// Three landing pages for the questions people search before they find this
// server: what a pay-per-call API is (/pay-per-call-api), how to give an MCP
// client paid tools (/paid-mcp-tools), and how the ways to give an agent tools
// compare (/compare). Each one is short, first-party and links to the page
// that goes deep; every price, count and payment wire is read from the same
// sources the 402 and the catalog read, never typed here. A fourth,
// /insider-trades-api, answers the searches for SEC Form 4 insider trades by
// API: its routes, example input, answer fields and prices are read from the
// catalog entries that serve them. A fifth, /crypto-history-stats-api, answers
// the searches for a crypto history API with the two routes whose answers are
// computed here from a coin's past prices (statistics, never the series): the
// market-data source's terms allow a product that incorporates its data and
// bar passing its own figures on, so the page names no route that returns a
// series, prints field names and formulas but no figure, and carries the
// source's credit with its link beside the routes.
import { ledgerShell, ledgerFooterCompact, esc, breadcrumbTrail, codeBlock } from "./ledger-chrome.js";
import { articleDates } from "./page-dates.js";
import { toolList } from "./pages.js";
import { isComputePayable } from "./pow.js";
import { TYPICAL_PRICE_RANGE } from "./typical-price-range.js";
import { RAILS_OR } from "./rails.js";
import { BASE_NO_GAS_SENTENCE } from "./base-no-gas.js";
import { SETTLE_FIRST_SENTENCE } from "./settle-first-copy.js";
import { receiptsServed } from "./receipt-signing.js";
import { connectorWires, connectorPayText } from "./connector-pay.js";
import { FLAGSHIP_MCP_NAMES, AGENT402_MCP_VERSION } from "./mcp-flagship.js";
import { getWalletHtml } from "./get-a-wallet.js";
import { WHY_COMPARE, WHY_POINTS } from "./why.js";
import { siteOrgRef, mppOffered } from "./site-org.js";
import { asyncProfileOf } from "./slow-routes.js";
import { needsAsyncOrWait } from "./slow-sync-window.js";
import { HUMAN_PRODUCTS, humanCheckoutEnabled } from "./human-checkout.js";
import { COINGECKO_API_URL } from "./data-attribution.js";

export const INSIDER_TRADES_PATH = "/insider-trades-api";
export const CRYPTO_HISTORY_STATS_PATH = "/crypto-history-stats-api";
export const SEARCH_LANDING_PATHS = ["/pay-per-call-api", "/paid-mcp-tools", "/compare", INSIDER_TRADES_PATH, CRYPTO_HISTORY_STATS_PATH];

const CSS = `
.sl-wrap{max-width:900px;margin:0 auto;padding:50px 30px 64px}
.sl-wrap h1{font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:1.02;margin:0 0 18px}
.sl-lead{color:var(--ink);font-size:var(--fs-lg);line-height:1.6;margin:0 0 30px;max-width:760px}
.sl-wrap h2{font-family:var(--font-body);font-weight:700;font-size:var(--fs-xl);letter-spacing:-.02em;margin:34px 0 12px}
.sl-wrap p,.sl-wrap li{color:var(--muted);font-size:var(--fs-base);line-height:1.65;max-width:760px}
.sl-wrap p{margin:0 0 14px}
.sl-wrap li{margin:0 0 8px}
.sl-wrap ol,.sl-wrap ul{padding-left:22px;margin:0 0 14px}
.sl-wrap a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent)}
.sl-wrap code{font-family:var(--font-mono);font-size:var(--fs-code-inline)}
.sl-wrap p.sl-credit{color:var(--ink);font-size:var(--fs-base)}
.sl-links{display:flex;flex-wrap:wrap;gap:8px 20px;list-style:none;padding:0;margin:0}
.sl-links li{margin:0;font-family:var(--font-mono);font-size:var(--fs-sm)}
.sl-table{width:100%;border-collapse:collapse;font-size:var(--fs-md);margin:0 0 14px}
.sl-table th,.sl-table td{border-bottom:1px solid var(--hairline);padding:10px 12px;text-align:left;vertical-align:top;color:var(--muted);line-height:1.5}
.sl-table th{font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.08em;text-transform:uppercase;color:var(--faint);font-weight:500}
.sl-table td:first-child{color:var(--ink);font-weight:600}
.sl-table td.sl-here{color:var(--ink)}
.sl-points{list-style:none;padding:0;border-top:1px solid var(--hairline)}
.sl-points li{border-bottom:1px solid var(--hairline);padding:14px 0;margin:0}
.sl-points b{color:var(--ink);display:block;margin-bottom:4px}
@media(max-width:720px){
.sl-wrap{padding:34px 16px 48px}
.sl-wrap h1{font-size:var(--fs-3xl)}
.sl-table,.sl-table tbody,.sl-table tr,.sl-table td{display:block;width:100%}
.sl-table thead{display:none}
.sl-table tr{border-bottom:1px solid var(--hairline);padding:8px 0}
.sl-table td{border:0;padding:4px 0}
.sl-table td[data-col]::before{content:attr(data-col) ": ";font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
}
`;

const pre = (text) => codeBlock(`<code>${esc(text)}</code>`, { html: true, style: "margin:0 0 14px" });
const links = (pairs) => `<ul class="sl-links">${pairs.map(([href, label]) => `<li><a href="${esc(href)}">${esc(label)}</a></li>`).join("")}</ul>`;

function page(baseUrl, { path, title, description, h1, crumb, body }) {
  const canonical = `${baseUrl}${path}`;
  const crumbs = breadcrumbTrail(baseUrl, [["Home", "/"], [crumb, path]]);
  const dates = articleDates(path);
  const articleLd = { "@context": "https://schema.org", "@type": "TechArticle", headline: h1, description, url: canonical, author: siteOrgRef(baseUrl), publisher: siteOrgRef(baseUrl) };
  return ledgerShell({
    title, description, canonical, baseUrl, activePath: "__none__", extraCss: CSS,
    jsonLd: [articleLd, crumbs.ld], article: dates,
    body: `<div class="sl-wrap">${crumbs.nav}<h1>${esc(h1)}</h1>${body}</div>${ledgerFooterCompact()}`,
  });
}

const freeToolCount = (catalog) => toolList(catalog).filter(isComputePayable).length;

/** /pay-per-call-api: what a pay-per-call API is and how one call is paid. */
export function payPerCallApiPage(baseUrl, catalog, { mpp = mppOffered() } = {}) {
  const free = freeToolCount(catalog);
  const wires = mpp ? "x402 and MPP" : "x402";
  const receipt = receiptsServed() ? "a signed receipt" : "the settlement receipt";
  const body = `
<p class="sl-lead">A pay-per-call API prices each request on its own and takes payment with it. No account, no API key and no monthly plan: the agent reads the price, pays it and gets the answer.</p>
<h2>How one call is paid</h2>
<ol>
  <li>The agent calls a route and gets HTTP 402 with the price and the ways to pay.</li>
  <li>It pays from its own wallet${mpp ? " over x402 or with an MPP credential" : " over x402"} and sends the call again.</li>
  <li>The server settles the payment and answers with the result and ${receipt}.</li>
</ol>
<p>On x402, a call that answers an error is not charged. ${esc(SETTLE_FIRST_SENTENCE)}</p>
<h2>What a call costs</h2>
<p>Most tools cost ${esc(TYPICAL_PRICE_RANGE.text)} per call, and every price is listed on the tool's page and in <a href="/api/pricing">/api/pricing</a> before you pay.${free ? ` ${free} pure-CPU tool${free === 1 ? " is" : "s are"} also free through proof-of-work: the agent solves a small puzzle instead of paying.` : ""}</p>
<h2>Ways to pay</h2>
<ul>
  <li>x402: ${esc(RAILS_OR)}. ${esc(BASE_NO_GAS_SENTENCE)}</li>
  ${mpp ? `<li>MPP: the same routes answer an MPP Payment challenge; see <a href="/what-is-mpp">MPP on Agent402</a>.</li>` : ""}
  <li>Proof-of-work for the pure-CPU tools, with no wallet.</li>
</ul>
<h2>Start</h2>
${links([["/start", "First call"], ["/learn/pay-per-call-api", "The headers, step by step"], ["/tools", "Browse tools"], ["/paid-mcp-tools", "Paid MCP tools"], ["/compare", "Compare"]])}`;
  return page(baseUrl, {
    path: "/pay-per-call-api",
    title: "Pay-per-call APIs for AI agents | Agent402",
    description: `A pay-per-call API prices each request and takes payment with it. How AI agents pay per call over ${wires}, with 500+ tools to call.`,
    h1: "Pay-per-call APIs for AI agents",
    crumb: "Pay-per-call APIs",
    body,
  });
}

/** /paid-mcp-tools: one MCP server, the whole catalog, paid per call. */
export function paidMcpToolsPage(baseUrl, catalog, { wires = connectorWires() } = {}) {
  const slugs = new Set(toolList(catalog).map((t) => t.slug));
  const named = Object.entries(FLAGSHIP_MCP_NAMES).filter(([slug]) => slugs.has(slug)).map(([, name]) => name);
  const c = (s) => `<code>${esc(s)}</code>`;
  // connectorPayText marks its wire keys; escape the prose, then format them.
  const payText = esc(connectorPayText({ code: (s) => `\u0001${s}\u0002` })).replace(/\u0001([^\u0002]*)\u0002/g, "<code>$1</code>");
  const body = `
<p class="sl-lead">One MCP server gives an agent the whole Agent402 catalog: search it, read a tool's price and input schema, and call it. Pure-CPU tools are free through proof-of-work; the rest are paid per call.</p>
<h2>Add it</h2>
<p>The hosted connector, in Claude Code:</p>
${pre(`claude mcp add --transport http agent402 ${baseUrl}/mcp`)}
<p>In Cursor's ${c("mcp.json")}:</p>
${pre(`{ "mcpServers": { "agent402": { "url": "${baseUrl}/mcp" } } }`)}
<p>The local server pays from a wallet you give it. Use a new wallet holding a few dollars of USDC, never your main wallet:</p>
${pre(`claude mcp add agent402 -s user -e AGENT_KEY=0xYOUR_FUNDED_KEY -- npx -y agent402-mcp@${AGENT402_MCP_VERSION}`)}
<p>${getWalletHtml()}</p>
<h2>What the agent sees</h2>
<p>${c("catalog.search")}, ${c("catalog.find")} and ${c("catalog.call")} reach every tool by task or slug, and ${c("payment.info")} says how to pay.${named.length ? ` Common tools also have their own names: ${named.length > 1 ? `${named.slice(0, -1).map(c).join(", ")} and ${c(named[named.length - 1])}` : c(named[0])}.` : ""}</p>
<h2>How a paid tool is paid</h2>
<p>${payText}</p>
<h2>More</h2>
${links([["/integrations/mcp", "MCP package"], ["/docs/MCP-Connector", "Connector docs"], ["/how-to-pay", "How to pay"], ["/pay-per-call-api", "Pay-per-call APIs"], ["/compare", "Compare"]])}`;
  return page(baseUrl, {
    path: "/paid-mcp-tools",
    title: "Paid MCP tools for AI agents | Agent402",
    description: wires.names.length
      ? `Add 500+ tools to any MCP client with one command. Pure-CPU tools are free; the rest are paid in the call over ${wires.phrase}.`
      : "Add 500+ tools to any MCP client with one command, with pure-CPU tools free through proof-of-work.",
    h1: "Paid MCP tools for AI agents",
    crumb: "Paid MCP tools",
    body,
  });
}

/** /compare: the ways to give an agent tools, side by side (category labels
 *  only: no product or vendor is named). */
export function comparePage(baseUrl) {
  const [first, ...rest] = WHY_COMPARE.cols;
  const head = `<tr><th scope="col"></th>${WHY_COMPARE.cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr>`;
  const rows = WHY_COMPARE.rows.map(([label, ...cells]) => `<tr><td>${esc(label)}</td>${cells.map((v, i) => `<td data-col="${esc(WHY_COMPARE.cols[i])}"${i === 0 ? ' class="sl-here"' : ""}>${esc(v)}</td>`).join("")}</tr>`).join("");
  const points = WHY_POINTS.map((w) => `<li><b>${esc(w.h)}</b>${esc(w.s)}${w.links?.length ? ` ${w.links.map(([href, label]) => `<a href="${esc(href)}">${esc(label)}</a>`).join(" · ")}` : ""}</li>`).join("");
  const body = `
<p class="sl-lead">Three ways to give an agent tools, compared on what it takes to start, pay, find a tool, handle errors and run it. "${esc(first)}" is this server; the other columns are ${esc(rest.join(" and ").toLowerCase())}.</p>
<div style="overflow-x:auto"><table class="sl-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
<h2>What is different here</h2>
<ul class="sl-points">${points}</ul>
<h2>Start</h2>
${links([["/start", "First call"], ["/pay-per-call-api", "Pay-per-call APIs"], ["/paid-mcp-tools", "Paid MCP tools"], ["/proof", "Receipts"]])}`;
  return page(baseUrl, {
    path: "/compare",
    title: "Compare ways to give an AI agent tools | Agent402",
    description: "Three ways to give an AI agent tools, side by side: build each one yourself, call each provider directly, or call one catalog paid per call.",
    h1: "Compare ways to give an agent tools",
    crumb: "Compare",
    body,
  });
}

/** The catalog entry for a slug (null when this boot does not serve it). */
const defOf = (catalog, slug) => toolList(catalog).find((t) => t.slug === slug) || null;
const routeParts = (def) => { const [method, path] = String(def.route).split(" "); return { method, path }; };

/** /insider-trades-api: SEC Form 4 insider trades by API, with the cheapest
 *  route that lists them and the report product that reads them. */
export function insiderTradesApiPage(baseUrl, catalog, { storefront = humanCheckoutEnabled() } = {}) {
  const list = defOf(catalog, "edgar-insider-trades");
  const report = defOf(catalog, "insider-report");
  if (!list) throw new Error("insider-trades-api: edgar-insider-trades is not in the catalog");
  const c = (s) => `<code>${esc(s)}</code>`;
  const l = routeParts(list);
  const input = list.discovery?.input || {};
  const query = new URLSearchParams(Object.entries(input).map(([k, v]) => [k, String(v)])).toString();
  const example = list.discovery?.output?.example || null;
  const rowFields = example?.trades?.[0] ? Object.keys(example.trades[0]) : [];
  // The handler also answers the window's dates and its source, which the
  // published example leaves out.
  const topFields = example ? [...new Set([...Object.keys(example).filter((k) => k !== "trades"), "startDate", "endDate", "source"])] : [];
  const inputFields = Object.keys(list.discovery?.inputSchema?.properties || {});
  const or = (arr) => arr.length > 1 ? `${arr.slice(0, -1).map(c).join(", ")} and ${c(arr[arr.length - 1])}` : arr.map(c).join("");
  // The card sentences are an offer: printed only while the storefront is on
  // and sells this report.
  const byCard = Boolean(storefront && report && HUMAN_PRODUCTS[report.slug]);
  let reportBlock = "";
  if (report) {
    const r = routeParts(report);
    const job = needsAsyncOrWait(asyncProfileOf(report));
    const body = JSON.stringify(report.discovery?.input || { ticker: input.ticker });
    reportBlock = `
<h2>Get the transactions, read and summarized</h2>
<p>A filing row says who filed and when; the shares, prices and transaction codes are inside the filing. ${c(`${r.method} ${r.path}`)} (${esc(report.price)} a call, model-backed) reads every Form 4 in the window, separates open-market buys and sales from awards, option exercises and tax withholding, totals them per insider and as a net flow, and a model writes a cited report with the transactions as a table.${job ? ` It runs as a job: send ${c("Prefer: respond-async")}, then poll the ${c("Location")} link it answers (free) until the report is ready.` : ""}</p>
${pre(`curl -i -X POST ${baseUrl}${r.path} \\
  -H 'Content-Type: application/json'${job ? " \\\n  -H 'Prefer: respond-async'" : ""} \\
  -d '${body}'`)}
${byCard ? `<p>People can buy the same report by card at <a href="/reports">Reports</a>.</p>` : ""}`;
  }
  const bodyHtml = `
<p class="sl-lead">Form 4 is the filing an officer, director or 10% holder makes after trading the company's stock. Agent402 reads those filings from SEC EDGAR and serves them by API, paid per call from an agent's wallet with no account or key.</p>
<h2>List the Form 4 filings against a company</h2>
<p>${c(`${l.method} ${l.path}`)} costs ${esc(list.price)} a call. It takes ${or(inputFields)}, and returns the Form 4 filings where the company is the issuer.</p>
${pre(`curl -i "${baseUrl}${l.path}?${query}"`)}
<p>The first answer is HTTP 402 with the price and the ways to pay. An x402 client signs the payment and sends the same request again; the answer is the list below.</p>
${example ? `<h2>What comes back</h2>
<p>The top-level fields, ${or(topFields)}, name the company, the window and the source. Each row in ${c("trades")} carries ${or(rowFields)}: ${c("url")} is the filing on sec.gov, and ${c("cik")} there is the insider's own filer number. ${example.trades && Number(example.returned) > example.trades.length ? `The published example, shortened to ${example.trades.length === 1 ? "one row" : `${example.trades.length} rows`}, uses a made-up issuer, filer and accession number; a live answer names the company asked for:` : "The published example uses a made-up issuer, filer and accession number; a live answer names the company asked for:"}</p>
${pre(JSON.stringify(example, null, 2))}` : ""}
${reportBlock}
<h2>From an agent</h2>
<p>Over MCP, the hosted connector at ${c(`${baseUrl}/mcp`)} reaches both: ${c("catalog.find")} with a task such as "insider trades for a ticker" returns the route, its input schema and its price, and ${c("catalog.call")} runs it. Over HTTP, <a href="/api/find?q=insider%20trades">/api/find</a> answers the same question.</p>
<h2>Source and use</h2>
<p>Form 4 filings are public records published by the U.S. Securities and Exchange Commission on EDGAR; each row of a live answer links the filing itself, so every figure can be checked at the source. Agent402 reads them with a declared User-Agent, as SEC's access rules ask. Agent402 is not affiliated with or endorsed by the SEC.</p>
<p>Information only, not investment advice. A Form 4 reports a trade after it happened, and says nothing about why it was made.</p>
<h2>More</h2>
${links([[`/tools/${list.slug}`, "Insider trades tool"], ...(report ? [[`/tools/${report.slug}`, "Insider flow report"]] : []), ...(byCard ? [["/reports", "Reports by card"]] : []), [CRYPTO_HISTORY_STATS_PATH, "Crypto history statistics"], ["/start", "First call"], ["/how-to-pay", "How to pay"]])}`;
  return page(baseUrl, {
    path: INSIDER_TRADES_PATH,
    title: "Insider trades API: SEC Form 4 data for agents | Agent402",
    description: "SEC Form 4 insider trades by API: the filings against any US ticker, paid per call with no account or key, plus a cited report. Information only.",
    h1: "Insider trades by API: SEC Form 4 data",
    crumb: "Insider trades API",
    body: bodyHtml,
  });
}

/** /crypto-history-stats-api: a coin's past year as computed statistics
 *  (return, largest drawdown, volatility) and a stablecoin's worst distance
 *  from its peg over a day and a week. Both routes answer figures computed
 *  here; neither returns a price series, and the page says so. */
export function cryptoHistoryStatsApiPage(baseUrl, catalog) {
  const year = defOf(catalog, "token-diligence");
  const peg = defOf(catalog, "stablecoin-depeg-watch");
  if (!year) throw new Error("crypto-history-stats-api: token-diligence is not in the catalog");
  const c = (s) => `<code>${esc(s)}</code>`;
  const or = (arr) => arr.length > 1 ? `${arr.slice(0, -1).map(c).join(", ")} and ${c(arr[arr.length - 1])}` : arr.map(c).join("");
  const y = routeParts(year);
  const yBody = JSON.stringify(year.discovery?.input || {});
  const yExample = year.discovery?.output?.example || {};
  // The look-back fields of a row's `computed` block, as the published example names them.
  const yFields = Object.keys(yExample.rows?.[0]?.computed || {}).filter((k) => /1y|Annualized|candles/.test(k));
  const yRanks = Object.keys(yExample.comparison || {}).filter((k) => /Return|Volatility/.test(k));
  const credit = `<p class="sl-credit">Powered by <a href="${esc(COINGECKO_API_URL)}" rel="noopener">CoinGecko</a>.</p>`;
  let pegBlock = "";
  if (peg) {
    const p = routeParts(peg);
    const query = new URLSearchParams(Object.entries(peg.discovery?.input || {}).map(([k, v]) => [k, String(v)])).toString();
    const pFields = Object.keys(peg.discovery?.output?.example?.coins?.[0] || {}).filter((k) => /deviation/i.test(k));
    pegBlock = `
<h2>A stablecoin's worst day and week against its peg</h2>
<p>${c(`${p.method} ${p.path}`)} costs ${esc(peg.price)} a call. For every large USD stablecoin it answers the distance from the peg now and the widest distance over the past 24 hours and 7 days, in basis points${pFields.length ? ` (${or(pFields)})` : ""}, with a status and flags for the ones that left it.</p>
${pre(`curl -i "${baseUrl}${p.path}${query ? `?${query}` : ""}"`)}`;
  }
  const bodyHtml = `
<p class="sl-lead">Agent402 answers questions about a coin's past year with statistics computed here: one-year return, largest drawdown and annualized volatility. The routes return those figures, not the price series behind them, paid per call from an agent's wallet with no account or key.</p>
${credit}
<h2>One-year return, drawdown and volatility for a list of coins</h2>
<p>${c(`${y.method} ${y.path}`)} costs ${esc(year.price)} a coin, quoted in the 402 for the coins you send. It reads a year of price candles for each coin and reduces them to the figures below, then ranks the list.</p>
${pre(`curl -i -X POST ${baseUrl}${y.path} \\
  -H 'Content-Type: application/json' \\
  -d '${yBody}'`)}
<p>The first answer is HTTP 402 with the price and the ways to pay. An x402 client signs the payment and sends the same request again.</p>
<h2>What comes back</h2>
<p>Each row's ${c("computed")} block carries ${or(yFields)}:</p>
<ul>
  <li>${c("return1yPct")}: the change from the first to the last candle close of the year.</li>
  <li>${c("maxDrawdown1yPct")}: the largest fall from a running high to a later candle's low.</li>
  <li>${c("volatilityAnnualizedPct")}: the standard deviation of close-to-close log returns, scaled to a year.</li>
  <li>${c("candles")}: how many candles the figures were computed from, and their width.</li>
</ul>
<p>${yRanks.length ? `${c("comparison")} ranks the coins you sent (${or(yRanks)}), and ` : ""}${c("flags")} names measured conditions such as a deep drawdown or high volatility. The ${c("method")} field of every answer states each formula, so a figure can be recomputed. The <a href="/tools/${esc(year.slug)}">tool page</a> shows the full answer shape.</p>
${pegBlock}
<h2>What these routes are</h2>
<p>They are computed answers: ratios, ranks, deviations and flags worked out by deterministic code, with no model in either route. They do not return candles, a price series or a coin's price on a past date, so they suit a question such as "how far did this coin fall in the past year" and not a chart or a backtest that needs every point.</p>
<h2>From an agent</h2>
<p>Over MCP, the hosted connector at ${c(`${baseUrl}/mcp`)} reaches both: ${c("catalog.find")} with a task such as "one-year drawdown for a coin" returns the route, its input schema and its price, and ${c("catalog.call")} runs it. Over HTTP, <a href="/api/find?q=one-year%20drawdown%20for%20a%20coin">/api/find</a> answers the same question.</p>
<h2>Source and use</h2>
<p>The figures are computed from market data. Powered by <a href="${esc(COINGECKO_API_URL)}" rel="noopener">CoinGecko</a>; every answer carries the same credit. Agent402 is not affiliated with or endorsed by CoinGecko.</p>
<p>Information only, not investment advice. A past return, drawdown or volatility describes what happened, and says nothing about what happens next.</p>
<h2>More</h2>
${links([[`/tools/${year.slug}`, "Token diligence tool"], ...(peg ? [[`/tools/${peg.slug}`, "Stablecoin depeg watch"]] : []), [INSIDER_TRADES_PATH, "Insider trades by API"], ["/start", "First call"], ["/how-to-pay", "How to pay"]])}`;
  return page(baseUrl, {
    path: CRYPTO_HISTORY_STATS_PATH,
    title: "Crypto history stats API: return and drawdown | Agent402",
    description: "Crypto history statistics by API: one-year return, drawdown and volatility per coin, computed from a year of candles. Not a price feed. Information only.",
    h1: "Crypto history statistics by API",
    crumb: "Crypto history statistics",
    body: bodyHtml,
  });
}
