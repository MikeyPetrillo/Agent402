// Deploy quiet gate: hold the Railway deploy until OUTSIDE traffic has a lull,
// so a container swap (a 60-90 s no-container window on this volume-backed
// service) never lands in the middle of someone's burst.
//
// Reads the free /api/stats surface (recentCalls: the newest FEED_ROWS served
// calls, newest-first, ISO timestamps, paidWith: "usdc" | "proof-of-work" |
// "heartbeat") and waits until the most recent OUTSIDE call is at least
// QUIET_SECS old. Every class counts except our own: paid calls (x402, MPP,
// credits, card) because cutting one mid-flight is the charged-but-not-served
// failure, and proof-of-work calls, which include every tool call made through
// the hosted /mcp connector, because an MCP host shows a restart to its user
// as a tool-execution error. "heartbeat" rows are ours (the signed probe
// token, and paid calls from our own wallets, which /api/stats books under
// that label) and never hold a deploy. An unknown future label counts as
// outside: waiting is the safe direction.
//
// Ignoring our own rows opens one hole: when they fill the whole feed, an
// outside call a minute ago has scrolled out of sight. So quiet also needs
// VISIBILITY: the feed, or an unbroken chain of polls, must reach back at
// least QUIET_SECS. The tracker also remembers the newest outside call it has
// seen, so a call that scrolls out between two polls still holds the gate.
//
// Fail-open by design; this gate must never be able to strand a deploy:
//   - stats unreachable FAILS_OPEN_AFTER times in a row: proceed
//     (prod may be down, and the deploy may be the fix)
//   - stats readable but not in the expected shape: proceed, with a warning
//   - still busy after MAX_WAIT_SECS: proceed with a loud warning (the
//     in-server SIGTERM drain + RAILWAY_DEPLOYMENT_DRAINING_SECONDS still
//     protect whatever is in flight)
//   - QUIET_GATE=off: skip entirely
//
// Env: TARGET_URL (required), QUIET_SECS (180), POLL_SECS (15),
//      MAX_WAIT_SECS (1200), QUIET_GATE ("off" to skip).

const FAILS_OPEN_AFTER = 4;

/** Rows /api/stats exposes in recentCalls (RECENT_SHOW in src/stats.js). A
 *  page shorter than this is the whole retained log, so it covers all time. */
export const FEED_ROWS = 25;

/** paidWith labels that are our own traffic. Everything else is outside. */
const OURS = new Set(["heartbeat"]);

export function isOurs(call) {
  return OURS.has(call?.paidWith);
}

/** Seconds since the most recent OUTSIDE call in one /api/stats payload.
 *  Infinity when none is visible. Malformed input: Infinity (fail-open). */
export function lastOutsideAgeSeconds(stats, nowMs) {
  const calls = Array.isArray(stats?.recentCalls) ? stats.recentCalls : null;
  if (!calls) return Infinity;
  let newest = -Infinity;
  for (const c of calls) {
    if (!c || typeof c !== "object" || isOurs(c)) continue;
    const t = Date.parse(c.at);
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  if (newest === -Infinity) return Infinity;
  return Math.max(0, (nowMs - newest) / 1000);
}

/**
 * Poll-to-poll verdict. observe(stats, nowMs) takes one /api/stats payload and
 * the time the poll STARTED (so the previous page is known to reach at least
 * that far), and answers { quiet, ageSecs, coveredSecs, unreadable }.
 *   ageSecs     seconds since the newest outside call seen on ANY poll so far
 *   coveredSecs how far back visibility is unbroken (Infinity = all of it)
 * quiet = ageSecs >= quietSecs AND coveredSecs >= quietSecs, or an unreadable
 * payload (fail-open, the caller warns).
 */
export function createQuietTracker(quietSecs, { feedRows = FEED_ROWS } = {}) {
  let newestOutside = -Infinity;
  let coverFrom = null; // earliest ms with unbroken visibility
  let lastPollAt = null; // start time of the previous readable poll
  return {
    observe(stats, nowMs) {
      const calls = Array.isArray(stats?.recentCalls) ? stats.recentCalls : null;
      let oldest = Infinity;
      let parsed = 0;
      for (const c of calls || []) {
        if (!c || typeof c !== "object") continue;
        const t = Date.parse(c.at);
        if (!Number.isFinite(t)) continue;
        parsed++;
        if (t < oldest) oldest = t;
        if (!isOurs(c) && t > newestOutside) newestOutside = t;
      }
      // Not the shape this gate reads (no list, or rows with no readable
      // timestamp at all): fail open, as the gate always has.
      if (!calls || (calls.length > 0 && parsed === 0)) {
        return { quiet: true, unreadable: true, ageSecs: Infinity, coveredSecs: Infinity };
      }
      const pageFrom = calls.length < feedRows ? -Infinity : oldest;
      // Unbroken only if this page reaches back to where the last one began.
      const continuous = lastPollAt !== null && pageFrom <= lastPollAt;
      coverFrom = continuous ? Math.min(coverFrom, pageFrom) : pageFrom;
      lastPollAt = nowMs;
      const ageSecs = newestOutside === -Infinity ? Infinity : Math.max(0, (nowMs - newestOutside) / 1000);
      const coveredSecs = coverFrom === -Infinity ? Infinity : Math.max(0, (nowMs - coverFrom) / 1000);
      return { quiet: ageSecs >= quietSecs && coveredSecs >= quietSecs, unreadable: false, ageSecs, coveredSecs };
    },
  };
}

/** Single-payload verdict (no memory across polls). */
export function isQuiet(stats, nowMs, quietSecs) {
  return createQuietTracker(quietSecs).observe(stats, nowMs).quiet;
}

async function fetchStats(targetUrl) {
  const res = await fetch(new URL("/api/stats", targetUrl), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`/api/stats returned HTTP ${res.status}`);
  return res.json();
}

const secs = (n) => (n === Infinity ? "not in view" : `${Math.round(n)}s`);

async function main() {
  if ((process.env.QUIET_GATE || "").toLowerCase() === "off") {
    console.log("quiet gate: QUIET_GATE=off, skipping");
    return;
  }
  const targetUrl = process.env.TARGET_URL;
  if (!targetUrl) {
    console.error("quiet gate: TARGET_URL is required");
    process.exit(1);
  }
  const quietSecs = Number(process.env.QUIET_SECS) || 180;
  const pollSecs = Number(process.env.POLL_SECS) || 15;
  const maxWaitSecs = Number(process.env.MAX_WAIT_SECS) || 1200;

  console.log(`quiet gate: waiting for ${quietSecs}s without an outside call (paid or free; our own probes excluded) on ${targetUrl} (max wait ${maxWaitSecs}s)`);
  const startedAt = Date.now();
  const tracker = createQuietTracker(quietSecs);
  let consecutiveFailures = 0;

  for (;;) {
    let verdict = null;
    const polledAt = Date.now();
    try {
      const stats = await fetchStats(targetUrl);
      consecutiveFailures = 0;
      verdict = tracker.observe(stats, polledAt);
    } catch (e) {
      consecutiveFailures++;
      console.log(`quiet gate: stats fetch failed (${consecutiveFailures}/${FAILS_OPEN_AFTER}): ${e.message}`);
      if (consecutiveFailures >= FAILS_OPEN_AFTER) {
        console.log("quiet gate: stats unreachable, failing OPEN so the deploy (which may be the fix) can proceed");
        return;
      }
    }

    if (verdict) {
      if (verdict.unreadable) {
        console.log("::warning::quiet gate: /api/stats recentCalls is not in the expected shape, failing OPEN");
        return;
      }
      if (verdict.quiet) {
        console.log(`quiet gate: PASS, last outside call ${verdict.ageSecs === Infinity ? "not in view" : `${Math.round(verdict.ageSecs)}s ago`} (visibility ${secs(verdict.coveredSecs)})`);
        return;
      }
      if (verdict.ageSecs < quietSecs) {
        console.log(`quiet gate: outside traffic ${Math.round(verdict.ageSecs)}s ago (need ${quietSecs}s of quiet), waiting`);
      } else {
        console.log(`quiet gate: our own traffic fills the feed, can see back only ${Math.floor(verdict.coveredSecs)}s (need ${quietSecs}s), waiting`);
      }
    }

    if ((Date.now() - startedAt) / 1000 + pollSecs > maxWaitSecs) {
      console.log(`::warning::quiet gate: still not quiet after ${maxWaitSecs}s, proceeding anyway; the SIGTERM drain window protects in-flight calls`);
      return;
    }
    await new Promise((r) => setTimeout(r, pollSecs * 1000));
  }
}

// Run only when invoked directly (the test imports the pure helpers above).
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // The gate itself erroring must not block a deploy.
    console.log(`::warning::quiet gate crashed (${e.message}), failing open`);
  });
}
