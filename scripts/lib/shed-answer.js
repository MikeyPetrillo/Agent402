// A load-shed answer (src/load-shed.js shedResponse) is admission control,
// not a broken page: under a saturated event loop the server refuses free
// requests with 503, Retry-After, and the same figure in the body's
// retryAfterSeconds, so paid calls keep flowing. A suite that drives many
// free requests against one booted server can saturate a slow runner with
// its own burst and meet that answer (the discoverability lane, run
// 43828629618: every page after the first 216 read 503 from the lag gate).
// These helpers match the server's own shed answer whole (its sentence, its
// fields, and Retry-After equal to retryAfterSeconds), so a tool relaying an
// upstream 503 with a Retry-After is never waited out, and wait as asked, a
// bounded number of times; any other 503 is the caller's to judge.
import { SHED_ERROR } from "../../src/load-shed.js";

export const SHED_MAX_ASKS = 3, SHED_MAX_WAIT_MS = 10_000;
// Every field shedResponse writes: the sentence, the figure, and a reason.
const SHED_KEYS = new Set(["error", "retryAfterSeconds", "reason"]);

/** True when `body` is the server's shed answer body (src/load-shed.js shedResponse). */
export function isShedBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (body.error !== SHED_ERROR || typeof body.retryAfterSeconds !== "number") return false;
  if ("reason" in body && typeof body.reason !== "string") return false;
  return Object.keys(body).every((k) => SHED_KEYS.has(k));
}

/** How long a load-shed answer asks the caller to wait (ms), or null when the
 *  answer is not one. */
export function shedWaitMs(status, retryAfterHeader, body, maxWaitMs = SHED_MAX_WAIT_MS) {
  if (status !== 503 || !isShedBody(body)) return null;
  const header = Number(retryAfterHeader);
  if (!Number.isFinite(header) || header <= 0 || body.retryAfterSeconds !== header) return null;
  return Math.min(maxWaitMs, Math.ceil(header * 1000));
}

/**
 * fetch(url, init), asking again after a load-shed answer as it asks, at most
 * `maxAsks` asks and `maxWaitMs` of waiting. Resolves to
 * { res, text, shed, stillShed }: the last response with its body already
 * read as text, how many shed answers were waited out, and whether the last
 * answer was still one.
 */
export async function fetchHonoringShed(url, init = {}, { maxAsks = SHED_MAX_ASKS, maxWaitMs = SHED_MAX_WAIT_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let waited = 0, shed = 0;
  for (let ask = 1; ; ask++) {
    const res = await fetch(url, init);
    const text = await res.text();
    let body = null;
    if (res.status === 503) { try { body = JSON.parse(text); } catch { /* not a shed answer */ } }
    const waitMs = shedWaitMs(res.status, res.headers.get("retry-after"), body, maxWaitMs);
    if (waitMs === null) return { res, text, shed, stillShed: false };
    if (ask >= maxAsks || waited + waitMs > maxWaitMs) return { res, text, shed, stillShed: true };
    shed++;
    waited += waitMs;
    await sleep(waitMs);
  }
}
