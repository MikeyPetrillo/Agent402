#!/usr/bin/env node
// The submission ceiling was a lifetime bucket: an origin entered and nothing
// ever took it out, so the front door filled once and stayed full. A seller
// arriving later got "submission list is full" no matter how many of the
// origins ahead of them had gone dark months earlier.
//
// This pins the policy that gives a slot back. Everything here is about
// REFUSING to release, because a wrong release drops a real seller's listing
// and the pass runs unattended every cycle.
import { selectReleasableOrigins, cycleOkFraction } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const row = (origin, o = {}) => ({
  origin,
  first_seen: NOW - 200 * DAY,
  last_routable_seen: NOW - 1 * DAY,
  last_settled_seen: null,
  ...o,
});
const run = (opts) => selectReleasableOrigins({
  now: NOW, cycleOkFraction: 1, isSubmitted: () => true, hasSettled: () => false, ...opts,
});

// --- the case it exists for -------------------------------------------------
ok(run({ registrations: [row("https://gone.example", { last_routable_seen: NOW - 40 * DAY })] })
  .join() === "https://gone.example", "a month-dead submission was not released");

// --- refusals ---------------------------------------------------------------
ok(run({ registrations: [row("https://alive.example")] }).length === 0,
  "released an origin that answered yesterday");
ok(run({ registrations: [row("https://recent.example", { last_routable_seen: NOW - 29 * DAY })] }).length === 0,
  "released at 29 days - the window is 30");

// Money outranks liveness. A seller who has been PAID through us holds its
// slot three times as long (90 days), by its own row or by the ledger, and
// gives it back after that: a dead address serves nobody, and the
// registration row keeps its tenure for a return.
ok(run({ registrations: [row("https://paid.example", { last_routable_seen: NOW - 60 * DAY, last_settled_seen: NOW - 70 * DAY })] }).length === 0,
  "released a settled origin at 60 days - its window is 90");
ok(run({ registrations: [row("https://paid2.example", { last_routable_seen: NOW - 89 * DAY })], hasSettled: (o) => o === "https://paid2.example" }).length === 0,
  "released at 89 days an origin the ledger says has settled");
ok(run({ registrations: [row("https://paid3.example", { last_routable_seen: NOW - 91 * DAY, last_settled_seen: NOW - 100 * DAY })] }).join() === "https://paid3.example",
  "a settled origin dark for 91 days was not released");
ok(run({ registrations: [row("https://paid4.example", { last_routable_seen: NOW - 91 * DAY })], hasSettled: () => true, settledMaxIdleMs: 365 * DAY }).length === 0,
  "the settled window is the caller's (365 days here)");
// The windows from the variables: the settled one is never shorter than the
// plain one, and a zero, negative or unreadable value reads as the default
// (a zero window would release every live seller).
{
  const { execFileSync } = await import("node:child_process");
  const inChild = (env, rows) => execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { selectReleasableOrigins } = await import(${JSON.stringify(new URL("../src/x402-index.js", import.meta.url).href)});
    console.log(JSON.stringify(selectReleasableOrigins({ registrations: ${JSON.stringify(rows)}, isSubmitted: () => true, cycleOkFraction: 1, now: ${NOW} })));
  `], { env: { ...process.env, ...env, MEMORY_DB_FILE: process.env.MEMORY_DB_FILE || "/tmp/claude-501/mem-release-child.db" }, encoding: "utf8", timeout: 60_000 }).trim().split("\n").pop();
  const settled95 = [row("https://paid.example", { last_routable_seen: NOW - 95 * DAY, last_settled_seen: NOW - 100 * DAY })];
  const settled60 = [row("https://paid.example", { last_routable_seen: NOW - 60 * DAY, last_settled_seen: NOW - 70 * DAY })];
  const plain10 = [row("https://gone.example", { last_routable_seen: NOW - 10 * DAY })];
  ok(inChild({ INDEX_RELEASE_AFTER_DAYS: "100", INDEX_SETTLED_RELEASE_AFTER_DAYS: "90" }, settled95) === "[]", "a settled seller holds its slot at least the plain window when that is the longer one");
  ok(inChild({ INDEX_SETTLED_RELEASE_AFTER_DAYS: "0" }, settled60) === "[]" && inChild({ INDEX_SETTLED_RELEASE_AFTER_DAYS: "abc" }, settled60) === "[]" && inChild({ INDEX_SETTLED_RELEASE_AFTER_DAYS: "-5" }, settled60) === "[]", "a zero, unreadable or negative settled window reads as the default");
  ok(inChild({ INDEX_RELEASE_AFTER_DAYS: "0" }, plain10) === "[]" && inChild({ INDEX_RELEASE_AFTER_DAYS: "7" }, plain10) === JSON.stringify(["https://gone.example"]), "a zero plain window reads as the default; a real one is honored");
}
// The ceiling: 4,000 slots unless the variable says otherwise, a quarter of
// them for quick tunnels.
{
  const { submissionSlotStatus, __testSetSubmittedCap } = await import("../src/x402-index.js");
  __testSetSubmittedCap();
  const s = submissionSlotStatus();
  ok(s.cap === 4000 && s.tunnelCap === 1000, `the default submission ceiling is 4,000 with 1,000 tunnel slots (${s.cap}, ${s.tunnelCap})`);
}

// Not ours to release: a registry-discovered or operator-seeded origin holds no
// submission slot, so releasing one would just delete a listing for nothing.
ok(run({ registrations: [row("https://discovered.example", { last_routable_seen: NOW - 400 * DAY })], isSubmitted: () => false }).length === 0,
  "released an origin that holds no submission slot");

// --- the outage guard, which is the whole safety story ----------------------
// Every seller looks dead when the failure is OURS. A blocked egress IP or a
// bad deploy would otherwise release the entire list in a single pass.
const allDead = [
  row("https://a.example", { last_routable_seen: NOW - 90 * DAY }),
  row("https://b.example", { last_routable_seen: NOW - 90 * DAY }),
];
ok(run({ registrations: allDead, cycleOkFraction: 0.2 }).length === 0,
  "released during a cycle where 80% of crawls failed - that is our outage, not theirs");
ok(run({ registrations: allDead, cycleOkFraction: 0 }).length === 0,
  "released during a cycle where everything failed");
ok(run({ registrations: allDead, cycleOkFraction: null }).length === 0,
  "released on an UNKNOWN cycle health - must fail closed");
ok(run({ registrations: allDead, cycleOkFraction: undefined }).length === 0,
  "released when cycle health was not supplied at all");
ok(run({ registrations: allDead, cycleOkFraction: NaN }).length === 0,
  "NaN cycle health passed the guard - comparison must reject it, not invert");
ok(run({ registrations: allDead, cycleOkFraction: 0.5 }).length === 2,
  "a healthy-enough cycle (exactly at the floor) released nothing");

// --- rows that should not crash or be immortal ------------------------------
ok(run({ registrations: [{ origin: "https://norec.example", first_seen: NOW - 400 * DAY, last_routable_seen: null }] })
  .join() === "https://norec.example",
  "a row with no last_routable_seen was immortal - it must fall back to first_seen");
ok(run({ registrations: [{ origin: "https://blank.example" }] }).length === 0,
  "a row with no timestamps at all was released on a guess");
ok(run({ registrations: [null, undefined, {}, { origin: 42 }, row("https://ok.example")] }).length === 0,
  "malformed rows were not skipped safely");
ok(run({ registrations: [] }).length === 0, "empty input produced releases");

// --- the window is configurable and actually read ---------------------------
ok(run({ registrations: [row("https://x.example", { last_routable_seen: NOW - 10 * DAY })], maxIdleMs: 5 * DAY })
  .join() === "https://x.example", "maxIdleMs was ignored");

// --- what counts as evidence that the failure is OURS ----------------------
// cycleOkFraction answers exactly one question, and only outcomes that could
// indicate our own breakage may vote on it.
const cache = new Map([
  ["ok1", {}],
  ["ok2", {}],
  ["down", { error: "timeout" }],
  ["blocked", { robotsBlocked: true, error: "robots.txt disallows" }],
]);
const look = (o) => cache.get(o);
ok(cycleOkFraction(["ok1", "ok2", "down"], look) === 2 / 3, "plain success/failure ratio is wrong");

// A seller excluding us in robots.txt is a deliberate choice this module
// already refuses to file under our outage count. Counting it as a failure
// drags the fraction down and blocks releases that should proceed.
ok(cycleOkFraction(["ok1", "blocked"], look) === 1,
  "a robots-blocked seller was scored as our failure");
ok(cycleOkFraction(["down", "blocked"], look) === 0,
  "a robots-blocked seller was scored as a success");
ok(cycleOkFraction(["blocked"], look) === null,
  "a cycle of nothing but robots-blocked sellers reported a health number instead of null");

// An origin never reached this cycle (budgeted probe, abort) is not a vote
// either - scoring absence as failure would block releases after a quiet pass.
ok(cycleOkFraction(["ok1", "never-visited"], look) === 1, "an unvisited origin was scored");
ok(cycleOkFraction([], look) === null, "an empty cycle reported a health number");

// The two compose: an all-robots-blocked cycle yields null, which the release
// policy must treat as unknown and release nothing.
ok(selectReleasableOrigins({
  now: NOW, isSubmitted: () => true, hasSettled: () => false,
  registrations: [row("https://gone.example", { last_routable_seen: NOW - 90 * DAY })],
  cycleOkFraction: cycleOkFraction(["blocked"], look),
}).length === 0, "a cycle with no scoreable outcomes released anyway");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
