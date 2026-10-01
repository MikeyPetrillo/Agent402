#!/usr/bin/env node
// We must stop re-asking an origin a question it has already answered 686 times.
//
//   node scripts/test-crawl-backoff.js
//
// WHY: a seller reported (#645) that our crawler hit their /.well-known/x402
// 686 times in one week and got 404 every single time, while simultaneously
// fetching their /agents.json successfully. The crawl interval was "gentle"
// (5 min) but the BEHAVIOUR was not: an origin that had failed hundreds of
// times in a row was re-probed exactly as often as a healthy one. That is our
// index spending someone else's bandwidth ~98 times a day to re-learn a fact
// we already had.
//
// Two properties, and the second is what keeps this honest:
//   * repeated failure widens the gap between probes,
//   * ANY success clears it immediately, so a seller who fixes their manifest
//     is picked back up on the next crawl rather than punished for having been
//     broken.
import { readFileSync } from "node:fs";
import { manifestProbeDue, probeDue, noteProbeOutcome, crawlBackoffState, __noteCrawlOutcomeForTest as note } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const o = "https://backoff.test";
const T0 = 1_000_000;

ok(manifestProbeDue(o, T0), "an origin we have never failed on is probed immediately");

// Early failures must NOT back off: a transient blip should not cost a seller
// their listing freshness.
note(o, false, T0); ok(manifestProbeDue(o, T0), "1st failure does not delay the next probe");
note(o, false, T0); ok(manifestProbeDue(o, T0), "2nd failure does not delay the next probe");
note(o, false, T0); ok(manifestProbeDue(o, T0), "3rd failure does not delay the next probe");

// Sustained failure does.
note(o, false, T0);
ok(!manifestProbeDue(o, T0), "4th consecutive failure starts backing off");
ok(manifestProbeDue(o, T0 + 31 * 60 * 1000), "...and it lifts once the window passes");

note(o, false, T0); note(o, false, T0);
const st = crawlBackoffState().find((x) => x.origin === o);
ok(st && st.fails >= 5, `sustained failure is tracked (${st?.fails} consecutive)`);
ok(!manifestProbeDue(o, T0 + 60 * 60 * 1000), "the window widens with further failures, not stays flat");

// THE PROPERTY THAT MATTERS MOST: a seller who fixes their manifest is not
// punished for having been broken.
note(o, true, T0);
ok(manifestProbeDue(o, T0), "a single success clears the backoff immediately");
ok(!crawlBackoffState().some((x) => x.origin === o), "and the origin leaves the backoff table entirely");

// The backoff is capped, not unbounded — an origin can never be shelved forever.
const o2 = "https://capped.test";
for (let i = 0; i < 50; i++) note(o2, false, T0);
ok(manifestProbeDue(o2, T0 + 7 * 60 * 60 * 1000),
  "even after 50 failures the probe resumes within hours - never permanently abandoned");

// --- the backoff must cover EVERY path, not the one that got reported ---
// The first version gated only /.well-known/x402, because that is the path the
// reporting seller named. The crawl asks each origin for four files. Measured
// afterwards: 687 indexed sellers reach the fallback chain, 21 of 25 sampled
// serve NONE of /openapi.json, /agents.json or /llms.txt, and all three were
// re-asked every 5 minutes forever - about 500,000 404s a day, roughly 700x
// the volume of the report that started it. Two of those paths were added the
// same afternoon as the fix.
const O = "https://multipath.test";
const T = 5_000_000;

for (let i = 0; i < 6; i++) noteProbeOutcome(O, "/openapi.json", false, T);
ok(!probeDue(O, "/openapi.json", T), "a dead /openapi.json backs off");
ok(probeDue(O, "/agents.json", T),
  "...and that must NOT back off /agents.json on the same origin - one dead path is not a dead origin");
ok(probeDue(O, "/llms.txt", T), "...nor /llms.txt");
ok(probeDue(O, "/.well-known/x402", T), "...nor the manifest");

ok(probeDue("https://other.test", "/openapi.json", T),
  "and a dead path on one origin never affects another origin");

for (let i = 0; i < 6; i++) noteProbeOutcome(O, "/agents.json", false, T);
noteProbeOutcome(O, "/openapi.json", true, T);
ok(probeDue(O, "/openapi.json", T), "a success clears that path immediately");
ok(!probeDue(O, "/agents.json", T), "...without clearing a different path that is still failing");

const paths = crawlBackoffState().filter((x) => x.origin === O);
ok(paths.length === 1 && paths[0].path === "/agents.json",
  `state reports WHICH path is backed off, not just which origin (${JSON.stringify(paths)})`);

// The structural guard. Gating four paths by hand is how the first three got
// missed; this fails if a future per-origin probe is added without the gate.
const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
// probePath's own fetch is the gated one; everything else must go through it.
const helperStart = src.indexOf("async function probePath(originUrl, path");
const helperEnd = src.indexOf("\n}", helperStart);
const outsideHelper = src.slice(0, helperStart) + src.slice(helperEnd);
// ONE deliberate exception: the robots.txt fetch cannot go through probePath,
// because probePath consults robots and that would recurse forever. It is not
// ungated - it carries its OWN bound, a 24h per-origin cache that also caches
// FAILURES, which is stricter than the backoff gate it bypasses (at most one
// request per origin per day, versus 288). Both halves are asserted below, so
// removing the cache or lengthening it silently is not possible.
const rawProbes = (outsideHelper.match(/(?:safeFetch|crawlFetch)\(`\$\{originUrl\}[^`]*`/g) || [])
  .filter((m) => !m.includes("/robots.txt"));
ok(rawProbes.length === 0,
  `every per-origin fetch goes through the backoff gate, none raw (found ${rawProbes.length}: ${rawProbes.join(", ")})`);
ok(/ROBOTS_TTL_MS\s*=\s*24 \* 60 \* 60 \* 1000/.test(src),
  "the robots.txt exception is bounded by a 24h cache, not by nothing");
ok(/robotsCache\.set\(originUrl, \{ groups, at: Date\.now\(\) \}\)/.test(src) &&
   src.indexOf("catch {") < src.indexOf("robotsCache.set(originUrl, { groups, at: Date.now() })", src.indexOf("async function robotsGroupsFor")),
  "and a FAILED robots fetch is cached too, so an unreachable origin is asked once a day and not once a cycle");
ok((src.match(/(?:safeFetch|crawlFetch)\(`\$\{originUrl\}/g) || []).length === 2,
  "exactly two per-origin fetches exist: the gated helper, and the robots.txt read it depends on");
ok(/async function probePath\(originUrl, path/.test(src),
  "the single gated helper every probe funnels through still exists");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
