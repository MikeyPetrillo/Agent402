import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

// Example tasks, each with the calls it makes. The COST is computed from the
// live catalog at render time: every typed cost line on this page had drifted
// from the prices the paywall charges, one claimed a set of network tools was
// free over proof-of-work, and the stories were written as past events.
// `calls` = [slug, count]; `per` names the unit the total is for.
const USE_CASES = [
  {
    title: "Research 50 public companies overnight",
    story: "An analyst's agent walks 50 tickers, pulling filings, reported financials and live quotes for each, and leaves 50 structured summaries ready for review in the morning.",
    calls: [["edgar-filings", 50], ["edgar-company-facts", 50], ["stock-quote", 50], ["stock-history", 50]],
    per: "for 50 companies",
  },
  {
    title: "Check a domain's security posture",
    story: "A security team's agent reads a vendor's domain in one pass: DNS records, TLS certificate, WHOIS, HTTP headers, SPF and robots.txt.",
    calls: [["dns", 1], ["tls-cert", 1], ["whois", 1], ["http-check", 1], ["spf-check", 1], ["robots-check", 1]],
    per: "per domain",
  },
  {
    title: "Extract 200 PDF invoices to text",
    story: "A procurement agent converts 200 supplier invoices from PDF to markdown, then parses line items, totals and dates into structured JSON for reconciliation.",
    calls: [["pdf-to-markdown", 200]],
    per: "for 200 invoices",
  },
  {
    title: "Watch competitor pricing daily",
    story: "A pricing agent renders 20 JavaScript-heavy product pages every morning, extracts the price elements and logs changes to its wallet-keyed memory for trend analysis.",
    calls: [["render", 20], ["extract", 20], ["memory-write", 20]],
    per: "per day",
  },
  {
    title: "Build a macro dashboard from government data",
    story: "A research agent assembles a US economic snapshot: CPI year-over-year, unemployment, the Fed funds rate, the Treasury yield curve and FX rates, from official feeds, with no API keys.",
    calls: [["cpi-yoy", 1], ["unemployment-rate", 1], ["fed-funds", 1], ["treasury-yield-curve", 1], ["fx-dashboard", 1]],
    per: "per snapshot",
  },
  {
    title: "Answer customer questions with live web search",
    story: "A support agent searches the live web for product documentation, gets a cited synthesis from the answer tool and includes the source URLs in its reply.",
    calls: [["search", 1], ["answer", 1]],
    per: "per question",
  },
  {
    title: "Validate and geocode a 500-row address list",
    story: "An ops agent lints a CSV of customer addresses, geocodes each row to lat/lng and checks the contact emails, with no maps API key.",
    calls: [["csv-lint", 1], ["geocode", 500], ["email-validate", 500]],
    per: "for 500 rows",
  },
  {
    title: "Cross-check SEC insider trades against stock moves",
    story: "A compliance agent pulls recent insider trades from EDGAR, matches them against the stock's price history and flags trades that preceded large moves.",
    calls: [["edgar-insider-trades", 1], ["stock-history", 1], ["stock-quote", 1]],
    per: "per company",
  },
];

const priceNum = (def) => Number(String(def?.price ?? "").replace(/[^0-9.]/g, ""));
// Shortest exact form at the $0.001 grain: $0.01, $0.004, $0.033, $1.94.
const fmtUsd = (n) => { const s3 = n.toFixed(3); return `$${s3.endsWith("0") ? n.toFixed(2) : s3}`; };

/** The use case's cost from the catalog, or null when any of its tools is not
 *  served here (the line is then left out rather than guessed). */
export function useCaseCost(uc, catalog) {
  const bySlug = new Map(Object.values(catalog || {}).map((d) => [d?.slug, d]));
  let total = 0;
  const parts = [];
  for (const [slug, n] of uc.calls) {
    const p = priceNum(bySlug.get(slug));
    if (!(Number.isFinite(p) && p > 0)) return null;
    total += p * n;
    parts.push(`${n} \u00d7 ${slug} at ${fmtUsd(p)}`);
  }
  return `${fmtUsd(total)} ${uc.per} (${parts.join(" + ")})`;
}

export function useCasesPage(baseUrl, catalog = {}) {
  const canonical = `${baseUrl}/use-cases`;
  const pageTitle = "Use Cases - what agents build with Agent402";
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
    const cost = useCaseCost(uc, catalog);
    const toolLinks = uc.calls.map(([slug]) => slug)
      .map((slug) => `<a href="/tools/${esc(slug)}" class="uc-tool-link">${esc(slug)}</a>`)
      .join(", ");
    return `
      <div class="uc-card">
        <h3>${esc(uc.title)}</h3>
        <p class="uc-story">${esc(uc.story)}</p>
        <p class="uc-tools"><span class="uc-label">Tools used:</span> ${toolLinks}</p>
        ${cost ? `<p class="uc-cost"><span class="uc-label">Cost at list price:</span> <span class="uc-price">${esc(cost)}</span></p>` : ""}
      </div>`;
  }).join("\n");

  const extraCss = `
.uc-wrap{max-width:960px;margin:0 auto;padding:56px 30px}
.uc-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px}
.uc-h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px}
.uc-intro{max-width:760px;font-size:15px;line-height:1.55;color:var(--muted);margin:0 0 40px}
.uc-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px;margin-bottom:48px}
@media(max-width:740px){.uc-grid{grid-template-columns:1fr}.uc-h1{font-size:36px !important}}
.uc-card{background:var(--card);border:1px solid var(--hairline);padding:24px 26px}
.uc-card h3{margin:0 0 10px;font-family:var(--font-body);font-weight:800;font-size:20px;color:var(--ink)}
.uc-story{color:var(--muted);font-size:14px;line-height:1.55;margin:0 0 16px}
.uc-tools,.uc-cost{font-size:14px;margin:6px 0;color:var(--muted)}
.uc-label{color:var(--ink);font-weight:600}
.uc-price{color:var(--accent);font-family:var(--font-mono);font-weight:700}
.uc-tool-link{color:var(--accent);text-decoration:none;font-family:var(--font-mono);font-size:13px}
.uc-tool-link:hover{text-decoration:underline}
.uc-cta{text-align:center;margin:32px 0 48px}
.uc-cta a{color:var(--accent);font-family:var(--font-mono);font-weight:700;text-decoration:none;font-size:15px}
.uc-cta a:hover{text-decoration:underline}
`;

  const body = `
<div class="uc-wrap">
<div class="uc-eyebrow">$ GET /use-cases</div>
<h1 class="uc-h1">Use Cases</h1>
<p class="uc-intro">Example tasks an agent can run with Agent402, from overnight research to daily monitoring. Each one names the calls it makes and what they cost at today's per-call prices.</p>
<div class="uc-grid">
${cards}
</div>
<div class="uc-cta"><a href="/quickstart">Ready to build? Start with the quickstart guide &rarr;</a></div>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title: pageTitle, description: pageDesc, canonical, baseUrl, activePath: "/use-cases", jsonLd, extraCss, body });
}
