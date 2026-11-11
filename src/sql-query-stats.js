// How many upstream queries onchain-sql calls actually use.
//
// A call may send the query service up to SQL_QUERY_BUDGET queries
// (src/tools/cdp-kit.js): the query itself, then the row-size measure and the
// filtered run or one small re-run when the service will not send the result.
// This keeps a per-UTC-day histogram of the queries a call sent (0 for a call
// the handler refused before any query, then 1, 2 or 3), split by how the
// call ended:
//   charged    its response finished with a final 200 and the payment settled
//              (or a credits debit);
//   free       a final 200 nothing was charged for (FREE_MODE, proof-of-work,
//              a trial, a first-call allowance);
//   uncharged  any other end: a 4xx or 5xx the handler answered, a 402 after
//              the handler ran (the x402 middleware settles after the handler,
//              and a settle that fails turns the answer into a 402, so the
//              handler's own outcome is not the sale), or a buyer who left
//              before the answer (499).
// A call is counted once its response has ended, never when the handler
// returned. The budget refusals (the uncharged 422 for a spent query budget)
// are also counted on their own. Each count is split by lane: outside (a
// buyer) or synthetic (our own probes and wallets).
//
// Counts only: never the SQL text, a request field, a payer or an address.
//
// Stored as one state document (src/json-document.js): the state database
// when one is configured (shared across replicas, kept across deploys), the
// file otherwise. Each process adds its increments to memory synchronously and
// folds them into the document with update() (a read-modify-write that never
// drops another replica's increments) on a timer and at shutdown, so the
// answer path never waits on the store. A failure here is counted, logged at
// most once a UTC day, and never reaches the call.
import { createJsonDocument } from "./json-document.js";

export const SQL_STATS_DOC = "onchain-sql-query-stats";
/** The fewest UTC days kept, today included: today and the 120 days before it, as every earlier build kept. */
export const SQL_STATS_MIN_KEEP_DAYS = 121;
/** UTC days kept, today included (SQL_QUERY_STATS_KEEP_DAYS, default 121, up to 400; never fewer than the default). */
export const SQL_STATS_KEEP_DAYS = () => {
  const n = Math.floor(Number(process.env.SQL_QUERY_STATS_KEEP_DAYS));
  return Number.isFinite(n) && n > SQL_STATS_MIN_KEEP_DAYS ? Math.min(n, 400) : SQL_STATS_MIN_KEEP_DAYS;
};
export const SQL_STATS_FLUSH_MS = () => Math.max(1_000, Number(process.env.SQL_QUERY_STATS_FLUSH_MS) || 60_000);
export const LANES = ["outside", "synthetic"];
export const OUTCOMES = ["charged", "free", "uncharged"];
// Queries a call sent: 0 (refused before any query) to the call budget.
export const BUCKETS = ["q0", "q1", "q2", "q3"];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
const emptyHist = () => Object.fromEntries(BUCKETS.map((b) => [b, 0]));
const emptyLane = () => ({ ...Object.fromEntries(OUTCOMES.map((o) => [o, emptyHist()])), budgetSpent: 0 });
const emptyDay = () => Object.fromEntries(LANES.map((l) => [l, emptyLane()]));

let doc = null;
const docOf = () => {
  if (!doc) doc = createJsonDocument({ name: SQL_STATS_DOC, file: process.env.SQL_QUERY_STATS_FILE || "/data/onchain-sql-query-stats.json", log: () => {} });
  return doc;
};
const bodyOf = (b) => (b && typeof b === "object" && b.days && typeof b.days === "object" ? b : { days: {} });

// Increments not yet folded into the document: day -> lane -> outcome -> bucket -> n.
let pending = {};
let timer = null;
let flushing = null;
// Failures of this module since boot (a count that could not be taken, a
// store write that did not land), and the UTC day one was last logged.
let failures = 0;
let failureLoggedDay = null;
function noteFailure(what) {
  failures++;
  const d = utcDay();
  if (failureLoggedDay === d) return;
  failureLoggedDay = d;
  try { console.warn(`[sql-query-stats] ${what}; counts are kept in memory and retried (logged once a day)`); } catch { /* a log line never fails a call */ }
}

/**
 * How a finished call ended. `status` is the response's FINAL status (499
 * when the buyer left before it finished); `sale` is what the server read
 * from that final response: "charged" (a settled payment or a credits debit),
 * "free" (nothing was asked), anything else no evidence of either.
 */
export function outcomeOf({ status, sale = null } = {}) {
  if (status !== 200) return "uncharged";
  if (sale === "charged") return "charged";
  if (sale === "free") return "free";
  return "uncharged";
}

/** The histogram bucket for the queries a call sent (clamped to the buckets). */
export function bucketOf(queries = 0) {
  const n = Math.floor(Number(queries) || 0);
  return `q${Math.max(0, Math.min(n, BUCKETS.length - 1))}`;
}

/**
 * Count one finished onchain-sql call. Synchronous; the store write is
 * deferred. Never throws: a failure is counted and the call is not.
 */
export function noteSqlCall({ status, queries = 0, budgetSpent = false, synthetic = false, sale = null, now = Date.now() } = {}) {
  try {
    const d = utcDay(now);
    const lane = (pending[d] ||= emptyDay())[synthetic ? "synthetic" : "outside"];
    lane[outcomeOf({ status, sale })][bucketOf(queries)]++;
    if (budgetSpent) lane.budgetSpent++;
    startTimer();
    return true;
  } catch {
    noteFailure("a call could not be counted");
    return false;
  }
}

// A lane as stored by any build. Before the outcome split a lane held q1..q3
// for calls that answered a final 200 (the tool has no free tier, so those
// were settled calls); they are read as charged.
function addLane(into, from) {
  if (!from || typeof from !== "object") return into;
  for (const o of OUTCOMES) for (const b of BUCKETS) into[o][b] += num(from[o]?.[b]);
  for (const b of BUCKETS) into.charged[b] += num(from[b]);
  into.budgetSpent += num(from.budgetSpent);
  return into;
}
function mergeInto(days, add) {
  for (const [d, lanes] of Object.entries(add || {})) {
    if (!DAY_RE.test(d)) continue;
    const day = emptyDay();
    for (const l of LANES) { addLane(day[l], days[d]?.[l]); addLane(day[l], lanes?.[l]); }
    days[d] = day;
  }
  return days;
}
// Today and the keep - 1 days before it stay; an older day is dropped.
function prune(days, now = Date.now(), keep = SQL_STATS_KEEP_DAYS()) {
  const cutoff = utcDay(now - (keep - 1) * 86_400_000);
  for (const d of Object.keys(days)) if (!DAY_RE.test(d) || d < cutoff) delete days[d];
  return days;
}

/** Fold the pending increments into the document. Never throws; a failed write keeps them for the next flush. */
export async function flushSqlQueryStats({ now = Date.now() } = {}) {
  if (flushing) return flushing;
  const batch = pending;
  if (!Object.keys(batch).length) return { ok: true, flushed: false };
  pending = {};
  const keepBatch = () => { pending = prune(mergeInto(pending, batch), now); noteFailure("the store write did not land"); return { ok: false }; };
  flushing = (async () => {
    try {
      const r = await docOf().update((b) => {
        const x = bodyOf(b);
        // Every stored day is rewritten in the current shape.
        const days = mergeInto(mergeInto({}, x.days), batch);
        return { ...x, days: prune(days, now) };
      }, { fallback: null });
      return r?.ok ? { ok: true, flushed: true } : keepBatch();
    } catch {
      return keepBatch();
    } finally { flushing = null; }
  })();
  return flushing;
}

function startTimer() {
  if (timer) return;
  timer = setInterval(() => { flushSqlQueryStats().catch(() => {}); }, SQL_STATS_FLUSH_MS());
  timer.unref?.();
}

const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
const callsIn = (hist) => BUCKETS.reduce((n, b) => n + num(hist[b]), 0);
const queriesIn = (hist) => BUCKETS.reduce((n, b, i) => n + i * num(hist[b]), 0);
// Calls and queries by outcome for one lane, and two ratios over its charged
// calls: the queries those calls sent, and every query the lane sent.
function summaryOf(lane) {
  const calls = Object.fromEntries(OUTCOMES.map((o) => [o, callsIn(lane[o])]));
  const queries = Object.fromEntries(OUTCOMES.map((o) => [o, queriesIn(lane[o])]));
  const all = OUTCOMES.reduce((n, o) => n + queries[o], 0);
  return { calls, queries, queriesPerChargedCall: ratio(queries.charged, calls.charged), allQueriesPerChargedCall: ratio(all, calls.charged) };
}

/** The histogram for the operator view: stored days plus this process's unflushed counts, newest first. Counts only. */
export async function sqlQueryStatsReport({ days = SQL_STATS_KEEP_DAYS(), now = Date.now() } = {}) {
  let stored = { days: {} }, scope = "stored";
  try {
    const r = await docOf().read({ quiet: true });
    if (r?.ok) stored = bodyOf(r.body); else scope = "unread";
  } catch { scope = "unread"; }
  // A batch being written may or may not be in the row just read; it is
  // counted once it lands, so only the unflushed counts are added here.
  const merged = mergeInto(mergeInto({}, stored.days), pending);
  const window = Math.max(1, Math.floor(Number(days)) || 1);
  const cutoff = utcDay(now - (window - 1) * 86_400_000);
  const rows = Object.keys(merged).filter((d) => d >= cutoff).sort().reverse().map((d) => ({ day: d, ...merged[d] }));
  const totals = emptyDay();
  for (const r of rows) for (const l of LANES) addLane(totals[l], r[l]);
  const summary = Object.fromEntries(LANES.map((l) => [l, summaryOf(totals[l])]));
  return {
    outcomes: OUTCOMES, buckets: BUCKETS, days: rows, totals, summary,
    // The outside lane's ratio: upstream queries its charged calls sent, per charged call.
    queriesPerChargedCall: summary.outside.queriesPerChargedCall,
    windowDays: window, keepDays: SQL_STATS_KEEP_DAYS(), scope, failures,
  };
}

/** Test seams. */
export function _resetSqlQueryStats() { pending = {}; if (timer) { clearInterval(timer); timer = null; } doc = null; failures = 0; failureLoggedDay = null; }
export function _setSqlQueryStatsDocForTest(d) { doc = d; }
