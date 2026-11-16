// The direct inference upstream's daily spend and balance words
// (src/gateway-direct-upstream.js). AN ALARM ONLY: nothing here refuses,
// caps or reroutes a call; the direct link's routing is decided by the price
// guard, the share draw and the breaker, never by these words.
//
// SPEND. Every direct answer the upstream billed (served, or discarded as
// empty) books its cost to the UTC day: the upstream's own reported charge
// (the x_* charged_micro field, its header, or usage.cost), and when an
// answer carries none, its usage tokens at the private cost table's row for
// the model (src/upstream-costs.js, longest prefix; never printed). An
// answer neither prices is counted as unpriced on the operator view. The day
// is kept in this process and in a shared day counter (src/shared-limits.js)
// every replica adds to; the word is built from the larger of the two, so a
// new process on a day already past the threshold reads high.
//
//   DIRECT_UPSTREAM_DAILY_ALERT_USD   the threshold, USD per UTC day (default 5;
//                                     a blank or malformed value reads the default;
//                                     0 or off turns the alarm off).
//
// Word directUpstreamSpend: off (the upstream is unconfigured, or the alarm is
// off), ok, high (the day's spend reached the threshold; every call is still
// served). high pages; ok and off close. The figures (spend, threshold, the
// reported, estimated and unpriced counts) are on the operator view only.
//
// BALANCE. Word directUpstreamBalance: off (unconfigured, or a share of 0),
// ok, exhausted: the upstream's last answer of either kind was a 402 (its
// balance refusal) and no direct answer has been served since. Each such call
// already walked to OpenRouter and was served there; the breaker keeps the
// next calls off the direct link. exhausted pages; ok and off close. Per
// process, like the breaker it sits beside.
import { createSharedDailySpend } from "./shared-limits.js";
import { createSharedCeilingView } from "./daily-ceilings.js";
import { upstreamCosts, rowRateAt } from "./upstream-costs.js";
import { directUpstreamConfig, directBalanceState } from "./gateway-direct-upstream.js";

export const DIRECT_SPEND_ALERT_ENV = "DIRECT_UPSTREAM_DAILY_ALERT_USD";
export const DIRECT_SPEND_DEFAULT_ALERT_USD = 5;

/** The day's threshold in USD, or null when the alarm is off. */
export function directSpendAlertUsd(env = process.env) {
  const raw = String(env[DIRECT_SPEND_ALERT_ENV] ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0") return null;
  const n = raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DIRECT_SPEND_DEFAULT_ALERT_USD;
}

const utcDay = (now) => new Date(now).toISOString().slice(0, 10);
const blank = (day = "") => ({ day, micro: 0, answers: 0, reported: 0, estimated: 0, unpriced: 0 });
let spend = blank();
const roll = (now) => { const d = utcDay(now); if (spend.day !== d) spend = blank(d); };

const shared = createSharedDailySpend("direct-upstream-day", "direct-upstream");
const view = createSharedCeilingView(shared);

/** USD for `usage` at the cost table's row for `model` (longest prefix), or null. */
export function directSpendEstimateUsd(model, usage) {
  const id = String(model || "").toLowerCase();
  const p = Number(usage?.prompt_tokens), c = Number(usage?.completion_tokens);
  if (!id || !Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0 || p + c <= 0) return null;
  let best = null;
  for (const [prefix, row] of upstreamCosts().models) if (id.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, row };
  if (!best) return null;
  const r = rowRateAt(best.row, p);
  const usd = (p * r.prompt + c * r.completion) / 1e6;
  return Number.isFinite(usd) && usd >= 0 ? usd : null;
}

/** Book one billed direct answer. `reportedUsd` is the upstream's own charge
 *  (null or undefined when it sent none). Never throws, never refuses. */
export function noteDirectSpend(model, usage, reportedUsd, now = Date.now()) {
  try {
    roll(now);
    spend.answers++;
    let usd;
    if (typeof reportedUsd === "number" && Number.isFinite(reportedUsd) && reportedUsd >= 0) { usd = reportedUsd; spend.reported++; }
    else {
      usd = directSpendEstimateUsd(model, usage);
      if (usd === null) { spend.unpriced++; return; }
      spend.estimated++;
    }
    const m = Math.round(usd * 1e6);
    spend.micro += m;
    if (m) shared.book(usd, now);
  } catch { /* an alarm never fails a served call */ }
}

/** One bounded read of the shared day for the word; never rejects. */
export function refreshDirectSpendShared(now = Date.now()) { return view.refresh(now); }

/** { status } publicly; the operator view adds the day's figures. */
export function directUpstreamSpendStatus({ full = false, now = Date.now(), env = process.env } = {}) {
  roll(now);
  const alert = directSpendAlertUsd(env);
  const micro = Math.max(spend.micro, view.micro(now));
  const status = !directUpstreamConfig(env) || alert === null ? "off" : micro >= Math.round(alert * 1e6) ? "high" : "ok";
  if (!full) return { status };
  return { status, day: spend.day, spentUsd: micro / 1e6, alertUsd: alert, answers: spend.answers, reported: spend.reported, estimated: spend.estimated, unpriced: spend.unpriced, shared: shared.enabled };
}

/** { status } publicly; the operator view adds the counts. */
export function directUpstreamBalanceStatus({ full = false, env = process.env } = {}) {
  const cfg = directUpstreamConfig(env);
  const b = directBalanceState();
  const status = !cfg || cfg.share <= 0 ? "off" : b.exhausted ? "exhausted" : "ok";
  if (!full) return { status };
  return { status, refusals: b.refusals, lastRefusalAt: b.lastRefusalAt ? new Date(b.lastRefusalAt).toISOString() : null, lastServedAt: b.lastServedAt ? new Date(b.lastServedAt).toISOString() : null };
}

/** Test seam. */
export function _resetDirectSpendForTest() { spend = blank(); view.reset(); shared.reset(); }
