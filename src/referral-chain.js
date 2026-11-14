// Chain truth for a referral settlement (src/referral-gate.js): did the
// buyer's authorization PAY us?
//
// `authorizationState(authorizer, nonce)` on Base USDC says only that the
// nonce is spent, and EIP-3009 spends one nonce space from three calls: the
// receive this route asks for, a transfer the buyer signs to anyone, and a
// cancel. So "used" is never "paid". An authorization is paid only by ITS OWN
// transfer: in the receipt of the transaction that used the nonce, the
// token's AuthorizationUsed(from, nonce) log followed directly by a Transfer
// from the payer to the pay-to address of at least the amount, in a
// successful transaction sent to the pay-to contract (receiptProvesPayment).
// The facilitator's own "success" is checked the same way before an answer
// is delivered.
//
// The transaction is found by its AuthorizationUsed log, searched page by
// page from the chain head recorded when the intent was written (so a read
// made long after still covers it) to the head now; an AuthorizationCanceled
// log for the same pair proves it was not paid. A spent nonce whose log is
// not found in what could be read stays UNKNOWN: absence is never proof.
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

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const lc = (v) => String(v ?? "").toLowerCase();
const blockOf = (l) => { const n = parseInt(String(l?.logIndex ?? ""), 16); return Number.isFinite(n) ? n : null; };

/**
 * Whether a receipt proves that THIS authorization paid `amount` from `from`
 * to `payTo`. Pure. "paid" | "unpaid" | "unknown".
 *
 * The token's receive path (FiatToken `_receiveWithAuthorization`: it requires
 * the caller to be the payee, marks the nonce used, then transfers) emits
 * AuthorizationUsed(from, nonce) and, as the very next log, Transfer(from,
 * payTo, value). So an authorization is proven paid only by ITS OWN pair:
 * the AuthorizationUsed log for this nonce, followed directly by a Transfer
 * of the token from the payer to the pay-to address of at least the amount.
 * A Transfer elsewhere in the transaction proves nothing about this nonce,
 * and one Transfer log can only ever follow one AuthorizationUsed log.
 * The receipt must also be the transaction asked about, have succeeded, and
 * have been sent to the pay-to contract (whose receive path is the only one
 * that pays it on behalf of a ReceiveWithAuthorization).
 */
export function receiptProvesPayment(receipt, { tx, from, nonce, payTo, amount }) {
  if (!receipt || typeof receipt !== "object") return "unknown";
  if (tx && lc(receipt.transactionHash) !== lc(tx)) return "unpaid";
  if (lc(receipt.status) !== "0x1") return "unpaid";
  if (lc(receipt.to) !== lc(payTo)) return "unpaid";
  let need;
  try { need = BigInt(amount); } catch { return "unpaid"; }
  if (!(need > 0n) || !ADDR.test(String(payTo || "")) || !ADDR.test(String(from || ""))) return "unpaid";
  const logs = Array.isArray(receipt.logs) ? [...receipt.logs].sort((a, b) => (blockOf(a) ?? 0) - (blockOf(b) ?? 0)) : [];
  for (let i = 0; i < logs.length; i++) {
    const l = logs[i];
    if (lc(l.address) !== lc(TOKEN) || lc(l.topics?.[0]) !== AUTHORIZATION_USED_TOPIC) continue;
    if (lc(l.topics?.[1]) !== topicOf(from) || lc(l.topics?.[2]) !== lc(nonce)) continue;
    const t = logs[i + 1];
    if (!t || lc(t.address) !== lc(TOKEN) || lc(t.topics?.[0]) !== TRANSFER_TOPIC) return "unpaid";
    if (blockOf(l) !== null && blockOf(t) !== null && blockOf(t) !== blockOf(l) + 1) return "unpaid";
    if (lc(t.topics?.[1]) !== topicOf(from) || lc(t.topics?.[2]) !== topicOf(payTo)) return "unpaid";
    let value;
    try { value = BigInt(t.data); } catch { return "unpaid"; }
    return value >= need ? "paid" : "unpaid";
  }
  return "unpaid";
}

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
 */
export function createReferralChainReader({ rpcUrls = null, rpcUrl = null, publicLanes = undefined, tries = 3, budgetMs = 15_000, timeoutMs = 3_000, pauseMs = 1_000, lookbackBlocks = 900, pageBlocks = 2_000, maxPages = 30, now = Date.now } = {}) {
  const rpcs = rpcUrls && rpcUrls.length ? rpcUrls : rpcUrl ? [rpcUrl] : baseRpcUrls();
  const read = (method, params, left) => rpcCall(rpcs, method, params, Math.max(250, Math.min(timeoutMs, left)));

  /** The chain head, or null when no RPC answers. */
  async function head({ budget = 3_000 } = {}) {
    try { const h = Number(BigInt(await read("eth_blockNumber", [], budget))); return Number.isSafeInteger(h) && h > 0 ? h : null; } catch { return null; }
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

  /** Whether transaction `tx` paid this authorization (receiptProvesPayment):
   *  "paid" | "unpaid" | "unknown" (no receipt readable yet). */
  async function proveTransaction(tx, { from, nonce, payTo, amount }, { budget = 4_000 } = {}) {
    if (!TX.test(String(tx || ""))) return "unpaid";
    let receipt;
    try { receipt = await read("eth_getTransactionReceipt", [tx], budget); } catch { return "unknown"; }
    if (!receipt) return "unknown";
    return receiptProvesPayment(receipt, { tx, from, nonce, payTo, amount });
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
   *                              what could be read, or the receipt unreadable):
   *                              NEVER read as not paid
   * `fromBlock`: the head when the intent was written; the search runs from
   * there to the head, so a late read still finds an early payment.
   * `wait`: keep reading for a spent nonce until the budget ends.
   */
  async function state({ from, nonce, payTo, amount, fromBlock = null }, { wait = false } = {}) {
    const none = { used: null, paid: null, transaction: null };
    let data;
    try { data = authorizationStateCalldata(from, nonce); } catch { return none; }
    const started = now();
    const deadline = started + budgetMs;
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
              const v = await proveTransaction(used.tx, { from, nonce, payTo, amount }, { budget: Math.max(250, deadline - now()) });
              return { used: true, paid: v === "paid" ? true : v === "unpaid" ? false : null, transaction: used.tx };
            }
            const canceled = await findLog(AUTHORIZATION_CANCELED_TOPIC, from, nonce, fromBlock, deadline);
            if (canceled.tx) return { used: true, paid: false, transaction: canceled.tx };
            return { used: true, paid: null, transaction: null };
          }
          if (!wait) return { used: false, paid: null, transaction: null };
        }
      } catch { /* the next try reads again */ }
      if (i < tries - 1) await sleep(Math.min(pauseMs, Math.max(0, deadline - now())));
    }
    return { ...none, used: last };
  }

  return { state, head, proveTransaction };
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
 */
export function chainVerdict(s, { validBeforeMs = 0, nowMs = Date.now(), slackMs = 120_000 } = {}) {
  const expired = validBeforeMs > 0 && nowMs > validBeforeMs + slackMs;
  if (s?.used === true) {
    if (s.paid === true && TX.test(String(s.transaction || ""))) return "paid";
    if (s.paid === false) return "unpaid";
    return "unknown";
  }
  if (s?.used === false) return expired ? "expired-unused" : "unused";
  return "unknown";
}
