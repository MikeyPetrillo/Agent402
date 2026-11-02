#!/usr/bin/env node
// Every store deadline of the withLoopTimeout shape counts loop time, offline.
//
// scripts/test-loop-deadline.js pins the helper (src/loop-deadline.js) and its
// first three users. This suite drives each other site through its own module:
// the command is sent, the answer is a threadpool read that completes while
// synchronous work holds the loop past the site's deadline, and the site must
// take that answer instead of booking a store that did not answer:
//   - the hang-up forgiveness ticket reserve (src/hangup-forgiveness.js),
//   - the per-payer unsettled spend reserve (src/external-spend-guard.js),
//   - a ledger journal command (src/ledger-journal-redis.js),
//   - the Redis persistence read (src/redis-persistence.js),
//   - an idempotency store read (src/idempotency-store.js),
//   - the first-call allowance's day read (src/first-call-allowance.js),
//   - the Nominatim shared slot (src/tools/nominatim-pace.js),
//   - a database status ping (src/db-status.js).
// Each one also still times out on a store that never answers.
//   node scripts/test-loop-deadline-sites.js
import { writeFileSync, mkdtempSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The shared controls read their mode at import: Redis mode, with the client
// injected below (nothing connects). Short deadlines keep the holds short.
const dir = mkdtempSync(join(tmpdir(), "loop-deadline-sites-"));
process.env.REDIS_URL = "redis://127.0.0.1:1/0";
delete process.env.SHARED_LIMITS;
delete process.env.STATE_DATABASE_URL;
process.env.SHARED_LIMITS_OP_MS = "200";
process.env.LEDGER_JOURNAL_REDIS_OP_MS = "200";
process.env.REDIS_PERSISTENCE_OP_MS = "200";
process.env.NOMINATIM_SHARED_DEADLINE_MS = "200";
process.env.HANGUP_FORGIVE_FILE = join(dir, "hangup.json");
process.env.WALLET_DAILY_LEDGER_FILE = join(dir, "wallet-daily.json");
process.env.FIRST_CALL_ALLOWANCE = "on";

const { __setTestClient } = await import("../src/shared-limit.js");
const { reserveHangupForgiveness } = await import("../src/hangup-forgiveness.js");
const { reserveSpend } = await import("../src/external-spend-guard.js");
const { createRedisJournal, __setJournalRedisForTest } = await import("../src/ledger-journal-redis.js");
const { createPersistenceMonitor } = await import("../src/redis-persistence.js");
const { createIdempotencyStore, createLocalIdempotencyStore } = await import("../src/idempotency-store.js");
const { firstCallAllowanceStatus, firstCallAllowanceConfig } = await import("../src/first-call-allowance.js");
const { nominatimSlot, nominatimPaceCounts, _resetNominatimPace } = await import("../src/tools/nominatim-pace.js");
const { databasesStatus, resetDatabasesStatusCache } = await import("../src/db-status.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const keepAlive = setInterval(() => {}, 1000);
const checkPhase = () => new Promise((r) => setImmediate(r));
const inFlight = async () => { for (let i = 0; i < 40; i++) await null; };
const spin = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* the loop is held */ } };

const file = join(dir, "answer");
writeFileSync(file, "x".repeat(64));
const fh = await open(file, "r");
// One threadpool request, issued now: its completion is read in a poll phase.
const answerSoon = (value) => fh.read(Buffer.alloc(8), 0, 8, 0).then(() => value);
const hung = () => new Promise(() => {});

// The shared controls report a missed answer once a minute per control on
// console.warn: capture the lines, so "the store did not answer" is visible.
const warns = [];
const realWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(" ")); };
const timedOutWarn = (control) => warns.some((w) => w.includes(control) && /timed out/.test(w));

// Hold the loop past the deadline once the call has sent its command.
async function held(call, holdMs = 500) {
  await checkPhase();
  const p = call();
  await inFlight();
  spin(holdMs);
  return p;
}

// 1. Hang-up forgiveness: the shared ticket reserve.
{
  const evals = [];
  __setTestClient({ eval: (script) => { evals.push(script); return answerSoon([1, 0]); } });
  const req = {};
  const t = await held(() => reserveHangupForgiveness(req, { keys: ["ip:198.51.100.7"], priceUsd: 0.01, slug: "loop-deadline-probe" }));
  ok(t.granted === true && evals.length >= 1, `hang-up ticket: an answer that landed while the loop was held grants (${t.state}/${t.reason})`);
  ok(!timedOutWarn("hangup-forgiveness"), "hang-up ticket: the store is not booked as one that did not answer");
}
{
  warns.length = 0;
  __setTestClient({ eval: hung, sendCommand: hung });
  const t0 = performance.now();
  await Promise.race([reserveHangupForgiveness({}, { keys: ["ip:198.51.100.8"], priceUsd: 0.01, slug: "loop-deadline-probe" }), new Promise((r) => setTimeout(r, 3000))]);
  ok(timedOutWarn("hangup-forgiveness") && performance.now() - t0 < 3000, "hang-up ticket: a store that never answers still times out");
}
// 2. External spend guard: the per-payer shared reserve.
{
  warns.length = 0;
  const evals = [];
  __setTestClient({ eval: (script) => { evals.push(script); return answerSoon([1, 0]); } });
  const d = await held(() => reserveSpend("0x" + "a".repeat(40), 0.01, { chain: "base" }));
  ok(d?.ok === true && evals.length >= 1, `spend reserve: an answer that landed while the loop was held reserves (${JSON.stringify(d?.ok)})`);
  ok(!timedOutWarn("external-spend"), "spend reserve: the store is not booked as one that did not answer");
}
{
  warns.length = 0;
  __setTestClient({ eval: hung });
  await Promise.race([reserveSpend("0x" + "b".repeat(40), 0.01, { chain: "base" }), new Promise((r) => setTimeout(r, 3000))]);
  ok(timedOutWarn("external-spend"), "spend reserve: a store that never answers still times out");
}
__setTestClient(null);
// 3. Ledger journal: a command answered during a hold does not open the down window.
{
  const j = createRedisJournal({ key: "loop-deadline-probe", redis: async () => ({ eval: () => answerSoon(7), unref() {} }) });
  const r = await held(() => j.renew(["1"]).catch((e) => e));
  ok(r === 7 && !j.down(), `journal: an answer that landed while the loop was held is read (${r?.message || r}, down ${j.down()})`);
  const j2 = createRedisJournal({ key: "loop-deadline-probe-2", redis: async () => ({ eval: hung, unref() {} }) });
  const e = await j2.renew(["1"]).catch((x) => x);
  ok(/timed out/.test(String(e?.message)) && j2.down(), "journal: a command that never answers still times out and opens the down window");
  __setJournalRedisForTest(null);
}
// 4. Redis persistence: the INFO read.
{
  const INFO = ["# Persistence", "loading:0", "aof_enabled:1", "aof_rewrite_in_progress:0", "aof_last_bgrewrite_status:ok", "aof_last_write_status:ok", "rdb_bgsave_in_progress:0", "rdb_last_bgsave_status:ok", "rdb_changes_since_last_save:0", "rdb_last_save_time:1760000000"].join("\r\n");
  const m = createPersistenceMonitor({ redis: async () => ({ info: () => answerSoon(INFO) }), enabled: () => true, log: { error() {}, warn() {}, log() {} } });
  const w = await held(() => m.check());
  ok(w === "on", `persistence: an INFO answer that landed while the loop was held reads "on" (${w})`);
  const m2 = createPersistenceMonitor({ redis: async () => ({ info: hung }), enabled: () => true, log: { error() {}, warn() {}, log() {} } });
  ok((await m2.check()) === "unknown", "persistence: a read that never answers still times out");
}
// 5. Idempotency store: a cross-container answer read during a hold replays.
{
  const body = { status: 200, body: "stored" };
  const s = createIdempotencyStore({ redis: async () => ({ get: () => answerSoon(JSON.stringify(body)) }), local: createLocalIdempotencyStore(), opTimeoutMs: 200 });
  const got = await held(() => s.get("k1"));
  ok(got?.body === "stored", `idempotency: an answer that landed while the loop was held replays (${JSON.stringify(got)})`);
  const s2 = createIdempotencyStore({ redis: async () => ({ get: hung }), local: createLocalIdempotencyStore(), opTimeoutMs: 100 });
  ok((await s2.get("k2")) == null, "idempotency: a read that never answers falls through to the local store");
}
// 6. First-call allowance: the day read.
if (firstCallAllowanceConfig().enabled) {
  __setTestClient({ get: (k) => answerSoon(/fca-n/.test(k) ? "3" : "1000") });
  const st = await held(() => firstCallAllowanceStatus());
  ok(st.status !== "unavailable" && st.today?.grants === 3, `first-call allowance: a day read answered during a hold is read (${st.status})`);
  __setTestClient({ get: hung });
  const st2 = await firstCallAllowanceStatus();
  ok(st2.status === "unavailable", "first-call allowance: a day read that never answers still reads unavailable");
  __setTestClient(null);
} else {
  ok(false, "first-call allowance: FIRST_CALL_ALLOWANCE=on did not enable it, so its read is not exercised");
}
// 7. Nominatim: the shared slot.
{
  _resetNominatimPace();
  __setTestClient({ set: () => answerSoon("OK"), pTTL: () => answerSoon(0) });
  const got = await held(() => nominatimSlot());
  ok(got === true && nominatimPaceCounts().shared === 1, `nominatim: a slot granted during a hold is the shared slot (${JSON.stringify(nominatimPaceCounts())})`);
  __setTestClient(null);
}
// 8. Database status: a ping answered during a stall reads ok.
{
  resetDatabasesStatusCache();
  const v = await held(() => databasesStatus({ pings: { leads: () => answerSoon(true), analytics: () => answerSoon(null) }, timeoutMs: 200, log: () => {} }));
  ok(v.leads.status === "ok" && v.analytics.status === "unconfigured", `database status: a ping answered while the loop was held reads ok (${v.leads.status})`);
  resetDatabasesStatusCache();
  const v2 = await databasesStatus({ pings: { leads: hung, analytics: () => null }, timeoutMs: 100, log: () => {} });
  ok(v2.leads.status === "unreachable", `database status: a ping that never answers still reads unreachable (${v2.leads.status})`);
}

console.warn = realWarn;
await fh.close();
clearInterval(keepAlive);
console.log(`\ntest-loop-deadline-sites: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
