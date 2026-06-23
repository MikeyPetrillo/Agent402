import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

const USE_CASES = [
  {
    title: "Research 50 public companies overnight",
    story: "An investment analyst\u2019s agent iterated through 50 S&P 500 tickers, pulling 10-K filings, earnings history, and live quotes for each. By morning, 50 structured summaries were ready for review.",
    tools: ["research-company", "edgar-filings", "stock-quote", "stock-history"],
    cost: "~$0.50 (50 \u00d7 ~$0.01/call)",
  },
  {
    title: "Audit a domain\u2019s security posture in 30 seconds",
    story: "A security team\u2019s agent ran the security-audit skill pack against a candidate vendor\u2019s domain: DNS records, TLS certificate, WHOIS, HTTP headers, SPF/DKIM, and robots.txt \u2014 all in one pass.",
    tools: ["dns", "tls-cert", "whois", "http-check", "spf-check", "robots-check"],
    cost: "~$0.04 (7 tool calls)",
  },
  {
    title: "Extract and compare 200 PDF invoices",
    story: "A procurement agent batch-processed 200 supplier invoices: PDF to markdown, then parsed line items, totals, and dates into structured JSON for reconciliation.",
    tools: ["pdf-to-markdown", "extract"],
    cost: "~$1.00 (200 \u00d7 $0.005)",
  },
  {
    title: "Monitor competitor pricing daily",
    story: "A pricing agent visits 20 product pages every morning, renders the JavaScript-heavy pages, extracts the price elements, and logs changes to wallet-keyed memory for trend analysis.",
    tools: ["render", "extract", "memory-write", "memory-read"],
    cost: "~$0.40/day (20 renders + 20 extracts + writes)",
  },
  {
    title: "Build a macro dashboard from government data",
    story: "A research agent assembled a US economic snapshot: CPI year-over-year, unemployment, Fed funds rate, Treasury yield curve, and FX rates \u2014 all from official FRED and Treasury feeds, no API keys needed.",
    tools: ["cpi-yoy", "unemployment-rate", "fed-funds", "treasury-yield-curve", "ecb-fx-rates"],
    cost: "~$0.005 (5 \u00d7 $0.001, all free via PoW)",
  },
  {
    title: "Answer customer questions with live web search",
    story: "A support agent searches the live web for product documentation, gets a cited synthesis via the answer tool, and includes source URLs in its response to the customer.",
    tools: ["search", "answer", "extract"],
    cost: "~$0.02 per question",
  },
  {
    title: "Validate and geocode a 500-row address list",
    story: "An ops agent processed a CSV of customer addresses: validated formatting, geocoded each to lat/lng, and flagged duplicates \u2014 no Google Maps API key required.",
    tools: ["geocode", "csv-lint", "validate-email"],
    cost: "~$2.50 (500 geocodes at $0.005)",
  },
  {
    title: "Cross-check SEC insider trades against stock moves",
    story: "A compliance agent pulled recent insider trades from EDGAR, matched them against stock price history, and flagged trades that preceded significant price movements.",
    tools: ["edgar-insider-trades", "stock-history", "stock-quote"],
    cost: "~$0.10 per company",
  },
];

export function useCasesPage(baseUrl) {
  const canonical = `${baseUrl}/use-cases`;
  const pageTitle = "Use Cases \u2014 what agents build with Agent402";
  const pageDesc = "Concrete examples of autonomous agents using Agent402: company research, security audits, PDF processing, live web search, macro dashboards, and more.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: pageTitle,
    description: pageDesc,
    url: canonical,
    numberOfItems: USE_CASES.length,
    itemListElement: USE_CASES.map((uc, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: uc.title,
      description: uc.story,
    })),
  };

  const cards = USE_CASES.map((uc) => {
    const toolLinks = uc.tools
      .map((slug) => `<a href="/tools/${esc(slug)}" class="tool-link">${esc(slug)}</a>`)
      .join(", ");
    return `
      <div class="uc-card">
        <h3>${esc(uc.title)}</h3>
        <p class="uc-story">${esc(uc.story)}</p>
        <p class="uc-tools"><span class="uc-label">Tools used:</span> ${toolLinks}</p>
        <p class="uc-cost"><span class="uc-label">Cost:</span> <span class="uc-price">${esc(uc.cost)}</span></p>
      </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(pageDesc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(pageTitle)}">
<meta property="og:description" content="${esc(pageDesc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(pageTitle)}">
<meta name="twitter:description" content="${esc(pageDesc)}">
${CHROME_HEAD_LINKS}
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
${CHROME_CSS}
:root{--bg:#0b0e14;--card:#131826;--text:#e6e9f0;--muted:#8b93a7;--accent:#4ade80;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
.uc-intro{max-width:760px;color:var(--muted);line-height:1.7;margin:0 0 2.5rem}
.uc-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1.5rem;margin-bottom:3rem}
@media(max-width:740px){.uc-grid{grid-template-columns:1fr}}
.uc-card{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:1.5rem 1.6rem}
.uc-card h3{margin:0 0 .75rem;font-size:1.1rem;color:var(--text);font-weight:600}
.uc-story{color:var(--muted);font-size:.93rem;line-height:1.65;margin:0 0 1rem}
.uc-tools,.uc-cost{font-size:.88rem;margin:.35rem 0;color:var(--muted)}
.uc-label{color:var(--text);font-weight:500}
.uc-price{color:var(--accent);font-family:var(--mono);font-weight:500}
.tool-link{color:var(--accent);text-decoration:none;font-family:var(--mono);font-size:.85rem}
.tool-link:hover{text-decoration:underline}
.uc-cta{text-align:center;margin:2rem 0 3rem}
.uc-cta a{color:var(--accent);font-weight:600;text-decoration:none;font-size:1.05rem}
.uc-cta a:hover{text-decoration:underline}
.breadcrumb{font-size:.85rem;color:var(--muted);margin-bottom:1.5rem}
.breadcrumb a{color:var(--accent);text-decoration:none}
.breadcrumb a:hover{text-decoration:underline}
</style>
</head>
<body>
${renderHeader("/use-cases")}
<main style="max-width:960px;margin:0 auto;padding:2rem 1.25rem">
<p class="breadcrumb"><a href="/">Home</a> &rsaquo; Use Cases</p>
<h1 style="font-size:1.8rem;margin:0 0 1rem;color:var(--text)">Use Cases</h1>
<p class="uc-intro">Real tasks agents solve with Agent402 &mdash; from overnight research to live monitoring. Each example shows the tools involved and what it costs at per-call pricing.</p>
<div class="uc-grid">
${cards}
</div>
<div class="uc-cta"><a href="/quickstart">Ready to build? Start with the quickstart guide &rarr;</a></div>
</main>
${renderFooter()}
</body>
</html>`;
}
