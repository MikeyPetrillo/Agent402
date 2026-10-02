#!/usr/bin/env node
// A published guarantee has to survive being checked.
//
//   node scripts/test-reliability-claims.js          (offline, no server)
//
// WHY: /api/reliability publishes claims about how this service is tested and
// watched, each with a verification URL. Nobody had checked them against the
// code in a while, and an audit found two that had drifted:
//
//   * "Every tool is called with its own documented example in CI" - CI
//     deliberately skips 20 of 528 endpoints backed by metered third-party
//     APIs, because a sweep once cost ~4,500 billed Brave queries in a month.
//   * "A production heartbeat probes ... every 15 minutes" - the substance was
//     right and the attribution wrong. There are TWO observers on separate
//     infrastructure, and the measured rate is better than advertised.
//
// An overclaim on a page whose whole purpose is verifiability is worse than no
// page. These assertions pin the claims to things a reader could check.
import { readFileSync } from "node:fs";
import { reliabilityReport } from "../src/discovery.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Built from the module rather than fetched, so this runs in the offline block
// of CI alongside the other invariant tests. The claims are static text; what
// is being checked is whether they match the code, and that needs no server.
const rel = reliabilityReport({
  baseUrl: "https://agent402.tools", network: "base",
  wallet: "0x0000000000000000000000000000000000000000", stats: {},
});
const claims = rel.guarantees || [];
ok(claims.length > 0, `reliability publishes ${claims.length} guarantees`);

const text = claims.map((c) => c.claim).join("\n");

// The CI claim must not assert completeness the code does not deliver.
const testAll = readFileSync(new URL("./test-all.js", import.meta.url), "utf8");
const skipsExist = /BRAVE_ROUTES|E2B_ROUTES/.test(testAll) && /skipBrave|skipE2b/.test(testAll);
ok(skipsExist, "CI genuinely skips some routes (the fact the claim has to account for)");
const ciClaim = claims.find((c) => /documented example/.test(c.claim));
ok(ciClaim, "the CI claim is present");
ok(!/^Every tool is called with its own documented example in CI, and the release is blocked on any failure\.$/.test(ciClaim.claim),
  "...and is no longer the bare 'every tool' form that the skips contradict");
ok(/skip|except/i.test(ciClaim.claim),
  "...it states that some endpoints are skipped");
ok(/Brave|E2B|metered/i.test(ciClaim.claim),
  "...and says which, so a reader can find them in the source");

// The observer claim must not credit one observer for two observers' work, and
// must not advertise a cadence we do not hit.
const hb = claims.find((c) => /observers|heartbeat/i.test(c.claim));
ok(hb, "the observer claim is present");
ok(/two independent observers/i.test(hb.claim),
  "it credits BOTH observers - a single-observer claim was the weaker and less true version");
ok(/separate infrastructure/i.test(hb.claim),
  "...and says they are on separate infrastructure, which is the point of having two");

// Every claim must still carry a way to check it. A guarantee without a
// verification URL is a marketing line.
const unverifiable = claims.filter((c) => !c.verify && !c.evidence);
ok(unverifiable.length === 0,
  `every guarantee carries a verify or evidence URL (${unverifiable.length} without)`);

// And the claims must not contain absolutes we have not tested. "never" and
// "always" are the words that bit us.
const absolutes = claims.filter((c) => /\b(100%|never fails|always works|guaranteed uptime|zero downtime)\b/i.test(c.claim));
ok(absolutes.length === 0,
  `no untestable absolutes in the claims (${absolutes.map((c) => c.claim.slice(0, 40)).join("; ")})`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
