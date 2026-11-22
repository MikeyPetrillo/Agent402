// One settlement, one sale (src/sale-repeats.js) against a REAL Postgres
// (STATE_DATABASE_URL; CI fails without it): the database writer does not
// write a second sale for a Solana settlement signature, a repeat row already
// in the table is left out of the figures once the mirror holds it, and the
// operator script's dry run reads the table and changes nothing.
//   STATE_DATABASE_URL=postgres://... node scripts/test-sale-repeats-pg.js
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { requireTestPg } from "./lib/test-pg.js";
const { url, schema } = requireTestPg({ label: "test-sale-repeats-pg" });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "repeats-pg-"));
process.env.SALES_LEDGER_DB = join(DIR, "sales.db");
process.env.LEDGER_MIRROR_REFRESH_MS = "3600000";
process.env.LEDGER_MIRROR_MARGIN_MS = "400";
const SCRIPT = join(fileURLToPath(import.meta.url), "..", "sale-repeats.js");
const PAYER = "So1PayerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SIG1 = `sigA${"x".repeat(60)}`, SIG2 = `sigB${"x".repeat(60)}`;
const sl = await import("../src/sales-ledger.js");
const { closeStateDb, __dropStateSchema } = await import("../src/state-db.js");
const client = new pg.Client({ connectionString: url });
const count = async (where = "TRUE", params = []) => (await client.query(`SELECT count(*)::int AS n FROM "${schema}".sales WHERE ${where}`, params)).rows[0].n;
const run = (args) => spawnSync(process.execPath, [SCRIPT, "--pg", ...args], { env: { ...process.env, STATE_DATABASE_URL: url, STATE_DB_SCHEMA: schema }, encoding: "utf8" });
const external = () => sl.salesSummary({ detailed: true }).totals.external;

try {
  await client.connect();
  await sl.salesLedgerReady();
  const sale = (o) => sl.recordSale({ slug: "web-search", priceUsd: 0.02, rail: "usdc", network: "solana", payer: PAYER, synthetic: false, wire: "x402", ...o });
  ok(await sale({ tx: SIG1 }) === true && await count("tx = $1", [SIG1]) === 1, "a Solana sale is written");
  await sale({ tx: SIG1 });
  await sale({ tx: SIG1, slug: "hash", priceUsd: 0.001 });
  ok(await count("tx = $1", [SIG1]) === 1 && sl.saleRepeatStats().refusedSinceBoot === 2, `a second sale for its settlement is not written, whatever tool it names (${JSON.stringify(sl.saleRepeatStats())})`);
  await sale({ tx: SIG2 });
  await sale({ tx: "0xevm", network: "eip155:8453", payer: "0x00000000000000000000000000000000000000a1" });
  await sale({ tx: "0xevm", network: "eip155:8453", payer: "0x00000000000000000000000000000000000000a1" });
  ok(await count("tx = $1", [SIG2]) === 1 && await count("tx = '0xevm'") === 2, "a signature of its own is written, and an EVM hash still stands behind two rows");
  const before = external();
  ok(before.sales === 4, `four sales on the books (${before.sales})`);

  // A repeat row the way the old writer left it, written by another process.
  await client.query(`INSERT INTO "${schema}".sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) SELECT ts + 1500, slug, price_usd, rail, network, payer, tx, internal, wire FROM "${schema}".sales WHERE tx = $1`, [SIG1]);
  await new Promise((r) => setTimeout(r, 500)); // past the mirror's margin, so the refresh reads the row
  await sl.salesLedgerRefresh();
  const after = external();
  ok(await count("tx = $1", [SIG1]) === 2 && sl.saleRepeatStats().repeatRows === 1, "the table holds the repeat row and the mirror lists it");
  ok(after.sales === before.sales && after.revenueUsd === before.revenueUsd, `the figures count the settlement once (${before.sales} sales, $${before.revenueUsd} before and after)`);

  const dry = run([]);
  ok(dry.status === 0 && /DRY RUN \(nothing is changed\)/.test(dry.stdout) && /repeat rows: 1 \(1 external, 0 our own\)/.test(dry.stdout) && !dry.stdout.includes(PAYER), `the dry run reads the table and prints no payer (${dry.stdout.split("\n").slice(1, 3).join(" / ")}${dry.stderr.slice(0, 200)})`);
  ok(await count() === 5, "the dry run changes nothing");
  const refused = run(["--apply", "--expect", "5"]);
  ok(refused.status === 3 && await count() === 5, "--apply with another count than the dry run printed is refused");
  const applied = run(["--apply", "--expect", "1"]);
  const moved = (await client.query(`SELECT count(*)::int AS n FROM "${schema}".sales_repeats`).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
  ok(applied.status === 0 && await count("tx = $1", [SIG1]) === 1 && moved === 1 && await count() === 4, `the correction moves the repeat row to sales_repeats and keeps the first (${applied.stdout.trim().split("\n").pop()}${applied.stderr.slice(0, 200)})`);
} catch (e) {
  fail++; console.error("FAIL - threw:", e?.stack || e);
} finally {
  await client.end().catch(() => {});
  await sl.salesLedgerFlush().catch(() => {});
  await __dropStateSchema?.().catch(() => {});
  await closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-sale-repeats-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
