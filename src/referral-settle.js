// The client for a referral network's settlement facilitator
// (src/referral-gate.js is the only caller).
//
// A sale on a referral route pays the network's split contract, and only the network's
// facilitator can settle it. Every request to it is signed by a hot key of
// ours (REFERRAL_SIGNER_KEY): the body is serialized ONCE, and that exact
// string is both signed and sent, so the bytes the facilitator hashes are the
// bytes it received.
//
//   body      = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements })
//   digest    = keccak256(utf8(body) || uint64_be(timestamp))
//   signature = EIP-191 personal signature over the 32 digest bytes
//   headers   = X-Agent-Signature (65-byte hex), X-Agent-Timestamp (unix seconds)
//
// Every upstream answer is reduced to
//   { ok, transaction, payer, reason, retryable, status, inDoubt, side }
// and nothing else of it is kept: `reason` is a short code (the facilitator's
// own when it is one, else a status-derived one), never its message text.
// `inDoubt` is true when the answer does not say whether the payment moved:
// a timeout, a dropped connection, a 5xx, a 4xx the facilitator's documents
// do not name (an intermediary's 403, 408 or 429), an answer that is not the
// documented shape, a settlement the facilitator calls pending. The caller
// must not treat that as "not charged"; it reads the chain
// (src/referral-chain.js). A definite refusal carries `side`: "buyer" when
// it is a verdict on the payment, "ours" when it is about this server's own
// request, key or registration.
//
// The key is read once, never logged and never part of an error: a failure is
// reported as a code, and any text that reaches a log goes through
// redactSecrets first.
import { keccak256, concat, stringToHex, numberToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { redactSecrets } from "./tools/redact.js";

const MAX_BODY_BYTES = 64 * 1024;
export const REFERRAL_VERIFY_TIMEOUT_MS = 10_000;
export const REFERRAL_SETTLE_TIMEOUT_MS = 60_000;
const TX = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;

/** A facilitator's reason as a code, or `fallback` when it is not one. */
export function safeReason(value, fallback) {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  return REASON.test(s) ? s : fallback;
}

/** The exact bytes a request signs: keccak256(utf8(body) || uint64_be(ts)). */
export function referralRequestDigest(body, timestampSeconds) {
  return keccak256(concat([stringToHex(body), numberToHex(timestampSeconds, { size: 8 })]));
}

// Reasons that say the payment did not move and the same authorization may be
// sent again.
const RETRYABLE = new Set(["lookup_unavailable", "merchant_unavailable", "retryable"]);
// Definite refusals that are about this server's side, never the buyer's
// payment (the buyer is answered 503 and nothing is counted against it).
const OURS = new Set([...RETRYABLE, "merchant_signature", "signing_failed", "facilitator_http_401"]);
const sideOf = (reason) => (OURS.has(reason) ? "ours" : "buyer");
// The ONLY refusals that count toward the gate's own-fault hold: the
// facilitator refusing this server's signature (a 401, or the documented
// merchant-signature reason), and a request this server could not sign. A
// 400 is about the payment the buyer sent, and a lookup the facilitator could
// not make is its own: a buyer must not be able to close the route for
// everyone by sending payments the facilitator rejects.
const OWN_FAULT = new Set(["merchant_signature", "signing_failed", "facilitator_http_401"]);
const ownFaultOf = (status, reason) => status === 401 || OWN_FAULT.has(reason);
// A refusal that says the signed request was seen before (the network accepts
// a signed request once): a replay, not a bad signature.
const REPLAY_STYLE = /(^|_)(used|replay|replayed|duplicate|already|seen|nonce)(_|$)/;
// How far ahead of the clock a signed timestamp may be set, inside the
// facilitator's allowed skew (60 s either way), and how long a signed
// (body, timestamp) pair is remembered.
const SIGN_AHEAD_MAX_S = 30;
const SIGN_MEMORY_MS = 180_000;
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
// Reasons that leave the outcome open: the facilitator may still land it.
const PENDING = new Set(["settle_pending", "facilitator_timeout"]);

async function readJsonCapped(res) {
  const declared = Number(res.headers?.get?.("content-length") || 0);
  if (declared > MAX_BODY_BYTES) { try { await res.body?.cancel?.(); } catch { /* nothing to release */ } return null; }
  let text = "";
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { try { await reader.cancel(); } catch { /* already closed */ } return null; }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } else {
    text = String(await res.text());
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return null;
  }
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch { return null; }
}

const answer = (o) => ({ ok: false, transaction: null, payer: null, reason: null, retryable: false, status: 0, inDoubt: false, side: null, ownFault: false, ...o });

/**
 * @param {object} o
 * @param {string} o.facilitatorUrl   base URL (no trailing slash)
 * @param {string} o.signerKey        32-byte hex key, with or without 0x
 * @param {number} [o.verifyTimeoutMs]
 * @param {number} [o.settleTimeoutMs]
 * @param {boolean} [o.signVerify]    send the signed headers on /verify too (default true)
 * @param {typeof fetch} [o.fetchImpl]
 * @param {() => number} [o.now]
 */
export function createReferralSettler({ facilitatorUrl, signerKey, verifyTimeoutMs = REFERRAL_VERIFY_TIMEOUT_MS, settleTimeoutMs = REFERRAL_SETTLE_TIMEOUT_MS, signVerify = true, fetchImpl = fetch, now = Date.now } = {}) {
  const key = String(signerKey || "").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error("referral signer key is not a 32-byte hex key");
  let account;
  // The library's own error would quote the key: this one names only the setting.
  try { account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`); }
  catch { throw new Error("referral signer key is not a usable private key"); }
  const base = String(facilitatorUrl || "").replace(/\/+$/, "");

  // The same body is never signed with the same timestamp twice: /verify and
  // /settle carry one body, and a facilitator that accepts a signed request
  // once would refuse the second as a replay. A body signed before gets the
  // next second after its last one; past SIGN_AHEAD_MAX_S ahead of the clock
  // the call waits for the clock instead.
  const signedAt = new Map(); // body hash -> { ts: last timestamp signed, at }
  async function signedHeaders(body) {
    const t = now();
    if (signedAt.size > 2_000) { for (const [k, v] of signedAt) if (t - v.at > SIGN_MEMORY_MS) signedAt.delete(k); }
    const hash = keccak256(stringToHex(body));
    const prev = signedAt.get(hash);
    const repeat = !!prev && t - prev.at <= SIGN_MEMORY_MS;
    let timestamp = Math.floor(t / 1000);
    if (repeat && prev.ts >= timestamp) timestamp = prev.ts + 1;
    // True only if this exact pair was signed before (the line above prevents it).
    const samePair = repeat && prev.ts === timestamp;
    signedAt.set(hash, { ts: timestamp, at: t });
    const ahead = timestamp - Math.floor(now() / 1000);
    if (ahead > SIGN_AHEAD_MAX_S) await sleep((ahead - SIGN_AHEAD_MAX_S) * 1000);
    const signature = await account.signMessage({ message: { raw: referralRequestDigest(body, timestamp) } });
    return { headers: { "X-Agent-Signature": signature, "X-Agent-Timestamp": String(timestamp) }, samePair };
  }

  async function post(path, paymentPayload, paymentRequirements, { timeoutMs, signed }) {
    // Serialized once: this string is what is signed and what is sent.
    const body = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements });
    const headers = { Accept: "application/json", "Content-Type": "application/json" };
    let samePair = false;
    try {
      if (signed) { const h = await signedHeaders(body); Object.assign(headers, h.headers); samePair = h.samePair; }
    } catch {
      // Nothing was sent.
      return { sent: false, status: 0, data: null, failure: "signing_failed" };
    }
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const name = String(e?.name || "");
      return { sent: true, status: 0, data: null, failure: name === "TimeoutError" || name === "AbortError" ? "facilitator_timeout" : "facilitator_unreachable", samePair };
    }
    if (res.status >= 300 && res.status < 400) {
      try { await res.body?.cancel?.(); } catch { /* nothing to release */ }
      return { sent: true, status: res.status, data: null, failure: "redirect_refused", samePair };
    }
    let data = null;
    try { data = await readJsonCapped(res); } catch { data = null; }
    return { sent: true, status: res.status, data, failure: null, samePair };
  }
  // A refusal counts as this server's own fault only when it can be about
  // the signature: not when its reason says the request was seen before, and
  // not on a (body, timestamp) pair this process had already sent (`samePair`;
  // signedHeaders never repeats one, so this is a backstop). The buyer is
  // answered 503 either way.
  const ownFault401 = (r, status, reason) => ownFaultOf(status, reason) && !(r.samePair === true || REPLAY_STYLE.test(reason));

  /** Ask the facilitator whether the payment would settle. Never moves money. */
  async function verify(paymentPayload, paymentRequirements) {
    const r = await post("/verify", paymentPayload, paymentRequirements, { timeoutMs: verifyTimeoutMs, signed: signVerify });
    if (r.failure) return answer({ status: r.status, reason: r.failure, retryable: r.sent, inDoubt: true });
    const d = r.data;
    if (r.status === 200 && d && d.isValid === true) return answer({ ok: true, status: 200, payer: ADDR.test(String(d.payer || "")) ? String(d.payer).toLowerCase() : null });
    if (r.status === 200 && d && d.isValid === false) { const why = safeReason(d.invalidReason, "invalid_payment"); return answer({ status: 200, reason: why, side: sideOf(why), ownFault: ownFault401(r, 200, why) }); }
    const reason = safeReason(d?.errorReason ?? d?.invalidReason ?? d?.error, `facilitator_http_${r.status}`);
    // A 401, or a reason about our own side, is never the buyer's credential.
    if (r.status === 401 || OURS.has(reason)) return answer({ status: r.status, reason, retryable: true, side: "ours", ownFault: ownFault401(r, r.status, reason) });
    // The documented 400 (a JSON answer) refuses the payment that was sent: the buyer's credential.
    if (r.status === 400 && d) return answer({ status: 400, reason, side: "buyer" });
    // A verdict on the payment is only a documented one: a 200 with isValid
    // false, or that 400. Any other answer (an intermediary's 403 or 429, a
    // 5xx, a page that is not JSON, an undocumented 4xx) says nothing about
    // the buyer's payment: the service is unavailable, and nothing is counted
    // against the buyer.
    return answer({ status: r.status, reason: r.data ? reason : `facilitator_http_${r.status}`, retryable: true, inDoubt: true });
  }

  /** Settle the payment. `ok` only with a transaction hash. */
  async function settle(paymentPayload, paymentRequirements, { timeoutMs = settleTimeoutMs } = {}) {
    const r = await post("/settle", paymentPayload, paymentRequirements, { timeoutMs: Math.max(1_000, Math.min(settleTimeoutMs, Number(timeoutMs) || settleTimeoutMs)), signed: true });
    // Not sent at all: nothing can have moved.
    if (r.failure && !r.sent) return answer({ reason: r.failure, side: "ours", ownFault: true });
    if (r.failure) return answer({ status: r.status, reason: r.failure, inDoubt: true });
    const d = r.data;
    if (r.status === 200 && d && d.success === true) {
      const transaction = String(d.transaction || "");
      if (!TX.test(transaction)) return answer({ status: 200, reason: "settle_no_transaction", inDoubt: true });
      return answer({ ok: true, status: 200, transaction, payer: ADDR.test(String(d.payer || "")) ? String(d.payer).toLowerCase() : null });
    }
    const reason = safeReason(d?.errorReason ?? d?.error, r.status === 200 ? "settle_failed" : `facilitator_http_${r.status}`);
    if (PENDING.has(reason)) return answer({ status: r.status, reason, inDoubt: true });
    // The documented refusals: a 200 with success false, a 400, a 401, a 409,
    // and the 503 that names a lookup it could not make. None of them moved
    // money. Any other status (an intermediary's 403, 408 or 429, a 5xx) says
    // nothing about the payment.
    if (r.status === 200 && d && d.success === false) return answer({ status: 200, reason, retryable: RETRYABLE.has(reason), side: sideOf(reason), ownFault: ownFault401(r, 200, reason) });
    if (r.status === 401) return answer({ status: 401, reason, side: "ours", ownFault: ownFault401(r, 401, reason) });
    if (r.status === 400 || r.status === 409) return answer({ status: r.status, reason, retryable: RETRYABLE.has(reason), side: sideOf(reason), ownFault: ownFault401(r, r.status, reason) });
    if (r.status === 503 && RETRYABLE.has(reason)) return answer({ status: 503, reason, retryable: true, side: "ours" });
    return answer({ status: r.status, reason, inDoubt: true });
  }

  return { signerAddress: account.address, verify, settle };
}

/** One bounded, scrubbed line of free text for a log. */
export function referralLogText(value, max = 200) {
  return redactSecrets(String(value ?? "")).replace(/[\r\n\t]+/g, " ").slice(0, max);
}
