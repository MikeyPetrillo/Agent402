#!/usr/bin/env node
// A metered upstream must not be reachable from a surface that earns nothing.
//
//   node scripts/test-metered-upstreams.js          (offline, source scan)
//
// WHY: this defect has now happened three times, to three different vendors,
// and each time it was found by an invoice rather than by us.
//
//   Alchemy  (2026-07-20) crawler traffic on /revenue and /marketplace kept a
//            60s snapshot cache permanently warm: ~1,440 full RPC scans/day,
//            the dominant driver of the compute-unit bill. Fixed by a 10-min
//            TTL.
//   Brave    (2026-08-02) CI's own test sweep bought live web searches through
//            a tool that called a search HANDLER in-process. ~1,100/month.
//   CDP SQL  (2026-08-03) `/<chain>?seller=<host>` ran two BILLED SQL queries
//            per distinct seller wallet, from a public unauthenticated page,
//            over a roster of ~2,300. 29,589 queries, $245.59 in one month,
//            against roughly $50 of revenue.
//
// The shape is always the same: something that costs money per call, reachable
// from a surface with no payment attached - a page, a crawler, a background
// refresh, a test - and no bound between them.
//
// A paid TOOL handler calling a metered upstream is fine and needs no entry
// here: the buyer paid, the margin was checked, revenue is attached. Everything
// else must declare what bounds it.
import { readFileSync, readdirSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Hosts that bill per request. Adding one here is how a new vendor joins the
// guard; it is deliberately a hostname list rather than a package list,
// because the thing that costs money is the request, not the SDK.
const METERED = [
  "api.search.brave.com",
  "api.cdp.coinbase.com",
  "api.openai.com",
  "openrouter.ai",
  "e2b.dev",
  "api.neynar.com",
  "alchemy.com",
  "hist.databento.com",
];

// Non-tool files allowed to reach a metered host, each with the bound that
// makes it safe. An entry without a real bound is the bug this test exists to
// prevent, so the bound is asserted in the source, not just described here.
const ALLOWED = {
  "x402-economy.js": { why: "whole-market snapshot; only paid query kept", bound: /ECONOMY_FRESH_MS/ },
  "revenue-live.js": { why: "rail snapshot RPC fan-out", bound: /SNAPSHOT_TTL_MS/ },
  "leaderboard.js": { why: "leaderboard scan", bound: /CACHE|TTL|cached/i },
  "x402-index.js": { why: "registry discovery poll", bound: /DISCOVERY_INTERVAL_MS/ },
  "server.js": { why: "wallet activity scan", bound: /SQL_SCAN_DAILY_BUDGET/ },
  "decision-one.js": { why: "typed-judgment backend for the paid judge routes and the internal judges", bound: /DECISION_ONE_DAILY_MAX_BYTES/ },
  "verify-hint.js": { why: "payer balance read after a refused payment; public nodes first, the keyed provider last", bound: /MAX_BATCHES_INFLIGHT/ },
  // A file may NAME a metered host without ever calling it - upstream-budgets
  // declares the per-vendor daily call budgets and matches egress-meter rows by
  // hostname, so the host strings are the subject of the bound, not a request.
  // That claim is not taken on trust: `noRequest` files are re-checked below
  // against the request verbs, so one added later that actually fetches fails.
  "upstream-budgets.js": { why: "declares the daily call budgets; hostnames are match strings", noRequest: true },
};

// What "issues a request" looks like in this tree. Kept narrow on purpose: a
// false negative here would let a real caller in under the noRequest flag.
const REQUEST_VERBS = /\b(fetch|safeFetch|fetchJson|getJson|axios|request|https?\.(get|request))\s*\(/;

const dir = new URL("../src/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
const offenders = [];
for (const f of files) {
  const src = readFileSync(new URL(f, dir), "utf8");
  const hit = METERED.find((h) => src.includes(h));
  if (!hit) continue;
  const rule = ALLOWED[f];
  if (!rule) { offenders.push(`${f} reaches ${hit} with no declared bound`); continue; }
  if (rule.noRequest) {
    if (REQUEST_VERBS.test(src)) offenders.push(`${f} is allowed as "names the host, makes no request" but the source issues one`);
    continue;
  }
  if (!rule.bound.test(src)) offenders.push(`${f} is allowed for "${rule.why}" but its bound is missing from the source`);
}
ok(offenders.length === 0,
  `every non-tool file reaching a metered upstream declares a bound${offenders.length ? `:\n     ${offenders.join("\n     ")}` : ""}`);

// A tool KIT may call a metered host from its paid handler with no entry
// here, but a kit that also runs its own background loop (a timer) reaches the
// host with no buyer attached, which is this file's whole subject. Each such
// kit is listed with the bound it must carry in its source.
const TOOL_LOOPS = {
  "databento.js": { why: "stock-quote warmer: range refresh and top-symbol pre-reads", bound: /DATABENTO_BACKGROUND_DAILY_MAX_CALLS/ },
};
const toolsDir = new URL("../src/tools/", import.meta.url);
const loopOffenders = [];
let loopKits = 0;
for (const f of readdirSync(toolsDir).filter((x) => x.endsWith(".js"))) {
  const src = readFileSync(new URL(f, toolsDir), "utf8");
  const host = METERED.find((h) => src.includes(h));
  if (!host || !/\bsetInterval\s*\(/.test(src)) continue;
  loopKits++;
  const rule = TOOL_LOOPS[f];
  if (!rule) { loopOffenders.push(`tools/${f} runs a timer and reaches ${host} with no declared bound`); continue; }
  if (!rule.bound.test(src)) loopOffenders.push(`tools/${f} is allowed for "${rule.why}" but its bound is missing from the source`);
}
ok(loopOffenders.length === 0, `every tool kit with a background loop on a metered host declares a bound${loopOffenders.length ? `:\n     ${loopOffenders.join("\n     ")}` : ""}`);
ok(loopKits >= 1, `the tool-loop scan found ${loopKits} kit(s) (sanity: it is not blind)`);
// The warmer's ceiling must default to a finite number, never to unbounded.
{
  const dbSrc = readFileSync(new URL("databento.js", toolsDir), "utf8");
  const dflt = Number((dbSrc.match(/DATABENTO_BACKGROUND_DAILY_MAX_CALLS[\s\S]{0,400}?:\s*(\d+);/) || [])[1] || 0);
  ok(dflt > 0 && dflt <= 500, `the stock-quote warmer's daily ceiling defaults to a small finite number (${dflt})`);
}

// The guard must actually be looking at something - an empty scan would pass
// silently, which is the vacuous-green failure this codebase keeps producing.
const reaching = files.filter((f) => {
  const src = readFileSync(new URL(f, dir), "utf8");
  return METERED.some((h) => src.includes(h));
});
// Floor is 3 (was 4 until landing.js, the dead page whose only ALLOWED entry
// was "unused legacy page (not mounted)", was deleted 2026-08-15 - it had
// been padding this count the whole time).
ok(reaching.length >= 3,
  `the scan found ${reaching.length} non-tool files touching a metered host (sanity: it is not blind)`);

// The three specific bounds that were each added AFTER an invoice. Losing any
// one of them re-opens a leak that has already cost real money.
const server = readFileSync(new URL("server.js", dir), "utf8");
ok(/SQL_SCAN_DAILY_BUDGET\) \|\| 0;/.test(server),
  "CDP wallet scans stay OFF by default (the $245.59 lesson)");
const rev = readFileSync(new URL("revenue-live.js", dir), "utf8");
// The TTL is written as an expression (`10 * 60_000`), not a literal, so parse
// the minutes multiplier rather than a bare number - the first version of this
// assertion captured nothing and reported 0s against correct code.
const mins = Number((rev.match(/SNAPSHOT_TTL_MS[^;]*\|\|\s*(\d+)\s*\*\s*60_?000/) || [])[1] || 0);
// Raised from >=5 after a production census measured 221 Alchemy calls per
// refresh: at a 10-minute TTL that is ~955,000 billed calls/month for a page
// with no revenue attached. The floor is the lesson, so it moves with it.
ok(mins >= 30,
  `the revenue snapshot TTL is at least 30 min (${mins} min) - 221 Alchemy calls per refresh means a short TTL is ~1M calls/month`);
const econ = readFileSync(new URL("x402-economy.js", dir), "utf8");
ok(/ECONOMY_FRESH_MS[^;]*60 \* 60 \* 1000/.test(econ),
  "the economy snapshot is cached in hours - its data is a 7/30-day aggregate");

// The noRequest check has to be able to SEE a request, or it is a rubber stamp
// on every file added under that flag. Prove it against a file that does call
// out before believing it about one that does not. The control is revenue-live
// (a real fetcher that also names the hosts) and NOT x402-economy, which
// reaches CDP through a paid tool HANDLER and matches no request verb - the
// same in-process shape as the Brave leak, and the honest limit of this check:
// it can say "this file issues no request of its own", never "this file cannot
// reach the host".
const caller = readFileSync(new URL("revenue-live.js", dir), "utf8");
ok(REQUEST_VERBS.test(caller) && !REQUEST_VERBS.test(readFileSync(new URL("upstream-budgets.js", dir), "utf8")),
  "the noRequest check recognises a real caller, and upstream-budgets is not one");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
