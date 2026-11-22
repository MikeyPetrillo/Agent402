// Opt-in idempotency for catalog routes, mounted by src/server.js right after
// the credits gate and before the paywall. Lives here so its tests drive the
// same code the server runs (scripts/test-idempotency-inflight.js).
import { createHash } from "node:crypto";
import { paymentHeaderOf, paymentIdentifierOf, paymentNonceIdentityOf } from "./payer.js";
import { IDEM_MAX_BODY_BYTES } from "./idempotency-limits.js";
import { createIdempotencyStore, IDEM_TTL_MS, INFLIGHT_RENEW_MS, INFLIGHT_MAX_MS } from "./idempotency-store.js";
import { onResponseEnd } from "./hangup-settlement.js";
import { allowanceServed } from "./allowance-state.js";
import { isX402McpRequest } from "./mcp-x402-routes.js";
import { MAX_SETTLED_VALIDITY_HOLD_MS, paymentReplayKey } from "./replay-guard.js";
import { decodePaymentHeader } from "./payment-header.js";
import { base64BytesOf } from "./base64-bytes.js";

// A stored answer is the body as served, or, when it was charged but never
// delivered (the buyer left while the payment settled), the body under this
// marker with the charge the server booked for it, so the replay can name it.
const STORED = "__a402Stored";
const wrapStored = (body, charged) => ({ [STORED]: 1, body, charged });
const unwrapStored = (hit) => (hit && typeof hit === "object" && !Array.isArray(hit) && hit[STORED] === 1 ? { body: hit.body, charged: hit.charged || null } : { body: hit, charged: null });

// THE SAME PAYMENT AFTER AN UNCONFIRMED SETTLE. A payment whose settle chain
// ended on an answer that does not show whether the transfer was sent is
// answered 402 settlement-unconfirmed (src/payments.js markUnconfirmedStop),
// and its authorization stays claimed while the transfer may still land
// (src/settlement-claims.js). Sent again, it used to run the handler again
// and then meet that claim at settle (duplicate_authorization), which the
// settle breaker reads as the buyer's fault. That answer is kept here under
// the payment's identity (any route or body: one authorization is one
// payment): for an EVM payment its network, signed payer and nonce
// (paymentNonceIdentityOf), so the same authorization re-encoded or naming
// another `resource` is the same payment; for any other rail the identity the
// replay guard reads from what its chain consumes (paymentReplayKey), else
// the credential text. It is stored with a digest of the payer's signature
// (unconfirmedSignatureOf), and the same payment sent again under that
// signature gets it back before the
// paywall: no handler run, no verify, no settle, nothing counted against the
// wallet. Kept until the authorization's validBefore (past it the
// authorization can no longer move money, and a new one is safe) plus a
// minute, at least a minute, at most MAX_SETTLED_VALIDITY_HOLD_MS (30 days);
// a payment that names no validBefore (Solana, Stellar, Algorand), a day.
//
// A payment cut at its network's settle deadline (src/settle-deadlines.js)
// also keeps the route's own answer beside it, when that answer replays (the
// server's implicitReplay rule: no lasting effect, no identity binding, not
// streamed) and fits. The same payment sent again is then asked of
// onCappedResend first: once the chain proves its transfer landed it is
// served that answer (its debt, if one was booked, voided first); until then,
// and whenever the check cannot say, the kept 402.
const UNCONFIRMED = "__a402Unconfirmed";
// What the settle deadlines leave on a request they cut (src/settle-deadlines.js CAPPED).
const CAPPED = Symbol.for("agent402.settleCapped");
const UNCONFIRMED_MIN_MS = 60_000;
const UNCONFIRMED_NO_EXPIRY_MS = 24 * 3600_000;
// A header field read as text: a string as is, a number as its digits,
// anything else (an object, including one whose own toString or valueOf is
// not a function, which String() throws on) as "". Every parse of a payment
// below reads a field through this, so a malformed header is a payment with
// no identity (the normal path and its 402), never a thrown error.
const textOf = (v) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "bigint" ? String(v) : "");
/** How long an unconfirmed answer is kept for an authorization whose
 *  validBefore is `validBefore` (unix seconds; none or unreadable reads as a
 *  payment that names no validBefore). */
export function unconfirmedReplayMs(validBefore, now = Date.now()) {
  const t = textOf(validBefore).trim();
  const vb = t === "" ? NaN : Number(t);
  if (!Number.isFinite(vb) || vb <= 0) return UNCONFIRMED_NO_EXPIRY_MS;
  return Math.min(MAX_SETTLED_VALIDITY_HOLD_MS, Math.max(UNCONFIRMED_MIN_MS, vb * 1000 - now + UNCONFIRMED_MIN_MS));
}
/** The key an unconfirmed answer is kept under for this request's payment. */
export function unconfirmedKeyOf(req, cred) {
  let id = null;
  try {
    const n = paymentNonceIdentityOf(req);
    if (n && typeof n.network === "string" && typeof n.from === "string" && typeof n.nonce === "string") id = `nonce\n${n.network}\n${n.from}\n${n.nonce}`;
    else {
      let k = null;
      try { k = paymentReplayKey(req); } catch { k = null; }
      // "<kind>:<identity>:<legacy>": the identity half is what the chain
      // consumes; a raw-credential key ("c:") is the text itself.
      if (typeof k === "string" && !k.startsWith("c:")) id = `replay\n${k.split(":").slice(0, 2).join(":")}`;
    }
  } catch { id = null; }
  return createHash("sha256").update(`unconfirmed-settle\n${id || `cred\n${textOf(cred)}`}`).digest("hex");
}
// THE SAME PAYMENT AFTER A FAILED SETTLE-FIRST RUN. A payment settled before
// its run (src/settle-first.js) whose run then failed, or whose answer was
// not delivered, is owed back (the refund ledger, class settle-first-failed).
// The failure says the same payment may be sent again (`retry:
// "same-payment"`): a CREDIT is kept here under the payment's identity (as
// for an unconfirmed answer, above) AND the route it paid for, bound to the
// payer's signature digest, for CREDIT_TTL_MS; the digest of the body it paid
// for is kept INSIDE the record, so a request carrying a payment header has
// its body hashed only when a credit is stored for that payment (a large body
// with a payment that holds none is never read here). The same request sent
// again with that payment is run once more WITHOUT any settlement (the
// payment is already taken): the server voids the debt before the run
// (onSettledFirstResend: a hold the refund run cannot claim past), restores
// it if the run fails again, and keeps it void when the answer is served, so
// a buyer is served once and never both served and refunded. A copy sent
// while one runs is told to wait (409). A served credit is spent here.
const CREDIT = "__a402SettledFirstCredit";
export const CREDIT_TTL_MS = 24 * 3600_000;
/** A digest of this request's JSON body, worked out once per request (the
 *  explicit or implicit idempotency key, the call digest of a kept answer and
 *  a settle-first credit all bind to it). Throws as JSON.stringify does. */
const bodyDigests = new WeakMap();
function bodyDigestOf(req) {
  const memo = bodyDigests.get(req);
  if (memo && memo.body === req.body) return memo.digest;
  const digest = createHash("sha256").update(JSON.stringify(req.body)).digest("hex");
  bodyDigests.set(req, { body: req.body, digest });
  return digest;
}
/** The body a settle-first credit is bound to: kept in the credit's record
 *  and compared with a resend's ("-" for none, "?" for one that cannot be read). */
export function settledFirstCreditBodyOf(req) {
  try { return req.body && typeof req.body === "object" && Object.keys(req.body).length ? bodyDigestOf(req) : "-"; } catch { return "?"; }
}
/** The key a settle-first credit is kept under for this request's payment and
 *  route (its body is bound inside the record: settledFirstCreditBodyOf). */
export function settledFirstCreditKeyOf(req, cred) {
  let id = null;
  try {
    const n = paymentNonceIdentityOf(req);
    if (n && typeof n.network === "string" && typeof n.from === "string" && typeof n.nonce === "string") id = `nonce\n${n.network}\n${n.from}\n${n.nonce}`;
    else {
      let k = null;
      try { k = paymentReplayKey(req); } catch { k = null; }
      if (typeof k === "string" && !k.startsWith("c:")) id = `replay\n${k.split(":").slice(0, 2).join(":")}`;
    }
  } catch { id = null; }
  const url = String(req.originalUrl || req.url || "");
  const qs = url.includes("?") ? `\n?${url.slice(url.indexOf("?") + 1)}` : "";
  const wire = isX402McpRequest(req) ? "x402-mcp " : "";
  return createHash("sha256").update(`settled-first-credit-v2\n${id || `cred\n${textOf(cred)}`}\n${wire}${req.method} ${req.path}${qs}`).digest("hex");
}

/** What binds a stored unconfirmed answer to the payer's own signature. The
 *  key above is the payment's identity, which anyone can name without the
 *  payer's key (a header with no valid signature naming its network, payer
 *  and nonce); the answer is replayed only to a header whose signature digest
 *  matches the one stored with it. An EVM payment: its signature (hex read
 *  in one case). A signed-transaction payment (Solana, Stellar, Algorand):
 *  the signed transaction bytes the chain consumes, decoded, so the same
 *  transaction re-encoded matches and one with other signatures does not.
 *  Anything else: its identity, or the credential text, which are themselves
 *  the whole signed payload. Null when no signature is named: never replayed. */
export function unconfirmedSignatureOf(req, cred) {
  try { return signatureDigestOf(req, cred); } catch { return null; }
}
function signatureDigestOf(req, cred) {
  const digest = (tag, v) => createHash("sha256").update(`${tag}\n`).update(v).digest("hex");
  let p = null;
  try { p = decodePaymentHeader(cred); } catch { p = null; }
  if (!p || typeof p !== "object") return textOf(cred) ? digest("cred", textOf(cred)) : null;
  const inner = p.payload && typeof p.payload === "object" ? p.payload : null;
  const sigOf = () => {
    const s = typeof inner?.signature === "string" ? inner.signature.trim() : "";
    if (!s) return null;
    return digest("sig", /^0x[0-9a-fA-F]+$/.test(s) ? s.toLowerCase() : s);
  };
  if (paymentNonceIdentityOf(req)) return sigOf();
  const accepted = p.accepted && typeof p.accepted === "object" ? p.accepted : null;
  const network = textOf(accepted?.network) || textOf(p.network) || textOf(inner?.network);
  if (inner && (network.startsWith("solana") || network.startsWith("stellar"))) {
    const bytes = base64BytesOf(inner.transaction);
    return bytes ? digest(`tx\n${network.split(":")[0]}`, bytes) : null;
  }
  if (inner && network.startsWith("algorand")) {
    const group = inner.paymentGroup;
    if (!Array.isArray(group) || !Number.isInteger(inner.paymentIndex)) return null;
    const bytes = base64BytesOf(group[inner.paymentIndex]);
    return bytes ? digest(`tx\nalgorand\n${inner.paymentIndex}`, bytes) : null;
  }
  const sig = sigOf();
  if (sig) return sig;
  let k = null;
  try { k = paymentReplayKey(req); } catch { k = null; }
  return typeof k === "string" && k ? digest("replay", k) : textOf(cred) ? digest("cred", textOf(cred)) : null;
}

/** Whether a re-sent x402 payment on `def`'s route may replay its first
 *  answer implicitly (src/server.js mounts it as `implicitReplay`): never on a
 *  route whose effect outlives the answer, never on an identity-bound route,
 *  never for a streamed call. The two predicates are the server's own. */
/** The credentials an Idempotency-Key binds to: an x402 payment (the MPP evm
 *  wire arrives translated into one), a prepaid credits key, a solved
 *  proof-of-work challenge. A Tempo or card credential is answered by its own
 *  gate's replay guard instead. Read by the conformance document. */
export const IDEMPOTENCY_CREDENTIALS = Object.freeze(["x402", "credits", "pow"]);

// A charge booked as owed AFTER its answer was stored (src/server.js
// recordHangupDebt; the hosted MCP connector's cut-off: the route wrote its
// settled 200 in full, so the answer was committed as delivered, and then the
// connector said it had stopped waiting). The request's middleware run
// registers how to restate its stored answer as charged-but-undelivered, so a
// resend of the same payment voids that debt before it is served, exactly as
// for a hang-up before the first byte: served once, never served and refunded.
const chargedLaterOf = new WeakMap(); // request -> (charged) => void
/** Restate this request's stored answer (if any) as charged under `charged`
 *  ({ tx, network, wire }); before the answer is stored, the charge rides the
 *  commit instead. No-op off a keyed request. */
export function noteChargedAfterServe(req, charged) {
  const fn = req && typeof req === "object" ? chargedLaterOf.get(req) : null;
  if (!fn || !charged || typeof charged !== "object" || typeof charged.tx !== "string" || !charged.tx) return false;
  try { return fn({ tx: charged.tx, network: charged.network ?? null, wire: charged.wire ?? null }) === true; } catch { return false; }
}

/** The note a debt's void carries when its stored answer is served on a resend. */
export const RESEND_SERVED_NOTE = "served on the resend of the same payment";

export function implicitReplayAllowed(def, req, { hasLastingEffect, isIdentityBound }) {
  return Boolean(def) && !hasLastingEffect(def.slug) && !isIdentityBound(def) && req?.body?.stream !== true;
}

/** What a resend of a charged-but-undelivered answer gets (src/server.js
 *  onReplay). Its debt is voided BEFORE the answer goes out, so a buyer is
 *  served once, never both served and refunded:
 *   - "serve": the void landed, or there is no row, or the row is already void;
 *   - "refunded": the refund run has claimed or paid the row (`row`);
 *   - "pending": the void did not land and the row still reads owed. The
 *     ledger write failed or is queued (a queued void lands later), so
 *     refusing as refunded would leave the buyer neither served nor repaid;
 *     the resend is asked to retry, and then reads whichever landed.
 *  voidOnClaim(tx) and rowOf(tx) are the ledger's voidOwedOnResend (a void
 *  that lands now or not at all, so a debt whose buyer never retries stays
 *  owed) and refundByEvidenceFresh; either may throw or answer a promise.
 *  A "serve" on a row that was already void hands the row back (`row`), so
 *  the caller can note that its answer went out. */
export async function chargedReplayVerdict(tx, { voidOnClaim, rowOf }) {
  let voided = false;
  try { voided = (await voidOnClaim(tx)) === true; } catch { voided = false; }
  if (voided) return { verdict: "serve", voided: true };
  let row = null;
  try { row = await rowOf(tx); } catch { row = null; }
  if (!row || row.status === "void") return { verdict: "serve", voided: false, ...(row ? { row } : {}) };
  if (row.status === "owed") return { verdict: "pending", row };
  return { verdict: "refunded", row };
}

/** isCatalogRoute(req): true for a priced catalog route. freeMode: dev/test boot with no paywall.
 *  implicitReplay(req): true when a re-sent x402 payment on this route may be
 *  answered from its first answer (the server excludes routes with a lasting
 *  effect and streamed calls); absent, no implicit key is derived.
 *  onReplay(req, { implicit, key, charged }): awaited once per stored answer
 *  before it is served; `charged` names the charge ({ tx, network, wire }) when
 *  the stored answer was charged and never delivered (see below), else null.
 *  Resolving { serve: false, status, body, retryAfter? } answers that instead
 *  of the stored body (the charge was refunded, or its debt's void has not
 *  landed yet); any other result serves it. */
/** settledFirstCredit(req, status): what a credit for this request's payment
 *  holds ({ tx, network, wire, note, receipt }) when its payment was settled
 *  before its run and the run ended with `status` (>= 400, or 499 for an
 *  answer not delivered); else null. onSettledFirstResend(req, credit):
 *  awaited when the same payment is sent again; resolves { serve: true } to
 *  run it (the server marked the request), or { serve: false, status, body,
 *  retryAfter? } to answer that instead. Both from the server. */
export function createIdempotency({ isCatalogRoute, freeMode = false, store = createIdempotencyStore(), implicitReplay = null, onReplay = null, onCappedResend = null, settledFirstCredit = null, onSettledFirstResend = null }) {
  // Opt-in idempotency (safe retry for paid/proven calls). If a client sends an
  // `Idempotency-Key`, a successful gated call is cached keyed by that key + the
  // gate credential it presented (the x402 payment authorization or the
  // proof-of-work token — both single-use). A retry with the SAME Idempotency-Key
  // AND the SAME credential replays the stored result WITHOUT re-charging — so an
  // agent that paid but lost the response doesn't pay twice. Because the cache key
  // includes the credential (which only the original payer/solver holds), it can
  // never serve a paid result to a non-payer; requests without the header are
  // completely unaffected (default behavior, normal billing). Runs before the
  // paywall so a replay hit skips settlement.
  // The answers and the in-flight claims live in src/idempotency-store.js:
  // Redis when one is reachable (so a retry that lands on another container
  // still replays), else this process. IDEM_MAX_BODY_BYTES lives in
  // src/idempotency-limits.js (the tool pages quote it); IDEM_TTL_MS in the store.
  void IDEM_TTL_MS;
  const idemHashKey = (req) => {
    // The x402 `payment-identifier` extension (declared on every route's 402) is
    // honoured as an ALIAS of the Idempotency-Key header under the SAME binding
    // rules below (exact credential + route + body) - so a stock x402 client that
    // attaches a payment id gets the paid-retry replay without knowing our
    // header. It is NOT a cross-authorization dedupe: the id is client-chosen
    // text on a payload nothing has verified yet at this point in the chain, so
    // only the exact original credential can replay (a fresh authorization with
    // the same id is a new payment). Header wins when both are present.
    let idem = req.header("idempotency-key") || paymentIdentifierOf(req);
    if (idem && idem.length > 256) return null;
    // IMPLICIT KEY (2026-10-23). A client that re-sends a request with the SAME
    // signed x402 payment (one EIP-3009 authorization, one nonce) after a
    // timeout was answered twice: the first copy settled and was served, the
    // second ran the handler again and its settlement reverted (nonce used),
    // so the buyer read a 402 for a call it had paid for and the settle
    // breaker counted a failure. The nonce is single-use on chain, so a
    // payment's identity (network, signed payer, nonce) names exactly one
    // call: with no explicit key it becomes the key, under the same binding
    // as an explicit one (this exact credential, route and body), so the
    // replay is served from the first answer with no handler run and no
    // settlement. A different body or route under the same nonce is a
    // different key and takes the normal path. Only an EVM payment has such
    // a nonce; a PoW token and a credits key never derive one (the token has
    // its own replay guard, a credits key is reusable, so a repeat is a new
    // call). Routes the server lists as excluded (a lasting effect, a stream)
    // keep their explicit-key behavior only.
    let implicit = false;
    if (!idem && typeof implicitReplay === "function" && implicitReplay(req)) {
      const id = paymentNonceIdentityOf(req);
      if (id) { idem = `nonce:${id.network}:${id.from}:${id.nonce}`; implicit = true; }
    }
    if (!idem) return null;
    // Must match @x402/express's OWN precedence exactly (payment-signature wins
    // when both are present, verified against node_modules/@x402/express) - the
    // credential that actually settles the payment is the only one allowed to
    // seed the cache key. Checking x-payment first let an attacker settle for
    // real via a valid Payment-Signature while binding the cache entry to a
    // SELF-CHOSEN, non-secret X-Payment string - any third party who later knew
    // that string (the payer can simply publish it) could replay the same
    // Idempotency-Key + that string + the same body and hit the cache BEFORE
    // the paywall middleware below ever runs, with no payment of their own.
    // A prepaid credits key is a credential too (it authorizes and debits the
    // call): bind its HASH so a credits buyer's retry replays the paid answer
    // instead of re-debiting, exactly like an x402 buyer's (audit 2026-08-26 -
    // the plugin README promised this and the server ignored the header).
    const creditsCred = /^Bearer a402_[A-Za-z0-9_-]{16,80}$/.test(String(req.headers?.authorization || ""))
      ? "credits:" + createHash("sha256").update(req.headers.authorization.slice(7)).digest("hex") : null;
    // A credits-settled request binds to its key hash FIRST: the gate already
    // authorized it, and an unverified x-pow-solution riding alongside would
    // otherwise bind a paid entry to a public string anyone could replay.
    const x402Cred = paymentHeaderOf(req);
    const powCred = req.header("x-pow-solution");
    const cred = x402Cred || (req.creditsSettled === true ? creditsCred : null) || powCred || creditsCred;
    if (!cred) return null; // nothing to securely bind the key to → don't cache
    // Which presented credential the key is bound to, so the store step can
    // require that it is the one the gate actually verified.
    const kind = cred === x402Cred ? "x402" : cred === creditsCred ? "credits" : "pow";
    if (!IDEMPOTENCY_CREDENTIALS.includes(kind)) return null;
    // Bind to the exact route AND the request body, so the same key+credential
    // can't be used to retrieve a cached response from a different payload or
    // different endpoint. Body is hashed (not stored) so the key stays compact.
    const bodyHash = req.body && Object.keys(req.body).length ? bodyDigestOf(req) : "-";
    // A GET tool takes its input on the query string: bound too (as sent), so
    // a repeat with another input is a different call. Added only when there
    // is one, so a query-less key hashes exactly as before.
    const url = String(req.originalUrl || req.url || "");
    const qs = url.includes("?") ? `\n?${url.slice(url.indexOf("?") + 1)}` : "";
    // A connector x402 twin (src/mcp-x402-routes.js) runs on the tool's own
    // path but quotes another resource: bound apart, so one payment's answer
    // on one is never served as the other's.
    const wire = isX402McpRequest(req) ? "x402-mcp " : "";
    return { key: createHash("sha256").update(`${wire}${req.method} ${req.path}${qs}\n${idem}\n${cred}\n${bodyHash}`).digest("hex"), kind, implicit };
  };
  // The call a request makes (its wire, route, query and body), so a kept
  // route answer is served only to the same call: the unconfirmed 402 is the
  // payment's whatever the call, the route's answer is that call's alone.
  const callDigestOf = (req) => {
    const bodyHash = req.body && typeof req.body === "object" && Object.keys(req.body).length ? bodyDigestOf(req) : "-";
    const url = String(req.originalUrl || req.url || "");
    const qs = url.includes("?") ? `\n?${url.slice(url.indexOf("?") + 1)}` : "";
    const wire = isX402McpRequest(req) ? "x402-mcp " : "";
    return createHash("sha256").update(`${wire}${req.method} ${req.path}${qs}\n${bodyHash}`).digest("hex");
  };
  // The unconfirmed answer of a payment, back for the same payment (above).
  const replayUnconfirmed = (req, res, rec) => {
    // Every 402 is no-store already (src/paid-no-store.js).
    if (typeof rec.receipt === "string" && rec.receipt) res.setHeader("PAYMENT-RESPONSE", rec.receipt);
    res.setHeader("X-Replayed-Answer", "1");
    req.__paymentRejectReason = typeof rec.body?.reason === "string" ? rec.body.reason : "settlement-unconfirmed";
    res.status(402).type("application/json");
    return res.send(JSON.stringify(rec.body));
  };
  // The same payment sent again after a settle-deadline cut, with the
  // route's answer kept: served once the transfer is proven (onCappedResend),
  // else the kept 402.
  const replayCapped = async (req, res, rec) => {
    let v = null;
    try { v = await onCappedResend(req, { payment: rec.capped.payment }); } catch { v = null; }
    if (v && typeof v === "object" && v.serve === true) {
      if (typeof v.receipt === "string" && v.receipt) res.setHeader("PAYMENT-RESPONSE", v.receipt);
      res.setHeader("X-Idempotent-Replay", "true");
      res.setHeader("X-Replayed-Answer", "1");
      return res.status(200).json(rec.capped.answer);
    }
    if (v && typeof v === "object" && v.serve === false) {
      if (Number(v.retryAfter) > 0) res.setHeader("Retry-After", String(Math.ceil(Number(v.retryAfter))));
      return res.status(Number(v.status) || 402).json(v.body && typeof v.body === "object" ? v.body : { error: "replay_refused" });
    }
    return replayUnconfirmed(req, res, rec);
  };
  // Keep this request's unconfirmed answer (set on the request by the
  // paywall when it sent one) for the same payment sent again.
  const keepUnconfirmed = (req, res, uKey, sig) => {
    // The route's own answer, for a payment the settle deadlines cut: the
    // first JSON body the handler sent as a 200 (the paywall's 402 that
    // replaces it is written with its own status).
    let answer;
    let replays = false;
    try { replays = typeof onCappedResend === "function" && typeof implicitReplay === "function" && implicitReplay(req) === true; } catch { replays = false; }
    if (replays && typeof res.json === "function") {
      const prior = res.json;
      res.json = function cappedAnswerJson(body) {
        if (answer === undefined && res.statusCode === 200 && body !== undefined) answer = body;
        return prior.call(this, body);
      };
    }
    let done = false;
    const keep = () => {
      if (done) return;
      done = true;
      // A listener: a throw here would be uncaught.
      try { keepNow(); } catch { /* nothing kept: the next send takes the normal path */ }
    };
    const keepNow = () => {
      const a = req.__a402UnconfirmedAnswer;
      if (res.statusCode !== 402 || !a || typeof a !== "object" || !a.body || typeof a.body !== "object") return;
      if (typeof sig !== "string" || !sig) return;
      let rec = { [UNCONFIRMED]: 1, body: a.body, receipt: typeof a.receipt === "string" ? a.receipt : null, sig };
      const capped = req[CAPPED];
      let bytes = 0;
      if (replays && answer !== undefined && capped && typeof capped === "object") {
        let call = null;
        try { call = callDigestOf(req); } catch { call = null; }
        const withAnswer = call ? { ...rec, capped: { answer, payment: capped, call } } : rec;
        try { bytes = Buffer.byteLength(JSON.stringify(withAnswer), "utf8"); } catch { bytes = 0; }
        if (bytes && bytes <= IDEM_MAX_BODY_BYTES) rec = withAnswer;
      }
      if (rec.capped === undefined) { try { bytes = Buffer.byteLength(JSON.stringify(rec), "utf8"); } catch { bytes = 0; } }
      if (!bytes || bytes > IDEM_MAX_BODY_BYTES) return;
      store.set(uKey, rec, bytes, { ttlMs: unconfirmedReplayMs(a.validBefore) }).catch(() => {});
    };
    res.once("finish", keep);
    res.once("close", keep);
  };
  // Keep a credit for this request's payment when its run settled first and
  // then failed or was not delivered (settledFirstCredit says so).
  // `occupied`: an unspent credit for this payment and route under another
  // body is stored at cKey, and is never replaced.
  const keepSettledFirstCredit = (req, res, cKey, sig, occupied) => {
    if (typeof sig !== "string" || !sig || occupied) return;
    let done = false;
    onResponseEnd(req, res, (info) => {
      if (done) return;
      done = true;
      try {
        const status = info?.via === "undelivered" ? 499 : res.statusCode;
        if (!(status >= 400)) return;
        const c = settledFirstCredit(req, status);
        if (!c || typeof c.tx !== "string" || !c.tx) return;
        const rec = { [CREDIT]: 1, sig, body: settledFirstCreditBodyOf(req), tx: c.tx, network: c.network ?? null, wire: c.wire ?? null, note: typeof c.note === "string" ? c.note : null, receipt: typeof c.receipt === "string" ? c.receipt : null, at: Date.now() };
        const bytes = Buffer.byteLength(JSON.stringify(rec), "utf8");
        if (bytes > IDEM_MAX_BODY_BYTES) return;
        store.set(cKey, rec, bytes, { ttlMs: CREDIT_TTL_MS }).catch(() => {});
      } catch { /* no credit kept: the debt stays owed and is refunded */ }
    });
  };
  // Run the same payment's request again under its credit. True when the
  // request was answered here; false when it was marked to run.
  const startSettledFirstCredit = async (req, res, cKey, credit) => {
    let claimed = false;
    try { claimed = await store.claim(cKey); } catch { claimed = false; }
    if (!claimed) {
      res.setHeader("Retry-After", "2");
      res.status(409).json({ error: "idempotent_request_in_flight", charged: false, hint: "A call carrying this same payment is still running. Retry shortly with the same payment; nothing more is charged." });
      return true;
    }
    let verdict;
    try { verdict = await onSettledFirstResend(req, credit); } catch { verdict = { serve: false, status: 503, retryAfter: 10, body: { error: "resend_pending", hint: "The payment this request carries could not be read against its charge just now. Nothing more is charged. Retry shortly with the same payment." } }; }
    if (!verdict || verdict.serve !== true) {
      store.release(cKey).catch(() => {});
      if (Number(verdict?.retryAfter) > 0) res.setHeader("Retry-After", String(Math.ceil(Number(verdict.retryAfter))));
      res.status(Number(verdict?.status) || 402).json(verdict?.body && typeof verdict.body === "object" ? verdict.body : { error: "resend_refused" });
      return true;
    }
    let ended = false;
    onResponseEnd(req, res, (info) => {
      if (ended) return;
      ended = true;
      const served = info?.via !== "undelivered" && res.statusCode === 200;
      // Served: the credit is spent (the answer itself is kept under the
      // payment's idempotency key where one applies).
      const after = served
        ? Promise.resolve().then(() => store.set(cKey, { [CREDIT]: 1, spent: true, sig: credit.sig, tx: credit.tx }, 200, { ttlMs: CREDIT_TTL_MS })).catch(() => {})
        : Promise.resolve();
      after.then(() => store.release(cKey)).catch(() => {});
    });
    return false;
  };
  return async (req, res, next) => {
    if (!isCatalogRoute(req)) return next();
    const cred = freeMode ? null : paymentHeaderOf(req);
    const uKey = cred ? unconfirmedKeyOf(req, cred) : null;
    const cKey = cred && typeof settledFirstCredit === "function" ? settledFirstCreditKeyOf(req, cred) : null;
    const bound = idemHashKey(req);
    if (!bound && !uKey) return next();
    const [uHit, hit0, cHit] = await Promise.all([
      uKey ? Promise.resolve().then(() => store.get(uKey)).catch(() => null) : null,
      bound ? Promise.resolve().then(() => store.get(bound.key)).catch(() => null) : null,
      cKey ? Promise.resolve().then(() => store.get(cKey)).catch(() => null) : null,
    ]);
    const uSig = uKey ? unconfirmedSignatureOf(req, cred) : null;
    const uStored = Boolean(uHit && typeof uHit === "object" && uHit[UNCONFIRMED] === 1 && uHit.body && typeof uHit.body === "object");
    // Only the payer's own signature gets its answer back; any other header
    // naming the same payment takes the normal path (verify refuses it), and
    // never replaces the payer's stored answer.
    if (uStored && typeof uSig === "string" && uSig && uHit.sig === uSig) {
      const capped = uHit.capped;
      let sameCall = false;
      try { sameCall = !!capped && typeof capped === "object" && typeof capped.call === "string" && capped.call === callDigestOf(req); } catch { sameCall = false; }
      if (typeof onCappedResend === "function" && sameCall && capped.answer !== undefined && capped.payment && typeof capped.payment === "object") return replayCapped(req, res, uHit);
      return replayUnconfirmed(req, res, uHit);
    }
    if (uKey && !uStored) keepUnconfirmed(req, res, uKey, uSig);
    // A credit for this payment, route and body (above), when no answer is
    // stored for it: the payment's failed settle-first run is run again.
    // The body is read only now, when a credit is stored for this payment.
    const live = cHit && typeof cHit === "object" && cHit[CREDIT] === 1 && !cHit.spent && typeof cHit.tx === "string" && cHit.tx ? cHit : null;
    const credit = live && typeof live.body === "string" && live.body === settledFirstCreditBodyOf(req) ? live : null;
    if (credit && (hit0 === null || hit0 === undefined) && typeof uSig === "string" && uSig && credit.sig === uSig && typeof onSettledFirstResend === "function") {
      // Answered here (a wait, a refund, a pending ledger), or marked and run
      // on: its answer is kept below like any paid call's.
      if (await startSettledFirstCredit(req, res, cKey, credit)) return;
    } else if (cKey) keepSettledFirstCredit(req, res, cKey, uSig, Boolean(live && !credit));
    if (!bound) return next();
    const { key, kind, implicit } = bound;
    let hit = hit0;
    if (hit !== null && hit !== undefined) {
      // Answered here, before the paywall and the dispatcher: no handler, no
      // settlement, and none of the finish-time bookkeeping behind the gates
      // (the sale, the served-call tally, the tool-answer classes) sees it.
      const { body, charged } = unwrapStored(hit);
      if (typeof onReplay === "function") {
        // The hook runs before the body goes out and may refuse the replay
        // ({ serve: false, status, body }: the charge behind the stored
        // answer was refunded); anything else serves it.
        let verdict;
        try { verdict = await onReplay(req, { implicit, key, charged }); } catch { verdict = undefined; }
        if (verdict && typeof verdict === "object" && verdict.serve === false) {
          if (Number(verdict.retryAfter) > 0) res.setHeader("Retry-After", String(Math.ceil(Number(verdict.retryAfter))));
          return res.status(Number(verdict.status) || 402).json(verdict.body && typeof verdict.body === "object" ? verdict.body : { error: "replay_refused" });
        }
      }
      res.setHeader("X-Idempotent-Replay", "true");
      if (implicit) res.setHeader("X-Replayed-Answer", "1");
      return res.status(200).json(body);
    }
    // The same keyed call is still running (a client that timed out and retried
    // before the first answer finished). A single-use credential (an x402
    // authorization, a PoW token) already refuses this duplicate at its own replay
    // guard, but a prepaid credits key is reusable: both copies would run and both
    // would be debited. Refuse the copy before its handler runs; the gate ahead of
    // us releases its hold on a non-200, so it is never charged, and a retry after
    // the first finishes replays the stored answer.
    let claimed = false;
    try { claimed = await store.claim(key); } catch { claimed = true; }
    if (!claimed) {
      res.setHeader("Retry-After", "2");
      return res.status(409).json({
        error: "idempotent_request_in_flight",
        hint: implicit
          ? "A call carrying this same signed payment is still running. Retry shortly with the same payment to receive its answer; this request was not charged."
          : "A call with this Idempotency-Key, credential and body is still running. Retry shortly with the same Idempotency-Key to receive its answer; this request was not charged.",
      });
    }
    // The claim lives as long as the RUN, not the connection. A client that
    // times out closes its socket while the handler is still going; releasing
    // on that close let its retry (same key, same reusable credential) find no
    // answer and a free claim, so the handler ran twice and a credits key was
    // debited twice. The run ends when the response is ended (the handler, or
    // the gate after it settles, calls res.end). The claim is released only
    // after the answer that run committed has been written, so a retry finds
    // the claim (409) or the stored answer, never neither. Renewals stop at the
    // same point; INFLIGHT_MAX_MS bounds a run that never ends, and the store's
    // claim TTL bounds a process that dies.
    let pendingSet = null;
    let ended = false;
    let released = false;
    const renew = setInterval(() => { store.renew(key).catch(() => {}); }, INFLIGHT_RENEW_MS);
    renew.unref?.();
    let maxTimer = null;
    const releaseClaim = () => {
      if (released) return;
      released = true;
      clearInterval(renew);
      clearTimeout(maxTimer);
      Promise.resolve(pendingSet).catch(() => {}).then(() => store.release(key)).catch(() => {});
    };
    maxTimer = setTimeout(releaseClaim, INFLIGHT_MAX_MS);
    maxTimer.unref?.();
    const socketGone = () => Boolean(res.destroyed || !res.socket || res.socket.destroyed);
    // Whether the client left before any byte went out. That case is the
    // undelivered path below (committed under its booked debt, if charged);
    // a client that left once headers were out was answered in part, its
    // 200 is charged as one, and it is committed as one (endedGone).
    let goneBeforeHeaders = false;
    res.once("close", () => { if (!res.headersSent) goneBeforeHeaders = true; });
    // A 200 whose "finish" will not come (the socket closed after headers):
    // the gates decided its charge on the same final status, so the answer is
    // committed here, before the claim is let go, and a retry with the same
    // key replays it instead of running and being charged again.
    const endedGone = () => {
      if (!goneBeforeHeaders) commit();
      setImmediate(releaseClaim);
    };
    const priorEnd = res.end;
    res.end = function idempotencyAwareEnd(...args) {
      const out = priorEnd.apply(this, args);
      if (!ended) {
        ended = true;
        // An answer other than 200 is never stored, so the run is over here:
        // release now. Waiting for "finish" left a window in which a client
        // that resent the same payment as soon as the 402's headers arrived
        // was told its first call was still running.
        if (res.statusCode !== 200) releaseClaim();
        // Ended on a live socket: "finish" commits, then releases. Ended after
        // the client left (no "finish" comes): an undelivered commit ran inside
        // the call above; a client that left after headers is committed now.
        // Either way the release waits for the write to land.
        else if (socketGone()) endedGone();
      }
      return out;
    };
    // The socket closed after the response was ended (its "finish" may never
    // come): the run is over, and its 200 is committed as above. A close
    // before the end leaves the claim held.
    res.once("close", () => { if (ended) endedGone(); });
    // Settlement-aware caching (FR4-01). @x402/express (v2.16) runs the handler
    // FIRST, then settles, and ONLY on a <400 response; on settlement FAILURE it
    // replaces the buffered 200 with a 402. So committing to the cache at
    // res.json() time (handler completion, BEFORE settlement) would store a result
    // whose payment never settled, and a retry could replay it for free. Capture
    // the body at res.json() but COMMIT only on 'finish', when res.statusCode is
    // the post-settlement reality: a final 200 means settlement succeeded (the
    // paywall would have written a 402 otherwise). PoW (free) requests never enter
    // the settle path, so their 200 is final at finish too — cached correctly.
    let captured;
    const origJson = res.json.bind(res);
    res.json = (body) => { captured = body; return origJson(body); };
    let committed = false;
    let stored0 = false; // the answer went to the store
    let storedCharged = false; // ... wrapped as charged
    let lateCharged = null; // a charge booked before the commit (noteChargedAfterServe)
    const commit = (charged0 = null) => {
      if (committed || res.statusCode !== 200 || captured === undefined) return;
      committed = true;
      const charged = charged0 || lateCharged;
      // Only a credential the server actually VERIFIED may seed the cache.
      //
      // idemHashKey binds the entry to `x-pow-solution` as presented, and this
      // middleware runs BEFORE the PoW gate, so at key time that header is just
      // an attacker-chosen string. That was safe only because an unauthenticated
      // caller could never reach a 200 to seed anything - the bogus solution
      // produced X-Pow-Error and a 402. The trial changed that: it returns 200
      // with no credential at all, so one trial plus a made-up solution seeded an
      // entry that ANY client could then replay, unpaid, for the whole TTL -
      // defeating the "1 per tool per hour" bound the trial advertises.
      //
      // At finish the verdict is known, so require it here: a settled payment, or
      // a PoW the gate accepted. A trial NEVER seeds the cache - it is one call,
      // not a reusable receipt. (FREE_MODE has no paywall to bind to and is
      // dev/test only, so it keeps caching.)
      if (res.getHeader("X-Trial-Accepted") === "true") return;
      // Nor does a first-call allowance grant: its payment never settled
      // (src/first-call-allowance.js), so it is no receipt to replay against.
      if (allowanceServed(req)) return;
      const powVerified = res.getHeader("X-Pow-Accepted") === "true";
      // A PoW-served answer is stored only under the PoW token it was served
      // on. The key is computed before the PoW gate, so a payment header riding
      // alongside a valid solution is unverified text: binding the entry to it
      // would let anyone presenting that text replay the answer. Such a call is
      // simply not stored; a call carrying only its solution keeps its replay.
      if (powVerified && kind !== "pow") return;
      const paid = Boolean(paymentHeaderOf(req)) || req.creditsSettled === true || req.tempoSettled === true;
      if (!freeMode && !paid && !powVerified) return;
      const stored = charged ? wrapStored(captured, charged) : captured;
      let bytes = 0;
      try { bytes = Buffer.byteLength(JSON.stringify(stored), "utf8"); } catch { bytes = 0; }
      if (!bytes || bytes > IDEM_MAX_BODY_BYTES) return;
      stored0 = true;
      storedCharged = Boolean(charged);
      pendingSet = store.set(key, stored, bytes).catch(() => {});
    };
    chargedLaterOf.set(req, (charged) => {
      if (!committed) { lateCharged = charged; return true; }
      if (!stored0 || storedCharged) return false;
      const wrapped = wrapStored(captured, charged);
      let bytes = 0;
      try { bytes = Buffer.byteLength(JSON.stringify(wrapped), "utf8"); } catch { bytes = 0; }
      if (!bytes || bytes > IDEM_MAX_BODY_BYTES) return false;
      storedCharged = true;
      // After the first write, never before it, so the charged form is the one kept.
      pendingSet = Promise.resolve(pendingSet).catch(() => {}).then(() => store.set(key, wrapped, bytes)).catch(() => {});
      return true;
    });
    res.on("finish", () => { commit(); releaseClaim(); });
    // CHARGED BUT NEVER DELIVERED. A buyer that leaves before the first byte
    // while its payment settles is charged (no ticket, or the close landed
    // inside the settle call) and Node emits no "finish" for the response the
    // gate then ends, so the answer was dropped and the resend ran the
    // handler again against a used nonce: a 402 for a call already paid. The
    // hang-up recorder books that charge as a debt on the request before the
    // outcome runs (server.js recordHangupDebt, on the receipt's proof only);
    // the answer is committed under it, so the resend of the same payment is
    // served from here and the replay names the charge for the server to
    // void the debt. Registered on every end, not the settle outcome: a close
    // that lands during the settle call holds a granted ticket and reads as
    // forgiven, yet the money moved, and the booked debt is what says so. A
    // hang-up that was not charged books no debt and commits nothing.
    onResponseEnd(req, res, (info) => {
      if (info?.via !== "undelivered") return;
      const debt = Object.hasOwn(req, "__a402HangupDebt") ? req.__a402HangupDebt : null;
      if (!debt || typeof debt !== "object" || typeof debt.tx !== "string" || !debt.tx) return;
      commit({ tx: debt.tx, network: debt.network ?? null, wire: debt.wire ?? null });
    });
    next();
  };
}
