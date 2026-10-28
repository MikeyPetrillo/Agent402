// One Nominatim request per second for the whole service.
//
// The public Nominatim usage policy allows an absolute maximum of one request
// per second per application (operations.osmfoundation.org/policies/nominatim).
// Every replica sends from the same service, so the second is shared: with a
// shared store (src/shared-limits.js: REDIS_URL set, SHARED_LIMITS not off) a
// call claims the second with SET NX PX, and a call that finds it taken waits
// for it to free. Without a shared store, or when the store does not answer
// inside NOMINATIM_SHARED_DEADLINE_MS, this process spaces its own calls by
// one second per replica (RATE_LIMIT_REPLICAS), so N replicas together stay at
// one a second. A call that cannot get a slot within NOMINATIM_PACE_WAIT_MS
// is refused here and the geo kit answers from its fallback geocoder instead
// of queueing. Repeat queries are answered by the response cache
// (src/cache.js), which the policy also asks for.
import { getSharedRedisClient } from "../shared-limit.js";
import { sharedLimitsEnabled, keyOf, noteSharedLimitsDegraded } from "../shared-limits.js";

const SLOT_MS = 1000;
const envMs = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
const waitBudgetMs = () => envMs("NOMINATIM_PACE_WAIT_MS", 2500);
const sharedDeadlineMs = () => envMs("NOMINATIM_SHARED_DEADLINE_MS", 250);
const replicas = () => Math.max(1, Math.floor(Number(process.env.RATE_LIMIT_REPLICAS) || 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function within(p, ms) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

let localNextAt = 0;
const counts = { shared: 0, local: 0, refused: 0 };

// This process's own spacing: reserve the next free slot if it starts inside
// the wait budget, then wait for it.
async function localSlot(deadline, now = Date.now()) {
  const at = Math.max(now, localNextAt);
  if (at > deadline) return false;
  localNextAt = at + SLOT_MS * replicas();
  if (at > now) await sleep(at - now);
  counts.local++;
  return true;
}

/** Resolves true once this call holds the service's Nominatim second, false when none frees within the wait budget. */
export async function nominatimSlot() {
  const deadline = Date.now() + waitBudgetMs();
  if (sharedLimitsEnabled()) {
    try {
      const c = await getSharedRedisClient();
      if (!c) throw new Error("redis unavailable");
      const key = keyOf("nominatim-slot", "all");
      for (;;) {
        const got = await within(c.set(key, String(process.pid), { NX: true, PX: SLOT_MS }), sharedDeadlineMs());
        if (got === "OK") { counts.shared++; return true; }
        const ttl = Number(await within(c.pTTL(key), sharedDeadlineMs()));
        const waitMs = ttl > 0 ? ttl : 50;
        if (Date.now() + waitMs > deadline) { counts.refused++; return false; }
        await sleep(waitMs);
      }
    } catch (e) {
      noteSharedLimitsDegraded("nominatim-pace", { error: e?.message });
    }
  }
  const ok = await localSlot(deadline);
  if (!ok) counts.refused++;
  return ok;
}

export function nominatimPaceCounts() { return { ...counts }; }
export function _resetNominatimPace() { localNextAt = 0; counts.shared = 0; counts.local = 0; counts.refused = 0; }
