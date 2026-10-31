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
// Protected (never shed): /health, /health/ready, /__operator/*, the MCP connector's
// loopback replay, the Stripe webhook, every priced catalog route and the /v1
// gateway, paid or unpaid - the unpaid 402 is the first step of a purchase.

import { PerformanceObserver, performance } from "node:perf_hooks";
import { recentLagMs, lateTicksRecent } from "./loop-lag.js";

const BUDGET_WINDOW_MS = 1000;

// A search slice is timed by the wall clock, so a garbage-collection pause that
// lands inside it was charged to the budget as search work: on one replica a
// single 300 ms pause filled a third of a second's budget and shed every other
// search in that second (2026-10-31). Node reports a pause a moment after it
// ends, so a budget that asks for it (gcCredit) gives the pause back to every
// slice it overlapped as soon as the report arrives. The cap is unchanged; it
// now counts search work only.
const gcCreditBudgets = new Set();
let gcObserver = null;
function watchGcPauses() {
  if (gcObserver) return;
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const start = performance.timeOrigin + e.startTime;
        for (const b of gcCreditBudgets) b.creditPause(start, start + e.duration);
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });
  } catch { gcObserver = null; /* no gc entries on this runtime: budgets charge wall time as before */ }
}

// 800 ms of search per rolling second across all callers: one router query
// costs about 200 ms, so a caller that asks route and then find inside a
// second is served, while a burst past four queries a second is still shed.
// The per-client share and the in-flight cap in server.js keep one caller
// from spending the whole budget.
export function createComputeBudget({ budgetMs = Number(process.env.DISCOVERY_CPU_BUDGET_MS) || 800, windowMs = BUDGET_WINDOW_MS, gcCredit = false } = {}) {
  const samples = []; // [at, ms, startedAt]: a slice that ran from startedAt to at, ms still charged
  let sum = 0;
  const prune = (now) => { while (samples.length && now - samples[0][0] > windowMs) sum -= samples.shift()[1]; };
  const budget = {
    over(now = Date.now()) { prune(now); return sum >= budgetMs; },
    record(ms, now = Date.now()) { if (!(ms > 0)) return; prune(now); samples.push([now, ms, now - ms]); sum += ms; },
    spent(now = Date.now()) { prune(now); return Math.round(sum); },
    /** Give back the part of each slice that a pause from `start` to `end`
     *  (epoch ms) overlapped. */
    creditPause(start, end) {
      if (!(end > start)) return;
      for (const s of samples) {
        const overlap = Math.min(s[0], end) - Math.max(s[2], start);
        if (overlap <= 0) continue;
        const credit = Math.min(overlap, s[1]);
        s[1] -= credit;
        sum -= credit;
      }
    },
    budgetMs,
  };
  if (gcCredit) { gcCreditBudgets.add(budget); watchGcPauses(); }
  return budget;
}

const LAG_SHED_MS = Number(process.env.SHED_LAG_MS) || 250;
const INFLIGHT_SHED = Number(process.env.SHED_INFLIGHT) || 400;
const counters = { shed: 0, shedLag: 0, shedInflight: 0, discoveryBudget: 0, discoveryInflight: 0, discoveryDeadline: 0, chainSellerView: 0, shedOther: 0, since: Date.now() };

// Shed kind -> its counter. A kind not listed here counts as shedOther.
const KIND_COUNTER = {
  lag: "shedLag",
  inflight: "shedInflight",
  "discovery-budget": "discoveryBudget",
  "discovery-inflight": "discoveryInflight",
  // A discovery compute that passed its deadline: the slot was released and the
  // caller refused, so it is a shed with its own count (server.js, serveCachedDiscovery).
  "discovery-deadline": "discoveryDeadline",
  // A chain market ?seller= view whose build the build cap refused (server.js).
  "chain-seller-view": "chainSellerView",
};
// Counters of FREE work refused by its own bound (the discovery gates and the
// seller-view build cap) while the shared gate let it through: those bounds
// trip on a burst of free requests alone, whatever paid traffic is doing.
// Everything else (lag, in-flight, and any kind not named here) is shedding
// by the shared gate, which means the serving path itself was strained.
export const FREE_SHED_COUNTERS = ["discoveryBudget", "discoveryInflight", "discoveryDeadline", "chainSellerView"];

/** Why free traffic should be refused right now, or null. */
// Lag sheds only while the loop is SATURATED: the smoothed lag is high AND at
// least 3 of the last 4 ticks ran late. A single freeze (a GC pause, one slow
// build, the boot stall after a deploy) is one late tick, and the requests
// that queued behind it are served, not refused - on 2026-09-25 a one-off
// stall refused a /revenue refresh because the old test read only the most
// recent tick, which is the stall itself for every request queued behind it.
// Boot runs several blocking steps back to back (x402 init, warm starts), and
// a new container keeps stalling on its own boot work for well past its first
// request (index warm-up, lazy loads): lag shedding on lag alone in that
// window refused ordinary page reads. So during the warm-up a saturated loop
// sheds only while requests are also backed up (WARMUP_LAG_INFLIGHT in
// flight): boot work saturates the loop with few requests waiting, a flood
// saturates it with many. The in-flight ceiling applies from the start.
const STARTED_AT = Date.now();
const LAG_WARMUP_MS = Number(process.env.SHED_LAG_WARMUP_MS ?? 60_000);
const WARMUP_LAG_INFLIGHT = Number(process.env.SHED_WARMUP_LAG_INFLIGHT) || Math.max(1, Math.round(INFLIGHT_SHED / 4));
const LATE_TICKS_TO_SHED = 3;
export function shouldShedFree({ inFlight = 0, lagMs = recentLagMs(), lateTicks = lateTicksRecent(LAG_SHED_MS / 2), now = Date.now() } = {}) {
  if (String(process.env.LOAD_SHED || "").toLowerCase() === "off") return null;
  const saturated = lagMs >= LAG_SHED_MS && lateTicks >= LATE_TICKS_TO_SHED;
  if (saturated && (now - STARTED_AT >= LAG_WARMUP_MS || inFlight >= WARMUP_LAG_INFLIGHT)) return "lag";
  if (inFlight >= INFLIGHT_SHED) return "inflight";
  return null;
}

export function noteShed(kind) {
  counters.shed++;
  const c = Object.prototype.hasOwnProperty.call(KIND_COUNTER, kind) ? KIND_COUNTER[kind] : "shedOther";
  counters[c]++;
}

/** Counts only, for /__operator/perf.json and the heartbeat. `free` and
 *  `serving` split `shed` by FREE_SHED_COUNTERS; they always sum to it. */
export function shedStatus() {
  const free = FREE_SHED_COUNTERS.reduce((n, k) => n + counters[k], 0);
  return { ...counters, free, serving: counters.shed - free, lagShedMs: LAG_SHED_MS, inFlightShed: INFLIGHT_SHED, warmupLagInFlight: WARMUP_LAG_INFLIGHT };
}

/** The serving-health words for shedding. `shedding` (degrades) when the
 *  shared gate's sheds (lag, in-flight, any unlisted kind) pass the hourly
 *  threshold; `free-shedding` (informational, does not degrade) when free work
 *  refused by its own bound passes it. Paid routes are never shed (the gate
 *  protects them), and their errors and the loop's lag have reasons of their own. */
export function shedVerdict(status, threshold, now = Date.now()) {
  const reasons = [], info = [];
  if (!status || now - status.since >= 3600_000) return { reasons, info };
  const free = Number.isFinite(status.free) ? status.free : FREE_SHED_COUNTERS.reduce((n, k) => n + (Number(status[k]) || 0), 0);
  const serving = Number.isFinite(status.serving) ? status.serving : (Number(status.shed) || 0) - free;
  if (serving > threshold) reasons.push("shedding");
  if (free > threshold) info.push("free-shedding");
  return { reasons, info };
}

/** `extra` (optional) adds fields to the body, such as a `reason` naming which
 *  bound refused the call; the error text and Retry-After stay the same. */
export function shedResponse(res, retryAfter = 2, extra = null) {
  // Marked so the 5xx-rate counts leave it out: shedding is deliberate and has its own alarm reason.
  if (res.locals) res.locals.shed = true;
  res.set("Retry-After", String(retryAfter));
  res.set("Cache-Control", "no-store");
  return res.status(503).json({
    error: "The server is busy; free and discovery requests are paused briefly so paid calls keep flowing.",
    retryAfterSeconds: retryAfter,
    ...(extra && typeof extra === "object" ? extra : {}),
  });
}

/** Zero the counters (hourly from the server, so they read "since the last hour"). */
export function resetShedCounters() { for (const k of Object.keys(counters)) counters[k] = k === "since" ? Date.now() : 0; }
