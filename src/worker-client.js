// Client for the secretless browser/media worker (audit F02/F04/F06).
//
// When RENDER_WORKER_URL is set, the render/screenshot/media handlers run in a
// SEPARATE service that holds no payment/DB/operator/provider secrets and no
// /data mount (see worker/server.js) — so a Chromium or ffmpeg/ffprobe RCE from
// hostile page/media content lands in a box with nothing worth stealing. Unset
// => everything runs in-process, exactly as before (this is the default; prod
// behavior is unchanged until the worker is deployed and the flag is set).
//
// Platform note: on Railway the worker still can't enable Chromium's own sandbox
// (no userns/seccomp) or a network egress firewall — those stay documented
// limitations. What this achieves is the big one: removing the secrets from
// blast range of a browser/parser compromise.
const workerUrl = () => (process.env.RENDER_WORKER_URL || "").trim().replace(/\/$/, "");
const workerToken = () => (process.env.RENDER_WORKER_TOKEN || "").trim();
const WORKER_TIMEOUT_MS = Number(process.env.RENDER_WORKER_TIMEOUT_MS) || 75_000;
// FR4-06: cap the response a (compromised/malfunctioning) worker can make the
// main service buffer. Renders (markdown) and screenshots (base64 PNG) are
// already bounded by render.js's byte budget; this is the belt-and-suspenders.
const WORKER_MAX_BYTES = Number(process.env.RENDER_WORKER_MAX_BYTES) || 40 * 1024 * 1024;

// FR4-06: config is ATOMIC — the worker is used only when BOTH the URL and the
// token are set. A URL without a token would send unauthenticated calls that the
// (fail-closed) worker 401s, silently breaking every paid render.
export function workerEnabled() { return Boolean(workerUrl() && workerToken()); }

// FR4-06 / P1.1: fail LOUD at boot on a partial worker config (exactly one of
// URL/token set), and — when isolation is REQUIRED (RENDER_WORKER_REQUIRED
// truthy, e.g. in prod) — on a missing worker config, so browser/media tools can
// never silently run in-process in a deployment that intends isolation. Call once
// at boot.
export function assertWorkerConfig() {
  const hasUrl = Boolean(workerUrl());
  const hasToken = Boolean(workerToken());
  if (hasUrl !== hasToken) {
    throw new Error(
      `Incomplete render-worker config: RENDER_WORKER_URL is ${hasUrl ? "set" : "unset"} but RENDER_WORKER_TOKEN is ${hasToken ? "set" : "unset"}. Set BOTH (worker isolation) or NEITHER (in-process).`
    );
  }
  const required = /^(1|true|yes|on)$/i.test((process.env.RENDER_WORKER_REQUIRED || "").trim());
  if (required && !(hasUrl && hasToken)) {
    throw new Error(
      "RENDER_WORKER_REQUIRED is set but the render worker is not configured (need RENDER_WORKER_URL + RENDER_WORKER_TOKEN). Refusing to boot so browser/media tools cannot run in-process and defeat the isolation."
    );
  }
}

// Read a fetch Response body as text with a hard byte cap; aborts the stream and
// throws (502) if the worker returns more than `maxBytes`.
async function readBounded(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) return await res.text();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw Object.assign(new Error(`render worker response exceeded ${maxBytes} bytes`), { statusCode: 502 });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// A worker service that sleeps when idle refuses or resets connections while
// its container starts, and the platform edge in front of it answers 502/503/504
// with a body of its own. Those are retried with backoff; anything the worker
// itself answers (a JSON body with an `error` string, or a result) is final, so
// a job the worker accepted never runs twice.
const WAKE_BACKOFF_MS = [500, 1000, 2000, 4000];
const WAKE_BACKOFF_CAP_MS = 4000;
// A retry is attempted only while at least this much of the deadline remains
// for the job itself after the wait.
const WORKER_MIN_ATTEMPT_MS = Number(process.env.RENDER_WORKER_MIN_ATTEMPT_MS) || 20_000;
const CONNECT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

/** True for a fetch rejection that means the worker never answered. */
export function isConnectFailure(err) {
  if (!err || err.name === "AbortError") return false;
  const code = err.cause?.code || err.code;
  // A coded cause decides alone: a headers or body timeout means the worker
  // accepted the job, so it is not retried.
  if (code) return CONNECT_CODES.has(code);
  return err instanceof TypeError && /fetch failed/i.test(String(err.message || ""));
}

/** True for a 502/503/504 that the platform edge produced, not the worker. */
export function isEdgeUnavailable(status, body) {
  if (![502, 503, 504].includes(status)) return false;
  return !(body && typeof body === "object" && typeof body.error === "string");
}

export function wakeBackoffMs(attempt) {
  return WAKE_BACKOFF_MS[attempt] ?? WAKE_BACKOFF_CAP_MS;
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener?.("abort", done); resolve(); }
  signal?.addEventListener?.("abort", done, { once: true });
});

// Dispatch one browser/media job to the worker. Returns the tool's JSON result,
// or `{ __binary: Buffer, contentType }` for a binary result (screenshot PNG).
// `timeoutMs` is the whole call's deadline, wake retries included.
export async function runOnWorker(slug, input, { signal, timeoutMs = WORKER_TIMEOUT_MS, minAttemptMs = WORKER_MIN_ATTEMPT_MS } = {}) {
  const base = workerUrl();
  if (!base) throw Object.assign(new Error("render worker not configured"), { statusCode: 503 });
  const started = Date.now();
  const ac = new AbortController();
  // The timer's abort carries a TimeoutError, so the failure monitor counts
  // it as the worker timing out rather than the caller cancelling.
  const timer = setTimeout(() => ac.abort(new DOMException("render worker timed out", "TimeoutError")), timeoutMs);
  const onAbort = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener("abort", onAbort, { once: true }); }
  const token = workerToken();
  const payload = JSON.stringify({ slug, input });
  const canRetry = (wait) => !ac.signal.aborted && timeoutMs - (Date.now() - started) - wait >= minAttemptMs;
  let res, text;
  try {
    for (let attempt = 0; ; attempt++) {
      let failure;
      try {
        res = await fetch(`${base}/call`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: payload,
          signal: ac.signal,
        });
      } catch (e) {
        if (!isConnectFailure(e)) throw Object.assign(new Error(`render worker unreachable: ${e.name === "AbortError" || e.name === "TimeoutError" ? "timeout" : e.message}`), { statusCode: 503 });
        failure = e.cause?.code || e.message;
      }
      if (res && !failure) {
        text = await readBounded(res, WORKER_MAX_BYTES);
        let peek = null;
        try { peek = JSON.parse(text); } catch { /* non-JSON */ }
        if (!isEdgeUnavailable(res.status, peek)) break;
        failure = `edge HTTP ${res.status}`;
      }
      const wait = wakeBackoffMs(attempt);
      if (!canRetry(wait)) {
        throw Object.assign(new Error(`render worker unreachable: ${failure} after ${attempt + 1} attempt${attempt ? "s" : ""}`), { statusCode: 503, retryAfter: 5 });
      }
      res = undefined;
      await sleep(wait, ac.signal);
    }
  } catch (e) {
    if (e?.statusCode) throw e;
    throw Object.assign(new Error(`render worker unreachable: ${e?.name === "AbortError" || e?.name === "TimeoutError" ? "timeout" : e?.message}`), { statusCode: 503 });
  } finally { clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort); }
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) {
    // A saturated pool on the worker names a retry delay; carry it through so
    // the buyer's 503 has the same Retry-After as the in-process path.
    const retryAfter = Number.isInteger(body?.retryAfterSeconds) ? body.retryAfterSeconds : undefined;
    throw Object.assign(new Error(body?.error || `render worker HTTP ${res.status}`), { statusCode: res.status, ...(retryAfter ? { retryAfter } : {}) });
  }
  if (body && body.__binary) {
    const buf = Buffer.from(body.__binary, "base64");
    if (buf.byteLength > WORKER_MAX_BYTES) throw Object.assign(new Error("render worker binary too large"), { statusCode: 502 });
    return { __binary: buf, contentType: body.contentType };
  }
  return body;
}
