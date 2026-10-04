// Sanctions screening: a name or a crypto address against the published lists.
//
// Built 2026-09-12. The catalog had nothing here, and the gap showed up from
// two directions at once: a competing x402 seller's single most expensive
// route is sanctions screening, and our OWN router pays external sellers from
// our wallet without ever asking whether the payout address is on OFAC's list.
// The second reason is the better one - this makes the router answerable, not
// just the catalog longer.
//
// THE LISTS ARE BULK FILES, SO THEY ARE CACHED, NOT FETCHED PER CALL. OFAC SDN
// is ~5.7MB and the UK OFSI consolidated list ~16MB; fetching either per
// request would be slow, rude to a government endpoint, and a fine way to get
// our egress IP blocked. One load per process, refreshed on a timer, served
// from memory.
//
// A MISS IS NEVER A CLEARANCE - see src/tools/sanctions-core.js for why the
// verdict vocabulary has no word in it that reads as permission.
import { parseSdnCryptoAddresses, parseSdnNames, screenName, normalizeAddress, SANCTIONS_VERDICTS } from "./sanctions-core.js";

const SDN_URL = process.env.OFAC_SDN_URL || "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV";
const REFRESH_MS = Math.max(3600_000, Number(process.env.SANCTIONS_REFRESH_MS) || 12 * 3600_000);
const MAX_BYTES = 32 * 1024 * 1024; // a list that grows past this is a surprise worth failing on
const bad = (msg, code) => { const e = new Error(msg); e.statusCode = code; return e; };

let state = { addresses: new Map(), names: [], fetchedAt: null, error: null, loading: null, bytes: 0 };

/** Load the SDN export once. Injectable fetch so the tests never touch a
 *  government endpoint. */
export async function loadSanctions({ fetchImpl = fetch, now = () => Date.now(), force = false } = {}) {
  if (!force && state.fetchedAt && now() - state.fetchedAt < REFRESH_MS) return state;
  if (state.loading) return state.loading; // one in-flight load, never a stampede
  state.loading = (async () => {
    try {
      const res = await fetchImpl(SDN_URL, { signal: AbortSignal.timeout(60_000), headers: { accept: "text/csv" } });
      if (!res.ok) throw new Error(`OFAC SDN fetch: HTTP ${res.status}`);
      const csv = await res.text();
      if (csv.length > MAX_BYTES) throw new Error(`OFAC SDN export is ${(csv.length / 1e6).toFixed(1)}MB, over the ${MAX_BYTES / 1e6}MB cap`);
      const addresses = parseSdnCryptoAddresses(csv);
      const names = parseSdnNames(csv);
      // A parse that yields nothing is a FORMAT CHANGE, not an empty list, and
      // serving "no match" off it would be the worst possible failure here:
      // every query would read as clean. Keep the previous good load instead.
      if (!names.length) throw new Error("OFAC SDN parsed to zero entries - treating as a format change, not an empty list");
      state = { addresses, names, fetchedAt: now(), error: null, loading: null, bytes: csv.length };
    } catch (e) {
      state.error = String(e?.message || e).slice(0, 200);
      state.loading = null;
      if (!state.fetchedAt) throw e; // nothing cached: the caller must be refused, never served an empty list
    }
    state.loading = null;
    return state;
  })();
  return state.loading;
}

const LOADED_SINCE = Date.now();
const BOOT_GRACE_MS = 10 * 60_000;

/** One word for the public /api/gateway-status, so the heartbeat can page:
 *  "ok" loaded within two refresh cycles; "stale" refreshes are failing and
 *  screening answers from an old list (the case that is wrong without a
 *  refusal - an unloaded list refuses every call); "unloaded" never loaded
 *  past the boot grace; "loading" never loaded, still inside it. */
export function sanctionsHealth(now = Date.now(), bootAt = LOADED_SINCE) {
  if (state.fetchedAt) return { status: now - state.fetchedAt <= 2 * REFRESH_MS ? "ok" : "stale" };
  return { status: now - bootAt > BOOT_GRACE_MS ? "unloaded" : "loading" };
}

/** Counts only, for the operator surface and /api/gateway-status. */
export const sanctionsStatus = () => ({
  loaded: !!state.fetchedAt,
  fetchedAt: state.fetchedAt ? new Date(state.fetchedAt).toISOString() : null,
  addresses: state.addresses.size,
  entries: state.names.length,
  bytes: state.bytes,
  lastError: state.error,
});

const LISTS = [{ list: "OFAC SDN", authority: "US Treasury OFAC", url: "https://sanctionslist.ofac.treas.gov/" }];
// The caveat travels IN the answer - documentation nobody reads is not a
// control. It is VERDICT-AWARE: emitting the miss caveat on a match produced
// "this value does not appear on the lists" directly under `verdict: match`,
// which is nonsense and would teach a reader to skip the field entirely. Found
// 2026-09-12 by reading an actual response rather than the shape of one.
const envelope = (matched) => ({
  listsChecked: LISTS,
  listsFetchedAt: state.fetchedAt ? new Date(state.fetchedAt).toISOString() : null,
  ...(matched
    ? { confirmBeforeActing: SANCTIONS_VERDICTS.match_caveat }
    : { notAClearance: SANCTIONS_VERDICTS.no_match_on_lists_checked }),
});

export const SANCTIONS_TOOLS = [
  {
    route: "GET /api/sanctions/wallet",
    name: "Sanctions screening - crypto address",
    slug: "sanctions-wallet",
    category: "chain",
    price: "$0.002",
    description: "Is this blockchain address on the OFAC SDN list? Screens any address against every Digital Currency Address OFAC publishes (Bitcoin, Ethereum, Tron, USDT, USDC, Monero, Litecoin and more). A match names the sanctioned entity and its SDN id. A miss is reported as 'not on the lists checked, as of this date' and is never a clearance - the answer carries that caveat in the payload. Deterministic: a cached copy of the published list, no model in the path.",
    tags: ["sanctions", "ofac", "compliance", "screening", "wallet", "aml"],
    discovery: {
      inputSchema: { type: "object", properties: { address: { type: "string", description: "The blockchain address to screen" }, asset: { type: "string", description: "Optional asset hint (BTC, ETH, TRX...). Only affects case handling for chains whose addresses are case-sensitive" } }, required: ["address"] },
      input: { address: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96" },
      // The documented input is a REAL listed address (Lazarus Group), so the
      // documented output is a MATCH - and a match carries confirmBeforeActing,
      // not the miss caveat. CI caught the mismatch the moment the caveat
      // became verdict-aware, which is the documented-keys guard doing exactly
      // its job: a published example that promises a key the answer does not
      // carry teaches an agent to expect a field that never arrives.
      output: { type: "json", example: { address: "0x098b716b8aaf21512996dc57eb0615e2383e2f96", verdict: "match", entity: "LAZARUS GROUP", sdnId: "12345", asset: "ETH", listedAddress: "0x098b716b8aaf21512996dc57eb0615e2383e2f96", addressesOnList: 492, listsChecked: [{ list: "OFAC SDN", authority: "US Treasury OFAC" }], listsFetchedAt: "2026-09-12T00:00:00.000Z", confirmBeforeActing: "a match is a string match against a published list, not a confirmed identification..." } },
    },
    handler: async (input) => {
      const raw = String(input?.address || "").trim();
      if (!raw) throw bad("address is required", 400);
      if (raw.length > 120) throw bad("address is too long to be an address", 400);
      await loadSanctions().catch(() => {});
      if (!state.fetchedAt) throw bad(SANCTIONS_VERDICTS.lists_unavailable, 503);
      const key = normalizeAddress(raw, input?.asset);
      const hit = state.addresses.get(key);
      return {
        address: key,
        verdict: hit ? "match" : "no_match_on_lists_checked",
        ...(hit ? { entity: hit.entity, sdnId: hit.sdnId, asset: hit.asset, listedAddress: hit.address } : {}),
        addressesOnList: state.addresses.size,
        ...envelope(!!hit),
      };
    },
  },
  {
    route: "GET /api/sanctions/name",
    name: "Sanctions screening - name",
    slug: "sanctions-name",
    category: "research",
    price: "$0.005",
    description: "Screen a person or company name against the OFAC SDN list. Returns exact and substring matches with the SDN entry id and type, so every hit can be checked against the published list itself. Matching is exact, substring, or all-tokens (every word of your query appears as a whole word in the entry, in any order - so 'Vladimir Putin' finds 'PUTIN, Vladimir Vladimirovich'). Never a fuzzy similarity score, because a confident near-miss on a common surname is a liability rather than an answer; each hit says which of the three it was. A miss is 'not on the lists checked, as of this date', never a clearance.",
    tags: ["sanctions", "ofac", "compliance", "screening", "kyc", "aml"],
    discovery: {
      inputSchema: { type: "object", properties: { name: { type: "string", description: "Person or company name to screen" }, limit: { type: "number", description: "Max matches to return (default 25)" } }, required: ["name"] },
      input: { name: "Gazprom" },
      output: { type: "json", example: { query: "Gazprom", verdict: "match", exactCount: 0, containsCount: 2, allTokensCount: 0, matches: [{ id: "12345", name: "GAZPROMBANK JOINT STOCK COMPANY", type: "-0-", matchType: "contains" }], entriesOnList: 19388, listsChecked: [{ list: "OFAC SDN", authority: "US Treasury OFAC" }], listsFetchedAt: "2026-09-12T00:00:00.000Z", confirmBeforeActing: "a match is a string match against a published list, not a confirmed identification..." } },
    },
    handler: async (input) => {
      const q = String(input?.name || "").trim();
      if (!q) throw bad("name is required", 400);
      if (q.length > 200) throw bad("name is too long to screen", 400);
      await loadSanctions().catch(() => {});
      if (!state.fetchedAt) throw bad(SANCTIONS_VERDICTS.lists_unavailable, 503);
      const limit = Math.max(1, Math.min(100, Number(input?.limit) || 25));
      const r = screenName(q, state.names, { limit });
      return {
        query: r.query,
        verdict: r.matches.length ? "match" : "no_match_on_lists_checked",
        exactCount: r.exactCount ?? 0,
        containsCount: r.containsCount ?? 0,
        allTokensCount: r.allTokensCount ?? 0,
        matches: r.matches,
        ...(r.reason ? { note: r.reason } : {}),
        entriesOnList: state.names.length,
        ...envelope(r.matches.length > 0),
      };
    },
  },
];

/**
 * Screen ONE payout address before we sign a payment to it. Returns the SDN
 * entry on a match, null when it is not on the list, and THROWS when the list
 * is not loaded.
 *
 * The throw is the important part and it is the opposite of the tool's own
 * behaviour. A buyer of sanctions-wallet gets a 503 that says "we could not
 * check" - honest, and their decision what to do. The ROUTER cannot be handed
 * a null that means both "not listed" and "we have no list", because those
 * lead to opposite actions and the caller would have no way to tell them
 * apart. So: a fact, or an exception. The router's own handler decides what an
 * exception means (it proceeds, loudly - see the call site in x402-buyer.js
 * for why failing closed there would be an outage wearing compliance clothes).
 *
 * Never fetches: a payment path must not wait on a 5.7MB download. It reads
 * the copy the boot warmer and the refresh timer maintain.
 */
export async function screenAddressForPayment(address) {
  if (!state.fetchedAt) throw new Error("sanctions list not loaded");
  const key = normalizeAddress(address);
  if (!key) throw new Error("unreadable address");
  return state.addresses.get(key) || null;
}

/** Warm the list at boot so the first buyer does not pay for a 5.7MB download. */
export function startSanctionsRefresh({ log = console.log } = {}) {
  const tick = () => loadSanctions({ force: true })
    .then(() => log(`[sanctions] OFAC SDN loaded: ${state.names.length} entries, ${state.addresses.size} crypto addresses`))
    .catch((e) => console.warn(`[sanctions] load failed (screening will refuse until it succeeds): ${String(e?.message || e).slice(0, 120)}`));
  setTimeout(tick, 15_000).unref?.();
  setInterval(tick, REFRESH_MS).unref?.();
}
