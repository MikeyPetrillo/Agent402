#!/usr/bin/env node
// The referral settlement book on the state database (src/referral-book.js
// over src/json-rows-document.js): a head row and one row per entry, written
// under the head's row lock.
//   - the old whole-book document is read once and folded into rows; nothing in it is lost;
//   - a whole-book section a build before this one writes during a deploy's overlap is folded too (a row wins);
//   - a write at 2,000 entries carries the entry it changes, not the book;
//   - two processes writing one book at once lose no write;
//   - another process's writes and deletions reach this one's copy;
//   - a change that throws, or edits an entry in place, fails alone.
// Requires STATE_DATABASE_URL (CI fails without it).
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { requireTestPg } from "./lib/test-pg.js";

const WORKER = process.argv[2] === "--worker";
if (!WORKER) requireTestPg({ label: "test-referral-book-pg" });
const sdb = await import("../src/state-db.js");
const { createReferralBook, REFERRAL_BOOK_DOC } = await import("../src/referral-book.js");
const { createJsonRowsDocument } = await import("../src/json-rows-document.js");
const { SKIP_UPDATE } = await import("../src/json-document.js");

const hex = (n) => `0x${randomBytes(n).toString("hex")}`;
const quiet = { error() {}, warn() {}, log() {} };
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const nowS = () => Math.floor(Date.now() / 1000);
const intentOf = (payer = hex(20)) => ({ key: `${hex(32)}#${hex(32)}`, slug: "echo", payer, nonce: hex(32), amount: "10000", validBefore: nowS() + 600 });

if (WORKER) {
  // One of two processes: N paid calls' book writes (the intent, then the charge), eight at a time.
  const n = Number(process.argv[3]), startAt = Number(process.argv[4]);
  const book = createReferralBook({ file: null, log: quiet, maxEntries: 100_000, maxPerPayer: 100_000 });
  await book.ready;
  while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 5));
  let i = 0, lost = 0, stood = 0;
  const keys = [];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < n) {
      i++;
      const e = intentOf();
      const a = await book.intent(e);
      const b = a && await book.resolve(e.key, { state: "charged-undelivered", tx: hex(32) });
      if (a && b) { stood++; keys.push(e.key); } else lost++;
    }
  }));
  process.stdout.write(`${JSON.stringify({ stood, lost, failed: book.writeStats().failed, keys })}\n`);
  await sdb.closeStateDb();
  process.exit(0);
}

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const rowsOf = async () => (await sdb.stateQuery(`SELECT id, body FROM ${sdb.stateDbSchema()}.records WHERE collection = $1`, [`${REFERRAL_BOOK_DOC}.rows`])).rows;
const headOf = async () => (await sdb.documents.get(REFERRAL_BOOK_DOC));

try {
  // ---- the old whole-book document is folded into rows at the first write ----
  const t = Date.now();
  const oldEntries = {}, oldSold = {}, oldDropped = {};
  for (let i = 0; i < 1990; i++) { const e = intentOf(`0x${String(i % 60).padStart(40, "0")}`); oldEntries[e.key] = { ...e, at: t, state: i % 3 ? "in-doubt" : "charged-undelivered", tx: i % 3 ? null : hex(32), attempts: 1, saleBooked: false, fromBlock: 1000 + i }; }
  for (let i = 0; i < 2000; i++) oldSold[`${hex(32)}#${hex(32)}`] = { tx: hex(32), payer: hex(20), slug: "echo", at: t };
  for (let i = 0; i < 5; i++) { const k = `${hex(32)}#${hex(32)}`; oldDropped[k] = { key: k, slug: "echo", payer: hex(20), nonce: hex(32), amount: "10000", validBefore: nowS() + 60, fromBlock: null, at: t }; }
  const oldBody = { entries: oldEntries, forgiven: [[t, 5000, ["a"]]], resolved: [{ key: "ack:x", at: t }], retired: [], closed: [], short: {}, proven: { echo: { fp: "f", at: t } }, sold: oldSold, dropped: oldDropped };
  await sdb.documents.put(REFERRAL_BOOK_DOC, oldBody);
  const book = createReferralBook({ file: null, log: quiet });
  await book.ready;
  const readOld = book.size() === 1990 && Object.keys(book.soldMarks()).length === 2000 && book.droppedRefused().count === 5;
  const first = intentOf();
  const wrote = await book.intent(first);
  const head = await headOf();
  const rows = await rowsOf();
  const byId = new Map(rows.map((r) => [r.id, r.body.b]));
  const intact = Object.entries(oldEntries).every(([k, v]) => canon(byId.get(`entries:${k}`)) === canon(v)) && Object.keys(oldSold).every((k) => byId.has(`sold:${k}`)) && Object.keys(oldDropped).every((k) => byId.has(`dropped:${k}`));
  ok(readOld && wrote && rows.length === 1991 + 2000 + 5 && intact && !("entries" in head.body) && !("sold" in head.body) && !("dropped" in head.body) && head.body.proven?.echo?.fp === "f" && head.body.forgiven.length === 1, `the old whole-book document is read as it stands and folded into rows by the first write: every entry, booked-payment mark and dropped record kept exactly (${rows.length} rows), the small sections stay in the head`);

  // ---- a write at 2,000 entries is the size of what it changes ----
  const sizes = [], times = [];
  for (let i = 0; i < 9; i++) { const e = intentOf(); const t0 = performance.now(); await book.intent(e); times.push(performance.now() - t0); sizes.push(book.writeStats().bytes); }
  const per = sizes.map((x, i) => x - (i ? sizes[i - 1] : sizes[0])).slice(1);
  times.sort((a, b) => a - b);
  console.log(`  (a write at ${book.size()} entries: ${Math.max(...per)} bytes at most, median ${times[4].toFixed(1)} ms)`);
  ok(book.size() === 2000 && per.every((b) => b > 0 && b < 2048), `a paid call's write at 2,000 open entries carries its own entry only (${Math.max(...per)} bytes at most, not the whole book)`);

  // ---- a build before this one writes a whole-book section during the overlap: folded, a row wins ----
  {
    const rowKey = first.key;
    const lateKey = `${hex(32)}#${hex(32)}`;
    const h = await headOf();
    // The older build's compare-and-set write: its own entries section (the one entry it wrote, and a stale copy of one that is a row).
    await sdb.stateQuery(`UPDATE ${sdb.stateDbSchema()}.documents SET body = $2::jsonb, version = version + 1 WHERE name = $1 AND version = $3`, [REFERRAL_BOOK_DOC, JSON.stringify({ ...h.body, entries: { [lateKey]: { key: lateKey, slug: "echo", payer: hex(20), state: "intent", at: 1 }, [rowKey]: { key: rowKey, state: "intent", stale: true } } }), h.version]);
    await book.ping();
    const after = await headOf();
    const rs = new Map((await rowsOf()).map((r) => [r.id, r.body.b]));
    ok(!("entries" in after.body) && rs.get(`entries:${lateKey}`)?.state === "intent" && rs.get(`entries:${rowKey}`)?.stale !== true && book.get(lateKey)?.state === "intent", "an entries section an older build writes into the head during a deploy's overlap is folded into rows by the next write; a row already standing for a key is kept as it is");
  }

  // ---- another process's writes and deletions reach this copy ----
  {
    const other = createReferralBook({ file: null, log: quiet, maxEntries: 100_000 });
    await other.ready;
    const e = intentOf();
    const gone = Object.keys(oldEntries)[0];
    await other.resolve(gone, null);
    const took = await other.intent(e);
    await book.ping();
    ok(took && book.get(e.key)?.state === "intent" && book.get(gone) === null && other.size() === book.size(), "a write and a removal made by another process's book are read into this one's copy by its next write (only the rows written since its version)");
  }

  // ---- a change that throws, or edits a stored value in place, fails alone ----
  {
    const doc = createJsonRowsDocument({ name: "rows-doc-test", parts: ["items"], log: () => {} });
    const r1 = await doc.update(() => ({ items: { a: { n: 1 }, b: { n: 2 } }, note: "x" }));
    const inPlace = await doc.update((body) => { body.items.a.n = 9; return body; });
    const thrown = await doc.update(() => { throw new Error("a change that throws"); });
    const skipped = await doc.update(() => SKIP_UPDATE);
    const body = await doc.load(null);
    ok(r1.ok && inPlace.ok === false && thrown.ok === false && skipped.ok && skipped.changed === false && body.items.a.n === 1 && body.items.b.n === 2 && body.note === "x", `a change that edits a stored entry in place is refused (never written half-seen), one that throws rolls back, and the document is as the last good write left it (${inPlace.error})`);
  }

  // ---- two processes writing one book at once lose no write ----
  {
    const startAt = Date.now() + 2500;
    const run = () => new Promise((resolve) => {
      const p = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker", "150", String(startAt)], { env: process.env, stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      p.on("exit", () => { try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch { resolve({ stood: 0, lost: -1, keys: [] }); } });
    });
    const [a, b] = await Promise.all([run(), run()]);
    const rs = new Map((await rowsOf()).map((r) => [r.id, r.body.b]));
    const landed = [...a.keys, ...b.keys].filter((k) => rs.get(`entries:${k}`)?.state === "charged-undelivered").length;
    ok(a.stood === 150 && b.stood === 150 && a.lost === 0 && b.lost === 0 && a.failed === 0 && b.failed === 0 && landed === 300, `two processes writing one book of 2,000 entries at once, eight calls at a time each: every intent and charge stands and is in the rows (${a.stood} + ${b.stood} stood, ${a.lost + b.lost} lost, ${landed} charged rows)`);
  }
} finally {
  await sdb.stateQuery(`DROP SCHEMA IF EXISTS ${sdb.stateDbSchema()} CASCADE`).catch(() => {});
  await sdb.closeStateDb().catch(() => {});
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
