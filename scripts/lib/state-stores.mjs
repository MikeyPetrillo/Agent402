// The stores that moved from the volume into the state database, in one
// place for the scripts that move rows between the two shapes
// (state-export.js, state-migration-verify.js) and their tests:
//
//   SQLITE_STORES   each SQLite ledger file: its file name on the volume, the
//                   variable that points its module at another path, the
//                   module, and its tables (SQLite name -> state table)
//   RECORD_DIRS     the one-file-per-record directories (records collection)
//   LOG_FILES       the append-only logs (log_lines stream)
//   INDEX_CACHE     the crawl cache (records collection, NDJSON file)
//
// A store's `transient` tables expire on their own (retry ids kept for a
// day): exported, never imported, so the verifier does not compare counts.
// Its `queues` are file-only tables of rows still waiting to reach the
// database (the ledger mirror's dead letter): verified empty, never mapped.
// Its `bookkeeping` tables are file-only stamps the write-through keeps
// beside the mirror (the refund ledger's pg_sync_meta): never mapped,
// reported by the verifier as bookkeeping. Its `dbColumns` are columns a
// state table has and the file shape never held (a sale's sale_uid, the
// database's own dedupe id): the export leaves them out without a note.
// DB_ONLY tables exist only in the database (bookkeeping a file build never
// kept): neither exported nor verified.
//
// bootStores() imports every store module with the paths pointed into one
// directory and waits for each to be ready. With STATE_DATABASE_URL unset
// that creates every SQLite file with the module's OWN schema (and its
// migrations marked done); with it set, every state table exists. Set the
// environment with storeEnv() BEFORE the first import: the modules decide
// their paths and backend once, at import.
//
//   node scripts/lib/state-stores.mjs boot <dir>     (prints one JSON line)
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export const SQLITE_STORES = [
  { file: "agent402-sales.db", env: (d) => ({ SALES_LEDGER_DB: join(d, "agent402-sales.db") }), tables: { sales: "sales", sale_feedback: "sale_feedback" }, queues: ["pg_dead_letter"], dbColumns: { sales: ["sale_uid"] } },
  { file: "agent402-refunds.db", env: (d) => ({ REFUND_DB_DIR: d }), tables: { refunds: "refunds" }, queues: ["pg_dead_letter"], bookkeeping: ["pg_sync_meta"] },
  { file: "agent402-decide.db", env: (d) => ({ DECIDE_LEDGER_DB: join(d, "agent402-decide.db") }), tables: { decisions: "decide_ledger_decisions", credits: "decide_ledger_credits", runs: "decide_ledger_runs", feedback: "decide_ledger_feedback", seller_spend: "decide_ledger_seller_spend" } },
  { file: "agent402-stats.db", env: (d) => ({ STATS_DB_DIR: d, STATS_ALLOW_EPHEMERAL: "true" }), tables: { counters: "stats_counters", tool_counts: "stats_tool_counts", meta: "stats_meta", recent_calls: "stats_recent_calls", paid_tool_counts: "stats_paid_tool_counts", heartbeat_tool_counts: "stats_heartbeat_tool_counts", charged_failures: "stats_charged_failures", daily_calls: "stats_daily_calls", daily_upstream_calls: "stats_daily_upstream_calls", daily_upstream_spend: "stats_daily_upstream_spend", seller_registrations: "stats_seller_registrations" } },
  { file: "agent402.db", env: (d) => ({ MEMORY_DB_FILE: join(d, "agent402.db"), MEMORY_ALLOW_EPHEMERAL: "true" }), tables: { kv: "memory_kv", grants: "memory_grants", memlog: "memory_memlog", docs: "memory_docs", requests: "memory_requests" }, transient: ["requests"] },
  { file: "status.db", env: (d) => ({ STATUS_DB_PATH: join(d, "status.db") }), tables: { status_probes: "status_probes" } },
  { file: "agent402-economy.db", env: (d) => ({ X402_ECONOMY_DB: join(d, "agent402-economy.db") }), tables: { daily: "economy_daily" } },
  { file: "agent402-revenue.db", env: (d) => ({ REVENUE_LEDGER_DB: join(d, "agent402-revenue.db") }), tables: { transfers: "revenue_transfers", cursors: "revenue_cursors" } },
  { file: "agent402-stripe-shadow.db", env: () => ({}), tables: { shadow: "stripe_shadow" } },
  { file: "agent402-pow.db", env: (d) => ({ POW_DB_PATH: join(d, "agent402-pow.db") }), tables: { pow_used: "pow_used" } },
];
export const DB_ONLY = ["stats_flushes"];
// collection -> directory on the volume, and how a file name maps to a record id.
export const RECORD_DIRS = [
  { dir: "credits", collection: "credits", idOf: (f) => (f.startsWith("k_") && f.endsWith(".json") ? f.slice(0, -5) : f === "_sessions.json" ? "_sessions" : null), fileOf: (id) => `${id}.json` },
  { dir: "human-checkout", collection: "human-checkout", idOf: (f) => (f.endsWith(".json") ? f.slice(0, -5) : null), fileOf: (id) => `${id}.json` },
  { dir: "mcp-tasks", collection: "mcp-tasks", idOf: (f) => (f.endsWith(".json") ? f.slice(0, -5) : null), fileOf: (id) => `${id}.json` },
  { dir: "async-jobs", collection: "async-jobs", idOf: (f) => (f.endsWith(".json") ? f.slice(0, -5) : null), fileOf: (id) => `${id}.json` },
  { dir: "traffic", collection: "traffic", idOf: (f) => (f === "payers.json" ? "payers" : /^\d{4}-\d{2}-\d{2}\.json$/.test(f) ? f.slice(0, -5) : null), fileOf: (id) => `${id}.json` },
];
export const LOG_FILES = [
  { file: "outbound-spend.ndjson", stream: "outbound-spend" },
  { file: "wishes.jsonl", stream: "wishes" },
];
export const INDEX_CACHE = { file: "x402-index-cache.ndjson", collection: "x402-index" };

/** The environment that points every store module into `dir`. */
export function storeEnv(dir) {
  const d = resolve(dir);
  const env = { OUTBOUND_LEDGER_FILE: join(d, "outbound-spend.ndjson"), WISH_FILE: join(d, "wishes.jsonl"), INDEX_CACHE_FILE: join(d, "x402-index-cache.json") };
  for (const s of SQLITE_STORES) Object.assign(env, s.env(d));
  return env;
}

/** Import every store module and wait until each is ready (see the header). */
export async function bootStores(dir, { log = () => {} } = {}) {
  mkdirSync(dir, { recursive: true });
  Object.assign(process.env, storeEnv(dir));
  const pg = Boolean(String(process.env.STATE_DATABASE_URL || "").trim());
  const src = (p) => new URL(`../../src/${p}`, import.meta.url).href;
  const sales = await import(src("sales-ledger.js"));
  const refunds = await import(src("refund-ledger.js"));
  const revenue = await import(src("revenue-ledger.js"));
  const stats = await import(src("stats.js"));
  const status = await import(src("status-store.js"));
  const economy = await import(src("x402-economy.js"));
  const pow = await import(src("pow.js"));
  const memory = await import(src("tools/memory.js"));
  const { openDecideLedger } = await import(src("decide/ledger.js"));
  const decide = openDecideLedger(join(resolve(dir), "agent402-decide.db"));
  const { createShadowLedger } = await import(src("stripe-shadow-ledger.js"));
  // The shadow ledger only opens its store when it is switched on; it is
  // constructed here and never started (no timer, no network).
  const shadow = createShadowLedger({ env: { STRIPE_SHADOW_LEDGER: "on", STRIPE_SECRET_KEY: "unused-never-started" }, dbFile: join(resolve(dir), "agent402-stripe-shadow.db"), fetchImpl: async () => { throw new Error("never started"); }, log });
  // The record directories and the append logs.
  const { createCredits } = await import(src("credits.js"));
  const credits = createCredits({ stripe: null, baseUrl: "http://127.0.0.1", storeDir: join(resolve(dir), "credits"), onDebit: () => {}, onLoad: () => {}, log });
  const { createHumanCheckout } = await import(src("human-checkout.js"));
  const checkout = createHumanCheckout({ stripe: null, generate: async () => { throw new Error("never called"); }, baseUrl: "http://127.0.0.1", storeDir: join(resolve(dir), "human-checkout"), onSale: () => {}, log });
  const outbound = await import(src("outbound-ledger.js"));
  const wish = await import(src("wish.js"));
  await credits.ready();
  await checkout.ready();
  await sales.salesLedgerReady?.();
  await refunds.refundLedgerReady?.();
  await Promise.resolve(revenue.ledgerStoreReady?.()).catch(() => {});
  await stats.statsReady?.();
  await status.statusStoreReady?.();
  status.totalObservations?.(); // file mode opens the SQLite file on the first read
  await economy.economyHistoryReady?.();
  await pow.powReplayReady?.();
  await memory.memoryReady?.();
  await decide.ready;
  if (pg) {
    // The crawl cache is imported by the index's warm start.
    const index = await import(src("x402-index.js"));
    await index.warmStartIndexFromStateDb();
    const sdb = await import(src("state-db.js"));
    await sdb.stateDb();
    await sdb.stateStoresReady({ timeoutMs: 120_000 });
  }
  return { pg, modules: { sales, refunds, revenue, stats, status, economy, pow, memory, decide, shadow, credits, checkout, outbound, wish } };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain && process.argv[2] === "boot") {
  const dir = process.argv[3];
  if (!dir) { console.error("usage: node scripts/lib/state-stores.mjs boot <dir>"); process.exit(2); }
  const { pg } = await bootStores(dir);
  if (pg) { const sdb = await import("../../src/state-db.js"); await sdb.closeStateDb(); }
  console.log(JSON.stringify({ booted: true, pg, dir: resolve(dir) }));
  process.exit(0);
}
