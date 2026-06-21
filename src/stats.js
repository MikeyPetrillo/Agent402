// Lightweight operational counters for the machine-to-machine economy: how many
// tool calls have been served, split by settlement method (USDC payment vs
// proof-of-work). Money itself is verifiable on-chain at the wallet — this is
// just the operational tally, persisted so it survives restarts.
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Counters + recent-calls + meta live in /data (persistent volume) so they
// survive redeploys — recentCalls is the live activity feed on the landing
// page, and a silent fallback to /tmp would wipe it on every container
// restart. Mirrors the same contract as pow.js: refuse to boot in production
// without /data unless an explicit ephemeral opt-in is set (local tests,
// FREE_MODE sweeps, edge runners). Exported as `statsPersistent` so /health
// can surface which path was actually picked.
const HAS_DATA_DIR = existsSync("/data");
const ALLOW_EPHEMERAL =
  process.env.STATS_ALLOW_EPHEMERAL === "true" ||
  process.env.FREE_MODE === "true" ||
  process.env.NODE_ENV !== "production";
if (!HAS_DATA_DIR && !ALLOW_EPHEMERAL) {
  console.error(
    "Stats DB has no persistent volume (/data missing) and NODE_ENV=production. Mount /data, or set STATS_ALLOW_EPHEMERAL=true to accept losing recentCalls + counters on restart."
  );
  process.exit(1);
}
const DATA_DIR = HAS_DATA_DIR ? "/data" : "/tmp";
export const statsPersistent = HAS_DATA_DIR;
const db = new Database(join(DATA_DIR, "agent402-stats.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS tool_counts (slug TEXT PRIMARY KEY, n INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS recent_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, method TEXT NOT NULL, ts INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS paid_tool_counts (slug TEXT PRIMARY KEY, n INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS heartbeat_tool_counts (slug TEXT PRIMARY KEY, n INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS charged_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, status INTEGER NOT NULL, ts INTEGER NOT NULL);
`);

const RECENT_KEEP = 200; // rows retained
const RECENT_SHOW = 25;  // rows exposed in /api/stats

const bumpCounter = db.prepare("INSERT INTO counters (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1");
const bumpTool = db.prepare("INSERT INTO tool_counts (slug, n) VALUES (?, 1) ON CONFLICT(slug) DO UPDATE SET n = n + 1");
const getCounter = db.prepare("SELECT n FROM counters WHERE k = ?");
const allTools = db.prepare("SELECT slug, n FROM tool_counts ORDER BY n DESC LIMIT 10");
const setMetaIfAbsent = db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING");
const getMeta = db.prepare("SELECT v FROM meta WHERE k = ?");
const insertRecent = db.prepare("INSERT INTO recent_calls (slug, method, ts) VALUES (?, ?, ?)");
const pruneRecent = db.prepare("DELETE FROM recent_calls WHERE id <= (SELECT MAX(id) FROM recent_calls) - ?");
const getRecent = db.prepare("SELECT slug, method, ts FROM recent_calls ORDER BY id DESC LIMIT ?");
const bumpPaidTool = db.prepare("INSERT INTO paid_tool_counts (slug, n) VALUES (?, 1) ON CONFLICT(slug) DO UPDATE SET n = n + 1");
const topPaid = db.prepare("SELECT slug, n FROM paid_tool_counts ORDER BY n DESC LIMIT 10");
const allPaid = db.prepare("SELECT slug, n FROM paid_tool_counts");
// Per-tool count of internal heartbeat probes (PoW path, agent402-heartbeat UA).
// Kept separate so the operator dashboard can show real external PoW adoption
// without the every-15-min /api/hash probe drowning it out.
const bumpHeartbeatTool = db.prepare("INSERT INTO heartbeat_tool_counts (slug, n) VALUES (?, 1) ON CONFLICT(slug) DO UPDATE SET n = n + 1");
const allHeartbeat = db.prepare("SELECT slug, n FROM heartbeat_tool_counts");
const allToolsFull = db.prepare("SELECT slug, n FROM tool_counts ORDER BY n DESC");
const getRecentAll = db.prepare("SELECT slug, method, ts FROM recent_calls ORDER BY id DESC LIMIT ?");
// Detection for "we charged USDC on-chain but didn't serve a 200" — the worst-
// case operational failure (we took the buyer's money, gave them nothing). Kept
// as both a counter and a small retained log so an alarm can show *which* tools
// failed and when. Pruned to the most recent 200 events, same as recent_calls.
const insertChargedFailure = db.prepare("INSERT INTO charged_failures (slug, status, ts) VALUES (?, ?, ?)");
const pruneChargedFailures = db.prepare("DELETE FROM charged_failures WHERE id <= (SELECT MAX(id) FROM charged_failures) - ?");
const getChargedFailures = db.prepare("SELECT slug, status, ts FROM charged_failures ORDER BY id DESC LIMIT ?");

setMetaIfAbsent.run("firstServed", String(Date.now()));
const bootedAt = Date.now();

const recordCall = db.transaction((slug, method) => {
  bumpCounter.run("total");
  // Three rails: USDC (real revenue), external PoW (real free-tier adoption),
  // heartbeat (our own probe — pays via PoW but we track it separately so the
  // operator dashboard reflects external traffic only).
  const counterKey = method === "pow" ? "viaProofOfWork" : method === "heartbeat" ? "viaHeartbeat" : "viaUSDC";
  bumpCounter.run(counterKey);
  bumpTool.run(slug);
  if (method === "usdc") bumpPaidTool.run(slug); // USDC purchases — what people actually BUY
  if (method === "heartbeat") bumpHeartbeatTool.run(slug); // internal probe traffic
  // Privacy-safe activity feed: tool + settlement method + time only — never a
  // payload, wallet, or IP. Only successful (200) served calls reach here.
  insertRecent.run(slug, method, Date.now());
  pruneRecent.run(RECENT_KEEP);
  setMetaIfAbsent.run("firstServed", String(Date.now()));
});

/** Count one successfully served paid-tool call. method: "usdc" | "pow" | "heartbeat". */
export function recordServedCall(slug, method) {
  try {
    recordCall(slug, method);
  } catch {
    /* counters are best-effort; never break a response */
  }
}

/**
 * Record a "charged but didn't serve" event — the x402 middleware settled USDC
 * on-chain (X-PAYMENT-RESPONSE header present on the response) but the handler
 * returned non-200. The buyer was billed for nothing. A non-zero count of these
 * is an operational red alert; CI surfaces it via /api/stats.chargedButFailed.
 */
const recordFailure = db.transaction((slug, status) => {
  bumpCounter.run("chargedButFailedTotal");
  insertChargedFailure.run(slug, status, Date.now());
  pruneChargedFailures.run(RECENT_KEEP);
});

export function recordChargedFailure(slug, status) {
  try {
    recordFailure(slug, status);
  } catch {
    /* best-effort */
  }
}

/**
 * Lightweight DB liveness probe for /health. Reads the cheapest possible
 * statement (PK lookup on a tiny table) and returns true on success. Never
 * throws — the caller decides what status code to return.
 */
export function dbHealthy() {
  try {
    getMeta.get("firstServed");
    return true;
  } catch {
    return false;
  }
}

export function getStats({ wallet, walletName, network, toolCount, baseUrl, prices }) {
  const num = (k) => getCounter.get(k)?.n ?? 0;
  const priceOf = (slug) => (prices && Number(prices[slug])) || 0;
  const estimatedRevenueUsd = +allPaid.all().reduce((s, r) => s + r.n * priceOf(r.slug), 0).toFixed(4);
  const topPaidTools = topPaid.all().map((r) => ({ slug: r.slug, purchases: r.n, revenueUsd: +(r.n * priceOf(r.slug)).toFixed(4) }));
  const firstServed = parseInt(getMeta.get("firstServed")?.v ?? Date.now(), 10);
  const explorer = network === "base-sepolia" ? "https://sepolia.basescan.org" : "https://basescan.org";
  return {
    service: "Agent402",
    summary: "A live node in the machine-to-machine economy: autonomous agents pay per call in USDC (or with compute) and get the result — no human, no signup.",
    tools: toolCount,
    payment: { protocol: "x402", network, currency: "USDC" },
    wallet,
    walletName: walletName || null,
    onchainRevenueProof: wallet ? `${explorer}/address/${wallet}#tokentxns` : null,
    onchainNote: "Settled revenue is verifiable on-chain at the wallet above — that is the trustless source of truth, not this counter.",
    toolCallsServed: {
      total: num("total"),
      viaUSDC: num("viaUSDC"),
      viaProofOfWork: num("viaProofOfWork"),
      viaHeartbeat: num("viaHeartbeat"), // internal probe traffic (PoW path, agent402-heartbeat UA)
    },
    // Charged on-chain but handler returned non-200 — should always be 0. Any
    // value here means we billed the buyer and gave them an error. The dashboard
    // and a daily CI check both alert when this is nonzero.
    chargedButFailed: num("chargedButFailedTotal"),
    topTools: allTools.all(),
    topPaidTools, // most-PURCHASED tools (USDC only), with estimated revenue
    estimatedRevenueUsd, // sum of price × USDC-purchase count (counters; chain is source of truth)
    recentCalls: getRecent.all(RECENT_SHOW).map((r) => ({
      slug: r.slug,
      paidWith: r.method === "pow" ? "proof-of-work" : r.method === "heartbeat" ? "heartbeat" : "usdc",
      at: new Date(r.ts).toISOString(),
    })),
    servingSince: new Date(firstServed).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - bootedAt) / 1000),
    runTheDemo: `${baseUrl}/llms.txt`,
  };
}

/**
 * Full per-tool breakdown for the operator dashboard — every tool that's ever
 * been served, USDC purchases per tool, estimated revenue per tool, and the
 * full retained recent-calls log. Pricing comes from the catalog at the call
 * site so this module stays decoupled from CATALOG. Operator-only — gated by
 * AGENT402_OPERATOR_TOKEN at the route layer.
 */
export function getOperatorBreakdown({ prices, walletOnlySet, limit = RECENT_KEEP } = {}) {
  const priceOf = (slug) => (prices && Number(prices[slug])) || 0;
  const isWalletOnly = (slug) => !!(walletOnlySet && walletOnlySet.has && walletOnlySet.has(slug));
  const paidBySlug = new Map(allPaid.all().map((r) => [r.slug, r.n]));
  const heartbeatBySlug = new Map(allHeartbeat.all().map((r) => [r.slug, r.n]));
  const tools = allToolsFull.all().map((r) => {
    const paid = paidBySlug.get(r.slug) || 0;
    const heartbeat = heartbeatBySlug.get(r.slug) || 0;
    return {
      slug: r.slug,
      calls: r.n,
      paid,
      // External PoW = everything that isn't USDC and isn't our heartbeat probe.
      // This is the column that reflects real free-tier adoption.
      pow: Math.max(0, r.n - paid - heartbeat),
      heartbeat,
      revenueUsd: +(paid * priceOf(r.slug)).toFixed(4),
      pricePerCall: priceOf(r.slug),
      walletOnly: isWalletOnly(r.slug),
    };
  });
  return {
    totals: {
      total: getCounter.get("total")?.n ?? 0,
      viaUSDC: getCounter.get("viaUSDC")?.n ?? 0,
      viaProofOfWork: getCounter.get("viaProofOfWork")?.n ?? 0,
      viaHeartbeat: getCounter.get("viaHeartbeat")?.n ?? 0,
      estimatedRevenueUsd: +tools.reduce((s, t) => s + t.revenueUsd, 0).toFixed(4),
      toolsServed: tools.length,
      chargedButFailed: getCounter.get("chargedButFailedTotal")?.n ?? 0,
    },
    tools,
    recentCalls: getRecentAll.all(limit).map((r) => ({
      slug: r.slug,
      paidWith: r.method === "pow" ? "proof-of-work" : r.method === "heartbeat" ? "heartbeat" : "usdc",
      at: new Date(r.ts).toISOString(),
    })),
    chargedFailures: getChargedFailures.all(limit).map((r) => ({
      slug: r.slug,
      status: r.status,
      at: new Date(r.ts).toISOString(),
    })),
    bootedAt: new Date(bootedAt).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - bootedAt) / 1000),
  };
}
