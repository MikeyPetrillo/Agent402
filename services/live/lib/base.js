// x402 on Base: every USDC transfer that settled a signed EIP-3009
// authorization. Polls a public RPC a block or two at a time; the first run
// backfills the last hour so the page is never empty after a restart.
import { AUTH_USED_TOPIC, TRANSFER_TOPIC, BASE, MAX_PAYMENT_USD, REFERRAL_ROUTERS } from "./chains.js";
import { makeRpc, hexToBig, toHex, topicAddr } from "./rpc.js";

const pad32 = (a) => "0x" + "0".repeat(24) + a.toLowerCase().slice(2);
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

/** A settlement paid to a referral split contract is drawn as a payment to
 *  the seller the contract paid on in that transaction: `payouts` are the
 *  Transfer logs FROM a router; the first one in the event's transaction to
 *  a seller in `sellers` (the payTos the page names) becomes the event's
 *  payTo. Every settlement stays, at the amount its buyer paid; one with no
 *  such payout keeps the contract as its payTo. Pure. */
export function attributeRouted(events, payouts, { routers = REFERRAL_ROUTERS, sellers = new Set() } = {}) {
  if (!routers.size || !events.some((e) => routers.has(e.payTo))) return events;
  const paidTo = new Map(); // tx -> seller the router paid
  for (const l of payouts) {
    const tx = String(l.transactionHash).toLowerCase();
    const from = topicAddr(l.topics?.[1]);
    const to = topicAddr(l.topics?.[2]);
    if (!routers.has(from) || !sellers.has(to) || paidTo.has(tx)) continue;
    paidTo.set(tx, to);
  }
  return events.map((e) => (routers.has(e.payTo) && paidTo.has(e.tx) ? { ...e, payTo: paidTo.get(e.tx) } : e));
}

export function startBase({ onEvents, onStatus = () => {}, rpc = makeRpc(BASE.rpcs), pollMs = 2000, backfillSeconds = 3600, log = console, routers = REFERRAL_ROUTERS, sellers = new Set() } = {}) {
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
    const evs = pairSettlements(auth, transfers);
    // A payment to a referral split contract: read where the contract paid it on.
    if (routers.size && sellers.size && evs.some((e) => routers.has(e.payTo))) {
      const payouts = await rpc("eth_getLogs", [{ fromBlock: toHex(from), toBlock: toHex(to), address: BASE.usdc, topics: [TRANSFER_TOPIC, [...routers].map(pad32), [...sellers].map(pad32)] }]);
      return attributeRouted(evs, payouts, { routers, sellers });
    }
    return evs;
  }

  async function backfill(fromBlock, head) {
    let to = head;
    while (to > fromBlock && !stopped) {
      const from = Math.max(fromBlock + 1, to - MAX_RANGE + 1);
      try {
        const evs = await range(from, to);
        const now = Date.now();
        for (const e of evs) e.ts = now - (head - e.block) * BASE.blockSeconds * 1000;
        if (evs.length) onEvents(evs, { backfill: true });
        to = from - 1;
      } catch (e) {
        status.lastError = String(e?.message || e).slice(0, 160);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    status.backfilled = true;
  }

  async function tick() {
    if (stopped) return;
    try {
      const head = Number(hexToBig(await rpc("eth_blockNumber", [])));
      status.head = head;
      // First tick: live polling starts at head, and the last hour is loaded
      // NEWEST FIRST in the background, so recent payments appear in seconds.
      if (last === null) { last = head; backfill(head - Math.round(backfillSeconds / BASE.blockSeconds), head); }
      while (last < head && !stopped) {
        const from = last + 1, to = Math.min(head, last + MAX_RANGE);
        const evs = await range(from, to);
        // Timestamp from the block distance to head: one getBlock per block
        // would triple the RPC calls for a value the page shows to the second.
        const now = Date.now();
        for (const e of evs) e.ts = now - (head - e.block) * BASE.blockSeconds * 1000;
        if (evs.length) onEvents(evs, { backfill: false });
        last = to;
        status.lastBlock = to;
      }
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
