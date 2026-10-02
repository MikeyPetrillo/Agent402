#!/usr/bin/env node
// The crawl cadence is a factual claim we make to third parties about how often
// we fetch their servers — the same class as a price quoted in prose, and the
// reason a seller opened #886. It is stated on two rendered pages, and both
// used to type "every 5 minutes" as a literal, so raising the interval would
// have left us advertising a cadence six times faster than the one we run.
//
// This guard fails if any served page states a crawl cadence that is not the
// one derived from the timer constant. Offline; no server boot.
import { readFileSync, readdirSync } from "node:fs";
import { crawlIntervalLabel } from "../src/x402-index.js";
import { mppCrawlIntervalLabel } from "../src/mpp-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error("FAIL:", m); } };

// 1. The labels are derived, and derive correctly.
ok(/^every \d+ (minutes|hours)$|^every hour$/.test(crawlIntervalLabel()),
  `x402 label malformed: ${crawlIntervalLabel()}`);
ok(/^every \d+ (minutes|hours)$|^every hour$/.test(mppCrawlIntervalLabel()),
  `mpp label malformed: ${mppCrawlIntervalLabel()}`);

// 2. No page SOURCE may hardcode a crawl cadence. We look for a cadence phrase
//    sitting next to crawl language in a string literal, which is exactly the
//    shape that shipped. A file that interpolates the derived label is fine
//    because the literal minutes are simply not there to match.
// EVERY module under src/, not a hand-kept list. The first version of this
// guard listed seven files and missed src/market-page.js - the one that
// actually renders /marketplace and every per-chain page - because it was
// written against a renderer that turned out to be dead code nothing mounts.
// A guard whose coverage is a list someone has to remember to extend fails
// exactly when a new page is added, which is the moment it is needed.
const PAGE_FILES = readdirSync(new URL("../src", import.meta.url))
  .filter((f) => f.endsWith(".js"))
  .map((f) => `src/${f}`);
// Deliberately keyed on crawl/index language only: the heartbeat and the
// Cloudflare status observer also state cadences, and those are honest claims
// about a different system that must not be rewritten by this guard.
// The second shape shipped too: "hourly" beside crawl/probe language, typed
// while the crawler re-probes every 30 minutes (market and sell pages).
const CADENCE = /(crawl|re-?probes?|index)[^.<>{}]{0,80}?every (\d+|five|ten|fifteen|thirty) minutes?|\bhourly (crawl|probe|pass)|\b(probes?|crawl(s|er)?)( \w+){0,3} hourly\b|next hourly pass/i;
for (const f of PAGE_FILES) {
  let src = "";
  try { src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8"); } catch { continue; }
  const offenders = src.split("\n")
    .map((line, i) => [i + 1, line])
    // comments explain mechanism to us, not cadence to sellers
    .filter(([, line]) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(([, line]) => CADENCE.test(line));
  ok(offenders.length === 0,
    `${f} states a crawl cadence as a literal (derive it from crawlIntervalLabel()): ` +
    offenders.map(([n]) => `line ${n}`).join(", "));
}

// 3. Mutation control: the detector must actually see the shape that shipped.
ok(CADENCE.test('this page crawls them every 5 minutes and shows what is online'),
  "detector blind to the exact string that shipped on /index");
ok(CADENCE.test('A crawl cycle re-probes every known origin every 5 minutes;'),
  "detector blind to the exact string that shipped on /mpp-marketplace");
ok(CADENCE.test('every independent seller the hourly crawl finds') && CADENCE.test('records your tools and advertised chains, and probes health hourly') && CADENCE.test('the crawler picks you up on the next hourly pass'),
  "detector blind to the 'hourly' crawl shapes that shipped on the market and sell pages");
ok(!CADENCE.test('the heartbeat probes production every 15 minutes'),
  "detector over-matches unrelated cadence copy (status/heartbeat)");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
