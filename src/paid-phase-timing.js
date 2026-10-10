// Where a paid call's time goes, per rail: verify, handler, settle.
//
// WHY: a paid stock-quote took ~11 s end to end and the buyer's ~10 s timeout
// closed first, so it was charged and not delivered. The route timer
// (src/request-timing.js) sees one number per route; it cannot say whether the
// facilitator's verify, our handler or the settlement call ate the budget, nor
// on which rail. This records, for every paid call that reached its handler:
//   verifyMs   facilitator verify (x402 and the MPP evm shim, which is x402
//              underneath): onBeforeVerify -> onAfterVerify / onVerifyFailure
//   handlerMs  handler start (the post-gate dispatcher) -> its first res.end
//              (the gate buffers that end until it settles, so this is the
//              handler alone)
//   settleMs   onBeforeSettle -> onAfterSettle; a settlement recovered by a
//              fallback facilitator fires no afterSettle, so its end is the
//              response's end
//   gateMs     arrival -> handler start, on EVERY rail
//   afterMs    handler end -> response end, on EVERY rail
// The Tempo, Stripe and credits gates have no verify/settle hooks of their own,
// so on those rails verifyMs and settleMs are null and gateMs / afterMs carry
// the same split: what their gate did before the handler (a Tempo push
// credential is finalized there) and after it (the Tempo broadcast, the Stripe
// capture, the credits debit).
//
// Output: one log line per paid call (slug, rail, network, status, the phases,
// whether the buyer left) and a rolling per-rail p50/p95 over the last
// PAID_TIMING_WINDOW calls for the operator surface. Never a payer, a
// transaction hash, an input or an IP. In memory, reset by a deploy.
import { performance } from "node:perf_hooks";
import { railOf } from "./payment-rail.js";
import { clientGoneBeforeFirstByte } from "./hangup-settlement.js";

const KEY = "__a402Phases";
const windowSize = () => { const n = Number(process.env.PAID_TIMING_WINDOW); return Number.isInteger(n) && n > 0 ? Math.min(n, 5000) : 200; };
const logOn = () => String(process.env.PAID_TIMING_LOG || "").toLowerCase() !== "off";
const rings = new Map(); // rail -> rows (newest last)

const now = () => performance.now();
function phasesOf(req, create = true) {
  if (!req || typeof req !== "object") return null;
  if (Object.hasOwn(req, KEY)) return req[KEY];
  if (!create) return null;
  const s = { arrived: null };
  try { Object.defineProperty(req, KEY, { value: s, enumerable: false, configurable: true, writable: true }); } catch { return null; }
  return s;
}
const reqOf = (ctx) => ctx?.transportContext?.request?.adapter?.req;

/** Mounted before every payment gate: stamps the arrival. */
export function phaseArrivalMiddleware() {
  return (req, _res, next) => { const s = phasesOf(req); if (s && s.arrived == null) s.arrived = now(); next(); };
}

/** x402 (and MPP evm) verify/settle marks. Hooks only record; none aborts or recovers. */
export function registerPhaseTimingHooks(server) {
  const mark = (field, extra) => (ctx) => {
    try {
      const s = phasesOf(reqOf(ctx));
      if (!s) return;
      if (s[field] == null) s[field] = now();
      const net = ctx?.requirements?.network;
      if (net && !s.network) s.network = String(net);
      if (extra) extra(s, ctx);
    } catch { /* timing must never touch a payment */ }
  };
  server.onBeforeVerify(mark("verifyStart"));
  server.onAfterVerify(mark("verifyEnd"));
  server.onVerifyFailure(mark("verifyEnd", (s) => { s.verifyFailed = true; }));
  server.onBeforeSettle(mark("settleStart"));
  server.onAfterSettle(mark("settleEnd", (s, ctx) => { s.settled = ctx?.result?.success === true; }));
  server.onSettleFailure(mark("settleFailedAt"));
  return server;
}

/**
 * Called where the handler is about to run (after every gate). Marks the
 * start, wraps res.end OUTSIDE the gate's buffering wrapper so the handler's
 * own end is the handler-end mark, and records the call when the response
 * closes (finished or abandoned).
 */
export function markPaidHandlerStart(req, res, slug) {
  const s = phasesOf(req);
  if (!s || s.handlerStart != null) return;
  s.handlerStart = now();
  s.slug = String(slug || "");
  const record = () => { if (s.recorded) return; s.recorded = true; try { recordPaidCall(req, res, s); } catch { /* never break a response */ } };
  const innerEnd = res.end;
  res.end = function phaseEnd(...args) {
    if (s.handlerEnd == null) s.handlerEnd = now();
    // A buyer who left mid-handler closed the response first; the handler's
    // own end completes the record.
    if (s.closedAt != null) record();
    return innerEnd.apply(this, args);
  };
  res.once("close", () => {
    s.closedAt = now();
    if (s.handlerEnd != null) return record();
    // Still running: record when the handler ends, or after a bound with the
    // handler time unknown.
    const t = setTimeout(record, HANDLER_WAIT_MS);
    t.unref?.();
  });
}
const HANDLER_WAIT_MS = 120_000;

const ms = (a, b) => (a != null && b != null && b >= a ? Math.round(b - a) : null);

function recordPaidCall(req, res, s) {
  const closedAt = s.closedAt ?? now();
  const finished = res.writableFinished === true;
  const gone = clientGoneBeforeFirstByte(req) ? "before-first-byte" : finished ? "no" : "mid-response";
  const rail = railOf(req) || (s.verifyStart != null ? "x402" : "unknown");
  const row = {
    slug: s.slug,
    rail,
    network: s.network || null,
    status: res.statusCode,
    verifyMs: ms(s.verifyStart, s.verifyEnd),
    handlerMs: ms(s.handlerStart, s.handlerEnd),
    settleMs: s.settleStart != null ? ms(s.settleStart, s.settleEnd ?? closedAt) : null,
    gateMs: ms(s.arrived, s.handlerStart),
    afterMs: s.handlerEnd != null && s.handlerEnd <= closedAt ? ms(s.handlerEnd, closedAt) : null,
    totalMs: ms(s.arrived, closedAt),
    gone,
  };
  const ring = rings.get(rail) || [];
  ring.push(row);
  while (ring.length > windowSize()) ring.shift();
  rings.set(rail, ring);
  if (logOn()) {
    const f = (v) => (v == null ? "-" : `${v}ms`);
    console.log(`[paid-timing] ${row.slug} rail=${row.rail} net=${row.network || "-"} status=${row.status} verify=${f(row.verifyMs)} handler=${f(row.handlerMs)} settle=${f(row.settleMs)} gate=${f(row.gateMs)} after=${f(row.afterMs)} total=${f(row.totalMs)} gone=${row.gone}`);
  }
  return row;
}

function pct(values, p) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
}

/** Per-rail p50/p95 for each phase over the rolling window (operator only). */
export function paidPhaseSummary() {
  const out = { window: windowSize(), rails: {} };
  for (const [rail, ring] of rings) {
    const phase = (k) => ({ p50: pct(ring.map((r) => r[k]), 50), p95: pct(ring.map((r) => r[k]), 95) });
    out.rails[rail] = {
      calls: ring.length,
      gone: ring.filter((r) => r.gone !== "no").length,
      verifyMs: phase("verifyMs"), handlerMs: phase("handlerMs"), settleMs: phase("settleMs"),
      gateMs: phase("gateMs"), afterMs: phase("afterMs"), totalMs: phase("totalMs"),
      slowestSlugs: [...ring].sort((a, b) => (b.totalMs ?? 0) - (a.totalMs ?? 0)).slice(0, 5).map((r) => ({ slug: r.slug, totalMs: r.totalMs, handlerMs: r.handlerMs, settleMs: r.settleMs })),
    };
  }
  return out;
}

/** Test hook. */
export function _resetPaidPhases() { rings.clear(); }
