// Child of scripts/state-cutover-check.js: import the money ledgers in the
// mode the environment selects, wait for their first load, and print one
// JSON line of exact figures. Never writes the files (read-only import,
// STATE_WRITE_THROUGH=off).
const mode = process.env.CUTOVER_MODE || "file";
const withDecide = process.argv[2] === "with-decide";
const out = { mode };

const sales = await import("../../src/sales-ledger.js");
const refunds = await import("../../src/refund-ledger.js");
if (mode === "pg") {
  const sdb = await import("../../src/state-db.js");
  await sdb.stateStoresReady({ timeoutMs: 600_000 });
  if (typeof sales.salesLedgerReady === "function") await sales.salesLedgerReady();
  if (typeof refunds.refundLedgerReady === "function") await refunds.refundLedgerReady();
}

// Sales: the public summaries plus exact counts and sums straight from the rows.
const summary = sales.salesSummary();
out.sales = {
  summary,
  externalByNetwork: sales.externalByNetwork(),
  mpp: (() => { const m = sales.mppSales(); return { count: m.count, externalCount: m.externalCount, internalCount: m.internalCount, rails: Object.fromEntries(Object.entries(m.rails || {}).map(([k, v]) => [k, { count: v.count, external: v.external, externalUsd: v.externalUsd }])) }; })(),
  card: sales.cardSales(),
  decide: sales.decideSales({ days: 30 }),
  firstRecordedTs: sales.firstRecordedTs(),
};
// Refunds: totals and the status breakdown.
const rows = refunds.listRefunds({ limit: 100000 });
const list = Array.isArray(rows) ? rows : rows?.rows || [];
const byStatus = {};
let owedUsd = 0, n = 0;
for (const r of list) { n++; byStatus[r.status] = (byStatus[r.status] || 0) + 1; if (r.status === "owed") owedUsd += Number(r.priceUsd ?? r.price_usd ?? 0); }
out.refunds = { count: n, byStatus, owedUsd: +owedUsd.toFixed(6), totals: refunds.refundTotals(), alarm: refunds.refundAlarmStatus() };

// Exact row counts straight from the store each mode reads: the SQLite files
// in file mode, the state tables in database mode. The two must be equal, or
// the import dropped rows.
if (mode === "pg") {
  const sdb = await import("../../src/state-db.js");
  const count = async (t) => Number((await sdb.stateQuery(`SELECT count(*)::bigint AS n FROM ${sdb.stateDbSchema()}.${t}`)).rows[0].n);
  out.rows = { sales: await count("sales"), saleFeedback: await count("sale_feedback"), refunds: await count("refunds") };
} else {
  const { default: Database } = await import("better-sqlite3");
  const q = (f, t) => { const db = new Database(f, { readonly: true }); try { return db.prepare(`select count(*) c from ${t}`).get().c; } finally { db.close(); } };
  const refundsFile = (await import("node:path")).join(process.env.REFUND_DB_DIR, "agent402-refunds.db");
  out.rows = { sales: q(process.env.SALES_LEDGER_DB, "sales"), saleFeedback: q(process.env.SALES_LEDGER_DB, "sale_feedback"), refunds: q(refundsFile, "refunds") };
}

if (withDecide) {
  const { openDecideLedger } = await import("../../src/decide/ledger.js");
  const ledger = openDecideLedger(process.env.DECIDE_LEDGER_DB);
  if (typeof ledger.ready === "function") await ledger.ready();
  out.decide = typeof ledger.summaryForCutover === "function" ? await ledger.summaryForCutover() : { note: "the decide ledger exposes no cutover summary yet" };
}

if (mode === "pg") {
  const sdb = await import("../../src/state-db.js");
  await sdb.__dropStateSchema();
  await sdb.closeStateDb();
}
console.log(JSON.stringify(out));
process.exit(0);
