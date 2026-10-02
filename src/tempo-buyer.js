// Tempo (MPP) buyer — the server's DEDICATED spending wallet for paying OTHER
// MPP sellers on a buyer's behalf, the Tempo counterpart of x402-buyer.js's
// Base/Algorand spending wallets. Same doctrine throughout:
//
//   - a DEDICATED hot wallet (TEMPO_UPSTREAM_BUYER_KEY, an EVM private key -
//     Tempo is secp256k1, so this can be the same address as the Base spending
//     wallet, funded separately with USDC on Tempo). NEVER the treasury, NEVER
//     the CI burner. Absent key = the Tempo leg is off; nothing else changes.
//   - ASSET PIN: pays ONLY USDC.e on Tempo (0x20C0…8b50, the currency 138 of
//     141 mpp.dev registry sellers quote and mppx's own mainnet default). A
//     seller quoting anything else is refused before any signing.
//   - MARGIN GUARD: the live 402's amount must be <= maxAtomic; a seller cannot
//     quote a cheap registry price and charge a dear one.
//   - PROVEN SELLERS ONLY: before signing, the challenge's recipient must show
//     recent inbound USDC.e transfers on-chain (rpc.tempo.xyz eth_getLogs) -
//     the same "route only to sellers with real settled volume" gate the Base
//     leg enforces via the leaderboard, measured live 2026-08-18: Firecrawl
//     4,184 / Exa 2,129 inbound transfers in ~15h vs 0 for two others. Fails
//     CLOSED on RPC error (no proof, no spend).
//   - Settlement is the SELLER's relay broadcast of OUR signed credential; we
//     hold no relay key here. mppx signs pull credentials validBefore = now+25s,
//     so we sign and send immediately - a slow seller is bounded by their own
//     window, never by ours.
import { createHash } from "node:crypto";
import { assertSigningAllowed } from "./signing-halt.js";
import { ROUTER_UA, noteSellerDeliveryFailure, clearSellerDeliveryFailure, isCallerInputStatus } from "./x402-buyer.js";
import { recordUpstreamSpend } from "./stats.js";
import { assertPublicUrl, ssrfDispatcher } from "./tools/fetch-guard.js";
import { readBytesCapped, decodeUtf8 } from "./capped-body.js";

export const TEMPO_CHAIN_ID = 4217;
export const TEMPO_CAIP2 = "eip155:4217";
/** USDC.e on Tempo mainnet - the ecosystem's quote currency (mppx defaults.tokens.usdc). */
export const TEMPO_USDC = "0x20C000000000000000000000b9537d11c60E8b50";
const TEMPO_USDC_LC = TEMPO_USDC.toLowerCase();
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEFAULT_MAX_BYTES = 512 * 1024;

const rpcUrl = () => process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz";
export const tempoBuyerConfigured = () => !!(process.env.TEMPO_UPSTREAM_BUYER_KEY || "").trim();

function bad(message, statusCode = 502) { const e = new Error(message); e.statusCode = statusCode; return e; }

async function rpc(method, params, { timeoutMs = 15000 } = {}) {
  const res = await fetch(rpcUrl(), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json();
  if (j.error) throw new Error(`tempo rpc ${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

// ---- proven-seller gate ---------------------------------------------------
// rpc.tempo.xyz caps eth_getLogs at 100k blocks (~15h at ~0.56s/block); one
// recipient-filtered query over 99k blocks answers in ~1s. Cached per
// recipient so a routed burst does not re-scan the chain per call.
const PROOF_BLOCKS = 99_000;
const PROOF_TTL_MS = 30 * 60 * 1000;
const proofCache = new Map(); // recipientLc -> { at, count, payers }
export const tempoMinSettled = () => Number(process.env.SOR_TEMPO_MIN_SETTLED_TX ?? 20);
/** Distinct payers the Tempo floor also requires, the Base floor's rule
 *  (SOR_MIN_DISTINCT_PAYERS, default 3). A malformed value reads as the default. */
export const tempoMinPayers = () => {
  const raw = process.env.SOR_TEMPO_MIN_DISTINCT_PAYERS ?? process.env.SOR_MIN_DISTINCT_PAYERS;
  const n = Number(raw);
  return raw === undefined || raw === "" || !Number.isFinite(n) || n < 0 ? 3 : n;
};

const topicAddr = (t) => (typeof t === "string" && /^0x[0-9a-fA-F]{64}$/.test(t) ? "0x" + t.slice(26).toLowerCase() : null);
let ourWalletsCache = null;
async function defaultOurWallets() {
  if (!ourWalletsCache) {
    try { ourWalletsCache = (await import("./revenue-live.js")).OUR_EVM_WALLETS; } catch { ourWalletsCache = new Set(); }
  }
  return ourWalletsCache;
}

/**
 * The settlement evidence a recipient's Transfer logs carry (2026-09-28).
 * A transfer from the recipient to ITSELF is not a buyer, and neither is one
 * from our own wallets (the Tempo spending wallet pays the sellers it routes
 * to, and money we sent a seller must not count toward the floor deciding
 * whether we send it more) - the same two exclusions the Base scan makes
 * (src/leaderboard.js foldTransfers). `payers` is the distinct senders left;
 * a log with no readable sender counts as a transfer and names no payer.
 */
export function tempoEvidenceFromLogs(recipient, logs, ourWallets = null) {
  const self = String(recipient || "").toLowerCase();
  const ours = new Set([...(ourWallets || [])].map((w) => String(w).toLowerCase()));
  const payers = new Set();
  let count = 0;
  for (const log of Array.isArray(logs) ? logs : []) {
    const from = topicAddr(log?.topics?.[1]);
    if (from && (from === self || ours.has(from))) continue;
    count++;
    if (from) payers.add(from);
  }
  return { count, payers: payers.size };
}

/** Inbound USDC.e evidence for `recipient` over the last ~15h of blocks:
 *  { count, payers }. Injectable rpc for tests. Throws on RPC failure
 *  (callers fail closed). A primed entry with no payer figure carries
 *  `payers: undefined`. */
export async function tempoInboundEvidence(recipient, { rpcFn = rpc, now = Date.now(), ourWallets = null } = {}) {
  const key = String(recipient).toLowerCase();
  const hit = proofCache.get(key);
  if (hit && now - hit.at < PROOF_TTL_MS) return { count: hit.count, payers: hit.payers };
  const latest = parseInt(await rpcFn("eth_blockNumber", []), 16);
  const from = "0x" + Math.max(0, latest - PROOF_BLOCKS).toString(16);
  const topic = "0x" + key.slice(2).padStart(64, "0");
  const logs = await rpcFn("eth_getLogs", [{ fromBlock: from, toBlock: "latest", address: TEMPO_USDC, topics: [TRANSFER_TOPIC, null, topic] }]);
  const ev = tempoEvidenceFromLogs(key, logs, ourWallets || await defaultOurWallets());
  proofCache.set(key, { at: now, count: ev.count, payers: ev.payers });
  return ev;
}
/** The transfer count alone (the older interface). */
export async function tempoInboundCount(recipient, opts = {}) {
  return (await tempoInboundEvidence(recipient, opts)).count;
}
export function __testResetProofCache() { proofCache.clear(); }
/** Seed the proven-seller cache from an external read (the MPP leaderboard's
 *  batched scan, src/mpp-leaderboard.js) so a routed buy to a ranked seller
 *  does not re-scan the chain. Same TTL as a direct read. `payers`: the
 *  distinct payers the read saw, when it knows them. */
export function primeTempoInboundCount(recipient, count, now = Date.now(), payers = undefined) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(recipient)) || !Number.isFinite(count)) return;
  proofCache.set(String(recipient).toLowerCase(), { at: now, count: Math.max(0, count | 0), payers: Number.isFinite(payers) ? Math.max(0, payers | 0) : undefined });
}
/** The JSON-RPC client the gate uses (exported so the leaderboard shares the
 *  endpoint + timeout, and tests inject a stub in one place). */
export const tempoRpc = (method, params, opts) => rpc(method, params, opts);

// ---- spending wallet status (for /api/gateway-status + the heartbeat) ------
let accountCache = null;
async function account() {
  const key = (process.env.TEMPO_UPSTREAM_BUYER_KEY || "").trim();
  if (!key) return null;
  if (accountCache && accountCache.key === key) return accountCache.acct;
  const { privateKeyToAccount } = await import("viem/accounts");
  const acct = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  accountCache = { key, acct };
  return acct;
}
export async function tempoBuyerAddress() { return (await account())?.address || null; }

/** Bucketed status, numbers never exposed: unconfigured / ok / low / unknown. */
export async function tempoBuyerStatus() {
  const acct = await account();
  if (!acct) return { status: "unconfigured" };
  const low = Number(process.env.TEMPO_UPSTREAM_BUYER_LOW_USD ?? 0.5);
  try {
    const data = "0x70a08231" + acct.address.toLowerCase().slice(2).padStart(64, "0");
    const hex = await rpc("eth_call", [{ to: TEMPO_USDC, data }, "latest"], { timeoutMs: 8000 });
    const usd = Number(BigInt(hex)) / 1e6;
    return { status: usd < low ? "low" : "ok", asset: "USDC.e", chain: TEMPO_CAIP2 };
  } catch {
    return { status: "unknown", asset: "USDC.e", chain: TEMPO_CAIP2 };
  }
}

// ---- pay one MPP seller over tempo/charge ----------------------------------
/**
 * Pay one MPP (tempo/charge) endpoint from the Tempo spending wallet and
 * return { result, quote, receipt } - the same shape payX402 returns, so the
 * router's receipt code is chain-agnostic.
 *
 * `createCredential(response402)` is injectable for tests (defaults to a real
 * mppx client bound to the spending wallet); `proof` is injectable too.
 */
export async function payTempo(url, {
  maxAtomic, method = "POST", body, headers = {}, timeoutMs = 20000, maxBytes = DEFAULT_MAX_BYTES,
  trusted = false, createCredential = null, proof = tempoInboundEvidence, minSettled = tempoMinSettled(), minPayers = tempoMinPayers(),
  memoizeDelivery = false,
} = {}) {
  assertSigningAllowed("a Tempo payment");
  if (maxAtomic == null) throw bad("payTempo requires maxAtomic (the margin-guard ceiling)", 500);
  if (!tempoBuyerConfigured() && !createCredential) throw bad("Tempo spending wallet not configured (TEMPO_UPSTREAM_BUYER_KEY)", 409);
  if (!trusted) await assertPublicUrl(url);
  const init = (extra = {}) => ({
    method,
    // Same identification as the x402 buyer, for the same reason: this path is
    // a bare fetch, so without it a Tempo purchase reaches the seller as `node`.
    // `extra` stays last - it carries the payment credential.
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
      "user-agent": ROUTER_UA,
      "x-agent402-via": "router",
      ...extra,
    },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    // Pin the resolved address on every hop (the one-shot assertPublicUrl above is
    // TOCTOU-rebindable), exactly as src/x402-buyer.js does.
    dispatcher: ssrfDispatcher,
  });
  // 1. Bare request -> the seller's live 402 (their quote is the truth, the
  //    registry price is a hint).
  const bare = await fetch(url, init());
  if (bare.status === 200) return { result: await readCapped(bare, maxBytes), quote: null, receipt: null };
  if (bare.status !== 402 && bare.status !== 401) throw bad(`Seller answered HTTP ${bare.status} to the unpaid request`, 502);
  const www = bare.headers.get("www-authenticate");
  if (!www) throw bad("Seller returned no WWW-Authenticate: Payment challenge", 502);
  const { Challenge } = await import("mppx");
  let challenges;
  try { challenges = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": www })); } catch { throw bad("Seller's MPP challenge did not parse", 502); }
  const ch = challenges.find((c) => c.method === "tempo" && c.intent === "charge");
  if (!ch) throw bad(`Seller offers no tempo/charge method (offered: ${challenges.map((c) => `${c.method}/${c.intent}`).join(", ") || "none"})`, 409);
  const req = ch.request || {};
  // 2. ASSET PIN + chain + margin guard, all before any signing.
  if (String(req.currency || "").toLowerCase() !== TEMPO_USDC_LC) throw bad(`Seller quotes ${req.currency || "an unknown currency"} - this wallet pays only USDC.e on Tempo`, 409);
  const chainId = req.methodDetails?.chainId;
  if (chainId !== undefined && Number(chainId) !== TEMPO_CHAIN_ID) throw bad(`Seller's challenge targets chain ${chainId}, not Tempo mainnet (${TEMPO_CHAIN_ID})`, 409);
  let quotedAtomic;
  try { quotedAtomic = BigInt(String(req.amount)); } catch { throw bad("Seller's challenge amount is not an integer base-units string", 502); }
  if (!(quotedAtomic > 0n)) throw bad("Seller quoted a zero amount", 502);
  if (quotedAtomic > BigInt(maxAtomic)) throw bad(`Seller's live quote (${Number(quotedAtomic) / 1e6} USDC) exceeds this call's ceiling (${Number(maxAtomic) / 1e6})`, 409);
  const recipient = String(req.recipient || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw bad("Seller's challenge names no valid recipient", 502);
  // 3. PROVEN-SELLER GATE (fail closed).
  let inbound;
  let inboundPayers;
  try {
    const ev = await proof(recipient);
    // A proof may answer a bare count (the older interface) or { count, payers }.
    if (ev && typeof ev === "object") { inbound = Number(ev.count) || 0; inboundPayers = ev.payers; }
    else inbound = ev;
  } catch (e) { throw bad(`Cannot verify seller settlement history on Tempo (${String(e?.message || e).slice(0, 80)}) - refusing to spend`, 503); }
  if (inbound < minSettled) throw bad(`Seller recipient ${recipient.slice(0, 8)}… has ${inbound} recent inbound USDC transfers on Tempo (floor ${minSettled}) - not routable yet`, 409);
  // THE SAME TRANSFERS FROM TWO WALLETS ARE NOT A MARKET (2026-09-28). The
  // count alone was cheap to reach from one or two wallets the seller holds;
  // the Base floor has required distinct payers since it existed. A proof that
  // names no payer figure (a primed count from an older read) is judged on
  // the count, as before.
  if (Number.isFinite(inboundPayers) && inboundPayers < minPayers) throw bad(`Seller recipient ${recipient.slice(0, 8)}… has ${inboundPayers} distinct recent payers on Tempo (floor ${minPayers}) - not routable yet`, 409);
  // 4. Sign a credential (validBefore = now + 25s in mppx) and send it at once.
  const mint = createCredential || (await defaultCredentialFactory());
  const credential = await mint(new Response(null, { status: 402, headers: { "WWW-Authenticate": Challenge.serialize(ch) } }));
  if (typeof credential !== "string" || !/^Payment\s/i.test(credential)) throw bad("Could not create an MPP credential", 502);
  // From here the credential has been handed to the seller, and nothing on
  // this rail can prove afterwards that it was not broadcast: every failure
  // below is stamped `committed`, with the amount the credential carries
  // (`signedUsd`), so a caller keeps that spend booked against the wallet
  // (route-execute) instead of treating it as nothing spent.
  try {
    const sentAt = Date.now();
    const paid = await fetch(url, init({ Authorization: credential }));
    const receiptHdr = paid.headers.get("payment-receipt");
    // DELIVERY MEMO, the payX402 rule on this rail (2026-09-28). Only the
    // router's own purchase writes it (memoizeDelivery, default false). Two
    // shapes are a failure to deliver: a 5xx with no receipt (the seller's
    // backend failed after our credential reached it), and ANY >= 400 that
    // carries a Payment-Receipt (the seller says it took the payment and still
    // answered with an error). A 402/401/4xx with no receipt is the seller
    // answering the request, which proves nothing about a charge on this rail
    // and is not recorded. A charged 400/413/415/422 is not recorded either:
    // a stock mppx seller settles BEFORE its handler, route-execute forwards
    // the caller's params as the body, and striking there would let anyone
    // bench an honest seller with two malformed bodies (isCallerInputStatus).
    // Two strikes inside the TTL before it steers anything (x402-buyer.js).
    if (memoizeDelivery && paid.status >= 400 && (paid.status >= 500 || (receiptHdr && !isCallerInputStatus(paid.status)))) {
      const origin = (() => { try { return new URL(url).origin; } catch { return null; } })();
      if (origin) noteSellerDeliveryFailure(origin, "tempo", { status: paid.status, ms: Date.now() - sentAt });
    }
    if (paid.status === 402 || paid.status === 401) throw bad(`Seller rejected the paid retry (HTTP ${paid.status})`, 502);
    if (paid.status >= 400) throw bad(`Seller failed after payment (HTTP ${paid.status})`, paid.status >= 500 ? 502 : 502);
    let reference = null;
    if (receiptHdr) {
      try { const { Receipt } = await import("mppx"); reference = Receipt.deserialize(receiptHdr)?.reference || null; } catch { /* best-effort */ }
    }
    // A settled delivery (a receipt with a reference) clears the memo, the
    // payX402 rule: a bare 200 proves the route answers, not that it takes
    // payment and delivers.
    if (memoizeDelivery && reference) { try { clearSellerDeliveryFailure(new URL(url).origin, "tempo"); } catch { /* unparseable url: nothing to clear */ } }
    recordUpstreamSpend("tempo-buyer", Number(quotedAtomic) / 1e6);
    return {
      result: await readCapped(paid, maxBytes),
      quote: { atomic: String(quotedAtomic), usd: Number(quotedAtomic) / 1e6, network: TEMPO_CAIP2 },
      receipt: { transaction: reference, network: TEMPO_CAIP2, wire: "mpp" },
    };
  } catch (err) {
    const e = err && typeof err === "object" ? err : bad(String(err), 502);
    e.committed = true;
    // The credential carries the quote and nothing more: the most it moves.
    e.signedUsd = Number(quotedAtomic) / 1e6;
    throw e;
  }
}

async function defaultCredentialFactory() {
  const acct = await account();
  if (!acct) throw bad("Tempo spending wallet not configured (TEMPO_UPSTREAM_BUYER_KEY)", 409);
  const { Mppx, tempo } = await import("mppx/client");
  const client = Mppx.create({ methods: [tempo.charge({ account: acct })], polyfill: false });
  return (res402) => client.createCredential(res402);
}

// Streams and stops at `maxBytes` (src/capped-body.js), so a seller's body is
// never held in full. `sha256` is over the bytes read; `truncated` says when
// that is a prefix.
async function readCapped(res, maxBytes) {
  const { bytes: buf, truncated } = await readBytesCapped(res, maxBytes);
  const text = decodeUtf8(buf);
  const ct = res.headers.get("content-type") || "";
  if (/json/i.test(ct)) { try { return JSON.parse(text); } catch { /* fall through */ } }
  return { text, truncated, contentType: ct, sha256: createHash("sha256").update(buf).digest("hex") };
}
