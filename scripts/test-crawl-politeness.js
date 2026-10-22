// Crawl load is per OPERATOR, and the register cap is a backstop not a queue.
//
// Both come from the same 2026-08-31 mailbox read. A listed seller reported
// ~18,200 requests/day across their 20 hosts, ~67% of all their external
// traffic, none carrying payment; our own arithmetic put it in the same order of
// magnitude, because we key on ORIGIN and their 20 hosts were 20 unrelated crawl
// targets. Separately three sellers in one week were refused by
// /api/index/register's 30/hour GLOBAL cap and two gave up and emailed instead.
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { childJson } from "./lib/child-json.js";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
// the same suffix and starve another seller's listing until its learned quote aged
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
// Suffixes a 2026-10-20 read of the index found hosting three or more sellers
// paying to distinct wallets. Before this, every project on the first of them
// shared one budget of four per cycle, and a seller's row waited a day for a
// read that would have priced it.
for (const [a, b, label] of [
  ["https://abcdefghijklmnopqrst.supabase.co/functions/v1/one", "https://tsrqponmlkjihgfedcba.supabase.co/functions/v1/two", "supabase.co"],
  ["https://svc-a-123456789.us-central1.run.app", "https://svc-b-987654321.europe-west1.run.app", "run.app"],
  ["https://10-0-0-1.sslip.io", "https://10-0-0-2.sslip.io", "sslip.io"],
  ["https://app.user-a.deno.net", "https://app.user-b.deno.net", "deno.net"],
  ["https://a-box.duckdns.org", "https://b-box.duckdns.org", "duckdns.org"],
  ["https://alpha-beta-gamma.ngrok-free.dev", "https://delta-eps-zeta.ngrok-free.dev", "ngrok-free.dev"],
  ["https://host.tail000001.ts.net", "https://host.tail000002.ts.net", "ts.net"],
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
ok(/const fraction = cycleOkFraction\(due\);/.test(index) && /releaseDeadSubmissions\(fraction\)/.test(index) && !/cycleOkFraction\(ordered\)/.test(index),
   "the outage guard scores the crawled set, not the full seed list");
ok(/const due = originsDueThisCycle\(ordered, crawlCycle\)/.test(index),
   "runCrawl actually applies the per-operator filter");
ok(/runPool\(due, CRAWL_CONCURRENCY, crawlSeller\)/.test(index),
   "and crawls the FILTERED list, not the full one");

// THE ROTATION INDEX SURVIVES A RESTART. The cycle number picks which slice of
// a large operator's list is due, so an index that starts at 0 on every boot
// never reaches the slices a process does not live long enough to count up
// to. Each "boot" below is a fresh process reading the same store.
const runCrawl = /async function runCrawl\(\) \{[\s\S]*?\n\}\n/.exec(index)?.[0] || "";
ok(/const cycle = await advanceCrawlCycle\(\);/.test(runCrawl) && !/crawlCycle \+= 1/.test(runCrawl),
   "runCrawl advances the rotation through the store, not a bare in-memory increment");
ok(/export function startCrawler\(opts = \{\}\) \{[\s\S]*?loadCrawlCycle\(\);/.test(index),
   "the crawler loads the stored rotation index at boot");
const dir = mkdtempSync(join(tmpdir(), "crawl-cycle-"));
const cycleFile = join(dir, "x402-crawl-cycle.json");
const moduleUrl = pathToFileURL(new URL("../src/x402-index.js", import.meta.url).pathname).href;
// One process: load the store, run `advances` cycles, print the index. When
// `nested` is given it runs as a second process between the load and the
// advance, the shape of two containers taking the crawl lease in turn.
const boot = (advances, nested = null) => {
  const code = `
    const m = await import(${JSON.stringify(moduleUrl)});
    await m.loadCrawlCycle();
    const before = m.currentCrawlCycle();
    ${nested ? `const { execFileSync } = await import("node:child_process"); execFileSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(nested)}], { stdio: "pipe" });` : ""}
    let n = before;
    for (let i = 0; i < ${advances}; i++) n = await m.advanceCrawlCycle();
    console.log(JSON.stringify({ before, after: n }));
    process.exit(0);
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, CRAWL_CYCLE_FILE: cycleFile, FREE_MODE: "true" }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).toString();
  return childJson(out);
};
try {
  const first = boot(3);
  ok(first.before === 0 && first.after === 3, `a fresh store starts at 0 and three cycles count to 3 (${JSON.stringify(first)})`);
  const second = boot(1);
  ok(second.before === 3, `a restarted process resumes at the stored index, 3 (read ${second.before})`);
  ok(second.after === 4, `and its next cycle is 4, not 1 (got ${second.after})`);
  // Two containers: the second loaded the index at 4, then the first ran a
  // cycle (5); the second's own cycle must be 6, read from the store, not 5
  // from its memory.
  const nestedCode = `
    const m = await import(${JSON.stringify(moduleUrl)});
    await m.loadCrawlCycle();
    await m.advanceCrawlCycle();
    process.exit(0);
  `;
  const third = boot(1, nestedCode);
  ok(third.before === 4 && third.after === 6, `a cycle another container ran meanwhile is counted: 4 loaded, 5 ran elsewhere, this one is 6 (${JSON.stringify(third)})`);
  const stored = JSON.parse(readFileSync(cycleFile, "utf8"));
  ok(stored.cycle === 6, `the store holds the index the last cycle ran under (${JSON.stringify(stored)})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
