// Where the idempotency middleware keeps a settled answer and the in-flight
// claims (src/idempotency.js). Until this module both lived in the process:
// a retry that landed on the other container during a deploy's overlap, or
// on another replica, found nothing and ran (and charged) again. With a Redis
// in reach (REDIS_URL, the same client the shared limiter and the replay guard
// use) both live there with the same ten-minute life; without one, or while
// it is unreachable, the process-local store below is exactly what we had.
//
// Keys are the middleware's sha256 binding (credential + route + body), never
// the credential itself. Bodies are capped as before (IDEM_MAX_BODY_BYTES per
// entry; the local store also caps total bytes and entries).
import { getSharedRedisClient } from "./shared-limit.js";

export const IDEM_TTL_MS = 10 * 60 * 1000;
const IDEM_MAX_ENTRIES = 5000;
const IDEM_MAX_BYTES = 32 * 1024 * 1024;
const PREFIX = "idem:";
const INFLIGHT_TTL_SECONDS = 120; // the longest handler clears this; a crashed holder self-heals

export function createLocalIdempotencyStore({ ttlMs = IDEM_TTL_MS, maxEntries = IDEM_MAX_ENTRIES, maxBytes = IDEM_MAX_BYTES } = {}) {
  const entries = new Map(); // key -> { at, body, bytes }
  const inFlight = new Set();
  let bytes = 0;
  const sweep = setInterval(() => {
    const cutoff = Date.now() - ttlMs;
    for (const [k, v] of entries) if (v.at < cutoff) { bytes -= v.bytes; entries.delete(k); }
  }, 60_000);
  sweep.unref?.();
  return {
    kind: "local",
    async get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      if (Date.now() - hit.at >= ttlMs) { bytes -= hit.bytes; entries.delete(key); return null; }
      return hit.body;
    },
    async set(key, body, size) {
      // Evict oldest entries (Map preserves insertion order: FIFO) until we fit.
      while ((entries.size >= maxEntries || bytes + size > maxBytes) && entries.size > 0) {
        const firstKey = entries.keys().next().value;
        const ev = entries.get(firstKey);
        if (ev) bytes -= ev.bytes;
        entries.delete(firstKey);
      }
      entries.set(key, { at: Date.now(), body, bytes: size });
      bytes += size;
      return true;
    },
    /** True when this call now owns the in-flight claim; false when another copy holds it. */
    async claim(key) { if (inFlight.has(key)) return false; inFlight.add(key); return true; },
    async release(key) { inFlight.delete(key); },
    size() { return entries.size; },
    stop() { clearInterval(sweep); },
  };
}

/**
 * The shared store: Redis when reachable, else the local one. Every Redis
 * failure falls back to the local store for that call (the same per-process
 * guarantee as before), never to "no guard".
 */
export function createIdempotencyStore({ ttlMs = IDEM_TTL_MS, redis = getSharedRedisClient, local = createLocalIdempotencyStore({ ttlMs }) } = {}) {
  const client = async () => { try { return await redis(); } catch { return null; } };
  return {
    kind: "shared",
    local,
    async get(key) {
      const c = await client();
      if (c) {
        try {
          const raw = await c.get(PREFIX + "b:" + key);
          if (raw != null) return JSON.parse(raw);
          return null;
        } catch { /* fall through to local */ }
      }
      return local.get(key);
    },
    async set(key, body, size) {
      const c = await client();
      if (c) {
        try { await c.set(PREFIX + "b:" + key, JSON.stringify(body), { PX: ttlMs }); return true; }
        catch { /* fall through to local */ }
      }
      return local.set(key, body, size);
    },
    async claim(key) {
      const c = await client();
      if (c) {
        try {
          const r = await c.set(PREFIX + "f:" + key, "1", { NX: true, EX: INFLIGHT_TTL_SECONDS });
          return r === "OK";
        } catch { /* fall through to local */ }
      }
      return local.claim(key);
    },
    async release(key) {
      const c = await client();
      if (c) { try { await c.del(PREFIX + "f:" + key); } catch { /* local below */ } }
      await local.release(key);
    },
    stop() { local.stop(); },
  };
}
