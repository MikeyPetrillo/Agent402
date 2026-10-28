// Tool response cache — Redis-backed, per-route, optional.
//
// Wraps the central handler dispatch in src/server.js so that for a known set
// of "expensive upstream" tools (whois, dns, ip-info, geocode, fx, etc.) we
// can return a cached JSON body without hitting the third-party API again.
//
// Design notes:
//   - REDIS_URL is the Railway convention (auto-injected by the Redis plugin).
//     If absent, every function below is a no-op: callers get null on read and
//     a silent skip on write. The server runs identically without Redis.
//   - Connection is lazy + memoized: first call connects, every subsequent call
//     reuses the same client. A connect failure flips `unavailable = true` so
//     we don't retry on every request and tank latency.
//   - Per-route policy lives in CACHEABLE_ROUTES below: { ttl, keyFields }.
//     Adding a new cacheable route is a single line — no touching kit files.
//   - We only cache GET requests with a 200, non-error, non-binary JSON body.
//     Error responses are never cached (an upstream blip would poison the key
//     for ttl seconds).
//   - Every read/write is wrapped in try/catch — a Redis stall NEVER takes
//     down a tool. Worst case it adds a few ms then we serve fresh.
import { createHash } from "node:crypto";
import { loadRedis } from "./lazy-redis.js";

// Mirror src/db-ssl.js for Redis: a plaintext redis:// URL is only acceptable
// on Railway's private mesh; a public host must use rediss:// or the password,
// the rate-limit counters and the cache travel in the clear. Fail loudly at
// import so a misconfigured URL never silently runs unencrypted.
function assertRedisTransport(url) {
  if (!url) return;
  let u; try { u = new URL(url); } catch { return; }
  const internal = /\.railway\.internal$/i.test(u.hostname) || /^(localhost|127\.0\.0\.1|::1)$/i.test(u.hostname);
  if (u.protocol === "redis:" && !internal) throw new Error(`REDIS_URL uses plaintext redis:// to a public host (${u.hostname}); use rediss:// or the private mesh`);
}
const REDIS_URL = process.env.REDIS_URL || "";
assertRedisTransport(REDIS_URL);
let client = null;
let connecting = null;
let unavailable = false;

async function getClient() {
  if (!REDIS_URL || unavailable) return null;
  if (client && client.isReady) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      const { createClient } = await loadRedis();
      const c = createClient({
        url: REDIS_URL,
        socket: {
          connectTimeout: 5_000,
          // Stop retrying after a handful of failed attempts so a permanently
          // dead Redis doesn't keep firing reconnects forever.
          reconnectStrategy: (retries) =>
            retries > 5 ? new Error("redis: too many reconnects") : Math.min(retries * 200, 2_000),
        },
      });
      c.on("error", (err) => console.error("[cache] redis error:", err.message));
      await c.connect();
      client = c;
      return c;
    } catch (e) {
      console.error("[cache] connect failed:", e.message);
      unavailable = true;
      return null;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

export function cacheEnabled() {
  return !!REDIS_URL && !unavailable;
}

// Per-route cache policy.
//   ttl       — seconds. Pick something that matches how stale the upstream
//               answer can be without misleading the agent.
//   keyFields: the request-input fields that materially change the answer,
//               named as the tool reads them (scripts/test-cache-keys.js
//               checks each against the tool's inputSchema). They document
//               the policy and /api/cacheable lists them; the key itself is
//               built from every field the call carries (cacheKeyFor).
//   fallbackTtl / fallbackSource: optional. An answer whose `source` starts
//               with fallbackSource came from a backup provider and is kept
//               for fallbackTtl seconds instead of ttl (cacheTtlFor).
//
// Add new entries here, NOT in the kit files — keeps cache policy in one place.
//
// SECURITY INVARIANT: the cache key is the path plus the call's input
//   fields; it does NOT include the caller's gate credential (wallet address,
//   PoW ticket, idempotency key). The response cache is read only after the
//   payment gates (and by free discovery), so a hit is paid like any other
//   200, but its body is shared by every caller with the same input. Only a
//   route whose answer depends on nothing but its input belongs here: NEVER
//   add memory tools, identity-bound routes or anything keyed on the payer.
export const CACHEABLE_ROUTES = {
  // Only GET kit routes are cached, so a POST tool (whois, tls-cert,
  // http-check) or a route the server defines itself never belongs here.
  "/api/ens-resolve":    { ttl:  3600, keyFields: ["name"] },

  // Geo — almost never changes.
  // An answer from the backup geocoder (source photon...) is kept briefly.
  "/api/geocode":         { ttl: 86400, keyFields: ["q", "limit", "countryCodes"], fallbackSource: "photon", fallbackTtl: 600 },
  "/api/reverse-geocode": { ttl: 86400, keyFields: ["lat", "lon", "zoom"], fallbackSource: "photon", fallbackTtl: 600 },
  "/api/place-search":    { ttl:  3600, keyFields: ["q", "limit", "countryCodes", "viewbox", "bounded"], fallbackSource: "photon", fallbackTtl: 600 },

  // Time-sensitive but coarsely cacheable.
  "/api/fx-rate":          { ttl:   300, keyFields: ["from", "to", "amount"] },
  "/api/weather-forecast": { ttl:   600, keyFields: ["lat", "lon"] },
  "/api/weather-alerts":   { ttl:   300, keyFields: ["area"] },
  "/api/earthquakes":      { ttl:   300, keyFields: ["minMag", "period"] },
  // Release dates are scheduled weeks ahead; FRED's /releases/dates endpoint
  // is its slowest (15-60s under load, per the 2026-07-16 incident) and agents
  // poll this route on fixed schedules — an hour of caching means most polls
  // never wait on FRED at all.
  "/api/fred-release-calendar": { ttl: 3600, keyFields: ["days"] },

  // Product/code lookups — effectively static.
  "/api/barcode-lookup":   { ttl: 86400, keyFields: ["code"] },

  // On-chain — short TTL, can change every block but agents often poll.
  "/api/gas-estimate":  { ttl: 30, keyFields: ["network"] },
  "/api/usdc-balance":  { ttl: 30, keyFields: ["address", "network"] },

  // Search — shift over time, but for agent batch tasks the same query
  // repeated within a minute is wasted spend. 5min is a fair middle.
  // The domain lists change which pages come back, so they are part of the key.
  "/api/search":   { ttl: 300, keyFields: ["q", "count", "freshness", "includeDomains", "excludeDomains"] },
  "/api/gov-data": { ttl: 3600, keyFields: ["q", "rows"] },

  // Discovery primitives — every agent hits /api/find and /api/route on the
  // first call of a session, often with the same query repeated as they
  // explore. The underlying CATALOG only changes when the server reboots, but
  // we still keep TTLs short (60s) because the resolver is cheap and we'd
  // rather pick up index refreshes (leaderboard / reliability) within a minute.
  // `network` is load-bearing in /api/route's key. It arrived as a FILTER on
  // the handler (routeQuery networkFilter) and was never added here, so
  // ?q=swap&network=solana and ?q=swap&network=base shared one cache entry:
  // whichever ran first served the other for 60 s, and the answer a buyer got
  // was a list of sellers on a chain they cannot pay on, with nothing saying it
  // had been filtered for someone else. A key that ignores a filter is the same
  // defect class as a page that calls itself complete - the response is a
  // subset, and the contract says nothing.
  "/api/find":  { ttl: 60, keyFields: ["q", "task", "query", "k"] },
  "/api/route": { ttl: 60, keyFields: ["q", "task", "query", "top", "k", "include", "network"] },

  // x402 payments helpers. Quotes are mostly static (sellers rarely re-price);
  // x402-verify is fully immutable once a tx confirms; tx-status is short-ttl
  // because pending→confirmed flips matter.
  "/api/x402-quote":  { ttl:   600, keyFields: ["url", "method"] },
  "/api/x402-verify": { ttl: 86400, keyFields: ["hash", "network", "to", "min"] },
  "/api/tx-status":   { ttl:    60, keyFields: ["hash", "network"] },
};

// Build a deterministic cache key from a path + every input field the call
// carried (keyFields are included for callers that pass a fixed object), so
// two calls that differ in any field never share an entry. Values are kept as
// sent (no case folding: base58 addresses and signatures are case-sensitive),
// and the whole field list is hashed so long URL inputs neither collide on a
// shared prefix nor exceed Redis key limits.
export function cacheKeyFor(path, input, keyFields) {
  const fields = new Set(keyFields);
  if (input && typeof input === "object") for (const f of Object.keys(input)) fields.add(f);
  const parts = [];
  for (const f of [...fields].sort()) {
    const raw = input == null ? undefined : input[f];
    if (raw == null || raw === "") continue;
    parts.push([f, typeof raw === "object" ? JSON.stringify(raw) : String(raw)]);
  }
  return `a402:${path}|${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

// Seconds to keep one answer: the policy's ttl, or fallbackTtl when the
// answer came from the policy's backup provider.
export function cacheTtlFor(policy, body) {
  const src = body && typeof body === "object" && typeof body.source === "string" ? body.source : "";
  if (policy?.fallbackSource && policy.fallbackTtl && src.startsWith(policy.fallbackSource)) return policy.fallbackTtl;
  return policy?.ttl;
}

// Hard read timeout so a stalled Redis can never hang a request. The cache is
// strictly an optimization — falling back to a fresh upstream call is always
// preferable to making the agent wait on a degraded cache.
const CACHE_READ_TIMEOUT_MS = 300;
export async function cacheGet(key) {
  if (!REDIS_URL || unavailable) return null;
  try {
    const c = await getClient();
    if (!c) return null;
    const v = await Promise.race([
      c.get(key),
      new Promise((resolve) => setTimeout(() => resolve(null), CACHE_READ_TIMEOUT_MS)),
    ]);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null;
  }
}

// In-process cache outcome counters. The dispatcher calls noteCacheOutcome()
// after each cached route serves, so even without Redis we always know
// "X requests hit, Y missed, Z were skipped (no policy)" since the server
// started. Surfaced at /api/cache-stats. Reset to 0 on restart (cache itself
// is not durable across restarts either, so per-boot counters are honest).
const _counters = { hits: 0, misses: 0, skips: 0, sets: 0, errors: 0, startedAt: Date.now() };
export function noteCacheOutcome(kind) {
  if (kind === "hit") _counters.hits++;
  else if (kind === "miss") _counters.misses++;
  else if (kind === "skip") _counters.skips++;
  else if (kind === "set") _counters.sets++;
  else if (kind === "error") _counters.errors++;
}
export function cacheCounters() {
  const total = _counters.hits + _counters.misses;
  return {
    enabled: cacheEnabled(),
    hits: _counters.hits,
    misses: _counters.misses,
    skips: _counters.skips,
    sets: _counters.sets,
    errors: _counters.errors,
    hitRate: total > 0 ? +(_counters.hits / total).toFixed(4) : 0,
    startedAt: new Date(_counters.startedAt).toISOString(),
  };
}

export async function cacheSet(key, value, ttlSec) {
  if (!REDIS_URL || unavailable) return;
  try {
    const c = await getClient();
    if (!c) return;
    await c.set(key, JSON.stringify(value), { EX: Math.max(1, ttlSec | 0) });
    noteCacheOutcome("set");
  } catch (e) {
    noteCacheOutcome("error");
    // Swallow — caching is best-effort, never block the response path.
  }
}
