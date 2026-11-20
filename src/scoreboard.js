// The weekly operator scoreboard (operator only; never a public surface).
// Composes figures other modules already compute, counts and shares only:
//   operators       the week's outside paying wallets resolved to operators on
//                   public evidence (src/payer-operators.js): operators (an
//                   upper bound), the share that paid on two or more days,
//                   the largest operator's share of the week's dollars, and
//                   how many wallets each source resolved
//   wallets         the funnel ledger's wallet figures (repeat, returning)
//   organic         outside dollars per day over the week (our own wallets,
//                   the router's purchases, burners, CI and signed probes are
//                   excluded by the ledger's internal flag)
//   concentration   30-day outside dollars: largest wallet and tool shares
//   newPayersPerDay first-ever paying wallets per day (Arc excluded)
//   conversion      settled per probe by arrival path (src/funnel.js)
//   firstCallAllowance  the trial's switch, today's grants and returned payers
//   refunds         counts and dollars owed, paid, sending
// Bazaar rank, the Bazaar listing count and the MPP rank are read from
// outside this server by scripts/scoreboard.js, which merges them in.
import { OPERATOR_SOURCES } from "./payer-operators.js";

/**
 * The week's operators from the paying wallets and their resolutions.
 * @param {{payer:string, usd:number, days:number}[]} weekPayers
 * @param {Map<string, object>} resolved  address -> { mapping } | { pending } | { kind } | { unreadable }
 */
export function summarizeOperators(weekPayers, resolved) {
  const ops = new Map(); // key -> { usd, days }
  const bySource = Object.fromEntries(OPERATOR_SOURCES.map((s) => [s, 0]));
  let resolvedWallets = 0, pending = 0, unreadable = 0, totalUsd = 0;
  for (const p of weekPayers || []) {
    const k = String(p.payer || "").toLowerCase();
    const r = resolved?.get?.(k) || {};
    const key = r.mapping ? `op:${r.mapping.operator}` : `wallet:${k}`;
    if (r.mapping) { resolvedWallets++; if (Object.hasOwn(bySource, r.mapping.source)) bySource[r.mapping.source]++; }
    else if (r.pending) pending++;
    else if (r.unreadable) unreadable++;
    const usd = Number(p.usd) || 0;
    totalUsd += usd;
    const e = ops.get(key) || { usd: 0, days: 0 };
    e.usd += usd;
    // Days are per wallet; an operator's paying days are at least its busiest wallet's.
    e.days = Math.max(e.days, Number(p.days) || 0);
    ops.set(key, e);
  }
  let repeat = 0, top = 0;
  for (const e of ops.values()) { if (e.days >= 2) repeat++; if (e.usd > top) top = e.usd; }
  return {
    wallets: (weekPayers || []).length,
    operators: ops.size,
    operatorsUpperBound: true,
    repeatShare: ops.size ? +(repeat / ops.size).toFixed(3) : null,
    topOperatorShare: totalUsd > 0 ? +(top / totalUsd).toFixed(4) : null,
    resolvedWallets, bySource, pendingWallets: pending, unreadableWallets: unreadable,
  };
}

export const SCOREBOARD_DEFINITIONS = Object.freeze({
  operators: "outside paying wallets of the week grouped by operator where public evidence names one (payTo: the wallet is the receiving address one indexed origin advertises; ens or basename: the wallet's primary name, checked forward). An unresolved wallet counts as its own operator, so operators is an upper bound. repeatShare: operators that paid on two or more days of the week",
  organic: "outside dollars per UTC day at the buyer's price; our own wallets, the router's purchases for buyers, burners, CI and signed probes are not outside",
  concentration: "over the 30 whole UTC days before today: the largest single wallet's and the largest tool's share of outside dollars (90-day targets: no buyer above 25%, no tool above 35%)",
  newPayersPerDay: "wallets whose first counted sale ever falls on that day; sales on the excluded networks are not counted",
  conversion: "settled per probe and callers who paid after a probe, per arrival path, from the paid-call funnel",
  external: "bazaarRank, bazaarListing and mppRank are measured from outside by scripts/scoreboard.js",
});

/** One scoreboard answer from its parts (all optional; a part that failed reads null). */
export function composeScoreboard({ now = Date.now(), ledger = null, funnelWeek = null, operators = null, conversion = null, firstCallAllowance = null, refunds = null, catalogRoutes = null } = {}) {
  const conv = conversion ? Object.fromEntries(Object.entries(conversion).map(([a, c]) => [a, {
    probes: c.probes, settled: c.settled, settledPerProbe: c.settledPerProbe, callerConversion: c.callerConversion,
  }])) : null;
  const fca = firstCallAllowance ? {
    enabled: firstCallAllowance.enabled, status: firstCallAllowance.status,
    dailyCapUsd: firstCallAllowance.dailyCapUsd, today: firstCallAllowance.today,
    returnedPayers: firstCallAllowance.returnedPayers ?? null,
  } : null;
  return {
    generatedAt: new Date(now).toISOString(),
    week: ledger?.week || null,
    operators,
    wallets: funnelWeek ? {
      outsidePayingWallets: funnelWeek.outsidePayingWallets, repeatShare: funnelWeek.repeatShare,
      returningShare: funnelWeek.returningShare, salesWithoutPayer: funnelWeek.salesWithoutPayer,
    } : null,
    organic: funnelWeek ? { usdPerDay: funnelWeek.organicUsdPerDay, usdPerDayAvg: funnelWeek.organicUsdPerDayAvg } : null,
    concentration: ledger ? { window: ledger.window, ...ledger.concentration } : null,
    newPayersPerDay: ledger ? { days: ledger.newPayersPerDay, excludedNetworks: ledger.newPayersExcludedNetworks } : null,
    conversion: conv,
    firstCallAllowance: fca,
    refunds,
    listing: { catalogRoutes },
    bazaarRank: null,
    mppRank: null,
    definitions: SCOREBOARD_DEFINITIONS,
  };
}
