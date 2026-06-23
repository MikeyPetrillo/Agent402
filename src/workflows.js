import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

const WORKFLOWS = [
  {
    title: "Research a company",
    description: "Search the web for a company, render a key page, extract structured data, pull a company profile, and retrieve SEC filings \u2014 all in one chain.",
    cost: "~$0.03",
    steps: [
      { slug: "search", label: "Search the web for the company" },
      { slug: "render", label: "Render the company homepage" },
      { slug: "extract", label: "Extract structured data from the page" },
      { slug: "research-company", label: "Pull a full company profile" },
      { slug: "edgar-filings", label: "Retrieve SEC filings from EDGAR" },
    ],
  },
  {
    title: "Audit a domain",
    description: "Run a full security and configuration audit on any domain: DNS records, TLS certificate, WHOIS registration, HTTP headers, SPF policy, and robots.txt.",
    cost: "~$0.04",
    steps: [
      { slug: "dns", label: "Look up DNS records" },
      { slug: "tls-cert", label: "Inspect the TLS certificate" },
      { slug: "whois", label: "Query WHOIS registration" },
      { slug: "http-check", label: "Check HTTP headers and status" },
      { slug: "spf-check", label: "Validate SPF policy" },
      { slug: "robots-check", label: "Parse robots.txt rules" },
    ],
  },
  {
    title: "Process PDF invoices",
    description: "Convert a PDF invoice to markdown, extract line items and totals into structured JSON, then validate the output as clean CSV.",
    cost: "~$0.015",
    steps: [
      { slug: "pdf-to-markdown", label: "Convert PDF to markdown text" },
      { slug: "extract", label: "Extract line items and totals" },
      { slug: "csv-lint", label: "Validate and lint the CSV output" },
    ],
  },
  {
    title: "Monitor a webpage",
    description: "Render a JavaScript-heavy page, extract a target element, write the result to wallet-keyed memory, and read back previous snapshots for change detection.",
    cost: "~$0.02",
    steps: [
      { slug: "render", label: "Render the target page" },
      { slug: "extract", label: "Extract the monitored element" },
      { slug: "memory-write", label: "Save snapshot to memory" },
      { slug: "memory-read", label: "Read previous snapshots" },
    ],
  },
  {
    title: "Build a macro dashboard",
    description: "Assemble a US economic snapshot from official government feeds: CPI, unemployment, Fed funds rate, and the Treasury yield curve \u2014 all free via proof-of-work.",
    cost: "free via PoW",
    steps: [
      { slug: "cpi-yoy", label: "Fetch CPI year-over-year rate" },
      { slug: "unemployment-rate", label: "Get current unemployment rate" },
      { slug: "fed-funds", label: "Pull the Fed funds rate" },
      { slug: "treasury-yield-curve", label: "Retrieve Treasury yield curve" },
    ],
  },
];

export function workflowsPage(baseUrl) {
  const canonical = `${baseUrl}/workflows`;
  const pageTitle = "Workflows \u2014 tool chaining examples for Agent402";
  const pageDesc = "See how agents chain Agent402 tools into multi-step workflows: company research, domain audits, PDF processing, web monitoring, and macro dashboards.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: pageTitle,
    description: pageDesc,
    url: canonical,
    numberOfItems: WORKFLOWS.length,
    itemListElement: WORKFLOWS.map((wf, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: wf.title,
      description: wf.description,
    })),
  };

  const cards = WORKFLOWS.map((wf) => {
    const steps = wf.steps
      .map((s) => `<a href="/tools/${esc(s.slug)}" class="wf-step"><span class="wf-step-name">${esc(s.slug)}</span><span class="wf-step-desc">${esc(s.label)}</span></a>`)
      .join(`<span class="wf-arrow" aria-hidden="true">\u2192</span>`);
    return `
      <div class="wf-card">
        <h3>${esc(wf.title)}</h3>
        <p class="wf-desc">${esc(wf.description)}</p>
        <div class="wf-flow">${steps}</div>
        <p class="wf-cost"><span class="wf-label">Estimated cost:</span> <span class="wf-price">${esc(wf.cost)}</span></p>
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
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;margin:0}
.breadcrumb{font-size:.85rem;color:var(--muted);margin-bottom:1.5rem}
.breadcrumb a{color:var(--accent);text-decoration:none}
.breadcrumb a:hover{text-decoration:underline}
.wf-intro{max-width:760px;color:var(--muted);line-height:1.7;margin:0 0 2.5rem}
.wf-grid{display:flex;flex-direction:column;gap:1.5rem;margin-bottom:3rem}
.wf-card{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:1.5rem 1.6rem}
.wf-card h3{margin:0 0 .6rem;font-size:1.15rem;color:var(--text);font-weight:600}
.wf-desc{color:var(--muted);font-size:.93rem;line-height:1.65;margin:0 0 1.2rem}
.wf-flow{display:flex;align-items:stretch;gap:0;flex-wrap:nowrap;overflow-x:auto;padding:.25rem 0}
.wf-step{display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:.7rem 1rem;min-width:120px;max-width:170px;text-decoration:none;transition:border-color .15s,background .15s;flex-shrink:0}
.wf-step:hover{border-color:var(--accent);background:rgba(74,222,128,.06)}
.wf-step-name{color:var(--accent);font-family:var(--mono);font-size:.82rem;font-weight:600;margin-bottom:.3rem}
.wf-step-desc{color:var(--muted);font-size:.75rem;line-height:1.35;text-align:center}
.wf-arrow{display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:1.1rem;padding:0 .5rem;flex-shrink:0}
.wf-cost{font-size:.88rem;margin:.9rem 0 0;color:var(--muted)}
.wf-label{color:var(--text);font-weight:500}
.wf-price{color:var(--accent);font-family:var(--mono);font-weight:500}
.wf-cta{text-align:center;margin:2rem 0 3rem}
.wf-cta a{display:inline-block;color:#0b0e14;background:var(--accent);font-weight:600;text-decoration:none;font-size:1.05rem;padding:.7rem 2rem;border-radius:8px;transition:opacity .15s}
.wf-cta a:hover{opacity:.88}
@media(max-width:740px){
  .wf-flow{flex-direction:column;align-items:stretch}
  .wf-step{max-width:none;flex-direction:row;gap:.7rem;justify-content:flex-start}
  .wf-step-desc{text-align:left}
  .wf-arrow{transform:rotate(90deg);padding:.25rem 0}
}
</style>
</head>
<body>
${renderHeader("/workflows")}
<main style="max-width:960px;margin:0 auto;padding:2rem 1.25rem">
<p class="breadcrumb"><a href="/">Home</a> &rsaquo; Workflows</p>
<h1 style="font-size:1.8rem;margin:0 0 1rem;color:var(--text)">Workflows</h1>
<p class="wf-intro">Agent402 tools are designed to chain together. Each workflow below shows a multi-step pipeline an agent can run end-to-end, with estimated per-run cost at pay-per-call pricing.</p>
<div class="wf-grid">
${cards}
</div>
<div class="wf-cta"><a href="/playground">Try it yourself &rarr;</a></div>
</main>
${renderFooter()}
</body>
</html>`;
}
