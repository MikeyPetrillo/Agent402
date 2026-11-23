// The titles the scheduled checks' issues carried before they were renamed to
// one neutral shape ("Scheduled check needs review: <check>"), by check.
//
// This is the ONE list. The status Worker reads it when it lists the open
// issues (src/index.js, openIssues), and every workflow job that looks an
// issue up runs scripts/adopt-issue-titles.js first, which reads it too: an
// open issue still filed under a previous title is given the check's current
// title, so the lookup by exact title finds it and the check comments on it
// or closes it as it would its own. Without that, an issue opened before the
// rename is never found again: it stays open after the check recovers, and a
// check that keeps its state in the issue (which routes a presence check has
// already bought) starts over.
//
// A check renamed again gains its old title here. An entry is removed only
// once no issue under that title can still be open. Plain data and two pure
// functions: the Worker bundles this file, so it imports nothing.
export const TITLE_PREFIX = "Scheduled check needs review: ";

export const PREVIOUS_TITLES = Object.freeze({
  "algorand-buyer-wallet": ["Algorand upstream buyer wallet LOW (x402)"],
  "algorand-rail-canary": ["Algorand rail canary FAILING"],
  "algorand-rail-canary-funding": ["Algorand rail canary: sweep wallet needs USDC"],
  "analytics-store": ["Postgres UNREACHABLE (leads/analytics)"],
  "arc-settlements": ["Arc pending settlements need attention"],
  "availability": ["Heartbeat: production DOWN"],
  "buyer-refusals": ["buyerRefusals: a paying buyer was refused by the settle breaker"],
  "buyer-wallet": ["Upstream buyer wallet LOW (x402)"],
  "buyer-wallet-trend": ["Upstream buyer wallet is DRAINING (unexplained fall)"],
  "canary-wallet": ["Canary burner LOW (Base)"],
  "canary-wallet (b)": ["Canary burner EMPTY (Base)"],
  "canary-wallet (c)": ["Canary burner LOW"],
  "catalog-buy": ["Catalog buy FAILING"],
  "cdn-origin": ["CDN origin secret: edge traffic reached the origin unauthenticated"],
  "charged-failure": ["Charged failure: a paid tool returned an error to a paying agent"],
  "contained-turns": ["containedTurns: a scheduled turn is throwing every minute"],
  "corpus": ["Correctness corpus FAILING"],
  "cost-table": ["Upstream cost table missing or incomplete in production"],
  "coverage-balance-reads": ["Coverage balance reads DEGRADED (calls in flight)"],
  "credits-guards": [],
  "credits-refund": ["A refused credits purchase was not refunded"],
  "dataset": ["Dataset record UNHEALTHY"],
  "direct-upstream": ["directUpstream: the direct upstream is degraded"],
  "direct-upstream-balance": ["directUpstreamBalance: the direct upstream's prepaid balance is exhausted"],
  "direct-upstream-spend": ["directUpstreamSpend: the direct upstream's daily spend is high"],
  "discovery-consistency": ["Discovery self-consistency: live prod drifted from source"],
  "evm-buyer-wallets": ["EVM chains upstream buyer wallet LOW (x402)"],
  "evm-buyer-wallets-read": ["EVM chains upstream buyer wallet UNREADABLE (x402)"],
  "external-spend": ["External spend global ceiling REFUSING"],
  "facilitator-allowance": ["PayAI credit allowance HIGH"],
  "facilitator-funds": ["facilitatorFunds: a facilitator refused settlement"],
  "facilitator-funds (b)": ["facilitatorFunds: a facilitator's settlement gas is running low"],
  "facilitator-funds (c)": ["facilitatorFunds: a settlement signer's balance could not be read for hours"],
  "facilitator-funds (d)": ["facilitatorFunds: a facilitator's settlement gas is running low or could not be read"],
  "facilitator-metering": ["CDP settlement metering HIGH"],
  "first-call-allowance": ["First-call allowance UNAVAILABLE (shared store)"],
  "gateway-balance": ["Gateway balance READY to withdraw"],
  "gateway-credits": ["Gateway credits LOW (OpenRouter)"],
  "gateway-credits-read": ["Gateway balance UNREADABLE (OpenRouter)"],
  "gateway-settlements": ["Gateway pending settlements need attention"],
  "history-reads": ["Solana history reads FAILING on every lane"],
  "index-price-sync": ["402 Index price sync FAILING"],
  "index-price-writeback": ["402 Index listing written back at an old price"],
  "late-settlements": ["Late settlements need attention"],
  "ledger-rows": ["Ledger rows waiting on local disk (dead-letter stuck)"],
  "listing-keep-alive": ["Bazaar keep-alive FAILED - listings will age out"],
  "listing-keep-alive-upper": ["Bazaar keep-alive above the ceiling FAILED"],
  "listing-pass": ["Listing pass FAILED"],
  "listing-presence": ["Bazaar presence check"],
  "listing-rank": ["Bazaar listing check"],
  "listing-validation": ["Bazaar listing validation FAILED"],
  "listing-validation-read": ["Bazaar listing validator unreadable"],
  "log-reads": ["EVM log reads FAILING on every lane"],
  "mcp-client": ["MCP connector: an independent client failed a check"],
  "mcp-listing-pass": ["Bazaar MCP tool listings pass FAILED"],
  "mcp-listing-presence": ["Bazaar MCP listing presence check"],
  "model-catalog": ["Upstream model price drift"],
  "mpp-probe": ["MPP synthetic probe FAILING"],
  "mpp-volume": ["Tempo MPP volume FAILING"],
  "offsite-backup": ["Offsite backup is not current"],
  "operator-auth": ["Operator token guessing ELEVATED"],
  "outbound-payments": ["Outbound payments reached a burst of NEW destinations"],
  "paid-canary": ["Paid-path canary FAILED"],
  "paid-canary-rail": ["Paid canary rail FAILED"],
  "payment-call-outcome": ["MPP paid-but-failed call"],
  "payment-party-screen": ["Payment-party screen STALE or MISSING (OFAC SDN)"],
  "payment-reconciliation": ["MPP reconciliation MISMATCH"],
  "payment-reconciliation-run": ["MPP daily reconciliation is NOT RUNNING"],
  "payment-reconciliation-window": ["MPP reconciliation 7-day window MISMATCH"],
  "paywall-read": ["Paywall not observed"],
  "post-author-reads": ["X search author reads OVER the daily alert"],
  "post-data-spend": ["X data daily spend OVER its ceiling"],
  "post-queue": ["Tweet queue needs attention (server poster)"],
  "provider-package-latest": ["agent402-openclaw FAILS on the newest OpenClaw"],
  "published-packages": ["Published npm package BROKEN against prod"],
  "query-service": ["onchainSqlBusy: a top paying buyer was told the query service is busy"],
  "rail-offers": ["Settlement rail DEGRADED"],
  "referral-settlement": ["referralSettlement: referral settlements need attention"],
  "refund-ledger": ["Refund ledger needs attention"],
  "refunds": ["Refunds owed to a buyer are waiting"],
  "replay-store-marks": ["Replay store marks PENDING (Redis)"],
  "report-quality": ["Paid report quality REGRESSED"],
  "revenue-read": ["Live revenue read is stale"],
  "robinhood-settler": ["robinhoodSettler: our own relayer has been settling Robinhood sales for hours"],
  "route-judgment-budget": ["Route judgment token ceiling CAPPED for the day"],
  "router-spend": ["Router spend per minute OVER its ceiling"],
  "screening-lists": ["Sanctions lists STALE or UNLOADED (OFAC SDN)"],
  "security-advisory": ["Security advisory waiting in triage"],
  "security-advisory-read": ["Security advisory check cannot read"],
  "seller-listings": ["brokenListings: seller listings are failing to read across many origins"],
  "served-package-version": ["Served agent402-mcp version is not on npm"],
  "serving-health": ["Serving health DEGRADED"],
  "settle-failures": ["settleFailures: a burst of buyers' payments verified and then failed to settle"],
  "settlement-age": ["Settlement stale - the paid canary is not buying"],
  "shared-limits-store": ["Shared limits store DEGRADED (Redis)"],
  "solana-buyer-wallet": ["Solana upstream buyer wallet LOW (x402)"],
  "speech-upstream": ["Speech upstream breaker COOLING (backup voices serving)"],
  "state-database": ["State database DEGRADED (Postgres)"],
  "status-probe-build": ["Status probe Worker is NOT the code on main"],
  "stellar-fee-account": ["Stellar facilitator fee account LOW (XLM)"],
  "store-persistence": ["Redis append-only persistence is not on"],
  "subscription-canary": ["MPP subscription rail FAILING"],
  "subscription-engine": ["MPP subscription engine FAILED to start"],
  "subscription-gas-sponsor": ["Subscription gas sponsor LOW (PathUSD)"],
  "subscription-gas-sponsor-limit": ["Subscription gas sponsor CEILING reached"],
  "subscription-renewals": ["subscriptionRenewals: a monitor renewal has stayed unconfirmed for hours"],
  "tempo-buyer-wallet": ["Tempo upstream buyer wallet LOW (MPP)"],
  "tool-answers": ["toolAnswers: a tool is answering empty or error-shaped 200s"],
  "tool-failures": ["toolFailures: a tool is answering 5xx to buyers"],
  "tool-self-check": ["Tool self-check: paid tool failing"],
  "top-buyer-failures": ["topBuyerFailures: a top paying buyer is getting failed answers"],
  "transactional-email": ["Transactional email is not sending"],
  "unsettled-reports": ["unsettledReports: a burst of report runs were served and then did not settle"],
  "upstream-call-budget": ["Upstream call budget ELEVATED"],
  "upstream-ceiling": ["Upstream hard ceiling REACHED"],
  "upstream-health": ["upstreamHealth: an upstream is timing out or failing"],
  "upstream-health (b)": ["upstreamHealth: an upstream did not answer within our limit"],
  "weather-keyed-reads": ["Open-Meteo keyed reads REFUSED"],
});

// A title that carried a varying part: the month a reconciliation is for.
// The dated usage reports are filed once and never looked up, so they have
// no entry.
const PREVIOUS_PATTERNS = Object.freeze([
  { previous: /^Brave reconciliation: (\d{4}-\d{2})$/, check: (m) => `search-call-reconciliation (${m[1]})` },
]);

const CURRENT_BY_PREVIOUS = new Map();
for (const [check, olds] of Object.entries(PREVIOUS_TITLES)) for (const old of olds) CURRENT_BY_PREVIOUS.set(old, TITLE_PREFIX + check);

/** The current title of the check that filed issues under `title`, or null
 *  when `title` is not a previous title (a current title included). */
export function currentTitleFor(title) {
  const t = String(title ?? "");
  const exact = CURRENT_BY_PREVIOUS.get(t);
  if (exact) return exact;
  for (const p of PREVIOUS_PATTERNS) { const m = p.previous.exec(t); if (m) return TITLE_PREFIX + p.check(m); }
  return null;
}

// Whose issues are a check's: the Actions bot under either of the names the
// API gives it, and the accounts the caller names (the repository owner, the
// Worker's own token account). Anyone can file an issue under any title; a
// stranger's is never retitled or closed.
const BOT_LOGINS = new Set(["github-actions[bot]", "app/github-actions", "github-actions"]);

/**
 * What to do with the open issues so that each check finds its own:
 *   retitle: [{ number, from, to }]  an issue under a previous title, when no
 *            open issue carries the current one; the oldest when several do;
 *   close:   [{ number, from, to }]  an issue under a previous title whose
 *            check already has an open issue under the current title (or a
 *            second one under the same previous title).
 * `issues` is [{ number, title, author }]; `trusted` the extra logins.
 */
export function planTitleAdoption(issues, { trusted = [] } = {}) {
  const ours = new Set([...BOT_LOGINS, ...trusted.map((x) => String(x || "").toLowerCase()).filter(Boolean)]);
  const mine = (Array.isArray(issues) ? issues : []).filter((x) => x && Number.isInteger(x.number) && ours.has(String(x.author || "").toLowerCase()));
  const held = new Set(mine.filter((x) => String(x.title).startsWith(TITLE_PREFIX)).map((x) => x.title));
  const retitle = [], close = [];
  for (const x of [...mine].sort((a, b) => a.number - b.number)) {
    const to = currentTitleFor(x.title);
    if (!to) continue;
    if (held.has(to)) close.push({ number: x.number, from: x.title, to });
    else { held.add(to); retitle.push({ number: x.number, from: x.title, to }); }
  }
  return { retitle, close };
}
