// Ledger retention on a REAL Postgres (STATE_DATABASE_URL; CI fails without
// it): runLedgerRetention with LEDGER_RETENTION=apply removes only resolved
// refunds (paid, void) past their period; an owed, sending or blocked row of
// any age stays, as does an unfiled reportable sanctions event; a resolved
// row inside the period stays too. The sanctions events store keeps repeats as
// attempts and aggregates as counts on its rows, on the database.
//
//   STATE_DATABASE_URL=postgres://... node scripts/test-ledger-retention-pg.js
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-ledger-retention-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "retention-pg-"));
process.env.REFUND_DB_DIR = DIR;
process.env.SALES_LEDGER_DB = join(DIR, "sales.db");
delete process.env.LEDGER_RETENTION;

const sdb = await import("../src/state-db.js");
const rl = await import("../src/refund-ledger.js");
const R = await import("../src/ledger-retention.js");
const sanc = await import("../src/sanctions-events.js");
const T = `${sdb.stateDbSchema()}.refunds`;

const YEAR = 365.25 * 86_400_000;
const now = Date.now();
const old = now - 9 * YEAR;      // past the 7-year period
const recent = now - 2 * YEAR;   // inside it
let exit = 1;
try {
  await rl.refundLedgerReady();
  await (await import("../src/sales-ledger.js")).salesLedgerReady();
  const rows = [
    ["old-owed", "owed", old], ["old-sending", "sending", old], ["old-blocked", "blocked", old],
    ["old-paid", "paid", old], ["old-void", "void", old],
    ["new-paid", "paid", recent], ["new-void", "void", recent],
  ];
  for (const [evidence, status, at] of rows) {
    await sdb.stateQuery(`INSERT INTO ${T} (evidence, slug, network, payer, price_usd, http_status, status, created_at) VALUES ($1, 'hash', 'eip155:8453', '0xAbCd000000000000000000000000000000000001', 0.001, 502, $2, $3)`, [evidence, status, at]);
  }
  const present = async () => (await sdb.stateQuery(`SELECT evidence FROM ${T} ORDER BY evidence`)).rows.map((r) => r.evidence);
  ok((await present()).length === rows.length, `the seven rows are in the table (${(await present()).join(",")})`);

  // An unfiled reportable sanctions event older than ten years, and a filed one.
  const ancient = Date.UTC(2010, 0, 4);
  const unfiled = await sanc.recordSanctionsEvent({ kind: "blocked-refund", address: "0xabc", amountUsd: 0.01 }, { now: ancient });
  const filed = await sanc.recordSanctionsEvent({ kind: "screen-hit", address: "0xdef" }, { now: ancient + 1000 });
  await sanc.markSanctionsEventsFiled({ ids: [filed.id], reference: "RS-1" });

  // Repeats and aggregates on the database: an attempt adds to the row, an
  // aggregate counts in one row, and a filed row keeps the count it was filed with.
  const bodyOf = async (id) => (await sdb.stateQuery(`SELECT body FROM ${sdb.stateDbSchema()}.records WHERE collection = $1 AND id = $2`, [sanc.SANCTIONS_EVENTS_COLLECTION, id])).rows[0]?.body;
  const hitAddr = "0x" + "5f".repeat(20);
  const h1 = await sanc.recordSanctionsEvent({ kind: "screen-hit", address: hitAddr, rail: "x402", route: "POST /api/hash" });
  const h2 = await sanc.recordSanctionsEvent({ kind: "screen-hit", address: hitAddr.toUpperCase().replace("0X", "0x"), rail: "x402", route: "POST /api/other" });
  const h3 = await sanc.recordSanctionsEvent({ kind: "screen-hit", address: hitAddr, rail: "x402", route: "POST /ref/hash" });
  await sanc.flushSanctionsEvents();
  ok(h1 && h2?.id === h1.id && h3 && h3.id !== h1.id && (await bodyOf(h1.id))?.attempts === 2 && (await bodyOf(h3.id))?.attempts === 1, `a repeat on the same route class is an attempt on the row in the database (${(await bodyOf(h1.id))?.attempts}); /ref is its own row`);
  const a1 = await sanc.recordSanctionsAggregate({ kind: "unproven-refusal", reason: "unsigned-field", rail: "x402", route: "POST /ref/hash" });
  for (let i = 0; i < 4; i++) await sanc.recordSanctionsAggregate({ kind: "unproven-refusal", reason: i % 2 ? "unproven-signer" : "unsigned-field", rail: "x402", route: "POST /ref/hash" });
  await sanc.flushSanctionsEvents();
  const ab = await bodyOf(a1.id);
  ok(ab?.count === 5 && ab.byReason["unsigned-field"] === 3 && ab.byReason["unproven-signer"] === 2 && ab.address === null && ab.report === null, `an aggregate is one database row with its count (${ab?.count}, ${JSON.stringify(ab?.byReason)})`);
  const view = await sanc.sanctionsEventsOperatorView({ recent: 1000 });
  ok(view.recent.find((r) => r.id === h1.id)?.attempts === 2 && view.unfiled.some((r) => r.id === h1.id) && !view.unfiled.some((r) => r.id === a1.id), "the operator view reads the attempts; the record-only aggregate is not a report due");
  await sanc.markSanctionsEventsFiled({ ids: [h1.id], reference: "RS-2" });
  const h4 = await sanc.recordSanctionsEvent({ kind: "screen-hit", address: hitAddr, rail: "x402", route: "POST /api/hash" });
  await sanc.flushSanctionsEvents();
  const filedBody = await bodyOf(h1.id);
  ok(filedBody?.filedRef === "RS-2" && filedBody.attempts === 2 && h4 && h4.id !== h1.id && (await bodyOf(h4.id))?.attempts === 1, "after filing, the filed row keeps its count and reference; the next attempt opens a new row");
  // A hard kill on the database: the next process reads every attempt and the count row.
  {
    const { runRestartCase } = await import("./lib/sanctions-restart.js");
    const addr = "0x" + "4d".repeat(20);
    const res = runRestartCase({ env: { STATE_DATABASE_URL: process.env.STATE_DATABASE_URL, SANCTIONS_EVENTS_FILE: join(DIR, "restart-events.jsonl") }, address: addr });
    const hitBody = (await sdb.stateQuery(`SELECT body FROM ${sdb.stateDbSchema()}.records WHERE collection = $1 AND body->>'address' = $2`, [sanc.SANCTIONS_EVENTS_COLLECTION, addr])).rows.map((r) => r.body);
    const counted = (await sdb.stateQuery(`SELECT body FROM ${sdb.stateDbSchema()}.records WHERE collection = $1 AND body->>'aggregate' = 'true' AND body->>'routeClass' = 'ref'`, [sanc.SANCTIONS_EVENTS_COLLECTION])).rows.map((r) => r.body);
    ok(res.killedBy === "SIGKILL" && hitBody.length === 1 && hitBody[0].attempts === 4 && res.rows?.find((x) => x.address === addr)?.attempts === 4 && counted.reduce((t, x) => t + x.count, 0) === 1 + 5, `after a SIGKILL the next process lands every attempt and the count row in the database (killed by ${res.killedBy}; attempts ${hitBody[0]?.attempts}; counts ${JSON.stringify(counted.map((x) => [x.rail, x.count]))}; ${res.rows ? "" : res.readerErr || res.writerErr})`);
  }

  const dry = await R.runLedgerRetention({ now, env: { LEDGER_RETENTION: "" }, log: () => {} });
  ok((await present()).length === rows.length, `a dry run removes nothing (${JSON.stringify(dry?.refunds ?? dry)})`);

  await R.runLedgerRetention({ now, env: { LEDGER_RETENTION: "apply" }, log: () => {} });
  const left = await present();
  ok(left.includes("old-owed") && left.includes("old-sending") && left.includes("old-blocked"), `an owed, sending or blocked row is never removed, whatever its age (left: ${left.join(",")})`);
  ok(!left.includes("old-paid") && !left.includes("old-void"), "a resolved row past its period is removed");
  ok(left.includes("new-paid") && left.includes("new-void"), "a resolved row inside its period stays");
  const evRows = (await sdb.stateQuery(`SELECT id FROM ${sdb.stateDbSchema()}.records WHERE collection = $1`, [sanc.SANCTIONS_EVENTS_COLLECTION])).rows.map((r) => r.id);
  ok(evRows.includes(unfiled.id) && !evRows.includes(filed.id), "an unfiled reportable sanctions event is kept past ten years; a filed one is removed");
  exit = fail ? 1 : 0;
} catch (e) {
  console.error(`FAIL - threw: ${e?.stack || e}`);
} finally {
  try { await sdb.stateQuery(`DROP SCHEMA IF EXISTS ${sdb.stateDbSchema()} CASCADE`); } catch { /* best effort */ }
  console.log(`\ntest-ledger-retention-pg: ${pass} passed, ${fail} failed`);
  process.exit(exit);
}
