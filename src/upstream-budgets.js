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
// THE COUNTER IS DAILY AND IN MEMORY. It resets at UTC midnight and on every
// deploy, so a figure here is a FLOOR for the day, and a monthly quota is only
// bounded by proxy: a daily budget under the month's share keeps the month safe
// without pretending to read the quota. Every status says so rather than
// implying precision it does not have.
//
// WHO SEES WHAT. /api/gateway-status publishes one word for the whole group;
// the per-upstream rows (calls, budget, reason) are the operator view only, so
// no public surface names an upstream or publishes a daily ceiling.

import { egressReport } from "./egress-meter.js";

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
  { match: "api.e2b.dev", name: "e2b", env: "BUDGET_E2B_CALLS", dflt: 500,
    why: "paid sandbox time, billed by the minute" },
  { match: "api.neynar.com", name: "neynar", env: "BUDGET_NEYNAR_CALLS", dflt: 2000,
    why: "the Farcaster tools" },
  { match: "api.exa.ai", name: "exa", env: "BUDGET_EXA_CALLS", dflt: 500,
    why: "beside exaAllowance, which tracks spend; this tracks call volume" },
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

/**
 * Per-upstream daily call usage against budget (the operator view; the public
 * view keeps `status` alone). Counts only - never a key, never a URL, never a
 * caller. `status`:
 *   ok        under the budget
 *   elevated  at or over it - look, do not necessarily panic
 *   disabled  budget explicitly turned off
 * A host we made no calls to today simply reads 0/ok; absence is not an error.
 */
export function upstreamBudgetStatus(report = null) {
  const rep = report || egressReport({ top: 2000 });
  const hosts = rep.hosts || [];
  const out = { day: rep.day, sinceRestart: true, upstreams: {} };
  let worst = "ok";
  for (const b of UPSTREAM_BUDGETS) {
    const own = ownCounters.get(b.name);
    let calls;
    try { calls = own ? Number(own()) || 0 : null; } catch { calls = null; }
    if (calls === null) {
      calls = hosts
        .filter((h) => typeof h.host === "string" && h.host.endsWith(b.match))
        .reduce((a, h) => a + (h.calls || 0), 0);
    }
    const budget = budgetOf(b);
    const status = budget === 0 ? "disabled" : (calls >= budget ? "elevated" : "ok");
    if (status === "elevated") worst = "elevated";
    out.upstreams[b.name] = { callsToday: calls, budget: budget || null, status, why: b.why, ...(own ? { counts: "tool calls only" } : {}) };
  }
  out.status = worst;
  out.note = "Counts OUR outbound calls per host, not a vendor balance - most of these publish none. "
    + "Daily, in memory, reset by UTC midnight and by every deploy, so a figure here is a floor for the day. "
    + "A monthly quota is bounded by proxy, never read.";
  return out;
}
