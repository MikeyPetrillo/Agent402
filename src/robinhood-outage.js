// Robinhood (eip155:4663) settlement when a listed facilitator's answer is
// AMBIGUOUS: a 5xx, a timeout, a transport error, or a failed answer that
// names no transaction and no payment verdict. Such a facilitator may have
// broadcast, so the settle chain used to stop there and the buyer got a 402
// even when the transfer landed a moment later.
//
// With our own relayer configured, the buyer's EIP-3009 authorization is read
// on chain instead of guessed at:
//   1. authorizationState(from, nonce) is polled for a short window, bounded
//      by the authorization's own settle deadline and the CDN answer window.
//   2. Used: the transaction that used it (its AuthorizationUsed log) must
//      carry the payment's Transfer from the payer to our treasury in USDG.
//      With that proof the payment is SETTLED with that transaction (the
//      caller claims it, so it is never served twice or booked owed). Used
//      with no such transfer: refused, and nobody else is asked.
//   3. Still unused: our relayer submits it (it re-reads authorizationState
//      under its own lock before signing). If it does not settle, the chain is
//      read once more, in case the facilitator's transfer landed meanwhile.
//   4. Any read failure (a receipt that cannot be read yet included), or a
//      refusal while the authorization can still be used: refused (402) and
//      the AUTHORIZATION is booked in the late-settlement book
//      (src/late-settlements.js), which finds whatever transaction later uses
//      it and books it owed.
// Bounds: the wait in (1) ends inside the authorization's settle deadline and
// the CDN answer window. Our relayer in (3) is skipped (the authorization is
// booked instead) when the buyer left holding a forgiveness ticket, when the
// authorization's deadline leaves it no time, or when a CDN request's window
// is shorter than the relayer's worst case (its lock wait plus its receipt
// wait); the relayer's own steps are bounded by those two settings.
//
// One EIP-3009 nonce moves money at most once, so no path here can charge a
// buyer twice; the claims make sure one transfer answers one request.

import { keccak256, toHex, encodeFunctionData, parseAbi } from "viem";
import { rpc, evmTransferredInReceipt } from "./payment-verify.js";
import { cdnSyncLeftMs } from "./cdn-sync-window.js";
import { SETTLE_RULE_SECONDS } from "./evm-validity.js";
import { chargeCancelledForClientGone } from "./hangup-settlement.js";
import { relayerSettings } from "./robinhood-relayer.js";

export const AUTHORIZATION_USED_TOPIC = keccak256(toHex("AuthorizationUsed(address,bytes32)"));
const STATE_ABI = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;
const RPC_TIMEOUT_MS = 6_000;
// Margin kept before the authorization's settle deadline for our relayer to
// sign, send and have the transfer mined.
const RELAYER_MARGIN_MS = 4_000;
// Margin kept before a CDN request's answer is cut off.
const CDN_MARGIN_MS = 3_000;
const LOG_CHUNK_BLOCKS = 10_000;

export function ambiguousWaitMs(env = process.env) {
  const n = Number(env.ROBINHOOD_AMBIGUOUS_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 60_000) : 8_000;
}

/**
 * A facilitator verdict about the payment itself (a bad signature, too little
 * balance, an expired window): definite, so nothing is waited on or retried.
 * A reverted transfer with no hash is not ambiguous either (the revert-retry
 * rule in src/payments.js owns it).
 */
function isPaymentVerdict(reason) {
  const r = String(reason || "");
  if (!r) return false;
  if (r === "invalid_exact_evm_transaction_failed") return false;
  return /^invalid_/.test(r) || /insufficient_funds|unsupported_scheme|unsupported_network|invalid_payload/.test(r);
}

/**
 * True for a settle failure whose outcome is unknown: no transaction named,
 * and either a transport failure, an HTTP 5xx, or a failed answer that carries
 * no payment verdict. `isPreBroadcast` and `isRevertRetry` are the payments
 * module's own classifiers, passed in so this module never disagrees with them.
 */
export function isAmbiguousSettleFailure(err, { isPreBroadcast = () => false, isRevertRetry = () => false } = {}) {
  if (!err || typeof err !== "object") return false;
  if (typeof err.transaction === "string" && err.transaction.trim()) return false;
  if (isPreBroadcast(err) || isRevertRetry(err)) return false;
  return !isPaymentVerdict(err.errorReason);
}

const authOf = (payload) => {
  const a = payload?.payload?.authorization;
  if (!a || !ADDR.test(String(a.from || "")) || !NONCE.test(String(a.nonce || ""))) return null;
  return a;
};

/** The block whose timestamp is at or just before `tMs`, estimated from the
 *  head and a block `probe` blocks back (an over-estimate of the range is
 *  safe: the lookup only widens). */
export async function blockNear(call, tMs, probe = 1000) {
  const head = Number(BigInt(await call("eth_blockNumber", [])));
  const hb = await call("eth_getBlockByNumber", [toHex(head), false]);
  const back = Math.max(0, head - probe);
  const pb = await call("eth_getBlockByNumber", [toHex(back), false]);
  const ht = Number(BigInt(hb?.timestamp ?? "0x0")), pt = Number(BigInt(pb?.timestamp ?? "0x0"));
  const perBlock = head > back && ht > pt ? (ht - pt) / (head - back) : 1;
  const behindS = Math.max(0, ht - Math.floor(tMs / 1000));
  return { head, from: Math.max(0, head - Math.ceil(behindS / perBlock) - 10) };
}

/**
 * The transaction that used (authorizer, nonce) on `token`, from its
 * AuthorizationUsed log, searched from `fromBlock` to `toBlock` in chunks of at
 * most LOG_CHUNK_BLOCKS and at most `maxBlocks` in all. Answers
 * { tx, scannedTo } (tx null when not found in the range). Throws on a read
 * failure.
 */
export async function findAuthorizationTx(call, { token, authorizer, nonce, fromBlock, toBlock, maxBlocks = 200_000 }) {
  const topics = [AUTHORIZATION_USED_TOPIC, `0x${String(authorizer).slice(2).toLowerCase().padStart(64, "0")}`, String(nonce).toLowerCase()];
  const end = Math.min(toBlock, fromBlock + maxBlocks - 1);
  for (let a = fromBlock; a <= end; a += LOG_CHUNK_BLOCKS) {
    const b = Math.min(end, a + LOG_CHUNK_BLOCKS - 1);
    const logs = await call("eth_getLogs", [{ address: token, fromBlock: toHex(a), toBlock: toHex(b), topics }]);
    const hit = (Array.isArray(logs) ? logs : []).find((l) => TX.test(String(l?.transactionHash || "")) && !l.removed);
    if (hit) return { tx: String(hit.transactionHash).toLowerCase(), scannedTo: b };
  }
  return { tx: null, scannedTo: end };
}

export async function authorizationUsed(call, token, authorizer, nonce) {
  const data = encodeFunctionData({ abi: STATE_ABI, functionName: "authorizationState", args: [authorizer, nonce] });
  const out = await call("eth_call", [{ to: token, data }, "latest"]);
  return BigInt(out || "0x0") !== 0n;
}

/**
 * @param {object} o
 * @param {string} o.network   eip155:4663
 * @param {string} o.token     USDG
 * @param {string} o.treasury  our payTo on 4663
 * @param {string} o.rpcUrl    the chain's JSON-RPC endpoint
 * @param {object} o.relayer   our own relayer client ({ settle })
 */
export function createRobinhoodOutage({ network, token, treasury, rpcUrl, relayer, waitMs = ambiguousWaitMs(), pollMs = 1_000,
  relayerWorstMs = (() => { const s = relayerSettings(); return s.lockWaitMs + s.receiptTimeoutMs; })(),
  clientGone = chargeCancelledForClientGone, fetchImpl = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.warn } = {}) {
  if (!rpcUrl) throw new Error("no RPC for eip155:4663");
  const tok = String(token).toLowerCase(), ours = String(treasury).toLowerCase();
  const call = (method, params) => rpc(rpcUrl, method, params, fetchImpl, RPC_TIMEOUT_MS, []);

  /** Proof that (from, nonce) moved at least `amount` of USDG to our treasury:
   *  the transaction hash, or null when it moved nothing of ours. Throws on a
   *  read failure. */
  async function proofOf(auth, amount, sinceMs) {
    const { head, from } = await blockNear(call, sinceMs);
    const { tx } = await findAuthorizationTx(call, { token: tok, authorizer: auth.from, nonce: auth.nonce, fromBlock: from, toBlock: head });
    if (!tx) return { tx: null, found: false };
    const receipt = await call("eth_getTransactionReceipt", [tx]);
    // Not readable yet (the node has the log, not the receipt): unknown, never
    // read as a revert.
    if (!receipt) return { tx, found: true, unknown: true };
    if (String(receipt.status) !== "0x1") return { tx, found: true, ours: false };
    const moved = evmTransferredInReceipt(receipt, { token: tok, from: auth.from, toSet: [ours] });
    return { tx, found: true, ours: moved >= BigInt(amount) && moved > 0n };
  }

  return {
    network,
    /**
     * Handles one ambiguous failure. Answers null when it does not apply (not
     * our sale on 4663, or no EIP-3009 authorization), else one of
     *   { served: true, result }                 settled; the caller claims it
     *   { refused: true, lateAuth | null, reason }
     */
    async handle(ctx) {
      const rq = ctx?.requirements || {};
      if (rq.network !== network || String(rq.asset || "").toLowerCase() !== tok || String(rq.payTo || "").toLowerCase() !== ours) return null;
      const auth = authOf(ctx?.paymentPayload);
      if (!auth) return null;
      const amount = String(rq.amount ?? "");
      if (!/^[0-9]{1,30}$/.test(amount)) return null;
      const req = ctx?.transportContext?.request?.adapter?.req;
      const startedAt = now();
      // Look back far enough for a facilitator that broadcast before this
      // hook ran (its settle call is part of this same request).
      const sinceMs = startedAt - 5 * 60_000;
      const lateAuth = { payer: auth.from, nonce: auth.nonce, validBefore: auth.validBefore ?? null, via: "ambiguous facilitator" };
      const served = (tx) => ({ served: true, result: { success: true, transaction: tx, network, payer: auth.from } });
      const settleLeft = () => {
        const vb = Number(auth.validBefore);
        const authLeft = Number.isFinite(vb) && vb > 0 && vb < 1e10 ? vb * 1000 - now() - SETTLE_RULE_SECONDS * 1000 : Infinity;
        const cdnLeft = cdnSyncLeftMs(req, now());
        return Math.min(authLeft, cdnLeft == null ? Infinity : cdnLeft - CDN_MARGIN_MS);
      };
      // The wait ends while our relayer still has time to submit.
      const waitUntil = startedAt + Math.max(0, Math.min(waitMs, settleLeft() - RELAYER_MARGIN_MS));

      const judgeUsed = async () => {
        const p = await proofOf(auth, amount, sinceMs);
        if (p.ours) return served(p.tx);
        if (!p.found) return { refused: true, lateAuth, reason: "used, its transaction not found yet" };
        if (p.unknown) return { refused: true, lateAuth, reason: `used by tx ${p.tx}, its receipt not readable yet` };
        return { refused: true, lateAuth: null, reason: `used by tx ${p.tx} without this payment's transfer to us` };
      };

      try {
        for (;;) {
          if (await authorizationUsed(call, tok, auth.from, auth.nonce)) return await judgeUsed();
          if (now() + pollMs > waitUntil) break;
          await sleep(pollMs);
        }
      } catch (e) {
        log(`[rh-outage] chain read failed for ${auth.from} nonce ${auth.nonce}: ${String(e?.message || e).slice(0, 120)}; refused, the authorization is booked`);
        return { refused: true, lateAuth, reason: "chain read failed" };
      }

      if (settleLeft() <= RELAYER_MARGIN_MS) return { refused: true, lateAuth, reason: "no time left for our relayer before the authorization's deadline" };
      // The buyer left holding a forgiveness ticket: no money is moved for
      // them. The authorization stays booked, so a facilitator transfer that
      // still lands is recorded as owed.
      if (req && clientGone(req)) return { refused: true, lateAuth, reason: "the buyer left (forgiven); our relayer is not used" };
      const cdnLeft = cdnSyncLeftMs(req, now());
      if (cdnLeft != null && cdnLeft - CDN_MARGIN_MS < relayerWorstMs) return { refused: true, lateAuth, reason: "the CDN answer window is shorter than our relayer's worst case" };
      let r;
      try { r = await relayer.settle(ctx.paymentPayload, rq); } catch (e) { r = { success: false, errorReason: "relayer_error", errorMessage: String(e?.message || e) }; }
      if (r?.success === true && TX.test(String(r.transaction || ""))) return served(String(r.transaction).toLowerCase());
      // Our relayer did not settle it: the facilitator's transfer may have
      // landed meanwhile (our attempt was then refused or a no-op).
      try {
        if (await authorizationUsed(call, tok, auth.from, auth.nonce)) return await judgeUsed();
      } catch (e) {
        log(`[rh-outage] chain re-read failed after our relayer for ${auth.from} nonce ${auth.nonce}: ${String(e?.message || e).slice(0, 120)}`);
      }
      return { refused: true, lateAuth, reason: `our relayer did not settle it (${r?.errorReason || "no reason"})` };
    },
  };
}
