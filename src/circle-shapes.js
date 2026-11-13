// Shapes the Circle clients validate an upstream answer against, in one place
// so the facilitator client, the /supported parser, the pending book and the
// Gateway client agree on what an address or an id looks like.
// Dependency-free: src/circle-supported.js imports it, and that module runs in
// scripts/lib/rail-recovered.js without the package install.

export const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const TX = /^0x[0-9a-fA-F]{64}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const UINT = /^[0-9]{1,78}$/;
export const B32 = /^0x[0-9a-fA-F]{64}$/;
export const REASON = /^[a-z0-9_]{1,64}$/;
export const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
/** A payload field as text: the string itself, "" for anything else. A field
 *  a buyer sent as an object, number or array is never coerced (an object
 *  whose own toString is not a function would throw), so it fails the shape
 *  test it is read for and is refused as an invalid payload. */
export function txt(v) { return typeof v === "string" ? v : ""; }
/** A requirement amount as text: our own requirements carry a string, and a
 *  safe integer is read as its digits; anything else is "". */
export function uintText(v) { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : txt(v); }
export function lc(s) { return txt(s).toLowerCase(); }
