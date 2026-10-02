// MPP leaderboard - the on-chain ranking of MPP sellers, the role the x402
// leaderboard (src/leaderboard.js) plays for x402: who is actually being PAID,
// measured on chain by us, never self-reported.
//
// Signal: 138 of 141 sellers in the mpp.dev registry settle tempo/charge in
// USDC.e on Tempo (measured 2026-08-18), so the leaderboard ranks verified MPP
// sellers by inbound USDC.e transfers on Tempo to the recipient their LIVE
// challenge names (src/mpp-index.js parseOffers - the address the seller is
// paid at, read from a real 402, not from the registry). Per recipient we
// report transfers, distinct payers and volume over the window.
//
// Window: rpc.tempo.xyz caps eth_getLogs at 100k blocks (~15h at ~0.56s/
// block; the same bound src/tempo-buyer.js's proven-seller gate lives under),
// so a rebuild reads the last 99k blocks. That is a WINDOW, not lifetime - the
// page says so next to every number. ONE batched query per chunk (topics[2] =
// every recipient) instead of one query per seller: ~140 sellers would
// otherwise be ~140 RPC calls per refresh. Chunks split themselves in half on
// an RPC error down to a floor, then the whole rebuild fails and the previous
// snapshot stays up, marked stale (a leaderboard that goes blank on one bad
// RPC minute reads as "nobody is selling").
//
// Honesty: an inbound transfer to a seller's recipient is any inbound USDC.e
// transfer, not provably an MPP settlement - it is the same proxy the router
// spends real money on, disclosed as such. Counts feed the router's
// proven-seller cache (tempo-buyer.js primeTempoInboundCount) so a routed
// buy to a ranked seller does not re-scan the chain.
import { readFileSync, writeFileSync } from "node:fs";
import { timedSync } from "./boot-timing.js";
import { redactSecrets } from "./tools/redact.js";
import { mppIndexSnapshot } from "./mpp-index.js";
import { TEMPO_USDC, tempoMinSettled, tempoMinPayers, tempoRpc, primeTempoInboundCount } from "./tempo-buyer.js";
import { OUR_EVM_WALLETS } from "./revenue-live.js";

// The payers that count toward the proven floor (2026-09-28): not the
// recipient paying itself, not our own wallets (the Tempo spending wallet pays
// the sellers it routes to). The public `payers` column stays the raw count.
export function evidencePayerCount(payerSet, recipient, ours = OUR_EVM_WALLETS) {
  const self = String(recipient || "").toLowerCase();
  let n = 0;
  for (const p of payerSet || []) {
    const k = String(p || "").toLowerCase();
    if (!k || k === self || ours.has(k)) continue;
    n++;
  }
  return n;
}
import { tempoFeedEnabled, emptyFeedState, syncTempoTransfers, feedStats, feedHistoryDays, persistFeedStateAsync, loadFeedState, feedCovers } from "./tempo-transfers.js";

// Transfer-feed window when the Tempo data API is the source (a time window,
// not a block window): 24h. The RPC path keeps its ~15h block window.
export const MPP_LB_FEED_WINDOW_MS = 24 * 3600e3;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDC_LC = TEMPO_USDC.toLowerCase();
export const MPP_LB_WINDOW_BLOCKS = 99_000; // rpc.tempo.xyz eth_getLogs cap is 100k
const CHUNK_BLOCKS = 33_000;
const MIN_CHUNK_BLOCKS = 2_000;
export const MPP_LB_REFRESH_MS = 30 * 60 * 1000;
export const MPP_LB_STALE_MS = 3 * MPP_LB_REFRESH_MS; // 90 min without a good rebuild = stale
export const MPP_LB_CACHE_FILE = process.env.MPP_LB_CACHE_FILE || "/data/mpp-leaderboard-cache.json";

const addrTopic = (addr) => "0x" + String(addr).toLowerCase().slice(2).padStart(64, "0");
const topicAddr = (topic) => "0x" + String(topic || "").slice(-40).toLowerCase();

/** The rankable recipients in a snapshot: verified sellers whose live
 *  challenge offers a tempo method (charge OR session - both are paid to the
 *  recipient on chain) in USDC.e with a valid recipient. Several sellers may
 *  share one recipient (one operator, several products; measured live: a
 *  shared gateway recipient behind 15 names); rows are keyed by recipient and
 *  list every seller name behind it, plus the intents offered - the router
 *  pays tempo/charge ONLY, so `routable` needs a charge offer. Pure. */
export function rankableRecipients(snapshot, { self = null } = {}) {
  const byRecipient = new Map();
  for (const s of snapshot?.sellers || []) {
    if (!s?.verified) continue;
    for (const o of s.offers || []) {
      if (o?.method !== "tempo") continue;
      const intent = o.intent || "charge";
      if (intent !== "charge" && intent !== "session") continue;
      if (!o.recipient || String(o.currency || "").toLowerCase() !== USDC_LC) continue;
      if (o.chainId !== null && o.chainId !== undefined && Number(o.chainId) !== 4217) continue;
      const key = o.recipient.toLowerCase();
      const row = byRecipient.get(key) || { recipient: key, sellers: [], intents: [], self: false };
      const origin = String(s.serviceUrl || s.origin || "");
      if (!row.sellers.some((x) => x.origin === origin)) row.sellers.push({ name: s.name || origin.replace(/^https?:\/\//, ""), origin, url: s.url || origin });
      if (!row.intents.includes(intent)) row.intents.push(intent);
      byRecipient.set(key, row);
    }
  }
  if (self && /^0x[0-9a-fA-F]{40}$/.test(self)) {
    const key = self.toLowerCase();
    const row = byRecipient.get(key) || { recipient: key, sellers: [], intents: ["charge"], self: true };
    row.self = true;
    byRecipient.set(key, row);
  }
  return [...byRecipient.values()];
}

/** Fetch Transfer logs to ANY of `topics` over [from, to], splitting the range
 *  on RPC error down to MIN_CHUNK_BLOCKS. Throws if a minimal chunk still
 *  fails (caller keeps the previous snapshot). */
async function fetchLogsSplitting(rpcFn, topics, from, to) {
  try {
    const logs = await rpcFn("eth_getLogs", [{ fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: TEMPO_USDC, topics: [TRANSFER_TOPIC, null, topics] }]);
    return Array.isArray(logs) ? logs : [];
  } catch (e) {
    if (to - from + 1 <= MIN_CHUNK_BLOCKS) throw e;
    const mid = from + Math.floor((to - from) / 2);
    return [...(await fetchLogsSplitting(rpcFn, topics, from, mid)), ...(await fetchLogsSplitting(rpcFn, topics, mid + 1, to))];
  }
}

// ---- rolling history ---------------------------------------------------------
// The RPC window is ~15h, so a leaderboard read from it alone forgets
// everything older than the last read. History accumulates ACROSS refreshes:
// every refresh attributes only the logs above the last scanned block
// (`cursor`) to today's UTC bucket, so overlapping windows never double
// count, and 7d/30d sums roll from the buckets. The first refresh seeds the
// buckets with the whole window (~15h). A refresh gap longer than the window
// (RPC down > 15h) loses the uncovered blocks - counted in `gaps`, said on
// the API, never silently smoothed. Buckets carry transfers + volume only
// (distinct payers do not sum across days without storing every payer).
export const MPP_LB_HISTORY_DAYS = 30;
export function emptyHistory() { return { cursor: null, gaps: 0, days: {} }; }
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Fold this refresh's logs (with blockNumber) into `history` (mutated copy
 *  returned). Pure apart from `now`. Exported for tests. */
export function foldHistory(history, logsByRecipient, { latest, from, now }) {
  const h = { cursor: history?.cursor ?? null, gaps: history?.gaps || 0, days: { ...(history?.days || {}) } };
  // Blocks strictly above the cursor are new; on a cold cursor the whole window is.
  let minNew = h.cursor === null ? from : h.cursor + 1;
  if (h.cursor !== null && h.cursor + 1 < from) { h.gaps += 1; minNew = from; } // window moved past the cursor: blocks (cursor, from) were never scanned
  const today = dayKey(now);
  const bucket = { ...(h.days[today] || {}) };
  for (const [recipient, logs] of logsByRecipient) {
    let t = 0, v = 0n;
    for (const log of logs) {
      const bn = parseInt(log?.blockNumber, 16);
      if (!Number.isFinite(bn) || bn < minNew) continue;
      t += 1;
      try { v += BigInt(log?.data || "0x0"); } catch { /* count, skip amount */ }
    }
    if (!t) continue;
    const prev = bucket[recipient] || { t: 0, v: "0" };
    bucket[recipient] = { t: prev.t + t, v: (BigInt(prev.v) + v).toString() };
  }
  h.days[today] = bucket;
  h.cursor = latest;
  // prune beyond the horizon
  const cutoff = dayKey(now - MPP_LB_HISTORY_DAYS * 86400e3);
  for (const d of Object.keys(h.days)) if (d < cutoff) delete h.days[d];
  return h;
}

/** Sum a recipient's buckets over the last N days (inclusive of today). */
export function historySum(history, recipient, days, now) {
  const cutoff = dayKey(now - (days - 1) * 86400e3);
  let t = 0, v = 0n;
  for (const [d, bucket] of Object.entries(history?.days || {})) {
    if (d < cutoff) continue;
    const e = bucket[recipient]; if (!e) continue;
    t += e.t; try { v += BigInt(e.v); } catch { /* skip */ }
  }
  return { transfers: t, volumeUsdc: Number(v) / 1e6 };
}


/** Ecosystem totals EXCLUDE our own self-flagged row: at ~1,000 self-buys a
 *  day (tempo-volume.yml) our row would otherwise be most of "the MPP
 *  economy on Tempo" on our own page. The row itself stays listed and
 *  flagged `self`; `selfTransfers` says what was left out. */
function ecosystemTotals(active) {
  const ext = active.filter((r) => !r.self);
  const self = active.filter((r) => r.self);
  return {
    transfers: ext.reduce((n, r) => n + r.transfers, 0),
    volumeUsdc: Math.round(ext.reduce((n, r) => n + r.volumeUsdc, 0) * 1e6) / 1e6,
    d7Transfers: ext.reduce((n, r) => n + r.d7.transfers, 0),
    d30Transfers: ext.reduce((n, r) => n + r.d30.transfers, 0),
    selfTransfers: self.reduce((n, r) => n + r.transfers, 0),
    activeRecipients: ext.length,
  };
}
/** Build a leaderboard from a snapshot + chain reads. Injectable rpc + clock
 *  for tests. Throws on RPC failure (the scheduler keeps the last good one).
 *  `history` (previous rolling history) is folded and returned as
 *  `.history`; ranking is by 7-day transfers (>= window transfers once
 *  seeded), then window transfers - proven/routable stay on the WINDOW count,
 *  the floor the router spends against. */
export async function computeMppLeaderboard({ snapshot = mppIndexSnapshot(), rpcFn = tempoRpc, now = Date.now(), self = null, history = null, feed = null } = {}) {
  const rows = rankableRecipients(snapshot, { self });
  // ---- Source A (since 2026-08-19): Tempo's transfer feed, when a synced
  // feed state is supplied. No RPC, a 24h time window, history from the
  // feed's own hour buckets (feed days win over previously RPC-folded days
  // for the same date; older RPC-folded days are kept until the feed covers
  // them - no double counting either way).
  if (feed && feed.syncs > 0) {
    const fstats = feedStats(feed, rows.map((r) => r.recipient), { windowMs: MPP_LB_FEED_WINDOW_MS, now });
    const feedDays = feedHistoryDays(feed);
    const prevDays = { ...(history?.days || {}) };
    const mergedDays = { ...prevDays, ...feedDays };
    const cutoff = dayKey(now - MPP_LB_HISTORY_DAYS * 86400e3);
    for (const d of Object.keys(mergedDays)) if (d < cutoff) delete mergedDays[d];
    const nextHistory = { cursor: history?.cursor ?? null, gaps: history?.gaps || 0, days: mergedDays };
    const floor = tempoMinSettled();
    const minPayers = tempoMinPayers();
    const ranked = rows.map((r) => {
      const st = fstats.get(r.recipient.toLowerCase()) || { transfers: 0, payers: new Set(), volumeAtomic: 0n };
      // Unknown when the feed kept only counts for part of the window: judged
      // on the count, as before, and never primed (the pay-time gate then
      // reads the chain itself).
      const evPayers = st.payersPartial ? undefined : evidencePayerCount(st.payers, r.recipient);
      const proven = st.transfers >= floor && (evPayers === undefined || evPayers >= minPayers);
      return {
        recipient: r.recipient, sellers: r.sellers, intents: r.intents, self: !!r.self,
        transfers: st.transfers, payers: st.payers.size,
        volumeUsdc: Number(st.volumeAtomic) / 1e6,
        d7: historySum(nextHistory, r.recipient, 7, now),
        d30: historySum(nextHistory, r.recipient, 30, now),
        proven,
        routable: proven && r.intents.includes("charge"),
        evidencePayers: evPayers,
      };
    }).sort((a, b) => b.d7.transfers - a.d7.transfers || b.transfers - a.transfers || b.volumeUsdc - a.volumeUsdc || a.recipient.localeCompare(b.recipient))
      .map((r, i) => ({ rank: i + 1, ...r }));
    for (const r of ranked) if (r.evidencePayers !== undefined) primeTempoInboundCount(r.recipient, r.transfers, now, r.evidencePayers);
    const active = ranked.filter((r) => r.transfers > 0 || r.d30.transfers > 0);
    return {
      generatedAt: now,
      window: { source: "tempo-api", hours: MPP_LB_FEED_WINDOW_MS / 3600e3, approxHours: MPP_LB_FEED_WINDOW_MS / 3600e3, since: new Date(now - MPP_LB_FEED_WINDOW_MS).toISOString(), feed: { syncs: feed.syncs, lastSyncAt: feed.lastSyncAt, lastPages: feed.lastPages, lastNew: feed.lastNew, lastError: feed.lastError, cursorTs: feed.cursorTs } },
      chain: "tempo", chainId: 4217, asset: "USDC.e", assetAddress: TEMPO_USDC,
      provenFloor: floor,
      recipients: ranked.length,
      activeRecipients: ecosystemTotals(active).activeRecipients,
      totals: ecosystemTotals(active),
      history: { ...nextHistory, daysCovered: Object.keys(nextHistory.days).length, since: Object.keys(nextHistory.days).sort()[0] || null },
      rows: ranked,
      stale: false,
      lastError: null,
    };
  }
  // ---- Source B: the RPC eth_getLogs scan (original path; fallback).
  const latest = parseInt(await rpcFn("eth_blockNumber", []), 16);
  if (!Number.isFinite(latest)) throw new Error("tempo rpc: bad eth_blockNumber");
  const from = Math.max(0, latest - MPP_LB_WINDOW_BLOCKS + 1); // exactly WINDOW blocks, inclusive
  const stats = new Map(rows.map((r) => [r.recipient, { transfers: 0, payers: new Set(), volumeAtomic: 0n, logs: [] }]));
  if (rows.length) {
    const topics = rows.map((r) => addrTopic(r.recipient));
    for (let a = from; a <= latest; a += CHUNK_BLOCKS) {
      const b = Math.min(latest, a + CHUNK_BLOCKS - 1);
      const logs = await fetchLogsSplitting(rpcFn, topics, a, b);
      for (const log of logs) {
        const to = topicAddr(log?.topics?.[2]);
        const st = stats.get(to);
        if (!st) continue;
        st.transfers += 1;
        st.payers.add(topicAddr(log?.topics?.[1]));
        st.logs.push(log);
        try { st.volumeAtomic += BigInt(log?.data || "0x0"); } catch { /* malformed data: count the transfer, skip the amount */ }
      }
    }
  }
  const nextHistory = foldHistory(history || emptyHistory(), new Map([...stats].map(([k, st]) => [k, st.logs])), { latest, from, now });
  const floor = tempoMinSettled();
  const minPayers = tempoMinPayers();
  const ranked = rows.map((r) => {
    const st = stats.get(r.recipient);
    const evPayers = evidencePayerCount(st.payers, r.recipient);
    const proven = st.transfers >= floor && evPayers >= minPayers;
    return {
      recipient: r.recipient, sellers: r.sellers, intents: r.intents, self: !!r.self,
      transfers: st.transfers, payers: st.payers.size,
      volumeUsdc: Number(st.volumeAtomic) / 1e6,
      d7: historySum(nextHistory, r.recipient, 7, now),
      d30: historySum(nextHistory, r.recipient, 30, now),
      proven,                                     // on-chain floor met: transfers AND distinct payers
      routable: proven && r.intents.includes("charge"), // ...and the router can actually pay it
      evidencePayers: evPayers,
    };
  }).sort((a, b) => b.d7.transfers - a.d7.transfers || b.transfers - a.transfers || b.volumeUsdc - a.volumeUsdc || a.recipient.localeCompare(b.recipient))
    .map((r, i) => ({ rank: i + 1, ...r }));
  for (const r of ranked) primeTempoInboundCount(r.recipient, r.transfers, now, r.evidencePayers);
  const active = ranked.filter((r) => r.transfers > 0 || r.d30.transfers > 0);
  const histDays = Object.keys(nextHistory.days).length;
  return {
    generatedAt: now,
    window: { source: "rpc", fromBlock: from, toBlock: latest, blocks: latest - from + 1, approxHours: Math.round(((latest - from + 1) * 0.56) / 3600 * 10) / 10 },
    chain: "tempo", chainId: 4217, asset: "USDC.e", assetAddress: TEMPO_USDC,
    provenFloor: floor,
    recipients: ranked.length,
    activeRecipients: ecosystemTotals(active).activeRecipients,
    totals: ecosystemTotals(active),
    history: { ...nextHistory, daysCovered: histDays, since: Object.keys(nextHistory.days).sort()[0] || null },
    rows: ranked,
    stale: false,
    lastError: null,
  };
}

// ---------------------------------------------------------------------------
// Scheduler + snapshot (stale-while-revalidate; warm start from /data)
// ---------------------------------------------------------------------------
let current = null;
let timer = null;
let inFlight = null;

export function persistMppLeaderboard(file = MPP_LB_CACHE_FILE) {
  if (!current) return false;
  try { writeFileSync(file, JSON.stringify(current)); return true; } catch { return false; }
}
export function loadPersistedMppLeaderboard(file = MPP_LB_CACHE_FILE) {
  return timedSync("MPP leaderboard warm-start", file, () => _loadPersistedMppLeaderboard(file));
}
function _loadPersistedMppLeaderboard(file = MPP_LB_CACHE_FILE) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j && Array.isArray(j.rows) && Number.isFinite(j.generatedAt)) { current = j; return true; }
  } catch { /* cold start */ }
  return false;
}

/** One rebuild, deduped (a burst of requests never fans out to N chain
 *  reads). On failure the previous snapshot stays, marked stale + lastError. */
let feedState = null; // Tempo transfer-feed state (null until first load/sync)
export function __feedStateForTest() { return feedState; }
export function refreshMppLeaderboard(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      let feed = null;
      if (opts.feed !== undefined) feed = opts.feed; // test injection
      else if (tempoFeedEnabled()) {
        feedState ??= loadFeedState() || emptyFeedState();
        try {
          // Tracked recipients (full payer detail, 31 days) = the rankable
          // recipients in the current index snapshot + our own payTo; every
          // other address keeps counts only for 48h (bounded state).
          const track = new Set(rankableRecipients(opts.snapshot ?? mppIndexSnapshot(), { self: opts.self ?? null }).map((r) => r.recipient));
          const r = await syncTempoTransfers(feedState, { token: TEMPO_USDC, track, now: opts.now });
          await persistFeedStateAsync(feedState);
          const covers = feedCovers(feedState, { windowMs: MPP_LB_FEED_WINDOW_MS, now: opts.now });
          feed = covers ? feedState : null; // until the cold backfill covers the window, the RPC scan keeps serving (never under-count)
          console.log(`[mpp-leaderboard] tempo feed sync: +${r.added} transfers over ${r.pages} page(s)${r.complete ? "" : " (more pending)"}${covers ? "" : " - feed does not cover the window yet, RPC scan serves this rebuild"}`);
        } catch (e) {
          // Feed unreadable: keep whatever the feed already holds if it has
          // synced before (stale-but-present beats a blank), else fall back to
          // the RPC scan - loudly either way.
          console.warn(`[mpp-leaderboard] tempo feed sync failed (${String(e?.message || e).slice(0, 160)}) - ${feedState.syncs > 0 ? "using the last synced feed state" : "falling back to the RPC scan"}`);
          feed = feedCovers(feedState, { windowMs: MPP_LB_FEED_WINDOW_MS, now: opts.now }) ? feedState : null;
        }
      }
      current = await computeMppLeaderboard({ ...opts, feed, history: opts.history ?? current?.history ?? null });
      persistMppLeaderboard();
    } catch (e) {
      // Public on /api/mpp-leaderboard and rendered on /mpp-marketplace: an RPC
      // or API error message can quote the request URL (and a key in it).
      const msg = redactSecrets(String(e?.message || e)).slice(0, 200);
      if (current) current = { ...current, lastError: msg };
      else current = { generatedAt: 0, window: null, chain: "tempo", chainId: 4217, asset: "USDC.e", assetAddress: TEMPO_USDC, provenFloor: tempoMinSettled(), recipients: 0, activeRecipients: 0, totals: { transfers: 0, volumeUsdc: 0 }, rows: [], stale: true, lastError: msg };
      console.warn(`[mpp-leaderboard] rebuild failed, serving previous snapshot: ${msg}`);
    } finally { inFlight = null; }
    return current;
  })();
  return inFlight;
}

/** Synchronous read for pages/APIs. `stale` is computed at read time so a
 *  scheduler that stopped firing shows as stale, not as fresh forever. */
// provenMinPayers rides beside provenFloor at READ time: "proven" needs both
// the transfer floor and distinct non-self payers (tempo-buyer's gate), and a
// page that quotes only the floor states a rule the router does not apply.
export function mppLeaderboardSnapshot(now = Date.now()) {
  if (!current) return { generatedAt: 0, window: null, chain: "tempo", chainId: 4217, asset: "USDC.e", assetAddress: TEMPO_USDC, provenFloor: tempoMinSettled(), provenMinPayers: tempoMinPayers(), recipients: 0, activeRecipients: 0, totals: { transfers: 0, volumeUsdc: 0 }, rows: [], stale: true, lastError: null };
  return { ...current, provenMinPayers: tempoMinPayers(), stale: !current.generatedAt || now - current.generatedAt > MPP_LB_STALE_MS };
}

export function startMppLeaderboard({ self = null, delayMs = 120_000 } = {}) {
  if (timer) return;
  const warmed = loadPersistedMppLeaderboard();
  if (warmed) console.log(`[mpp-leaderboard] warm-started ${current.rows.length} recipients from ${MPP_LB_CACHE_FILE}`);
  // First build after the MPP crawler's boot pass has verified sellers and
  // captured their live offers (99 seeds at concurrency 10 with an 8s probe
  // timeout is ~10s typical, ~80s worst) - an empty snapshot would rank
  // nobody and then sit for 30 min. A second early pass at +10 min catches
  // sellers whose first probe was slow; then the steady 30-min cadence.
  const kick = setTimeout(() => { refreshMppLeaderboard({ self }); }, delayMs);
  kick.unref?.();
  const kick2 = setTimeout(() => { refreshMppLeaderboard({ self }); }, delayMs + 8 * 60 * 1000);
  kick2.unref?.();
  timer = setInterval(() => { refreshMppLeaderboard({ self }); }, MPP_LB_REFRESH_MS);
  timer.unref?.();
}
export function stopMppLeaderboard() { if (timer) clearInterval(timer); timer = null; }
export function __testReset() { current = null; inFlight = null; feedState = null; stopMppLeaderboard(); }
