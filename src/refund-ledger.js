// The refund ledger: every buyer who paid and did not get their answer, until
// they are made whole.
//
// Settlement ordering makes charged-but-failed RARE - a >=400 cancels
// settlement, so the buyer normally keeps their money - but rare is not never:
// a settle receipt with success:true on a response that then went out non-200
// means USDC moved and nothing was delivered. Today that moment is an odometer
// (stats.js charged_failures) and a PostHog event; neither can drive a refund,
// because the odometer keeps only slug/status/ts and events are not a ledger.
//
// This table records the debt itself: who is owed, how much, on which chain,
// with the settle transaction as evidence, and whether it has been repaid.
// The refund EXECUTOR (scripts/refund-run.js, a dispatch-only workflow with
// its own keys and caps) reads this via the operator endpoint - the server
// never holds a spending key and never sends money.
//
// Design rules:
//   * IDEMPOTENT on evidence: one settle tx = one debt, however many times the
//     detection path fires. Without a tx (some rails omit it), the fallback
//     identity is payer+slug+minute, which cannot double-record a burst.
//   * synthetic (canary/heartbeat) rows are recorded but FLAGGED - the ledger
//     must reflect reality, and the executor skips them by default because
//     refunding our own burner is churn, not justice.
//   * append + status only; rows are never deleted. paid/void need a note or
//     tx so the ledger stays auditable.
//   * never throws into the serving path - recording a debt must not break
//     the response that just failed.
//
// Where it lives. Without a state database (STATE_DATABASE_URL unset) the
// table is the SQLite file on the volume and every export is synchronous, as
// it always was. With one, the table is in Postgres and the SQLite handle
// below is an in-memory MIRROR of it: the readers (listRefunds, refundTotals,
// refundAlarmStatus, refundsCreatedBetween, refundsForPayer, refundByEvidence)
// stay synchronous and read the mirror; every WRITE is one Postgres statement
// with RETURNING, lands in call order, is written into the mirror when it
// lands, and the function returns a Promise of the same verdict it returns
// synchronously in file mode. A status transition is decided by Postgres
// alone (UPDATE ... WHERE status = ... RETURNING), so two containers can never
// both claim one row. The mirror pulls other containers' writes every
// REFRESH_MS. The file is imported once (agent402-refunds.db in the imports
// table) at the first boot with the database on, and while its directory is
// there every landed write is also written into it (write-through), so a
// rollback to the file-only build reads a current ledger.
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stateDbEnabled, stateDbSchema, stateQuery, importOnce, trackStoreReady } from "./state-db.js";
import { PG_NOW_MS, REFRESH_MS, REFRESH_MARGIN_MS, sqliteFileRows, serialQueue, insertRows, syncIdSequence, everyMs, makeWarnOnce } from "./ledger-mirror.js";

const HAS_DATA_DIR = existsSync("/data");
const DATA_DIR = process.env.REFUND_DB_DIR || (HAS_DATA_DIR ? "/data" : "/tmp");
const DB_FILE = join(DATA_DIR, "agent402-refunds.db");
const IMPORT_NAME = "agent402-refunds.db";
const USE_PG = stateDbEnabled();
/** "pg" when the ledger lives in the state database, "file" when it is the SQLite file. */
export const refundLedgerBackend = USE_PG ? "pg" : "file";
const db = new Database(USE_PG ? ":memory:" : DB_FILE);
if (!USE_PG) db.pragma("journal_mode = WAL");
// Write-through (database mode): while the volume is still mounted, every
// landed write is also applied to the file, so a rollback to the previous
// build reads a current ledger. Best effort, never the verdict, logged once.
const fileDb = USE_PG && existsSync(DATA_DIR) ? (() => { try { const f = new Database(DB_FILE); f.pragma("journal_mode = WAL"); return f; } catch { return null; } })() : null;

for (const h of [db, fileDb]) if (h) h.exec(`
  CREATE TABLE IF NOT EXISTS refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence TEXT NOT NULL UNIQUE,      -- settle tx, or payer|slug|minute fallback
    slug TEXT NOT NULL,
    network TEXT,                       -- CAIP-2 as settled
    payer TEXT,                         -- verified payer address (case preserved!)
    priceUsd REAL NOT NULL DEFAULT 0,
    httpStatus INTEGER,
    synthetic INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'owed',-- owed | paid | void
    paidTx TEXT,
    note TEXT,
    createdAt INTEGER NOT NULL,
    resolvedAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS refunds_status ON refunds (status);
`);
// Additive column (2026-09-24): which payment wire carried the charge
// ("x402", "mpp", "mpp-tempo", "mpp-stripe"). The MPP reconciliation job
// (src/mpp-reconcile.js) counts paid-but-failed MPP calls from it; a NULL is
// a row recorded before the column existed.
for (const h of [db, fileDb]) if (h) { try { h.exec("ALTER TABLE refunds ADD COLUMN wire TEXT"); } catch { /* exists */ } }
// Additive column: on a disconnect debt (http 499), why the run was not
// forgiven - the forgiveness ticket's denial reason ("payer budget", "ip
// budget", "global budget", "lasting effect", ...), "settled in flight" when a
// granted ticket lost the race to a settle already under way, "no ticket" when
// none was reserved. The refund planner holds the budget denials for review
// (scripts/refund-run.js). NULL on every other debt and on rows written before
// the column existed.
for (const h of [db, fileDb]) if (h) { try { h.exec("ALTER TABLE refunds ADD COLUMN hangupReason TEXT"); } catch { /* exists */ } }
// Additive column (2026-10-06): when a row was claimed for sending, so the
// refund alarm can tell a run in progress (seconds) from a row stuck mid-send.
// NULL on a sending row means it was claimed before the column existed:
// treated as stuck.
for (const h of [db, fileDb]) if (h) { try { h.exec("ALTER TABLE refunds ADD COLUMN claimedAt INTEGER"); } catch { /* exists */ } }

const insertOwed = db.prepare(`
  INSERT OR IGNORE INTO refunds (evidence, slug, network, payer, priceUsd, httpStatus, synthetic, createdAt, wire, hangupReason, note)
  VALUES (@evidence, @slug, @network, @payer, @priceUsd, @httpStatus, @synthetic, @createdAt, @wire, @hangupReason, @note)
`);
const selectByEvidence = db.prepare("SELECT * FROM refunds WHERE evidence = ?");
// Only an OWED row: a row already being sent or paid is never quietly voided.
const voidOwedByEvidence = db.prepare(`
  UPDATE refunds SET status = 'void', note = CASE WHEN note IS NULL OR note = '' THEN @note ELSE note || '; ' || @note END, resolvedAt = @resolvedAt
  WHERE evidence = @evidence AND status = 'owed'
`);
const renoteOwed = db.prepare("UPDATE refunds SET note = @to WHERE evidence = @evidence AND status = 'owed' AND note = @from");
// A push debt booked as "input refused" whose transfer was then claimed on a
// retry that the buyer hung up on: the same evidence, now a disconnect. Owed
// rows only, and only while the note still reads the input refusal.
const promoteHangup = db.prepare(`
  UPDATE refunds SET httpStatus = 499, hangupReason = @hangupReason,
    note = CASE WHEN note IS NULL OR note = '' THEN @append ELSE note || '; ' || @append END
  WHERE evidence = @evidence AND status = 'owed' AND note = @from
`);
// The same rewrite for a claimed push whose handler then failed: the owed
// input-refused row takes the handler's status and says what happened.
const restateHandlerFailure = db.prepare(`
  UPDATE refunds SET httpStatus = @httpStatus,
    note = CASE WHEN note IS NULL OR note = '' THEN @append ELSE note || '; ' || @append END
  WHERE evidence = @evidence AND status = 'owed' AND note = @from
`);
const selectByStatus = db.prepare("SELECT * FROM refunds WHERE status = ? ORDER BY id DESC LIMIT ?");
const selectAll = db.prepare("SELECT * FROM refunds ORDER BY id DESC LIMIT ?");
const resolveRow = db.prepare(`
  UPDATE refunds SET status = @status, paidTx = @paidTx, note = @note, resolvedAt = @resolvedAt
  WHERE id = @id AND status IN ('owed', 'sending')
`);
// Claim a row BEFORE money moves. See claimRefundForSend().
const claimRow = db.prepare(`
  UPDATE refunds SET status = 'sending', note = @note, resolvedAt = NULL, claimedAt = @claimedAt
  WHERE id = @id AND status = 'owed'
`);
// Release a stuck claim back to owed. See releaseStuckSend().
const releaseRow = db.prepare(`
  UPDATE refunds SET status = 'owed', note = @note, resolvedAt = NULL, claimedAt = NULL
  WHERE id = @id AND status = 'sending'
`);
const oldestOwedQ = db.prepare("SELECT count(*) AS n, min(createdAt) AS oldest FROM refunds WHERE status = 'owed' AND createdAt < ?");
const stuckSendingQ = db.prepare("SELECT count(*) AS n FROM refunds WHERE status = 'sending' AND (claimedAt IS NULL OR claimedAt < ?)");
const totalsQ = db.prepare(`
  SELECT status, count(*) AS n, sum(priceUsd) AS usd, sum(synthetic) AS synth
  FROM refunds GROUP BY status
`);

// ---- the state database -------------------------------------------------------
// Postgres columns are snake_case; the mirror keeps the file's camelCase so
// every reader above, and every consumer of its rows, sees the same shape.
const T = (t) => `${stateDbSchema()}.${t}`;
const PG_COLS = ["id", "evidence", "slug", "network", "payer", "price_usd", "http_status", "synthetic", "status", "paid_tx", "note", "created_at", "resolved_at", "wire", "hangup_reason", "claimed_at"];
const PG_DDL = () => `
  CREATE TABLE IF NOT EXISTS ${T("refunds")} (
    id            BIGSERIAL PRIMARY KEY,
    evidence      TEXT NOT NULL UNIQUE,
    slug          TEXT NOT NULL,
    network       TEXT,
    payer         TEXT,
    price_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
    http_status   INTEGER,
    synthetic     INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'owed',
    paid_tx       TEXT,
    note          TEXT,
    created_at    BIGINT NOT NULL,
    resolved_at   BIGINT,
    wire          TEXT,
    hangup_reason TEXT,
    claimed_at    BIGINT,
    updated_at    BIGINT NOT NULL DEFAULT ${PG_NOW_MS}
  );
  CREATE INDEX IF NOT EXISTS refunds_status ON ${T("refunds")} (status);
  CREATE INDEX IF NOT EXISTS refunds_updated_at ON ${T("refunds")} (updated_at);
`;
const mirrorUpsert = db.prepare(`
  INSERT OR REPLACE INTO refunds (id, evidence, slug, network, payer, priceUsd, httpStatus, synthetic, status, paidTx, note, createdAt, resolvedAt, wire, hangupReason, claimedAt)
  VALUES (@id, @evidence, @slug, @network, @payer, @priceUsd, @httpStatus, @synthetic, @status, @paidTx, @note, @createdAt, @resolvedAt, @wire, @hangupReason, @claimedAt)
`);
const fileUpsert = fileDb ? fileDb.prepare(mirrorUpsert.source) : null;
const num = (v) => (v == null ? null : Number(v));
let lastUpdated = 0;   // newest updated_at the mirror holds (server clock, ms)
let loaded = false;    // the first pull finished: the readers answer from a full mirror
let ready = null;
let refreshing = false;
const warnOnce = makeWarnOnce("refund-ledger");
const enqueue = serialQueue();

const pgToMirror = (r) => ({
  id: Number(r.id), evidence: r.evidence, slug: r.slug, network: r.network ?? null, payer: r.payer ?? null,
  priceUsd: Number(r.price_usd) || 0, httpStatus: num(r.http_status), synthetic: Number(r.synthetic) || 0,
  status: r.status, paidTx: r.paid_tx ?? null, note: r.note ?? null, createdAt: Number(r.created_at),
  resolvedAt: num(r.resolved_at), wire: r.wire ?? null, hangupReason: r.hangup_reason ?? null, claimedAt: num(r.claimed_at),
});
function applyPgRow(r) {
  mirrorUpsert.run(pgToMirror(r));
  const u = Number(r.updated_at) || 0;
  if (u > lastUpdated) lastUpdated = u;
}
let writeThroughWarned = false;
/** The landed row into the file (same id, same evidence), so a rolled-back build reads it. */
function writeThroughRow(r) {
  if (!fileUpsert) return;
  try { fileUpsert.run(pgToMirror(r)); }
  catch (e) { if (!writeThroughWarned) { writeThroughWarned = true; console.warn(`[refund-ledger] write-through to ${DB_FILE} failed: ${String(e?.message || e).slice(0, 120)}`); } }
}
const applyPgRows = db.transaction((rows) => { for (const r of rows) applyPgRow(r); });
const fileToPg = (r) => ({
  id: r.id, evidence: r.evidence, slug: r.slug, network: r.network ?? null, payer: r.payer ?? null,
  price_usd: Number(r.priceUsd) || 0, http_status: r.httpStatus ?? null, synthetic: r.synthetic ? 1 : 0,
  status: r.status || "owed", paid_tx: r.paidTx ?? null, note: r.note ?? null, created_at: Number(r.createdAt) || 0,
  resolved_at: r.resolvedAt ?? null, wire: r.wire ?? null, hangup_reason: r.hangupReason ?? null, claimed_at: r.claimedAt ?? null,
});

/** The file's rows into the table, once: insert-if-absent, so a second container importing at the same time is harmless. */
async function importFile() {
  const { rows, bytes } = sqliteFileRows(DB_FILE, "refunds");
  if (!rows.length) return { bytes, rows: 0 };
  const n = await insertRows(stateQuery, T("refunds"), PG_COLS, rows.map(fileToPg), { conflict: "ON CONFLICT DO NOTHING" });
  await syncIdSequence(stateQuery, T("refunds"));
  console.log(`[refund-ledger] imported ${n} of ${rows.length} row(s) from ${DB_FILE}`);
  return { bytes, rows: n };
}
async function pullAll() {
  const r = await stateQuery(`SELECT * FROM ${T("refunds")} ORDER BY id`);
  db.transaction((rows) => { db.exec("DELETE FROM refunds"); for (const x of rows) applyPgRow(x); })(r.rows);
  loaded = true;
}
/** Rows another container wrote since the last pull (with a margin; upserts are idempotent). */
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const r = await stateQuery(`SELECT * FROM ${T("refunds")} WHERE updated_at > $1 ORDER BY updated_at, id`, [Math.max(0, lastUpdated - REFRESH_MARGIN_MS)]);
    if (r.rows.length) applyPgRows(r.rows);
  } finally { refreshing = false; }
}
async function refreshWhere(where, params) {
  const r = await stateQuery(`SELECT * FROM ${T("refunds")} WHERE ${where}`, params);
  if (r.rows.length) applyPgRows(r.rows);
}
async function firstLoad() {
  await stateQuery(PG_DDL());
  await importOnce(IMPORT_NAME, { source: DB_FILE, run: importFile });
  await pullAll();
  everyMs(refresh, REFRESH_MS);
}
function readyP() {
  if (!USE_PG) return Promise.resolve();
  if (!ready) {
    ready = firstLoad().catch((e) => {
      ready = null; // the next write or refresh tries the load again
      warnOnce("first load", e);
      throw e;
    });
  }
  return ready;
}
if (USE_PG) trackStoreReady(readyP());

/** One queued Postgres write: lands after every earlier write, never rejects (a failed write resolves false, logged once a minute). */
function pgWrite(label, fn) {
  return enqueue(async () => {
    try { await readyP(); return await fn(); }
    catch (e) { warnOnce(label, e); return false; }
  });
}
/** A refusal before any write: the same `false`, in the mode's shape. */
const refuse = () => (USE_PG ? Promise.resolve(false) : false);
/** Apply an UPDATE's RETURNING row; on no row, re-read what another container left there. */
async function applyOrRefresh(r, where, params) {
  if (r.rows[0]) { applyPgRow(r.rows[0]); writeThroughRow(r.rows[0]); return true; }
  await refreshWhere(where, params).catch(() => {});
  return false;
}
const NOTE_CASE = (p) => `CASE WHEN note IS NULL OR note = '' THEN ${p}::text ELSE note || '; ' || ${p}::text END`;

/** Resolves once the first load (DDL, the one-time file import, the full pull) is done; immediately in file mode. */
export function refundLedgerReady() { return readyP().catch(() => {}); }
/** Resolves once every queued write has landed (tests and shutdown). */
export function refundLedgerFlush() { return enqueue(async () => {}); }
/** Pull other containers' writes now (the timer does this every REFRESH_MS). */
export async function refundLedgerRefresh() { if (!USE_PG) return; await readyP(); await refresh(); }

/**
 * Does this settle receipt PROVE the buyer was charged?
 *
 * The charged-failure ALARM deliberately fires on ambiguity too - for a
 * warning, unclear should be loud. A DEBT is money leaving a wallet, so it
 * needs positive proof: only an explicit `success === true`.
 *
 * Without this split, any future middleware change that made the receipt
 * unparseable would mint a refundable debt on every failing paid call, with no
 * evidence anyone was charged - and with no tx to key on, one fresh row per
 * slug per minute. The receipt itself is unforgeable (a RESPONSE header
 * written only by @x402/express, never echoed from a request), so
 * `success:true` is trustworthy; the gap was trusting the ABSENCE of a field.
 */
export function receiptProvesCharge(receipt) {
  return !!receipt && typeof receipt === "object" && receipt.success === true;
}

/** Record a debt. Returns true when a NEW row was created (false = duplicate
 *  evidence, already on the books). Addresses are stored exactly as given -
 *  base58/base32 rails are case-sensitive and must never be folded.
 *  Database mode: returns a Promise of that verdict, resolved only once the
 *  row is in Postgres (the write is queued behind earlier writes). */
export function recordRefundOwed({ slug, network, payer, priceUsd, tx, httpStatus, synthetic, wire, hangupReason, note = null } = {}) {
  try {
    const evidence = (typeof tx === "string" && tx.trim())
      ? tx.trim()
      : `${payer || "unknown"}|${slug || "unknown"}|${Math.floor(Date.now() / 60_000)}`;
    const row = {
      evidence,
      slug: String(slug || "unknown"),
      network: network ? String(network) : null,
      payer: payer ? String(payer) : null,
      priceUsd: Number(priceUsd) || 0,
      httpStatus: Number(httpStatus) || null,
      synthetic: synthetic ? 1 : 0,
      createdAt: Date.now(),
      wire: wire ? String(wire).slice(0, 40) : null,
      hangupReason: hangupReason ? String(hangupReason).slice(0, 40) : null,
      note: typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : null,
    };
    if (USE_PG) {
      return pgWrite("record", async () => {
        const r = await stateQuery(
          `INSERT INTO ${T("refunds")} (evidence, slug, network, payer, price_usd, http_status, synthetic, created_at, wire, hangup_reason, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (evidence) DO NOTHING RETURNING *`,
          [row.evidence, row.slug, row.network, row.payer, row.priceUsd, row.httpStatus, row.synthetic, row.createdAt, row.wire, row.hangupReason, row.note],
        );
        return applyOrRefresh(r, "evidence = $1", [row.evidence]);
      });
    }
    const info = insertOwed.run(row);
    return info.changes > 0;
  } catch {
    return refuse(); // recording a debt must never break the serving path
  }
}

// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function listRefunds({ status = "owed", limit = 200 } = {}) {
  try {
    return status === "all" ? selectAll.all(limit) : selectByStatus.all(status, limit);
  } catch { return []; }
}

/**
 * Claim a debt for sending, BEFORE the transfer is broadcast.
 *
 * Without this the pipeline had a double-refund window: the executor sent the
 * money and then marked the row paid, so a failure in between (network blip on
 * the mark call) left the row `owed` while the funds were already gone. The
 * next run re-verifies the INBOUND payment - which is true forever, that is the
 * point of it - and pays a second time. Verification proves we were paid; it
 * can never prove we have not already refunded.
 *
 * So a row is moved to `sending` first, and only `owed` rows can be claimed:
 * a crash after this point leaves it stuck in `sending`, which the executor
 * refuses to touch and a human resolves. A stuck row costs a delay; a double
 * refund costs money twice and is invisible.
 *
 * Returns true only for the claimer that won the row. Database mode: a
 * Promise of it, decided by one `UPDATE ... WHERE status = 'owed' RETURNING`
 * in Postgres, so two containers can never both win.
 */
export function claimRefundForSend(id, note = null) {
  if (USE_PG) {
    return pgWrite("claim", async () => {
      const r = await stateQuery(
        `UPDATE ${T("refunds")} SET status = 'sending', note = $2, resolved_at = NULL, claimed_at = $3, updated_at = ${PG_NOW_MS}
         WHERE id = $1 AND status = 'owed' RETURNING *`,
        [Number(id), note, Date.now()],
      );
      return applyOrRefresh(r, "id = $1", [Number(id)]);
    });
  }
  try { return claimRow.run({ id, note, claimedAt: Date.now() }).changes > 0; } catch { return false; }
}

/**
 * Put a row stuck in `sending` back in the owed queue. Only for a human who
 * has checked the chain and found that nothing left the wallet (no transfer to
 * the payer, nonce not advanced): the next run then verifies and pays it like
 * any other debt. Requires a note saying what was checked. Never touches an
 * owed, paid or void row. Database mode: a Promise of the verdict.
 */
export function releaseStuckSend(id, note) {
  if (!note || typeof note !== "string" || !note.trim()) return refuse();
  if (USE_PG) {
    return pgWrite("release", async () => {
      const r = await stateQuery(
        `UPDATE ${T("refunds")} SET status = 'owed', note = $2, resolved_at = NULL, claimed_at = NULL, updated_at = ${PG_NOW_MS}
         WHERE id = $1 AND status = 'sending' RETURNING *`,
        [Number(id), note.trim()],
      );
      return applyOrRefresh(r, "id = $1", [Number(id)]);
    });
  }
  try { return releaseRow.run({ id, note: note.trim() }).changes > 0; } catch { return false; }
}

function resolvePg(label, id, status, paidTx, note) {
  return pgWrite(label, async () => {
    const r = await stateQuery(
      `UPDATE ${T("refunds")} SET status = $2, paid_tx = $3, note = $4, resolved_at = $5, updated_at = ${PG_NOW_MS}
       WHERE id = $1 AND status IN ('owed', 'sending') RETURNING *`,
      [Number(id), status, paidTx, note, Date.now()],
    );
    return applyOrRefresh(r, "id = $1", [Number(id)]);
  });
}

/** Mark a debt repaid. Requires the outbound transaction - a refund without
 *  evidence is a deletion wearing a nicer name. Only `owed` rows transition.
 *  Database mode: a Promise of the verdict. */
export function markRefundPaid(id, paidTx, note = null) {
  // "undefined"/"null" as a STRING is what a sender produces when it reads the
  // wrong field off an SDK response. It passes a non-empty check while being
  // no evidence at all, in the one column the ledger treats as proof.
  const bad = new Set(["undefined", "null", "nan", "false", "0"]);
  if (!paidTx || typeof paidTx !== "string" || !paidTx.trim()) return refuse();
  if (bad.has(paidTx.trim().toLowerCase())) return refuse();
  if (USE_PG) return resolvePg("paid", id, "paid", paidTx.trim(), note);
  try {
    return resolveRow.run({ id, status: "paid", paidTx: paidTx.trim(), note, resolvedAt: Date.now() }).changes > 0;
  } catch { return false; }
}

/** Void a debt (bad detection, unreachable payer, dust). Requires a note -
 *  writing off a customer's money silently is exactly what this ledger exists
 *  to prevent. Database mode: a Promise of the verdict. */
export function markRefundVoid(id, note) {
  if (!note || typeof note !== "string" || !note.trim()) return refuse();
  if (USE_PG) return resolvePg("void", id, "void", null, note.trim());
  try {
    return resolveRow.run({ id, status: "void", paidTx: null, note: note.trim(), resolvedAt: Date.now() }).changes > 0;
  } catch { return false; }
}

/** The row recorded under this evidence (a settle tx or push hash), or null.
 *  Database mode: from the mirror (this process's landed writes, plus other
 *  containers' writes as of the last refresh). */
export function refundByEvidence(evidence) {
  try { return (typeof evidence === "string" && evidence.trim() && selectByEvidence.get(evidence.trim())) || null; } catch { return null; }
}

/** A debt booked for a payment that has since been claimed for the request it
 *  paid (a Tempo push transfer refused on input, then presented again and
 *  served): void it, so the buyer is never both served and refunded. Requires
 *  a note like every void; touches an OWED row only. Returns true when a row
 *  was voided (database mode: a Promise of it). */
export function voidOwedOnClaim(evidence, note) {
  if (typeof evidence !== "string" || !evidence.trim() || !note || typeof note !== "string" || !note.trim()) return refuse();
  if (USE_PG) {
    const ev = evidence.trim();
    return pgWrite("void-on-claim", async () => {
      const r = await stateQuery(
        `UPDATE ${T("refunds")} SET status = 'void', note = ${NOTE_CASE("$2")}, resolved_at = $3, updated_at = ${PG_NOW_MS}
         WHERE evidence = $1 AND status = 'owed' RETURNING *`,
        [ev, note.trim(), Date.now()],
      );
      return applyOrRefresh(r, "evidence = $1", [ev]);
    });
  }
  try { return voidOwedByEvidence.run({ evidence: evidence.trim(), note: note.trim(), resolvedAt: Date.now() }).changes > 0; } catch { return false; }
}

/** Rewrite an OWED row's note from `from` to `to`, exactly once: the row
 *  changes only while its note currently reads `from`. Returns true
 *  when it did (so a caller can act once per transition); database mode: a
 *  Promise of it. */
export function renoteOwedRefund(evidence, from, to) {
  if (USE_PG) {
    const ev = String(evidence || "").trim();
    return pgWrite("renote", async () => {
      const r = await stateQuery(
        `UPDATE ${T("refunds")} SET note = $3, updated_at = ${PG_NOW_MS} WHERE evidence = $1 AND status = 'owed' AND note = $2 RETURNING *`,
        [ev, from, to],
      );
      return applyOrRefresh(r, "evidence = $1", [ev]);
    });
  }
  try { return renoteOwed.run({ evidence: String(evidence || "").trim(), from, to }).changes > 0; } catch { return false; }
}

/** Turn an OWED row whose note reads `from` into a disconnect debt (http 499,
 *  `hangupReason`, `append` added to the note), so the refund planner's
 *  hang-up holds apply to it. Never touches a sending, paid or void row.
 *  Returns true when it did; database mode: a Promise of it. */
export function promoteOwedToHangup(evidence, { from, hangupReason, append } = {}) {
  if (typeof evidence !== "string" || !evidence.trim() || !from || !append) return refuse();
  const ev = evidence.trim();
  const reason = hangupReason ? String(hangupReason).slice(0, 40) : null;
  const add = String(append).slice(0, 120);
  if (USE_PG) {
    return pgWrite("promote-hangup", async () => {
      const r = await stateQuery(
        `UPDATE ${T("refunds")} SET http_status = 499, hangup_reason = $3, note = ${NOTE_CASE("$4")}, updated_at = ${PG_NOW_MS}
         WHERE evidence = $1 AND status = 'owed' AND note = $2 RETURNING *`,
        [ev, from, reason, add],
      );
      return applyOrRefresh(r, "evidence = $1", [ev]);
    });
  }
  try {
    return promoteHangup.run({ evidence: ev, from, append: add, hangupReason: reason }).changes > 0;
  } catch { return false; }
}

/** An OWED row whose note is exactly `from` takes a handler's failure status
 *  (>= 400, never 499: disconnects go through promoteOwedToHangup) and gains
 *  `append` in its note. Rows being sent, paid or void are never touched.
 *  True when the row changed; database mode: a Promise of it. */
export function restateOwedAsHandlerFailure(evidence, { from, httpStatus, append } = {}) {
  const st = Number(httpStatus);
  if (typeof evidence !== "string" || !evidence.trim() || !from || !append || !Number.isInteger(st) || st < 400 || st === 499) return refuse();
  const ev = evidence.trim();
  const add = String(append).slice(0, 120);
  if (USE_PG) {
    return pgWrite("restate-failure", async () => {
      const r = await stateQuery(
        `UPDATE ${T("refunds")} SET http_status = $3, note = ${NOTE_CASE("$4")}, updated_at = ${PG_NOW_MS}
         WHERE evidence = $1 AND status = 'owed' AND note = $2 RETURNING *`,
        [ev, from, st, add],
      );
      return applyOrRefresh(r, "evidence = $1", [ev]);
    });
  }
  try {
    return restateHandlerFailure.run({ evidence: ev, from, append: add, httpStatus: st }).changes > 0;
  } catch { return false; }
}

// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function refundTotals() {
  try {
    const out = { owed: { n: 0, usd: 0 }, paid: { n: 0, usd: 0 }, void: { n: 0, usd: 0 } };
    out.sending = { n: 0, usd: 0 };   // in-flight or stuck mid-send; needs a human
    for (const r of totalsQ.all()) {
      if (out[r.status]) out[r.status] = { n: r.n, usd: Number((r.usd || 0).toFixed(6)), synthetic: r.synth || 0 };
    }
    return out;
  } catch { return { owed: { n: 0, usd: 0 }, paid: { n: 0, usd: 0 }, void: { n: 0, usd: 0 } }; }
}

/**
 * One word for the alarm: is anyone waiting on money we owe them?
 *  - "stuck": a row has sat in `sending` past `stuckMinutes` (a run takes
 *    seconds per row), so a human must check the chain and resolve it.
 *  - "aging": a debt has been owed longer than `owedHours`. Debts held for
 *    review (hang-up budget denials) count too: 44 of them sat unnoticed for
 *    a day before this alarm existed.
 *  - "ok" otherwise; "unknown" if the ledger cannot be read (in database
 *    mode, also until the first pull from Postgres has finished).
 * Counts are for the operator view only; the public view is the word.
 */
export function refundAlarmStatus({ owedHours = 48, stuckMinutes = 30, now = Date.now() } = {}) {
  if (USE_PG && !loaded) return { status: "unknown" };
  try {
    const owed = oldestOwedQ.get(now - owedHours * 3600_000);
    const stuck = stuckSendingQ.get(now - stuckMinutes * 60_000);
    const status = stuck.n > 0 ? "stuck" : owed.n > 0 ? "aging" : "ok";
    return { status, owedHours, stuckMinutes, agingCount: owed.n, stuckCount: stuck.n,
      oldestOwedHours: owed.oldest ? Math.floor((now - owed.oldest) / 3600_000) : null };
  } catch { return { status: "unknown" }; }
}

const selectCreatedBetween = db.prepare(
  "SELECT id, evidence, slug, network, priceUsd, httpStatus, synthetic, status, createdAt, wire FROM refunds WHERE createdAt >= ? AND createdAt < ? ORDER BY id ASC LIMIT ?"
);
/** Debts recorded in [sinceMs, untilMs), WITHOUT the payer column: the
 *  reconciliation job reads this and publishes counts, and nothing it holds
 *  should be able to leak an address. Bounded by `limit`. */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function refundsCreatedBetween(sinceMs, untilMs = Date.now(), { limit = 5000 } = {}) {
  try { return selectCreatedBetween.all(Number(sinceMs) || 0, Number(untilMs) || Date.now(), limit); } catch { return []; }
}

// A payer's OWN rows, for identity-bound surfaces only (my-usage, the weekly
// digest): the caller has already proved the address. EVM addresses match
// case-insensitively (hex); every other address matches exactly, because
// base58/base32 rails are case-sensitive and must never be folded.
const selectForPayerExact = db.prepare(
  "SELECT evidence, network, priceUsd, status, paidTx, createdAt, resolvedAt FROM refunds WHERE payer = ? ORDER BY id DESC LIMIT ?"
);
const selectForPayerEvm = db.prepare(
  "SELECT evidence, network, priceUsd, status, paidTx, createdAt, resolvedAt FROM refunds WHERE lower(payer) = ? ORDER BY id DESC LIMIT ?"
);
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function refundsForPayer(payer, { limit = 50 } = {}) {
  const p = typeof payer === "string" ? payer.trim() : "";
  if (!p) return [];
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  try {
    return /^0x[0-9a-fA-F]{40}$/.test(p) ? selectForPayerEvm.all(p.toLowerCase(), n) : selectForPayerExact.all(p, n);
  } catch { return []; }
}

/** Test seam. Database mode: a Promise, and the Postgres table is emptied too. */
export function __resetRefunds() {
  if (USE_PG) {
    return enqueue(async () => {
      await readyP();
      await stateQuery(`DELETE FROM ${T("refunds")}`);
      db.exec("DELETE FROM refunds");
      if (fileDb) fileDb.exec("DELETE FROM refunds");
    });
  }
  db.exec("DELETE FROM refunds");
}
