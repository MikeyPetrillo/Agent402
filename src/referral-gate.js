// Referral copies of paid tool routes: /ref/<slug>.
//
// For each allowlisted tool this gate serves a copy of the paid route whose
// 402 pays a referral network's split contract instead of this server's
// wallet: the buyer signs an EIP-3009 ReceiveWithAuthorization to that
// contract on Base, and the network's facilitator settles it on a request
// signed by a hot key of ours (src/referral-settle.js). The contract pays our
// share to a wallet of ours.
//
// The gate is standalone. It is not a catalog route, adds no rail and rewrites
// nothing onto a catalog path, so every surface derived from the catalog or
// the rails (pricing, openapi, llms.txt, the x402 manifest, the sitemap) stays
// as it is, and a header the x402 paywall cannot verify never reaches a
// catalog-keyed middleware. It calls the tool's own handler.
//
// MONEY RULES (root CLAUDE.md, "x402 settlement ordering"):
//   - The amount is the amount the direct route's Base accept carries for the
//     same request, in USDC base units: the same price function, the same
//     per-network funnel. Never higher.
//   - An authorization is taken only when it is the buyer's own signature
//     (checked here, before any call leaves this server), names the contract
//     and exactly the amount, is still valid for the whole run and the
//     settlement (handler deadline + settle reserve + the verify wait), and
//     expires no more than REFERRAL_MAX_VALIDITY_MS ahead.
//   - One authorization, one run. The replay guard holds it from before the
//     run. It is released only while nothing has run (an input refusal, a
//     verify refusal, a store that did not answer). Once the handler has
//     started the authorization is spent for running purposes whatever
//     happens next: it is held to its validBefore.
//   - Handler first, then settle. The handler runs under the gate's deadline,
//     presented to it as the end of its payment window and as a ceiling on
//     its upstream budget, so its upstream work is cut off at the deadline,
//     not only abandoned. An error, a timeout, a stream or a binary answer is
//     answered as it is and never settled.
//   - A buyer gone before settlement is not settled while the run holds a
//     hang-up forgiveness ticket: the direct routes' rule, on budgets of this
//     gate's own, so referral traffic never changes a direct buyer's outcome.
//     Without a ticket the payment is settled and the answer is kept for the
//     buyer's re-send.
//   - The chain head is read before /verify, and the intent (with that head)
//     is written to a durable book (src/referral-book.js) before /settle;
//     with no head or no intent stored, nothing runs or nothing is sent. One
//     /settle is in flight per authorization.
//   - PAID MEANS ROUTED TO US (src/referral-proof.js). The authorization
//     names only the split contract, which pays whichever merchant its caller
//     names. A payment is ours only when one receipt shows the
//     authorization's own transfer into the contract AND the contract's
//     routed-payment event naming this buyer, this amount and our merchant
//     id, paid out to our payout wallet at no less than the expected net
//     (nothing stands in for the event). Routed elsewhere, a cancel or a
//     transfer elsewhere delivers nothing and books nothing; a receipt shape
//     that is not recognized is unknown (held), never paid and never unpaid.
//     The facilitator's own "success" is checked the same way first.
//   - While the book holds an entry that says this server's own bookkeeping
//     is wrong (a contradicted settle, a success whose receipt still cannot
//     be read), a new payment is answered 503 before anything runs
//     (bookFault): only the entry's own payer for anything a payment can be
//     made to produce; every payer only for a fault no payment can cause.
//   - The tool's answer is kept, against the authorization, for a few minutes
//     (REFERRAL_ANSWER_RETENTION_MS): a re-send of the same PAYMENT-SIGNATURE
//     returns it when the payment landed, with no second run and no second
//     sale. A delivered mark is written before any answer byte goes out. The
//     answer goes out in chunks confirmed as the socket takes them: all
//     confirmed is delivered; none handed over is not served; anything
//     between is partly served (not delivered, kept for the re-send, and its
//     refund held for review).
//   - A sale is booked once, at the NET amount (gross less the slug's
//     commission and the fee); the gross is the quote.
//   - Unsettled runs are bounded per signed payer and per client address in
//     this gate's own lane; the direct routes' settle breaker, its status
//     word and its counters neither see nor judge a referral run.
//   - A charge proven ours whose answer can no longer be delivered is owed
//     back at the gross in the refund ledger (oweIfUndeliverable), only
//     behind that proof and never for an entry carrying the delivered mark.
//     A buyer who left carries the hang-up reason on that debt, so the refund
//     run holds a repeat one for review.
//
// TIME. deadline + settle reserve + verify wait must fit the 60 s window the
// 402 asks a buyer to sign for (referralConfig refuses a configuration that
// does not); the settle call itself may run past validBefore, since it waits
// for the receipt of a transaction submitted inside it.
//
// The answer store is in this process: one replica serves today. With two, a
// re-send that reaches the other replica reads the book and the replay guard
// (both shared) and is refused as already used; it does not run again.
import { createHash } from "node:crypto";
import { verifyTypedData, parseCompactSignature, compactSignatureToSignature, serializeSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDC_DOMAIN_BY_NETWORK } from "./evm-usdc-domain.js";
import { decodePaymentHeader } from "./payment-header.js";
import { handlerInputOf, withIgnoredParams } from "./handler-input.js";
import { withLoopTimeout } from "./loop-deadline.js";
import { binaryTypesOf } from "./tool-media-type.js";
import { referralLogText } from "./referral-settle.js";
import { chainVerdict } from "./referral-chain.js";
import { runAsReferral } from "./referral-run.js";
import { IDEM_TTL_MS } from "./idempotency-store.js";
import { DEFAULT_KEY_BUDGET_USD, DEFAULT_GLOBAL_BUDGET_USD } from "./hangup-forgiveness.js";

export const REFERRAL_NETWORK = "eip155:8453";
export const REFERRAL_CHAIN_ID = 8453;
const USDC = USDC_DOMAIN_BY_NETWORK[REFERRAL_NETWORK];
export const REFERRAL_ASSET = USDC.asset;
/** What the 402 asks a buyer to sign for. The run, the verify wait and the
 *  settle reserve fit inside it (referralConfig). */
export const REFERRAL_MAX_TIMEOUT_SECONDS = 60;
export const REFERRAL_DEFAULTS = Object.freeze({
  // The handler's budget.
  deadlineMs: 25_000,
  // The facilitator's /settle waits for the receipt.
  settleMs: 50_000,
  verifyMs: 10_000,
  // An authorization must still be valid this long after the handler ends,
  // so the settlement is submitted before validBefore.
  settleReserveMs: 10_000,
  // An authorization may expire at most this far ahead.
  maxValidityMs: 15 * 60_000,
  // Unsettled runs (a settle the facilitator refused for the payment, a run
  // that timed out) one payer or one client address may hold in the window.
  unsettledMax: 3,
  unsettledWindowMs: 15 * 60_000,
  // Paid calls in flight (verify, run and settle together), on the route and per payer.
  maxInflight: 24,
  payerInflightMax: 8,
  // The direct routes' settle-breaker figures: unsettled outcomes refuse a
  // payer at 3 (and over half its outcomes), at 40 whatever it settled; with
  // 12 distinct failing payers a never-paid one is held at 1.
  unsettledHardMax: 40,
  globalMax: 12,
  // Our own faults: this many refusals of OUR request in a row answer 503
  // before the handler for the cool-down, then one call probes again.
  ownFaultMax: 3,
  ownFaultCooldownMs: 60_000,
  // A settle success whose receipt cannot be read yet: how long the read is
  // retried before deciding, and how many such answers may be delivered and
  // still open (unconfirmed) at once; past it the answer is held as in doubt.
  receiptWaitMs: 4_000,
  unconfirmedMax: 5,
  // Full readings of a receipt the proof rule does not recognize before the
  // sweep closes an expired entry to the operator record.
  unrecognizedReads: 5,
  // A send with no progress for sendIdleMs, or still going after sendMaxMs, is ended.
  sendIdleMs: 15_000,
  sendMaxMs: 120_000,
  // Sales paid FAR under the rate map's floor on one slug before new calls on it stop (0: never).
  shortNetMax: 3,
  feeBps: 0,
});
export const REFERRAL_TOKEN_MAX_CHARS = 8192;
/** A referrer token is echoed byte for byte only when it is printable ASCII:
 *  anything else could not come back as the bytes that were sent. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
export const REFERRAL_AGENT_ID_MAX_CHARS = 128;
/** One answer larger than this is not served on this route (it is held in memory through the settle). */
export const REFERRAL_ANSWER_MAX_BYTES = 8 * 1024 * 1024;
/** Answers kept for a re-send: this many, this many bytes. */
export const REFERRAL_KEPT_ANSWERS_MAX = 200;
export const REFERRAL_KEPT_BYTES_MAX = 48 * 1024 * 1024;
/** An answer up to this size is stored with its open book entry, so a restart keeps it. */
export const REFERRAL_PERSISTED_ANSWER_MAX_BYTES = 256 * 1024;
/** All the answers this process holds at rest, at most. */
export const REFERRAL_PERSISTED_BYTES_MAX = 32 * 1024 * 1024;
/** How long a produced answer is kept for a re-send (the privacy page's bound
 *  for a paid answer kept against its payment), and the grace past the
 *  authorization's validBefore it is never kept beyond. */
export const REFERRAL_ANSWER_RETENTION_MS = IDEM_TTL_MS;
export const REFERRAL_ANSWER_GRACE_MS = 15 * 60_000;
/** Settle attempts a kept answer may make after its first. */
export const REFERRAL_RESEND_SETTLES_MAX = 2;
/** An unconfirmed payment whose receipt still cannot be read after this long is flagged (the word reads attention until it is resolved). */
export const REFERRAL_UNCONFIRMED_FLAG_MS = 3 * 60_000;
/** An answer goes out in pieces of this size, each counted when the socket has taken it. */
export const REFERRAL_SEND_CHUNK_BYTES = 16 * 1024;
/** A send that makes no progress for this long is ended (REFERRAL_SEND_IDLE_MS). */
export const REFERRAL_SEND_IDLE_MS = REFERRAL_DEFAULTS.sendIdleMs;
/** A send is ended this long after it began, whatever its progress (REFERRAL_SEND_MAX_MS). */
export const REFERRAL_SEND_MAX_MS = REFERRAL_DEFAULTS.sendMaxMs;
/**
 * Send `body` (a Buffer) on `res` in pieces of `chunkBytes`, one at a time,
 * the next only once the socket has confirmed taking the last. Returns the
 * live counts `{ total, dispatched, taken, ended }`: `dispatched` bytes were
 * handed to the socket, `taken` bytes were confirmed by a write callback with
 * no error. The response is ended only when every byte is confirmed. Not
 * awaited by its caller: a slow reader holds its own socket and nothing else.
 *
 * BOUNDED. A piece that is not confirmed within `idleMs` (a reader that
 * stopped reading, or a layer between this call and the socket that never
 * calls back), or a send still going `maxMs` after it began, is ended by
 * destroying the response: `ended` says which ("idle" or "max"), and the
 * close that follows reads the counts as they stand. A send never waits
 * without a bound.
 */
export function sendCounted(res, body, { chunkBytes = REFERRAL_SEND_CHUNK_BYTES, idleMs = REFERRAL_SEND_IDLE_MS, maxMs = REFERRAL_SEND_MAX_MS } = {}) {
  const sent = { total: body.length, dispatched: 0, taken: 0, ended: null };
  let idle = null, done = false;
  const stop = () => { done = true; clearTimeout(idle); clearTimeout(max); };
  const cut = (why) => { if (done) return; stop(); sent.ended = why; try { res.destroy(); } catch { /* already gone */ } };
  const max = setTimeout(() => cut("max"), maxMs);
  max.unref?.();
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => cut("idle"), idleMs); idle.unref?.(); };
  try { res.once?.("close", stop); } catch { /* a response with no events is bounded by its timers */ }
  const next = () => {
    try {
      if (done || res.destroyed) { stop(); return; }
      if (sent.dispatched >= sent.total) { stop(); res.end(); return; }
      const part = body.subarray(sent.dispatched, Math.min(sent.total, sent.dispatched + chunkBytes));
      sent.dispatched += part.length;
      arm();
      res.write(part, (err) => { if (err) return; sent.taken += part.length; next(); });
    } catch { /* a write that throws ends here; the close reads the counts */ }
  };
  next();
  return sent;
}
/**
 * How a send ended when the connection closed, from its counts:
 * `{ how, atMost }`, `atMost` the most bytes the buyer can hold.
 *   delivered   every byte was confirmed taken by the socket
 *   not-served  nothing was handed to the socket: the buyer has no byte
 *   partial     anything between. A piece in flight may have reached the
 *               buyer without its confirmation (measured: a client had read
 *               about 64 KB more than was confirmed), so the bound is the
 *               bytes handed over, not the bytes confirmed
 */
export function sentOutcome({ total, dispatched, taken }) {
  if (taken >= total) return { how: "delivered", atMost: total };
  return dispatched > 0 ? { how: "partial", atMost: Math.min(total, dispatched) } : { how: "not-served", atMost: 0 };
}
/** The hang-up reason a partly served answer's refund debt carries: one of
 *  the reasons scripts/refund-run.js holds for review (REPEAT_HANGUP_REASONS),
 *  so the debt is never repaid without one. The note on the row says how many
 *  bytes went out. */
export const REFERRAL_PARTIAL_HOLD_REASON = "payer budget";
/** Contradicted settle successes that moved money, from this many distinct
 *  payers inside one unsettled-run window, hold the whole route. */
export const REFERRAL_CONTRADICTED_PAYERS = 3;
/** What an operator may decide for an entry resolved by hand. */
export const REFERRAL_HAND_OUTCOMES = Object.freeze(["refund", "delivered", "dismissed"]);
/** The address bounds are this many times the payer's (several wallets share one address). */
export const REFERRAL_ADDRESS_FACTOR = 4;

/** Whether a refund row already on the books (`have`) stands for the debt
 *  `row`: the same transaction AND the same payer, on this wire. A row for
 *  the same transaction under another payer or wire is another debt. */
export function refundRowCovers(have, row) {
  if (!have || !row) return false;
  return lc(String(have.evidence ?? have.tx ?? "")) === lc(String(row.evidenceKey ?? row.tx ?? "")) && lc(String(have.payer ?? "")) === lc(String(row.payer ?? "")) && (have.wire === "referral" || have.wire === "referral-operator");
}

/** The refund ledger's evidence for one referral payment: the transaction
 *  and the authorization's nonce, so two payments settled in one transaction
 *  are two rows (src/payment-verify.js reads the pair back). */
export const referralRefundEvidence = (tx, nonce) => (/^0x[0-9a-fA-F]{64}$/.test(String(nonce || "")) ? `${String(tx).toLowerCase()}#${String(nonce).toLowerCase()}` : String(tx).toLowerCase());
/**
 * The gate's `oweRefund`, as the server wires it over the refund ledger
 * (src/refund-ledger.js): the row is written under the PAYMENT's evidence
 * (`evidenceKey`), and true means a row stands for THIS debt: the one just
 * written, or one already there for the same evidence and payer on this wire.
 */
export function referralRefundWriter({ recordRefundOwed, refundByEvidence }) {
  return async (row) => {
    const evidence = row.evidenceKey || row.tx;
    const { evidenceKey, ...rest } = row;
    const r = await recordRefundOwed({ ...rest, tx: evidence });
    if (r === true) return true;
    return refundRowCovers(refundByEvidence(evidence), row);
  };
}
/**
 * The payment the facilitator is sent: built from the fields this server
 * validated, never the buyer's decoded object passed through. `accepted` is
 * the requirement this request was quoted; the authorization is its six
 * checked string fields and the checked signature; of the buyer's extensions
 * only the two attribution strings are carried, bounded and printable.
 */
export function normalizedPayment(payment, requirement, auth, signature, resourceUrl) {
  const ext = payment && typeof payment.extensions === "object" && payment.extensions && !Array.isArray(payment.extensions) ? payment.extensions : {};
  const extensions = {};
  if (typeof ext.attributionToken === "string" && ext.attributionToken && ext.attributionToken.length <= REFERRAL_TOKEN_MAX_CHARS && PRINTABLE_ASCII.test(ext.attributionToken)) extensions.attributionToken = ext.attributionToken;
  if (typeof ext.buyerAgentId === "string" && ext.buyerAgentId && ext.buyerAgentId.length <= REFERRAL_AGENT_ID_MAX_CHARS && PRINTABLE_ASCII.test(ext.buyerAgentId)) extensions.buyerAgentId = ext.buyerAgentId;
  return {
    x402Version: 2,
    resource: { url: resourceUrl },
    accepted: requirement,
    payload: { signature, authorization: { from: auth.from, to: auth.to, value: auth.value, validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce } },
    ...(Object.keys(extensions).length ? { extensions } : {}),
  };
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^\d{1,78}$/;
const HEX = /^0x[0-9a-fA-F]+$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const lc = (s) => (typeof s === "string" ? s.toLowerCase() : "");
const headerText = (v) => (Array.isArray(v) ? v[0] : v);

const RECEIVE_TYPES = Object.freeze({
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
});

/** An https URL with no credentials (http only for a loopback host, for local
 *  runs), as its string without a trailing slash; null otherwise. */
function cleanUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
    if (u.username || u.password || u.hash) return null;
    return u.toString().replace(/\/+$/, "");
  } catch { return null; }
}
function msKnob(env, name, dflt, { min = 1000, max = 3_600_000 } = {}) {
  const raw = String(env?.[name] ?? "").trim();
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : dflt;
}
function intKnob(env, name, dflt, { min = 1, max = 10_000 } = {}) {
  const raw = String(env?.[name] ?? "").trim();
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
}
function usdKnob(env, name, dflt) {
  const raw = String(env?.[name] ?? "").trim();
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : dflt;
}
/**
 * The commission map, `default:<bps>,<slug>:<bps>`: what each slug's sale is
 * booked net of. A bare number is the default. Returns
 * `{ default: number|null, bySlug }`, or null when the text is empty or an
 * entry is malformed: there is no built-in rate, and a net booked from a
 * misread one is worse than a gate that stays off.
 */
export function parseCommissionBps(raw) {
  const out = { default: null, bySlug: {} };
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const bps = (v) => (/^\d{1,5}$/.test(v) && Number(v) <= 10_000 ? Number(v) : null);
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    const name = i < 0 ? "default" : part.slice(0, i).trim().toLowerCase();
    const n = bps(i < 0 ? part : part.slice(i + 1).trim());
    if (n === null || (name !== "default" && !SLUG.test(name)) || (name !== "default" && Object.hasOwn(out.bySlug, name))) return null;
    if (name === "default") out.default = n; else out.bySlug[name] = n;
  }
  return out;
}
/** The product id map, `<slug>:<0x 32-byte id>,...`: `{ slug: id }` (lower
 *  case), `{}` when the text is empty, null when an entry is malformed. */
export function parseProductIds(raw) {
  const out = {};
  const text = String(raw ?? "").trim();
  if (!text) return out;
  for (const part of text.split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    const slug = i < 0 ? "" : part.slice(0, i).trim().toLowerCase(), id = i < 0 ? "" : part.slice(i + 1).trim().toLowerCase();
    if (!SLUG.test(slug) || !B32.test(id) || Object.hasOwn(out, slug)) return null;
    out[slug] = id;
  }
  return out;
}
/** The commission a slug's sale is booked net of, or null when the map names neither it nor a default. */
export function commissionBpsFor(config, slug) {
  const m = config?.commission;
  if (!m) return null;
  return Object.hasOwn(m.bySlug, slug) ? m.bySlug[slug] : m.default;
}
/** True when the text is a 32-byte key a signer can be made from (never all zero, never past the curve order). */
function usableSignerKey(key) {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) return false;
  try { return ADDR.test(privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`).address); } catch { return false; }
}

const REQUIRED_VARS = ["REFERRAL_PAY_TO", "REFERRAL_FACILITATOR_URL", "REFERRAL_SIGNER_KEY", "REFERRAL_SLUGS", "REFERRAL_SETUP_URL", "REFERRAL_COMMISSION_BPS", "REFERRAL_MERCHANT_ID", "REFERRAL_PAYOUT_ADDRESS"];

/**
 * The gate's configuration, or null (off) unless every required variable is
 * set and well formed. Never throws.
 *
 * Required:
 *   REFERRAL_PAY_TO             the network's split contract (0x address); the 402's payTo
 *   REFERRAL_FACILITATOR_URL    the facilitator's base URL (https)
 *   REFERRAL_SIGNER_KEY         32-byte hex key that signs facilitator requests
 *   REFERRAL_SLUGS              comma list of catalog slugs to serve under /ref/<slug>
 *   REFERRAL_SETUP_URL          the network's setup document, echoed in the 402 (https)
 *   REFERRAL_COMMISSION_BPS     `default:<bps>,<slug>:<bps>`: read ONLY to book the net amount;
 *                               every slug in REFERRAL_SLUGS must be named or covered by `default`
 *   REFERRAL_MERCHANT_ID        this merchant's id on the split contract (a decimal number): a
 *                               payment counts as ours only when the contract routed it to this id
 *   REFERRAL_PAYOUT_ADDRESS     the wallet the split contract pays this merchant's amount to
 *                               (0x address, not the pay-to contract)
 * Optional (default):
 *   REFERRAL_FEE_BPS            (0) read ONLY to book the net amount
 *   REFERRAL_DEADLINE_MS        (25000) handler budget
 *   REFERRAL_SETTLE_MS          (50000) /settle timeout
 *   REFERRAL_VERIFY_MS          (10000) /verify timeout
 *   REFERRAL_SETTLE_RESERVE_MS  (10000) validity kept for the settlement after the handler
 *   REFERRAL_MAX_VALIDITY_MS    (900000) the furthest ahead an authorization may expire
 *   REFERRAL_VERIFY_SIGNED      (on) /verify carries the signed headers; `off` sends it unsigned
 *   REFERRAL_UNSETTLED_MAX      (3) unsettled runs per payer and per client address in the window
 *   REFERRAL_UNSETTLED_WINDOW_MS (900000)
 *   REFERRAL_MAX_INFLIGHT       (24) paid calls in flight
 *   REFERRAL_ROUTED_TOPIC       (the documented routed-payment event) topic0 of the split
 *                               contract's routed-payment event, when it differs
 *   REFERRAL_RECEIPT_WAIT_MS    (4000) how long a settle success's receipt is read before deciding
 *   REFERRAL_UNCONFIRMED_MAX    (5) answers delivered on a success whose receipt is not readable yet
 *   REFERRAL_UNRECOGNIZED_READS (5) full readings of a receipt the proof rule does not recognize
 *                               before an expired entry is closed to the operator record
 *   REFERRAL_MIN_NET_BPS        (none) `default:<bps>,<slug>:<bps>`: the least share of the PRICE a
 *                               sale on a slug must bring; a sale under it counts toward that
 *                               slug's stop. Unset for a slug: for a model-backed tool the share of the
 *                               price the gateway keeps upstream cost within (7000 bps today, read from
 *                               src/tools/llm-gateway-kit.js MARGIN), for any other tool half the net
 *                               the commission map expects
 *   REFERRAL_SHORT_NET_MAX      (3) sales on one slug under that floor before new calls on it
 *                               answer 503; a slug whose tool is model-backed stops at ONE (0: never, for all)
 *   REFERRAL_PRODUCT_IDS        (none) `<slug>:<0x 32-byte id>,...`: the product id the split
 *                               contract's routed event must name for that slug's payment to count
 *   REFERRAL_SEND_IDLE_MS       (15000) an answer's send with no progress for this long is ended
 *   REFERRAL_SEND_MAX_MS        (120000) an answer's send is ended this long after it began
 *   REFERRAL_HANGUP_KEY_USD, REFERRAL_HANGUP_GLOBAL_USD, REFERRAL_HANGUP_WINDOW_MS
 *                               this route's own hang-up forgiveness budgets (the direct routes'
 *                               sizes: per payer and per address, route-wide, one day)
 * deadline + settle reserve + verify must not exceed the 60 s the 402 asks a
 * buyer to sign for, or the gate stays off.
 */
export function referralConfig(env = process.env) {
  try {
    const payTo = String(env?.REFERRAL_PAY_TO || "").trim();
    const facilitatorUrl = cleanUrl(env?.REFERRAL_FACILITATOR_URL);
    const signerKey = String(env?.REFERRAL_SIGNER_KEY || "").trim();
    const setupUrl = cleanUrl(env?.REFERRAL_SETUP_URL);
    const slugs = [...new Set(String(env?.REFERRAL_SLUGS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
    if (!ADDR.test(payTo) || !facilitatorUrl || !setupUrl || !usableSignerKey(signerKey)) return null;
    // Who the split contract must have routed a payment to for it to be ours.
    const merchantId = String(env?.REFERRAL_MERCHANT_ID || "").trim();
    const payoutAddress = String(env?.REFERRAL_PAYOUT_ADDRESS || "").trim();
    if (!UINT.test(merchantId) || !ADDR.test(payoutAddress) || lc(payoutAddress) === lc(payTo)) return null;
    const routedTopicRaw = String(env?.REFERRAL_ROUTED_TOPIC || "").trim();
    if (routedTopicRaw && !B32.test(routedTopicRaw)) return null;
    if (!slugs.length || !slugs.every((s) => SLUG.test(s))) return null;
    const commission = parseCommissionBps(env?.REFERRAL_COMMISSION_BPS);
    const feeBps = intKnob(env, "REFERRAL_FEE_BPS", REFERRAL_DEFAULTS.feeBps, { min: 0, max: 10_000 });
    if (!commission) return null;
    // Optional maps: absent is fine, malformed leaves the gate off (a misread floor or product id is worse).
    const minNetRaw = String(env?.REFERRAL_MIN_NET_BPS ?? "").trim();
    const minNetBps = minNetRaw ? parseCommissionBps(minNetRaw) : null;
    if (minNetRaw && !minNetBps) return null;
    const productIds = parseProductIds(env?.REFERRAL_PRODUCT_IDS);
    if (productIds === null) return null;
    for (const slug of slugs) {
      const c = Object.hasOwn(commission.bySlug, slug) ? commission.bySlug[slug] : commission.default;
      if (c === null || c + feeBps > 10_000) return null;
    }
    Object.freeze(commission.bySlug);
    const deadlineMs = msKnob(env, "REFERRAL_DEADLINE_MS", REFERRAL_DEFAULTS.deadlineMs);
    const verifyMs = msKnob(env, "REFERRAL_VERIFY_MS", REFERRAL_DEFAULTS.verifyMs);
    const settleReserveMs = msKnob(env, "REFERRAL_SETTLE_RESERVE_MS", REFERRAL_DEFAULTS.settleReserveMs);
    if (deadlineMs + settleReserveMs + verifyMs > REFERRAL_MAX_TIMEOUT_SECONDS * 1000) return null;
    return Object.freeze({
      payTo, facilitatorUrl, signerKey, setupUrl, slugs: Object.freeze(slugs),
      merchantId: BigInt(merchantId).toString(), payoutAddress, routedTopic: routedTopicRaw ? routedTopicRaw.toLowerCase() : null,
      receiptWaitMs: msKnob(env, "REFERRAL_RECEIPT_WAIT_MS", REFERRAL_DEFAULTS.receiptWaitMs, { min: 0, max: 20_000 }),
      unconfirmedMax: intKnob(env, "REFERRAL_UNCONFIRMED_MAX", REFERRAL_DEFAULTS.unconfirmedMax, { min: 0, max: 1000 }),
      unrecognizedReads: intKnob(env, "REFERRAL_UNRECOGNIZED_READS", REFERRAL_DEFAULTS.unrecognizedReads, { min: 1, max: 1000 }),
      shortNetMax: intKnob(env, "REFERRAL_SHORT_NET_MAX", REFERRAL_DEFAULTS.shortNetMax, { min: 0, max: 1000 }),
      sendIdleMs: msKnob(env, "REFERRAL_SEND_IDLE_MS", REFERRAL_DEFAULTS.sendIdleMs, { min: 100, max: 600_000 }),
      sendMaxMs: msKnob(env, "REFERRAL_SEND_MAX_MS", REFERRAL_DEFAULTS.sendMaxMs, { min: 100, max: 3_600_000 }),
      deadlineMs, verifyMs, settleReserveMs,
      settleMs: msKnob(env, "REFERRAL_SETTLE_MS", REFERRAL_DEFAULTS.settleMs),
      maxValidityMs: msKnob(env, "REFERRAL_MAX_VALIDITY_MS", REFERRAL_DEFAULTS.maxValidityMs, { min: REFERRAL_MAX_TIMEOUT_SECONDS * 1000 }),
      verifySigned: String(env?.REFERRAL_VERIFY_SIGNED || "").trim().toLowerCase() !== "off",
      unsettledMax: intKnob(env, "REFERRAL_UNSETTLED_MAX", REFERRAL_DEFAULTS.unsettledMax, { min: 1, max: 1000 }),
      unsettledWindowMs: msKnob(env, "REFERRAL_UNSETTLED_WINDOW_MS", REFERRAL_DEFAULTS.unsettledWindowMs),
      maxInflight: intKnob(env, "REFERRAL_MAX_INFLIGHT", REFERRAL_DEFAULTS.maxInflight, { min: 1, max: 1000 }),
      payerInflightMax: intKnob(env, "REFERRAL_PAYER_INFLIGHT_MAX", REFERRAL_DEFAULTS.payerInflightMax, { min: 1, max: 1000 }),
      unsettledHardMax: intKnob(env, "REFERRAL_UNSETTLED_HARD_MAX", REFERRAL_DEFAULTS.unsettledHardMax, { min: 1, max: 10_000 }),
      globalMax: intKnob(env, "REFERRAL_UNSETTLED_GLOBAL_MAX", REFERRAL_DEFAULTS.globalMax, { min: 1, max: 10_000 }),
      ownFaultMax: intKnob(env, "REFERRAL_OWN_FAULT_MAX", REFERRAL_DEFAULTS.ownFaultMax, { min: 1, max: 1000 }),
      ownFaultCooldownMs: msKnob(env, "REFERRAL_OWN_FAULT_COOLDOWN_MS", REFERRAL_DEFAULTS.ownFaultCooldownMs),
      // This route's own hang-up forgiveness budgets (USD, as micro-dollars):
      // the sizes the direct routes use, counted apart from them.
      hangupKeyMicro: Math.round(usdKnob(env, "REFERRAL_HANGUP_KEY_USD", DEFAULT_KEY_BUDGET_USD) * 1e6),
      hangupGlobalMicro: Math.round(usdKnob(env, "REFERRAL_HANGUP_GLOBAL_USD", DEFAULT_GLOBAL_BUDGET_USD) * 1e6),
      hangupWindowMs: msKnob(env, "REFERRAL_HANGUP_WINDOW_MS", 24 * 3600_000, { max: 30 * 24 * 3600_000 }),
      commission: Object.freeze(commission), feeBps,
      minNetBps: minNetBps ? Object.freeze({ default: minNetBps.default, bySlug: Object.freeze(minNetBps.bySlug) }) : null,
      productIds: Object.freeze(productIds),
    });
  } catch { return null; }
}

/** Names (never values) of the required variables that are set while the gate
 *  is off, for one boot warning: a half-configured gate serves nothing. */
export function referralConfigProblem(env = process.env) {
  if (referralConfig(env)) return null;
  const set = REQUIRED_VARS.filter((n) => String(env?.[n] || "").trim());
  if (!set.length) return null;
  const missing = REQUIRED_VARS.filter((n) => !set.includes(n));
  return missing.length ? `missing ${missing.join(", ")}` : "a value is not usable (an address, an https URL, a 32-byte signer key, a slug list, a commission map that covers every slug, commission plus fee past 10000 bps, a minimum-net map or a product id map that is malformed, a merchant id that is not a number, a payout address that is the pay-to contract, a routed-event topic that is not 32 bytes, or deadline + settle reserve + verify past 60 s)";
}

const flatUsdOf = (def) => Number(String(def?.price ?? "").replace(/[^0-9.]/g, "")) || 0;
const priceFnOf = (def) => (typeof def?.quote === "function" ? def.quote : typeof def?.tierQuote === "function" ? def.tierQuote : null);
const usdText = (usd) => "$" + usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

/** USDC base units (a BigInt) of a "$0.03" price, or null when the text is not
 *  a dollar amount of at most six decimals above zero. */
export function baseUnitsOf(priceText) {
  const m = /^\$(\d{1,12})(?:\.(\d{1,6}))?$/.exec(String(priceText ?? "").trim());
  if (!m) return null;
  const units = BigInt(m[1]) * 1_000_000n + BigInt((m[2] || "").padEnd(6, "0") || "0");
  return units > 0n ? units : null;
}

/** What a sale on this route books: the gross the buyer paid, and the net
 *  left after the commission and the fee. Each leg is floored (a leg that
 *  rounds to zero is not taken), so the remainder stays in net. */
export function referralNet(grossUnits, { commissionBps = 0, feeBps = 0 } = {}) {
  const gross = BigInt(grossUnits);
  const commission = (gross * BigInt(commissionBps)) / 10_000n;
  const fee = (gross * BigInt(feeBps)) / 10_000n;
  const net = gross - commission - fee;
  return { grossUnits: gross, netUnits: net > 0n ? net : 0n, grossUsd: Number(gross) / 1e6, netUsd: Number(net > 0n ? net : 0n) / 1e6 };
}

/** The split legs the contract's routed event states: each may round on its own. */
const SPLIT_LEGS = 4;
/**
 * The least merchant amount a payment of `grossUnits` may show and still be
 * ours (a BigInt): the gross less the LARGEST the commission and the fee
 * could round to. The contract splits them over up to SPLIT_LEGS legs and
 * may round each up (or floor the merchant share), so the bound is the total
 * rounded up, plus one unit for each further leg. referralNet is the exact
 * figure; this is the floor the proof asks, never the amount booked (a sale
 * is booked at the merchant amount its receipt shows).
 */
export function referralMinNet(grossUnits, { commissionBps = 0, feeBps = 0 } = {}) {
  const gross = BigInt(grossUnits);
  const bps = BigInt(commissionBps) + BigInt(feeBps);
  const most = (gross * bps + 9_999n) / 10_000n + BigInt(SPLIT_LEGS - 1);
  const least = gross - most;
  return least > 0n ? least : 0n;
}

/** Slugs served under /ref before the price-parity rule (referralIneligibility):
 *  still served, and named in a warning at every boot until the owner decides. */
export const REFERRAL_PARITY_GRANDFATHERED = Object.freeze(["hash"]);
/** True when a definition's published example, example output or input
 *  schema text names one of `hosts` (compared in lower case). */
export function namesOwnHost(def, hosts = []) {
  const list = (hosts || []).map((h) => String(h || "").trim().toLowerCase()).filter(Boolean);
  if (!list.length || !def || typeof def !== "object") return false;
  let text = "";
  try { text = JSON.stringify([def.discovery?.input ?? null, def.discovery?.example ?? null, def.discovery?.output ?? null, def.discovery?.inputSchema ?? null]).toLowerCase(); } catch { return true; }
  return list.some((h) => text.includes(h));
}

/**
 * Why a catalog definition cannot be served as a referral copy, or null.
 * `flags` are the server's own readings of the definition:
 *   compute       its handler reaches no upstream (nothing to cut off)
 *   clamped       its upstream work ends at the gate's deadline (it reads the
 *                 payment window the gate presents, or runs under a handler
 *                 budget the gate's ceiling caps)
 *   ownTimeoutMs  otherwise, the longest its own upstream wait can take
 * A tool that is neither `compute` nor `clamped` is served only when its own
 * upstream timeout is known and fits the handler deadline: a run the deadline
 * cannot cut off would keep spending upstream after the buyer was told it was
 * not charged.
 */
export function referralIneligibility(def, { identityBound = false, lastingEffect = false, paysThirdParty = false, longRunning = false, compute = false, clamped = false, ownTimeoutMs = null, deadlineMs = REFERRAL_DEFAULTS.deadlineMs, priceForNetwork = (p) => p, ownHosts = [], cheaperDirect = null } = {}) {
  if (!def || typeof def !== "object") return "not in the catalog";
  if (typeof def.handler !== "function") return "in the catalog but has no handler";
  if (identityBound) return "identity-bound route";
  if (lastingEffect) return "its effect outlives the answer";
  if (paysThirdParty) return "pays an outside seller";
  if (longRunning) return "long-running or composite route";
  if (binaryTypesOf(def)) return "answers bytes, not JSON";
  // A referred buyer is never pointed at this server's own surfaces: a tool
  // whose published example or input hints name this host is left out (an
  // empty request runs that example, and a refused input quotes it).
  if (namesOwnHost(def, ownHosts)) return "its published example or input hints name this server's own host";
  // Price parity: the referral copy never costs more than the same call on
  // the public route. A tool the public route gives for less by a path this
  // route lacks (`cheaperDirect` names it) is left out; the slugs served
  // before the rule are served still, with a line at every boot.
  if (cheaperDirect && !REFERRAL_PARITY_GRANDFATHERED.includes(def.slug)) return `the public route can be had for less than the listed price (${cheaperDirect})`;
  if (!compute && !clamped) {
    if (!Number.isFinite(ownTimeoutMs) || !(ownTimeoutMs > 0)) return "declares no upstream timeout the handler deadline can be checked against";
    if (ownTimeoutMs > deadlineMs) return `its own upstream wait (${Math.round(ownTimeoutMs / 1000)} s) is past the handler deadline (${Math.round(deadlineMs / 1000)} s)`;
  }
  if (!(flatUsdOf(def) > 0)) return "no list price";
  let listed = null;
  try { listed = baseUnitsOf(priceForNetwork(def.price, REFERRAL_NETWORK)); } catch { listed = null; }
  if (listed === null) return "its list price is not a whole number of USDC base units";
  return null;
}

/** The allowlisted definitions that pass the boot checks, by slug, and the
 *  ones refused with the reason. `flagsOf(def)` returns the flags above. */
export function referralRoutes(config, catalog, flagsOf = () => ({})) {
  const defs = new Map();
  const refused = [];
  const served = [];
  const noted = [];
  const bySlug = new Map(Object.values(catalog || {}).filter((d) => d && typeof d.slug === "string").map((d) => [d.slug, d]));
  for (const slug of config?.slugs || []) {
    const def = bySlug.get(slug);
    let reason;
    try { reason = referralIneligibility(def, { deadlineMs: config.deadlineMs, ...(def ? flagsOf(def) : {}) }); }
    catch { reason = "could not be checked"; }
    if (reason) { refused.push({ slug, reason }); continue; }
    defs.set(slug, def);
    // Why the handler deadline can be kept, for the boot line.
    let f = {};
    try { f = flagsOf(def) || {}; } catch { f = {}; }
    if (f.cheaperDirect) noted.push({ slug, note: `served under /ref although the public route can be had for less (${f.cheaperDirect}): it was served before the price-parity rule, and stays until the owner decides` });
    served.push({ slug, why: f.compute ? "no upstream work" : f.clamped ? `upstream work ends at the deadline${Number.isFinite(f.ownTimeoutMs) && f.ownTimeoutMs > 0 ? ` (own timeout ${Math.round(f.ownTimeoutMs / 1000)} s)` : ""}` : `own upstream timeout ${Math.round(f.ownTimeoutMs / 1000)} s fits` });
  }
  return { defs, refused, served, noted };
}

/** The slug a request path names under /ref/, or null. Case, a trailing slash
 *  and percent-encoding are folded the way the router resolves the path: the
 *  wide reading, for the gates that must COUNT every spelling. The gate itself
 *  serves the canonical spelling only (isCanonicalReferralPath). */
export function referralSlugOfPath(path) {
  let p = String(path || "");
  if (p.length > 200) return null;
  try { p = decodeURIComponent(p); } catch { /* a malformed escape stays as written */ }
  p = p.toLowerCase().replace(/\/{2,}/g, "/");
  if (!p.startsWith("/ref/")) return null;
  const slug = p.slice(5).replace(/\/+$/, "");
  return SLUG.test(slug) ? slug : null;
}
/** True for exactly `/ref/<slug>`: no escape, no case change, no extra slash. */
export function isCanonicalReferralPath(path, slug) {
  return typeof path === "string" && typeof slug === "string" && path === `/ref/${slug}`;
}

/** True when `signature` is an ECDSA signature by `auth.from` over the
 *  ReceiveWithAuthorization typed data of Base USDC. A 65-byte signature with
 *  v 27/28 or 0/1 and a 64-byte EIP-2098 compact one are all read (the forms
 *  the facilitator's documents accept). Pure: no network call. */
export async function isLocalReceiveSignature(auth, signature) {
  try {
    const full = signature.length === 130 ? serializeSignature(compactSignatureToSignature(parseCompactSignature(signature))) : signature;
    return await verifyTypedData({
      address: auth.from,
      domain: { name: USDC.name, version: USDC.version, chainId: REFERRAL_CHAIN_ID, verifyingContract: REFERRAL_ASSET },
      types: RECEIVE_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message: { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
      signature: full,
    });
  } catch { return false; }
}

/**
 * The local reading of a decoded payment against the requirement this request
 * was quoted. Returns `{ reason }` (a refusal code) or
 * `{ auth, signature, validBeforeMs, timeReason }` (`timeReason` a refusal
 * code when the authorization's clock window does not fit, else null). Reads
 * string fields only.
 * `needMs`: the validity the authorization must still carry (the whole run
 * and its settlement); `maxValidityMs`: the furthest ahead it may expire.
 */
export function checkReferralPayment(payment, requirement, { nowMs = Date.now(), needMs = REFERRAL_DEFAULTS.deadlineMs + REFERRAL_DEFAULTS.settleReserveMs + REFERRAL_DEFAULTS.verifyMs, maxValidityMs = REFERRAL_DEFAULTS.maxValidityMs } = {}) {
  const refuse = (reason) => ({ reason });
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) return refuse("invalid_request");
  const txt = (v) => (typeof v === "string" ? v : "");
  // Every network and asset the payment names must be the one quoted.
  for (const n of [payment.accepted?.network, payment.network, payment.payload?.network]) {
    if (n !== undefined && n !== null && n !== REFERRAL_NETWORK) return refuse("invalid_network");
  }
  const asset = payment.accepted?.asset;
  if (asset !== undefined && asset !== null && lc(txt(asset)) !== lc(requirement.asset)) return refuse("invalid_payment_requirements");
  const scheme = payment.accepted?.scheme ?? payment.scheme;
  if (scheme !== undefined && scheme !== null && scheme !== "exact") return refuse("unsupported_scheme");
  const inner = payment.payload;
  const auth = inner && typeof inner === "object" && !Array.isArray(inner) ? inner.authorization : null;
  const signature = inner && typeof inner === "object" ? inner.signature : null;
  if (!auth || typeof auth !== "object" || Array.isArray(auth) || typeof signature !== "string" || !HEX.test(signature)) return refuse("invalid_payload");
  // An ECDSA signature in one of its two forms: nothing else can be checked here.
  if (signature.length !== 132 && signature.length !== 130) return refuse("invalid_exact_evm_payload_signature");
  if (!ADDR.test(txt(auth.from)) || !ADDR.test(txt(auth.to)) || !B32.test(txt(auth.nonce))) return refuse("invalid_payload");
  for (const f of ["value", "validAfter", "validBefore"]) if (!UINT.test(txt(auth[f]))) return refuse("invalid_payload");
  // The money checks: the contract named in the 402, and exactly the amount.
  if (lc(auth.to) !== lc(requirement.payTo)) return refuse("invalid_exact_evm_payload_recipient_mismatch");
  if (BigInt(auth.value) !== BigInt(requirement.amount)) return refuse("invalid_exact_evm_payload_authorization_value_mismatch");
  // EIP-2: the upper-half-s twin of a valid signature is refused, as the token does.
  if (signature.length === 132 && BigInt(`0x${signature.slice(66, 130)}`) > SECP256K1_HALF_N) return refuse("invalid_exact_evm_payload_signature");
  const validBeforeSec = BigInt(auth.validBefore);
  // Bounded before it becomes a Number.
  if (validBeforeSec > 4_102_444_800n) return refuse("authorization_validity_too_long");
  const validBeforeMs = Number(validBeforeSec) * 1000;
  // The clock checks are a reason of their own (`timeReason`), read by the
  // caller AFTER it has looked for an answer already kept for this payment:
  // a re-send of a payment that ran is answered whatever the clock says now.
  const nowSec = BigInt(Math.floor(nowMs / 1000));
  let timeReason = null;
  if (BigInt(auth.validAfter) > nowSec) timeReason = "invalid_exact_evm_payload_authorization_valid_after";
  // Long enough for the whole run and its settlement: a shorter one is
  // refused, never run on a shortened budget.
  else if (validBeforeMs - nowMs < needMs) timeReason = "invalid_exact_evm_payload_authorization_valid_before";
  // And no longer than the bound: a held claim always ends soon.
  else if (validBeforeMs - nowMs > maxValidityMs) timeReason = "authorization_validity_too_long";
  return { auth, signature, validBeforeMs, timeReason };
}

/** The replay identity of a referral authorization: the chain consumes a
 *  nonce per (token, from), so that pair on Base is the payment. */
export function referralReplayKey(auth) {
  return `referral:${createHash("sha256").update(`${REFERRAL_NETWORK}\n${lc(auth.from)}\n${lc(auth.nonce)}`).digest("hex")}`;
}

/** Reason codes of this gate's own, with the sentence each answer carries. */
export const REFERRAL_REASONS = Object.freeze({
  invalid_request: "The payment header does not decode to a payment. Nothing was charged.",
  invalid_payload: "The payment carries no usable authorization and signature. Nothing was charged.",
  invalid_network: "This route settles USDC on Base (eip155:8453) only. Nothing was charged.",
  invalid_payment_requirements: "The payment names another asset than the one this route's 402 asks. Nothing was charged.",
  unsupported_scheme: "This route takes the exact scheme only. Nothing was charged.",
  invalid_exact_evm_payload_recipient_mismatch: "The authorization does not pay the address this route's 402 names. Nothing was charged.",
  invalid_exact_evm_payload_authorization_value_mismatch: "The authorization's value is not the amount this request's 402 asks. Nothing was charged.",
  invalid_exact_evm_payload_authorization_valid_before: "The authorization expires too soon for the call to run and settle. Nothing was charged. Request the 402 again and pay it at once.",
  invalid_exact_evm_payload_authorization_valid_after: "The authorization is not valid yet. Nothing was charged.",
  invalid_exact_evm_payload_signature: "The signature is not the payer's own ECDSA signature over this ReceiveWithAuthorization. Nothing was charged.",
  authorization_validity_too_long: "The authorization expires too far ahead for this route. Nothing was charged. Sign one that expires within the time the 402 asks.",
  facilitator_unavailable: "The payment could not be checked right now. Nothing ran and nothing was charged. Retry shortly.",
  settle_outcome_unknown: "The call ran, but whether the payment settled is not known yet. Send the same PAYMENT-SIGNATURE again: if the payment was charged, the answer is returned with its transaction and nothing runs or is charged twice; if it was not, nothing is owed.",
  settle_refused: "The call ran, but the payment network refused to settle the payment. No charge is recorded; if one lands after all, the full price is recorded as owed to the paying wallet.",
  authorization_expired_unused: "This authorization expired without being used. Nothing was charged. Sign a new one to make the call again.",
  answer_unavailable: "This authorization was already used for a call whose answer is no longer held here. No charge is recorded for it here; whether one landed is still being read from the chain, and if one did, the full price is recorded as owed to the paying wallet.",
  answer_unavailable_charged: "This payment was charged and its answer is no longer held here. The full price is owed to the paying wallet; recording that did not succeed just now and is tried again. Send the same PAYMENT-SIGNATURE again shortly to read where it stands.",
  answer_unavailable_refund_owed: "This payment was charged, and its answer is no longer held here, so the full price is recorded as owed to the paying wallet. It is repaid on Base after the payment is reviewed; `transaction` and `refundStatusUrl` in this answer show where it stands. Sign a new authorization to make the call again.",
  authorization_used_unpaid: "This authorization was used on chain without a payment to this route being found (it was canceled, or used for another transfer), so the answer is not delivered. This route was not paid. If that was not your doing, check the paying wallet's transfers before signing again.",
  settled_to_another_merchant: "The payment network settled this payment to another merchant, not to this route: the amount left the paying wallet in the transaction named in this answer, we did not receive it, and nothing was delivered. We cannot return money we did not receive. Take the transaction to the referral network whose link was used; this server has recorded it for its operator. Signing again would be a second payment.",
  payer_screen_unavailable: "The payment could not be checked right now. Nothing ran and nothing was charged. Retry shortly.",
  settlement_unavailable: "The payment could not be settled because of a fault on this server's side. Nothing was charged. If the call ran, its answer is kept: send the same PAYMENT-SIGNATURE again later.",
  chain_unavailable: "The chain could not be read right now, so the payment could not be followed to its settlement. Nothing ran and nothing was charged. Retry shortly.",
  settlement_under_review: "This route is not taking this payment while an earlier settlement is being checked. Nothing ran and nothing was charged. Retry later.",
  settlement_unproven_refund_owed: "The payment was taken, but its settlement is not one this route can prove as its own, so the answer is not delivered. The full price is recorded as owed to the paying wallet. It is repaid on Base after the payment is reviewed; `transaction` and `refundStatusUrl` in this answer show where it stands.",
  settled_for_another_product: "This payment was settled for another product than the one this route sells, so the answer is not delivered. The full price is recorded as owed to the paying wallet. It is repaid on Base after the payment is reviewed; `transaction` and `refundStatusUrl` in this answer show where it stands.",
  rate_under_review: "This tool is not taking payments on this route while its settlement terms are being checked. Nothing ran and nothing was charged. Retry later.",
  settlement_book_full: "This route cannot record a new settlement right now. Nothing ran and nothing was charged. Retry in a minute.",
  delivery_store_unavailable: "The payment settled, but the delivery could not be recorded, so the answer was not sent. Send the same PAYMENT-SIGNATURE again shortly: the answer is kept and nothing runs or is charged twice.",
  answer_already_delivered: "This payment was settled and its answer was delivered. Each authorization buys one call: sign a new one to call again.",
  settlement_store_unavailable: "The call ran, but the settlement could not be recorded, so the payment was not submitted. Nothing was charged. Send the same PAYMENT-SIGNATURE again shortly: the answer is kept and nothing runs twice.",
  too_many_unsettled_runs: "Too many calls from this payer ran without their payment settling. Nothing was charged for this request. Retry after the time given.",
  too_many_runs_in_flight: "This payer already has the most paid calls this route runs at once. Nothing was charged for this request. Retry in a few seconds.",
  busy: "Too many paid calls are in flight on this route. Nothing ran and nothing was charged. Retry shortly.",
  draining: "This host is restarting. Nothing ran and nothing was charged. Retry in a minute.",
});

/** True for a request with no input at all: no query, and either no body
 *  (no Content-Length above zero and no Transfer-Encoding) or a JSON body
 *  that parsed to exactly {}. */
export function isEmptyRequest(req) {
  if (req?.query && typeof req.query === "object" && Object.keys(req.query).length) return false;
  const h = req?.headers || {};
  const declared = Number(h["content-length"]);
  const hasBody = (Number.isFinite(declared) && declared > 0) || h["transfer-encoding"] !== undefined;
  if (!hasBody) return true;
  const type = String(h["content-type"] || "").toLowerCase();
  const b = req.body;
  return /^application\/(?:[\w.+-]+\+)?json\b/.test(type) && b !== null && typeof b === "object" && !Array.isArray(b) && !Buffer.isBuffer(b) && Object.keys(b).length === 0;
}

/** A log that prints the first `perMinute` lines of a minute and then one
 *  summary of how many were left out (the shape of src/prepayment-refusal.js's sampler). */
export function createLineSampler({ perMinute = 20, now = Date.now, print = () => {} } = {}) {
  let minute = -1, printed = 0, suppressed = 0;
  const flush = () => { if (suppressed > 0) { try { print(`refusal lines summary: ${suppressed} more in that minute`); } catch { /* a log never throws */ } } printed = 0; suppressed = 0; };
  return {
    line(text) {
      const m = Math.floor(now() / 60_000);
      if (m !== minute) { flush(); minute = m; }
      if (printed < perMinute) { printed++; try { print(text); } catch { /* a log never throws */ } return true; }
      suppressed++;
      return false;
    },
    flush,
    stats: () => ({ printed, suppressed }),
  };
}

/**
 * Build the gate. Every dependency on the server is passed in, so the module
 * can be run against stubs. Required: config, defs, settler, chain, book,
 * replayGuard, priceUsdOf, priceForNetwork, sendToolError, recordSale.
 *
 * @param {object} o
 * @param {object} o.config                    referralConfig()
 * @param {Map<string, object>} o.defs         slug -> catalog definition (referralRoutes)
 * @param {{verify: Function, settle: Function}} o.settler   createReferralSettler()
 * @param {{state: Function}} o.chain          createReferralChainReader()
 * @param {object} o.book                      createReferralBook()
 * @param {object} o.replayGuard               createReplayGuard(): a guard of this gate's own
 * @param {(def, req) => number} o.priceUsdOf  the server's per-request price (stashes the quote on the request)
 * @param {(price: string, network: string) => string} o.priceForNetwork
 * @param {(def, req) => ({status, body}|null)} [o.preValidate]        the pre-payment input check
 * @param {(def, input) => ({status, body}|null)} [o.prePaymentRefusal] the metered pre-payment refusal
 * @param {(req, res) => Promise<boolean>} [o.payerScreen]  the payer screen: false when it answered the refusal itself
 * @param {(req) => void} [o.isolate]          keep this run out of the direct routes' money guards
 * @param {(req, endsAtMs) => void} [o.presentWindow]  present the run's deadline as its payment window
 * @param {(ms, fn) => any} [o.withCeiling]    run fn with handler budgets capped at ms
 * @param {{limited, note}} [o.credentialLimiter]  the refused-credential limiter
 * @param {() => ({active: boolean, leftMs: number})} [o.draining]
 * @param {(tx, payer, slug) => number} [o.saleBooked]  how many sales stand for this payer and slug under this transaction
 * @param {(req) => void} [o.onSettledSale]    a settled sale by this client (paid-client allowance)
 * @param {number|null} [o.modelNetFloorBps]  the stop floor of a model-backed tool as a share of its price, where
 *                                             REFERRAL_MIN_NET_BPS names neither the slug nor a default (the server passes
 *                                             the gateway's own margin bound, src/tools/llm-gateway-kit.js MARGIN)
 * @param {({tx, netUsd, payer, slug, grossUsd}) => boolean|Promise<boolean>} o.amendSaleNet  correct THIS payment's booked net in place: the row of that payer, slug and gross under the transaction (true when a row changed)
 */
export function createReferralGate({
  config, defs, settler, chain, book, replayGuard, baseUrl, priceUsdOf, priceForNetwork,
  preValidate, prePaymentRefusal, warmQuote, runAsCaller, sendToolError, recordSale, saleBooked, isSynthetic, salePathOf, requireShared, onRun = null,
  payerScreen, isolate, presentWindow, withCeiling, credentialLimiter, clientKey, draining, onSettledSale, payerHasPaid, oweRefund, amendSaleNet, answers, modelNetFloorBps = null,
  log = console, now = Date.now,
} = {}) {
  if (!config || !(defs instanceof Map) || !settler || !chain || !book || !replayGuard) throw new Error("referral gate: config, defs, settler, chain, book and replayGuard are required");
  // Every dependency on the server is REQUIRED: a gate built without one of
  // them would run with a rule silently missing (no payer screen, no
  // deadline on upstream work, no drain check), so it is not built at all.
  const required = { priceUsdOf, priceForNetwork, preValidate, prePaymentRefusal, warmQuote, runAsCaller, sendToolError, recordSale, saleBooked, isSynthetic, salePathOf, requireShared, payerScreen, isolate, presentWindow, withCeiling, clientKey, draining, onSettledSale, payerHasPaid, oweRefund, amendSaleNet };
  if (!answers || typeof answers.put !== "function" || typeof answers.get !== "function" || typeof answers.del !== "function") required.answers = null;
  const missing = Object.entries(required).filter(([, v]) => typeof v !== "function").map(([k]) => k);
  if (!credentialLimiter || typeof credentialLimiter.limited !== "function" || typeof credentialLimiter.note !== "function") missing.push("credentialLimiter");
  if (missing.length) throw new Error(`referral gate: missing ${missing.join(", ")}`);
  const origin = String(baseUrl || "").replace(/\/+$/, "");
  const counters = {
    deliveryMarkFailed: 0, bookFaultHeld: 0, newPayerShareRefused: 0, shortNetSales: 0, shortNetHeld: 0, netsCorrected: 0, settleUnproven: 0, refusedUnread: 0, productMismatches: 0, ceilingCuts: 0, partlyServed: 0, unrecognizedClosed: 0, sendsEndedIdle: 0, sendInflightRefused: 0, reopenedByHand: 0, unconfirmedHeld: 0, unconfirmedFlagged: 0, headUnavailable: 0, bookFullRefused: 0, resolvedByHand: 0, alreadyDelivered: 0,
    challenges: 0, refused: 0, signatureRefused: 0, replays: 0, verifyRefused: 0, screened: 0, laneRefused: 0, busy: 0,
    signerRefused: 0, ownFaultHeld: 0, screenErrors: 0, verifyUnavailable: 0, settleContradicted: 0, unconfirmed: 0, refundsOwed: 0, restoredAnswers: 0, runs: 0, exampleRuns: 0, handlerErrors: 0, timeouts: 0, forgivenHangups: 0, settleRefused: 0, settleInDoubt: 0, landedAfterDoubt: 0, usedUnpaid: 0, intentFailed: 0,
    settled: 0, resent: 0, redelivered: 0, chargedNotServed: 0,
  };
  const line = (level, text) => { try { (log[level] || log.log).call(log, `[referral] ${text}`); } catch { /* a log never breaks a call */ } };
  const refusalLog = createLineSampler({ now, print: (text) => line("warn", text) });
  // Faults of this server's own (the signer refused): error lines an operator sees, sampled the same way.
  const faultLog = createLineSampler({ now, print: (text) => line("error", text) });
  const shortPayer = (from) => `${String(from).slice(0, 6)}`;
  const needMs = config.deadlineMs + config.settleReserveMs + config.verifyMs;

  // ---- the unsettled-run lane ------------------------------------------------------
  // The direct routes' settle breaker, on this route's own counts
  // (src/gateway-settle-breaker.js), so a referral run is judged the same way
  // without feeding or meeting the direct one:
  //   - unsettled OUTCOMES are counted per signed payer: a settle refused for
  //     the payment, a nonce spent without paying, and a settle whose outcome
  //     is not known yet (taken back if it is later proven paid). A run that
  //     ended at the deadline THIS route imposed is not one (the direct
  //     breaker does not count its own timeouts either). Settled calls are
  //     outcomes too and never erased.
  //   - a payer is refused (429, before anything runs) only when it holds
  //     `unsettledMax` unsettled outcomes in the window AND they are more than
  //     MIN_FAIL_SHARE of its outcomes, or `unsettledHardMax` whatever it
  //     settled. Nobody is refused for another wallet's outcomes: a client
  //     address is counted too (at REFERRAL_ADDRESS_FACTOR times the payer's
  //     figure), but it refuses only a payer that has an unsettled outcome of
  //     its own.
  //   - service-wide: while `globalMax` distinct payers have unsettled outcomes
  //     in the window, a payer that has never settled (no settled outcome in
  //     the window and no paid sale on the books) is held at one unsettled
  //     outcome instead of `unsettledMax`. It tightens only never-paid
  //     wallets and refuses nobody for others' outcomes alone.
  //   - runs in flight are bounded per payer apart from all of this, at a
  //     figure honest concurrency does not reach (`payerInflightMax`).
  // Retry-After is when the oldest unsettled outcome that holds the refusal
  // leaves the window.
  const MIN_FAIL_SHARE = 0.5;
  const lane = new Map(); // key -> { inflight, fails: [[t, tag]], oks: [t] }
  const LANE_MAX_KEYS = 20_000;
  const laneOf = (key, create) => {
    let l = lane.get(key);
    if (!l && create) {
      if (lane.size >= LANE_MAX_KEYS) { for (const [k, v] of lane) { if (v.inflight === 0) { lane.delete(k); break; } } }
      l = { inflight: 0, fails: [], oks: [] };
      lane.set(key, l);
    }
    return l || null;
  };
  const trimLane = (l, t) => {
    while (l.fails.length && t - l.fails[0][0] >= config.unsettledWindowMs) l.fails.shift();
    while (l.oks.length && t - l.oks[0] >= config.unsettledWindowMs) l.oks.shift();
  };
  const laneKeysOf = (req, payer) => [`payer:${payer}`, `addr:${clientKey(req)}`];
  /** Distinct payers with an unsettled outcome in the window (the service-wide reading). */
  const failingPayers = (t) => {
    let n = 0;
    for (const [k, l] of lane) { if (!k.startsWith("payer:")) continue; trimLane(l, t); if (l.fails.length) n++; }
    return n;
  };
  /** THE SERVICE-WIDE RULE, on the run slots too. While `globalMax` distinct
   *  payers have unsettled runs in the window (a stream of payments that run
   *  a tool and then do not settle), payers with no paid sale on the books
   *  share at most a QUARTER of the run slots (at least one): the rest stay
   *  free for returning buyers, and new buyers still have a share. A payer
   *  with a paid sale is never refused by it. Not a wait: a new payer past
   *  the share is answered 503 busy at once. */
  const serviceWideFailing = () => failingPayers(now()) >= config.globalMax;
  const newPayerSlots = () => Math.max(1, Math.floor(config.maxInflight / 4));
  let inflightNew = 0;
  /** Admit a run, or `{ retryAfterSeconds }` when the payer is held. */
  const laneAdmit = (keys) => {
    const t = now();
    const [payerKey, addrKey] = keys;
    const p = laneOf(payerKey, false);
    const a = laneOf(addrKey, false);
    if (p) trimLane(p, t);
    if (a) trimLane(a, t);
    const pFails = p ? p.fails.length : 0;
    const pOks = p ? p.oks.length : 0;
    const wait = (list) => Math.max(1, Math.ceil((list[0][0] + config.unsettledWindowMs - t) / 1000));
    if (p && p.inflight >= config.payerInflightMax) return { retryAfterSeconds: 5, inflight: true };
    // One address may hold REFERRAL_ADDRESS_FACTOR times a payer's runs in flight (wallets that share it).
    if (a && a.inflight >= config.payerInflightMax * REFERRAL_ADDRESS_FACTOR) return { retryAfterSeconds: 5, inflight: true };
    if (pFails > 0) {
      const neverPaid = pOks === 0 && !payerHasPaid(payerKey.slice(6));
      const max = neverPaid && failingPayers(t) >= config.globalMax ? 1 : config.unsettledMax;
      if (pFails >= config.unsettledHardMax || (pFails >= max && pFails > MIN_FAIL_SHARE * (pFails + pOks))) return { retryAfterSeconds: wait(p.fails) };
      // The address counts only against a payer that has failed itself.
      if (a && a.fails.length >= config.unsettledMax * REFERRAL_ADDRESS_FACTOR) return { retryAfterSeconds: wait(a.fails) };
    }
    for (const key of keys) laneOf(key, true).inflight++;
    return null;
  };
  const laneLeave = (keys) => { for (const key of keys) { const l = lane.get(key); if (l && l.inflight > 0) l.inflight--; } };
  const laneNote = (keys, tag = null) => { const t = now(); for (const key of keys) { const l = laneOf(key, true); if (tag && l.fails.some((n) => n[1] === tag)) continue; l.fails.push([t, tag]); } };
  const laneClear = (keys, tag) => { if (!tag) return; for (const key of keys) { const l = lane.get(key); if (l) l.fails = l.fails.filter((n) => n[1] !== tag); } };
  const laneOk = (keys) => { const t = now(); for (const key of keys) laneOf(key, true).oks.push(t); };

  // ---- hang-up forgiveness: this route's own budget ---------------------------------
  // The direct routes' rule (a buyer gone before settlement is not charged
  // while the run holds a ticket priced at its charge, against a per-payer,
  // a per-address and a route-wide budget that a paid success never refills),
  // on budgets of this gate's own: a referral run never holds or spends a
  // cent of the budget a direct buyer's hang-up is judged against. Abandoned
  // records are kept in the book, so a restart does not refill them.
  const MICRO = 1e6;
  const forgive = { inflight: new Map(), globalInflight: 0, abandoned: [] };
  const digestKey = (k) => createHash("sha256").update(String(k)).digest("hex").slice(0, 24);
  let forgivenLoaded = false;
  const loadForgiven = () => { if (forgivenLoaded) return; forgivenLoaded = true; try { forgive.abandoned = book.forgiven().map((r) => [Number(r[0]), Number(r[1]), Array.isArray(r[2]) ? r[2] : []]); } catch { forgive.abandoned = []; } };
  Promise.resolve(book.ready).then(() => { forgivenLoaded = false; loadForgiven(); }).catch(() => {});
  function reserveForgiveness(keys, micro) {
    loadForgiven();
    const t = now();
    forgive.abandoned = forgive.abandoned.filter((r) => t - r[0] < config.hangupWindowMs);
    const ids = keys.map(digestKey);
    // `reason`: why no ticket was granted, in the direct routes' words (the
    // refund run holds a hang-up past a spent budget for review).
    const ticket = { granted: false, ids, micro, open: false, reason: null };
    if (!(micro > 0)) return ticket;
    const spentBy = (id) => forgive.abandoned.reduce((a, r) => a + (r[2].includes(id) ? r[1] : 0), 0) + (forgive.inflight.get(id) || 0);
    const spentAll = forgive.abandoned.reduce((a, r) => a + r[1], 0) + forgive.globalInflight;
    if (spentAll + micro > config.hangupGlobalMicro) { ticket.reason = "global budget"; return ticket; }
    const over = ids.findIndex((id) => spentBy(id) + micro > config.hangupKeyMicro);
    if (over >= 0) { ticket.reason = over === 0 ? "payer budget" : "ip budget"; return ticket; }
    for (const id of ids) forgive.inflight.set(id, (forgive.inflight.get(id) || 0) + micro);
    forgive.globalInflight += micro;
    ticket.granted = true;
    ticket.open = true;
    return ticket;
  }
  function finishForgiveness(ticket, abandoned) {
    if (!ticket || !ticket.open) return;
    ticket.open = false;
    for (const id of ticket.ids) { const left = (forgive.inflight.get(id) || 0) - ticket.micro; if (left > 0) forgive.inflight.set(id, left); else forgive.inflight.delete(id); }
    forgive.globalInflight = Math.max(0, forgive.globalInflight - ticket.micro);
    if (!abandoned) return;
    const record = [now(), ticket.micro, ticket.ids];
    forgive.abandoned.push(record);
    book.noteForgiven(record, { windowMs: config.hangupWindowMs }).catch(() => {});
  }

  // ---- answers kept for a re-send, by replay key ------------------------------------
  const kept = new Map(); // key -> entry (insertion order = age)
  let keptBytes = 0;
  // One /settle in flight per authorization: the request that is settling
  // holds the slot, and a re-send that arrives meanwhile is told so.
  const settling = new Set();
  let inflight = 0;
  // Calls between admission and the end of the request (waiting on /verify included).
  let pending = 0;
  const dropKept = (key) => { const e = kept.get(key); if (e) { keptBytes -= e.bytes; kept.delete(key); } };
  // What an entry still owes its buyer: an answer whose payment landed and was
  // not delivered, or whose settle outcome is not known, is the last to go.
  const owed = (e) => (e.landed && !e.delivered) || e.everInDoubt === true && !e.unpaid && !e.delivered;
  // RETENTION. A tool's answer is kept for the buyer's re-send only until its
  // `expiresAt`: REFERRAL_ANSWER_RETENTION_MS after it was produced, never past
  // the authorization's validBefore plus REFERRAL_ANSWER_GRACE_MS, in memory
  // and at rest alike (src/privacy.js states the same bound for a paid answer
  // kept against its payment). An answer still owed when it expires is not
  // delivered after it: the payment it was charged for is owed back instead
  // (oweIfUndeliverable).
  const expiryOf = (producedAt, validBeforeMs) => Math.min(producedAt + REFERRAL_ANSWER_RETENTION_MS, validBeforeMs + REFERRAL_ANSWER_GRACE_MS);
  const pruneKept = () => {
    const t = now();
    for (const [key, e] of kept) { if (t >= e.expiresAt) dropKept(key); }
  };
  // Bytes this process has put at rest and not yet removed (a bound on the
  // answers store, beside its per-answer size bound).
  const atRest = new Map(); // key -> { bytes, expiresAt }
  let atRestBytes = 0;
  const restForget = (key) => { const r = atRest.get(key); if (r) { atRestBytes -= r.bytes; atRest.delete(key); } };
  const restDrop = (key) => { restForget(key); answers.del(key).catch(() => {}); };
  const restPrune = () => { const t = now(); for (const [key, r] of atRest) if (t >= r.expiresAt) restForget(key); };
  const keep = (entry) => {
    pruneKept();
    if (entry.bytes > REFERRAL_ANSWER_MAX_BYTES) return false;
    if (!Number.isFinite(entry.expiresAt)) entry.expiresAt = expiryOf(entry.at || now(), entry.validBeforeMs);
    dropKept(entry.key);
    while (kept.size >= REFERRAL_KEPT_ANSWERS_MAX || keptBytes + entry.bytes > REFERRAL_KEPT_BYTES_MAX) {
      // Delivered and definitively refused answers go first, oldest first.
      let victim = null;
      for (const [key, e] of kept) { if (!owed(e)) { victim = key; break; } }
      if (victim === null) {
        victim = kept.keys().next().value;
        if (victim === undefined) break;
        const e = kept.get(victim);
        // An answer still owed is dropped only when nothing else is left, and the book says so.
        line("error", `kept answers are full of answers still owed; dropping the oldest from memory (${e.slug} payer=${shortPayer(e.payer)} ${e.landed ? "charged, undelivered" : "settle in doubt"}); the copy at rest, if any, stays, and a charged one that cannot be delivered is owed back`);
        book.resolve(victim, { answerEvicted: true }).catch(() => {});
      }
      dropKept(victim);
    }
    kept.set(entry.key, entry);
    keptBytes += entry.bytes;
    return true;
  };

  /** The least our payout must carry for a sale of `amount` on `slug`
   *  (referralMinNet: tolerant of the contract's rounding). The proof needs it. */
  const minNetOf = (slug, amount) => {
    try { return referralMinNet(amount, { commissionBps: commissionBpsFor(config, slug) ?? 0, feeBps: config.feeBps }).toString(); } catch { return null; }
  };
  /** The proof of one transaction with its detail (`moved`: the buyer's own
   *  transfer into the split contract is in the receipt). A reader without
   *  the detail reads as moved: the wider hold. */
  const proveWithDetail = async (tx, args, opts) => {
    if (typeof chain.proveDetail === "function") { const d = await chain.proveDetail(tx, args, opts); return { verdict: d?.verdict || "unknown", moved: d?.moved === true, routedToUs: d?.routedToUs === true, net: d?.net ?? null, read: d?.read === true, why: d?.why || null, product: d?.product || null }; }
    return { verdict: await chain.proveTransaction(tx, args, opts), moved: true, routedToUs: false, net: null, read: false, why: null, product: null };
  };
  /**
   * THE HOLD FOR A BOOK THAT IS WRONG. An open entry that says this server's
   * own bookkeeping is wrong refuses a NEW payment before anything runs (503,
   * nothing charged); a re-send of a payment already run is answered as
   * always. The scope:
   *   - "payer" (that payer only): EVERY contradicted settle success, where
   *     the named transaction did not pay this merchant: routed to another
   *     merchant, reverted, another transaction's, or denied by the chain
   *     after the answer went out. An authorization names the split contract
   *     and no merchant, so its signer can present it elsewhere, cancel it or
   *     spend it: each of these can be produced with a payment, and none may
   *     close the route for other buyers. The payer's own lane holds it.
   *   - "route" (every payer), only for facts no payment can cause:
   *       1. an unconfirmed entry flagged because the receipt of a
   *          transaction the facilitator called successful still cannot be
   *          read, or is not a shape the rule recognizes, after three
   *          minutes. A buyer signs an authorization and nothing else: it
   *          neither sends the settlement transaction nor decides what its
   *          receipt holds or whether this server's RPCs can read it. The
   *          cause is this server's settings, its chain reads, or the
   *          contract's event shape, and the next success would not be
   *          confirmed either.
   *       2. a payment BOOKED on a receipt that proved it, whose receipt no
   *          longer does (writeDebt). Only the chain or its readers changing
   *          their answer for one transaction hash does that.
   *     An entry with no scope written on it reads "payer".
   * It ends when the entry resolves: the sweep confirms it, or an operator
   * resolves it by hand. Null when nothing holds this payer.
   */
  const bookFault = (payer, faults = book.faults()) => {
    let own = null;
    for (const f of faults) {
      if (f.scope !== "payer") return f;
      // An unproven success is this server's fault, never a hold on its payer.
      if (f.payer === payer && f.own !== false) own = f;
    }
    return own;
  };
  // ---- contradicted successes from several payers: a hold that heals itself --------
  // Open contradicted successes that MOVED money, from
  // REFERRAL_CONTRADICTED_PAYERS distinct payers inside one window and with
  // NO proven-paid settle since (a wrong merchant id setting looks like this:
  // every payer is charged and none served), hold the route. Counted per
  // payer, so one payer with many payments never reaches it; counted only
  // since the last settle a receipt proved paid to this merchant
  // (`route.healedAt`), so contradictions scattered among sales that prove
  // fine never add up.
  // The hold is probe-based, like the own-fault hold: while it stands ONE
  // payment at a time goes through. A probe the receipt proves paid ends the
  // hold; a probe contradicted again keeps it and starts a cool-down
  // (`ownFaultCooldownMs`) before a payer that has never paid here may probe
  // again, so a setting that is really wrong charges one new buyer a minute,
  // not every buyer. A payer with a paid sale on the books probes at any
  // time: wallets made for the purpose cannot keep returning buyers out.
  const route = { healedAt: 0, probeUntil: 0, blockedUntil: 0 };
  const manyContradicted = (moved) => {
    const live = moved.filter((f) => f.at > route.healedAt);
    if (live.length < REFERRAL_CONTRADICTED_PAYERS) return null;
    const byTime = live.slice().sort((x, y) => x.at - y.at);
    for (let i = 0; i < byTime.length; i++) {
      const payers = new Set();
      for (let j = i; j < byTime.length && byTime[j].at - byTime[i].at <= config.unsettledWindowMs; j++) payers.add(byTime[j].payer);
      if (payers.size >= REFERRAL_CONTRADICTED_PAYERS) return { ...byTime[i], scope: "route", many: true };
    }
    return null;
  };
  const routeHeld = (faults = book.faults()) => manyContradicted(faults.filter((f) => f.moved === true));
  /** For a new payment while the route may be held: null (not held), "hold"
   *  (503), or "probe" (this payment goes through as the one probe; with
   *  `take` the probe slot is taken, to be given back by routeProbeEnd).
   *  When the hold stands on UNPROVEN successes that moved money from three
   *  payers (every buyer is being charged with no answer: this server's
   *  settings, or the contract's shape), a payer that has never paid here is
   *  never the probe: only a payer with a paid sale on the books probes, and
   *  the hold ends only on a receipt-proven sale or by the operator. */
  const routeGate = (payer, take, faults = book.faults()) => {
    if (!routeHeld(faults)) return null;
    const t = now();
    if (t < route.probeUntil) return "hold";
    let paidBefore = false;
    try { paidBefore = payerHasPaid(payer) === true; } catch { paidBefore = false; }
    const unprovenPayers = new Set(faults.filter((f) => f.unproven === true && f.moved === true && f.at > route.healedAt).map((f) => f.payer));
    if (unprovenPayers.size >= REFERRAL_CONTRADICTED_PAYERS && !paidBefore) return "hold";
    if (t < route.blockedUntil && !paidBefore) return "hold";
    if (take) route.probeUntil = t + OWN_PROBE_MS;
    return "probe";
  };
  const routeProbeEnd = (contradicted) => {
    route.probeUntil = 0;
    if (contradicted) route.blockedUntil = now() + config.ownFaultCooldownMs;
  };
  /** A settle the receipt proved paid to this merchant: earlier contradictions no longer count. */
  const routeHealed = () => { route.healedAt = now(); route.blockedUntil = 0; };
  // ---- a sale paid under the rate map's floor --------------------------------------
  // The contract's rate for a slug above the one REFERRAL_COMMISSION_BPS
  // holds is this server's own configuration drift, never the buyer's fault:
  // the call is paid (the proof does not weigh the net), the answer is
  // delivered, and the sale is booked at what the receipt shows. What follows
  // is ours: the word reads attention from the first such sale, naming the
  // slug and both amounts, until the map admits the amount (a restart with
  // the corrected map) or an operator clears the record. And a slug whose
  // sales arrive under its STOP floor is stopped: 503 before the handler,
  // nothing charged. The floor is the share of the price REFERRAL_MIN_NET_BPS
  // sets for the slug; with none set, for a model-backed tool the share of
  // the price its upstream cost is kept within (modelNetFloorBps), for any
  // other tool half the net the commission map expects. A model-backed tool
  // stops at ONE sale under its floor (each call has upstream cost), any
  // other at `shortNetMax` (three: one or two can be an odd sale); a gap
  // that leaves the sale at or above the floor is raised and stops nobody.
  /** How many sales under the stop floor a slug takes before it stops: ONE
   *  for a tool the catalog marks model-backed (each call has upstream
   *  cost), `shortNetMax` for any other; 0 (the knob) never stops a slug. */
  const stopAfter = (slug) => (config.shortNetMax <= 0 ? 0 : defs.get(slug)?.modelBacked === true ? 1 : config.shortNetMax);
  /** Whether `got` of a sale of `gross` on `slug` is under the slug's STOP
   *  floor: the share of the price REFERRAL_MIN_NET_BPS sets for it, else
   *  half the net the commission map expects. */
  const underStopFloor = (slug, gross, got) => {
    const m = config.minNetBps;
    const bps = m ? (Object.hasOwn(m.bySlug, slug) ? m.bySlug[slug] : m.default) : null;
    if (bps !== null && bps !== undefined) return BigInt(got) < (BigInt(gross) * BigInt(bps)) / 10_000n;
    // A model-backed tool with no floor of its own: the share of the price
    // its upstream cost is kept within. Under it a call can cost more than it brings.
    if (defs.get(slug)?.modelBacked === true && Number.isInteger(modelNetFloorBps) && modelNetFloorBps > 0) return BigInt(got) < (BigInt(gross) * BigInt(modelNetFloorBps)) / 10_000n;
    return BigInt(got) * 2n < BigInt(minNetOf(slug, gross));
  };
  // What this process has seen since boot, ahead of the book's write: the
  // sales under the stop floor per slug (so the stop holds from the moment a
  // short sale is seen), the slugs with a sale that arrived at or above the
  // floor (their rate is proven), and the calls in flight per slug.
  const rate = { deep: new Map(), proven: new Set(), inflight: new Map(), product: new Map() };
  // PROVEN SURVIVES A RESTART. A slug with a receipt-proven sale at or above
  // its floor is recorded in the book with a fingerprint of everything that
  // proof was judged against: the slug's commission and the fee, its stop
  // floor, its product id, the merchant id, the pay-to contract and the
  // payout wallet. A process that starts with the same settings reads the
  // slug as proven (warm); any change to one of them makes it cold again,
  // and so do the slug's own stop and an operator's clear.
  const stopFloorSpec = (slug) => {
    const m = config.minNetBps;
    const bps = m ? (Object.hasOwn(m.bySlug, slug) ? m.bySlug[slug] : m.default) : null;
    if (bps !== null && bps !== undefined) return `bps:${bps}`;
    return defs.get(slug)?.modelBacked === true && Number.isInteger(modelNetFloorBps) && modelNetFloorBps > 0 ? `model:${modelNetFloorBps}` : "half";
  };
  const rateFingerprint = (slug) => createHash("sha256").update(JSON.stringify([commissionBpsFor(config, slug), config.feeBps, stopFloorSpec(slug), productOf(slug), config.merchantId, lc(config.payTo), lc(config.payoutAddress), defs.get(slug)?.modelBacked === true])).digest("hex").slice(0, 32);
  const isProven = (slug) => {
    if (rate.proven.has(slug)) return true;
    const rec = typeof book.provenSlugs === "function" ? book.provenSlugs()[slug] : null;
    return !!rec && rec.fp === rateFingerprint(slug);
  };
  const markProven = (slug) => {
    rate.proven.add(slug);
    if (typeof book.noteProven === "function") Promise.resolve().then(() => book.noteProven(slug, rateFingerprint(slug))).catch(() => {});
  };
  const markCold = (slug) => {
    rate.proven.delete(slug);
    if (typeof book.clearProven === "function") Promise.resolve().then(() => book.clearProven(slug)).catch(() => {});
  };
  /** A receipt, read in full, names ANOTHER product id than the one
   *  configured for its slug: the slug stops at once (this process's own
   *  note, ahead of the book's), the book keeps the record, and the word
   *  names both ids until the configured id matches or an operator clears it. */
  const noteProductMismatch = (slug, amount, tx, product) => {
    if (!product || !product.configured || !product.received) return;
    if (!rate.product.has(slug)) { counters.productMismatches++; line("error", `PRODUCT ID DIFFERS for ${slug}: configured ${product.configured}, receipt ${product.received} (tx=${tx}); nothing delivered or booked as this slug's sale, new calls on it are held; correct REFERRAL_PRODUCT_IDS`); }
    rate.product.set(slug, { configured: product.configured, received: product.received });
    markCold(slug);
    book.noteShort(slug, { expected: "0", received: "0", gross: String(amount), tx, deep: false, product: { configured: product.configured, received: product.received } }).catch(() => {});
  };
  /** The product stops that still stand: `[{ slug, configured, received }]`
   *  (the book's records and this process's own; one whose configured id now
   *  equals the id the receipt carried no longer stands). */
  const productStops = () => {
    const out = new Map();
    const all = typeof book.shortSales === "function" ? book.shortSales() : {};
    for (const slug of Object.keys(all)) if (all[slug]?.product) out.set(slug, all[slug].product);
    for (const [slug, p] of rate.product) out.set(slug, p);
    return [...out].filter(([slug, p]) => productOf(slug) !== p.received).map(([slug, p]) => ({ slug, configured: productOf(slug), received: p.received }));
  };
  /** The net a sale brought is known: raise it when it is under what the map
   *  expects, count it toward the slug's stop when it is under the stop
   *  floor, and call the slug's rate proven when it is not. Once per
   *  transaction (the book counts each once). */
  const noteShortSale = (slug, amount, tx, net) => {
    try {
      const floor = BigInt(minNetOf(slug, amount));
      const got = BigInt(net);
      const deep = underStopFloor(slug, amount, got);
      if (deep) { const seen = rate.deep.get(slug) || new Set(); seen.add(String(tx)); rate.deep.set(slug, seen); markCold(slug); } else markProven(slug);
      if (!(got < floor) && !deep) return;
      counters.shortNetSales++;
      line("error", `SHORT NET: the split contract paid this merchant less than the commission map expects for ${slug}: expected at least ${floor}, received ${got}, of a gross of ${amount} (tx=${tx}); the call is paid and served; correct REFERRAL_COMMISSION_BPS`);
      book.noteShort(slug, { expected: floor.toString(), received: got.toString(), gross: String(amount), tx, deep }).catch(() => {});
    } catch { /* an amount that cannot be read notes nothing */ }
  };
  /** The short-net records the CURRENT maps still do not admit: `[{ slug,
   *  ...record, expectedNow, deepNow }]` (`deepNow`: the last amount is still
   *  under the stop floor as the maps stand now). */
  const shortNow = () => {
    const out = [];
    const all = typeof book.shortSales === "function" ? book.shortSales() : {};
    for (const slug of Object.keys(all)) {
      const r = all[slug];
      try {
        if (!(Number(r.count) > 0)) continue; // a product note alone: no short sale behind it
        const deepNow = underStopFloor(slug, r.gross, r.received);
        if (BigInt(r.received) < BigInt(minNetOf(slug, r.gross)) || deepNow) out.push({ slug, ...r, expectedNow: minNetOf(slug, r.gross), deepNow });
      } catch { /* unreadable: not counted */ }
    }
    return out;
  };
  /** No new call on this slug: its sales under the stop floor reached the
   *  slug's bound (the book's count, or this process's own, whichever is
   *  ahead), and the last such amount is still under the floor as the maps
   *  stand now (a corrected map, even in part, ends it). */
  const slugHeld = (slug) => {
    if (productStops().some((p) => p.slug === slug)) return true;
    const bound = stopAfter(slug);
    if (!bound) return false;
    const rec = shortNow().find((r) => r.slug === slug);
    const seen = Math.max(rec && rec.deepNow ? Number(rec.deep) || 0 : 0, rate.deep.get(slug)?.size || 0);
    return seen >= bound;
  };
  /** A RESERVATION, not a count after the fact: until one sale on a slug has
   *  arrived at or above its stop floor in this process, no more calls are
   *  in flight on it than the slug's bound, so a burst cannot all be served
   *  under the floor before the first receipt is read. null (free), "hold",
   *  or "taken" (with `take`: one in-flight place, given back by rateLeave). */
  const rateGate = (slug, take, payer = null) => {
    const bound = stopAfter(slug);
    if (!bound || isProven(slug)) return null;
    // A payer with a paid sale on the books is not held to a cold slug's bound.
    if (payer) { try { if (payerHasPaid(payer) === true) return null; } catch { /* held to the bound */ } }
    const n = rate.inflight.get(slug) || 0;
    if (n >= bound) return "hold";
    if (take) rate.inflight.set(slug, n + 1);
    return take ? "taken" : null;
  };
  const rateLeave = (slug) => { const n = (rate.inflight.get(slug) || 0) - 1; if (n > 0) rate.inflight.set(slug, n); else rate.inflight.delete(slug); };
  /** The product id the routed event must name for this slug, or null (not bound). */
  const productOf = (slug) => (config.productIds && Object.hasOwn(config.productIds, slug) ? config.productIds[slug] : null);
  /** Close a book entry, trying again when the write does not land: a
   *  closing write that fails is never left to be read as "undelivered". */
  async function closeEntry(key) {
    for (let i = 0; i < 3; i++) {
      let ok = false;
      try { ok = (await book.resolve(key, null)) === true; } catch { ok = false; }
      if (ok) return true;
      await new Promise((r) => { const t = setTimeout(r, 150 * (i + 1)); t.unref?.(); });
    }
    line("error", `a finished settlement could not be closed in the book (${key.slice(0, 20)}); it keeps its delivered mark and the sweep closes it`);
    return false;
  }

  /**
   * A refund owed for a charged call whose answer can no longer be delivered
   * (it expired, it was dropped, it was never stored and this process
   * restarted): the gross the buyer paid, in the refund ledger
   * (src/refund-ledger.js), with the paying transaction as its evidence, so
   * the refundsOwed word pages and scripts/refund-run.js repays it after
   * proving the transfer on chain. A debt is written ONLY when all hold, each
   * read at this moment:
   *   - the entry, as the book has it now, is charged-undelivered and does
   *     NOT carry the delivered mark (set before any answer byte goes out; an
   *     entry that carries it was served and is closed here instead);
   *   - no answer is still deliverable (in memory or at rest);
   *   - the receipt proves, again, that the payment was routed to this
   *     merchant (the proof rule; unreadable waits, contradicted is flagged);
   *   - no debt stands for that transaction and payer (the ledger's own key).
   * Resolves true when the entry was closed with a debt.
   */
  /**
   * AN UNPROVEN SUCCESS THAT MOVED MONEY IS OWED BACK. The facilitator
   * answered success, the receipt was read in full, it shows the buyer's own
   * transfer into the split contract, and it does not prove a sale of this
   * route: the buyer paid and (the answer not delivered) got nothing. The
   * gross is written as owed, once, on the operator wire (proven by that
   * transfer; no sale is booked), and the entry STAYS: in doubt, unproven,
   * for the operator and for the hold, never closed by itself.
   */
  async function oweUnproven(key, why) {
    const e = book.get(key);
    if (!e || e.unproven !== true || e.moved !== true || e.delivered === true || e.debtAt || kept.get(key)?.delivered === true) return false;
    const tx = txOf(e);
    if (!tx) return false;
    let gross;
    try { gross = Number(BigInt(e.amount)) / 1e6; } catch { return false; }
    let owedRow = false;
    try { owedRow = (await oweRefund({ slug: e.slug, network: REFERRAL_NETWORK, payer: e.payer, priceUsd: gross, tx, evidenceKey: referralRefundEvidence(tx, e.nonce), wire: "referral-operator", httpStatus: 402, hangupReason: null, note: `referral settle not proven as this route's sale: the buyer's transfer into the split contract is proven, no sale was booked: ${why}`.slice(0, 300) })) === true; }
    catch { owedRow = false; }
    if (!owedRow) { line("error", `a refund owed could NOT be recorded for an unproven settle (${e.slug} payer=${shortPayer(e.payer)} tx=${tx}); the next sweep tries again`); return false; }
    counters.refundsOwed++;
    dropKept(key);
    restDrop(key);
    await book.resolve(key, { debtAt: now() }).catch(() => {});
    line("error", `CHARGED-BUT-NOT-SERVED: a settle success that does not prove this route's sale moved the buyer's money (${e.slug} payer=${shortPayer(e.payer)} tx=${tx}: ${why}); a refund of the gross is recorded as owed; the entry stays open for an operator`);
    return true;
  }
  /** The transaction an entry names: the one that paid, else the one the sweep found spending its nonce. */
  const txOf = (e) => { const t = String(e?.tx || e?.seenTx || ""); return /^0x[0-9a-fA-F]{64}$/.test(t) ? t : null; };
  async function oweIfUndeliverable(snapshot, why) {
    const e = snapshot ? book.get(snapshot.key) : null;
    if (!e || e.state !== "charged-undelivered" || !/^0x[0-9a-fA-F]{64}$/.test(String(e.tx || ""))) return false;
    const mem = kept.get(e.key);
    if (e.delivered === true || mem?.delivered === true) { await closeEntry(e.key); return false; }
    if (settling.has(e.key)) return false;
    if (mem && now() < mem.expiresAt) return false;
    let rest = null;
    try { rest = await answers.get(e.key); } catch { return false; }
    if (rest) return false;
    return (await writeDebt(e, why)) === "owed";
  }
  /**
   * THE ONE WRITER of a refund debt, for the automatic path above and for an
   * operator's `refund` (resolveByHand). Behind the proof, read now; never
   * for an entry carrying the delivered mark; at the gross; once (the
   * ledger's own key, and the entry leaves the state it was read in). `e` is
   * the entry as the book has it. The proof may also be a receipt, read in
   * full, that shows this authorization's own
   * transfer of the amount into the split contract where the rule does not
   * recognize what the contract did next (an event of another shape, a
   * payout address that differs): proof that the BUYER PAID, which is what a
   * refund needs. It is not proof that this merchant was paid, so no sale is
   * booked for it, and the row is written on the wire `referral-operator`,
   * which the refund run proves by that same transfer
   * (src/payment-verify.js). A receipt routed to another merchant is never
   * refunded here: that sale was someone else's. Returns "owed", or why not: "unproven"
   * (no receipt readable, or a shape not recognized), "contradicted" (the
   * receipt does not prove a payment to this merchant: flagged for an
   * operator), "changed" (delivered or closed meanwhile), "failed" (the
   * ledger did not take the row).
   */
  async function writeDebt(e, why, { byHand = false } = {}) {
    const was = e.state;
    const tx = txOf(e);
    let proof = { verdict: "unknown", moved: false };
    try { proof = await proveWithDetail(tx, { from: e.payer, nonce: e.nonce, payTo: config.payTo, amount: e.amount, minNet: minNetOf(e.slug, e.amount), productId: productOf(e.slug) }); } catch { proof = { verdict: "unknown", moved: false }; }
    if (proof.verdict === "unpaid") {
      if (was !== "contradicted") {
        counters.settleContradicted++;
        line("error", `a charged entry's transaction does NOT prove a payment routed to this merchant (${e.slug} payer=${shortPayer(e.payer)} tx=${tx}); no refund recorded, kept as contradicted for an operator`);
        // A payment booked on a proof that no longer holds: no settle can be trusted.
        await book.resolve(e.key, { state: "contradicted", scope: "route", contradictedAt: now() }).catch(() => {});
      }
      // An operator, on an entry ALREADY kept as contradicted whose receipt
      // shows the buyer's own transfer into the contract (routed to another
      // merchant): the debt can be recorded, with the reason. Never by itself.
      if (!(byHand && was === "contradicted" && proof.moved === true)) return "contradicted";
    }
    const elsewhere = proof.verdict === "unpaid";
    const byTransfer = proof.verdict !== "paid";
    // Read in full, the buyer's own transfer into the contract shown, and not
    // a proof of this route's sale: the buyer paid, which is what a refund
    // needs (the automatic path and the operator alike).
    if (byTransfer && !elsewhere && !(proof.verdict === "unknown" && proof.moved === true)) return "unproven";
    // The entry again, after the awaits: delivered or closed meanwhile is no debt.
    const cur = book.get(e.key);
    if (!cur || cur.state !== was || cur.delivered === true || kept.get(e.key)?.delivered === true) return "changed";
    let gross;
    try { gross = Number(BigInt(e.amount)) / 1e6; } catch { return "failed"; }
    // The fields a direct route's hang-up debt carries, so the refund run's
    // repeat hang-up hold reads this row the same way. A partly served answer
    // carries the reason that run holds, and its byte counts in the note.
    const hangup = typeof cur.hangup === "string" && cur.hangup ? cur.hangup : null;
    const partial = cur.partial === true;
    const note = elsewhere ? `operator refund: the buyer's transfer into the split contract is proven; the network routed it to another merchant and it was not received here; no sale was booked: ${why}` : byTransfer ? `operator refund: the buyer's transfer into the split contract is proven, its routing is not recognized; no sale was booked: ${why}` : partial ? `referral answer partly sent (at most ${Number(cur.partialSent) || 0} of ${Number(cur.partialOf) || 0} bytes) before the connection closed, held for review: ${why}` : `referral answer not deliverable: ${why}`;
    let owedRow = false;
    try { owedRow = (await oweRefund({ slug: e.slug, network: REFERRAL_NETWORK, payer: e.payer, priceUsd: gross, tx, evidenceKey: referralRefundEvidence(tx, e.nonce), wire: byTransfer ? "referral-operator" : "referral", httpStatus: hangup || partial ? 499 : 402, hangupReason: partial ? REFERRAL_PARTIAL_HOLD_REASON : hangup, note: note.slice(0, 300) })) === true; }
    catch { owedRow = false; }
    if (!owedRow) { line("error", `a refund owed could NOT be recorded for a charged, undelivered call (${e.slug} payer=${shortPayer(e.payer)} tx=${tx}); kept in the book`); return "failed"; }
    counters.refundsOwed++;
    line("error", `CHARGED-BUT-NOT-SERVED: the answer can no longer be delivered (${why}; ${e.slug} payer=${shortPayer(e.payer)} tx=${tx}); a refund of the gross is recorded as owed`);
    dropKept(e.key);
    restDrop(e.key);
    // A small mark stays while the authorization could still be sent again,
    // so a re-send is told the payment is owed back and nothing runs twice;
    // the sweep removes it once the authorization has expired.
    await book.resolve(e.key, { state: "refund-owed", tx, refundAt: now() }).catch(() => {});
    return "owed";
  }

  // ---- our own faults ------------------------------------------------------------
  // The facilitator refusing THIS SERVER's signature (a 401, the documented
  // merchant-signature reason) or a request this server could not sign is
  // ours to fix; nothing a buyer sends counts here (src/referral-settle.js
  // `ownFault`). After `ownFaultMax` of them in a row a paid call is answered
  // 503 BEFORE the handler for `ownFaultCooldownMs` (the buyer gets the same
  // 503 either way; this only stops running tools that cannot be settled).
  // After the cool-down ONE call at a time probes: the others keep getting
  // the 503 until the probe ends. A request the facilitator accepts ends the
  // hold (verifyAccepted, and a /settle answered for the payment); another
  // refusal of our signature starts the cool-down again.
  const OWN_PROBE_MS = config.verifyMs + config.deadlineMs + config.settleMs + 5_000;
  const own = { streak: 0, blockedUntil: 0, lastAt: 0, probeUntil: 0, stage: null };
  const noteOwnFault = (stage) => { own.streak++; own.lastAt = now(); own.probeUntil = 0; own.stage = stage; if (own.streak >= config.ownFaultMax) own.blockedUntil = now() + config.ownFaultCooldownMs; };
  const clearOwnFault = () => { own.streak = 0; own.blockedUntil = 0; own.probeUntil = 0; own.stage = null; };
  // A verdict on a SIGNED /verify shows the signature is accepted there: it
  // ends a hold that /verify's own refusals started (a /settle refusal is
  // ended only by a /settle the facilitator answers for the payment).
  const verifyAccepted = () => { if (config.verifySigned && own.stage === "verify") clearOwnFault(); };
  /** Seconds a paid call must wait for the hold, or 0 when it may run (as the probe, when a hold is on). */
  const ownFaultWait = () => {
    if (own.streak < config.ownFaultMax) return 0;
    const t = now();
    if (t < own.blockedUntil) return Math.max(1, Math.ceil((own.blockedUntil - t) / 1000));
    if (t < own.probeUntil) return Math.max(1, Math.ceil(Math.min(own.probeUntil - t, config.ownFaultCooldownMs) / 1000));
    own.probeUntil = t + OWN_PROBE_MS;
    return 0;
  };
  // The facilitator not answering (a timeout, a 5xx, an intermediary's page):
  // since when without a break, and how many calls in that stretch.
  // Counted per endpoint: a /verify that answers says nothing of a /settle that does not.
  const reach = { verify: { since: 0, calls: 0 }, settle: { since: 0, calls: 0 }, intentFailedAt: 0, contradictedAt: 0 };
  const noteUnanswered = (stage) => { const r = reach[stage]; if (!r.since) r.since = now(); r.calls++; };
  const noteAnswered = (stage) => { reach[stage].since = 0; reach[stage].calls = 0; };

  /**
   * One word for /api/gateway-status: "attention" while any of these holds,
   * else "ok":
   *   - a book entry in doubt, charged and undelivered, unconfirmed or still
   *     an intent for more than 15 minutes;
   *   - a contradicted entry, or an unconfirmed one flagged because its
   *     receipt could not be read (both stay until resolved);
   *   - an open entry whose receipt the contract routed to this merchant and
   *     the proof rule does not accept (it stays until resolved);
   *   - the facilitator refused this server's own signature in the last 15
   *     minutes;
   *   - /verify or /settle unanswered by at least two calls in a row, the
   *     first of them 10 minutes ago or more (one failed call and then no
   *     traffic is not an outage);
   *   - an intent that could not be stored in the last 15 minutes;
   *   - the book is full;
   *   - an entry was retired at capacity, or closed because its receipt is
   *     not recognized, in the last day.
   * The reasons are operator-only.
   */
  function statusWord() {
    const t = now();
    const reasons = [];
    const all = book.list();
    const old = all.filter((e) => ["in-doubt", "charged-undelivered", "unconfirmed", "intent"].includes(e.state) && t - (e.at || 0) > 15 * 60_000);
    if (old.length) reasons.push(`${old.length} settlement(s) open past 15 minutes`);
    if (all.some((e) => e.state === "contradicted")) reasons.push("a settle the chain contradicted is open");
    if (all.some((e) => e.state === "unconfirmed" && e.flagged === true)) reasons.push("a settle success whose receipt cannot be read is open");
    { const n = failingPayers(t); if (n >= config.globalMax) reasons.push(`unsettled runs came from ${n} payers in the window: payers with no paid sale share ${newPayerSlots()} of ${config.maxInflight} run slots`); }
    if (all.some((e) => e.state === "in-doubt" && e.unproven === true)) reasons.push("a settle success whose receipt, read in full, does not prove the sale is open");
    for (const p of productStops()) reasons.push(`${p.slug}: product id differs: configured ${p.configured}, receipt ${p.received}; new calls on it are held`);
    // A slug held by this process's own count where the book holds no record of it (its write did not land).
    { const recorded = new Set(shortNow().map((r) => r.slug)); for (const [slug, seen] of rate.deep) if (seen.size && !recorded.has(slug) && slugHeld(slug)) reasons.push(`${slug}: ${seen.size} sale(s) under its stop floor were seen and could not be recorded in the book; new calls on it are held`); }
    if (routeHeld(book.faults())) reasons.push(`settle successes the chain contradicted came from ${REFERRAL_CONTRADICTED_PAYERS} or more payers: new payments are held, one at a time probes`);
    for (const r of shortNow()) reasons.push(`${r.slug}: the split contract paid less than the commission map expects (expected at least ${r.expectedNow}, received ${r.received}, of a gross of ${r.gross}; ${r.count} sale(s)${slugHeld(r.slug) ? "; new calls on it are held" : ""})`);
    if (all.some((e) => e.routedToUs === true && (e.state === "in-doubt" || e.state === "intent"))) reasons.push("a payment the split contract routed to this merchant, which the proof rule does not accept, is open");
    if (own.lastAt && t - own.lastAt < 15 * 60_000) reasons.push("the facilitator refused this server's own request");
    if ([reach.verify, reach.settle].some((r) => r.since && r.calls >= 2 && t - r.since >= 10 * 60_000)) reasons.push("the facilitator has not answered for 10 minutes");
    if (reach.intentFailedAt && t - reach.intentFailedAt < 15 * 60_000) reasons.push("an intent to settle could not be stored");
    if (book.full()) reasons.push("the settlement book is full");
    // An entry retired at capacity is an operator's to read: the word says so for a day.
    const gone = typeof book.retiredAtCapacity === "function" ? book.retiredAtCapacity() : [];
    if (gone.some((r) => t - (Number(r.at) || 0) < 24 * 3600_000)) reasons.push("a settlement was retired at capacity");
    // So is one closed because its receipt, read in full, is not a payment this route recognizes.
    const shut = typeof book.closedUnrecognized === "function" ? book.closedUnrecognized() : [];
    if (shut.some((r) => t - (Number(r.at) || 0) < 24 * 3600_000)) reasons.push("a settlement whose receipt is not recognized was closed to the operator record");
    // Not a reason: the slugs whose payments are not bound to a product id (the operator view lists them).
    return { status: reasons.length ? "attention" : "ok", reasons, noProductId: [...defs.keys()].filter((slug) => !productOf(slug)) };
  }

  /** The amount this request is quoted, in USDC base units (a decimal
   *  string): the direct route's own Base amount. A request whose input cannot
   *  be priced reads the route's list price, as the direct route's 402 does. */
  function amountFor(def, req) {
    let usd = 0;
    try { usd = Number(priceUsdOf(def, req)); } catch { usd = 0; }
    const text = priceFnOf(def) && Number.isFinite(usd) && usd > 0 ? usdText(usd) : def.price;
    const units = baseUnitsOf(priceForNetwork(text, REFERRAL_NETWORK)) ?? baseUnitsOf(priceForNetwork(def.price, REFERRAL_NETWORK));
    return units === null ? null : units.toString();
  }

  /** The one accept of this request's 402, and the requirement the facilitator is sent. */
  function requirementFor(def, amount) {
    return {
      scheme: "exact",
      network: REFERRAL_NETWORK,
      asset: REFERRAL_ASSET,
      amount,
      payTo: config.payTo,
      maxTimeoutSeconds: REFERRAL_MAX_TIMEOUT_SECONDS,
      extra: { name: USDC.name, version: USDC.version, authorizationType: "ReceiveWithAuthorization", facilitatorUrl: config.facilitatorUrl, endpoint: `/ref/${def.slug}` },
    };
  }

  function challengeFor(def, req, requirement) {
    // The attribution token is echoed exactly as sent (never re-encoded); one
    // past the bound is not echoed at all, since a cut token is another token.
    const token = headerText(req.headers["x-referrer-token"]);
    const agentId = headerText(req.headers["x-referrer-buyer-agent-id"]);
    return {
      x402Version: 2,
      resource: { url: `${origin}/ref/${def.slug}`, description: String(def.name || def.slug).slice(0, 200), mimeType: "application/json" },
      accepts: [requirement],
      extensions: {
        attributionToken: typeof token === "string" && token.length <= REFERRAL_TOKEN_MAX_CHARS && PRINTABLE_ASCII.test(token) ? token : "",
        ...(typeof agentId === "string" && agentId && agentId.length <= REFERRAL_AGENT_ID_MAX_CHARS ? { buyerAgentId: agentId } : {}),
        setup_url: config.setupUrl,
      },
      // A request with no input runs the tool's published example (below):
      // the 402 for it says so and shows that input, in a field of this
      // server's own beside the fields the network reads.
      ...(req.__a402ReferralExample === true && def.discovery?.input ? { emptyRequest: { note: "A request with no input runs this tool's published example, shown here as input, at the price quoted. Send your own input to run that instead.", input: def.discovery.input } } : {}),
    };
  }

  // The ready-to-run call a refusal carries is built for the direct route: it
  // is dropped here. Every other hint that would name a route is left out
  // where it is written (routeHint, src/referral-run.js), not rewritten.
  // A refusal's other fields (the expected-input descriptions, an example)
  // are written for the direct route too: any text in them that names this
  // server's host or one of its own paths is dropped, field by field, so a
  // referred buyer is never pointed at the catalog, the prices, the docs or a
  // direct route. The `error` sentence and the tool's slug are kept as written.
  const OWN_HOST_TEXT = (() => { try { return [new URL(origin).host.toLowerCase(), "agent402.tools"]; } catch { return ["agent402.tools"]; } })();
  const OWN_PATH = /(^|[^a-z0-9.])\/(api|v1)\/|\/openapi\.json|\/llms[a-z-]*\.txt|\/\.well-known\/x402|(^|[\s"'(])\/(docs|pricing|crawler|tools|catalog)\b/i;
  const pointsHome = (text) => { const t = String(text).toLowerCase(); return OWN_HOST_TEXT.some((h) => t.includes(h)) || OWN_PATH.test(t); };
  function withoutPointers(value, depth = 0) {
    if (typeof value === "string") return pointsHome(value) ? undefined : value;
    if (!value || typeof value !== "object" || depth > 6) return value;
    if (Array.isArray(value)) return value.map((v) => withoutPointers(v, depth + 1)).filter((v) => v !== undefined);
    const out = {};
    for (const [k, v] of Object.entries(value)) { const w = withoutPointers(v, depth + 1); if (w !== undefined) out[k] = w; }
    return out;
  }
  function scrub(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body;
    const copy = {};
    for (const [k, v] of Object.entries(body)) {
      if (k === "howToCall") continue;
      if (k === "error" || k === "tool" || k === "transaction") { copy[k] = v; continue; }
      const w = withoutPointers(v);
      if (w !== undefined) copy[k] = w;
    }
    return copy;
  }

  const refusePayment = (res, reason, { status = 402, retryable = false, retryAfter = null, message = null, extra = null } = {}) => {
    if (retryAfter) res.setHeader("Retry-After", String(retryAfter));
    const text = message || REFERRAL_REASONS[reason] || (status === 402 ? "The payment was not accepted. Nothing was charged." : null);
    return res.status(status).json({ success: false, errorReason: reason, ...(text ? { errorMessage: text } : {}), ...(retryable ? { retryable: true } : {}), ...(extra || {}) });
  };
  // What a buyer told "owed back" can check: the settlement transaction (on
  // chain already) and the free refund lookup for it (src/refund-lookup.js),
  // which lists every refund recorded under that transaction.
  const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
  const txFields = (key) => { const b = book.get(key); const t = String(b?.tx || b?.seenTx || kept.get(key)?.tx || "").toLowerCase(); return TX_HASH.test(t) ? t : null; };
  const owedBack = (res, reason, key) => { const t = txFields(key); return refusePayment(res, reason, { status: 409, extra: t ? { transaction: t, refundStatusUrl: `${origin}/api/refunds?tx=${t}` } : null }); };
  // A payment the network settled to another merchant (a success whose
  // receipt shows the buyer's transfer into the contract, routed elsewhere):
  // the transaction, or null when this payment is not one.
  const settledElsewhereTx = (key) => { const b = book.get(key); return b && b.state === "contradicted" && b.moved === true ? txFields(key) : null; };
  const unpaidAnswer = (res, key) => {
    const t = settledElsewhereTx(key);
    return t ? refusePayment(res, "settled_to_another_merchant", { status: 409, extra: { transaction: t } }) : refusePayment(res, "authorization_used_unpaid");
  };

  /** Book the sale for a settled authorization, once. Only ever called with
   *  the transaction that paid: the facilitator's own, or the one whose
   *  receipt proved the transfer. */
  function bookSale({ key, slug, amount, payer, tx, sha = null, req = null, net = null }) {
    if (!tx) return false;
    const entry = kept.get(key);
    // A sale already booked whose receipt is now in hand: the row is
    // corrected in place to the merchant amount the receipt shows (it was
    // booked at the computed net before the receipt could be read).
    const known = (() => { try { return net !== null && net !== undefined && BigInt(net) > 0n && BigInt(net) <= BigInt(amount); } catch { return false; } })();
    const correct = () => {
      if (!known) return;
      // The net is known now: raised (once per transaction) whatever the ledger write returns.
      noteShortSale(slug, amount, tx, net);
      Promise.resolve().then(() => amendSaleNet({ tx, netUsd: Number(BigInt(net)) / 1e6, payer, slug, grossUsd: Number(BigInt(amount)) / 1e6 })).then((changed) => {
        if (changed !== true) return;
        counters.netsCorrected++;
        line("warn", `a sale booked before its receipt could be read is corrected to the amount received (${slug} tx=${tx}: ${net} of ${amount})`);
      }).catch(() => {});
    };
    if (entry?.saleBooked) { correct(); return true; }
    if (book.get(key)?.saleBooked === true) { if (entry) entry.saleBooked = true; correct(); return true; }
    // The durable mark of THIS payment (it outlives the entry and the process).
    const marks = typeof book.soldMarks === "function" ? book.soldMarks() : {};
    if (marks[key]) { if (entry) entry.saleBooked = true; correct(); return true; }
    // The ledger's own word, for a sale recorded just before this process
    // lost its note of it. ONE PAYMENT, ONE ROW: a transaction can settle
    // several payments of one payer, so the rows the ledger holds for this
    // payer, slug and transaction are weighed against the OTHER payments
    // of that payer this gate has booked there; a row beyond those is this
    // payment's own.
    try {
      const seen = new Set();
      for (const [k, o] of kept) if (k !== key && o.saleBooked === true && o.charged === tx && o.payer === lc(payer) && o.slug === slug) seen.add(k);
      for (const o of book.list()) if (o.key !== key && o.saleBooked === true && o.tx === tx && o.payer === lc(payer) && o.slug === slug) seen.add(o.key);
      for (const k of Object.keys(marks)) if (k !== key && marks[k].tx === tx && marks[k].payer === lc(payer) && marks[k].slug === slug) seen.add(k);
      const others = seen.size;
      if (Number(saleBooked(tx, payer, slug)) > others) { if (entry) entry.saleBooked = true; correct(); return true; }
    } catch { /* booked below */ }
    const commissionBps = commissionBpsFor(config, slug);
    if (commissionBps === null) { line("error", `sale NOT booked: no commission is configured for ${slug} (tx=${tx})`); return false; }
    const money = referralNet(amount, { commissionBps, feeBps: config.feeBps });
    // The net is the merchant amount the receipt shows, when the proof is in
    // hand; the computed one only for a success booked before its receipt
    // can be read (unconfirmed).
    try { if (net !== null && net !== undefined && BigInt(net) > 0n && BigInt(net) <= money.grossUnits) money.netUsd = Number(BigInt(net)) / 1e6; } catch { /* the computed net stands */ }
    try {
      recordSale({
        slug, priceUsd: money.netUsd, quoteUsd: money.grossUsd, rail: "referral", wire: "referral", network: "base",
        payer, tx, synthetic: req ? !!isSynthetic(req) : false, responseSha256: sha, via: req ? salePathOf(req) : null,
      });
    } catch { return false; }
    if (entry) entry.saleBooked = true;
    if (typeof book.noteSold === "function") book.noteSold(key, { tx, payer, slug }).catch(() => {});
    if (known) noteShortSale(slug, amount, tx, net);
    return true;
  }

  /** The 200: the tool's answer with the settle transaction at the top level. */
  function bodyText(entry) {
    const tail = `"transaction":${JSON.stringify(entry.charged)}`;
    if (entry.wrap) return `{"result":${entry.text},${tail}}`;
    return entry.text === "{}" ? `{${tail}}` : `${entry.text.slice(0, -1)},${tail}}`;
  }
  /**
   * Send a proven-paid answer. The DELIVERED MARK is written to the book
   * before any byte goes out and is what every later reader checks first: an
   * entry that carries it is never read as undelivered (no refund is owed for
   * it), whatever happens to the closing write. With no mark stored the
   * answer is not sent (the buyer's re-send gets it).
   *
   * HOW MUCH WENT OUT. One `res.end` of the whole body reads as finished
   * whatever the buyer read (measured: an answer of 5 MB to a client that
   * read nothing and reset still ends with `writableFinished` true), so the
   * body goes out in REFERRAL_SEND_CHUNK_BYTES pieces (sendCounted), each
   * confirmed by its write callback. The bytes handed to the socket are the
   * most the buyer can have received (the kernel holds what it took:
   * measured, megabytes more than a client had read). When the connection
   * closes (sentOutcome):
   *   - every byte confirmed: delivered (the mark stands, the entry closes);
   *   - nothing handed to the socket: not served. The mark is taken back and
   *     the answer is kept for a re-send; if it is never delivered the gross
   *     is owed back;
   *   - anything between: PARTLY SERVED. The buyer may hold most of the
   *     answer, so the mark is taken back and the answer stays for a re-send,
   *     and the entry is marked partial: a refund debt for it carries the
   *     reason the refund run holds for review, never repaid on its own.
   */
  async function deliver(res, entry, { redelivery = false } = {}) {
    // No proof of payment, no delivery.
    if (!entry.landed || !entry.charged) return false;
    // ONE SEND IN FLIGHT per payment: a re-send that arrives while the answer
    // is still going out is told so, and holds no second copy of it.
    if (entry.sending === true) {
      counters.sendInflightRefused++;
      if (!res.headersSent && !res.destroyed) { res.setHeader("X-Payment-Replay", "inflight"); res.setHeader("Retry-After", "5"); res.status(409).json({ error: "This payment's answer is being sent on another connection. Send it again in a few seconds; nothing runs or is charged twice.", reason: "inflight" }); }
      return false;
    }
    const text = bodyText(entry);
    const openState = () => (entry.unconfirmed ? "unconfirmed" : "charged-undelivered");
    // An answer already delivered once is sent again from memory while it is
    // kept (the buyer's client may have lost it): nothing is open for it.
    const again = entry.delivered === true;
    const notServed = (why) => {
      if (again) return;
      counters.chargedNotServed++;
      // A hang-up, in the words the refund run reads: the reason no
      // forgiveness ticket was granted (a spent budget) when there is one.
      entry.hangup = entry.hangup || entry.goneReason || "settle in flight";
      line("error", `CHARGED-BUT-NOT-SERVED: ${why} (${entry.slug} payer=${shortPayer(entry.payer)} tx=${entry.charged}); the answer is kept for a re-send of the same payment`);
      // An unconfirmed payment stays unconfirmed: only its receipt makes it charged.
      book.resolve(entry.key, { state: openState(), delivered: false, sendingUntil: 0, hangup: entry.hangup, tx: entry.charged, saleBooked: entry.saleBooked === true, landedAt: now() }).catch(() => {});
    };
    const partlyServed = (sent, total) => {
      if (again) return;
      counters.partlyServed++;
      entry.partial = true;
      entry.partialSent = Math.max(Number(entry.partialSent) || 0, sent);
      entry.hangup = REFERRAL_PARTIAL_HOLD_REASON;
      line("error", `PARTLY SERVED: the connection closed after at most ${sent} of ${total} bytes of the answer went out (${entry.slug} payer=${shortPayer(entry.payer)} tx=${entry.charged}); the answer is kept for a re-send, and a refund for it is held for review`);
      book.resolve(entry.key, { state: openState(), delivered: false, sendingUntil: 0, partial: true, partialSent: entry.partialSent, partialOf: total, hangup: entry.hangup, tx: entry.charged, saleBooked: entry.saleBooked === true, landedAt: now() }).catch(() => {});
    };
    if (res.destroyed || res.writableEnded) { notServed("the buyer's connection closed before the answer could be sent"); return false; }
    let marked = again;
    // The mark says until when this send may still be going out (its own
    // bound plus a margin, stamped with the mark itself): no sweep closes
    // the entry before then.
    if (!again) { try { marked = (await book.resolve(entry.key, { state: openState(), delivered: true, deliveredAt: now(), sendingUntil: now() + config.sendMaxMs + 5_000, tx: entry.charged, saleBooked: entry.saleBooked === true })) === true; } catch { marked = false; } }
    if (!marked) {
      counters.deliveryMarkFailed++;
      line("error", `the delivered mark could not be stored (${entry.slug} payer=${shortPayer(entry.payer)} tx=${entry.charged}); the answer is NOT sent and is kept for a re-send`);
      if (!res.headersSent && !res.destroyed) refusePayment(res, "delivery_store_unavailable", { status: 503, retryable: true, retryAfter: 15 });
      return false;
    }
    if (res.destroyed || res.writableEnded) { notServed("the buyer's connection closed before the answer could be sent"); return false; }
    // The one send in flight for this payment starts here (the settle slot keeps two from getting this far at once).
    entry.sending = true;
    const body = Buffer.from(text, "utf8");
    let sent = { total: body.length, dispatched: 0, taken: 0, ended: null };
    res.once("close", () => {
      entry.sending = false;
      if (sent.ended) { counters.sendsEndedIdle++; line("error", `an answer's send was ended at its ${sent.ended === "idle" ? "no-progress" : "longest-send"} bound (${entry.slug} payer=${shortPayer(entry.payer)}, ${sent.taken} of ${sent.total} bytes confirmed)`); }
      const { how, atMost } = sentOutcome(sent);
      if (how === "partial") { partlyServed(atMost, sent.total); return; }
      if (how === "not-served") { notServed("the connection closed before any byte of the answer went out"); return; }
      // Delivered: nothing at rest, and nothing left open for this
      // authorization, except an unconfirmed payment, which keeps its entry
      // (with the delivered mark) until the sweep confirms it.
      if (again) return;
      entry.delivered = true;
      restDrop(entry.key);
      if (!entry.unconfirmed) closeEntry(entry.key).catch(() => {});
      else book.resolve(entry.key, { sendingUntil: 0 }).catch(() => {});
    });
    try {
      res.status(200);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Length", String(body.length));
      sent = sendCounted(res, body, { idleMs: config.sendIdleMs, maxMs: config.sendMaxMs });
      if (redelivery) counters.redelivered++;
      return true;
    } catch (err) { entry.sending = false; notServed(`the answer could not be written: ${referralLogText(err?.message, 120)}`); return false; }
  }

  /** The payment is proven: book it, keep the case until delivered, take back its lane note. */
  async function markPaid(entry, tx, req, { sha = null, unconfirmed = false, net = null } = {}) {
    if (!unconfirmed) routeHealed();
    entry.charged = tx;
    entry.landed = true;
    entry.unpaid = false;
    entry.unconfirmed = unconfirmed;
    bookSale({ key: entry.key, slug: entry.slug, amount: entry.amount, payer: entry.payer, tx, sha: sha || createHash("sha256").update(bodyText(entry), "utf8").digest("hex"), req, net });
    await book.resolve(entry.key, { state: unconfirmed ? "unconfirmed" : "charged-undelivered", tx, saleBooked: entry.saleBooked === true, landedAt: now(), ...(entry.hangup ? { hangup: entry.hangup } : {}) }).catch(() => {});
    laneClear(entry.laneKeys || [], entry.key);
    laneOk(entry.laneKeys || []);
    try { if (req) onSettledSale(req); } catch { /* a convenience, never a reason to fail */ }
  }

  /**
   * Read the chain for a kept answer and act on its one-word verdict
   * (chainVerdict, src/referral-chain.js). Returns "charged" (the receipt
   * proves the payment), "unpaid" (the nonce was spent without paying us:
   * never delivered, never booked), "expired-unused", "unused" or "unknown".
   */
  async function readChain(entry, req, { wait = false, why = "re-send" } = {}) {
    let c;
    try { c = await chain.state({ from: entry.payer, nonce: entry.auth.nonce, payTo: config.payTo, amount: entry.amount, fromBlock: entry.fromBlock ?? book.get(entry.key)?.fromBlock ?? null, minNet: minNetOf(entry.slug, entry.amount), productId: productOf(entry.slug) }, { wait }); }
    catch { c = { used: null, paid: null, transaction: null, complete: false }; }
    const verdict = chainVerdict(c, { validBeforeMs: entry.validBeforeMs, nowMs: now(), slackMs: 30_000 });
    if (verdict === "paid") {
      await markPaid(entry, c.transaction, req, { net: c.net ?? null });
      counters.landedAfterDoubt++;
      line("error", `SETTLE-IN-DOUBT resolved by the chain: the payment landed (${entry.slug} payer=${shortPayer(entry.payer)} tx=${c.transaction}; ${why})`);
      return "charged";
    }
    if (verdict === "unpaid") {
      // Spent without paying this route (a cancel, a transfer elsewhere, a
      // short or reverted transaction): no delivery, no sale, and it counts
      // as an unsettled run in the payer's lane.
      entry.unpaid = true;
      entry.inDoubt = false;
      counters.usedUnpaid++;
      laneClear(entry.laneKeys || [], entry.key);
      laneNote(entry.laneKeys || [], null);
      restDrop(entry.key);
      // A contradicted success keeps its entry for an operator, whatever the chain says after.
      if (!entry.contradicted) await closeEntry(entry.key);
      line("error", `authorization spent on chain WITHOUT paying this merchant (${entry.slug} payer=${shortPayer(entry.payer)} tx=${c.transaction || "none of ours"}; ${why}) - nothing delivered, nothing booked`);
      return "unpaid";
    }
    entry.chainUnused = verdict === "unused" || verdict === "expired-unused";
    if (verdict === "expired-unused") return "expired-unused";
    if (entry.inDoubt && !entry.contradicted) {
      await book.resolve(entry.key, { state: "in-doubt", reason: entry.lastReason || null }).catch(() => {});
      line("error", `SETTLE-IN-DOUBT (${entry.slug} payer=${shortPayer(entry.payer)} ${why}; chain reads ${verdict === "unused" ? "unused so far" : "no proof yet"}) - answer kept, authorization held, buyer answered 402`);
    }
    return verdict;
  }

  // Refusals that say the authorization is already spent: the chain decides what that means.
  const USED_STYLE = /(^|_)(used|nonce|replay|replayed|duplicate)(_|$)/;

  /**
   * Ask the facilitator to settle a kept answer's payment and read the
   * outcome to its end. Returns "charged", "refused" (definite, nothing
   * moved; entry.lastReason, entry.lastSide), "unpaid", "expired-unused",
   * "unknown", or "no-intent" (the durable intent could not be written, so
   * nothing was sent). The caller holds the authorization's settle slot.
   */
  async function settleEntry(entry, req) {
    // No durable intent, no settle: a payment that moved with no record of
    // the attempt is the one case nothing could ever reconcile.
    let stored = false;
    // `fromBlock` is the chain head read BEFORE the payment was verified
    // (serve): the proof of this payment is looked for from there.
    try { stored = (await book.intent({ key: entry.key, slug: entry.slug, payer: entry.payer, nonce: entry.auth.nonce, amount: entry.amount, validBefore: Math.floor(entry.validBeforeMs / 1000), fromBlock: entry.fromBlock })) === true; }
    catch { stored = false; }
    if (!stored) {
      counters.intentFailed++;
      reach.intentFailedAt = now();
      line("error", `the intent to settle could not be stored (${entry.slug} payer=${shortPayer(entry.payer)}${book.full() ? ", the book is full" : ""}); /settle NOT called, nothing charged, answer kept`);
      return "no-intent";
    }
    // The answer at rest, apart from the book, while it may be owed (a restart
    // must not leave a charged buyer without it): bounded per answer and in all.
    if (!atRest.has(entry.key)) {
      restPrune();
      if (entry.bytes <= REFERRAL_PERSISTED_ANSWER_MAX_BYTES && atRestBytes + entry.bytes <= REFERRAL_PERSISTED_BYTES_MAX) {
        try {
          if (await answers.put(entry.key, { text: entry.text, wrap: entry.wrap, digest: entry.digest, slug: entry.slug, payment: entry.payment, requirement: entry.requirement, expiresAt: entry.expiresAt })) {
            atRest.set(entry.key, { bytes: entry.bytes, expiresAt: entry.expiresAt });
            atRestBytes += entry.bytes;
          }
        } catch { /* kept in memory only */ }
      }
      if (!atRest.has(entry.key)) line("warn", `an answer of ${entry.bytes} bytes is kept in memory only (${entry.slug}); if it cannot be delivered, the payment is owed back`);
    }
    entry.settleAttempts++;
    const d = draining();
    // During a drain the call ends inside what the drain has left; the intent
    // above stands for it if the process stops first.
    const timeoutMs = d.active ? Math.max(2_000, Math.min(config.settleMs, d.leftMs - 5_000)) : config.settleMs;
    let s;
    try { s = await settler.settle(entry.payment, entry.requirement, { timeoutMs }); }
    catch { s = { ok: false, inDoubt: true, reason: "settle_error", status: 0, retryable: false }; }
    if (!s) s = { ok: false, inDoubt: true, reason: "settle_error", status: 0 };
    if (s.ok || !s.inDoubt) noteAnswered("settle"); else if (s.status === 0 || s.status >= 500 || !s.status) noteUnanswered("settle");
    // A settle that names another payer than the one who signed is not an answer about this payment.
    if (s.ok && s.payer && s.payer !== entry.payer) { line("error", `settle answered for another payer than the signer (${entry.slug} payer=${shortPayer(entry.payer)}); reading the chain`); s = { ok: false, inDoubt: true, reason: "settle_payer_mismatch", status: s.status }; }
    if (s.ok) {
      // The facilitator's word is checked against the chain before anything is
      // delivered or booked: the receipt of the transaction it names must show
      // THIS authorization's own transfer, routed to this merchant
      // (receiptProvesPayment). The read is retried for a few seconds.
      // THREE READINGS of that receipt:
      //   proven       delivered and booked;
      //   not readable no receipt yet: delivered and booked as unconfirmed
      //                while few such are open (below), the sweep confirms it;
      //   READ IN FULL and it does not prove THIS sale: never delivered,
      //                never booked. It names another product (a verdict of
      //                its own: the slug stops, the buyer is owed back), or
      //                it is contradicted (unpaid), or it is a shape the rule
      //                does not accept (held in doubt for the operator).
      let proof = "unknown", provenNet = null, moved = false, detail = { read: false, why: null, product: null, routedToUs: false };
      try { const d = await proveWithDetail(s.transaction, { from: entry.payer, nonce: entry.auth.nonce, payTo: config.payTo, amount: entry.amount, minNet: minNetOf(entry.slug, entry.amount), productId: productOf(entry.slug) }, { waitMs: config.receiptWaitMs }); proof = d.verdict; provenNet = d.net; moved = d.moved === true; detail = d; }
      catch { proof = "unknown"; }
      if (proof === "unpaid") {
        // Contradicted: nothing delivered, nothing booked, and the entry is
        // KEPT as contradicted (with the transaction named) until an operator
        // resolves it, whatever the chain says of the authorization after.
        counters.settleContradicted++;
        reach.contradictedAt = now();
        line("error", `the facilitator answered success, but the chain CONTRADICTS it (${entry.slug} payer=${shortPayer(entry.payer)} tx=${s.transaction}): nothing delivered, nothing booked; kept as contradicted`);
        entry.inDoubt = true;
        entry.everInDoubt = true;
        entry.contradicted = true;
        laneNote(entry.laneKeys || [], entry.key);
        // Whom it holds (bookFault): this payer only. An authorization does
        // not name a merchant, so a payment can be made to produce this.
        // `moved`: the buyer's own transfer reached the split contract in that
        // transaction. Such entries from several payers hold the route (manyContradicted).
        await book.resolve(entry.key, { state: "contradicted", scope: "payer", moved, tx: s.transaction, contradictedAt: now() }).catch(() => {});
        const after = await readChain(entry, req, { wait: false, why: "settle success contradicted" });
        if (after === "charged") await book.resolve(entry.key, { contradictedTx: s.transaction }).catch(() => {});
        return after;
      }
      clearOwnFault();
      if (proof === "unknown" && detail.read === true) {
        const tx = String(s.transaction).toLowerCase();
        entry.inDoubt = true;
        entry.everInDoubt = true;
        if (detail.product) {
          // ANOTHER PRODUCT. The slug stops now; this buyer's transfer is on
          // chain and reached our merchant, so the gross is owed back (the
          // refund run proves that receipt without the product binding).
          noteProductMismatch(entry.slug, entry.amount, tx, detail.product);
          entry.lastReason = "settled_for_another_product";
          let owedRow = false;
          try { owedRow = (await oweRefund({ slug: entry.slug, network: REFERRAL_NETWORK, payer: entry.payer, priceUsd: Number(BigInt(entry.amount)) / 1e6, tx, evidenceKey: referralRefundEvidence(tx, entry.auth.nonce), wire: "referral", httpStatus: 402, hangupReason: null, note: `referral payment settled for another product: product id differs: configured ${detail.product.configured}, receipt ${detail.product.received}`.slice(0, 300) })) === true; } catch { owedRow = false; }
          if (owedRow) {
            counters.refundsOwed++;
            dropKept(entry.key);
            restDrop(entry.key);
            await book.resolve(entry.key, { state: "refund-owed", tx, refundAt: now(), why: detail.why }).catch(() => {});
            return "refund-owed";
          }
          line("error", `a refund owed could NOT be recorded for a payment settled for another product (${entry.slug} payer=${shortPayer(entry.payer)} tx=${tx}); kept in the book`);
        }
        // Read in full, and not a proof of this sale: held for the operator.
        counters.settleUnproven++;
        entry.unprovenSettle = true;
        entry.lastReason = entry.lastReason || "receipt_not_this_sale";
        await book.resolve(entry.key, { state: "in-doubt", reason: "receipt_not_this_sale", unproven: true, unprovenAt: now(), moved, seenTx: tx, why: String(detail.why || "").slice(0, 160), ...(detail.routedToUs ? { routedToUs: true } : {}) }).catch(() => {});
        line("error", `SETTLE UNPROVEN: the facilitator answered success and its receipt, read in full, does not prove this sale (${entry.slug} payer=${shortPayer(entry.payer)} tx=${tx}: ${detail.why}): nothing delivered, nothing booked; held for an operator`);
        // The buyer's money moved and no answer goes out: owed back now.
        if (moved && (await oweUnproven(entry.key, String(detail.why || "")))) { entry.lastReason = "settlement_unproven_refund_owed"; return "refund-owed"; }
        return "unknown";
      }
      if (proof !== "paid") {
        // The receipt is not readable yet. A
        // few such answers may be delivered and stay open as unconfirmed;
        // past that the answer is held as in doubt, and the buyer's re-send
        // gets it once the receipt proves the payment.
        const open = book.counts().unconfirmed || 0;
        if (open >= config.unconfirmedMax) {
          counters.unconfirmedHeld++;
          entry.inDoubt = true;
          entry.everInDoubt = true;
          entry.lastReason = "receipt_unreadable";
          laneNote(entry.laneKeys || [], entry.key);
          await book.resolve(entry.key, { state: "in-doubt", reason: "receipt_unreadable", claimedTx: s.transaction }).catch(() => {});
          line("error", `SETTLE-IN-DOUBT: the facilitator answered success, its receipt is not readable, and ${open} unconfirmed settlement(s) are already open (${entry.slug} payer=${shortPayer(entry.payer)} tx=${s.transaction}): answer held, not booked, until the receipt proves it`);
          return "unknown";
        }
      }
      await markPaid(entry, s.transaction, req, { unconfirmed: proof !== "paid", net: proof === "paid" ? provenNet : null });
      counters.settled++;
      if (proof !== "paid") counters.unconfirmed++;
      line("log", `settled ${entry.slug} payer=${shortPayer(entry.payer)} tx=${s.transaction}${proof !== "paid" ? " (receipt not readable yet: delivered, the sweep confirms it)" : ""}`);
      return "charged";
    }
    entry.lastReason = s.reason || "settle_failed";
    entry.lastSide = s.side || null;
    entry.lastRetryable = s.retryable === true;
    const usedStyle = USED_STYLE.test(entry.lastReason);
    if (!s.inDoubt && !entry.everInDoubt && !usedStyle) {
      // A definite refusal of a payment that was never in doubt. The refusal
      // is the facilitator's word; the entry closes on ONE chain read that
      // shows the authorization unused. A read that shows it used is acted on
      // as any other, and while the chain cannot be read the entry stays, in
      // doubt, for the sweep: it closes once the authorization can no longer
      // be sent, and a payment that lands late is found and owed back.
      entry.inDoubt = false;
      const seen = await readChain(entry, req, { wait: false, why: `settle refused (${entry.lastReason})` });
      if (seen === "charged" || seen === "unpaid") return seen;
      if (seen === "unused" || seen === "expired-unused") await closeEntry(entry.key);
      else {
        counters.refusedUnread++;
        entry.inDoubt = true;
        entry.everInDoubt = true;
        entry.refusedUnread = true;
        laneNote(entry.laneKeys || [], entry.key);
        await book.resolve(entry.key, { state: "in-doubt", reason: entry.lastReason || null }).catch(() => {});
        line("error", `settle refused and the chain could not be read (${entry.slug} payer=${shortPayer(entry.payer)} reason=${entry.lastReason}): the entry stays open, in doubt, until the chain shows the authorization unused and expired, or used`);
      }
      if (entry.lastSide === "ours") {
        // Only a refusal of our signature counts toward the hold.
        if (s.ownFault === true) noteOwnFault("settle");
        counters.signerRefused++;
        faultLog.line(`the facilitator refused THIS SERVER's request at /settle (${entry.slug} reason=${entry.lastReason} status=${s.status}): check REFERRAL_SIGNER_KEY and the signer's role; not charged, answer kept, buyer answered 503`);
      } else {
        clearOwnFault();
        // (Kept while the entry is open: a payment that lands late can still be answered.)
        if (!entry.refusedUnread) restDrop(entry.key);
        counters.settleRefused++;
        line("warn", `settle refused after a successful handler (${entry.slug} payer=${shortPayer(entry.payer)} reason=${entry.lastReason} status=${s.status}) - not charged, authorization held`);
      }
      return "refused";
    }
    // In doubt now, in doubt before, or refused as already spent: the chain
    // says what happened. An entry that was ever in doubt stays in the book
    // until the chain proves it paid, spent elsewhere, or expired unused.
    if (s.inDoubt) counters.settleInDoubt++;
    entry.inDoubt = true;
    entry.everInDoubt = true;
    laneNote(entry.laneKeys || [], entry.key);
    return readChain(entry, req, { wait: s.inDoubt, why: `${entry.lastReason} status=${s.status}` });
  }

  /** The answer for an outcome that is not "charged". */
  function refuseOutcome(res, entry, outcome) {
    if (res.headersSent || res.destroyed) return undefined;
    if (outcome === "unpaid") return unpaidAnswer(res, entry.key);
    if (outcome === "expired-unused") return refusePayment(res, "authorization_expired_unused");
    if (outcome === "no-intent") return refusePayment(res, "settlement_store_unavailable", { status: 503, retryable: true, retryAfter: 30 });
    if (outcome === "refund-owed") return owedBack(res, ["settled_for_another_product", "settlement_unproven_refund_owed"].includes(entry.lastReason) ? entry.lastReason : "answer_unavailable_refund_owed", entry.key);
    // A refusal of OUR request (the signer, a lookup the facilitator could not make) is this server's to fix.
    if (outcome === "refused" && entry.lastSide === "ours") return refusePayment(res, "settlement_unavailable", { status: 503, retryable: true, retryAfter: 60 });
    if (outcome === "refused") return refusePayment(res, entry.lastReason || "settle_refused", { retryable: entry.lastRetryable, message: REFERRAL_REASONS[entry.lastReason] || REFERRAL_REASONS.settle_refused });
    if (entry.everInDoubt) return refusePayment(res, "settle_outcome_unknown", { retryable: true });
    return refusePayment(res, entry.lastReason || "settle_refused", { retryable: entry.lastRetryable, message: REFERRAL_REASONS[entry.lastReason] || REFERRAL_REASONS.settle_refused });
  }

  /** A re-send of a payment whose answer is kept: never a second run. */
  async function resend(req, res, entry) {
    counters.resent++;
    if (settling.has(entry.key)) { res.setHeader("X-Payment-Replay", "inflight"); res.setHeader("Retry-After", "5"); return res.status(409).json({ error: "This payment is being settled by another request. Send it again in a few seconds; nothing runs or is charged twice.", reason: "inflight" }); }
    if (entry.unpaid) return unpaidAnswer(res, entry.key);
    settling.add(entry.key);
    try {
      let outcome = entry.landed ? "charged" : await readChain(entry, req, { why: "re-send" });
      if (outcome === "expired-unused") {
        // Expired without being used: nothing was charged, and nothing can be.
        dropKept(entry.key);
        restDrop(entry.key);
        if (!entry.contradicted) await closeEntry(entry.key);
      } else if (outcome === "unused" && !entry.contradicted && now() < entry.validBeforeMs - 2_000 && entry.settleAttempts <= REFERRAL_RESEND_SETTLES_MAX) {
        outcome = await settleEntry(entry, req);
      }
      if (outcome === "charged") { await deliver(res, entry, { redelivery: true }); return undefined; }
      return refuseOutcome(res, entry, outcome);
    } finally { settling.delete(entry.key); }
  }

  // Every step that can write an answer runs as a referral run, so no hint in
  // it names a route of this server (src/referral-run.js).
  const handler = (req, res) => runAsReferral(() => serve(req, res));

  async function serve(req, res) {
    res.set("X-Robots-Tag", "noindex, nofollow").set("Cache-Control", "no-store");
    const slug = referralSlugOfPath(req.path);
    const def = slug ? defs.get(slug) : null;
    // Only the canonical spelling is served: any other reaches no limiter
    // mounted on the path, so it gets no price and no run.
    if (!def || !isCanonicalReferralPath(req.path, slug)) return res.status(404).json({ error: "Not found" });
    // PAYMENT-SIGNATURE is the only payment evidence this route reads.
    delete req.headers["x-payment"];

    let input = null;
    try {
      input = handlerInputOf(req, def);
      // An EMPTY request (no body or `{}`, and no query) runs the tool's
      // published example: the standard buyer flow probes and pays with no
      // input, and the one paid call it makes has to show the product. The
      // unpaid 402 then quotes that example, and the paid call runs exactly
      // it. ONLY a truly empty request takes it: no query, and no body at all
      // or a JSON body that is exactly {}. Any other body (text, a form, a
      // JSON array, a body this route does not parse) is the buyer's own
      // request and is served as the direct route serves it.
      const example = def.discovery?.input;
      if (isEmptyRequest(req) && input && typeof input === "object" && Object.keys(input).length === 0 && example && typeof example === "object" && !Array.isArray(example) && Object.keys(example).length > 0) {
        req.__handlerInput = structuredClone(example);
        input = handlerInputOf(req, def);
        req.__a402ReferralExample = true;
      }
      // A chat body is always answered as one JSON object here (the answer has
      // to carry the settlement's transaction), so streaming is turned off
      // BEFORE the request is priced: the quote and the run read one input.
      if (def.category === "llm" && input && typeof input === "object") {
        if ("stream" in input) input.stream = false;
        delete input.stream_options;
      }
    } catch { input = null; }
    const hasInput = !!input && typeof input === "object" && Object.keys(input).length > 0;
    if (warmQuote && input) { try { await warmQuote(def, req); } catch { /* priced in place */ } }

    const amount = amountFor(def, req);
    if (amount === null) return res.status(404).json({ error: "Not found" });
    const requirement = requirementFor(def, amount);

    const raw = headerText(req.headers["payment-signature"]);
    if (typeof raw !== "string" || !raw) {
      // A header that did not decode was removed at intake.
      if (req.__droppedPaymentAttempt === true) { counters.refused++; credentialLimiter?.note(req); return refusePayment(res, "invalid_request"); }
      // A body the direct route refuses before any payment is refused here
      // the same way; a probe with no input reads the example's price.
      if (hasInput) {
        let bad = null;
        try { bad = prePaymentRefusal(def, input); } catch { bad = null; }
        if (bad && Number(bad.status) >= 400) { counters.refused++; return res.status(Number(bad.status)).json(scrub(bad.body)); }
      }
      counters.challenges++;
      return res.status(402).json(challengeFor(def, req, requirement));
    }
    // A payment is taken on GET and POST only (a HEAD answer has no body to deliver).
    if (req.method !== "GET" && req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "A paid call is a GET or a POST. Nothing was charged.", tool: def.slug }); }
    if (credentialLimiter?.limited(req)) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({ error: "Too many refused payment credentials from this address; send a payment that verifies, or slow down. Nothing was charged.", retryAfterSeconds: 60 });
    }
    const refuseCredential = (reason) => { counters.refused++; credentialLimiter?.note(req); return refusePayment(res, reason); };

    const payment = decodePaymentHeader(raw);
    if (!payment) return refuseCredential("invalid_request");
    const checked = checkReferralPayment(payment, requirement, { nowMs: now(), needMs, maxValidityMs: config.maxValidityMs });
    if (checked.reason) return refuseCredential(checked.reason);
    const { auth, signature, validBeforeMs, timeReason } = checked;
    const payer = lc(auth.from);
    // The payer's own signature, checked here before any call leaves this
    // server: a forged one costs nothing outbound. A signature that is not an
    // ECDSA one by `from` (a contract wallet's) is not taken on this route.
    if (!(await isLocalReceiveSignature(auth, signature))) { counters.signatureRefused++; return refuseCredential("invalid_exact_evm_payload_signature"); }

    const key = referralReplayKey(auth);
    const digest = createHash("sha256").update(`${signature.toLowerCase()}\n${lc(auth.to)}\n${auth.value}\n${auth.validAfter}\n${auth.validBefore}`).digest("hex");
    // A payment whose answer is kept: the re-send path, never a second run.
    // An answer past its retention is gone, whether or not a prune has run yet.
    if (kept.has(key) && now() >= kept.get(key).expiresAt) dropKept(key);
    const held = kept.get(key);
    if (held) {
      if (held.digest !== digest || held.slug !== def.slug) { counters.replays++; res.setHeader("X-Payment-Replay", "consumed"); return res.status(409).json({ error: "Payment authorization already used. Each payment authorization (nonce) is single-use - sign a fresh authorization to make another paid call.", reason: "consumed" }); }
      return resend(req, res, held);
    }
    // An authorization the book still holds open with no answer here (the
    // process that ran it is gone, or its answer was dropped): it bought its
    // run, and it runs no second.
    const open = book.get(key);
    let stored = null;
    if (open) { try { stored = await answers.get(key); } catch { stored = null; } }
    if (open && open.delivered !== true && stored && stored.digest === digest && stored.slug === def.slug && typeof stored.text === "string") {
      // The answer was stored at rest for the open entry (this process
      // restarted, or dropped it from memory): restored, and served by the
      // re-send path.
      const charged = (open.state === "charged-undelivered" || open.state === "unconfirmed") && typeof open.tx === "string" && open.tx ? open.tx : null;
      const restored = { key, digest, slug: def.slug, text: stored.text, wrap: stored.wrap === true, bytes: Buffer.byteLength(stored.text), amount: String(open.amount), requirement: stored.requirement, payment: stored.payment, auth, payer, validBeforeMs: (Number(open.validBefore) || 0) * 1000, fromBlock: open.fromBlock ?? null, hangup: open.hangup || null, contradicted: open.state === "contradicted", laneKeys: laneKeysOf(req, payer), charged, landed: !!charged, unconfirmed: open.state === "unconfirmed", unpaid: false, saleBooked: open.saleBooked === true, delivered: false, settleAttempts: Number(open.attempts) || 1, lastReason: open.reason || null, lastSide: null, lastRetryable: false, chainUnused: false, inDoubt: !charged, everInDoubt: true, at: now(), expiresAt: Number(stored.expiresAt) };
      keep(restored);
      counters.restoredAnswers++;
      return resend(req, res, restored);
    }
    // An entry that carries the delivered mark was served: it buys nothing
    // more, and nothing is owed for it, whatever state it still shows.
    if (open && open.delivered === true) {
      counters.alreadyDelivered++;
      res.setHeader("X-Payment-Replay", "consumed");
      return refusePayment(res, "answer_already_delivered", { status: 409 });
    }
    if (open && (open.state === "in-doubt" || open.state === "intent" || open.state === "unconfirmed")) {
      // The answer is gone: whether the buyer was charged is the chain's to say.
      let c = null;
      try { c = await chain.state({ from: open.payer, nonce: open.nonce, payTo: config.payTo, amount: open.amount, fromBlock: open.fromBlock ?? null, minNet: minNetOf(open.slug, open.amount), productId: productOf(open.slug) }); } catch { c = null; }
      const fresh = book.get(key);
      if (fresh && fresh.delivered !== true && fresh.state === open.state && chainVerdict(c, { validBeforeMs: (Number(open.validBefore) || 0) * 1000, nowMs: now() }) === "paid") {
        const booked = bookSale({ key, slug: open.slug, amount: open.amount, payer: open.payer, tx: c.transaction, net: c.net ?? null });
        await book.resolve(key, { state: "charged-undelivered", tx: c.transaction, saleBooked: booked === true, landedAt: now() }).catch(() => {});
      }
    }
    const openNow = open ? book.get(key) || open : null;
    if (openNow) {
      counters.replays++;
      // A charged buyer whose answer is gone: the payment is owed back now.
      if (openNow.state === "charged-undelivered") await oweIfUndeliverable(openNow, "its answer is no longer held");
      if (book.get(key)?.state === "refund-owed" || book.get(key)?.debtAt) return owedBack(res, "answer_unavailable_refund_owed", key);
      if (settledElsewhereTx(key)) return unpaidAnswer(res, key);
      res.setHeader("X-Payment-Replay", "consumed");
      // Charged (the chain proved it) with the debt not yet written, or not known to be charged.
      const chargedNow = book.get(key)?.state === "charged-undelivered";
      return res.status(409).json({ error: chargedNow ? REFERRAL_REASONS.answer_unavailable_charged : REFERRAL_REASONS.answer_unavailable, reason: "answer_unavailable", charged: chargedNow ? true : null });
    }
    // The clock: valid now, for the whole run and its settlement, and not too far ahead.
    if (timeReason) return refuseCredential(timeReason);
    // An open entry that says this server's own bookkeeping is wrong: a new
    // payment is refused here, before anything is claimed, sent or run.
    // One pass over the book's faults for this request.
    const faultsNow = book.faults();
    const routeHeldNow = !!routeHeld(faultsNow);
    if (bookFault(payer, faultsNow) || (routeHeldNow && routeGate(payer, false, faultsNow) === "hold")) {
      counters.bookFaultHeld++;
      return refusePayment(res, "settlement_under_review", { status: 503, retryable: true, retryAfter: routeHeldNow ? 30 : 300 });
    }
    // A slug whose sales arrive under its stop floor: no new call on it. And
    // until a slug's rate has proven, only its bound of calls is in flight.
    if (slugHeld(def.slug) || rateGate(def.slug, false, payer) === "hold") {
      counters.shortNetHeld++;
      return refusePayment(res, "rate_under_review", { status: 503, retryable: true, retryAfter: slugHeld(def.slug) ? 300 : 5 });
    }

    // The payer screen the direct route runs before serving.
    // A screen that cannot answer refuses (fails closed): nothing runs.
    let screened = false;
    try { screened = await payerScreen(req, res); }
    catch {
      counters.screenErrors++;
      line("error", `the payer screen could not answer (${def.slug}); refused, nothing ran`);
      return refusePayment(res, "payer_screen_unavailable", { status: 503, retryable: true, retryAfter: 30 });
    }
    if (!screened) { counters.screened++; return undefined; }
    // A book that cannot take one more settlement FOR THIS PAYER (its own
    // share spent, or the book at capacity with nothing to retire): refused
    // here, before anything runs (never after the tool has run). Another
    // payer's open settlements do not spend this payer's share.
    if (!(typeof book.roomFor === "function" ? book.roomFor(payer) : !book.full())) {
      counters.bookFullRefused++;
      return refusePayment(res, "settlement_book_full", { status: 503, retryable: true, retryAfter: 60 });
    }

    if (draining().active) return refusePayment(res, "draining", { status: 503, retryable: true, retryAfter: 60 });

    // The input, checked the way the direct route checks it before payment: a
    // request that cannot be served is a 4xx with nothing claimed.
    try {
      if (input === null) handlerInputOf(req, def);
      const bad = preValidate(def, req) || prePaymentRefusal(def, input);
      if (bad && Number(bad.status) >= 400) { counters.refused++; return res.status(Number(bad.status)).json(scrub(bad.body)); }
    } catch (err) {
      const status = Number(err?.statusCode);
      if (status >= 400 && status < 500) { counters.refused++; return res.status(status).json(scrub({ error: referralLogText(err?.message), tool: def.slug })); }
      // Anything else is left to the handler, as on the direct route.
    }

    // Calls waiting on /verify are bounded apart from the runs (a slow verify
    // full of payments that will not verify must not take the run slots):
    // route-wide here, and per payer and per address in the lane below. A run
    // slot is taken only once the payment has verified.
    if (pending >= config.maxInflight * REFERRAL_ADDRESS_FACTOR) { counters.busy++; return refusePayment(res, "busy", { status: 503, retryable: true, retryAfter: 5 }); }
    // Unsettled runs by this payer or address, with the calls they have in
    // flight right now: bounded at admission, before anything runs or is sent.
    const laneKeys = laneKeysOf(req, payer);
    const laneHold = laneAdmit(laneKeys);
    if (laneHold) {
      counters.laneRefused++;
      res.setHeader("Retry-After", String(laneHold.retryAfterSeconds));
      return res.status(429).json({ success: false, errorReason: laneHold.inflight ? "too_many_runs_in_flight" : "too_many_unsettled_runs", errorMessage: laneHold.inflight ? REFERRAL_REASONS.too_many_runs_in_flight : REFERRAL_REASONS.too_many_unsettled_runs, retryAfterSeconds: laneHold.retryAfterSeconds });
    }
    pending++;
    let slot = false;
    let probing = false;
    let claimed = false;
    const release = () => { if (!claimed) return; claimed = false; replayGuard.release(key).catch(() => {}); };
    // Spent for running purposes: held while the authorization stays valid.
    const hold = (settled) => { if (!claimed) return; claimed = false; replayGuard.settle(key, undefined, { validBeforeMs, settled }).catch(() => {}); };
    // Post-settlement hooks a handler left on the request (a share link is
    // written only for a settled call): each runs once with the outcome.
    const settledHooks = (ok) => { for (const fn of Array.isArray(req.__onSettled) ? req.__onSettled.splice(0) : []) { try { fn(ok); } catch { /* never break a response */ } } };
    let gone = false;
    let ticket = null;
    let settleSent = false;
    let answerSent = false;
    let holdsSlot = false;
    let routeProbe = false;
    let newSlot = false;
    let ratePlace = false;
    let ranEntry = null;
    res.once("close", () => { if (!res.writableFinished) gone = true; });
    const clientGone = () => gone || res.destroyed === true || req.socket?.destroyed === true;

    try {
      // One authorization, one run.
      let verdict;
      try { verdict = await replayGuard.begin(key, undefined, { requireShared: !!requireShared(def) }); }
      catch { verdict = "unavailable"; }
      if (verdict === "unavailable") {
        res.setHeader("Retry-After", "30");
        return res.status(503).json({ error: "This route is briefly unavailable: the shared payment store did not answer, so no run was started and nothing was charged. Retry in about 30 seconds.", reason: "replay-store-unavailable" });
      }
      if (verdict !== "ok") {
        counters.replays++;
        res.setHeader("X-Payment-Replay", verdict);
        return res.status(409).json({ error: "Payment authorization already used. Each payment authorization (nonce) is single-use - sign a fresh authorization to make another paid call.", reason: verdict });
      }
      claimed = true;

      // Our own signature keeps being refused: answered 503 before anything
      // is sent or run, except by the one call that probes after the cool-down.
      const holdSeconds = ownFaultWait();
      if (holdSeconds) {
        release();
        counters.ownFaultHeld++;
        return refusePayment(res, "settlement_unavailable", { status: 503, retryable: true, retryAfter: holdSeconds });
      }
      probing = own.streak >= config.ownFaultMax;
      // The route hold's one probe, and this slug's place in flight: taken
      // here, in one turn with the checks, and given back when the call ends.
      // (Read again only while the route was held at admission: the common call makes one pass.)
      const rg = routeHeldNow ? routeGate(payer, true) : null;
      if (rg === "hold") { release(); counters.bookFaultHeld++; return refusePayment(res, "settlement_under_review", { status: 503, retryable: true, retryAfter: 30 }); }
      routeProbe = rg === "probe";

      // The chain head NOW, before the payment is verified: nothing can have
      // spent the authorization for this route earlier, so the proof of its
      // payment (or of its cancel) is looked for from here. With no head
      // readable the payment could not be followed: nothing runs.
      let fromBlock = null;
      try { fromBlock = await chain.head(); } catch { fromBlock = null; }
      if (!Number.isSafeInteger(fromBlock) || fromBlock <= 0) {
        release();
        counters.headUnavailable++;
        faultLog.line(`the chain head could not be read before /verify (${def.slug}); buyer answered 503, nothing ran`);
        return refusePayment(res, "chain_unavailable", { status: 503, retryable: true, retryAfter: 15 });
      }

      // The facilitator's own reading of the payment, always, before the
      // handler. It is sent the payment as this server validated it.
      const sent = normalizedPayment(payment, requirement, auth, signature, `${origin}/ref/${def.slug}`);
      const v = await settler.verify(sent, requirement);
      if (!v.ok || (v.payer && v.payer !== payer)) {
        release(); // nothing ran
        // The facilitator refused OUR request (the signer, the registration):
        // not the buyer's credential, not the buyer's lane.
        if (!v.ok && v.side === "ours") {
          if (v.ownFault === true) noteOwnFault("verify");
          counters.signerRefused++;
          faultLog.line(`the facilitator refused THIS SERVER's request at /verify (${def.slug} reason=${v.reason} status=${v.status}): check REFERRAL_SIGNER_KEY and the signer's role; nothing ran, buyer answered 503`);
          return refusePayment(res, "settlement_unavailable", { status: 503, retryable: true, retryAfter: 60 });
        }
        // No verdict on the payment (the facilitator did not answer, or an
        // intermediary answered for it): unavailable, and nothing is counted
        // against the buyer.
        if (!v.ok && v.inDoubt) {
          counters.verifyUnavailable++;
          noteUnanswered("verify");
          faultLog.line(`/verify gave no verdict (${def.slug} reason=${v.reason} status=${v.status}); buyer answered 503, nothing ran`);
          return refusePayment(res, "facilitator_unavailable", { status: 503, retryable: true, retryAfter: 30 });
        }
        noteAnswered("verify");
        verifyAccepted();
        counters.verifyRefused++;
        refusalLog.line(`verify refused ${def.slug} payer=${shortPayer(payer)} reason=${v.ok ? "payer_mismatch" : v.reason} status=${v.status}`);
        credentialLimiter?.note(req);
        return refusePayment(res, v.ok ? "invalid_payment" : (v.reason || "invalid_payment"), { retryable: v.retryable });
      }
      noteAnswered("verify");
      verifyAccepted();
      if (clientGone()) { release(); return undefined; }
      // A run slot, now that the payment verified: past the bound nothing runs.
      if (inflight >= config.maxInflight) { release(); counters.busy++; return refusePayment(res, "busy", { status: 503, retryable: true, retryAfter: 5 }); }
      // The slug's place in flight, taken only now that /verify accepted the
      // payment (a credential that does not verify never holds a cold slug
      // closed), in one turn with the run slot, and given back when the call ends.
      if (slugHeld(def.slug) || rateGate(def.slug, false, payer) === "hold") { release(); counters.shortNetHeld++; return refusePayment(res, "rate_under_review", { status: 503, retryable: true, retryAfter: slugHeld(def.slug) ? 300 : 5 }); }
      // While the service-wide rule is on, a payer with no paid sale takes one of the new payers' share of the slots.
      let paidPayer = false;
      try { paidPayer = payerHasPaid(payer) === true; } catch { paidPayer = false; }
      if (!paidPayer && serviceWideFailing() && inflightNew >= newPayerSlots()) { release(); counters.busy++; counters.newPayerShareRefused++; return refusePayment(res, "busy", { status: 503, retryable: true, retryAfter: 5 }); }
      ratePlace = rateGate(def.slug, true, payer) === "taken";
      inflight++;
      slot = true;
      if (!paidPayer) { inflightNew++; newSlot = true; }
      // The whole deadline must still fit before the settle reserve: a run is
      // never started on a shortened budget.
      const left = validBeforeMs - now() - config.settleReserveMs;
      if (left < config.deadlineMs) { release(); counters.refused++; return refusePayment(res, "invalid_exact_evm_payload_authorization_valid_before"); }

      // ---- the handler starts: from here the authorization is spent -------------
      // A short sale seen while this call was being verified: it does not run.
      if (slugHeld(def.slug)) { release(); counters.shortNetHeld++; return refusePayment(res, "rate_under_review", { status: 503, retryable: true, retryAfter: 300 }); }
      counters.runs++;
      if (req.__a402ReferralExample === true) counters.exampleRuns++;
      const budget = config.deadlineMs;
      try { isolate(req); } catch { /* the lane mark is best effort */ }
      try { presentWindow(req, now() + budget); } catch { /* the handler keeps its own timeouts */ }
      ticket = reserveForgiveness(laneKeys, Number(amount));
      if (onRun) { try { onRun(req, res, def); } catch { /* bookkeeping only */ } }
      let result;
      try {
        if (input === null) input = handlerInputOf(req, def);
        const ceilingMs = Math.max(1, budget - 500);
        const ranFrom = Date.now();
        result = await withLoopTimeout(
          Promise.resolve().then(() => withCeiling(ceilingMs, () => runAsCaller(req, () => def.handler(input, req)))),
          budget,
          () => Object.assign(new Error("The call did not finish in time, so it was not settled and nothing was charged. Sign a new authorization to make the call again."), { statusCode: 504, referralTimeout: true }),
        );
        // A handler that came back only once its ceiling had passed was cut
        // off by it: whatever it returned, that is a run that did not finish
        // in time, never an answer to settle.
        if (Date.now() - ranFrom >= ceilingMs) { counters.ceilingCuts++; throw Object.assign(new Error("The call did not finish in time, so it was not settled and nothing was charged. Sign a new authorization to make the call again."), { statusCode: 504, referralTimeout: true }); }
      } catch (err) {
        hold(false);
        settledHooks(false);
        const timedOut = err?.referralTimeout === true || Number(err?.statusCode) === 504;
        // A run that ended at the deadline this route imposed is not counted
        // against the payer (the direct breaker does not count its own either).
        if (timedOut) counters.timeouts++; else counters.handlerErrors++;
        // A provider refused the buyer's request and no other model took it: a 400, as on the direct route.
        if (err?.upstreamRejected === true && (err.statusCode || 502) === 502) err.statusCode = 400;
        if (!(Number(err?.statusCode) >= 400)) { try { err.statusCode = 500; } catch { /* a frozen error keeps the renderer's default */ } }
        if (!res.headersSent) {
          // The direct route's rendering, with no pointer to a direct route.
          const json = res.json.bind(res);
          res.json = (body) => json(scrub(body));
          sendToolError(res, err, def.slug);
        }
        return undefined;
      }

      // Only a JSON answer can carry the transaction: a stream or raw bytes is refused, uncharged.
      if (result && (result.__binary || typeof result.__sse === "function")) {
        hold(false);
        settledHooks(false);
        counters.handlerErrors++;
        return res.status(500).json({ error: "This tool's answer cannot be served on this route; nothing was charged.", tool: def.slug });
      }
      // The answer is serialized BEFORE the settlement, so a value that
      // cannot be sent is found while nothing has been charged.
      const answer = withIgnoredParams(result, req);
      const wrap = !answer || typeof answer !== "object" || Array.isArray(answer) || Object.hasOwn(answer, "transaction");
      let text;
      try { text = JSON.stringify(answer === undefined ? null : answer); if (typeof text !== "string") throw new Error("not JSON"); }
      catch { text = null; }
      const bytes = text === null ? 0 : Buffer.byteLength(text);
      if (text === null || bytes > REFERRAL_ANSWER_MAX_BYTES) {
        hold(false);
        settledHooks(false);
        counters.handlerErrors++;
        return res.status(500).json({ error: text === null ? "This tool's answer could not be serialized; nothing was charged." : "This tool's answer is too large for this route; nothing was charged.", tool: def.slug });
      }
      // What a hang-up from here on is recorded as (the refund run's words):
      // the reason no forgiveness ticket was granted (a spent budget: a repeat
      // hang-up, held for review), else a first one inside the budget.
      const goneReason = (ticket && !ticket.granted && ticket.reason) || "settle in flight";
      const entry = { key, digest, slug: def.slug, text, wrap, bytes, amount, requirement, payment: sent, auth, payer, validBeforeMs, fromBlock, hangup: null, goneReason, laneKeys, charged: null, landed: false, unpaid: false, saleBooked: false, delivered: false, settleAttempts: 0, lastReason: null, lastSide: null, lastRetryable: false, chainUnused: false, inDoubt: false, everInDoubt: false, at: now() };

      // The buyer left before settlement starts. With a forgiveness ticket the
      // payment is not settled (the direct routes' rule, on this route's own
      // budgets). Without one it is settled as for any other run, and the
      // answer is kept.
      if (clientGone() && ticket && ticket.granted) {
        hold(false);
        settledHooks(false);
        counters.forgivenHangups++;
        line("warn", `client gone before settlement (${def.slug} payer=${shortPayer(payer)}) - not settled, not charged, authorization held`);
        return undefined;
      }

      // Gone, with no ticket: settled as for any run. Why no ticket was
      // granted is kept for the refund run, in the direct routes' words.
      if (clientGone()) entry.hangup = goneReason;

      // From here the answer is kept against the authorization for its life,
      // and this request holds the authorization's one settle slot.
      hold(true);
      keep(entry);
      settling.add(key);
      holdsSlot = true;
      settleSent = true;
      ranEntry = entry;
      const outcome = await settleEntry(entry, req);
      settledHooks(outcome === "charged");
      // The buyer left while the settle was in flight: the entry carries the
      // hang-up from now, whatever the outcome reads yet, so a payment that
      // lands later is owed back as a hang-up (and a repeat one is held).
      if (clientGone() && !entry.hangup) {
        entry.hangup = goneReason;
        if (book.get(key)) await book.resolve(key, { hangup: entry.hangup }).catch(() => {});
      }
      if (outcome === "charged") { answerSent = await deliver(res, entry); return undefined; }
      // A verdict on the payment after a served run counts in this route's own lane.
      if (outcome === "refused" && entry.lastSide === "buyer") laneNote(laneKeys, entry.key);
      if (!clientGone()) refuseOutcome(res, entry, outcome);
      return undefined;
    } catch (err) {
      // Nothing above is expected to throw. A claim still held here is given
      // back only if the handler never started (`hold` cleared it otherwise).
      release();
      line("error", `gate error (${def.slug}): ${referralLogText(err?.message)}`);
      if (!res.headersSent) { try { res.status(500).json({ error: "request failed", tool: def.slug }); } catch { /* socket already gone */ } }
      return undefined;
    } finally {
      pending--;
      if (slot) inflight--;
      if (newSlot) inflightNew--;
      // A probe that ended without a verdict on our signature: the next call probes.
      if (probing && own.streak >= config.ownFaultMax && now() >= own.blockedUntil) own.probeUntil = 0;
      laneLeave(laneKeys);
      if (routeProbe) routeProbeEnd(ranEntry?.contradicted === true || ranEntry?.unprovenSettle === true);
      if (ratePlace) rateLeave(def.slug);
      if (holdsSlot) settling.delete(key);
      // The ticket's end: abandoned (its price spent from the forgiveness
      // budgets) when the buyer left and no answer went out, whether the
      // settlement was withheld or was already in flight; returned otherwise.
      // A buyer who keeps leaving during the settle therefore runs out of
      // budget like one who leaves before it, and the next such debt carries
      // the spent-budget reason the refund run holds.
      finishForgiveness(ticket, clientGone() && !answerSent);
    }
  }

  /** The sweep's booking: a sale for an open book entry whose receipt proves the payment. */
  const bookFromSweep = async (e, transaction, net = null) => {
    const booked = bookSale({ key: e.key, slug: e.slug, amount: e.amount, payer: e.payer, tx: transaction, net });
    const entry = kept.get(e.key);
    if (entry && !entry.landed) { entry.charged = transaction; entry.landed = true; laneClear(entry.laneKeys || [], entry.key); laneOk(entry.laneKeys || []); }
    return booked;
  };
  /** An unconfirmed payment (the facilitator's success, its receipt not yet
   *  readable): confirmed, flagged as contradicted, or, when its receipt
   *  still cannot be read after REFERRAL_UNCONFIRMED_FLAG_MS, flagged so the
   *  word reads attention until it is resolved. */
  async function confirmUnconfirmed(snapshot) {
    const e = book.get(snapshot.key);
    if (!e || e.state !== "unconfirmed") return;
    let proof = "unknown", provenNet = null, moved = false, detail = { read: false, why: null, product: null, routedToUs: false };
    try { const d = await proveWithDetail(e.tx, { from: e.payer, nonce: e.nonce, payTo: config.payTo, amount: e.amount, minNet: minNetOf(e.slug, e.amount), productId: productOf(e.slug) }); proof = d.verdict; provenNet = d.net; moved = d.moved === true; detail = d; } catch { proof = "unknown"; }
    const cur = book.get(e.key);
    if (!cur || cur.state !== "unconfirmed") return;
    const entry = kept.get(e.key);
    if (proof === "unknown" && detail.read === true) {
      // The receipt is there now, read in full, and does not prove this sale:
      // no longer "not readable" (never the route-wide flag). Held for the
      // operator as unproven; another product stops its slug.
      counters.settleUnproven++;
      if (detail.product) noteProductMismatch(e.slug, e.amount, e.tx, detail.product);
      line("error", `a settle success delivered before its receipt could be read is NOT proven by it (${e.slug} payer=${String(e.payer).slice(0, 6)} tx=${e.tx}: ${detail.why}${cur.delivered ? ", the answer was delivered" : ""}): held for an operator`);
      await book.resolve(e.key, { state: "in-doubt", reason: "receipt_not_this_sale", unproven: true, unprovenAt: now(), moved, seenTx: e.tx, flagged: false, why: String(detail.why || "").slice(0, 160), ...(detail.routedToUs ? { routedToUs: true } : {}) }).catch(() => {});
      return;
    }
    if (proof === "paid") {
      if (entry) entry.unconfirmed = false;
      routeHealed();
      // The sale was booked at the computed net: corrected now to what the receipt shows.
      bookSale({ key: e.key, slug: e.slug, amount: e.amount, payer: e.payer, tx: e.tx, net: provenNet });
      // A send still going out keeps its entry (charged now, the mark kept): its own end closes it.
      const sendingNow = entry ? entry.sending === true : cur.delivered === true && Number(cur.sendingUntil) > now();
      if (sendingNow) await book.resolve(e.key, { state: "charged-undelivered", flagged: false }).catch(() => {});
      else if (cur.delivered === true || entry?.delivered) await closeEntry(e.key);
      else await book.resolve(e.key, { state: "charged-undelivered", flagged: false }).catch(() => {});
      return;
    }
    if (proof === "unpaid") {
      counters.settleContradicted++;
      reach.contradictedAt = now();
      line("error", `a settle success the chain CONTRADICTS (${e.slug} payer=${String(e.payer).slice(0, 6)} tx=${e.tx}${cur.delivered ? ", the answer was delivered" : ""}): kept for an operator`);
      // A success taken on the facilitator's word that the chain denies. A
      // payment can be made to produce this (bookFault), so it holds its payer only.
      await book.resolve(e.key, { state: "contradicted", scope: "payer", moved, contradictedAt: now() }).catch(() => {});
      return;
    }
    const since = Number(cur.landedAt || cur.at || 0);
    const flag = cur.flagged === true || now() - since >= REFERRAL_UNCONFIRMED_FLAG_MS;
    if (flag && cur.flagged !== true) {
      counters.unconfirmedFlagged++;
      line("error", `a settle success has NO readable receipt after ${Math.round(REFERRAL_UNCONFIRMED_FLAG_MS / 60_000)} minutes (${e.slug} payer=${String(e.payer).slice(0, 6)} tx=${e.tx}${cur.delivered ? ", the answer was delivered" : ""}): flagged for an operator`);
    }
    await book.resolve(e.key, { checks: (cur.checks || 0) + 1, checkedAt: now(), ...(flag ? { flagged: true } : {}) }).catch(() => {});
  }
  // An intent is left to its own request for the settle timeout and the chain read after it.
  const heldMoved = [];
  const sweepOnce = async () => {
    const out = await sweepBook();
    // What the pass found held with the buyer's money moved, and any unproven
    // entry whose debt did not land before: marked, and owed back.
    for (const h of heldMoved.splice(0)) {
      const e = book.get(h.key);
      if (e && e.state === "in-doubt" && e.unproven !== true) await book.resolve(h.key, { unproven: true, unprovenAt: now(), moved: true, why: h.why.slice(0, 160) }).catch(() => {});
    }
    for (const e of book.list()) if (e.state === "in-doubt" && e.unproven === true && e.moved === true && !settling.has(e.key)) await oweUnproven(e.key, String(e.why || "")); // (once, and never for a delivered answer: oweUnproven's own checks)
    return out;
  };
  const sweepBook = async () => {
    // A short-net record the current map admits (the map was corrected) is dropped.
    try { const live = new Set(shortNow().map((r) => r.slug)); for (const p of productStops()) live.add(p.slug); for (const slug of Object.keys(book.shortSales())) if (!live.has(slug)) { await book.clearShort(slug); rate.deep.delete(slug); rate.product.delete(slug); } } catch { /* the next pass */ }
    pruneKept();
    restPrune();
    try { await answers.sweep?.(); } catch { /* the next pass */ }
    for (const e of book.list().filter((x) => x.state === "unconfirmed").sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0)).slice(0, 50)) await confirmUnconfirmed(e);
    return book.sweep({
      chain, bookSale: bookFromSweep, payTo: config.payTo, graceMs: config.settleMs + 15_000,
      minNetOf: (e) => minNetOf(e.slug, e.amount),
      productIdOf: (e) => productOf(e.slug),
      onHeld: (e, st) => {
        if (st?.product) noteProductMismatch(e.slug, e.amount, String(st.transaction || ""), st.product);
        // A receipt read in full that shows the buyer's transfer and is no
        // proof: the entry is unproven from now, and its buyer is owed back.
        if (st?.moved === true) heldMoved.push({ key: e.key, why: String(st.why || "") });
      },
      onUnpaid: (e) => { counters.usedUnpaid++; restDrop(e.key); laneNote([`payer:${String(e.payer).toLowerCase()}`], null); const entry = kept.get(e.key); if (entry) { entry.unpaid = true; entry.inDoubt = false; } },
      onCharged: (e) => oweIfUndeliverable(e, "its answer expired or was not stored"),
      unrecognizedMax: config.unrecognizedReads,
      onUnrecognized: (e) => { counters.unrecognizedClosed++; restDrop(e.key); },
    });
  };

  /**
   * An operator closes an entry by hand (a contradicted or flagged one, one
   * nothing can prove, a charged one whose buyer wrote in), with a note
   * saying what was checked and an explicit outcome:
   *   refund     a refund debt is written by the automatic path's own writer
   *              (writeDebt: behind the proof read now, never with the
   *              delivered mark, at the gross, once); the entry stays as the
   *              refund-owed mark. With no proof no debt is written and the
   *              entry is left as it is.
   *   delivered  the buyer has the answer: no debt; the entry is removed.
   *   dismissed  nothing is owed: no debt; the entry is removed.
   * A charged, undelivered entry needs the outcome named; any other reads
   * `dismissed` when none is given. Every resolution is recorded with the
   * outcome, the note and whether a debt was written. `{ ok, entry, debt }`.
   */
  async function resolveByHand(key, { note = "", outcome = null } = {}) {
    if (typeof key !== "string" || !key) return { ok: false, error: "no entry key" };
    if (typeof note !== "string" || note.trim().length < 3) return { ok: false, error: "a note saying what was checked is required" };
    if (settling.has(key)) return { ok: false, error: "this entry is being settled right now" };
    const e = book.get(key);
    if (!e) return { ok: false, error: "no such entry, or the book could not be written" };
    if ((outcome === null || outcome === undefined) && e.state !== "charged-undelivered") outcome = "dismissed";
    if (!REFERRAL_HAND_OUTCOMES.includes(outcome)) return { ok: false, error: `name the outcome: ${REFERRAL_HAND_OUTCOMES.join(", ")} (a charged, undelivered entry is never closed without one)` };
    if (kept.get(key)?.sending === true) return { ok: false, error: "this entry's answer is being sent right now" };
    const view = { slug: e.slug, payer: e.payer, amount: e.amount, state: e.state, tx: txOf(e), delivered: e.delivered === true };
    let debt = false;
    if (outcome === "refund") {
      if (e.delivered === true || kept.get(key)?.delivered === true) return { ok: false, error: "this entry carries the delivered mark: no refund is owed for it" };
      if (e.state !== "refund-owed" && !e.debtAt) {
        if (!txOf(e)) return { ok: false, error: "no transaction is recorded for this entry: there is nothing a refund could be proven against" };
        // The settle slot, so no re-send delivers the answer while the debt is written.
        settling.add(key);
        let wrote;
        try { wrote = await writeDebt(e, `resolved by an operator (${note.trim().slice(0, 120)})`, { byHand: true }); } finally { settling.delete(key); }
        if (wrote !== "owed") return { ok: false, error: wrote === "unproven" ? "the receipt could not be read or is not a recognized shape: no debt written, the entry is unchanged" : wrote === "contradicted" ? "the receipt does not prove a payment routed to this merchant: no debt written, and the entry is kept as contradicted (where its receipt shows the buyer's own transfer into the contract, routed to another merchant, sending refund again records the debt for a payment this server did not receive)" : wrote === "changed" ? "the entry changed meanwhile (delivered or closed): no debt written" : "the refund ledger did not take the row: no debt written" };
      }
      debt = true;
      // A refund already recorded by hand for this entry is not recorded again.
      if ((e.state === "refund-owed" || e.debtAt) && e.byHand === true) return { ok: true, entry: view, debt };
      // An unproven entry whose debt was written by itself stays as it is (open, for the hold): the operator's refund records the note.
      const r = await book.resolveByHand(key, { note: note.trim(), outcome, debt: true, was: e.state, patch: { byHand: true } });
      if (!r.ok) return { ok: false, error: "the debt is written, but the resolution could not be recorded; send it again" };
      counters.resolvedByHand++;
      return { ok: true, entry: view, debt };
    }
    const r = await book.resolveByHand(key, { note: note.trim(), outcome });
    if (!r.ok) return { ok: false, error: "no such entry, or the book could not be written" };
    counters.resolvedByHand++;
    dropKept(key);
    restDrop(key);
    return { ok: true, entry: view, debt };
  }

  /** An operator puts an entry closed as unrecognized back in the book (a
   *  close that was wrong), with a note: it is an open in-doubt entry again,
   *  never closed by itself, and `refund`, `delivered` and `dismissed` work
   *  on it (resolveByHand). `{ ok, entry }`. */
  async function reopenByHand(key, { note = "" } = {}) {
    if (typeof key !== "string" || !key) return { ok: false, error: "no entry key" };
    if (typeof note !== "string" || note.trim().length < 3) return { ok: false, error: "a note saying what was checked is required" };
    const r = await book.reopenClosed(key, { note: note.trim() });
    if (!r.ok) return { ok: false, error: "no such closed record (or an open entry already stands for it), or the book could not be written" };
    counters.reopenedByHand++;
    return { ok: true, entry: { slug: r.entry.slug, payer: r.entry.payer, amount: r.entry.amount, state: r.entry.state, tx: r.entry.seenTx || null, delivered: false } };
  }

  /** An operator clears a slug's short-net record (and with it the stop on
   *  that slug), with a note. The next sale under the floor starts it again. */
  async function clearShortByHand(slug, { note = "" } = {}) {
    if (typeof slug !== "string" || !slug) return { ok: false, error: "no slug" };
    if (typeof note !== "string" || note.trim().length < 3) return { ok: false, error: "a note saying what was checked is required" };
    // This process's own count too, whether or not the book holds a record
    // (a stop whose record never landed is still cleared, and still recorded).
    const inProcess = (rate.deep.get(slug)?.size || 0) > 0 || rate.product.has(slug);
    let ok = await book.clearShort(slug, { note: note.trim() });
    if (!ok && inProcess) { try { await book.resolveNote({ slug, outcome: "short-net-cleared", note: note.trim() }); } catch { /* cleared all the same */ } ok = true; }
    // An operator's clear makes the slug cold again, whether or not a stop stood.
    markCold(slug);
    if (ok) { rate.deep.delete(slug); rate.product.delete(slug); }
    return ok ? { ok: true, slug } : { ok: false, error: "no short-net record stands for that slug, or the book could not be written" };
  }

  return {
    handler, sweepOnce, statusWord, resolveByHand, reopenByHand, clearShortByHand, shortSales: () => shortNow(),
    stats: () => ({ ...counters, inflight, keptAnswers: kept.size, keptBytes, atRestAnswers: atRest.size, atRestBytes, laneKeys: lane.size, pending, coldInflight: Object.fromEntries(rate.inflight), ownFaultStreak: own.streak, ownFaultHeldUntil: own.blockedUntil ? new Date(own.blockedUntil).toISOString() : null, forgivenUsd: forgive.abandoned.reduce((a, r) => a + r[1], 0) / MICRO, book: book.counts() }),
    slugs: () => [...defs.keys()],
  };
}
