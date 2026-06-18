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
import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL || "";
let client = null;
let connecting = null;
let unavailable = false;

async function getClient() {
  if (!REDIS_URL || unavailable) return null;
  if (client && client.isReady) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    try {
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
//   keyFields — the request-input fields that materially change the answer.
//               Anything not listed is ignored when computing the key.
//
// Add new entries here, NOT in the kit files — keeps cache policy in one place.
export const CACHEABLE_ROUTES = {
  // Net/DNS — stable on the order of minutes-to-hours.
  "/api/dns":            { ttl:   300, keyFields: ["domain", "type"] },
  "/api/whois":          { ttl:  3600, keyFields: ["domain"] },
  "/api/tls-cert":       { ttl:  3600, keyFields: ["host", "port"] },
  "/api/http-check":     { ttl:    60, keyFields: ["url"] },
  "/api/robots-check":   { ttl:  3600, keyFields: ["url", "userAgent"] },
  "/api/sitemap":        { ttl:  1800, keyFields: ["url"] },
  "/api/ip-info":        { ttl: 86400, keyFields: ["ip"] },
  "/api/ens-resolve":    { ttl:  3600, keyFields: ["name"] },
  "/api/email-validate": { ttl:  3600, keyFields: ["email"] },

  // Geo — almost never changes.
  "/api/geocode":         { ttl: 86400, keyFields: ["address"] },
  "/api/reverse-geocode": { ttl: 86400, keyFields: ["lat", "lon"] },
  "/api/place-search":    { ttl:  3600, keyFields: ["query", "near"] },

  // Time-sensitive but coarsely cacheable.
  "/api/fx-rate":          { ttl:   300, keyFields: ["base", "quote"] },
  "/api/weather-forecast": { ttl:   600, keyFields: ["lat", "lon"] },
  "/api/weather-alerts":   { ttl:   300, keyFields: ["state"] },
  "/api/earthquakes":      { ttl:   300, keyFields: ["min_magnitude", "hours"] },

  // Product/code lookups — effectively static.
  "/api/barcode-lookup":   { ttl: 86400, keyFields: ["code"] },

  // On-chain — short TTL, can change every block but agents often poll.
  "/api/gas-estimate":  { ttl: 30, keyFields: ["network"] },
  "/api/usdc-balance":  { ttl: 30, keyFields: ["address", "network"] },
};

// Build a deterministic cache key from a path + the policy's keyFields. Values
// are stringified and lowercased so trivial input variation ("Foo.com" vs
// "foo.com") doesn't fragment the cache. Long values are hashed-by-truncation
// rather than left whole so we don't blow past Redis key limits on URL inputs.
export function cacheKeyFor(path, input, keyFields) {
  const parts = [path];
  for (const f of keyFields) {
    const raw = input == null ? "" : input[f];
    const v = raw == null ? "" : String(raw).toLowerCase().slice(0, 256);
    parts.push(`${f}=${v}`);
  }
  return "a402:" + parts.join("|");
}

export async function cacheGet(key) {
  if (!REDIS_URL || unavailable) return null;
  try {
    const c = await getClient();
    if (!c) return null;
    const v = await c.get(key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null;
  }
}

export async function cacheSet(key, value, ttlSec) {
  if (!REDIS_URL || unavailable) return;
  try {
    const c = await getClient();
    if (!c) return;
    await c.set(key, JSON.stringify(value), { EX: Math.max(1, ttlSec | 0) });
  } catch (e) {
    // Swallow — caching is best-effort, never block the response path.
  }
}
