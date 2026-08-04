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
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HAS_DATA_DIR = existsSync("/data");
const DATA_DIR = process.env.REFUND_DB_DIR || (HAS_DATA_DIR ? "/data" : "/tmp");
const db = new Database(join(DATA_DIR, "agent402-refunds.db"));
db.pragma("journal_mode = WAL");

db.exec(`
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

const insertOwed = db.prepare(`
  INSERT OR IGNORE INTO refunds (evidence, slug, network, payer, priceUsd, httpStatus, synthetic, createdAt)
  VALUES (@evidence, @slug, @network, @payer, @priceUsd, @httpStatus, @synthetic, @createdAt)
`);
const selectByStatus = db.prepare("SELECT * FROM refunds WHERE status = ? ORDER BY id DESC LIMIT ?");
const selectAll = db.prepare("SELECT * FROM refunds ORDER BY id DESC LIMIT ?");
const resolveRow = db.prepare(`
  UPDATE refunds SET status = @status, paidTx = @paidTx, note = @note, resolvedAt = @resolvedAt
  WHERE id = @id AND status IN ('owed', 'sending')
`);
// Claim a row BEFORE money moves. See claimRefundForSend().
const claimRow = db.prepare(`
  UPDATE refunds SET status = 'sending', note = @note, resolvedAt = NULL
  WHERE id = @id AND status = 'owed'
`);
const totalsQ = db.prepare(`
  SELECT status, count(*) AS n, sum(priceUsd) AS usd, sum(synthetic) AS synth
  FROM refunds GROUP BY status
`);

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
 *  base58/base32 rails are case-sensitive and must never be folded. */
export function recordRefundOwed({ slug, network, payer, priceUsd, tx, httpStatus, synthetic } = {}) {
  try {
    const evidence = (typeof tx === "string" && tx.trim())
      ? tx.trim()
      : `${payer || "unknown"}|${slug || "unknown"}|${Math.floor(Date.now() / 60_000)}`;
    const info = insertOwed.run({
      evidence,
      slug: String(slug || "unknown"),
      network: network ? String(network) : null,
      payer: payer ? String(payer) : null,
      priceUsd: Number(priceUsd) || 0,
      httpStatus: Number(httpStatus) || null,
      synthetic: synthetic ? 1 : 0,
      createdAt: Date.now(),
    });
    return info.changes > 0;
  } catch {
    return false; // recording a debt must never break the serving path
  }
}

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
 * Returns true only for the claimer that won the row.
 */
export function claimRefundForSend(id, note = null) {
  try { return claimRow.run({ id, note }).changes > 0; } catch { return false; }
}

/** Mark a debt repaid. Requires the outbound transaction - a refund without
 *  evidence is a deletion wearing a nicer name. Only `owed` rows transition. */
export function markRefundPaid(id, paidTx, note = null) {
  if (!paidTx || typeof paidTx !== "string" || !paidTx.trim()) return false;
  try {
    return resolveRow.run({ id, status: "paid", paidTx: paidTx.trim(), note, resolvedAt: Date.now() }).changes > 0;
  } catch { return false; }
}

/** Void a debt (bad detection, unreachable payer, dust). Requires a note -
 *  writing off a customer's money silently is exactly what this ledger exists
 *  to prevent. */
export function markRefundVoid(id, note) {
  if (!note || typeof note !== "string" || !note.trim()) return false;
  try {
    return resolveRow.run({ id, status: "void", paidTx: null, note: note.trim(), resolvedAt: Date.now() }).changes > 0;
  } catch { return false; }
}

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

/** Test seam. */
export function __resetRefunds() { db.exec("DELETE FROM refunds"); }
