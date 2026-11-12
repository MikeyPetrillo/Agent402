// How many distinct authors and posts x-search-recent calls return.
//
// The search sends `expansions=author_id`, so every distinct author of the
// page comes back once under `includes.users`, and each one is a user read on
// X's card. This keeps a per-UTC-day histogram of two counts per call: the
// distinct authors in `includes.users` and the posts in `data`, each in the
// buckets below. A call is counted in `calls` and the histograms only once its
// response has finished with a final 200 (the x402 middleware settles after
// the handler, and a settle that fails turns the answer into a 402, so the
// handler's own outcome is not the sale). Each count is split by lane:
// outside (a buyer) or synthetic (our own probes and wallets). Same shape and
// store as src/sql-query-stats.js.
// Each lane also keeps `authorReads`, the exact sum of distinct authors X
// returned, counted for every call X answered (noteXSearchAuthorReads), not
// only a final 200: X bills those reads, as the X spend meter books them,
// whether or not the sale then settles. Inside a request they count on the
// final response of any status (a failed settle, a hang-up), so the lane is
// the one the histograms use; outside a request, at once. A settle that fails
// adds its authors here and nothing to `calls` or the histograms. That is the day's expanded-user reads:
// xSearchAuthorsStatus() reads it into the xSearchAuthors word on
// /api/gateway-status (ok / alert past X_SEARCH_AUTHOR_DAILY_ALERT). The word
// is an alarm only: nothing is refused.
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
import { withLoopDeadline } from "./loop-deadline.js";
import { randomUUID } from "node:crypto";

export const X_SEARCH_STATS_DOC = "x-search-author-stats";
export const X_SEARCH_STATS_KEEP_DAYS = 120;
export const X_SEARCH_STATS_FLUSH_MS = () => Math.max(1_000, Number(process.env.X_SEARCH_STATS_FLUSH_MS) || 60_000);
export const LANES = ["outside", "synthetic"];
// Both counts share one bucket scale.
export const BUCKETS = ["0", "1", "2-3", "4-6", "7-10", "11+"];
export const MEASURES = ["authors", "posts"];

const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const emptyHist = () => Object.fromEntries(BUCKETS.map((b) => [b, 0]));
const emptyLane = () => ({ calls: 0, authorReads: 0, authors: emptyHist(), posts: emptyHist() });
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
// The batch a flush is writing: out of `pending`, maybe not yet in the row.
let inflightBatch = null;
let inflightId = null;
// Every flush tags the row with its batch id (the row keeps the last
// LANDED_KEEP ids), so a status read knows exactly which of this process's
// batches it already holds: none is counted twice, and none is dropped by a
// read that predates its write.
const LANDED_KEEP = 64;
const landedLocal = new Map(); // batch id -> the batch, for batches this process landed recently

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

/**
 * Count the authors of one X search answer, whatever the call's final
 * response: X bills them either way. Synchronous; the store write
 * is deferred. Feeds `authorReads` only.
 */
export function noteXSearchAuthorReads({ authors = 0, synthetic = false, now = Date.now() } = {}) {
  const n = Math.max(0, Math.floor(Number(authors) || 0));
  if (!n) return false;
  const lane = synthetic ? "synthetic" : "outside";
  (pending[utcDay(now)] ||= emptyDay())[lane].authorReads += n;
  startTimer();
  return true;
}

/** Count one finished x-search-recent call (calls and the histograms; a final 200 only). Synchronous; the store write is deferred. */
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
      into.authorReads = (Number(into.authorReads) || 0) + (Number(from?.authorReads) || 0);
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
  const id = randomUUID();
  inflightBatch = batch;
  inflightId = id;
  flushing = (async () => {
    try {
      const r = await docOf().update((b) => {
        const x = bodyOf(b);
        mergeInto(x.days, batch);
        prune(x.days, now);
        x.landed = [...(Array.isArray(x.landed) ? x.landed : []), id].slice(-LANDED_KEEP);
        return x;
      }, { fallback: null });
      if (!r?.ok) { pending = mergeInto(pending, batch); return { ok: false }; }
      landedLocal.set(id, batch);
      while (landedLocal.size > LANDED_KEEP) landedLocal.delete(landedLocal.keys().next().value);
      // The cached stored day now holds this batch too, unless the read it came
      // from already did.
      if (storedToday.ok && !storedToday.landed.has(id)) {
        storedToday = { ...storedToday, reads: storedToday.reads + readsOf(batch[storedToday.day]), landed: new Set([...storedToday.landed, id]) };
      }
      return { ok: true, flushed: true };
    } catch {
      pending = mergeInto(pending, batch);
      return { ok: false };
    } finally { inflightBatch = null; inflightId = null; flushing = null; }
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

// The day's author reads past which xSearchAuthors reads alert. A search page
// holds at most X_MAX_POSTS_PER_CALL posts (src/tools/x-data-kit.js, default
// 10), so at most that many distinct authors: at the default, 500 is 50 full
// pages of distinct authors in one UTC day, many times the route's normal
// day, so a normal day reads ok and growth worth a look reads alert. Every
// expanded author is also on the X spend meter, so the daily X ceiling
// (X_DATA_DAILY_MAX_USD) still bounds the day's whole X spend.
export const X_SEARCH_AUTHOR_DAILY_ALERT_DEFAULT = 500;
export const xSearchAuthorDailyAlert = () => {
  const n = Number(process.env.X_SEARCH_AUTHOR_DAILY_ALERT);
  return Number.isFinite(n) && n > 0 ? n : X_SEARCH_AUTHOR_DAILY_ALERT_DEFAULT;
};
const STATUS_READ_TTL_MS = 30_000;
// The longest a status read waits on the store (loop time); past it the word
// reads as a failed read would.
export const X_SEARCH_STATUS_READ_MS = 400;
let storedToday = { day: null, reads: 0, at: 0, ok: false, landed: new Set() };
let statusRead = null;
const readsOf = (day) => LANES.reduce((a, l) => a + (Number(day?.[l]?.authorReads) || 0), 0);

// One store read shared by every concurrent status request, bounded by
// X_SEARCH_STATUS_READ_MS. A batch this process landed that the row does not
// list yet (the read predates its write) is added back from memory.
function refreshStoredToday(d, now) {
  if (statusRead) return statusRead;
  statusRead = withLoopDeadline(Promise.resolve().then(() => docOf().read({ quiet: true })), X_SEARCH_STATUS_READ_MS, null)
    .catch(() => null)
    .then((r) => {
      statusRead = null;
      if (!r?.ok) { storedToday = { day: d, reads: 0, at: now, ok: false, landed: new Set() }; return; }
      const body = bodyOf(r.body);
      const landed = new Set(Array.isArray(body.landed) ? body.landed : []);
      let reads = readsOf(body.days[d]);
      for (const [id, batch] of landedLocal) {
        if (!landed.has(id)) { reads += readsOf(batch[d]); landed.add(id); }
      }
      storedToday = { day: d, reads, at: now, ok: true, landed };
    });
  return statusRead;
}

/**
 * The xSearchAuthors word: today's expanded-author reads (both lanes: our own
 * probes cost the same) against X_SEARCH_AUTHOR_DAILY_ALERT. ok / alert, or
 * unknown when the stored day cannot be read and this process has counted
 * nothing over the mark. One bounded store read, reused for 30 s; never
 * rejects. `full` adds the figures for the operator view.
 */
export async function xSearchAuthorsStatus({ now = Date.now(), full = false } = {}) {
  const d = utcDay(now);
  if (storedToday.day !== d || now - storedToday.at >= STATUS_READ_TTL_MS) await refreshStoredToday(d, now);
  // A batch being written counts too (the alarm errs toward alert while a
  // write is in flight), so a flush never dips the figure.
  const inflight = inflightId && !(storedToday.ok && storedToday.landed.has(inflightId)) ? readsOf(inflightBatch?.[d]) : 0;
  const reads = (storedToday.day === d ? storedToday.reads : 0) + readsOf(pending[d]) + inflight;
  const mark = xSearchAuthorDailyAlert();
  const status = reads > mark ? "alert" : storedToday.ok ? "ok" : "unknown";
  return full ? { status, authorReadsToday: reads, alertAbove: mark, scope: storedToday.ok ? "stored" : "unread" } : { status };
}

/** Test seam. */
export function _resetXSearchStats() { pending = {}; inflightBatch = null; inflightId = null; landedLocal.clear(); statusRead = null; if (timer) { clearInterval(timer); timer = null; } doc = null; storedToday = { day: null, reads: 0, at: 0, ok: false, landed: new Set() }; }
/** Test seam: the document the module reads and writes. */
export function _xSearchStatsDoc() { return docOf(); }
