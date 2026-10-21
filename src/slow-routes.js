// Which paid routes are slow, how slow, and what a buyer is told about it.
//
// A buyer whose HTTP client gives up before a slow route answers loses the
// answer, and past the hang-up forgiveness budget it is charged for it. The
// fix on the buyer's side is "Prefer: respond-async" (src/async-jobs.js): a
// 202 and a job link at once, the answer collected later, payment settled only
// on the delivered result. This module is the one place that decides which
// routes say so and with what numbers, so the 402, /api/pricing,
// /openapi.json, /llms.txt, the tool pages and the clients cannot disagree.
//
// TWO KINDS OF ROUTE:
//   - slow: the run budget (EVM_RUN_SECONDS, sized from measured settled
//     runs) is past SLOW_ADVISE_SECONDS. Advertised everywhere with its
//     expected and maximum duration, and async is RECOMMENDED: the 402 carries
//     the X-Async-Recommended header and the clients switch to it on their own.
//   - async-capable: accepts the header and runs as a job, but is not
//     advertised as slow (most calls finish well inside a client timeout).
//     These are the routes whose effect is never forgiven on a hang-up (the
//     route-execute tiers, seller-payability) or whose worst case runs long
//     (the media tiers), so a buyer who wants the job link can have it.
//
// expectedSeconds is a typical run, from measured run times where one is
// recorded below; maxSeconds is the run budget. Both are seconds of handler
// time, not counting the payment round trip.
import { EVM_RUN_SECONDS } from "./evm-validity.js";

/** A route whose run budget is past this many seconds is advertised as slow. */
export const SLOW_ADVISE_SECONDS = 20;

// Typical run, seconds, from measured settled runs (tool_call latency, 60 days
// to 2026-09-28; see src/evm-validity.js): the report composites finished in
// 38 to 139 s (midpoint 90), image-gen-premium in 35 to 46 s, and v1-videos
// generates in about 40 s. A slow route not listed here has no measured
// typical run, and its progress estimate uses half its budget.
const TYPICAL_REPORT_SECONDS = 90;
const TYPICAL_SECONDS = Object.freeze({ "v1-videos": 40, "image-gen-premium": 40 });
// Composites whose typical run is not covered by the report measurement.
const NO_TYPICAL = new Set(["decide-execute"]);

// Async-capable, not advertised as slow. maxSeconds is the handler's own
// deadline where it has one.
const ASYNC_CAPABLE = Object.freeze({
  "route-execute": null, "route-execute-plus": null, "route-execute-max": null, "route-execute-pro": null,
  "seller-payability": 55,
  "v1-images-fast": null, "v1-images-pro": null,
  // v1-images-edit is not here: it takes a multipart upload, and a job replays
  // a JSON body.
});

/** The async profile of a catalog def, or null when the route does not run as a job.
 *  { slow, expectedSeconds|null, maxSeconds|null } */
export function asyncProfileOf(def) {
  const slug = def?.slug;
  if (typeof slug !== "string") return null;
  const run = Object.hasOwn(EVM_RUN_SECONDS, slug) ? Number(EVM_RUN_SECONDS[slug]) : 0;
  if (run > 0) {
    const typical = Object.hasOwn(TYPICAL_SECONDS, slug) ? TYPICAL_SECONDS[slug] : NO_TYPICAL.has(slug) ? null : TYPICAL_REPORT_SECONDS;
    return { slow: run > SLOW_ADVISE_SECONDS, expectedSeconds: typical != null ? Math.min(typical, run) : null, maxSeconds: run };
  }
  if (Object.hasOwn(ASYNC_CAPABLE, slug)) return { slow: false, expectedSeconds: null, maxSeconds: ASYNC_CAPABLE[slug] };
  return null;
}

/** Seconds a progress estimate counts toward: the typical run, else half the budget. */
export function estimateBasisSeconds(profile) {
  if (!profile) return null;
  if (profile.expectedSeconds > 0) return profile.expectedSeconds;
  if (profile.maxSeconds > 0) return Math.max(1, Math.round(profile.maxSeconds / 2));
  return null;
}

export const ASYNC_STATUS_PATH = "/api/jobs/{id}";
export const ASYNC_RECOMMENDED_HEADER = "X-Async-Recommended";

/** The machine-readable block the 402 body, /api/pricing and /openapi.json
 *  carry for a route that runs as a job; null for every other route. */
export function asyncAdvice(def) {
  const p = def?.asyncProfile ?? asyncProfileOf(def);
  if (!p) return null;
  return {
    recommended: p.slow,
    ...(p.expectedSeconds != null ? { expectedSeconds: p.expectedSeconds } : {}),
    ...(p.maxSeconds != null ? { maxSeconds: p.maxSeconds } : {}),
    prefer: "respond-async",
    accepted: 202,
    statusUrl: ASYNC_STATUS_PATH,
    how: p.slow
      ? "This route is slow. Send the paid call with the header Prefer: respond-async: it answers 202 with a Location job link at once. Poll GET /api/jobs/{id} (free), waiting Retry-After seconds between polls, until status is succeeded or failed. Payment settles only on a delivered result."
      : "Send the paid call with the header Prefer: respond-async to get 202 and a job link instead of waiting on the connection, then poll GET /api/jobs/{id} (free) until status is succeeded or failed. Payment settles only on a delivered result.",
  };
}

/** The X-Async-Recommended header value for a slow route's 402, or null. */
export function asyncRecommendedHeader(def) {
  const p = def?.asyncProfile ?? asyncProfileOf(def);
  if (!p || !p.slow) return null;
  return `respond-async; ${p.expectedSeconds != null ? `expected-seconds=${p.expectedSeconds}; ` : ""}max-seconds=${p.maxSeconds}`;
}

/** The short llms.txt marker for a slow route, or "". */
export function slowRouteMarker(def) {
  const p = def?.asyncProfile ?? asyncProfileOf(def);
  if (!p || !p.slow) return "";
  return ` (slow: ${p.expectedSeconds != null ? `about ${p.expectedSeconds} s, ` : ""}up to ${p.maxSeconds} s; send Prefer: respond-async for a job link)`;
}

/**
 * Express middleware for the paywall 402 of a slow route: the
 * X-Async-Recommended header, and an `async` block in a JSON object body. Wraps
 * res.send, so it is mounted AFTER the 402 body mirror (it then runs first and
 * the mirror's header keys still win; `async` is not a protocol key). Never
 * changes a status, never touches the PAYMENT-REQUIRED header, never throws.
 * `defOf(req)` returns the catalog def for the request, or null.
 */
export function asyncAdviceMiddleware(defOf) {
  return function asyncAdvice402(req, res, next) {
    let def = null;
    try { def = defOf(req); } catch { def = null; }
    const header = def ? asyncRecommendedHeader(def) : null;
    if (!header) return next();
    const origSend = res.send;
    res.send = function advisedSend(chunk) {
      try {
        if (res.statusCode === 402 && !res.headersSent) {
          res.setHeader(ASYNC_RECOMMENDED_HEADER, header);
          if (typeof chunk === "string" && chunk.trimStart().startsWith("{")) {
            const body = JSON.parse(chunk);
            if (body && typeof body === "object" && !Array.isArray(body) && body.async === undefined) chunk = JSON.stringify({ ...body, async: asyncAdvice(def) });
          }
        }
      } catch { /* advice must never break a 402 */ }
      return origSend.call(this, chunk);
    };
    next();
  };
}
