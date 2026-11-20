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
import { randomUUID } from "node:crypto";
import { getSharedRedisClient } from "./shared-limit.js";
import { withLoopTimeout } from "./loop-deadline.js";
import { delIfValue } from "./bounded-redis.js";

// Ten minutes; IDEM_TTL_MS overrides it (a paid-mode test shortens it to prove
// a replay past the window is not served from the store).
export const IDEM_TTL_MS = (() => { const n = Number(process.env.IDEM_TTL_MS); return Number.isFinite(n) && n >= 1000 ? n : 10 * 60 * 1000; })();
const IDEM_MAX_ENTRIES = 5000;
const IDEM_MAX_BYTES = 32 * 1024 * 1024;
const PREFIX = "idem:";
// Renewed every INFLIGHT_RENEW_MS while the handler runs (the slow routes run
// for minutes); a crashed holder's claim lapses within this.
const INFLIGHT_TTL_SECONDS = 120;
export const INFLIGHT_RENEW_MS = 30_000;
// The longest a claim is held for a run whose response never ends (the
// middleware releases it when the run ends; this bounds a handler that hangs).
// IDEM_INFLIGHT_MAX_MS overrides it.
export const INFLIGHT_MAX_MS = (() => { const n = Number(process.env.IDEM_INFLIGHT_MAX_MS); return Number.isFinite(n) && n >= 1000 ? n : 2 * 60 * 60 * 1000; })();

export function createLocalIdempotencyStore({ ttlMs = IDEM_TTL_MS, maxEntries = IDEM_MAX_ENTRIES, maxBytes = IDEM_MAX_BYTES } = {}) {
  const entries = new Map(); // key -> { at, body, bytes, ttl? }
  // An entry may carry a life of its own (set's `ttlMs`); the store's otherwise.
  const lifeOf = (v) => (Number(v?.ttl) > 0 ? Number(v.ttl) : ttlMs);
  const inFlight = new Set();
  let bytes = 0;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of entries) if (now - v.at >= lifeOf(v)) { bytes -= v.bytes; entries.delete(k); }
  }, 60_000);
  sweep.unref?.();
  return {
    kind: "local",
    async get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      if (Date.now() - hit.at >= lifeOf(hit)) { bytes -= hit.bytes; entries.delete(key); return null; }
      return hit.body;
    },
    async set(key, body, size, { ttlMs: life = null } = {}) {
      // Evict oldest entries (Map preserves insertion order: FIFO) until we fit.
      while ((entries.size >= maxEntries || bytes + size > maxBytes) && entries.size > 0) {
        const firstKey = entries.keys().next().value;
        const ev = entries.get(firstKey);
        if (ev) bytes -= ev.bytes;
        entries.delete(firstKey);
      }
      entries.set(key, { at: Date.now(), body, bytes: size, ...(Number(life) > 0 ? { ttl: Number(life) } : {}) });
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
 * Each claim is written under a token of its own, and a claim whose command
 * was sent and never answered (Redis paused past the bound: it may land
 * later) is remembered by that token too, so its release drops it once it
 * lands. Every drop is by token: a claim another container holds is never
 * dropped by one that only sent its own.
 */
const REDIS_OP_MS = 1_000;
const RELEASE_RETRY_MS = 5_000;
export function createIdempotencyStore({ ttlMs = IDEM_TTL_MS, redis = getSharedRedisClient, local = createLocalIdempotencyStore({ ttlMs }), opTimeoutMs = REDIS_OP_MS, releaseRetryMs = RELEASE_RETRY_MS } = {}) {
  const client = async () => { try { return await redis(); } catch { return null; } };
  // A Redis command that neither answers nor fails must not park the request.
  // Loop time (src/loop-deadline.js): an answer that landed while the loop was
  // held is read, not taken for a store that did not answer.
  const op = (p) => withLoopTimeout(p, opTimeoutMs, () => new Error("redis op timeout"));
  // Keys this process released locally whose Redis claim could not be dropped.
  const pendingRelease = new Map(); // key -> { until (ms), token }
  // Keys whose claim this process holds in Redis, or sent there with no
  // answer (it may land later), by the claim's token: only those need a drop.
  const heldInRedis = new Map(); // key -> token
  let retryTimer = null;
  const tryRedisDel = async (key, token) => {
    const c = await client();
    if (!c) return false;
    try { await op(delIfValue(c, PREFIX + "f:" + key, token)); return true; } catch { return false; }
  };
  const scheduleRetry = () => {
    if (retryTimer || pendingRelease.size === 0) return;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      const now = Date.now();
      for (const [key, { until, token }] of [...pendingRelease]) {
        if (now >= until) { pendingRelease.delete(key); continue; } // the Redis ttl has lapsed it
        if (await tryRedisDel(key, token)) pendingRelease.delete(key);
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
    async set(key, body, size, { ttlMs: life = null } = {}) {
      const px = Number(life) > 0 ? Math.ceil(Number(life)) : ttlMs;
      await local.set(key, body, size, { ttlMs: px });
      const c = await client();
      if (c) {
        try { await op(c.set(PREFIX + "b:" + key, JSON.stringify(body), { PX: px })); }
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
      const token = randomUUID();
      try {
        let r = await op(c.set(PREFIX + "f:" + key, token, { NX: true, EX: INFLIGHT_TTL_SECONDS }));
        if (r !== "OK" && pendingRelease.has(key)) {
          // Our own claim, released while Redis was down: drop it (by its
          // token, never another container's) and retry.
          await op(delIfValue(c, PREFIX + "f:" + key, pendingRelease.get(key).token));
          pendingRelease.delete(key);
          r = await op(c.set(PREFIX + "f:" + key, token, { NX: true, EX: INFLIGHT_TTL_SECONDS }));
        }
        if (r === "OK") { pendingRelease.delete(key); heldInRedis.set(key, token); return true; }
        await local.release(key);
        return false;
      } catch {
        // Redis did not answer: the local claim guards this process. A claim
        // that was sent may still land; the release drops it by its token.
        heldInRedis.set(key, token);
        return true;
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
      const token = heldInRedis.get(key);
      if (token === undefined) return; // never sent to Redis: nothing to clear there
      heldInRedis.delete(key);
      // On one connection the drop runs after a claim that lands late.
      if (!(await tryRedisDel(key, token))) {
        pendingRelease.set(key, { until: Date.now() + INFLIGHT_TTL_SECONDS * 1000, token });
        scheduleRetry();
      }
    },
    stop() { local.stop(); if (retryTimer) clearTimeout(retryTimer); retryTimer = null; },
  };
}
