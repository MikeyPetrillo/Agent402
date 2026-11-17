// The sanctions lists' stored copies on a REAL Postgres (production's
// backend): json-document saveSerialized() sends the text its caller built
// across turns as the row (no second serialization in one turn) and writes
// the write-through file off the event loop, so neither a large list nor a
// busy disk holds the loop. Pinned here:
//   - the row and the write-through file of a body saved in pieces are the
//     ones save() stores for the same body, byte for byte, sidecar included
//     (a rollback to the previous build reads the same file);
//   - on a disk whose synchronous writes stall, save() holds the loop for the
//     stall (the control) and saveSerialized() makes no synchronous write;
//   - the worst turn of the tools' payout copy, adopted and stored through
//     the real kit at a production-sized list on that disk, stays under the
//     bound;
//   - saves issued together land in order: the row and the file end on the
//     last body, with the sidecar naming the row's version;
//   - a write-through that fails is logged once, the save still resolves on
//     the row's verdict, and nothing rejects unhandled;
//   - a save the database refused is kept WITH its pieces: the retry that
//     lands makes no synchronous write either.
// Requires STATE_DATABASE_URL (CI fails without it).
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requireTestPg } from "./lib/test-pg.js";
import { bound, gapMeter } from "./lib/ours-clock.js";
import { stallSyncWrites } from "./lib/stalled-disk.js";
import { startPgRelay } from "./lib/pg-relay.js";
const { url } = requireTestPg({ label: "test-sanctions-store-pg" });
// Through a relay, so the last section can cut the database mid-save.
const relay = await startPgRelay(url);
process.env.STATE_DATABASE_URL = relay.url;
process.env.STATE_DB_CONNECT_TIMEOUT_MS = "1000";
process.env.STATE_STORE_RETRY_MS = "300";
process.env.STATE_STORE_RETRY_MAX_MS = "600";
const DIR = mkdtempSync(join(tmpdir(), "sanctions-store-pg-"));
process.env.SANCTIONS_PAYOUT_FILE = join(DIR, "kit", "payout.json");
mkdirSync(join(DIR, "kit"));
const sdb = await import("../src/state-db.js");
const { createJsonDocument } = await import("../src/json-document.js");
const { runSliced, storedBodySteps, __holdSdnListForTests, __resetSdnListForTests } = await import("../src/ofac-sdn.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const settle = () => new Promise((r) => setTimeout(r, 10));
const rowOf = async (name) => (await sdb.stateQuery(`SELECT body, version FROM ${sdb.stateDbSchema()}.documents WHERE name = $1`, [name])).rows[0] || null;
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));
const turn = bound(60, 3);
const row = (i) => ({ address: "0x" + String(i).padStart(40, "0"), asset: "ETH", entity: `ENTITY ${i} & CO é"`, sdnId: String(i) });
const piecesOf = (head, rows) => runSliced(storedBodySteps(head, "addresses", rows));

try {
  // ---- (1) the same row, the same file, the same sidecar as save() ---------
  {
    const rows = Array.from({ length: 5000 }, (_, i) => row(i));
    const head = { v: 1, fetchedAt: 1700000000000, publishDate: "11/14/2026", gone: undefined };
    const { body, pieces } = await piecesOf(head, rows);
    const fa = join(DIR, "whole.json"), fb = join(DIR, "pieces.json");
    const a = createJsonDocument({ name: "t-whole.json", file: fa, log: () => {} });
    const b = createJsonDocument({ name: "t-pieces.json", file: fb, log: () => {} });
    ok(a.backend === "pg" && b.backend === "pg", "the documents are on the database");
    ok((await a.save(body)) === true && (await b.saveSerialized(body, pieces)) === true, "both saves resolve true");
    await a.flush(); await b.flush();
    const ra = await rowOf("t-whole.json"), rb = await rowOf("t-pieces.json");
    ok(rb && JSON.stringify(rb.body) === JSON.stringify(ra.body) && rb.body.addresses.length === 5000, "the row stored from pieces is the row save() stores");
    const rawA = readFileSync(fa, "utf8"), rawB = readFileSync(fb, "utf8");
    ok(rawA === rawB && rawB === JSON.stringify(body), "the write-through file is byte for byte the one save() writes");
    const ma = JSON.parse(readFileSync(`${fa}.rowmark`, "utf8")), mb = JSON.parse(readFileSync(`${fb}.rowmark`, "utf8"));
    ok(readFileSync(`${fa}.rowmark`, "utf8") === readFileSync(`${fb}.rowmark`, "utf8") && mb.version === Number(rb.version) && mb.sha256 === sha256(rawB) && ma.sha256 === mb.sha256,
      "its sidecar names the row's version and the hash of the bytes written, as save()'s does");
    ok(!readFileSync(join(DIR, "pieces.json"), "utf8").includes("undefined") && !existsSync(`${fb}.${process.pid}.p1.tmp`), "no temp file is left behind");
    // A second document on the same row reads what was stored.
    const again = createJsonDocument({ name: "t-pieces.json", file: fb, log: () => {} });
    ok((await again.load(null))?.addresses?.[4999]?.sdnId === "4999", "a load reads the body back");
  }

  // ---- (2) a disk whose synchronous writes stall ----------------------------
  {
    const rows = Array.from({ length: 40_000 }, (_, i) => row(i));
    const { body, pieces } = await piecesOf({ v: 1, fetchedAt: 1 }, rows);
    const dir = join(DIR, "stalled"); mkdirSync(dir);
    const disk = stallSyncWrites([dir], turn.ms * 2);
    try {
      const ctl = createJsonDocument({ name: "t-stall-ctl.json", file: join(dir, "ctl.json"), log: () => {} });
      await settle();
      let m = gapMeter(1);
      await ctl.save(body); await ctl.flush();
      await settle();
      const ctlGap = m.stop();
      ok(disk.stalls >= 1 && ctlGap.worst > turn.ms, `control: save()'s write-through on the stalled disk holds the loop ${Math.round(ctlGap.worst)} ms over ${disk.stalls} synchronous writes (${turn.note})`);
      const before = disk.stalls;
      const doc = createJsonDocument({ name: "t-stall.json", file: join(dir, "doc.json"), log: () => {} });
      await settle();
      m = gapMeter(1);
      const stored = await doc.saveSerialized(body, pieces); await doc.flush();
      await settle();
      const gap = m.stop();
      ok(stored === true && disk.stalls === before && gap.worst < turn.ms, `saveSerialized() of the same 40,000 rows makes ${disk.stalls - before} synchronous writes and its worst turn is ${Math.round(gap.worst)} ms (${turn.note})`);
      ok(readFileSync(join(dir, "doc.json"), "utf8") === readFileSync(join(dir, "ctl.json"), "utf8") && (await rowOf("t-stall.json")).body.addresses.length === 40_000, "the row and the file hold the body");
    } finally { disk.restore(); }
  }

  // ---- (3) the tools' payout copy through the real kit, production-sized ----
  {
    const kit = await import("../src/tools/sanctions-kit.js");
    kit.__resetSanctionsForTests();
    await kit.startSanctionsPayoutStore();
    // 20,000 entries of two addresses each (production holds about 20,000
    // entries; its digital currency addresses are far fewer).
    const entries = Array.from({ length: 20_000 }, (_, i) => ({ uid: String(i), lastName: `ENTITY ${i}`, firstName: null, name: `ENTITY ${i}`, sdnType: "Entity", programs: ["SDGT"], addresses: [0, 1].map((k) => ({ asset: "ETH", address: "0x" + String(i * 2 + k).padStart(40, "0") })) }));
    __holdSdnListForTests({ entries, digitalCurrencyIds: 40_000, publishDate: "11/14/2026", bytes: 0, fetchedAt: Date.now() });
    const disk = stallSyncWrites([join(DIR, "kit")], turn.ms * 2);
    let gap, stored;
    try {
      await settle();
      const m = gapMeter(1);
      await kit.loadSanctions({ force: true });
      stored = await kit.__payoutWriteForTests();
      await kit.__payoutDocForTests().flush();
      await settle();
      gap = m.stop();
    } finally { disk.restore(); }
    const st = kit.sanctionsStatus();
    const r = await rowOf("sanctions-payout-addresses.json");
    ok(st.payoutScreen.addresses === 40_000 && stored === true && r?.body?.addresses?.length === 40_000, `the kit adopts the list and its payout copy lands in the row (${r?.body?.addresses?.length} addresses)`);
    ok(disk.stalls === 0 && gap.worst < turn.ms, `adopting and storing it on the stalled disk makes ${disk.stalls} synchronous writes; worst turn ${Math.round(gap.worst)} ms (${turn.note})`);
    const raw = readFileSync(process.env.SANCTIONS_PAYOUT_FILE, "utf8");
    ok(isDeepStrictEqual(JSON.parse(raw), r.body) && JSON.parse(readFileSync(`${process.env.SANCTIONS_PAYOUT_FILE}.rowmark`, "utf8")).sha256 === sha256(raw), "its write-through file holds the row's body, with the sidecar");

    // Store writes started together land in order: an older, larger map first,
    // a newer, smaller one second; the newer one stands in the row and the file.
    kit.__seedPayoutListForTests(Array.from({ length: 60_000 }, (_, i) => row(i)), { fetchedAt: 111 });
    const first = kit.__storePayoutForTests();
    kit.__seedPayoutListForTests([row(1), row(2), row(3)], { fetchedAt: 222 });
    const second = kit.__storePayoutForTests();
    ok((await second) === true && (await first) === true, "two store writes started together both resolve true");
    await kit.__payoutDocForTests().flush();
    await settle();
    const r2 = await rowOf("sanctions-payout-addresses.json");
    const f2 = JSON.parse(readFileSync(process.env.SANCTIONS_PAYOUT_FILE, "utf8"));
    ok(r2.body.fetchedAt === 222 && r2.body.addresses.length === 3 && f2.fetchedAt === 222 && f2.addresses.length === 3, `the map adopted last stands in the row (fetchedAt ${r2.body.fetchedAt}) and in the file (${f2.fetchedAt}), not the older one that took longer to serialize`);
    kit.__resetSanctionsForTests(); __resetSdnListForTests();
  }

  // ---- (4) the document's own ordering: saves issued together ---------------
  {
    const file = join(DIR, "order.json");
    const doc = createJsonDocument({ name: "t-order.json", file, log: () => {} });
    const big = await piecesOf({ v: 1, n: "big" }, Array.from({ length: 30_000 }, (_, i) => row(i)));
    const mid = await piecesOf({ v: 1, n: "mid" }, Array.from({ length: 3000 }, (_, i) => row(i)));
    const last = await piecesOf({ v: 1, n: "last" }, [row(7)]);
    const all = await Promise.all([doc.saveSerialized(big.body, big.pieces), doc.saveSerialized(mid.body, mid.pieces), doc.saveSerialized(last.body, last.pieces)]);
    await doc.flush();
    const r = await rowOf("t-order.json");
    const raw = readFileSync(file, "utf8");
    const mark = JSON.parse(readFileSync(`${file}.rowmark`, "utf8"));
    ok(all.every((x) => x === true) && r.body.n === "last", "three saves issued together: the row ends on the last body");
    ok(raw === JSON.stringify(last.body) && mark.version === Number(r.version) && mark.sha256 === sha256(raw), "...and so does the file, a large earlier body's slower write never landing over it; the sidecar names the row's final version");
    // One at a time, each awaited: every body is written through in turn.
    await doc.saveSerialized(big.body, big.pieces); await doc.saveSerialized(mid.body, mid.pieces);
    await doc.flush();
    ok(readFileSync(file, "utf8") === JSON.stringify(mid.body) && JSON.parse(readFileSync(`${file}.rowmark`, "utf8")).version === Number((await rowOf("t-order.json")).version), "saves awaited one after another leave the last one in the file");
  }

  // ---- (5) a write-through that fails ---------------------------------------
  {
    const dir = join(DIR, "blocked"); mkdirSync(dir);
    const file = join(dir, "doc.json");
    mkdirSync(file); // the store's path is a directory: the rename over it fails
    const lines = [];
    const doc = createJsonDocument({ name: "t-blocked.json", file, log: (m) => lines.push(m) });
    const p = await piecesOf({ v: 1 }, [row(1)]);
    const s1 = await doc.saveSerialized(p.body, p.pieces);
    const s2 = await doc.saveSerialized(p.body, p.pieces);
    const flushed = await doc.flush();
    await settle();
    ok(s1 === true && s2 === true && flushed === true && (await rowOf("t-blocked.json")).body.addresses.length === 1, "the save resolves on the row's verdict when the write-through fails");
    ok(lines.filter((l) => /write-through to .* failed/.test(l)).length === 1, `the failed write-through is logged once (${lines.length} lines)`);
    ok(!existsSync(`${file}.rowmark`) && !readdirSync(dir).some((f) => f.endsWith(".tmp")), "no sidecar and no temp file are left for a file that was not written");
    ok(unhandled.length === 0, `nothing rejected unhandled (${unhandled.length})`);
    // A document with no directory for its file (production: no volume) writes none.
    const none = createJsonDocument({ name: "t-novolume.json", file: join(DIR, "absent", "doc.json"), log: () => {} });
    ok((await none.saveSerialized(p.body, p.pieces)) === true && (await none.flush()) === true && !existsSync(join(DIR, "absent")), "with no directory for the file the row is stored and no directory is made");
  }

  // ---- (6) a save the database refused keeps its pieces for the retry -------
  {
    const dir = join(DIR, "outage"); mkdirSync(dir);
    const file = join(dir, "doc.json");
    const doc = createJsonDocument({ name: "t-outage.json", file, log: () => {}, failLog: () => {} });
    const first = await piecesOf({ v: 1, n: "first" }, [row(1)]);
    ok((await doc.saveSerialized(first.body, first.pieces)) === true, "a first save lands");
    await doc.flush();
    const p = await piecesOf({ v: 1, n: "kept" }, Array.from({ length: 40_000 }, (_, i) => row(i)));
    const disk = stallSyncWrites([dir], turn.ms * 2);
    try {
      relay.cut();
      const refused = await doc.saveSerialized(p.body, p.pieces);
      ok(refused === false && doc.lastError, "a save during an outage resolves false and is kept");
      relay.heal();
      await settle();
      const m = gapMeter(1);
      let flushed = false;
      for (let i = 0; i < 40 && !flushed; i++) { flushed = await doc.flush(); if (!flushed) await new Promise((r) => setTimeout(r, 200)); }
      await settle();
      const gap = m.stop();
      const r = await rowOf("t-outage.json");
      ok(flushed && r?.body?.n === "kept" && r.body.addresses.length === 40_000, "the kept save lands once the database answers");
      ok(disk.stalls === 0 && gap.worst < turn.ms && readFileSync(file, "utf8") === JSON.stringify(p.body), `...from its pieces: ${disk.stalls} synchronous writes on the stalled disk, worst turn ${Math.round(gap.worst)} ms (${turn.note}), the file byte for byte`);
    } finally { disk.restore(); relay.heal(); }
  }
} finally {
  relay.heal();
  for (let i = 0; i < 3; i++) { try { await sdb.__dropStateSchema(); break; } catch { /* retried */ } }
  await sdb.closeStateDb();
  await relay.close();
  rmSync(DIR, { recursive: true, force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
