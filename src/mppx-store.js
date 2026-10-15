// The store mppx keeps its own Tempo charge replay claims in.
//
// mppx's tempo/charge claims every transaction hash it settles (a push
// credential's hash, a pull transaction's pre-broadcast and final hash) in a
// Store.AtomicStore, and refuses a second claim with CredentialReplayedError.
// Left unset it falls back to an in-memory Map, which only covers one process:
// two replicas could each accept the same push credential. This store puts the
// claims in Redis when REDIS_URL is configured (the one connection
// shared-limit.js already holds, via getSharedRedisClient), so every replica
// reads and writes the same claim, and in a per-process memory store
// otherwise.
//
// Fail direction: OPEN to the per-process store, the same choice
// src/replay-guard.js makes and for the same reason. These claims are
// defense-in-depth: a pull transaction can be mined once, a push transfer's
// memo is bound to one challenge id, and the Tempo gate's own replay guard
// claims that challenge id first. Failing closed would refuse a buyer whose
// push transfer is already on chain. While Redis is unreachable the guarantee
// is exactly the single-process one, and every degraded call logs.
//
// Claims are written with a TTL at the claim's own expiry (the challenge's),
// so Redis never accumulates spent markers. Values round-trip through ox's
// Json, the serializer mppx's own stores use (it keeps bigints intact).
import { Json } from "ox";
import { Store } from "mppx";
import { getSharedRedisClient } from "./shared-limit.js";

export const MPPX_STORE_PREFIX = "mppx-store:";
// A value that is not a replay marker carries no expiry of its own (mppx's
// sponsor-budget state, unused while this server sponsors no fees). It is kept
// a day, far past any challenge window.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 1000;
// Each lost race means another writer landed, so contention of N writers on
// one key needs up to N rounds; a short jittered pause spreads them out.
const CAS_ATTEMPTS = 32;
const casPause = (attempt) => new Promise((r) => setTimeout(r, Math.floor(Math.random() * Math.min(25, 2 + attempt * 2))));

// Compare-and-set in one round trip: apply ARGV[3] (set or delete) only while
// the key still holds what the caller read (ARGV[1] = "1" means it read none).
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if ARGV[1] == '1' then
  if cur then return 0 end
elseif cur ~= ARGV[2] then
  return 0
end
if ARGV[3] == 'set' then
  redis.call('SET', KEYS[1], ARGV[4], 'PX', ARGV[5])
else
  redis.call('DEL', KEYS[1])
end
return 1
`;

function isReplayMarker(v) {
  return v !== null && typeof v === "object" && v.type === "mppx:replay" && typeof v.expires === "number";
}
function ttlMsFor(value, now = Date.now()) {
  if (isReplayMarker(value)) return Math.max(MIN_TTL_MS, Math.ceil(value.expires - now));
  return DEFAULT_TTL_MS;
}

/** A Store.AtomicStore for mppx server methods. `getClient` resolves to a
 *  connected node-redis client or null (not configured or unreachable);
 *  the default is the process's shared connection. Exported for tests. */
export function createMppxStore({ getClient = getSharedRedisClient, prefix = MPPX_STORE_PREFIX, log = (m) => console.warn(m) } = {}) {
  const local = Store.memory();
  let lastDegradedLog = 0;
  const degraded = (op, e) => {
    const now = Date.now();
    if (now - lastDegradedLog < 60_000) return;
    lastDegradedLog = now;
    try { log(`[mppx-store] redis ${op} failed, using this process's store (claims are not shared until redis answers): ${String(e?.message || e).slice(0, 200)}`); } catch { /* logging never throws */ }
  };
  async function redis() {
    try { return await getClient(); } catch { return null; }
  }
  const k = (key) => `${prefix}${key}`;

  return {
    /** Where claims go right now: "redis" or "memory". For status and tests. */
    async backend() { return (await redis()) ? "redis" : "memory"; },
    async get(key) {
      const c = await redis();
      if (c) {
        try {
          const raw = await c.get(k(key));
          return raw == null ? null : Json.parse(raw);
        } catch (e) { degraded("get", e); }
      }
      return local.get(key);
    },
    async put(key, value) {
      const c = await redis();
      if (c) {
        try { await c.set(k(key), Json.stringify(value), { PX: ttlMsFor(value) }); return; } catch (e) { degraded("put", e); }
      }
      await local.put(key, value);
    },
    async delete(key) {
      // Both: a claim made while redis was unreachable lives locally.
      await local.delete(key);
      const c = await redis();
      if (c) {
        try { await c.del(k(key)); } catch (e) { degraded("delete", e); }
      }
    },
    /** Atomic first-use claim through `expires` (ms): SET NX with that TTL. */
    async tryClaim(key, expires) {
      const c = await redis();
      if (c) {
        try {
          const marker = { expires, type: "mppx:replay" };
          const reply = await c.set(k(key), Json.stringify(marker), { NX: true, PX: ttlMsFor(marker) });
          return reply === "OK";
        } catch (e) { degraded("tryClaim", e); }
      }
      return local.tryClaim(key, expires);
    },
    /** Read, compute the change, and apply it only if the key is unchanged;
     *  retried on a concurrent write. */
    async update(key, fn) {
      const c = await redis();
      if (c) {
        try {
          for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
            const raw = await c.get(k(key));
            const change = fn(raw == null ? null : Json.parse(raw));
            if (change.op === "noop") return change.result;
            const value = change.op === "set" ? Json.stringify(change.value) : "";
            const applied = await c.eval(CAS_SCRIPT, {
              keys: [k(key)],
              arguments: [raw == null ? "1" : "0", raw == null ? "" : raw, change.op === "set" ? "set" : "delete", value, String(change.op === "set" ? ttlMsFor(change.value) : 0)],
            });
            if (Number(applied) === 1) return change.result;
            await casPause(attempt);
          }
          throw new Error(`mppx store update for ${key} lost ${CAS_ATTEMPTS} races in a row`);
        } catch (e) {
          if (/lost \d+ races/.test(String(e?.message))) throw e;
          degraded("update", e);
        }
      }
      return local.update(key, fn);
    },
  };
}

let shared = null;
/** The one store this process hands every mppx Tempo charge method. */
export function mppxReplayStore() {
  if (!shared) shared = createMppxStore();
  return shared;
}
