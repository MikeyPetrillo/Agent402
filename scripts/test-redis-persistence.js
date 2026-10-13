// Redis persistence as one word (src/redis-persistence.js) and the journal
// gate it drives (src/ledger-journal-redis.js), offline with a stub client:
//   - INFO persistence text reads on / off / degraded; garbage reads unknown;
//   - the monitor reads nothing before start, retries while unknown, keeps the
//     last parsed fields through a failed read, times out a hung read, and
//     publishes one word (the fields only on the operator view);
//   - a journal add goes to Redis only while the word is on: off, degraded and
//     an unread state past the wait hold it on local disk (the shared
//     dead-letter's fallback), with one log line per change and none for the
//     first unread window; claims and removals are never held;
//   - the heartbeat leg and the status Worker page on off and degraded.
// The same gate against a REAL Redis, with append-only off and then on, is
// scripts/test-ledger-journal-persistence-gate.js.
import "./lib/file-mode.js";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.REDIS_PERSISTENCE_FIRST_MS = "20";
process.env.REDIS_PERSISTENCE_RETRY_MS = "100";
process.env.REDIS_PERSISTENCE_CHECK_MS = "1000";
process.env.REDIS_PERSISTENCE_OP_MS = "150";
process.env.LEDGER_JOURNAL_PERSISTENCE_WAIT_MS = "300";

const rp = await import("../src/redis-persistence.js");
const jr = await import("../src/ledger-journal-redis.js");
const { createDeadLetter, deadLetterWord } = await import("../src/ledger-mirror.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The monitor's timers never hold a process open on their own (a server is held by its listener); this test is held here.
const keepAlive = setInterval(() => {}, 1000);

// INFO persistence as Redis 7/8 answers it (the lines this module reads and the ones around them).
const INFO_ON = [
  "# Persistence", "loading:0", "async_loading:0", "rdb_changes_since_last_save:12", "rdb_bgsave_in_progress:0",
  "rdb_last_save_time:1760000000", "rdb_last_bgsave_status:ok", "aof_enabled:1", "aof_rewrite_in_progress:0",
  "aof_rewrite_scheduled:0", "aof_last_bgrewrite_status:ok", "aof_last_write_status:ok", "aof_last_cow_size:0", "",
].join("\r\n");
const INFO_OFF = INFO_ON.replace("aof_enabled:1", "aof_enabled:0");
const INFO_WRITE_ERR = INFO_ON.replace("aof_last_write_status:ok", "aof_last_write_status:err");
const INFO_REWRITE_ERR = INFO_ON.replace("aof_last_bgrewrite_status:ok", "aof_last_bgrewrite_status:err");

// ---- the parser and the word --------------------------------------------------
{
  const f = rp.parsePersistenceInfo(INFO_ON);
  ok(f && f.aofEnabled === 1 && f.appendonly === true && f.aofLastWriteStatus === "ok" && f.aofLastBgrewriteStatus === "ok" && f.rdbChangesSinceLastSave === 12 && f.rdbLastSaveTime === 1760000000 && f.aofRewriteInProgress === 0, `the fields are read from CRLF INFO text (${JSON.stringify(f)})`);
  ok(rp.persistenceWord(f) === "on", "aof on, last write ok, last rewrite ok: on");
  ok(rp.persistenceWord(rp.parsePersistenceInfo(INFO_OFF)) === "off" && rp.parsePersistenceInfo(INFO_OFF).appendonly === false, "aof_enabled:0: off");
  ok(rp.persistenceWord(rp.parsePersistenceInfo(INFO_WRITE_ERR)) === "degraded", "aof on with a failed last write: degraded");
  ok(rp.persistenceWord(rp.parsePersistenceInfo(INFO_REWRITE_ERR)) === "degraded", "aof on with a failed last rewrite: degraded");
  ok(rp.persistenceWord(rp.parsePersistenceInfo(INFO_ON.replace("aof_last_bgrewrite_status:ok\r\n", ""))) === "degraded", "aof on with the rewrite status missing: degraded, never on");
  ok(rp.parsePersistenceInfo("garbage\r\nnot:info") === null && rp.persistenceWord(null) === "unknown", "text without aof_enabled is not an answer: unknown");
  ok(rp.parsePersistenceInfo("") === null && rp.parsePersistenceInfo(undefined) === null && rp.parsePersistenceInfo({ aof_enabled: 1 }) === null, "empty, missing and non-string answers: unknown");
  ok(rp.persistenceWord(rp.parsePersistenceInfo(INFO_ON.replace("aof_enabled:1", "aof_enabled:yes"))) === "unknown", "a non-numeric aof_enabled: unknown");
  ok(rp.persistenceWord(rp.parsePersistenceInfo(INFO_ON.replace(/\r\n/g, "\n"))) === "on", "LF-only text reads the same");
}

// ---- the monitor, with a stub client --------------------------------------------
{
  let text = INFO_ON;
  let infoCalls = 0;
  let hang = false;
  let fails = false;
  let now = 1_760_000_500_000; // 500 s after the fixture's rdb_last_save_time
  const stub = { info: async (section) => { infoCalls++; if (section !== "persistence") throw new Error(`section ${section}`); if (hang) return new Promise(() => {}); if (fails) throw new Error("ECONNRESET"); return text; } };
  let clientNull = false;
  const changes = [];
  const m = rp.createPersistenceMonitor({ redis: async () => (clientNull ? null : stub), enabled: () => true, now: () => now });
  m.onChange((w, prev) => changes.push(`${prev}>${w}`));
  ok(JSON.stringify(m.status()) === JSON.stringify({ status: "unknown" }) && m.status({ full: true }).reason === "not_read" && infoCalls === 0, "before start: unknown, not read, nothing asked of Redis");
  m.start();
  ok(infoCalls === 0, "start schedules the first read; it does not run on the caller's stack");
  await m.firstRead();
  ok(infoCalls === 1 && m.word() === "on" && changes.join() === "unknown>on", `the first read ran shortly after start and read on (${changes.join()})`);
  const full = m.status({ full: true });
  ok(full.status === "on" && full.reason === null && full.fields?.aofEnabled === 1 && full.fields?.appendonly === true && typeof full.readAt === "string" && full.fields?.rdbLastSaveAgeSeconds === 500 && full.fields?.rdbChangesSinceLastSave === 12, `the operator view carries the fields and the read time (${JSON.stringify(full)})`);
  ok(Object.keys(m.status()).join() === "status", "the public view is the word alone");
  text = INFO_OFF;
  await m.check();
  ok(m.word() === "off" && changes.at(-1) === "on>off" && m.status({ full: true }).fields.appendonly === false, "a read of aof_enabled:0: off, one change");
  text = INFO_WRITE_ERR;
  await m.check();
  ok(m.word() === "degraded" && changes.at(-1) === "off>degraded", "a failed last write: degraded");
  await m.check();
  ok(changes.length === 3, "a read with the same word is not a change");
  fails = true;
  await m.check();
  let s = m.status({ full: true });
  ok(m.word() === "unknown" && s.reason === "read_failed" && s.failure === "read_failed" && typeof s.failedAt === "string" && s.fields?.aofLastWriteStatus === "err" && s.status === "unknown", `a failed read: unknown, the last parsed fields kept for the operator (${s.reason}, ${s.fields?.aofLastWriteStatus})`);
  fails = false; hang = true;
  const t0 = Date.now();
  await m.check();
  ok(m.word() === "unknown" && m.status({ full: true }).failure === "timeout" && Date.now() - t0 < 1000, `a hung read: unknown after the bounded timeout (${Date.now() - t0} ms, ${m.status({ full: true }).failure})`);
  hang = false; clientNull = true;
  await m.check();
  ok(m.word() === "unknown" && m.status({ full: true }).reason === "unreachable", "no client (not connected, cooling down): unknown, unreachable");
  clientNull = false; text = INFO_ON;
  const n0 = infoCalls;
  await wait(260);
  ok(infoCalls > n0 && m.word() === "on", `while unknown the monitor retries on REDIS_PERSISTENCE_RETRY_MS, and the next good read returns on (${infoCalls - n0} reads in 260 ms)`);
  const n1 = infoCalls;
  await wait(400);
  ok(infoCalls === n1, "once a word is read the timer is REDIS_PERSISTENCE_CHECK_MS, not the retry");
  const p1 = m.check(), p2 = m.check();
  ok(p1 === p2, "one read in flight at a time");
  await p1;
  m.stop();
  const n2 = infoCalls;
  await wait(250);
  ok(infoCalls === n2, "stop ends the timer");
}
{
  const m = rp.createPersistenceMonitor({ redis: async () => { throw new Error("never asked"); }, enabled: () => false });
  m.start();
  await m.firstRead();
  ok(m.word() === "unknown" && m.status({ full: true }).reason === "no_redis_url" && JSON.stringify(m.status()) === '{"status":"unknown"}', "without REDIS_URL: unknown, no_redis_url, nothing scheduled");
  m.stop();
}

// ---- the gate on a journal, with a stub client -----------------------------------
// The stub answers the Lua scripts by shape: STATE reads HLEN, everything else
// is a write that answers 1; the ADD calls are counted.
{
  const logs = [];
  const log = { log: (m) => logs.push(`log ${m}`), warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) };
  let text = INFO_OFF;
  let fails = false;
  const evals = [];
  const stub = {
    info: async () => { if (fails) throw new Error("ECONNRESET"); return text; },
    eval: async (script, { arguments: args }) => { evals.push(script.includes("HLEN") ? "STATE" : script.includes("ZRANGEBYSCORE") ? "CLAIM" : script.includes("HSET', KEYS[1]") ? "ADD" : script.includes("HDEL', KEYS[1]") ? "REMOVE" : "OTHER"); return script.includes("HLEN") ? [0, 0, ""] : 1; },
    hGetAll: async () => ({}), zRange: async () => [],
  };
  process.env.REDIS_URL = "redis://127.0.0.1:1";
  process.env.LEDGER_JOURNAL_REDIS = "on";
  rp.__resetRedisPersistenceForTest();
  jr.__resetJournalGateForTest({ log });
  jr.__setJournalRedisForTest(async () => stub);
  const J = jr.createRedisJournal({ key: "gate-stub", owner: "A" });
  const entry = (id) => ({ id, kind: "k", payload: { id }, at: Date.now() });
  const held = async (p) => { try { await p; return null; } catch (e) { return String(e.message); } };
  let g = jr.journalRedisGate();
  ok(!g.open && g.reason === "persistence_not_read" && g.word === "unknown", "before the first read: closed, persistence_not_read");
  ok(/held on local disk \(persistence_not_read\)/.test(await held(J.add(entry("1")))), "an add before the first read is refused to the caller (it goes to local disk), nothing asked of Redis");
  ok(evals.length === 0 && logs.length === 0, "...and nothing is logged for the first unread window");
  g = await jr.awaitJournalRedisGate({ timeoutMs: 1000 });
  ok(!g.open && g.reason === "persistence_off" && g.word === "off", `the first read says off: closed, persistence_off (${JSON.stringify(g)})`);
  ok(/held on local disk \(persistence_off\)/.test(await held(J.add(entry("1")))) && evals.length === 0, "an add while off is refused, nothing asked of Redis");
  ok(logs.length === 1 && /^warn \[ledger-journal\] journal entries stay on local disk: redis persistence reads off/.test(logs[0]) && /--appendonly yes/.test(logs[0]), `one line names why (${logs[0]})`);
  await J.claim(); await J.remove(["x"]); await J.state();
  ok(evals.join() === "CLAIM,REMOVE,STATE", `claims, removals and reads are never held (${evals.join()})`);
  evals.length = 0;
  await jr.awaitJournalRedisGate({ timeoutMs: 1000 });
  ok(logs.length === 1, "the same reason read again logs nothing more");
  text = INFO_WRITE_ERR;
  await rp.redisPersistenceMonitor().check();
  ok(jr.journalRedisGate().reason === "persistence_degraded" && logs.length === 2 && /reads degraded/.test(logs[1]), `degraded: still closed, one more line naming the new reason (${logs[1]})`);
  text = INFO_ON;
  await rp.redisPersistenceMonitor().check();
  g = jr.journalRedisGate();
  ok(g.open && g.reason === null && g.word === "on", "a read of on: open");
  ok(logs.length === 3 && /^log \[ledger-journal\] redis persistence reads on; journal entries go to Redis/.test(logs[2]), `one line when it clears (${logs[2]})`);
  ok((await held(J.add(entry("2")))) === null && evals.join() === "ADD", "an add while on reaches Redis");
  const st = jr.journalRedisGateStatus();
  ok(st.configured === true && st.backend === "redis" && st.open === true && st.reason === null && st.persistence === "on", `the operator status names the backend (${JSON.stringify(st)})`);
  // Unknown for longer than the wait: the read fails from here on, and the
  // first journal was made more than LEDGER_JOURNAL_PERSISTENCE_WAIT_MS ago.
  await wait(Number(process.env.LEDGER_JOURNAL_PERSISTENCE_WAIT_MS) + 50);
  fails = true;
  await rp.redisPersistenceMonitor().check();
  g = jr.journalRedisGate();
  ok(!g.open && g.reason === "persistence_unknown" && g.word === "unknown", `a failed read after the wait has passed: closed, persistence_unknown (${JSON.stringify(g)})`);
  await wait(50);
  ok(logs.length === 4 && /could not be read/.test(logs[3]), `...with one line (${logs[3]})`);
  ok(jr.journalRedisGateStatus().backend === "local-disk" && jr.journalRedisGateStatus().reason === "persistence_unknown", "the operator status says local-disk and why");
  fails = false;
  await rp.redisPersistenceMonitor().check();
  ok(jr.journalRedisGate().open && logs.length === 5 && /reads on/.test(logs[4]), "and the clear line again once it reads on");
  rp.redisPersistenceMonitor().stop();

  // The unread wait: a fresh gate whose read never answers is "not yet" until the wait passes, then unknown and logged once.
  logs.length = 0;
  rp.__resetRedisPersistenceForTest();
  jr.__resetJournalGateForTest({ log });
  jr.__setJournalRedisForTest(async () => ({ info: async () => { throw new Error("down"); }, eval: async () => 1 }));
  const K = jr.createRedisJournal({ key: "gate-unread", owner: "A" });
  await wait(120);
  ok(jr.journalRedisGate().reason === "persistence_not_read" && logs.length === 0, "a read that fails inside the wait: not_read, nothing logged yet");
  await wait(300);
  ok(jr.journalRedisGate().reason === "persistence_unknown" && logs.length === 1 && /could not be read/.test(logs[0]), `past LEDGER_JOURNAL_PERSISTENCE_WAIT_MS: persistence_unknown and one line (${logs[0]})`);
  ok(/held on local disk \(persistence_unknown\)/.test(await held(K.add(entry("3")))), "an add is still refused to local disk");
  rp.redisPersistenceMonitor().stop();

  // Through the shared dead-letter (createDeadLetter with the Redis journal configured): the fallback is local disk, and the word reads local.
  logs.length = 0; evals.length = 0; text = INFO_OFF;
  rp.__resetRedisPersistenceForTest();
  jr.__resetJournalGateForTest({ log });
  jr.__setJournalRedisForTest(async () => stub);
  const file = join(mkdtempSync(join(tmpdir(), "rp-gate-")), "j.ndjson");
  const dl = createDeadLetter({ file, name: "gateTest", journalKey: "gate-dl" });
  ok(dl.kind === "redis", "the dead-letter is the shared one (the switch is on)");
  await jr.awaitJournalRedisGate({ timeoutMs: 1000 });
  const a = await dl.addAsync("sale", { n: 1 }, { pending: false });
  ok(a.where === "local" && String(a.id).startsWith("L:") && existsSync(file) && readFileSync(file, "utf8").includes('"n":1') && !evals.includes("ADD"), `with persistence off the entry lands on local disk, not in Redis (${a.where})`);
  ok(deadLetterWord([dl.state()]) === "local" && dl.state().local === 1, `the dead-letter word reads local for it (${deadLetterWord([dl.state()])})`);
  text = INFO_ON;
  await rp.redisPersistenceMonitor().check();
  const b = await dl.addAsync("sale", { n: 2 }, { pending: false });
  ok(b.where === "redis" && evals.includes("ADD") && !readFileSync(file, "utf8").includes('"n":2'), `once it reads on the next entry goes to Redis (${b.where})`);
  rp.redisPersistenceMonitor().stop();
  jr.__setJournalRedisForTest(null);
  delete process.env.REDIS_URL; delete process.env.LEDGER_JOURNAL_REDIS;
}

// ---- the observers --------------------------------------------------------------
{
  const hb = readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
  const start = hb.indexOf("- name: Redis persistence check");
  const step = start < 0 ? "" : hb.slice(start, hb.indexOf("- name:", start + 10));
  ok(step.length > 0, "heartbeat.yml has the Redis persistence step");
  ok(/\.redisPersistence\.status/.test(step) && /if \[ "\$WORD" = "off" \] \|\| \[ "\$WORD" = "degraded" \]; then sleep 30; WORD=\$\(read_rp\); fi/.test(step), "it reads redisPersistence.status and confirms off or degraded on a second reading 30 s later");
  ok(/off\|degraded\)\s+if \[ -z "\$OPEN" \]; then\s+gh issue create/.test(step) && /on\)\s+if \[ -n "\$OPEN" \]; then\s+gh issue close/.test(step), "off and degraded open one issue; on closes it; unknown does neither");
  const body = (step.match(/--body "([^"]+)"/) || [])[1] || "";
  ok(/--appendonly yes --appendfsync everysec/.test(body) && /INFO persistence/.test(body) && /aof_last_write_status/.test(body) && /LEDGER_JOURNAL_REDIS/.test(body), "the body says what to check: the start command, INFO persistence, the journal switch");
  ok(!/\$\{?[A-Z_]*(KEY|TOKEN|SECRET|URL)\b/.test(body) && !/\d+ ?(s|ms|minutes|USD|\$)/.test(body.replace("30 s apart", "")), "and carries no number or secret");
  const { ALARMS, judge } = await import("../workers/status-probe/src/index.js");
  const T = "Redis append-only persistence is not on";
  ok(step.includes(`TITLE="${T}"`), "the heartbeat's title is the Worker's");
  const alarm = ALARMS.find((x) => x.title === T);
  ok(Boolean(alarm), "the status Worker has the alarm");
  ok(judge({ gateway: { redisPersistence: { status: "off" } } })[T] === "bad" && judge({ gateway: { redisPersistence: { status: "degraded" } } })[T] === "bad", "the Worker pages on off and degraded");
  ok(judge({ gateway: { redisPersistence: { status: "on" } } })[T] === "good", "on clears");
  ok(judge({ gateway: { redisPersistence: { status: "unknown" } } })[T] === "quiet" && judge({ gateway: {} })[T] === "quiet", "unknown and a build without the field do neither");
  ok(/redisPersistence\.status=degraded/.test(alarm.body({ gateway: { redisPersistence: { status: "degraded" } } })) && /redisPersistence\.status=off\./.test(alarm.body({ gateway: { redisPersistence: { status: "<b>x</b>" } } })), "the body echoes only a known word");
}

clearInterval(keepAlive);
console.log(`\ntest-redis-persistence: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
