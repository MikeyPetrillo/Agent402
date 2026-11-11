// The boot /supported read of a facilitator: up to three tries, inside a
// bound no longer than the boot reads it replaced.
//
// WHY. A rail is offered only when a facilitator's /supported lists it
// (src/payments.js, the boot guard). The read used to be one 6 s wait and one
// retry 2 s later, and the Arc and Circle Gateway batched reads one 8 s wait
// each, in sequence after it. A single slow answer of ours (our 6 s limit
// passing, not the facilitator saying anything) dropped the rail, and nothing
// said which of the two it was: our probe timing out, or the facilitator not
// listing the network. Worse, the retry asked the memoized getSupported, which
// handed back the same request still in flight, so a hung read was one long
// wait, not two tries.
//
// THE READ. A third try is made only after a try of ours timed out (two
// error answers keep the two tries they had). Try 1 asks the client as every caller does (the memo, so the
// x402 init that follows reads the same request, as before). Tries 2 and 3
// each start a NEW request (`readFresh`), and every request still out keeps
// counting: whichever answers first inside the bound is the answer, so a slow
// first answer that lands during the second try is used. Tries start at 0,
// tryMs + tryMs/3 and 2 x tryMs + 5/3 x tryMs (0, 8 s and 22 s at the 6 s
// default, about 28 s for all three), and a try is started only when it can
// run at least MIN_TRY_MS before the bound.
//
// THE BOUND. Every boot read now runs at once (the exact guard, Arc's read,
// the batched read), so the boot waits for the slowest one, not their sum.
// The bound is what the boot held before for the same configuration: 14 s for
// the guard (6 + 2 + 6), plus 8 s for each read that used to follow it (Arc,
// the batched option). A deployment without either keeps 14 s, so its third
// try is the background re-read (src/rail-recheck.js); one with both gets
// 30 s and all three tries. X402_SUPPORTED_TRY_MS and X402_SUPPORTED_BOOT_MS
// override the try and the bound (tests; the bound scales with the try when
// only the try is set).
//
// THE WORD. The outcome is one of: the answer; "probe-timeout" (the last try
// got no answer within our limit: ours, says nothing about the facilitator);
// "read-failed" (the facilitator or the connection answered with an error).
// src/payments.js turns these into the reason /api/rails publishes, beside
// "not-advertised" (it answered without the network).

export const BOOT_TRY_MS = 6_000;
export const BOOT_TRIES = 3;
/** The guard's bound before: 6 s, a 2 s pause, 6 s. */
export const BOOT_GUARD_MS = 14_000;
/** Each boot read that used to run after the guard (Arc, the batched option). */
export const BOOT_EXTRA_READ_MS = 8_000;
/** A try is not started with less than this left in the bound. */
export const MIN_TRY_MS = 1_000;

/** The reason words a failed boot read carries. */
export const BOOT_READ_WORDS = Object.freeze(["probe-timeout", "read-failed"]);

/**
 * { tryMs, tries, gapsMs, budgetMs } for a boot whose reads include
 * `extraReads` reads that used to follow the guard.
 */
export function bootReadSettings(env = process.env, { extraReads = 0 } = {}) {
  const t = Number(String(env.X402_SUPPORTED_TRY_MS ?? "").trim());
  const tryMs = Number.isFinite(t) && t >= 50 ? Math.round(t) : BOOT_TRY_MS;
  const scale = tryMs / BOOT_TRY_MS;
  const b = Number(String(env.X402_SUPPORTED_BOOT_MS ?? "").trim());
  const dflt = Math.round((BOOT_GUARD_MS + BOOT_EXTRA_READ_MS * Math.max(0, extraReads | 0)) * scale);
  const budgetMs = Number.isFinite(b) && b >= tryMs ? Math.round(b) : dflt;
  return { tryMs, tries: BOOT_TRIES, gapsMs: [Math.round(tryMs / 3), Math.round((tryMs * 4) / 3)], budgetMs, minTryMs: Math.min(MIN_TRY_MS, tryMs) };
}

/** True for an error that is a timeout of ours (our race, a client's own limit). */
export function isOurTimeout(e) {
  if (!e) return false;
  if (e.name === "TimeoutError" || e.reason === "timeout" || e.code === "BOOT_PROBE_TIMEOUT") return true;
  return /\btimed? ?out\b|timeout/i.test(String(e.name || "")) || e.constructor?.name === "FacilitatorTimeoutError";
}

/**
 * Read one facilitator's /supported at boot.
 * @param {object} o
 * @param {() => Promise<object>} o.read       the first try (the client as callers see it)
 * @param {() => Promise<object>} [o.readFresh] later tries: a request of their own
 * @param {number} o.deadline                  epoch ms the boot stops waiting
 * @returns {Promise<{ supported: object|null, reason: null|"probe-timeout"|"read-failed", tries: number, error: Error|null }>}
 */
export async function readSupportedAtBoot({ read, readFresh = read, tryMs = BOOT_TRY_MS, tries = BOOT_TRIES, gapsMs = [2_000, 8_000], deadline, minTryMs = MIN_TRY_MS, now = Date.now } = {}) {
  const end = Number.isFinite(deadline) ? deadline : now() + BOOT_GUARD_MS;
  let winner = null;
  let lastError = null;
  let wake = null;
  const nap = (ms) => new Promise((resolve) => {
    // Not unref'd: the boot awaits this read at the top level, and an
    // unref'd timer with nothing else pending would let the process exit.
    const t = setTimeout(done, Math.max(0, ms));
    function done() { clearTimeout(t); if (wake === done) wake = null; resolve(); }
    wake = done;
  });
  const start = (fn) => {
    const p = Promise.resolve().then(fn);
    const state = { settled: false, error: null };
    p.then((v) => { if (!winner) winner = { value: v }; }, (e) => { lastError = e; state.error = e; })
      .finally(() => { state.settled = true; wake?.(); });
    return state;
  };
  let tried = 0;
  let last = null;
  for (let i = 0; i < tries && !winner; i++) {
    if (i > 0) {
      // Only a try of ours that timed out earns a third: two error answers
      // from the facilitator are its own answer, and keep the two tries (and
      // the boot time) they had before.
      if (i >= 2 && last?.settled && !isOurTimeout(last.error)) break;
      const gap = gapsMs[i - 1] ?? gapsMs[gapsMs.length - 1] ?? 0;
      if (now() + gap + minTryMs > end) break;
      // An earlier request may still answer during the pause.
      const pauseEnd = now() + gap;
      while (!winner && now() < pauseEnd) await nap(pauseEnd - now());
      if (winner) break;
    }
    const left = end - now();
    if (left < minTryMs) break;
    tried++;
    last = start(i === 0 ? read : readFresh);
    const tryEnd = now() + Math.min(tryMs, left);
    while (!winner && !last.settled && now() < tryEnd) await nap(tryEnd - now());
    // A try whose request failed at once leaves its window early; one still
    // out keeps counting in the next window.
  }
  if (winner) return { supported: winner.value, reason: null, tries: tried, error: null };
  // The last try decides the word: no answer inside our limit is ours;
  // an error answer (or a client timeout of ours, reported as an error) is
  // read on its own terms.
  const reason = !last || !last.settled ? "probe-timeout" : isOurTimeout(last.error) ? "probe-timeout" : "read-failed";
  return { supported: null, reason, tries: tried, error: last?.error || lastError || null };
}
