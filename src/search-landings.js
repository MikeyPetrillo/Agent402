// Three landing pages for the questions people search before they find this
// server: what a pay-per-call API is (/pay-per-call-api), how to give an MCP
// client paid tools (/paid-mcp-tools), and how the ways to give an agent tools
// compare (/compare). Each one is short, first-party and links to the page
// that goes deep; every price, count and payment wire is read from the same
// sources the 402 and the catalog read, never typed here.
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

export const SEARCH_LANDING_PATHS = ["/pay-per-call-api", "/paid-mcp-tools", "/compare"];

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
