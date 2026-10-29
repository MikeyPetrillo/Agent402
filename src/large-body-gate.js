// The gate in front of the routes that take a body larger than the global
// 100 KB parser allows (image edits, vision and document judging, frame
// checks, transcriptions). Mounted before their body parsers, so it decides
// from the headers alone, before a byte of the body is read:
//
//   - a body sent with a Content-Encoding is refused (415); the parsers on
//     these routes also run with inflate off, so the decoded size of a body
//     is never more than what crossed the wire;
//   - a request without a plausible payment credential (isPaid) whose body is
//     over UNPAID_BODY_MAX_BYTES is answered without reading the body when
//     its price does not depend on the body (bodyQuoted false): the 402 it
//     gets is the one the full body would get, and the body is discarded by
//     the server as it arrives instead of being parsed;
//   - an unpaid body over that size that is parsed anyway (its price is read
//     from it) passes a per-client limiter first;
//   - every parse reserves its declared size (the route's limit when the
//     length is not declared) against one in-flight budget for the process
//     and is refused with a 503 and Retry-After when the budget is spent; the
//     reservation is released when the response finishes or the connection
//     closes.
//
// A route's own parser still enforces its limit with a 413; a body declared
// over that limit is left to it and reserves nothing.
export const UNPAID_BODY_MAX_BYTES = 100 * 1024;
export const DEFAULT_INFLIGHT_MAX_BYTES = 256 * 1024 * 1024;

export function largeBodyInflightMaxBytes(env = process.env) {
  const mb = Number(env.LARGE_BODY_INFLIGHT_MAX_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : DEFAULT_INFLIGHT_MAX_BYTES;
}

/**
 * @param {object} o
 * @param {Array<[string, number]>} o.routes  path and its largest parser limit in bytes
 * @param {(req) => boolean} o.isPaid         a plausible payment credential is present
 * @param {(req) => boolean} [o.bodyQuoted]   the route's price is read from its body
 * @param {boolean} [o.freeMode]              every call is served without payment
 * @param {{check: (key: string) => {limited: boolean}}} [o.unpaidLimiter]
 * @param {(req) => string} [o.clientKey]
 * @param {number} [o.maxInflightBytes]
 */
export function createLargeBodyGate({ routes, isPaid, bodyQuoted = () => false, freeMode = false, unpaidLimiter = null, clientKey = (req) => String(req.ip || ""), maxInflightBytes = DEFAULT_INFLIGHT_MAX_BYTES }) {
  const limits = new Map(routes);
  let inFlight = 0;
  function gate(req, res, next) {
    if (req.method !== "POST") return next();
    // Routing is case-insensitive and ignores a trailing slash; so is this.
    const limit = limits.get(String(req.path || "").toLowerCase().replace(/\/+$/, ""));
    if (!limit) return next();
    const enc = String(req.headers["content-encoding"] || "").trim().toLowerCase();
    if (enc && enc !== "identity") {
      return res.status(415).json({ error: "unsupported-content-encoding", hint: "Send this body uncompressed: this route does not accept a Content-Encoding." });
    }
    const lenHeader = req.headers["content-length"];
    const declared = typeof lenHeader === "string" && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null;
    const hasBody = declared === null ? req.headers["transfer-encoding"] !== undefined : declared > 0;
    if (!hasBody) return next();
    const size = declared ?? limit;
    if (!freeMode && size > UNPAID_BODY_MAX_BYTES && !isPaid(req)) {
      if (!bodyQuoted(req)) {
        req.body = {};
        Object.defineProperty(req, "__bodyUnread", { value: true, enumerable: false });
        return next();
      }
      if (unpaidLimiter && unpaidLimiter.check(clientKey(req)).limited) {
        res.set("Retry-After", "60");
        return res.status(429).json({ error: "Too many unpaid requests with a body to this route from this address; send the paid call, or slow down." });
      }
    }
    if (size > limit) return next();
    if (inFlight + size > maxInflightBytes) {
      res.set("Retry-After", "5");
      return res.status(503).json({ error: "busy", hint: "This host is reading other large request bodies right now; retry in a few seconds. Nothing was charged." });
    }
    inFlight += size;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight -= size; } };
    res.on("finish", release);
    res.on("close", release);
    next();
  }
  gate.inFlightBytes = () => inFlight;
  return gate;
}

/** A body parser that leaves a body the gate chose not to read alone. */
export function unlessBodyUnread(parser) {
  return (req, res, next) => (req.__bodyUnread ? next() : parser(req, res, next));
}
