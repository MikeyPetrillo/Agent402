// Re-plans that cost us a planner run and were never paid.
//
// `replan: true` runs the planner (a model call) before the plan's steps, and
// a request that then ends in a 4xx is never settled. A wallet that keeps
// sending re-plans whose runs end that way (params no step can take, for
// example) would buy planner runs for nothing. Each such re-plan is counted
// per payer; past the limit in the window, `replan` is refused before the
// planner until the window passes. A re-plan whose run is paid never counts,
// and a run of the saved plan (no `replan`) is never limited.
//
// The count is shared across containers through the same Redis counters the
// rate limits use. When the shared counter cannot be read, this process keeps
// its own count instead of refusing: a cost guard that failed closed would
// refuse paying buyers during a Redis blip.
import { sharedLimitEnabled, peek, spend } from "../shared-limit.js";

export const REPLAN_UNCHARGED_WINDOW_S = 3600;
export function replanUnchargedLimit(env = process.env) {
  const n = Number(env.DECIDE_REPLAN_UNCHARGED_PER_HOUR);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}
const NAME = "decide-replan-uncharged";

/** In-process counts, by payer and window bucket. */
export function createLocalReplanGuard({ limit = replanUnchargedLimit(), windowS = REPLAN_UNCHARGED_WINDOW_S, nowMs = () => Date.now() } = {}) {
  const counts = new Map();
  const keyOf = (who) => `${who}|${Math.floor(nowMs() / 1000 / windowS)}`;
  return {
    limit,
    async blocked(who) { return (counts.get(keyOf(who)) || 0) >= limit; },
    async note(who) {
      const k = keyOf(who);
      counts.set(k, (counts.get(k) || 0) + 1);
      if (counts.size > 10_000) for (const old of [...counts.keys()].slice(0, 5_000)) counts.delete(old);
    },
  };
}

/** Shared counts when Redis is configured and answering, else this process's. */
export function createReplanGuard({ limit = replanUnchargedLimit(), windowS = REPLAN_UNCHARGED_WINDOW_S } = {}) {
  const local = createLocalReplanGuard({ limit, windowS });
  return {
    limit,
    async blocked(who) {
      if (!sharedLimitEnabled()) return local.blocked(who);
      const r = await peek(NAME, who, limit, windowS);
      return r.degraded ? local.blocked(who) : r.limited;
    },
    async note(who) {
      await local.note(who);
      if (sharedLimitEnabled()) await spend(NAME, who, Number.MAX_SAFE_INTEGER, windowS);
    },
  };
}
