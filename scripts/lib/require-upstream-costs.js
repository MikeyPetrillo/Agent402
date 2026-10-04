// Suites that check real margins need the private upstream-cost table
// (src/upstream-costs.js). Under CI a missing table fails the suite, unless the
// workflow marks the run as one that cannot hold the secret (a fork PR sets
// UPSTREAM_COSTS_OPTIONAL=1). Locally it skips with a notice.
// A table that loads with gaps (a missing key, or a model row that did not
// parse) counts as not loaded, and the gap names (never values) are printed.
import { upstreamCostsLoaded, upstreamCostsGaps } from "../../src/upstream-costs.js";

export function requireUpstreamCosts(suite) {
  const gaps = upstreamCostsLoaded() ? upstreamCostsGaps() : null;
  if (gaps && !gaps.length) return;
  const why = gaps ? `the private upstream-cost table is incomplete (missing: ${gaps.join(", ")})` : "the private upstream-cost table is not loaded";
  if (process.env.CI && process.env.UPSTREAM_COSTS_OPTIONAL !== "1") {
    console.error(`FAIL - ${suite}: ${why} (set UPSTREAM_COSTS_JSON or UPSTREAM_COSTS_FILE)`);
    process.exit(1);
  }
  console.log(`SKIP - ${suite}: ${why}`);
  process.exit(0);
}
