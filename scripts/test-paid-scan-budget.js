#!/usr/bin/env node
// A public route must not be able to spend money without limit.
//
//   node scripts/test-paid-scan-budget.js          (offline, source invariants)
//
// WHY: `/<chain>?seller=<host>` and `/api/market/<chain>/panel` are public,
// unauthenticated, and take an arbitrary seller from a roster of ~2,300. On
// Base each distinct wallet ran a billed CDP SQL query, twice. One crawler
// walking the seller roster is thousands of billed queries, and robots.txt
// explicitly welcomed every major crawler.
//
// Three defects, three guards:
//   1. robots.txt invited crawlers to the paid URLs
//   2. nothing bounded the paid path, so volume was whatever the internet chose
//   3. the wallet cache called clear() at 500 entries, so crossing the
//      threshold re-cooled every wallet at once and re-billed all of them
import { readFileSync } from "node:fs";
import { robotsTxt } from "../src/seo.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// 1. robots.txt must disallow the URLs that cost money per fetch - for the
//    named crawlers AND the wildcard, since the named blocks override it.
const robots = robotsTxt("https://agent402.tools");
const blocks = robots.split(/\n\n+/).filter((b) => /^User-agent:/m.test(b));
const missing = blocks.filter((b) => !/Disallow: \/\*\?seller=/.test(b));
ok(missing.length === 0,
  `every user-agent block disallows the seller-scoped URLs (${missing.length} without)`);
ok(/Disallow: \/api\/market\//.test(robots), "the panel endpoint is disallowed too");

// The pages themselves must STAY indexable - the fix is about the parameter
// that multiplies a page view by a paid query, not about hiding the market.
ok(/User-agent: Googlebot\nAllow: \//.test(robots),
  "the market pages themselves remain crawlable - only the paid variant is blocked");

const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

// 2. The paid path must be budgeted, and the check must come BEFORE the spend.
ok(/const SQL_SCAN_DAILY_BUDGET/.test(src), "a daily ceiling on paid scans exists");

// The ceiling DEFAULTS TO ZERO. These queries power an activity chart on a
// free page; no paid tool handler calls the path, so none of the spend is
// attached to revenue.
ok(/SQL_SCAN_DAILY_BUDGET\) \|\| 0;/.test(src),
  "the paid scanner is OFF by default - it must be opted INTO, not out of");
const baseBranch = src.slice(src.indexOf('if (chainKey === "base")'), src.indexOf('if (chainKey === "base")') + 400);
ok(/paidScanAllowed\(\)/.test(baseBranch), "the Base branch consults the budget");
ok(baseBranch.indexOf("paidScanAllowed()") < baseBranch.indexOf("baseActivityViaSql"),
  "the budget is checked BEFORE the query - checking after would still spend");
// Matches the CALL, not its argument list: the scanner grew a `prior` option
// for the incremental resume, and pinning the exact arguments would fail on a
// change that leaves this guarantee untouched. What must hold is that the
// over-budget path RETURNS the free scanner for this wallet - not an error,
// not null, not the paid query again.
ok(/return evmActivity\("base", wallet[,)]/.test(baseBranch),
  "past the ceiling it falls back to the FREE scanner rather than erroring - the panel still renders");

// 3. The cache must not empty itself under load.
ok(!/chainActivityByWallet\.clear\(\)/.test(src),
  "the wallet cache no longer clear()s wholesale - that re-billed every warm wallet at once");
ok(/chainActivityByWallet\.delete\(oldest\)/.test(src),
  "it evicts the oldest single entry instead");

// 4. The one paid query we KEEP must not be re-billed faster than its own data
//    changes. Its windows are 7 and 30 days; a 30-minute cache meant 48 paid
//    rebuilds a day to move a figure by a rounding error.
const econ = readFileSync(new URL("../src/x402-economy.js", import.meta.url), "utf8");
const em = econ.match(/const ECONOMY_FRESH_MS = [^;]*?(\d+)\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
ok(Boolean(em), "the economy snapshot's freshness window is expressed in hours, not minutes");
const hours = em ? Number(em[1]) : 0;
ok(hours >= 2,
  `the snapshot is cached for hours, not minutes (${hours}h) - its data is a 7/30-day aggregate`);
ok(/stale-while-revalidate|startEconomyRefresh/.test(econ),
  "and it is still stale-while-revalidate, so no visitor waits on the rebuild");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
