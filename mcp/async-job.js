// Collect a paid call that the server answered as a job.
//
// A slow Agent402 route (its /api/pricing row carries async.recommended) takes
// longer than many clients wait. Sent with "Prefer: respond-async", the paid
// call answers 202 with a job link at once; the server runs it with this
// call's payment and settles only when the answer is ready. This module polls
// the job link (free), waiting Retry-After seconds between polls, and turns the
// final job into an ordinary Response: the route's own status, headers (the
// payment receipt) and body. A job that is still running when the caller's
// overall timeout ends throws AsyncJobPendingError carrying the job link, so
// the answer can still be collected later (the payment, if any, settles only
// on a delivered result, which may still happen).
//
// The job link must be on the same origin as the server: a Location naming
// another host is refused rather than fetched.
//
// Kept in lockstep with client/async-job.js (agent402-client).

export const DEFAULT_ASYNC_TIMEOUT_MS = 15 * 60_000;
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 30_000;
const MAX_POLL_FAILURES = 5;

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when this call should ask for a job: mode "auto" (default) for routes
 *  the catalog marks recommended, true for any route that runs as a job,
 *  false never. `advice` is the catalog row's `async` block. */
export function shouldRequestAsync(advice, mode = "auto") {
  if (!advice || typeof advice !== "object" || mode === false || mode === "off") return false;
  if (mode === true || mode === "always") return true;
  return advice.recommended === true;
}

export class AsyncJobPendingError extends Error {
  constructor(message, { jobUrl, slug, job } = {}) {
    super(message);
    this.name = "AsyncJobPendingError";
    Object.assign(this, { jobUrl, slug, job: job || null, mayBeCharged: true });
  }
}

/** Milliseconds to wait before the next poll, from Retry-After or the body. */
export function retryAfterMs(headers, doc) {
  const h = headers && typeof headers.get === "function" ? headers.get("retry-after") : null;
  let s = h != null && String(h).trim() !== "" ? Number(h) : NaN;
  if (!Number.isFinite(s)) s = Number(doc?.pollIntervalSeconds);
  if (!Number.isFinite(s) || s < 0) s = 5;
  return Math.max(MIN_WAIT_MS, Math.min(MAX_WAIT_MS, s * 1000));
}

function sameOrigin(url, baseUrl) {
  try { return new URL(url).origin === new URL(baseUrl).origin; } catch { return false; }
}

// The job's lifecycle: `state` (queued | running | succeeded | failed) when
// the server sends it, else the original `status` (working | completed | failed).
const STATUS_TO_STATE = { working: "running", completed: "succeeded", failed: "failed", cancelled: "failed" };
export function jobState(doc) {
  if (typeof doc?.state === "string" && doc.state) return doc.state;
  const s = typeof doc?.status === "string" ? doc.status : "";
  return STATUS_TO_STATE[s] || s || null;
}

/** An ordinary Response for a finished job's answer. */
export function responseFromJob(doc) {
  const done = jobState(doc) === "succeeded";
  const part = done ? doc.result || {} : doc?.error || {};
  const status = Number(part.httpStatus) || (done ? 200 : 502);
  const body = part.body !== undefined ? part.body : done ? {} : { error: part.message || doc?.message || "The job failed." };
  const headers = { "content-type": "application/json" };
  for (const [k, v] of Object.entries(part.headers || {})) if (typeof v === "string") headers[k.toLowerCase()] = v;
  if (!done && doc?.message) headers["x-agent402-job-message"] = String(doc.message).replace(/[^\x20-\x7e]/g, " ").slice(0, 300);
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Turn a 202 job answer into the route's final Response; any other response
 * is returned unchanged.
 * @param {Response} res              the answer to the paid call
 * @param {object} o
 * @param {string} o.baseUrl          the server's base URL (the job link must share its origin)
 * @param {Function} o.fetchImpl      a plain fetch (the job link is free; no payment rides on it)
 * @param {number} [o.timeoutMs]      overall wait for the job
 * @param {Function} [o.onProgress]   called with each job document
 * @param {string} [o.slug]
 */
export async function awaitJob(res, { baseUrl, fetchImpl, timeoutMs = DEFAULT_ASYNC_TIMEOUT_MS, onProgress = null, slug = "", sleep = sleepMs, now = () => Date.now() } = {}) {
  if (!res || res.status !== 202) return res;
  let doc = {};
  try { doc = await res.json(); } catch { doc = {}; }
  const loc = (res.headers && typeof res.headers.get === "function" && res.headers.get("location")) || doc.statusUrl;
  if (!loc) throw new AsyncJobPendingError(`"${slug}" answered 202 without a job link`, { slug, job: doc });
  let jobUrl;
  try { jobUrl = new URL(loc, `${String(baseUrl).replace(/\/$/, "")}/`).href; } catch { jobUrl = null; }
  if (!jobUrl || !sameOrigin(jobUrl, baseUrl)) throw new AsyncJobPendingError(`"${slug}" named a job link on another origin; it was not followed`, { slug, job: doc });
  const report = (d) => { try { onProgress?.(d); } catch { /* the caller's callback never breaks the wait */ } };
  report(doc);
  const deadline = now() + Math.max(0, Number(timeoutMs) || DEFAULT_ASYNC_TIMEOUT_MS);
  let wait = retryAfterMs(res.headers, doc);
  let failures = 0;
  for (;;) {
    if (now() + wait > deadline) {
      throw new AsyncJobPendingError(`"${slug}" is still running (${jobState(doc) || "running"}${doc.stage ? `, ${doc.stage}` : ""}); collect it from ${jobUrl} (free) until it expires`, { jobUrl, slug, job: doc });
    }
    await sleep(wait);
    let g;
    try { g = await fetchImpl(jobUrl, { headers: { Accept: "application/json" } }); }
    catch { g = null; }
    if (!g || g.status >= 500 || g.status === 429) {
      if (++failures >= MAX_POLL_FAILURES) throw new AsyncJobPendingError(`the job link for "${slug}" could not be read (${g ? `HTTP ${g.status}` : "network error"}); collect it from ${jobUrl}`, { jobUrl, slug, job: doc });
      wait = retryAfterMs(g?.headers, doc);
      continue;
    }
    if (g.status === 404 || g.status === 410) {
      throw new AsyncJobPendingError(`the job for "${slug}" is ${g.status === 410 ? "expired" : "unknown"} at ${jobUrl}`, { jobUrl, slug, job: doc });
    }
    failures = 0;
    try { doc = await g.json(); } catch { doc = {}; }
    report(doc);
    const st = jobState(doc);
    if (st === "succeeded" || st === "failed") return responseFromJob(doc);
    wait = retryAfterMs(g.headers, doc);
  }
}
