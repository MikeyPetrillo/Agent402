// Issued receipts, kept for the paying wallet's audit report.
//
// The response signer (src/receipt-signing.js) hands every receipt it signs
// to storeIssuedReceipt, and src/server.js calls it from the response's
// "finish" with a final status of 200 only: a receipt the buyer never
// received (a refused settle, a 4xx/5xx, a connection gone before the end)
// is never kept. Kept are the receipts a wallet's audit report can show
// (src/tools/audit-report-kit.js): a payment rail whose payer is an EVM
// wallet (x402 on an EVM chain, the Circle Gateway batched option, the MPP
// evm wire), and a Tempo payment, whose payer may still be unread when it is
// signed. A credits key keeps its history on its own balance page, a card
// payment names no wallet, and a payer on another chain can never open an
// audit report (the report is keyed on a signed EVM authorization), so none
// of those is kept.
//
// A row holds the receipt (the compact JWS, already public to its buyer) and
// the fields the report looks it up by: the payer, the settlement it names,
// its id, the route's slug and when it was issued. Never the request or the
// answer: the receipt names only their SHA-256 digests.
//
// Where it lives: the state database when STATE_DATABASE_URL is set (table
// `issued_receipts`), else a SQLite file (RECEIPT_STORE_DB, default
// /data/agent402-receipts.db, or /tmp without a volume).
//
// Streamed answers' receipts, kept for GET /api/receipt/<key> (table
// `streamed_receipts`, same database or file): a paid answer written in parts
// names X-Agent402-Receipt-Url in its head, and its receipt is kept here once
// the answer finished 200 (keepStreamedReceiptOnFinalOk), whatever the rail,
// so a client that could take neither the event-stream line nor a trailer
// still gets it. A row holds the key (the settlement, or the random token the
// head named), the receipt and when it was issued: nothing the receipt does
// not already hold. Deleted RECEIPT_FETCH_DAYS after it was issued (default
// 30) and past RECEIPT_FETCH_MAX_ROWS (default 500,000), oldest first, by the
// same hourly sweep; the newest RECEIPT_FETCH_MEMORY (default 2000) are also
// held in memory, so a fetch right after the stream ends finds its receipt
// before a queued database write lands.
//
// Bounded: a row is deleted RECEIPT_STORE_DAYS after it was issued (default
// 400, so a year's report and a month of slack), and past
// RECEIPT_STORE_MAX_ROWS (default 2,000,000) the oldest go first. The sweep
// runs hourly, under a lease with the database on. A write the database does
// not take is kept in a bounded queue (RECEIPT_STORE_PENDING_MAX, default
// 5000) and retried; past the bound the oldest pending receipt is dropped
// and counted, never the serving path.
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stateDbEnabled, stateDbSchema, stateQuery, withSchemaLock, leased } from "./state-db.js";
import { normalizePayerAddress } from "./payer.js";
import { enableWal } from "./sqlite-wal.js";

const DAY_MS = 86_400_000;
const intEnv = (name, dflt, lo, hi) => {
  const n = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
/** How long an issued receipt is kept, in days (stated on /privacy). */
export const RECEIPT_STORE_DAYS = intEnv("RECEIPT_STORE_DAYS", 400, 31, 3650);
export const RECEIPT_STORE_MAX_ROWS = intEnv("RECEIPT_STORE_MAX_ROWS", 2_000_000, 1000, 100_000_000);
const PENDING_MAX = intEnv("RECEIPT_STORE_PENDING_MAX", 5000, 10, 1_000_000);
/** How long a streamed answer's receipt stays fetchable, in days. */
export const RECEIPT_FETCH_DAYS = intEnv("RECEIPT_FETCH_DAYS", 30, 1, 400);
export const RECEIPT_FETCH_MAX_ROWS = intEnv("RECEIPT_FETCH_MAX_ROWS", 500_000, 1000, 50_000_000);
const FETCH_MEMORY = intEnv("RECEIPT_FETCH_MEMORY", 2000, 0, 100_000);
const FETCH_KEY_RE = /^[A-Za-z0-9_.:-]{16,200}$/;
const SWEEP_MS = 60 * 60 * 1000;
const RETRY_MS = 15_000;
/** The rails whose receipts are kept (a wallet's audit report can name them). */
export const STORED_RAILS = Object.freeze(["x402", "gateway-batched", "mpp-evm", "mpp-tempo"]);
const EVM_RE = /^0x[0-9a-f]{40}$/;
const JWS_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JWS_MAX = 4096;
const TEXT_MAX = 200;

const USE_PG = stateDbEnabled();
export const receiptStoreBackend = USE_PG ? "pg" : "file";
const HAS_DATA_DIR = existsSync("/data");
const DB_PATH = process.env.RECEIPT_STORE_DB || join(HAS_DATA_DIR ? "/data" : "/tmp", "agent402-receipts.db");

let fileDb = null;
function file() {
  if (fileDb) return fileDb;
  const db = new Database(DB_PATH);
  enableWal(db);
  db.exec(`
CREATE TABLE IF NOT EXISTS issued_receipts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id  TEXT    NOT NULL UNIQUE,
  ts          INTEGER NOT NULL,
  payer       TEXT,
  rail        TEXT    NOT NULL,
  settlement  TEXT,
  slug        TEXT,
  replay      INTEGER NOT NULL DEFAULT 0,
  jws         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issued_receipts_payer ON issued_receipts (payer, ts);
CREATE INDEX IF NOT EXISTS idx_issued_receipts_settlement ON issued_receipts (settlement);
CREATE INDEX IF NOT EXISTS idx_issued_receipts_ts ON issued_receipts (ts);
CREATE TABLE IF NOT EXISTS streamed_receipts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fetch_key   TEXT    NOT NULL UNIQUE,
  ts          INTEGER NOT NULL,
  jws         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_streamed_receipts_ts ON streamed_receipts (ts);
`);
  fileDb = db;
  return db;
}

const T = () => `${stateDbSchema()}.issued_receipts`;
const S = () => `${stateDbSchema()}.streamed_receipts`;
let pgReady = null;
function pgTable() {
  if (!pgReady) {
    pgReady = withSchemaLock(async (c) => {
      await c.query(`CREATE TABLE IF NOT EXISTS ${T()} (
        id BIGSERIAL PRIMARY KEY,
        receipt_id TEXT NOT NULL UNIQUE,
        ts BIGINT NOT NULL,
        payer TEXT,
        rail TEXT NOT NULL,
        settlement TEXT,
        slug TEXT,
        replay BOOLEAN NOT NULL DEFAULT false,
        jws TEXT NOT NULL)`);
      await c.query(`CREATE INDEX IF NOT EXISTS issued_receipts_payer_idx ON ${T()} (payer, ts)`);
      await c.query(`CREATE INDEX IF NOT EXISTS issued_receipts_settlement_idx ON ${T()} (settlement)`);
      await c.query(`CREATE INDEX IF NOT EXISTS issued_receipts_ts_idx ON ${T()} (ts)`);
      await c.query(`CREATE TABLE IF NOT EXISTS ${S()} (id BIGSERIAL PRIMARY KEY, fetch_key TEXT NOT NULL UNIQUE, ts BIGINT NOT NULL, jws TEXT NOT NULL)`);
      await c.query(`CREATE INDEX IF NOT EXISTS streamed_receipts_ts_idx ON ${S()} (ts)`);
    }).catch((e) => { pgReady = null; throw e; });
  }
  return pgReady;
}

const counters = { stored: 0, skipped: 0, failed: 0, dropped: 0 };
/** Counts for the operator view (never a payer, never a receipt). `skipped` counts every issued receipt the store does not keep (a rail no audit report reads, a payer that is not an EVM wallet), on the serving path too. */
export function receiptStoreCounts() { return { backend: receiptStoreBackend, pending: pending.length, ...counters }; }

const cap = (v) => (v == null || v === "" ? null : String(v).slice(0, TEXT_MAX));

/**
 * The row a signed receipt is kept as, or null when it is not kept (a rail
 * no audit report reads, a payer that is not an EVM wallet, a receipt that
 * does not read). Pure; exported for tests.
 */
export function issuedReceiptRow(jws, record, now = Date.now()) {
  if (typeof jws !== "string" || jws.length > JWS_MAX || !JWS_RE.test(jws)) return null;
  if (!record || typeof record !== "object") return null;
  const rail = String(record.rail || "");
  if (!STORED_RAILS.includes(rail)) return null;
  const payer = normalizePayerAddress(record.payer);
  // A Tempo receipt signed before the sender read finished names no payer:
  // it is kept by its settlement, which the sale row names under its payer.
  if (payer ? !EVM_RE.test(payer) : rail !== "mpp-tempo") return null;
  const settlement = cap(record.settlement);
  if (!payer && !settlement) return null;
  const id = cap(record.id);
  if (!id) return null;
  const iat = Date.parse(record.iat);
  return { receipt_id: id, ts: Number.isFinite(iat) ? iat : now, payer, rail, settlement, slug: cap(record.slug), replay: record.replay === true, jws };
}

const pending = [];
let retryTimer = null;
function enqueue(row) {
  pending.push(row);
  while (pending.length > PENDING_MAX) { pending.shift(); counters.dropped++; }
  if (!retryTimer) { retryTimer = setTimeout(() => { retryTimer = null; void drain(); }, RETRY_MS); retryTimer.unref?.(); }
}
let draining = null;
async function pgInsert(rows) {
  await pgTable();
  const vals = [];
  const ph = rows.map((r, i) => {
    vals.push(r.receipt_id, r.ts, r.payer, r.rail, r.settlement, r.slug, r.replay, r.jws);
    const b = i * 8;
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
  });
  await stateQuery(`INSERT INTO ${T()} (receipt_id, ts, payer, rail, settlement, slug, replay, jws) VALUES ${ph.join(",")} ON CONFLICT (receipt_id) DO NOTHING`, vals, { idempotent: true });
}
function drain() {
  if (draining) return draining;
  // Started on the next microtask, so the mark is set before the run can
  // clear it (a run with nothing pending finishes at once).
  draining = Promise.resolve().then(async () => {
    try {
      while (pending.length) {
        const batch = pending.slice(0, 200);
        try { await pgInsert(batch); }
        catch (e) {
          counters.failed++;
          console.warn(`[receipt-store] write failed, kept for retry (${String(e?.message || e).slice(0, 120)})`);
          if (!retryTimer) { retryTimer = setTimeout(() => { retryTimer = null; void drain(); }, RETRY_MS); retryTimer.unref?.(); }
          return false;
        }
        pending.splice(0, batch.length);
        counters.stored += batch.length;
      }
      return true;
    } finally { draining = null; }
  });
  return draining;
}

/**
 * Keep one issued receipt. Never throws. With the database on it returns a
 * promise (true once written, false when it was not kept or is queued for
 * retry); with the file it is written before it returns.
 */
export function storeIssuedReceipt(jws, record) {
  try {
    const row = issuedReceiptRow(jws, record);
    if (!row) { counters.skipped++; return USE_PG ? Promise.resolve(false) : false; }
    if (USE_PG) { enqueue(row); return drain(); }
    file().prepare("INSERT OR IGNORE INTO issued_receipts (receipt_id, ts, payer, rail, settlement, slug, replay, jws) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.receipt_id, row.ts, row.payer, row.rail, row.settlement, row.slug, row.replay ? 1 : 0, row.jws);
    counters.stored++;
    return true;
  } catch (e) {
    counters.failed++;
    try { console.warn(`[receipt-store] not kept (${String(e?.message || e).slice(0, 120)})`); } catch { /* never throws */ }
    return USE_PG ? Promise.resolve(false) : false;
  }
}
/**
 * The response signer's onSigned hook (src/server.js): keep the receipt when
 * the response finishes with a final 200, and only then. Node emits no
 * "finish" for a response whose connection closed first, so a receipt its
 * buyer never received is not kept. A receipt the store would not keep (a
 * rail no audit report reads, a payer that is not an EVM wallet) adds no
 * listener. A kept one raises the response's listener bound by its own one,
 * so a response that already carries Node's default ten does not log a
 * listener-leak warning per paid answer. Never throws.
 */
export function keepReceiptOnFinalOk(jws, record, _req, res, keep = storeIssuedReceipt) {
  try {
    if (!issuedReceiptRow(jws, record)) { counters.skipped++; return; }
    const bound = res.getMaxListeners?.();
    if (Number.isFinite(bound) && bound > 0) res.setMaxListeners(bound + 1);
    res.once("finish", () => { try { if (res.statusCode === 200) keep(jws, record); } catch { /* bookkeeping only */ } });
  } catch { /* never break the answer */ }
}
/** Resolves once every queued write has been tried (at once with the file). */
export async function receiptStoreFlush() { if (USE_PG) await drain(); }

const fromRow = (r) => ({ receiptId: r.receipt_id, ts: Number(r.ts), payer: r.payer || null, rail: r.rail, settlement: r.settlement || null, slug: r.slug || null, replay: r.replay === true || r.replay === 1, jws: r.jws });

/**
 * The receipts kept for these settlements, for the audit report of `payer`:
 * a receipt that names another payer is never returned, whatever settlement
 * it names. Map of settlement to its receipts, oldest first.
 */
export async function receiptsForSettlements(payer, settlements) {
  const p = normalizePayerAddress(payer);
  const list = [...new Set((Array.isArray(settlements) ? settlements : []).filter((s) => typeof s === "string" && s).map((s) => s.slice(0, TEXT_MAX)))].slice(0, 2000);
  const out = new Map();
  if (!p || !list.length) return out;
  let rows;
  if (USE_PG) {
    await pgTable();
    rows = (await stateQuery(`SELECT receipt_id, ts, payer, rail, settlement, slug, replay, jws FROM ${T()} WHERE settlement = ANY($1::text[]) AND (payer = $2 OR payer IS NULL) ORDER BY ts, id`, [list, p])).rows;
  } else {
    rows = [];
    const q = file().prepare(`SELECT receipt_id, ts, payer, rail, settlement, slug, replay, jws FROM issued_receipts WHERE settlement IN (SELECT value FROM json_each(?)) AND (payer = ? OR payer IS NULL) ORDER BY ts, id`);
    for (let i = 0; i < list.length; i += 500) rows.push(...q.all(JSON.stringify(list.slice(i, i + 500)), p));
  }
  for (const r of rows) {
    const row = fromRow(r);
    if (row.payer && row.payer !== p) continue;
    const a = out.get(row.settlement) || [];
    a.push(row);
    out.set(row.settlement, a);
  }
  return out;
}

// The newest streamed receipts, by key, in insertion order (a bounded map).
const recentStreamed = new Map();
function remember(key, row) {
  if (!FETCH_MEMORY) return;
  recentStreamed.delete(key);
  recentStreamed.set(key, row);
  while (recentStreamed.size > FETCH_MEMORY) recentStreamed.delete(recentStreamed.keys().next().value);
}
const streamedCounters = { stored: 0, failed: 0 };
/** Counts for the operator view (never a key, never a receipt). */
export function streamedReceiptCounts() { return { held: recentStreamed.size, ...streamedCounters }; }

/**
 * Keep a streamed answer's receipt under `key`. Never throws. The first
 * receipt kept under a key stays (a resend of the same payment is not signed
 * again under it). Returns true once written (a promise with the database).
 */
export function storeStreamedReceipt(key, jws, record, now = Date.now()) {
  try {
    if (!FETCH_KEY_RE.test(String(key ?? "")) || typeof jws !== "string" || jws.length > JWS_MAX || !JWS_RE.test(jws)) return USE_PG ? Promise.resolve(false) : false;
    const iat = Date.parse(record?.iat);
    const row = { ts: Number.isFinite(iat) ? iat : now, jws };
    if (!recentStreamed.has(key)) remember(key, row);
    if (USE_PG) {
      return pgTable().then(() => stateQuery(`INSERT INTO ${S()} (fetch_key, ts, jws) VALUES ($1, $2, $3) ON CONFLICT (fetch_key) DO NOTHING`, [key, row.ts, jws], { idempotent: true }))
        .then(() => { streamedCounters.stored++; return true; })
        .catch((e) => { streamedCounters.failed++; console.warn(`[receipt-store] streamed receipt not kept (${String(e?.message || e).slice(0, 120)})`); return false; });
    }
    file().prepare("INSERT OR IGNORE INTO streamed_receipts (fetch_key, ts, jws) VALUES (?, ?, ?)").run(key, row.ts, jws);
    streamedCounters.stored++;
    return true;
  } catch (e) {
    streamedCounters.failed++;
    try { console.warn(`[receipt-store] streamed receipt not kept (${String(e?.message || e).slice(0, 120)})`); } catch { /* never throws */ }
    return USE_PG ? Promise.resolve(false) : false;
  }
}
/**
 * The response signer's onStreamed hook (src/server.js): keep a streamed
 * answer's receipt once the response finished with a final 200, and only
 * then (a connection gone first emits no "finish"). Never throws.
 */
export function keepStreamedReceiptOnFinalOk(key, jws, record, _req, res, keep = storeStreamedReceipt) {
  try {
    const bound = res.getMaxListeners?.();
    if (Number.isFinite(bound) && bound > 0) res.setMaxListeners(bound + 1);
    res.once("finish", () => { try { if (res.statusCode === 200) keep(key, jws, record); } catch { /* bookkeeping only */ } });
  } catch { /* never break the answer */ }
}
/** The receipt kept under `key`, or null (unknown, aged out, or not a key). */
export async function streamedReceipt(key, now = Date.now()) {
  if (!FETCH_KEY_RE.test(String(key ?? ""))) return null;
  const cutoff = now - RECEIPT_FETCH_DAYS * DAY_MS;
  const hit = recentStreamed.get(key);
  if (hit) return hit.ts >= cutoff ? hit.jws : null;
  let row;
  if (USE_PG) {
    await pgTable();
    row = (await stateQuery(`SELECT ts, jws FROM ${S()} WHERE fetch_key = $1`, [key])).rows[0];
  } else {
    row = file().prepare("SELECT ts, jws FROM streamed_receipts WHERE fetch_key = ?").get(key);
  }
  return row && Number(row.ts) >= cutoff ? row.jws : null;
}

/** Delete what is past the retention or the row bound. Exported for tests. */
export async function sweepIssuedReceipts({ now = Date.now(), days = RECEIPT_STORE_DAYS, maxRows = RECEIPT_STORE_MAX_ROWS, fetchDays = RECEIPT_FETCH_DAYS, fetchMaxRows = RECEIPT_FETCH_MAX_ROWS } = {}) {
  const cutoff = now - days * DAY_MS;
  if (USE_PG) {
    await pgTable();
    const aged = await stateQuery(`DELETE FROM ${T()} WHERE ts < $1`, [cutoff], { idempotent: true });
    const over = await stateQuery(`DELETE FROM ${T()} WHERE id <= (SELECT id FROM ${T()} ORDER BY id DESC OFFSET $1 LIMIT 1)`, [maxRows], { idempotent: true });
    const sAged = await stateQuery(`DELETE FROM ${S()} WHERE ts < $1`, [now - fetchDays * DAY_MS], { idempotent: true });
    const sOver = await stateQuery(`DELETE FROM ${S()} WHERE id <= (SELECT id FROM ${S()} ORDER BY id DESC OFFSET $1 LIMIT 1)`, [fetchMaxRows], { idempotent: true });
    return { aged: aged.rowCount || 0, over: over.rowCount || 0, streamedAged: sAged.rowCount || 0, streamedOver: sOver.rowCount || 0 };
  }
  const db = file();
  const aged = db.prepare("DELETE FROM issued_receipts WHERE ts < ?").run(cutoff).changes;
  const over = db.prepare("DELETE FROM issued_receipts WHERE id <= (SELECT id FROM issued_receipts ORDER BY id DESC LIMIT 1 OFFSET ?)").run(maxRows).changes;
  const streamedAged = db.prepare("DELETE FROM streamed_receipts WHERE ts < ?").run(now - fetchDays * DAY_MS).changes;
  const streamedOver = db.prepare("DELETE FROM streamed_receipts WHERE id <= (SELECT id FROM streamed_receipts ORDER BY id DESC LIMIT 1 OFFSET ?)").run(fetchMaxRows).changes;
  for (const [k, v] of recentStreamed) if (v.ts < now - fetchDays * DAY_MS) recentStreamed.delete(k);
  return { aged, over, streamedAged, streamedOver };
}

let sweepTimer = null;
/** Start the hourly sweep (src/server.js, once, in paid mode). */
export function startReceiptStoreSweep() {
  if (sweepTimer) return;
  const run = USE_PG ? leased("receipt-store-sweep", {}, () => sweepIssuedReceipts()) : () => sweepIssuedReceipts();
  const tick = () => { Promise.resolve().then(run).catch((e) => console.warn(`[receipt-store] sweep failed (${String(e?.message || e).slice(0, 120)})`)); };
  sweepTimer = setInterval(tick, SWEEP_MS);
  sweepTimer.unref?.();
}
