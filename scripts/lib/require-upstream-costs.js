// Suites that check real margins need the private upstream-cost table
// (src/upstream-costs.js). Under CI a missing table fails the suite, unless the
// workflow marks the run as one that cannot hold the secret (a fork PR sets
// UPSTREAM_COSTS_OPTIONAL=1). Locally it skips with a notice.
// A table that loads with gaps (a missing key, or a model row that did not
// parse) counts as not loaded, and the gap names (never values) are printed.
//
// A suite whose checks mostly need no rate does not stop here: it calls
// costsOrStandIn() (scripts/lib/stand-in-costs.js), runs on stand-in costs
// and counts its rate checks as needing the table. requireUpstreamCosts() is
// for the suites named in scripts/test-no-silent-skips.js, whose checks read
// the real rates throughout.
import { upstreamCostsLoaded, upstreamCostsGaps } from "../../src/upstream-costs.js";

/** null when the private table is loaded whole, else the reason it is not (names, never values). */
export function upstreamCostsMissing() {
  const gaps = upstreamCostsLoaded() ? upstreamCostsGaps() : null;
  if (gaps && !gaps.length) return null;
  return gaps ? `the private upstream-cost table is incomplete (missing: ${gaps.join(", ")})` : "the private upstream-cost table is not loaded";
}

/** True when a missing table is a failure here: under CI, unless the run cannot hold the secret. */
export const upstreamCostsRequired = () => Boolean(process.env.CI) && process.env.UPSTREAM_COSTS_OPTIONAL !== "1";

export function requireUpstreamCosts(suite) {
  const why = upstreamCostsMissing();
  if (!why) return;
  if (upstreamCostsRequired()) {
    console.error(`FAIL - ${suite}: ${why} (set UPSTREAM_COSTS_JSON or UPSTREAM_COSTS_FILE)`);
    process.exit(1);
  }
  console.log(`SKIP - ${suite}: ${why}`);
  process.exit(0);
}
