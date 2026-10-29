// How long a synchronous answer may take when the request came through the
// CDN proxy (req.viaCdn, src/cdn-client-ip.js). req.viaCdn is set only while
// CDN_PROXY is on and the request carried the origin secret, so with the
// switch off nothing here converts, refuses or bounds any request.
//
// The CDN proxy ends a request that has sent no response byte for 100 seconds.
// A request reached straight through the hosting edge has no such limit, so
// nothing here applies to it: req.cdnSyncDeadlineMs is set only on a CDN
// request, and every reader treats its absence as "no bound".
//
// Three treatments, each applied before the work it bounds:
//   1. A paid POST to a job-capable route (src/slow-routes.js) whose run
//      budget is past the bound, sent without Prefer: respond-async:
//        - from a client that follows a 202 job answer on its own (the
//          agent402-client SDK from 0.8.16, whose every paid call passes
//          through its job collector), it is served as if the header had been
//          sent: 202 and a job link (src/async-jobs.js, which replays the call
//          and settles only on a final 200);
//        - from any other client it is refused with a 504 before the payment
//          gate, so nothing is verified, spent upstream or charged, and the
//          refusal names the header that runs it as a job. A client that did
//          not ask for a job could take the 202 for the answer and pay for a
//          result it never collects, so it is never converted unasked.
//   2. Handlers that bound their own waits read cdnSyncLeftMs(req): the LLM
//      gateway caps each upstream attempt (and a stream's wait for its first
//      frame) under it and ends with a 504 (not charged) instead of starting
//      an attempt that cannot answer in time; the image tiers stop before a
//      fallback link that cannot finish; route-execute bounds its outside
//      seller waits by it.
//   3. Streams that have sent their first frame are untouched: bytes flow.
//
// CDN_SYNC_MAX_SECONDS (default 90) is the bound, under the proxy's 100 s so
// settlement and the write fit after the handler.

export const DEFAULT_CDN_SYNC_MAX_SECONDS = 90;
export function cdnSyncMaxSeconds(env = process.env) {
  const n = Number(env.CDN_SYNC_MAX_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CDN_SYNC_MAX_SECONDS;
}

/** Middleware: stamp the deadline on a CDN request. Mount right after the
 *  client-address middleware, before the payment gates. */
export function cdnSyncDeadlineMiddleware({ maxSeconds = cdnSyncMaxSeconds, now = () => Date.now() } = {}) {
  return function cdnSyncDeadline(req, _res, next) {
    if (req.viaCdn === true) req.cdnSyncDeadlineMs = now() + (typeof maxSeconds === "function" ? maxSeconds() : maxSeconds) * 1000;
    next();
  };
}

/** Milliseconds left before a CDN request's synchronous answer is cut off;
 *  null when the request did not come through the CDN proxy. */
export function cdnSyncLeftMs(req, now = Date.now()) {
  const d = req && typeof req === "object" ? req.cdnSyncDeadlineMs : undefined;
  return typeof d === "number" && Number.isFinite(d) ? d - now : null;
}

/** The SDK version from which every paid call passes through the job
 *  collector (client/async-job.js awaitJob), so an unasked 202 is followed. */
export const JOB_FOLLOWING_SDK = Object.freeze({ product: "agent402-client", min: [0, 8, 16] });

/** True when the User-Agent names a client that follows a 202 job answer. */
export function followsJobAnswer(req) {
  const ua = String(req?.headers?.["user-agent"] || "");
  const m = new RegExp(`(?:^|\\s)${JOB_FOLLOWING_SDK.product}/(\\d+)\\.(\\d+)\\.(\\d+)(?:$|[\\s;(-])`).exec(ua);
  if (!m) return false;
  const v = m.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) {
    if (v[i] !== JOB_FOLLOWING_SDK.min[i]) return v[i] > JOB_FOLLOWING_SDK.min[i];
  }
  return true;
}

/**
 * Middleware for treatment 1. Mount immediately before the async-jobs
 * middleware (so a converted call becomes a job there) and before every
 * payment gate (so a refusal spends and charges nothing).
 * @param {object} o
 * @param {(req) => object|null} o.asyncRouteOf  the catalog def when this POST may run as a job
 * @param {(req) => boolean} o.wantsAsync        RFC 7240 respond-async check
 * @param {(req) => boolean} o.carriesPaymentAttempt
 * @param {(req) => boolean} o.isInternal         our own loopback replays (an
 *        async job's, the MCP connector's): mounted before the async marker
 *        exists, so the predicate the slow window reads decides here too
 */
export function cdnSyncWindowMiddleware({ asyncRouteOf, wantsAsync, carriesPaymentAttempt, isInternal = () => false, maxSeconds = cdnSyncMaxSeconds, log = console.log }) {
  return function cdnSyncWindow(req, res, next) {
    if (req.viaCdn !== true || req.method !== "POST" || req.asyncJobLoopback) return next();
    let internal = false;
    try { internal = isInternal(req) === true; } catch { internal = false; }
    if (internal) return next();
    if (wantsAsync(req)) return next();
    let def = null;
    try { def = asyncRouteOf(req); } catch { def = null; }
    const budget = Number(def?.asyncProfile?.maxSeconds);
    const bound = typeof maxSeconds === "function" ? maxSeconds() : maxSeconds;
    if (!def || !(budget > bound)) return next();
    // Unpaid: the ordinary 402, which already recommends the header.
    if (!carriesPaymentAttempt(req)) return next();
    const ct = String(req.headers["content-type"] || "");
    const jsonBody = !ct || /^application\/(?:[\w.+-]*\+)?json\b/i.test(ct);
    if (jsonBody && followsJobAnswer(req)) {
      const prior = String(req.headers.prefer || "").trim();
      req.headers.prefer = prior ? `${prior}, respond-async` : "respond-async";
      req.cdnAsyncApplied = true;
      return next();
    }
    log(`[cdn-sync-window] ${def.slug} refused synchronously (run budget ${budget} s over ${bound} s)`);
    return res.status(504).set("Cache-Control", "no-store").json({
      error: "sync_answer_too_slow_for_connection",
      slug: def.slug,
      maxSeconds: budget,
      syncLimitSeconds: bound,
      hint: `This route can take up to ${budget} s, longer than this connection waits for an answer (${bound} s). Send the paid call again with the header Prefer: respond-async: it answers 202 with a job link at once, and payment settles only when the result is ready. Prefer: wait is not served on this connection for this route. Nothing was charged.`,
    });
  };
}
