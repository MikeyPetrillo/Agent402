// How many upstream queries onchain-sql calls actually use.
//
// A call may send the query service up to SQL_QUERY_BUDGET queries
// (src/tools/cdp-kit.js): the query itself, then the row-size measure and the
// filtered run or one small re-run when the service will not send the result.
// This keeps a per-UTC-day histogram of the queries a call used, counted only
// once the call's response has finished with a final 200 (the x402 middleware
// settles after the handler, and a settle that fails turns the answer into a
// 402, so the handler's own outcome is not the sale), plus the calls refused
// for exhausting the budget (the uncharged 422), counted when that answer
// finished. Each count is split by lane: outside (a buyer) or synthetic (our
// own probes and wallets).
//
// Counts only: never the SQL text, a payer or an address.
//
// Stored as one state document (src/json-document.js): the state database
// when one is configured (shared across replicas, kept across deploys), the
// file otherwise. Each process adds its increments to memory synchronously and
// folds them into the document with update() (a read-modify-write that never
// drops another replica's increments) on a timer and at shutdown, so the
// answer path never waits on the store.
import { createJsonDocument } from "./json-document.js";

export const SQL_STATS_DOC = "onchain-sql-query-stats";
export const SQL_STATS_KEEP_DAYS = 120;
export const SQL_STATS_FLUSH_MS = () => Math.max(1_000, Number(process.env.SQL_QUERY_STATS_FLUSH_MS) || 60_000);
export const LANES = ["outside", "synthetic"];
// One row per lane: queries used by a final-200 call (1, 2 or 3) and the
// budget refusals.
export const BUCKETS = ["q1", "q2", "q3", "budgetSpent"];

const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const emptyLane = () => Object.fromEntries(BUCKETS.map((b) => [b, 0]));
const emptyDay = () => Object.fromEntries(LANES.map((l) => [l, emptyLane()]));

let doc = null;
const docOf = () => {
  if (!doc) doc = createJsonDocument({ name: SQL_STATS_DOC, file: process.env.SQL_QUERY_STATS_FILE || "/data/onchain-sql-query-stats.json", log: () => {} });
  return doc;
};
const bodyOf = (b) => (b && typeof b === "object" && b.days && typeof b.days === "object" ? b : { days: {} });

// Increments not yet folded into the document: day -> lane -> bucket -> n.
let pending = {};
let timer = null;
let flushing = null;

/** The bucket a call falls in, or null for an outcome that is not counted. */
export function bucketOf({ status, queries = 0, budgetSpent = false }) {
  if (budgetSpent) return "budgetSpent";
  if (status !== 200) return null;
  const n = Math.floor(Number(queries) || 0);
  return n >= 1 && n <= 3 ? `q${n}` : null;
}

/** Count one finished onchain-sql call. Synchronous; the store write is deferred. */
export function noteSqlCall({ status, queries = 0, budgetSpent = false, synthetic = false, now = Date.now() } = {}) {
  const bucket = bucketOf({ status, queries, budgetSpent });
  if (!bucket) return false;
  const d = utcDay(now);
  const lane = synthetic ? "synthetic" : "outside";
  const day = (pending[d] ||= emptyDay());
  day[lane][bucket]++;
  startTimer();
  return true;
}

function mergeInto(days, add) {
  for (const [d, lanes] of Object.entries(add)) {
    const day = (days[d] ||= emptyDay());
    for (const l of LANES) {
      day[l] ||= emptyLane();
      for (const b of BUCKETS) day[l][b] = (Number(day[l][b]) || 0) + (Number(lanes?.[l]?.[b]) || 0);
    }
  }
  return days;
}
function prune(days, now = Date.now()) {
  const cutoff = utcDay(now - SQL_STATS_KEEP_DAYS * 86_400_000);
  for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
  return days;
}

/** Fold the pending increments into the document. Never throws; a failed write keeps them for the next flush. */
export async function flushSqlQueryStats({ now = Date.now() } = {}) {
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
  timer = setInterval(() => { flushSqlQueryStats().catch(() => {}); }, SQL_STATS_FLUSH_MS());
  timer.unref?.();
}

/** The histogram for the operator view: stored days plus this process's unflushed counts, newest first. Counts only. */
export async function sqlQueryStatsReport({ days = 30, now = Date.now() } = {}) {
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
  const totals = { outside: emptyLane(), synthetic: emptyLane() };
  for (const r of rows) for (const l of LANES) for (const b of BUCKETS) totals[l][b] += Number(r[l]?.[b]) || 0;
  return { buckets: BUCKETS, days: rows, totals, windowDays: Math.max(1, days), scope };
}

/** Test seam. */
export function _resetSqlQueryStats() { pending = {}; if (timer) { clearInterval(timer); timer = null; } doc = null; }
