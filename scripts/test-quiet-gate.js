// Tests for the deploy quiet gate: the CI step that holds a Railway deploy
// until OUTSIDE traffic (paid or free, our own probes excluded) has a lull.
// Pure checks on the verdict helpers, a source pin against the /api/stats
// labels the gate reads, and end-to-end runs of the script against a stub
// /api/stats server.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lastOutsideAgeSeconds, isQuiet, isOurs, createQuietTracker, FEED_ROWS } from "./deploy-quiet-gate.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const here = dirname(fileURLToPath(import.meta.url));
const NOW = 1_800_000_000_000;
const iso = (agoSecs, now = NOW) => new Date(now - agoSecs * 1000).toISOString();
const stats = (calls) => ({ recentCalls: calls });
const paid = (ago, now) => ({ slug: "transcribe", paidWith: "usdc", at: iso(ago, now) });
const pow = (ago, now) => ({ slug: "hash", paidWith: "proof-of-work", at: iso(ago, now) });
const beat = (ago, now) => ({ slug: "hash", paidWith: "heartbeat", at: iso(ago, now) });
/** A full feed of our own rows, newest `from` seconds ago, one every `step` s. */
const oursFeed = (from, step, now = NOW) => Array.from({ length: FEED_ROWS }, (_, i) => beat(from + i * step, now));

// --- the source the gate reads ----------------------------------------------
// The gate's notion of "a full page" and of "ours" must match what src/stats.js
// actually publishes, or the visibility rule and the classifier drift silently.
const statsSrc = readFileSync(join(here, "..", "src", "stats.js"), "utf8");
const shown = statsSrc.match(/const RECENT_SHOW = (\d+);/);
ok(shown && Number(shown[1]) === FEED_ROWS, `FEED_ROWS (${FEED_ROWS}) matches RECENT_SHOW in src/stats.js (${shown?.[1]})`);
const labelLine = statsSrc.split("\n").find((l) => /^\s*paidWith: r\.method ===/.test(l)) || "";
const labels = [...labelLine.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).filter((s) => !["pow"].includes(s));
ok(labels.includes("heartbeat") && labels.includes("proof-of-work") && labels.includes("usdc"),
  `recentCalls publishes the three labels the gate knows (${labels.join(", ")})`);
ok(isOurs({ paidWith: "heartbeat" }) && !isOurs({ paidWith: "usdc" }) && !isOurs({ paidWith: "proof-of-work" }),
  "only the heartbeat label is ours; usdc and proof-of-work are outside");
// Our own paid calls reach the feed under the heartbeat label (stats.recordCall's
// internal branch), which is what lets the gate ignore them.
ok(/insertRecent\.run\(slug, "heartbeat", Date\.now\(\)\)/.test(statsSrc),
  "our own paid calls are written to the feed as heartbeat rows");

// --- verdict helpers --------------------------------------------------------
ok(lastOutsideAgeSeconds(stats([paid(30)]), NOW) === 30, "a paid call holds the gate (age measured)");
ok(lastOutsideAgeSeconds(stats([pow(5)]), NOW) === 5, "a proof-of-work call holds the gate too (free and hosted-MCP callers)");
ok(lastOutsideAgeSeconds(stats([beat(5), beat(6)]), NOW) === Infinity, "heartbeat rows never hold the gate");
ok(lastOutsideAgeSeconds(stats([paid(500), pow(40), beat(2)]), NOW) === 40,
  "the NEWEST outside call wins, whatever its class and wherever it sits in the feed");
ok(lastOutsideAgeSeconds(stats([{ slug: "x", paidWith: "credits", at: iso(12) }]), NOW) === 12,
  "an unknown future label counts as outside (waiting is the safe direction)");
ok(lastOutsideAgeSeconds(stats([]), NOW) === Infinity, "empty feed reads as quiet");
ok(lastOutsideAgeSeconds({}, NOW) === Infinity, "malformed stats fail open (quiet)");
ok(lastOutsideAgeSeconds(stats([{ paidWith: "usdc", at: "not-a-date" }]), NOW) === Infinity,
  "unparseable timestamps are ignored");

ok(isQuiet(stats([paid(200)]), NOW, 180) === true, "paid call older than the window: quiet");
ok(isQuiet(stats([paid(100)]), NOW, 180) === false, "recent paid call: busy");
ok(isQuiet(stats([pow(100)]), NOW, 180) === false, "recent proof-of-work call: busy");
ok(isQuiet(stats([pow(200)]), NOW, 180) === true, "proof-of-work call older than the window: quiet");
ok(isQuiet(stats([beat(1), beat(2)]), NOW, 180) === true, "only our own heartbeat traffic: quiet");
ok(isQuiet(stats([]), NOW, 180) === true, "empty feed: quiet");

// Unreadable payloads fail open, and say so.
const unreadableCases = [
  [{}, "no recentCalls field"],
  [{ recentCalls: "nope" }, "recentCalls not a list"],
  [stats([{ paidWith: "usdc", at: "not-a-date" }, null]), "no row with a readable timestamp"],
];
for (const [payload, what] of unreadableCases) {
  const v = createQuietTracker(180).observe(payload, NOW);
  ok(v.quiet === true && v.unreadable === true, `unreadable response (${what}) fails open and is flagged`);
}

// Visibility: our own rows filling the whole feed must not read as quiet.
{
  const v = createQuietTracker(180).observe(stats(oursFeed(1, 1.5)), NOW);
  ok(v.quiet === false && v.ageSecs === Infinity && v.coveredSecs < 180,
    `a full feed of our own rows spanning ${Math.round(v.coveredSecs)}s is not proof of quiet`);
  const deep = createQuietTracker(180).observe(stats(oursFeed(1, 10)), NOW);
  ok(deep.quiet === true && deep.coveredSecs >= 180, "a full feed of our own rows reaching back past the window is quiet");
  const short = createQuietTracker(180).observe(stats([beat(1), beat(3)]), NOW);
  ok(short.quiet === true && short.coveredSecs === Infinity, "a short page is the whole log, so it covers all time");
  const hidden = createQuietTracker(180).observe(stats([...oursFeed(1, 10).slice(0, FEED_ROWS - 1), pow(200)]), NOW);
  ok(hidden.quiet === true, "a full page whose oldest row is an outside call past the window is quiet");
}

// Unbroken polls extend visibility; a gap resets it.
{
  const t = createQuietTracker(180);
  let now = NOW, v;
  for (let i = 0; i < 12; i++) { now = NOW + i * 15_000; v = t.observe(stats(oursFeed(1, 1.5, now)), now); }
  ok(v.quiet === true && v.coveredSecs >= 180, `continuous polls over a saturated feed build visibility (${Math.round(v.coveredSecs)}s) and then pass`);
  const g = createQuietTracker(180);
  g.observe(stats(oursFeed(1, 1.5, NOW)), NOW);
  // next page's oldest row is AFTER the previous poll started: rows in between were never seen
  const later = NOW + 200_000;
  const gv = g.observe(stats(oursFeed(1, 1.5, later)), later);
  ok(gv.quiet === false && gv.coveredSecs < 180, "a gap between polls resets visibility instead of claiming quiet");
}

// Memory: an outside call seen once still holds the gate after it scrolls away.
{
  const t = createQuietTracker(180);
  const first = t.observe(stats([pow(10), ...oursFeed(11, 1).slice(0, FEED_ROWS - 1)]), NOW);
  ok(first.quiet === false && first.ageSecs === 10, "outside call in view: busy");
  let now = NOW, v;
  // our own rows, one a second: each page reaches back past the previous poll
  for (let i = 1; i <= 8; i++) { now = NOW + i * 15_000; v = t.observe(stats(oursFeed(0.5, 1, now)), now); }
  ok(v.quiet === false && Math.round(v.ageSecs) === 130, `after it scrolled out of the feed the gate still counts it (${Math.round(v.ageSecs)}s ago)`);
  for (let i = 9; i <= 13; i++) { now = NOW + i * 15_000; v = t.observe(stats(oursFeed(0.5, 1, now)), now); }
  ok(v.quiet === true, "and passes once it is older than the window");
}

// --- end-to-end against a stub server ---------------------------------------
const gateScript = join(here, "deploy-quiet-gate.js");

function runGate(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [gateScript], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

// The stub keeps each call's own timestamp, like the real feed: a burst's rows
// stay put and age in real time, and the gate has to wait them out.
let mode = "paid-burst";
let hits = 0;
let burst = [];
const server = createServer((req, res) => {
  hits++;
  if (mode === "http-500") return void res.writeHead(500).end("boom");
  if (mode === "not-json") return void res.writeHead(200, { "Content-Type": "application/json" }).end("<html>");
  const now = Date.now();
  let body;
  switch (mode) {
    // a call lands just before each of the first two polls, then nothing
    case "paid-burst": if (hits <= 2) burst.unshift(paid(0.5, now)); body = stats(burst); break;
    case "pow-burst": if (hits <= 2) burst.unshift(pow(0.5, now)); body = stats(burst); break;
    case "heartbeat-only": body = stats([beat(1, now), beat(2, now)]); break;
    case "empty": body = stats([]); break;
    case "unreadable": body = { recentCalls: null, note: "shape changed" }; break;
    // our own rows fill the whole feed, 0.1 s apart: one page shows 2.4 s
    case "saturated": body = stats(oursFeed(0, 0.1, now)); break;
    default: body = stats([]);
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const fast = { TARGET_URL: base, QUIET_SECS: "60", POLL_SECS: "0.2", MAX_WAIT_SECS: "30" };

const burstEnv = { ...fast, QUIET_SECS: "2" };
let t0 = Date.now();
let r = await runGate(burstEnv);
ok(r.code === 0 && /PASS/.test(r.out) && /outside traffic \d+s ago/.test(r.out), "paid burst: gate waits and passes once traffic ages out");
ok(hits >= 5 && Date.now() - t0 >= 1500, `gate actually waited out the paid burst (${hits} polls, ${Date.now() - t0}ms)`);

hits = 0; burst = []; mode = "pow-burst"; t0 = Date.now();
r = await runGate(burstEnv);
ok(r.code === 0 && /PASS/.test(r.out) && /outside traffic \d+s ago/.test(r.out), "proof-of-work burst: gate waits too, then passes");
ok(hits >= 5 && Date.now() - t0 >= 1500, `gate waited out the proof-of-work burst (${hits} polls, ${Date.now() - t0}ms)`);

hits = 0; mode = "heartbeat-only";
r = await runGate(fast);
ok(r.code === 0 && /PASS/.test(r.out) && hits === 1, `our own heartbeat traffic never holds the gate (${hits} poll)`);

hits = 0; mode = "empty";
r = await runGate(fast);
ok(r.code === 0 && /PASS/.test(r.out) && hits === 1, "empty feed passes on the first poll");

hits = 0; mode = "unreadable";
r = await runGate(fast);
ok(r.code === 0 && /not in the expected shape/.test(r.out) && hits === 1, "unreadable response fails open at once, with a warning");

hits = 0; mode = "saturated";
r = await runGate({ ...fast, QUIET_SECS: "4" });
ok(r.code === 0 && /our own traffic fills the feed/.test(r.out) && /PASS/.test(r.out) && hits >= 5,
  `a feed full of our own rows: gate polls until it has seen the whole window, then passes (${hits} polls)`);

hits = 0;
const busyServer = createServer((req, res) => {
  hits++;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(stats([pow(0, Date.now())])));
});
await new Promise((r2) => busyServer.listen(0, "127.0.0.1", r2));
r = await runGate({ TARGET_URL: `http://127.0.0.1:${busyServer.address().port}`, QUIET_SECS: "60", POLL_SECS: "0.2", MAX_WAIT_SECS: "1" });
ok(r.code === 0 && /proceeding anyway/.test(r.out), "sustained outside traffic: proceeds after max wait with a warning (never strands a deploy)");
busyServer.close();

hits = 0; mode = "http-500";
r = await runGate(fast);
ok(r.code === 0 && /failing OPEN/.test(r.out) && hits >= 4, "unreachable stats fails open after consecutive errors");

hits = 0; mode = "not-json";
r = await runGate(fast);
ok(r.code === 0 && /failing OPEN/.test(r.out) && hits >= 4, "a non-JSON body counts as a failed read and fails open");

r = await runGate({ TARGET_URL: base, QUIET_GATE: "off" });
ok(r.code === 0 && /skipping/.test(r.out), "QUIET_GATE=off skips immediately");

r = await runGate({ TARGET_URL: "" });
ok(r.code === 1, "missing TARGET_URL is a hard misconfiguration error");

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
