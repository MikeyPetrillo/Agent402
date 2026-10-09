// The refund ledger against a REAL Postgres (STATE_DATABASE_URL; CI fails
// without it): the SQLite file is imported once at the first boot with the
// database on and never again, every write lands in Postgres (and in the file,
// write-through) before its promise resolves, a fresh process reads the table
// and not the file, and exactly one claimer wins an owed row however many
// containers try at once.
//
//   STATE_DATABASE_URL=postgres://... node scripts/test-refund-ledger-pg.js
import { mkdtempSync, rmSync } from "node:fs";
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
  ok(!ev.includes("ALGO-file3"), "a second boot does not import the file again (a row deleted from the table stays gone)");
  ok(ev.includes("0xnew1") && out.rows.find((r) => r[1] === "0xnew1")[2] === "paid", "the second boot reads the table's current state, not the file");
  ok(out.rows.find((r) => r[1] === "0xpush1")[3].endsWith("then disconnected"), "the second boot sees the note rewrite");
  ok(out.alarm === "ok" || out.alarm === "aging", `the second boot's alarm reads from a loaded mirror (${out.alarm})`);

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
