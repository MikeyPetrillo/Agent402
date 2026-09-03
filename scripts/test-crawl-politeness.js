// Crawl load is per OPERATOR, and the register cap is a backstop not a queue.
//
// Both come from the same 2026-08-31 mailbox read. A listed seller reported
// ~18,200 requests/day across their 20 hosts, ~67% of all their external
// traffic, none carrying payment; our own arithmetic put it in the same order of
// magnitude, because we key on ORIGIN and their 20 hosts were 20 unrelated crawl
// targets. Separately three sellers in one week were refused by
// /api/index/register's 30/hour GLOBAL cap and two gave up and emailed instead.
import { readFileSync } from "node:fs";
import { originsDueThisCycle, operatorKey } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.log(`FAIL - ${msg}`); } };

const many = Array.from({ length: 20 }, (_, i) => `https://h${i}.example.xyz`);
const solo = ["https://alone-a.com", "https://alone-b.io"];
const all = [...many, ...solo];

ok(operatorKey("https://a.b.example.xyz") === "example.xyz", "subdomains of one operator share a key");

// SHARED HOSTING IS NOT ONE OPERATOR. "last two labels" made every Vercel seller
// one operator, every Workers seller one operator, and handed each whole group a
// single per-cycle budget - so an attacker could register throwaway origins under
// the same suffix and starve a competitor's listing until its learned quote aged
// out (QUOTE_MAX_AGE_MS, 7 days). This file already knew better in one place:
// railwayDeploymentOrigin exists because unrelated sellers publish on
// *.up.railway.app.
for (const [a, b, label] of [
  ["https://victim.vercel.app", "https://attacker.vercel.app", "vercel.app"],
  ["https://a.one.workers.dev", "https://b.two.workers.dev", "workers.dev"],
  ["https://x.up.railway.app", "https://y.up.railway.app", "up.railway.app"],
  ["https://p.onrender.com", "https://q.onrender.com", "onrender.com"],
  ["https://m.pages.dev", "https://n.pages.dev", "pages.dev"],
]) ok(operatorKey(a) !== operatorKey(b), `two tenants on ${label} are not one operator`);
ok(operatorKey("https://x.foo.co.uk") === "foo.co.uk", "multi-part suffixes are not split at the wrong label");
ok(operatorKey("not a url") === "not a url", "an unparseable origin degrades to itself, never throws");

const c0 = originsDueThisCycle(all, 0);
ok(c0.filter((o) => o.includes("example.xyz")).length === 4, "a 20-host operator contributes at most the cap per cycle");
ok(solo.every((s) => c0.includes(s)), "single-host sellers are crawled every cycle - the cap must not slow the majority");

// Every origin must still be reached; a politeness budget that starves an origin
// forever is a listing bug, which is exactly the failure the quote-probe
// rotation was written to avoid.
const seen = new Set();
for (let c = 0; c < 5; c++) for (const o of originsDueThisCycle(all, c)) seen.add(o);
ok(many.every((m) => seen.has(m)), "every origin of a large operator is covered within ceil(n/cap) cycles");

ok(originsDueThisCycle([], 0).length === 0, "an empty seed list is not an error");
const one = originsDueThisCycle(["https://solo.dev"], 7);
ok(one.length === 1, "a lone origin is always due");

// Order matters: the crawl spends its quote budget first-come, so the politeness
// filter must not reshuffle the rotation the caller established.
const ordered = originsDueThisCycle(all, 2);
ok(ordered.join() === all.filter((o) => ordered.includes(o)).join(), "input order is preserved");

// The register cap: a global limit low enough to refuse ordinary adoption is the
// growth funnel turning away the people it exists for.
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const m = /REG_GLOBAL_MAX = Math\.max\(30, Number\(process\.env\.INDEX_REGISTER_GLOBAL_MAX \|\| (\d+)\)\)/.exec(server);
ok(!!m && Number(m[1]) >= 200, `the global register cap is a backstop, not a queue (${m ? m[1] : "not found"}/hour)`);
ok(/5 submissions per hour per IP/.test(server), "per-IP fairness is still enforced - that is what stops one actor");
ok(/GLOBAL cap hit/.test(server), "tripping the global cap is logged - it refused three sellers silently for a week");
ok(!/regGlobal\.length >= 30\b/.test(server), "the old hardcoded 30/hour global cap is gone");

// The function being correct proves nothing if the crawler stops calling it.
// Verified by mutation: replacing the call site with `const due = ordered` left
// every assertion above green, which is the same shape as a primitive that stays
// correct while the caller is quietly handed the wrong value.
const index = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
// The outage guard must score what was actually crawled. Once the cap made the
// crawled set a subset, passing the full list let held-back origins contribute
// their PREVIOUS verdict - diluting the fraction with stale OKs in the unsafe
// direction, so an egress outage could still clear the 0.5 floor and release
// submission slots.
ok(/releaseDeadSubmissions\(cycleOkFraction\(due\)\)/.test(index),
   "the outage guard scores the crawled set, not the full seed list");
ok(/const due = originsDueThisCycle\(ordered, crawlCycle\)/.test(index),
   "runCrawl actually applies the per-operator filter");
ok(/runPool\(due, CRAWL_CONCURRENCY, crawlSeller\)/.test(index),
   "and crawls the FILTERED list, not the full one");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
