// The refund ledger against a REAL Postgres (STATE_DATABASE_URL; CI fails
// without it): the SQLite file is imported once at the first boot with the
// database on and never again, every write lands in Postgres (and in the file,
// write-through) before its promise resolves, a fresh process reads the table
// and not the file, and exactly one claimer wins an owed row however many
// containers try at once.
//
//   STATE_DATABASE_URL=postgres://... node scripts/test-refund-ledger-pg.js
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-refund-ledger-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = mkdtempSync(join(tmpdir(), "refunds-pg-"));
const FILE = join(DIR, "agent402-refunds.db");
process.env.REFUND_DB_DIR = DIR;
process.env.LEDGER_MIRROR_MARGIN_MS = "400";

// The file a volume would hold: three debts written by the file-only build.
{
  const f = new Database(FILE);
  f.exec(`CREATE TABLE refunds (id INTEGER PRIMARY KEY AUTOINCREMENT, evidence TEXT NOT NULL UNIQUE, slug TEXT NOT NULL, network TEXT, payer TEXT, priceUsd REAL NOT NULL DEFAULT 0, httpStatus INTEGER, synthetic INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'owed', paidTx TEXT, note TEXT, createdAt INTEGER NOT NULL, resolvedAt INTEGER, wire TEXT, hangupReason TEXT, claimedAt INTEGER)`);
  const ins = f.prepare("INSERT INTO refunds (evidence, slug, network, payer, priceUsd, httpStatus, synthetic, status, paidTx, note, createdAt, resolvedAt, wire) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  ins.run("0xfile1", "hash", "eip155:8453", "0xAbCd000000000000000000000000000000000001", 0.001, 502, 0, "owed", null, null, Date.now() - 3 * 86_400_000, null, "x402");
  ins.run("0xfile2", "uuid", "eip155:8453", "0xAbCd000000000000000000000000000000000002", 0.002, 500, 0, "paid", "0xrefund2", "sent", Date.now() - 2 * 86_400_000, Date.now() - 86_400_000, "x402");
  ins.run("ALGO-file3", "t", "algorand:mainnet", "MiXeDcAsEaDdReSs", 0.003, 500, 1, "owed", null, null, Date.now() - 1000, null, "x402");
  f.close();
}

const sdb = await import("../src/state-db.js");
const rl = await import("../src/refund-ledger.js");
const T = `${sdb.stateDbSchema()}.refunds`;
const pgRows = async (where = "TRUE", params = []) => (await sdb.stateQuery(`SELECT * FROM ${T} WHERE ${where} ORDER BY id`, params)).rows;

try {
  ok(rl.refundLedgerBackend === "pg", "the ledger reports the database backend");
  await rl.refundLedgerReady();

  // ---- (1) import once --------------------------------------------------------
  const all = rl.listRefunds({ status: "all" });
  ok(all.length === 3 && all.map((r) => r.evidence).sort().join() === "0xfile1,0xfile2,ALGO-file3", `the file's rows are imported and readable (${all.length})`);
  ok(all.find((r) => r.evidence === "ALGO-file3")?.payer === "MiXeDcAsEaDdReSs", "a case-sensitive address survives the import verbatim");
  ok(all.find((r) => r.evidence === "0xfile2")?.status === "paid" && all.find((r) => r.evidence === "0xfile2")?.paidTx === "0xrefund2", "a paid row keeps its status and outbound tx");
  const mark = await sdb.imports.done("agent402-refunds.db");
  ok(mark && mark.source === FILE, "the import is marked under the file's basename");
  ok((await pgRows()).length === 3 && (await pgRows()).map((r) => Number(r.id)).join() === "1,2,3", "Postgres holds the rows with the file's ids");
  ok(rl.refundTotals().owed.n === 2 && rl.refundTotals().paid.n === 1, "totals read from the mirror");
  ok(rl.refundAlarmStatus({ owedHours: 48 }).status === "aging", "the alarm sees the three-day-old debt");

  // ---- (2) writes land in Postgres before the promise resolves ---------------
  const row = { slug: "hash", network: "eip155:8453", payer: "0xAbCd000000000000000000000000000000000009", priceUsd: 0.004, tx: "0xnew1", httpStatus: 502, wire: "x402" };
  const p = rl.recordRefundOwed(row);
  ok(typeof p?.then === "function", "recordRefundOwed returns a promise in database mode");
  ok((await p) === true, "the first record creates the debt");
  ok((await pgRows("evidence = $1", ["0xnew1"])).length === 1, "the debt is in Postgres when the promise resolves");
  ok((await rl.recordRefundOwed(row)) === false, "the same evidence again is a no-op (unique evidence)");
  ok((await pgRows("evidence = $1", ["0xnew1"])).length === 1, "still one row");
  ok(rl.refundByEvidence("0xnew1")?.status === "owed" && Number(rl.refundByEvidence("0xnew1").id) === 4, "the mirror has the landed row with its Postgres id");
  const fileNow = new Database(FILE, { readonly: true });
  const ft = fileNow.prepare("SELECT id, status FROM refunds WHERE evidence = ?").get("0xnew1");
  fileNow.close();
  ok(ft && ft.id === 4 && ft.status === "owed", "write-through: the landed row is also in the SQLite file with the same id");

  // ---- (3) exactly one claimer wins an owed row ------------------------------
  const id = Number(rl.refundByEvidence("0xnew1").id);
  const other = sdb.stateQuery(`UPDATE ${T} SET status = 'sending', note = 'other container', claimed_at = $2 WHERE id = $1 AND status = 'owed' RETURNING id`, [id, Date.now()]);
  const mine = rl.claimRefundForSend(id, "this container");
  const [o, m] = await Promise.all([other, mine]);
  ok((o.rowCount > 0) !== (m === true), `exactly one of two concurrent claimers wins (other=${o.rowCount > 0}, mine=${m})`);
  ok(rl.refundByEvidence("0xnew1")?.status === "sending", "the mirror shows the row as sending either way");
  ok((await rl.claimRefundForSend(id, "again")) === false, "a sending row cannot be claimed again");
  ok((await rl.markRefundPaid(id, "undefined")) === false, "a non-evidence outbound tx is refused");
  ok((await rl.markRefundPaid(id, "0xout1", "sent")) === true, "a sending row is marked paid with its outbound tx");
  ok((await pgRows("id = $1", [id]))[0].status === "paid" && (await pgRows("id = $1", [id]))[0].paid_tx === "0xout1", "paid in Postgres");
  ok((await rl.markRefundVoid(id, "no")) === false, "a paid row is never voided");
  ok((await rl.voidOwedOnClaim("0xfile1", "claimed on retry")) === true, "an owed row is voided on a served claim");
  ok((await rl.voidOwedOnClaim("0xfile1", "claimed on retry")) === false, "a void row is not voided twice");
  ok((await rl.releaseStuckSend(id, "checked")) === false, "release touches only a sending row");
  ok(rl.refundTotals().paid.n === 2 && rl.refundTotals().void.n === 1 && rl.refundTotals().owed.n === 1, `totals after the transitions (${JSON.stringify(rl.refundTotals())})`);
  // Note rewrites, keyed on the current note.
  ok((await rl.recordRefundOwed({ slug: "x", network: "tempo", payer: "0xAbCd000000000000000000000000000000000003", priceUsd: 0.01, tx: "0xpush1", httpStatus: 400, wire: "mpp-tempo", note: "push unclaimed: input refused" })) === true, "a push debt is booked");
  ok((await rl.promoteOwedToHangup("0xpush1", { from: "push unclaimed: input refused", hangupReason: "no ticket", append: "claimed on retry, then disconnected" })) === true, "promoted to a disconnect debt");
  ok(rl.refundByEvidence("0xpush1")?.httpStatus === 499 && rl.refundByEvidence("0xpush1")?.hangupReason === "no ticket" && rl.refundByEvidence("0xpush1")?.note.endsWith("then disconnected"), "the mirror shows the promoted row");
  ok((await rl.promoteOwedToHangup("0xpush1", { from: "push unclaimed: input refused", hangupReason: "no ticket", append: "x" })) === false, "a second promotion finds no row with the old note");
  ok(rl.refundsForPayer("0xabcd000000000000000000000000000000000009").length === 1 && rl.refundsForPayer("mixedcaseaddress").length === 0, "payer lookups: EVM case-folded, every other rail exact");
  ok(rl.refundsCreatedBetween(0, Date.now() + 1).every((r) => !("payer" in r)), "refundsCreatedBetween never carries the payer");

  // ---- another container's write arrives on refresh ---------------------------
  await sdb.stateQuery(`UPDATE ${T} SET note = 'edited elsewhere', updated_at = ((extract(epoch from clock_timestamp()) * 1000)::bigint) WHERE evidence = 'ALGO-file3'`);
  ok(rl.refundByEvidence("ALGO-file3")?.note === null, "before a refresh the mirror still shows the old row");
  await rl.refundLedgerRefresh();
  ok(rl.refundByEvidence("ALGO-file3")?.note === "edited elsewhere", "after a refresh the mirror shows another container's write");

  // ---- (1b) a second boot does not re-import ----------------------------------
  await sdb.stateQuery(`DELETE FROM ${T} WHERE evidence = 'ALGO-file3'`); // only a test deletes; the file still holds the row
  const childSrc = `
    const rl = await import(${JSON.stringify(join(ROOT, "src/refund-ledger.js"))});
    const sdb = await import(${JSON.stringify(join(ROOT, "src/state-db.js"))});
    await rl.refundLedgerReady();
    const rows = rl.listRefunds({ status: "all" }).map((r) => [r.id, r.evidence, r.status, r.note]);
    console.log(JSON.stringify({ rows, totals: rl.refundTotals(), alarm: rl.refundAlarmStatus().status }));
    await sdb.closeStateDb();
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", childSrc], { env: { ...process.env }, cwd: ROOT, encoding: "utf8" }).trim().split("\n").pop());
  const ev = out.rows.map((r) => r[1]);
  ok(ev.filter((e) => e === "ALGO-file3").length === 1 && (await pgRows("evidence = $1", ["ALGO-file3"])).length === 1, "a debt missing from the table is restored from the file at the next boot (insert-if-absent by evidence), once");
  ok(ev.includes("0xnew1") && out.rows.find((r) => r[1] === "0xnew1")[2] === "paid", "the second boot reads the table's current state, not the file");
  ok(out.rows.find((r) => r[1] === "0xpush1")[3].endsWith("then disconnected"), "the second boot sees the note rewrite");
  ok(out.alarm === "ok" || out.alarm === "aging", `the second boot's alarm reads from a loaded mirror (${out.alarm})`);

  // ---- roll-forward after a rollback -----------------------------------------
  const boot = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", childSrc], { env: { ...process.env }, cwd: ROOT, encoding: "utf8" }).trim().split("\n").pop());
  // (a) an ordinary write-through: the file sits within the grace of the table's newest row, so a file edit is not applied.
  ok((await rl.recordRefundOwed({ slug: "r", network: "eip155:8453", payer: "0xAbCd000000000000000000000000000000000004", priceUsd: 0.005, tx: "0xroll1", httpStatus: 500 })) === true, "a debt booked by the database build (written through to the file)");
  { const f = new Database(FILE); f.prepare("UPDATE refunds SET note = 'file edit within grace' WHERE evidence = '0xroll1'").run(); f.close(); }
  boot();
  ok((await pgRows("evidence = $1", ["0xroll1"]))[0].note === null, "a file written within the grace is not rolled forward (write-through, not a rollback)");
  // (b) the file-only build ran alone: it marked a row paid, booked a new debt, and the file is past the grace.
  {
    const f = new Database(FILE);
    f.prepare("UPDATE refunds SET status = 'paid', paidTx = '0xrolledtx', note = 'paid while rolled back', resolvedAt = ? WHERE evidence = '0xroll1'").run(Date.now());
    f.prepare("INSERT INTO refunds (evidence, slug, network, payer, priceUsd, httpStatus, synthetic, status, createdAt) VALUES ('0xfileonly', 'h', 'eip155:8453', '0xAbCd000000000000000000000000000000000005', 0.006, 500, 0, 'owed', ?)").run(Date.now());
    f.close();
    const future = new Date(Date.now() + 10 * 60_000);
    utimesSync(FILE, future, future);
  }
  const rolled = boot();
  const paidRow = (await pgRows("evidence = $1", ["0xroll1"]))[0];
  ok(paidRow?.status === "paid" && paidRow?.paid_tx === "0xrolledtx" && paidRow?.note === "paid while rolled back", "a refund marked paid in the file is paid in the database after the next boot");
  ok((await pgRows("evidence = $1", ["0xfileonly"]))[0]?.status === "owed", "a debt booked in the file alone is in the database");
  ok(rolled.rows.some((r) => r[1] === "0xfileonly") && rolled.rows.find((r) => r[1] === "0xroll1")[2] === "paid", "the booting instance reads the rolled-forward rows");
  ok(rolled.rows.some((r) => r[1] === "ALGO-file3"), "the file wins per row: a row the file still holds is back in the table");
  ok((await rl.recordRefundOwed({ slug: "h", network: "eip155:8453", payer: "0xAbCd000000000000000000000000000000000006", priceUsd: 0.001, tx: "0xafterroll", httpStatus: 500 })) === true && Number(rl.refundByEvidence("0xafterroll").id) > Number((await pgRows("evidence = $1", ["0xfileonly"]))[0].id), "the id sequence continues past the rolled-forward rows");

  // ---- M10: a stale or foreign file never moves a row backwards -----------------
  {
    ok((await rl.recordRefundOwed({ slug: "m10", network: "eip155:8453", payer: "0xAbCd000000000000000000000000000000000007", priceUsd: 0.002, tx: "0xm10", httpStatus: 500 })) === true, "M10: a debt is booked");
    const mid = Number(rl.refundByEvidence("0xm10").id);
    ok((await rl.claimRefundForSend(mid, "run")) === true && (await rl.markRefundPaid(mid, "0xm10paid", "sent")) === true, "M10: and paid");
    // The file still says owed (a foreign writer, or a copy from before the payment) and is stamped far in the future.
    { const f = new Database(FILE); f.prepare("UPDATE refunds SET status = 'owed', paidTx = NULL, note = 'stale', resolvedAt = NULL WHERE evidence = '0xm10'").run(); f.close(); }
    const future = new Date(Date.now() + 30 * 60_000);
    utimesSync(FILE, future, future);
    boot();
    const r = (await pgRows("evidence = $1", ["0xm10"]))[0];
    ok(r.status === "paid" && r.paid_tx === "0xm10paid", `M10: a file row behind the table never reverts paid to owed (${r.status}, ${r.paid_tx})`);
    // An owed row written in the table after the file: the file's note is not applied.
    ok((await rl.recordRefundOwed({ slug: "m10b", network: "eip155:8453", payer: "0xAbCd000000000000000000000000000000000007", priceUsd: 0.002, tx: "0xm10b", httpStatus: 500 })) === true, "M10: a second debt");
    { const f = new Database(FILE); f.prepare("UPDATE refunds SET note = 'old file note' WHERE evidence = '0xm10b'").run(); f.close(); }
    const past = new Date(Date.now() - 30 * 60_000);
    utimesSync(FILE, past, past);
    boot();
    ok((await pgRows("evidence = $1", ["0xm10b"]))[0].note === null, "M10: a table row written after the file is never overwritten by it");
    // Further along in the file, but the table row was written after the file: not applied.
    ok((await rl.recordRefundOwed({ slug: "m10c", network: "eip155:8453", payer: "0xAbCd000000000000000000000000000000000007", priceUsd: 0.002, tx: "0xm10c", httpStatus: 500 })) === true, "M10: a third debt");
    { const f = new Database(FILE); f.prepare("UPDATE refunds SET status = 'paid', paidTx = '0xforeign' WHERE evidence = '0xm10c'").run(); f.close(); }
    for (const f of [FILE, `${FILE}-wal`]) { try { utimesSync(f, past, past); } catch { /* no wal */ } }
    boot();
    ok((await pgRows("evidence = $1", ["0xm10c"]))[0].status === "owed", "M10: a file older than the table row never moves it, even forward");
  }

  // ---- M5: a cutover-window row from the file-only build, its id already taken ----
  {
    const maxId = Number((await sdb.stateQuery(`SELECT MAX(id) AS m FROM ${T}`)).rows[0].m);
    { const f = new Database(FILE); f.prepare("INSERT INTO refunds (id, evidence, slug, network, payer, priceUsd, httpStatus, synthetic, status, createdAt) VALUES (?, '0xcutover', 'c', 'eip155:8453', '0xAbCd000000000000000000000000000000000008', 0.003, 500, 0, 'owed', ?)").run(maxId + 1000, Date.now());
      f.prepare("UPDATE refunds SET id = ? WHERE evidence = '0xcutover'").run(Number(rl.refundByEvidence("0xm10").id) + 5000); f.close(); }
    // The file row's id collides with nothing now; make it collide with a live table row instead.
    { const f = new Database(FILE); const live = Number(rl.refundByEvidence("0xm10b").id); f.prepare("DELETE FROM refunds WHERE id = ?").run(live); f.prepare("UPDATE refunds SET id = ? WHERE evidence = '0xcutover'").run(live); f.close(); }
    const past = new Date(Date.now() - 30 * 60_000);
    utimesSync(FILE, past, past); // older than the table's newest row: the mtime gate alone would skip it
    boot();
    const rows = await pgRows("evidence = $1", ["0xcutover"]);
    ok(rows.length === 1 && rows[0].status === "owed", "M5: a debt written to the file by the old build is in the table after the next boot, even under a colliding id and an old mtime");
    boot();
    ok((await pgRows("evidence = $1", ["0xcutover"])).length === 1, "M5: a second boot inserts it no second time");
  }

  // ---- WS-H H3: the id sequence never moves backwards --------------------------
  {
    const seq = (await sdb.stateQuery("SELECT pg_get_serial_sequence($1, 'id') AS s", [T])).rows[0].s;
    const before = Number((await sdb.stateQuery("SELECT nextval($1::regclass) AS v", [seq])).rows[0].v); // an insert that took an id and has not committed
    const { syncIdSequence } = await import("../src/ledger-mirror.js");
    await sdb.stateQuery(`DELETE FROM ${T} WHERE id = (SELECT MAX(id) FROM ${T})`);
    await syncIdSequence(sdb.stateQuery, T);
    const next = Number((await sdb.stateQuery("SELECT nextval($1::regclass) AS v", [seq])).rows[0].v);
    ok(next > before, `syncIdSequence never moves the sequence back under an id already taken (${before} then ${next})`);
  }

  // ---- a5 / a18: renote and restate change an OWED row whose note matches only ----
  {
    ok((await rl.recordRefundOwed({ slug: "rn", network: "tempo", payer: "0xAbCd00000000000000000000000000000000000a", priceUsd: 0.01, tx: "0xrn", httpStatus: 400, wire: "mpp-tempo", note: "push unclaimed: input refused" })) === true, "a5: a push debt");
    ok((await rl.renoteOwedRefund("0xrn", "some other note", "x")) === false && (await pgRows("evidence = $1", ["0xrn"]))[0].note === "push unclaimed: input refused", "a5: renote with a non-matching note changes nothing");
    ok((await rl.restateOwedAsHandlerFailure("0xrn", { from: "some other note", httpStatus: 502, append: "y" })) === false && Number((await pgRows("evidence = $1", ["0xrn"]))[0].http_status) === 400, "a18: restate with a non-matching note changes nothing");
    const rid = Number(rl.refundByEvidence("0xrn").id);
    ok((await rl.claimRefundForSend(rid, "push unclaimed: input refused")) === true, "a5: the row is claimed (sending), note unchanged");
    ok((await rl.renoteOwedRefund("0xrn", "push unclaimed: input refused", "x")) === false && (await pgRows("evidence = $1", ["0xrn"]))[0].note === "push unclaimed: input refused", "a5: renote never touches a sending row");
    ok((await rl.restateOwedAsHandlerFailure("0xrn", { from: "push unclaimed: input refused", httpStatus: 502, append: "y" })) === false && (await pgRows("evidence = $1", ["0xrn"]))[0].status === "sending", "a18: restate never touches a sending row");
    ok((await rl.recordRefundOwed({ slug: "rn2", network: "tempo", payer: "0xAbCd00000000000000000000000000000000000a", priceUsd: 0.01, tx: "0xrn2", httpStatus: 400, note: "push unclaimed: input refused" })) === true
      && (await rl.renoteOwedRefund("0xrn2", "push unclaimed: input refused", "renoted")) === true && (await pgRows("evidence = $1", ["0xrn2"]))[0].note === "renoted", "a5: control: a matching owed row is renoted");
    ok((await rl.restateOwedAsHandlerFailure("0xrn2", { from: "renoted", httpStatus: 502, append: "y" })) === true && Number((await pgRows("evidence = $1", ["0xrn2"]))[0].http_status) === 502, "a18: control: a matching owed row is restated");
  }

  // ---- e4: refundLedgerFlush resolves only once a queued write is in Postgres ----
  {
    rl.recordRefundOwed({ slug: "fl", network: "eip155:8453", payer: "0xAbCd00000000000000000000000000000000000b", priceUsd: 0.001, tx: "0xflush", httpStatus: 500 }); // not awaited
    await rl.refundLedgerFlush();
    ok((await pgRows("evidence = $1", ["0xflush"])).length === 1, "e4: a queued debt is in Postgres when the flush resolves");
  }

  // ---- H13: a NUL in a note never stops the ledger ------------------------------
  {
    ok((await rl.recordRefundOwed({ slug: "nul", network: "eip155:8453", payer: "0xAbCd00000000000000000000000000000000000c", priceUsd: 0.001, tx: "0xnul", httpStatus: 500, note: "bad\u0000note" })) === true, "H13: a debt whose note carries a NUL is recorded");
    ok((await pgRows("evidence = $1", ["0xnul"]))[0]?.note === "badnote", "H13: stored with the NUL stripped");
    { const f = new Database(FILE); f.prepare("INSERT INTO refunds (evidence, slug, network, payer, priceUsd, httpStatus, synthetic, status, note, createdAt) VALUES ('0xnulfile', 'n', 'eip155:8453', '0xAbCd00000000000000000000000000000000000c', 0.001, 500, 0, 'owed', ?, ?)").run("file\u0000note", Date.now()); f.close(); }
    const out2 = boot();
    ok(out2.rows.some((r) => r[1] === "0xnulfile") && (await pgRows("evidence = $1", ["0xnulfile"]))[0]?.note === "filenote", "H13: a file row with a NUL is imported and the ledger still loads");
  }

  // ---- M2: an import burst is not pulled again on every refresh -----------------
  {
    const vals = [];
    for (let i = 0; i < 2000; i++) vals.push(`('0xbulk${i}', 'b', 'eip155:8453', 0, ${Date.now()})`);
    await sdb.stateQuery(`INSERT INTO ${T} (evidence, slug, network, price_usd, created_at) VALUES ${vals.join(",")}`);
    // Refreshes spaced as the timer spaces them (REFRESH_MS > the margin).
    const gap = () => new Promise((r) => setTimeout(r, Number(process.env.LEDGER_MIRROR_MARGIN_MS) + 300));
    await gap();
    const first = await rl.refundLedgerRefresh();
    await gap();
    const second = await rl.refundLedgerRefresh();
    ok(first >= 2000 && second === 0, `M2: the burst is pulled once, and the next refresh pulls nothing (${first}, ${second})`);
  }

  // ---- the test seam empties both -------------------------------------------
  await rl.__resetRefunds();
  ok(rl.listRefunds({ status: "all" }).length === 0 && (await pgRows()).length === 0, "__resetRefunds empties the table and the mirror");
} finally {
  await sdb.__dropStateSchema();
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
