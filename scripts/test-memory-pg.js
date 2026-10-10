// Paid agent memory (src/tools/memory.js) on the state database: the SQLite
// file is imported once at the first boot with STATE_DATABASE_URL set, the
// audit hash chain survives the import and continues on Postgres, incr and
// cas are atomic under concurrent callers, the grants gate holds, and a
// second process sees every write. Requires STATE_DATABASE_URL (CI fails
// without it; locally it skips).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { requireTestPg } from "./lib/test-pg.js";

const { url: PG_URL, schema: SCHEMA } = requireTestPg({ label: "test-memory-pg" });
const DIR = mkdtempSync(join(tmpdir(), "memory-pg-"));
const DB_FILE = join(DIR, "agent402.db");
process.env.MEMORY_DB_FILE = DB_FILE;
const MOD_URL = pathToFileURL(join(process.cwd(), "src/tools/memory.js")).href;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const rejects = async (name, fn, code) => {
  try { await fn(); ok(false, `${name} (should reject)`); }
  catch (e) { ok(!code || e.statusCode === code, `${name} -> ${e.statusCode || "?"} ${String(e.message).slice(0, 60)}`); }
};
const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const C = "0x" + "c3".repeat(20);

// Verify a getLog() answer end to end: contiguous seq from `fromSeq`, each
// prevHash the previous hash, each hash recomputed from the row.
function chainOk(entries, { fromSeq = 1, prev = "" } = {}) {
  let seq = fromSeq;
  for (const e of entries) {
    if (e.seq !== seq || e.prevHash !== prev) return false;
    const h = createHash("sha256")
      .update(`${e.prevHash}|${e.seq}|${e.ts}|${e.actor}|${e.action}|${e.key ?? ""}|${e.data === null ? "" : JSON.stringify(e.data)}`)
      .digest("hex");
    if (h !== e.hash) return false;
    prev = e.hash; seq++;
  }
  return true;
}

// A child process running the module with the given env (file mode when
// STATE_DATABASE_URL is absent); prints one JSON line.
function child(script, env) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH || "", MEMORY_DB_FILE: DB_FILE, ...env },
    encoding: "utf8", timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`child exited ${r.status}: ${r.stderr.slice(0, 400)}`);
  const line = r.stdout.trim().split("\n").pop();
  return JSON.parse(line);
}

// ---- 1) seed a genuine SQLite file through the module's own file mode ------
const seeded = child(`
  const m = await import(${JSON.stringify(MOD_URL)});
  const A = ${JSON.stringify(A)}, B = ${JSON.stringify(B)};
  m.memoryPut(A, "k1", { v: 1 });
  m.memoryPut(A, "k2", "two", { ttlSeconds: 3600 });
  m.memoryIncr(A, "ctr", 4, A);
  m.grant(A, B, "read");
  await m.remember(A, "The deploy failed because the build ran out of memory.", { topic: "ops" });
  m.memoryPut(B, "own", "b");
  console.log(JSON.stringify({ backend: m.BACKEND, persistent: m.PERSISTENT, logA: m.getLog(A, A).entries.length }));
`, {});
ok(seeded.backend === "sqlite" && seeded.persistent === false && seeded.logA === 5, `file mode seeded the SQLite file (backend ${seeded.backend}, ${seeded.logA} log rows for A)`);

const src = new Database(DB_FILE, { readonly: true });
const sqliteCounts = Object.fromEntries(["kv", "grants", "memlog", "docs"].map((t) => [t, src.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
const sqliteLogA = src.prepare("SELECT seq, hash, prev_hash FROM memlog WHERE ns = ? ORDER BY seq").all(A);
src.close();
ok(sqliteCounts.kv === 4 && sqliteCounts.grants === 1 && sqliteCounts.memlog === 6 && sqliteCounts.docs === 1, `SQLite holds ${JSON.stringify(sqliteCounts)}`);

// ---- 2) first boot with the database on: import once ------------------------
const sdb = await import("../src/state-db.js");
const m = await import(MOD_URL);
try {
  await m.memoryReady();
  ok(m.BACKEND === "pg" && m.PERSISTENT === true, "with the database on the backend is pg and PERSISTENT reads true");
  const mark = await sdb.imports.done("agent402.db");
  ok(mark && mark.source === DB_FILE && mark.bytes > 0, `the import is marked (imports.done: source ${mark?.source === DB_FILE ? "matches" : "differs"}, ${mark?.bytes} bytes)`);
  const T = (t) => `${SCHEMA}.${t}`;
  const pgCount = async (t) => Number((await sdb.stateQuery(`SELECT COUNT(*)::int AS n FROM ${T(t)}`)).rows[0].n);
  ok((await pgCount("memory_kv")) === sqliteCounts.kv && (await pgCount("memory_grants")) === sqliteCounts.grants && (await pgCount("memory_memlog")) === sqliteCounts.memlog && (await pgCount("memory_docs")) === sqliteCounts.docs, "every table imported row for row");
  const pgLogA = (await sdb.stateQuery(`SELECT seq, hash, prev_hash FROM ${T("memory_memlog")} WHERE ns = $1 ORDER BY seq`, [A])).rows.map((r) => ({ seq: Number(r.seq), hash: r.hash, prev_hash: r.prev_hash }));
  ok(JSON.stringify(pgLogA) === JSON.stringify(sqliteLogA), "the imported chain rows (seq, hash, prev_hash) are byte-identical to SQLite's");

  // The imported data reads back through the module.
  ok((await m.memoryGet(A, "k1")).value.v === 1 && (await m.memoryGet(A, "ctr")).value === 4, "imported keys read back through memoryGet");
  const k2 = await m.memoryGet(A, "k2");
  ok(typeof k2.expiresAt === "number" && k2.expiresAt > Math.floor(Date.now() / 1000), "an imported TTL survives as a number");
  ok((await m.memoryGet(A, "k1", { actor: B })).value.v === 1, "an imported read grant still gates B's read (allowed)");
  await rejects("imported read grant does not allow B to write", () => m.memoryPut(A, "x", 1, { actor: B }), 403);

  // ---- 3) the chain continues on Postgres --------------------------------------
  const lastImported = sqliteLogA[sqliteLogA.length - 1];
  const w = await m.memoryPut(A, "k3", { after: "import" });
  ok(w.persistent === true && w.owner === A, "a write on Postgres resolves after the database has it (persistent: true)");
  let log = await m.getLog(A, A, 1000);
  ok(log.entries.length === sqliteLogA.length + 1, `the log has ${log.entries.length} entries (${sqliteLogA.length} imported + 1)`);
  ok(log.entries[sqliteLogA.length].prevHash === lastImported.hash, "the first Postgres entry links to the last imported hash");
  ok(chainOk(log.entries), "the whole chain verifies: imported rows then Postgres rows");
  ok(log.persistent === true, "getLog reports persistent: true");
  // The write is mirrored into the SQLite file after the commit (a rollback to
  // the file-only build then serves current memory): same row, same log row.
  {
    const f = new Database(DB_FILE, { readonly: true });
    const row = f.prepare("SELECT v FROM kv WHERE ns = ? AND k = ?").get(A, "k3");
    const last = f.prepare("SELECT seq, hash, prev_hash FROM memlog WHERE ns = ? ORDER BY seq DESC LIMIT 1").get(A);
    f.close();
    ok(m.__memoryMirrorStatus() === "on", `the SQLite mirror is on (${m.__memoryMirrorStatus()})`);
    ok(row && JSON.parse(row.v).after === "import", "a put in Postgres mode also appears in the SQLite file");
    const pgLast = log.entries[log.entries.length - 1];
    ok(last && last.seq === pgLast.seq && last.hash === pgLast.hash && last.prev_hash === pgLast.prevHash, "the mirrored memlog row has the same seq, prev_hash and hash as Postgres");
  }

  // ---- 4) atomic steps under concurrency -----------------------------------
  const N = 25;
  const incrs = await Promise.all(Array.from({ length: N }, () => m.memoryIncr(A, "ctr", 1, A)));
  ok((await m.memoryGet(A, "ctr")).value === 4 + N, `${N} concurrent incr calls land exactly once each (ctr = ${4 + N})`);
  ok(new Set(incrs.map((r) => r.value)).size === N, "every concurrent incr saw a distinct intermediate value");
  log = await m.getLog(A, A, 1000);
  ok(log.entries.filter((e) => e.action === "incr").length === N + 1 && chainOk(log.entries), `the chain stays contiguous and valid through ${N} concurrent writers (${log.entries.length} entries)`);
  // ---- one namespace cannot occupy the shared pool -----------------------------
  // Writes to one owner wait their turn in this process, not on a pooled
  // connection parked on the database lock: while a burst of writes to one
  // namespace runs, no connection of ours waits on an advisory lock and an
  // unrelated query is served alongside it.
  {
    const pg = (await import("pg")).default;
    const watcher = new pg.Client({ connectionString: PG_URL });
    await watcher.connect();
    let maxWaiting = 0, sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const r = await watcher.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND pid <> pg_backend_pid()");
        maxWaiting = Math.max(maxWaiting, r.rows[0].n);
      }
    })();
    const W = "0x" + "d4".repeat(20);
    const BURST = 120;
    const writes = Array.from({ length: BURST }, (_, i) => m.memoryPut(W, "k" + (i % 5), "v" + i));
    let otherDone = false;
    const other = sdb.stateQuery("SELECT 1").then(() => { otherDone = true; });
    let writesDone = 0;
    for (const w of writes) w.then(() => { writesDone++; }, () => {});
    await other;
    const writesAtOther = writesDone;
    const results = await Promise.allSettled(writes);
    sampling = false; await sampler; await watcher.end();
    ok(results.every((r) => r.status === "fulfilled"), `${BURST} concurrent writes to one namespace all succeed`);
    ok(maxWaiting === 0, `no pooled connection waited on a namespace lock during the burst (max waiting ${maxWaiting})`);
    ok(otherDone && writesAtOther < BURST, `an unrelated query was served before the burst finished (${writesAtOther}/${BURST} writes done)`);
    const lg = await m.getLog(W, W, 1000);
    ok(lg.entries.length === BURST && chainOk(lg.entries), `the namespace chain is contiguous through the burst (${lg.entries.length} entries)`);
  }

  // ---- M9: a retried paid write with a client request id applies once ---------
  {
    const first = await m.memoryIncr(A, "rid-ctr", 1, A, { requestId: "job-7:step-1" });
    // The commit landed and the answer was lost: the client retries with the same id.
    const again = await m.memoryIncr(A, "rid-ctr", 1, A, { requestId: "job-7:step-1" });
    ok(first.value === 1 && again.value === 1 && again.replayed === true && (await m.memoryGet(A, "rid-ctr")).value === 1, `M9: a retried incr with the same requestId counts once and replays the first answer (${first.value}, ${again.value})`);
    const racing = await Promise.all(Array.from({ length: 8 }, () => m.memoryIncr(A, "rid-ctr2", 1, A, { requestId: "same-id" })));
    ok((await m.memoryGet(A, "rid-ctr2")).value === 1 && racing.filter((r) => !r.replayed).length === 1, "M9: concurrent copies of one requestId apply once");
    ok((await m.memoryIncr(A, "rid-ctr", 1, A)).value === 2, "M9: without a requestId every call counts");
    await rejects("M9: the same requestId for a different write is refused", () => m.memoryIncr(A, "rid-ctr", 5, A, { requestId: "job-7:step-1" }), 409);
    await rejects("M9: a malformed requestId is refused", () => m.memoryIncr(A, "rid-ctr", 1, A, { requestId: "has space" }), 400);
    const p1 = await m.memoryPut(A, "rid-put", { n: 1 }, { requestId: "put-1" });
    const p2 = await m.memoryPut(A, "rid-put", { n: 1 }, { requestId: "put-1" });
    ok(p2.replayed === true && p2.updated === p1.updated, "M9: a retried put replays its first answer");
    const logIncr = (await m.getLog(A, A, 1000)).entries.filter((e) => e.key === "rid-ctr2");
    ok(logIncr.length === 1, `M9: one memlog row for the applied write (${logIncr.length})`);
    ok((await m.memoryIncr(B, "rid-ctr", 1, B, { requestId: "job-7:step-1" })).value === 1, "M9: another namespace's id is its own");
  }
  const cas = await Promise.all(Array.from({ length: 10 }, (_, i) => m.memoryCas(A, "locks/job", null, `agent-${i}`, { ttlSeconds: 30, hasValue: true })));
  const winners = cas.filter((r) => r.swapped);
  ok(winners.length === 1, `exactly one of 10 concurrent cas acquires wins the lock (${winners.length})`);
  const holder = winners[0]?.value;
  ok(cas.filter((r) => !r.swapped).every((r) => r.value === holder), "every loser is told the holder's token");
  ok((await m.memoryCas(A, "locks/job", "wrong", undefined, { hasValue: false })).swapped === false, "release with the wrong token fails");
  ok((await m.memoryCas(A, "locks/job", holder, undefined, { hasValue: false })).swapped === true, "release with the right token deletes");
  await rejects("released lock is gone", () => m.memoryGet(A, "locks/job"), 404);
  await m.memoryPut(A, "doc", { v: 1 });
  ok((await m.memoryCas(A, "doc", { v: 1 }, { v: 2 }, { hasValue: true })).swapped === true, "cas optimistic update on match");
  const stale = await m.memoryCas(A, "doc", { v: 1 }, { v: 3 }, { hasValue: true });
  ok(stale.swapped === false && stale.value.v === 2, "cas on a stale expected fails and returns the current value");
  await m.memoryPut(A, "word", "hello");
  await rejects("incr on a non-numeric value", () => m.memoryIncr(A, "word", 1, A), 400);
  ok((await m.memoryDelete(A, "word")).deleted === true, "delete works");
  log = await m.getLog(A, A, 1000);
  ok(chainOk(log.entries), "the chain still verifies after cas, delete and failed steps");

  // ---- 5) the grants gate ---------------------------------------------------
  await rejects("C cannot read A without a grant", () => m.memoryGet(A, "k1", { actor: C }), 403);
  await rejects("C cannot list A's keys", () => m.memoryGet(A, undefined, { actor: C }), 403);
  await rejects("C cannot read A's log", () => m.getLog(A, C), 403);
  await rejects("C cannot write A", () => m.memoryPut(A, "x", 1, { actor: C }), 403);
  await rejects("C cannot incr in A", () => m.memoryIncr(A, "ctr", 1, C), 403);
  await rejects("C cannot cas in A", () => m.memoryCas(A, "k1", null, 1, { actor: C, hasValue: true }), 403);
  await rejects("C cannot recall A", () => m.recall(A, "memory", 5, { actor: C }), 403);
  ok((await m.authorize(A, C, "read")) === false && (await m.authorize(A, A, "write")) === true, "authorize answers false for a stranger and true for the owner");
  await m.grant(A, C, "read");
  ok((await m.memoryGet(A, "k1", { actor: C })).value.v === 1, "C reads A after a read grant");
  await rejects("C still cannot write with a read grant", () => m.memoryPut(A, "x", 1, { actor: C }), 403);
  await m.grant(A, C, "readwrite");
  ok((await m.memoryPut(A, "fromC", "c", { actor: C })).owner === A, "C writes A after a readwrite grant");
  ok((await m.listGrants(A)).grants.some((g) => g.grantee === C && g.mode === "readwrite" && g.active), "listGrants shows C as readwrite and active");
  // An expired grant (exp in the past, set directly) is refused.
  await sdb.stateQuery(`UPDATE ${T("memory_grants")} SET exp = $3 WHERE owner = $1 AND grantee = $2`, [A, C, Math.floor(Date.now() / 1000) - 10]);
  await rejects("an expired grant is refused", () => m.memoryGet(A, "k1", { actor: C }), 403);
  ok((await m.listGrants(A)).grants.find((g) => g.grantee === C).active === false, "listGrants shows the expired grant as inactive");
  await m.grant(A, C, "read", 3600);
  ok((await m.memoryGet(A, "k1", { actor: C })).value.v === 1, "a fresh TTL grant reads");
  ok((await m.revoke(A, C)).revoked === true, "revoke removes the grant");
  await rejects("C is blocked after revoke", () => m.memoryGet(A, "k1", { actor: C }), 403);
  await rejects("a grant to a non-0x grantee is refused", () => m.grant(A, "not-a-wallet", "read"), 400);
  log = await m.getLog(A, A, 1000);
  ok(log.entries.filter((e) => e.action === "grant").length === 4 && log.entries.filter((e) => e.action === "revoke").length === 1 && chainOk(log.entries), "grants and revokes are chained too");

  // ---- 6) recall: the imported vector and a new one -------------------------
  await m.remember(A, "Our favorite pizza topping is pineapple and jalapeno.", { topic: "food" });
  await m.remember(A, "Kubernetes pods were OOMKilled during the rollout.", { topic: "ops" });
  const r = await m.recall(A, "why did the deployment crash from low memory", 2);
  ok(r.results.length > 0 && !r.results[0].text.includes("pizza") && r.results.every((x) => x.score > 0), `recall ranks an ops doc first, never the food doc (${r.results.length} scored result(s))`);
  ok(r.results.some((x) => x.text.startsWith("The deploy failed")), "the doc imported from SQLite is recalled by its stored vector");
  ok((await m.forget(A, r.results[0].id)).deleted === true, "forget deletes a doc");

  // ---- 7) quotas --------------------------------------------------------------
  process.env.MEMORY_MAX_NS_KEYS = "2";
  await m.memoryPut(C, "q1", 1); await m.memoryPut(C, "q2", 1);
  await rejects("key quota full -> 413", () => m.memoryPut(C, "q3", 1), 413);
  await m.memoryPut(C, "q1", 2);
  ok(true, "overwriting an existing key at the cap is allowed");
  await rejects("incr creating a key at the cap -> 413", () => m.memoryIncr(C, "q4", 1, C), 413);
  await rejects("cas creating a key at the cap -> 413", () => m.memoryCas(C, "q5", null, "v", { hasValue: true }), 413);
  delete process.env.MEMORY_MAX_NS_KEYS;
  process.env.MEMORY_MAX_NS_BYTES = "1000";
  await m.memoryPut(C, "q3", "y".repeat(900));
  await rejects("byte budget full -> 413", () => m.memoryPut(C, "q4", "y".repeat(200)), 413);
  await m.memoryPut(C, "q3", "tiny");
  ok((await m.memoryPut(C, "q4", "y".repeat(200))).bytes === 200, "shrinking a value frees budget");
  delete process.env.MEMORY_MAX_NS_BYTES;
  await rejects("a value with a NUL character is refused (400, not a failed statement)", () => m.memoryPut(C, "nul", "a\u0000b"), 400);
  // Postgres keeps no U+0000 and no unpaired surrogate: a value holding one is
  // refused (400, never charged) rather than stored changed.
  await m.memoryPut(C, "nul", { keep: 1 });
  await rejects("an object value holding U+0000 is refused (400)", () => m.memoryPut(C, "nul", { note: "line1\u0000line2" }), 400);
  await rejects("a string value that is JSON text with an escaped NUL is refused (400)", () => m.memoryPut(C, "nul", '{"a":"\\u0000"}'), 400);
  await rejects("a value holding an unpaired surrogate is refused (400)", () => m.memoryPut(C, "nul", { s: "\ud800" }), 400);
  await rejects("cas to a value holding U+0000 is refused (400)", () => m.memoryCas(C, "nul", { keep: 1 }, ["\u0000"], { hasValue: true }), 400);
  await rejects("incr on a key holding U+0000 is refused (400)", () => m.memoryIncr(C, "c\u0000tr", 1, C), 400);
  await rejects("remember with meta holding U+0000 is refused (400)", () => m.remember(C, "a note", { t: "\u0000" }), 400);
  ok(JSON.stringify((await m.memoryGet(C, "nul")).value) === JSON.stringify({ keep: 1 }), "a refused write leaves the stored value as it was");
  await m.memoryPut(C, "esc", { t: "a\\u0000b" });
  ok((await m.memoryGet(C, "esc")).value.t === "a\\u0000b", "an escaped backslash before u0000 is plain text and round-trips");

  // ---- 8) a second boot: no re-import, and both processes see each other -------
  // Add a row to the SQLite file AFTER the import; a second boot must not pick it up.
  const w2 = new Database(DB_FILE);
  w2.prepare("INSERT INTO kv (ns, k, v, updated, exp) VALUES (?, ?, ?, ?, NULL)").run(A, "late-file-row", "\"x\"", Date.now());
  w2.close();
  const mark1 = await sdb.imports.done("agent402.db");
  const second = child(`
    const m = await import(${JSON.stringify(MOD_URL)});
    await m.memoryReady();
    const A = ${JSON.stringify(A)};
    let late = "present";
    try { await m.memoryGet(A, "late-file-row"); } catch (e) { late = e.statusCode; }
    const k3 = (await m.memoryGet(A, "k3")).value.after;
    const put = await m.memoryPut(A, "from-second-boot", { boot: 2 });
    const log = await m.getLog(A, A, 1000);
    console.log(JSON.stringify({ backend: m.BACKEND, persistent: m.PERSISTENT, late, k3, put: put.persistent, entries: log.entries.length, last: log.entries[log.entries.length - 1].hash }));
  `, { STATE_DATABASE_URL: PG_URL, STATE_DB_SCHEMA: SCHEMA });
  ok(second.backend === "pg" && second.persistent === true, "the second boot runs on Postgres");
  ok(second.late === 404, "the second boot did not re-import the file (a row added after the import is absent)");
  const mark2 = await sdb.imports.done("agent402.db");
  ok(String(mark1.importedAt) === String(mark2.importedAt), "the import mark is unchanged by the second boot");
  ok(second.k3 === "import", "the second process reads the first process's write");
  const fromSecond = await m.memoryGet(A, "from-second-boot");
  ok(fromSecond.value.boot === 2, "the first process reads the second process's write");
  log = await m.getLog(A, A, 1000);
  ok(log.entries.length === second.entries && log.entries[log.entries.length - 1].hash === second.last && chainOk(log.entries), "both processes see one chain, and it verifies");
  ok(second.late === 404, "a file write within the 60 s grace (the mirror's own writes land in milliseconds) does not roll forward");

  // ---- 9) roll-forward after a rollback -------------------------------------
  // The file-only build (a rollback) appends to the file; its mtime then runs
  // ahead of the database's newest chain row. The next database boot re-reads
  // the file, the file winning per row, and the chain continues from it.
  const before = await m.getLog(A, A, 1000);
  const rolled = child(`
    const m = await import(${JSON.stringify(MOD_URL)});
    const A = ${JSON.stringify(A)};
    const w = m.memoryPut(A, "rolled-back-row", { from: "file-only build" });
    m.grant(A, ${JSON.stringify(C)}, "readwrite");
    const log = m.getLog(A, A, 1000);
    console.log(JSON.stringify({ backend: m.BACKEND, entries: log.entries.length, tail: log.entries.slice(-2) }));
  `, {});
  ok(rolled.backend === "sqlite" && rolled.entries === before.entries.length + 2 && rolled.tail[0].prevHash === before.entries[before.entries.length - 1].hash, "the file-only build appended two chain rows continuing the mirrored chain");
  const future = new Date(Date.now() + 120_000);
  for (const f of [DB_FILE, `${DB_FILE}-wal`]) if (existsSync(f)) utimesSync(f, future, future);
  const third = child(`
    const m = await import(${JSON.stringify(MOD_URL)});
    await m.memoryReady();
    const A = ${JSON.stringify(A)};
    const row = (await m.memoryGet(A, "rolled-back-row")).value.from;
    const log = await m.getLog(A, A, 1000);
    console.log(JSON.stringify({ row, entries: log.entries.length, last: log.entries[log.entries.length - 1] }));
  `, { STATE_DATABASE_URL: PG_URL, STATE_DB_SCHEMA: SCHEMA });
  ok(third.row === "file-only build", "a database boot after the rollback rolls the file's row forward");
  ok(third.entries === rolled.entries && third.last.hash === rolled.tail[1].hash && third.last.prevHash === rolled.tail[1].prevHash, "the file's chain rows are in the database with the same seq, prev_hash and hash");
  ok((await m.memoryGet(A, "late-file-row")).value === "x", "the row written to the file after the first import is rolled forward too (the file wins per row)");
  ok((await m.listGrants(A)).grants.some((g) => g.grantee === C && g.mode === "readwrite"), "a grant made by the file-only build is rolled forward");
  const mark3 = await sdb.imports.done("agent402.db");
  ok(String(mark1.importedAt) === String(mark3.importedAt), "the roll-forward is not a re-import: the mark is unchanged");
  const after = await m.memoryPut(A, "after-roll-forward", 1);
  ok(after.persistent === true, "a write after the roll-forward lands");
  log = await m.getLog(A, A, 1000);
  ok(log.entries.length === rolled.entries + 1 && log.entries[rolled.entries].prevHash === rolled.tail[1].hash && chainOk(log.entries), "the database chain continues from the file's last hash and verifies end to end");
  // After everything (both processes, grants, docs, deletes) the file mirrors the database.
  {
    const f = new Database(DB_FILE, { readonly: true });
    const fileLog = f.prepare("SELECT seq, hash FROM memlog WHERE ns = ? ORDER BY seq").all(A).map((r) => `${r.seq}:${r.hash}`).join(",");
    const fileKeys = f.prepare("SELECT k FROM kv WHERE ns = ? ORDER BY k").all(A).map((r) => r.k).join(",");
    const fileDocs = f.prepare("SELECT COUNT(*) AS n FROM docs WHERE ns = ?").get(A).n;
    const fileGrants = f.prepare("SELECT grantee, mode FROM grants WHERE owner = ? ORDER BY grantee").all(A).map((r) => `${r.grantee}:${r.mode}`).join(",");
    f.close();
    const pgLog = log.entries.map((e) => `${e.seq}:${e.hash}`).join(",");
    const pgKeys = (await m.memoryGet(A)).keys.map((k) => k.k).sort().join(",");
    const pgDocs = Number((await sdb.stateQuery(`SELECT COUNT(*)::int AS n FROM ${T("memory_docs")} WHERE ns = $1`, [A])).rows[0].n);
    const pgGrants = (await m.listGrants(A)).grants.map((g) => `${g.grantee}:${g.mode}`).sort().join(",");
    ok(fileLog === pgLog, `the file's whole memlog for A equals the database's (${log.entries.length} rows, both processes)`);
    ok(fileKeys === pgKeys && fileDocs === pgDocs && fileGrants === pgGrants, `kv, docs and grants in the file match the database (${pgKeys.split(",").length} keys, ${pgDocs} docs, ${pgGrants.split(",").filter(Boolean).length} grants)`);
  }
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("test-memory-pg: OK");
