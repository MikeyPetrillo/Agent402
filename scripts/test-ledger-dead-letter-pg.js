// The refund and sales ledgers through a Postgres outage (STATE_DATABASE_URL;
// CI fails without it). Both ledgers run behind a TCP relay the test cuts: a
// debt owed and a sale recorded while the database is unreachable are kept
// in the local dead-letter (the ledger file), and once the relay heals they
// land exactly once, whether the replay comes from this process's refresh or
// from a fresh boot reading the same file. The NDJSON fallback of the
// dead-letter is checked on its own.
//
//   STATE_DATABASE_URL=postgres://... node scripts/test-ledger-dead-letter-pg.js
import { createServer, connect } from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireTestPg } from "./lib/test-pg.js";
const { url, schema } = requireTestPg({ label: "test-ledger-dead-letter-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = mkdtempSync(join(tmpdir(), "ledger-dl-pg-"));

// ---- a TCP relay in front of Postgres the test can cut and heal -------------
const target = new URL(url);
let cut = false;
const live = new Set();
const relay = createServer((client) => {
  if (cut) { client.destroy(); return; }
  const up = connect({ host: target.hostname, port: Number(target.port || 5432) });
  live.add(client); live.add(up);
  client.pipe(up); up.pipe(client);
  const drop = () => { client.destroy(); up.destroy(); live.delete(client); live.delete(up); };
  client.on("error", drop); up.on("error", drop); client.on("close", drop); up.on("close", drop);
});
await new Promise((r) => relay.listen(0, "127.0.0.1", r));
const relayPort = relay.address().port;
const cutRelay = () => { cut = true; for (const s of live) s.destroy(); live.clear(); };
const healRelay = () => { cut = false; };
const relayUrl = `${target.protocol}//${target.username ? `${target.username}${target.password ? ":" + target.password : ""}@` : ""}127.0.0.1:${relayPort}${target.pathname}${target.search}`;

process.env.STATE_DATABASE_URL = relayUrl;
process.env.STATE_DB_SCHEMA = schema;
process.env.REFUND_DB_DIR = DIR;
process.env.SALES_LEDGER_DB = join(DIR, "agent402-sales.db");

const sdb = await import("../src/state-db.js");
const rl = await import("../src/refund-ledger.js");
const sl = await import("../src/sales-ledger.js");
const { createDeadLetter } = await import("../src/ledger-mirror.js");
const S = schema;
const count = async (sql, params = []) => Number((await sdb.stateQuery(sql, params)).rows[0].n);
const PAYER = "0x3333333333333333333333333333333333333333";

try {
  await rl.refundLedgerReady();
  await sl.salesLedgerReady();
  ok(rl.refundLedgerBackend === "pg" && sl.salesLedgerBackend === "pg", "both ledgers run on the database");

  // ---- (1) written while the database is unreachable --------------------------
  cutRelay();
  const debt = await rl.recordRefundOwed({ slug: "hash", network: "eip155:8453", payer: PAYER, priceUsd: 0.002, tx: "0xdl-debt", httpStatus: 502, wire: "x402" });
  const sale = await sl.recordSale({ slug: "hash", priceUsd: 0.002, rail: "usdc", network: "base", payer: PAYER, tx: "0xdl-sale", wire: "x402" });
  const powSale = await sl.recordSale({ slug: "uuid", priceUsd: 0, rail: "pow" }); // no tx: matched by ts/slug/rail/payer
  // Two sales naming one payment (a subscription invoice and its report): a tx
  // is not a sale's identity, so the replay must land both.
  const shared1 = await sl.recordSale({ slug: "monitor", priceUsd: 5, rail: "card", network: "stripe", payer: null, tx: "in_dl-shared", wire: "stripe-subscription" });
  const shared2 = await sl.recordSale({ slug: "monitor-report", priceUsd: 0, rail: "card", network: "stripe", payer: null, tx: "in_dl-shared", wire: "stripe-subscription" });
  ok(debt === false && sale === false && powSale === false && shared1 === false && shared2 === false, "the writes report not landed while the database is unreachable");
  ok(rl.refundDeadLetterCount() === 1 && sl.salesDeadLetterCount() === 4, `the debt and the sales wait in the local dead-letter (${rl.refundDeadLetterCount()}, ${sl.salesDeadLetterCount()})`);

  // ---- (2) the database is back: a refresh lands each exactly once ----------------
  healRelay();
  await rl.refundLedgerRefresh();
  await sl.salesLedgerRefresh();
  ok(await count(`SELECT count(*) AS n FROM ${S}.refunds WHERE evidence = '0xdl-debt'`) === 1, "the debt is in Postgres after the outage");
  ok(await count(`SELECT count(*) AS n FROM ${S}.sales WHERE tx = '0xdl-sale'`) === 1 && await count(`SELECT count(*) AS n FROM ${S}.sales WHERE rail = 'pow' AND slug = 'uuid'`) === 1, "both sales are in Postgres after the outage");
  ok(await count(`SELECT count(*) AS n FROM ${S}.sales WHERE tx = 'in_dl-shared'`) === 2, "two sales sharing one tx both land: a tx alone is not a sale's identity");
  ok(rl.refundDeadLetterCount() === 0 && sl.salesDeadLetterCount() === 0, "the dead-letter is empty once they landed");
  ok(rl.refundByEvidence("0xdl-debt")?.status === "owed" && sl.saleByTx("0xdl-sale")?.slug === "hash", "the mirror reads the landed rows");
  await rl.refundLedgerRefresh();
  await sl.salesLedgerRefresh();
  ok(await count(`SELECT count(*) AS n FROM ${S}.refunds WHERE evidence = '0xdl-debt'`) === 1 && await count(`SELECT count(*) AS n FROM ${S}.sales WHERE tx = '0xdl-sale'`) === 1, "a second refresh lands nothing twice");

  // ---- (3) the commit landed but its reply was lost: still exactly once ----------
  cutRelay();
  ok((await rl.recordRefundOwed({ slug: "hash", network: "eip155:8453", payer: PAYER, priceUsd: 0.002, tx: "0xdl-debt2", httpStatus: 502 })) === false, "a second debt waits");
  ok((await sl.recordSale({ slug: "hash", priceUsd: 0.002, rail: "usdc", network: "base", payer: PAYER, tx: "0xdl-sale2" })) === false, "a second sale waits");
  healRelay();
  // Another writer lands the same rows first (as if the original commit had gone through).
  await sdb.stateQuery(`INSERT INTO ${S}.refunds (evidence, slug, price_usd, created_at) VALUES ('0xdl-debt2', 'hash', 0.002, $1)`, [Date.now()]);
  // The landed sale is the queued one, value for value (a lost reply leaves exactly that row).
  const queued = sl._salesDeadLetterEntries().find((e) => e.kind === "sale" && e.payload[6] === "0xdl-sale2")?.payload;
  await sdb.stateQuery(`INSERT INTO ${S}.sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire, quote_usd, response_sha256)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, queued);
  // ---- (4) and a fresh boot reading the same file is the one that replays --------
  const childSrc = `
    const rl = await import(${JSON.stringify(join(ROOT, "src/refund-ledger.js"))});
    const sl = await import(${JSON.stringify(join(ROOT, "src/sales-ledger.js"))});
    const sdb = await import(${JSON.stringify(join(ROOT, "src/state-db.js"))});
    await rl.refundLedgerReady(); await sl.salesLedgerReady();
    console.log(JSON.stringify({ refunds: rl.refundDeadLetterCount(), sales: sl.salesDeadLetterCount() }));
    await sdb.closeStateDb();
  `;
  // Async: the relay runs on this process's event loop.
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", childSrc], { env: { ...process.env }, cwd: ROOT, encoding: "utf8" });
  const out = JSON.parse(stdout.trim().split("\n").pop());
  ok(out.refunds === 0 && out.sales === 0, "a fresh boot replays the dead-letter at its first load");
  ok(await count(`SELECT count(*) AS n FROM ${S}.refunds WHERE evidence = '0xdl-debt2'`) === 1 && await count(`SELECT count(*) AS n FROM ${S}.sales WHERE tx = '0xdl-sale2'`) === 1, "a row already in the table is not inserted again (insert-if-absent by evidence and by tx)");

  // ---- (5) the NDJSON fallback ---------------------------------------------------
  {
    const file = join(DIR, "nd", "dl.ndjson");
    const dl = createDeadLetter({ db: null, file });
    ok(dl.kind === "ndjson" && dl.size() === 0, "without an open SQLite file the dead-letter is an NDJSON file");
    ok(dl.add("refund", { evidence: "a" }) && dl.add("refund", { evidence: "b" }) && existsSync(file) && dl.size() === 2, "entries are appended (the directory is created)");
    const first = dl.list()[0];
    dl.remove(first.id);
    ok(dl.size() === 1 && dl.list()[0].payload.evidence === "b", "an entry is removed once it landed; the rest stay");
    ok(createDeadLetter({ db: null, file }).size() === 1, "the entries survive a restart");
  }
} finally {
  healRelay();
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb().catch(() => {});
  relay.close();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
