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
import { OUR_EVM_WALLETS, OUR_SOLANA_WALLETS, OUR_STELLAR_WALLETS, OUR_ALGORAND_WALLETS } from "./revenue-live.js";
import { normalizePayerAddress } from "./payer.js";
import { PAYING_RAILS_SQL, isPaidRail } from "./paid-rails.js";

const HAS_DATA_DIR = existsSync("/data");
const DB_PATH = process.env.SALES_LEDGER_DB || join(HAS_DATA_DIR ? "/data" : "/tmp", "agent402-sales.db");
export const salesPersistent = HAS_DATA_DIR || Boolean(process.env.SALES_LEDGER_DB);

// EVM burners lowercase; Solana/Stellar/Algorand burners case-exact (base58
// and Stellar/Algorand base32 addresses are case-sensitive — lowercasing
// them breaks matching).
const BURNERS = new Set([
  ...[...OUR_EVM_WALLETS].map((w) => String(w).toLowerCase()),
  ...OUR_SOLANA_WALLETS,
  ...OUR_STELLAR_WALLETS,
  ...OUR_ALGORAND_WALLETS,
]);

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
CREATE INDEX IF NOT EXISTS idx_sales_payer  ON sales (payer, ts);
`);
// Additive column (2026-07-24): which HTTP wire carried the credential —
// "x402" (PAYMENT-SIGNATURE) or "mpp" (Authorization: Payment via
// src/mpp-shim.js). Same settlement either way; recorded so MPP adoption is
// answerable from the ledger history the day it starts, and /revenue can
// surface the split once external MPP sales exist. NULL = pre-column rows.
try { db.exec("ALTER TABLE sales ADD COLUMN wire TEXT"); } catch { /* exists */ }
// Additive column (2026-08-27): the QUOTED ceiling of a metered call, next to
// the settled amount in price_usd, so "settled under the quote" is a fact the
// ledger can prove per row (see proofFeed / GET /api/proof). NULL on flat
// routes and pre-column rows.
try { db.exec("ALTER TABLE sales ADD COLUMN quote_usd REAL"); } catch { /* exists */ }

// Boot-time reclassification (2026-08-20): `internal` is decided at record
// time, so a wallet that JOINS the burner/test set later leaves stale
// external rows behind. Idempotent sweep: any row whose recorded payer is in
// today's burner set is ours. Plus a small tx-hash allowlist for payer-less
// rows the sweep can't reach: AgentCore/Privy validation buys from Mike's
// test wallet 0x24e6a249… made BEFORE the same-day mppTempoPayer fix, when
// tempo settles recorded payer NULL (04:11 and 12:58 UTC self-buys — the
// wallet is in OUR_EVM_WALLETS, so every buy AFTER the fix classifies
// internal on its own and this list stops growing).
const INTERNAL_TX_ALLOWLIST = [
  "0xa3c18eeacc2f0dff61a7144f93d8d33c60148adc31a07832c390769da2bd85a0",
  "0x913e5fa8322cc54a499d73214af76449781831d732ab0344139edce37f35dcba",
];
try {
  const bList = [...BURNERS].map(() => "?").join(",");
  const swept = db.prepare(`UPDATE sales SET internal = 1 WHERE internal = 0 AND payer IN (${bList})`).run(...BURNERS).changes;
  const tList = INTERNAL_TX_ALLOWLIST.map(() => "?").join(",");
  const oneOff = db.prepare(`UPDATE sales SET internal = 1 WHERE internal = 0 AND tx IN (${tList})`).run(...INTERNAL_TX_ALLOWLIST).changes;
  if (swept + oneOff > 0) console.log(`[sales-ledger] reclassified ${swept + oneOff} row(s) internal (burner-set membership${oneOff ? ` + ${oneOff} pre-fix AgentCore test buy(s)` : ""})`);
} catch (e) { console.warn(`[sales-ledger] internal reclassification sweep failed: ${String(e?.message || e).slice(0, 200)}`); }

const insertSale = db.prepare(
  "INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire, quote_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
export function recordSale({ slug, priceUsd, rail, network, payer, tx, synthetic, wire, quoteUsd }) {
  try {
    const p = normalizePayerAddress(payer); // lowercases EVM only — base58/Stellar stay case-exact
    const internal = Boolean(synthetic) || rail === "heartbeat" || (p !== null && BURNERS.has(p));
    const q = Number(quoteUsd);
    insertSale.run(
      Date.now(),
      String(slug || "unknown"),
      Number(priceUsd) || 0,
      String(rail || "unknown"),
      network ? String(network) : null,
      p,
      tx ? String(tx) : null,
      internal ? 1 : 0,
      wire ? String(wire) : null,
      Number.isFinite(q) && q > 0 ? q : null
    );
  } catch { /* never break serving for accounting */ }
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
  FROM sales WHERE wire IN ('mpp', 'mpp-tempo', 'mpp-stripe')
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
  SELECT network, internal, COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts
  FROM sales WHERE wire IN ('mpp', 'mpp-tempo', 'mpp-stripe')
  GROUP BY network, internal`);
const qMppRecentExternal = db.prepare(`
  SELECT ts, network, tx FROM sales WHERE wire IN ('mpp', 'mpp-tempo', 'mpp-stripe') AND internal = 0
  ORDER BY ts DESC LIMIT ?`);
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
const qExternalByNetwork = db.prepare(`
  SELECT network, COUNT(*) AS n, COUNT(DISTINCT payer) AS buyers
  FROM sales WHERE internal = 0 AND rail IN ${PAYING_RAILS_SQL} AND ts >= ?
  GROUP BY network`);
export function externalByNetwork({ days = 30 } = {}) {
  const since = Date.now() - days * 86_400_000;
  const out = {};
  for (const r of qExternalByNetwork.all(since)) {
    const key = canonRail(r.network);
    const cur = out[key] || (out[key] = { settlements: 0, buyers: 0 });
    cur.settlements += r.n; cur.buyers += r.buyers; // buyers summed only across CAIP aliases of ONE rail
  }
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
export function externalSlugWindow(sinceMs, untilMs) {
  return qExtSlugWindow.all(sinceMs, untilMs);
}

/** When the ledger recorded its first row (unix ms), or null when empty. */
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
export function mppTxHashes() {
  const out = new Set();
  for (const r of qMppTx.all()) {
    if (!r.tx) continue;
    out.add(r.tx);
    if (/^0x[0-9a-fA-F]+$/.test(r.tx)) out.add(r.tx.toLowerCase());
  }
  return out;
}

/** Recent MPP-wire settlements (Authorization: Payment) with on-chain tx + payer. */
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
      const e = rails[n] || (rails[n] = { count: 0, external: 0, internal: 0, lastAt: null, lastExternalAt: null, txs: [], txsInternal: false });
      e.count += t.n; count += t.n;
      if (t.internal) e.internal += t.n; else { e.external += t.n; externalCount += t.n; if (!e.lastExternalAt || t.last_ts > Date.parse(e.lastExternalAt)) e.lastExternalAt = new Date(t.last_ts).toISOString(); }
      if (!e.lastAt || t.last_ts > Date.parse(e.lastAt)) e.lastAt = new Date(t.last_ts).toISOString();
      if (firstTs === null || t.first_ts < firstTs) firstTs = t.first_ts;
      if (lastTs === null || t.last_ts > lastTs) lastTs = t.last_ts;
    }
    // Recent on-chain proof: external rows first; a rail with no external
    // settle yet shows its newest internal (canary) hashes, flagged as such.
    const ext = qMppRecentExternal.all(Math.min(Math.max(1, limit | 0), 100));
    for (const r of ext) { const e = rails[canonRail(r.network)]; if (e && r.tx && e.txs.length < 12) e.txs.push(r.tx); }
    for (const r of rows) { const e = rails[canonRail(r.network)]; if (e && e.external === 0 && r.tx && e.txs.length < 12) { e.txs.push(r.tx); e.txsInternal = true; } }
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
      txs: ext.map((r) => r.tx).filter(Boolean),
      // Per-rail slice of the same evidence (all-time count, external/internal
      // split, newest settlement, recent external hashes) so /revenue can give
      // each MPP rail its own card and link every hash to the RIGHT explorer.
      // Still aggregate: no tool, no price, no payer, no per-tx timestamp.
      rails,
      note: "Aggregate view, all-time. internal = settlements paid by our own wallets (daily canary, Tempo volume runner); external = everyone else. Per-settlement tool/price rows are operator-only; the tx hashes resolve on-chain for independent verification.",
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

// Day-bucketed Tempo settlements (wire = 'mpp-tempo'), UTC, straight from
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
  FROM sales WHERE wire = 'mpp-tempo'
  GROUP BY day ORDER BY day`);

/** [{day, extUsd, extTx, intUsd, intTx}], oldest first. */
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
export function tempoDailyRecordingSince() {
  const rows = qTempoDaily.all();
  return rows.length ? rows[0].day : null;
}

// ---------------------------------------------------------------------------
// Public receipts for the metered tier (GET /api/proof, /proof).
//
// Shape is deliberately NOT a purchase feed (the mppSales lesson: tool + price
// + timestamp per row is a customer's buying pattern). It is aggregates plus
// ONE latest external row and ONE latest internal (canary) row, each with the
// settle tx so the amount is checkable on-chain, and never a payer.
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
export function meteredExternal({ days = 7, slug = "v1-chat-metered" } = {}) {
  const r = qMeteredExtWindow.get(slug, Date.now() - days * 86_400_000) || {};
  return { days, slug, settlements: Number(r.n) || 0, buyers: Number(r.buyers) || 0, settledUsd: +Number(r.settled || 0).toFixed(6), lastAt: r.last_ts ? new Date(r.last_ts).toISOString() : null };
}

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
      network: l.network, wire: l.wire, rail: l.rail, tx: l.tx,
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
