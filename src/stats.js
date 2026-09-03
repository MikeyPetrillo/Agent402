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

const RECENT_KEEP = 200; // rows retained
const RECENT_SHOW = 25;  // rows exposed in /api/stats

// The router-execute tiers: the only catalog slugs Agent402 earns a margin
// on (every other paid call is buyer wallet straight to seller wallet).
const ROUTER_SLUGS = new Set(["route-execute", "route-execute-plus", "route-execute-max", "route-execute-pro"]);

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
const upsertSellerRegistration = db.prepare(`
  INSERT INTO seller_registrations (origin, first_seen, last_routable_seen, last_settled_seen)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(origin) DO UPDATE SET
    last_routable_seen = excluded.last_routable_seen,
    last_settled_seen = COALESCE(excluded.last_settled_seen, last_settled_seen)
`);
const allSellerRegistrations = db.prepare("SELECT origin, first_seen, last_routable_seen, last_settled_seen FROM seller_registrations ORDER BY first_seen DESC");

/**
 * Record that a self-serve-registered origin (from POST /api/index/register)
 * answered a live probe this cycle — called once at registration and again on
 * every periodic crawl tick the origin stays routable. first_seen is set only
 * on the row's first insert (immutable); last_routable_seen always advances to
 * now; last_settled_seen advances only when `settled` is true this call and is
 * never erased by a later call that didn't observe a settlement.
 */
export function recordSellerRegistrationSeen(origin, { settled = false } = {}) {
  const now = Date.now();
  try {
    upsertSellerRegistration.run(origin, now, now, settled ? now : null);
  } catch {
    /* best-effort — never break the crawl/registration path over telemetry */
  }
}

/** Every self-serve registration with its conversion/churn timestamps, newest first. */
export function getSellerRegistrations() {
  try {
    return allSellerRegistrations.all();
  } catch {
    return [];
  }
}

setMetaIfAbsent.run("firstServed", String(Date.now()));
const bootedAt = Date.now();

const recordCall = db.transaction((slug, method, network, wire, internal = false) => {
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
    bumpDaily.run(new Date().toISOString().slice(0, 10), "heartbeat");
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
    new Date().toISOString().slice(0, 10),
    method === "pow" ? "pow" : method === "heartbeat" ? "heartbeat" : method === "trial" ? "trial" : "usdc"
  );
  setMetaIfAbsent.run("firstServed", String(Date.now()));
});

/** Count one successfully served paid-tool call. method: "usdc" | "pow" | "heartbeat".
 *  network (usdc only): short chain name from the settle receipt, e.g. "base" | "solana".
 *  wire (usdc only): "mpp" when the credential arrived as MPP Authorization:
 *  Payment (translated by the shim); anything else counts as plain x402. */
export function recordServedCall(slug, method, network = null, wire = null, { internal = false } = {}) {
  try {
    recordCall(slug, method, network, wire, internal);
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
  return usdcNetCounters.all().reduce((a, r) => a + (r.n || 0), 0);
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
  const firstServed = parseInt(getMeta.get("firstServed")?.v ?? Date.now(), 10);
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
      viaUSDCByNetwork: mergeNetworkCounters(usdcNetCounters.all().map((r) => [r.k.slice("usdcNet:".length), r.n])),
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
    chargedButFailedGenuine: (getChargedFailures.all(RECENT_KEEP) || [])
      .filter((r) => Number(r.status) !== 402).length,
    chargedButFailedNote:
      "chargedButFailed is a LIFETIME counter containing a since-fixed miscount: settlement REJECTIONS (buyer keeps their money) were recorded as charged failures. Use chargedButFailedGenuine, which excludes them, for current quality.",
    // topTools ranks by RAW CALL VOLUME (free + paid combined, from allTools),
    // never by purchases alone - a "topPaidTools" purchase-count ranking used
    // to be published right beside it (found externally 2026-08-14). Stripping
    // that field to counts-only (no dollar figures) was NOT the fix it looked
    // like: /api/pricing is public, so purchases × price reconstructs exact
    // per-tool revenue anyway, and even without that math the ranking itself
    // is a "which tools to clone" signal - the same class of leak /api/sales
    // was reduced to stop giving away. The full per-tool breakdown (paid
    // count, revenue, price) stays operator-only via getOperatorBreakdown.
    topTools: allTools.all(),
    estimatedRevenueUsd, // sum of price × USDC-purchase count (counters; chain is source of truth)
    recentCalls: getRecent.all(RECENT_SHOW).map((r) => ({
      slug: r.slug,
      paidWith: r.method === "pow" ? "proof-of-work" : r.method === "heartbeat" ? "heartbeat" : "usdc",
      at: new Date(r.ts).toISOString(),
    })),
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
  for (const r of allDaily.all()) {
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
    bumpUpstream.run(new Date().toISOString().slice(0, 10), String(upstream), String(caller));
  } catch {
    /* best-effort */
  }
}

/**
 * Record one unit of upstream SPEND in dollars (e.g. an OpenRouter call's
 * measured cost, an x402 buy's settled quote), day-bucketed in UTC. Integer
 * micro-dollars so sums stay exact. Best-effort - metering must never break
 * serving - and recorded server-side on purpose: PostHog-only cost telemetry
 * is how an $11 OpenRouter day once read as $0.03 (a keyless local boot has
 * no PostHog; this table records whenever the process serves).
 */
export function recordUpstreamSpend(source, usd) {
  try {
    const micro = Math.round(Number(usd) * 1e6);
    if (!Number.isFinite(micro) || micro <= 0) return;
    bumpSpend.run(new Date().toISOString().slice(0, 10), String(source), micro);
  } catch {
    /* best-effort */
  }
}

/** Day-bucketed upstream-spend rows: [{day, source, usd_micro, n}]. */
export function getDailyUpstreamSpend() {
  try {
    return dailySpend.all();
  } catch {
    return [];
  }
}

/** Day-bucketed outbound-call rows for one upstream: [{day, caller, n}]. */
export function getDailyUpstreamCalls(upstream) {
  try {
    return dailyUpstream.all(String(upstream));
  } catch {
    return [];
  }
}

/** First day the daily tally recorded anything, or null before the first call. */
export function dailyCallsRecordingSince() {
  const rows = allDaily.all();
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
  const viaUSDCByNetwork = mergeNetworkCounters(usdcNetCounters.all().map((r) => [r.k.slice("usdcNet:".length), r.n]));
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
      total: getCounter.get("total")?.n ?? 0,
      viaUSDC: getCounter.get("viaUSDC")?.n ?? 0,
      viaUSDCAttributed,
      viaUSDCBeforeNetworkCounter: Math.max(0, (getCounter.get("viaUSDC")?.n ?? 0) - viaUSDCAttributed),
      viaUSDCByNetworkNote: "viaUSDC is a lifetime counter; the per-network split starts when that counter shipped, so viaUSDCAttributed + viaUSDCBeforeNetworkCounter = viaUSDC",
      viaUSDCByNetwork,
      viaProofOfWork: getCounter.get("viaProofOfWork")?.n ?? 0,
      viaTrial: getCounter.get("viaTrial")?.n ?? 0,
      viaHeartbeat: getCounter.get("viaHeartbeat")?.n ?? 0,
      estimatedRevenueUsd: +tools.reduce((s, t) => s + t.revenueUsd, 0).toFixed(4),
      toolsServed: tools.length,
      chargedButFailed: getCounter.get("chargedButFailedTotal")?.n ?? 0,
    },
    railBreakdown,
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
    processUptimeSeconds: Math.floor((Date.now() - bootedAt) / 1000), // see the public getStats() comment above - same rename, same reason
  };
}
