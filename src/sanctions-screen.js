// Payment-party screen: EVM-format addresses on the US Treasury OFAC
// Specially Designated Nationals (SDN) list. Two readers: the Tempo rail's
// direct mode (src/mpp-tempo.js, TEMPO_RELAY=off), which checks every payment
// party here before any money moves, and the x402 payer screen
// (src/x402-payer-screen.js), which checks an x402 payment's EVM payer after
// verification and before the paid handler.
//
// SOURCE. OFAC's SDN list in its legacy XML format (SDN.XML), downloaded and
// parsed by src/ofac-sdn.js: the same parser, and the same in-memory parse,
// the sanctions tools and the router's payout screen
// (src/tools/sanctions-kit.js) read, so the two never read the list
// differently and one download feeds both (SHARED LOAD in src/ofac-sdn.js).
// This screen keeps only the EVM set of that parse.
//
// WHAT IS KEPT. Every idNumber that is an EVM-format address (0x + 40 hex),
// whatever asset ticker it is listed under (ETH, USDT, USDC, ETC, BNB, ...):
// a Tempo address is an EVM address, so a listed EVM address is the same
// account on Tempo. Lowercased into a Set; the per-asset counts are kept for
// the operator view.
//
// REFRESH. Every SANCTIONS_LIST_REFRESH_MS (default 6 h) under leased(), so
// one container fetches; every container re-reads the stored set on its own
// tick. While nothing is loaded the tick runs every SANCTIONS_LIST_RETRY_MS
// (default 5 min). The last good set is stored through json-document (the
// state database row, or the file without one) so a restart has it at once.
// A failed fetch or a parse that is implausible (no EVM address at all, or
// fewer than half of the set it would replace) keeps the previous set and
// logs one line.
//
// STATUS. fresh (fetched within two refresh periods), stale (older; still
// screens against the last good set), missing (never loaded: every screen
// answers unavailable; direct mode offers no tempo challenge, and the x402
// payer screen serves unscreened).
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createJsonDocument } from "./json-document.js";
import { leased, trackStoreReady } from "./state-db.js";
import { shared, noteSharedLimitsDegraded } from "./shared-limits.js";
import { parseSdnXml, sdnEvmAddresses, loadSdnList, sdnListUrl, SDN_LIST_DEFAULT_URL } from "./ofac-sdn.js";
import { registerMemoryStore } from "./memory-stores.js";

export const SANCTIONS_LIST_DEFAULT_URL = SDN_LIST_DEFAULT_URL;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

const envMs = (k, d, min = 1) => { const n = Number(process.env[k]); return Number.isFinite(n) && n >= min ? n : d; };
export function sanctionsListRefreshMs() { return envMs("SANCTIONS_LIST_REFRESH_MS", 6 * 3600_000, 1000); }
function retryMs() { return envMs("SANCTIONS_LIST_RETRY_MS", 5 * 60_000, 1000); }
export function sanctionsListUrl() { return sdnListUrl(); }

/** Every EVM-format Digital Currency Address in an SDN.XML export, read
 *  through the shared parser (src/ofac-sdn.js).
 *  Returns { addresses: Set<lowercase>, perAsset: {TICKER: n}, digitalCurrencyIds, publishDate }.
 *  perAsset counts distinct EVM addresses per ticker. Pure; never throws. */
export function parseSdnXmlEvmAddresses(xml) {
  return fromParse(parseSdnXml(xml));
}
function fromParse(parsed) {
  const { addresses, perAsset } = sdnEvmAddresses(parsed);
  return { addresses, perAsset, digitalCurrencyIds: parsed.digitalCurrencyIds, publishDate: parsed.publishDate };
}

// ---------------------------------------------------------------------------
let state = null;
let doc = null;
let ready = null;
let timer = null;
let running = false;

function emptyState() {
  return { set: null, perAsset: {}, loadedAt: null, publishDate: null, source: null, lastAttemptAt: null, lastError: null, lastErrorAt: null };
}
state = emptyState();

function storeFile() {
  if (process.env.SANCTIONS_SCREEN_FILE) return process.env.SANCTIONS_SCREEN_FILE;
  return join(existsSync("/data") ? "/data" : "/tmp", "sanctions-screen-evm.json");
}
function getDoc() {
  if (!doc) doc = createJsonDocument({ name: "sanctions-screen-evm.json", file: storeFile(), log: (m) => console.warn(m) });
  return doc;
}

function adopt(body, source) {
  if (!body || typeof body !== "object" || !Array.isArray(body.addresses)) return false;
  const set = new Set(body.addresses.filter((a) => typeof a === "string" && EVM_RE.test(a)).map((a) => a.toLowerCase()));
  const loadedAt = Number(body.loadedAt);
  if (!set.size || !Number.isFinite(loadedAt)) return false;
  // Only a newer stored set replaces what is held (another container's refresh).
  if (state.loadedAt && loadedAt <= state.loadedAt) return false;
  state.set = set;
  state.perAsset = body.perAsset && typeof body.perAsset === "object" ? { ...body.perAsset } : {};
  state.loadedAt = loadedAt;
  state.publishDate = typeof body.publishDate === "string" ? body.publishDate : null;
  state.source = source;
  return true;
}

/** Read the stored set (the last good one any container fetched). */
export async function loadStoredSanctionsScreen() {
  try {
    const body = await getDoc().load(null);
    return adopt(body, "store");
  } catch (e) {
    console.warn(`[sanctions-screen] reading the stored list failed: ${String(e?.message || e).slice(0, 160)}`);
    return false;
  }
}

function failed(reason, log) {
  state.lastError = String(reason).slice(0, 200);
  state.lastErrorAt = Date.now();
  log(`[sanctions-screen] refresh refused, ${state.set ? `keeping the set loaded at ${new Date(state.loadedAt).toISOString()}` : "no list loaded"}: ${state.lastError}`);
  return { ok: false, reason: state.lastError };
}

/** Fetch (or take the shared parse fetched within `maxAgeMs`, src/ofac-sdn.js),
 *  then (when plausible) adopt and store the list. Unleased. */
export async function refreshSanctionsScreen({ fetchImpl = globalThis.fetch, now = () => Date.now(), log = console.warn, maxAgeMs = 0 } = {}) {
  state.lastAttemptAt = now();
  let list;
  try {
    list = await loadSdnList({ maxAgeMs, fetchImpl, now });
  } catch (e) {
    return failed(`fetch failed: ${String(e?.message || e).slice(0, 120)}`, log);
  }
  const parsed = fromParse(list);
  if (!parsed.addresses.size) return failed(`parsed to zero EVM addresses (${parsed.digitalCurrencyIds} digital currency ids); treated as a format change`, log);
  if (state.set && parsed.addresses.size * 2 < state.set.size) return failed(`parsed to ${parsed.addresses.size} EVM addresses against ${state.set.size} held; a drop past half is treated as a bad export`, log);
  state.set = parsed.addresses;
  state.perAsset = parsed.perAsset;
  state.loadedAt = list.fetchedAt;
  state.publishDate = parsed.publishDate;
  state.source = "fetch";
  state.lastError = null;
  const body = { v: 1, loadedAt: state.loadedAt, publishDate: state.publishDate, perAsset: state.perAsset, addresses: [...parsed.addresses].sort() };
  const stored = await getDoc().save(body).catch(() => false);
  if (!stored) log(`[sanctions-screen] list loaded but not stored: ${String(getDoc().lastError || "save refused").slice(0, 120)}`);
  console.log(`[sanctions-screen] OFAC SDN loaded: ${parsed.addresses.size} EVM addresses (${Object.entries(parsed.perAsset).map(([k, v]) => `${k} ${v}`).join(", ")})${state.publishDate ? `, published ${state.publishDate}` : ""}`);
  return { ok: true, evmAddresses: parsed.addresses.size };
}

const refreshLeased = leased("sanctions-screen-refresh", { ttlMs: 30 * 60_000, failOpen: true }, (opts) => refreshSanctionsScreen(opts));

/** One tick: the leaseholder fetches when its set is due; every container
 *  re-reads the stored set first, so it picks up another container's fetch. */
export async function sanctionsScreenTick(opts = {}) {
  if (running) return { skipped: "busy" };
  running = true;
  try {
    await loadStoredSanctionsScreen();
    const now = (opts.now || Date.now)();
    if (state.loadedAt && now - state.loadedAt < sanctionsListRefreshMs()) return { skipped: "fresh" };
    // A parse the sanctions tools fetched within a quarter period is taken
    // rather than downloaded a second time.
    const r = await refreshLeased({ maxAgeMs: sanctionsListRefreshMs() / 4, ...opts });
    if (r?.skipped) await loadStoredSanctionsScreen();
    return r;
  } finally { running = false; }
}

function schedule(opts) {
  if (timer) clearTimeout(timer);
  const delay = state.set ? sanctionsListRefreshMs() : retryMs();
  timer = setTimeout(() => { sanctionsScreenTick(opts).catch(() => {}).finally(() => schedule(opts)); }, delay);
  timer.unref?.();
}

/** Start the screen: read the stored set (registered as a state store), then
 *  refresh when due and on the timer. Idempotent: the first caller's options
 *  apply. Resolves when the stored set has been read (the first fetch runs in
 *  the background). `firstTickDelayMs` holds the first tick back (the x402
 *  start passes the sanctions tools' boot warm-up delay, so both readers ask
 *  for the list together and share one download). */
export function startSanctionsScreen(opts = {}) {
  if (ready) return ready;
  const { firstTickDelayMs = 0, ...tickOpts } = opts;
  ready = trackStoreReady(loadStoredSanctionsScreen(), "sanctions-screen");
  ready.then(() => {
    const first = () => { sanctionsScreenTick(tickOpts).catch(() => {}).finally(() => schedule(tickOpts)); };
    if (!(firstTickDelayMs > 0)) return first();
    timer = setTimeout(first, firstTickDelayMs);
    timer.unref?.();
  });
  return ready;
}

/** Whether startSanctionsScreen ran in this process (Tempo direct mode or x402 payments). */
export function sanctionsScreenStarted() { return !!ready; }

/** fresh | stale | missing */
export function sanctionsScreenStatus(now = Date.now()) {
  if (!state.set || !state.loadedAt) return "missing";
  return now - state.loadedAt <= 2 * sanctionsListRefreshMs() ? "fresh" : "stale";
}

/** Operator view: counts and times, never an address. */
export function sanctionsScreenOperatorView(now = Date.now()) {
  return {
    status: sanctionsScreenStatus(now),
    evmAddresses: state.set ? state.set.size : 0,
    perAsset: { ...state.perAsset },
    lastLoadedAt: state.loadedAt ? new Date(state.loadedAt).toISOString() : null,
    publishDate: state.publishDate,
    source: state.source,
    lastAttemptAt: state.lastAttemptAt ? new Date(state.lastAttemptAt).toISOString() : null,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt ? new Date(state.lastErrorAt).toISOString() : null,
    oneHop: {
      status: oneHopStatus(now),
      reads: oneHop.reads, pages: oneHop.pages, transfersRead: oneHop.transfersRead, partialReads: oneHop.partialReads,
      cacheHits: oneHop.cacheHits, refused: oneHop.refused, flagged: oneHop.flagged, unvaluedTransfers: oneHop.unvaluedTransfers, failures: oneHop.failures, skippedNoKey: oneHop.skippedNoKey,
      recentFlags: oneHop.recentFlags.map((f) => ({ ...f, funders: [...f.funders] })),
      lastError: oneHop.lastError,
      lastFailAt: oneHop.lastFailAt ? new Date(oneHop.lastFailAt).toISOString() : null,
      lastReadAt: oneHop.lastReadAt ? new Date(oneHop.lastReadAt).toISOString() : null,
      rule: { minUsd: oneHopMinUsd(), minShare: oneHopMinShare(), shareFloorUsd: oneHopShareFloorUsd() },
      bounds: { maxPages: oneHopMaxPages(), pageSize: ONE_HOP_PAGE, deadlineMs: oneHopDeadlineMs(), lookbackDays: Math.round(oneHopLookbackMs() / 86400_000), ttlDays: Math.round(oneHopTtlMs() / 86400_000) },
    },
  };
}

/** Screen payment addresses. Values that are not EVM-format addresses are
 *  ignored (the caller passes every party it could read). Stale screens
 *  against the last good set; missing answers unavailable. */
export function screenAddresses(list) {
  if (!state.set) return { ok: false, reason: "unavailable" };
  for (const a of Array.isArray(list) ? list : [list]) {
    if (typeof a !== "string" || !EVM_RE.test(a)) continue;
    const key = a.toLowerCase();
    if (state.set.has(key)) return { ok: false, reason: "listed", address: key };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// ONE-HOP FUNDING CHECK. On a payer's first direct-mode payment (and again
// once its verdict expires, SANCTIONS_ONE_HOP_TTL_MS, default 7 days) the
// payer's recent inbound transfers are read from Tempo's transfer data feed
// (GET /v1/transfers?recipient=<payer>, the feed src/tempo-transfers.js and
// src/mpp-reconcile.js read, key TEMPO_DATA_API_KEY) and every sender is
// checked against the same EVM set.
//
// THE RULE. Anyone can send a small amount to any wallet, a listed wallet
// included, so receiving from a listed address is not by itself a refusal.
// The amounts the payer received from listed senders are summed (USD
// stablecoins at face value; a transfer in a token that cannot be valued is
// left out of both sums, counted and logged). The payment is refused
// (screen-rejected) when that sum is
//   - at least SANCTIONS_ONE_HOP_MIN_USD (default 1.00), or
//   - at least SANCTIONS_ONE_HOP_MIN_SHARE (default 0.5) of everything the
//     payer received in the read AND at least SANCTIONS_ONE_HOP_SHARE_FLOOR_USD
//     (default 0.10).
// Why the share needs a floor: the catalog's lowest price is $0.001 and most
// tools are priced under a cent (GET /api/pricing, the CATALOG the server
// builds: 455 of 587 routes under $0.01 when this was written), so a buyer
// wallet often holds only a few cents in total. A share rule alone would let
// a listed wallet that sends $0.005 to a $0.05 wallet refuse that buyer; with
// the floor, unsolicited sends that small are flagged, never refused. The
// share line is a half: a wallet funded mostly by a listed address with
// amounts under a dollar (for example $0.20 of $0.25) is refused, while a
// listed send that is a minority of a wallet's funding (for example $0.50 of
// $5) is flagged. Below these lines the payment is allowed and FLAGGED: one log
// line (masked addresses, the amount, the count), an operator-view counter
// and the last few flags. The verdict (clean, flagged or listed) is cached
// per payer and read again when it expires.
//
// Bounds, because this runs on the payment path:
//   - newest first, at most SANCTIONS_ONE_HOP_MAX_PAGES pages (default 2) of
//     50, so at most 100 transfers. A wallet that pays agents is topped up a
//     handful of times; the newest 100 inbound transfers cover its funding
//     for nearly every payer, and a wallet with more inbound traffic than that
//     (an exchange or a service wallet) would not finish inside the deadline
//     anyway. A read that stops at the cap decides on what it read.
//   - within SANCTIONS_ONE_HOP_LOOKBACK_MS (default 90 days).
//   - one deadline for the whole read, SANCTIONS_ONE_HOP_DEADLINE_MS (default
//     2500 ms). A pull credential is signed valid for about 25 s and the
//     handler and the broadcast still follow, so the read gets a small, fixed
//     share of that. Past the deadline the pages already read decide.
//
// The verdict is cached per payer as a shared-limits flag (Redis when
// configured, so every replica reads it and it survives a restart; one key
// per payer with its own expiry, so the cache never grows past the payers
// seen inside one TTL). A json-document would rewrite one whole body per new
// payer on the payment path and grow with the payer count. A process-local
// copy rides in front of it (capped) so a shared store that does not answer
// still spares a second read in this process.
//
// The feed read never refuses a payment by failing: no key, an HTTP error, a
// timeout or an unreadable body leaves the exact match as the only screen
// (which still fails closed), logs one word per minute and shows on the
// operator view. Nothing is cached for a failed read.
const ONE_HOP_PAGE = 50;
const ONE_HOP_FLAGS_KEPT = 10;
function oneHopTtlMs() { return envMs("SANCTIONS_ONE_HOP_TTL_MS", 7 * 86400_000, 1000); }
function oneHopMaxPages() { return Math.max(1, Math.min(10, Math.trunc(envMs("SANCTIONS_ONE_HOP_MAX_PAGES", 2, 1)))); }
function oneHopDeadlineMs() { return Math.min(10_000, envMs("SANCTIONS_ONE_HOP_DEADLINE_MS", 2500, 50)); }
function oneHopLookbackMs() { return envMs("SANCTIONS_ONE_HOP_LOOKBACK_MS", 90 * 86400_000, 60_000); }
function oneHopMinUsd() { const n = Number(process.env.SANCTIONS_ONE_HOP_MIN_USD); return Number.isFinite(n) && n > 0 ? n : 1; }
function oneHopMinShare() { const n = Number(process.env.SANCTIONS_ONE_HOP_MIN_SHARE); return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.5; }
function oneHopShareFloorUsd() { const n = Number(process.env.SANCTIONS_ONE_HOP_SHARE_FLOOR_USD); return Number.isFinite(n) && n >= 0 ? n : 0.1; }
const oneHopKey = () => String(process.env.TEMPO_DATA_API_KEY || "").trim();
const oneHopBase = () => (process.env.TEMPO_API_BASE_URL || "https://api.tempo.xyz").replace(/\/$/, "");
const oneHopOff = () => /^(0|off|false|no)$/i.test(String(process.env.SANCTIONS_ONE_HOP || "").trim());

// USD stablecoins valued at face: Tempo's PathUSD and USDC.e by address, and
// a token the feed names with a USD stablecoin symbol.
const USD_TOKENS = new Set(["0x20c0000000000000000000000000000000000000", "0x20c000000000000000000000b9537d11c60e8b50"]);
const USD_SYMBOL_RE = /^(pathusd|usdc(\.e)?|usdt0?|usd[a-z0-9.]{0,8}|[a-z]{1,8}usd)$/i;
/** The face USD value of one feed transfer, or null when it cannot be valued. Exported for tests. */
export function transferUsd(t) {
  const tok = t?.destinationToken || t?.sourceToken || {};
  const amt = t?.destinationToken ? t?.destinationAmount : t?.sourceAmount;
  const address = String(tok.address || "").toLowerCase();
  const symbol = String(tok.symbol || "");
  if (!USD_TOKENS.has(address) && !USD_SYMBOL_RE.test(symbol)) return null;
  const decimals = Number.isInteger(tok.decimals) ? tok.decimals : USD_TOKENS.has(address) ? 6 : null;
  let base;
  try { base = BigInt(String(amt?.baseUnits ?? "")); } catch { return null; }
  if (decimals == null || base < 0n) return null;
  return Number(base) / 10 ** decimals;
}

const ONE_HOP_LOCAL_MAX = 10_000;
let oneHopLocal = new Map(); // payer -> { verdict, until, ... }
let oneHopInFlight = new Map(); // payer -> Promise<verdict | null>
let oneHop = null;
function emptyOneHop() { return { reads: 0, pages: 0, transfersRead: 0, unvaluedTransfers: 0, cacheHits: 0, refused: 0, flagged: 0, partialReads: 0, failures: 0, skippedNoKey: 0, lastError: null, lastFailAt: 0, lastReadAt: 0, recentFlags: [], wordLoggedAt: {} }; }
oneHop = emptyOneHop();

// One log word per word per minute (off, unavailable, unvalued), never one per payment.
function logOneHopWord(word, log) {
  const at = oneHop.wordLoggedAt[word] || 0;
  if (Date.now() - at < 60_000) return;
  oneHop.wordLoggedAt[word] = Date.now();
  log(`[sanctions-screen] one-hop ${word}`);
}
function noteOneHopFailure(word, detail, log) {
  oneHop.failures++;
  oneHop.lastError = `${word}${detail ? `: ${String(detail).slice(0, 100)}` : ""}`;
  oneHop.lastFailAt = Date.now();
  logOneHopWord(word, log);
}
/** An address shortened for logs and the operator view (0x1234...abcd). */
export const maskAddress = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : "?");

/** One word for the funding check: off (no key, or SANCTIONS_ONE_HOP=off),
 *  degraded (a feed read failed inside the last ten minutes), on. */
export function oneHopStatus(now = Date.now()) {
  if (oneHopOff() || !oneHopKey()) return "off";
  return oneHop.lastFailAt && now - oneHop.lastFailAt < 10 * 60_000 ? "degraded" : "on";
}

function rememberLocal(payer, v, until) {
  if (oneHopLocal.size >= ONE_HOP_LOCAL_MAX) oneHopLocal.delete(oneHopLocal.keys().next().value);
  oneHopLocal.set(payer, { ...v, until });
}
const VERDICT_FLAGS = [["listed", "s1h-listed"], ["flagged", "s1h-flagged"], ["clean", "s1h-clean"]];
async function cachedVerdict(payer, now) {
  const hit = oneHopLocal.get(payer);
  if (hit && hit.until > now) return hit;
  if (hit) oneHopLocal.delete(payer);
  const reads = await Promise.all(VERDICT_FLAGS.map(([, name]) => shared.flagGet(name, payer, { now }).catch((e) => ({ ok: false, error: e?.message }))));
  const bad = reads.find((r) => !r?.ok);
  if (bad) noteSharedLimitsDegraded("sanctions-one-hop", bad);
  for (let i = 0; i < VERDICT_FLAGS.length; i++) {
    if (reads[i]?.ok && reads[i].until > now) { const v = { verdict: VERDICT_FLAGS[i][0], cached: true }; rememberLocal(payer, v, reads[i].until); return v; }
  }
  return null;
}
async function storeVerdict(payer, v, now) {
  const until = now + oneHopTtlMs();
  rememberLocal(payer, v, until);
  const name = VERDICT_FLAGS.find(([w]) => w === v.verdict)[1];
  const r = await shared.flagSet(name, payer, until, { now }).catch((e) => ({ ok: false, error: e?.message }));
  if (!r?.ok) noteSharedLimitsDegraded("sanctions-one-hop", r);
}

/** `payer`'s newest inbound transfers, inside the bounds above.
 *  { ok: true, transfers: [{ sender, usd }], pages, partial } or { ok: false, error }. */
async function readInbound(payer, { fetchImpl, now }) {
  const deadline = Date.now() + oneHopDeadlineMs();
  const transfers = [];
  let cursor = null, pages = 0;
  const base = `${oneHopBase()}/v1/transfers?recipient=${encodeURIComponent(payer)}&timestamp.from=${encodeURIComponent(new Date(now - oneHopLookbackMs()).toISOString())}&timestamp.to=${encodeURIComponent(new Date(now).toISOString())}&limit=${ONE_HOP_PAGE}&order=desc`;
  while (pages < oneHopMaxPages()) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    let res, body;
    try {
      res = await fetchImpl(cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base, { headers: { "tempo-api-key": oneHopKey(), accept: "application/json" }, signal: AbortSignal.timeout(left) });
      body = await res.json();
    } catch (e) {
      if (pages) break; // past the deadline mid-read: decide on what was read
      return { ok: false, error: `unreadable (${String(e?.name || "error")})` };
    }
    if (!res.ok || !Array.isArray(body?.data)) {
      if (pages) break;
      return { ok: false, error: `HTTP ${res?.status}` };
    }
    pages++;
    for (const t of body.data) {
      if (String(t?.recipient || "").toLowerCase() !== payer) return { ok: false, error: "recipient filter not honoured" };
      const from = String(t?.sender || "");
      transfers.push({ sender: EVM_RE.test(from) ? from.toLowerCase() : null, usd: transferUsd(t) });
    }
    cursor = body.nextCursor || null;
    if (!cursor || !body.data.length) return { ok: true, transfers, pages, partial: false };
  }
  return { ok: true, transfers, pages, partial: true };
}

/** The rule above, on one read. Pure. Exported for tests. */
export function oneHopVerdict(transfers, set, { minUsd = oneHopMinUsd(), minShare = oneHopMinShare(), shareFloorUsd = oneHopShareFloorUsd() } = {}) {
  let totalUsd = 0, listedUsd = 0, listedCount = 0, unvalued = 0;
  const funders = new Set();
  for (const t of transfers) {
    const listed = !!t.sender && set.has(t.sender);
    if (t.usd == null) { unvalued++; if (listed) { listedCount++; funders.add(t.sender); } continue; }
    totalUsd += t.usd;
    if (listed) { listedUsd += t.usd; listedCount++; funders.add(t.sender); }
  }
  const share = totalUsd > 0 ? listedUsd / totalUsd : 0;
  const verdict = !listedCount ? "clean"
    : listedUsd >= minUsd - 1e-9 || (share >= minShare - 1e-9 && listedUsd >= shareFloorUsd - 1e-9 && listedUsd > 0) ? "listed"
    : "flagged";
  return { verdict, listedUsd, totalUsd, share, listedCount, funders: [...funders], unvalued };
}

async function checkOnePayer(payer, { fetchImpl, now, log }) {
  const cached = await cachedVerdict(payer, now);
  if (cached) { oneHop.cacheHits++; return cached; }
  if (!state.set) return null; // nothing to screen against; the exact match refuses on its own
  const r = await readInbound(payer, { fetchImpl, now });
  oneHop.lastReadAt = Date.now();
  if (!r.ok) { noteOneHopFailure("unavailable", r.error, log); return null; }
  oneHop.reads++; oneHop.pages += r.pages; oneHop.transfersRead += r.transfers.length;
  if (r.partial) oneHop.partialReads++;
  const v = oneHopVerdict(r.transfers, state.set);
  if (v.unvalued) { oneHop.unvaluedTransfers += v.unvalued; logOneHopWord("unvalued-token", log); }
  const summary = `payer ${maskAddress(payer)} received $${v.listedUsd.toFixed(6)} in ${v.listedCount} transfer(s) from listed ${v.funders.map(maskAddress).join(",")} of $${v.totalUsd.toFixed(6)} read (${(v.share * 100).toFixed(2)}%${v.unvalued ? `, ${v.unvalued} unvalued` : ""}${r.partial ? ", partial read" : ""})`;
  if (v.verdict === "listed") { oneHop.refused++; log(`[sanctions-screen] one-hop refused: ${summary}`); }
  if (v.verdict === "flagged") {
    oneHop.flagged++;
    log(`[sanctions-screen] one-hop flagged, allowed: ${summary}`);
    oneHop.recentFlags.unshift({ at: new Date().toISOString(), payer: maskAddress(payer), funders: v.funders.map(maskAddress), listedUsd: Number(v.listedUsd.toFixed(6)), count: v.listedCount, sharePct: Number((v.share * 100).toFixed(2)) });
    oneHop.recentFlags.length = Math.min(oneHop.recentFlags.length, ONE_HOP_FLAGS_KEPT);
  }
  const out = { verdict: v.verdict, funder: v.funders[0] || null, listedUsd: v.listedUsd, count: v.listedCount, share: v.share };
  await storeVerdict(payer, out, now);
  return out;
}

/** The one-hop check for each payer. { ok: true } (clean, flagged, or the
 *  check could not run: the exact match is then the only screen) or
 *  { ok: false, reason: "funded", payer, funder, listedUsd, count, share }
 *  (funder null when the verdict came from the cache). Never throws. */
export async function screenFunding(payers, { fetchImpl = globalThis.fetch, now = Date.now(), log = console.warn } = {}) {
  if (oneHopOff()) return { ok: true, skipped: "off" };
  if (!oneHopKey()) { oneHop.skippedNoKey++; logOneHopWord("off", log); return { ok: true, skipped: "no-key" }; }
  const list = [...new Set((Array.isArray(payers) ? payers : [payers]).filter((a) => typeof a === "string" && EVM_RE.test(a)).map((a) => a.toLowerCase()))];
  let flagged = false;
  for (const payer of list) {
    let p = oneHopInFlight.get(payer);
    if (!p) {
      p = checkOnePayer(payer, { fetchImpl, now, log }).catch((e) => { noteOneHopFailure("unavailable", e?.message, log); return null; });
      oneHopInFlight.set(payer, p);
      p.finally(() => oneHopInFlight.delete(payer));
    }
    const v = await p;
    if (v?.verdict === "listed") return { ok: false, reason: "funded", payer, funder: v.cached ? null : v.funder, listedUsd: v.listedUsd ?? null, count: v.count ?? null, share: v.share ?? null };
    if (v?.verdict === "flagged") flagged = true;
  }
  return flagged ? { ok: true, flagged: true } : { ok: true };
}

/** Test seam: drop the process-local verdicts only (the shared store keeps its own). */
export function __clearOneHopLocalForTests() { oneHopLocal = new Map(); }

/** Test seam: forget everything (and the store handle, so env changes apply). */
export function __resetSanctionsScreenForTests() {
  if (timer) clearTimeout(timer);
  timer = null; ready = null; doc = null; running = false;
  state = emptyState();
  oneHop = emptyOneHop();
  oneHopLocal = new Map();
  oneHopInFlight = new Map();
}

// Operator heap read (/__operator/heap.json `stores`).
registerMemoryStore("sanctions-screen.state", () => state, { note: "screening lists" });
registerMemoryStore("sanctions-screen.oneHop", () => oneHopLocal, { note: "one-hop verdicts" });
