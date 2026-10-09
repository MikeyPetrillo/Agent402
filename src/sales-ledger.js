// Sales ledger — every served paid/proven call, BY NAME, persistently.
//
// The stats odometer answers "how many calls"; the chain answers "how much
// money"; neither answers the merchant question: WHICH tools do external
// wallets actually buy? This module records one row per served catalog call
// at settle time — slug, price, rail, settlement chain, verified payer, tx —
// and classifies it internal/external so canary + burner + heartbeat traffic
// never masquerades as demand. SQLite on the /data volume (same pattern as
// stats.js / revenue-ledger.js): rows survive redeploys, and every USDC row
// keeps its settle tx so the ledger stays independently verifiable on-chain.
//
// Classification (internal = our own money/traffic):
//   - request carried a valid POW_SECRET-signed X-Heartbeat-Token (canary,
//     heartbeat probe, CI smoke — unspoofable), or
//   - the verified EIP-3009 payer is one of our burner wallets.
// Solana-settled calls carry no server-visible payer (the SVM payload embeds
// a signed transaction, not an authorization object) — the canary's Solana
// leg is covered by the heartbeat token instead.
//
// Privacy: rows hold ONLY slug, price, rail, chain, payer wallet (already
// public on-chain in the settle tx), and tx hash. Never inputs, IPs, or UAs.
//
// Zero config: persists wherever /data exists (prod); elsewhere it lands in
// /tmp (ephemeral, still functional) — SALES_LEDGER_DB overrides for tests.
//
// Where it lives. Without a state database (STATE_DATABASE_URL unset) the
// tables are the SQLite file and every export is synchronous, as it always
// was. With one, the tables are in Postgres and the SQLite handle below is an
// in-memory MIRROR of them: every reader keeps its SQL and stays synchronous,
// reading the mirror; every WRITE (recordSale, setAttestation,
// recordSaleFeedback) is one Postgres statement with RETURNING, lands in call
// order, is written into the mirror when it lands, and returns a Promise. The
// mirror pulls other containers' writes every REFRESH_MS, so in database mode
// a reader is exact for this process's own landed writes and at most one
// refresh interval behind another container's. The file is imported once
// (agent402-sales.db in the imports table) at the first boot with the
// database on, and while its directory is there every landed write is also
// written into it (write-through), so a rollback reads a current ledger; a
// file written after that build ran alone is rolled forward into the tables
// at the next boot (rollForwardIfFileNewer, the file winning per row).
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { OUR_EVM_WALLETS, OUR_SOLANA_WALLETS, OUR_STELLAR_WALLETS, OUR_ALGORAND_WALLETS } from "./revenue-live.js";
import { normalizePayerAddress } from "./payer.js";
import { PAYING_RAILS_SQL, isPaidRail } from "./paid-rails.js";
import { stateDbEnabled, stateDbSchema, stateQuery, importOnce, imports, trackStoreReady } from "./state-db.js";
import { PG_NOW_MS, REFRESH_MS, REFRESH_MARGIN_MS, fileNewerThan, ledgerFileMtime, sqliteFileRows, serialQueue, insertRows, syncIdSequence, everyMs, makeWarnOnce } from "./ledger-mirror.js";

const HAS_DATA_DIR = existsSync("/data");
const DB_PATH = process.env.SALES_LEDGER_DB || join(HAS_DATA_DIR ? "/data" : "/tmp", "agent402-sales.db");
const USE_PG = stateDbEnabled();
/** "pg" when the ledger lives in the state database, "file" when it is the SQLite file. */
export const salesLedgerBackend = USE_PG ? "pg" : "file";
export const salesPersistent = HAS_DATA_DIR || Boolean(process.env.SALES_LEDGER_DB) || USE_PG;

// EVM burners lowercase; Solana/Stellar/Algorand burners case-exact (base58
// and Stellar/Algorand base32 addresses are case-sensitive — lowercasing
// them breaks matching).
const BURNERS = new Set([
  ...[...OUR_EVM_WALLETS].map((w) => String(w).toLowerCase()),
  ...OUR_SOLANA_WALLETS,
  ...OUR_STELLAR_WALLETS,
  ...OUR_ALGORAND_WALLETS,
]);

const db = new Database(USE_PG ? ":memory:" : DB_PATH);
if (!USE_PG) db.pragma("journal_mode = WAL");
// Write-through handle (database mode, while the file's directory exists).
const fileDb = USE_PG && existsSync(dirname(DB_PATH)) ? (() => { try { const f = new Database(DB_PATH); f.pragma("journal_mode = WAL"); return f; } catch { return null; } })() : null;
for (const h of [db, fileDb]) if (h) h.exec(`
CREATE TABLE IF NOT EXISTS sales (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,   -- unix ms, server clock at response finish
  slug      TEXT    NOT NULL,
  price_usd REAL    NOT NULL,   -- catalog price at time of sale
  rail      TEXT    NOT NULL,   -- usdc | pow | heartbeat | marketplace
  network   TEXT,               -- settlement chain (usdc rail only)
  payer     TEXT,               -- verified EIP-3009 payer, lowercase (EVM only)
  tx        TEXT,               -- settle tx hash/signature from the receipt
  internal  INTEGER NOT NULL    -- 1 = our own traffic, 0 = external demand
);
CREATE INDEX IF NOT EXISTS idx_sales_ext_ts ON sales (internal, ts);
CREATE INDEX IF NOT EXISTS idx_sales_slug   ON sales (slug);
CREATE INDEX IF NOT EXISTS idx_sales_payer  ON sales (payer, ts);

-- Feedback bound to a settled payment (2026-09-12).
--
-- Reviews are worthless when anyone can leave one. Here the credential is the
-- settlement transaction: a row can only be written by the wallet the ledger
-- records as having PAID for that exact call. Not a rating anyone can mint -
-- a statement by a provable customer about a provable purchase.
--
-- UNIQUE on tx, so one payment is one verdict. A buyer can change their mind
-- (the row is replaced) but cannot stack five reviews on one call, which is
-- the cheapest way to distort any review system.
CREATE TABLE IF NOT EXISTS sale_feedback (
  tx        TEXT    PRIMARY KEY,   -- the settlement tx: the credential and the dedupe key
  sale_id   INTEGER NOT NULL,
  slug      TEXT    NOT NULL,      -- denormalised so a per-tool read needs no join
  payer     TEXT    NOT NULL,      -- lowercased EVM payer, verified from the signed authorization
  verdict   TEXT    NOT NULL,      -- "good" | "bad" - deliberately two, see recordSaleFeedback
  reason    TEXT,                  -- the buyer's own words, bounded
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_slug ON sale_feedback (slug, ts);
`);
// Additive column (2026-07-24): which HTTP wire carried the credential —
// "x402" (PAYMENT-SIGNATURE) or "mpp" (Authorization: Payment via
// src/mpp-shim.js). Same settlement either way; recorded so MPP adoption is
// answerable from the ledger history the day it starts, and /revenue can
// surface the split once external MPP sales exist. NULL = pre-column rows.
for (const h of [db, fileDb]) if (h) { try { h.exec("ALTER TABLE sales ADD COLUMN wire TEXT"); } catch { /* exists */ } }
// Additive column (2026-08-27): the QUOTED ceiling of a metered call, next to
// the settled amount in price_usd, so "settled under the quote" is a fact the
// ledger can prove per row (see proofFeed / GET /api/proof). NULL on flat
// routes and pre-column rows.
for (const h of [db, fileDb]) if (h) { try { h.exec("ALTER TABLE sales ADD COLUMN quote_usd REAL"); } catch { /* exists */ } }
// Additive columns (2026-09-03, the attest tool): sha256 of the JSON body the
// buyer received (hex, recorded by the dispatcher for JSON responses only;
// NULL for streamed/binary bodies and pre-column rows), and the EAS
// attestation written for this sale on Base, once one exists.
for (const h of [db, fileDb]) if (h) { try { h.exec("ALTER TABLE sales ADD COLUMN response_sha256 TEXT"); } catch { /* exists */ } }
for (const h of [db, fileDb]) if (h) { try { h.exec("ALTER TABLE sales ADD COLUMN attest_uid TEXT"); } catch { /* exists */ } }
for (const h of [db, fileDb]) if (h) { try { h.exec("ALTER TABLE sales ADD COLUMN attest_tx TEXT"); } catch { /* exists */ } }
for (const h of [db, fileDb]) if (h) { try { h.exec("CREATE INDEX IF NOT EXISTS idx_sales_tx ON sales (tx)"); } catch { /* exists */ } }
// wire and ts carried no index of their own, so the MPP/Tempo aggregates
// (WHERE wire IN ...) and the window totals (WHERE ts >= ?, MIN(ts)) scanned
// the whole table on every /revenue and /api/stats build (2026-09-25 audit).
for (const h of [db, fileDb]) if (h) { try { h.exec("CREATE INDEX IF NOT EXISTS idx_sales_wire_ts ON sales (wire, ts)"); } catch { /* exists */ } }
for (const h of [db, fileDb]) if (h) { try { h.exec("CREATE INDEX IF NOT EXISTS idx_sales_ts ON sales (ts)"); } catch { /* exists */ } }

// Boot-time reclassification (2026-08-20): `internal` is decided at record
// time, so a wallet that JOINS the burner/test set later leaves stale
// external rows behind. Idempotent sweep: any row whose recorded payer is in
// today's burner set is ours. Plus a small tx-hash allowlist for payer-less
// rows the sweep can't reach: AgentCore/Privy validation buys from the operator's
// test wallet 0x24e6a249… made BEFORE the same-day mppTempoPayer fix, when
// tempo settles recorded payer NULL (04:11 and 12:58 UTC self-buys — the
// wallet is in OUR_EVM_WALLETS, so every buy AFTER the fix classifies
// internal on its own and this list stops growing).
const INTERNAL_TX_ALLOWLIST = [
  "0xa3c18eeacc2f0dff61a7144f93d8d33c60148adc31a07832c390769da2bd85a0",
  "0x913e5fa8322cc54a499d73214af76449781831d732ab0344139edce37f35dcba",
];
const sweepLog = (swept, oneOff) => { if (swept + oneOff > 0) console.log(`[sales-ledger] reclassified ${swept + oneOff} row(s) internal (burner-set membership${oneOff ? ` + ${oneOff} pre-fix AgentCore test buy(s)` : ""})`); };
if (!USE_PG) {
  try {
    const bList = [...BURNERS].map(() => "?").join(",");
    const swept = db.prepare(`UPDATE sales SET internal = 1 WHERE internal = 0 AND payer IN (${bList})`).run(...BURNERS).changes;
    const tList = INTERNAL_TX_ALLOWLIST.map(() => "?").join(",");
    const oneOff = db.prepare(`UPDATE sales SET internal = 1 WHERE internal = 0 AND tx IN (${tList})`).run(...INTERNAL_TX_ALLOWLIST).changes;
    sweepLog(swept, oneOff);
  } catch (e) { console.warn(`[sales-ledger] internal reclassification sweep failed: ${String(e?.message || e).slice(0, 200)}`); }
}
// The same sweep in database mode runs against Postgres in firstLoad(), before the first pull.
async function sweepPg() {
  try {
    const swept = (await stateQuery(`UPDATE ${T("sales")} SET internal = 1, updated_at = ${PG_NOW_MS} WHERE internal = 0 AND payer = ANY($1::text[])`, [[...BURNERS]])).rowCount || 0;
    const oneOff = (await stateQuery(`UPDATE ${T("sales")} SET internal = 1, updated_at = ${PG_NOW_MS} WHERE internal = 0 AND tx = ANY($1::text[])`, [INTERNAL_TX_ALLOWLIST])).rowCount || 0;
    sweepLog(swept, oneOff);
  } catch (e) { console.warn(`[sales-ledger] internal reclassification sweep failed: ${String(e?.message || e).slice(0, 200)}`); }
}

// ---- the state database -------------------------------------------------------
const T = (t) => `${stateDbSchema()}.${t}`;
const IMPORT_NAME = basename(DB_PATH);
const SALE_COLS = ["id", "ts", "slug", "price_usd", "rail", "network", "payer", "tx", "internal", "wire", "quote_usd", "response_sha256", "attest_uid", "attest_tx"];
const FEEDBACK_COLS = ["tx", "sale_id", "slug", "payer", "verdict", "reason", "ts"];
const PG_DDL = () => `
  CREATE TABLE IF NOT EXISTS ${T("sales")} (
    id              BIGSERIAL PRIMARY KEY,
    ts              BIGINT NOT NULL,
    slug            TEXT NOT NULL,
    price_usd       DOUBLE PRECISION NOT NULL,
    rail            TEXT NOT NULL,
    network         TEXT,
    payer           TEXT,
    tx              TEXT,
    internal        INTEGER NOT NULL,
    wire            TEXT,
    quote_usd       DOUBLE PRECISION,
    response_sha256 TEXT,
    attest_uid      TEXT,
    attest_tx       TEXT,
    updated_at      BIGINT NOT NULL DEFAULT ${PG_NOW_MS}
  );
  CREATE INDEX IF NOT EXISTS sales_tx ON ${T("sales")} (tx);
  CREATE INDEX IF NOT EXISTS sales_updated_at ON ${T("sales")} (updated_at);
  CREATE TABLE IF NOT EXISTS ${T("sale_feedback")} (
    tx          TEXT PRIMARY KEY,
    sale_id     BIGINT NOT NULL,
    slug        TEXT NOT NULL,
    payer       TEXT NOT NULL,
    verdict     TEXT NOT NULL,
    reason      TEXT,
    ts          BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL DEFAULT ${PG_NOW_MS}
  );
  CREATE INDEX IF NOT EXISTS sale_feedback_updated_at ON ${T("sale_feedback")} (updated_at);
`;
const MIRROR_SALE_SQL = `INSERT OR REPLACE INTO sales (${SALE_COLS.join(", ")}) VALUES (${SALE_COLS.map((c) => "@" + c).join(", ")})`;
const MIRROR_FEEDBACK_SQL = `INSERT OR REPLACE INTO sale_feedback (${FEEDBACK_COLS.join(", ")}) VALUES (${FEEDBACK_COLS.map((c) => "@" + c).join(", ")})`;
const mirrorSale = db.prepare(MIRROR_SALE_SQL);
const mirrorFeedback = db.prepare(MIRROR_FEEDBACK_SQL);
const fileSale = fileDb ? fileDb.prepare(MIRROR_SALE_SQL) : null;
const fileFeedback = fileDb ? fileDb.prepare(MIRROR_FEEDBACK_SQL) : null;
const num = (v) => (v == null ? null : Number(v));
const saleRowOf = (r) => ({
  id: Number(r.id), ts: Number(r.ts), slug: r.slug, price_usd: Number(r.price_usd) || 0, rail: r.rail, network: r.network ?? null,
  payer: r.payer ?? null, tx: r.tx ?? null, internal: Number(r.internal) ? 1 : 0, wire: r.wire ?? null, quote_usd: num(r.quote_usd),
  response_sha256: r.response_sha256 ?? null, attest_uid: r.attest_uid ?? null, attest_tx: r.attest_tx ?? null,
});
const feedbackRowOf = (r) => ({ tx: r.tx, sale_id: Number(r.sale_id), slug: r.slug, payer: r.payer, verdict: r.verdict, reason: r.reason ?? null, ts: Number(r.ts) });
let lastSaleUpdated = 0, lastFeedbackUpdated = 0;
let ready = null;
let refreshing = false;
const warnOnce = makeWarnOnce("sales-ledger");
const enqueue = serialQueue();
const stamp = (r, which) => { const u = Number(r.updated_at) || 0; if (which === "sale") { if (u > lastSaleUpdated) lastSaleUpdated = u; } else if (u > lastFeedbackUpdated) lastFeedbackUpdated = u; };
function applySale(r) { mirrorSale.run(saleRowOf(r)); stamp(r, "sale"); }
function applyFeedback(r) { mirrorFeedback.run(feedbackRowOf(r)); stamp(r, "feedback"); }
const applySales = db.transaction((rows) => { for (const r of rows) applySale(r); });
const applyFeedbacks = db.transaction((rows) => { for (const r of rows) applyFeedback(r); });
let writeThroughWarned = false;
/** The landed row into the file (same id), so a rolled-back build reads it. Best effort, never the verdict. */
function writeThrough(stmt, row) {
  if (!stmt) return;
  try { stmt.run(row); }
  catch (e) { if (!writeThroughWarned) { writeThroughWarned = true; console.warn(`[sales-ledger] write-through to ${DB_PATH} failed: ${String(e?.message || e).slice(0, 120)}`); } }
}

/** Both tables of the file into Postgres, once: insert-if-absent with the file's ids, so a second container importing at the same time is harmless. */
async function importFile() {
  const sales = sqliteFileRows(DB_PATH, "sales");
  const fb = sqliteFileRows(DB_PATH, "sale_feedback");
  let n = 0, m = 0;
  if (sales.rows.length) {
    n = await insertRows(stateQuery, T("sales"), SALE_COLS, sales.rows.map(saleRowOf), { conflict: "ON CONFLICT DO NOTHING" });
    await syncIdSequence(stateQuery, T("sales"));
  }
  if (fb.rows.length) m = await insertRows(stateQuery, T("sale_feedback"), FEEDBACK_COLS, fb.rows.map(feedbackRowOf), { conflict: "ON CONFLICT DO NOTHING" });
  if (sales.rows.length || fb.rows.length) console.log(`[sales-ledger] imported ${n} of ${sales.rows.length} sale(s) and ${m} of ${fb.rows.length} feedback row(s) from ${DB_PATH}`);
  return { bytes: sales.bytes, rows: n + m };
}
const FEEDBACK_UPSERT = `ON CONFLICT (tx) DO UPDATE SET ${FEEDBACK_COLS.filter((c) => c !== "tx").map((c) => `${c} = EXCLUDED.${c}`).join(", ")}, updated_at = ${PG_NOW_MS}`;
/**
 * Roll-forward after a rollback: the file-only build writes the file alone,
 * so when the file was written more than NEWER_FILE_GRACE_MS after the
 * tables' newest row (write-through lands within milliseconds) it carries
 * sales and verdicts the tables lack. The file wins per row: sales are
 * inserted where absent (by id), feedback is upserted by tx. Same shape as
 * json-document's reimportIfFileNewer. Returns the counts or null.
 */
async function rollForwardIfFileNewer() {
  const mtime = ledgerFileMtime(DB_PATH);
  if (!Number.isFinite(mtime)) return null;
  const newest = Math.max(
    Number((await stateQuery(`SELECT MAX(updated_at) AS m FROM ${T("sales")}`)).rows[0]?.m) || 0,
    Number((await stateQuery(`SELECT MAX(updated_at) AS m FROM ${T("sale_feedback")}`)).rows[0]?.m) || 0,
  );
  const markedAt = newest ? 0 : (await imports.done(IMPORT_NAME))?.importedAt?.getTime?.() || 0;
  if (!fileNewerThan(mtime, newest || markedAt)) return null;
  const sales = sqliteFileRows(DB_PATH, "sales");
  const fb = sqliteFileRows(DB_PATH, "sale_feedback");
  let n = 0, m = 0;
  if (sales.rows.length) {
    n = await insertRows(stateQuery, T("sales"), SALE_COLS, sales.rows.map(saleRowOf), { conflict: "ON CONFLICT DO NOTHING" });
    await syncIdSequence(stateQuery, T("sales"));
  }
  if (fb.rows.length) m = await insertRows(stateQuery, T("sale_feedback"), FEEDBACK_COLS, fb.rows.map(feedbackRowOf), { conflict: FEEDBACK_UPSERT });
  console.log(`[sales-ledger] rolled forward ${n} sale(s) and ${m} feedback row(s) from ${DB_PATH}: the file was written ${Math.round((mtime - (newest || markedAt)) / 1000)} s after the tables' newest row (a rollback window)`);
  return { sales: n, feedback: m };
}
async function pullAll() {
  const s = await stateQuery(`SELECT * FROM ${T("sales")} ORDER BY id`);
  const f = await stateQuery(`SELECT * FROM ${T("sale_feedback")} ORDER BY ts`);
  db.transaction(() => { db.exec("DELETE FROM sales; DELETE FROM sale_feedback"); for (const r of s.rows) applySale(r); for (const r of f.rows) applyFeedback(r); })();
}
/** Rows another container wrote since the last pull (with a margin; upserts are idempotent). */
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const s = await stateQuery(`SELECT * FROM ${T("sales")} WHERE updated_at > $1 ORDER BY updated_at, id`, [Math.max(0, lastSaleUpdated - REFRESH_MARGIN_MS)]);
    if (s.rows.length) applySales(s.rows);
    const f = await stateQuery(`SELECT * FROM ${T("sale_feedback")} WHERE updated_at > $1 ORDER BY updated_at`, [Math.max(0, lastFeedbackUpdated - REFRESH_MARGIN_MS)]);
    if (f.rows.length) applyFeedbacks(f.rows);
  } finally { refreshing = false; }
}
async function firstLoad() {
  await stateQuery(PG_DDL());
  await importOnce(IMPORT_NAME, { source: DB_PATH, run: importFile });
  await rollForwardIfFileNewer();
  await sweepPg();
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
/** One queued Postgres write: lands after every earlier write; never rejects (a failed write resolves `onError`, logged once a minute). */
function pgWrite(label, fn, onError = false) {
  return enqueue(async () => {
    try { await readyP(); return await fn(); }
    catch (e) { warnOnce(label, e); return onError; }
  });
}
/** Resolves once the first load (DDL, the one-time file import, the sweep, the full pull) is done; immediately in file mode. */
export function salesLedgerReady() { return readyP().catch(() => {}); }
/** Resolves once every queued write has landed (tests and shutdown). */
export function salesLedgerFlush() { return enqueue(async () => {}); }
/** Pull other containers' writes now (the timer does this every REFRESH_MS). */
export async function salesLedgerRefresh() { if (!USE_PG) return; await readyP(); await refresh(); }

const insertSale = db.prepare(
  "INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire, quote_usd, response_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
);

/** Settle tx hash/signature out of the base64 PAYMENT-RESPONSE receipt. */
export function txFromPaymentResponse(headerValue) {
  if (typeof headerValue !== "string" || !headerValue) return null;
  try {
    const tx = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"))?.transaction;
    return typeof tx === "string" && tx ? tx : null;
  } catch {
    return null;
  }
}

/**
 * Record one served catalog call. Fire-and-forget from the serving path:
 * never throws, and a broken disk only costs the row, not the response.
 * Database mode: returns a Promise (true once the row is in Postgres, false
 * when the write failed), queued behind earlier writes so rows land in call
 * order; the serving path does not wait on it.
 */
export function recordSale({ slug, priceUsd, rail, network, payer, tx, synthetic, wire, quoteUsd, responseSha256 }) {
  try {
    const p = normalizePayerAddress(payer); // lowercases EVM only — base58/Stellar stay case-exact
    const internal = Boolean(synthetic) || rail === "heartbeat" || (p !== null && BURNERS.has(p));
    const q = Number(quoteUsd);
    const vals = [
      Date.now(),
      String(slug || "unknown"),
      Number(priceUsd) || 0,
      String(rail || "unknown"),
      network ? String(network) : null,
      p,
      tx ? String(tx) : null,
      internal ? 1 : 0,
      wire ? String(wire) : null,
      Number.isFinite(q) && q > 0 ? q : null,
      /^[0-9a-f]{64}$/i.test(String(responseSha256 || "")) ? String(responseSha256).toLowerCase() : null,
    ];
    if (USE_PG) {
      return pgWrite("record-sale", async () => {
        const r = await stateQuery(
          `INSERT INTO ${T("sales")} (ts, slug, price_usd, rail, network, payer, tx, internal, wire, quote_usd, response_sha256)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`, vals);
        applySale(r.rows[0]);
        writeThrough(fileSale, saleRowOf(r.rows[0]));
        return true;
      });
    }
    insertSale.run(...vals);
  } catch { /* never break serving for accounting */ }
  return USE_PG ? Promise.resolve(false) : undefined;
}

const selectByTx = db.prepare(
  "SELECT id, ts, slug, price_usd, rail, network, payer, tx, internal, wire, quote_usd, response_sha256, attest_uid, attest_tx FROM sales WHERE tx = ? ORDER BY id DESC LIMIT 1"
);
const updateAttestation = db.prepare("UPDATE sales SET attest_uid = ?, attest_tx = ? WHERE id = ? AND attest_uid IS NULL");

/** The newest sale settled by this transaction (hash or signature, as the
 *  receipt carried it), or null. Read by the attest tool: a settlement we did
 *  not record is not ours to attest. */
const upsertFeedback = db.prepare(`
  INSERT INTO sale_feedback (tx, sale_id, slug, payer, verdict, reason, ts)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(tx) DO UPDATE SET verdict = excluded.verdict, reason = excluded.reason, ts = excluded.ts
`);
const selectFeedbackByTx = db.prepare("SELECT tx, slug, verdict, reason, ts FROM sale_feedback WHERE tx = ?");
// Distinct payers per tool as well as raw counts: ten verdicts from one wallet
// is one opinion, and a tally that cannot say so is a tally that can be gamed
// by anyone willing to buy the same call ten times.
// Joined to the sale so the operator sees WHICH bytes are being complained
// about, not just which tool. Payer deliberately not selected: the complaint is
// what needs acting on, and the address adds nothing to that.
const selectBadFeedback = db.prepare(`
  SELECT f.ts, f.slug, f.reason, f.tx, s.response_sha256
  FROM sale_feedback f LEFT JOIN sales s ON s.id = f.sale_id
  WHERE f.verdict = 'bad' AND f.ts >= ? ORDER BY f.ts DESC LIMIT ?
`);
const selectFeedbackTally = db.prepare(`
  SELECT slug,
         SUM(CASE WHEN verdict = 'good' THEN 1 ELSE 0 END) AS good,
         SUM(CASE WHEN verdict = 'bad'  THEN 1 ELSE 0 END) AS bad,
         COUNT(DISTINCT payer) AS raters
  FROM sale_feedback WHERE ts >= ? GROUP BY slug ORDER BY (good + bad) DESC
`);

// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function saleByTx(tx) {
  const t = String(tx || "").trim();
  if (!t) return null;
  const r = selectByTx.get(t);
  if (!r) return null;
  return {
    id: r.id, ts: r.ts, slug: r.slug, priceUsd: Number(r.price_usd) || 0, rail: r.rail, network: r.network || null,
    payer: r.payer || null, tx: r.tx, internal: !!r.internal, wire: r.wire || null,
    responseSha256: r.response_sha256 || null, attestUid: r.attest_uid || null, attestTx: r.attest_tx || null,
  };
}

/** Record the attestation written for a sale. Write-once: a second call for
 *  the same row is a no-op (returns false), so a racing double attest can
 *  never overwrite the first UID. Database mode: a Promise of the verdict,
 *  decided by `UPDATE ... WHERE attest_uid IS NULL RETURNING` in Postgres. */
export function setAttestation(id, { uid, attestTx }) {
  if (USE_PG) {
    return pgWrite("set-attestation", async () => {
      const r = await stateQuery(
        `UPDATE ${T("sales")} SET attest_uid = $1, attest_tx = $2, updated_at = ${PG_NOW_MS} WHERE id = $3 AND attest_uid IS NULL RETURNING *`,
        [String(uid), attestTx ? String(attestTx) : null, Number(id)]);
      if (!r.rows[0]) {
        // Another container won: show its row.
        const cur = await stateQuery(`SELECT * FROM ${T("sales")} WHERE id = $1`, [Number(id)]).catch(() => null);
        if (cur?.rows[0]) applySale(cur.rows[0]);
        return false;
      }
      applySale(r.rows[0]);
      writeThrough(fileSale, saleRowOf(r.rows[0]));
      return true;
    });
  }
  try { return updateAttestation.run(String(uid), attestTx ? String(attestTx) : null, Number(id)).changes === 1; }
  catch { return false; }
}

const qExtBySlug = db.prepare(`
  SELECT slug, COUNT(*) AS sales, SUM(price_usd) AS revenue, MAX(ts) AS last_ts
  FROM sales WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND ts >= ?
  GROUP BY slug ORDER BY sales DESC, revenue DESC LIMIT 20`);
const qExtRecent = db.prepare(`
  SELECT ts, slug, price_usd, rail, network, payer, tx
  FROM sales WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL}
  ORDER BY ts DESC LIMIT 20`);
const qIntRecent = db.prepare(`
  SELECT ts, slug, price_usd, rail, network, payer, tx
  FROM sales WHERE internal = 1
  ORDER BY ts DESC LIMIT 20`);
// Settlements whose credential arrived over an MPP wire — either "mpp"
// (evm-translated, same on-chain USDC settlement as x402 via mpp-shim.js) or
// "mpp-tempo" (native TIP-1034/TIP-20 via Tempo's own relay, src/mpp-tempo.js
// — genuinely NOT the same settlement mechanism, just also arrived over an
// MPP wire). Was `wire = 'mpp'` only, which silently excluded every Tempo
// settlement from /api/revenue/mpp — caught in the post-launch Tempo audit,
// 2026-08-17. Both external buys and internal (canary) MPP settlements are
// included, since MPP is new and most current MPP traffic is the daily
// canary's Base+Celo native-wire legs.
const qMppRecent = db.prepare(`
  SELECT ts, slug, price_usd, rail, network, payer, tx, internal
  FROM sales WHERE wire IN ('mpp', 'mpp-tempo', 'mpp-stripe', 'mpp-tempo-subscription')
  ORDER BY ts DESC LIMIT ?`);
// PUBLIC aggregate sources (cost audit 2026-08-19): the public view used to be
// derived from the 30 NEWEST rows, so once the Tempo volume runner started
// settling ~1,000 internal buys a day the 30 newest were always our own and
// /api/revenue/mpp read "externalCount 0" with only our hashes on the rail
// cards - a public misstatement by crowding. Totals now come from the whole
// ledger grouped by network x internal, and the recent hashes are EXTERNAL
// rows first (internal hashes only fill a rail that has no external settle yet).
// MPP rails were keyed by the raw recorded `network`, so Celo settled two
// ways - the friendly "celo" (evm/charge via the shim) and the CAIP-2
// "eip155:42220" - and rendered as TWO cards ("Celo 51" + "celo 1"). Collapse
// CAIP-2 EVM ids to the friendly rail key so one chain is one rail everywhere
// (2026-08-20). Unknown ids pass through unchanged.
const CAIP_TO_RAIL = {
  "eip155:8453": "base", "eip155:42220": "celo", "eip155:137": "polygon",
  "eip155:42161": "arbitrum", "eip155:10": "optimism", "eip155:43114": "avalanche",
};
const canonRail = (network) => CAIP_TO_RAIL[String(network || "").toLowerCase()] || (network || "unknown");

const qMppTotals = db.prepare(`
  SELECT network, internal, COUNT(*) AS n, SUM(price_usd) AS usd, MIN(ts) AS first_ts, MAX(ts) AS last_ts
  FROM sales WHERE wire IN ('mpp', 'mpp-tempo', 'mpp-stripe', 'mpp-tempo-subscription')
  GROUP BY network, internal`);
// Our own (internal) MPP settlements, newest per network: the only hashes the
// public view lists. Partitioned per network so the Tempo volume runner's
// volume cannot crowd a Base or Celo canary hash out of the list.
const qMppRecentOwnByNetwork = db.prepare(`
  SELECT ts, network, tx FROM (
    SELECT ts, network, tx, ROW_NUMBER() OVER (PARTITION BY network ORDER BY ts DESC) AS rn
    FROM sales WHERE wire IN ('mpp', 'mpp-tempo', 'mpp-stripe', 'mpp-tempo-subscription') AND internal = 1 AND tx IS NOT NULL
  ) WHERE rn <= 12 ORDER BY ts DESC`);
// Every MPP tx hash, for joining the wire onto the on-chain revenue ledger
// (separate db) so the chart can filter by wire. Unbounded by design: the
// series spans the whole chart window, not just the recent list. Widened to
// 'mpp-tempo' for consistency with qMppRecent above, though it's currently a
// no-op there: the on-chain revenue ledger only scans RAILS-listed chains,
// and Tempo is deliberately excluded from RAILS (not x402-settleable), so no
// Tempo tx hash could match anyway — see the revenue-chart Tempo gap noted
// in the same audit (Tempo settlements aren't a chart series yet).
const qMppTx = db.prepare("SELECT tx FROM sales WHERE wire IN ('mpp', 'mpp-tempo', 'mpp-stripe') AND tx IS NOT NULL");
// Settlement RECEIPTS we recorded: one row per call we served on a paying rail
// and believed was paid for, carrying the tx the FACILITATOR said it settled.
// Reconciling these against transfers actually seen on-chain is the only way to
// catch a facilitator that reports success for a payment that never lands - we
// deliver the answer, and nothing arrives. Rows with no tx are excluded: they
// carry no claim that can be checked (see settlement-reconcile.js, which counts
// them separately rather than treating them as either confirmed or missing).
// `payer` is deliberately NOT selected. Reconciliation needs none of it, and
// this row set is serialized to JSON downstream - so a future `...row` spread
// into the samples list would silently publish wallet addresses on an endpoint
// that promises aggregates. Not selecting it makes that regression structurally
// impossible rather than a comment someone has to remember.
const qClaimedSettlements = db.prepare(`
  SELECT ts, slug, price_usd AS usd, network, tx
  FROM sales
  WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND ts >= ? AND ts < ?
  ORDER BY ts`);
/** External paid settlements in [since, until) as recorded at serve time. */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function claimedSettlements(since, until = Date.now()) {
  return qClaimedSettlements.all(since, until);
}

// TRUE distinct counts. These must NOT be derived from the ranked lists below:
// those carry LIMIT 20 / LIMIT 10 for display, so `list.length` silently
// becomes min(actual, limit) and can never report more. That is exactly what
// happened - `distinctToolsSoldExternal` read 20 and `distinctExternalBuyers`
// read 10 against real figures many times larger, both PUBLISHED on
// /marketplace, /leaderboard, every chain page and /api/index, and the capped
// "20 of 627 tools had any external use" was the measurement that justified
// retiring 40 tools and 29 skill packs on 2026-08-25. A ceiling that looks like
// a count is worse than no count: it reads as a finding.
const qExtDistinctSlugs = db.prepare(`
  SELECT COUNT(DISTINCT slug) AS n
  FROM sales WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND ts >= ?`);
const qExtDistinctPayers = db.prepare(`
  SELECT COUNT(DISTINCT payer) AS n
  FROM sales WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND payer IS NOT NULL AND ts >= ?`);
const qExtByPayer = db.prepare(`
  SELECT payer, COUNT(*) AS sales, SUM(price_usd) AS revenue, MAX(ts) AS last_ts
  FROM sales WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND payer IS NOT NULL AND ts >= ?
  GROUP BY payer ORDER BY revenue DESC LIMIT 10`);
// Demand composition: external tools ranked by how many DISTINCT verified
// wallets bought each (breadth, not dollars) — the public /index "what agents
// actually buy" widget. payer IS NOT NULL keeps it to attributable settlements
// (EVM exposes the payer; SVM rows carry none), and internal=0 excludes our
// own canary/burner traffic, so this only ever counts independent demand.
const qExtBuyersBySlug = db.prepare(`
  SELECT slug, COUNT(DISTINCT payer) AS buyers, COUNT(*) AS sales, SUM(price_usd) AS revenue
  FROM sales
  WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND payer IS NOT NULL AND ts >= ?
  GROUP BY slug ORDER BY buyers DESC, sales DESC LIMIT ?`);
const qTotals = db.prepare(`
  SELECT internal, rail, COUNT(*) AS n, SUM(price_usd) AS usd
  FROM sales WHERE ts >= ? GROUP BY internal, rail`);
const qFirstTs = db.prepare("SELECT MIN(ts) AS ts FROM sales");
// Per-slug external paid aggregation over a half-open window [since, until) —
// the bestsellers tool's data feed. COUNT(DISTINCT payer) skips NULLs, so
// `buyers` counts only attributable settlements (EVM exposes the signed payer;
// SVM/Stellar rows carry none and count toward sales but never buyers). No
// LIMIT: the row count is bounded by the catalog size, and the ranking lens
// (buyers vs sales vs revenue) is the caller's choice, not the query's.
const qExtSlugWindow = db.prepare(`
  SELECT slug, COUNT(*) AS sales, SUM(price_usd) AS revenue,
         COUNT(DISTINCT payer) AS buyers, MIN(ts) AS first_ts, MAX(ts) AS last_ts
  FROM sales WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND ts >= ? AND ts < ?
  GROUP BY slug`);

// Payer-scoped view (the /api/my-usage tool). Money rails only — PoW rows
// carry no payer, so they can never appear in a wallet-keyed report anyway.
const qPayerReceiptsTotal = db.prepare(
  "SELECT COUNT(*) AS n FROM sales WHERE payer = ? AND internal = 0 AND ts >= ? AND ts <= ?"
);
const qPayerReceipts = db.prepare(`
  SELECT ts, slug, price_usd, quote_usd, rail, network, wire, tx, response_sha256, attest_uid
    FROM sales
   WHERE payer = ? AND internal = 0 AND ts >= ? AND ts <= ?
   ORDER BY ts DESC
   LIMIT ?`);
const qPayerTotals = db.prepare(`
  SELECT COUNT(*) AS n, SUM(price_usd) AS usd, MIN(ts) AS first_ts, MAX(ts) AS last_ts
  FROM sales WHERE payer = ? AND rail IN ${PAYING_RAILS_SQL} AND ts >= ?`);
const qPayerBySlug = db.prepare(`
  SELECT slug, COUNT(*) AS n, SUM(price_usd) AS usd, MAX(ts) AS last_ts
  FROM sales WHERE payer = ? AND rail IN ${PAYING_RAILS_SQL} AND ts >= ?
  GROUP BY slug ORDER BY n DESC, usd DESC LIMIT 50`);
const qPayerByNetwork = db.prepare(`
  SELECT network, COUNT(*) AS n, SUM(price_usd) AS usd
  FROM sales WHERE payer = ? AND rail IN ${PAYING_RAILS_SQL} AND ts >= ?
  GROUP BY network`);
// External settlements and distinct external buyers per settlement network,
// for the per-rail host entry on the chain marketplace pages (2026-08-28).
// Same PAYING_RAILS / internal=0 line the summary draws; CAIP-2 ids collapse
// to the friendly rail key like everywhere else.
//
// A DISTINCT COUNT CANNOT BE SUMMED, and this grouped by the RAW network while
// the answer is keyed by the CANONICAL rail. The same chain is recorded under
// two spellings - "base" and "eip155:8453", "celo" and "eip155:42220" (the
// reason canonRail exists at all: the MPP board once rendered Celo as two
// rows) - so a wallet that paid under both spellings of ONE rail arrived as
// two grouped rows and `buyers` added them. Reproduced 2026-09-22: one wallet,
// one rail, two spellings, and the /base host card reports 2 distinct buyers
// against a true 1. Exactly the shape we decline to publish about anybody
// else: a third-party index summed a per-resource unique-payer metric across
// our resources and reported 701 payers against our real 158, and
// foldBazaarQuality folds payers with MAX for this reason, with the reason
// written beside it.
//
// So the payers are counted, never added: one row per (rail, payer) and a set
// per canonical rail. Row count is bounded by buyers x rails, and NULL payers
// (SVM/Stellar rows carry none) are skipped exactly as COUNT(DISTINCT) did -
// they still count toward settlements, never toward buyers.
const qExternalByNetwork = db.prepare(`
  SELECT network, COUNT(*) AS n
  FROM sales WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND ts >= ?
  GROUP BY network`);
const qExternalByNetworkPayers = db.prepare(`
  SELECT DISTINCT network, payer
  FROM sales WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND payer IS NOT NULL AND ts >= ?`);
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function externalByNetwork({ days = 30 } = {}) {
  const since = Date.now() - days * 86_400_000;
  const out = {};
  const row = (key) => out[key] || (out[key] = { settlements: 0, buyers: 0 });
  for (const r of qExternalByNetwork.all(since)) row(canonRail(r.network)).settlements += r.n;
  const payersByRail = new Map();
  for (const r of qExternalByNetworkPayers.all(since)) {
    const key = canonRail(r.network);
    let set = payersByRail.get(key);
    if (!set) payersByRail.set(key, (set = new Set()));
    set.add(r.payer);
  }
  for (const [key, set] of payersByRail) row(key).buyers = set.size;
  return out;
}
const qPayerRecent = db.prepare(`
  SELECT ts, slug, price_usd, network, tx
  FROM sales WHERE payer = ? AND rail IN ${PAYING_RAILS_SQL}
  ORDER BY ts DESC LIMIT ?`);

/**
 * One wallet's own purchase history — ONLY ever called with a payer address
 * the payment middleware verified (payment = identity, same model as the
 * memory tools). No internal/external filter: a wallet always sees all of
 * its own rows.
 */
/** External settlements of specific slugs in a window, with the settle tx.
 *  Read-only, for the refund backfill: the charged-failure detector only mints
 *  a debt on a NON-200, and the packs that shipped broken all answered 200 with
 *  an empty envelope, so this is the only record of who was charged. Internal
 *  rows (our own canaries and burners) are excluded by the ledger's own
 *  classification - refunding ourselves would just burn gas. */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function externalSalesForSlugs(slugs, sinceMs, untilMs) {
  const list = (Array.isArray(slugs) ? slugs : []).filter((s) => typeof s === "string" && s);
  if (!list.length) return [];
  const holes = list.map(() => "?").join(",");
  try {
    return db.prepare(
      `SELECT ts, slug, price_usd AS priceUsd, network, payer, tx
         FROM sales
        WHERE internal = 0 AND ts >= ? AND ts < ? AND slug IN (${holes})
        ORDER BY ts ASC`
    ).all(Number(sinceMs) || 0, Number(untilMs) || Date.now(), ...list);
  } catch { return []; }
}

/**
 * One payer's settled calls as ACCOUNTING ROWS, newest first.
 *
 * payerUsage answers "how much have I spent" for a person reading a report.
 * This answers "what do I post to the general ledger", which is a different
 * shape: one row per settled payment, each carrying what was bought, the amount
 * actually settled, the counterparty, and the independent evidence - the
 * settlement transaction, the sha256 of the bytes delivered, and the EAS
 * attestation UID where one was written. Those three are what makes a row
 * auditable by someone who does not trust us, which is the whole point of
 * handing it to a finance system.
 *
 * Identity-bound by the caller, never by a parameter: the route derives the
 * payer from the signed authorization, so this can only ever return the
 * caller's OWN rows. A global feed of who paid whom is the customer list we
 * refuse to publish anywhere else, and an ERP does not want one anyway - it
 * wants its own payables.
 *
 * Internal rows (our canaries, volume runs) are excluded: they are not
 * anybody's purchases.
 */
/**
 * Record one buyer's verdict on one call they paid for.
 *
 * THE CALLER MUST HAVE ALREADY PROVEN OWNERSHIP. This function trusts `payer`
 * because its only call site derives it from the signed EIP-3009 authorization
 * and compares it against the sale's own recorded payer - the same check the
 * attest tool makes, for the same reason. Nothing here re-verifies that, and a
 * second call site that skipped it would be a way to write reviews as somebody
 * else.
 *
 * TWO VERDICTS, NOT FIVE STARS. A scale invites an average, an average invites
 * a ranking, and a ranking built on a handful of self-selected reviews is a
 * number that looks like a measurement and is not one. "It delivered" or "it
 * did not" is what a buyer actually knows, and it is the only thing we would
 * be willing to publish about someone else.
 *
 * Database mode: returns a Promise of the row (null when the write failed),
 * one row per tx in Postgres (INSERT ... ON CONFLICT (tx) DO UPDATE).
 */
export function recordSaleFeedback({ tx, saleId, slug, payer, verdict, reason }) {
  const v = verdict === "good" || verdict === "bad" ? verdict : null;
  if (!tx || !saleId || !slug || !payer || !v) return USE_PG ? Promise.resolve(null) : null;
  const row = {
    tx: String(tx), saleId: Number(saleId), slug: String(slug),
    payer: String(payer).toLowerCase(), verdict: v,
    // Bounded: a buyer's words, stored and later shown, so they can never be
    // an unbounded span in anything that renders them.
    reason: reason == null ? null : String(reason).slice(0, 1000),
    ts: Date.now(),
  };
  if (USE_PG) {
    return pgWrite("record-feedback", async () => {
      const r = await stateQuery(
        `INSERT INTO ${T("sale_feedback")} (tx, sale_id, slug, payer, verdict, reason, ts) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tx) DO UPDATE SET verdict = EXCLUDED.verdict, reason = EXCLUDED.reason, ts = EXCLUDED.ts, updated_at = ${PG_NOW_MS}
         RETURNING *`,
        [row.tx, row.saleId, row.slug, row.payer, row.verdict, row.reason, row.ts]);
      applyFeedback(r.rows[0]);
      writeThrough(fileFeedback, feedbackRowOf(r.rows[0]));
      return row;
    }, null);
  }
  upsertFeedback.run(row.tx, row.saleId, row.slug, row.payer, row.verdict, row.reason, row.ts);
  return row;
}

/** This buyer's own verdict on one tx, or null. */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function feedbackForTx(tx) {
  const r = selectFeedbackByTx.get(String(tx || ""));
  return r ? { tx: r.tx, slug: r.slug, verdict: r.verdict, reason: r.reason, at: new Date(r.ts).toISOString() } : null;
}

/**
 * Per-tool counts. COUNTS ONLY - never the payer, never the reason text.
 *
 * A roster of who said what about which tool is a customer list with opinions
 * attached, and the same rule that keeps buyer addresses off every other
 * surface applies here.
 */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function feedbackByTool({ days = 90 } = {}) {
  const since = Date.now() - Math.max(1, days) * 86_400_000;
  return selectFeedbackTally.all(since).map((r) => ({
    slug: r.slug, good: r.good, bad: r.bad, total: r.good + r.bad,
    raters: r.raters,
  }));
}

/**
 * Operator view: the bad verdicts, with the buyer's words and the digest of the
 * bytes they were served, newest first.
 *
 * The words live here and NOWHERE public. A complaint that nobody reads is the
 * failure mode this whole table exists to avoid (a buyer's fault report once sat
 * unread for eleven days on the wish board), so the log line at write time and
 * this list are the two places a person actually finds them.
 */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function badFeedback({ days = 30, limit = 50 } = {}) {
  const since = Date.now() - Math.max(1, days) * 86_400_000;
  return selectBadFeedback.all(since, Math.max(1, Math.min(500, Number(limit) || 50))).map((r) => ({
    at: new Date(r.ts).toISOString(), item: r.slug, reason: r.reason,
    settlementTx: r.tx, responseSha256: r.response_sha256 || null,
  }));
}

// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function payerReceipts(payer, { from = null, to = null, limit = 500 } = {}) {
  const lo = from ? Date.parse(from) : Date.now() - 90 * 86_400_000;
  const hi = to ? Date.parse(to) : Date.now();
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { error: "unparseable from/to" };
  const cap = Math.min(Math.max(limit, 1), 5000);
  const rows = qPayerReceipts.all(payer, lo, hi, cap);
  // UNCAPPED, deliberately. `returned` is this page; `total` is the window. A
  // count-named field holding the length of a LIMITed result is how a capped
  // query once got published as a business figure, and for an accounting
  // consumer it is worse than useless: it would under-report payables and the
  // reader would have no way to know.
  const total = qPayerReceiptsTotal.get(payer, lo, hi)?.n || 0;
  return {
    wallet: payer,
    from: new Date(lo).toISOString(),
    to: new Date(hi).toISOString(),
    returned: rows.length,
    total,
    // Stated so a consumer never mistakes a page for the period.
    truncated: rows.length < total,
    currency: "USD",
    rows: rows.map((r) => ({
      settledAt: new Date(r.ts).toISOString(),
      item: r.slug,
      // What was actually charged. On a metered call quotedUsd is the ceiling
      // that was authorized and amountUsd is what settled under it - both are
      // kept because the difference is the thing a buyer reconciles.
      amountUsd: +Number(r.price_usd || 0).toFixed(6),
      quotedUsd: r.quote_usd == null ? null : +Number(r.quote_usd).toFixed(6),
      rail: r.rail,
      network: r.network || null,
      wire: r.wire || null,
      // Evidence, all independently checkable without asking us.
      settlementTx: r.tx || null,
      responseSha256: r.response_sha256 || null,
      attestationUid: r.attest_uid || null,
    })),
  };
}

// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function payerUsage(payer, { days = 30, limit = 50 } = {}) {
  const since = Date.now() - days * 86_400_000;
  const t = qPayerTotals.get(payer, since);
  return {
    wallet: payer,
    days,
    persistent: salesPersistent,
    totals: {
      calls: t?.n || 0,
      paidUsd: +(t?.usd || 0).toFixed(4),
      firstAt: t?.first_ts ? new Date(t.first_ts).toISOString() : null,
      lastAt: t?.last_ts ? new Date(t.last_ts).toISOString() : null,
    },
    byNetwork: Object.fromEntries(
      qPayerByNetwork.all(payer, since).map((r) => [r.network || "unknown", { calls: r.n, usd: +(r.usd || 0).toFixed(4) }])
    ),
    bySlug: qPayerBySlug.all(payer, since).map((r) => ({
      slug: r.slug, calls: r.n, usd: +(r.usd || 0).toFixed(4), lastAt: new Date(r.last_ts).toISOString(),
    })),
    recent: qPayerRecent.all(payer, limit).map((r) => ({
      at: new Date(r.ts).toISOString(), slug: r.slug, priceUsd: r.price_usd, network: r.network, tx: r.tx,
    })),
    note: "Rows are recorded at settle time and every USDC row keeps its settle tx, so this report is independently verifiable on-chain. The call that paid for this report will appear in the next one.",
  };
}

/**
 * Public demand widget on /index — external tools ranked by DISTINCT verified
 * buyers over `days`. Breadth of demand, not revenue: the tools the most
 * independent wallets reach for. Canary/burner traffic excluded (internal=0).
 */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function topByBuyers({ days = 30, limit = 8 } = {}) {
  const since = Date.now() - days * 86_400_000;
  return qExtBuyersBySlug.all(since, limit).map((r) => ({
    slug: r.slug,
    buyers: r.buyers,
    sales: r.sales,
    revenueUsd: +(r.revenue || 0).toFixed(4),
  }));
}

/**
 * Raw rows for the bestsellers tool: every externally-paid tool's window
 * aggregate over [sinceMs, untilMs). One row per slug — sales, revenue,
 * distinct attributable buyers, first/last sale ts. Ranking, lenses, and
 * trend math live in the tool's pure compute (x402-kit computeBestsellers).
 */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function externalSlugWindow(sinceMs, untilMs) {
  return qExtSlugWindow.all(sinceMs, untilMs);
}

/** When the ledger recorded its first row (unix ms), or null when empty. */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function firstRecordedTs() {
  return qFirstTs.get()?.ts ?? null;
}

/**
 * The merchant view: external paid sales by name, recent named sales,
 * repeat buyers, and honest internal/external totals. `days` bounds the
 * by-slug/by-payer aggregations (recent list is always the latest rows).
 */
// The on-chain ledger (agent402-revenue.db) records settlements scanned from
// each RAILS-listed chain. A "mpp" (evm-translated) settlement is byte-
// identical on-chain to an x402 one, so its tx hash can join against that
// scan — the wire is an HTTP-layer fact only this table knows. A
// "mpp-tempo" settlement's tx would never join here even in principle:
// Tempo is deliberately excluded from RAILS (not x402-settleable), so the
// on-chain ledger never scans it. The tx hash is the join key between the
// two databases, so the revenue chart can offer a wire filter. EVM hashes
// are hex (case-insensitive, normalized to lowercase); Solana/Stellar
// signatures are base58/base32 and case-SENSITIVE, so those are kept verbatim
// and both forms are carried.
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function mppTxHashes() {
  const out = new Set();
  for (const r of qMppTx.all()) {
    if (!r.tx) continue;
    out.add(r.tx);
    if (/^0x[0-9a-fA-F]+$/.test(r.tx)) out.add(r.tx.toLowerCase());
  }
  return out;
}

// Every MPP-wire row in a time window, for the daily reconciliation job
// (src/mpp-reconcile.js). Includes the Tempo subscription charges, which pay
// the same recipient. The payer rides along ONLY because the EVM leg's
// on-chain check needs it (from == payer); the reconciler never copies it
// into its summary. Bounded by `limit`.
const qMppWindow = db.prepare(`
  SELECT id, ts, slug, price_usd, quote_usd, rail, network, payer, tx, internal, wire
  FROM sales WHERE wire IN ('mpp', 'mpp-tempo', 'mpp-stripe', 'mpp-tempo-subscription') AND ts >= ? AND ts < ?
  ORDER BY id ASC LIMIT ?`);
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function mppLedgerRows(sinceMs, untilMs = Date.now(), { limit = 50_000 } = {}) {
  try {
    return qMppWindow.all(Number(sinceMs) || 0, Number(untilMs) || Date.now(), limit).map((r) => ({
      id: r.id, ts: r.ts, slug: r.slug, priceUsd: Number(r.price_usd) || 0,
      quoteUsd: r.quote_usd == null ? null : Number(r.quote_usd), rail: r.rail, network: r.network || null,
      payer: r.payer || null, tx: r.tx || null, internal: !!r.internal, wire: r.wire || null,
    }));
  } catch { return []; }
}

/** Recent MPP-wire settlements (Authorization: Payment) with on-chain tx + payer. */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function mppSales({ limit = 30, detailed = false } = {}) {
  const rows = qMppRecent.all(Math.min(Math.max(1, limit | 0), 100));
  // Dropping the payer was not enough. Each row still pairs a TOOL NAME with a
  // PRICE and a TIMESTAMP, which is a per-call purchase feed - the same thing
  // salesSummary was reduced to aggregates for, and the same thing the paid
  // bestsellers tool sells. This endpoint was missed in that pass, and it only
  // surfaced later because the leak gate had no MPP rows to look at and was
  // passing vacuously.
  //
  // The feed exists to make MPP-wire adoption VERIFIABLE, and that needs a
  // count and chain-resolvable tx hashes, not a shopping list. Unauthenticated
  // callers get exactly that; the operator view keeps the full rows.
  if (!detailed) {
    // All-time totals per network x internal (see qMppTotals) - never "the 30
    // newest rows", which our own volume runner now dominates.
    const totals = qMppTotals.all();
    const rails = {};
    let count = 0, externalCount = 0, firstTs = null, lastTs = null;
    for (const t of totals) {
      const n = canonRail(t.network);
      const e = rails[n] || (rails[n] = { count: 0, external: 0, externalUsd: 0, internal: 0, lastAt: null, lastExternalAt: null, txs: [], txsInternal: false });
      e.count += t.n; count += t.n;
      if (t.internal) e.internal += t.n; else { e.external += t.n; e.externalUsd = +(e.externalUsd + Number(t.usd || 0)).toFixed(6); externalCount += t.n; if (!e.lastExternalAt || t.last_ts > Date.parse(e.lastExternalAt)) e.lastExternalAt = new Date(t.last_ts).toISOString(); }
      if (!e.lastAt || t.last_ts > Date.parse(e.lastAt)) e.lastAt = new Date(t.last_ts).toISOString();
      if (firstTs === null || t.first_ts < firstTs) firstTs = t.first_ts;
      if (lastTs === null || t.last_ts > lastTs) lastTs = t.last_ts;
    }
    // On-chain proof: OUR OWN settlements only (daily canary, Tempo volume
    // runner). An outside buyer's tx hash resolves to that buyer's wallet on
    // chain, so publishing it would publish who pays us; outside settlements
    // are counted above and never listed.
    const own = qMppRecentOwnByNetwork.all();
    for (const r of own) { const e = rails[canonRail(r.network)]; if (e && e.txs.length < 12) { e.txs.push(r.tx); e.txsInternal = true; } }
    return {
      persistent: salesPersistent,
      count,
      // Adoption evidence without the purchase pattern: WHEN the wire was used,
      // on WHICH rails, and the tx hashes that prove it on-chain.
      firstAt: firstTs !== null ? new Date(firstTs).toISOString() : null,
      lastAt: lastTs !== null ? new Date(lastTs).toISOString() : null,
      byNetwork: Object.fromEntries(Object.entries(rails).map(([n, e]) => [n, e.count])),
      externalCount,
      internalCount: count - externalCount,
      txs: own.map((r) => r.tx),
      txsInternal: true,
      // Per-rail slice of the same evidence (all-time count, external/internal
      // split, newest settlement, recent external hashes) so /revenue can give
      // each MPP rail its own card and link every hash to the RIGHT explorer.
      // Still aggregate: no tool, no per-call price, no payer, no per-tx
      // timestamp. externalUsd is the rail's all-time outside total, the same
      // aggregate the x402 table shows per chain.
      rails,
      note: "Aggregate view, all-time. internal = settlements paid by our own wallets (daily canary, Tempo volume runner); external = everyone else. Per-settlement tool/price rows are operator-only. The tx hashes are our own settlements only and resolve on-chain for independent verification; outside buyers' hashes are never listed, because a hash names its payer on chain.",
    };
  }
  return {
    persistent: salesPersistent,
    // `returned`, not `count`: rows is capped at the requested limit, so its
    // length describes THIS PAGE and nothing else. The all-time total sits
    // beside it, from the aggregate. Naming a page size `count` is how the
    // capped figures on the public surfaces happened.
    returned: rows.length,
    count: qMppTotals.all().reduce((n, t) => n + t.n, 0),
    // No payer. This feed is public (the /revenue MPP section + /api/revenue/mpp)
    // and exists to make MPP-wire adoption verifiable, which the tx hash does on
    // its own - anyone who wants chain truth can resolve the payer from the tx.
    // Carrying the address here made this a per-call customer list on a public
    // route, which is the same thing salesSummary's contract below refuses.
    settlements: rows.map((r) => ({
      at: new Date(r.ts).toISOString(), slug: r.slug, priceUsd: r.price_usd,
      rail: r.rail, network: r.network, tx: r.tx, internal: !!r.internal,
    })),
  };
}

/**
 * Sales summary. Two modes, same rule the wish board follows:
 *
 *  - default (PUBLIC): aggregate only — totals, recording window, and COUNTS.
 *    "Real demand exists, come sell" stays public because it pulls buyers and
 *    sellers in; "who pays us, how often, and which tools earn most" does not.
 *    Three things kept this out of the public shape: per-call rows carry payer
 *    addresses (a customer list, however public the chain is, and the /revenue
 *    Buyers metric is counts-only for exactly this reason), repeatBuyers ranked
 *    our own customers by spend, and topExternal is the ranking the PAID
 *    bestsellers tool sells — serving it free undercut our own product.
 *
 *  - detailed:true (OPERATOR ONLY): the itemized rows. Never wire this to a
 *    public route; it lives behind the operator token at /__operator/sales.json.
 */
// Card revenue (Stripe checkout, subscription invoices, prepaid credits spend):
// external only, counts and dollars, for the /revenue page. The page rendered
// only the on-chain wires until 2026-08-28, so a $2 card sale in the ledger
// never appeared on it. Last-sale time is truncated to the hour (no per-buyer
// timing), like the metered proof feed.
const qCard = db.prepare(`
  SELECT COUNT(*) AS n, COALESCE(SUM(price_usd), 0) AS usd, MAX(ts) AS last_ts
  FROM sales WHERE internal = 0 AND rail IN ('card', 'credits') AND ts >= ?`);
const qCardSubs = db.prepare(`
  SELECT COUNT(*) AS n FROM sales WHERE internal = 0 AND rail = 'card' AND wire = 'stripe-subscription' AND ts >= ?`);
// Decide (the paid planner) and its execute route, for the /revenue monitor.
// Counts, dollars and DISTINCT payers only, per slug x internal: never a
// per-call row (the mppSales lesson). Paying rails only, so a proof-of-work
// or trial row never reads as a sale. Uncapped aggregates by design (feeds
// distinct counts; see test-capped-counts).
const DECIDE_SLUGS = ["decide", "decide-execute"];
// A wallet that buys this many distinct tools inside one UTC day is walking the
// catalog, not choosing a planner: its decide settlements are real sales but
// not demand, so the surface counts them apart.
export const SWEEP_DISTINCT_TOOLS_PER_DAY = 30;
const qSweepPayers = db.prepare(`
  SELECT DISTINCT payer FROM (
    SELECT payer, (ts / 86400000) AS day, COUNT(DISTINCT slug) AS n
    FROM sales WHERE internal = 0 AND payer IS NOT NULL AND rail IN ${PAYING_RAILS_SQL} AND ts >= ?
    GROUP BY payer, day)
  WHERE n >= ${SWEEP_DISTINCT_TOOLS_PER_DAY}`);
const qDecideSales = db.prepare(`
  SELECT slug, internal, payer, COUNT(*) AS n, SUM(price_usd) AS usd, MAX(ts) AS last_ts
  FROM sales WHERE slug IN ('decide', 'decide-execute') AND rail IN ${PAYING_RAILS_SQL} AND ts >= ?
  GROUP BY slug, internal, payer`);
function decideWindow(since) {
  const out = {};
  for (const slug of DECIDE_SLUGS) out[slug] = { count: 0, internal: 0, external: 0, externalUsd: 0, externalBuyers: 0, lastExternalAt: null, sweeps: { count: 0, usd: 0, buyers: 0 } };
  const sweeps = new Set(qSweepPayers.all(since).map((r) => r.payer));
  let lastTs = {};
  for (const r of qDecideSales.all(since)) {
    const e = out[r.slug];
    if (!e) continue;
    e.count += r.n;
    if (r.internal) { e.internal += r.n; continue; }
    // An outside wallet is an outside buyer whatever else it bought that day:
    // a catalog sweeper's plan counts as external like any other. The sweeps
    // sub-object says how many of those external settlements came from
    // sweepers, as information, never as a subtraction.
    if (r.payer && sweeps.has(r.payer)) {
      e.sweeps.count += r.n;
      e.sweeps.usd = +(e.sweeps.usd + Number(r.usd || 0)).toFixed(6);
      e.sweeps.buyers += 1;
    }
    e.external += r.n;
    e.externalUsd = +(e.externalUsd + Number(r.usd || 0)).toFixed(6);
    if (r.payer) e.externalBuyers += 1;
    if (r.last_ts && r.last_ts > (lastTs[r.slug] || 0)) lastTs[r.slug] = r.last_ts;
  }
  // Truncated to the hour, like every other external timestamp we publish.
  for (const slug of DECIDE_SLUGS) if (lastTs[slug]) out[slug].lastExternalAt = new Date(Math.floor(lastTs[slug] / 3_600_000) * 3_600_000).toISOString();
  return out;
}
/** { days, sweepRule, window: {decide, decide-execute}, allTime: {...} } - see decideWindow. */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function decideSales({ days = 30 } = {}) {
  return {
    days,
    sweepRule: `a wallet that bought ${SWEEP_DISTINCT_TOOLS_PER_DAY} or more distinct tools in one UTC day is a catalog sweep; its plans and runs count as external like any other outside buyer, and sweeps says how many of the external settlements came from such wallets`,
    window: decideWindow(Date.now() - days * 86_400_000),
    allTime: decideWindow(0),
  };
}

// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function cardSales({ days = 30 } = {}) {
  const since = Date.now() - days * 86_400_000;
  const w = qCard.get(since), all = qCard.get(0), subs = qCardSubs.get(0);
  const lastAt = all?.last_ts ? new Date(Math.floor(all.last_ts / 3_600_000) * 3_600_000).toISOString() : null;
  return { days, count: Number(w?.n || 0), usd: +Number(w?.usd || 0).toFixed(2), allTimeCount: Number(all?.n || 0), allTimeUsd: +Number(all?.usd || 0).toFixed(2), subscriptionInvoices: Number(subs?.n || 0), lastAt };
}

/**
 * External PAID revenue per UTC day: [{day, revenueUsd, sales}]. The margin
 * view's revenue side - external rows on money rails only, same isPaidRail
 * rule as salesSummary (a pow row's price is what it WOULD have cost).
 */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function externalDailyRevenue({ days = 60 } = {}) {
  const since = Date.now() - days * 86_400_000;
  const rows = db.prepare(
    `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day,
            SUM(price_usd) AS usd, COUNT(*) AS n
     FROM sales WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND ts >= ?
     GROUP BY day ORDER BY day`
  ).all(since);
  return rows.map((r) => ({ day: r.day, revenueUsd: +Number(r.usd || 0).toFixed(6), sales: r.n }));
}

// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function salesSummary({ days = 30, detailed = false } = {}) {
  const since = Date.now() - days * 86_400_000;
  const totals = { external: { sales: 0, revenueUsd: 0 }, internal: { sales: 0, revenueUsd: 0 }, byRail: {} };
  for (const r of qTotals.all(since)) {
    const side = r.internal ? "internal" : "external";
    // Free-tier (pow) rows count as usage, not revenue — price is what it
    // WOULD have cost; only money rails add to revenueUsd. Shared with the SQL
    // above via paid-rails.js: this line was a TENTH hand-written copy of the
    // set, and it survived the first pass of that consolidation because it is
    // JavaScript and the sweep matched the SQL spelling. A mutation test found
    // it — dropping a rail from the constant left this total still counting it.
    const paid = isPaidRail(r.rail);
    totals[side].sales += r.n;
    if (paid) totals[side].revenueUsd += r.usd;
    totals.byRail[`${side}:${r.rail}`] = r.n;
  }
  totals.external.revenueUsd = +totals.external.revenueUsd.toFixed(4);
  totals.internal.revenueUsd = +totals.internal.revenueUsd.toFixed(4);
  const byPayer = qExtByPayer.all(since);
  const base = {
    days,
    persistent: salesPersistent,
    recordingSince: qFirstTs.get()?.ts ?? null,
    totals,
    // Counts, never rosters or rankings: enough to show the market is real
    // without naming a single buyer or ranking a single tool.
    distinctExternalBuyers: qExtDistinctPayers.get(since)?.n ?? 0,
    distinctToolsSoldExternal: qExtDistinctSlugs.get(since)?.n ?? 0,
  };
  if (!detailed) return base;
  return {
    ...base,
    // The weekly number: external buyers on the metered route (counts only).
    meteredExternal7d: meteredExternal({ days: 7 }),
    topExternal: qExtBySlug.all(since).map((r) => ({
      slug: r.slug, sales: r.sales, revenueUsd: +r.revenue.toFixed(4), lastAt: new Date(r.last_ts).toISOString(),
    })),
    recentExternal: qExtRecent.all().map((r) => ({
      at: new Date(r.ts).toISOString(), slug: r.slug, priceUsd: r.price_usd, rail: r.rail,
      network: r.network, payer: r.payer, tx: r.tx,
    })),
    recentInternal: qIntRecent.all().map((r) => ({
      at: new Date(r.ts).toISOString(), slug: r.slug, priceUsd: r.price_usd, rail: r.rail,
      network: r.network, payer: r.payer, tx: r.tx,
    })),
    repeatBuyers: byPayer.map((r) => ({
      payer: r.payer, sales: r.sales, revenueUsd: +r.revenue.toFixed(4), lastAt: new Date(r.last_ts).toISOString(),
    })),
  };
}

// Day-bucketed Tempo settlements (wire 'mpp-tempo', plus tempo/subscription charges), UTC, straight from
// this table — NOT the on-chain wallet scan /api/revenue/daily reads. Tempo
// is deliberately excluded from RAILS (not x402-settleable), so no scan
// ever sees it; this is the ONLY place Tempo revenue is visible day-by-day,
// same "second data source, same chart" pattern as the free-tier (PoW) lane
// (getDailyCalls() in stats.js, its own table for the same structural
// reason: free calls settle nowhere either). Real dollars either way, so
// unlike the free-tier lane this reports usd, not just tx counts.
const qTempoDaily = db.prepare(`
  SELECT date(ts / 1000, 'unixepoch') AS day,
    SUM(CASE WHEN internal = 0 THEN price_usd ELSE 0 END) AS extUsd,
    SUM(CASE WHEN internal = 0 THEN 1 ELSE 0 END) AS extTx,
    SUM(CASE WHEN internal = 1 THEN price_usd ELSE 0 END) AS intUsd,
    SUM(CASE WHEN internal = 1 THEN 1 ELSE 0 END) AS intTx
  FROM sales WHERE wire IN ('mpp-tempo', 'mpp-tempo-subscription')
  GROUP BY day ORDER BY day`);

/** [{day, extUsd, extTx, intUsd, intTx}], oldest first. */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function tempoDailyRevenue() {
  return qTempoDaily.all().map((r) => ({
    day: r.day,
    extUsd: +r.extUsd.toFixed(6),
    extTx: r.extTx,
    intUsd: +r.intUsd.toFixed(6),
    intTx: r.intTx,
  }));
}

/** First day any Tempo settlement was recorded, or null before the first one. */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function tempoDailyRecordingSince() {
  const rows = qTempoDaily.all();
  return rows.length ? rows[0].day : null;
}

// External Tempo payments (per-call tempo/charge and tempo/subscription
// charges), for the revenue ledger's buyer figures. Tempo is not one of the
// chains the on-chain transfer scan reads, so without this the buyer counts
// on /revenue could not see a Tempo buyer at all, and the external payment
// headline could not see a Tempo payment. `internal` is this table's
// own classification and is never re-derived by the reader. Uncapped on
// purpose: these rows feed distinct counts.
const qTempoExternalPayments = db.prepare(`
  SELECT ts, payer, tx, price_usd FROM sales
  WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND wire IN ('mpp-tempo', 'mpp-tempo-subscription')
  ORDER BY ts`);

/** [{ts, payer, tx, usd}] for every external Tempo settlement, oldest first. */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function externalTempoPayments() {
  try {
    return qTempoExternalPayments.all().map((r) => ({ ts: r.ts, payer: r.payer || null, tx: r.tx || null, usd: Number(r.price_usd) || 0 }));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Public receipts for the metered tier (GET /api/proof, /proof).
//
// Shape is deliberately NOT a purchase feed (the mppSales lesson: tool + price
// + timestamp per row is a customer's buying pattern). It is aggregates plus
// ONE latest external row and ONE latest internal (canary) row, never a payer.
// Only the canary row carries its settle tx (a hash names its payer on chain).
const qProofAgg = db.prepare(`
  SELECT COUNT(*) AS n, SUM(price_usd) AS settled, SUM(quote_usd) AS quoted,
         SUM(CASE WHEN quote_usd IS NOT NULL THEN 1 ELSE 0 END) AS quoted_n
  FROM sales WHERE slug = ? AND internal = ? AND rail IN ${PAYING_RAILS_SQL}`);
const qProofLatest = db.prepare(`
  SELECT ts, price_usd, quote_usd, network, tx, wire, rail
  FROM sales WHERE slug = ? AND internal = ? AND rail IN ${PAYING_RAILS_SQL}
  ORDER BY ts DESC LIMIT 1`);
const qMeteredExtWindow = db.prepare(`
  SELECT COUNT(*) AS n, COUNT(DISTINCT payer) AS buyers, SUM(price_usd) AS settled, MAX(ts) AS last_ts
  FROM sales WHERE slug = ? AND internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND ts >= ?`);
/** External metered settlements in a window: counts only, never a roster. The
 *  weekly number the distribution work is measured by (PostHog mirror:
 *  "External metered buyers per week"). */
// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function meteredExternal({ days = 7, slug = "v1-chat-metered" } = {}) {
  const r = qMeteredExtWindow.get(slug, Date.now() - days * 86_400_000) || {};
  return { days, slug, settlements: Number(r.n) || 0, buyers: Number(r.buyers) || 0, settledUsd: +Number(r.settled || 0).toFixed(6), lastAt: r.last_ts ? new Date(r.last_ts).toISOString() : null };
}

// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function proofFeed({ slug = "v1-chat-metered" } = {}) {
  const side = (internal) => {
    const a = qProofAgg.get(slug, internal ? 1 : 0) || {};
    const l = qProofLatest.get(slug, internal ? 1 : 0) || null;
    // External rows carry the hour, not the second: /api/revenue/mpp withholds
    // per-tx timestamps for the same reason, and the block explorer already
    // has the exact time for anyone who wants it. Our own canary row keeps it.
    const at = new Date(l ? l.ts : 0);
    if (l && !internal) at.setUTCMinutes(0, 0, 0);
    const row = l ? {
      at: at.toISOString(),
      atPrecision: internal ? "second" : "hour",
      settledUsd: +Number(l.price_usd).toFixed(6),
      quoteUsd: l.quote_usd == null ? null : +Number(l.quote_usd).toFixed(6),
      underQuote: l.quote_usd == null ? null : Number(l.price_usd) <= Number(l.quote_usd) + 1e-9,
      network: l.network, wire: l.wire, rail: l.rail,
      // An outside buyer's tx hash resolves to that buyer's wallet on chain,
      // so only our own canary row carries one; the external row is the
      // amount, the quote and the hour.
      tx: internal ? l.tx : null,
      txWithheld: !internal,
    } : null;
    return {
      count: Number(a.n) || 0,
      settledUsd: +Number(a.settled || 0).toFixed(6),
      quotedUsd: a.quoted == null ? null : +Number(a.quoted).toFixed(6),
      quotedCount: Number(a.quoted_n) || 0,
      latest: row,
    };
  };
  const week = meteredExternal({ days: 7, slug });
  return { slug, persistent: salesPersistent, external: { ...side(false), buyers7d: week.buyers, settlements7d: week.settlements }, internal: side(true), generatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Weekly OUTSIDE MPP agents (operator-only, counts only).
//
// Distinct external payers per UTC week (weeks start Monday 00:00 UTC) on the
// MPP wires, split by method, beside the same series over every paying rail
// for comparison. `internal` is this table's own classification (canary,
// Tempo volume runner, burners, heartbeat), never recomputed here. A payer is
// "new" in the week of its FIRST payment in that scope across ALL history,
// not the charted window, so nobody is relabelled new when the window moves.
// Payer strings are already normalized at record time (EVM lowercase), so one
// wallet paying over Tempo and over the Base evm challenge is one agent.
// Addresses never leave this function.
const WEEK_MS = 7 * 86_400_000;
const WEEK_EPOCH_MS = 4 * 86_400_000; // 1970-01-05, a Monday
export const MPP_AGENT_METHODS = Object.freeze({
  "mpp-tempo": "tempoCharge",
  "mpp-tempo-subscription": "tempoSubscription",
  "mpp": "evm",
});
const MPP_AGENT_WIRES_SQL = `(${Object.keys(MPP_AGENT_METHODS).map((w) => `'${w}'`).join(", ")})`;
const qAgentRowsAll = db.prepare(`
  SELECT CAST((ts - ${WEEK_EPOCH_MS}) / ${WEEK_MS} AS INTEGER) AS wk, payer, wire,
         COUNT(*) AS n, SUM(price_usd) AS usd
  FROM sales WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND ts >= ?
  GROUP BY wk, payer, wire`);
const qAgentFirstAll = db.prepare(`
  SELECT payer, MIN(ts) AS first_ts FROM sales
  WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND payer IS NOT NULL GROUP BY payer`);
const qAgentFirstMpp = db.prepare(`
  SELECT payer, MIN(ts) AS first_ts FROM sales
  WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND payer IS NOT NULL AND wire IN ${MPP_AGENT_WIRES_SQL} GROUP BY payer`);

export function weekStartOf(ts) {
  return Math.floor((ts - WEEK_EPOCH_MS) / WEEK_MS) * WEEK_MS + WEEK_EPOCH_MS;
}

// Database mode: reads the in-memory mirror; exact for this process's landed writes, at most REFRESH_MS (15 s) behind another container's.
export function mppAgentsWeekly({ weeks = 12, now = Date.now() } = {}) {
  const n = Math.max(1, Math.min(104, Math.floor(Number(weeks)) || 12));
  const currentWk = Math.floor((now - WEEK_EPOCH_MS) / WEEK_MS);
  const firstWk = currentWk - n + 1;
  const since = firstWk * WEEK_MS + WEEK_EPOCH_MS;
  const firstAll = new Map(qAgentFirstAll.all().map((r) => [r.payer, r.first_ts]));
  const firstMpp = new Map(qAgentFirstMpp.all().map((r) => [r.payer, r.first_ts]));
  const blank = () => ({ agents: new Set(), payments: 0, usd: 0, unattributedPayments: 0 });
  const buckets = new Map();
  for (let wk = firstWk; wk <= currentWk; wk++) {
    buckets.set(wk, { all: blank(), mpp: blank(), byMethod: Object.fromEntries(Object.values(MPP_AGENT_METHODS).map((m) => [m, blank()])) });
  }
  const add = (b, payer, cnt, usd) => {
    b.payments += cnt; b.usd += usd;
    if (payer) b.agents.add(payer); else b.unattributedPayments += cnt;
  };
  for (const r of qAgentRowsAll.all(since)) {
    const b = buckets.get(r.wk);
    if (!b) continue;
    const cnt = Number(r.n) || 0, usd = Number(r.usd) || 0;
    add(b.all, r.payer, cnt, usd);
    const method = Object.hasOwn(MPP_AGENT_METHODS, r.wire || "") ? MPP_AGENT_METHODS[r.wire] : null;
    if (method) { add(b.mpp, r.payer, cnt, usd); add(b.byMethod[method], r.payer, cnt, usd); }
  }
  const shape = (b, weekStart, firsts) => {
    let newAgents = 0;
    if (firsts) for (const p of b.agents) { const f = firsts.get(p); if (f !== undefined && f >= weekStart) newAgents++; }
    const out = { distinctAgents: b.agents.size, payments: b.payments, usd: +b.usd.toFixed(6), unattributedPayments: b.unattributedPayments };
    if (firsts) Object.assign(out, { newAgents, returningAgents: b.agents.size - newAgents });
    return out;
  };
  const mpp = [], all = [];
  for (const [wk, b] of buckets) {
    const weekStart = wk * WEEK_MS + WEEK_EPOCH_MS;
    const iso = new Date(weekStart).toISOString().slice(0, 10);
    const row = { weekStart: iso, ...shape(b.mpp, weekStart, firstMpp), byMethod: {} };
    for (const [m, mb] of Object.entries(b.byMethod)) row.byMethod[m] = shape(mb, weekStart, null);
    mpp.push(row);
    all.push({ weekStart: iso, ...shape(b.all, weekStart, firstAll) });
  }
  return {
    weeks: mpp,
    allRails: { weeks: all },
    methods: { ...MPP_AGENT_METHODS },
    window: { weeks: n, from: new Date(since).toISOString().slice(0, 10), weekStartsOn: "Monday 00:00 UTC", currentWeekPartial: true },
    scope: "External payers only (the ledger's internal=0 on paying rails). newAgents = first payment in that scope across all history; an agent paying on several MPP methods counts once in the MPP total and once in each method row. unattributedPayments are payments with no recorded payer, counted in payments/usd but never as agents.",
    persistent: salesPersistent,
    generatedAt: new Date(now).toISOString(),
  };
}
