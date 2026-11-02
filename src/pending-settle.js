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
// So on an EVM exact (EIP-3009) settle failure that names a transaction and
// reads as pending, the transaction's receipt is polled here for a bounded
// time. The settlement is recovered with that transaction only when the
// receipt proves it is this payment:
//   mined with status 1,
//   carrying the asset's AuthorizationUsed(payer, nonce) log for THIS
//   authorization (one EIP-3009 nonce moves money once, so the transfer is
//   this payment's and no other's),
//   and moving at least the required amount of the asset from the signed payer
//   to the payTo of the requirements (evmTransferredInReceipt, the rule the
//   late-settlement book applies),
//   not already a recorded sale (read fresh from the ledger).
// The caller (src/payments.js) then claims the tx (src/settlement-claims.js),
// so one transfer answers one request and a tx the late book already booked
// owed is never served.
//
// Anything else keeps the path the failure always had: reverted, mined
// without that transfer or that authorization, not mined by the deadline, the
// RPC unreadable, or the buyer gone before the first byte. The failure stands
// (402), the late-settlement book books the tx, and a refund is owed only
// after on-chain proof. This module never settles: it only reads the chain.
//
// Bounds: the wait ends at the first of PENDING_SETTLE_RECEIPT_WAIT_MS
// (default 12 s: six Base blocks at 2 s, past the few seconds a broadcast
// transfer takes to be included when the chain is healthy), the request's CDN
// answer window less a margin (src/cdn-sync-window.js), and the
// authorization's validBefore (mined after it, the transfer reverts). Polls
// every PENDING_SETTLE_POLL_MS (default 1.5 s).
//
// Not handled here: Robinhood 4663 (src/robinhood-outage.js and its own
// relayer), Arc 5042 (src/circle-pending.js), Tempo, Circle Gateway batched
// payments, Permit2 payloads, and any network without a configured RPC
// (src/evm-rpcs.js).
import { rpc, evmTransferredInReceipt } from "./payment-verify.js";
import { evmRpcFor } from "./evm-rpcs.js";
import { cdnSyncLeftMs } from "./cdn-sync-window.js";
import { clientGoneBeforeFirstByte } from "./hangup-settlement.js";

export const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
export const SETTLEMENT_PENDING_REASON = "settlement_pending";
const EXCLUDED_NETWORKS = new Set(["eip155:4663", "eip155:5042", "eip155:4217"]);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
// Kept before a CDN request's answer is cut off, for the answer itself.
export const CDN_MARGIN_MS = 3_000;
const CALL_TIMEOUT_MS = 4_000;

// Words a facilitator uses for a broadcast whose receipt it stopped waiting
// for. Read only together with a transaction hash.
const PENDING_WORDS = [
  /\bsettlement[_ ]pending\b/i,
  /\bdid not confirm in time\b/i,
  /\bcontext deadline exceeded\b/i,
  /\bnot (?:yet )?confirmed\b/i,
  /\b(?:receipt|confirmation) (?:wait )?timed? ?out\b/i,
];

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
/** The receipt wait, ms (PENDING_SETTLE_RECEIPT_WAIT_MS, at most 30 s; 0 turns the read off). */
export function pendingSettleWaitMs(env = process.env) { return Math.min(num(env.PENDING_SETTLE_RECEIPT_WAIT_MS, 12_000), 30_000); }
/** The poll interval, ms (PENDING_SETTLE_POLL_MS, 250 ms to 5 s). */
export function pendingSettlePollMs(env = process.env) { return Math.min(Math.max(num(env.PENDING_SETTLE_POLL_MS, 1_500), 250), 5_000); }

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

/** Whether this failure context is one this module reads. */
export function pendingSettleApplies(ctx, { rpcFor = evmRpcFor } = {}) {
  const rq = ctx?.requirements || {};
  const network = String(rq.network || "");
  if (!network.startsWith("eip155:") || EXCLUDED_NETWORKS.has(network)) return false;
  if (String(rq.scheme || "").toLowerCase() !== "exact") return false;
  if (!pendingSettleTxOf(ctx?.error)) return false;
  const a = ctx?.paymentPayload?.payload?.authorization;
  if (!a || !ADDR.test(String(a.from || "")) || !B32.test(String(a.nonce || ""))) return false;
  if (!ADDR.test(String(rq.payTo || "")) || !ADDR.test(String(rq.asset || ""))) return false;
  return !!rpcFor(network);
}

/** The receipt's verdict for this payment: "ours", or a reason it is not. */
export function judgePendingReceipt(receipt, { asset, payer, nonce, payTo, amount }) {
  if (String(receipt?.status) !== "0x1") return { ours: false, reason: `transaction did not succeed on chain (status ${receipt?.status})` };
  const tok = String(asset).toLowerCase();
  const used = (receipt.logs || []).some((l) => String(l?.address || "").toLowerCase() === tok
    && String(l?.topics?.[0] || "").toLowerCase() === AUTHORIZATION_USED_TOPIC
    && String(l?.topics?.[1] || "").toLowerCase() === topicOf(payer)
    && String(l?.topics?.[2] || "").toLowerCase() === String(nonce).toLowerCase());
  if (!used) return { ours: false, reason: "the transaction did not use this payment's authorization" };
  let required;
  try { required = BigInt(amount); } catch { return { ours: false, reason: "requirements amount unreadable" }; }
  const moved = evmTransferredInReceipt(receipt, { token: asset, from: payer, toSet: [payTo] });
  if (moved === 0n || moved < required) return { ours: false, reason: `the transaction moved ${moved} of ${required} from the payer to our payTo` };
  return { ours: true };
}

/**
 * Read the named transaction's receipt for a bounded time. Answers
 * `{ recovered: true, result }` (the caller still claims the tx) or
 * `{ recovered: false, reason }`.
 */
export async function confirmPendingSettle(ctx, {
  rpcFor = evmRpcFor,
  fetchImpl = fetch,
  waitMs = pendingSettleWaitMs(),
  pollMs = pendingSettlePollMs(),
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  clientGone = clientGoneBeforeFirstByte,
  saleByTx = null,
} = {}) {
  if (!pendingSettleApplies(ctx, { rpcFor })) return { recovered: false, reason: "not a pending EVM exact settle with a transaction" };
  const rq = ctx.requirements;
  const network = String(rq.network);
  const tx = pendingSettleTxOf(ctx.error);
  const auth = ctx.paymentPayload.payload.authorization;
  const req = reqOf(ctx);
  const gone = () => !!(req && clientGone(req));
  if (gone()) return { recovered: false, reason: "the buyer left before the answer" };
  const url = rpcFor(network);
  const started = now();
  const vb = Number(auth.validBefore);
  const authLeft = Number.isFinite(vb) && vb > 0 && vb < 1e10 ? vb * 1000 - started : Infinity;
  const cdnLeft = cdnSyncLeftMs(req, started);
  const budget = Math.max(0, Math.min(waitMs, authLeft, cdnLeft == null ? Infinity : cdnLeft - CDN_MARGIN_MS));
  const deadline = started + budget;
  if (budget <= 0) return { recovered: false, reason: "no time left to read the transaction" };
  let lastReason = "transaction not mined within the wait";
  for (;;) {
    const left = deadline - now();
    if (left <= 0) break;
    let receipt;
    try {
      receipt = await rpc(url, "eth_getTransactionReceipt", [tx], fetchImpl, Math.min(CALL_TIMEOUT_MS, left), []);
    } catch (e) {
      lastReason = `could not read the chain: ${String(e?.message || e).slice(0, 120)}`;
      receipt = undefined;
    }
    if (receipt) {
      // The chain has answered: waiting longer cannot change the verdict.
      const v = judgePendingReceipt(receipt, { asset: rq.asset, payer: auth.from, nonce: auth.nonce, payTo: rq.payTo, amount: rq.amount });
      if (!v.ours) return { recovered: false, reason: v.reason };
      if (gone()) return { recovered: false, reason: "the buyer left before the answer" };
      let lookup = saleByTx;
      if (!lookup) lookup = (await import("./sales-ledger.js")).saleByTxFresh;
      let sold = null;
      try { sold = await lookup(tx); } catch (e) { return { recovered: false, reason: `could not read the sales ledger: ${String(e?.message || e).slice(0, 80)}` }; }
      if (sold) return { recovered: false, reason: "the transaction is already a recorded sale" };
      return { recovered: true, result: { success: true, transaction: tx, network, payer: auth.from } };
    }
    if (receipt === null) lastReason = "transaction not mined within the wait";
    if (gone()) return { recovered: false, reason: "the buyer left before the answer" };
    if (now() + pollMs >= deadline) break;
    await sleep(pollMs);
  }
  return { recovered: false, reason: lastReason };
}

// ---- the upstream-health count --------------------------------------------
// A facilitator that answers pending as an HTTP 5xx is counted s5xx by the
// egress meter's observer (src/tool-failure-monitor.js) when the response
// arrives, before anyone knows the transfer landed. Each such answer is noted
// on the payment payload it settled, and a recovery moves those counts back
// to ok (forgiveUpstream). A 5xx with no transaction, or one whose transfer
// was not proven, stays counted.
const pendingAnswers = new WeakMap(); // paymentPayload -> [{ host, at }]

/** Wrap a facilitator client's settle so its pending 5xx answers are noted. */
export function notePendingSettleAnswers(client, url, { now = () => Date.now() } = {}) {
  if (!client || typeof client.settle !== "function" || client.settle.__a402PendingNoted) return client;
  let host = null;
  try { host = new URL(String(url)).host; } catch { return client; }
  const orig = client.settle;
  const wrapped = async function settle(payload, ...rest) {
    try {
      return await orig.call(this ?? client, payload, ...rest);
    } catch (err) {
      try {
        if (payload && typeof payload === "object" && Number(err?.statusCode) >= 500 && pendingSettleTxOf(err)) {
          const list = pendingAnswers.get(payload) || [];
          if (list.length < 8) list.push({ host, at: now() });
          pendingAnswers.set(payload, list);
        }
      } catch { /* bookkeeping only */ }
      throw err;
    }
  };
  wrapped.__a402PendingNoted = true;
  client.settle = wrapped;
  return client;
}

/** The pending 5xx answers noted for this payload, cleared as they are read. */
export function takePendingAnswers(payload) {
  if (!payload || typeof payload !== "object") return [];
  const list = pendingAnswers.get(payload) || [];
  pendingAnswers.delete(payload);
  return list;
}
