// A caller's malformed input is a 400, wherever a pure-CPU tool notices it.
//
// A tool on the proof-of-work tier (src/free-tier.js) is a function of its
// input alone: no network, no key, no model, no stored state. Its handlers
// coerce fields as they go (String(x), Number(x), new Date(x).toISOString(),
// "x".repeat(n)), and JavaScript reports a field it cannot coerce by throwing
// a TypeError or a RangeError: an object whose "toString" is not a function,
// a date outside the range a Date holds, a structure nested past the stack.
// Thrown bare, that reads as a 500, a tool failure, when the tool did what it
// should and the input is the caller's to fix.
//
// The catalog wraps each such tool's handler once (src/server.js), so the
// HTTP route, the MCP connector and the skill packs all answer the same 400.
// A handler's own errors (anything carrying a statusCode) pass through, and
// so does every error on a tool that reaches the network or a model, where a
// TypeError can be a fault on our side.
//
// Pure module: no imports.

/** The 400 a caller reads for `err`, or `err` itself when it is not a coercion failure. */
export function callerInputError(err) {
  if (!err) return err;
  // A worker pool hands an error back as a plain Error with a 500 and the
  // name it was thrown under (`threw`), set only when it carried no status.
  const bare = err.statusCode ? (err.statusCode === 500 && (err.threw === "TypeError" || err.threw === "RangeError")) : (err instanceof TypeError || err instanceof RangeError);
  if (!bare) return err;
  const out = new Error(`Invalid input: ${String(err.message || err.name).split("\n")[0].slice(0, 200)}`);
  out.statusCode = 400;
  out.cause = err;
  return out;
}

/** `handler`, with a coercion failure answered as a 400. */
export function withCallerInputErrors(handler) {
  return async (input, ctx) => {
    try { return await handler(input, ctx); }
    catch (err) { throw callerInputError(err); }
  };
}

/**
 * True when `value` holds, at any depth, an object whose own "toString" or
 * "valueOf" is not a function: the shape String() and Number() throw on.
 * Reads at most `max` nodes.
 */
export function holdsUncoercible(value, max = 10_000) {
  const stack = [value];
  let seen = 0;
  while (stack.length && seen++ < max) {
    const v = stack.pop();
    if (v === null || typeof v !== "object") continue;
    if (!Array.isArray(v)) {
      for (const k of ["toString", "valueOf"]) if (Object.hasOwn(v, k) && typeof v[k] !== "function") return true;
    }
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push(child);
  }
  return false;
}

/** `v`, or undefined when it cannot be read as text (String(v) throws). */
export function readableAsText(v) {
  if (v === null || v === undefined || typeof v !== "object") return v;
  try { String(v); return v; } catch { return undefined; }
}
