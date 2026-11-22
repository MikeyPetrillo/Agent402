// The correction of stored repeat sales (src/sale-repeats.js holds the rule):
// one implementation, read by the operator script (scripts/sale-repeats.js)
// and the operator routes (/__operator/sale-repeats.json and
// /__operator/sale-repeats/apply in src/server.js).
//
// A dry run reads the repeat rows and the rows they repeat and changes
// nothing (a read-only file handle, or a read-only transaction). The
// correction runs only when `expect` equals the repeat-row count the same
// read finds, in one transaction: each repeat row is copied to
// `sales_repeats` (same columns, plus when it was moved) and removed from
// `sales`. A repeat row that carries an attestation, or that a feedback row
// names, is HELD BACK: a buyer can reach it. A second correction finds no
// row to move.
//
// The summary for an answer (summaryOf) carries counts, dates and tools,
// never a payer, a settlement id or an amount per payer.
import { oneSaleScopeSql, repeatRowsSql } from "./sale-repeats.js";

export const SALE_COLS = ["id", "ts", "slug", "price_usd", "rail", "network", "payer", "tx", "internal", "wire", "quote_usd", "response_sha256", "attest_uid", "attest_tx", "via", "run_key"];
const day = (ms) => new Date(Number(ms)).toISOString().slice(0, 10);

/**
 * The plan from the repeat rows, the rows they repeat and the held-back rows
 * ([{ id, attested, feedback }]). Pure.
 */
export function planOf(repeats, firsts, heldRows) {
  const firstByTx = new Map(firsts.map((r) => [r.tx, r]));
  const held = new Map(heldRows.map((h) => [Number(h.id), h]));
  const byDay = new Map(), bySlug = new Map();
  const plan = { settlements: new Set(), rows: 0, usd: 0, external: 0, externalUsd: 0, internal: 0, otherSlug: 0, otherPayer: 0, heldBack: 0, heldAttested: 0, heldFeedback: 0, firstDay: null, lastDay: null, move: [], list: [] };
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
    const h = held.get(Number(r.id));
    if (h) { plan.heldBack++; if (h.attested) plan.heldAttested++; if (h.feedback) plan.heldFeedback++; } else plan.move.push(Number(r.id));
    plan.list.push({ id: Number(r.id), keptId: f ? Number(f.id) : null, tx: r.tx, day: d, slug: r.slug, keptSlug: f ? f.slug : null, internal: Boolean(Number(r.internal)), heldBack: Boolean(h) });
  }
  plan.byDay = [...byDay].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  plan.bySlug = [...bySlug].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return plan;
}

const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
/** The plan as an answer: counts, dates and tools only. */
export function summaryOf(plan) {
  return {
    settlements: plan.settlements.size,
    rows: plan.rows,
    external: plan.external,
    internal: plan.internal,
    bookedUsd: round6(plan.usd),
    externalUsd: round6(plan.externalUsd),
    firstDay: plan.firstDay,
    lastDay: plan.lastDay,
    otherSlug: plan.otherSlug,
    otherPayer: plan.otherPayer,
    move: plan.move.length,
    heldBack: plan.heldBack,
    heldBackReasons: { attestation: plan.heldAttested, feedback: plan.heldFeedback },
    byDay: plan.byDay.map(([d, n]) => ({ day: d, rows: n })),
    bySlug: plan.bySlug.map(([s, n]) => ({ slug: s, rows: n })),
  };
}

/**
 * The ledger file. `apply` opens it for writing; otherwise read-only.
 * Resolves { plan, applied, refused, moved }: `refused` when apply was asked
 * with an `expect` other than the repeat-row count (nothing is changed).
 */
export async function correctFile(path, { apply = false, expect = null, now = Date.now } = {}) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(path, { readonly: !apply, fileMustExist: true });
  try {
    if (apply) db.pragma("busy_timeout = 5000");
    const read = () => {
      const has = (c) => db.prepare("SELECT 1 FROM pragma_table_info('sales') WHERE name = ?").get(c);
      const cols = SALE_COLS.filter(has);
      const repeats = db.prepare(`SELECT ${cols.map((c) => `s.${c}`).join(", ")} FROM sales s WHERE s.id IN (${repeatRowsSql("sales")}) ORDER BY s.id`).all();
      const firsts = db.prepare(`SELECT f.id, f.tx, f.slug, f.payer FROM sales f WHERE ${oneSaleScopeSql("f")} AND f.id = (SELECT MIN(m.id) FROM sales m WHERE m.tx = f.tx AND ${oneSaleScopeSql("m")}) AND f.tx IN (SELECT r2.tx FROM sales r2 WHERE r2.id IN (${repeatRowsSql("sales")}))`).all();
      const fb = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sale_feedback'").get();
      const named = fb ? db.prepare("SELECT 1 FROM sale_feedback WHERE sale_id = ?") : null;
      const heldRows = repeats.map((r) => ({ id: r.id, attested: Boolean(has("attest_uid") && r.attest_uid), feedback: Boolean(named && named.get(r.id)) })).filter((h) => h.attested || h.feedback);
      return planOf(repeats, firsts, heldRows);
    };
    if (!apply) return { plan: read(), applied: false, refused: false, moved: 0 };
    // The read and the move in one write transaction: no row can land
    // between the count the caller confirmed and the rows moved.
    const all = db.prepare("SELECT name FROM pragma_table_info('sales')").all().map((r) => r.name);
    return db.transaction(() => {
      const plan = read();
      if (plan.rows !== expect) return { plan, applied: false, refused: true, moved: 0 };
      db.exec(`CREATE TABLE IF NOT EXISTS sales_repeats (${all.join(", ")}, moved_at INTEGER NOT NULL)`);
      const copy = db.prepare(`INSERT INTO sales_repeats (${all.join(", ")}, moved_at) SELECT ${all.join(", ")}, ? FROM sales WHERE id = ?`);
      const drop = db.prepare("DELETE FROM sales WHERE id = ?");
      const at = now();
      for (const id of plan.move) { if (copy.run(at, id).changes !== 1 || drop.run(id).changes !== 1) throw new Error(`row ${id} changed under the run`); }
      return { plan, applied: true, refused: false, moved: plan.move.length };
    }).immediate();
  } finally { db.close(); }
}

/**
 * The state database, on a client whose transaction the CALLER opened (BEGIN)
 * and closes (COMMIT, or ROLLBACK on a throw). A dry run makes the
 * transaction read-only before its first read; apply locks the sales table
 * against writers first. Same answer shape as correctFile.
 */
export async function correctPgInTx(client, { schema, apply = false, expect = null, now = Date.now, schemaLockKey = null } = {}) {
  const T = (t) => `${schema}.${t}`;
  if (!apply) await client.query("SET TRANSACTION READ ONLY");
  else await client.query(`LOCK TABLE ${T("sales")} IN SHARE ROW EXCLUSIVE MODE`);
  const repeats = (await client.query(`SELECT ${SALE_COLS.map((c) => `s.${c}`).join(", ")} FROM ${T("sales")} s WHERE s.id IN (${repeatRowsSql(T("sales"))}) ORDER BY s.id`)).rows;
  const firsts = (await client.query(`SELECT f.id, f.tx, f.slug, f.payer FROM ${T("sales")} f WHERE ${oneSaleScopeSql("f")} AND f.id = (SELECT MIN(m.id) FROM ${T("sales")} m WHERE m.tx = f.tx AND ${oneSaleScopeSql("m")}) AND f.tx IN (SELECT r2.tx FROM ${T("sales")} r2 WHERE r2.id IN (${repeatRowsSql(T("sales"))}))`)).rows;
  const named = new Set((await client.query(`SELECT sale_id FROM ${T("sale_feedback")} WHERE sale_id = ANY($1::bigint[])`, [repeats.map((r) => r.id)])).rows.map((r) => Number(r.sale_id)));
  const heldRows = repeats.map((r) => ({ id: r.id, attested: Boolean(r.attest_uid), feedback: named.has(Number(r.id)) })).filter((h) => h.attested || h.feedback);
  const plan = planOf(repeats, firsts, heldRows);
  if (!apply) return { plan, applied: false, refused: false, moved: 0 };
  if (plan.rows !== expect) return { plan, applied: false, refused: true, moved: 0 };
  // A table created in this schema takes the schema-change lock every store takes.
  if (schemaLockKey != null) await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [schemaLockKey, schema]);
  await client.query(`CREATE TABLE IF NOT EXISTS ${T("sales_repeats")} (LIKE ${T("sales")}, moved_at BIGINT NOT NULL)`);
  const moved = await client.query(`WITH gone AS (DELETE FROM ${T("sales")} WHERE id = ANY($1::bigint[]) RETURNING *) INSERT INTO ${T("sales_repeats")} SELECT gone.*, $2::bigint FROM gone`, [plan.move, now()]);
  if (moved.rowCount !== plan.move.length) throw new Error(`moved ${moved.rowCount} of ${plan.move.length}: rolled back`);
  return { plan, applied: true, refused: false, moved: plan.move.length };
}

/** The lease the routes' correction runs under, so two replicas never run it at once. */
export const SALE_REPEATS_LEASE = "sale-repeats-apply";

/**
 * The running server's own ledger: the state database when it is configured
 * (a pooled transaction), else the ledger file at `filePath`. Same answer
 * shape as correctFile. The correction runs under SALE_REPEATS_LEASE and
 * resolves { busy: reason } when another run holds it.
 */
export async function correctServerLedger({ filePath, apply = false, expect = null, timeoutMs = 60_000 } = {}) {
  const sdb = await import("./state-db.js");
  const run = () => (sdb.stateDbEnabled()
    ? sdb.withStateTx((client) => correctPgInTx(client, { schema: sdb.stateDbSchema(), apply, expect, schemaLockKey: sdb.SCHEMA_LOCK_KEY }), { timeoutMs })
    : correctFile(filePath, { apply, expect }));
  if (!apply) return run();
  const r = await sdb.withLease(SALE_REPEATS_LEASE, { ttlMs: Math.max(120_000, timeoutMs * 2), failOpen: false, log: () => {} }, run);
  return r.ran ? r.result : { busy: r.reason };
}
