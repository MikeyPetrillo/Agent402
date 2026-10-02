// Daily call budgets for every PAID upstream, alarmed off the egress meter.
//
// WHY THIS EXISTS. Nine upstreams had a balance or spend alarm and seven did
// not, and the seven were not the unimportant ones:
//   - BRAVE powers `search`, one of our best-selling tools. If the
//     subscription lapses, a top product 503s and the first to know is a
//     buyer.
//   - ALCHEMY is pay-as-you-go with no ceiling, so it can bill without
//     earning. A runaway loop costs money silently.
//   - COINGECKO is a hard 10,000/month Demo quota that HAS already been
//     exhausted once (2026-09-07, by CI rather than customers), after which
//     production's CoinGecko tools would have 429'd for the rest of the month.
//   - OPENAI, E2B and NEYNAR each back real catalog tools that simply stop
//     working, quietly, when their account does.
//
// WHAT THIS IS NOT. It is not a balance read - most of these vendors publish no
// balance endpoint, which is the same wall the Exa alarm hit. It counts OUR OWN
// outbound calls per host, which the egress meter has been doing all along
// without anything watching it, and compares that to a budget the operator
// sets. So it answers "are we using far more than we planned today", never
// "how much credit is left".
//
// THE COUNTER IS DAILY AND IN MEMORY. It resets at UTC midnight and on every
// deploy, so a figure here is a FLOOR for the day, and a monthly quota
// (CoinGecko) is only bounded by proxy: 10,000/month is ~330/day, so a daily
// budget under that keeps the month safe without pretending to read the quota.
// Every status says so rather than implying precision it does not have.

import { egressReport } from "./egress-meter.js";

// host suffix -> { name, env, default daily call budget }
// Defaults are set ABOVE current observed use, so switching this on does not
// page anyone on day one; the point is catching a step change, not policing
// normal traffic. `0` or `off` in the env disables one budget.
export const UPSTREAM_BUDGETS = [
  // 100,000 since 2026-09-26: the Solana board reads every settled payment
  // (about 18,000 reads a day at current volume, on top of ~21,000 of other use)
  // and fills its first week of history at 4,000 reads a cycle.
  { match: "alchemy.com", name: "alchemy", env: "BUDGET_ALCHEMY_CALLS", dflt: 100000,
    why: "pay-as-you-go, no ceiling - this is the one that can bill without earning" },
  { match: "api.search.brave.com", name: "brave", env: "BUDGET_BRAVE_CALLS", dflt: 2000,
    why: "backs `search`, our best-selling tool - exhaustion costs revenue, not just uptime" },
  { match: "api.coingecko.com", name: "coingecko", env: "BUDGET_COINGECKO_CALLS", dflt: 300,
    why: "hard 10,000/month Demo quota (~330/day) and it has run out once already" },
  { match: "api.openai.com", name: "openai", env: "BUDGET_OPENAI_CALLS", dflt: 2000,
    why: "transcribe, embeddings, moderation and image generation" },
  { match: "api.e2b.dev", name: "e2b", env: "BUDGET_E2B_CALLS", dflt: 500,
    why: "paid sandbox time; CI has leaked this key once already" },
  { match: "api.neynar.com", name: "neynar", env: "BUDGET_NEYNAR_CALLS", dflt: 2000,
    why: "the nine Farcaster tools" },
  { match: "api.exa.ai", name: "exa", env: "BUDGET_EXA_CALLS", dflt: 500,
    why: "beside exaAllowance, which tracks dollars - this tracks call volume" },
];

// A budget whose vendor is ALSO an indexed seller cannot be read off host
// traffic: the index crawlers read api.exa.ai's public documents and price
// quotes every cycle (unpaid), and that alone put the Exa budget "elevated" at
// 621 calls with $0 of Exa spent (2026-09-26). Such a budget counts the tool
// kit's own calls instead, registered here by name.
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
 * Per-upstream daily call usage against budget. Counts only - never a key,
 * never a URL, never a caller. `status`:
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
    + "A monthly quota (CoinGecko) is bounded by proxy, never read.";
  return out;
}
