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

/** The marker header the connector's loopback replay sends (src/mcp-mpp.js),
 *  with the paid replay's call id when it has one (openLoopbackCall), and a
 *  task run's key when the replay runs one (src/mcp-tasks.js newRunKey): the
 *  route books that key on the sale it makes for the replay. */
export function mcpLoopbackHeaders({ callId = null, runKey = null, grantHandle = null } = {}) {
  return {
    ...(typeof grantHandle === "string" && GRANT_RE.test(grantHandle) ? { "X-Agent402-Via-Grant": grantHandle } : {}),
    "X-Agent402-Via": MARKER,
    ...(typeof callId === "string" && CALL_RE.test(callId) ? { "X-Agent402-Via-Call": callId } : {}),
    ...(typeof runKey === "string" && RUN_RE.test(runKey) ? { "X-Agent402-Via-Run": runKey } : {}),
  };
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
  // The call id is read only beside a genuine marker, and removed either way.
  const call = headers ? headers[MCP_CALL_HEADER] : undefined;
  if (call !== undefined) {
    if (genuine && typeof call === "string" && CALL_RE.test(call.trim())) callIdOf.set(req, call.trim());
    delete headers[MCP_CALL_HEADER];
  }
  // So is a task run's key: caller text anywhere else.
  const run = headers ? headers[MCP_RUN_HEADER] : undefined;
  if (run !== undefined) {
    if (genuine && typeof run === "string" && RUN_RE.test(run.trim())) runKeyOf.set(req, run.trim());
    delete headers[MCP_RUN_HEADER];
  }
  // So is a connector grant's handle (src/mcp-oauth.js): read only beside a
  // genuine marker, and spent here, so a handle pays for one replay.
  const grantH = headers ? headers[MCP_GRANT_HEADER] : undefined;
  if (grantH !== undefined) {
    if (genuine && typeof grantH === "string" && GRANT_RE.test(grantH.trim())) {
      const g = takeGrantHandle(grantH.trim());
      if (g) grantOfReq.set(req, g);
    }
    delete headers[MCP_GRANT_HEADER];
  }
  verdicts.set(req, genuine);
  return genuine;
}

// ---- A connector grant's call -------------------------------------------------
// The connector resolves a bearer to a grant, opens a handle for one paid
// replay (openGrantHandle: random, in this process only, short-lived), and
// sends it beside the marker. The credits gate reads the grant with
// loopbackGrantOf; nothing a caller sends can name one.
export const MCP_GRANT_HEADER = "x-agent402-via-grant";
const GRANT_RE = /^[0-9a-f]{48}$/;
const GRANT_HANDLE_TTL_MS = 60_000;
const GRANT_HANDLES_MAX = 5_000;
const grantHandles = new Map(); // handle -> { at, grant }
const grantOfReq = new WeakMap();
function takeGrantHandle(h) {
  const e = grantHandles.get(h);
  grantHandles.delete(h);
  return e && Date.now() - e.at < GRANT_HANDLE_TTL_MS ? e.grant : null;
}
/** A handle for one paid replay under `grant` ({ id, keyId, capUsd }). */
export function openGrantHandle(grant) {
  const h = randomBytes(24).toString("hex");
  grantHandles.set(h, { at: Date.now(), grant: Object.freeze({ id: String(grant.id), keyId: String(grant.keyId), capUsd: Number(grant.capUsd) }) });
  const now = Date.now();
  for (const [k, e] of grantHandles) {
    if (grantHandles.size <= GRANT_HANDLES_MAX && now - e.at < GRANT_HANDLE_TTL_MS) break;
    grantHandles.delete(k);
  }
  return h;
}
/** The grant a genuine replay is paid under, or null. */
export function loopbackGrantOf(req) {
  if (!isMcpLoopback(req)) return null;
  return grantOfReq.get(req) || null;
}

/** The task run's key on a genuine replay that names one, or null. */
export function loopbackRunKeyOf(req) {
  if (!isMcpLoopback(req)) return null;
  return runKeyOf.get(req) || null;
}

/** Middleware: read (and remove) the marker before any route runs. */
export function stripMcpMarker(req, _res, next) {
  isMcpLoopback(req);
  next();
}

// ---- A paid replay the connector stopped waiting for -------------------------
// The connector names each paid replay (a random call id, sent beside the
// marker and read only with it) and says how it ended for the connector: the
// answer arrived (closeLoopbackCall) or the connector stopped waiting
// (cutLoopbackCall: its deadline, a loopback error). The route says how it
// ended for the route (watchLoopbackOutcome). Whichever side ends second acts:
//   - CHARGED, NOT RECEIVED. A route that wrote a settled 200 in full and a
//     connector that stopped waiting for it, in either order (a stall of the
//     event loop can let the connector's deadline fire after the answer was
//     written to the socket, and the route then saw an ordinary delivery):
//     the route's `onSettledCut` runs once (the server books the charge as
//     owed). A close before the first byte is the hang-up recorder's
//     (src/hangup-settlement.js), as on any other request.
//   - ONE OUTCOME PER CALL. A route ending after the cut leaves the outcome
//     to the connector's own count (loopbackCallCut); a cut after the route
//     counted its outcome is not counted again (cutLoopbackCall answers
//     routeCounted).
// Bounded: an entry ends when both sides have spoken, or after
// LOOPBACK_CALL_TTL_MS; past LOOPBACK_CALLS_MAX the oldest goes first.
export const MCP_CALL_HEADER = "x-agent402-via-call";
const CALL_RE = /^[0-9a-f]{32}$/;
export const MCP_RUN_HEADER = "x-agent402-via-run";
const RUN_RE = /^[0-9a-f]{32}$/;
const runKeyOf = new WeakMap(); // request -> task run key (a genuine replay's only)
export const LOOPBACK_CALL_TTL_MS = 15 * 60_000;
export const LOOPBACK_CALLS_MAX = 5_000;
const loopCalls = new Map(); // call id -> { at, cut, routeEnded, counted, onSettledCut }
const callIdOf = new WeakMap(); // request -> call id (a genuine replay's only)

function pruneCalls(now = Date.now()) {
  for (const [id, e] of loopCalls) {
    if (loopCalls.size <= LOOPBACK_CALLS_MAX && now - e.at < LOOPBACK_CALL_TTL_MS) break;
    loopCalls.delete(id);
  }
}
/** A new paid replay's call id (the connector, before the loopback). */
export function openLoopbackCall() {
  const id = randomBytes(16).toString("hex");
  loopCalls.set(id, { at: Date.now(), cut: false, routeEnded: false, counted: false, onSettledCut: null });
  pruneCalls();
  return id;
}
/** The connector received the route's answer: nothing is owed for it. */
export function closeLoopbackCall(id) { loopCalls.delete(String(id)); }
/** The connector stopped waiting. Runs the route's booking when the route
 *  already wrote a settled answer; answers whether the route counted the
 *  call's outcome (the connector then does not count it again). */
export function cutLoopbackCall(id) {
  const e = loopCalls.get(String(id));
  if (!e) return { routeCounted: false };
  e.cut = true;
  const counted = e.counted;
  if (e.routeEnded) {
    loopCalls.delete(String(id));
    const fn = e.onSettledCut;
    if (fn) { try { fn(); } catch { /* booking never breaks the connector */ } }
  }
  return { routeCounted: counted };
}
/** The connector's call id on a genuine replay, or null. */
export function loopbackCallIdOf(req) {
  if (!isMcpLoopback(req)) return null;
  return callIdOf.get(req) || null;
}
/** True when the connector already stopped waiting for this replay. */
export function loopbackCallCut(req) {
  const id = loopbackCallIdOf(req);
  return Boolean(id && loopCalls.get(id)?.cut);
}
/** The route counted this replay's outcome. */
export function noteLoopbackCounted(req) {
  const id = loopbackCallIdOf(req);
  const e = id ? loopCalls.get(id) : null;
  if (e) e.counted = true;
}
/**
 * The route side, registered before the gates: when the answer was written
 * in full (`finish`), `settled(res)` says whether it carries a settled
 * charge; if so and the connector stopped (or stops) waiting,
 * `onSettledCut()` runs once. A response that closes without finishing ends
 * the route's side with nothing to book. No-op off a genuine replay.
 */
export function watchLoopbackOutcome(req, res, { settled, onSettledCut }) {
  const id = loopbackCallIdOf(req);
  if (!id || !res || typeof res.once !== "function") return false;
  let done = false;
  const end = (book) => {
    if (done) return;
    done = true;
    const e = loopCalls.get(id);
    if (!e) return; // the connector received the answer
    if (e.cut) {
      loopCalls.delete(id);
      if (book) { try { onSettledCut(); } catch { /* booking never breaks serving */ } }
      return;
    }
    e.routeEnded = true;
    e.onSettledCut = book ? onSettledCut : null;
  };
  res.once("finish", () => { let book = false; try { book = Boolean(settled(res)); } catch { book = false; } end(book); });
  res.once("close", () => end(false));
  return true;
}
/** Test seam: the open entries. */
export function _loopbackCallsForTest() { return loopCalls; }
