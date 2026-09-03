// A rate limit that survives horizontal scaling.
//
// src/rate-limit.js keeps buckets in a per-process Map, so every replica holds
// its own copy and the effective system-wide limit is (configured x replicas).
// Scaling 1 -> 2 replicas silently doubled every limit built on it. The
// RATE_LIMIT_REPLICAS divisor fixes that for any budget larger than the replica
// count, but it CANNOT fix a budget that is already 1: dividing 1 by 2 floors
// back to 1, because a budget of zero is an outage rather than a limit. The
// trial's per-tool cap is exactly 1, so it stayed doubled.
//
// This is the only way to make a cap of 1 mean 1 across N processes: one
// counter, somewhere both replicas can see it.
//
// FAILS CLOSED. If Redis is unreachable the answer is "over budget", so the
// caller is refused the free thing and pays instead. The opposite choice —
// granting when we cannot count — turns a Redis outage into unmetered free
// access, which is how a limiter becomes decorative at exactly the moment it
// matters. A buyer paying is a worse experience; unbounded free calls are a
// worse failure.
import { createClient } from "redis";

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
// Test seam. The property that matters — a cap of 1 holding across SEVERAL
// processes — cannot be proven without a shared counter, and neither a Redis
// server nor Docker is guaranteed on a dev box or a CI runner. Skipping the
// test would leave the fix asserted but unverified, which is the failure mode
// this repo keeps rediscovering. Injecting a client lets two module consumers
// share one store and proves the semantics for real.
let testClient = null;
export function __setTestClient(c) { testClient = c; unavailable = false; }

// A failed connect used to set `unavailable = true` FOREVER, so one timeout
// during container start disabled the shared counter for the life of the
// process. Railway's private network is IPv6-only and takes a moment to come up
// after boot, so a timeout there is expected and transient — exactly the case
// that must not become permanent. Retry after a cooldown instead.
const RETRY_COOLDOWN_MS = 30_000;
let unavailableUntil = 0;

// How long a REQUEST may wait on a connect attempt, as opposed to how long the
// attempt itself may take. These are deliberately different numbers.
//
// A dead Redis would otherwise park an inbound request for the full connect
// timeout: the caller is on the hot path of the trial gate, and raising the
// connect timeout to 10s (needed so a slow IPv6 private network is not
// mistaken for an outage) handed that same 10s to a buyer. Waiting is also
// pointless, because the answer on failure is "refused" either way.
//
// So the request waits a short beat, and the connect keeps running in the
// background with the full budget. A healthy Redis resolves in milliseconds
// and nothing changes; a dead one refuses fast and fails closed, while the
// background attempt still records the outcome for the next caller.
const CONNECT_WAIT_MS = 1_000;

/** Resolve `p`, or null if it takes longer than `ms`. The promise is NOT
 *  cancelled: it keeps running so its result is cached for the next caller. */
function withDeadline(p, ms) {
  return Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms).unref?.())]);
}

/**
 * Shared accessor for the module's Redis client — exported so other modules
 * that need raw Redis primitives (not the counter-shaped spend/peek/refund
 * above) can reuse the SAME connection instead of opening a second one to
 * the same server. First consumer: src/replay-guard.js (cross-replica
 * payment-nonce replay protection). Same contract as the internal callers
 * below: null means "not configured or not currently reachable," and the
 * caller decides its own fallback — this module's fail-closed choice is
 * specific to rate-limiting and must not be assumed by every consumer.
 */
export async function getSharedRedisClient() {
  return getClient();
}

async function getClient() {
  if (testClient) return testClient;
  if (!REDIS_URL) return null;
  if (unavailable && Date.now() < unavailableUntil) return null;
  if (unavailable) { unavailable = false; }   // cooldown elapsed — try again
  if (client && client.isReady) return client;
  if (connecting) return withDeadline(connecting, CONNECT_WAIT_MS);
  connecting = (async () => {
    // Retire a stale client before replacing it. `isReady` false with a live
    // socket underneath meant the old one was dropped on the floor, and each
    // cooldown retry leaked another. quit() is best-effort: a client that
    // cannot connect also cannot close cleanly, and that must not throw here.
    if (client) {
      const stale = client;
      client = null;
      try { await stale.quit(); } catch { try { stale.destroy?.(); } catch { /* already gone */ } }
    }
    try {
      const c = createClient({
        url: REDIS_URL,
        socket: {
          // Railway private hostnames (*.railway.internal) resolve AAAA-only.
          // Node's default happy-eyeballs can spend the whole timeout on an A
          // record that will never exist, which is what "Connection timeout"
          // looked like in production. `family: 6` goes straight to IPv6 there
          // and is left alone for any other host.
          ...(/\.railway\.internal(:|$)/.test(REDIS_URL) ? { family: 6 } : {}),
          connectTimeout: 10_000,
          reconnectStrategy: (retries) =>
            retries > 5 ? new Error("redis: too many reconnects") : Math.min(retries * 200, 2_000),
        },
      });
      c.on("error", (err) => {
        state.lastError = err.message;
        console.error("[shared-limit] redis error:", err.message);
      });
      await c.connect();
      client = c;
      // The confirmation the announce line deliberately does NOT make.
      if (state.connected !== true) console.log("[shared-limit] redis CONNECTED — counters are shared");
      state.connected = true;
      return c;
    } catch (e) {
      state.connected = false;
      state.lastError = e.message;
      console.error(`[shared-limit] connect failed (FAILING CLOSED — trials refused, retrying in ${RETRY_COOLDOWN_MS / 1000}s):`, e.message);
      unavailable = true;
      unavailableUntil = Date.now() + RETRY_COOLDOWN_MS;
      return null;
    } finally {
      connecting = null;
    }
  })();
  return withDeadline(connecting, CONNECT_WAIT_MS);
}

/** Is a shared counter CONFIGURED? Callers use this to pick the shared path
 *  over the per-process fallback.
 *
 *  Note the word: CONFIGURED, not connected. This is a synchronous check on the
 *  gate's hot path, so it cannot await a socket — it can only report whether a
 *  URL exists and whether we have already given up on it. Whether the counter
 *  was actually REACHED is knowable only per call, and `spend()` reports it via
 *  `degraded`. Do not read a true here as "the shared counter is working." */
let announced = false;
export function sharedLimitEnabled() {
  // CONFIGURED, not reachable — and that distinction is the whole point.
  //
  // This used to return false once `unavailable` was set, which silently sent
  // the caller down the per-process branch. That branch GRANTS, so a replica
  // that could not reach Redis stopped refusing and started handing out its own
  // private allowance: fail-OPEN, the precise opposite of the property at the
  // top of this file, reached by a route the fail-closed code could not see.
  // Observed in production as one tool granting two trials in a row while the
  // logs showed connection timeouts.
  //
  // If a shared store is configured, the shared path is the only path. When it
  // cannot be reached, spend() answers "limited" and the caller pays. Falling
  // back to a per-process counter is never correct here, because a per-process
  // counter cannot express the cap that made this module necessary.
  const on = Boolean(testClient) || Boolean(REDIS_URL);
  // Say which path was CHOSEN, once — and say plainly that choosing it is not
  // the same as reaching it. The previous line logged "SHARED (redis)" purely
  // because REDIS_URL was set, which is true even when every single INCR is
  // failing and the limiter is refusing everyone. A limiter that reports health
  // it has not verified is worse than one that reports nothing, because it ends
  // the investigation. The confirmation comes from connectionState() below.
  if (!announced) {
    announced = true;
    console.log(`[shared-limit] path=${on ? "shared" : "per-process"}` +
      `${REDIS_URL ? " (redis configured, not yet contacted)" : " — REDIS_URL unset"}` +
      `${unavailable ? " — redis marked unavailable" : ""}`);
  }
  return on;
}

// The verified half of the story. `getClient()` sets this the first time it
// actually reaches (or fails to reach) Redis, and `spend()` records the first
// degraded call. Exposed so an operator surface can show the TRUE state rather
// than the configured one.
let state = { connected: null, lastError: null, degradedCalls: 0 };
export function connectionState() { return { ...state, configured: Boolean(REDIS_URL) }; }

/** The fail-closed answer, counted. Every caller that cannot reach the shared
 *  counter goes through here so "how often are we refusing because the store is
 *  down?" has an answer instead of being invisible. */
function degradedResult() {
  state.degradedCalls++;
  return { limited: true, count: null, degraded: true };
}

/** Window-bucketed key: all replicas in the same wall-clock window agree. */
export function windowKey(name, key, windowSeconds) {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  return `rl:${name}:${key}:${bucket}`;
}

/**
 * Spend one unit if the budget allows. ATOMIC: INCR is a single round trip, so
 * two replicas racing the same key cannot both see "1 left".
 *
 * Returns { limited, count, degraded }. `degraded` marks a Redis failure, where
 * we report limited:true — see the fail-closed note above.
 */
export async function spend(name, key, limit, windowSeconds) {
  const c = await getClient();
  if (!c) return degradedResult();
  const k = windowKey(name, key, windowSeconds);
  try {
    const n = await c.incr(k);
    // Set the TTL only on creation. Refreshing it on every hit would slide the
    // window forever under sustained traffic and the budget would never reset.
    if (n === 1) await c.expire(k, windowSeconds);
    if (n > limit) {
      // Give back the over-limit increment so a rejected caller cannot inflate
      // the counter and extend their own lockout indefinitely.
      await c.decr(k);
      return { limited: true, count: limit, degraded: false };
    }
    return { limited: false, count: n, degraded: false };
  } catch (e) {
    console.error("[shared-limit] spend failed:", e.message);
    return degradedResult();
  }
}

/** Read without spending. Same fail-closed rule. */
export async function peek(name, key, limit, windowSeconds) {
  const c = await getClient();
  if (!c) return degradedResult();
  try {
    const raw = await c.get(windowKey(name, key, windowSeconds));
    const n = Number(raw || 0);
    return { limited: n >= limit, count: n, degraded: false };
  } catch (e) {
    console.error("[shared-limit] peek failed:", e.message);
    return degradedResult();
  }
}

/**
 * Give back one unit. Used when the granted thing then FAILED: a trial charged
 * at grant time whose request returned >=400 never delivered anything, and the
 * caller should not lose their one free call to a malformed probe — the same
 * rule settlement ordering already applies to paying buyers.
 *
 * Floors at zero: a refund must never mint budget for a key that was never
 * charged.
 */
export async function refund(name, key, windowSeconds) {
  const c = await getClient();
  if (!c) return;
  const k = windowKey(name, key, windowSeconds);
  try {
    const n = await c.decr(k);
    if (n < 0) await c.set(k, "0", { KEEPTTL: true });
  } catch (e) {
    console.error("[shared-limit] refund failed:", e.message);
  }
}
