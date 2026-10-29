// Which background jobs are running, for the [loop-lag] stall line.
//
// A stall with no request in flight was blocked by scheduled work, and the
// line could not say which. Every scheduled loop under leased() (state-db.js)
// and the few timers wrapped with runAsJob() register here while they run, so
// the stall line and the stall ring name them.
//
// A job that blocks the loop in its last synchronous stretch finishes (its
// finally runs in the microtasks right after the block) before the lag timer
// fires, so a stall also names the jobs that ENDED inside its window: a short
// ring of recent ends is kept for that.
//
// Cheap: one Map insert and delete per run, no timers, never throws.

const active = new Map(); // id -> { name, at }
const ENDED_RING = 64;
const ended = []; // [{ name, at, endedAt }], oldest first
let nextId = 1;

/** Run `fn` as the named background job; returns what `fn` returns (awaited). */
export async function runAsJob(name, fn) {
  const id = nextId++;
  const at = Date.now();
  const label = String(name || "job").slice(0, 80);
  active.set(id, { name: label, at });
  try { return await fn(); }
  finally {
    active.delete(id);
    ended.push({ name: label, at, endedAt: Date.now() });
    if (ended.length > ENDED_RING) ended.shift();
  }
}

/** Jobs running now, oldest first, as `name ageMs` strings. */
export function activeJobs(now = Date.now()) {
  return [...active.values()].sort((a, b) => a.at - b.at).map((j) => `${j.name} ${now - j.at}ms`);
}

/**
 * The job names that ran at any point in [fromMs, toMs]: those running now and
 * those that ended inside the window. Distinct names, running ones first.
 */
export function jobsDuring(fromMs, toMs = Date.now()) {
  const names = [];
  const add = (n) => { if (!names.includes(n)) names.push(n); };
  for (const j of [...active.values()].sort((a, b) => a.at - b.at)) if (j.at <= toMs) add(j.name);
  for (let i = ended.length - 1; i >= 0; i--) {
    const j = ended[i];
    if (j.endedAt >= fromMs && j.at <= toMs) add(j.name);
  }
  return names;
}
