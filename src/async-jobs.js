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
//   - the charged-but-undelivered cases (a settled 200 whose result cannot be
//     stored, or whose body cannot be read after its headers arrived) record a
//     debt on the refund ledger (onChargedFailure, the MCP tasks' booking),
//     only on the receipt's positive proof of charge. A loopback that ends
//     before any answer is a disconnect the hang-up hook books or forgives.
// The loopback is our own client and never hangs up early (its deadline is past
// the longest run budget), so the hang-up rules never apply to it.
//
// The job id is a bearer capability (48 hex chars, short TTL), as on /mcp.
//
// PROGRESS (src/job-progress.js): the job is `queued` until the paid handler
// starts (the payment gate has passed), then `running` with a stage, a 0-1
// progress and an ETA. Handlers that know their steps report them through a
// sink registered for this job and keyed on the loopback request; any other
// route reports elapsed time against its typical run, labeled estimated.
// GET /api/jobs/:id sets Retry-After on every state that is not final.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { carriesPaymentAttempt } from "./payment-attempt.js";
import { PROGRESS_HEADER, registerProgressSink, throttledProgressWriter, progressView } from "./job-progress.js";

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

/** What GET /api/jobs/:id returns: no owner, pid or boot id.
 *  `status` keeps its original values (working | completed | failed), so a
 *  poller written for them still finishes; `state` is the lifecycle
 *  (queued | running | succeeded | failed) with the progress fields. `profile` is the route's
 *  async profile (src/slow-routes.js) with its estimate basis, or null. */
export function publicJob(rec, { basePath = "/api/jobs", profile = null, now = Date.now() } = {}) {
  const expiresAt = rec.ttlMs != null ? new Date((rec.createdAtMs || 0) + rec.ttlMs).toISOString() : null;
  const pollSeconds = Math.max(1, Math.round((rec.pollIntervalMs || 5000) / 1000));
  const { retryAfterSeconds, ...progress } = progressView(rec, {
    now, pollSeconds,
    basisSeconds: profile?.basisSeconds ?? null, expectedSeconds: profile?.expectedSeconds ?? null, maxSeconds: profile?.maxSeconds ?? null,
  });
  const final = progress.state === "succeeded" || progress.state === "failed";
  return {
    jobId: rec.taskId, status: rec.status, ...progress, slug: rec.slug,
    ...(rec.statusMessage ? { message: rec.statusMessage } : {}),
    createdAt: rec.createdAt, updatedAt: rec.lastUpdatedAt, expiresAt,
    statusUrl: `${basePath}/${rec.taskId}`,
    ...(!final ? { pollIntervalSeconds: retryAfterSeconds } : {}),
    ...(rec.status === "completed" ? { result: rec.result } : {}),
    ...(final && rec.status !== "completed" ? { error: rec.error } : {}),
  };
}

// What a catalog def lists ("$0.005"), the price a job books without a quote.
const listPriceUsd = (def) => Number(String(def?.price ?? "").replace(/[^0-9.]/g, "")) || 0;

/**
 * @param {object} o
 * @param {number} o.port            this server's port (the loopback target)
 * @param {(req) => object|null} o.asyncRouteOf  the catalog def when this POST may run async
 * @param {object} o.store           createTaskStore() instance for these jobs
 * @param {(def, req) => number} [o.quoteOf]  the USD the gate will hold for this
 *   request (a per-request quote, else the list price), read when the job is
 *   made, so the booked debt is the price the buyer paid, not the catalog's.
 * @param {(o) => number} [o.paidOf]  the USD that quote came to on the chain
 *   the receipt names (premium, floor) or that the meter settled.
 */
export function createAsyncJobs({ port, host = "127.0.0.1", asyncRouteOf, store, fetchImpl = fetch, maxPerIp = 4, basePath = "/api/jobs", log = console.log, onChargedFailure = null, profileOfSlug = () => null,
  quoteOf = listPriceUsd, paidOf = ({ basePriceUsd, meteredUsd }) => (Number(meteredUsd) > 0 ? Number(meteredUsd) : basePriceUsd) }) {
  if (!port || !store || typeof asyncRouteOf !== "function") throw new Error("createAsyncJobs: port, store and asyncRouteOf are required");
  const loopbackToken = randomBytes(24).toString("hex");
  const perIp = new Map();
  const dec = (ip) => { const n = (perIp.get(ip) || 1) - 1; if (n <= 0) perIp.delete(ip); else perIp.set(ip, n); };

  // The store's durable methods resolve at once on the file backend and after
  // the row is stored on the state database; the handlers await either way.
  async function middleware(req, res, next) {
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
    // The replay sends the parsed JSON body; any other body (a multipart
    // upload) is served synchronously rather than replayed without its bytes.
    const ct = String(req.headers["content-type"] || "");
    if (ct && !/^application\/(?:[\w.+-]*\+)?json\b/i.test(ct)) return next();
    // Unpaid: the ordinary 402 (the route's description names this mode).
    // Async is for a call that is ready to pay, so a job is never created for
    // a request that could not settle anything.
    if (!carriesPaymentAttempt(req)) return next();
    if (store.atCapacity()) return res.status(503).set("Retry-After", "30").json({ error: "async_capacity", hint: "Too many jobs are running right now. Retry in a minute, or send the call with Prefer: wait=<seconds> (the route's maxSeconds) instead of Prefer: respond-async to wait for the answer on this connection. Nothing was charged." });
    const ip = String(req.ip || "");
    if ((perIp.get(ip) || 0) >= maxPerIp) return res.status(429).set("Retry-After", "30").json({ error: "async_jobs_per_client", hint: `At most ${maxPerIp} jobs may run at once per client. Collect a finished one first. Nothing was charged.` });

    const ctl = new AbortController();
    let rec = null;
    try { rec = await store.create({ slug: def.slug, controller: ctl }); } catch { rec = null; }
    if (!rec) return res.status(503).json({ error: "async_unavailable", hint: "A job could not be recorded. Send the call with Prefer: wait=<seconds> (the route's maxSeconds) instead of Prefer: respond-async to wait on this connection. Nothing was charged." });
    perIp.set(ip, (perIp.get(ip) || 0) + 1);

    const headers = {};
    for (const h of FORWARD) if (req.headers[h] !== undefined) headers[h] = String(req.headers[h]);
    headers["content-type"] = "application/json";
    headers["x-forwarded-for"] = ip || "127.0.0.1";
    headers[LOOPBACK_HEADER] = loopbackToken;
    // The handler's progress reaches this job's record through a sink keyed
    // on the loopback (src/job-progress.js); writes are throttled and never
    // reopen a terminal record.
    const progressWriter = throttledProgressWriter((patch) => store.update?.(rec.taskId, patch));
    const progressSink = registerProgressSink(progressWriter);
    headers[PROGRESS_HEADER] = progressSink.key;
    const body = JSON.stringify(req.body ?? {});
    const url = `http://${host}:${port}${req.originalUrl}`;
    // The price this request is gated at, read now: the replay is priced the
    // same way, and a debt for a lost answer books what was paid.
    let quotedUsd;
    try { quotedUsd = Number(quoteOf(def, req)) || 0; } catch { quotedUsd = listPriceUsd(def); }
    const paidUsd = (receipt, meteredUsd) => { try { return paidOf({ basePriceUsd: quotedUsd, receipt, meteredUsd, req }); } catch { return quotedUsd; } };

    (async () => {
      let r = null;
      // Progress stops before the terminal write, so a late update is never
      // queued behind it (and the store refuses one that is).
      const endProgress = () => { progressWriter.cancel(); progressSink.release(); };
      try {
        r = await fetchImpl(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(store.RUN_TIMEOUT_MS)]) });
        const ct = r.headers.get("content-type") || "";
        let payload;
        if (/json/i.test(ct)) { const t = await r.text(); try { payload = JSON.parse(t); } catch { payload = { text: t }; } }
        else if (/^(image|audio|video)\//i.test(ct) || /octet-stream/i.test(ct)) payload = { contentType: ct.split(";")[0], encoding: "base64", data: Buffer.from(await r.arrayBuffer()).toString("base64") };
        else payload = { text: await r.text() };
        const kept = {};
        for (const h of KEEP) { const v = r.headers.get(h); if (v) kept[h] = v; }
        endProgress();
        if (r.status === 200) {
          const receipt = decodeReceipt(kept["payment-response"]);
          await store.complete(rec.taskId, { httpStatus: 200, headers: kept, body: payload }, { receipt, priceUsd: paidUsd(receipt, kept["x-metered-usd"]) });
        } else {
          await store.fail(rec.taskId, { httpStatus: r.status, body: payload, ...(Object.keys(kept).length ? { headers: kept } : {}) },
            r.status === 402 ? "The payment was not accepted, so the call did not run and nothing was charged. The 402 is in error.body." : `The call ended with HTTP ${r.status} and nothing was charged.`);
        }
      } catch (e) {
        endProgress();
        const aborted = e?.name === "AbortError" || e?.name === "TimeoutError";
        // A 200 whose headers arrived has settled (settlement comes before
        // the answer is written); its body was then lost. Book it here, on
        // the receipt's proof, and say only what was done.
        let booked = false;
        if (r && r.status === 200) {
          const receipt = decodeReceipt(r.headers.get("payment-response"));
          if (receipt && receipt.success === true && typeof onChargedFailure === "function") {
            try { booked = (await onChargedFailure({ slug: def.slug, receipt, priceUsd: paidUsd(receipt, r.headers.get("x-metered-usd")) })) !== false; } catch { booked = false; }
          }
        }
        const message = !r || r.status !== 200
          ? "The call did not finish. If it had already been paid and settled, the charge is recorded as owed in our refund ledger and repaid; otherwise nothing was charged."
          : booked
            ? "The call was paid and settled, but its answer could not be read. The charge is recorded as owed in our refund ledger and repaid."
            : "The call answered, but its answer could not be read. Quote this job id when asking about the charge.";
        await store.fail(rec.taskId, { httpStatus: 504, message: aborted ? "The run did not finish in time." : "The run could not be completed." }, message);
        log(`[async-jobs] ${def.slug} job ended without an answer (${aborted ? "timeout" : "error"}${r ? `, loopback ${r.status}` : ""}${booked ? ", recorded as owed" : ""})`);
      } finally { endProgress(); dec(ip); }
    })();

    const statusUrl = `${basePath}/${rec.taskId}`;
    const doc = publicJob(rec, { basePath, profile: profileOfSlug(def.slug) });
    res.status(202).set({ Location: statusUrl, "Preference-Applied": "respond-async", "Retry-After": String(doc.pollIntervalSeconds || Math.max(1, Math.round(store.POLL_MS / 1000))), "Cache-Control": "no-store" })
      .json({ ...doc, message: `Running ${def.slug}. Poll ${statusUrl} (free), waiting Retry-After seconds between polls, until status is completed or failed (state shows queued, running, succeeded or failed). Payment settles only when the result is ready; on x402 a failed run is not charged.` });
  }

  /** GET /api/jobs/:id - free. */
  async function statusHandler(req, res) {
    const id = String(req.params.id || "");
    let rec = null;
    try { rec = /^[0-9a-f]{48}$/.test(id) ? await store.get(id) : null; } catch { return res.status(503).set("Cache-Control", "no-store").json({ error: "job_store_unavailable", hint: "The job store could not be read. Retry shortly." }); }
    res.set("Cache-Control", "no-store");
    if (!rec) return res.status(404).json({ error: "job_not_found", hint: "Unknown job id. Job links are valid for one hour." });
    if (rec === "expired") return res.status(410).json({ error: "job_expired", hint: "This job link has expired. Job links are valid for one hour." });
    const doc = publicJob(rec, { basePath, profile: profileOfSlug(rec.slug) });
    if (doc.pollIntervalSeconds) res.set("Retry-After", String(doc.pollIntervalSeconds));
    return res.json(doc);
  }

  return { middleware, statusHandler, loopbackToken, activeFor: (ip) => perIp.get(ip) || 0 };
}
