// The journal's persistence gate against a REAL Redis
// (src/ledger-journal-redis.js, src/redis-persistence.js): with append-only
// off, a money journal entry lands on the container's local disk and the
// dead-letter word reads local; once append-only is on, the next entry lands
// in Redis and the word reads pending. INFO persistence is read through the
// real client, so the parse is proven on what Redis answers, not a fixture.
// Requires REDIS_URL (under CI a missing one fails); the test switches that
// Redis's appendonly with CONFIG SET and puts it back as it found it.
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createClient } from "redis";

const URL = String(process.env.REDIS_URL || "").trim();
if (!URL) {
  const msg = "test-ledger-journal-persistence-gate: no REDIS_URL; start a local Redis (redis-server --port 26379 --save '' --appendonly yes) and export REDIS_URL=redis://127.0.0.1:26379";
  if (process.env.CI) { console.error(`FAIL - ${msg} (a missing Redis is a failure under CI)`); process.exit(1); }
  console.log(`SKIP - ${msg}`); process.exit(0);
}
process.env.LEDGER_JOURNAL_REDIS = "on";
process.env.LEDGER_JOURNAL_PERSISTENCE_WAIT_MS = "400";
process.env.REDIS_PERSISTENCE_RETRY_MS = "100";
const rp = await import("../src/redis-persistence.js");
const jr = await import("../src/ledger-journal-redis.js");
const { createDeadLetter, ledgerDeadLetterStatus, deadLetterWord } = await import("../src/ledger-mirror.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const keepAlive = setInterval(() => {}, 1000);

const admin = createClient({ url: URL }); admin.on("error", () => {}); await admin.connect();
const wasAppendonly = (await admin.configGet("appendonly")).appendonly;
const setAof = async (v) => { await admin.configSet("appendonly", v); await wait(200); };
const logs = [];
const log = { log: (m) => logs.push(`log ${m}`), warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) };
// The journal's client: a fresh connection, handed to the journal and the persistence read alike.
let jc = null;
jr.__setJournalRedisForTest(async () => { if (jc?.isReady) return jc; const c = createClient({ url: URL }); c.on("error", () => {}); await c.connect(); jc = c; return c; });
jr.__resetJournalGateForTest({ log });
const key = `gate-${randomBytes(4).toString("hex")}`;
const items = `a402:journal:{${key}}:items`;
const file = join(mkdtempSync(join(tmpdir(), "jr-gate-")), "j.ndjson");

try {
  // ---- append-only OFF ----
  await setAof("no");
  const dl = createDeadLetter({ file, name: "sales", journalKey: key });
  ok(dl.kind === "redis", "the dead-letter is the shared one (REDIS_URL and the switch)");
  let g = await jr.awaitJournalRedisGate({ timeoutMs: 3000 });
  ok(g.word === "off" && !g.open && g.reason === "persistence_off", `INFO persistence through the real client reads off (${JSON.stringify(g)})`);
  const f = rp.redisPersistenceStatus({ full: true });
  ok(f.status === "off" && f.fields?.aofEnabled === 0 && f.fields?.appendonly === false && typeof f.fields?.aofLastWriteStatus === "string" && typeof f.readAt === "string", `the operator view carries the parsed fields (${JSON.stringify(f.fields)})`);
  ok(JSON.stringify(rp.redisPersistenceStatus()) === '{"status":"off"}', "the public view is the word");
  const a = await dl.addAsync("sale", { tx: "0xgate-1" }, { pending: false });
  ok(a.where === "local" && existsSync(file) && readFileSync(file, "utf8").includes("0xgate-1"), `with append-only off the entry lands on local disk (${a.where})`);
  ok(Number(await admin.hLen(items)) === 0, "...and nothing in Redis");
  ok(deadLetterWord([dl.state()]) === "local", `the dead-letter word reads local (${deadLetterWord([dl.state()])})`);
  const full = ledgerDeadLetterStatus({ full: true });
  ok(full.status === "local" && full.journalRedis?.configured === true && full.journalRedis?.backend === "local-disk" && full.journalRedis?.reason === "persistence_off" && full.journalRedis?.persistence === "off", `the operator view names why (${JSON.stringify(full.journalRedis)})`);
  ok(Object.keys(ledgerDeadLetterStatus()).join() === "status", "the public view is the word alone");
  ok(logs.length === 1 && /^warn \[ledger-journal\] journal entries stay on local disk: redis persistence reads off/.test(logs[0]), `one log line names why (${logs[0]})`);

  // ---- append-only ON ----
  await setAof("yes");
  g = await jr.awaitJournalRedisGate({ timeoutMs: 3000 });
  ok(g.word === "on" && g.open, `after CONFIG SET appendonly yes the read says on and the gate opens (${JSON.stringify(g)})`);
  ok(logs.length === 2 && /^log \[ledger-journal\] redis persistence reads on; journal entries go to Redis/.test(logs[1]), `one line when it clears (${logs[1]})`);
  const b = await dl.addAsync("sale", { tx: "0xgate-2" }, { pending: false });
  ok(b.where === "redis" && Number(await admin.hLen(items)) === 1 && !readFileSync(file, "utf8").includes("0xgate-2"), `the next entry lands in Redis, not on disk (${b.where})`);
  await dl.refresh();
  ok(ledgerDeadLetterStatus({ full: true }).journalRedis?.backend === "redis" && ledgerDeadLetterStatus({ full: true }).journalRedis?.reason === null, "the operator view says redis");
  // The disk entry is still there (the replay lands it), so the word stays local until it does; a journal with only the Redis entry reads pending.
  await dl.remove(a.id);
  ok(deadLetterWord([dl.state()]) === "pending", `with the disk entry landed the word reads pending for the Redis one (${deadLetterWord([dl.state()])})`);
  const rf = rp.redisPersistenceStatus({ full: true });
  ok(rf.status === "on" && rf.fields?.aofEnabled === 1 && rf.fields?.aofLastWriteStatus === "ok" && rf.fields?.aofLastBgrewriteStatus === "ok", `on: aof_enabled 1 and both statuses ok (${JSON.stringify(rf.fields)})`);

  // ---- off again: Redis keeps the entry it has; new ones go to disk ----
  await setAof("no");
  await rp.redisPersistenceMonitor().check();
  ok(!jr.journalRedisGate().open, "off again: the gate closes");
  const claimed = await dl.claim();
  ok(claimed.some((e) => e.id === b.id), "an entry already in Redis is still claimed while the gate is closed");
  await dl.endClaim();
  const c = await dl.addAsync("sale", { tx: "0xgate-3" }, { pending: false });
  ok(c.where === "local" && Number(await admin.hLen(items)) === 1, "a new entry goes to disk");
  ok(logs.length === 3 && /reads off/.test(logs[2]), "and one more line");
} finally {
  await admin.configSet("appendonly", wasAppendonly).catch(() => {});
  const p = `a402:journal:{${key}}`;
  await admin.del(["items", "seq", "lease", "owner", "pend", "drain", "n"].map((s) => `${p}:${s}`)).catch(() => {});
  rp.redisPersistenceMonitor().stop();
  await admin.quit().catch(() => {});
  await jc?.quit().catch(() => {});
  clearInterval(keepAlive);
}
console.log(`\ntest-ledger-journal-persistence-gate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
