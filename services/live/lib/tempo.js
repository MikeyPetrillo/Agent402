// MPP on Tempo: USDC.e transfers to the recipients MPP sellers are paid at
// (read from their live 402s by the MPP index). The recipient list comes from
// the directory and refreshes with it.
import { TRANSFER_TOPIC, TEMPO, MAX_PAYMENT_USD } from "./chains.js";
import { makeRpc, hexToBig, toHex, topicAddr, addrTopic } from "./rpc.js";

const MAX_RANGE = 2000;
const RECIPIENT_CHUNK = 60;

/** Transfer logs to known recipients -> events. Pure. */
export function tempoEvents(logs, recipients) {
  const out = [];
  for (const l of logs) {
    const from = topicAddr(l.topics?.[1]);
    const to = topicAddr(l.topics?.[2]);
    if (!recipients.has(to) || from === to) continue;
    const usd = Number(hexToBig(l.data)) / 1e6;
    if (!(usd > 0) || usd > MAX_PAYMENT_USD) continue;
    out.push({ chain: "mpp", tx: String(l.transactionHash).toLowerCase(), logIndex: Number(hexToBig(l.logIndex)), block: Number(hexToBig(l.blockNumber)), payer: from, payTo: to, amountUsd: usd });
  }
  return out;
}

export function startTempo({ recipients, onEvents, onStatus = () => {}, rpc = makeRpc(TEMPO.rpcs), pollMs = 2000, backfillSeconds = 3600, log = console } = {}) {
  let last = null, stopped = false, timer = null;
  const status = { lastBlock: null, head: null, lastOkAt: null, lastError: null, backfilled: false, recipients: 0 };

  async function logsFor(from, to, topics) {
    const logs = [];
    for (let i = 0; i < topics.length; i += RECIPIENT_CHUNK) {
      logs.push(...await rpc("eth_getLogs", [{ fromBlock: toHex(from), toBlock: toHex(to), address: TEMPO.usdc, topics: [TRANSFER_TOPIC, null, topics.slice(i, i + RECIPIENT_CHUNK)] }]));
    }
    return logs;
  }
  // The last hour, NEWEST FIRST, beside live polling (see base.js).
  async function backfill(fromBlock, head, topics, set) {
    let to = head;
    while (to > fromBlock && !stopped) {
      const from = Math.max(fromBlock + 1, to - MAX_RANGE + 1);
      try {
        const evs = tempoEvents(await logsFor(from, to, topics), set);
        const now = Date.now();
        for (const e of evs) e.ts = now - (head - e.block) * TEMPO.blockSeconds * 1000;
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
    const set = recipients();
    status.recipients = set.size;
    try {
      const head = Number(hexToBig(await rpc("eth_blockNumber", [])));
      status.head = head;
      if (!set.size) { onStatus(status); timer = setTimeout(tick, pollMs * 5); timer.unref?.(); return; }
      const topics = [...set].map(addrTopic);
      if (last === null) { last = head; backfill(head - Math.round(backfillSeconds / TEMPO.blockSeconds), head, topics, set); }
      while (last < head && !stopped) {
        const from = last + 1, to = Math.min(head, last + MAX_RANGE);
        const logs = [];
        for (let i = 0; i < topics.length; i += RECIPIENT_CHUNK) {
          logs.push(...await rpc("eth_getLogs", [{ fromBlock: toHex(from), toBlock: toHex(to), address: TEMPO.usdc, topics: [TRANSFER_TOPIC, null, topics.slice(i, i + RECIPIENT_CHUNK)] }]));
        }
        const evs = tempoEvents(logs, set);
        const now = Date.now();
        for (const e of evs) e.ts = now - (head - e.block) * TEMPO.blockSeconds * 1000;
        if (evs.length) onEvents(evs, { backfill: false });
        last = to;
        status.lastBlock = to;
      }
      status.lastOkAt = Date.now();
      status.lastError = null;
    } catch (e) {
      status.lastError = String(e?.message || e).slice(0, 160);
      log.warn?.(`[live:tempo] ${status.lastError}`);
    }
    onStatus(status);
    if (!stopped) { timer = setTimeout(tick, status.lastError ? pollMs * 5 : pollMs); timer.unref?.(); }
  }
  tick();
  return { status, stop() { stopped = true; clearTimeout(timer); } };
}
