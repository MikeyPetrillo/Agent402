// /agentic-finance - the category page. "Agentic Finance (AIFI)" is the
// moniker Agent402 positions itself under: software agents that discover,
// price, pay for and get paid for services on their own, over open payment
// protocols (x402, MPP), with a wallet as the identity. This page DEFINES the
// term (DefinedTerm + Article + FAQPage JSON-LD, the same structured-data
// pattern the homepage and the what-is pages already carry) and places
// Agent402 as its applied layer, with every claim linked to a live surface.
// Same design system as what-is-mpp.js. No live counts baked into copy:
// evergreen "500+" only, per the project rule.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { routingProofSentence } from "./routing-proof.js";
import { resolveRailCountTokens } from "./rails.js";

import { ORG_SAME_AS } from "./repo-link.js";
// The one-sentence definition: the visible lede and the DefinedTerm description.
const DEFINITION = "Agentic Finance (AIFI) is software agents paying and getting paid on their own: per request, from a non-custodial wallet, over the open protocols x402 and MPP, with a verifiable receipt for each call.";

// The stack, the agentic payments / commerce distinction and what one purchase
// looks like on the wire live in the long-form post and the glossary; this page
// links them instead of retelling them.
const FAQS = [
  { q: "Do agents need crypto to take part?", a: "To pay, an agent needs a wallet holding a stablecoin (USDC, or USDG on Robinhood Chain, or USDC.e or PathUSD on Tempo) on a supported chain; gas is sponsored on the EVM rails, so no native token is required. Pure-CPU tools are also payable with a proof-of-work solve instead of money." },
  { q: "Is it live today?", a: "Yes. Agent402 settles on {{railCount}} x402 chains plus Tempo over MPP, and a daily canary buys real tools over both wires. Every figure on the revenue page links to its on-chain proof." },
];

// Where Agent402 sits: one row per thing a reader can do, each with its page.
const ROLES = [
  ["Buy tools", "500+ tools an agent pays for per call over x402 or MPP; the model-backed ones are marked as such.", [["/tools", "browse the catalog"]]],
  ["Buy reports", "Research, due-diligence and filing reports built from live data and cited to their sources.", [["/reports", "see the reports"]]],
  ["Route", `An open cross-seller index and a Smart Order Router that buys the result from the best seller and sells it to the agent. ${"{{routingProof}}"}`, [["/marketplace", "open the index"], ["/guides/smart-order-router", "how routing works"]]],
  ["Sell", "Put a price on your API or site with the open-source tollbooth; agents pay per request over both wires while people browse free.", [["/sell", "sell your API"]]],
  ["Prove", "Settlements by rail and wire, the on-chain seller leaderboard and uptime measured from outside, each figure linked to its proof.", [["/revenue", "revenue"], ["/status", "status"]]],
];

export function agenticFinancePage(baseUrl) {
  // Rail counts resolve from the live offer at render (src/rails.js).
  const faqs = FAQS.map((f) => ({ ...f, a: resolveRailCountTokens(f.a) }));
  const roles = ROLES.map(([h, p, links]) => [h, p.replace("{{routingProof}}", routingProofSentence()), links]);
  const canonical = `${baseUrl}/agentic-finance`;
  const title = "What is Agentic Finance (AIFI)? Agents that pay and get paid";
  const description =
    "Agentic Finance (AIFI) is software agents paying and getting paid on their own, per request, over the open protocols x402 and MPP. The definition and where Agent402 fits: tools, reports, routing, selling and on-chain proof.";

  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", url: baseUrl, logo: { "@type": "ImageObject", url: `${baseUrl}/logo.png` }, sameAs: ORG_SAME_AS, knowsAbout: ["Agentic Finance", "AIFI", "x402", "Machine Payments Protocol", "MPP", "agentic payments", "AI agents"] };
  const termLd = { "@type": "DefinedTerm", "@id": `${canonical}#term`, name: "Agentic Finance", alternateName: "AIFI", description: DEFINITION, url: canonical, inDefinedTermSet: { "@type": "DefinedTermSet", "@id": `${baseUrl}/glossary#set`, name: "Agentic Finance (AIFI) glossary", url: `${baseUrl}/glossary` } };
  const breadcrumbLd = { "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "Agentic Finance (AIFI)", item: canonical },
  ] };
  const articleLd = { "@type": "Article", "@id": `${canonical}#article`, headline: title, description, about: { "@id": `${canonical}#term` }, publisher: { "@id": `${baseUrl}/#organization` }, author: { "@id": `${baseUrl}/#organization` }, mainEntityOfPage: canonical, keywords: "agentic finance, AIFI, agentic payments, x402, MPP, machine payments protocol, AI agents, pay-per-call, machine-to-machine payments" };
  const faqLd = { "@type": "FAQPage", "@id": `${canonical}#faq`, mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) };

  const extraCss = `
@media (max-width:900px){.af-row{grid-template-columns:minmax(0,1fr)!important;gap:6px!important}}
`;
  const link = (href, label) => `<a href="${href}" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">${esc(label)}</a>`;
  const rolesHtml = roles.map(([h, p, links]) =>
    `<div class="af-row" style="display:grid;grid-template-columns:200px minmax(0,1fr);gap:24px;padding:20px 0;border-bottom:1px solid var(--hairline);align-items:baseline;"><h3 style="font-weight:600;font-size:var(--fs-lg);margin:0;color:var(--ink);">${esc(h)}</h3><p class="ml-measure" style="font-size:var(--fs-base);line-height:1.6;color:var(--muted);margin:0;">${esc(p)} ${links.map(([href, label]) => link(href, label)).join(" · ")}</p></div>`
  ).join("");
  const faqHtml = faqs.map((f) =>
    `<article style="padding:22px 0;border-bottom:1px solid var(--hairline);"><h3 style="font-weight:600;font-size:var(--fs-lg);margin:0 0 10px;color:var(--ink);">${esc(f.q)}</h3><p class="ml-measure" style="font-size:var(--fs-base);line-height:1.65;color:var(--muted);margin:0;">${esc(f.a)}</p></article>`
  ).join("");

  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin-bottom:22px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">agentic finance (aifi)</span>
    </nav>
    <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.94;margin:0 0 24px;color:var(--ink);">Agentic Finance <span style="color:var(--accent);">(AIFI)</span></h1>
    <p id="definition" class="ml-measure" style="font-size:var(--fs-lg);line-height:1.5;color:var(--muted);margin:0 0 16px;">${esc(DEFINITION)}</p>
    <p class="ml-measure" style="font-size:var(--fs-base);line-height:1.6;color:var(--muted);margin:0;">The long form, with the stack and one purchase traced on the wire, is ${link("/blog/what-is-agentic-finance-aifi#stack", "the AIFI post")}. Every term is defined once in ${link("/glossary", "the glossary")}, and ${link("/101", "x402 and MPP 101")} starts from zero.</p>
  </div>
</header>

<section id="agent402" style="max-width:1180px;margin:0 auto;padding:56px 30px 0;">
  <h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--ink);">Where Agent402 sits</h2>
  <div style="border-top:1px solid var(--hairline);">${rolesHtml}</div>
</section>

<section id="faq" style="max-width:1180px;margin:0 auto;padding:56px 30px 0;">
  <h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--ink);">Questions</h2>
  <div style="max-width:900px;border-top:1px solid var(--hairline);">${faqHtml}</div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:56px 30px 56px;">
  <div class="ml-cta-panel" style="background:var(--panel);border:1px solid var(--hairline);padding:44px;">
    <h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0 0 24px;color:var(--on-panel);">Give your agent 500+ tools</h2>
    <a class="btn btn-primary on-panel" href="/docs#add">Add to your agent →</a>
  </div>
</section>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title, description, canonical, baseUrl, activePath: "/what-is-x402", extraCss,
    ogImage: `${baseUrl}/og/agentic-finance.png`,
    jsonLd: [orgLd, termLd, breadcrumbLd, articleLd, faqLd],
    body,
  });
}
