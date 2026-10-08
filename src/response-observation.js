// Did the seller keep the promise their OpenAPI made?
//
// response-contract.js reports what a seller DECLARES about a paid response.
// That is a claim, and every projection says so with runtimeVerified:false. A
// declared schema and a delivered payload are different things, and only one of
// them costs a buyer money.
//
// The router already buys from external sellers to resell and already sees
// what comes back. So the verification is free: on a settled 200, check whether
// the paths the seller guaranteed were actually present, and remember only the
// verdict.
//
// WHAT THIS DELIBERATELY NEVER STORES: the response. Not the values, not the
// undeclared keys, not a sample, not a hash of one. That payload is what the
// buyer paid for; we are the reseller that happened to fetch it, and
// keeping any of it would be a leak dressed up as telemetry. The only thing
// recorded is, for each path the SELLER ITSELF chose to promise, whether it was
// there. A seller who declares nothing is never observed at all - there is no
// promise to check, and "what did this response contain" is not our question to
// ask.

const MAX_ROUTES = 5000;          // bounded like every other crawl-side map
const MAX_PATHS_PER_ROUTE = 64;   // matches the contract's own path cap
const WINDOW = 20;                // last N paid calls per route

const store = new Map();          // "METHOD origin+route" -> record
const key = (origin, method, route) => `${String(method || "POST").toUpperCase()} ${origin}${route}`;

/** Is a dotted path present in a parsed JSON body?
 *
 *  Presence, never value: `null` counts as present, because the seller promised
 *  the FIELD and null is a value they are entitled to send. Judging their
 *  values would be us deciding what their data should say. */
export function pathPresent(body, path) {
  if (body === null || typeof body !== "object") return false;
  let node = body;
  for (const seg of String(path).split(".")) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
    if (!Object.prototype.hasOwnProperty.call(node, seg)) return false;
    node = node[seg];
  }
  return true;
}

/**
 * Record one settled paid call against what the seller guaranteed.
 *
 * Only called for an external seller, only on a settled 200, and only when the
 * seller declared something to check. Never throws: a defect in observation
 * must not fail a call the buyer has already paid for.
 *
 * @param {object} p
 * @param {string[]} p.guaranteedPaths  what the seller's own document promised
 * @param {unknown} p.body              the delivered response (READ, never kept)
 */
export function observeDelivery({ origin, method, route, guaranteedPaths, body, now = Date.now } = {}) {
  try {
    if (!origin || !route) return null;
    const paths = (Array.isArray(guaranteedPaths) ? guaranteedPaths : []).slice(0, MAX_PATHS_PER_ROUTE);
    if (!paths.length) return null;              // no promise, nothing to verify
    const k = key(origin, method, route);
    // Bounded: drop the oldest route rather than growing without limit. This
    // map is observation, so losing the least recently used one costs nothing
    // that a later call cannot re-establish.
    if (!store.has(k) && store.size >= MAX_ROUTES) store.delete(store.keys().next().value);

    const missing = paths.filter((p) => !pathPresent(body, p));
    const prev = store.get(k) || { calls: 0, kept: 0, lastMissing: [], firstSeenAt: now(), lastSeenAt: 0 };
    const rec = {
      calls: Math.min(prev.calls + 1, WINDOW * 1000),
      kept: prev.kept + (missing.length ? 0 : 1),
      // Only the NAMES the seller themselves published, so this carries nothing
      // the seller has not already put in a public document.
      lastMissing: missing.slice(0, MAX_PATHS_PER_ROUTE),
      firstSeenAt: prev.firstSeenAt,
      lastSeenAt: now(),
    };
    store.set(k, rec);
    return rec;
  } catch {
    return null;   // never break a paid call to record a statistic about it
  }
}

/** What we have actually observed for a route, or null when we have never
 *  bought it. Null means UNOBSERVED and must never be rendered as a pass. */
export function deliveryObservation(origin, method, route) {
  const rec = store.get(key(origin, method, route));
  if (!rec || !rec.calls) return null;
  return {
    calls: rec.calls,
    kept: rec.kept,
    // A route bought once that delivered once is not "100% reliable", and a
    // rate alone invites reading it that way. The count travels with it.
    keptRate: Number((rec.kept / rec.calls).toFixed(3)),
    lastMissing: rec.lastMissing,
    lastSeenAt: new Date(rec.lastSeenAt).toISOString(),
  };
}

/** Spread into a public tool row. Absent when we have never paid for it, so a
 *  consumer can tell "we checked and it delivered" from "we never looked". */
export function deliveryProjection(origin, method, route) {
  const o = deliveryObservation(origin, method, route);
  return o ? { responseDelivery: { ...o, source: "agent402_paid_call" } } : {};
}

export function __resetObservationsForTest() { store.clear(); }
export function __observationCountForTest() { return store.size; }
