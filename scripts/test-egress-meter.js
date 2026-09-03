#!/usr/bin/env node
import { readFileSync } from "node:fs";
// The thing that totals up what we spend must be cheap, safe and honest.
//
//   node scripts/test-egress-meter.js          (offline)
//
// WHY: three cost leaks were found by an invoice rather than by us. All three
// looked like ordinary traffic until someone totalled it up, and nothing was
// totalling it up. This meter runs in production on the hot path of every
// outbound call, so the properties that keep it safe there matter as much as
// the counting.
import { recordEgress, egressReport, needsCaller, __resetEgressMeter } from "../src/egress-meter.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

__resetEgressMeter();

// 1. It counts, and it attributes.
recordEgress("api.search.brave.com", "x\n at y\n at z (/Users/a/src/tools/search.js:1:1)");
recordEgress("api.search.brave.com", "x\n at y\n at z (/Users/a/src/tools/search.js:1:1)");
recordEgress("g.alchemy.com", "x\n at y\n at z (/Users/a/src/revenue-live.js:1:1)");
let r = egressReport();
ok(r.totalCalls === 3 && r.distinctHosts === 2, `counts calls and hosts (${r.totalCalls}/${r.distinctHosts})`);
const brave = r.hosts.find((h) => h.host === "api.search.brave.com");
ok(brave.calls === 2, "repeat calls to one host aggregate");
ok(brave.callers.includes("tools/search.js"), "the calling file is recorded");

// 2. Attribution must name the FEATURE, not the transport. Every outbound call
//    passes through fetch-guard; reporting that is true and useless, because it
//    never tells you which feature is spending.
__resetEgressMeter();
recordEgress("g.alchemy.com",
  "e\n at fetch\n at safeFetch (/Users/a/src/tools/fetch-guard.js:9:9)\n at scan (/Users/a/src/revenue-live.js:5:5)");
r = egressReport();
ok(r.hosts[0].callers.includes("revenue-live.js"),
  `skips the transport frame and names the caller (${r.hosts[0].callers.join(",")})`);
ok(!r.hosts[0].callers.includes("tools/fetch-guard.js"),
  "...and does not report the plumbing as the spender");

// 3. It must NEVER throw. It sits on the hot path of every tool call, and a
//    metering bug that breaks a paid request would cost more than the leak.
let threw = null;
try {
  recordEgress(null, null);
  recordEgress(undefined, undefined);
  recordEgress("", {});
  recordEgress("h", { toString() { throw new Error("hostile stack"); } });
  egressReport({ top: -5 });
} catch (e) { threw = e; }
ok(!threw, `malformed input never throws (${threw?.message || "no throw"})`);
// HONEST LIMIT: this exercises callerOf's own guard, not recordEgress's outer
// catch - mutating that catch to rethrow leaves this assertion green, because
// the hostile input is swallowed one level down. The outer catch is
// defence-in-depth for future edits and is NOT covered here. Recorded rather
// than papered over: a test that implies coverage it lacks is how three leaks
// survived guards that looked green.

// 4. Memory is bounded. An index crawl touches ~1,300 hosts; a hostile or
//    runaway caller must not grow this without limit.
__resetEgressMeter();
for (let i = 0; i < 2500; i++) recordEgress(`h${i}.test`, "");
r = egressReport({ top: 5 });
ok(r.distinctHosts <= 2000, `host table is capped (${r.distinctHosts})`);
ok(r.droppedHosts > 0, `and it reports what it dropped rather than silently truncating (${r.droppedHosts})`);

// 5. Host ONLY. A full URL would capture buyer-supplied input - a render
//    target, a search query - which is customer data we have no reason to keep.
__resetEgressMeter();
recordEgress("api.search.brave.com", "");
// Check the HOST fields, not the whole document: the report legitimately
// contains "?" as the unknown-caller marker, and matching that was the test
// flagging its own fallback as a privacy leak.
recordEgress("api.openai.com", "at x (/Users/a/src/tools/llm-kit.js:1:1)");
const hostFields = egressReport().hosts.map((h) => h.host);
ok(hostFields.every((h) => !/[/?#]/.test(h)),
  `no host field contains a path, query or fragment (${hostFields.join(", ")})`);
ok(hostFields.every((h) => !/^https?:/.test(h)),
  "hosts are stored bare, not as URLs");

// 6. COST. This wraps every outbound call, so it must be cheap once a host is
//    known. The first version built `new Error().stack` on EVERY call while its
//    own comment claimed "one Map lookup and an integer increment" - at boot the
//    index crawler makes hundreds of requests and it pushed startup past the
//    20s budget in scripts/test-shutdown.js. CI caught what the comment denied.
__resetEgressMeter();
const N = 100_000;
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  recordEgress("hot.test", needsCaller("hot.test") ? () => new Error().stack : null);
}
const ms = Date.now() - t0;
ok(ms < 2000, `${N} records in ${ms}ms - the hot path stays cheap once a host is known`);
const hot = egressReport().hosts.find((h) => h.host === "hot.test");
ok(hot.calls === N, "every call is still counted");
ok(hot.callers.length <= 4, `attribution stops after a few samples (${hot.callers.length})`);

// 7. ATTRIBUTION AT REAL DEPTH — the assertion that was missing while the
//    meter was blind in production.
//
//    Every check above feeds callerOf() a hand-built stack string, so all 13
//    passed against a meter that named ITSELF as the caller for every metered
//    vendor in a production census (Alchemy 214 calls <- egress-meter.js). Two
//    causes, neither reachable from a synthetic string:
//      * Error.stackTraceLimit defaults to 10, and this module's own plumbing
//        eats three frames, so a caller ~7+ frames down was never captured.
//      * a request issued from inside a vendor SDK has no /src/ frame near the
//        top, and the /src/-only match then fell through to the plumbing.
//
//    So this drives the INSTALLED fetch hook from a real file on disk, at
//    depths that bracket the old limit. Depth 3 passed before; 15 and 30 did
//    not, which is precisely the shape of every SDK-mediated call we bill for.
{
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");

  // The intervening frames MUST live outside /src/, in a node_modules path.
  //
  // The first version of this fixture recursed inside deep-caller.js itself, so
  // every intermediate frame was also a /src/ frame and the caller was found at
  // frame 4 no matter the depth. It passed, and it passed just as happily with
  // both fixes reverted — a fixture that cannot reproduce the bug it guards.
  // A real SDK call looks like this instead: our file at the BOTTOM, vendor
  // frames stacked on top of it, which is exactly what pushed the app frame
  // past the 10-frame limit in production.
  const root = mkdtempSync(join(tmpdir(), "egress-attr-"));
  const srcDir = join(root, "src");
  const pkgDir = join(root, "node_modules", "fake-sdk");
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(pkgDir, { recursive: true });

  // The SDK calls fetch ITSELF. Passing a callback authored in deep-caller.js
  // put an app-owned frame directly above fetch, which again made the caller
  // findable at frame 4 regardless of depth — the same way the first fixture
  // failed, one level subtler. Our code must appear ONLY at the bottom.
  writeFileSync(join(pkgDir, "index.js"), `
// Stands in for viem / the CDP client: frames between our code and fetch().
export const request = (n, url) => (n === 0 ? globalThis.fetch(url) : request(n - 1, url));
`);
  const file = join(srcDir, "deep-caller.js");
  writeFileSync(file, `
import { request } from ${JSON.stringify(pathToFileURL(join(pkgDir, "index.js")).href)};
export async function fetchAtDepth(url, depth) {
  return request(depth, url);
}
`);

  globalThis.fetch = async () => ({ ok: true });        // base fetch first...
  const { installEgressMeter } = await import("../src/egress-meter.js");
  installEgressMeter();                                  // ...so the hook wraps it
  const { fetchAtDepth } = await import(pathToFileURL(file).href);

  __resetEgressMeter();
  for (const depth of [3, 15, 30]) {
    await fetchAtDepth(`https://depth${depth}.alchemy.test/v2/k`, depth);
  }
  for (const depth of [3, 15, 30]) {
    const row = egressReport().hosts.find((h) => h.host === `depth${depth}.alchemy.test`);
    ok(row && row.callers.includes("deep-caller.js"),
      `names the real caller ${depth} frames deep (got ${row ? row.callers.join(",") : "no row"})`);
    ok(row && !row.callers.includes("egress-meter.js"),
      `the meter never blames itself at depth ${depth}`);
  }

  // A call with NO app frame at all — a background SDK timer, or a stack deeper
  // than the capture limit. "?" and "egress-meter.js" are both dead ends for
  // the only question this meter answers; the package name at least says which
  // dependency is spending money.
  const { request } = await import(pathToFileURL(join(pkgDir, "index.js")).href);
  await request(0, "https://no-app-frame.alchemy.test/v2/k");
  const orphan = egressReport().hosts.find((h) => h.host === "no-app-frame.alchemy.test");
  ok(orphan && orphan.callers.includes("pkg:fake-sdk"),
    `names the package when no app frame exists (got ${orphan ? orphan.callers.join(",") : "no row"})`);
}


// The two global fetch wrappers are plumbing, not callers (2026-09-02: the
// Alchemy row read "drain-abort.js" within an hour of that wrapper shipping).
{
  const src = readFileSync(new URL("../src/egress-meter.js", import.meta.url), "utf8");
  const line = src.split("\n").find((l) => l.startsWith("const PLUMBING = /")) || "";
  ok(line.includes("drain-abort") && line.includes("facilitator-diagnostics"), "PLUMBING skips the drain-aware and facilitator-diagnostics fetch wrappers");
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
