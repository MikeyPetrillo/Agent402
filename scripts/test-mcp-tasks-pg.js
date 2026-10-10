// The task store (src/mcp-tasks.js) on the state database: the directory of
// one-file-per-task records is imported once at the first boot with the
// database on, writes land in the `records` table where a second instance (a
// new container) reads them, a working record of a LIVE container is not an
// orphan while that container's lease stands and becomes one when it goes,
// and a settled 200 whose result cannot be retained still records a refund
// debt. Requires STATE_DATABASE_URL (CI fails without it).
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-mcp-tasks-pg" });
const { records, imports, leases, __dropStateSchema, closeStateDb } = await import("../src/state-db.js");
const { createTaskStore, newTaskId } = await import("../src/mcp-tasks.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const quiet = () => {};
const TMP = mkdtempSync(join(tmpdir(), "mcp-tasks-pg-"));
const DIR = join(TMP, "mcp-tasks");
const COLLECTION = basename(DIR);
const now = Date.now();
const iso = new Date(now).toISOString();
const fileRec = (over) => ({ taskId: newTaskId(), status: "working", statusMessage: "Running research.", createdAt: iso, lastUpdatedAt: iso, createdAtMs: now, ttlMs: 3_600_000, pollIntervalMs: 5000, slug: "research", owner: "a-boot-before-the-database", pid: 1, ...over });

try {
  // ---- 1. the directory is imported once ----------------------------------
  const orphan = fileRec({});
  const done = fileRec({ status: "completed", result: { content: [{ type: "text", text: "kept" }] } });
  const stale = fileRec({ createdAtMs: now - 7_200_000 }); // past its ttl: never imported
  rmSync(DIR, { recursive: true, force: true });
  const { mkdirSync } = await import("node:fs");
  mkdirSync(DIR, { recursive: true });
  for (const r of [orphan, done, stale]) writeFileSync(join(DIR, `${r.taskId}.json`), JSON.stringify(r));

  const s1 = createTaskStore({ dir: DIR, log: quiet });
  ok(s1.backend === "pg", "with STATE_DATABASE_URL set the store is on the database");
  await s1.ready();
  const mark = await imports.done(COLLECTION);
  ok(mark && mark.source === DIR, `the import is marked once under the directory's name (${COLLECTION})`);
  ok((await records.count(COLLECTION)) === 2, "both unexpired records were imported, the expired one was not");
  const swept = await s1.get(orphan.taskId);
  ok(swept?.status === "failed" && /restart/i.test(swept.statusMessage) && /not charged/i.test(swept.statusMessage),
    "a working record from a boot with no lease is resolved as FAILED, not charged (its run died with its process)");
  ok((await s1.get(done.taskId))?.result?.content?.[0]?.text === "kept", "a completed record and its result come through the import intact");

  // A second boot does not re-import: a row removed from the table stays removed.
  await records.del(COLLECTION, done.taskId);
  const s1b = createTaskStore({ dir: DIR, bootId: "a-second-boot", log: quiet });
  await s1b.ready();
  ok((await s1b.get(done.taskId)) === null, "a second boot does not re-import the directory (the mark holds)");
  ok(readdirSync(DIR).length === 3, "the directory is left in place");
  await s1b.close();

  // ---- 2. writes go to the table; a fresh instance reads them -------------
  const ctl = new AbortController();
  const rec = await s1.create({ slug: "research", controller: ctl });
  ok(rec && /^[0-9a-f]{48}$/.test(rec.taskId), "create() resolves the record once its row is stored");
  const row = await records.get(COLLECTION, rec.taskId);
  ok(row?.status === "working" && row.owner === s1.bootId, "the row is in the records table under this boot's owner");
  ok(s1.activeCount() === 1 && s1.atCapacity() === false, "the synchronous capacity view counts this container's live run");

  // The new container of a deploy: a different boot id over the same directory.
  const s2 = createTaskStore({ dir: DIR, bootId: "the-next-container", log: quiet });
  await s2.ready();
  const seen = await s2.get(rec.taskId);
  ok(seen?.status === "working", "a fresh instance (the other container) reads the working task from the row, NOT as an orphan: the owner's lease stands");
  ok(Boolean(await leases.holder(`${COLLECTION}:boot:${s1.bootId}`)), "the first container holds a renewed lease named after its boot");
  ok(s2.activeCount() === 0, "the other container's capacity view does not count a run it is not running");

  // The first container completes the run; the second reads the result.
  await s1.complete(rec.taskId, { content: [{ type: "text", text: "answer" }] }, { receipt: { success: true }, priceUsd: 0.5 });
  const got = await s2.get(rec.taskId);
  ok(got?.status === "completed" && got.result?.content?.[0]?.text === "answer", "the completed result is read by the other container from the row");
  ok(!ctl.signal.aborted, "a completion does not abort the run's controller");

  // ---- 3. the invariants ----------------------------------------------------
  // (a) a terminal task never transitions again, across containers.
  const c = await s1.create({ slug: "research" });
  ok((await s2.cancel(c.taskId)) === true, "the other container can cancel a task it does not run (the ack is spec'd)");
  ok((await s1.complete(c.taskId, { content: [] }, { receipt: { success: true } })) === false, "a late result cannot resurrect a cancelled task");
  ok((await s1.get(c.taskId))?.status === "cancelled", "the cancellation is what the row holds (the conditional write refused the completion)");

  // (b) an orphan is one whose owner's lease is gone: close the first store.
  const live = await s1.create({ slug: "research" });
  await s1.close();
  ok((await leases.holder(`${COLLECTION}:boot:${s1.bootId}`)) === null, "closing the store releases its lease");
  const r = await s2.sweep();
  ok(r.orphaned === 1, `once the lease is gone the sweep resolves the dead container's working run (${JSON.stringify(r)})`);
  const dead = await s2.get(live.taskId);
  ok(dead?.status === "failed" && /not charged/i.test(dead.statusMessage || ""), "...as failed and not charged: the paid loopback never delivered a 200");
  ok((await s2.get(rec.taskId))?.status === "completed", "a completed task survives the sweep");

  // (c) a settled 200 whose result cannot be retained records a refund debt.
  const charged = [];
  process.env.AGENT402_MCP_TASK_MAX_RESULT_BYTES = "200";
  const tiny = createTaskStore({ dir: join(TMP, "tiny"), log: quiet, onChargedFailure: (i) => charged.push(i) });
  delete process.env.AGENT402_MCP_TASK_MAX_RESULT_BYTES;
  await tiny.ready();
  const big = await tiny.create({ slug: "research" });
  await tiny.complete(big.taskId, { content: [{ type: "text", text: "x".repeat(5_000) }] }, { receipt: { success: true }, priceUsd: 1 });
  const bigRow = await records.get(basename(tiny.dir), big.taskId);
  ok(bigRow?.status === "failed" && bigRow.result === undefined, "a result too large to retain fails the task on the row rather than pretending to have delivered it");
  ok(charged.length === 1 && charged[0].slug === "research" && charged[0].receipt?.success === true && charged[0].priceUsd === 1,
    "that case reports a charged failure with the settle receipt for refund review");
  const small = await tiny.create({ slug: "research" });
  await tiny.complete(small.taskId, { content: [{ type: "text", text: "s" }] }, { receipt: { success: true } });
  ok(charged.length === 1, "an ordinary delivered result records NO debt");

  // (d) expiry: an expired row is pruned by the sweep and answers "expired" on a read.
  const old = fileRec({ owner: "the-next-container", createdAtMs: now - 7_200_000 });
  await records.put(COLLECTION, old.taskId, old);
  ok((await s2.get(old.taskId)) === "expired", "a TTL'd id reads as expired");
  ok((await records.get(COLLECTION, old.taskId)) === null, "...and its row is gone");

  // (e) a traversing or malformed id reads nothing and throws nothing.
  for (const bad of ["../planted", "", "/absolute/path", "not-hex-" + "0".repeat(40)]) {
    let threw = null, got2;
    try { got2 = await s2.get(bad); } catch (e) { threw = e; }
    ok(threw === null && got2 === null, `get(${JSON.stringify(bad.slice(0, 22))}) is a clean null`);
  }

  // ---- M11: a live run marked closed elsewhere, then completed with a charge ----
  {
    const dir = join(TMP, "m11_tasks");
    const charged = [];
    const A = createTaskStore({ dir, bootId: "m11A", log: quiet, onChargedFailure: (x) => charged.push(x) });
    await A.ready();
    const rec = await A.create({ slug: "some-paid-tool" });
    // (a) A's boot lease row is gone (a missed renew, a database blip at boot): the next renew takes it back.
    await leases.release("m11_tasks:boot:m11A", { owner: "m11A" });
    await A._renewLease();
    ok((await leases.holder("m11_tasks:boot:m11A"))?.owner === "m11A", "M11a: a renew that finds no lease row re-acquires the boot lease");
    // (b) the lease is gone again and B's sweep resolves the live run as an orphan.
    await leases.release("m11_tasks:boot:m11A", { owner: "m11A" });
    const B = createTaskStore({ dir, bootId: "m11B", log: quiet });
    await B.ready();
    ok((await B.get(rec.taskId))?.status === "failed", "M11b: another container resolved the run as failed");
    // A's run now returns its settled, paid 200.
    await A.complete(rec.taskId, { content: [{ type: "text", text: "paid result" }] }, { receipt: { success: true, transaction: "0xm11" }, priceUsd: 0.05 });
    const after = await A.get(rec.taskId);
    ok(after.status === "failed" && charged.length === 1 && charged[0].receipt?.transaction === "0xm11", `M11b: a charged result on a row closed elsewhere records the debt (status ${after.status}, onChargedFailure calls: ${charged.length})`);
    // A failure arriving on a closed row records nothing.
    const rec2 = await A.create({ slug: "some-paid-tool" });
    await B.cancel(rec2.taskId);
    await A.fail(rec2.taskId, { code: -32603, message: "x" });
    ok(charged.length === 1 && (await A.get(rec2.taskId)).status === "cancelled", "M11b: a failure on a row cancelled elsewhere records no debt and keeps the cancel");
    // a16: the conditional write. The row closes elsewhere between A's read and A's write.
    const rec3 = await A.create({ slug: "some-paid-tool" });
    const origGet = records.get;
    records.get = async (c, id) => {
      const body = await origGet.call(records, c, id);
      if (id === rec3.taskId && body?.status === "working") await records.put(c, id, { ...body, status: "cancelled", statusMessage: "closed elsewhere" });
      return body;
    };
    try { await A.complete(rec3.taskId, { content: [{ type: "text", text: "late" }] }, { receipt: { success: true, transaction: "0xm11c" }, priceUsd: 0.05 }); }
    finally { records.get = origGet; }
    ok((await A.get(rec3.taskId)).status === "cancelled" && charged.length === 2, `a16: a row closed between read and write keeps its terminal state, and the charged result is recorded (${(await A.get(rec3.taskId)).status}, ${charged.length})`);
    await A.close(); await B.close();
  }

  await s2._reset();
  ok((await records.count(COLLECTION)) === 0, "_reset clears the collection");
  await s2.close();
  await tiny.close();
} catch (e) {
  fail++;
  console.error("FAIL - threw:", e?.stack || e);
} finally {
  await __dropStateSchema().catch(() => {});
  await closeStateDb();
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\ntest-mcp-tasks-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
