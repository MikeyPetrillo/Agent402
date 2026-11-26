// Money records past their retention period (src/ledger-retention.js): sales
// and resolved refunds at 7 years, sanctions events at 10, a dry run unless
// LEDGER_RETENTION=apply. Offline, on this suite's own ledger files.
//
//   node scripts/test-ledger-retention.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ledger-retention-"));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
process.env.REFUND_DB_DIR = dir;
process.env.SANCTIONS_EVENTS_FILE = join(dir, "sanctions.jsonl");
delete process.env.LEDGER_RETENTION;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const R = await import("../src/ledger-retention.js");
const sales = await import("../src/sales-ledger.js");
const refunds = await import("../src/refund-ledger.js");
const sanc = await import("../src/sanctions-events.js");

// ---- the settings ---------------------------------------------------------
{
  const s = R.retentionSettings({});
  ok(s.apply === false && s.salesYears === 7 && s.refundYears === 7, "default: a dry run, 7 years for sales and refunds");
  const low = R.retentionSettings({ LEDGER_RETENTION: "apply", LEDGER_RETENTION_SALES_YEARS: "2", LEDGER_RETENTION_REFUND_YEARS: "9" });
  ok(low.apply === true && low.salesYears === 7 && low.refundYears === 9, "LEDGER_RETENTION=apply deletes; a period is never set under 7 years");
  ok(new Date(R.yearsBefore(Date.UTC(2026, 10, 24), 7)).toISOString().startsWith("2019-11-24"), "seven calendar years before a date");
}

// ---- the pass, on real ledger files ----------------------------------------
const NOW = Date.now();
sales.recordSale({ slug: "hash", priceUsd: 0.001, rail: "usdc", network: "eip155:8453", payer: "0x00000000000000000000000000000000000000a1", tx: "0x" + "a1".repeat(32) });
refunds.recordRefundOwed({ slug: "hash", network: "eip155:8453", payer: "0x00000000000000000000000000000000000000a1", priceUsd: 0.001, tx: "0x" + "b1".repeat(32), httpStatus: 502 });
refunds.recordRefundOwed({ slug: "hash", network: "eip155:8453", payer: "0x00000000000000000000000000000000000000a2", priceUsd: 0.002, tx: "0x" + "b2".repeat(32), httpStatus: 502 });
refunds.recordRefundOwed({ slug: "hash", network: "eip155:8453", payer: "0x00000000000000000000000000000000000000a3", priceUsd: 0.003, tx: "0x" + "b3".repeat(32), httpStatus: 502 });
const rows = refunds.listRefunds({ status: "owed", limit: 10 });
const byPayer = (p) => rows.find((r) => r.payer.endsWith(p));
refunds.markRefundPaid(byPayer("a1").id, "0x" + "c1".repeat(32));
refunds.markRefundBlocked(byPayer("a3").id, "payee listed");
await sanc.recordSanctionsEvent({ kind: "screen-hit", address: "0x00000000000000000000000000000000000000a4" }, { now: NOW });

const later = NOW + 8 * 365 * 86_400_000; // eight years on: every row above is past seven
{
  const dry = await R.runLedgerRetention({ now: later, env: {}, log: () => {} });
  ok(dry.apply === false && dry.parts.sales.due === 1 && dry.parts.sales.removed === 0, `dry run: the sale past seven years is counted, not removed (${JSON.stringify(dry.parts.sales)})`);
  ok(dry.parts.refunds.due === 1 && dry.parts.refunds.removed === 0, `dry run: only the paid refund is due; the owed and the blocked rows are not (${JSON.stringify(dry.parts.refunds)})`);
  ok(dry.parts.sanctions.due === 0, "a sanctions event is kept past seven years (ten-year rule, and an unfiled one is never removed)");
  ok(R.ledgerRetentionStatus().ran === true && R.ledgerRetentionStatus().apply === false, "the operator view holds the last pass");
}
{
  const applied = await R.runLedgerRetention({ now: later, env: { LEDGER_RETENTION: "apply" }, log: () => {} });
  ok(applied.parts.sales.removed === 1 && applied.parts.refunds.removed === 1, `applied: the sale and the paid refund are removed (${JSON.stringify(applied.parts)})`);
  const left = refunds.listRefunds({ status: "all", limit: 10 }).map((r) => r.status).sort().join(",");
  ok(left === "blocked,owed", `an owed and a blocked refund are never removed (${left})`);
  const again = await R.runLedgerRetention({ now: later, env: { LEDGER_RETENTION: "apply" }, log: () => {} });
  ok(again.parts.sales.due === 0 && again.parts.refunds.due === 0, "a second pass finds nothing more");
}
// ---- a part that fails does not stop the others ----------------------------
{
  const out = await R.runLedgerRetention({ now: later, env: {}, log: () => {}, deps: { sales: async () => { throw new Error("store down"); }, refunds: async () => ({ due: 2, removed: 0 }), sanctions: async () => ({ due: 0, removed: 0 }) } });
  ok(out.parts.sales.error === "store down" && out.parts.refunds.due === 2 && out.parts.sanctions.due === 0, "a failing part is reported and the rest still run");
}
// ---- LEDGER_RETENTION=off skips the money records, never the refusal records ----
{
  const calls = [];
  const deps = { sales: async () => { calls.push("sales"); return { due: 0, removed: 0 }; }, refunds: async () => { calls.push("refunds"); return { due: 0, removed: 0 }; }, sanctions: async () => { calls.push("sanctions"); return { due: 0, removed: 0 }; }, refusals: async (o) => { calls.push(`refusals:${o.apply}`); return { due: 3, removed: 3 }; } };
  const out = await R.runLedgerRetention({ now: later, env: { LEDGER_RETENTION: "off" }, log: () => {}, deps });
  ok(calls.join(",") === "refusals:true" && out.parts.refusals.removed === 3, `LEDGER_RETENTION=off: only the refusal records are pruned, and they are deleted (${calls.join(",")})`);
}
// ---- wired into the server under a lease, contained, whatever the switch says ----
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const wired = src.split("\n").filter((l) => /startLedgerRetention\(\)/.test(l) && !/^\s*(\/\/|import)/.test(l));
  ok(wired.length === 1 && wired[0].trim() === "startLedgerRetention();", `the server starts the daily pass unconditionally (${JSON.stringify(wired)})`);
  const mod = readFileSync(new URL("../src/ledger-retention.js", import.meta.url), "utf8");
  ok(/leased\("ledger-retention"/.test(mod) && /contained\("ledger-retention"/.test(mod), "the pass runs under its lease and inside a contained turn");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
