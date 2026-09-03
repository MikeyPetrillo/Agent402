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
// Bounded: one RPC read per payer per minute, 1.5 s timeout, at most
// MAX_INFLIGHT reads at once (the hook is awaited inside the paywall, so a
// forged payer must never buy seconds of our latency - review 2026-08-28), hint
// memory 5 min, 2,000 entries. The hint is keyed by the CREDENTIAL that failed
// (sha256 of the authorization's from + nonce + signature), never by the
// address alone: the payer field is unverified client text at verify time,
// so an address-keyed hint let anyone read any wallet's balance through us
// and plant a misleading hint on a real buyer's next 402 (review
// 2026-08-28). Only the exact retried header sees its own hint; telemetry
// gets a BUCKET, never an address.
import { createHash } from "node:crypto";
import { classifyPaymentRejection, unclassifiedPaymentShape } from "./payment-reject.js";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_RPC = () => process.env.AGENT402_BASE_RPC || "https://mainnet.base.org";
const BALANCE_TTL_MS = 60_000;
const HINT_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 2_000;
const MAX_INFLIGHT = 4;
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

/** USDC balance of `address` on Base, in USD (6 decimals). null when unreadable. */
export async function usdcBalanceOnBase(address, { fetchImpl = fetch, rpcUrl = BASE_RPC(), now = Date.now } = {}) {
  const key = String(address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(key)) return null;
  const c = balances.get(key);
  if (c && now() - c.at < BALANCE_TTL_MS) return c.usd;
  if (inflight >= MAX_INFLIGHT) return null; // never queue: a full lane reads as unknown
  inflight++;
  try {
    const data = "0x70a08231" + key.slice(2).padStart(64, "0"); // balanceOf(address)
    const res = await fetchImpl(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_BASE, data }, "latest"] }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const j = await res.json();
    if (typeof j?.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(j.result)) return null;
    const usd = Number(BigInt(j.result || "0x0")) / 1e6;
    balances.set(key, { usd, at: now() }); bounded(balances);
    return usd;
  } catch { return null; } finally { inflight--; }
}

export const _inflightForTest = () => inflight;

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
    return {
      retry: "fund-wallet",
      hint: `${short} holds $${balanceUsd.toFixed(4)} USDC on Base and this call costs ${price}. Fund the wallet (or pay on another network listed in accepts), then sign a NEW authorization; re-sending this one will keep failing.`,
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
 *  credential that failed gets its hint merged into the JSON body (`error`
 *  and `accepts` untouched) and a Retry-After that slows a loop. Requests
 *  with no payment header, a different credential, and every non-402 pass
 *  through byte-identical. */
export function verifyHintMiddleware() {
  return function verifyHint(req, res, next) {
    const header = req.headers["payment-signature"] || req.headers["x-payment"];
    if (!header) return next();
    const origJson = res.json.bind(res);
    res.json = function hintedJson(body) {
      if (res.statusCode === 402 && body && typeof body === "object" && !Array.isArray(body)) {
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
        // instead of costing another guess-and-deploy cycle. The buyer's body
        // is untouched here - this is our telemetry, not their explanation.
        req.__paymentRejectReason = "unclassified";
        req.__paymentRejectShape = advertised ? unclassifiedPaymentShape(header) : null;
      }
      return origJson(body);
    };
    next();
  };
}

export const _testResetForTest = () => { balances.clear(); hints.clear(); };
