// Daily call budgets for every PAID upstream, alarmed off the egress meter.
//
// WHY THIS EXISTS. A balance alarm covers the upstreams that publish a
// balance; most paid upstreams publish none, and each backs catalog tools that
// stop working quietly when the account behind them lapses, runs out of quota
// or (pay-as-you-go with no ceiling) bills without earning. This watches the
// one thing every upstream has in common: how many calls we made to it today.
//
// WHAT THIS IS NOT. It is not a balance read. It counts OUR OWN outbound calls
// per host, which the egress meter records anyway, and compares that to a
// budget the operator sets. So it answers "are we using far more than we
// planned today", never "how much credit is left".
//
// THE COUNT IS THE DAY'S, ACROSS DEPLOYS AND REPLICAS, when a shared store is
// configured. Each process counts its own calls in memory (the egress meter,
// reset at UTC midnight and on every deploy); on a timer it adds what it has
// counted since its last flush to a shared daily counter per upstream
// (src/shared-limits.js) and reads the day's total back. The status is built
// from that total (plus what this process has not flushed yet), or from the
// day's count the hard ceiling of the same name keeps
// (src/upstream-hard-caps.js), whichever is larger, never from less than this
// process's own count. So a deploy late in a heavy day does not read "ok" on
// a budget the day already passed. Without a shared store the process's own
// count is all there is, a FLOOR for the day, and the status says which it
// read (`shared`). A monthly quota is only bounded by proxy: a daily budget
// under the month's share keeps the month safe without pretending to read it.
//
// WHO SEES WHAT. /api/gateway-status publishes one word for the whole group;
// the per-upstream rows (calls, budget, reason) are the operator view only, so
// no public surface names an upstream or publishes a daily ceiling.

import { egressReport } from "./egress-meter.js";
import { createSharedDailySpend } from "./shared-limits.js";
import { hardCapStatus } from "./upstream-hard-caps.js";

// host suffix -> { name, env, default daily call budget }
// Defaults are set ABOVE current observed use, so switching this on does not
// page anyone on day one; the point is catching a step change, not policing
// normal traffic. `0` or `off` in the env disables one budget.
export const UPSTREAM_BUDGETS = [
  // The Solana board reads every settled payment and fills its history in
  // batches, so this budget sits well above the other hosts' use.
  { match: "alchemy.com", name: "alchemy", env: "BUDGET_ALCHEMY_CALLS", dflt: 100000,
    why: "pay-as-you-go with no ceiling: the one that can bill without earning" },
  { match: "api.search.brave.com", name: "brave", env: "BUDGET_BRAVE_CALLS", dflt: 2000,
    why: "backs the search tools; a lapse refuses a top product" },
  { match: "api.coingecko.com", name: "coingecko", env: "BUDGET_COINGECKO_CALLS", dflt: 300,
    why: "a hard monthly quota, bounded here by its daily share" },
  { match: "api.openai.com", name: "openai", env: "BUDGET_OPENAI_CALLS", dflt: 2000,
    why: "transcribe, embeddings, moderation and image generation" },
  { match: "api.hunter.io", name: "hunter", env: "BUDGET_HUNTER_CALLS", dflt: 200,
    why: "the b2b enrichment tools; billed per lookup" },
  { match: "api.apollo.io", name: "apollo", env: "BUDGET_APOLLO_CALLS", dflt: 200,
    why: "the b2b enrichment tools; billed per lookup" },
  { match: "hist.databento.com", name: "databento", env: "BUDGET_DATABENTO_CALLS", dflt: 3000,
    why: "the equities tools plus the stock-quote warmer, which also holds its own daily ceiling" },
];

// A budget whose vendor is ALSO an indexed seller cannot be read off host
// traffic: the index crawlers read that host's public documents and price
// quotes every cycle, unpaid, and those reads alone can push the budget to
// "elevated" with nothing spent. Such a budget counts the tool kit's own calls
// instead, registered here by name.
const ownCounters = new Map();
export function registerUpstreamCounter(name, fn) { if (typeof fn === "function") ownCounters.set(name, fn); }

const budgetOf = (b) => {
  const raw = String(process.env[b.env] ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0") return 0;          // explicitly disabled
  const n = Number(raw);
  // A MALFORMED value falls back to the default, never to disabled: a typo
  // must not silently switch an alarm off. Same rule as the spend guards.
  return Number.isFinite(n) && n > 0 ? n : b.dflt;
};

const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
// This process's own count for one budget: the tool kit's registered counter,
// else the egress meter's calls to hosts under the budget's suffix.
function processCalls(b, hosts) {
  const own = ownCounters.get(b.name);
  let calls;
  try { calls = own ? Number(own()) || 0 : null; } catch { calls = null; }
  if (calls === null) {
    calls = hosts
      .filter((h) => typeof h.host === "string" && h.host.endsWith(b.match))
      .reduce((a, h) => a + (h.calls || 0), 0);
  }
  return calls;
}

// The shared day per budget: what this process has added to the shared
// counter (`flushed`, out of its own count) and the last total read back.
const sharedRows = new Map(); // name -> { day, flushed, shared, store }
function sharedRowOf(b, now = Date.now()) {
  let s = sharedRows.get(b.name);
  const d = utcDay(now);
  if (!s) { s = { day: d, flushed: 0, shared: null, store: createSharedDailySpend(`upstream-budget-${b.name}`, "upstream-budgets", { scale: 1 }) }; sharedRows.set(b.name, s); }
  if (s.day !== d) { s.day = d; s.flushed = 0; s.shared = null; }
  return s;
}
// The day's count as this process sees it: the shared total plus what it has
// not flushed, the hard ceiling's own day count, or its own count.
function dayCalls(b, calls, now) {
  const s = sharedRowOf(b, now);
  let seen = Math.max(calls, s.shared === null ? 0 : s.shared + Math.max(0, calls - s.flushed));
  let shared = s.shared !== null;
  try {
    const cap = hardCapStatus(now).upstreams[b.name];
    // The ceiling counts what the egress meter counts (calls to the host); a
    // budget with a registered counter counts tool calls and is left alone.
    if (cap && !ownCounters.has(b.name) && cap.shared) { seen = Math.max(seen, Number(cap.usedToday) || 0); shared = true; }
  } catch { /* the budget's own counts stand */ }
  return { seen, shared };
}

/**
 * Add this process's new calls to each budget's shared daily counter and read
 * the day's totals back. On a timer (startUpstreamBudgetSync); never on a
 * request's path. Without a shared store it does nothing.
 */
export async function syncUpstreamBudgets(now = Date.now(), report = null) {
  const hosts = (report || egressReport({ top: 2000 })).hosts || [];
  for (const b of UPSTREAM_BUDGETS) {
    const s = sharedRowOf(b, now);
    if (!s.store.enabled) continue;
    const calls = processCalls(b, hosts);
    const delta = calls - s.flushed;
    if (delta > 0) { s.flushed = calls; s.store.book(delta, now); }
    try {
      const v = await s.store.today(now);
      // The day's total only grows; a read that predates the flush is not taken as a step back.
      if (v !== null) s.shared = Math.max(v, s.shared ?? 0);
    } catch { /* keep the last reading */ }
  }
}
let syncTimer = null;
export function startUpstreamBudgetSync() {
  if (syncTimer) return;
  syncTimer = setInterval(() => { void syncUpstreamBudgets().catch(() => {}); }, Math.max(1_000, Number(process.env.UPSTREAM_BUDGET_SYNC_MS) || 15_000));
  syncTimer.unref?.();
  // The first read lands soon after boot, so a new process does not answer from its own empty count for long.
  const first = setTimeout(() => { void syncUpstreamBudgets().catch(() => {}); }, 2_000);
  first.unref?.();
}
/** Test seam. */
export function _resetUpstreamBudgetShared() { sharedRows.clear(); }

/**
 * Per-upstream daily call usage against budget (the operator view; the public
 * view keeps `status` alone). Counts only - never a key, never a URL, never a
 * caller. `status`:
 *   ok        under the budget
 *   elevated  at or over it - look, do not necessarily panic
 *   disabled  budget explicitly turned off
 * A host we made no calls to today simply reads 0/ok; absence is not an error.
 */
export function upstreamBudgetStatus(report = null, now = Date.now()) {
  const rep = report || egressReport({ top: 2000 });
  const hosts = rep.hosts || [];
  const out = { day: rep.day, sinceRestart: true, upstreams: {} };
  let worst = "ok";
  let anyShared = false;
  for (const b of UPSTREAM_BUDGETS) {
    const own = ownCounters.get(b.name);
    const processCount = processCalls(b, hosts);
    const { seen: calls, shared } = dayCalls(b, processCount, now);
    if (shared) anyShared = true;
    const budget = budgetOf(b);
    const status = budget === 0 ? "disabled" : (calls >= budget ? "elevated" : "ok");
    if (status === "elevated") worst = "elevated";
    // callsToday is the day's count (shared: across deploys and replicas);
    // processCallsToday is this process's own, since its restart.
    out.upstreams[b.name] = { callsToday: calls, processCallsToday: processCount, shared, budget: budget || null, status, why: b.why, ...(own ? { counts: "tool calls only" } : {}) };
  }
  out.status = worst;
  out.sinceRestart = !anyShared;
  out.note = "Counts OUR outbound calls per host, not a vendor balance - most of these publish none. "
    + "A row marked shared is the UTC day's count across deploys and replicas; a row that is not is this process's own count since its restart, a floor for the day. "
    + "A monthly quota is bounded by proxy, never read.";
  return out;
}
