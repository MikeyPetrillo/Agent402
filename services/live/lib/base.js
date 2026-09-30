// x402 on Base: every USDC transfer that settled a signed EIP-3009
// authorization. Polls a public RPC a block or two at a time; the first run
// backfills the last hour so the page is never empty after a restart.
import { AUTH_USED_TOPIC, TRANSFER_TOPIC, BASE, MAX_PAYMENT_USD } from "./chains.js";
import { makeRpc, hexToBig, toHex, topicAddr } from "./rpc.js";

const MAX_RANGE = 400;      // blocks per getLogs call
const AUTHORIZER_CHUNK = 40; // topic OR-list size per Transfer query

/** Pair Transfer logs with the AuthorizationUsed logs of the same tx: the
 *  settlement is the Transfer FROM the authorizer in that transaction. Pure. */
export function pairSettlements(authLogs, transferLogs) {
  const authByTx = new Map();
  for (const l of authLogs) {
    const tx = String(l.transactionHash).toLowerCase();
    const set = authByTx.get(tx) || new Set();
    set.add(topicAddr(l.topics?.[1]));
    authByTx.set(tx, set);
  }
  const out = [];
  for (const l of transferLogs) {
    const tx = String(l.transactionHash).toLowerCase();
    const authorizers = authByTx.get(tx);
    if (!authorizers) continue;
    const from = topicAddr(l.topics?.[1]);
    const to = topicAddr(l.topics?.[2]);
    if (!authorizers.has(from) || from === to) continue;
    const usd = Number(hexToBig(l.data)) / 1e6;
    if (!(usd > 0) || usd > MAX_PAYMENT_USD) continue;
    out.push({ chain: "x402", tx, logIndex: Number(hexToBig(l.logIndex)), block: Number(hexToBig(l.blockNumber)), payer: from, payTo: to, amountUsd: usd });
  }
  return out;
}

export function startBase({ onEvents, onStatus = () => {}, rpc = makeRpc(BASE.rpcs), pollMs = 2000, backfillSeconds = 3600, log = console } = {}) {
  let last = null, stopped = false, timer = null;
  const status = { lastBlock: null, head: null, lastOkAt: null, lastError: null, backfilled: false };

  async function range(from, to) {
    const auth = await rpc("eth_getLogs", [{ fromBlock: toHex(from), toBlock: toHex(to), address: BASE.usdc, topics: [AUTH_USED_TOPIC] }]);
    if (!auth.length) return [];
    const authorizers = [...new Set(auth.map((l) => l.topics?.[1]).filter(Boolean))];
    const transfers = [];
    for (let i = 0; i < authorizers.length; i += AUTHORIZER_CHUNK) {
      const part = await rpc("eth_getLogs", [{ fromBlock: toHex(from), toBlock: toHex(to), address: BASE.usdc, topics: [TRANSFER_TOPIC, authorizers.slice(i, i + AUTHORIZER_CHUNK)] }]);
      transfers.push(...part);
    }
    return pairSettlements(auth, transfers);
  }

  async function tick() {
    if (stopped) return;
    try {
      const head = Number(hexToBig(await rpc("eth_blockNumber", [])));
      status.head = head;
      if (last === null) last = head - Math.round(backfillSeconds / BASE.blockSeconds);
      while (last < head && !stopped) {
        const from = last + 1, to = Math.min(head, last + MAX_RANGE);
        const evs = await range(from, to);
        // Timestamp from the block distance to head: one getBlock per block
        // would triple the RPC calls for a value the page shows to the second.
        const now = Date.now();
        for (const e of evs) e.ts = now - (head - e.block) * BASE.blockSeconds * 1000;
        if (evs.length) onEvents(evs, { backfill: !status.backfilled });
        last = to;
        status.lastBlock = to;
      }
      status.backfilled = true;
      status.lastOkAt = Date.now();
      status.lastError = null;
    } catch (e) {
      status.lastError = String(e?.message || e).slice(0, 160);
      log.warn?.(`[live:base] ${status.lastError}`);
    }
    onStatus(status);
    if (!stopped) { timer = setTimeout(tick, status.lastError ? pollMs * 5 : pollMs); timer.unref?.(); }
  }
  tick();
  return { status, stop() { stopped = true; clearTimeout(timer); } };
}
