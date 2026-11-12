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
// Bumped on every write, so the router worker's replica (src/router-pool.js)
// is re-sent only when an observation changed.
let version = 0;
export function observationsVersion() { return version; }
export function observationsSnapshot() { return [...store]; }
/** Replace this thread's observations with a shipped snapshot (worker only). */
export function applyObservationsSnapshot(rows) {
  store.clear();
  for (const [k, rec] of Array.isArray(rows) ? rows : []) store.set(k, rec);
  version++;
}

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
    // A body we cut at our own byte limit (readAfterSpend marks it
    // `_truncated`) or could not read is not what the seller sent: a missing
    // path there is ours, so the call is not observed either way.
    if (body && typeof body === "object" && (body._truncated === true || typeof body.relayError === "string")) return null;
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
    version++;
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

// The keys of an error envelope with no content: the {error, message, code}
// shape, GraphQL's top-level `errors`, RFC 7807 problem details (type, title,
// status, detail, instance), the ok/success flags, and the request or trace id
// and timestamp an error page carries for support. A body with any other key
// carries content, so it is the seller's answer even with an error beside it.
const ERROR_ENVELOPE_KEYS = new Set([
  "error", "errors", "message", "ok", "success", "status", "statusCode", "code",
  "detail", "details", "type", "title", "instance",
  "requestId", "request_id", "traceId", "trace_id", "timestamp",
]);
const NOT_FOUND_STATUSES = new Set([404, 410]);

/**
 * Is a 200 the seller sent WITHOUT taking payment an answer at all?
 *
 * The router resells such a 200 at its own tier price, so a body that answers
 * nothing must not be sold. Returns the reason (a fixed word, never seller
 * text) or null when the body reads as an answer. The rules are the ones the
 * answer classes use (src/answer-shape.js) plus the paid side's own signals:
 *   empty           no body: null, "", {}
 *   challenge       an x402 payment challenge (x402Version + accepts) sent
 *                   with a 200, so nothing was delivered
 *   error-shaped    an error envelope and nothing else: `error` set,
 *                   `errors` non-empty or `ok: false`, and every key is one
 *                   of ERROR_ENVELOPE_KEYS, unless the seller's own contract
 *                   guarantees the signaling key. Any other key is content
 *                   (`{valid:false, errors}`, `{data, errors}`, a health
 *                   report with `ok:false`), and so is a not-found status
 *                   (404, 410): for a lookup, absence is the answer.
 *   missing-fields  the seller guaranteed response paths and none is present
 * An empty array, a number or a string with text is the seller's answer.
 */
export function unpaidNonAnswerReason(body, guaranteedPaths = []) {
  if (body === null || body === undefined || body === "") return "empty";
  if (typeof body !== "object" || Array.isArray(body)) return null;
  const hasKeys = (o) => { for (const k in o) { if (Object.hasOwn(o, k)) return true; } return false; };
  if (!hasKeys(body)) return "empty";
  if (typeof body.x402Version === "number" && Array.isArray(body.accepts) && body.accepts.length > 0) return "challenge";
  const paths = (Array.isArray(guaranteedPaths) ? guaranteedPaths : []).slice(0, MAX_PATHS_PER_ROUTE).map(String);
  const promised = (k) => paths.some((p) => p === k || p.startsWith(`${k}.`));
  // answer-shape.js isSet / nonEmpty: an empty object is not set.
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const set = (v) => v !== null && v !== undefined && v !== false && v !== "" && !(isObj(v) && !hasKeys(v));
  const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : isObj(v) ? hasKeys(v) : set(v));
  const signaled = (!promised("error") && set(body.error))
    || (!promised("errors") && nonEmpty(body.errors))
    || (!promised("ok") && body.ok === false);
  if (signaled) {
    let envelopeOnly = true;
    for (const k in body) { if (Object.hasOwn(body, k) && !ERROR_ENVELOPE_KEYS.has(k)) { envelopeOnly = false; break; } }
    const notFound = [body.status, body.statusCode].some((v) => (typeof v === "number" || typeof v === "string") && NOT_FOUND_STATUSES.has(Number(v)));
    if (envelopeOnly && !notFound) return "error-shaped";
  }
  if (paths.length && !paths.some((p) => pathPresent(body, p))) return "missing-fields";
  return null;
}

export function __resetObservationsForTest() { store.clear(); version++; }
export function __observationCountForTest() { return store.size; }
