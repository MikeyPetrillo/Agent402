// The UTF-8 length of a value as JSON.stringify writes it, for a tool that
// bounds the size of its answer while it builds it. Measured, never estimated:
// a number is its printed digits ("1.7976931348623157e+308" is 23), a string
// counts its escapes ("\u0001" is 6) and its multi-byte characters, so a
// budget charged with these lengths is the answer's size on the wire.

// Printable ASCII with no quote or backslash: written as is, one byte each.
const PLAIN = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;

/** Bytes of `s` written as a JSON string, quotes included. */
export function jsonStringBytes(s) {
  if (PLAIN.test(s)) return s.length + 2;
  return Buffer.byteLength(JSON.stringify(s), "utf8");
}

/** Bytes of a scalar (string, number, boolean, null) written as JSON. A value
 *  JSON drops or cannot write (undefined, a function) is counted as `null`. */
export function jsonLeafBytes(v) {
  if (typeof v === "string") return jsonStringBytes(v);
  const j = typeof v === "bigint" ? undefined : JSON.stringify(v);
  return j === undefined ? 4 : Buffer.byteLength(j, "utf8");
}

/** Bytes of any JSON value written compactly. Each object or array measured is
 *  kept in `cache` (a WeakMap the caller may share across calls), so a subtree
 *  is measured once however often it is placed. The walk is iterative, so a
 *  deeply nested value never deepens the stack. */
export function jsonValueBytes(value, cache = new WeakMap()) {
  if (value === null || typeof value !== "object") return jsonLeafBytes(value);
  if (cache.has(value)) return cache.get(value);
  const stack = [value];
  const open = new Set();
  while (stack.length) {
    const node = stack[stack.length - 1];
    if (cache.has(node)) { stack.pop(); continue; }
    const kids = Array.isArray(node) ? node : Object.values(node);
    if (!open.has(node)) {
      open.add(node);
      for (const k of kids) if (k !== null && typeof k === "object" && !cache.has(k) && !open.has(k)) stack.push(k);
      continue;
    }
    stack.pop();
    open.delete(node);
    const size = (v) => (v !== null && typeof v === "object" ? (cache.get(v) ?? 4) : jsonLeafBytes(v));
    let n = 2 + kids.length; // brackets and commas (one more than written)
    if (Array.isArray(node)) for (const v of node) n += size(v);
    else for (const k of Object.keys(node)) n += jsonStringBytes(k) + 1 + size(node[k]);
    cache.set(node, n);
  }
  return cache.get(value);
}
