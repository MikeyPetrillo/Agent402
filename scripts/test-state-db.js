// src/state-db.js against a real Postgres: the four shapes (documents, records,
// log lines, leases) and the import marker, in a schema this run creates and
// drops. Leases are the piece two overlapping containers depend on: a second
// owner cannot take a live lease, can take an expired one, and withLease skips
// a tick another holder owns instead of running it twice.
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-state-db" });
const sdb = await import("../src/state-db.js");
const { documents, records, logLines, leases, imports, withLease, stateDb, stateQuery, stateDbStatus, __dropStateSchema, closeStateDb } = sdb;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  ok(await stateDb(), "the pool comes up and the schema is created");
  ok(stateDbStatus() === "on", `status reads on (${stateDbStatus()})`);

  // documents
  ok((await documents.get("d1")) === null, "a missing document reads null");
  ok((await documents.put("d1", { a: 1, b: [1, 2] })) === 1, "first put is version 1");
  ok((await documents.put("d1", { a: 2 })) === 2, "second put bumps the version");
  let d = await documents.get("d1");
  ok(d.version === 2 && d.body.a === 2 && d.body.b === undefined, "put replaces the whole body");
  const m = await documents.mergeKeys("d1", { c: 3 }, ["a"]);
  ok(m.body.c === 3 && m.body.a === undefined && m.version === 3, "mergeKeys adds keys and drops the named ones");
  const m2 = await documents.mergeKeys("d-new", { x: 1 });
  ok(m2.body.x === 1 && m2.version === 1, "mergeKeys creates a missing document");
  ok((await documents.list("d")).map((x) => x.name).join(",") === "d-new,d1", "list by prefix, sorted");
  ok((await documents.list("d_")).length === 0, "list escapes LIKE wildcards");
  await documents.put("a\\b", { s: 1 }); await documents.put("axb", { s: 2 });
  ok((await documents.list("a\\")).map((x) => x.name).join(",") === "a\\b", "list treats a backslash in the prefix literally");
  ok((await documents.list("a%")).length === 0, "list treats a percent in the prefix literally");
  ok((await documents.del("d-new")) === true && (await documents.del("d-new")) === false, "del reports whether a row went");
  ok((await documents.putIfAbsent("pia", { a: 1 })) === true && (await documents.putIfAbsent("pia", { a: 2 })) === false && (await documents.get("pia")).body.a === 1, "putIfAbsent creates once and never overwrites");
  let threw = false; try { await documents.put("", {}); } catch { threw = true; }
  ok(threw, "an empty name is refused");

  // records
  await records.put("c", "b", { n: 2 }); await records.put("c", "a", { n: 1 }); await records.put("c", "c", { n: 3 });
  ok((await records.get("c", "a")).n === 1 && (await records.get("c", "zz")) === null, "records get by (collection, id)");
  await records.put("c", "a", { n: 10 });
  ok((await records.get("c", "a")).n === 10, "put upserts a record");
  const page = await records.list("c", { limit: 2 });
  ok(page.map((x) => x.id).join(",") === "a,b", "list pages by id");
  ok((await records.list("c", { limit: 2, after: "b" })).map((x) => x.id).join(",") === "c", "list continues after a cursor");
  ok((await records.count("c")) === 3 && (await records.count("other")) === 0, "count per collection");
  ok((await records.del("c", "b")) === true && (await records.count("c")) === 2, "del removes one record");

  // log lines
  const id1 = await logLines.append("s", { k: 1 });
  const id2 = await logLines.append("s", { k: 2 });
  await logLines.append("t", { k: 9 });
  ok(id2 > id1, "ids increase");
  const lines = await logLines.read("s");
  ok(lines.length === 2 && lines[0].body.k === 1 && lines[1].body.k === 2, "read returns a stream's lines oldest first");
  ok((await logLines.read("s", { afterId: id1 })).length === 1, "read after an id");
  ok((await logLines.tail("s", 1))[0].body.k === 2, "tail returns the newest");
  ok((await logLines.count("s")) === 2 && (await logLines.count("t")) === 1, "count per stream");

  // imports
  ok((await imports.done("f")) === null, "an unimported name reads null");
  await imports.mark("f", { source: "/data/f.json", bytes: 12 });
  await imports.mark("f", { source: "/other", bytes: 99 });
  const im = await imports.done("f");
  ok(im.source === "/data/f.json" && im.bytes === 12, "mark records once; a second mark does not overwrite");

  // leases
  ok(await leases.acquire("L", { owner: "A", ttlMs: 2000 }), "A acquires a free lease");
  ok(!(await leases.acquire("L", { owner: "B", ttlMs: 2000 })), "B cannot take A's live lease");
  ok(await leases.acquire("L", { owner: "A", ttlMs: 2000 }), "A re-acquires its own lease");
  ok((await leases.holder("L")).owner === "A", "holder names A");
  ok(await leases.renew("L", { owner: "A", ttlMs: 2000 }) && !(await leases.renew("L", { owner: "B", ttlMs: 2000 })), "only the owner renews");
  ok(!(await leases.release("L", { owner: "B" })) && (await leases.holder("L")).owner === "A", "B cannot release A's lease");
  ok(await leases.release("L", { owner: "A" }) && (await leases.holder("L")) === null, "A releases");
  ok(await leases.acquire("E", { owner: "A", ttlMs: 1000 }), "A takes E with a 1 s ttl");
  await sleep(1200);
  ok(await leases.acquire("E", { owner: "B", ttlMs: 2000 }), "B takes E once it expired");
  await leases.release("E", { owner: "B" });

  // withLease
  let runs = 0;
  const r1 = await withLease("W", { owner: "A", ttlMs: 5000 }, async () => { runs++; return "x"; });
  ok(r1.ran === true && r1.result === "x" && runs === 1, "withLease runs the function and returns its result");
  ok((await leases.holder("W")) === null, "withLease releases afterwards");
  await leases.acquire("W", { owner: "Z", ttlMs: 5000 });
  const r2 = await withLease("W", { owner: "A", ttlMs: 5000 }, async () => { runs++; });
  ok(r2.ran === false && r2.reason === "held" && runs === 1, "withLease skips a tick another holder owns");
  await leases.release("W", { owner: "Z" });
  let bad = false;
  const r3 = await withLease("W", { owner: "A", ttlMs: 1000, log: () => {} }, async () => { await sleep(1500); return "long"; }).catch(() => { bad = true; });
  ok(!bad && r3.ran && r3.result === "long", "a tick longer than the ttl keeps the lease through renewal");
  ok(!(await leases.acquire("W", { owner: "B", ttlMs: 1000 })) === false, "after a long tick the lease is free again");
  await leases.release("W", { owner: "B" });

  // Renewal is what keeps a tick longer than its ttl exclusive: another owner
  // trying mid-tick, past the ttl, must still be refused.
  let midTickSteal = null;
  const rr = await withLease("RN", { owner: "A", ttlMs: 1000, log: () => {} }, async () => {
    await sleep(1600);
    midTickSteal = await leases.acquire("RN", { owner: "B", ttlMs: 1000 });
    return 1;
  });
  ok(rr.ran && midTickSteal === false && !rr.lost, `renewal keeps the lease past its ttl: another owner is refused mid-tick (got ${midTickSteal})`);

  // ---- C1: a connection cut while a transaction holds it --------------------
  {
    const { withStateTx, stateQuery } = sdb;
    let txErr = null;
    const crashes = [];
    const onUncaught = (e) => crashes.push(String(e?.message || e));
    process.on("uncaughtException", onUncaught);
    try {
      await withStateTx(async (c) => {
        const pid = (await c.query("SELECT pg_backend_pid() AS p")).rows[0].p;
        await stateQuery("SELECT pg_terminate_backend($1)", [pid]);
        await sleep(300); // the client sits checked out and idle while its backend dies
        await c.query("SELECT 1");
      });
    } catch (e) { txErr = e; }
    process.off("uncaughtException", onUncaught);
    ok(crashes.length === 0, `a backend killed mid-transaction raises no uncaught error event (${crashes.join("; ") || "none"})`);
    ok(!!txErr, "the transaction itself rejects");
    ok(stateDbStatus() === "degraded", `a dropped connection in a transaction reads degraded (${stateDbStatus()})`);
    const after = await withStateTx(async (c) => (await c.query("SELECT 7 AS n")).rows[0].n);
    ok(after === 7 && stateDbStatus() === "on", "the next transaction gets a working connection and the word reads on again");
  }

  // ---- H13: NUL and lone surrogates reach Postgres cleaned --------------------
  {
    const { withStateTx, stateQuery } = sdb;
    await documents.put("nul-doc", { reason: "a\u0000b", lone: "x\ud800y", pair: "😀", esc: "\\u0000 kept", nested: ["\u0000", { k: "c\u0000" }] });
    const nd = (await documents.get("nul-doc")).body;
    ok(nd.reason === "ab" && nd.lone === "x�y" && nd.pair === "😀" && nd.esc === "\\u0000 kept" && nd.nested[0] === "" && nd.nested[1].k === "c",
      `a document body with NUL and a lone surrogate stores cleaned, an escaped backslash survives (${JSON.stringify(nd)})`);
    await records.put("nul-c", "r1", { v: "p\u0000q", s: "\udc00" });
    const nr = await records.get("nul-c", "r1");
    ok(nr.v === "pq" && nr.s === "�", "a record body with NUL and a lone low surrogate stores cleaned");
    await logLines.append("nul-s", { line: "l\u0000m" });
    ok((await logLines.tail("nul-s", 1))[0].body.line === "lm", "a log line with NUL stores cleaned");
    const t = (await stateQuery("SELECT $1::text AS t", ["t\u0000u"])).rows[0].t;
    ok(t === "tu", "a plain text parameter with NUL is cleaned");
    const tx = await withStateTx(async (c) => {
      await c.query(`INSERT INTO ${sdb.stateDbSchema()}.records (collection, id, body) VALUES ($1, $2, $3::jsonb)`, ["nul-c", "r\u00002", JSON.stringify({ w: "z\u0000" })]);
      return (await c.query({ text: `SELECT id, body FROM ${sdb.stateDbSchema()}.records WHERE collection = $1 AND id = $2`, values: ["nul-c", "r\u00002"] })).rows[0];
    });
    ok(tx && tx.id === "r2" && tx.body.w === "z", "a transaction's parameters (positional and config form) are cleaned too");
    // JSON escapes are cleaned only in a parameter cast to json/jsonb: a TEXT
    // value that happens to look like JSON is stored exactly as typed.
    const S = sdb.stateDbSchema();
    await stateQuery(`CREATE TABLE IF NOT EXISTS ${S}.text_probe (k INT PRIMARY KEY, v TEXT)`);
    const typed = ['{"note":"\\u0000"}', '"\\u0000"', '["\\ud800"]', '{"a":1,"a\\u0000":2}'];
    for (let i = 0; i < typed.length; i++) await stateQuery(`INSERT INTO ${S}.text_probe (k, v) VALUES ($1, $2)`, [i, typed[i]]);
    const back = (await stateQuery(`SELECT k, v FROM ${S}.text_probe ORDER BY k`)).rows.map((r) => r.v);
    ok(JSON.stringify(back) === JSON.stringify(typed), `a TEXT value shaped like JSON with escapes is stored unchanged (${JSON.stringify(back)})`);
    await withStateTx(async (c) => { await c.query(`UPDATE ${S}.text_probe SET v = $2 WHERE k = $1`, [0, typed[3]]); await c.query({ text: `UPDATE ${S}.text_probe SET v = $2 WHERE k = $1`, values: [1, typed[0]] }); });
    const back2 = (await stateQuery(`SELECT v FROM ${S}.text_probe WHERE k IN (0, 1) ORDER BY k`)).rows.map((r) => r.v);
    ok(back2[0] === typed[3] && back2[1] === typed[0], "a transaction's TEXT parameters are stored unchanged too");
    const asJson = (await stateQuery("SELECT $1::jsonb AS j, $2::jsonb[] AS a", ['{"n":"x\\u0000y"}', ['{"m":"\\ud800"}']])).rows[0];
    ok(asJson.j.n === "xy" && asJson.a[0].m === "\ufffd", `a parameter cast to jsonb or jsonb[] still has its escapes cleaned (${JSON.stringify(asJson)})`);
    const raw = (await stateQuery("SELECT $1::text AS t", ['{"z":"a\u0000b"}'])).rows[0].t;
    ok(raw === '{"z":"ab"}', "a raw NUL is still dropped from a TEXT parameter");
  }

  // ---- H11: re-entry in one process never releases the running holder -------
  {
    let inner = null;
    const outer = await withLease("RE", { ttlMs: 60_000, log: () => {} }, async () => {
      inner = await withLease("RE", { ttlMs: 60_000, log: () => {} }, async () => "inner ran");
      return (await leases.holder("RE"))?.owner || null;
    });
    ok(inner && inner.ran === false && inner.reason === "busy", `a re-entrant call answers busy without running (${JSON.stringify(inner)})`);
    ok(outer.result === sdb.leaseOwnerId(), "the outer run still holds its lease after the re-entrant call returned");
    let wrappedRuns = 0;
    let releaseGate;
    const gate = new Promise((r) => { releaseGate = r; });
    const tick = sdb.leased("RE2", { ttlMs: 60_000, log: () => {} }, async () => { wrappedRuns++; await gate; return "done"; });
    const first = tick();
    await sleep(100);
    const second = await tick();
    const midHolder = await leases.holder("RE2");
    releaseGate();
    await first;
    ok(second.skipped === "leased" && second.reason === "busy" && midHolder?.owner === sdb.leaseOwnerId() && wrappedRuns === 1, "leased(): an overlapping call in-process skips and leaves the lease held");
  }

  // ---- M13: the owner id differs per boot even with the same replica and pid -
  {
    const other = await import("../src/state-db.js?second-boot");
    ok(other.leaseOwnerId() !== sdb.leaseOwnerId() && sdb.leaseOwnerId().startsWith(sdb.leaseOwnerId().split(":")[0]), `two boots with the same pid get different owners (${sdb.leaseOwnerId()} vs ${other.leaseOwnerId()})`);
  }

  // ---- H10: fencing: a lost lease is visible to the running function --------
  {
    let sawStill = null, sawAbort = null, afterLoss = null, during = null;
    const r = await withLease("FN", { ttlMs: 1500, log: () => {} }, async (ctx) => {
      during = sdb.leaseStillHeld("FN");
      sawStill = ctx.stillHeld();
      // Another container takes the row (the shape of a stall past the ttl).
      await stateQuery(`UPDATE ${sdb.stateDbSchema()}.leases SET owner = 'thief' WHERE name = 'FN'`);
      await sleep(1200); // past one renew interval
      sawAbort = ctx.signal.aborted;
      afterLoss = sdb.leaseStillHeld("FN");
      return ctx.stillHeld();
    });
    ok(during === true && sawStill === true, "while held, stillHeld() and leaseStillHeld(name) read true");
    ok(sawAbort === true && afterLoss === false && r.result === false && r.lost === true, `a renew that finds the lease gone aborts the signal and flags the run lost (${JSON.stringify({ sawAbort, afterLoss, r })})`);
    ok((await leases.holder("FN"))?.owner === "thief", "a lost run does not release the new holder's lease");
    await leases.release("FN", { owner: "thief" });
    ok(sdb.leaseStillHeld("never-taken") === false, "a lease this process does not hold reads not held");
    // No renew has landed for a full ttl (here the loop is blocked): not held, before any renew reports.
    const stalled = await withLease("FN2", { ttlMs: 1000, log: () => {} }, async (ctx) => {
      const until = Date.now() + 1100; while (Date.now() < until) { /* a stall: no timer runs */ }
      return { still: ctx.stillHeld(), named: sdb.leaseStillHeld("FN2") };
    });
    ok(stalled.result.still === false && stalled.result.named === false && stalled.lost === true, `a run that stalled past its ttl reads not held and is flagged lost (${JSON.stringify(stalled)})`);
  }

  // ---- M18: log reconcile restores a lost middle line, never duplicates -----
  {
    const { reconcileLogFile } = sdb;
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "sdb-rec-"));
    try {
      await logLines.append("rec", { n: 1 });
      await logLines.append("rec", { n: 3 });
      const f = join(dir, "rec.ndjson");
      writeFileSync(f, [{ n: 1 }, { n: 2 }, { n: 3 }].map((x) => JSON.stringify(x)).join("\n") + "\n");
      const added = await reconcileLogFile("rec", f, { log: () => {} });
      const got = (await logLines.read("rec")).map((x) => x.body.n).sort().join(",");
      ok(added === 1 && got === "1,2,3", `a stream missing a middle line gains exactly that line (added ${added}, stream ${got})`);
      ok((await reconcileLogFile("rec", f, { log: () => {} })) === 0 && (await logLines.count("rec")) === 3, "reconciling again adds nothing");
      // Two containers reconciling the same gap at once add it once.
      await logLines.append("rec3", { a: 1 });
      const f3 = join(dir, "rec3.ndjson");
      writeFileSync(f3, `{"a":1}\n{"b":2}\n{"c":3}\n`);
      const both = await Promise.all([reconcileLogFile("rec3", f3, { log: () => {} }), reconcileLogFile("rec3", f3, { log: () => {} })]);
      ok(both[0] + both[1] === 2 && (await logLines.count("rec3")) === 3, `two reconciles at once add each missing line once (added ${both.join("+")}, stream ${await logLines.count("rec3")})`);
      // A line another container restored between this one's read and its
      // insert (same stable key) is skipped, not an error.
      {
        const { createHash } = await import("node:crypto");
        const keyOf = (b) => createHash("sha256").update(JSON.stringify(b)).digest("hex").slice(0, 32);
        await logLines.append("rec5", { a: 1 });
        await stateQuery(`INSERT INTO ${sdb.stateDbSchema()}.log_lines (stream, body, line_key) VALUES ('rec5', '{"other":"row"}'::jsonb, $1)`, [`${keyOf({ b: 2 })}:1`]);
        const f5 = join(dir, "rec5.ndjson");
        writeFileSync(f5, `{"a":1}\n{"b":2}\n{"c":3}\n`);
        let threw = null, added5 = null;
        try { added5 = await reconcileLogFile("rec5", f5, { log: () => {} }); } catch (e) { threw = e; }
        ok(!threw && added5 === 1 && (await logLines.count("rec5")) === 3, `a line whose key another container already wrote is skipped (added ${added5}${threw ? `, threw ${threw.message}` : ""})`);
      }
      // Key order and a NUL in the file line do not make a stored line look missing.
      await logLines.append("rec4", { bb: 2, a: "n\u0000ul" }); // jsonb hands keys back shortest first: a, bb
      const f4 = join(dir, "rec4.ndjson");
      writeFileSync(f4, `{"bb":2,"a":"n\\u0000ul"}\n{"z":1}\n`);
      ok((await reconcileLogFile("rec4", f4, { log: () => {} })) === 1 && (await logLines.count("rec4")) === 2, "a stored line matches its file line regardless of key order or a cleaned NUL");
      // Two identical lines in the file and one in the stream: one is added.
      await logLines.append("rec2", { same: 1 });
      const f2 = join(dir, "rec2.ndjson");
      writeFileSync(f2, `{"same":1}\n{"same":1}\n`);
      ok((await reconcileLogFile("rec2", f2, { log: () => {} })) === 1 && (await logLines.count("rec2")) === 2, "repeated identical lines are counted by occurrence");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // ---- e2: which failures degrade the status word -----------------------------
  {
    await stateQuery(`CREATE TABLE IF NOT EXISTS ${sdb.stateDbSchema()}.uniq_t (k TEXT PRIMARY KEY)`);
    await stateQuery(`INSERT INTO ${sdb.stateDbSchema()}.uniq_t (k) VALUES ('a')`);
    let dup = null;
    try { await stateQuery(`INSERT INTO ${sdb.stateDbSchema()}.uniq_t (k) VALUES ('a')`); } catch (e) { dup = e; }
    ok(dup?.code === "23505" && stateDbStatus() === "on", `a constraint violation is the caller's answer, not an outage (status ${stateDbStatus()})`);
    let txDup = null;
    try { await sdb.withStateTx(async (c) => c.query(`INSERT INTO ${sdb.stateDbSchema()}.uniq_t (k) VALUES ('a')`)); } catch (e) { txDup = e; }
    ok(txDup?.code === "23505" && stateDbStatus() === "on", "the same in a transaction leaves the word on");
    ok(sdb.lastStateDbError() && /duplicate key/.test(sdb.lastStateDbError()), "the last error is still recorded for the operator");
    let slow = null;
    try { await sdb.withStateTx(async (c) => c.query("SELECT pg_sleep(2)"), { timeoutMs: 300 }); } catch (e) { slow = e; }
    ok(slow?.code === "57014" && stateDbStatus() === "degraded", `a transaction past its statement limit fails and reads degraded (${slow?.code}, ${stateDbStatus()})`);
    await stateQuery("SELECT 1");
    ok(stateDbStatus() === "on", "the next good statement reads on");
  }

  // ---- H4 + e2: a database that hangs is detected and leases do not hang ----
  {
    const { createServer, connect } = await import("node:net");
    const target = new URL(process.env.STATE_DATABASE_URL);
    let blackhole = false;
    const socks = new Set();
    const relay = createServer((cl) => {
      const up = connect({ host: target.hostname, port: Number(target.port || 5432) });
      socks.add(cl); socks.add(up);
      cl.on("data", (d) => { if (!blackhole) up.write(d); });
      up.on("data", (d) => { if (!blackhole) cl.write(d); });
      const drop = () => { cl.destroy(); up.destroy(); };
      cl.on("error", drop); up.on("error", drop); cl.on("close", drop); up.on("close", drop);
    });
    await new Promise((r) => relay.listen(0, "127.0.0.1", r));
    const realUrl = process.env.STATE_DATABASE_URL;
    const saved = { q: process.env.STATE_DB_QUERY_TIMEOUT_MS, c: process.env.STATE_DB_CONNECT_TIMEOUT_MS, l: process.env.STATE_DB_LEASE_ACQUIRE_MS };
    await closeStateDb();
    process.env.STATE_DATABASE_URL = realUrl.replace(`${target.hostname}:${target.port}`, `127.0.0.1:${relay.address().port}`);
    process.env.STATE_DB_QUERY_TIMEOUT_MS = "1500";
    process.env.STATE_DB_CONNECT_TIMEOUT_MS = "1500";
    process.env.STATE_DB_LEASE_ACQUIRE_MS = "600";
    try {
      await documents.put("hang-pre", { a: 1 });
      ok(stateDbStatus() === "on", "through the relay the word reads on");
      blackhole = true;
      const t0 = Date.now();
      let hangErr = null;
      try { await documents.get("hang-pre"); } catch (e) { hangErr = e; }
      const took = Date.now() - t0;
      ok(hangErr && took < 5000, `a query against a database that stopped answering fails within its timeout (${took} ms: ${String(hangErr?.message).slice(0, 60)})`);
      ok(stateDbStatus() === "degraded", `a hang reads degraded (${stateDbStatus()})`);
      const t1 = Date.now();
      let ran = 0;
      const lr = await withLease("HANG", { ttlMs: 60_000, log: () => {} }, async () => { ran++; });
      ok(lr.ran === false && lr.reason === "db" && ran === 0 && Date.now() - t1 < 1300, `a lease acquire against a hung database gives up in bounded time (${Date.now() - t1} ms, ${JSON.stringify(lr)})`);
      const t2 = Date.now();
      let txErr = null;
      try { await sdb.withStateTx(async (c) => c.query("SELECT 1")); } catch (e) { txErr = e; }
      ok(txErr && Date.now() - t2 < 6000, `a transaction against a hung database fails in bounded time (${Date.now() - t2} ms)`);
    } finally {
      blackhole = false;
      for (const s of socks) s.destroy();
      relay.close();
      await closeStateDb();
      process.env.STATE_DATABASE_URL = realUrl;
      for (const [k, v] of [["STATE_DB_QUERY_TIMEOUT_MS", saved.q], ["STATE_DB_CONNECT_TIMEOUT_MS", saved.c], ["STATE_DB_LEASE_ACQUIRE_MS", saved.l]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    await documents.put("hang-post", { a: 1 });
    ok(stateDbStatus() === "on", "back on the real database the word reads on");
  }

  // ---- M1: shutdown releases every lease this process holds -----------------
  {
    const other = await import("../src/state-db.js?shutdown-boot");
    let gateOpen;
    const gate = new Promise((r) => { gateOpen = r; });
    let sig = null;
    const running = other.withLease("SD", { ttlMs: 60 * 60_000, log: () => {} }, async (ctx) => { sig = ctx.signal; await gate; return "finished"; });
    await sleep(200);
    ok((await leases.holder("SD"))?.owner === other.leaseOwnerId(), "a long tick holds its lease");
    const n = await other.releaseHeldLeases({ timeoutMs: 3000 });
    ok(n === 1 && (await leases.holder("SD")) === null, `releaseHeldLeases frees the held lease at once (${n})`);
    ok(sig?.aborted === true && other.leaseStillHeld("SD") === false, "the running tick sees its lease is gone");
    await leases.acquire("SD2", { owner: "someone-else", ttlMs: 60_000 });
    const late = await other.withLease("SD2", { ttlMs: 1000, log: () => {} }, async () => "ran");
    ok(late.ran === false && late.reason === "shutdown", `after shutdown no new leased tick starts, nor tries the row (${late.reason})`);
    await leases.release("SD2", { owner: "someone-else" });
    gateOpen();
    await running;
    await other.closeStateDb();
  }

  // ---- F11: a store that has not loaded after the boot wait reads degraded --
  {
    const fresh = await import("../src/state-db.js?stores-boot");
    fresh.trackStoreReady(Promise.reject(new Error("first load failed")), "flaky-store");
    fresh.trackStoreReady(Promise.resolve(1), "good-store");
    await fresh.stateDb();
    await fresh.stateQuery("SELECT 1");
    ok(fresh.stateDbStatus() === "on", "before the boot wait ends the status does not page on a store");
    const r = await fresh.stateStoresReady({ timeoutMs: 2000 });
    ok(r !== "ready", `the boot wait does not call a failed first load ready (${r})`);
    ok(fresh.stateDbStatus() === "degraded" && fresh.stateStoresLoaded() === false, "after the boot wait an unloaded store reads degraded");
    fresh.markStoreLoaded("flaky-store");
    ok(fresh.stateDbStatus() === "on" && fresh.stateStoresLoaded() === true, "once the store reports its retried load, the word reads on");
    fresh.markStoreFailed("good-store");
    ok(fresh.stateDbStatus() === "degraded", "a store can report a load that failed after resolving");
    await fresh.closeStateDb();
  }

  // ---- a pooled connection that died while idle ------------------------------
  {
    // Warm several pooled clients, then kill their backends while they sit idle.
    await Promise.all(Array.from({ length: 4 }, () => stateQuery("SELECT pg_sleep(0.05)")));
    await stateQuery(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle' AND application_name = ''`);
    const reads = await Promise.allSettled(Array.from({ length: 4 }, () => stateQuery("SELECT 1 AS one")));
    ok(reads.every((r) => r.status === "fulfilled"), `reads right after idle connections died succeed on a fresh connection (${reads.map((r) => r.status === "fulfilled" ? "ok" : r.reason?.message).join("; ")})`);
    await Promise.all(Array.from({ length: 4 }, () => stateQuery("SELECT pg_sleep(0.05)")));
    await stateQuery(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle' AND application_name = ''`);
    const puts = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => records.put("retry-c", `r${i}`, { i })));
    ok(puts.every((r) => r.status === "fulfilled") && (await records.count("retry-c")) === 4, "an idempotent write right after idle connections died succeeds");
    ok(stateDbStatus() === "on", `and the word reads on (${stateDbStatus()})`);
  }

  // ---- the schema setup takes the shared advisory lock ------------------------
  {
    const lockClient = new (await import("pg")).default.Client({ connectionString: process.env.STATE_DATABASE_URL });
    await lockClient.connect();
    await lockClient.query("BEGIN");
    await lockClient.query("SELECT pg_advisory_xact_lock(4020402, hashtext($1))", [sdb.stateDbSchema()]);
    const fresh = await import("../src/state-db.js?lock-boot");
    let done = false;
    const setup = fresh.stateDb().then(() => { done = true; });
    await sleep(500);
    ok(done === false, "schema setup waits while another holder has the schema lock");
    await lockClient.query("COMMIT");
    await setup;
    ok(done === true, "and completes once the lock is released");
    await lockClient.end();
    await fresh.closeStateDb();
  }

  // ---- an outside registry of unloaded stores feeds the status word ------------
  {
    const fresh = await import("../src/state-db.js?probe-boot");
    await fresh.stateQuery("SELECT 1");
    await fresh.stateStoresReady({ timeoutMs: 100 });
    ok(fresh.stateDbStatus() === "on", "no unloaded store: on");
    let pending = ["sales-ledger"];
    fresh.setUnloadedStoresProbe(() => pending);
    ok(fresh.stateDbStatus() === "degraded" && fresh.unloadedStateStores().join() === "sales-ledger", "a store the probe names reads degraded");
    pending = [];
    ok(fresh.stateDbStatus() === "on", "and on once it loads");
    await fresh.closeStateDb();
  }

  // ---- M12: no fail-open unless the loop opts in -----------------------------
  // A database that cannot answer: a young container skips, an old one runs as the only container.
  const brokenUrl = process.env.STATE_DATABASE_URL;
  const { leaseFailOpenMs } = sdb;
  ok(leaseFailOpenMs({}) === 600_000 && leaseFailOpenMs({ STATE_DB_LEASE_FAILOPEN_MS: "5000" }) === 5000, "the fail-open age defaults to ten minutes and reads the variable");
  await closeStateDb();
  process.env.STATE_DATABASE_URL = "postgres://postgres@127.0.0.1:1/none?sslmode=disable&connect_timeout=1";
  let ran = 0;
  const young = await withLease("F", { ttlMs: 1000, uptimeMs: 1000, log: () => {} }, async () => { ran++; });
  ok(young.ran === false && young.reason === "db" && ran === 0, "lease unavailable: a container younger than the fail-open age skips its tick");
  const oldSafe = await withLease("F", { ttlMs: 1000, uptimeMs: 11 * 60_000, log: () => {} }, async () => { ran++; return "ok"; });
  ok(oldSafe.ran === false && oldSafe.reason === "db" && ran === 0, "lease unavailable: by default even an old container skips (no fail-open unless the loop opts in)");
  const youngOpen = await withLease("F", { ttlMs: 1000, uptimeMs: 1000, failOpen: true, log: () => {} }, async () => { ran++; });
  ok(youngOpen.ran === false && youngOpen.reason === "db" && ran === 0, "lease unavailable, failOpen: a young container still skips");
  const old = await withLease("F", { ttlMs: 1000, uptimeMs: 11 * 60_000, failOpen: true, log: () => {} }, async () => { ran++; return "ok"; });
  ok(old.ran === true && old.reason === "db-failopen" && ran === 1, "lease unavailable, failOpen: a container older than the fail-open age runs as the only container");
  const wrappedSafe = await sdb.leased("F2", { ttlMs: 1000, uptimeMs: 11 * 60_000, log: () => {} }, async () => { ran++; })();
  ok(wrappedSafe.skipped === "leased" && ran === 1, "leased() without failOpen skips when the lease is unavailable");
  ok(stateDbStatus() === "degraded", "a failed query flips the status word to degraded");
  await closeStateDb();
  process.env.STATE_DATABASE_URL = brokenUrl;
  ok(await stateDb(), "the real database is reachable again afterwards");
  await documents.put("after", { ok: true });
  ok(stateDbStatus() === "on", "a good query restores the status word to on");
} finally {
  await __dropStateSchema();
  await closeStateDb();
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
