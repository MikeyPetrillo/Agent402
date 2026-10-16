// The CoinGecko response cache, shared by every replica.
//
// Each kit keeps a short cache keyed on the exact upstream URL, so an identical
// request inside the window costs the key nothing. In one process that cache
// was private, so with two replicas a request that landed on the other
// container went upstream again and spent a second call of the same budget.
// Now an answer fetched on one replica is written to the shared store
// (src/shared-limits.js: REDIS_URL set, SHARED_LIMITS not off) with the same
// TTL, and a miss in this process's map reads the store before going upstream.
//
// The store never holds up a request: the write is in the background, a read
// that has not answered inside COINGECKO_SHARED_DEADLINE_MS is a miss, and a
// store that is not configured or not reachable leaves the per-process map
// exactly as it was. Concurrent misses for one URL in one process share a
// single upstream call (in-flight dedupe), and a failed call is never cached.
//
// Stored per entry: the upstream body text and the time it was fetched, so a
// cached answer on any replica reports when the upstream actually gave it.
import { createHash } from "node:crypto";
import { getSharedRedisClient } from "../shared-limit.js";
import { sharedLimitsEnabled, keyOf, noteSharedLimitsDegraded } from "../shared-limits.js";
import { cgWithin } from "./coingecko-rate.js";

/** Bodies larger than this stay in the process's map only (COINGECKO_SHARED_CACHE_MAX_BYTES). */
const SHARED_MAX_BODY = () => Math.max(1024, Number(process.env.COINGECKO_SHARED_CACHE_MAX_BYTES) || 4 * 1024 * 1024);
const counts = { localHits: 0, sharedHits: 0, misses: 0, sharedWrites: 0, sharedMisses: 0 };

/**
 * One cache. `name` namespaces it in the shared store; `max` bounds the
 * process's map (oldest dropped); a body over `maxBody` is served but not kept
 * anywhere. Entries are { text, fetchedAt, expiresAt, data? } (`data` is the
 * parsed body, kept with `keepParsed` for callers that never mutate it).
 */
export function createCgCache(name, { max = 200, maxBody = Infinity, keepParsed = false } = {}) {
  const local = new Map();
  const inflight = new Map();
  const sharedKey = (key) => keyOf(`cg-cache:${name}`, createHash("sha256").update(String(key)).digest("hex").slice(0, 40));

  function localGet(key, now = Date.now()) {
    const hit = local.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= now) { local.delete(key); return null; }
    return hit;
  }
  function localPut(key, entry) {
    if (entry.text.length > maxBody) return;
    local.delete(key);
    if (local.size >= max) { const oldest = local.keys().next().value; if (oldest !== undefined) local.delete(oldest); }
    local.set(key, entry);
  }

  async function sharedGet(key, now = Date.now()) {
    if (!sharedLimitsEnabled()) return null;
    try {
      const c = await getSharedRedisClient();
      if (!c) throw new Error("redis unavailable");
      const raw = await cgWithin(c.get(sharedKey(key)));
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (typeof v?.t !== "string" || !(Number(v.e) > now)) return null;
      return { text: v.t, fetchedAt: String(v.f || ""), expiresAt: Number(v.e) };
    } catch (e) {
      counts.sharedMisses++;
      noteSharedLimitsDegraded("coingecko-cache", { error: e?.message });
      return null;
    }
  }
  function sharedPut(key, entry) {
    if (!sharedLimitsEnabled() || entry.text.length > maxBody || entry.text.length > SHARED_MAX_BODY()) return;
    const ttl = Math.round(entry.expiresAt - Date.now());
    if (ttl <= 0) return;
    void (async () => {
      try {
        const c = await getSharedRedisClient();
        if (!c) throw new Error("redis unavailable");
        await cgWithin(c.set(sharedKey(key), JSON.stringify({ t: entry.text, f: entry.fetchedAt, e: entry.expiresAt }), { PX: ttl }));
        counts.sharedWrites++;
      } catch (e) {
        noteSharedLimitsDegraded("coingecko-cache", { error: e?.message });
      }
    })();
  }

  /** The cached entry for `key` (this process, then the shared store), or null. */
  async function get(key) {
    const hit = localGet(key);
    if (hit) { counts.localHits++; return hit; }
    const shared = await sharedGet(key);
    if (shared) { counts.sharedHits++; localPut(key, shared); return shared; }
    return null;
  }

  /** Keep `text` under `key` for `ttlMs`, here and (in the background) in the shared store. */
  function put(key, text, ttlMs, fetchedAt = new Date().toISOString()) {
    const entry = { text: String(text), fetchedAt, expiresAt: Date.now() + ttlMs };
    localPut(key, entry);
    sharedPut(key, entry);
    return entry;
  }

  /**
   * The cached entry for `key`, or the one `load()` fetches. `load` resolves
   * the body text, or { text, data } with the parsed body (and throws for
   * anything that must not be cached); it runs
   * once per process for concurrent misses on the same key. Resolves
   * { entry, cached }.
   */
  async function through(key, ttlMs, load) {
    const hit = await get(key);
    if (hit) return { entry: hit, cached: true };
    let p = inflight.get(key);
    if (!p) {
      counts.misses++;
      p = (async () => {
        const out = await load();
        const isText = typeof out === "string";
        const entry = put(key, isText ? out : out.text, ttlMs);
        // The leader's parse is kept for callers that read `data`.
        if (keepParsed && !isText && out.data !== undefined) entry.data = out.data;
        return entry;
      })();
      inflight.set(key, p);
      p.then(() => inflight.delete(key), () => inflight.delete(key));
    }
    return { entry: await p, cached: false };
  }

  return {
    get, put, through,
    /** Test seam: drop this process's entries (the shared store keeps its own TTLs). */
    clear() { local.clear(); inflight.clear(); },
    get size() { return local.size; },
  };
}

/** Test seam: where this process's cache answers came from. */
export function cgCacheCounts() { return { ...counts }; }
