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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
