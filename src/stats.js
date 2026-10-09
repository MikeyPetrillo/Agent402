// Lightweight operational counters for the machine-to-machine economy: how many
// tool calls have been served, split by settlement method (USDC payment vs
// proof-of-work). Money itself is verifiable on-chain at the wallet — this is
// just the operational tally, persisted so it survives restarts.
//
// Two backends behind one synchronous API:
//   - the SQLite file on the volume (no state database configured): every
//     read and write is a prepared statement, exactly as before;
//   - the state database (STATE_DATABASE_URL set): the tables live in Postgres
//     under the stats_ prefix, an in-memory mirror of them is filled by the
//     first load (registered with trackStoreReady, so the server waits for it)
//     and updated on every write, and the writes themselves go to Postgres
//     through one ordered queue as additive deltas (n = n + delta), so two
//     containers overlapping at a deploy both land their counts exactly. The
//     SQLite file is imported once (ON CONFLICT DO NOTHING, marked in the
//     imports table) the first time the database is on.
// Readers keep their synchronous signatures on both backends. Writes are
// fire-and-forget on both; with the database on, recordChargedFailure and
// recordUpstreamSpend (the two money-adjacent rows) flush at once and resolve
// when the row has landed, and statsFlush() awaits everything queued.
import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { importOnce, stateDbEnabled, stateDbSchema, stateQuery, trackStoreReady, withStateTx } from "./state-db.js";

// Counters + recent-calls + meta live in /data (persistent volume) so they
// survive redeploys — recentCalls is the live activity feed on the landing
// page, and a silent fallback to /tmp would wipe it on every container
// restart. Mirrors the same contract as pow.js: refuse to boot in production
// without /data unless an explicit ephemeral opt-in is set (local tests,
// FREE_MODE sweeps, edge runners). Exported as `statsPersistent` so /health
// can surface which path was actually picked. With the state database on the
// tally lives there, so the volume is not required.
const HAS_DATA_DIR = existsSync("/data");
const USE_PG = stateDbEnabled();
const ALLOW_EPHEMERAL =
  process.env.STATS_ALLOW_EPHEMERAL === "true" ||
  process.env.FREE_MODE === "true" ||
  process.env.NODE_ENV !== "production";
if (!HAS_DATA_DIR && !USE_PG && !ALLOW_EPHEMERAL) {
  console.error(
    "Stats DB has no persistent volume (/data missing) and NODE_ENV=production. Mount /data, or set STATS_ALLOW_EPHEMERAL=true to accept losing recentCalls + counters on restart."
  );
  process.exit(1);
}
// STATS_DB_DIR (tests only) points the SQLite file somewhere else; unset, the
// file is where it always was.
const DATA_DIR = String(process.env.STATS_DB_DIR || "").trim() || (HAS_DATA_DIR ? "/data" : "/tmp");
export const statsPersistent = HAS_DATA_DIR || USE_PG;
const DB_FILE = join(DATA_DIR, "agent402-stats.db");
/** The database's name for the import of the SQLite file (the file's basename). */
export const STATS_IMPORT_NAME = "agent402-stats.db";

const RECENT_KEEP = 200; // rows retained
const RECENT_SHOW = 25;  // rows exposed in /api/stats
const TOP_TOOLS_SHOW = 10; // rows in the public topTools ranking (allTools' LIMIT)

// The router-execute tiers: the only catalog slugs Agent402 earns a margin
// on (every other paid call is buyer wallet straight to seller wallet).
const ROUTER_SLUGS = new Set(["route-execute", "route-execute-plus", "route-execute-max", "route-execute-pro"]);

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// The two writers, over statement-shaped handles. Each handle has .run(...);
// on SQLite they are the prepared statements inside one db.transaction, on
// Postgres they update the mirror and add to the pending delta. One body for
// both, so the two backends cannot disagree about what a served call bumps.
// ---------------------------------------------------------------------------
function servedCallWriter({ bumpCounter, bumpTool, bumpPaidTool, bumpHeartbeatTool, insertRecent, pruneRecent, bumpDaily, setMetaIfAbsent }) {
  return (slug, method, network, wire, internal = false) => {
    // A settled USDC/Tempo call from OUR OWN wallets (the daily canary, the
    // Tempo volume runner - signed heartbeat token on a paid request) is real
    // on-chain settlement but NOT external demand: it lands in viaUSDCInternal,
    // the tool/recent/daily series file it as heartbeat traffic, and it never
    // bumps viaUSDC / viaMPPWire / the per-chain split / paid-tool ranks. Before
    // 2026-08-19 the heartbeat class was only recognised on the PoW path, so
    // ~1,000 self-buys a day would have read as paid external calls on the
    // homepage counter and the MPP-adoption counter (cost audit 2026-08-19).
    if (method === "usdc" && internal) {
      bumpCounter.run("total");
      bumpCounter.run("viaUSDCInternal");
      if (wire === "mpp") bumpCounter.run("viaMPPWireInternal");
      bumpTool.run(slug);
      bumpHeartbeatTool.run(slug);
      insertRecent.run(slug, "heartbeat", Date.now());
      pruneRecent.run(RECENT_KEEP);
      bumpDaily.run(today(), "heartbeat");
      setMetaIfAbsent.run("firstServed", String(Date.now()));
      return;
    }
    bumpCounter.run("total");
    // Three rails: USDC (real revenue), external PoW (real free-tier adoption),
    // heartbeat (our own probe — pays via PoW but we track it separately so the
    // operator dashboard reflects external traffic only).
    // "trial" is its OWN class and must never fall through to viaUSDC. A trial
    // call moves no money, so counting it as USDC would inflate the paid series
    // with revenue that does not exist - the else-branch here is `usdc`, so a new
    // free path that forgets to name itself is silently booked as a sale.
    const counterKey =
      method === "pow" ? "viaProofOfWork"
        : method === "heartbeat" ? "viaHeartbeat"
        : method === "credits" ? "viaCredits"
          : method === "trial" ? "viaTrial"
            : "viaUSDC";
    bumpCounter.run(counterKey);
    bumpTool.run(slug);
    if (method === "usdc") bumpPaidTool.run(slug); // USDC purchases — what people actually BUY
    // Which chain settled it. Multi-chain x402 means "viaUSDC" alone can't answer
    // "did anyone ever pay on Solana" — the settle receipt's network is the only
    // place that fact exists at serve time. "unknown" = settled before this
    // counter existed or the receipt header didn't decode.
    if (method === "usdc") bumpCounter.run(`usdcNet:${network || "unknown"}`);
    // Which WIRE carried the credential. Same settlement, same rail, but the
    // buyer spoke either x402 (PAYMENT-SIGNATURE) or MPP (Authorization:
    // Payment, translated by src/mpp-shim.js). Counted only for usdc — the MPP
    // adoption signal after the MPPScan/tempo directory listings.
    if (method === "usdc" && wire === "mpp") bumpCounter.run("viaMPPWire");
    // Router executions are the only paid calls Agent402 earns a margin on -
    // every other paid call is buyer wallet straight to seller wallet. Counted
    // only for usdc (a free/PoW router call, if one ever exists, earns no
    // margin either) so the disclosure line's ratio against viaUSDC is
    // meaningful. ROUTER_SLUGS mirrors pow.js's route-execute* wallet-only
    // set - if a future tier is added there without an update here, it simply
    // undercounts rather than breaking, so this is deliberately a local
    // literal rather than an import that could pull in unrelated PoW logic.
    if (method === "usdc" && ROUTER_SLUGS.has(slug)) bumpCounter.run("viaRouter");
    if (method === "heartbeat") bumpHeartbeatTool.run(slug); // internal probe traffic
    // Privacy-safe activity feed: tool + settlement method + time only — never a
    // payload, wallet, or IP. Only successful (200) served calls reach here.
    insertRecent.run(slug, method, Date.now());
    pruneRecent.run(RECENT_KEEP);
    // Same transaction as the counters above: the daily series and the lifetime
    // totals are written together or not at all, so they cannot drift apart.
    bumpDaily.run(
      today(),
      method === "pow" ? "pow" : method === "heartbeat" ? "heartbeat" : method === "trial" ? "trial" : "usdc"
    );
    setMetaIfAbsent.run("firstServed", String(Date.now()));
  };
}

/**
 * Record a "charged but didn't serve" event — the x402 middleware settled USDC
 * on-chain (X-PAYMENT-RESPONSE header present on the response) but the handler
 * returned non-200. The buyer was billed for nothing. A non-zero count of these
 * is an operational red alert; CI surfaces it via /api/stats.chargedButFailed.
 */
function chargedFailureWriter({ bumpCounter, insertChargedFailure, pruneChargedFailures }) {
  return (slug, status) => {
    bumpCounter.run("chargedButFailedTotal");
    insertChargedFailure.run(slug, status, Date.now());
    pruneChargedFailures.run(RECENT_KEEP);
  };
}

// ---------------------------------------------------------------------------
// SQLite backend: the file on the volume, prepared statements, synchronous.
// ---------------------------------------------------------------------------
function openSqlite(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tool_counts (slug TEXT PRIMARY KEY, n INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recent_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, method TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS paid_tool_counts (slug TEXT PRIMARY KEY, n INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS heartbeat_tool_counts (slug TEXT PRIMARY KEY, n INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS charged_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, status INTEGER NOT NULL, ts INTEGER NOT NULL);
    -- Daily served-call tally by settlement method. The lifetime counters above
    -- answer "how much free-tier adoption is there"; they cannot answer "is it
    -- growing", and recent_calls is pruned to RECENT_KEEP (200 rows) so it can
    -- never be the source of a time series. One row per (day, method) — three
    -- methods x 365 days is ~1k rows a year, so this is never pruned.
    CREATE TABLE IF NOT EXISTS daily_calls (day TEXT NOT NULL, method TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, method));
    -- Outbound PAID-upstream call meter, day-bucketed (2026-07-29). The in-memory
    -- meter in search.js resets on every redeploy, so it cannot reconcile a
    -- billing MONTH against the provider's dashboard; this table is the
    -- deploy-proof series that can. One row per (day, upstream, caller) -
    -- a handful of upstreams x a handful of callers x 365 days - never pruned.
    CREATE TABLE IF NOT EXISTS daily_upstream_calls (day TEXT NOT NULL, upstream TEXT NOT NULL, caller TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, upstream, caller));
    CREATE TABLE IF NOT EXISTS daily_upstream_spend (day TEXT NOT NULL, source TEXT NOT NULL, usd_micro INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, source));
    -- Self-serve seller conversion/churn (2026-08-16). Every previous seller
    -- signal lives in x402-index.js's in-memory crawl cache (submittedSeeds is a
    -- bare Set<origin> persisted with no timestamps at all), so there was no way
    -- to answer "of everyone who registered via /sell, how many are still live,
    -- and how many ever actually settled a payment" without hand-diffing JSON
    -- snapshots. first_seen is stamped once, at registration. last_routable_seen
    -- updates every crawl cycle the origin's x402 surface answers (churn signal —
    -- stops advancing the moment a seller goes dark). last_settled_seen updates
    -- only when that cycle's leaderboard snapshot shows the origin with
    -- callsSettled > 0 (conversion signal — did they ever get paid, not just
    -- stay reachable). Both nullable: a fresh registration has neither yet beyond
    -- the initial routable stamp, and most registrations never settle at all.
    CREATE TABLE IF NOT EXISTS seller_registrations (origin TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_routable_seen INTEGER, last_settled_seen INTEGER);
  `);

  const bumpCounter = db.prepare("INSERT INTO counters (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1");
  const bumpTool = db.prepare("INSERT INTO tool_counts (slug, n) VALUES (?, 1) ON CONFLICT(slug) DO UPDATE SET n = n + 1");
  const getCounter = db.prepare("SELECT n FROM counters WHERE k = ?");
  const allTools = db.prepare(`SELECT slug, n FROM tool_counts ORDER BY n DESC LIMIT ${TOP_TOOLS_SHOW}`);
  const countToolsWithCalls = db.prepare("SELECT COUNT(*) AS n FROM tool_counts");
  // TRUE counts for the two capped lists above, so neither is ever the only
  // number a reader has. Uncapped by construction: a COUNT(*), never a length.
  const countChargedFailures = db.prepare("SELECT COUNT(*) AS n FROM charged_failures");
  const countChargedFailuresGenuine = db.prepare("SELECT COUNT(*) AS n FROM charged_failures WHERE status <> 402");
  const setMetaIfAbsent = db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING");
  const getMeta = db.prepare("SELECT v FROM meta WHERE k = ?");
  const insertRecent = db.prepare("INSERT INTO recent_calls (slug, method, ts) VALUES (?, ?, ?)");
  const pruneRecent = db.prepare("DELETE FROM recent_calls WHERE id <= (SELECT MAX(id) FROM recent_calls) - ?");
  const getRecent = db.prepare("SELECT slug, method, ts FROM recent_calls ORDER BY id DESC LIMIT ?");
  const bumpPaidTool = db.prepare("INSERT INTO paid_tool_counts (slug, n) VALUES (?, 1) ON CONFLICT(slug) DO UPDATE SET n = n + 1");
  const usdcNetCounters = db.prepare("SELECT k, n FROM counters WHERE k LIKE 'usdcNet:%'");
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
  const bumpDaily = db.prepare("INSERT INTO daily_calls (day, method, n) VALUES (?, ?, 1) ON CONFLICT(day, method) DO UPDATE SET n = n + 1");
  const allDaily = db.prepare("SELECT day, method, n FROM daily_calls ORDER BY day, method");
  const bumpUpstream = db.prepare("INSERT INTO daily_upstream_calls (day, upstream, caller, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, upstream, caller) DO UPDATE SET n = n + 1");
  const bumpSpend = db.prepare("INSERT INTO daily_upstream_spend (day, source, usd_micro, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, source) DO UPDATE SET usd_micro = usd_micro + excluded.usd_micro, n = n + 1");
  const dailySpend = db.prepare("SELECT day, source, usd_micro, n FROM daily_upstream_spend ORDER BY day, source");
  const dailyUpstream = db.prepare("SELECT day, caller, n FROM daily_upstream_calls WHERE upstream = ? ORDER BY day, caller");
  const insertChargedFailure = db.prepare("INSERT INTO charged_failures (slug, status, ts) VALUES (?, ?, ?)");
  const pruneChargedFailures = db.prepare("DELETE FROM charged_failures WHERE id <= (SELECT MAX(id) FROM charged_failures) - ?");
  const getChargedFailures = db.prepare("SELECT slug, status, ts FROM charged_failures ORDER BY id DESC LIMIT ?");
  const countChargedFailuresGenuineSince = db.prepare("SELECT COUNT(*) AS n FROM charged_failures WHERE status <> 402 AND ts >= ?");
  const upsertSellerRegistration = db.prepare(`
    INSERT INTO seller_registrations (origin, first_seen, last_routable_seen, last_settled_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(origin) DO UPDATE SET
      last_routable_seen = excluded.last_routable_seen,
      last_settled_seen = COALESCE(excluded.last_settled_seen, last_settled_seen)
  `);
  const firstSeenFor = db.prepare("SELECT first_seen FROM seller_registrations WHERE origin = ?");
  // first_seen is INSERT-only above (ON CONFLICT updates the other two columns),
  // so a succession onto an EXISTING row needs its own statement. MIN() so a
  // re-registration can only ever pull the date earlier, never later.
  const backdateSellerRegistration = db.prepare("UPDATE seller_registrations SET first_seen = MIN(first_seen, ?) WHERE origin = ?");
  const allSellerRegistrations = db.prepare("SELECT origin, first_seen, last_routable_seen, last_settled_seen FROM seller_registrations ORDER BY first_seen DESC");
  // A submitted origin that has never answered a probe has no row, and the
  // release pass only looks at rows, so it held its slot forever. This gives it
  // one (first_seen = now, never routable) without touching an existing row, so
  // it ages out under the same rule as everyone else.
  const insertSellerRegistrationIfAbsent = db.prepare("INSERT OR IGNORE INTO seller_registrations (origin, first_seen, last_routable_seen, last_settled_seen) VALUES (?, ?, NULL, NULL)");
  const deleteSellerRegistrationStmt = db.prepare("DELETE FROM seller_registrations WHERE origin = ?");

  const recordCall = db.transaction(servedCallWriter({ bumpCounter, bumpTool, bumpPaidTool, bumpHeartbeatTool, insertRecent, pruneRecent, bumpDaily, setMetaIfAbsent }));
  const recordFailure = db.transaction(chargedFailureWriter({ bumpCounter, insertChargedFailure, pruneChargedFailures }));

  setMetaIfAbsent.run("firstServed", String(Date.now()));

  return {
    backend: "sqlite",
    ready: Promise.resolve(),
    flush: () => Promise.resolve(),
    recordCall,
    recordFailure,
    bumpUpstream: (day, upstream, caller) => { bumpUpstream.run(day, upstream, caller); },
    bumpSpend: (day, source, micro) => { bumpSpend.run(day, source, micro); },
    sellerSeen(origin, now, settledAt, prior) {
      upsertSellerRegistration.run(origin, now, now, settledAt);
      if (prior) backdateSellerRegistration.run(prior, origin);
    },
    sellerEnsure: (origin, now) => insertSellerRegistrationIfAbsent.run(origin, now).changes > 0,
    sellerDelete: (origin) => deleteSellerRegistrationStmt.run(origin).changes > 0,
    sellerFirstSeen: (origin) => firstSeenFor.get(origin)?.first_seen ?? null,
    sellerRegistrations: () => allSellerRegistrations.all(),
    counter: (k) => getCounter.get(k)?.n ?? 0,
    usdcNetCounters: () => usdcNetCounters.all(),
    topTools: () => allTools.all(),
    toolsFull: () => allToolsFull.all(),
    toolsWithCalls: () => countToolsWithCalls.get()?.n ?? 0,
    paidAll: () => allPaid.all(),
    heartbeatAll: () => allHeartbeat.all(),
    meta: (k) => getMeta.get(k)?.v ?? null,
    recent: (limit) => getRecent.all(limit),
    recentAll: (limit) => getRecentAll.all(limit),
    chargedFailures: (limit) => getChargedFailures.all(limit),
    chargedFailuresRetained: () => countChargedFailures.get()?.n ?? 0,
    chargedFailuresGenuine: () => countChargedFailuresGenuine.get()?.n ?? 0,
    chargedFailuresGenuineSince: (since) => countChargedFailuresGenuineSince.get(since)?.n ?? 0,
    dailyCalls: () => allDaily.all(),
    dailyUpstreamSpend: () => dailySpend.all(),
    dailyUpstreamCalls: (upstream) => dailyUpstream.all(upstream),
    healthy() { getMeta.get("firstServed"); return true; },
  };
}

// ---------------------------------------------------------------------------
// Postgres backend: the mirror, the delta queue, the one-time import.
// ---------------------------------------------------------------------------
const PG_TABLES = ["counters", "tool_counts", "paid_tool_counts", "heartbeat_tool_counts", "meta", "recent_calls", "charged_failures", "daily_calls", "daily_upstream_calls", "daily_upstream_spend", "seller_registrations"];
const FAILURES_PENDING_MAX = 10_000; // pending charged-failure rows kept while the database is unreachable
const SELLER_OPS_PENDING_MAX = 10_000;
const FLUSH_COALESCE_MS = 25;
const FLUSH_RETRY_MS = 5_000;
const IMPORT_CHUNK = 2_000;
const numOrNull = (v) => (v == null ? null : Number(v));
const key2 = (a, b) => `${a}\u0000${b}`;
const key3 = (a, b, c) => `${a}\u0000${b}\u0000${c}`;
const addTo = (map, k, n = 1) => { map.set(k, (map.get(k) || 0) + n); };

function openPg(file) {
  const T = (t) => `${stateDbSchema()}.stats_${t}`;
  const say = (m) => console.log(`[stats] ${m}`);
  let lastError = null;
  let loaded = false;

  // ---- the mirror: what every synchronous reader answers from ----
  const counters = new Map();
  const toolCounts = new Map();
  const paidCounts = new Map();
  const heartbeatCounts = new Map();
  const meta = new Map();
  const recent = []; // oldest first, at most RECENT_KEEP
  const failures = []; // oldest first, at most RECENT_KEEP
  const dailyCalls = new Map(); // key2(day, method) -> { day, method, n }
  const upstreamCalls = new Map(); // key3(day, upstream, caller) -> { day, upstream, caller, n }
  const spend = new Map(); // key2(day, source) -> { day, source, usd_micro, n }
  const sellers = new Map(); // origin -> { origin, first_seen, last_routable_seen, last_settled_seen }

  // ---- the pending delta: what the next flush writes, in order ----
  const newDelta = () => ({ dirty: false, counters: new Map(), tools: new Map(), paid: new Map(), heartbeat: new Map(), meta: new Map(), recent: [], failures: [], daily: new Map(), upstream: new Map(), spend: new Map(), sellerOps: [] });
  let delta = newDelta();
  const touch = () => { delta.dirty = true; flushSoon(); };

  // Mirror + delta updates, one function per statement the writers use.
  const mirrorSellerOp = (op) => {
    const row = sellers.get(op.origin);
    if (op.kind === "seen") {
      if (row) { row.last_routable_seen = op.now; if (op.settledAt != null) row.last_settled_seen = op.settledAt; }
      else sellers.set(op.origin, { origin: op.origin, first_seen: op.now, last_routable_seen: op.now, last_settled_seen: op.settledAt });
    } else if (op.kind === "backdate") {
      if (row) row.first_seen = Math.min(row.first_seen, op.prior);
    } else if (op.kind === "ensure") {
      if (!row) sellers.set(op.origin, { origin: op.origin, first_seen: op.now, last_routable_seen: null, last_settled_seen: null });
    } else if (op.kind === "delete") {
      sellers.delete(op.origin);
    }
  };
  const sellerOp = (op) => {
    mirrorSellerOp(op);
    delta.sellerOps.push(op);
    if (delta.sellerOps.length > SELLER_OPS_PENDING_MAX) delta.sellerOps.splice(0, delta.sellerOps.length - SELLER_OPS_PENDING_MAX);
    touch();
  };
  const pushRing = (ring, row) => { ring.push(row); if (ring.length > RECENT_KEEP) ring.splice(0, ring.length - RECENT_KEEP); };
  const stmts = {
    bumpCounter: { run: (k) => { addTo(counters, k); addTo(delta.counters, k); touch(); } },
    bumpTool: { run: (slug) => { addTo(toolCounts, slug); addTo(delta.tools, slug); touch(); } },
    bumpPaidTool: { run: (slug) => { addTo(paidCounts, slug); addTo(delta.paid, slug); touch(); } },
    bumpHeartbeatTool: { run: (slug) => { addTo(heartbeatCounts, slug); addTo(delta.heartbeat, slug); touch(); } },
    setMetaIfAbsent: { run: (k, v) => { if (!meta.has(k)) meta.set(k, v); if (!delta.meta.has(k)) delta.meta.set(k, v); touch(); } },
    // Pending feed rows beyond RECENT_KEEP would be pruned the moment they
    // landed, so the pending list is trimmed the same way: nothing a reader
    // could ever see is dropped.
    insertRecent: { run: (slug, method, ts) => { const row = { slug, method, ts }; pushRing(recent, row); pushRing(delta.recent, row); touch(); } },
    pruneRecent: { run: () => {} }, // the ring and the flush prune by construction
    bumpDaily: { run: (day, method) => { const k = key2(day, method); (dailyCalls.get(k) || dailyCalls.set(k, { day, method, n: 0 }).get(k)).n += 1; addTo(delta.daily, k); touch(); } },
    bumpUpstream: { run: (day, upstream, caller) => { const k = key3(day, upstream, caller); (upstreamCalls.get(k) || upstreamCalls.set(k, { day, upstream, caller, n: 0 }).get(k)).n += 1; addTo(delta.upstream, k); touch(); } },
    bumpSpend: { run: (day, source, micro) => {
      const k = key2(day, source);
      const row = spend.get(k) || spend.set(k, { day, source, usd_micro: 0, n: 0 }).get(k);
      row.usd_micro += micro; row.n += 1;
      const d = delta.spend.get(k) || delta.spend.set(k, { usd_micro: 0, n: 0 }).get(k);
      d.usd_micro += micro; d.n += 1;
      touch();
    } },
    // Every charged failure lands: the pending list is capped far above
    // anything a healthy run produces, and only while the database is away.
    insertChargedFailure: { run: (slug, status, ts) => { const row = { slug, status, ts }; pushRing(failures, row); delta.failures.push(row); if (delta.failures.length > FAILURES_PENDING_MAX) delta.failures.splice(0, delta.failures.length - FAILURES_PENDING_MAX); touch(); } },
    pruneChargedFailures: { run: () => {} },
  };
  const recordCall = servedCallWriter(stmts);
  const recordFailure = chargedFailureWriter(stmts);

  // ---- tables ----
  let tablesReady = null;
  const ensureTables = () => {
    if (!tablesReady) {
      tablesReady = stateQuery(`
        CREATE TABLE IF NOT EXISTS ${T("counters")} (k TEXT PRIMARY KEY, n BIGINT NOT NULL);
        CREATE TABLE IF NOT EXISTS ${T("tool_counts")} (slug TEXT PRIMARY KEY, n BIGINT NOT NULL);
        CREATE TABLE IF NOT EXISTS ${T("paid_tool_counts")} (slug TEXT PRIMARY KEY, n BIGINT NOT NULL);
        CREATE TABLE IF NOT EXISTS ${T("heartbeat_tool_counts")} (slug TEXT PRIMARY KEY, n BIGINT NOT NULL);
        CREATE TABLE IF NOT EXISTS ${T("meta")} (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ${T("recent_calls")} (id BIGSERIAL PRIMARY KEY, slug TEXT NOT NULL, method TEXT NOT NULL, ts BIGINT NOT NULL);
        CREATE TABLE IF NOT EXISTS ${T("charged_failures")} (id BIGSERIAL PRIMARY KEY, slug TEXT NOT NULL, status INTEGER NOT NULL, ts BIGINT NOT NULL);
        CREATE TABLE IF NOT EXISTS ${T("daily_calls")} (day TEXT NOT NULL, method TEXT NOT NULL, n BIGINT NOT NULL, PRIMARY KEY (day, method));
        CREATE TABLE IF NOT EXISTS ${T("daily_upstream_calls")} (day TEXT NOT NULL, upstream TEXT NOT NULL, caller TEXT NOT NULL, n BIGINT NOT NULL, PRIMARY KEY (day, upstream, caller));
        CREATE TABLE IF NOT EXISTS ${T("daily_upstream_spend")} (day TEXT NOT NULL, source TEXT NOT NULL, usd_micro BIGINT NOT NULL, n BIGINT NOT NULL, PRIMARY KEY (day, source));
        CREATE TABLE IF NOT EXISTS ${T("seller_registrations")} (origin TEXT PRIMARY KEY, first_seen BIGINT NOT NULL, last_routable_seen BIGINT, last_settled_seen BIGINT);
      `).catch((e) => { tablesReady = null; throw e; });
    }
    return tablesReady;
  };

  // ---- the one-time import of the SQLite file ----
  // Read-only, every row INSERT ... ON CONFLICT DO NOTHING (two containers
  // booting at once both run it; neither can double a row), the feed and
  // failure logs keep their ids so the sequences continue past them.
  async function importSqlite() {
    if (!existsSync(file)) return { bytes: 0, rows: 0 };
    const src = new Database(file, { readonly: true, fileMustExist: true });
    const rowsOf = (sql) => { try { return src.prepare(sql).all(); } catch { return []; } }; // a table an older file lacks is empty
    let rows = 0;
    try {
      const tables = {
        counters: rowsOf("SELECT k, n FROM counters"),
        tool_counts: rowsOf("SELECT slug, n FROM tool_counts"),
        paid_tool_counts: rowsOf("SELECT slug, n FROM paid_tool_counts"),
        heartbeat_tool_counts: rowsOf("SELECT slug, n FROM heartbeat_tool_counts"),
        meta: rowsOf("SELECT k, v FROM meta"),
        recent_calls: rowsOf("SELECT id, slug, method, ts FROM recent_calls ORDER BY id"),
        charged_failures: rowsOf("SELECT id, slug, status, ts FROM charged_failures ORDER BY id"),
        daily_calls: rowsOf("SELECT day, method, n FROM daily_calls"),
        daily_upstream_calls: rowsOf("SELECT day, upstream, caller, n FROM daily_upstream_calls"),
        daily_upstream_spend: rowsOf("SELECT day, source, usd_micro, n FROM daily_upstream_spend"),
        seller_registrations: rowsOf("SELECT origin, first_seen, last_routable_seen, last_settled_seen FROM seller_registrations"),
      };
      const cols = (name, r) => ({
        counters: [["k", "text", String(r.k)], ["n", "bigint", numOrNull(r.n)]],
        tool_counts: [["slug", "text", String(r.slug)], ["n", "bigint", numOrNull(r.n)]],
        paid_tool_counts: [["slug", "text", String(r.slug)], ["n", "bigint", numOrNull(r.n)]],
        heartbeat_tool_counts: [["slug", "text", String(r.slug)], ["n", "bigint", numOrNull(r.n)]],
        meta: [["k", "text", String(r.k)], ["v", "text", String(r.v)]],
        recent_calls: [["id", "bigint", numOrNull(r.id)], ["slug", "text", String(r.slug)], ["method", "text", String(r.method)], ["ts", "bigint", numOrNull(r.ts)]],
        charged_failures: [["id", "bigint", numOrNull(r.id)], ["slug", "text", String(r.slug)], ["status", "integer", numOrNull(r.status)], ["ts", "bigint", numOrNull(r.ts)]],
        daily_calls: [["day", "text", String(r.day)], ["method", "text", String(r.method)], ["n", "bigint", numOrNull(r.n)]],
        daily_upstream_calls: [["day", "text", String(r.day)], ["upstream", "text", String(r.upstream)], ["caller", "text", String(r.caller)], ["n", "bigint", numOrNull(r.n)]],
        daily_upstream_spend: [["day", "text", String(r.day)], ["source", "text", String(r.source)], ["usd_micro", "bigint", numOrNull(r.usd_micro)], ["n", "bigint", numOrNull(r.n)]],
        seller_registrations: [["origin", "text", String(r.origin)], ["first_seen", "bigint", numOrNull(r.first_seen)], ["last_routable_seen", "bigint", numOrNull(r.last_routable_seen)], ["last_settled_seen", "bigint", numOrNull(r.last_settled_seen)]],
      })[name];
      await withStateTx(async (c) => {
        for (const name of PG_TABLES) {
          const all = tables[name];
          for (let i = 0; i < all.length; i += IMPORT_CHUNK) {
            const chunk = all.slice(i, i + IMPORT_CHUNK).map((r) => cols(name, r));
            const names = chunk[0].map((x) => x[0]);
            const types = chunk[0].map((x) => x[1]);
            const arrays = names.map((_, j) => chunk.map((row) => row[j][2]));
            const params = names.map((_, j) => `$${j + 1}::${types[j]}[]`).join(", ");
            await c.query(`INSERT INTO ${T(name)} (${names.join(", ")}) SELECT * FROM unnest(${params}) AS t(${names.join(", ")}) ON CONFLICT DO NOTHING`, arrays);
            rows += chunk.length;
          }
        }
        for (const name of ["recent_calls", "charged_failures"]) {
          await c.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), (SELECT COALESCE(MAX(id), 0) + 1 FROM ${T(name)}), false)`, [T(name)]);
        }
      });
    } finally { src.close(); }
    let bytes = 0; try { bytes = statSync(file).size; } catch { /* size is diagnostics only */ }
    say(`imported ${rows} row(s) from ${file}`);
    return { bytes, rows };
  }

  // ---- the first load ----
  async function loadMirror() {
    const q = async (name, sql) => (await stateQuery(sql.replace("%T", T(name)))).rows;
    const fresh = {
      counters: new Map((await q("counters", "SELECT k, n FROM %T")).map((r) => [r.k, Number(r.n)])),
      tools: new Map((await q("tool_counts", "SELECT slug, n FROM %T")).map((r) => [r.slug, Number(r.n)])),
      paid: new Map((await q("paid_tool_counts", "SELECT slug, n FROM %T")).map((r) => [r.slug, Number(r.n)])),
      heartbeat: new Map((await q("heartbeat_tool_counts", "SELECT slug, n FROM %T")).map((r) => [r.slug, Number(r.n)])),
      meta: new Map((await q("meta", "SELECT k, v FROM %T")).map((r) => [r.k, r.v])),
      recent: (await q("recent_calls", `SELECT slug, method, ts FROM %T ORDER BY id DESC LIMIT ${RECENT_KEEP}`)).reverse().map((r) => ({ slug: r.slug, method: r.method, ts: Number(r.ts) })),
      failures: (await q("charged_failures", `SELECT slug, status, ts FROM %T ORDER BY id DESC LIMIT ${RECENT_KEEP}`)).reverse().map((r) => ({ slug: r.slug, status: Number(r.status), ts: Number(r.ts) })),
      daily: (await q("daily_calls", "SELECT day, method, n FROM %T")).map((r) => ({ day: r.day, method: r.method, n: Number(r.n) })),
      upstream: (await q("daily_upstream_calls", "SELECT day, upstream, caller, n FROM %T")).map((r) => ({ day: r.day, upstream: r.upstream, caller: r.caller, n: Number(r.n) })),
      spend: (await q("daily_upstream_spend", "SELECT day, source, usd_micro, n FROM %T")).map((r) => ({ day: r.day, source: r.source, usd_micro: Number(r.usd_micro), n: Number(r.n) })),
      sellers: (await q("seller_registrations", "SELECT origin, first_seen, last_routable_seen, last_settled_seen FROM %T")).map((r) => ({ origin: r.origin, first_seen: Number(r.first_seen), last_routable_seen: numOrNull(r.last_routable_seen), last_settled_seen: numOrNull(r.last_settled_seen) })),
    };
    // Replace the mirror with the rows, then re-apply whatever was written
    // before the load finished (it is still pending in the delta), so an
    // early write is neither lost from the mirror nor counted twice.
    counters.clear(); toolCounts.clear(); paidCounts.clear(); heartbeatCounts.clear(); meta.clear();
    dailyCalls.clear(); upstreamCalls.clear(); spend.clear(); sellers.clear();
    for (const [k, n] of fresh.counters) counters.set(k, n);
    for (const [k, n] of fresh.tools) toolCounts.set(k, n);
    for (const [k, n] of fresh.paid) paidCounts.set(k, n);
    for (const [k, n] of fresh.heartbeat) heartbeatCounts.set(k, n);
    for (const [k, v] of fresh.meta) meta.set(k, v);
    for (const r of fresh.daily) dailyCalls.set(key2(r.day, r.method), r);
    for (const r of fresh.upstream) upstreamCalls.set(key3(r.day, r.upstream, r.caller), r);
    for (const r of fresh.spend) spend.set(key2(r.day, r.source), r);
    for (const r of fresh.sellers) sellers.set(r.origin, r);
    const pendingRecent = recent.splice(0); const pendingFailures = failures.splice(0);
    for (const r of fresh.recent) pushRing(recent, r);
    for (const r of fresh.failures) pushRing(failures, r);
    const d = delta;
    for (const [k, n] of d.counters) addTo(counters, k, n);
    for (const [k, n] of d.tools) addTo(toolCounts, k, n);
    for (const [k, n] of d.paid) addTo(paidCounts, k, n);
    for (const [k, n] of d.heartbeat) addTo(heartbeatCounts, k, n);
    for (const [k, v] of d.meta) if (!meta.has(k)) meta.set(k, v);
    for (const [k, n] of d.daily) { const [day, method] = k.split("\u0000"); (dailyCalls.get(k) || dailyCalls.set(k, { day, method, n: 0 }).get(k)).n += n; }
    for (const [k, n] of d.upstream) { const [day, upstream, caller] = k.split("\u0000"); (upstreamCalls.get(k) || upstreamCalls.set(k, { day, upstream, caller, n: 0 }).get(k)).n += n; }
    for (const [k, v] of d.spend) { const [day, source] = k.split("\u0000"); const row = spend.get(k) || spend.set(k, { day, source, usd_micro: 0, n: 0 }).get(k); row.usd_micro += v.usd_micro; row.n += v.n; }
    for (const r of pendingRecent) pushRing(recent, r);
    for (const r of pendingFailures) pushRing(failures, r);
    for (const op of d.sellerOps) mirrorSellerOp(op);
    loaded = true;
  }

  const ready = trackStoreReady((async () => {
    try {
      await ensureTables();
      await importOnce(STATS_IMPORT_NAME, { source: file, run: importSqlite });
      await loadMirror();
      stmts.setMetaIfAbsent.run("firstServed", String(Date.now()));
      lastError = null;
    } catch (e) {
      lastError = String(e?.message || e).slice(0, 160);
      say(`first load failed: ${lastError}`);
      throw e;
    }
  })());
  ready.catch(() => {}); // reported above; the server's readiness wait is bounded

  // ---- the ordered write queue ----
  // Deltas are additive, so one transaction per flush carries every write
  // made since the last one; a failed flush merges its delta back in front
  // of the newer writes and retries, so no row is dropped while the database
  // is away and nothing is counted twice when it returns.
  let flushing = null;
  let flushTimer = null;
  let retryTimer = null;
  function flushSoon() {
    if (flushTimer || flushing) return;
    flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, FLUSH_COALESCE_MS);
  }
  function mergeBack(d) {
    const cur = delta;
    const merged = newDelta();
    merged.dirty = true;
    for (const src of [d, cur]) {
      for (const [k, n] of src.counters) addTo(merged.counters, k, n);
      for (const [k, n] of src.tools) addTo(merged.tools, k, n);
      for (const [k, n] of src.paid) addTo(merged.paid, k, n);
      for (const [k, n] of src.heartbeat) addTo(merged.heartbeat, k, n);
      for (const [k, v] of src.meta) if (!merged.meta.has(k)) merged.meta.set(k, v);
      for (const [k, n] of src.daily) addTo(merged.daily, k, n);
      for (const [k, n] of src.upstream) addTo(merged.upstream, k, n);
      for (const [k, v] of src.spend) { const m = merged.spend.get(k) || merged.spend.set(k, { usd_micro: 0, n: 0 }).get(k); m.usd_micro += v.usd_micro; m.n += v.n; }
    }
    merged.recent = [...d.recent, ...cur.recent].slice(-RECENT_KEEP);
    merged.failures = [...d.failures, ...cur.failures].slice(-FAILURES_PENDING_MAX);
    merged.sellerOps = [...d.sellerOps, ...cur.sellerOps].slice(-SELLER_OPS_PENDING_MAX);
    delta = merged;
  }
  async function applyDelta(c, d) {
    const upsertN = async (table, col, map) => {
      if (!map.size) return;
      const ks = [...map.keys()], ns = ks.map((k) => map.get(k));
      await c.query(`INSERT INTO ${T(table)} (${col}, n) SELECT * FROM unnest($1::text[], $2::bigint[]) AS t(${col}, n) ON CONFLICT (${col}) DO UPDATE SET n = ${T(table)}.n + EXCLUDED.n`, [ks, ns]);
    };
    await upsertN("counters", "k", d.counters);
    await upsertN("tool_counts", "slug", d.tools);
    await upsertN("paid_tool_counts", "slug", d.paid);
    await upsertN("heartbeat_tool_counts", "slug", d.heartbeat);
    if (d.meta.size) {
      const ks = [...d.meta.keys()];
      await c.query(`INSERT INTO ${T("meta")} (k, v) SELECT * FROM unnest($1::text[], $2::text[]) AS t(k, v) ON CONFLICT (k) DO NOTHING`, [ks, ks.map((k) => d.meta.get(k))]);
    }
    if (d.recent.length) {
      await c.query(`INSERT INTO ${T("recent_calls")} (slug, method, ts) SELECT slug, method, ts FROM unnest($1::text[], $2::text[], $3::bigint[]) WITH ORDINALITY AS t(slug, method, ts, ord) ORDER BY ord`, [d.recent.map((r) => r.slug), d.recent.map((r) => r.method), d.recent.map((r) => r.ts)]);
      await c.query(`DELETE FROM ${T("recent_calls")} WHERE id <= (SELECT MAX(id) FROM ${T("recent_calls")}) - $1`, [RECENT_KEEP]);
    }
    if (d.failures.length) {
      await c.query(`INSERT INTO ${T("charged_failures")} (slug, status, ts) SELECT slug, status, ts FROM unnest($1::text[], $2::integer[], $3::bigint[]) WITH ORDINALITY AS t(slug, status, ts, ord) ORDER BY ord`, [d.failures.map((r) => r.slug), d.failures.map((r) => r.status), d.failures.map((r) => r.ts)]);
      await c.query(`DELETE FROM ${T("charged_failures")} WHERE id <= (SELECT MAX(id) FROM ${T("charged_failures")}) - $1`, [RECENT_KEEP]);
    }
    if (d.daily.size) {
      const ks = [...d.daily.keys()].map((k) => k.split("\u0000"));
      await c.query(`INSERT INTO ${T("daily_calls")} (day, method, n) SELECT * FROM unnest($1::text[], $2::text[], $3::bigint[]) AS t(day, method, n) ON CONFLICT (day, method) DO UPDATE SET n = ${T("daily_calls")}.n + EXCLUDED.n`, [ks.map((k) => k[0]), ks.map((k) => k[1]), [...d.daily.values()]]);
    }
    if (d.upstream.size) {
      const ks = [...d.upstream.keys()].map((k) => k.split("\u0000"));
      await c.query(`INSERT INTO ${T("daily_upstream_calls")} (day, upstream, caller, n) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[]) AS t(day, upstream, caller, n) ON CONFLICT (day, upstream, caller) DO UPDATE SET n = ${T("daily_upstream_calls")}.n + EXCLUDED.n`, [ks.map((k) => k[0]), ks.map((k) => k[1]), ks.map((k) => k[2]), [...d.upstream.values()]]);
    }
    if (d.spend.size) {
      const ks = [...d.spend.keys()].map((k) => k.split("\u0000"));
      const vs = [...d.spend.values()];
      await c.query(`INSERT INTO ${T("daily_upstream_spend")} (day, source, usd_micro, n) SELECT * FROM unnest($1::text[], $2::text[], $3::bigint[], $4::bigint[]) AS t(day, source, usd_micro, n) ON CONFLICT (day, source) DO UPDATE SET usd_micro = ${T("daily_upstream_spend")}.usd_micro + EXCLUDED.usd_micro, n = ${T("daily_upstream_spend")}.n + EXCLUDED.n`, [ks.map((k) => k[0]), ks.map((k) => k[1]), vs.map((v) => v.usd_micro), vs.map((v) => v.n)]);
    }
    for (const op of d.sellerOps) {
      if (op.kind === "seen") {
        await c.query(`INSERT INTO ${T("seller_registrations")} (origin, first_seen, last_routable_seen, last_settled_seen) VALUES ($1, $2, $2, $3)
          ON CONFLICT (origin) DO UPDATE SET last_routable_seen = EXCLUDED.last_routable_seen, last_settled_seen = COALESCE(EXCLUDED.last_settled_seen, ${T("seller_registrations")}.last_settled_seen)`, [op.origin, op.now, op.settledAt]);
      } else if (op.kind === "backdate") {
        await c.query(`UPDATE ${T("seller_registrations")} SET first_seen = LEAST(first_seen, $1::bigint) WHERE origin = $2`, [op.prior, op.origin]);
      } else if (op.kind === "ensure") {
        await c.query(`INSERT INTO ${T("seller_registrations")} (origin, first_seen, last_routable_seen, last_settled_seen) VALUES ($1, $2, NULL, NULL) ON CONFLICT (origin) DO NOTHING`, [op.origin, op.now]);
      } else if (op.kind === "delete") {
        await c.query(`DELETE FROM ${T("seller_registrations")} WHERE origin = $1`, [op.origin]);
      }
    }
  }
  function flush() {
    if (flushing) return flushing;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushing = (async () => {
      try { await ready; } catch { /* the first load failed; the tables exist or the write fails below */ }
      let okAll = true;
      while (delta.dirty) {
        const d = delta; delta = newDelta();
        try { await withStateTx((c) => applyDelta(c, d)); lastError = null; }
        catch (e) {
          okAll = false;
          lastError = String(e?.message || e).slice(0, 160);
          say(`write failed, kept for retry: ${lastError}`);
          mergeBack(d);
          if (!retryTimer) { retryTimer = setTimeout(() => { retryTimer = null; void flush(); }, FLUSH_RETRY_MS); retryTimer.unref?.(); }
          break;
        }
      }
      flushing = null;
      return okAll;
    })();
    return flushing;
  }

  const byN = (a, b) => b.n - a.n || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  const by2 = (f, g) => (a, b) => (a[f] < b[f] ? -1 : a[f] > b[f] ? 1 : a[g] < b[g] ? -1 : a[g] > b[g] ? 1 : 0);
  const tail = (ring, limit) => { const n = Number(limit); return n > 0 ? ring.slice(-n).reverse().map((r) => ({ ...r })) : []; };

  return {
    backend: "pg",
    ready,
    flush,
    recordCall,
    recordFailure,
    bumpUpstream: (day, upstream, caller) => stmts.bumpUpstream.run(day, upstream, caller),
    bumpSpend: (day, source, micro) => stmts.bumpSpend.run(day, source, micro),
    sellerSeen(origin, now, settledAt, prior) {
      sellerOp({ kind: "seen", origin, now, settledAt });
      if (prior) sellerOp({ kind: "backdate", origin, prior });
    },
    sellerEnsure(origin, now) { const added = !sellers.has(origin); sellerOp({ kind: "ensure", origin, now }); return added; },
    sellerDelete(origin) { const had = sellers.has(origin); sellerOp({ kind: "delete", origin }); return had; },
    sellerFirstSeen: (origin) => sellers.get(origin)?.first_seen ?? null,
    sellerRegistrations: () => [...sellers.values()].map((r) => ({ ...r })).sort((a, b) => b.first_seen - a.first_seen),
    counter: (k) => counters.get(k) ?? 0,
    usdcNetCounters: () => [...counters].filter(([k]) => k.startsWith("usdcNet:")).map(([k, n]) => ({ k, n })),
    topTools: () => [...toolCounts].map(([slug, n]) => ({ slug, n })).sort(byN).slice(0, TOP_TOOLS_SHOW),
    toolsFull: () => [...toolCounts].map(([slug, n]) => ({ slug, n })).sort(byN),
    toolsWithCalls: () => toolCounts.size,
    paidAll: () => [...paidCounts].map(([slug, n]) => ({ slug, n })),
    heartbeatAll: () => [...heartbeatCounts].map(([slug, n]) => ({ slug, n })),
    meta: (k) => meta.get(k) ?? null,
    recent: (limit) => tail(recent, limit),
    recentAll: (limit) => tail(recent, limit),
    chargedFailures: (limit) => tail(failures, limit),
    chargedFailuresRetained: () => failures.length,
    chargedFailuresGenuine: () => failures.filter((r) => r.status !== 402).length,
    chargedFailuresGenuineSince: (since) => failures.filter((r) => r.status !== 402 && r.ts >= since).length,
    dailyCalls: () => [...dailyCalls.values()].map((r) => ({ ...r })).sort(by2("day", "method")),
    dailyUpstreamSpend: () => [...spend.values()].map((r) => ({ ...r })).sort(by2("day", "source")),
    dailyUpstreamCalls: (upstream) => [...upstreamCalls.values()].filter((r) => r.upstream === upstream).map((r) => ({ day: r.day, caller: r.caller, n: r.n })).sort(by2("day", "caller")),
    // No synchronous probe exists on this backend: healthy once the first
    // load landed and while the last write did too.
    healthy: () => loaded && lastError === null,
  };
}

const S = USE_PG ? openPg(DB_FILE) : openSqlite(DB_FILE);
/** "sqlite" or "pg": which backend holds the tally. */
export const statsBackend = S.backend;
/** Resolves once every queued write has landed (a no-op on SQLite). Tests and shutdown. */
export function statsFlush() { return S.flush(); }
/** Resolves once the first load (and the one-time import) has finished. */
export function statsReady() { return S.ready; }

/** When we first saw this origin register, or null. */
export function sellerRegistrationFirstSeen(origin) {
  try { return S.sellerFirstSeen(origin); } catch { return null; }
}

/**
 * Record that a self-serve-registered origin (from POST /api/index/register)
 * answered a live probe this cycle — called once at registration and again on
 * every periodic crawl tick the origin stays routable. first_seen is set only
 * on the row's first insert (immutable); last_routable_seen always advances to
 * now; last_settled_seen advances only when `settled` is true this call and is
 * never erased by a later call that didn't observe a settlement.
 */
export function recordSellerRegistrationSeen(origin, { settled = false, inheritFirstSeenFrom = null } = {}) {
  const now = Date.now();
  try {
    // SUCCESSION. A seller moving off a throwaway host (a *.workers.dev or a
    // preview URL) to a permanent domain had no way to keep the one thing the
    // move costs them: how long we have known them. Their settlement evidence
    // needs no migrating - it is keyed by payTo and follows the wallet, not the
    // origin - and the old origin drops out of the routable set on its own once
    // it stops answering. But first_seen is origin-keyed, so re-registering
    // reset a seller who has been listed for months to "new today".
    //
    // Only ever moves the date BACKWARD (MIN), so a succession claim can never
    // make an origin look newer or younger than it is, and it is recorded on
    // the new row alone: the predecessor is untouched, never demoted, never
    // deleted. Demotion stays the honest way - the old origin stops responding
    // and ages out - because a register call that could retire another seller's
    // listing is a weapon, whatever proof is attached to it.
    // ONE mechanism, not two: insert at `now` as always, then pull the date
    // back. Setting the inherited value on the INSERT as well was redundant
    // (the row may already exist, so the UPDATE has to handle it anyway) and
    // redundancy here is worse than useless - it made a mutation of either
    // path survive, so the test could not tell whether the rule worked.
    const prior = inheritFirstSeenFrom ? sellerRegistrationFirstSeen(inheritFirstSeenFrom) : null;
    S.sellerSeen(origin, now, settled ? now : null, prior);
  } catch {
    /* best-effort — never break the crawl/registration path over telemetry */
  }
}

/** Ensure a registration row exists for each origin; returns how many were added. */
export function ensureSellerRegistrations(origins) {
  let added = 0;
  try { const now = Date.now(); for (const o of origins) if (S.sellerEnsure(String(o), now)) added++; } catch { /* telemetry, never break the crawl */ }
  return added;
}

/** Forget one origin's registration row (operator removal only). */
export function deleteSellerRegistration(origin) {
  try { return S.sellerDelete(String(origin || "")); } catch { return false; }
}

/** Every self-serve registration with its conversion/churn timestamps, newest first. */
export function getSellerRegistrations() {
  try {
    return S.sellerRegistrations();
  } catch {
    return [];
  }
}

const bootedAt = Date.now();

/** Count one successfully served paid-tool call. method: "usdc" | "pow" | "heartbeat".
 *  network (usdc only): short chain name from the settle receipt, e.g. "base" | "solana".
 *  wire (usdc only): "mpp" when the credential arrived as MPP Authorization:
 *  Payment (translated by the shim); anything else counts as plain x402. */
export function recordServedCall(slug, method, network = null, wire = null, { internal = false } = {}) {
  try {
    S.recordCall(slug, method, network, wire, internal);
  } catch {
    /* counters are best-effort; never break a response */
  }
}

// CAIP-2 → the short names used across /api/pricing and PAYMENT_NETWORKS.
export const CAIP2_NAMES = {
  "eip155:8453": "base",
  "eip155:137": "polygon",
  "eip155:42161": "arbitrum",
  "eip155:84532": "base-sepolia",
  "eip155:42220": "celo",
  "eip155:43114": "avalanche",
  "eip155:143": "monad",
  // Settles USDG (Global Dollar), not USDC — shows up as its own bucket in
  // viaUSDCByNetwork so the per-rail split separates the two stablecoins.
  "eip155:4663": "robinhood (USDG)",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "solana",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "solana-devnet",
  "stellar:pubnet": "stellar",
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=": "algorand",
  // Added 2026-08-02. Both rails shipped without an entry here, so every
  // settlement on them was booked under its raw CAIP-2 id and shown that way
  // on the PUBLIC /api/stats - "eip155:10" instead of "optimism". Nothing was
  // lost, but per-chain revenue read low for both because the named bucket and
  // the id bucket are different counters. scripts/test-chain-names.js now
  // fails if an offered rail has no entry, so a thirteenth cannot repeat it.
  "eip155:1329": "sei",
  "eip155:10": "optimism",
};

/** Fold a raw CAIP-2 counter key into its friendly name.
 *
 *  Counters recorded BEFORE a chain was added to CAIP2_NAMES keep their raw
 *  key forever, so the same chain appears twice on /api/stats: monad 19 next
 *  to eip155:143 42, celo 35 next to eip155:42220 16. Both are that chain.
 *  Serving them separately understates every affected rail and invites the
 *  reader to treat one row as the whole story.
 *
 *  Applied at READ time rather than by rewriting history: the stored counters
 *  stay exactly as recorded, and the merge is a presentation rule anyone can
 *  check against CAIP2_NAMES. */
/** Settlements the per-network split can actually attribute (its own sum). */
function usdcAttributed() {
  return S.usdcNetCounters().reduce((a, r) => a + (r.n || 0), 0);
}

export function mergeNetworkCounters(entries) {
  const out = new Map();
  for (const [key, n] of entries) {
    const name = CAIP2_NAMES[key] || key;
    out.set(name, (out.get(name) || 0) + n);
  }
  return Object.fromEntries([...out.entries()].sort((a, b) => b[1] - a[1]));
}

/** The CAIP-2 ids we can name, for the coverage guard. */
export const KNOWN_CAIP2 = Object.freeze({ ...CAIP2_NAMES });

/**
 * Decode the settle-receipt header (PAYMENT-RESPONSE in x402 v2,
 * X-PAYMENT-RESPONSE in v1) into its JSON object, or null.
 *
 * SEMANTICS THAT MATTER (verified against @x402/core, 2026-07-16): the
 * middleware attaches this header to settle FAILURES too — a facilitator
 * rejection produces a 402 whose receipt is { success:false, errorReason, … }.
 * So the header's PRESENCE never proves the buyer was charged; only the
 * receipt's `success` field does. Pure and defensive: any shape surprise →
 * null, never a throw (this runs in the tally middleware on every response).
 */
export function decodeSettleReceipt(headerValue) {
  if (typeof headerValue !== "string" || !headerValue) return null;
  try {
    const receipt = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
    return receipt && typeof receipt === "object" && !Array.isArray(receipt) ? receipt : null;
  } catch {
    return null;
  }
}

/**
 * Which chain a settled x402 call was paid on, from the settle receipt:
 * `network` is CAIP-2 in v2, a short name in v1. Same defensive contract as
 * the decoder above.
 */
export function networkFromPaymentResponse(headerValue) {
  const net = decodeSettleReceipt(headerValue)?.network;
  if (typeof net !== "string" || !net) return null;
  return CAIP2_NAMES[net] || net;
}

// Genuine charged failures (a settled payment answered with an error; 402 rows
// are settlement refusals where the buyer kept their money) since `sinceMs`.
// Null when the store cannot be read, so a caller never reads "none" from a
// broken query.
export function chargedFailuresGenuineSince(sinceMs) {
  try { return S.chargedFailuresGenuineSince(Math.floor(Number(sinceMs) || 0)); } catch { return null; }
}

/**
 * Record a charged failure (see chargedFailureWriter). On SQLite the row is
 * written before this returns (undefined). With the state database on, the
 * row is queued and flushed at once, and the returned promise resolves true
 * once it has landed (false when the write is being retried).
 */
export function recordChargedFailure(slug, status) {
  try {
    S.recordFailure(slug, status);
  } catch {
    /* best-effort */
    return undefined;
  }
  return S.backend === "pg" ? S.flush() : undefined;
}

/**
 * Lightweight DB liveness probe for /health. Reads the cheapest possible
 * statement (PK lookup on a tiny table) and returns true on success. Never
 * throws — the caller decides what status code to return. With the state
 * database on it reports whether the first load landed and the last write did.
 */
export function dbHealthy() {
  try {
    return S.healthy();
  } catch {
    return false;
  }
}

export function getStats({ wallet, walletName, network, toolCount, baseUrl, prices }) {
  const num = (k) => S.counter(k);
  const priceOf = (slug) => (prices && Number(prices[slug])) || 0;
  const estimatedRevenueUsd = +S.paidAll().reduce((s, r) => s + r.n * priceOf(r.slug), 0).toFixed(4);
  const firstServed = parseInt(S.meta("firstServed") ?? Date.now(), 10);
  const explorer = network === "base-sepolia" ? "https://sepolia.basescan.org" : "https://basescan.org";
  return {
    service: "Agent402.Tools",
    summary: "A live node in the machine-to-machine economy: autonomous agents pay per call in USDC (or with compute) and get the result - no human, no signup.",
    tools: toolCount,
    payment: { protocol: "x402", network, currency: "USDC" },
    wallet,
    walletName: walletName || null,
    onchainRevenueProof: wallet ? `${explorer}/address/${wallet}#tokentxns` : null,
    onchainNote: "Settled revenue is verifiable on-chain at the wallet above - that is the trustless source of truth, not this counter.",
    toolCallsServed: {
      total: num("total"),
      viaUSDC: num("viaUSDC"),
      // USDC split by settlement chain (from the x402 settle receipt). "unknown"
      // = counted before this split existed. Answers "has anyone ever paid on
      // Solana/Polygon/…" without an explorer scan per chain.
      viaUSDCByNetwork: mergeNetworkCounters(S.usdcNetCounters().map((r) => [r.k.slice("usdcNet:".length), r.n])),
      // The two figures above do not add up and a reader should not have to
      // guess why: viaUSDC is a LIFETIME counter that predates the per-network
      // one. Measured 2026-08-28: 30,542 vs 16,372 attributed, only 33 of the
      // difference in "unknown" - the rest is simply older than the split. An
      // outside reviewer read the unlabelled 14k gap as a data error, which is
      // the right instinct. attributed + beforeNetworkCounter === viaUSDC.
      viaUSDCAttributed: usdcAttributed(),
      viaUSDCBeforeNetworkCounter: Math.max(0, num("viaUSDC") - usdcAttributed()),
      viaUSDCByNetworkNote: "viaUSDC is a lifetime counter; the per-network split begins when that counter shipped, so viaUSDCAttributed + viaUSDCBeforeNetworkCounter = viaUSDC",
      viaProofOfWork: num("viaProofOfWork"),
      viaTrial: num("viaTrial"), // one-per-tool-per-IP-per-hour wallet-free trials — free, never revenue
      viaHeartbeat: num("viaHeartbeat"), // internal probe traffic (PoW path, agent402-heartbeat UA)
      // Subset of viaUSDC whose credential arrived over the MPP wire
      // (Authorization: Payment, translated by src/mpp-shim.js) instead of
      // x402's PAYMENT-SIGNATURE. The MPP-adoption signal.
      viaMPPWire: num("viaMPPWire"),
      // Settled calls paid by OUR OWN wallets (daily canary, Tempo volume
      // runner): on-chain, but not external demand - kept out of viaUSDC,
      // viaMPPWire and the per-chain split above, shown here for transparency.
      viaUSDCInternal: num("viaUSDCInternal"),
      viaMPPWireInternal: num("viaMPPWireInternal"),
      // Subset of viaUSDC that came through the router (route-execute*) -
      // the only paid calls Agent402 earns a margin on. Pages render the
      // "how we earn" disclosure line only when this is present (it wasn't,
      // before this field existed) rather than guessing a value.
      viaRouter: num("viaRouter"),
    },
    // Charged on-chain but handler returned non-200 — should always be 0. Any
    // value here means we billed the buyer and gave them an error. The dashboard
    // and a daily CI check both alert when this is nonzero.
    //
    // PUBLISHED WITH ITS DEFECT NAMED. This lifetime counter is polluted: before
    // the fix, a settlement REJECTION (facilitator declines, buyer keeps their
    // money, we get a 402) was recorded here as if we had charged and failed.
    // Every one of the 200 retained events is a 402, and there has been none
    // since the fix. So the raw number reads as a ~6.7% "took payment, delivered
    // nothing" rate against viaUSDC, and that rate is false.
    //
    // We could not un-pollute it — the pre-fix events carry no marker — so the
    // honest move is to publish the number that IS meaningful beside it and say
    // plainly which is which. Quoting the lifetime figure as current quality
    // would be exactly the self-reported-metric problem we criticise elsewhere.
    chargedButFailed: num("chargedButFailedTotal"),
    // Genuine charged failures in the retained event log: a 402 there means the
    // buyer was never charged, so it is excluded. THIS is the reliability
    // number; the lifetime counter above is not.
    //
    // IT IS A WINDOW, AND IT SAYS SO. `charged_failures` is pruned to
    // RECENT_KEEP rows and read back under a LIMIT, so this is "genuine
    // failures among the most recent RECENT_KEEP charged-failure events", it
    // can never report more than RECENT_KEEP however many there were, and it
    // is NOT a lifetime figure - which is exactly what a reader takes it for
    // when it is published as a bare 0 beside a lifetime counter and the note
    // calls it "current quality". Same shape as the LIMIT-20 query whose
    // .length was once published as a tool count and drove a retirement: the
    // number was right and its contract was quiet. The scope now travels with
    // it, and test-capped-counts.js pins that it does.
    chargedButFailedGenuine: chargedFailuresGenuine(),
    chargedButFailedGenuineScope: {
      of: "the most recent charged-failure events retained on disk, not all time",
      eventsRetained: chargedFailuresRetained(),
      eventsRetainedMax: RECENT_KEEP,
      // The ceiling this figure can never exceed, said outright.
      maxReportable: RECENT_KEEP,
    },
    chargedButFailedNote:
      `chargedButFailed is a LIFETIME counter containing a since-fixed miscount: settlement REJECTIONS (buyer keeps their money) were recorded as charged failures. Use chargedButFailedGenuine for current quality - it excludes them, but it is a WINDOW over the most recent ${RECENT_KEEP} retained charged-failure events (see chargedButFailedGenuineScope), never a lifetime count.`,
    // topTools ranks by RAW CALL VOLUME (free + paid combined, from allTools),
    // never by purchases alone - a "topPaidTools" purchase-count ranking used
    // to be published right beside it (found externally 2026-08-14). Stripping
    // that field to counts-only (no dollar figures) was NOT the fix it looked
    // like: /api/pricing is public, so purchases × price reconstructs exact
    // per-tool revenue anyway, and even without that math the ranking itself
    // is a "which tools to clone" signal - the same class of leak /api/sales
    // was reduced to stop giving away. The full per-tool breakdown (paid
    // count, revenue, price) stays operator-only via getOperatorBreakdown.
    topTools: S.topTools(),
    // A ranking is not a catalog, and the cut has to be readable: `topTools`
    // is the head of a list this endpoint never returns in full.
    topToolsScope: { rankedBy: "raw call volume, free and paid combined", limit: TOP_TOOLS_SHOW, toolsWithAnyCalls: toolsWithCalls() },
    estimatedRevenueUsd, // sum of price × USDC-purchase count (counters; chain is source of truth)
    // Priced at TODAY's catalog price, not at what each call actually sold
    // for: tools have been repriced repeatedly (78 of them in one pass), a
    // retired tool's purchases lose their price entirely, and this counts
    // USDC purchases only - never card, credits or Tempo. The settled figures
    // on /api/revenue are the ones drawn from what was actually charged.
    estimatedRevenueNote:
      "An estimate, not a ledger: lifetime USDC-purchase counts valued at TODAY's catalog price (tools are repriced, and a retired tool's purchases value at zero). Card, prepaid-credits and Tempo sales are not in it. Use /api/revenue for settled amounts.",
    recentCalls: S.recent(RECENT_SHOW).map((r) => ({
      slug: r.slug,
      paidWith: r.method === "pow" ? "proof-of-work" : r.method === "heartbeat" ? "heartbeat" : "usdc",
      at: new Date(r.ts).toISOString(),
    })),
    // The newest RECENT_SHOW of RECENT_KEEP retained rows - a live feed, never
    // the period's traffic. Stated because the rows carry no total of their own.
    recentCallsScope: { shown: RECENT_SHOW, retainedMax: RECENT_KEEP, of: "the newest served calls retained on disk, not a period total" },
    servingSince: new Date(firstServed).toISOString(),
    // NOT service-availability uptime - resets to 0 on every deploy. Named
    // processUptimeSeconds (not uptimeSeconds) specifically so it can't be
    // misread as a reliability claim: /api/reliability sits this right next
    // to servingSince (a real ~2-month figure), and an agent parsing field
    // names alone would otherwise derive ~0.02% uptime from a service that's
    // actually 99.8-100% up (found in an internal audit, 2026-08-16).
    processUptimeSeconds: Math.floor((Date.now() - bootedAt) / 1000),
    runTheDemo: `${baseUrl}/llms.txt`,
  };
}

// TRUE counts for the two capped lists in getStats, so neither is ever the
// only number a reader has. Uncapped by construction: a COUNT, never a length
// of a LIMITed page.
const toolsWithCalls = () => { try { return S.toolsWithCalls(); } catch { return 0; } };
const chargedFailuresRetained = () => { try { return S.chargedFailuresRetained(); } catch { return 0; } };
const chargedFailuresGenuine = () => { try { return S.chargedFailuresGenuine(); } catch { return 0; } };

/**
 * Daily served-call counts by settlement method, oldest first.
 * [{ day: "2026-07-26", usdc: 812, pow: 143, heartbeat: 96 }]
 *
 * Recording starts the day this table ships — earlier days genuinely have no
 * per-day record (recent_calls is pruned to 200 rows and the counters are
 * lifetime-only), so the series must never imply zero free-tier usage before
 * then. Callers get `recordingSince` to label that honestly.
 */
export function getDailyCalls() {
  const byDay = new Map();
  for (const r of S.dailyCalls()) {
    const d = byDay.get(r.day) || { day: r.day, usdc: 0, pow: 0, heartbeat: 0 };
    if (r.method === "pow" || r.method === "heartbeat" || r.method === "usdc") d[r.method] = r.n;
    byDay.set(r.day, d);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * Record one outbound call to a paid upstream (e.g. "brave"), day-bucketed in
 * UTC like daily_calls. Best-effort: metering must never break serving.
 */
export function recordUpstreamCall(upstream, caller = "unknown") {
  try {
    S.bumpUpstream(today(), String(upstream), String(caller));
  } catch {
    /* best-effort */
  }
}

/**
 * Record one unit of upstream SPEND in dollars (e.g. an OpenRouter call's
 * measured cost, an x402 buy's settled quote), day-bucketed in UTC. Integer
 * micro-dollars so sums stay exact. Best-effort - metering must never break
 * serving - and recorded server-side on purpose: PostHog-only cost telemetry
 * is how a real OpenRouter day once read as near zero (a keyless local boot has
 * no PostHog; this table records whenever the process serves).
 * On SQLite the row is written before this returns (undefined). With the
 * state database on, the row is queued and flushed at once, and the returned
 * promise resolves true once it has landed.
 */
export function recordUpstreamSpend(source, usd) {
  try {
    const micro = Math.round(Number(usd) * 1e6);
    if (!Number.isFinite(micro) || micro <= 0) return undefined;
    S.bumpSpend(today(), String(source), micro);
  } catch {
    /* best-effort */
    return undefined;
  }
  return S.backend === "pg" ? S.flush() : undefined;
}

/** Day-bucketed upstream-spend rows: [{day, source, usd_micro, n}]. */
export function getDailyUpstreamSpend() {
  try {
    return S.dailyUpstreamSpend();
  } catch {
    return [];
  }
}

/** Day-bucketed outbound-call rows for one upstream: [{day, caller, n}]. */
export function getDailyUpstreamCalls(upstream) {
  try {
    return S.dailyUpstreamCalls(String(upstream));
  } catch {
    return [];
  }
}

/** First day the daily tally recorded anything, or null before the first call. */
export function dailyCallsRecordingSince() {
  const rows = S.dailyCalls();
  return rows.length ? rows.reduce((m, r) => (r.day < m ? r.day : m), rows[0].day) : null;
}

/**
 * Full per-tool breakdown for the operator dashboard — every tool that's ever
 * been served, USDC purchases per tool, estimated revenue per tool, and the
 * full retained recent-calls log. Pricing comes from the catalog at the call
 * site so this module stays decoupled from CATALOG. Operator-only — gated by
 * AGENT402_OPERATOR_TOKEN at the route layer.
 */
export function getOperatorBreakdown({ prices, walletOnlySet, limit = RECENT_KEEP, offeredNetworks = [] } = {}) {
  const priceOf = (slug) => (prices && Number(prices[slug])) || 0;
  const isWalletOnly = (slug) => !!(walletOnlySet && walletOnlySet.has && walletOnlySet.has(slug));
  const paidBySlug = new Map(S.paidAll().map((r) => [r.slug, r.n]));
  const heartbeatBySlug = new Map(S.heartbeatAll().map((r) => [r.slug, r.n]));
  const tools = S.toolsFull().map((r) => {
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
  const viaUSDCByNetwork = mergeNetworkCounters(S.usdcNetCounters().map((r) => [r.k.slice("usdcNet:".length), r.n]));
  // RECONCILIATION, because the two figures do not add up and a reader should
  // not have to guess why: `viaUSDC` is a lifetime counter that predates the
  // per-network one, so the split only covers settlements since that counter
  // shipped. Measured 2026-08-28: 30,542 vs 16,372, with just 33 in "unknown"
  // - the other 14,170 are simply older than the attribution. An outside
  // reviewer read the gap as a data error, which is the right instinct about
  // an unlabelled 14k discrepancy.
  const viaUSDCAttributed = Object.values(viaUSDCByNetwork).reduce((a, b) => a + b, 0);
  // Offered rails vs settled rails: viaUSDCByNetwork only ever carries a key
  // for a rail that has settled at least once — a rail with zero settlements
  // has no key at all, so it's invisible by omission rather than flagged.
  // offeredNetworks (the caller's enabledNetworks(NETWORK) list) turns that
  // silence into an explicit zero-settled-revenue row an operator can act on
  // — keep maintaining the rail's facilitator config/canary legs, or drop it.
  const railKey = (n) => (n === "robinhood" ? "robinhood (USDG)" : n);
  const railBreakdown = offeredNetworks.map((n) => ({
    network: n,
    settledCalls: viaUSDCByNetwork[railKey(n)] || 0,
  }));
  return {
    totals: {
      total: S.counter("total"),
      viaUSDC: S.counter("viaUSDC"),
      viaUSDCAttributed,
      viaUSDCBeforeNetworkCounter: Math.max(0, S.counter("viaUSDC") - viaUSDCAttributed),
      viaUSDCByNetworkNote: "viaUSDC is a lifetime counter; the per-network split starts when that counter shipped, so viaUSDCAttributed + viaUSDCBeforeNetworkCounter = viaUSDC",
      viaUSDCByNetwork,
      viaProofOfWork: S.counter("viaProofOfWork"),
      viaTrial: S.counter("viaTrial"),
      viaHeartbeat: S.counter("viaHeartbeat"),
      estimatedRevenueUsd: +tools.reduce((s, t) => s + t.revenueUsd, 0).toFixed(4),
      toolsServed: tools.length,
      chargedButFailed: S.counter("chargedButFailedTotal"),
    },
    railBreakdown,
    tools,
    recentCalls: S.recentAll(limit).map((r) => ({
      slug: r.slug,
      paidWith: r.method === "pow" ? "proof-of-work" : r.method === "heartbeat" ? "heartbeat" : "usdc",
      at: new Date(r.ts).toISOString(),
    })),
    chargedFailures: S.chargedFailures(limit).map((r) => ({
      slug: r.slug,
      status: r.status,
      at: new Date(r.ts).toISOString(),
    })),
    bootedAt: new Date(bootedAt).toISOString(),
    processUptimeSeconds: Math.floor((Date.now() - bootedAt) / 1000), // see the public getStats() comment above - same rename, same reason
  };
}
