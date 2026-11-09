// The URL an outside GET or HEAD seller is asked for: its listing URL with the
// caller's params as the query. ONE builder for the resolver's unpaid probe
// (src/server.js resolveExternalSeller) and the paid call (route-execute), so
// the URL probed is the URL paid. A GET cannot carry a body, so only
// primitives ride the query; a nested param is the caller's input mismatch,
// said plainly. Every other method keeps its listing URL and its JSON body.
//
// The query is built by URLSearchParams, which percent-encodes every byte that
// could end the query or name another authority, so a param value can only
// ever change the query: the origin and path stay the listing's, and the SSRF
// guard (assertPublicUrl and the pinned dispatcher) reads the bound URL.

// The same bound route-execute holds a caller's `target` URL to.
export const BOUND_URL_MAX_CHARS = 2048;

export function isQueryMethod(method) {
  const m = String(method || "POST").toUpperCase();
  return m === "GET" || m === "HEAD";
}

function refuse(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

export function boundRequestUrl(listingUrl, { method = "POST", params = {}, slug = "" } = {}) {
  const m = String(method || "POST").toUpperCase();
  if (!isQueryMethod(m)) return listingUrl;
  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null) continue;
    if (typeof v === "object" || typeof v === "function") throw refuse(`External tool "${slug}" is a ${m} endpoint - param "${k}" must be a string, number, or boolean`);
    qp.set(k, String(v));
  }
  const qs = qp.toString();
  if (!qs) return listingUrl;
  let out;
  try {
    const u = new URL(String(listingUrl));
    u.search = u.search ? `${u.search.slice(1)}&${qs}` : qs;
    out = u.href;
  } catch {
    out = `${listingUrl}${String(listingUrl).includes("?") ? "&" : "?"}${qs}`;
  }
  if (out.length > BOUND_URL_MAX_CHARS) throw refuse(`External tool "${slug}" is a ${m} endpoint - its params make a ${out.length}-character URL (max ${BOUND_URL_MAX_CHARS}). Nothing was spent and nothing is charged.`);
  return out;
}
