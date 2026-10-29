// How long a paid call to a slow route may keep a client waiting for a
// synchronous answer when the client has not said how long it waits.
//
// WHY: a slow route (src/slow-routes.js) can run past the 20 to 30 seconds
// many agent HTTP clients wait. A client that gives up before the first byte
// loses the answer, and once its hang-up allowance is spent
// (src/hangup-forgiveness.js) the call is charged and a refund is owed.
//
// WHY THE DECISION IS MADE BEFORE THE GATES, NOT MID-RUN: the x402 middleware
// runs the handler and then settles on the same response object, buffering
// the handler's answer until settlement; MPP push credentials are finalized
// before the handler, and credits hold at authorize. An in-flight request
// cannot answer 202 to its client and still hand its later answer to the
// payment gate without rewriting each gate. A job (src/async-jobs.js) already
// does the right thing: the 202 is answered before every gate, the real call is
// a loopback that settles only on its own final 200, and the answer is kept at
// its job link. So the choice is made here, on arrival, from the route's run
// budget:
//
// A PAID POST to a slow route whose run budget (maxSeconds) is past the window,
// sent without Prefer: respond-async:
//   - Prefer: wait=N with N at or past the run budget: the client has said it
//     waits that long, so it is served synchronously as before;
//   - a client that follows a 202 job answer on its own (agent402-client
//     0.8.16 or later, src/cdn-sync-window.js followsJobAnswer) with a JSON
//     body: served as if it had sent Prefer: respond-async (a job);
//   - any other client: answered 400 before every payment gate, so nothing is
//     verified, run upstream or charged, with a hint naming both headers. A
//     client that did not ask for a job could take an unasked 202 for the
//     answer and pay for a result it never collects, so it is never converted.
// Unpaid calls get the ordinary 402 (which recommends the header), and our
// own loopbacks (an async job's replay, the MCP connector) pass untouched.
//
// A Tempo PUSH credential (src/mpp-tempo.js: the buyer sent the transfer
// before the call) is the one payment a refusal here cannot leave untaken:
// the money is already at our recipient. Refused before the gate, the
// transfer would stay unclaimed and unbooked. So the refusal is not sent
// here but DEFERRED on the request (deferSyncWindowRefusal) and the Tempo
// gate answers it from its push input check, after the relay has confirmed
// the transfer and before the hash is claimed: the transfer is booked as
// owed until the same credential is presented again with the header, and
// that claim voids the debt (src/tempo-push-debts.js).
//
// SLOW_SYNC_WINDOW_SECONDS (default 20; "off" disables) is the longest wait
// assumed of a client that did not say otherwise.
import { PUSH_EXCEPTION } from "./tempo-push-debts.js";

export const DEFAULT_SLOW_SYNC_WINDOW_SECONDS = 20;

/** The retry a deferred refusal asks for (the Tempo gate's answer names it). */
export const SYNC_WINDOW_RETRY = "with the header Prefer: respond-async";

/** Park a sync window's refusal ({status, body}) on the request for the Tempo
 *  gate to answer, for a push credential. Own property, never a header. */
export function deferSyncWindowRefusal(req, refusal) {
  req.syncWindowRefusal = { ...refusal, retry: SYNC_WINDOW_RETRY };
}
/** The refusal a sync window deferred on this request, or null. */
export function syncWindowRefusalOf(req) {
  const r = req && typeof req === "object" && Object.hasOwn(req, "syncWindowRefusal") ? req.syncWindowRefusal : null;
  return r && typeof r === "object" && Number(r.status) >= 400 && r.body && typeof r.body === "object" ? r : null;
}
/** A route whose run budget is past this many seconds is advertised as slow
 *  (src/slow-routes.js re-exports it). */
export const SLOW_ADVISE_SECONDS = 20;
const OFF = /^(off|false|no|0)$/i;

/** The window in seconds, or null when it is switched off. */
export function slowSyncWindowSeconds(env = process.env) {
  const raw = String(env.SLOW_SYNC_WINDOW_SECONDS ?? "").trim();
  if (OFF.test(raw)) return null;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : DEFAULT_SLOW_SYNC_WINDOW_SECONDS;
}

/** True when a paid call to this route needs Prefer: respond-async or a long
 *  enough Prefer: wait (the route is advertised slow and can run past the window). */
export function needsAsyncOrWait(profile, windowSeconds = slowSyncWindowSeconds()) {
  if (windowSeconds == null || !profile || profile.slow !== true) return false;
  const budget = Number(profile.maxSeconds);
  return Number.isFinite(budget) && budget > windowSeconds;
}

const PREFER_WAIT = /(?:^|[\s,;])wait\s*=\s*"?(\d{1,7})"?(?=$|[\s,;])/i;
/** RFC 7240 Prefer: wait=N (seconds the client waits for a synchronous answer), or null. */
export function preferWaitSeconds(req) {
  const m = PREFER_WAIT.exec(String(req?.headers?.prefer || ""));
  return m ? Number(m[1]) : null;
}

/**
 * Middleware. Mount after the CDN sync window (which handles CDN requests on
 * its own, tighter bound) and immediately before the async-jobs middleware (so
 * a converted call becomes a job there), before every payment gate.
 * @param {object} o
 * @param {(req) => object|null} o.asyncRouteOf  the catalog def when this POST may run as a job
 * @param {(req) => boolean} o.wantsAsync
 * @param {(req) => boolean} o.carriesPaymentAttempt
 * @param {(req) => boolean} o.followsJobAnswer
 * @param {(req) => boolean} o.isInternal         our own loopback replays
 * @param {(req) => boolean} o.isTempoPush        a Tempo push credential the
 *        mounted Tempo gate will judge: its refusal is deferred to that gate
 */
export function slowSyncWindowMiddleware({ asyncRouteOf, wantsAsync, carriesPaymentAttempt, followsJobAnswer, isInternal = () => false, isTempoPush = () => false, windowSeconds = slowSyncWindowSeconds, log = console.log }) {
  return function slowSyncWindow(req, res, next) {
    if (req.method !== "POST" || wantsAsync(req)) return next();
    // The CDN window ahead of this one already deferred its refusal.
    if (syncWindowRefusalOf(req)) return next();
    const window = typeof windowSeconds === "function" ? windowSeconds() : windowSeconds;
    if (window == null) return next();
    let def = null;
    try { def = asyncRouteOf(req); } catch { def = null; }
    if (!def || !needsAsyncOrWait(def.asyncProfile, window)) return next();
    if (!carriesPaymentAttempt(req)) return next();
    let internal = false;
    try { internal = isInternal(req) === true; } catch { internal = false; }
    if (internal) return next();
    const budget = Number(def.asyncProfile.maxSeconds);
    const wait = preferWaitSeconds(req);
    if (wait != null && wait >= budget) return next();
    const ct = String(req.headers["content-type"] || "");
    const jsonBody = !ct || /^application\/(?:[\w.+-]*\+)?json\b/i.test(ct);
    // A job replays a JSON body only; any other body has no job to run as.
    if (!jsonBody) return next();
    if (followsJobAnswer(req)) {
      const prior = String(req.headers.prefer || "").trim();
      req.headers.prefer = prior ? `${prior}, respond-async` : "respond-async";
      req.slowSyncAsyncApplied = true;
      return next();
    }
    let push = false;
    try { push = isTempoPush(req) === true; } catch { push = false; }
    const body = {
      error: "respond_async_required",
      slug: def.slug,
      maxSeconds: budget,
      ...(def.asyncProfile.expectedSeconds != null ? { expectedSeconds: def.asyncProfile.expectedSeconds } : {}),
      syncWindowSeconds: window,
      prefer: "respond-async",
      preferWait: `wait=${budget}`,
      statusUrl: "/api/jobs/{id}",
      hint: `This route can take up to ${budget} s, longer than many clients wait. Send the paid call again with the header Prefer: respond-async: it answers 202 with a job link at once, and payment settles only when the result is ready. To wait on this connection instead, send Prefer: wait=${budget} and keep the connection open for at least ${budget + 30} s. This call was refused before any payment was taken${push ? PUSH_EXCEPTION : ""}.`,
    };
    if (push) {
      log(`[slow-sync-window] ${def.slug} refusal deferred to the Tempo gate (push credential, run budget ${budget} s over ${window} s)`);
      deferSyncWindowRefusal(req, { status: 400, body });
      return next();
    }
    log(`[slow-sync-window] ${def.slug} refused synchronously (run budget ${budget} s over ${window} s, ${wait == null ? "no Prefer" : `Prefer: wait=${wait} too short`})`);
    return res.status(400).set("Cache-Control", "no-store").json(body);
  };
}
