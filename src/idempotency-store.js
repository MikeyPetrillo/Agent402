// Where the idempotency middleware keeps a settled answer and the in-flight
// claims (src/idempotency.js). Until this module both lived in the process:
// a retry that landed on the other container during a deploy's overlap, or
// on another replica, found nothing and ran (and charged) again. With a Redis
// in reach (REDIS_URL, the same client the shared limiter and the replay guard
// use) both live there with the same ten-minute life AND in the process-local
// store below, so a Redis outage never drops below what we had before Redis.
// Without Redis the local store is the whole guard (per process: a retry on
// the other container during an overlap runs again).
//
// Keys are the middleware's sha256 binding (credential + route + body), never
// the credential itself. Bodies are capped as before (IDEM_MAX_BODY_BYTES per
// entry; the local store also caps total bytes and entries).
import { getSharedRedisClient } from "./shared-limit.js";

export const IDEM_TTL_MS = 10 * 60 * 1000;
const IDEM_MAX_ENTRIES = 5000;
const IDEM_MAX_BYTES = 32 * 1024 * 1024;
const PREFIX = "idem:";
// Renewed every INFLIGHT_RENEW_MS while the handler runs (the slow routes run
// for minutes); a crashed holder's claim lapses within this.
const INFLIGHT_TTL_SECONDS = 120;
export const INFLIGHT_RENEW_MS = 30_000;

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
    async renew() { return true; },
    async release(key) { inFlight.delete(key); },
    size() { return entries.size; },
    stop() { clearInterval(sweep); },
  };
}

/**
 * The shared store: Redis when reachable, ALWAYS backed by the local one.
 * Answers and claims are written to both, so a Redis outage (its 30 s
 * cooldown, or commands that throw) never makes this process forget what it
 * already stored or claimed: the per-process guarantee from before Redis is
 * the floor, and Redis only adds the cross-container one. Reads check Redis,
 * then the local store. A release clears both; a Redis delete that fails is
 * retried, and a later claim of a key this process released while Redis was
 * down clears its own stale Redis claim instead of refusing for 120 s.
 */
const REDIS_OP_MS = 1_000;
const RELEASE_RETRY_MS = 5_000;
export function createIdempotencyStore({ ttlMs = IDEM_TTL_MS, redis = getSharedRedisClient, local = createLocalIdempotencyStore({ ttlMs }), opTimeoutMs = REDIS_OP_MS, releaseRetryMs = RELEASE_RETRY_MS } = {}) {
  const client = async () => { try { return await redis(); } catch { return null; } };
  // A Redis command that neither answers nor fails must not park the request.
  const op = (p) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("redis op timeout")), opTimeoutMs);
    t.unref?.();
    Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
  // Keys this process released locally whose Redis claim could not be deleted.
  const pendingRelease = new Map(); // key -> deadline (ms)
  // Keys whose claim this process holds in Redis (only those need a Redis delete).
  const heldInRedis = new Set();
  let retryTimer = null;
  const tryRedisDel = async (key) => {
    const c = await client();
    if (!c) return false;
    try { await op(c.del(PREFIX + "f:" + key)); return true; } catch { return false; }
  };
  const scheduleRetry = () => {
    if (retryTimer || pendingRelease.size === 0) return;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      const now = Date.now();
      for (const [key, until] of [...pendingRelease]) {
        if (now >= until) { pendingRelease.delete(key); continue; } // the Redis ttl has lapsed it
        if (await tryRedisDel(key)) pendingRelease.delete(key);
      }
      scheduleRetry();
    }, releaseRetryMs);
    retryTimer.unref?.();
  };
  return {
    kind: "shared",
    local,
    async get(key) {
      const c = await client();
      if (c) {
        try {
          const raw = await op(c.get(PREFIX + "b:" + key));
          if (raw != null) return JSON.parse(raw);
          // A miss in Redis is not a miss: an answer stored while Redis was on
          // cooldown lives in the local store, and must still replay.
        } catch { /* fall through to local */ }
      }
      return local.get(key);
    },
    async set(key, body, size) {
      await local.set(key, body, size);
      const c = await client();
      if (c) {
        try { await op(c.set(PREFIX + "b:" + key, JSON.stringify(body), { PX: ttlMs })); }
        catch { /* the local copy still replays on this container */ }
      }
      return true;
    },
    async claim(key) {
      // The local claim first: a duplicate in this process is refused whatever
      // Redis says, exactly as before Redis.
      if (!(await local.claim(key))) return false;
      const c = await client();
      if (!c) return true;
      try {
        let r = await op(c.set(PREFIX + "f:" + key, "1", { NX: true, EX: INFLIGHT_TTL_SECONDS }));
        if (r !== "OK" && pendingRelease.has(key)) {
          // Our own claim, released while Redis was down: clear it and retry.
          await op(c.del(PREFIX + "f:" + key));
          pendingRelease.delete(key);
          r = await op(c.set(PREFIX + "f:" + key, "1", { NX: true, EX: INFLIGHT_TTL_SECONDS }));
        }
        if (r === "OK") { pendingRelease.delete(key); heldInRedis.add(key); return true; }
        await local.release(key);
        return false;
      } catch {
        return true; // Redis unreachable: the local claim guards this process
      }
    },
    /** Keep a claim alive while its handler runs: the longest routes outlive INFLIGHT_TTL_SECONDS. */
    async renew(key) {
      const c = await client();
      if (c) { try { await op(c.expire(PREFIX + "f:" + key, INFLIGHT_TTL_SECONDS)); } catch { /* the next renew retries */ } }
      return true;
    },
    async release(key) {
      await local.release(key);
      if (!heldInRedis.delete(key)) return; // never claimed in Redis: nothing to clear there
      if (!(await tryRedisDel(key))) {
        pendingRelease.set(key, Date.now() + INFLIGHT_TTL_SECONDS * 1000);
        scheduleRetry();
      }
    },
    stop() { local.stop(); if (retryTimer) clearTimeout(retryTimer); retryTimer = null; },
  };
}
