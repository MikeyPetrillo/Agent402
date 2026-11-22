// The environment for a booted test server that keeps its own state: every
// store a server writes to a file (the SQLite ledgers, stats, memory, PoW,
// status, the traffic and wish logs, the hang-up and late-settle books) is
// pointed into a fresh temp directory of its own.
//
// Why it exists: without /data each store defaults to a fixed name under
// /tmp, and MEMORY_DB_FILE or STATS_DB_DIR exported in a shell names one file
// for every child. Two servers on one file read each other's counts (a
// /api/stats delta off by the other run's calls) and contend for one SQLite
// write lock (SQLITE_BUSY), so a suite that passed alone failed beside
// another. Spread it AFTER `...process.env`:
//   env: { ...process.env, ...ownStoreEnv("mcp-mpp"), PORT: ... }
// Each call is a new directory, so two servers of one suite get two.
//
// The state database is switched off for the server (with one, these files
// are only import sources and the stores are rows every server shares).
// REDIS_URL is left as the caller has it: a suite that must not see Redis
// imports ./file-mode.js, and one that shares Redis on purpose scopes its keys
// with its own SHARED_LIMITS_PREFIX.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeEnv } from "./state-stores.mjs";

export function ownStoreEnv(label = "server") {
  const dir = mkdtempSync(join(tmpdir(), `a402-${label}-`));
  return {
    ...storeEnv(dir),
    STATE_DATABASE_URL: "", LEDGER_JOURNAL_REDIS: "",
    TRAFFIC_DIR: join(dir, "traffic"),
    HANGUP_FORGIVE_FILE: join(dir, "hangup-forgiveness.json"),
    LATE_SETTLE_FILE: join(dir, "late-settlements.json"),
    // The per-call count documents (src/sql-query-stats.js, src/x-search-stats.js).
    SQL_QUERY_STATS_FILE: join(dir, "onchain-sql-query-stats.json"),
    X_SEARCH_STATS_FILE: join(dir, "x-search-author-stats.json"),
    // Seller reputation records and delivery outcomes (src/seller-reputation.js).
    SELLER_REPUTATION_FILE: join(dir, "seller-reputation.json"),
    SELLER_DELIVERY_FILE: join(dir, "seller-delivery-outcomes.json"),
    SELLER_REPUTATION_META_FILE: join(dir, "seller-reputation-meta.json"),
    DISCOVERY_REFUSALS_FILE: join(dir, "discovery-refusals.json"),
    // Price webhook registrations, kept prices and queued deliveries (src/price-webhooks.js).
    PRICE_WEBHOOKS_FILE: join(dir, "price-webhooks.json"),
    // The Solana activity scans' state and the per-caller call days
    // (src/solana-activity-store.js, src/upstream-call-days.js).
    SOLANA_ACTIVITY_FILE: join(dir, "solana-activity.json"),
    // The EVM activity scans' state and the revenue view's window scans
    // (src/evm-activity-store.js, src/revenue-live.js).
    EVM_ACTIVITY_FILE: join(dir, "evm-activity.json"),
    REVENUE_WINDOW_SCAN_FILE: join(dir, "revenue-window-scan.json"),
    UPSTREAM_CALL_DAYS_FILE: join(dir, "upstream-call-days.json"),
    // The referral gate's open-settlement book (src/referral-book.js).
    REFERRAL_BOOK_FILE: join(dir, "referral-settlements.json"),
    REFERRAL_ANSWER_DIR: join(dir, "referral-answers"),
    // The card stores' record directories (src/credits.js, src/human-checkout.js).
    CREDITS_DIR: join(dir, "credits"),
    // The issued receipts kept for audit reports (src/receipt-store.js).
    RECEIPT_STORE_DB: join(dir, "agent402-receipts.db"),
    HUMAN_CHECKOUT_DIR: join(dir, "human-checkout"),
  };
}
