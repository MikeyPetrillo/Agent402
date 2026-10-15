// In-flight admission that heals itself.
//
// A gate of the shape `if (inFlight >= MAX) refuse; inFlight++; try { await
// work } finally { inFlight-- }` is only as sound as the promise it awaits: a
// piece of work that never settles keeps its slot for the life of the process,
// and MAX such pieces close the surface until a restart. The counter cannot
// tell a slot that is working from one that is stuck.
//
// This gauge records a start time per entry instead of a bare count. Admission
// reads `live()`, which counts only entries younger than `staleMs`: an entry
// past that age is still listed (the operator surface shows it and its age)
// but no longer refuses anyone. `raceDeadline` is the matching bound for the
// work itself: the caller gets a result or a timeout verdict by the deadline,
// and a result that arrives later is observed only to keep the rejection from
// going unhandled.

/** @param {{ staleMs: number }} opts */
export function createInFlightGauge({ staleMs }) {
  const ms = Number(staleMs);
  if (!Number.isFinite(ms) || ms <= 0) throw new TypeError("createInFlightGauge: staleMs must be a positive number");
  const entries = new Map(); // id -> { at, ...meta }
  let seq = 0;
  const live = (now = Date.now()) => {
    let n = 0;
    for (const e of entries.values()) if (now - e.at < ms) n++;
    return n;
  };
  const oldestAgeMs = (now = Date.now()) => {
    let oldest = null;
    for (const e of entries.values()) { const age = now - e.at; if (oldest === null || age > oldest) oldest = age; }
    return oldest;
  };
  return {
    /** Register one in-flight unit; returns its release function (idempotent). */
    enter(meta = {}, now = Date.now()) {
      const id = ++seq;
      entries.set(id, { at: now, ...meta });
      return () => entries.delete(id);
    },
    /** Entries younger than staleMs: the number admission compares against. */
    live,
    /** Every entry, stuck ones included. */
    size() { return entries.size; },
    /** Age of the oldest entry in ms, or null when empty. */
    oldestAgeMs,
    staleMs: ms,
    /** Operator view: counts and ages only. */
    snapshot(now = Date.now()) {
      return { inFlight: entries.size, live: live(now), oldestAgeMs: oldestAgeMs(now), staleMs: ms };
    },
  };
}

/**
 * Wait on `promise` for at most `ms`. Resolves `{ value }` when it settles in
 * time, `{ timedOut: true }` when it does not, and rejects with the promise's
 * own error when it rejects in time. A late settlement is swallowed so it
 * cannot surface as an unhandled rejection; the caller has already moved on.
 */
export function raceDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      Promise.resolve(promise).catch(() => {});
      resolve({ timedOut: true });
    }, Math.max(1, Number(ms) || 1));
    Promise.resolve(promise).then(
      (value) => { if (done) return; done = true; clearTimeout(timer); resolve({ value }); },
      (err) => { if (done) return; done = true; clearTimeout(timer); reject(err); },
    );
  });
}
