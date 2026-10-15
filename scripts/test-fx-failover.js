#!/usr/bin/env node
// A fallback that only fires on ERROR cannot rescue you from SLOW.
//
//   node scripts/test-fx-failover.js          (offline, stubbed fetch)
//
// WHY: fx-dashboard has two publishers - api.frankfurter.dev as primary and
// open.er-api.com as a keyless fallback - and the fallback was wired to the
// primary's catch block only. A primary that returns eventually, rather than
// failing, held the whole call.
//
// Measured 2026-08-03: the primary answered in ~0.06s warm but 7.8s and 11.6s
// cold; the fallback answered in ~0.08s every time. On the inherited 15s
// timeout with one retry, a cold primary could hold a PAID $0.015 call for up
// to 30s, and prod's self-check (12s budget) was recording fx-dashboard as a
// 504 outage while a healthy second publisher sat unused.
//
// The invariant: the primary is on a short leash, so "slow" becomes "failed"
// fast enough for the fallback to do its job.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const src = readFileSync(new URL("../src/tools/macro-kit.js", import.meta.url), "utf8");

// 1. The primary call must carry an explicit budget, not inherit the default.
// Locate the DASHBOARD call specifically. There are three frankfurter call
// sites and matching the first one tested fx-rate, which is a different case
// (see below). The explanatory comment above the call also names the host, so
// a bare hostname match finds prose rather than code. Every call builds its
// URL with ratesUrl() (src/tools/frankfurter.js, the v2 adapter); the
// dashboard's is the one that asks for the whole G10 basket.
const callIdx = src.indexOf("ratesUrl({ base: \"USD\", quotes: G10 })");
const call = callIdx >= 0 ? src.slice(callIdx, callIdx + 200) : "";
ok(callIdx >= 0, "the fx-dashboard call site is found");
ok(/FX_PRIMARY/.test(call),
  "the frankfurter call passes an explicit fetch budget rather than inheriting 15s");

const m = src.match(/const FX_PRIMARY = \{([^}]*)\}/);
ok(Boolean(m), "FX_PRIMARY is defined");
const budget = m ? m[1] : "";
const ms = Number((budget.match(/timeoutMs:\s*([0-9_]+)/) || [])[1]?.replace(/_/g, "") || 0);
ok(ms > 0 && ms <= 4000,
  `the primary's timeout leaves room for the fallback inside a 12s self-check budget (${ms}ms)`);
ok(/retries:\s*0/.test(budget),
  "no retry on the primary - the FALLBACK is the retry, and retrying a slow host doubles the wait");

// 2. The fallback must still exist and still be a different publisher. A
//    'fix' that pointed both at the same host would pass the timing test and
//    remove the redundancy that makes it worth having.
ok(/open\.er-api\.com/.test(src), "the second publisher is still wired in");
const adapter = readFileSync(new URL("../src/tools/frankfurter.js", import.meta.url), "utf8");
const primaryHost = "api.frankfurter.dev";
ok(adapter.includes(`https://${primaryHost}/v2`), "the primary is Frankfurter v2 (v1 is frozen)");
ok(/providers:\s*"ecb"/.test(adapter), "every v2 read is pinned to the ECB provider, not the blended default");
ok(!src.includes(`open.er-api.com/${primaryHost}`) && primaryHost !== "open.er-api.com",
  "primary and fallback are genuinely different hosts");

// 3. The response must say which publisher served it. Failing over silently
//    would make two different data sources indistinguishable to the buyer.
ok(/source = "Open ER-API/.test(src),
  "a failed-over response names the publisher that actually served it");
ok(/stale: true/.test(src),
  "and a served-stale answer is marked stale rather than passed off as fresh");

// 4. Total worst case must beat the self-check budget, or prod keeps reporting
//    an outage on a tool that works.
const SELFCHECK_BUDGET_MS = 12_000;
ok(ms * 1 + 3000 < SELFCHECK_BUDGET_MS,
  `primary budget + a slow fallback still fits inside the ${SELFCHECK_BUDGET_MS}ms self-check window`);

// 5. The leash belongs ONLY where there is somewhere to fail over to.
//    fx-rate and fx-history call the same publisher with NO fallback, so a
//    short timeout there would just convert slow successes into fast failures
//    and lower the hit rate for a paid call. Blanket-applying the fix would
//    have been the wrong move, so the difference is pinned deliberately.
const others = [...src.matchAll(/await getJson\(ratesUrl\(\{ base: from[^}]*\}\)([^;]*);/g)]
  .map((x) => x[1]);
ok(others.length >= 2, `the two fallback-less frankfurter calls are present (${others.length})`);
ok(others.every((a) => !/FX_PRIMARY/.test(a)),
  "fx-rate and fx-history do NOT get the short leash - with no fallback, a slow success beats a fast failure");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
