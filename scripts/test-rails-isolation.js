#!/usr/bin/env node
// One chain failing must stay ONE CHAIN's problem, and must be visible.
//
//   node scripts/test-rails-isolation.js
//
// WHY: a rail whose facilitator is missing or down is deliberately dropped from
// the 402 offer rather than throwing while the challenge is built - one bad
// rail once turned into HTTP 500 on EVERY paid endpoint (2026-07-02). That
// isolation is correct and revenue keeps flowing on the other chains.
//
// What was missing is that the drop is SILENT after boot. Celo vanished from
// the offer and nothing said so: the 402 quietly advertised 11 networks while
// the config asked for 12, /health read ok, and the only trace was a boot log
// nobody re-reads. It surfaced days later through a canary WARN, by which point
// the published claim "12 chains" had been false the whole time.
//
// So: the isolation must hold, AND the difference must be reportable.
import { railStatus, noteRailDropped } from "../src/payments.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Before any mount, nothing is configured - and that must not throw.
ok(Array.isArray(railStatus()), "railStatus() is safe to call before any payment mount");

// A drop reason recorded for a chain that was never configured must not invent
// a rail: railStatus reports the CONFIGURED set, not the drop log.
noteRailDropped("nosuchchain", "test reason");
ok(!railStatus().some((r) => r.network === "nosuchchain"),
  "a drop reason never conjures a rail that was not configured");

// Shape contract: every row must carry enough to act on without a second call.
for (const r of railStatus()) {
  ok(typeof r.network === "string", `row names its network (${r.network})`);
  ok("offered" in r, `${r.network}: says whether it is actually offered`);
  ok(r.offered === true ? r.reason === null : typeof r.reason === "string",
    `${r.network}: an un-offered rail explains itself, an offered one does not`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
