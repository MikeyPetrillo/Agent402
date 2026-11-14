// Chain truth for a referral settlement whose outcome the facilitator did not
// state (src/referral-gate.js): did the buyer's authorization PAY us?
//
// `authorizationState(authorizer, nonce)` on Base USDC says only that the
// nonce is spent, and EIP-3009 spends one nonce space from three calls: the
// receive this route asks for, a transfer the buyer signs to anyone, and a
// cancel. A buyer can sign our ReceiveWithAuthorization, let the tool run and
// then burn the nonce with a cancel or a transfer to itself. So "used" is
// never "paid". A payment has landed only when the RECEIPT of the transaction
// that used the nonce shows status success and a USDC Transfer from the payer
// to the pay-to address of at least the amount (evmTransferredInReceipt,
// src/payment-verify.js). The transaction is the one carrying the token's
// AuthorizationUsed(authorizer, nonce) log, looked up in a bounded range of
// recent blocks; an AuthorizationCanceled log for the same pair is proof it
// was not paid.
//
//   paid: true    the receipt proves the transfer
//   paid: false   the nonce is spent and the proof says it did not pay us
//                 (a canceled authorization, a transaction that moved less,
//                 or to someone else, or reverted)
//   paid: null    spent, proof not readable yet (`logsRead` says whether the
//                 log range was read and held no log for this pair)
//
// Bounded: a few tries inside a short budget, each read with its own timeout
// (the shared JSON-RPC reader). A read that fails is "unknown" (used: null),
// never "unused": only an explicit false says the nonce is not spent, and
// even that is final only once the authorization has expired.
import { keccak256, toHex } from "viem";
import { rpc, evmTransferredInReceipt } from "./payment-verify.js";
import { authorizationStateCalldata, evmRpcUrlFor } from "./evm-authorization-state.js";
import { AUTHORIZATION_USED_TOPIC } from "./pending-settle.js";
import { USDC_DOMAIN_BY_NETWORK } from "./evm-usdc-domain.js";

const TOKEN = USDC_DOMAIN_BY_NETWORK["eip155:8453"].asset;
const TX = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const AUTHORIZATION_CANCELED_TOPIC = keccak256(toHex("AuthorizationCanceled(address,bytes32)"));
const topicOf = (addr) => `0x${"0".repeat(24)}${String(addr).slice(2).toLowerCase()}`;
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/**
 * @param {object} [o]
 * @param {string} [o.rpcUrl]          the Base RPC (AGENT402_BASE_RPC, else the public one)
 * @param {number} [o.tries]           reads of authorizationState per call
 * @param {number} [o.budgetMs]        the whole call ends inside this
 * @param {number} [o.timeoutMs]       one RPC read
 * @param {number} [o.lookbackBlocks]  how far back the log is looked for (Base: about 2 s a block)
 */
export function createReferralChainReader({ rpcUrl = evmRpcUrlFor("base"), tries = 3, budgetMs = 8_000, timeoutMs = 2_500, pauseMs = 1_000, lookbackBlocks = 900, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const read = (method, params, left) => rpc(rpcUrl, method, params, fetchImpl, Math.max(250, Math.min(timeoutMs, left)), []);

  /** The log of `topic` for (authorizer, nonce) in the range read:
   *  `{ read, tx }` (`read` false when the range could not be read). */
  async function logOf(topic, authorizer, nonce, left) {
    try {
      const head = BigInt(await read("eth_blockNumber", [], left));
      const from = head > BigInt(lookbackBlocks) ? head - BigInt(lookbackBlocks) : 0n;
      const logs = await read("eth_getLogs", [{ address: TOKEN, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${head.toString(16)}`, topics: [topic, topicOf(authorizer), String(nonce).toLowerCase()] }], left);
      if (!Array.isArray(logs)) return { read: false, tx: null };
      const hit = logs.find((l) => TX.test(String(l?.transactionHash || "")) && String(l?.address || "").toLowerCase() === TOKEN.toLowerCase());
      return { read: true, tx: hit ? String(hit.transactionHash).toLowerCase() : null };
    } catch { return { read: false, tx: null }; }
  }

  /** Whether the transaction's receipt proves the payment: true, false, or null when it cannot be read. */
  async function receiptPays(tx, { from, payTo, amount }, left) {
    let receipt;
    try { receipt = await read("eth_getTransactionReceipt", [tx], left); } catch { return null; }
    if (!receipt || typeof receipt !== "object") return null;
    if (String(receipt.status || "").toLowerCase() !== "0x1") return false;
    let need;
    try { need = BigInt(amount); } catch { return false; }
    if (!(need > 0n) || !ADDR.test(String(payTo || "")) || !ADDR.test(String(from || ""))) return false;
    return evmTransferredInReceipt(receipt, { token: TOKEN, from, toSet: new Set([payTo]) }) >= need;
  }

  /**
   * `{ used, paid, transaction, logsRead }` for an authorization that was to
   * pay `amount` (USDC base units) from `from` to `payTo`:
   *   used false                 the nonce is not spent as of this read
   *   used null                  no read answered
   *   used true, paid true       the receipt of `transaction` proves the payment
   *   used true, paid false      spent without paying (`transaction` is the one that spent it, when found)
   *   used true, paid null       spent, proof not read (`logsRead`: the log range was read and held nothing)
   * `wait`: keep reading for a spent nonce until the budget ends (a
   * settlement that is still landing); a single false is returned at once
   * without it.
   */
  async function state({ from, nonce, payTo, amount }, { wait = false } = {}) {
    const none = { used: null, paid: null, transaction: null, logsRead: false };
    let data;
    try { data = authorizationStateCalldata(from, nonce); } catch { return none; }
    const started = now();
    const leftMs = () => Math.max(250, budgetMs - (now() - started));
    let last = null;
    for (let i = 0; i < tries; i++) {
      const left = budgetMs - (now() - started);
      if (left < 250) break;
      try {
        const r = await read("eth_call", [{ to: TOKEN, data }, "latest"], left);
        if (typeof r === "string" && /^0x[0-9a-fA-F]{64}$/.test(r)) {
          last = BigInt(r) !== 0n;
          if (last) {
            const usedLog = await logOf(AUTHORIZATION_USED_TOPIC, from, nonce, leftMs());
            if (usedLog.tx) return { used: true, paid: await receiptPays(usedLog.tx, { from, payTo, amount }, leftMs()), transaction: usedLog.tx, logsRead: true };
            const canceled = await logOf(AUTHORIZATION_CANCELED_TOPIC, from, nonce, leftMs());
            if (canceled.tx) return { used: true, paid: false, transaction: canceled.tx, logsRead: true };
            return { used: true, paid: null, transaction: null, logsRead: usedLog.read && canceled.read };
          }
          if (!wait) return { used: false, paid: null, transaction: null, logsRead: false };
        }
      } catch { /* the next try reads again */ }
      if (i < tries - 1) await sleep(Math.min(pauseMs, Math.max(0, budgetMs - (now() - started))));
    }
    return { ...none, used: last };
  }

  return { state };
}

/**
 * What a chain reading says about a settlement, in one word. The ONLY reading
 * that delivers an answer or books a sale is "paid".
 *   paid            the receipt proves the transfer to the pay-to address
 *   unpaid          the nonce is spent and did not pay us: a cancel, a
 *                   transfer elsewhere, a reverted or short transaction, or,
 *                   once the authorization has expired, a spent nonce with no
 *                   log of ours anywhere in the range that covers its life
 *   expired-unused  not spent, and past its validBefore: it never will be
 *   unused          not spent yet (it still can be)
 *   unknown         nothing readable, or spent with the proof not read yet
 */
export function chainVerdict(s, { validBeforeMs = 0, nowMs = Date.now(), slackMs = 120_000 } = {}) {
  const expired = validBeforeMs > 0 && nowMs > validBeforeMs + slackMs;
  if (s?.used === true) {
    if (s.paid === true && TX.test(String(s.transaction || ""))) return "paid";
    if (s.paid === false) return "unpaid";
    if (s.logsRead === true && !s.transaction && expired) return "unpaid";
    return "unknown";
  }
  if (s?.used === false) return expired ? "expired-unused" : "unused";
  return "unknown";
}
