// src/state-db.js against a real Postgres: the four shapes (documents, records,
// log lines, leases) and the import marker, in a schema this run creates and
// drops. Leases are the piece two overlapping containers depend on: a second
// owner cannot take a live lease, can take an expired one, and withLease skips
// a tick another holder owns instead of running it twice.
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-state-db" });
const sdb = await import("../src/state-db.js");
const { documents, records, logLines, leases, imports, withLease, stateDb, stateDbStatus, __dropStateSchema, closeStateDb } = sdb;

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
  ok((await documents.del("d-new")) === true && (await documents.del("d-new")) === false, "del reports whether a row went");
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
} finally {
  await __dropStateSchema();
  await closeStateDb();
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
