import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { isComputePayable } from "./pow.js";

// Each chain feeds the next step what the previous one returns (render and
// extract return markdown, not HTML; pdf-to-markdown returns markdown, not
// tables), so no step after them takes HTML or CSV; scripts/test-workflows-page.js
// holds that, and runs the chains it can against a booted server.
//
// Per-run cost is DERIVED from the live catalog at render time: the sum of
// each step's list price, and "free via proof-of-work" only when every step
// is compute-payable. A step whose slug is not in the catalog is dropped from
// the card rather than priced from a stale figure.
const usd = (p) => Number(String(p ?? "").replace(/[^0-9.]/g, "")) || 0;
export function workflowCost(steps, catalog) {
  const bySlug = new Map(Object.values(catalog || {}).filter((d) => d && d.slug).map((d) => [d.slug, d]));
  const defs = steps.map((st) => bySlug.get(st.slug)).filter(Boolean);
  const micro = defs.reduce((n, d) => n + Math.round(usd(d.price) * 1e6), 0);
  const allFree = defs.length > 0 && defs.every((d) => isComputePayable(d));
  const total = micro / 1e6;
  const label = allFree
    ? "free via proof-of-work"
    : `$${total.toFixed(total < 0.1 ? 3 : 2)} per run at list price`;
  return { known: new Set(defs.map((d) => d.slug)), total, allFree, label };
}

export const WORKFLOWS = [
  {
    title: "Research a company",
    description: "Search the web for a company, read its homepage as clean markdown, pull its key reported financials, and retrieve its recent SEC filings - all in one chain.",
    steps: [
      { slug: "search", label: "Search the web for the company" },
      { slug: "extract", label: "Read the homepage as markdown" },
      { slug: "company-financials", label: "Pull key reported financials" },
      { slug: "edgar-filings", label: "Retrieve SEC filings from EDGAR" },
    ],
  },
  {
    title: "Audit a domain",
    description: "Run a full security and configuration audit on any domain: DNS records, TLS certificate, WHOIS registration, HTTP headers, SPF policy, and robots.txt.",
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
    title: "Read a PDF document",
    description: "Check a PDF's page count and metadata, convert it to markdown for a model's context, then measure the text: words, sentences, reading time and a token estimate.",
    steps: [
      { slug: "pdf-info", label: "Read page count and metadata" },
      { slug: "pdf-to-markdown", label: "Convert the PDF to markdown" },
      { slug: "text-stats", label: "Count words, tokens and reading time" },
    ],
  },
  {
    title: "Monitor a webpage",
    description: "Render a JavaScript-heavy page as markdown, read the previous snapshot from wallet-keyed memory, diff the two line by line, and save the new snapshot for the next run.",
    steps: [
      { slug: "render", label: "Render the page as markdown" },
      { slug: "memory-read", label: "Read the previous snapshot" },
      { slug: "text-diff", label: "Diff old and new, line by line" },
      { slug: "memory-write", label: "Save the new snapshot" },
    ],
  },
  {
    title: "Build a macro dashboard",
    description: "Assemble a US economic snapshot from official government feeds: CPI, unemployment, Fed funds rate, and the Treasury yield curve - paid per call from a wallet.",
    steps: [
      { slug: "cpi-yoy", label: "Fetch CPI year-over-year rate" },
      { slug: "unemployment-rate", label: "Get current unemployment rate" },
      { slug: "fed-funds", label: "Pull the Fed funds rate" },
      { slug: "treasury-yield-curve", label: "Retrieve Treasury yield curve" },
    ],
  },
];

export function workflowsPage(baseUrl, catalog = {}) {
  const canonical = `${baseUrl}/workflows`;
  const pageTitle = "Workflows - tool chaining examples for Agent402";
  const pageDesc = "See how agents chain Agent402 tools into multi-step workflows: company research, domain audits, reading a PDF, web monitoring, and macro dashboards.";

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
    const cost = workflowCost(wf.steps, catalog);
    const steps = wf.steps
      .filter((s) => cost.known.has(s.slug))
      .map((s) => `<a href="/tools/${esc(s.slug)}" class="wf-step"><span class="wf-step-name">${esc(s.slug)}</span><span class="wf-step-desc">${esc(s.label)}</span></a>`)
      .join(`<span class="wf-arrow" aria-hidden="true">\u2192</span>`);
    return `
      <div class="wf-card">
        <h3>${esc(wf.title)}</h3>
        <p class="wf-desc">${esc(wf.description)}</p>
        <div class="wf-flow">${steps}</div>
        <p class="wf-cost"><span class="wf-label">Cost:</span> <span class="wf-price">${esc(cost.label)}</span></p>
      </div>`;
  }).join("\n");

  const extraCss = `
.wf-wrap{max-width:960px;margin:0 auto;padding:56px 30px}
.wf-eyebrow{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:18px}
.wf-h1{font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.96;margin:0 0 14px}
.wf-intro{max-width:760px;font-size:var(--fs-base);line-height:1.55;color:var(--muted);margin:0 0 40px}
.wf-grid{display:flex;flex-direction:column;gap:20px;margin-bottom:48px}
.wf-card{background:var(--card);border:1px solid var(--hairline);padding:24px 26px}
.wf-card h3{margin:0 0 8px;font-family:var(--font-body);font-weight:600;font-size:var(--fs-xl);color:var(--ink)}
.wf-desc{color:var(--muted);font-size:var(--fs-md);line-height:1.55;margin:0 0 20px}
.wf-flow{display:flex;align-items:stretch;gap:0;flex-wrap:nowrap;overflow-x:auto;padding:4px 0}
.wf-step{display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--card);border:1px solid var(--hairline);padding:12px 16px;min-width:120px;max-width:170px;text-decoration:none;transition:border-color .15s;flex-shrink:0}
.wf-step:hover{border-color:var(--accent)}
.wf-step-name{color:var(--accent);font-family:var(--font-mono);font-size:var(--fs-sm);font-weight:700;margin-bottom:4px}
.wf-step-desc{color:var(--muted);font-size:var(--fs-xs);line-height:1.35;text-align:center}
.wf-arrow{display:flex;align-items:center;justify-content:center;color:var(--faint);font-size:var(--fs-lg);padding:0 8px;flex-shrink:0}
.wf-cost{font-size:var(--fs-md);margin:14px 0 0;color:var(--muted)}
.wf-label{color:var(--ink);font-weight:600}
.wf-price{color:var(--accent);font-family:var(--font-mono);font-weight:700}
.wf-cta{text-align:center;margin:32px 0 48px}
.wf-cta a{display:inline-block;background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;text-decoration:none;font-size:var(--fs-md);padding:14px 30px;border:1.5px solid var(--accent)}
.wf-cta a:hover{opacity:.88}
@media(max-width:740px){
  .wf-h1{font-size:var(--fs-3xl) !important}
  .wf-flow{flex-direction:column;align-items:stretch}
  .wf-step{max-width:none;flex-direction:row;gap:12px;justify-content:flex-start}
  .wf-step-desc{text-align:left}
  .wf-arrow{transform:rotate(90deg);padding:4px 0}
}
`;

  const body = `
<div class="wf-wrap">
<section>
<div class="wf-eyebrow">$ GET /workflows</div>
<h1 class="wf-h1">Workflows</h1>
<p class="wf-intro">Agent402 tools are designed to chain together. Each workflow below shows a multi-step pipeline an agent can run end-to-end, with its per-run cost: the sum of each step's list price from the live catalog.</p>
</section>
<section>
<div class="wf-grid">
${cards}
</div>
</section>
<section>
<div class="wf-cta"><a href="/playground">Try it yourself &rarr;</a></div>
</section>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title: pageTitle, description: pageDesc, canonical, baseUrl, activePath: "/workflows", jsonLd, extraCss, body });
}
