// Pure classifier for a report-kit probe failure. Side-effect free so it can be
// unit-tested without making a single network call (same shape as
// scripts/avm-canary-classify.js).
//
// The distinction that matters: a THIRD PARTY being down is not our defect and
// must never fail a build (EDGAR, openFDA, GoPlus and DexScreener all have bad
// minutes). Our own code throwing is exactly the defect this lane exists to
// find - the 2026-08-29 domain-audit outage was a `TypeError: ... is not
// iterable` inside a probe, which answered HTTP 500 for every domain that
// publishes a DMARC rua, and no sweep could see it because the tool is metered.

/** Programming errors: our bug, always. */
const OUR_BUG_TYPES = new Set(["TypeError", "ReferenceError", "RangeError", "SyntaxError"]);
const OUR_BUG_MESSAGE =
  /is not a function|is not iterable|is not async iterable|Cannot read propert|Cannot destructure|Cannot convert|is not defined|Assignment to constant|Reduce of empty array|Invalid array length/i;

/** Third-party unreachable or unhappy. Never our build's problem. */
const UPSTREAM_MESSAGE =
  /fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|timeout|timed out|aborted|abort|rate limit|too many requests|HTTP (4[0-9]{2}|5[0-9]{2})|\b(429|500|502|503|504)\b|upstream|unavailable|temporarily/i;

/**
 * @param {unknown} err
 * @returns {"our-bug"|"upstream"} what the failure says about OUR code.
 */
export function classifyProbeFailure(err) {
  const name = err?.constructor?.name || err?.name || "";
  const msg = String(err?.message ?? err ?? "");

  // A programming error is our bug even when it mentions a network word - the
  // type is the stronger signal, so it is checked first and never overridden.
  if (OUR_BUG_TYPES.has(name) || OUR_BUG_MESSAGE.test(msg)) return "our-bug";

  // Our own `bad(msg, status)` with a 4xx: the probe rejected its INPUT. That
  // is this test calling it wrongly, or a contract change - either way ours.
  const status = Number(err?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 429) return "our-bug";

  // 502/503/504 is the house definition of "a third party failed us" (the same
  // set scripts/test-all.js tolerates in its lenient lane). A bare 500 is not:
  // that is our own handler, and it is precisely what domain-audit answered.
  if (Number.isInteger(status) && [502, 503, 504].includes(status)) return "upstream";
  if (Number.isInteger(status) && status >= 500) return "our-bug";
  if (UPSTREAM_MESSAGE.test(msg)) return "upstream";

  // Ambiguous: these probes are almost entirely I/O over third-party APIs, so
  // an unrecognised failure is far more likely to be one of them having a bad
  // minute than a new class of our own. Reported loudly, never fatal - a real
  // defect in our code arrives with a shape the rules above already name.
  return "upstream";
}
