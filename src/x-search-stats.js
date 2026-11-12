// How many distinct authors and posts x-search-recent calls return.
//
// The search sends `expansions=author_id`, so every distinct author of the
// page comes back once under `includes.users`, and each one is a user read on
// X's card. This keeps a per-UTC-day histogram of two counts per call: the
// distinct authors in `includes.users` and the posts in `data`, each in the
// buckets below. A call is counted only once its response has finished with
// a final 200 (the x402 middleware settles after the handler, and a settle
// that fails turns the answer into a 402, so the handler's own outcome is not
// the sale). Each count is split by lane: outside (a buyer) or synthetic (our
// own probes and wallets). Same shape and store as src/sql-query-stats.js.
//
// Counts only: never a username, a user or post id, or the query text.
//
// Stored as one state document (src/json-document.js): the state database
// when one is configured (shared across replicas, kept across deploys), the
// file otherwise. Each process adds its increments to memory synchronously and
// folds them into the document with update() (a read-modify-write that never
// drops another replica's increments) on a timer and at shutdown, so the
// answer path never waits on the store.
import { createJsonDocument } from "./json-document.js";

export const X_SEARCH_STATS_DOC = "x-search-author-stats";
export const X_SEARCH_STATS_KEEP_DAYS = 120;
export const X_SEARCH_STATS_FLUSH_MS = () => Math.max(1_000, Number(process.env.X_SEARCH_STATS_FLUSH_MS) || 60_000);
export const LANES = ["outside", "synthetic"];
// Both counts share one bucket scale.
export const BUCKETS = ["0", "1", "2-3", "4-6", "7-10", "11+"];
export const MEASURES = ["authors", "posts"];

const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const emptyHist = () => Object.fromEntries(BUCKETS.map((b) => [b, 0]));
const emptyLane = () => ({ calls: 0, authors: emptyHist(), posts: emptyHist() });
const emptyDay = () => Object.fromEntries(LANES.map((l) => [l, emptyLane()]));

let doc = null;
const docOf = () => {
  if (!doc) doc = createJsonDocument({ name: X_SEARCH_STATS_DOC, file: process.env.X_SEARCH_STATS_FILE || "/data/x-search-author-stats.json", log: () => {} });
  return doc;
};
const bodyOf = (b) => (b && typeof b === "object" && b.days && typeof b.days === "object" ? b : { days: {} });

// Increments not yet folded into the document: day -> lane -> counts.
let pending = {};
let timer = null;
let flushing = null;

/** The bucket a count falls in. */
export function bucketOf(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v <= 1) return String(v);
  if (v <= 3) return "2-3";
  if (v <= 6) return "4-6";
  if (v <= 10) return "7-10";
  return "11+";
}

/** Distinct authors and posts in one X search response. Counts only. */
export function countsOf(data) {
  const users = Array.isArray(data?.includes?.users) ? data.includes.users : [];
  const ids = new Set();
  for (const u of users) {
    const key = u?.id ?? u?.username;
    if (key !== undefined && key !== null && key !== "") ids.add(String(key));
  }
  const posts = Array.isArray(data?.data) ? data.data.length : 0;
  return { authors: ids.size, posts };
}

/** Count one finished x-search-recent call. Synchronous; the store write is deferred. */
export function noteXSearchCall({ status, authors = 0, posts = 0, synthetic = false, now = Date.now() } = {}) {
  if (status !== 200) return false;
  const d = utcDay(now);
  const lane = synthetic ? "synthetic" : "outside";
  const day = (pending[d] ||= emptyDay());
  day[lane].calls++;
  day[lane].authors[bucketOf(authors)]++;
  day[lane].posts[bucketOf(posts)]++;
  startTimer();
  return true;
}

function mergeInto(days, add) {
  for (const [d, lanes] of Object.entries(add)) {
    const day = (days[d] ||= emptyDay());
    for (const l of LANES) {
      const into = (day[l] ||= emptyLane());
      const from = lanes?.[l];
      into.calls = (Number(into.calls) || 0) + (Number(from?.calls) || 0);
      for (const m of MEASURES) {
        into[m] ||= emptyHist();
        for (const b of BUCKETS) into[m][b] = (Number(into[m][b]) || 0) + (Number(from?.[m]?.[b]) || 0);
      }
    }
  }
  return days;
}
function prune(days, now = Date.now()) {
  const cutoff = utcDay(now - X_SEARCH_STATS_KEEP_DAYS * 86_400_000);
  for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
  return days;
}

/** Fold the pending increments into the document. Never throws; a failed write keeps them for the next flush. */
export async function flushXSearchStats({ now = Date.now() } = {}) {
  if (flushing) return flushing;
  const batch = pending;
  if (!Object.keys(batch).length) return { ok: true, flushed: false };
  pending = {};
  flushing = (async () => {
    try {
      const r = await docOf().update((b) => {
        const x = bodyOf(b);
        mergeInto(x.days, batch);
        prune(x.days, now);
        return x;
      }, { fallback: null });
      if (!r?.ok) { pending = mergeInto(pending, batch); return { ok: false }; }
      return { ok: true, flushed: true };
    } catch {
      pending = mergeInto(pending, batch);
      return { ok: false };
    } finally { flushing = null; }
  })();
  return flushing;
}

function startTimer() {
  if (timer) return;
  timer = setInterval(() => { flushXSearchStats().catch(() => {}); }, X_SEARCH_STATS_FLUSH_MS());
  timer.unref?.();
}

/** The histogram for the operator view: stored days plus this process's unflushed counts, newest first. Counts only. */
export async function xSearchStatsReport({ days = 30, now = Date.now() } = {}) {
  let stored = { days: {} }, scope = "stored";
  try {
    const r = await docOf().read({ quiet: true });
    if (r?.ok) stored = bodyOf(r.body); else scope = "unread";
  } catch { scope = "unread"; }
  // A batch being written may or may not be in the row just read; it is
  // counted once it lands, so only the unflushed counts are added here.
  const merged = mergeInto(JSON.parse(JSON.stringify(stored.days)), pending);
  const cutoff = utcDay(now - (Math.max(1, days) - 1) * 86_400_000);
  const rows = Object.keys(merged).filter((d) => d >= cutoff).sort().reverse().map((d) => ({ day: d, ...merged[d] }));
  const sum = { all: emptyDay() };
  for (const r of rows) mergeInto(sum, { all: r });
  const totals = sum.all;
  return { buckets: BUCKETS, days: rows, totals, windowDays: Math.max(1, days), scope };
}

/** Test seam. */
export function _resetXSearchStats() { pending = {}; if (timer) { clearInterval(timer); timer = null; } doc = null; }
