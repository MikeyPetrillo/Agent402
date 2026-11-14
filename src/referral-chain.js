// Chain truth for a referral settlement whose outcome the facilitator did not
// state (src/referral-gate.js): was the buyer's EIP-3009 authorization used?
//
// `authorizationState(authorizer, nonce)` on Base USDC is true once, and only
// once, the authorization has been consumed, whoever submitted it and whatever
// the facilitator's answer said. When it reads true, the transaction is the
// one carrying the token's AuthorizationUsed(authorizer, nonce) log, looked
// up in a bounded range of recent blocks.
//
// Bounded: a few tries inside a short budget, each read with its own timeout
// (the shared JSON-RPC reader, src/payment-verify.js). A read that fails is
// "unknown" (used: null), never "unused": only an explicit false says the
// authorization has not been consumed, and even that is final only once the
// authorization has expired.
import { rpc } from "./payment-verify.js";
import { authorizationStateCalldata, evmRpcUrlFor } from "./evm-authorization-state.js";
import { AUTHORIZATION_USED_TOPIC } from "./pending-settle.js";
import { USDC_DOMAIN_BY_NETWORK } from "./evm-usdc-domain.js";

const TOKEN = USDC_DOMAIN_BY_NETWORK["eip155:8453"].asset;
const TX = /^0x[0-9a-fA-F]{64}$/;
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

  /** The transaction that used the authorization, or null when it is not found in the range read. */
  async function transactionOf(authorizer, nonce, left) {
    try {
      const head = BigInt(await read("eth_blockNumber", [], left));
      const from = head > BigInt(lookbackBlocks) ? head - BigInt(lookbackBlocks) : 0n;
      const logs = await read("eth_getLogs", [{ address: TOKEN, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${head.toString(16)}`, topics: [AUTHORIZATION_USED_TOPIC, topicOf(authorizer), String(nonce).toLowerCase()] }], left);
      const hit = Array.isArray(logs) ? logs.find((l) => TX.test(String(l?.transactionHash || "")) && String(l?.address || "").toLowerCase() === TOKEN.toLowerCase()) : null;
      return hit ? String(hit.transactionHash).toLowerCase() : null;
    } catch { return null; }
  }

  /**
   * `{ used: true, transaction }` (the hash, or null when the log was not
   * found), `{ used: false }` (not consumed as of this read) or
   * `{ used: null }` (no read answered). `until`: keep reading for a true
   * until the budget ends (a settlement that is still landing); a single
   * false is returned at once without it.
   */
  async function state({ from, nonce }, { wait = false } = {}) {
    let data;
    try { data = authorizationStateCalldata(from, nonce); } catch { return { used: null, transaction: null }; }
    const started = now();
    let last = null;
    for (let i = 0; i < tries; i++) {
      const left = budgetMs - (now() - started);
      if (left < 250) break;
      try {
        const r = await read("eth_call", [{ to: TOKEN, data }, "latest"], left);
        if (typeof r === "string" && /^0x[0-9a-fA-F]{64}$/.test(r)) {
          last = BigInt(r) !== 0n;
          if (last) return { used: true, transaction: await transactionOf(from, nonce, Math.max(250, budgetMs - (now() - started))) };
          if (!wait) return { used: false, transaction: null };
        }
      } catch { /* the next try reads again */ }
      if (i < tries - 1) await sleep(Math.min(pauseMs, Math.max(0, budgetMs - (now() - started))));
    }
    return { used: last, transaction: null };
  }

  return { state };
}
