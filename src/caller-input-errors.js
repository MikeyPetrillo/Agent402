// A field that cannot be coerced is the caller's 400, with the field named.
//
// JSON can carry an object whose own "toString" or "valueOf" is not a
// function ({"toString": 1}). JavaScript cannot turn such a value into text
// or a number: String(x), Number(x), `${x}` and x + "" all throw a TypeError.
// A tool that reads the field as a scalar then fails with a bare TypeError,
// which reads as a 500, a tool failure, when the input is the caller's to fix.
//
// The catalog wraps each proof-of-work tool's handler once (src/server.js),
// so the HTTP route, the MCP connector and the skill packs answer alike. The
// rule is narrow on purpose: a bare TypeError or RangeError becomes a 400 ONLY
// when the input holds such a value, and the answer names where. Any other
// bare error stays what it is, a 500 that the failure monitor counts, so a
// defect in a tool is never dressed as bad input.
//
// Pure module: no imports.

const MAX_NODES = 10_000;
const keyPath = (path, key) => (typeof key === "number" ? `${path}[${key}]` : path ? (/^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`) : String(key));

/**
 * Where `value` holds an object whose own "toString" or "valueOf" is not a
 * function: { path, key } for the first one found (path "" is the value
 * itself), or null. Reads at most MAX_NODES nodes.
 */
export function uncoercibleAt(value, max = MAX_NODES) {
  const stack = [{ v: value, path: "" }];
  let seen = 0;
  while (stack.length && seen++ < max) {
    const { v, path } = stack.pop();
    if (v === null || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) if (v[i] !== null && typeof v[i] === "object") stack.push({ v: v[i], path: keyPath(path, i) });
      continue;
    }
    for (const k of ["toString", "valueOf"]) if (Object.hasOwn(v, k) && typeof v[k] !== "function") return { path, key: k };
    const keys = Object.keys(v);
    for (let i = keys.length - 1; i >= 0; i--) { const c = v[keys[i]]; if (c !== null && typeof c === "object") stack.push({ v: c, path: keyPath(path, keys[i]) }); }
  }
  return null;
}

/** True when `value` holds such an object at any depth. */
export function holdsUncoercible(value, max = MAX_NODES) {
  return uncoercibleAt(value, max) !== null;
}

const isBare = (err) => !!err && (err.statusCode
  // A worker pool hands an error back as a plain Error with a 500 and the
  // name it was thrown under (`threw`), set only when it carried no status.
  ? err.statusCode === 500 && (err.threw === "TypeError" || err.threw === "RangeError")
  : err instanceof TypeError || err instanceof RangeError);

/**
 * The 400 a caller reads when `err` is a bare TypeError or RangeError AND
 * `input` holds a value that cannot be coerced; otherwise `err` itself.
 */
export function callerInputError(err, input) {
  if (!isBare(err)) return err;
  const at = uncoercibleAt(input);
  if (!at) return err;
  const out = new Error(`${at.path ? `"${at.path}"` : "The input"} holds an object whose "${at.key}" is not a function, so it cannot be read as text or a number; send a string or a number there`);
  out.statusCode = 400;
  out.field = at.path;
  out.cause = err;
  return out;
}

/** `handler`, with that failure answered as a 400. */
export function withCallerInputErrors(handler) {
  return async (input, ctx) => {
    try { return await handler(input, ctx); }
    catch (err) { throw callerInputError(err, input); }
  };
}

/** `v`, or undefined when it cannot be read as text (String(v) throws). */
export function readableAsText(v) {
  if (v === null || v === undefined || typeof v !== "object") return v;
  try { String(v); return v; } catch { return undefined; }
}
