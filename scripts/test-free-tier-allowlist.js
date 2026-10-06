// The free tier is an allowlist (src/free-tier.js): a tool is proof-of-work
// eligible only when listed there and not overridden by WALLET_ONLY_SLUGS.
// The point of the flip (2026-10-04) is the DEFAULT: a slug on neither list -
// every new tool - is wallet-only, so forgetting a list can no longer make an
// upstream-calling tool free. Offline.
import { FREE_TIER_SLUGS } from "../src/free-tier.js";
import { isComputePayable, WALLET_ONLY_SLUGS, PROBE_POW_SLUG } from "../src/pow.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

ok(!isComputePayable({ slug: "a-brand-new-tool-on-no-list" }), "a slug on neither list is wallet-only (the safe default)");
ok(FREE_TIER_SLUGS.size > 100, `the free tier is populated (${FREE_TIER_SLUGS.size} slugs)`);
const both = [...FREE_TIER_SLUGS].filter((s) => WALLET_ONLY_SLUGS.has(s));
ok(both.length === 0, `no slug is on both lists${both.length ? ` (${both.join(", ")})` : ""}`);
const listed = [...FREE_TIER_SLUGS][0];
ok(isComputePayable({ slug: listed }), `a listed slug is free (${listed})`);
const overridden = [...WALLET_ONLY_SLUGS][0];
ok(!isComputePayable({ slug: overridden }), `WALLET_ONLY_SLUGS wins (${overridden})`);
ok(isComputePayable({ slug: PROBE_POW_SLUG }), `the PoW probe slug (${PROBE_POW_SLUG}) stays free`);

// The settle-failure breaker and the operator view key on "paid" (not PoW-eligible),
// not on WALLET_ONLY_SLUGS: with an allowlist, a new tool on neither list is paid,
// and a WALLET_ONLY_SLUGS-keyed breaker would leave it uncovered.
import("node:fs").then(({ readFileSync }) => {
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/!FREE_MODE && !isComputePayable\(tool\)\) gatewaySettleBreakerCheck\(req, \{ global: false \}\)/.test(src), "the catalog settle breaker is keyed on !isComputePayable(tool)");
  ok(!/WALLET_ONLY_SLUGS\.has\(tool\.slug\)\) gatewaySettleBreakerCheck/.test(src), "the catalog settle breaker is not keyed on WALLET_ONLY_SLUGS");
  ok(!/walletOnlySet: WALLET_ONLY_SLUGS/.test(src), "the operator breakdown is not keyed on WALLET_ONLY_SLUGS");
  ok(/const PAID_SLUGS = \{ has: \(slug\) => Object\.hasOwn\(TOOL_PRICES, slug\) && !isComputePayable\(\{ slug \}\) \}/.test(src), "PAID_SLUGS is the catalog complement of isComputePayable");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
