#!/usr/bin/env node
// Sales rows that repeat a settlement: list them, and (only when told) move
// them off the sales table.
//
//   node scripts/sale-repeats.js --db <agent402-sales.db>            DRY RUN on a ledger file
//   STATE_DATABASE_URL=... node scripts/sale-repeats.js --pg         DRY RUN on the state database
//   ... --json <file>      also write every repeat row (ids, never amounts per payer) to a file
//   ... --apply --expect <rows>   the correction; refuses unless <rows> is the count the dry run printed
//
// THE RULE (src/sale-repeats.js): a Solana settlement signature stands behind
// one sale. A row that names a signature an earlier row already holds is a
// repeat of that sale. The ledger's writer no longer writes one, and every
// reader that counts or sums sales already leaves the stored ones out, so the
// figures are right with no correction at all.
//
// THE CORRECTION (--apply) is for the stored rows: each repeat row is copied
// to `sales_repeats` (same columns, plus when it was moved) and removed from
// `sales`, in one transaction, so a reader outside this codebase (an export,
// a backup, a SQL client) counts the settlement once too. A repeat row that
// carries an attestation, or that a feedback row names, is HELD BACK: a
// buyer can reach it. A running server keeps the rows in its own copy until
// its next restart; its readers leave them out either way.
//
// The default is a dry run: it opens the file read-only (or reads the
// database in a read-only transaction) and changes nothing. It prints counts
// and dates, never a payer.
import { writeFileSync } from "node:fs";
import { oneSaleScopeSql, repeatRowsSql } from "../src/sale-repeats.js";

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const APPLY = has("--apply");
const usage = () => { console.error("usage: node scripts/sale-repeats.js (--db <file> | --pg) [--json <file>] [--apply --expect <rows>]"); process.exit(2); };
if (has("--db") === has("--pg")) usage();
const expect = opt("--expect") == null ? null : Number(opt("--expect"));
if (APPLY && !Number.isInteger(expect)) { console.error("--apply needs --expect <rows>: the repeat-row count the dry run printed"); process.exit(2); }

const COLS = ["id", "ts", "slug", "price_usd", "rail", "network", "payer", "tx", "internal", "wire", "quote_usd", "response_sha256", "attest_uid", "attest_tx", "via", "run_key"];
const day = (ms) => new Date(Number(ms)).toISOString().slice(0, 10);
const usd = (n) => `$${(Number(n) || 0).toFixed(6)}`;

/** The plan from the repeat rows and the rows they repeat. Pure. */
function planOf(repeats, firsts, heldIds) {
  const firstByTx = new Map(firsts.map((r) => [r.tx, r]));
  const held = new Set(heldIds.map(Number));
  const byDay = new Map(), bySlug = new Map();
  const plan = { settlements: new Set(), rows: 0, usd: 0, external: 0, externalUsd: 0, internal: 0, otherSlug: 0, otherPayer: 0, heldBack: 0, firstDay: null, lastDay: null, move: [], list: [] };
  for (const r of repeats) {
    const f = firstByTx.get(r.tx);
    plan.settlements.add(r.tx);
    plan.rows++;
    plan.usd += Number(r.price_usd) || 0;
    if (Number(r.internal)) plan.internal++; else { plan.external++; plan.externalUsd += Number(r.price_usd) || 0; }
    if (f && f.slug !== r.slug) plan.otherSlug++;
    if (f && (f.payer || null) !== (r.payer || null)) plan.otherPayer++;
    const d = day(r.ts);
    if (!plan.firstDay || d < plan.firstDay) plan.firstDay = d;
    if (!plan.lastDay || d > plan.lastDay) plan.lastDay = d;
    byDay.set(d, (byDay.get(d) || 0) + 1);
    bySlug.set(r.slug, (bySlug.get(r.slug) || 0) + 1);
    const isHeld = held.has(Number(r.id));
    if (isHeld) plan.heldBack++; else plan.move.push(Number(r.id));
    plan.list.push({ id: Number(r.id), keptId: f ? Number(f.id) : null, tx: r.tx, day: d, slug: r.slug, keptSlug: f ? f.slug : null, internal: Boolean(Number(r.internal)), heldBack: isHeld });
  }
  plan.byDay = [...byDay].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  plan.bySlug = [...bySlug].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return plan;
}

function print(plan, where) {
  const lines = [];
  lines.push(`${APPLY ? "APPLY" : "DRY RUN (nothing is changed)"}: ${where}`);
  lines.push(`settlements booked more than once: ${plan.settlements.size}`);
  lines.push(`repeat rows: ${plan.rows} (${plan.external} external, ${plan.internal} our own), ${plan.firstDay || "none"} to ${plan.lastDay || "none"}`);
  lines.push(`booked in the repeat rows: ${usd(plan.usd)} (${usd(plan.externalUsd)} external)`);
  lines.push(`repeat rows under another tool than the first row: ${plan.otherSlug}; under another payer: ${plan.otherPayer}`);
  lines.push(`held back (an attestation or a feedback row names the row): ${plan.heldBack}`);
  lines.push(`a correction would move ${plan.move.length} row(s) from sales to sales_repeats and leave ${plan.settlements.size} settlement(s) with one sale each${plan.heldBack ? ` (${plan.heldBack} held back stay)` : ""}`);
  if (plan.byDay.length) lines.push(`by day: ${plan.byDay.map(([d, n]) => `${d} ${n}`).join(", ")}`);
  if (plan.bySlug.length) lines.push(`by tool: ${plan.bySlug.slice(0, 15).map(([s, n]) => `${s} ${n}`).join(", ")}${plan.bySlug.length > 15 ? `, and ${plan.bySlug.length - 15} more` : ""}`);
  for (const l of lines) console.log(l);
}

function finish(plan) {
  const out = opt("--json");
  if (out) { writeFileSync(out, JSON.stringify({ settlements: plan.settlements.size, rows: plan.rows, move: plan.move.length, heldBack: plan.heldBack, list: plan.list }, null, 1)); console.log(`wrote ${plan.list.length} row(s) to ${out}`); }
}

function refuseUnlessExpected(plan) {
  if (plan.rows !== expect) { console.error(`refused: --expect ${expect} but the store holds ${plan.rows} repeat row(s); run the dry run again and read it`); process.exit(3); }
}

async function runFile(path) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(path, { readonly: !APPLY, fileMustExist: true });
  try {
    const has = (c) => db.prepare("SELECT 1 FROM pragma_table_info('sales') WHERE name = ?").get(c);
    const cols = COLS.filter(has);
    const repeats = db.prepare(`SELECT ${cols.map((c) => `s.${c}`).join(", ")} FROM sales s WHERE s.id IN (${repeatRowsSql("sales")}) ORDER BY s.id`).all();
    const firsts = db.prepare(`SELECT f.id, f.tx, f.slug, f.payer FROM sales f WHERE ${oneSaleScopeSql("f")} AND f.id = (SELECT MIN(m.id) FROM sales m WHERE m.tx = f.tx AND ${oneSaleScopeSql("m")}) AND f.tx IN (SELECT r2.tx FROM sales r2 WHERE r2.id IN (${repeatRowsSql("sales")}))`).all();
    const fb = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sale_feedback'").get();
    const heldIds = repeats.filter((r) => (has("attest_uid") && r.attest_uid) || (fb && db.prepare("SELECT 1 FROM sale_feedback WHERE sale_id = ?").get(r.id))).map((r) => r.id);
    const plan = planOf(repeats, firsts, heldIds);
    print(plan, `ledger file ${path}`);
    finish(plan);
    if (!APPLY) return;
    refuseUnlessExpected(plan);
    const all = db.prepare("SELECT name FROM pragma_table_info('sales')").all().map((r) => r.name);
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS sales_repeats (${all.map((c) => `${c}`).join(", ")}, moved_at INTEGER NOT NULL)`);
      const copy = db.prepare(`INSERT INTO sales_repeats (${all.join(", ")}, moved_at) SELECT ${all.join(", ")}, ? FROM sales WHERE id = ?`);
      const drop = db.prepare("DELETE FROM sales WHERE id = ?");
      const now = Date.now();
      for (const id of plan.move) { if (copy.run(now, id).changes !== 1 || drop.run(id).changes !== 1) throw new Error(`row ${id} changed under the run`); }
    })();
    console.log(`moved ${plan.move.length} row(s) to sales_repeats`);
  } finally { db.close(); }
}

async function runPg() {
  const { default: pg } = await import("pg");
  const { stateDbUrl, stateDbSchema } = await import("../src/state-db.js");
  const url = stateDbUrl();
  if (!url) { console.error("--pg needs STATE_DATABASE_URL"); process.exit(2); }
  const schema = stateDbSchema();
  const T = (t) => `${schema}.${t}`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(APPLY ? "BEGIN" : "BEGIN TRANSACTION READ ONLY");
    if (APPLY) await client.query(`LOCK TABLE ${T("sales")} IN SHARE ROW EXCLUSIVE MODE`);
    const repeats = (await client.query(`SELECT ${COLS.map((c) => `s.${c}`).join(", ")} FROM ${T("sales")} s WHERE s.id IN (${repeatRowsSql(T("sales"))}) ORDER BY s.id`)).rows;
    const firsts = (await client.query(`SELECT f.id, f.tx, f.slug, f.payer FROM ${T("sales")} f WHERE ${oneSaleScopeSql("f")} AND f.id = (SELECT MIN(m.id) FROM ${T("sales")} m WHERE m.tx = f.tx AND ${oneSaleScopeSql("m")}) AND f.tx IN (SELECT r2.tx FROM ${T("sales")} r2 WHERE r2.id IN (${repeatRowsSql(T("sales"))}))`)).rows;
    const named = new Set((await client.query(`SELECT sale_id FROM ${T("sale_feedback")} WHERE sale_id = ANY($1::bigint[])`, [repeats.map((r) => r.id)])).rows.map((r) => Number(r.sale_id)));
    const heldIds = repeats.filter((r) => r.attest_uid || named.has(Number(r.id))).map((r) => r.id);
    const plan = planOf(repeats, firsts, heldIds);
    print(plan, `state database, schema ${schema}`);
    finish(plan);
    if (!APPLY) { await client.query("ROLLBACK"); return; }
    refuseUnlessExpected(plan);
    await client.query(`CREATE TABLE IF NOT EXISTS ${T("sales_repeats")} (LIKE ${T("sales")}, moved_at BIGINT NOT NULL)`);
    const moved = await client.query(`WITH gone AS (DELETE FROM ${T("sales")} WHERE id = ANY($1::bigint[]) RETURNING *) INSERT INTO ${T("sales_repeats")} SELECT gone.*, $2::bigint FROM gone`, [plan.move, Date.now()]);
    if (moved.rowCount !== plan.move.length) throw new Error(`moved ${moved.rowCount} of ${plan.move.length}: rolled back`);
    await client.query("COMMIT");
    console.log(`moved ${plan.move.length} row(s) to ${T("sales_repeats")}; a running server drops them from its own copy at its next restart`);
  } catch (e) { try { await client.query("ROLLBACK"); } catch { /* closed */ } throw e; }
  finally { await client.end(); }
}

if (has("--db")) { const p = opt("--db"); if (!p) usage(); await runFile(p); }
else await runPg();
