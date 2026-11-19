// One bound for every command sent to the shared Redis, in a module of its
// own with no state: importing it fixes nothing (src/shared-limits.js reads
// its mode once, at import, so a module that only needs the bound imports it
// from here).
import { withLoopTimeout } from "./loop-deadline.js";

/** A Redis command that neither answers nor fails within this is a failure (SHARED_LIMITS_OP_MS). */
export const OP_MS = () => Math.max(50, Number(process.env.SHARED_LIMITS_OP_MS) || 1_000);

/**
 * The shared Redis client with every command bounded: a method that answers a
 * promise rejects "command timed out" when no answer came within `ms` of loop
 * time (default OP_MS), so a connected Redis that stops answering fails the
 * caller's command instead of holding it for as long as the socket lives.
 * Anything else (a property, a method that answers no promise) passes
 * through. Null stays null.
 */
export function boundedRedisClient(c, ms = OP_MS) {
  if (!c || typeof c !== "object") return c ?? null;
  const limit = () => (typeof ms === "function" ? ms() : ms);
  return new Proxy(c, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      return function boundedCommand(...args) {
        const out = v.apply(target, args);
        return out && typeof out.then === "function" ? withLoopTimeout(out, limit(), () => new Error("shared-limits: command timed out")) : out;
      };
    },
  });
}
