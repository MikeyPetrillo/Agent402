// Locks two 2026-08-16 audit fixes to the operator dashboard, offline (calls
// getOperatorBreakdown/operatorPage directly, no server boot):
//
//   1. "Ops-cost-vs-revenue visibility for rails with zero external revenue":
//      viaUSDCByNetwork only ever carries a key for a rail that has settled
//      at least once, so a configured-but-unused rail is invisible by
//      omission, not flagged. getOperatorBreakdown() now takes an
//      `offeredNetworks` list and returns `railBreakdown`, an explicit row
//      per offered rail (settledCalls, zero or not) — cross-referencing what
//      we're PAYING to maintain (facilitator config, canary legs, tests)
//      against what it has ever earned.
//   2. "Top tools by revenue view (call-volume ≠ revenue proxy)": the
//      per-tool table already carried both `calls` and `revenueUsd`, but
//      only ever sorted by calls by default — operatorPage() now renders a
//      standalone top-5-by-revenue list alongside top-5-by-calls so the two
//      leaderboards are visible without clicking a column header.
//
//   node scripts/test-operator-revenue-visibility.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { getOperatorBreakdown } from "../src/stats.js";
import { operatorPage } from "../src/operator.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- 1. railBreakdown ---
const dataNoNetworks = getOperatorBreakdown({ prices: {}, walletOnlySet: new Set() });
ok(Array.isArray(dataNoNetworks.railBreakdown) && dataNoNetworks.railBreakdown.length === 0,
  "no offeredNetworks passed → railBreakdown is an empty array, not undefined");

// "base"/"polygon"/"solana" are REAL production counter keys and this reads
// the actual shared stats DB — in CI, other test steps in the same job
// legitimately settle real USDC on "base" before this step runs, so
// settledCalls for those cannot be asserted as exactly 0 here (that's a
// process-shared resource, not a fixture). Use one fake network name that
// can never collide with a real CAIP2_NAMES value for the "reports 0, never
// undefined" behavior, and keep "robinhood" only for its name-preservation
// check below (asserted on shape, not count).
const offered = ["base", "polygon", "solana", "robinhood", "__test_fake_network_zzz__"];
const dataWithNetworks = getOperatorBreakdown({ prices: {}, walletOnlySet: new Set(), offeredNetworks: offered });
ok(dataWithNetworks.railBreakdown.length === offered.length,
  `railBreakdown has one row per offered network (got ${dataWithNetworks.railBreakdown.length}, expected ${offered.length})`);
ok(offered.every((n) => dataWithNetworks.railBreakdown.some((r) => r.network === n)),
  "every offered network appears in railBreakdown by name");
ok(dataWithNetworks.railBreakdown.every((r) => Number.isInteger(r.settledCalls) && r.settledCalls >= 0),
  "every row's settledCalls is a non-negative integer, never absent/undefined/NaN");
const fakeRow = dataWithNetworks.railBreakdown.find((r) => r.network === "__test_fake_network_zzz__");
ok(fakeRow?.settledCalls === 0, "a network that has never settled anything reports settledCalls:0 exactly");

// robinhood settles USDG, booked under the display name "robinhood (USDG)" in
// viaUSDCByNetwork (see CAIP2_NAMES) — the offered-network row must still key
// off the plain "robinhood" name a human/operator recognizes from PAYMENT_NETWORKS.
const robRow = dataWithNetworks.railBreakdown.find((r) => r.network === "robinhood");
ok(!!robRow && robRow.network === "robinhood", "robinhood keeps its plain PAYMENT_NETWORKS name in railBreakdown, not the display-only \"(USDG)\" suffix");

// --- 2. operatorPage renders both leaderboards ---
const sampleData = {
  totals: { total: 10, viaUSDC: 8, viaProofOfWork: 2, viaHeartbeat: 0, viaUSDCByNetwork: {}, estimatedRevenueUsd: 3.8, toolsServed: 2 },
  railBreakdown: [{ network: "base", settledCalls: 100 }, { network: "monad", settledCalls: 0 }],
  tools: [
    { slug: "route-execute-pro", calls: 1, paid: 1, pow: 0, heartbeat: 0, revenueUsd: 3.3, pricePerCall: 3.3, walletOnly: false },
    { slug: "hash", calls: 500, paid: 500, pow: 0, heartbeat: 0, revenueUsd: 0.5, pricePerCall: 0.001, walletOnly: false },
  ],
  recentCalls: [],
  processUptimeSeconds: 60,
};
const html = operatorPage("https://agent402.tools", sampleData);
ok(html.includes("route-execute-pro") && html.includes("$3.3000"),
  "the high-price low-volume tool appears with its real revenue in the by-revenue list");
ok(html.includes("Top by revenue vs top by calls"), "the panel title is present");
ok(html.includes("Rails offered vs settled"), "the rails panel title is present");
ok(html.includes("ZERO REVENUE") && html.includes("monad"),
  "a zero-settled offered rail (monad) is flagged ZERO REVENUE");
const baseRow = html.match(/<tr><td>base<\/td>.*?<\/tr>/)?.[0] || "";
ok(baseRow.length > 0 && !baseRow.includes("ZERO REVENUE"),
  "a settled rail (base, 100 calls) is NOT flagged ZERO REVENUE");

// Empty-state fallbacks must never crash on a cold-boot server (no calls yet).
const coldHtml = operatorPage("https://agent402.tools", { totals: {}, railBreakdown: [], tools: [], recentCalls: [] });
ok(coldHtml.includes("No data yet."), "cold-boot (no tool calls) renders a 'No data yet.' fallback, not a crash/blank");
ok(coldHtml.includes("No configured rails."), "cold-boot with no offered networks renders a 'No configured rails.' fallback");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
