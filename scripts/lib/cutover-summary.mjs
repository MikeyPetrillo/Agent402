// Child of scripts/state-cutover-check.js: import the money ledgers in the
// mode the environment selects, wait for their first load, and print one
// JSON line of exact figures. The parent hands each mode its own copy of the
// files, so nothing a boot writes reaches the originals. CUTOVER_KEEP_SCHEMA=1
// leaves the database half's schema for the parent's row-level checksum.
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
// Refunds: EVERY row in every status (listRefunds defaults to the first 200
// owed rows), with the count and the sum per status.
const rows = refunds.listRefunds({ status: "all", limit: Number.MAX_SAFE_INTEGER });
const list = Array.isArray(rows) ? rows : rows?.rows || [];
const byStatus = {}, usdByStatus = {};
let n = 0;
for (const r of list) {
  n++;
  byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  usdByStatus[r.status] = (usdByStatus[r.status] || 0) + Number(r.priceUsd ?? r.price_usd ?? 0);
}
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
for (const k of Object.keys(usdByStatus)) usdByStatus[k] = +usdByStatus[k].toFixed(9);
out.refunds = { count: n, byStatus: sorted(byStatus), usdByStatus: sorted(usdByStatus), owedUsd: usdByStatus.owed || 0, totals: refunds.refundTotals(), alarm: refunds.refundAlarmStatus() };

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
  // Decide: open the ledger (the database half imports the file on open),
  // then read exact counts and sums from the store each mode uses.
  const { openDecideLedger } = await import("../../src/decide/ledger.js");
  const ledger = openDecideLedger(process.env.DECIDE_LEDGER_DB);
  if (ledger.ready) await ledger.ready;
  const tables = ["decisions", "credits", "runs", "feedback", "seller_spend"];
  if (mode === "pg") {
    const sdb = await import("../../src/state-db.js");
    const S = sdb.stateDbSchema();
    const q = async (sql) => (await sdb.stateQuery(sql)).rows;
    const counts = {}; for (const t of tables) counts[t] = Number((await q(`SELECT count(*)::bigint AS n FROM ${S}.decide_ledger_${t}`))[0].n);
    const by = async (t, col) => Object.fromEntries((await q(`SELECT ${col} AS k, count(*)::bigint AS n FROM ${S}.decide_ledger_${t} GROUP BY ${col} ORDER BY ${col}`)).map((r) => [String(r.k), Number(r.n)]));
    const creditCols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = '${S}' AND table_name = 'decide_ledger_credits'`)).map((r) => r.column_name);
    const stateCol = creditCols.includes("state") ? "state" : "status";
    const amountCol = creditCols.find((c) => /usd|amount|micro/.test(c)) || null;
    out.decide = { counts, creditsByState: await by("credits", stateCol), runsByState: await by("runs", (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = '${S}' AND table_name = 'decide_ledger_runs'`)).some((r) => r.column_name === "state") ? "state" : "status"),
      creditsSum: amountCol ? Number((await q(`SELECT coalesce(sum(${amountCol}),0) AS s FROM ${S}.decide_ledger_credits`))[0].s) : null, amountCol };
  } else {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(process.env.DECIDE_LEDGER_DB, { readonly: true });
    const counts = {}; for (const t of tables) counts[t] = db.prepare(`select count(*) c from ${t}`).get().c;
    const cols = (t) => db.prepare(`pragma table_info(${t})`).all().map((c) => c.name);
    const cc = cols("credits"), rc = cols("runs");
    const stateCol = cc.includes("state") ? "state" : "status";
    const amountCol = cc.find((c) => /usd|amount|micro/.test(c)) || null;
    const by = (t, col) => Object.fromEntries(db.prepare(`select ${col} k, count(*) n from ${t} group by ${col} order by ${col}`).all().map((r) => [String(r.k), r.n]));
    out.decide = { counts, creditsByState: by("credits", stateCol), runsByState: by("runs", rc.includes("state") ? "state" : "status"),
      creditsSum: amountCol ? Number(db.prepare(`select coalesce(sum(${amountCol}),0) s from credits`).get().s) : null, amountCol };
    db.close();
  }
}

if (mode === "pg") {
  const sdb = await import("../../src/state-db.js");
  if (process.env.CUTOVER_KEEP_SCHEMA !== "1") await sdb.__dropStateSchema();
  await sdb.closeStateDb();
}
console.log(JSON.stringify(out));
process.exit(0);
