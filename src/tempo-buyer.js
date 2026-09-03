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
import { recordUpstreamSpend } from "./stats.js";
import { assertPublicUrl, ssrfDispatcher } from "./tools/fetch-guard.js";

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
const proofCache = new Map(); // recipientLc -> { at, count }
export const tempoMinSettled = () => Number(process.env.SOR_TEMPO_MIN_SETTLED_TX ?? 20);

/** Count inbound USDC.e transfers to `recipient` over the last ~15h of blocks.
 *  Injectable rpc for tests. Throws on RPC failure (callers fail closed). */
export async function tempoInboundCount(recipient, { rpcFn = rpc, now = Date.now() } = {}) {
  const key = String(recipient).toLowerCase();
  const hit = proofCache.get(key);
  if (hit && now - hit.at < PROOF_TTL_MS) return hit.count;
  const latest = parseInt(await rpcFn("eth_blockNumber", []), 16);
  const from = "0x" + Math.max(0, latest - PROOF_BLOCKS).toString(16);
  const topic = "0x" + key.slice(2).padStart(64, "0");
  const logs = await rpcFn("eth_getLogs", [{ fromBlock: from, toBlock: "latest", address: TEMPO_USDC, topics: [TRANSFER_TOPIC, null, topic] }]);
  const count = Array.isArray(logs) ? logs.length : 0;
  proofCache.set(key, { at: now, count });
  return count;
}
export function __testResetProofCache() { proofCache.clear(); }
/** Seed the proven-seller cache from an external read (the MPP leaderboard's
 *  batched scan, src/mpp-leaderboard.js) so a routed buy to a ranked seller
 *  does not re-scan the chain. Same TTL as a direct read. */
export function primeTempoInboundCount(recipient, count, now = Date.now()) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(recipient)) || !Number.isFinite(count)) return;
  proofCache.set(String(recipient).toLowerCase(), { at: now, count: Math.max(0, count | 0) });
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
  trusted = false, createCredential = null, proof = tempoInboundCount, minSettled = tempoMinSettled(),
} = {}) {
  if (maxAtomic == null) throw bad("payTempo requires maxAtomic (the margin-guard ceiling)", 500);
  if (!tempoBuyerConfigured() && !createCredential) throw bad("Tempo spending wallet not configured (TEMPO_UPSTREAM_BUYER_KEY)", 409);
  if (!trusted) await assertPublicUrl(url);
  const init = (extra = {}) => ({
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers, ...extra },
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
  try { inbound = await proof(recipient); } catch (e) { throw bad(`Cannot verify seller settlement history on Tempo (${String(e?.message || e).slice(0, 80)}) - refusing to spend`, 503); }
  if (inbound < minSettled) throw bad(`Seller recipient ${recipient.slice(0, 8)}… has ${inbound} recent inbound USDC transfers on Tempo (floor ${minSettled}) - not routable yet`, 409);
  // 4. Sign a credential (validBefore = now + 25s in mppx) and send it at once.
  const mint = createCredential || (await defaultCredentialFactory());
  const credential = await mint(new Response(null, { status: 402, headers: { "WWW-Authenticate": Challenge.serialize(ch) } }));
  if (typeof credential !== "string" || !/^Payment\s/i.test(credential)) throw bad("Could not create an MPP credential", 502);
  const paid = await fetch(url, init({ Authorization: credential }));
  if (paid.status === 402 || paid.status === 401) throw bad(`Seller rejected the paid retry (HTTP ${paid.status})`, 502);
  if (paid.status >= 400) throw bad(`Seller failed after payment (HTTP ${paid.status})`, paid.status >= 500 ? 502 : 502);
  let reference = null;
  const receiptHdr = paid.headers.get("payment-receipt");
  if (receiptHdr) {
    try { const { Receipt } = await import("mppx"); reference = Receipt.deserialize(receiptHdr)?.reference || null; } catch { /* best-effort */ }
  }
  recordUpstreamSpend("tempo-buyer", Number(quotedAtomic) / 1e6);
  return {
    result: await readCapped(paid, maxBytes),
    quote: { atomic: String(quotedAtomic), usd: Number(quotedAtomic) / 1e6, network: TEMPO_CAIP2 },
    receipt: { transaction: reference, network: TEMPO_CAIP2, wire: "mpp" },
  };
}

async function defaultCredentialFactory() {
  const acct = await account();
  if (!acct) throw bad("Tempo spending wallet not configured (TEMPO_UPSTREAM_BUYER_KEY)", 409);
  const { Mppx, tempo } = await import("mppx/client");
  const client = Mppx.create({ methods: [tempo.charge({ account: acct })], polyfill: false });
  return (res402) => client.createCredential(res402);
}

async function readCapped(res, maxBytes) {
  const buf = Buffer.from(await res.arrayBuffer());
  const slice = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  const text = slice.toString("utf8");
  const ct = res.headers.get("content-type") || "";
  if (/json/i.test(ct)) { try { return JSON.parse(text); } catch { /* fall through */ } }
  return { text, truncated: buf.length > maxBytes, contentType: ct, sha256: createHash("sha256").update(buf).digest("hex") };
}
