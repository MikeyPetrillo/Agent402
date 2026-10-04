// Suites that check real margins need the private upstream-cost table
// (src/upstream-costs.js). Under CI a missing table fails the suite, unless the
// workflow marks the run as one that cannot hold the secret (a fork PR sets
// UPSTREAM_COSTS_OPTIONAL=1). Locally it skips with a notice.
import { upstreamCostsLoaded } from "../../src/upstream-costs.js";

export function requireUpstreamCosts(suite) {
  if (upstreamCostsLoaded()) return;
  if (process.env.CI && process.env.UPSTREAM_COSTS_OPTIONAL !== "1") {
    console.error(`FAIL - ${suite}: the private upstream-cost table is not loaded (set UPSTREAM_COSTS_JSON or UPSTREAM_COSTS_FILE)`);
    process.exit(1);
  }
  console.log(`SKIP - ${suite}: the private upstream-cost table is not loaded`);
  process.exit(0);
}
