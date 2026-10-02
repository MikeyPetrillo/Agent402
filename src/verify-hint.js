// A rejected payment answered in the buyer's language.
//
// Every verify failure in the logs this week read the same way to the buyer:
// "invalid_payload: contract call failed: unable to call contract: execution
// reverted". That is CDP simulating the USDC transferWithAuthorization and the
// transfer reverting - an empty wallet, or an authorization already spent or
// expired - and the buyers' clients answered it by retrying the same signed
// header ~400 times an hour (2026-08-26, 08-28). Nothing in that message tells
// an agent which of the two it is, so it cannot adapt. This module does the
// one thing the facilitator will not: read the payer's own USDC balance on
// Base (a public eth_call, cached a minute) and say plainly whether the wallet
// is short or the authorization is stale, on the 402 itself, with a
// machine-readable `retry` verb.
//
// Bounded: one balance read per payer per minute, 1.5 s wait, reads coalesced
// into at most MAX_BATCHES_INFLIGHT multicall requests at once (the hook is awaited inside the paywall, so a
// forged payer must never buy seconds of our latency - review 2026-08-28), hint
// memory 5 min, 2,000 entries. The hint is keyed by the CREDENTIAL that failed
// (sha256 of the authorization's from + nonce + signature), never by the
// address alone: the payer field is unverified client text at verify time,
// so an address-keyed hint let anyone read any wallet's balance through us
// and plant a misleading hint on a real buyer's next 402 (review
// 2026-08-28). Only the exact retried header sees its own hint; telemetry
// gets a BUCKET, never an address.
import { createHash } from "node:crypto";
import { encodeFunctionData, decodeFunctionResult } from "viem";
import { classifyPaymentRejection, classifySettlementRefusal, unclassifiedPaymentShape, unclassifiedPaymentHint } from "./payment-reject.js";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BALANCE_TTL_MS = 60_000;
const HINT_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 2_000;
const RPC_TIMEOUT_MS = 1_500;
const balances = new Map(); // payer -> { usd, at }
const hints = new Map();    // credential key -> { hint, retry, balanceUsd, priceUsd, network, reason, at }
let inflight = 0;

/** Stable key for one signed credential (the decoded x402 payment payload).
 *  EVM: from + nonce + signature (a replayed header hashes the same; a fresh
 *  authorization is a new key). Other schemes: the sorted payload JSON. */
export function credentialKeyOf(paymentPayload) {
  try {
    const inner = paymentPayload?.payload ?? paymentPayload;
    const a = inner?.authorization;
    const material = a && typeof a === "object"
      ? `${String(a.from || "").toLowerCase()}|${String(a.nonce || "")}|${String(inner.signature || "")}`
      : JSON.stringify(inner, Object.keys(inner || {}).sort());
    if (!material || material === "||") return null;
    return createHash("sha256").update(material).digest("hex").slice(0, 32);
  } catch { return null; }
}

/** The same key from the raw request header (payment-signature | x-payment). */
export function credentialKeyFromHeader(header) {
  if (!header) return null;
  try { return credentialKeyOf(JSON.parse(Buffer.from(String(header), "base64").toString("utf-8"))); } catch { return null; }
}

const bounded = (m) => { if (m.size > MAX_ENTRIES) { const first = m.keys().next().value; m.delete(first); } };

/** RPCs the balance read tries, in order. An explicit AGENT402_BASE_RPC is
 *  authoritative and used ALONE (an operator's choice, and the seam every test
 *  stub uses, so a stubbed boot can never fall through to a public node).
 *  Unset (production today): two public endpoints, then Alchemy when a key is
 *  configured. Any caller can trigger a read with a forged header naming any
 *  address, so the metered provider is the last resort, not the first. A read moves to the next only when the previous one failed
 *  (transport error, non-JSON, or a JSON-RPC error such as a rate limit),
 *  inside the same time budget. */
export function baseRpcUrls(env = process.env) {
  const override = String(env.AGENT402_BASE_RPC || "").trim();
  if (override) return [override];
  return [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
    env.ALCHEMY_API_KEY ? `https://base-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}` : "",
  ].filter(Boolean);
}

// Burst-safe balance reads (2026-09-29). The earlier shape allowed four reads
// in flight and refused the fifth at once as "unknown"; measured on 2026-09-28,
// two bursts of ~30 distinct zero-balance wallets inside one minute each read
// about half their balances as unknown, so those buyers got the generic hint
// instead of "this wallet is empty". Now reads are COALESCED: every wallet
// asked for inside a short window rides one Multicall3 aggregate3 eth_call
// (up to BATCH_MAX balanceOf calls in one request). The bounds that stop this
// being an amplifier stay: at most MAX_BATCHES_INFLIGHT requests at once, at
// most MAX_QUEUED wallets waiting (past that a read answers unknown at once),
// and no caller waits past WAIT_MS whatever the RPC does.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const BATCH_WINDOW_MS = 10;
const BATCH_MAX = 100;
const MAX_QUEUED = 256;
const MAX_BATCHES_INFLIGHT = 2;
const WAIT_MS = RPC_TIMEOUT_MS;
const queue = new Map();        // address -> resolve (queued, not yet sent)
const pendingByAddr = new Map(); // address -> promise (queued or in flight)
let flushTimer = null;
let batchCtx = null;

const AGG3_ABI = [{ type: "function", name: "aggregate3", stateMutability: "payable",
  inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "callData", type: "bytes" }] }],
  outputs: [{ name: "returnData", type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }] }];

/** aggregate3 over balanceOf(addr) on Base USDC (allowFailure on each). */
export function encodeBalanceMulticall(addresses) {
  return encodeFunctionData({ abi: AGG3_ABI, functionName: "aggregate3",
    args: [addresses.map((a) => ({ target: USDC_BASE, allowFailure: true, callData: "0x70a08231" + a.slice(2).padStart(64, "0") }))] });
}

/** aggregate3's result as USD numbers (null for a failed inner call). Throws
 *  on a malformed whole or a length that does not match the batch. */
export function decodeBalanceMulticall(hex, count) {
  const rows = decodeFunctionResult({ abi: AGG3_ABI, functionName: "aggregate3", data: hex });
  if (!Array.isArray(rows) || rows.length !== count) throw new Error("multicall result length mismatch");
  return rows.map((r) => (r.success && typeof r.returnData === "string" && r.returnData.length >= 66
    ? Number(BigInt(r.returnData.slice(0, 66))) / 1e6 : null));
}

async function runBatch(entries, ctx) {
  const addrs = entries.map(([a]) => a);
  const settle = (vals) => entries.forEach(([a, resolve], i) => { pendingByAddr.delete(a); resolve(vals ? vals[i] : null); });
  const deadline = Date.now() + WAIT_MS;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: MULTICALL3, data: encodeBalanceMulticall(addrs) }, "latest"] });
  for (const url of ctx.urls) {
    const left = deadline - Date.now();
    if (left <= 50) break;
    try {
      const res = await ctx.fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(left) });
      const j = await res.json();
      if (typeof j?.result !== "string") continue; // a JSON-RPC error (rate limit) -> next RPC
      const vals = decodeBalanceMulticall(j.result, addrs.length);
      const at = ctx.now();
      addrs.forEach((a, i) => { if (vals[i] != null) { balances.set(a, { usd: vals[i], at }); bounded(balances); } });
      settle(vals);
      return;
    } catch { /* next RPC */ }
  }
  settle(null);
}

function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  while (queue.size && inflight < MAX_BATCHES_INFLIGHT) {
    const entries = [...queue.entries()].slice(0, BATCH_MAX);
    for (const [a] of entries) queue.delete(a);
    inflight++;
    runBatch(entries, batchCtx).finally(() => { inflight--; if (queue.size) flush(); });
  }
}

/** USDC balance of `address` on Base, in USD (6 decimals). null when unreadable. */
export async function usdcBalanceOnBase(address, { fetchImpl = fetch, rpcUrl, rpcUrls, now = Date.now } = {}) {
  const key = String(address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(key)) return null;
  const c = balances.get(key);
  if (c && now() - c.at < BALANCE_TTL_MS) return c.usd;
  let p = pendingByAddr.get(key);
  if (!p) {
    if (queue.size >= MAX_QUEUED) return null; // a flood of addresses reads as unknown, never an unbounded queue
    p = new Promise((resolve) => queue.set(key, resolve));
    pendingByAddr.set(key, p);
    batchCtx = { fetchImpl, now, urls: rpcUrls || (rpcUrl ? [rpcUrl] : baseRpcUrls()) };
    if (queue.size >= BATCH_MAX) flush();
    else if (!flushTimer) { flushTimer = setTimeout(flush, BATCH_WINDOW_MS); }
  }
  let t;
  const timeout = new Promise((r) => { t = setTimeout(() => r(null), WAIT_MS); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
}

export const _inflightForTest = () => inflight;
export const _queuedForTest = () => queue.size;
export const _limitsForTest = { BATCH_MAX, MAX_QUEUED, MAX_BATCHES_INFLIGHT, WAIT_MS };

/** Bucket for telemetry (never the number, never the address). */
export function balanceBucket(balanceUsd, priceUsd) {
  if (balanceUsd == null) return "unknown";
  if (balanceUsd <= 0) return "zero";
  if (Number.isFinite(priceUsd) && balanceUsd < priceUsd) return "under-price";
  return "covers-price";
}

/** The plain-language hint. Pure; exported for tests. */
export function hintFor({ reason, balanceUsd, priceUsd, network, payer }) {
  const r = String(reason || "");
  const price = Number.isFinite(priceUsd) ? `$${priceUsd.toFixed(priceUsd < 0.01 ? 4 : 3)}` : "the listed price";
  const short = payer ? `${payer.slice(0, 6)}...${payer.slice(-4)}` : "your wallet";
  const reverted = /execution reverted|contract call failed|insufficient|balance/i.test(r);
  if (reverted && balanceUsd != null && (balanceUsd <= 0 || (Number.isFinite(priceUsd) && balanceUsd < priceUsd))) {
    // MEASURED 2026-09-19: 6,473 of 6,582 Base verify failures in 30 days came
    // from 20 wallets in this exact state - holding USDC, just less than the
    // price - and each retried the same doomed authorization 300-plus times.
    // Only 10 attempts were an actually EMPTY wallet. So the common case is
    // not "fund me", it is a buyer who can afford something and is asking for
    // the wrong thing, and "fund the wallet" is a dead end for them. Naming
    // what their balance DOES cover turns the refusal into a route they can
    // take now. `affordable` is filled by the middleware, which is where the
    // catalog is reachable; the sentence degrades gracefully without it.
    const funded = balanceUsd > 0;
    return {
      retry: funded ? "lower-price-route" : "fund-wallet",
      wantsAffordable: funded,
      hint: `${short} holds $${balanceUsd.toFixed(4)} USDC on Base and this call costs ${price}. ${funded
        ? "Either fund the wallet and sign a NEW authorization, or call something this balance already covers - GET /api/pricing lists every route and its price, and /api/find?q=<task> ranks them."
        : "Fund the wallet (or pay on another network listed in accepts), then sign a NEW authorization; re-sending this one will keep failing."}`,
    };
  }
  if (reverted) {
    return {
      retry: "fresh-authorization",
      hint: `${short} covers ${price}, so the authorization itself was refused on-chain: its nonce was already spent or its validity window has passed. Never re-send a signed authorization; sign a fresh one for this request.`,
    };
  }
  if (/expired|validBefore|valid_before/i.test(r)) return { retry: "fresh-authorization", hint: "The authorization's validity window has passed. Sign a fresh one." };
  if (/nonce|already used|replay/i.test(r)) return { retry: "fresh-authorization", hint: "That authorization nonce was already used. Sign a fresh one; a settled call is never re-charged." };
  if (/network|unsupported|scheme/i.test(r)) return { retry: "other-network", hint: `Pay on a network listed in accepts${network ? ` (the header named ${network})` : ""}.` };
  return { retry: "fresh-authorization", hint: "The payment was refused before settlement. Sign a fresh authorization exactly matching one entry in accepts; nothing was charged." };
}

/** Called from the x402 verify hooks (thrown failure AND graceful
 *  `isValid:false`). Reads the balance (bounded) and remembers the hint under
 *  the failed CREDENTIAL's key; `paymentPayload` is the decoded payload the
 *  paywall verified (`payer` alone is accepted for tests). */
export async function noteVerifyFailure({ paymentPayload, payer, network, reason, priceUsd, now = Date.now, balanceReader = usdcBalanceOnBase }) {
  const from = String(payer || paymentPayload?.payload?.authorization?.from || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(from)) return null;
  const key = paymentPayload ? credentialKeyOf(paymentPayload) : null;
  const isBase = /^eip155:8453$/.test(String(network || ""));
  const balanceUsd = isBase ? await balanceReader(from) : null;
  const h = hintFor({ reason, balanceUsd, priceUsd, network, payer: from });
  const entry = { ...h, balanceUsd, priceUsd, network, reason: String(reason || "").slice(0, 200), at: now() };
  if (key) { hints.set(key, entry); bounded(hints); }
  return { ...entry, bucket: balanceBucket(balanceUsd, priceUsd), key };
}

/** The remembered hint for one credential key (null when none / expired). */
export function hintForCredential(key, { now = Date.now } = {}) {
  if (!key) return null;
  const h = hints.get(key);
  if (!h || now() - h.at > HINT_TTL_MS) return null;
  return h;
}

/** Express middleware: a 402 answered to a request that CARRIED the exact
 *  credential that failed gets its hint merged into the JSON body and a
 *  Retry-After that slows a loop. Requests with no payment header, a
 *  different credential, and every non-402 pass through byte-identical. The
 *  offer is never touched here: the 402 body mirror
 *  (src/payment-required-body.js) merges the PAYMENT-REQUIRED offer in after
 *  these fields, and because each of these bodies carries a hint it drops
 *  `error` (the "Payment rejected" fallback and the header's sentence alike),
 *  so a client that reads `error` first reads the hint instead. */
export function verifyHintMiddleware() {
  return function verifyHint(req, res, next) {
    const header = req.headers["payment-signature"] || req.headers["x-payment"];
    if (!header) return next();
    const origJson = res.json.bind(res);
    res.json = function hintedJson(body) {
      if (res.statusCode === 402 && body && typeof body === "object" && !Array.isArray(body)) {
        // SETTLEMENT refused on OUR billing quota: the payment verified, the
        // call ran, and the facilitator would not settle it. The buyer's
        // wallet is fine and another listed network will settle, so say
        // exactly that, read from the settle receipt @x402/express has
        // already set on this response. No Retry-After: retrying the same
        // rail is the one thing that will not help.
        const settled = typeof res.getHeader === "function"
          ? (res.getHeader("PAYMENT-RESPONSE") || res.getHeader("X-PAYMENT-RESPONSE"))
          : null;
        const refused = settled ? classifySettlementRefusal(settled) : null;
        if (refused) {
          req.__paymentRejectReason = refused.reason; // for the paywall rollup
          return origJson({ ...body, error: body.error || "Payment rail temporarily unavailable", reason: refused.reason, ...(refused.network ? { network: refused.network } : {}), hint: refused.detail, retry: refused.retry });
        }
        const h = hintForCredential(credentialKeyFromHeader(header));
        if (h) {
          if (!res.headersSent) res.setHeader("Retry-After", h.retry === "fund-wallet" ? "60" : "5");
          return origJson({ ...body, hint: h.hint, retry: h.retry, ...(h.balanceUsd != null ? { payerUsdcOnBase: Number(h.balanceUsd.toFixed(6)) } : {}) });
        }
        // No facilitator hint means the payment never REACHED the facilitator:
        // @x402/express refused it first and threw the reason away. Read the
        // header ourselves and say what is wrong, so a looping client can
        // adapt instead of resending the same bytes forever.
        // getHeader is guarded: callers legitimately hand this middleware a
        // minimal `res` (the unit tests do), and a diagnostic must never be the
        // thing that breaks a 402.
        const advertised = typeof res.getHeader === "function"
          ? (res.getHeader("PAYMENT-REQUIRED") || res.getHeader("payment-required"))
          : null;
        const why = advertised ? classifyPaymentRejection({ paymentHeader: header, paymentRequiredHeader: advertised }) : null;
        if (why) {
          if (!res.headersSent) res.setHeader("Retry-After", "5");
          req.__paymentRejectReason = why.reason; // for the paywall rollup
          // WHICH field differs, for requirements-mismatch. Key NAMES only,
          // same rule as the unclassified shape: the reason alone told us the
          // class but not what the client is actually getting wrong, which is
          // the one thing needed to help them or to spot a fault of ours.
          if (Array.isArray(why.fields) && why.fields.length) {
            // diff AND the full echoed key list: which key is wrong, and
            // whether it replaced a field or sits beside it.
            const all = Array.isArray(why.acceptedKeys) ? `|a:${why.acceptedKeys.join(",")}` : "";
            req.__paymentRejectShape = `f:${why.fields.join(",")}${all}`.slice(0, 110);
          }
          return origJson({ ...body, error: body.error || "Payment rejected", reason: why.reason, hint: why.detail, retry: why.retry });
        }
        // Refused, and we could not say why. Record the payload's SHAPE (key
        // names only, never a value) so the next one of these answers itself
        // instead of costing another guess-and-deploy cycle.
        req.__paymentRejectReason = "unclassified";
        req.__paymentRejectShape = advertised ? unclassifiedPaymentShape(header) : null;
        // ...and tell the BUYER the same thing. This used to be telemetry only,
        // so a developer whose client failed in a way we had no name for got an
        // unadorned 402 - silence from the one system that could see exactly
        // what they had sent. An unclassified refusal is as likely to be our
        // defect as theirs, which is the other reason it should not be silent.
        const shapeHint = advertised ? unclassifiedPaymentHint({ paymentHeader: header, paymentRequiredHeader: advertised }) : null;
        if (shapeHint) {
          if (!res.headersSent) res.setHeader("Retry-After", "5");
          return origJson({ ...body, error: body.error || "Payment rejected", reason: shapeHint.reason, hint: shapeHint.detail, retry: shapeHint.retry });
        }
      }
      return origJson(body);
    };
    next();
  };
}

export const _testResetForTest = () => { balances.clear(); hints.clear(); queue.clear(); pendingByAddr.clear(); if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } };
