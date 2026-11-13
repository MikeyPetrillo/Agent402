// Did the seller keep the promise their OpenAPI made?
//
// response-contract.js reports what a seller DECLARES about a paid response.
// That is a claim, and every projection says so with runtimeVerified:false. A
// declared schema and a delivered payload are different things, and only one of
// them costs a buyer money.
//
// The router already buys from external sellers to resell and already sees
// what comes back. So the verification is free: on a settled 200 (and on a 200
// the seller sent without taking payment that answers nothing), check whether
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
const WINDOW = 20;                // last N observed calls per route

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

// The bodies our own readers built in place of the seller's (cut at our byte
// limit, or unreadable), each with the kind of stand-in it is. A WeakMap keyed
// on the objects themselves: a seller's JSON can carry `_truncated`,
// `relayError`, `raw`, `text` or `value`, but never one of these identities,
// so a stand-in's kind is read from the mark, never from its keys.
//   json        a cut JSON object prefix plus our `_truncated` key (default)
//   wrapped     our `{ value }` wrapper around a cut prefix that was not an
//               object (an array or a scalar)
//   unreadable  our `{ relayError }`: the body could not be read at all
//   raw         the x402 reader's `{ raw[, _truncated] }` reading of bytes
//               that were not JSON
//   text        the Tempo reader's `{ text, truncated, contentType, sha256 }`
//               reading of bytes that were not JSON
const NOT_SELLER_BODY = new WeakMap();
const STAND_IN_KINDS = new Set(["json", "wrapped", "unreadable", "raw", "text"]);
/** Mark a body our reader cut or could not read, so delivery is not judged on
 *  it, with the kind of stand-in it is (above). `{ wrapped: true }` is the
 *  same as `{ kind: "wrapped" }`. Returns the body. */
export function markNotSellerBody(body, { kind, wrapped = false } = {}) {
  if (body && typeof body === "object") {
    const k = wrapped ? "wrapped" : kind;
    NOT_SELLER_BODY.set(body, STAND_IN_KINDS.has(k) ? k : "json");
  }
  return body;
}

/** What the seller sent, read back from a stand-in our readers built:
 *  { unreadable }, { text, cut } (the Tempo reader's text reading, the x402
 *  reader's { raw }) or { json, cut } (a JSON prefix cut at our byte limit,
 *  our `_truncated` key taken off, or the value inside our `{ value }`
 *  wrapper). The branch is chosen by the mark our reader set, never by a
 *  key's name, so a seller's cut prefix is always judged as its own JSON. */
function standInSent(body) {
  switch (NOT_SELLER_BODY.get(body)) {
    case "unreadable": return { unreadable: true };
    case "text": return { text: String(body.text ?? ""), cut: body.truncated === true };
    case "raw": return { text: String(body.raw ?? ""), cut: body._truncated === true };
    case "wrapped": return { json: body.value, cut: body._truncated === true };
    default: { const { _truncated, ...rest } = body; return { json: rest, cut: _truncated === true }; }
  }
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
 * Record one call to a seller's paid route against what the seller guaranteed.
 *
 * Only called for an external seller, only when the seller declared something
 * to check, and only on a 200: one the router paid for and settled, or one the
 * seller sent without taking payment that the router refused to resell
 * (unpaidNonAnswerReason), which counts as a promise not kept. Both land in the
 * same per-route record. Never throws: a defect in observation must not fail a
 * call the buyer has already paid for.
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
    // A body our reader could not read at all (the seller settled, then cut
    // or reset the answer) cannot be judged, so it is counted as unverifiable,
    // as a cut is: a seller that aborts after settling never keeps a clean
    // record. Recognized by the object identity our own readers mark
    // (markNotSellerBody), never by a key, since a seller can send any
    // key. A body our reader holds whole (a non-JSON answer to a route that
    // promised JSON paths) is the seller's delivery: it is read back and
    // judged on the seller's bytes, never on our stand-in's keys, so a missed
    // promise is counted.
    // A body cut at our byte limit is the seller's choice of size, so it never
    // leaves the record untouched. A cut whose prefix parses to an object or
    // an array closed that document (only trailing bytes went unread) and is
    // judged on it. Any other cut (a prefix that does not parse, or parses only
    // as a scalar a longer body would extend) cannot be judged: it is counted
    // as unverifiable, beside calls and kept, so padding an answer past the
    // limit shows in the record instead of keeping it clean.
    let unverifiable = false;
    if (body && typeof body === "object" && NOT_SELLER_BODY.has(body)) {
      const sent = standInSent(body);
      if (sent.unreadable) unverifiable = true;
      else {
        let read;
        if ("json" in sent) read = sent.json;
        else { try { read = JSON.parse(sent.text); } catch { read = undefined; } }
        if (sent.cut && !(read !== null && typeof read === "object")) unverifiable = true;
        body = read === undefined ? null : read;
      }
    }
    const k = key(origin, method, route);
    // Bounded: drop the oldest route rather than growing without limit. This
    // map is observation, so losing the least recently used one costs nothing
    // that a later call cannot re-establish.
    if (!store.has(k) && store.size >= MAX_ROUTES) store.delete(store.keys().next().value);

    const prev = store.get(k) || { calls: 0, kept: 0, unverifiable: 0, lastMissing: [], firstSeenAt: now(), lastSeenAt: 0 };
    if (unverifiable) {
      const rec = { ...prev, unverifiable: Math.min((prev.unverifiable || 0) + 1, WINDOW * 1000), lastSeenAt: now() };
      store.set(k, rec);
      version++;
      return rec;
    }
    const missing = paths.filter((p) => !pathPresent(body, p));
    const rec = {
      calls: Math.min(prev.calls + 1, WINDOW * 1000),
      kept: prev.kept + (missing.length ? 0 : 1),
      unverifiable: prev.unverifiable || 0,
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
  if (!rec || !(rec.calls || rec.unverifiable)) return null;
  return {
    calls: rec.calls,
    kept: rec.kept,
    // A route bought once that delivered once is not "100% reliable", and a
    // rate alone invites reading it that way. The count travels with it.
    // Null when every call was unverifiable: no call could be judged.
    keptRate: rec.calls ? Number((rec.kept / rec.calls).toFixed(3)) : null,
    // Calls whose answer ran past our read limit in a form that cannot be
    // judged (counted apart from calls, never as kept).
    unverifiable: rec.unverifiable || 0,
    lastMissing: rec.lastMissing,
    lastSeenAt: new Date(rec.lastSeenAt).toISOString(),
  };
}

/** Spread into a public tool row. Absent when we have never called it, so a
 *  consumer can tell "we checked and it delivered" from "we never looked".
 *  `source` names the route's record as a whole (calls the router made to the
 *  seller's paid route, the unpaid non-answers included), not one call. */
export function deliveryProjection(origin, method, route) {
  const o = deliveryObservation(origin, method, route);
  return o ? { responseDelivery: { ...o, source: "agent402_paid_call" } } : {};
}

// The keys of an error envelope with no content: the {error, message, code}
// shape, GraphQL's top-level `errors`, RFC 7807 problem details (type, title,
// status, detail, instance), the ok/success flags and a reason, a framework's
// default error page (timestamp, path, trace), a retry hint, and the request
// or trace id an error page carries for support, the JSON-RPC frame (jsonrpc,
// id) and a payment challenge's frame (x402Version, accepts). Any other key holding a value
// carries content, so the body is the seller's answer even with an error
// beside it; a key holding null, "", {} or [] carries nothing.
const ERROR_ENVELOPE_KEYS = new Set([
  "error", "errors", "message", "ok", "success", "status", "statusCode", "code",
  "detail", "details", "type", "title", "instance", "reason",
  "requestId", "request_id", "traceId", "trace_id", "trace", "timestamp", "path",
  "jsonrpc", "id", "x402Version", "accepts",
  "retryAfter", "retry_after", "retryAfterSeconds", "retry_after_seconds", "retryAfterMs", "retry_after_ms",
]);

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
 *                   of ERROR_ENVELOPE_KEYS or holds no value (null, "", {},
 *                   []), unless the seller's own contract guarantees the
 *                   signaling key. Any other key holding a value, false and 0
 *                   included, is content (`{valid:false, errors}`,
 *                   `{data, errors}`, a health report with `ok:false`). A
 *                   404 or 410 envelope alone is not an answer either, so the
 *                   next seller is tried.
 *   missing-fields  the seller guaranteed response paths and none is present
 *   unreadable      our reader could not read the body at all
 * A stand-in our reader built (markNotSellerBody) is judged on the bytes the
 * seller sent, never on its own keys.
 * A top-level array or scalar is judged by the promised shape: the guaranteed
 * paths are object paths, so with any promised it is missing-fields; with
 * none, an array of no items (or only empty ones) or a blank string is empty,
 * and a number, a boolean, text or an array with an item is the answer.
 */
export function unpaidNonAnswerReason(body, guaranteedPaths = []) {
  if (body === null || body === undefined || body === "") return "empty";
  if (typeof body !== "object" || Array.isArray(body)) {
    if ((Array.isArray(guaranteedPaths) ? guaranteedPaths : []).length) return "missing-fields";
    const blank = (v) => v === null || v === undefined || (typeof v === "string" && !v.trim())
      || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
    if (Array.isArray(body)) return body.every(blank) ? "empty" : null;
    return blank(body) ? "empty" : null;
  }
  // A stand-in our own reader built is judged on what the seller sent, never
  // on the keys we wrote: an empty or blank body is empty, text that parses
  // as JSON is judged as that JSON, other text answers only a seller that
  // promised no JSON paths, and a body we could not read answers nothing.
  if (NOT_SELLER_BODY.has(body)) {
    const sent = standInSent(body);
    if (sent.unreadable) return "unreadable";
    if ("json" in sent) return unpaidNonAnswerReason(sent.json, guaranteedPaths);
    if (!sent.text.trim()) return "empty";
    if (!sent.cut) { try { return unpaidNonAnswerReason(JSON.parse(sent.text), guaranteedPaths); } catch { /* plain text */ } }
    return Array.isArray(guaranteedPaths) && guaranteedPaths.length ? "missing-fields" : null;
  }
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
    // A key counts as content only when it holds a value: false and 0 do.
    const holdsValue = (v) => v !== null && v !== undefined && v !== ""
      && !(Array.isArray(v) && v.length === 0) && !(isObj(v) && !hasKeys(v));
    let envelopeOnly = true;
    for (const k in body) {
      if (Object.hasOwn(body, k) && !ERROR_ENVELOPE_KEYS.has(k) && holdsValue(body[k])) { envelopeOnly = false; break; }
    }
    if (envelopeOnly) return "error-shaped";
  }
  if (paths.length && !paths.some((p) => pathPresent(body, p))) return "missing-fields";
  return null;
}

export function __resetObservationsForTest() { store.clear(); version++; }
export function __observationCountForTest() { return store.size; }
