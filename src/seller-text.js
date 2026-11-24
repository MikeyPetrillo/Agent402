// A seller's documents are parsed JSON: a field that is text in one dialect
// is an object in another (an x402 v2 `resource` is `{ url, mimeType }`), and
// String() or a template literal turns an object into "[object Object]",
// which then reads as a route, a name or a URL. Every reader that takes a
// seller-supplied field as text goes through these, so a value that is not
// text is never coerced into one.

/** A seller field as text: a string as it is, a finite number or a boolean as
 *  its text, anything else (an object, an array, null) as "". */
export function sellerText(v) {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/** The first of the values that is non-empty text once trimmed, or "". */
export function firstSellerText(...values) {
  for (const v of values) {
    const s = sellerText(v).trim();
    if (s) return s;
  }
  return "";
}

/** A resource reference as text: a string as it is, or the string `url` of a
 *  resource object (the x402 v2 `{ url, mimeType }` shape); anything else "". */
export function resourceUrlText(v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && !Array.isArray(v) && typeof v.url === "string") return v.url;
  return "";
}

// "[object Object]", "[object Array]" and the like, written raw or encoded.
const COERCED_OBJECT = /\[object[\s%]|%5Bobject/i;
// Whitespace and control characters never belong in a stored route.
const ROUTE_BAD_CHARS = /[\s\u0000-\u001f\u007f]/;

/** True when a stored tool row's route is not a usable path: not a string,
 *  not starting with a single "/", carrying whitespace or a control
 *  character, or holding the text an object coerces to. */
export function malformedRoute(route) {
  if (typeof route !== "string" || route === "") return true;
  if (route.charCodeAt(0) !== 47 /* "/" */ || route.startsWith("//")) return true;
  if (ROUTE_BAD_CHARS.test(route)) return true;
  return COERCED_OBJECT.test(route);
}
