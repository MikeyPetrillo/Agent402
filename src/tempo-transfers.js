// Tempo transfer feed (api.tempo.xyz GET /v1/transfers) - the leaderboard's
// primary read since 2026-08-19 (rail deep-dive build #4), with the RPC
// eth_getLogs scan kept as the fallback.
//
// Why: rpc.tempo.xyz caps eth_getLogs at 100k blocks (~15h) and a failing RPC
// read fails the rebuild closed. The transfer API has no block cap, takes
// TIME windows, pages by cursor, and is a read on Tempo's own index rather
// than a public RPC. It needs a Tempo API key with the data:read scope
// (`TEMPO_DATA_API_KEY`, on Railway since 2026-08-19; self-serve in Tempo's
// console). Measured 2026-08-19: >10,000 USDC.e transfers/day chain-wide
// (totalCount capped at 10k), the top recipient ~875/day; `limit` 5-50;
// rate limit headers RateLimit-Limit 10000. So the only affordable shape is
// ONE token-wide INCREMENTAL sweep (every new transfer since the last sync,
// ~400 pages/day at 50/page) filtered locally to the recipients we care
// about - never one query per recipient per rebuild.
//
// What the feed did NOT give us (probed the same day): `attribution` is not
// an accepted `include` on this key, and `memo` came back empty on every
// sampled transfer incl. our own canary settlements - so MPP-tag filtering /
// realm fingerprints are not possible from this source today. Counts are
// therefore "inbound USDC.e transfers", the same proxy the RPC path counts.
//
// State: hour buckets {hourKey -> {recipientLc -> {t, v(base units), p[payers]}}}
// pruned past 31 days, plus the sync cursor (ISO timestamp of the newest
// transfer seen, minus a small overlap on the next sync; ids dedupe the
// overlap). Persisted to /data so a redeploy does not start blind.
import { readFileSync } from "node:fs";
import { timedSync } from "./boot-timing.js";
import { writeFile } from "node:fs/promises";
import { redactSecrets } from "./tools/redact.js";

export const TEMPO_TRANSFERS_API = (process.env.TEMPO_API_BASE_URL || "https://api.tempo.xyz").replace(/\/$/, "") + "/v1/transfers";
export const TEMPO_TRANSFERS_CACHE_FILE = process.env.TEMPO_TRANSFERS_CACHE_FILE || "/data/tempo-transfers.json";
export const TEMPO_TRANSFERS_KEEP_DAYS = 31;
// Recipients we do NOT rank (every other address on the chain - measured
// ~400 distinct/6h, ~1,900 senders/6h) keep counts only, no payer list, and
// only for this long: enough for a seller verified today to have yesterday's
// numbers, bounded so the state cannot grow with the chain (cost audit
// 2026-08-19: the unbounded fold was ~22MB JSON / ~80MB heap at launch
// volume and linear in chain activity, stringified synchronously per rebuild).
export const TEMPO_TRANSFERS_UNTRACKED_KEEP_MS = 48 * 3600e3;
const OVERLAP_MS = 5 * 60_000;      // re-read the last 5 min each sync; ids dedupe
const RECENT_IDS_MAX = 20_000;      // dedupe ring
const DEFAULT_BACKFILL_MS = 24 * 3600e3; // first sync: last 24h (older history fills from the RPC path's folds)
const PAGE = 50;

export const tempoDataKey = () => (process.env.TEMPO_DATA_API_KEY || "").trim();
export const tempoFeedEnabled = () => !!tempoDataKey() && String(process.env.MPP_LB_SOURCE || "").toLowerCase() !== "rpc";

export function emptyFeedState() {
  return { cursorTs: null, coverageFromTs: null, pendingFromTs: null, caughtUpAt: null, buckets: {}, recentIds: [], syncs: 0, lastSyncAt: 0, lastError: null, lastPages: 0, lastNew: 0 };
}
/** True once the feed has read continuously from at least `windowMs` ago up
 *  to (near) now - i.e. a window stat read from it is complete. Until then
 *  (cold backfill in progress: ~2,000 transfers/hour chain-wide, measured
 *  2026-08-19) callers keep the RPC path rather than under-count. */
export function feedCovers(state, { windowMs, now = Date.now(), maxLagMs = 90 * 60_000 } = {}) {
  if (!state?.coverageFromTs || !state.cursorTs) return false;
  // A completed sync means we are current as of that moment even if the
  // newest transfer is older (a quiet stretch is not lag).
  const headTs = Math.max(Date.parse(state.cursorTs) || 0, Date.parse(state.caughtUpAt || 0) || 0);
  return Date.parse(state.coverageFromTs) <= now - windowMs && now - headTs <= maxLagMs;
}
const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13); // YYYY-MM-DDTHH
const dayOf = (hk) => hk.slice(0, 10);

/** Fold one page of transfers into state. Pure apart from `state` mutation.
 *  Returns how many were new. Exported for tests. */
export function foldTransfers(state, transfers, { token = null, track = null } = {}) {
  let added = 0;
  const seen = new Set(state.recentIds);
  for (const t of transfers || []) {
    if (!t || typeof t !== "object") continue;
    const id = String(t.id || t.transactionHash + "-" + t.logIndex);
    if (seen.has(id)) continue;
    if (token && String(t.sourceToken?.address || "").toLowerCase() !== token.toLowerCase()) continue;
    const ts = Date.parse(t.timestamp);
    if (!Number.isFinite(ts)) continue;
    const recipient = String(t.recipient || "").toLowerCase();
    const sender = String(t.sender || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(recipient)) continue;
    let base = 0n;
    try { base = BigInt(String(t.sourceAmount?.baseUnits ?? "0")); } catch { base = 0n; }
    const hk = hourKey(ts);
    const bucket = (state.buckets[hk] ??= {});
    const tracked = !track || track.has(recipient);
    const e = (bucket[recipient] ??= tracked ? { t: 0, v: "0", p: [] } : { t: 0, v: "0" });
    e.t += 1;
    e.v = (BigInt(e.v) + base).toString();
    if (tracked && sender) { (e.p ??= []); if (!e.p.includes(sender)) e.p.push(sender); }
    seen.add(id); state.recentIds.push(id); added++;
    if (!state.cursorTs || ts > Date.parse(state.cursorTs)) state.cursorTs = new Date(ts).toISOString();
  }
  if (state.recentIds.length > RECENT_IDS_MAX) state.recentIds = state.recentIds.slice(-RECENT_IDS_MAX);
  return added;
}

export function pruneFeedState(state, now = Date.now(), { track = null } = {}) {
  const cutoff = hourKey(now - TEMPO_TRANSFERS_KEEP_DAYS * 86400e3);
  const untrackedCutoff = hourKey(now - TEMPO_TRANSFERS_UNTRACKED_KEEP_MS);
  for (const hk of Object.keys(state.buckets)) {
    if (hk < cutoff) { delete state.buckets[hk]; continue; }
    if (track && hk < untrackedCutoff) {
      const bucket = state.buckets[hk];
      for (const r of Object.keys(bucket)) if (!track.has(r)) delete bucket[r];
      if (!Object.keys(bucket).length) delete state.buckets[hk];
    }
  }
  return state;
}

/** One incremental sync. Injectable fetch/clock. Throws on a hard failure
 *  (no key, first page unreadable); a failure mid-pagination keeps what was
 *  folded and records lastError. */
export async function syncTempoTransfers(state, { apiKey = tempoDataKey(), token, track = null, fetchImpl = fetch, now = Date.now(), maxPages = 240, backfillMs = DEFAULT_BACKFILL_MS } = {}) {
  if (!apiKey) throw new Error("tempo transfers: TEMPO_DATA_API_KEY unset");
  const fromMs = state.cursorTs ? Date.parse(state.cursorTs) - OVERLAP_MS : now - backfillMs;
  // Where continuous coverage WILL start once this backfill completes; only
  // promoted to coverageFromTs when a sync reads through to the end (an
  // incomplete backfill has a recent head but a hole behind it).
  if (!state.coverageFromTs && !state.pendingFromTs) state.pendingFromTs = new Date(fromMs).toISOString();
  const base = `${TEMPO_TRANSFERS_API}?${token ? `token=${encodeURIComponent(token)}&` : ""}timestamp.from=${encodeURIComponent(new Date(fromMs).toISOString())}&limit=${PAGE}&order=asc`;
  let cursor = null, pages = 0, added = 0;
  while (pages < maxPages) {
    const url = cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
    let res, body;
    try {
      res = await fetchImpl(url, { headers: { "tempo-api-key": apiKey, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      body = await res.json();
    } catch (e) {
      // lastError is PUBLISHED on /api/mpp-leaderboard (window.feed.lastError)
      // and persisted to /data - redact before it is recorded, never after.
      if (pages === 0) throw new Error(`tempo transfers: unreadable (${redactSecrets(String(e?.message || e)).slice(0, 160)})`);
      state.lastError = `page ${pages + 1}: ${redactSecrets(String(e?.message || e)).slice(0, 160)}`; break;
    }
    if (!res.ok || !Array.isArray(body?.data)) {
      const code = body?.error && typeof body.error === "object" && typeof body.error.code === "string" ? body.error.code.slice(0, 60) : "";
      // Status + the API's error CODE only: the body is an upstream response and
      // this string is public (see above) - its free-text message stays out.
      const msg = `tempo transfers: HTTP ${res.status}${code ? ` ${code}` : ""}`;
      if (pages === 0) throw new Error(msg);
      state.lastError = msg; break;
    }
    pages++;
    added += foldTransfers(state, body.data, { token, track });
    cursor = body.nextCursor || null;
    if (!cursor || body.data.length < PAGE) break;
  }
  if (pages > 0 && !cursor) {
    state.lastError = null; state.caughtUpAt = new Date(now).toISOString();
    if (!state.coverageFromTs && state.pendingFromTs) { state.coverageFromTs = state.pendingFromTs; state.pendingFromTs = null; }
  }
  pruneFeedState(state, now, { track });
  state.syncs += 1; state.lastSyncAt = now; state.lastPages = pages; state.lastNew = added;
  return { pages, added, complete: !cursor };
}

/** Stats per recipient (lowercase) over the last `windowMs`: transfers,
 *  distinct payers, volume (base units as BigInt). */
export function feedStats(state, recipients, { windowMs = 24 * 3600e3, now = Date.now() } = {}) {
  const from = hourKey(now - windowMs);
  const out = new Map(recipients.map((r) => [String(r).toLowerCase(), { transfers: 0, payers: new Set(), volumeAtomic: 0n }]));
  for (const [hk, bucket] of Object.entries(state.buckets || {})) {
    if (hk < from) continue;
    for (const [r, st] of out) {
      const e = bucket[r]; if (!e) continue;
      st.transfers += e.t;
      try { st.volumeAtomic += BigInt(e.v); } catch { /* skip amount */ }
      // An hour folded while the recipient was untracked kept its count and
      // not its senders: the distinct-payer figure is then a lower bound, not
      // a measurement (the proven floor reads it as unknown).
      if (e.t > 0 && !Array.isArray(e.p)) st.payersPartial = true;
      for (const p of e.p || []) st.payers.add(p);
    }
  }
  return out;
}

/** Day-bucketed history in the leaderboard's own shape ({days:{YYYY-MM-DD:{recipient:{t,v}}}}). */
export function feedHistoryDays(state) {
  const days = {};
  for (const [hk, bucket] of Object.entries(state.buckets || {})) {
    const d = dayOf(hk);
    const day = (days[d] ??= {});
    for (const [r, e] of Object.entries(bucket)) {
      const prev = day[r] || { t: 0, v: "0" };
      day[r] = { t: prev.t + e.t, v: (BigInt(prev.v) + BigInt(e.v)).toString() };
    }
  }
  return days;
}

/** Async variant for the scheduler: the stringify is still on-thread, but the
 *  write is not, and a failure never throws into the rebuild. */
export async function persistFeedStateAsync(state, file = TEMPO_TRANSFERS_CACHE_FILE) {
  try { await writeFile(file, JSON.stringify(state)); return true; } catch { return false; }
}
export function loadFeedState(file = TEMPO_TRANSFERS_CACHE_FILE) {
  return timedSync("Tempo transfer feed warm-start", file, () => _loadFeedState(file));
}
function _loadFeedState(file = TEMPO_TRANSFERS_CACHE_FILE) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    if (s && typeof s === "object" && s.buckets && typeof s.buckets === "object") return { ...emptyFeedState(), ...s, recentIds: Array.isArray(s.recentIds) ? s.recentIds : [] };
  } catch { /* cold */ }
  return null;
}
