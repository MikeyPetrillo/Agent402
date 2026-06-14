// Lightweight operational counters for the machine-to-machine economy: how many
// tool calls have been served, split by settlement method (USDC payment vs
// proof-of-work). Money itself is verifiable on-chain at the wallet — this is
// just the operational tally, persisted so it survives restarts.
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = existsSync("/data") ? "/data" : "/tmp";
const db = new Database(join(DATA_DIR, "agent402-stats.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS tool_counts (slug TEXT PRIMARY KEY, n INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS recent_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, method TEXT NOT NULL, ts INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS paid_tool_counts (slug TEXT PRIMARY KEY, n INTEGER NOT NULL);
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

setMetaIfAbsent.run("firstServed", String(Date.now()));
const bootedAt = Date.now();

const recordCall = db.transaction((slug, method) => {
  bumpCounter.run("total");
  bumpCounter.run(method === "pow" ? "viaProofOfWork" : "viaUSDC");
  bumpTool.run(slug);
  if (method !== "pow") bumpPaidTool.run(slug); // USDC purchases only — what people actually BUY
  // Privacy-safe activity feed: tool + settlement method + time only — never a
  // payload, wallet, or IP. Only successful (200) served calls reach here.
  insertRecent.run(slug, method, Date.now());
  pruneRecent.run(RECENT_KEEP);
  setMetaIfAbsent.run("firstServed", String(Date.now()));
});

/** Count one successfully served paid-tool call. method: "usdc" | "pow". */
export function recordServedCall(slug, method) {
  try {
    recordCall(slug, method);
  } catch {
    /* counters are best-effort; never break a response */
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
    },
    topTools: allTools.all(),
    topPaidTools, // most-PURCHASED tools (USDC only), with estimated revenue
    estimatedRevenueUsd, // sum of price × USDC-purchase count (counters; chain is source of truth)
    recentCalls: getRecent.all(RECENT_SHOW).map((r) => ({
      slug: r.slug,
      paidWith: r.method === "pow" ? "proof-of-work" : "usdc",
      at: new Date(r.ts).toISOString(),
    })),
    servingSince: new Date(firstServed).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - bootedAt) / 1000),
    runTheDemo: `${baseUrl}/llms.txt`,
  };
}
