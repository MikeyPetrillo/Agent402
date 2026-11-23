// Chain truth for a referral settlement (src/referral-gate.js): did the
// buyer's authorization PAY US?
//
// `authorizationState(authorizer, nonce)` on Base USDC says only that the
// nonce is spent, and EIP-3009 spends one nonce space from three calls: the
// receive this route asks for, a transfer the buyer signs to anyone, and a
// cancel. So "used" is never "paid". And the authorization names only the
// referral network's split contract, which pays whichever merchant its
// caller names: money that reached the contract is not yet money routed to
// this merchant. A payment is OURS only when one receipt shows all of it
// (receiptProvesPayment):
//   1. the token's AuthorizationUsed(from, nonce) log, followed directly by
//      a Transfer from the payer to the split contract of at least the amount;
//   2. before the next authorization in that transaction, the split
//      contract's own routed-payment event naming this buyer, this gross
//      amount and OUR merchant id, with a token Transfer from the contract to
//      our payout wallet of the merchant amount that event states, which is
//      at least the expected net. Nothing stands in for the event.
// The event routed to another merchant is "unpaid" (not ours). A shape this
// module does not recognize (no event it can decode, an event of ours
// without its payout transfer or under the expected net, a transaction not
// sent to the contract) is "unknown": never paid and never unpaid.
// The facilitator's own "success" is checked the same way before an answer
// is delivered.
//
// The transaction is found by its AuthorizationUsed log, searched page by
// page from the chain head recorded BEFORE the payment was verified (nothing
// can have spent the nonce earlier, and a read made long after still covers
// it) to the head now; an AuthorizationCanceled log for the same pair proves
// it was not paid. A spent nonce whose log is not found stays UNKNOWN while
// the authorization lives or the search was partial; once it has expired, a
// COMPLETE search from that recorded head that found neither log closes it
// as not paid (it was spent outside anything this route started). A spent
// nonce whose transaction WAS found, with a receipt read in full that the
// rule does not recognize, is reported so (`receiptRead`): the book closes
// it to an operator record after enough such reads (src/referral-book.js),
// never as paid and never as a refund.
//
// Bounded: a few tries inside a budget, each read with its own timeout, over
// the configured Base RPCs then public ones (rpcCall; public log lanes first
// for recent ranges, evmLogsRead). A read that fails is "unknown" (used:
// null), never "unused": only an explicit false says the nonce is not spent,
// and even that is final only once the authorization has expired.
import { keccak256, toHex } from "viem";
import { rpcCall } from "./revenue-live.js";
import { evmLogsRead } from "./evm-logs-rpc.js";
import { authorizationStateCalldata } from "./evm-authorization-state.js";
import { AUTHORIZATION_USED_TOPIC } from "./pending-settle.js";
import { USDC_DOMAIN_BY_NETWORK } from "./evm-usdc-domain.js";
import { receiptProvesPayment, proveReceipt, ROUTED_EVENT_TOPIC, ROUTED_EVENT_SIGNATURE } from "./referral-proof.js";

export { receiptProvesPayment, proveReceipt, ROUTED_EVENT_TOPIC, ROUTED_EVENT_SIGNATURE };

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
/** The Base RPCs a read walks, in order: the configured ones, then public ones. */
export function baseRpcUrls(env = process.env) {
  const list = [env.AGENT402_BASE_RPC, env.EVM_RPC_8453, "https://mainnet.base.org", "https://base-rpc.publicnode.com"]
    .map((u) => String(u || "").trim()).filter(Boolean);
  return [...new Set(list)];
}

const lc = (v) => String(v ?? "").toLowerCase();

/**
 * @param {object} o
 * @param {string[]} [o.rpcUrls]       the RPCs read in order (baseRpcUrls() by default)
 * @param {string} [o.rpcUrl]          one RPC (tests)
 * @param {Array} [o.publicLanes]      public log lanes for evmLogsRead (default: the module's own; [] for none)
 * @param {number} [o.tries]           reads of authorizationState per call
 * @param {number} [o.budgetMs]        the whole call ends inside this
 * @param {number} [o.timeoutMs]       one RPC read
 * @param {number} [o.lookbackBlocks]  the range read when no starting block is known
 * @param {number} [o.pageBlocks]      blocks per getLogs page
 * @param {number} [o.maxPages]        pages per search
 * @param {string} [o.merchantId]      our merchant id on the split contract (decimal)
 * @param {string} [o.payoutAddress]   the wallet the contract pays our merchant amount to
 * @param {string} [o.routedTopic]     the routed-payment event topic (the documented one by default)
 */
export function createReferralChainReader({ rpcUrls = null, rpcUrl = null, publicLanes = undefined, tries = 3, budgetMs = 15_000, timeoutMs = 3_000, pauseMs = 1_000, lookbackBlocks = 900, pageBlocks = 2_000, maxPages = 30, merchantId = null, payoutAddress = null, routedTopic = ROUTED_EVENT_TOPIC, headMaxAgeMs = 5_000, now = Date.now } = {}) {
  const rpcs = rpcUrls && rpcUrls.length ? rpcUrls : rpcUrl ? [rpcUrl] : baseRpcUrls();
  const read = (method, params, left) => rpcCall(rpcs, method, params, Math.max(250, Math.min(timeoutMs, left)));
  const routing = { merchantId, payoutAddress, routedTopic };

  /** The chain head, or null when no RPC answers. A reading up to
   *  `headMaxAgeMs` old is reused: a search that starts a few blocks early
   *  covers more, never less. */
  let lastHead = { at: 0, h: null };
  async function head({ budget = 3_000, fresh = false } = {}) {
    if (!fresh && lastHead.h !== null && now() - lastHead.at < headMaxAgeMs) return lastHead.h;
    try {
      const h = Number(BigInt(await read("eth_blockNumber", [], budget)));
      if (!Number.isSafeInteger(h) || h <= 0) return null;
      lastHead = { at: now(), h };
      return h;
    } catch { return null; }
  }

  /** The first transaction carrying the log `topic` for (authorizer, nonce),
   *  searched page by page from `fromBlock` (else the lookback) to the head:
   *  `{ complete, tx }`. `complete` is false when a page could not be read or
   *  the budget ran out first. */
  async function findLog(topic, authorizer, nonce, fromBlock, deadline) {
    let h;
    try { h = Number(BigInt(await read("eth_blockNumber", [], deadline - now()))); } catch { return { complete: false, tx: null }; }
    let start = Number.isSafeInteger(fromBlock) && fromBlock > 0 ? fromBlock : Math.max(0, h - lookbackBlocks);
    for (let page = 0; start <= h; page++) {
      if (page >= maxPages || deadline - now() < 250) return { complete: false, tx: null };
      const end = Math.min(h, start + pageBlocks - 1);
      const filter = { address: TOKEN, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}`, topics: [topic, topicOf(authorizer), lc(nonce)] };
      let logs;
      try {
        logs = await evmLogsRead(filter, { caller: "referral", chain: "base", rpcs, head: h, maxDepthBlocks: 9_000, timeoutMs: Math.max(250, Math.min(timeoutMs * 2, deadline - now())), ...(publicLanes !== undefined ? { lanes: publicLanes } : {}) });
      } catch { return { complete: false, tx: null }; }
      if (!Array.isArray(logs)) return { complete: false, tx: null };
      const hit = logs.find((l) => TX.test(String(l?.transactionHash || "")) && lc(l?.address) === lc(TOKEN));
      if (hit) return { complete: true, tx: lc(hit.transactionHash) };
      start = end + 1;
    }
    return { complete: true, tx: null };
  }

  /** Whether transaction `tx` paid this authorization to OUR merchant
   *  (receiptProvesPayment): "paid" | "unpaid" | "unknown" (no receipt
   *  readable, or a shape not recognized). `waitMs`: keep asking for a
   *  receipt that is not there yet for this long. */
  async function proveTransaction(tx, args, opts) {
    return (await proveDetail(tx, args, opts)).verdict;
  }
  /** The same reading with its detail: `{ verdict, why, moved, read }`
   *  (proveReceipt). `read` false: no receipt could be read. */
  async function proveDetail(tx, { from, nonce = null, payTo, amount, minNet = null, productId = null }, { budget = 4_000, waitMs = 0 } = {}) {
    if (!TX.test(String(tx || ""))) return { verdict: "unpaid", why: "no transaction hash", moved: false, read: false, routedToUs: false, net: null };
    const until = now() + Math.max(0, waitMs);
    for (;;) {
      let receipt = null;
      try { receipt = await read("eth_getTransactionReceipt", [tx], budget); } catch { receipt = null; }
      if (receipt) return proveReceipt(receipt, { tx, from, nonce, payTo, amount, minNet, productId, ...routing });
      if (now() + 400 >= until) return { verdict: "unknown", why: "no receipt readable", moved: false, read: false, routedToUs: false, net: null };
      await sleep(400);
    }
  }

  /**
   * `{ used, paid, transaction }` for an authorization that was to pay
   * `amount` (USDC base units) from `from` to `payTo`:
   *   used false                 the nonce is not spent as of this read
   *   used null                  no read answered
   *   used true, paid true       ITS OWN transfer in `transaction` proves the payment
   *   used true, paid false      spent without paying: a cancel, or the
   *                              transaction that used it did not pay this
   *                              authorization (receiptProvesPayment)
   *   used true, paid null       spent, proof not read (the log not found in
   *                              what could be read, the receipt unreadable or
   *                              of an unrecognized shape). `complete` true
   *                              says both log searches covered every block
   *                              from the recorded head and found nothing;
   *                              `receiptRead` true says the transaction's
   *                              receipt WAS read in full and is not a shape
   *                              the rule recognizes; `routedToUs` true says
   *                              that receipt's routed event names our
   *                              merchant id all the same
   * `net`: on paid, the merchant amount the receipt shows (base units).
   * `fromBlock`: the head when the intent was written; the search runs from
   * there to the head, so a late read still finds an early payment.
   * `wait`: keep reading for a spent nonce until the budget ends.
   * `budgetMs`: this call's own budget, when under the reader's.
   */
  async function state({ from, nonce, payTo, amount, fromBlock = null, minNet = null, productId = null }, { wait = false, budgetMs: callBudgetMs = null } = {}) {
    const none = { used: null, paid: null, transaction: null, complete: false };
    // A search is complete only from a head recorded before the payment could be spent.
    const anchored = Number.isSafeInteger(fromBlock) && fromBlock > 0;
    let data;
    try { data = authorizationStateCalldata(from, nonce); } catch { return none; }
    const started = now();
    // `budgetMs` of one call: a caller with less time than the reader's own budget.
    const deadline = started + (Number.isFinite(callBudgetMs) && callBudgetMs > 0 ? Math.min(budgetMs, callBudgetMs) : budgetMs);
    let last = null;
    for (let i = 0; i < tries; i++) {
      const left = deadline - now();
      if (left < 250) break;
      try {
        const r = await read("eth_call", [{ to: TOKEN, data }, "latest"], left);
        if (typeof r === "string" && /^0x[0-9a-fA-F]{64}$/.test(r)) {
          last = BigInt(r) !== 0n;
          if (last) {
            const used = await findLog(AUTHORIZATION_USED_TOPIC, from, nonce, fromBlock, deadline);
            if (used.tx) {
              const d = await proveDetail(used.tx, { from, nonce, payTo, amount, minNet, productId }, { budget: Math.max(250, deadline - now()) });
              const v = d.verdict;
              return { used: true, paid: v === "paid" ? true : v === "unpaid" ? false : null, transaction: used.tx, complete: false, receiptRead: d.read === true, why: d.why, routedToUs: d.routedToUs === true, net: v === "paid" ? d.net ?? null : null, split: v === "paid" ? d.split ?? null : null, moved: d.moved === true, product: d.product || null };
            }
            const canceled = await findLog(AUTHORIZATION_CANCELED_TOPIC, from, nonce, fromBlock, deadline);
            if (canceled.tx) return { used: true, paid: false, transaction: canceled.tx, complete: false };
            return { used: true, paid: null, transaction: null, complete: anchored && used.complete === true && canceled.complete === true };
          }
          if (!wait) return { used: false, paid: null, transaction: null, complete: false };
        }
      } catch { /* the next try reads again */ }
      if (i < tries - 1) await sleep(Math.min(pauseMs, Math.max(0, deadline - now())));
    }
    return { ...none, used: last };
  }

  return { state, head, proveTransaction, proveDetail, routing: () => ({ ...routing }) };
}

/**
 * What a chain reading says about a settlement, in one word. The ONLY reading
 * that delivers an answer or books a sale is "paid".
 *   paid            ITS OWN transfer to the pay-to address is in the receipt
 *   unpaid          the nonce is spent and did not pay us: a cancel, or a
 *                   transaction that used it without its own transfer of the
 *                   amount to the pay-to address
 *   expired-unused  not spent, and past its validBefore: it never will be
 *   unused          not spent yet (it still can be)
 *   unknown         nothing readable, or spent with the proof not read yet
 * A spent nonce with no log of either kind is "unpaid" only once the
 * authorization has expired AND the search from the head recorded before it
 * was verified was complete (`s.complete`): it was spent outside this route.
 */
export function chainVerdict(s, { validBeforeMs = 0, nowMs = Date.now(), slackMs = 120_000 } = {}) {
  const expired = validBeforeMs > 0 && nowMs > validBeforeMs + slackMs;
  if (s?.used === true) {
    if (s.paid === true && TX.test(String(s.transaction || ""))) return "paid";
    if (s.paid === false) return "unpaid";
    if (s.paid === null && s.transaction == null && s.complete === true && expired) return "unpaid";
    return "unknown";
  }
  if (s?.used === false) return expired ? "expired-unused" : "unused";
  return "unknown";
}
