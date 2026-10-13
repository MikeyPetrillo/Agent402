// Tests for the deploy quiet gate: the CI step that holds a Railway deploy
// until OUTSIDE traffic (paid or free, our own probes excluded) has a lull and
// no money journal entry waits on a container's local disk (the
// ledgerDeadLetter word on /api/gateway-status). Pure checks on the verdict
// helpers, source pins against the /api/stats labels and the dead-letter words
// the gate reads, and end-to-end runs of the script against a stub server that
// answers both surfaces.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lastOutsideAgeSeconds, isQuiet, isOurs, createQuietTracker, FEED_ROWS, LEDGER_HOLD_WORDS, ledgerHolds, ledgerDeadLetterWord } from "./deploy-quiet-gate.js";

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
// The labels live in paidWithLabel(); every recentCalls row is mapped through it.
const labelLine = statsSrc.split("\n").find((l) => /^\s*return method === "pow" \? "proof-of-work"/.test(l)) || "";
ok(/paidWith: paidWithLabel\(r\.method\)/.test(statsSrc), "recentCalls labels come from paidWithLabel");
const labels = [...labelLine.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).filter((s) => !["pow"].includes(s));
ok(labels.includes("heartbeat") && labels.includes("proof-of-work") && labels.includes("usdc"),
  `recentCalls publishes the three labels the gate knows (${labels.join(", ")})`);
ok(isOurs({ paidWith: "heartbeat" }) && !isOurs({ paidWith: "usdc" }) && !isOurs({ paidWith: "proof-of-work" }),
  "only the heartbeat label is ours; usdc and proof-of-work are outside");
// Our own paid calls reach the feed under the heartbeat label (stats.recordCall's
// internal branch), which is what lets the gate ignore them.
ok(/insertRecent\.run\(slug, "heartbeat", Date\.now\(\)\)/.test(statsSrc),
  "our own paid calls are written to the feed as heartbeat rows");

// --- the ledger word the gate reads -----------------------------------------
// The two words that hold a deploy are the two deadLetterWord() answers that
// mean "on this container's local disk" (src/ledger-mirror.js), and they are
// the same two the heartbeat pages on; pinned so the three cannot drift apart.
const mirrorSrc = readFileSync(join(here, "..", "src", "ledger-mirror.js"), "utf8");
const wordFn = mirrorSrc.slice(mirrorSrc.indexOf("export function deadLetterWord("), mirrorSrc.indexOf("export const MONEY_JOURNALS"));
const wordsReturned = [...wordFn.matchAll(/return (?:waiting > 0 \? )?"([a-z]+)"/g)].map((m) => m[1]);
ok(wordsReturned.includes("stuck") && wordsReturned.includes("local"), `deadLetterWord() still answers the words the gate holds on (${wordsReturned.join(", ")})`);
ok(/if \(onLocalDisk > 0\) return "local";/.test(wordFn) && /return "stuck";/.test(wordFn), "\"local\" and \"stuck\" are the local-disk answers; \"pending\" is the shared journal");
for (const w of LEDGER_HOLD_WORDS) ok(wordsReturned.includes(w), `gate hold word "${w}" is a word deadLetterWord() can answer`);
const serverSrc = readFileSync(join(here, "..", "src", "server.js"), "utf8");
ok(/ledgerDeadLetter: \(\(\) => \{\s*try \{ return ledgerDeadLetterStatus\(/.test(serverSrc), "/api/gateway-status publishes ledgerDeadLetter from ledgerDeadLetterStatus()");
const heartbeat = readFileSync(join(here, "..", ".github", "workflows", "heartbeat.yml"), "utf8");
ok(/\[ "\$WORD" = "stuck" \] \|\| \[ "\$WORD" = "local" \]/.test(heartbeat), "the heartbeat re-reads on the same two words the gate holds on");
ok(ledgerHolds("local") && ledgerHolds("stuck"), "local and stuck hold the deploy");
for (const w of ["none", "pending", "off", "unknown", "", undefined, null]) ok(!ledgerHolds(w), `${JSON.stringify(w)} does not hold the deploy (only a word that names local disk does)`);
ok(ledgerDeadLetterWord({ ledgerDeadLetter: { status: "none" } }) === "none", "the word is read from ledgerDeadLetter.status");
ok(ledgerDeadLetterWord({ ledgerDeadLetter: { status: "local" } }) === "local", "a holding word is read verbatim");
for (const [payload, what] of [[{}, "no ledgerDeadLetter field"], [{ ledgerDeadLetter: {} }, "no status"], [{ ledgerDeadLetter: { status: "" } }, "empty status"], [{ ledgerDeadLetter: { status: 3 } }, "status not a string"], [null, "no body"]]) {
  ok(ledgerDeadLetterWord(payload) === null, `unreadable gateway-status (${what}) reads null (fail-open, the gate warns)`);
}

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
// stay put and age in real time, and the gate has to wait them out. `hits`
// counts /api/stats polls; `ledgerHits` counts /api/gateway-status polls, which
// answer `ledgerMode` (a word, "shape" for a payload without the field,
// "http-500", or "local-then-none": local on the first two polls, then none).
let mode = "paid-burst";
let hits = 0;
let burst = [];
let ledgerMode = "none";
let ledgerHits = 0;
const server = createServer((req, res) => {
  if (req.url.startsWith("/api/gateway-status")) {
    ledgerHits++;
    if (ledgerMode === "http-500") return void res.writeHead(500).end("boom");
    const word = ledgerMode === "local-then-none" ? (ledgerHits <= 2 ? "local" : "none") : ledgerMode;
    res.writeHead(200, { "Content-Type": "application/json" });
    return void res.end(JSON.stringify(ledgerMode === "shape" ? { stateDb: { status: "on" } } : { ledgerDeadLetter: { status: word } }));
  }
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
  if (req.url.startsWith("/api/gateway-status")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return void res.end(JSON.stringify({ ledgerDeadLetter: { status: "none" } }));
  }
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

// --- the ledger word, end to end ----------------------------------------------
hits = 0; ledgerHits = 0; mode = "empty"; ledgerMode = "local-then-none"; t0 = Date.now();
r = await runGate(fast);
ok(r.code === 0 && /ledgerDeadLetter reads "local"/.test(r.out) && /PASS, .*ledgerDeadLetter none/.test(r.out),
  "a held journal entry holds the gate while traffic is quiet, and the gate passes once the word clears");
ok(ledgerHits === 3 && hits === 3 && Date.now() - t0 >= 400, `both surfaces are polled together at the gate's cadence (${hits} stats polls, ${ledgerHits} ledger polls, ${Date.now() - t0}ms)`);

hits = 0; ledgerHits = 0; mode = "empty"; ledgerMode = "stuck";
r = await runGate({ ...fast, MAX_WAIT_SECS: "1" });
ok(r.code === 0 && /proceeding anyway/.test(r.out) && /still held after 1s \(ledgerDeadLetter stuck\)/.test(r.out) && /pages on ledgerDeadLetter stuck/.test(r.out),
  "a word that never clears: proceeds after max wait, naming the word (never strands a deploy)");
ok(!/PASS/.test(r.out) && ledgerHits >= 3, `the gate never called a held ledger a pass (${ledgerHits} ledger polls)`);

hits = 0; ledgerHits = 0; mode = "paid-burst"; burst = []; ledgerMode = "local-then-none";
r = await runGate(burstEnv);
ok(r.code === 0 && /outside traffic \d+s ago/.test(r.out) && /ledgerDeadLetter reads "local"/.test(r.out) && /PASS/.test(r.out),
  "traffic and the ledger word hold together and the gate passes only when both are clear");

for (const word of ["none", "pending", "off", "unknown"]) {
  hits = 0; ledgerHits = 0; mode = "empty"; ledgerMode = word;
  r = await runGate(fast);
  ok(r.code === 0 && /PASS/.test(r.out) && ledgerHits === 1 && hits === 1, `ledgerDeadLetter "${word}" lets the deploy go on the first poll`);
}

hits = 0; ledgerHits = 0; mode = "empty"; ledgerMode = "shape";
r = await runGate(fast);
ok(r.code === 0 && /ledgerDeadLetter is not in the expected shape/.test(r.out) && /PASS, .*ledgerDeadLetter unreadable/.test(r.out) && ledgerHits === 1,
  "a gateway-status payload without the word fails open on the ledger at once, with a warning");

hits = 0; ledgerHits = 0; mode = "empty"; ledgerMode = "http-500";
r = await runGate(fast);
ok(r.code === 0 && /gateway-status unreachable, failing OPEN/.test(r.out) && /PASS/.test(r.out) && ledgerHits === 4 && hits === 4,
  `an unreachable gateway-status fails open after ${ledgerHits} consecutive errors; traffic is re-read on every poll until both are clear (${hits} stats polls)`);

hits = 0; ledgerHits = 0; mode = "http-500"; ledgerMode = "local-then-none";
r = await runGate(fast);
ok(r.code === 0 && /stats unreachable, failing OPEN/.test(r.out) && /ledgerDeadLetter reads "local"/.test(r.out) && /PASS/.test(r.out),
  "each check fails open on its own: unreadable stats do not release a held ledger word");
ledgerMode = "none";

r = await runGate({ TARGET_URL: base, QUIET_GATE: "off" });
ok(r.code === 0 && /skipping/.test(r.out), "QUIET_GATE=off skips immediately");

r = await runGate({ TARGET_URL: "" });
ok(r.code === 1, "missing TARGET_URL is a hard misconfiguration error");

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
