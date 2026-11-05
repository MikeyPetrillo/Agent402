// One paid call that honors the server's slow-route contract, for the repo
// scripts that buy catalog routes (base-list-sweep, catalog-buy,
// cross-chain-matrix, the decide checks).
//
// A slow route (its /api/pricing row, or its 402 body, carries an `async`
// block: src/slow-routes.js asyncAdvice) refuses a paid call that waits on the
// connection past the sync window with 400 respond_async_required, before
// any payment is taken; through the CDN a run budget past its bound is
// refused with 504 whatever Prefer: wait the client names. So a slow route is
// bought with Prefer: respond-async: the paid call answers 202 with a job
// link, the server runs it with this payment and settles only on the job's
// final 200, and the job link is polled (free) to the end with
// client/async-job.js awaitJob, which turns the job into the route's own
// Response (status, payment receipt, body). A job that ends failed is a
// failed call: its Response carries the job's error status, never a 2xx or
// 3xx. A route the catalog does not mark that answers 400
// respond_async_required is sent once more with the Prefer header the
// refusal body names; no other answer earns that retry, and a call that
// already sent the header never gets it.
//
// The same rules scripts/payai-listing-pass.js applies to its own records.
import { awaitJob, jobState, DEFAULT_ASYNC_TIMEOUT_MS } from "../../client/async-job.js";

export const RESPOND_ASYNC = "respond-async";

/** The Prefer value a route's paid call carries up front, from its `async`
 *  block (recommended, or a paid call without the header refused with 400),
 *  or null. Only a POST with a JSON body runs as a job. */
export function slowPreferOf(advice, { method = "POST", json = true } = {}) {
  if (!advice || typeof advice !== "object" || !json || String(method || "POST").toUpperCase() !== "POST") return null;
  return advice.recommended === true || advice.withoutPrefer === 400 ? RESPOND_ASYNC : null;
}

/** path -> the row's `async` block, for every /api/pricing row that has one. */
export function asyncAdviceByPath(pricing) {
  const out = new Map();
  for (const e of pricing?.endpoints || pricing?.tools || []) {
    if (e && typeof e.path === "string" && e.async && typeof e.async === "object") out.set(e.path, e.async);
  }
  return out;
}

/** The Prefer header a 400 respond_async_required body names, or null for
 *  any other status or body. */
export function asyncRefusalPreferOf(status, text) {
  if (status !== 400 || !text) return null;
  let doc = null;
  try { doc = JSON.parse(String(text)); } catch { return null; }
  if (doc?.error !== "respond_async_required") return null;
  return /^\s*respond-async\s*$/i.test(String(doc.prefer || "")) ? RESPOND_ASYNC : null;
}

/**
 * One paid call under the slow-route contract.
 * @param {(extraHeaders: object, attempt: number) => Promise<Response>} send
 *        makes the paid call (signing what it signs) with these headers added
 * @param {object} o
 * @param {string|null} o.prefer   slowPreferOf(...) for this route
 * @param {string} o.baseUrl       the server (a job link must share its origin)
 * @param {Function} o.fetchImpl   a plain fetch for the free job link
 * @returns {Promise<{ res: Response, prefer: string|null, attempts: number, fallback: boolean, job: {id, state}|null, jobFailed: boolean }>}
 *        `res` is the route's final answer. A job still running at the
 *        deadline throws client/async-job.js AsyncJobPendingError
 *        (mayBeCharged: true).
 */
export async function paidCallHonoringSlowRoutes(send, { prefer = null, baseUrl, fetchImpl = fetch, slug = "", timeoutMs = DEFAULT_ASYNC_TIMEOUT_MS, sleep, onJob = null } = {}) {
  let sent = prefer || null;
  let attempts = 1;
  let fallback = false;
  let res = await send(sent ? { Prefer: sent } : {}, attempts);
  if (!sent && res.status === 400) {
    const text = await res.clone().text().catch(() => "");
    const named = asyncRefusalPreferOf(res.status, text);
    if (named) {
      sent = named;
      fallback = true;
      attempts = 2;
      res = await send({ Prefer: sent }, attempts);
    }
  }
  if (res.status !== 202) return { res, prefer: sent, attempts, fallback, job: null, jobFailed: false };
  let job = null;
  const final = await awaitJob(res, {
    baseUrl, fetchImpl, slug, timeoutMs,
    ...(sleep ? { sleep } : {}),
    onProgress: (d) => {
      job = { id: d?.jobId ?? job?.id ?? null, state: jobState(d) };
      try { onJob?.(job); } catch { /* the caller's callback never breaks the wait */ }
    },
  });
  const jobFailed = job?.state === "failed";
  // A failed job is a failed call whatever status its error names.
  const out = jobFailed && final.status < 400
    ? new Response(await final.text().catch(() => ""), { status: 502, headers: final.headers })
    : final;
  return { res: out, prefer: sent, attempts, fallback, job, jobFailed };
}
