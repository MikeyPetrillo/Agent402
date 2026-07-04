// Agent402 — Company Research One-Pager demo
//
// A self-contained demo showing an agent autonomously paying for tools to
// produce a company research one-pager. Uses the agent402-client SDK with
// proof-of-work (free, no wallet) by default, or real USDC if AGENT_KEY is set.
//
// Usage:
//   node scripts/demo-company-onepager.js             # defaults to NVDA
//   node scripts/demo-company-onepager.js AAPL        # any US ticker
//   AGENT_KEY=0x... node scripts/demo-company-onepager.js MSFT  # pay in USDC
//
// Environment:
//   TARGET_URL   — Agent402 instance (default: https://agent402.tools)
//   AGENT_KEY    — private key for x402 USDC payment (optional; PoW if unset)

import { Agent402 } from "../client/index.js";

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const TICKER = (process.argv[2] || "NVDA").toUpperCase();
const AGENT_KEY = process.env.AGENT_KEY;

// Terminal colors
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const ts = () => dim(`[${new Date().toISOString().slice(11, 19)}]`);
const log = (s = "") => console.log(s);

log();
log(bold("  Agent402 — Company Research One-Pager"));
if (!AGENT_KEY) {
  log(yellow("  ⚠ AGENT_KEY not set — this demo calls wallet-only tools (stock-quote,"));
  log(yellow("    company-financials, search) which require USDC payment."));
  log(yellow("    Set AGENT_KEY=0x<private-key-with-USDC-on-Base> to run."));
  log();
  process.exit(1);
}
log(dim(`  target: ${TARGET} | ticker: ${TICKER} | payment: USDC (x402)`));
log(dim("─".repeat(70)));
log();

// Build client
let client;
if (AGENT_KEY) {
  const { x402Client } = await import("@x402/core/client");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const { privateKeyToAccount } = await import("viem/accounts");
  const xClient = new x402Client();
  registerExactEvmScheme(xClient, { signer: privateKeyToAccount(AGENT_KEY) });
  const payFetch = wrapFetchWithPayment(fetch, xClient);
  client = new Agent402({ baseUrl: TARGET, fetch: payFetch });
} else {
  client = new Agent402({ baseUrl: TARGET });
}

const costs = [];
const t0 = performance.now();

async function callTool(slug, params, label) {
  const start = performance.now();
  log(`${ts()} ${cyan("CALL")} ${slug} ${dim(JSON.stringify(params))}`);
  const result = await client.call(slug, params);
  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  // Look up price from catalog
  const cat = await client._loadCatalog();
  const price = cat.get(slug)?.price || "$0.00";
  costs.push({ slug, price });
  log(`${ts()} ${green(" OK ")} ${slug} ${dim(`(${elapsed}s, ${AGENT_KEY ? price + " USDC" : "PoW free"})`)}`);
  return result;
}

// --- Step 1: Stock quote ---
const quote = await callTool("stock-quote", { symbol: TICKER }, "live quote");

// --- Step 2: Company financials ---
const financials = await callTool("company-financials", { ticker: TICKER }, "financials");

// --- Step 3: Web search for recent news ---
const news = await callTool("search", { q: `${quote.name || TICKER} latest news`, count: 3, freshness: "pw" }, "news");

const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

// --- Format output ---
log();
log(dim("─".repeat(70)));
log();

// Helper to format large numbers
function fmt(n) {
  if (n == null) return "N/A";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toLocaleString()}`;
}

// Extract financials by label
function metric(label) {
  const m = financials.metrics?.find((x) => x.label === label);
  return {
    annual: m?.latestAnnual?.value,
    quarterly: m?.latestQuarterly?.value,
    annualPeriod: m?.latestAnnual?.period,
    quarterlyPeriod: m?.latestQuarterly?.period,
  };
}

const rev = metric("Revenue");
const ni = metric("Net Income");
const eps = metric("EPS (Diluted)");

// The stock-quote tool doesn't return marketCap directly; use totalAssets from
// financials as a proxy label if available, or skip.
const marketCap = null; // not available from stock-quote; omit from output

// Fiscal year label from the annual period
const fyLabel = rev.annualPeriod ? `FY${new Date(rev.annualPeriod).getFullYear()}` : "Latest";

// Compute total cost
const totalCost = costs.reduce((sum, c) => {
  const n = parseFloat(String(c.price).replace(/[^0-9.]/g, ""));
  return sum + (isNaN(n) ? 0 : n);
}, 0);

// Print the one-pager
log(bold(`# ${TICKER} — Company One-Pager`));
log(`${bold("Price:")} $${quote.price?.toFixed(2) ?? "N/A"} | ${bold("Prev Close:")} $${quote.previousClose?.toFixed(2) ?? "N/A"} | ${bold("Change:")} ${quote.changePct != null ? (quote.changePct >= 0 ? "+" : "") + quote.changePct.toFixed(2) + "%" : "N/A"}`);
log(`${bold("52wk:")} $${quote.fiftyTwoWeekLow?.toFixed(2) ?? "?"} - $${quote.fiftyTwoWeekHigh?.toFixed(2) ?? "?"} | ${bold("Volume:")} ${quote.volume?.toLocaleString() ?? "N/A"}${marketCap ? ` | ${bold("Market Cap:")} ${fmt(marketCap)}` : ""}`);
log(`${bold("Exchange:")} ${quote.exchange ?? "N/A"} | ${bold("Currency:")} ${quote.currency ?? "N/A"}`);
log();

log(bold(`## Key Financials (${fyLabel})`));
log(`| Metric | Annual | Quarterly |`);
log(`|--------|--------|-----------|`);
log(`| Revenue | ${fmt(rev.annual)} | ${fmt(rev.quarterly)} |`);
log(`| Net Income | ${fmt(ni.annual)} | ${fmt(ni.quarterly)} |`);
log(`| EPS (Diluted) | ${eps.annual != null ? "$" + eps.annual.toFixed(2) : "N/A"} | ${eps.quarterly != null ? "$" + eps.quarterly.toFixed(2) : "N/A"} |`);
log();

log(bold("## Recent News"));
const results = news.results || [];
if (results.length === 0) {
  log("- No recent news found");
} else {
  for (const r of results) {
    log(`- [${r.title}](${r.url})${r.age ? dim(` (${r.age})`) : ""}`);
  }
}
log();

log(dim("---"));
log(dim(`Generated by Agent402 | Total cost: $${totalCost.toFixed(3)} ${AGENT_KEY ? "USDC on Base" : "(PoW — free)"} | ${elapsed}s | ${new Date().toISOString().slice(0, 10)}`));
log();

process.exit(0);
