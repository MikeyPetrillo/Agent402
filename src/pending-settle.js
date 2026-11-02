// A settle answered "still pending" with a transaction hash, read on chain
// before the buyer is answered.
//
// A facilitator can broadcast the buyer's transferWithAuthorization and then
// stop waiting for its receipt before the block lands, answering
// `settlement_pending` (or "transaction did not confirm in time: context
// deadline exceeded") with the hash it broadcast. Without this the middleware
// answers 402, discards the buffered answer, and the late-settlement book
// (src/late-settlements.js) finds the transfer mined seconds later and books
// it owed: the buyer paid, got nothing, and waits for a refund.
//
// @x402/core retries a pending settle once (settleWithPendingRetry), and the
// retry can name ANOTHER transaction than the first answer did, while only the
// last answer reaches the failure hook. So every pending answer's transaction
// is noted on the payment (notePendingSettleAnswers), and every noted hash is
// read here. One EIP-3009 nonce moves money once, so at most one of them can
// prove the payment.
//
// On an EVM exact (EIP-3009) settle failure whose answers named a pending
// transaction, each transaction's receipt is polled for a bounded time. The
// settlement is recovered with a transaction only when its receipt proves it
// is this payment:
//   mined with status 1,
//   carrying the asset's AuthorizationUsed(payer, nonce) log for THIS
//   authorization (one EIP-3009 nonce moves money once, so the transfer is
//   this payment's and no other's),
//   and moving at least the required amount of the asset from the signed payer
//   to the payTo of the requirements (evmTransferredInReceipt, the rule the
//   late-settlement book applies),
//   not already a recorded sale (read fresh from the ledger, inside the wait).
// The caller (src/payments.js) then claims the tx (src/settlement-claims.js),
// so one transfer answers one request and a tx the late book already booked
// owed is never served.
//
// Anything else keeps the path the failure always had: reverted, mined
// without that transfer or that authorization, not mined by the deadline, the
// RPC unreadable or rate limited, too many reads already in flight, or the
// buyer gone before the first byte. The failure stands (402), the
// late-settlement book books EVERY noted transaction (with the authorization's
// nonce, so only the one that used it can be owed), and a refund is owed only
// after on-chain proof. This module never settles: it only reads the chain.
//
// Bounds: the wait ends at the first of PENDING_SETTLE_RECEIPT_WAIT_MS
// (default 12 s: six Base blocks at 2 s, past the few seconds a broadcast
// transfer takes to be included when the chain is healthy), the request's CDN
// answer window less a margin (src/cdn-sync-window.js), and the
// authorization's validBefore (mined after it, the transfer reverts). Polls
// every PENDING_SETTLE_POLL_MS (default 1.5 s). At most
// PENDING_SETTLE_MAX_INFLIGHT (default 8) reads run at once in a process;
// past that, and after an RPC rate-limit answer (HTTP 429 or a rate-limit
// error), the read is skipped or ends and the failure stands.
//
// Each outcome is counted per network and facilitator on the failure monitor
// (PENDING_OUTCOMES, src/tool-failure-monitor.js), shown on
// /__operator/tool-failures.json.
//
// Not handled here: Robinhood 4663 (src/robinhood-outage.js and its own
// relayer), Arc 5042 (src/circle-pending.js), Tempo, Circle Gateway batched
// payments, Permit2 payloads, and any network without a configured RPC
// (src/evm-rpcs.js).
import { rpc, evmTransferredInReceipt } from "./payment-verify.js";
import { evmRpcFor } from "./evm-rpcs.js";
import { cdnSyncLeftMs } from "./cdn-sync-window.js";
import { clientGoneBeforeFirstByte } from "./hangup-settlement.js";
import { isGatewayBatchedPayment } from "./gateway-wire.js";
import { currentRequestScope } from "./request-timing.js";
import { PENDING_OUTCOMES } from "./tool-failure-monitor.js";

export const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
export const SETTLEMENT_PENDING_REASON = "settlement_pending";
const EXCLUDED_NETWORKS = new Set(["eip155:4663", "eip155:5042", "eip155:4217"]);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
// Kept before a CDN request's answer is cut off, for the answer itself.
export const CDN_MARGIN_MS = 3_000;
const CALL_TIMEOUT_MS = 4_000;
const MAX_NOTES = 8;
/** Outcome keys counted on the failure monitor, in this order. */
export { PENDING_OUTCOMES };

// Words a facilitator uses for a broadcast whose receipt it stopped waiting
// for. Read only together with a transaction hash.
const PENDING_WORDS = [
  /\bsettlement[_ ]pending\b/i,
  /\bdid not confirm in time\b/i,
  /\bcontext deadline exceeded\b/i,
  /\bnot (?:yet )?confirmed\b/i,
  /\b(?:receipt|confirmation) (?:wait )?timed? ?out\b/i,
];
// An RPC answer that says the endpoint is throttling us.
const RATE_LIMITED = /\bHTTP 429\b|\brate[ -]?limit|\btoo many requests\b|\brequest limit\b|\blimit exceeded\b/i;

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const clip = (v, n = 32) => String(v ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, n);
/** The receipt wait, ms (PENDING_SETTLE_RECEIPT_WAIT_MS, at most 30 s; 0 turns the read off). */
export function pendingSettleWaitMs(env = process.env) { return Math.min(num(env.PENDING_SETTLE_RECEIPT_WAIT_MS, 12_000), 30_000); }
/** The poll interval, ms (PENDING_SETTLE_POLL_MS, 250 ms to 5 s). */
export function pendingSettlePollMs(env = process.env) { return Math.min(Math.max(num(env.PENDING_SETTLE_POLL_MS, 1_500), 250), 5_000); }
/** Concurrent receipt reads per process (PENDING_SETTLE_MAX_INFLIGHT, default 8; 0 skips every read). */
export function pendingSettleMaxInflight(env = process.env) { return Math.floor(num(env.PENDING_SETTLE_MAX_INFLIGHT, 8)); }
/** Whether an RPC error says the endpoint is rate limiting. */
export function isRateLimitedRpcError(e) { return RATE_LIMITED.test(String(e?.message || e || "")); }

/**
 * The transaction a pending settle failure names (lowercased), or null. A
 * payment verdict (an `invalid_*` reason, insufficient funds) is never
 * pending, whatever its message says.
 */
export function pendingSettleTxOf(err) {
  if (!err || typeof err !== "object") return null;
  const tx = String(err.transaction || "");
  if (!B32.test(tx)) return null;
  const reason = String(err.errorReason || "");
  if (reason === SETTLEMENT_PENDING_REASON) return tx.toLowerCase();
  if (/^invalid_/.test(reason) || /insufficient_funds/.test(reason)) return null;
  const text = [reason, err.errorMessage, err.message].filter((s) => typeof s === "string").join(" ");
  return PENDING_WORDS.some((re) => re.test(text)) ? tx.toLowerCase() : null;
}

const reqOf = (ctx) => ctx?.transportContext?.request?.adapter?.req;
const topicOf = (addr) => `0x${"0".repeat(24)}${String(addr).slice(2).toLowerCase()}`;

/** Whether this context's payment is one this module reads at all (network,
 *  scheme, an EIP-3009 authorization, never a Gateway batched payment). */
function readableKind(ctx, rpcFor) {
  const rq = ctx?.requirements || {};
  const network = String(rq.network || "");
  if (!network.startsWith("eip155:") || EXCLUDED_NETWORKS.has(network)) return false;
  if (String(rq.scheme || "").toLowerCase() !== "exact") return false;
  // Circle Gateway batched: Gateway alone settles it (src/gateway-wire.js).
  if (isGatewayBatchedPayment(ctx?.paymentPayload) || isGatewayBatchedPayment(rq)) return false;
  const a = ctx?.paymentPayload?.payload?.authorization;
  if (!a || !ADDR.test(String(a.from || "")) || !B32.test(String(a.nonce || ""))) return false;
  if (!ADDR.test(String(rq.payTo || "")) || !ADDR.test(String(rq.asset || ""))) return false;
  return !!rpcFor(network);
}

/**
 * Every pending transaction this failure's settle answers named, deduped,
 * lowercased: the noted answers in the order they came, then the final
 * answer's (normally the same as the last noted one).
 */
export function pendingTxsOf(ctx) {
  const out = [];
  for (const n of peekPendingAnswers(ctx?.paymentPayload)) if (n.tx && !out.includes(n.tx)) out.push(n.tx);
  const last = pendingSettleTxOf(ctx?.error);
  if (last && !out.includes(last)) out.push(last);
  return out;
}

/** The noted pending transactions the late-settlement book should hold for
 *  this failure (empty for a payment this module never reads). */
export function pendingNotedTxsFor(ctx, { rpcFor = evmRpcFor } = {}) {
  if (!readableKind(ctx, rpcFor)) return [];
  return pendingTxsOf(ctx);
}

/** Whether this failure context is one this module reads. */
export function pendingSettleApplies(ctx, { rpcFor = evmRpcFor } = {}) {
  if (!readableKind(ctx, rpcFor)) return false;
  return pendingTxsOf(ctx).length > 0;
}

/** Whether a receipt carries the asset's AuthorizationUsed(payer, nonce) log. */
export function receiptUsesAuthorization(receipt, { asset, payer, nonce }) {
  const tok = String(asset).toLowerCase();
  return (receipt?.logs || []).some((l) => String(l?.address || "").toLowerCase() === tok
    && String(l?.topics?.[0] || "").toLowerCase() === AUTHORIZATION_USED_TOPIC
    && String(l?.topics?.[1] || "").toLowerCase() === topicOf(payer)
    && String(l?.topics?.[2] || "").toLowerCase() === String(nonce).toLowerCase());
}

/** The receipt's verdict for this payment: "ours", or a reason (and outcome code) it is not. */
export function judgePendingReceipt(receipt, { asset, payer, nonce, payTo, amount }) {
  if (String(receipt?.status) !== "0x1") return { ours: false, code: "reverted", reason: `transaction did not succeed on chain (status ${clip(receipt?.status)})` };
  if (!receiptUsesAuthorization(receipt, { asset, payer, nonce })) return { ours: false, code: "wrongTransfer", reason: "the transaction did not use this payment's authorization" };
  let required;
  try { required = BigInt(amount); } catch { return { ours: false, code: "wrongTransfer", reason: "requirements amount unreadable" }; }
  const moved = evmTransferredInReceipt(receipt, { token: asset, from: payer, toSet: [payTo] });
  if (moved === 0n || moved < required) return { ours: false, code: "wrongTransfer", reason: `the transaction moved ${moved} of ${required} from the payer to our payTo` };
  return { ours: true };
}

let inflight = 0;
/** Receipt reads in flight in this process (tests and the operator view). */
export function pendingSettleInflight() { return inflight; }

/**
 * Read every noted transaction's receipt for a bounded time. Answers
 * `{ recovered: true, result, code: "recovered" }` (the caller still claims the
 * tx) or `{ recovered: false, code, reason }` with `code` one of
 * PENDING_OUTCOMES (or "notApplicable").
 */
export async function confirmPendingSettle(ctx, {
  rpcFor = evmRpcFor,
  fetchImpl = fetch,
  waitMs = pendingSettleWaitMs(),
  pollMs = pendingSettlePollMs(),
  maxInflight = pendingSettleMaxInflight(),
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  clientGone = clientGoneBeforeFirstByte,
  saleByTx = null,
  txs = null,
} = {}) {
  const no = (code, reason) => ({ recovered: false, code, reason });
  if (!pendingSettleApplies(ctx, { rpcFor })) return no("notApplicable", "not a pending EVM exact settle with a transaction");
  const rq = ctx.requirements;
  const network = String(rq.network);
  const candidates = (Array.isArray(txs) && txs.length ? txs : pendingTxsOf(ctx)).filter((t) => B32.test(String(t))).map((t) => String(t).toLowerCase());
  const auth = ctx.paymentPayload.payload.authorization;
  const req = reqOf(ctx);
  const gone = () => !!(req && clientGone(req));
  const GONE = "the buyer left before the answer";
  if (gone()) return no("buyerGone", GONE);
  const url = rpcFor(network);
  const started = now();
  const vb = Number(auth.validBefore);
  const authLeft = Number.isFinite(vb) && vb > 0 && vb < 1e10 ? vb * 1000 - started : Infinity;
  const cdnLeft = cdnSyncLeftMs(req, started);
  const budget = Math.max(0, Math.min(waitMs, authLeft, cdnLeft == null ? Infinity : cdnLeft - CDN_MARGIN_MS));
  const deadline = started + budget;
  if (budget <= 0) return no("noTime", waitMs <= 0 ? "the receipt wait is turned off (PENDING_SETTLE_RECEIPT_WAIT_MS=0)" : "no time left to read the transaction");
  if (inflight >= maxInflight) return no("capped", `${inflight} receipt reads already in flight (PENDING_SETTLE_MAX_INFLIGHT ${maxInflight})`);
  inflight++;
  try {
    const open = [...candidates];
    const verdicts = [];
    let last = { code: "notMined", reason: "transaction not mined within the wait" };
    for (;;) {
      for (const tx of [...open]) {
        const left = deadline - now();
        if (left <= 0) break;
        let receipt;
        try {
          receipt = await rpc(url, "eth_getTransactionReceipt", [tx], fetchImpl, Math.min(CALL_TIMEOUT_MS, left), []);
        } catch (e) {
          // A throttled endpoint is not read again by this wait: every
          // further read would only add to the load it refused.
          if (isRateLimitedRpcError(e)) return no("rateLimited", `the RPC is rate limiting reads: ${clip(e?.message || e, 80)}`);
          last = { code: "rpcError", reason: `could not read the chain: ${clip(e?.message || e, 120)}` };
          continue;
        }
        if (receipt === null || receipt === undefined) { if (last.code !== "rpcError") last = { code: "notMined", reason: "transaction not mined within the wait" }; continue; }
        // The chain has answered for this tx: waiting longer cannot change
        // its verdict.
        const v = judgePendingReceipt(receipt, { asset: rq.asset, payer: auth.from, nonce: auth.nonce, payTo: rq.payTo, amount: rq.amount });
        if (!v.ours) { open.splice(open.indexOf(tx), 1); verdicts.push({ tx, ...v }); continue; }
        // This tx used the authorization: no other can, so the answer is
        // decided here.
        if (gone()) return no("buyerGone", GONE);
        let lookup = saleByTx;
        if (!lookup) lookup = (await import("./sales-ledger.js")).saleByTxFresh;
        const ledgerLeft = deadline - now();
        if (ledgerLeft <= 0) return no("noTime", "the wait ended before the sales ledger was read");
        let sold = null;
        let timer = null;
        try {
          sold = await Promise.race([
            Promise.resolve().then(() => lookup(tx)),
            new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("the sales ledger did not answer within the wait"), { code: "noTime" })), ledgerLeft); }),
          ]);
        } catch (e) {
          return e?.code === "noTime" ? no("noTime", e.message) : no("ledgerError", `could not read the sales ledger: ${clip(e?.message || e, 80)}`);
        } finally { if (timer) clearTimeout(timer); }
        if (sold) return no("alreadySold", "the transaction is already a recorded sale");
        // The ledger read took time: the bounds and the buyer are read again.
        if (now() >= deadline) return no("noTime", "the wait ended while the sales ledger was read");
        if (gone()) return no("buyerGone", GONE);
        return { recovered: true, code: "recovered", result: { success: true, transaction: tx, network, payer: auth.from } };
      }
      if (!open.length) {
        const first = verdicts[0] || last;
        return no(first.code, verdicts.length > 1 ? verdicts.map((v) => `${v.tx.slice(0, 10)}: ${v.reason}`).join("; ") : first.reason);
      }
      if (gone()) return no("buyerGone", GONE);
      if (now() + pollMs >= deadline) break;
      await sleep(pollMs);
    }
    return no(last.code, last.reason);
  } finally {
    inflight--;
  }
}

// ---- notes on the payment ----------------------------------------------------
// Every pending answer a facilitator gives for one payment is noted here: its
// transaction (so each one is read, and each unproven one booked), whether it
// came as an HTTP 5xx (the egress meter's observer, src/tool-failure-monitor.js,
// counted it s5xx when it arrived), the facilitator's host, and the request's
// origin lane at the time (outside, synthetic, background). A recovery moves
// those 5xx counts back to ok in that lane (forgiveUpstream); a 5xx with no
// transaction, or one whose transfer was not proven, stays counted.
//
// Keyed by the payload's authorization object when it has one: a scheme that
// enriches the settle payload copies the payload but keeps that object, so the
// note and the failure hook find the same key.
const pendingAnswers = new WeakMap(); // authorization (or payload) -> [{ host, at, tx, s5xx, lane, client, via }]
const keyOf = (payload) => {
  if (!payload || typeof payload !== "object") return null;
  const a = payload.payload?.authorization;
  return a && typeof a === "object" ? a : payload;
};
const laneNow = () => { try { const s = currentRequestScope(); return !s ? "background" : s.synthetic ? "synthetic" : "outside"; } catch { return "background"; } };

let clientSeq = 0;
/**
 * Wrap a facilitator client's settle so its pending answers are noted. Each
 * note names the client that answered it (`client`, an id per wrapped client)
 * and its label (`via`, the facilitator's name), so a transaction is booked
 * under the facilitator that named it.
 *
 * When a settle on this client succeeds for a payment that already holds
 * pending notes, the notes are taken. `onSettledAfterPending(notes)` gets the
 * ones THIS client answered (the library's own retry settled it on the same
 * facilitator), so their 5xx counts can be forgiven. `onSettledByOther(notes)`
 * gets the ones another client answered (a settle fallback succeeded after
 * them): their transactions were never proven, so their 5xx counts stay.
 */
export function notePendingSettleAnswers(client, url, { now = () => Date.now(), lane = laneNow, via = null, onSettledAfterPending = null, onSettledByOther = null } = {}) {
  if (!client || typeof client.settle !== "function" || client.settle.__a402PendingNoted) return client;
  let host = null;
  try { host = new URL(String(url)).host; } catch { return client; }
  const id = ++clientSeq;
  const label = via == null ? null : String(via).slice(0, 60);
  const note = (payload, answer, s5xx) => {
    try {
      const k = keyOf(payload);
      const tx = pendingSettleTxOf(answer);
      if (!k || !tx || isGatewayBatchedPayment(payload)) return;
      const list = pendingAnswers.get(k) || [];
      if (list.length < MAX_NOTES) list.push({ host, at: now(), tx, s5xx: !!s5xx, lane: lane(), client: id, via: label });
      pendingAnswers.set(k, list);
    } catch { /* bookkeeping only */ }
  };
  const orig = client.settle;
  const wrapped = async function settle(payload, ...rest) {
    let result;
    try {
      result = await orig.call(this ?? client, payload, ...rest);
    } catch (err) {
      note(payload, err, Number(err?.statusCode) >= 500);
      throw err;
    }
    try {
      if (result && result.success === false) note(payload, result, false);
      else if (result && result.success === true && (typeof onSettledAfterPending === "function" || typeof onSettledByOther === "function")) {
        const notes = takePendingAnswers(payload);
        const mine = notes.filter((n) => n.client === id);
        const others = notes.filter((n) => n.client !== id);
        if (mine.length && typeof onSettledAfterPending === "function") onSettledAfterPending(mine, payload);
        if (others.length && typeof onSettledByOther === "function") onSettledByOther(others, payload);
      }
    } catch { /* bookkeeping only */ }
    return result;
  };
  wrapped.__a402PendingNoted = true;
  client.settle = wrapped;
  return client;
}

/** The pending answers noted for this payload, left in place. */
export function peekPendingAnswers(payload) {
  const k = keyOf(payload);
  return k ? [...(pendingAnswers.get(k) || [])] : [];
}

/** The pending answers noted for this payload, cleared as they are read. */
export function takePendingAnswers(payload) {
  const k = keyOf(payload);
  if (!k) return [];
  const list = pendingAnswers.get(k) || [];
  pendingAnswers.delete(k);
  return list;
}
