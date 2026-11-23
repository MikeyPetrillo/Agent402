// The free discovery documents, kept for when the load gate sheds.
//
// The load gate (src/load-shed.js, wired in server.js) refuses free work with a
// 503 while the event loop lags or too many requests are in flight, so the
// thread stays free for paid calls. The documents an agent reads to learn how
// to buy (the x402 manifest and its aliases, /openapi.json, /llms.txt,
// /llms-full.txt, /api/pricing) are the first step of a purchase, and a 503
// there loses the buyer before the 402. Each one's last 200 is kept as bytes
// when it is served normally (`capture`, mounted after the compressor so the
// bytes are the plain ones), and while the gate sheds, a GET or HEAD with no
// query is answered from that copy (`serve`): sending a kept buffer costs the
// thread next to nothing. The copy carries its own content type, cache and
// CORS headers, its ETag (a matching If-None-Match answers 304) and an Age
// header in seconds. A copy older than DISCOVERY_SNAPSHOT_MAX_AGE_MS (default
// one hour, the documents' own public cache time), a document never served
// since boot, and any request with a query are shed as before.

export const DISCOVERY_SNAPSHOT_PATHS = new Set([
  "/.well-known/x402",
  "/.well-known/x402.json",
  "/.well-known/x402-services.json",
  "/openapi.json",
  "/llms.txt",
  "/llms-full.txt",
  "/api/pricing",
]);
const KEEP_HEADERS = ["content-type", "cache-control", "etag", "access-control-allow-origin", "access-control-expose-headers", "link"];
const MAX_BYTES = 16 * 1024 * 1024;

function maxAgeFromEnv(env = process.env) {
  const n = Number(env.DISCOVERY_SNAPSHOT_MAX_AGE_MS);
  return Number.isFinite(n) && n > 0 ? n : 3600_000;
}

const hasQuery = (req) => String(req.originalUrl || req.url || "").includes("?");

export function createDiscoverySnapshots({ maxAgeMs = maxAgeFromEnv(), maxBytes = MAX_BYTES, now = Date.now, paths = DISCOVERY_SNAPSHOT_PATHS } = {}) {
  const kept = new Map(); // path -> { body, headers, at }
  let served = 0;

  /** Keep a document's plain bytes and the headers worth replaying. */
  function keep(path, body, headers = {}) {
    if (!paths.has(path) || !Buffer.isBuffer(body) || body.length > maxBytes) return;
    const h = {};
    for (const k of KEEP_HEADERS) {
      const v = headers[k];
      if (v !== undefined && v !== null && v !== "") h[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    kept.set(path, { body, headers: h, at: now() });
  }

  /** Express middleware: keeps the plain bytes of each document's 200. */
  function capture(req, res, next) {
    if (req.method !== "GET" || !paths.has(req.path) || hasQuery(req)) return next();
    const chunks = [];
    let size = 0, over = false;
    const add = (chunk, enc) => {
      if (over || chunk === undefined || chunk === null || typeof chunk === "function") return;
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof enc === "string" ? enc : "utf8");
      size += b.length;
      if (size > maxBytes) { over = true; chunks.length = 0; return; }
      chunks.push(b);
    };
    const write = res.write, end = res.end;
    res.write = function (chunk, enc, cb) { add(chunk, enc); return write.call(this, chunk, enc, cb); };
    res.end = function (chunk, enc, cb) {
      add(chunk, enc);
      if (!over && res.statusCode === 200) {
        try { keep(req.path, Buffer.concat(chunks), res.getHeaders()); } catch { /* the answer goes out regardless */ }
      }
      return end.call(this, chunk, enc, cb);
    };
    next();
  }

  /** Answer a shed request from its kept copy; false when there is none to give. */
  function serve(req, res) {
    if ((req.method !== "GET" && req.method !== "HEAD") || !paths.has(req.path) || hasQuery(req)) return false;
    const snap = kept.get(req.path);
    if (!snap) return false;
    const age = now() - snap.at;
    if (age > maxAgeMs) return false;
    for (const [k, v] of Object.entries(snap.headers)) res.set(k, v);
    res.set("age", String(Math.max(0, Math.floor(age / 1000))));
    served++;
    const inm = String(req.headers?.["if-none-match"] || "");
    if (snap.headers.etag && inm && inm.includes(snap.headers.etag)) { res.status(304).end(); return true; }
    res.status(200);
    if (req.method === "HEAD") res.end();
    else res.end(snap.body);
    return true;
  }

  /** Counts only. */
  function status() {
    return { kept: kept.size, served, maxAgeMs };
  }

  return { capture, serve, keep, status };
}
