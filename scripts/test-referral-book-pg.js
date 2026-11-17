#!/usr/bin/env node
// The referral settlement book on the state database (src/referral-book.js
// over src/json-rows-document.js): a head row and one row per entry, written
// under the head's row lock.
//   - the old whole-book document is read once and folded into rows; nothing in it is lost;
//   - a deploy's overlap with the build before rows, run as its own process
//     (that build's code from git when this clone holds it): each build sees
//     the entries the other writes, closes and changes, and an entry the older
//     build closed after this one made it a row is never left open;
//   - a write at 2,000 entries carries the entry it changes, not the book (mirror off);
//   - two processes writing one book at once lose no write;
//   - the mirror turned off beside a process that still writes it: a write of
//     rows alone leaves no whole body in the head for a later reader to take
//     as the book, and no entry, mark or record written by either is lost;
//   - another process's writes and deletions reach this one's copy;
//   - a change that throws, or edits an entry in place, fails alone.
// Requires STATE_DATABASE_URL (CI fails without it).
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { spawn, fork, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireTestPg } from "./lib/test-pg.js";
import { childJson } from "./lib/child-json.js";

const WORKER = process.argv[2] === "--worker";
const DOC_WORKER = process.argv[2] === "--doc-worker";
const OLD_WORKER = process.argv[2] === "--old-worker";
// The last build that kept the book as one whole document (its code is read from git when the clone holds it).
const OLD_BUILD_REF = "4f4d9c8606f7995de9e18a82d2288f0585cd3039";
if (OLD_WORKER) {
  // The build before rows, as a process of its own: its book over its own
  // whole-document store, driven by the parent one call at a time.
  const quietOld = { error() {}, warn() {}, log() {} };
  const dir = process.argv[3];
  let book, close;
  if (dir === "sim") {
    // No old code in this clone: this build's book over the whole-document store it used then (the same compare-and-set write of the whole body).
    const [{ createReferralBook: make, REFERRAL_BOOK_DOC: DOC }, { createJsonDocument }, sdbOld] = await Promise.all([import("../src/referral-book.js"), import("../src/json-document.js"), import("../src/state-db.js")]);
    book = make({ doc: createJsonDocument({ name: DOC, file: null, log: () => {} }), log: quietOld, maxEntries: 100_000, maxPerPayer: 100_000 });
    close = () => sdbOld.closeStateDb();
  } else {
    const [{ createReferralBook: make }, sdbOld] = await Promise.all([import(pathToFileURL(join(dir, "src/referral-book.js")).href), import(pathToFileURL(join(dir, "src/state-db.js")).href)]);
    book = make({ file: null, log: quietOld, maxEntries: 100_000, maxPerPayer: 100_000 });
    close = () => sdbOld.closeStateDb();
  }
  await book.ready;
  process.on("message", async ({ id, op, args = [] }) => {
    let out = null;
    try {
      if (op === "intent") out = await book.intent(args[0]);
      else if (op === "resolve") out = await book.resolve(args[0], args[1]);
      else if (op === "get") { await book.ping(); out = book.get(args[0]); }
      else if (op === "close") { await close(); out = true; }
    } catch (e) { out = { error: String(e?.message || e) }; }
    process.send({ id, out });
    if (op === "close") process.exit(0);
  });
  process.send({ ready: true });
  await new Promise(() => {}); // (driven by messages until "close")
}
if (!WORKER && !OLD_WORKER && !DOC_WORKER) requireTestPg({ label: "test-referral-book-pg" });
const sdb = await import("../src/state-db.js");
const { createReferralBook, REFERRAL_BOOK_DOC, REFERRAL_BOOK_PARTS } = await import("../src/referral-book.js");
const { createJsonRowsDocument, ROWS_MARK } = await import("../src/json-rows-document.js");
const { SKIP_UPDATE } = await import("../src/json-document.js");

const hex = (n) => `0x${randomBytes(n).toString("hex")}`;
const quiet = { error() {}, warn() {}, log() {} };
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const nowS = () => Math.floor(Date.now() / 1000);
const intentOf = (payer = hex(20)) => ({ key: `${hex(32)}#${hex(32)}`, slug: "echo", payer, nonce: hex(32), amount: "10000", validBefore: nowS() + 600 });

if (DOC_WORKER) {
  // One of two processes on one rows document, its mirror on or off: N changes made in place
  // (the head's small sections as they were read, so a write carries rows alone), every third one a removal too.
  const [mirror, name, n, startAt, tag] = [process.argv[3] === "on", process.argv[4], Number(process.argv[5]), Number(process.argv[6]), process.argv[7]];
  const doc = createJsonRowsDocument({ name, parts: ["items"], mirror, log: () => {} });
  while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 5));
  const kept = [], removed = [];
  let failedWrites = 0;
  for (let i = 0; i < n; i++) {
    const k = `${tag}-${i}`;
    const gone = i % 3 === 2 ? kept.shift() : null;
    const r = await doc.update((body) => { body.items[k] = { by: tag, i }; if (gone) delete body.items[gone]; });
    if (!r.ok) { failedWrites++; if (gone) kept.unshift(gone); continue; }
    kept.push(k);
    if (gone) removed.push(gone);
  }
  process.stdout.write(`${JSON.stringify({ kept, removed, failed: failedWrites, headWrites: doc.rowStats().headWrites })}\n`);
  await sdb.closeStateDb();
  process.exit(0);
}
if (WORKER) {
  // One of two processes: N paid calls' book writes (the intent, then the charge), eight at a time.
  const n = Number(process.argv[3]), startAt = Number(process.argv[4]);
  // (With a mirror word and a document name: a book of its own, the mirror on or off.)
  const mirrorArg = process.argv[5] || null, docArg = process.argv[6] || null;
  const book = createReferralBook({ ...(mirrorArg ? { doc: createJsonRowsDocument({ name: docArg, parts: REFERRAL_BOOK_PARTS, mirror: mirrorArg === "on", log: () => {} }) } : { file: null }), log: quiet, maxEntries: 100_000, maxPerPayer: 100_000 });
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
  const mirrorWhole = Object.keys(head.body.entries || {}).length === 1991 && Object.keys(head.body.sold || {}).length === 2000 && Object.keys(head.body.dropped || {}).length === 5 && head.body[ROWS_MARK] === head.version;
  ok(readOld && wrote && rows.length === 1991 + 2000 + 5 && intact && mirrorWhole && head.body.proven?.echo?.fp === "f" && head.body.forgiven.length === 1, `the old whole-book document is read as it stands and folded into rows by the first write: every entry, booked-payment mark and dropped record kept exactly (${rows.length} rows); the head keeps the small sections and, for the overlap release, the whole body marked with its version`);

  // ---- a deploy's overlap: the build before rows, as its own process, beside this one ----
  {
    let oldDir = "sim";
    try {
      const repo = fileURLToPath(new URL("..", import.meta.url));
      execFileSync("git", ["cat-file", "-e", `${OLD_BUILD_REF}^{commit}`], { cwd: repo, stdio: "ignore" });
      oldDir = mkdtempSync(join(tmpdir(), "a402-old-book-"));
      execFileSync("sh", ["-c", `git archive ${OLD_BUILD_REF} src scripts package.json | tar -x -C "${oldDir}"`], { cwd: repo, stdio: "ignore" });
      symlinkSync(join(repo, "node_modules"), join(oldDir, "node_modules"));
    } catch { if (oldDir !== "sim") { try { rmSync(oldDir, { recursive: true, force: true }); } catch { /* temp */ } } oldDir = "sim"; }
    console.log(`  (the older build: ${oldDir === "sim" ? "this build's book over the whole-document store (the old commit is not in this clone)" : `commit ${OLD_BUILD_REF.slice(0, 9)}`})`);
    const child = fork(fileURLToPath(import.meta.url), ["--old-worker", oldDir], { env: process.env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    let seq = 0;
    const waiting = new Map();
    let readyOld;
    const isReady = new Promise((r) => { readyOld = r; });
    child.on("message", (m) => { if (m?.ready) readyOld(true); else if (waiting.has(m?.id)) { waiting.get(m.id)(m.out); waiting.delete(m.id); } });
    // (A process that ends early fails what waits on it, never hangs the suite.)
    child.on("exit", () => { readyOld(false); for (const r of waiting.values()) r({ error: "the older build's process ended" }); waiting.clear(); });
    const old = (op, ...args) => new Promise((r) => { const id = ++seq; waiting.set(id, r); child.send({ id, op, args }); });
    try {
      if (!(await isReady)) throw new Error("the older build's process did not start");
      const soldBefore = (await rowsOf()).filter((r) => r.id.startsWith("sold:")).length;
      // 1. The older build writes an intent; this build's next write makes it a row; the older build then closes it.
      const k = intentOf();
      const oWrote = await old("intent", k);
      await book.intent(intentOf());
      const isRow = (await rowsOf()).some((r) => r.id === `entries:${k.key}`);
      const oClosed = await old("resolve", k.key, null);
      await book.ping();
      const closedRow = (await rowsOf()).some((r) => r.id === `entries:${k.key}`);
      ok(oWrote === true && isRow && oClosed === true && book.get(k.key) === null && !closedRow, `an entry the older build writes, this build makes a row, and the older build then closes is closed here too: no open intent is left for the sweep to read as charged and not served (row before close ${isRow}, after ${closedRow}; here ${JSON.stringify(book.get(k.key))})`);
      // 2. This build's change is seen by the older build.
      const j = intentOf();
      await book.intent(j);
      await book.resolve(j.key, { state: "charged-undelivered", tx: hex(32) });
      const seen = await old("get", j.key);
      ok(seen?.state === "charged-undelivered", `an entry this build writes and charges is read by the older build as it stands (${seen?.state})`);
      // 3. The older build changes an entry that is a row here: its value is taken.
      const l = intentOf();
      await book.intent(l);
      const oPatched = await old("resolve", l.key, { state: "in-doubt", attempts: 2 });
      await book.ping();
      const lRow = new Map((await rowsOf()).map((r) => [r.id, r.body.b])).get(`entries:${l.key}`);
      ok(oPatched === true && book.get(l.key)?.state === "in-doubt" && lRow?.state === "in-doubt" && lRow?.attempts === 2, `a change the older build makes to an entry after this build wrote its row is taken here and into the row (${lRow?.state})`);
      // 4. Nothing else moved: every booked-payment mark stands through the older build's writes.
      const soldAfter = (await rowsOf()).filter((r) => r.id.startsWith("sold:")).length;
      ok(soldBefore === 2000 && soldAfter === soldBefore && book.get(j.key)?.state === "charged-undelivered", `the older build's whole-body writes keep every booked-payment mark and this build's own entries (${soldAfter} marks)`);
      await old("close");
    } finally {
      try { child.kill(); } catch { /* gone */ }
      if (oldDir !== "sim") { try { rmSync(oldDir, { recursive: true, force: true }); } catch { /* temp */ } }
    }
  }

  // ---- a write at 2,000 entries is the size of what it changes (the mirror off, as the next release runs) ----
  {
    const SIZE_DOC = "referral-size-test";
    await sdb.documents.put(SIZE_DOC, oldBody);
    const lean = createReferralBook({ doc: createJsonRowsDocument({ name: SIZE_DOC, parts: REFERRAL_BOOK_PARTS, mirror: false, log: () => {} }), log: quiet });
    await lean.ready;
    await lean.intent(intentOf());
    const sizes = [], times = [];
    for (let i = 0; i < 9; i++) { const e = intentOf(); const t0 = performance.now(); await lean.intent(e); times.push(performance.now() - t0); sizes.push(lean.writeStats().bytes); }
    const per = sizes.map((x, i) => x - (i ? sizes[i - 1] : sizes[0])).slice(1);
    times.sort((a, b) => a - b);
    console.log(`  (a write at ${lean.size()} entries: ${Math.max(...per)} bytes at most, median ${times[4].toFixed(1)} ms)`);
    ok(lean.size() === 2000 && per.every((b) => b > 0 && b < 2048), `with the mirror off, a paid call's write at 2,000 open entries carries its own entry only (${Math.max(...per)} bytes at most, not the whole book)`);
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

  // ---- the mirror turned off: a write of rows alone leaves nothing in the head a reader takes as the book ----
  {
    const DOC = "referral-mirror-off-test";
    const rowsIn = async () => new Map((await sdb.stateQuery(`SELECT id, body FROM ${sdb.stateDbSchema()}.records WHERE collection = $1`, [`${DOC}.rows`])).rows.map((r) => [r.id, r.body.b]));
    const mk = (mirror) => createReferralBook({ doc: createJsonRowsDocument({ name: DOC, parts: REFERRAL_BOOK_PARTS, mirror, log: () => {} }), log: quiet, maxEntries: 100_000, maxPerPayer: 100_000 });
    // A process with the mirror on writes the book: two entries and a booked-payment mark.
    const on = mk(true);
    await on.ready;
    const e1 = intentOf(), e2 = intentOf(), e3 = intentOf(), e4 = intentOf(), e5 = intentOf();
    await on.intent(e1); await on.intent(e2);
    await on.noteSold(e2.key, { tx: hex(32), payer: e2.payer, slug: "echo" });
    const headOn = await sdb.documents.get(DOC);
    // A process with the mirror off writes rows alone: a new entry, a mark, a charge, and it closes one.
    const off = mk(false);
    await off.ready;
    const wroteOff = (await off.intent(e3)) && (await off.resolve(e3.key, { state: "charged-undelivered", tx: hex(32) }));
    await off.noteSold(e3.key, { tx: hex(32), payer: e3.payer, slug: "echo" });
    await off.resolve(e1.key, null);
    const headOff = await sdb.documents.get(DOC);
    const noStaleBody = !(ROWS_MARK in headOff.body) && REFERRAL_BOOK_PARTS.every((p) => !(p in headOff.body));
    // A third process (either setting) reads and writes next; then each of the first two writes again.
    const results = {};
    for (const mirror of [true, false]) {
      const next = mk(mirror);
      await next.ready;
      const seen = next.get(e3.key)?.state === "charged-undelivered" && next.get(e1.key) === null && !!next.soldMarks()[e3.key];
      const e = mirror ? e4 : e5;
      const took = await next.intent(e);
      const rs = await rowsIn();
      results[mirror ? "on" : "off"] = seen && took && rs.get(`entries:${e3.key}`)?.state === "charged-undelivered" && rs.has(`sold:${e3.key}`) && rs.has(`sold:${e2.key}`) && rs.has(`entries:${e2.key}`) && !rs.has(`entries:${e1.key}`) && rs.has(`entries:${e.key}`);
    }
    await on.ping(); await off.ping();
    const same = on.size() === 4 && off.size() === 4 && on.get(e1.key) === null && off.get(e1.key) === null && on.get(e3.key)?.state === "charged-undelivered" && off.get(e4.key)?.state === "intent";
    ok(headOn.body[ROWS_MARK] === headOn.version && wroteOff && noStaleBody && results.on && results.off && same, `after a write with the mirror on, a write of rows alone with the mirror off leaves no whole body in the head, and the next process's write (mirror on or off) keeps the entry, the charge and the mark it wrote and does not bring back the entry it closed (head clean: ${noStaleBody}; next with mirror: ${results.on}, without: ${results.off}; both copies agree: ${same})`);

    // The same at the document itself, where a change made in place leaves the head's text as it was read,
    // so the write after a read carries rows alone (the book's own head is written in another key order).
    {
      const NAME = "rows-mirror-off-test";
      const itemsIn = async () => new Map((await sdb.stateQuery(`SELECT id, body FROM ${sdb.stateDbSchema()}.records WHERE collection = $1`, [`${NAME}.rows`])).rows.map((r) => [r.id, r.body.b]));
      const docOn = createJsonRowsDocument({ name: NAME, parts: ["items"], mirror: true, log: () => {} });
      await docOn.update(() => ({ items: { a: { n: 1 }, b: { n: 2 } }, note: "x" }));
      const docOff = createJsonRowsDocument({ name: NAME, parts: ["items"], mirror: false, log: () => {} });
      const w1 = await docOff.update((body) => { body.items.c = { n: 3 }; delete body.items.a; });
      const w2 = await docOff.update((body) => { body.items.d = { n: 4 }; });
      const headAfter = await sdb.documents.get(NAME);
      const clean = !(ROWS_MARK in headAfter.body) && !("items" in headAfter.body) && headAfter.body.note === "x";
      const third = createJsonRowsDocument({ name: NAME, parts: ["items"], mirror: false, log: () => {} });
      const read3 = await third.load(null);
      const w3 = await third.update((body) => { body.items.e = { n: 5 }; });
      const w4 = await docOn.update((body) => { body.items.f = { n: 6 }; });
      const w5 = await docOff.update((body) => { body.items.g = { n: 7 }; });
      const items = await itemsIn();
      const ids = [...items.keys()].sort().join(",");
      ok(w1.ok && w2.ok && w3.ok && w4.ok && w5.ok && clean && Object.keys(read3.items).sort().join() === "b,c,d" && ids === "items:b,items:c,items:d,items:e,items:f,items:g" && Object.keys(w5.body.items).sort().join() === "b,c,d,e,f,g" && third.rowStats().folded === 0 && docOff.rowStats().headWrites === 2, `a document's write of rows alone with the mirror off, after a write that carried the mirror, rewrites the head without it, once for each such write (its own later writes carry rows alone): the next reader takes the rows, keeps what was added and does not bring back what was removed (rows: ${ids}; head clean: ${clean}; head writes with the mirror off: ${docOff.rowStats().headWrites})`);
      const startDocs = Date.now() + 2500;
      const runDoc = (mirror, tag) => new Promise((resolve) => {
        const p = spawn(process.execPath, [fileURLToPath(import.meta.url), "--doc-worker", mirror, NAME, "150", String(startDocs), tag], { env: process.env, stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        p.stdout.on("data", (d) => { out += d; });
        p.on("close", () => { try { resolve(childJson(out)); } catch { resolve({ kept: [], removed: [], failed: -1 }); } });
      });
      const [pa, pb] = await Promise.all([runDoc("on", "p"), runDoc("off", "q")]);
      // (Then the mirror off alone: two more writers, and a reader that never saw the document.)
      const [pc, pd] = await Promise.all([runDoc("off", "r"), runDoc("off", "s")]);
      const fresh = await createJsonRowsDocument({ name: NAME, parts: ["items"], mirror: false, log: () => {} }).load(null);
      const after = await itemsIn();
      const all = [pa, pb, pc, pd];
      const keptAll = all.flatMap((x) => x.kept), removedAll = all.flatMap((x) => x.removed);
      const missing = keptAll.filter((k) => !after.has(`items:${k}`) || !fresh.items[k]).length;
      const back = removedAll.filter((k) => after.has(`items:${k}`) || fresh.items[k]).length;
      ok(all.every((x) => x.failed === 0) && keptAll.length === 400 && removedAll.length === 200 && missing === 0 && back === 0 && after.size === 6 + 400 && Object.keys(fresh.items).length === 406, `two processes changing one document at once, one with the mirror on and one with it off, then two with it off: no row either wrote is lost and none either removed returns (${keptAll.length} kept, ${missing} missing; ${removedAll.length} removed, ${back} back; ${after.size} rows)`);
    }

    // Two processes at once on one book, one with the mirror on and one with it off: no write of either is lost.
    const startAt = Date.now() + 2500;
    const run = (mirror) => new Promise((resolve) => {
      const p = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker", "120", String(startAt), mirror, DOC], { env: process.env, stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      p.on("close", () => { try { resolve(childJson(out)); } catch { resolve({ stood: 0, lost: -1, keys: [] }); } });
    });
    const [a, b] = await Promise.all([run("on"), run("off")]);
    // (Then the mirror is off everywhere: a last process without it writes, and one more reads.)
    const last = mk(false);
    await last.ready;
    const e6 = intentOf();
    await last.intent(e6);
    const reader = mk(false);
    await reader.ready;
    const rs = await rowsIn();
    const landed = [...a.keys, ...b.keys].filter((k) => rs.get(`entries:${k}`)?.state === "charged-undelivered" && reader.get(k)?.state === "charged-undelivered").length;
    ok(a.stood === 120 && b.stood === 120 && a.lost === 0 && b.lost === 0 && a.failed === 0 && b.failed === 0 && landed === 240 && reader.size() === 4 + 240 + 1 && rs.has(`sold:${e3.key}`), `two processes writing one book at once, one with the mirror on and one with it off, then the mirror off alone: every intent and charge of both stands in the rows and in a later reader's copy (${a.stood} + ${b.stood} stood, ${a.lost + b.lost} lost, ${landed} charged rows, ${reader.size()} entries)`);
  }

  // ---- two processes writing one book at once lose no write ----
  {
    const startAt = Date.now() + 2500;
    const run = () => new Promise((resolve) => {
      const p = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker", "150", String(startAt)], { env: process.env, stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      // The result line wherever it lands among the child's own log lines, read once its output has closed.
      p.on("close", () => { try { resolve(childJson(out)); } catch { resolve({ stood: 0, lost: -1, keys: [] }); } });
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
