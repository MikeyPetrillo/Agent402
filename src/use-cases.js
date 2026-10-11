import { esc } from "./ledger-chrome.js";

// The Examples section of /docs (#examples; /use-cases answers a 301 to it).
// Example tasks, each with the calls it makes. The COST is computed from the
// live catalog at render time: every typed cost line on this page had drifted
// from the prices the paywall charges, one claimed a set of network tools was
// free over proof-of-work, and the stories were written as past events.
// `calls` = [slug, count]; `per` names the unit the total is for.
export const USE_CASES = [
  {
    title: "Research 50 public companies overnight",
    story: "An analyst's agent walks 50 tickers, pulling filings, reported financials, the latest close and price history for each, and leaves 50 structured summaries ready for review in the morning.",
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
    story: "A pricing agent reads 40 product pages every morning (render for the 20 JavaScript-heavy ones, extract for the 20 static ones, both returning markdown it scans for prices) and logs changes to its wallet-keyed memory for trend analysis.",
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
    story: "A support agent searches the live web for product documentation, gets a cited, model-written synthesis from the answer tool (model-backed) and includes the source URLs in its reply.",
    calls: [["search", 1], ["answer", 1]],
    per: "per question",
  },
  {
    title: "Validate an address list and geocode the new rows",
    story: "An ops agent lints a CSV of 500 customer rows, checks the contact emails and geocodes the 20 new addresses to lat/lng at one call a second, the open geocoder's pace, with no maps API key.",
    calls: [["csv-lint", 1], ["geocode", 20], ["email-validate", 500]],
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

/** JSON-LD for the #examples section: the tasks as an ItemList on /docs. */
export function examplesJsonLd(baseUrl) {
  const at = `${baseUrl}/docs`;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${at}#examples`,
    name: "Examples: tasks an agent runs with Agent402, priced from the live catalog",
    numberOfItems: USE_CASES.length,
    itemListElement: USE_CASES.map((uc, i) => ({ "@type": "ListItem", position: i + 1, name: uc.title, description: uc.story })),
  };
}

/** CSS for the #examples section (appended to the docs page's extraCss). */
export const EXAMPLES_SECTION_CSS = `
  #examples { scroll-margin-top: 110px; }
  .ex-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:0 0 44px; }
  @media (max-width:740px){ .ex-grid { grid-template-columns:minmax(0,1fr); } }
  .ex-card { background:var(--card);border:1px solid var(--hairline);padding:18px 20px; }
  .ml-docs-main .ex-card h3 { font-family:var(--font-body);font-weight:600;font-size:var(--fs-lg);line-height:1.3;margin:0 0 8px;color:var(--ink); }
  .ml-docs-main .ex-card p { font-size:var(--fs-md);line-height:1.55;color:var(--muted);margin:0 0 10px; }
  .ml-docs-main .ex-card p:last-child { margin-bottom:0; }
  .ex-label { color:var(--ink);font-weight:600; }
  .ex-price { color:var(--accent);font-family:var(--font-mono);font-size:var(--fs-sm);font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap; }
  .ex-parts { display:flex;flex-wrap:wrap;gap:2px 0;margin-top:2px;color:var(--faint);font-family:var(--font-mono);font-size:var(--fs-xs);font-variant-numeric:tabular-nums; }
  .ex-parts > span { white-space:nowrap; }
  .ex-parts > span + span::before { content:"+";padding:0 8px; }
  .ex-tool { color:var(--ink);font-family:var(--font-mono);font-size:var(--fs-sm);white-space:nowrap; }`;

// "$0.42 per day (20 x render at $0.01 + ...)": the total in the accent, the
// breakdown quieter under it, one term per item so a term never breaks inside.
function costHtml(cost) {
  const i = cost.indexOf(" (");
  if (i < 0) return `<span class="ex-price">${esc(cost)}</span>`;
  const terms = cost.slice(i + 2).replace(/\)\s*$/, "").split(" + ");
  return `<span class="ex-price">${esc(cost.slice(0, i))}</span> <span class="ex-parts">${terms.map((t) => `<span>${esc(t)}</span>`).join("")}</span>`;
}

/** The Examples section of /docs: each task, the tools it calls and its cost
 * at today's list prices, computed from the catalog it is given. */
export function examplesSectionHtml(catalog = {}) {
  const cards = USE_CASES.map((uc) => {
    const cost = useCaseCost(uc, catalog);
    const tools = uc.calls.map(([slug]) => `<a href="/tools/${esc(slug)}" class="ex-tool">${esc(slug)}</a>`).join(", ");
    return `
        <div class="ex-card">
          <h3>${esc(uc.title)}</h3>
          <p>${esc(uc.story)}</p>
          <p><span class="ex-label">Tools:</span> ${tools}</p>
          ${cost ? `<p><span class="ex-label">Cost at list price:</span> ${costHtml(cost)}</p>` : ""}
        </div>`;
  }).join("");
  return `<!-- EXAMPLES -->
      <section>
      <h2 id="examples" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-2xl);letter-spacing:-.02em;margin:0 0 10px;">Examples.</h2>
      <p style="font-size:var(--fs-base);line-height:1.55;color:var(--muted);max-width:640px;margin:0 0 18px;">Tasks an agent can run here, from overnight research to daily monitoring. Each one names the calls it makes and what they cost at today's per-call prices, read from the live catalog.</p>
      <div class="ex-grid">${cards}
      </div>
      </section>
`;
}
