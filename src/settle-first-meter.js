// Settle first, the budget mode: WHEN a wallet that has never settled with us
// has its payment settled before the upstream work.
//
// In normal operation every buyer is served first and charged only on
// success (CLAUDE.md, "x402 settlement ordering"). That order lets a payment
// that verified and then did not settle cost us the run it bought, once per
// fresh wallet. This module meters what that costs, and turns the budget
// mode on only when it is costing more than a budget:
//
//   the figure = the upstream cost of the /v1 model runs that ended
//                unsettled in the last 24 hours (a rolling window)
//              + the price of the runs now in flight from wallets that have
//                never settled and were served first (what is at risk until
//                each one settles).
//
// While the figure is at or above GATEWAY_SETTLE_FIRST_BUDGET_USD (default 5)
// the mode is on and a never-settled wallet settles at its run's settle point
// (src/settle-first.js, src/gateway-settle-breaker.js gatewaySettleFirstDue);
// once the figure falls back under it the mode is off and every wallet is
// served first again. The mode refuses nobody: it moves one settlement earlier.
//
// HOW A RUN IS PRICED. The upstream's own charge for the run when it reported
// one (OpenRouter's usage.cost, read where the gateway strips it), else the
// private cost table's rate for the model actually served and the tokens it
// used (src/direct-upstream-spend.js), noted on the run's request scope
// (noteRunUpstreamUsd). A run that noted nothing (a route whose upstream
// reports no cost) is priced at the price quoted for it, which is at or above
// its upstream cost, so the mode can only turn on sooner. A run whose payment
// was refused at its settle point, or that was asked for an exact payment,
// made no upstream call and is not metered. No figure is printed anywhere
// public: the operator view of /api/gateway-status carries them, and the log
// says only "on" or "off".
//
// SHARED AND DURABLE. With a Redis (REDIS_URL, src/shared-limits.js) the
// unsettled cost is kept per minute in one hash per clock hour (tally
// sfm-cost, 26 hours of life), so every replica adds to and reads the same
// window, the storage is bounded whatever the call rate, and a restart reads
// it back (the production Redis keeps an append-only file). The at-risk runs
// are entries of a sliding window (sfm-risk) removed when each run ends and
// aged out after 15 minutes if a process dies. Each process also keeps its
// own figures, and the larger of its own and the shared one is read. A read
// is made at most every REFRESH_MS, only when a never-settled wallet's run is
// being decided. Without a Redis the figures are this process's own and a
// restart starts them at zero.
//
// WHEN THE METER CANNOT BE READ (a Redis is configured and it did not
// answer, or has not answered yet): the mode reads ON. That answer refuses
// nobody; it only settles a new wallet's payment before its run.
//
// GATEWAY_SETTLE_FIRST: off (no run settles first, whatever the meter),
// always (the mode is on whatever the meter), anything else or unset: auto.
import { shared, sharedLimitsEnabled, noteSharedLimitsDegraded } from "./shared-limits.js";
import { currentRequestScope } from "./request-timing.js";

export const SETTLE_FIRST_BUDGET_ENV = "GATEWAY_SETTLE_FIRST_BUDGET_USD";
export const SETTLE_FIRST_DEFAULT_BUDGET_USD = 5;
const WINDOW_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;
const MINUTE_MS = 60_000;
const COST_TTL_MS = 26 * HOUR_MS;
/** How long an at-risk entry outlives a process that died with it. */
const RISK_WINDOW_MS = 15 * MINUTE_MS;
/** How often the shared figures are read, at most. */
export const REFRESH_MS = 10_000;
const CONTROL = "settle-first-meter";
const PROC = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/** The budget in USD (a blank, malformed or non-positive value reads the default). */
export function settleFirstBudgetUsd(env = process.env) {
  const raw = String(env[SETTLE_FIRST_BUDGET_ENV] ?? "").trim();
  const n = raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : SETTLE_FIRST_DEFAULT_BUDGET_USD;
}
/** "off", "always" or "auto" (GATEWAY_SETTLE_FIRST). */
export function settleFirstSwitch(env = process.env) {
  const v = String(env.GATEWAY_SETTLE_FIRST ?? "").trim().toLowerCase();
  return v === "off" ? "off" : v === "always" ? "always" : "auto";
}

// ---- the run's own upstream cost ---------------------------------------------
const RUN_COST = Symbol("a402.runUpstreamUsd");
const RUN_SCOPE = Symbol("a402.runScope");
/** Add `usd` to the upstream cost of the run whose request scope this call
 *  is in. Never throws; a value that is not a finite non-negative number is
 *  ignored. */
export function noteRunUpstreamUsd(usd) {
  try {
    const n = Number(usd);
    if (typeof usd !== "number" || !Number.isFinite(n) || n <= 0) return;
    const s = currentRequestScope();
    if (s && typeof s === "object") s[RUN_COST] = (Number(s[RUN_COST]) || 0) + n;
  } catch { /* metering only */ }
}
/** Keep the request's scope on the request (own, non-enumerable), so its run
 *  cost can be read when the response ends, outside that scope. */
export function bindRunScope(req) {
  try {
    const s = currentRequestScope();
    if (s && req && typeof req === "object" && !Object.hasOwn(req, RUN_SCOPE)) Object.defineProperty(req, RUN_SCOPE, { value: s, enumerable: false, configurable: true });
  } catch { /* nothing kept: the run is priced at its quote */ }
}
/** The upstream cost noted for this request's run, in USD (0 when none). */
export function runUpstreamUsdOf(req) {
  const s = req && typeof req === "object" && Object.hasOwn(req, RUN_SCOPE) ? req[RUN_SCOPE] : null;
  const v = s ? Number(s[RUN_COST]) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// ---- the figures, in micro-dollars ------------------------------------------
const micro = (usd) => (typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? Math.round(usd * 1e6) : 0);
const hourOf = (t) => Math.floor(t / HOUR_MS);
const minuteOf = (t) => Math.floor(t / MINUTE_MS);
// This process's unsettled cost: minute -> micro-dollars.
const ownCost = new Map();
// This process's at-risk runs: id -> micro-dollars.
const ownRisk = new Map();
let riskSeq = 0;
function pruneOwn(now) {
  const cutoff = minuteOf(now - WINDOW_MS);
  for (const m of ownCost.keys()) if (m <= cutoff) ownCost.delete(m);
}
function ownCostMicro(now) {
  pruneOwn(now);
  let s = 0;
  for (const v of ownCost.values()) s += v;
  return s;
}
function ownRiskMicro() { let s = 0; for (const v of ownRisk.values()) s += v; return s; }

/** One /v1 run that ended unsettled cost `usd` upstream: added to the window. */
export function noteUnsettledRunCost(usd, now = Date.now()) {
  const m = micro(usd);
  if (!m) return;
  const min = minuteOf(now);
  ownCost.set(min, (ownCost.get(min) || 0) + m);
  // This process's share of the shared view is fresh at once.
  view.costMicro += m;
  if (sharedLimitsEnabled()) {
    void Promise.resolve(shared.tallyAdd("sfm-cost", String(hourOf(now)), [[String(min), m]], COST_TTL_MS)).then((r) => {
      if (!r?.ok) { noteSharedLimitsDegraded(CONTROL, r); view.unread = true; }
    }, () => { view.unread = true; });
  }
}

/**
 * A run from a wallet that has never settled is served first: its price is
 * at risk until it ends. Returns the release (call it once, when the run
 * ends; a second call does nothing).
 */
export function reserveAtRisk(usd, now = Date.now()) {
  const m = micro(usd);
  if (!m) return () => {};
  const id = `${PROC}:${++riskSeq}`;
  ownRisk.set(id, m);
  view.riskMicro += m;
  if (sharedLimitsEnabled()) {
    void Promise.resolve(shared.windowAdd("sfm-risk", "all", { windowMs: RISK_WINDOW_MS, member: id, weight: m, now })).then((r) => {
      if (!r?.ok) { noteSharedLimitsDegraded(CONTROL, r); view.unread = true; }
    }, () => { view.unread = true; });
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    ownRisk.delete(id);
    view.riskMicro = Math.max(0, view.riskMicro - m);
    if (sharedLimitsEnabled()) void Promise.resolve(shared.windowRemove("sfm-risk", "all", { member: id, weight: m })).catch(() => {});
  };
}

/**
 * Decide and reserve in one step, for a never-settled wallet's run the plan
 * would serve first: read the mode from the figures as they stand NOW
 * (synchronous: the shared view as last read), and either answer that the
 * mode is on (`{ on: true, why }`, nothing reserved: the run settles first)
 * or reserve the run's price at risk (`{ on: false, release }`). Runs
 * admitted together are each decided after the reservations before them,
 * so they cannot all slip under the budget.
 */
export function admitServedFirst(usd, { now = Date.now(), env = process.env } = {}) {
  const v = decide(now, env);
  if (v.on) return { on: true, why: v.why };
  return { on: false, release: reserveAtRisk(usd, now) };
}

// ---- the shared view ---------------------------------------------------------
// costMicro / riskMicro: the shared totals as last read, plus what this
// process added since. readAt: when the last read answered (0: never).
// unread: the last read or write did not answer.
const view = { costMicro: 0, riskMicro: 0, readAt: 0, unread: false, reading: null };
async function readShared(now) {
  const hours = [];
  for (let h = hourOf(now - WINDOW_MS); h <= hourOf(now); h++) hours.push(h);
  const [tally, risk] = await Promise.all([
    shared.tallyReadMany(hours.map((h) => ({ name: "sfm-cost", key: String(h) }))),
    shared.windowRead("sfm-risk", "all", { windowMs: RISK_WINDOW_MS, now }),
  ]);
  if (!tally?.ok || !risk?.ok) { noteSharedLimitsDegraded(CONTROL, !tally?.ok ? tally : risk); view.unread = true; return false; }
  const cutoff = minuteOf(now - WINDOW_MS);
  let cost = 0;
  for (const r of tally.results || []) for (const [field, v] of Object.entries(r?.fields || {})) {
    const m = Number(field), n = Number(v);
    if (Number.isFinite(m) && m > cutoff && Number.isFinite(n) && n > 0) cost += n;
  }
  view.costMicro = cost;
  view.riskMicro = Math.max(0, Number(risk.sum) || 0);
  view.readAt = now;
  view.unread = false;
  return true;
}
function refresh(now) {
  if (!view.reading) view.reading = readShared(now).catch(() => { view.unread = true; return false; }).finally(() => { view.reading = null; });
  return view.reading;
}

// ---- the decision ------------------------------------------------------------
let lastOn = null;
let flips = 0;
function figures(now) {
  const ownC = ownCostMicro(now), ownR = ownRiskMicro();
  if (!sharedLimitsEnabled()) return { costMicro: ownC, riskMicro: ownR };
  return { costMicro: Math.max(ownC, view.costMicro), riskMicro: Math.max(ownR, view.riskMicro) };
}
function verdict(now, env) {
  const sw = settleFirstSwitch(env);
  if (sw === "off") return { on: false, why: "switched-off" };
  if (sw === "always") return { on: true, why: "always" };
  if (sharedLimitsEnabled() && (view.unread || !view.readAt)) return { on: true, why: "meter-unread" };
  const f = figures(now);
  return f.costMicro + f.riskMicro >= micro(settleFirstBudgetUsd(env)) ? { on: true, why: "budget" } : { on: false, why: "under-budget" };
}
function decide(now, env = process.env) {
  const v = verdict(now, env);
  if (lastOn !== null && v.on !== lastOn) {
    flips++;
    console.log(`[settle-first] budget mode ${v.on ? "on" : "off"} (${v.why}): a wallet that has never settled ${v.on ? "now settles before its run" : "is served first again"}`);
  }
  lastOn = v.on;
  return v;
}

/**
 * Is the budget mode on? `{ on, why }`: why is "always", "budget",
 * "meter-unread", "under-budget" or "switched-off". Synchronous without a
 * shared store, and with one whose figures were read inside REFRESH_MS; a
 * promise otherwise (one bounded read, shared by every caller meanwhile).
 */
export function settleFirstBudgetMode({ now = Date.now(), env = process.env } = {}) {
  const sw = settleFirstSwitch(env);
  if (sw !== "auto" || !sharedLimitsEnabled() || (view.readAt && now - view.readAt < REFRESH_MS && !view.unread)) return decide(now, env);
  return refresh(now).then(() => decide(now, env), () => decide(now, env));
}

/** The operator view (never public: it carries figures). */
export function settleFirstMeterStatus({ now = Date.now(), env = process.env } = {}) {
  const v = verdict(now, env);
  const f = figures(now);
  return {
    switch: settleFirstSwitch(env), budgetMode: v.on ? "on" : "off", why: v.why,
    unsettledUsd24h: f.costMicro / 1e6, atRiskUsd: f.riskMicro / 1e6, budgetUsd: settleFirstBudgetUsd(env),
    shared: sharedLimitsEnabled(), lastReadAgoMs: view.readAt ? now - view.readAt : null, flips,
  };
}

/** Test seam. */
export function _resetSettleFirstMeterForTest() {
  ownCost.clear(); ownRisk.clear();
  view.costMicro = 0; view.riskMicro = 0; view.readAt = 0; view.unread = false; view.reading = null;
  lastOn = null; flips = 0;
}
