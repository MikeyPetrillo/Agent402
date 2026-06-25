import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

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

  const extraCss = `
.wf-wrap{max-width:960px;margin:0 auto;padding:56px 30px}
.wf-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px}
.wf-h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px}
.wf-intro{max-width:760px;font-size:15px;line-height:1.55;color:var(--muted);margin:0 0 40px}
.wf-grid{display:flex;flex-direction:column;gap:20px;margin-bottom:48px}
.wf-card{background:var(--card);border:1.5px solid var(--ink);padding:24px 26px}
.wf-card h3{margin:0 0 8px;font-family:var(--font-body);font-weight:800;font-size:22px;color:var(--ink)}
.wf-desc{color:var(--muted);font-size:14px;line-height:1.55;margin:0 0 20px}
.wf-flow{display:flex;align-items:stretch;gap:0;flex-wrap:nowrap;overflow-x:auto;padding:4px 0}
.wf-step{display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--card);border:1.5px solid var(--ink);padding:12px 16px;min-width:120px;max-width:170px;text-decoration:none;transition:border-color .15s;flex-shrink:0}
.wf-step:hover{border-color:var(--accent)}
.wf-step-name{color:var(--accent);font-family:var(--font-mono);font-size:13px;font-weight:700;margin-bottom:4px}
.wf-step-desc{color:var(--muted);font-size:12px;line-height:1.35;text-align:center}
.wf-arrow{display:flex;align-items:center;justify-content:center;color:var(--faint);font-size:18px;padding:0 8px;flex-shrink:0}
.wf-cost{font-size:14px;margin:14px 0 0;color:var(--muted)}
.wf-label{color:var(--ink);font-weight:600}
.wf-price{color:var(--accent);font-family:var(--font-mono);font-weight:700}
.wf-cta{text-align:center;margin:32px 0 48px}
.wf-cta a{display:inline-block;background:var(--accent);color:#fff;font-family:var(--font-mono);font-weight:700;text-decoration:none;font-size:14px;padding:14px 30px;border:1.5px solid var(--accent)}
.wf-cta a:hover{opacity:.88}
@media(max-width:740px){
  .wf-h1{font-size:36px !important}
  .wf-flow{flex-direction:column;align-items:stretch}
  .wf-step{max-width:none;flex-direction:row;gap:12px;justify-content:flex-start}
  .wf-step-desc{text-align:left}
  .wf-arrow{transform:rotate(90deg);padding:4px 0}
}
`;

  const body = `
<div class="wf-wrap">
<div class="wf-eyebrow">$ GET /workflows</div>
<h1 class="wf-h1">Workflows</h1>
<p class="wf-intro">Agent402 tools are designed to chain together. Each workflow below shows a multi-step pipeline an agent can run end-to-end, with estimated per-run cost at pay-per-call pricing.</p>
<div class="wf-grid">
${cards}
</div>
<div class="wf-cta"><a href="/playground">Try it yourself &rarr;</a></div>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title: pageTitle, description: pageDesc, canonical, baseUrl, activePath: "/workflows", jsonLd, extraCss, body });
}
