#!/usr/bin/env node
// Persistent paid-upstream meter (daily_upstream_calls in stats.js).
//
// WHY: the in-memory Brave meter in search.js resets on every redeploy, so it
// can never reconcile a billing MONTH against the provider's dashboard - the
// whole point of the meter. The stats-DB series must therefore (1) bucket by
// UTC day, (2) split by caller, and (3) SURVIVE a process restart. Survival is
// the invariant that matters most, so it is proven with two separate child
// processes sharing one stats DB, not with in-process reads.
//
// Offline, no network. Uses a unique upstream name per run so the shared
// dev-machine /tmp stats DB cannot pollute the assertions.
import { spawnSync } from "node:child_process";
import { childJson } from "./lib/child-json.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const UP = `test-upstream-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
const run = (code) => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, FREE_MODE: "true" },
    encoding: "utf8",
    cwd: new URL("..", import.meta.url).pathname,
  });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  return childJson(r.stdout);
};

// Process 1: record 3 calls (2 same caller, 1 other), read back.
const first = run(`
  import { recordUpstreamCall, getDailyUpstreamCalls } from "./src/stats.js";
  recordUpstreamCall("${UP}", "search");
  recordUpstreamCall("${UP}", "search");
  recordUpstreamCall("${UP}", "answer");
  console.log(JSON.stringify(getDailyUpstreamCalls("${UP}")));
`);
const today = new Date().toISOString().slice(0, 10);
ok(Array.isArray(first) && first.length === 2, `two (day, caller) rows after 3 calls with 2 callers (got ${first.length})`);
ok(first.every((r) => r.day === today), `rows bucket to today's UTC day ${today}`);
const bySearch = first.find((r) => r.caller === "search");
const byAnswer = first.find((r) => r.caller === "answer");
ok(bySearch?.n === 2, `caller "search" counted twice (got ${bySearch?.n})`);
ok(byAnswer?.n === 1, `caller "answer" counted once (got ${byAnswer?.n})`);

// Process 2: a fresh process (= a redeploy) must see the same rows and be able
// to keep counting on top of them.
const second = run(`
  import { recordUpstreamCall, getDailyUpstreamCalls } from "./src/stats.js";
  recordUpstreamCall("${UP}", "search");
  console.log(JSON.stringify(getDailyUpstreamCalls("${UP}")));
`);
const searchAfter = second.find((r) => r.caller === "search");
ok(searchAfter?.n === 3, `RESTART SURVIVAL: a fresh process continues the count (got ${searchAfter?.n}, want 3) - the in-memory meter cannot do this`);

// Unknown upstream: empty array, never a throw.
const none = run(`
  import { getDailyUpstreamCalls } from "./src/stats.js";
  console.log(JSON.stringify(getDailyUpstreamCalls("never-recorded-${process.pid}")));
`);
ok(Array.isArray(none) && none.length === 0, "unknown upstream reads back as an empty series");

// Cleanup the unique test rows so repeated local runs stay tidy.
run(`
  import Database from "better-sqlite3";
  import { existsSync } from "node:fs";
  const db = new Database((existsSync("/data") ? "/data" : "/tmp") + "/agent402-stats.db");
  db.prepare("DELETE FROM daily_upstream_calls WHERE upstream = ?").run("${UP}");
  console.log(JSON.stringify({ cleaned: true }));
`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
