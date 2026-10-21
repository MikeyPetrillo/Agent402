// Render-worker wake retries (offline). A worker service that sleeps when idle
// refuses connections while its container starts, and the platform edge answers
// 502/503 with a body of its own. runOnWorker retries those with backoff inside
// its deadline, and never retries once the worker itself has answered.
//
//   node scripts/test-worker-wake-retry.js
import http from "node:http";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reserve a free port, then release it so connections to it are refused.
async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
function stub(handler) {
  let calls = 0;
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => { calls++; handler(req, res, calls, raw); });
  });
  return { srv, calls: () => calls };
}
const listenOn = (srv, port) => new Promise((r) => srv.listen(port, "127.0.0.1", r));
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

process.env.RENDER_WORKER_TOKEN = "wake-tok";
const wc = await import("../src/worker-client.js");
const { runOnWorker, isConnectFailure, isEdgeUnavailable, wakeBackoffMs } = wc;

// --- classification ---------------------------------------------------------
{
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  const headersTimeout = Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  ok(isConnectFailure(refused) && isConnectFailure(reset), "ECONNREFUSED and ECONNRESET are connection failures");
  ok(isConnectFailure(new TypeError("fetch failed")), "an uncoded \"fetch failed\" is a connection failure");
  ok(!isConnectFailure(headersTimeout), "a headers timeout (worker accepted the job) is not retried");
  ok(!isConnectFailure(abort), "an abort is not retried");
  ok(isEdgeUnavailable(502, { status: "error", message: "Application failed to respond" }), "an edge 502 body is retryable");
  ok(isEdgeUnavailable(503, null), "a non-JSON 503 is retryable");
  ok(!isEdgeUnavailable(503, { error: "browser pool busy", retryAfterSeconds: 3 }), "the worker's own 503 is final");
  ok(!isEdgeUnavailable(500, null), "a 500 is final");
  ok([0, 1, 2, 3, 4, 9].map(wakeBackoffMs).join(",") === "500,1000,2000,4000,4000,4000", "backoff is 0.5, 1, 2, 4 s, capped at 4 s");
}

// --- worker refuses connections, then starts listening -----------------------
{
  const port = await freePort();
  process.env.RENDER_WORKER_URL = `http://127.0.0.1:${port}`;
  const s = stub((req, res, _n, raw) => json(res, 200, { ok: true, echo: JSON.parse(raw).slug }));
  const t0 = Date.now();
  setTimeout(() => listenOn(s.srv, port), 1200);
  const r = await runOnWorker("render", { url: "https://agent402.tools/llms.txt" }, { timeoutMs: 20_000, minAttemptMs: 1000 });
  const took = Date.now() - t0;
  ok(r?.ok === true && r.echo === "render", "a call made while the worker is starting succeeds once it listens");
  ok(s.calls() === 1, `the worker ran the job exactly once (calls=${s.calls()})`);
  ok(took >= 1200 && took < 6000, `the call waited for the worker and no longer (took ${took} ms)`);
  await new Promise((r2) => s.srv.close(r2));
}

// --- edge 502 while starting, then the worker answers -------------------------
{
  const s = stub((req, res, n) => (n <= 2
    ? json(res, 502, { status: "error", code: 502, message: "Application failed to respond" })
    : json(res, 200, { ok: true, n })));
  await listenOn(s.srv, 0);
  process.env.RENDER_WORKER_URL = `http://127.0.0.1:${s.srv.address().port}`;
  const r = await runOnWorker("media-info", {}, { timeoutMs: 20_000, minAttemptMs: 1000 });
  ok(r?.ok === true && r.n === 3, "edge 502s are retried until the worker answers");
  await new Promise((r2) => s.srv.close(r2));
}

// --- the worker's own error is final (no double work) -------------------------
{
  const s = stub((req, res) => json(res, 503, { error: "browser pool busy", retryAfterSeconds: 3 }));
  await listenOn(s.srv, 0);
  process.env.RENDER_WORKER_URL = `http://127.0.0.1:${s.srv.address().port}`;
  let err = null;
  try { await runOnWorker("render", {}, { timeoutMs: 20_000, minAttemptMs: 1000 }); } catch (e) { err = e; }
  ok(err?.statusCode === 503 && err.retryAfter === 3 && /busy/.test(err.message), "the worker's own 503 passes through with its Retry-After");
  ok(s.calls() === 1, `the worker's own error is not retried (calls=${s.calls()})`);
  await new Promise((r2) => s.srv.close(r2));

  const s2 = stub((req, res) => json(res, 422, { error: "bad media" }));
  await listenOn(s2.srv, 0);
  process.env.RENDER_WORKER_URL = `http://127.0.0.1:${s2.srv.address().port}`;
  err = null;
  try { await runOnWorker("audio-convert", {}, { timeoutMs: 20_000, minAttemptMs: 1000 }); } catch (e) { err = e; }
  ok(err?.statusCode === 422 && s2.calls() === 1, "a 4xx from the worker is final and sent once");
  await new Promise((r2) => s2.srv.close(r2));
}

// --- a worker that never starts fails inside the deadline with a 503 ----------
{
  const port = await freePort();
  process.env.RENDER_WORKER_URL = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  let err = null;
  try { await runOnWorker("html-frames", {}, { timeoutMs: 4000, minAttemptMs: 1000 }); } catch (e) { err = e; }
  const took = Date.now() - t0;
  ok(err?.statusCode === 503 && /render worker unreachable/.test(err.message), `a worker that never wakes answers 503 unreachable (${err?.message})`);
  ok(took < 4000, `retries stop while the deadline still has room (took ${took} ms)`);
  ok(Number.isInteger(err?.retryAfter), "the final 503 names a Retry-After");
}

// --- a caller abort stops the wait --------------------------------------------
{
  const port = await freePort();
  process.env.RENDER_WORKER_URL = `http://127.0.0.1:${port}`;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const t0 = Date.now();
  let err = null;
  try { await runOnWorker("render", {}, { signal: ac.signal, timeoutMs: 30_000, minAttemptMs: 1000 }); } catch (e) { err = e; }
  ok(err?.statusCode === 503 && Date.now() - t0 < 2000, `a caller hang-up ends the wake wait (took ${Date.now() - t0} ms)`);
}

await sleep(10);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
