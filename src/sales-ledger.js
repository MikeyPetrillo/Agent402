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
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OUR_EVM_WALLETS } from "./revenue-live.js";

const HAS_DATA_DIR = existsSync("/data");
const DB_PATH = process.env.SALES_LEDGER_DB || join(HAS_DATA_DIR ? "/data" : "/tmp", "agent402-sales.db");
export const salesPersistent = HAS_DATA_DIR || Boolean(process.env.SALES_LEDGER_DB);

const BURNERS = new Set([...OUR_EVM_WALLETS].map((w) => String(w).toLowerCase()));

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
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
`);

const insertSale = db.prepare(
  "INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
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
 */
export function recordSale({ slug, priceUsd, rail, network, payer, tx, synthetic }) {
  try {
    const p = typeof payer === "string" && payer ? payer.toLowerCase() : null;
    const internal = Boolean(synthetic) || rail === "heartbeat" || (p !== null && BURNERS.has(p));
    insertSale.run(
      Date.now(),
      String(slug || "unknown"),
      Number(priceUsd) || 0,
      String(rail || "unknown"),
      network ? String(network) : null,
      p,
      tx ? String(tx) : null,
      internal ? 1 : 0
    );
  } catch { /* never break serving for accounting */ }
}

const qExtBySlug = db.prepare(`
  SELECT slug, COUNT(*) AS sales, SUM(price_usd) AS revenue, MAX(ts) AS last_ts
  FROM sales WHERE internal = 0 AND rail IN ('usdc','marketplace') AND ts >= ?
  GROUP BY slug ORDER BY sales DESC, revenue DESC LIMIT 20`);
const qExtRecent = db.prepare(`
  SELECT ts, slug, price_usd, rail, network, payer, tx
  FROM sales WHERE internal = 0 AND rail IN ('usdc','marketplace')
  ORDER BY ts DESC LIMIT 20`);
const qExtByPayer = db.prepare(`
  SELECT payer, COUNT(*) AS sales, SUM(price_usd) AS revenue, MAX(ts) AS last_ts
  FROM sales WHERE internal = 0 AND rail IN ('usdc','marketplace') AND payer IS NOT NULL AND ts >= ?
  GROUP BY payer ORDER BY revenue DESC LIMIT 10`);
const qTotals = db.prepare(`
  SELECT internal, rail, COUNT(*) AS n, SUM(price_usd) AS usd
  FROM sales WHERE ts >= ? GROUP BY internal, rail`);
const qFirstTs = db.prepare("SELECT MIN(ts) AS ts FROM sales");

/**
 * The merchant view: external paid sales by name, recent named sales,
 * repeat buyers, and honest internal/external totals. `days` bounds the
 * by-slug/by-payer aggregations (recent list is always the latest rows).
 */
export function salesSummary({ days = 30 } = {}) {
  const since = Date.now() - days * 86_400_000;
  const totals = { external: { sales: 0, revenueUsd: 0 }, internal: { sales: 0, revenueUsd: 0 }, byRail: {} };
  for (const r of qTotals.all(since)) {
    const side = r.internal ? "internal" : "external";
    // Free-tier (pow) rows count as usage, not revenue — price is what it
    // WOULD have cost; only money rails add to revenueUsd.
    const paid = r.rail === "usdc" || r.rail === "marketplace";
    totals[side].sales += r.n;
    if (paid) totals[side].revenueUsd += r.usd;
    totals.byRail[`${side}:${r.rail}`] = r.n;
  }
  totals.external.revenueUsd = +totals.external.revenueUsd.toFixed(4);
  totals.internal.revenueUsd = +totals.internal.revenueUsd.toFixed(4);
  return {
    days,
    persistent: salesPersistent,
    recordingSince: qFirstTs.get()?.ts ?? null,
    totals,
    topExternal: qExtBySlug.all(since).map((r) => ({
      slug: r.slug, sales: r.sales, revenueUsd: +r.revenue.toFixed(4), lastAt: new Date(r.last_ts).toISOString(),
    })),
    recentExternal: qExtRecent.all().map((r) => ({
      at: new Date(r.ts).toISOString(), slug: r.slug, priceUsd: r.price_usd, rail: r.rail,
      network: r.network, payer: r.payer, tx: r.tx,
    })),
    repeatBuyers: qExtByPayer.all(since).map((r) => ({
      payer: r.payer, sales: r.sales, revenueUsd: +r.revenue.toFixed(4), lastAt: new Date(r.last_ts).toISOString(),
    })),
  };
}
