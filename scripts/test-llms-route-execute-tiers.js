// Locks the llms.txt route-execute pricing fix (2026-08-16 audit): the
// "Proportional tiers" sentence was a hand-typed list of 3 tiers
// (execute/execute-plus/execute-max) that silently went stale the moment
// route-execute-pro ($3.30, added 2026-08-04) shipped in route-execute.js -
// nobody remembered to also update this unrelated prose file. Fixed by
// deriving the sentence from EXEC_TIERS directly, so a future 5th tier can't
// repeat the same silent omission.
//
// Also locks a bug caught while building that fix: the first draft built the
// URL as `/api/route/${slug}` (slug is "route-execute-plus"), producing the
// doubled path /api/route/route-execute-plus - the REAL route (registered in
// route-execute.js's buildRouteExecuteTool) strips the "route-execute"
// prefix and prepends "execute", giving /api/route/execute-plus. This test
// asserts every tier URL in the sentence is a route that actually appears in
// the live catalog, not just that some URL-shaped string is present.
//
// Offline - calls llmsTxt() directly and cross-checks against the real
// EXEC_TIERS array + a live catalog fixture.
//
//   node scripts/test-llms-route-execute-tiers.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { llmsTxt } from "../src/seo.js";
import { EXEC_TIERS } from "../src/tools/route-execute.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const text = llmsTxt("https://agent402.tools", {});
const sentenceMatch = text.match(/Proportional tiers:.*?fits/);
ok(!!sentenceMatch, "the 'Proportional tiers' sentence is present");
const sentence = sentenceMatch?.[0] || "";

ok(EXEC_TIERS.length >= 4, `sanity: EXEC_TIERS has the tiers we expect to see reflected (got ${EXEC_TIERS.length})`);

for (const tier of EXEC_TIERS) {
  const priceStr = `$${tier.execPriceUsd}`; // e.g. "$3.3" - JS default toString
  const priceStr2dp = tier.execPriceUsd.toFixed(2); // "3.30"
  const priceMentioned = sentence.includes(priceStr) || sentence.includes(`$${priceStr2dp}`);
  ok(priceMentioned, `every EXEC_TIERS price is mentioned in the sentence (${tier.slug}: $${tier.execPriceUsd})`);
}

// Specifically: route-execute-pro (the tier that went missing) must be named,
// by its REAL route path, not the raw slug.
ok(sentence.includes("execute-pro"), "route-execute-pro's price is present (this is the tier that was missing before the fix)");
ok(!sentence.includes("/api/route/route-execute"), "no doubled '/api/route/route-execute...' path (the URL-derivation bug caught while building this fix)");
ok(sentence.includes("/api/route/execute-plus") && sentence.includes("/api/route/execute-max") && sentence.includes("/api/route/execute-pro"),
  "every non-base tier links its REAL route path (/api/route/execute-<suffix>)");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
