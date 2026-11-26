// Sellers the router lists but never buys from. Discovery still lists them
// and a buyer can pay such a seller directly; only route-and-execute, which
// buys and hands the answer on, is refused. Every public surface says exactly
// that and nothing more (scripts/test-router-listed-only.js holds the wording).
//
// The list names no one: each entry is the sha256 (first 20 hex) of a
// lowercased registrable domain, the same digest scripts/gen-third-party-hashes.js
// writes, so this file passes scripts/test-no-third-party-names.js. A host
// matches when it, or any parent of it with at least two labels, hashes to a
// listed digest (a subdomain of a listed domain is the same seller).
// ROUTER_EXCLUDED_SELLER_HASHES adds digests (comma separated) at runtime.
import { createHash } from "node:crypto";

const digest = (s) => createHash("sha256").update(s).digest("hex").slice(0, 20);

// One entry per registrable domain, as a digest and nothing else.
const LISTED = Object.freeze([
  "009c8f68480ac4641fbc",
]);

let envRaw = null, envSet = new Set();
function listedSet(env = process.env) {
  const raw = String(env.ROUTER_EXCLUDED_SELLER_HASHES || "");
  if (raw !== envRaw) {
    envRaw = raw;
    envSet = new Set([...LISTED, ...raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f]{20}$/.test(s))]);
    cache.clear();
  }
  return envSet;
}

/** The lowercased hostname of a URL, an origin, a seller key (origin plus a
 *  path prefix) or a bare host; "" when none can be read. */
export function hostOf(ref) {
  const s = String(ref ?? "").trim();
  if (!s) return "";
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/\.+$/, ""); } catch { return ""; }
}

// Bounded memo: a page of index rows asks the same few hosts many times.
const cache = new Map();
const CACHE_MAX = 5000;

/** True when the router lists this seller and never buys from it (see above). */
export function sellerListedOnly(ref, { env = process.env } = {}) {
  const set = listedSet(env);
  const host = hostOf(ref);
  if (!host || !set.size) return false;
  const hit = cache.get(host);
  if (hit !== undefined) return hit;
  const labels = host.split(".");
  let out = false;
  for (let i = 0; i <= labels.length - 2 && !out; i++) out = set.has(digest(labels.slice(i).join(".")));
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(host, out);
  return out;
}

/** The thrown refusal a buyer raises before anything is signed. */
export function assertRouterBuysFrom(url) {
  if (sellerListedOnly(url)) {
    throw Object.assign(new Error("The router lists this seller and does not buy from it. Nothing was signed; a buyer can pay the seller directly."), { statusCode: 409, code: "listed_only" });
  }
}

export const __digestForTests = digest;
