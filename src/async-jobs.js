// Submit now, collect later, for the slow paid routes (reports, media,
// decide-execute): the HTTP twin of the connector's MCP tasks (src/mcp-tasks.js).
//
// WHY: a report runs one to four minutes, and many agent HTTP clients give up
// at about 30 seconds. A client that hangs up loses the answer, and once its
// hang-up allowance is spent the call is charged and has to be refunded. With
//   Prefer: respond-async
// on a PAID call to a slow route, the buyer gets 202 and a job link at once and
// collects the answer from GET /api/jobs/:id when it is ready.
//
// PAYMENT (unchanged, and the reason this is a loopback): the 202 is answered
// by this middleware, which is mounted BEFORE every payment gate, so it never
// reaches a paywall and nothing settles on it. The real call is then replayed
// to this same server over 127.0.0.1 carrying the buyer's own payment headers,
// and THAT request goes through the normal chain: verify, run the handler,
// settle only on a final 200. So:
//   - a run that fails answers non-200 on the loopback: settlement is cancelled,
//     the buyer is not charged, and the job says so;
//   - a refused payment answers 402 on the loopback: the job carries that 402;
//   - a process restart kills the loopback before any 200: not charged, and the
//     boot sweep marks the job failed;
//   - the one charged-but-undelivered case (a settled 200 whose result cannot be
//     stored) records a debt on the refund ledger, as the MCP tasks do.
// The loopback is our own client and never hangs up early (its deadline is past
// the longest run budget), so the hang-up rules never apply to it.
//
// The job id is a bearer capability (48 hex chars, short TTL), as on /mcp.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { carriesPaymentAttempt } from "./payment-attempt.js";

export const LOOPBACK_HEADER = "x-agent402-async-loopback";
const PREFER_ASYNC = /(^|[\s,;])respond-async(?=$|[\s,;=])/i;
/** RFC 7240: the client asks for an asynchronous answer. */
export const wantsAsync = (req) => PREFER_ASYNC.test(String(req?.headers?.prefer || ""));

// Request headers the paid call needs, and nothing else.
const FORWARD = ["content-type", "accept", "payment-signature", "x-payment", "payment-identifier", "authorization", "idempotency-key", "x-pow-solution", "x-heartbeat-token"];
// Response headers worth keeping with the result (the receipt, the balance).
const KEEP = ["payment-response", "payment-receipt", "x-credits-balance", "x-idempotent-replay", "x-metered-usd", "x-cache"];

function decodeReceipt(b64) {
  if (!b64) return null;
  try { return JSON.parse(Buffer.from(String(b64), "base64").toString("utf8")); } catch { return null; }
}
const sameToken = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/** What GET /api/jobs/:id returns: no owner, pid or boot id. */
export function publicJob(rec, { basePath = "/api/jobs" } = {}) {
  const expiresAt = rec.ttlMs != null ? new Date((rec.createdAtMs || 0) + rec.ttlMs).toISOString() : null;
  return {
    jobId: rec.taskId, status: rec.status, slug: rec.slug,
    ...(rec.statusMessage ? { message: rec.statusMessage } : {}),
    createdAt: rec.createdAt, updatedAt: rec.lastUpdatedAt, expiresAt,
    statusUrl: `${basePath}/${rec.taskId}`,
    ...(rec.status === "working" ? { pollIntervalSeconds: Math.max(1, Math.round((rec.pollIntervalMs || 5000) / 1000)) } : {}),
    ...(rec.status === "completed" ? { result: rec.result } : {}),
    ...(rec.status === "failed" ? { error: rec.error } : {}),
  };
}

/**
 * @param {object} o
 * @param {number} o.port            this server's port (the loopback target)
 * @param {(req) => object|null} o.asyncRouteOf  the catalog def when this POST may run async
 * @param {object} o.store           createTaskStore() instance for these jobs
 */
export function createAsyncJobs({ port, host = "127.0.0.1", asyncRouteOf, store, fetchImpl = fetch, maxPerIp = 4, basePath = "/api/jobs", log = console.log }) {
  if (!port || !store || typeof asyncRouteOf !== "function") throw new Error("createAsyncJobs: port, store and asyncRouteOf are required");
  const loopbackToken = randomBytes(24).toString("hex");
  const perIp = new Map();
  const dec = (ip) => { const n = (perIp.get(ip) || 1) - 1; if (n <= 0) perIp.delete(ip); else perIp.set(ip, n); };

  function middleware(req, res, next) {
    // Our own replay: pass it through to the normal paid chain. A forged marker
    // is stripped and the request is served as an ordinary synchronous call.
    if (req.headers[LOOPBACK_HEADER] !== undefined) {
      const genuine = sameToken(req.headers[LOOPBACK_HEADER], loopbackToken);
      delete req.headers[LOOPBACK_HEADER];
      if (genuine) req.asyncJobLoopback = true;
      return next();
    }
    if (req.method !== "POST" || !wantsAsync(req)) return next();
    const def = asyncRouteOf(req);
    if (!def) return next();
    // Unpaid: the ordinary 402 (the route's description names this mode).
    // Async is for a call that is ready to pay, so a job is never created for
    // a request that could not settle anything.
    if (!carriesPaymentAttempt(req)) return next();
    if (store.atCapacity()) return res.status(503).set("Retry-After", "30").json({ error: "async_capacity", hint: "Too many jobs are running right now. Retry in a minute, or send the call without Prefer: respond-async to wait for the answer on this connection. Nothing was charged." });
    const ip = String(req.ip || "");
    if ((perIp.get(ip) || 0) >= maxPerIp) return res.status(429).set("Retry-After", "30").json({ error: "async_jobs_per_client", hint: `At most ${maxPerIp} jobs may run at once per client. Collect a finished one first. Nothing was charged.` });

    const ctl = new AbortController();
    const rec = store.create({ slug: def.slug, controller: ctl });
    if (!rec) return res.status(503).json({ error: "async_unavailable", hint: "A job could not be recorded. Send the call without Prefer: respond-async. Nothing was charged." });
    perIp.set(ip, (perIp.get(ip) || 0) + 1);

    const headers = {};
    for (const h of FORWARD) if (req.headers[h] !== undefined) headers[h] = String(req.headers[h]);
    headers["content-type"] = "application/json";
    headers["x-forwarded-for"] = ip || "127.0.0.1";
    headers[LOOPBACK_HEADER] = loopbackToken;
    const body = JSON.stringify(req.body ?? {});
    const url = `http://${host}:${port}${req.originalUrl}`;

    (async () => {
      try {
        const r = await fetchImpl(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(store.RUN_TIMEOUT_MS)]) });
        const ct = r.headers.get("content-type") || "";
        let payload;
        if (/json/i.test(ct)) { const t = await r.text(); try { payload = JSON.parse(t); } catch { payload = { text: t }; } }
        else if (/^(image|audio|video)\//i.test(ct) || /octet-stream/i.test(ct)) payload = { contentType: ct.split(";")[0], encoding: "base64", data: Buffer.from(await r.arrayBuffer()).toString("base64") };
        else payload = { text: await r.text() };
        const kept = {};
        for (const h of KEEP) { const v = r.headers.get(h); if (v) kept[h] = v; }
        if (r.status === 200) {
          store.complete(rec.taskId, { httpStatus: 200, headers: kept, body: payload }, { receipt: decodeReceipt(kept["payment-response"]), priceUsd: def.priceUsd ?? null });
        } else {
          store.fail(rec.taskId, { httpStatus: r.status, body: payload, ...(Object.keys(kept).length ? { headers: kept } : {}) },
            r.status === 402 ? "The payment was not accepted, so the call did not run and nothing was charged. The 402 is in error.body." : `The call ended with HTTP ${r.status} and nothing was charged.`);
        }
      } catch (e) {
        const aborted = e?.name === "AbortError" || e?.name === "TimeoutError";
        store.fail(rec.taskId, { httpStatus: 504, message: aborted ? "The run did not finish in time." : "The run could not be completed." },
          "The call did not finish. If it had already been paid and settled, the charge is recorded as owed in our refund ledger and repaid; otherwise nothing was charged.");
        log(`[async-jobs] ${def.slug} job ended without an answer (${aborted ? "timeout" : "error"})`);
      } finally { dec(ip); }
    })();

    const statusUrl = `${basePath}/${rec.taskId}`;
    res.status(202).set({ Location: statusUrl, "Preference-Applied": "respond-async", "Retry-After": String(Math.max(1, Math.round(store.POLL_MS / 1000))), "Cache-Control": "no-store" })
      .json({ ...publicJob(rec, { basePath }), message: `Running ${def.slug}. Poll ${statusUrl} (free) until status is completed or failed. Payment settles only when the result is ready; a failed run is not charged.` });
  }

  /** GET /api/jobs/:id - free. */
  function statusHandler(req, res) {
    const id = String(req.params.id || "");
    const rec = /^[0-9a-f]{48}$/.test(id) ? store.get(id) : null;
    res.set("Cache-Control", "no-store");
    if (!rec) return res.status(404).json({ error: "job_not_found", hint: "Unknown job id. Job links are valid for one hour." });
    if (rec === "expired") return res.status(410).json({ error: "job_expired", hint: "This job link has expired. Job links are valid for one hour." });
    return res.json(publicJob(rec, { basePath }));
  }

  return { middleware, statusHandler, loopbackToken, activeFor: (ip) => perIp.get(ip) || 0 };
}
