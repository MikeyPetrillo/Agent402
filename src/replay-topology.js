// When a paid call needs the SHARED replay claim (Redis) and is refused if
// the shared store is configured but does not answer, instead of falling
// back to a per-process claim. A per-process claim is a complete guarantee
// only while this container is the only one serving: two containers each
// holding their own claim could run one signed payment twice.
//
// More than one container may be live when:
//   - more than one replica is configured (STATE_DB_REPLICAS, else
//     RATE_LIMIT_REPLICAS, as for leases: src/state-db.js leaseReplicas);
//   - this container started less than DEPLOY_OVERLAP_SECONDS ago (default
//     120): during a rolling deploy the old container still serves beside it;
//   - this container is draining (SIGTERM): its replacement is already live.
// A long-running or composite route always needs it (its run outlives the
// overlap window, so the window cannot vouch for it).
import { leaseReplicas } from "./state-db.js";

const bootedAt = Date.now();

export function deployOverlapMs(env = process.env) {
  const n = Number(env.DEPLOY_OVERLAP_SECONDS);
  return (Number.isFinite(n) && n >= 0 ? n : 120) * 1000;
}

/** Whether more than one container may be serving right now. */
export function mayHaveSiblings({ env = process.env, now = Date.now(), startedAt = bootedAt, draining = false } = {}) {
  if (leaseReplicas(env) > 1) return true;
  if (draining) return true;
  return now - startedAt < deployOverlapMs(env);
}

/** requireShared for replayGuard.begin. */
export function sharedClaimRequired({ longRunning = false, ...opts } = {}) {
  return !!longRunning || mayHaveSiblings(opts);
}
