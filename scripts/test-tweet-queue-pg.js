#!/usr/bin/env node
// The server tweet queue (src/tweet-queue.js) on the state database: the
// state file is imported once at the first load with the database on (and
// never again), the record of what was posted lives in one JSON document that
// a fresh instance (a new container, no file) reads, and the posting
// invariants hold on Postgres: an id is recorded SENDING in the document
// before the request leaves and its outcome after; a SENDING record is never
// re-sent; one post per clock hour; and the critical section is held under a
// database lease, so a tick skips while another container holds it. Offline:
// X is a stub, the clock is a stub.
//
// Needs STATE_DATABASE_URL (CI fails without it; locally it prints SKIP).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-tweet-queue-pg" });
const sdb = await import("../src/state-db.js");
const { createTweetQueue, hourOf, STATE_DOC_NAME, STATE_LEASE_NAME } = await import("../src/tweet-queue.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "tweetq-pg-"));
const H = 3_600_000;
const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 10);
const when = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const text = (n) => `PLACEHOLDER COPY ${n} zq9 not a real post`;
const CREDS = { consumerKey: "ck", consumerSecret: "cs", accessToken: "at", accessSecret: "as" };
const row = async () => (await sdb.documents.get(STATE_DOC_NAME))?.body ?? null;
const recOf = async (id) => (await row())?.records.find((r) => r.id === id) ?? null;

function mk(items, { clock = T0 + MIN, storePath = join(DIR, "state.json"), post = null, log = () => {} } = {}) {
  let t = clock;
  const sent = [];
  const q = createTweetQueue({
    queueJson: JSON.stringify(items), creds: CREDS, storePath, now: () => t, log, firstRunPostAfter: 0,
    post: post || (async (tx) => { sent.push(tx); return { kind: "posted", tweetId: String(sent.length) }; }),
  });
  return { q, sent, set: (ms) => { t = ms; } };
}

try {
  // ---- 1. import once ----------------------------------------------------------
  const file = join(DIR, "state.json");
  writeFileSync(file, JSON.stringify({ v: 1, records: [{ id: "old", state: "posted", at: T0 - 5 * H, hour: hourOf(T0 - 5 * H), tweetId: "7" }], slots: [] }));
  const items = [
    { id: "old", when: when(T0 - 5 * H), text: text("old") },
    { id: "a", when: when(T0), text: text("a") },
    { id: "b", when: when(T0), text: text("b") },
  ];
  const s1 = mk(items);
  ok(s1.q.backend === "pg", "with STATE_DATABASE_URL the queue's backend is pg");
  await s1.q.ready();
  const imported = await row();
  ok(imported?.v === 1 && imported.records.length === 1 && imported.records[0].id === "old", "the state file is imported into the document at the first load");
  const mark = await sdb.imports.done(STATE_DOC_NAME);
  ok(mark && mark.source === file, `the import is marked (${STATE_DOC_NAME})`);
  ok(s1.q.status().counts.posted === 1 && s1.q.status().lastPosted?.id === "old", "status() reads the imported record from the mirror");
  // The file changes after the import: a second instance reads the document, not the file.
  writeFileSync(file, JSON.stringify({ v: 1, records: [{ id: "old", state: "posted", at: T0 - 5 * H, hour: hourOf(T0 - 5 * H) }, { id: "a", state: "posted", at: T0 - 5 * H, hour: hourOf(T0 - 5 * H) }], slots: [] }));
  const s2 = mk(items);
  await s2.q.ready();
  ok((await row()).records.length === 1 && s2.q.status().counts.posted === 1 && s2.q.status().counts.due === 2, "a second load does not re-import the file: the document still holds one record");

  // ---- 2. posting writes the document; a fresh instance reads it ---------------
  // The SENDING record is in the DOCUMENT before the request leaves.
  let atPost = null;
  const s3 = mk(items, { post: async () => { atPost = await row(); return { kind: "posted", tweetId: "9001" }; } });
  await s3.q.ready();
  const r1 = await s3.q.tick();
  ok(r1.posted === 1 && atPost?.records.find((r) => r.id === "a")?.state === "sending", `the id is recorded SENDING in the document before the request leaves (${atPost?.records.map((r) => `${r.id}:${r.state}`).join(",")})`);
  ok(atPost.slots.some((s) => s.hour === hourOf(T0) && s.id === "a"), "and the hour's slot is taken in the same write");
  const afterA = await recOf("a");
  ok(afterA?.state === "posted" && afterA.tweetId === "9001", "the outcome replaces it after");
  ok(s3.q.status().lastPosted?.id === "a" && s3.q.status().currentHour.used === true, "status() reflects the write at once (the mirror)");
  await s3.q.flush();
  ok(JSON.parse(readFileSync(file, "utf8")).records.some((r) => r.id === "a" && r.state === "posted"), "the volume's file is kept current by write-through");
  // A fresh instance with NO file (a new container) reads the document.
  const fresh = mk(items, { storePath: join(DIR, "elsewhere", "state.json") });
  await fresh.q.ready();
  const st = fresh.q.status();
  ok(st.counts.posted === 2 && st.lastPosted?.id === "a" && !existsSync(join(DIR, "elsewhere", "state.json")), "a fresh instance reads the record from the document, not its missing file");

  // ---- 3. the invariants on Postgres ------------------------------------------
  // One post per clock hour: b is due but the hour is used.
  const r2 = await fresh.q.tick();
  ok(r2.posted === 0 && r2.idle === "hour_used" && fresh.sent.length === 0, "one post per clock hour: the second due item waits for the next hour");
  fresh.set(T0 + H + MIN);
  const r3 = await fresh.q.tick();
  ok(r3.posted === 1 && fresh.sent.length === 1 && (await recOf("b"))?.state === "posted", "the next hour posts it, recorded in the document");
  // A SENDING record left by another process is never re-sent.
  const body = await row();
  body.records.push({ id: "c", state: "sending", at: T0 + 2 * H + MIN, hour: hourOf(T0 + 2 * H) });
  body.slots.push({ hour: hourOf(T0 + 2 * H), id: "c" });
  await sdb.documents.put(STATE_DOC_NAME, body);
  const s4 = mk([...items, { id: "c", when: when(T0 + 2 * H), text: text("c") }, { id: "d", when: when(T0 + 2 * H), text: text("d") }], { clock: T0 + 2 * H + 2 * MIN });
  await s4.q.ready();
  const r4 = await s4.q.tick();
  ok(r4.posted === 0 && s4.sent.length === 0 && (await recOf("c"))?.state === "sending", "a SENDING record is never re-sent, and it holds its hour");
  ok(s4.q.status().counts.sending === 1 && s4.q.status().inDoubt.some((x) => x.id === "c" && x.class === "sending"), "the operator read names it as sending");
  s4.set(T0 + 3 * H + MIN);
  const r5 = await s4.q.tick();
  ok(r5.posted === 1 && s4.sent.length === 1 && (await recOf("d"))?.state === "posted" && (await recOf("c"))?.state === "sending", "the next hour posts the other item; the sending one is still untouched");
  // The critical section is a database lease: another holder blocks the tick.
  await sdb.leases.acquire(STATE_LEASE_NAME, { owner: "other-container", ttlMs: 60_000 });
  const s5 = mk([...items, { id: "e", when: when(T0 + 4 * H), text: text("e") }], { clock: T0 + 4 * H + MIN });
  await s5.q.ready();
  const r6 = await s5.q.tick();
  ok(r6.skipped === "locked" && s5.sent.length === 0 && (await recOf("e")) === null, "while another container holds the state lease the tick posts nothing and records nothing");
  await sdb.leases.release(STATE_LEASE_NAME, { owner: "other-container" });
  const r7 = await s5.q.tick();
  ok(r7.posted === 1 && (await sdb.leases.holder(STATE_LEASE_NAME)) === null, "once it is free the tick posts under the lease and releases it");
  // The tick itself is leased: another container's tick keeps this one out.
  await sdb.leases.acquire("tweet-queue-tick", { owner: "other-container", ttlMs: 60_000 });
  ok((await s5.q.tick()).skipped === "leased", "the tick is skipped under another holder of the tick lease");
  await sdb.leases.release("tweet-queue-tick", { owner: "other-container" });
  // A read-only process (FREE_MODE, not production) never seeds the document
  // from its own file: it reads the row and writes nothing.
  await sdb.documents.del(STATE_DOC_NAME);
  await sdb.stateQuery(`DELETE FROM ${process.env.STATE_DB_SCHEMA}.imports WHERE name = $1`, [STATE_DOC_NAME]);
  writeFileSync(join(DIR, "local-copy.json"), JSON.stringify({ v: 1, records: [], slots: [] }));
  const ro = createTweetQueue({ queueJson: JSON.stringify(items), creds: CREDS, storePath: join(DIR, "local-copy.json"), freeMode: true, now: () => T0 + MIN, log: () => {}, firstRunPostAfter: 0, post: async () => ({ kind: "posted" }) });
  await ro.ready();
  ok((await ro.tick()).skipped === "free_mode" && (await row()) === null && (await sdb.imports.done(STATE_DOC_NAME)) === null && ro.alarmStatus().status === "off", "a FREE_MODE boot with the database on reads but never imports its own (empty) file");
  // A corrupt document halts posting, the same as a corrupt file.
  await sdb.documents.put(STATE_DOC_NAME, { v: 1, records: [{ id: "x", state: "bogus", at: 1 }], slots: [] });
  const s6 = mk([...items, { id: "f", when: when(T0 + 5 * H), text: text("f") }], { clock: T0 + 5 * H + MIN });
  await s6.q.ready();
  const r8 = await s6.q.tick();
  ok(r8.error === "store_corrupt" && s6.sent.length === 0 && s6.q.alarmStatus().status === "halted" && s6.q.status().mode === "store_unreadable", "a corrupt document halts posting and pages");
  // ---- conditional claim: a write from a stale read is refused ------------------
  {
    const sp = join(DIR, "cas", "state.json");
    const its = [{ id: "cas1", when: when(T0), text: text("cas1") }];
    const A = mk(its, { storePath: sp, clock: T0 + MIN }); const B = mk(its, { storePath: sp, clock: T0 + MIN });
    await A.q.ready(); await B.q.ready();
    await sdb.documents.put(STATE_DOC_NAME, { v: 1, records: [], slots: [] }); // a row exists: the claim's write is an update at a version
    const stale = await A.q._stateStore.read();      // A reads (its lease then lapses)
    await B.q.tick();                                 // B claims and posts meanwhile
    ok(B.sent.length === 1, "B posts the item");
    stale.records.set("cas1", { id: "cas1", state: "sending", at: T0 + MIN, hour: hourOf(T0 + MIN) });
    let cls = null;
    try { await A.q._stateStore.write(stale); } catch (e) { cls = e.cls; }
    ok(cls === "conflict", `a claim written from a read the other container has moved past is refused (${cls})`);
    ok((await recOf("cas1"))?.state === "posted", "the other container's record stands");
    await A.q.tick();
    ok(A.sent.length === 0, "and A never sends it");
  }
  // ---- lease fencing: a tick whose lease was lost posts nothing more -------------
  {
    const sp = join(DIR, "fence", "state.json");
    const its = [{ id: "lf1", when: when(T0), text: text("lf1") }, { id: "lf2", when: when(T0), text: text("lf2") }];
    await sdb.documents.put(STATE_DOC_NAME, { v: 1, records: [], slots: [] });
    const realNow = Date.now;
    let armed = true;
    const F = mk(its, { storePath: sp, clock: T0 + MIN, post: async (tx) => {
      F.sent.push(tx);
      if (armed) { Date.now = () => realNow() + 2 * H; return { kind: "rejected", status: 403 }; } // the tick goes on to the next item
      return { kind: "posted", tweetId: "1" };
    } });
    await F.q.ready();
    try { await F.q.tick(); } finally { Date.now = realNow; }
    ok(F.sent.length === 1, `after the tick lease is lost no further post is sent (${F.sent.length})`);
    ok((await recOf("lf2")) === null, "the claim taken for the next item is handed back (no SENDING record is left)");
    armed = false;
    await F.q.tick();
    ok(F.sent.length === 2 && (await recOf("lf2"))?.state === "posted", "the next tick under a held lease posts it");
  }
} finally {
  await sdb.__dropStateSchema();
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} assertions, ${fail} failures`);
process.exit(fail ? 1 : 0);
