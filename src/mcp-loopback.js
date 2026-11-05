// The MCP connector's loopback marker. The connector replays a paid tool call
// to our own route over 127.0.0.1 (src/mcp-mpp.js) and marks it, and a marked
// replay is exempt from the unpaid-quote budget, the discovery limit, load
// shedding and the sync windows, and is booked on the "mcp" sale path.
//
// A loopback socket alone does not prove the replay: a self-host behind a
// same-host proxy (nginx, a tunnel) sees every client on a loopback socket,
// and the header itself is caller text. So the marker carries a per-process
// random secret, made here at import and never logged or published:
//
//   X-Agent402-Via: mcp;k=<48 hex>
//
// isMcpLoopback answers true only for that exact value on a loopback socket.
// Its first read of a request removes the header (a genuine one included, so
// no handler can echo the secret) and remembers the verdict for that request;
// stripMcpMarker is the same read as a middleware, mounted before the routes.
import { randomBytes, timingSafeEqual } from "node:crypto";

export const MCP_VIA_HEADER = "x-agent402-via";
const SECRET_RE = /^[0-9a-f]{48}$/;

// A test that boots a server in a child process cannot read this process's
// secret, so it may hand one in. Honored only outside production.
function secretOf(env = process.env) {
  const given = String(env.MCP_LOOPBACK_TEST_SECRET || "").trim().toLowerCase();
  const production = env.NODE_ENV === "production" || !!env.RAILWAY_ENVIRONMENT_NAME;
  if (given && !production && SECRET_RE.test(given)) return given;
  return randomBytes(24).toString("hex");
}
const SECRET = secretOf();
const MARKER = `mcp;k=${SECRET}`;

/** The marker header the connector's loopback replay sends (src/mcp-mpp.js). */
export function mcpLoopbackHeaders() {
  return { "X-Agent402-Via": MARKER };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const verdicts = new WeakMap();

function sameMarker(value) {
  const a = Buffer.from(String(value ?? ""), "utf8");
  const b = Buffer.from(MARKER, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when `req` is the connector's own loopback replay: the exact marker,
 *  secret included, on a loopback socket. Removes the marker header on its
 *  first read and answers the same verdict for that request afterwards. */
export function isMcpLoopback(req) {
  if (!req || typeof req !== "object") return false;
  if (verdicts.has(req)) return verdicts.get(req);
  const headers = req.headers && typeof req.headers === "object" ? req.headers : null;
  const raw = headers ? headers[MCP_VIA_HEADER] : undefined;
  let genuine = false;
  if (raw !== undefined) {
    genuine = typeof raw === "string" && sameMarker(raw.trim()) && LOOPBACK.has(String(req.socket?.remoteAddress || ""));
    delete headers[MCP_VIA_HEADER];
  }
  verdicts.set(req, genuine);
  return genuine;
}

/** Middleware: read (and remove) the marker before any route runs. */
export function stripMcpMarker(req, _res, next) {
  isMcpLoopback(req);
  next();
}
