// Admission control: paid calls first, always.
//
// Measured locally on 2026-09-25 against the production-sized index: 50
// addresses sending uncached /api/route searches pushed a steady paid-path
// probe to a 10 s median with a quarter of its calls timing out. The per-IP
// discovery limiter is right for one caller and blind to many. Node has one
// thread, so a paid call cannot preempt free work; the only lever is to refuse
// free work early and cheaply when it would crowd the thread.
//
// Two gates:
//   1. discoveryBudget: the synchronous CPU time uncached /api/find and
//      /api/route computes may spend per rolling second, across ALL callers.
//      Past it, the next uncached search answers 503 + Retry-After before it
//      computes. Cache hits never count and are never refused.
//   2. shouldShedFree(): event-loop lag (EWMA from loop-lag's ticks) or the
//      in-flight request count past a threshold sheds any request that is not
//      protected - see isProtected - with 503 + Retry-After, before parsing.
//
// Protected (never shed): /health, /__operator/*, the MCP connector's
// loopback replay, the Stripe webhook, every priced catalog route and the /v1
// gateway, paid or unpaid - the unpaid 402 is the first step of a purchase.

import { recentLagMs, lateTicksRecent } from "./loop-lag.js";

const BUDGET_WINDOW_MS = 1000;

export function createComputeBudget({ budgetMs = Number(process.env.DISCOVERY_CPU_BUDGET_MS) || 300, windowMs = BUDGET_WINDOW_MS } = {}) {
  const samples = []; // [at, ms]
  let sum = 0;
  const prune = (now) => { while (samples.length && now - samples[0][0] > windowMs) sum -= samples.shift()[1]; };
  return {
    over(now = Date.now()) { prune(now); return sum >= budgetMs; },
    record(ms, now = Date.now()) { if (!(ms > 0)) return; prune(now); samples.push([now, ms]); sum += ms; },
    spent(now = Date.now()) { prune(now); return Math.round(sum); },
    budgetMs,
  };
}

const LAG_SHED_MS = Number(process.env.SHED_LAG_MS) || 250;
const INFLIGHT_SHED = Number(process.env.SHED_INFLIGHT) || 400;
const counters = { shed: 0, shedLag: 0, shedInflight: 0, discoveryBudget: 0, discoveryInflight: 0, since: Date.now() };

/** Why free traffic should be refused right now, or null. */
// Lag sheds only while the loop is SATURATED: the smoothed lag is high AND at
// least 3 of the last 4 ticks ran late. A single freeze (a GC pause, one slow
// build, the boot stall after a deploy) is one late tick, and the requests
// that queued behind it are served, not refused - on 2026-09-25 a one-off
// stall refused a /revenue refresh because the old test read only the most
// recent tick, which is the stall itself for every request queued behind it.
// Boot runs several blocking steps back to back (x402 init, warm starts), so
// lag does not shed during a warm-up either. The in-flight ceiling still
// applies from the start.
const STARTED_AT = Date.now();
const LAG_WARMUP_MS = Number(process.env.SHED_LAG_WARMUP_MS ?? 60_000);
const LATE_TICKS_TO_SHED = 3;
export function shouldShedFree({ inFlight = 0, lagMs = recentLagMs(), lateTicks = lateTicksRecent(LAG_SHED_MS / 2), now = Date.now() } = {}) {
  if (String(process.env.LOAD_SHED || "").toLowerCase() === "off") return null;
  if (now - STARTED_AT >= LAG_WARMUP_MS && lagMs >= LAG_SHED_MS && lateTicks >= LATE_TICKS_TO_SHED) return "lag";
  if (inFlight >= INFLIGHT_SHED) return "inflight";
  return null;
}

export function noteShed(kind) {
  counters.shed++;
  if (kind === "lag") counters.shedLag++;
  else if (kind === "inflight") counters.shedInflight++;
  else if (kind === "discovery-budget") counters.discoveryBudget++;
  else if (kind === "discovery-inflight") counters.discoveryInflight++;
}

/** Counts only, for /__operator/perf.json and the heartbeat. */
export function shedStatus() { return { ...counters, lagShedMs: LAG_SHED_MS, inFlightShed: INFLIGHT_SHED }; }

export function shedResponse(res, retryAfter = 2) {
  // Marked so the 5xx-rate counts leave it out: shedding is deliberate and has its own alarm reason.
  if (res.locals) res.locals.shed = true;
  res.set("Retry-After", String(retryAfter));
  res.set("Cache-Control", "no-store");
  return res.status(503).json({
    error: "The server is busy; free and discovery requests are paused briefly so paid calls keep flowing.",
    retryAfterSeconds: retryAfter,
  });
}

/** Zero the counters (hourly from the server, so they read "since the last hour"). */
export function resetShedCounters() { for (const k of Object.keys(counters)) counters[k] = k === "since" ? Date.now() : 0; }
export const __resetShedForTest = resetShedCounters;
