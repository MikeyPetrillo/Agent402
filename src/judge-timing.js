// How long a judgment takes: each backend read, and the whole walk.
//
// A judgment is answered by the first backend that can (src/tools/judge-kit.js
// firstAnswer): the walk may read one backend or several. A deadline for it
// (a referral copy's, say) can only be sized from what those reads take, so
// every read is timed with how it ended, and every walk with its whole time,
// the backends it tried and whether the first one answered.
//
// Kept in this process: the newest JUDGE_TIMING_SAMPLES durations per backend
// and per walk, and counters. No payer, no input, no answer. Read on the
// operator view (/__operator/judge-timing.json); once an hour, while calls
// arrive, the same figures go to the log, so they outlive a deploy.
export const JUDGE_TIMING_SAMPLES = 500;
export const JUDGE_TIMING_LOG_EVERY_MS = 60 * 60_000;
export const JUDGE_BACKENDS = Object.freeze(["jev", "jev-openrouter", "decision-one", "gemini", "luna"]);
/** How a backend read ended: it answered, it failed without billing us, or it
 *  may have been billed with no usable answer (a timeout, an unreadable 200). */
export const JUDGE_OUTCOMES = Object.freeze(["ok", "failed", "unconfirmed"]);

const ring = () => ({ samples: [], next: 0, total: 0 });
const push = (r, ms) => {
  if (r.samples.length < JUDGE_TIMING_SAMPLES) r.samples.push(ms);
  else { r.samples[r.next] = ms; r.next = (r.next + 1) % JUDGE_TIMING_SAMPLES; }
  r.total++;
};
/** Nearest-rank percentile of a sample list (null when empty). */
function percentile(samples, p) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
const figures = (r) => ({ n: r.samples.length, total: r.total, p50Ms: percentile(r.samples, 50), p95Ms: percentile(r.samples, 95), maxMs: r.samples.length ? Math.max(...r.samples) : null });

let backends = new Map(); // backend -> { ring, outcomes }
let walks = { ring: ring(), served: 0, notServed: 0, fallbackServed: 0, byBackendsTried: {}, fallbacks: {} };
let since = 0, loggedAt = null;

/** One backend read: how long it took and how it ended. */
export function noteJudgeBackend(backend, ms, outcome, now = Date.now()) {
  if (!JUDGE_BACKENDS.includes(backend) || !Number.isFinite(ms) || ms < 0) return;
  if (!since) since = now;
  let b = backends.get(backend);
  if (!b) { b = { ring: ring(), outcomes: { ok: 0, failed: 0, unconfirmed: 0 } }; backends.set(backend, b); }
  push(b.ring, Math.round(ms));
  b.outcomes[JUDGE_OUTCOMES.includes(outcome) ? outcome : "failed"]++;
}

/** One whole walk: its time, the backends it tried in order, and the one that answered (null: none did). */
export function noteJudgeWalk({ ms, tried = [], served = null, now = Date.now() } = {}) {
  if (!Number.isFinite(ms) || ms < 0) return;
  if (!since) since = now;
  const order = (Array.isArray(tried) ? tried : []).filter((b) => JUDGE_BACKENDS.includes(b));
  push(walks.ring, Math.round(ms));
  const k = String(Math.min(order.length, JUDGE_BACKENDS.length));
  walks.byBackendsTried[k] = (walks.byBackendsTried[k] || 0) + 1;
  if (served && JUDGE_BACKENDS.includes(served)) {
    walks.served++;
    if (order.length && order[0] !== served) {
      walks.fallbackServed++;
      const pair = `${order[0]}>${served}`;
      walks.fallbacks[pair] = (walks.fallbacks[pair] || 0) + 1;
    }
  } else walks.notServed++;
  try { logHourly(now); } catch { /* a log line never fails a judgment */ }
}

function logHourly(now) {
  if (loggedAt === null) { loggedAt = now; return; }
  if (now - loggedAt < JUDGE_TIMING_LOG_EVERY_MS) return;
  loggedAt = now;
  const parts = [...backends.entries()].map(([name, b]) => { const f = figures(b.ring); return `${name} n=${f.n} p50=${f.p50Ms}ms p95=${f.p95Ms}ms failed=${b.outcomes.failed} unconfirmed=${b.outcomes.unconfirmed}`; });
  const w = figures(walks.ring);
  console.log(`[judge] timing: ${parts.join("; ")}; walks n=${w.n} p50=${w.p50Ms}ms p95=${w.p95Ms}ms fallback=${walks.fallbackServed} not-served=${walks.notServed}`);
}

/** The operator view: per backend and per walk. */
export function judgeTimingReport({ now = Date.now() } = {}) {
  const w = figures(walks.ring);
  return {
    since: since ? new Date(since).toISOString() : null,
    asOf: new Date(now).toISOString(),
    samplesKept: JUDGE_TIMING_SAMPLES,
    backends: Object.fromEntries([...backends.entries()].map(([name, b]) => [name, { ...figures(b.ring), outcomes: { ...b.outcomes } }])),
    walks: { ...w, served: walks.served, notServed: walks.notServed, fallbackServed: walks.fallbackServed, byBackendsTried: { ...walks.byBackendsTried }, fallbacks: { ...walks.fallbacks } },
    note: "Durations are the newest samples kept in this process (per backend and per walk); counters run since `since`. A walk is one judgment: every backend it read, to the answer or the last failure.",
  };
}

/** Test seam. */
export function __resetJudgeTiming() {
  backends = new Map();
  walks = { ring: ring(), served: 0, notServed: 0, fallbackServed: 0, byBackendsTried: {}, fallbacks: {} };
  since = 0; loggedAt = null;
}
