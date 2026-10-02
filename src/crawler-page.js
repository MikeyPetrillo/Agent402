// /crawler - what our index collects, how, and how to be removed from it.
//
// This page exists for three audiences and answers all of them in one place:
// an operator who sees our User-Agent in their logs and wants to know who we
// are; a seller who wants out; and anyone assessing whether the published
// index is assembled responsibly.
//
// It is also the answer to the question a data buyer asks in due diligence -
// what is collected, how, under what basis, and what is deliberately excluded.
// Writing it down once, publicly, is worth more than a paragraph produced on
// request, because an operator can check every claim against what our crawler
// actually did to them.
//
// Every sentence must name behaviour that exists in this repository. If a
// control here stops being true, change the control or change the page.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { ROUTER_UA } from "./x402-buyer.js";
import { unpaidQuoteBudgetPerHour } from "./unpaid-quote-budget.js";

export const CRAWLER_UA = "Mozilla/5.0 (compatible; Agent402/1.0; +https://agent402.tools/crawler)";

const SECTIONS = [
  {
    h: "What the crawler reads",
    p: [
      `Agent402 publishes an index of services that advertise machine payments over x402 or MPP. To build it we read the discovery documents a service publishes for exactly this purpose: <code>/.well-known/x402</code>, <code>/openapi.json</code>, <code>/llms.txt</code>, and the HTTP 402 challenge a paid route returns to an unpaid request.`,
      `That is all. We do not log in, we do not submit forms, we do not read anything behind a paywall, and we do not pay to see more. A 402 challenge is a public advertisement of price and payment rails - answering one with no credential is the ordinary way to read it.`,
    ],
  },
  {
    h: "How it behaves",
    p: [
      `The crawler identifies itself on every request as <code>${esc(CRAWLER_UA)}</code>, so it can be recognised, rate-limited or blocked by name.`,
      `It honours <code>robots.txt</code>, including for the discovery paths above. It re-reads an origin about every thirty minutes, backs off on errors, sends conditional requests so an unchanged document costs a single 304, and caps what it will read from any one response.`,
      `If our crawler is causing you a problem, a <code>Disallow</code> for that User-Agent stops it and needs no message from us. Email works too.`,
    ],
    links: [["/robots.txt", "Our own robots.txt"], ["mailto:mike@agent402.tools", "mike@agent402.tools"]],
  },
  {
    h: "The other thing that visits you",
    p: [
      `A crawl and a purchase are different acts and this page is linked from both, so it should say so. When our router buys from a service on a caller's behalf it sends a real HTTP 402 payment, which is not a crawl: it is a customer.`,
      `Those requests identify themselves as <code>${esc(ROUTER_UA)}</code> and carry <code>X-Agent402-Via: router</code>. Either one separates a purchase from a probe in your logs. Until 2026-09-21 they carried neither and arrived as <code>node</code>, which we fixed when a seller pointed out they could not tell our traffic apart.`,
      `<code>robots.txt</code> does not govern these. A purchase is a request for a service you advertised a price for, and declining one is a matter for your own endpoint, not for a crawl directive. If you would rather we did not buy from you at all, say so and we will stop.`,
    ],
  },
  {
    h: "Getting removed",
    p: [
      `Email <a href="mailto:mike@agent402.tools">mike@agent402.tools</a> from an address at the domain, or open an issue, and we will remove the origin from the index and stop crawling it. We do not require a reason and we do not argue about it.`,
      `Blocking the User-Agent in <code>robots.txt</code> has the same effect and takes immediate effect on the next cycle without waiting for us.`,
    ],
  },
  {
    h: "What we publish, and what we do not",
    p: [
      `The public index carries what a service advertises about itself: its endpoints, the prices and payment networks it declares, whether our own probe could reach it, and the payout addresses it names in its own challenges. Payout addresses are public infrastructure - they appear in every challenge the service hands to every buyer.`,
      `We publish counts of settled payments per payee, read from public chains. We never publish who paid: buyer figures are counts only, and no roster of payers leaves our systems. That rule is enforced in code, not by convention.`,
      `Measurements made by third parties are not redistributed. Where our pages display someone else's figures we label them as theirs, and they are excluded by name from any dataset we distribute.`,
    ],
    links: [["/api/index", "The index, free and unauthenticated"], ["/marketplace", "How it is rendered"]],
  },
  {
    h: "Corrections",
    p: [
      `If a row about your service is wrong, tell us and we will fix it. Several improvements to how prices are read came from operators who checked their own row and found it stale - that feedback loop is the main reason the index is accurate, and it is why the index is free to read.`,
    ],
  },
];

// The other direction: crawlers reading OUR catalog. The budget figure is the
// one the gate reads (src/unpaid-quote-budget.js, passed in by server.js), so
// the page cannot quote a number the server does not enforce; 0 means no
// budget is enforced here (FREE_MODE, or UNPAID_QUOTE_BUDGET_PER_HOUR=off).
export const CATALOG_CRAWL_ANCHOR = "crawling-this-catalog";
export function catalogCrawlSection(budget) {
  const n = Number(budget) || 0;
  return {
    h: "Crawling this catalog",
    id: CATALOG_CRAWL_ANCHOR,
    p: [
      `If you index this catalog, three documents carry every route and its price: <code>/.well-known/x402</code>, <code>/openapi.json</code> and <code>/api/pricing</code>. Read those rather than requesting each priced route to learn what it costs. <code>/openapi.json</code> is served with an ETag, so a repeat read that sends <code>If-None-Match</code> is a 304 with no body.`,
      `Listed prices change when we ship a release, not from one request to the next, so a full walk of every priced route more than a few times an hour is not needed.`,
      n > 0
        ? `Unpaid requests to priced routes are budgeted per client, meaning one address and one User-Agent product token. Past ${esc(n.toLocaleString("en-US"))} in an hour, the answer is a 429 with a <code>Retry-After</code> header that counts down to the top of the hour. A request that carries a payment, a credits key or a proof-of-work solution is never counted, and neither are the three documents above, <code>/mcp</code> or any page. Every purchase opens with one bare request, so buying is exempt from the first settlement onward: once a client settles a payment, nothing it sends is counted for the rest of that hour.`
        : `This server sets no hourly budget on unpaid requests to priced routes.`,
      `Named indexers, search engines and AI crawlers are not budgeted. If your index needs more than this and we do not recognize it by name, email <a href="mailto:mike@agent402.tools">mike@agent402.tools</a> with the User-Agent it sends and we will add it to the named list.`,
    ],
    links: [["/.well-known/x402", "The x402 manifest"], ["/openapi.json", "The OpenAPI document"], ["/api/pricing", "The price list"]],
  };
}

export function crawlerPage(baseUrl, { unpaidQuoteBudget = unpaidQuoteBudgetPerHour() } = {}) {
  const canonical = `${baseUrl}/crawler`;
  const title = "Our crawler";
  const description = "What the Agent402 index reads, how the crawler behaves, how to have a service removed, how to crawl this catalog, and what we publish about payers (counts only, never a roster).";
  const sections = [...SECTIONS, catalogCrawlSection(unpaidQuoteBudget)];
  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:22px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">crawler</span></nav>
    <h1 style="font-weight:800;font-size:46px;line-height:.98;letter-spacing:-.035em;margin:0 0 18px;color:var(--ink);max-width:900px;">Our crawler.</h1>
    <p style="font-size:18px;line-height:1.55;color:var(--muted);max-width:820px;margin:0;">Who we are, what we read, and how to be removed. If you found this page from a User-Agent in your logs, that was us.</p>
  </div>
</header>
${sections.map((s) => `
<section${s.id ? ` id="${esc(s.id)}"` : ""} style="max-width:1180px;margin:0 auto;padding:40px 30px 0;">
  <div style="display:grid;grid-template-columns:220px 1fr;gap:30px;padding-bottom:36px;border-bottom:1px solid var(--hairline);" class="sec-2col">
    <h2 style="font-family:var(--font-mono);font-size:13px;color:var(--accent);font-weight:600;margin:4px 0 0;">${esc(s.h)}</h2>
    <div>
      ${s.p.map((p) => `<p style="font-size:16px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 14px;">${p}</p>`).join("")}
      ${(s.links || []).length ? `<div style="display:flex;gap:18px;flex-wrap:wrap;">${s.links.map(([href, label]) => `<a href="${esc(href)}" style="font-family:var(--font-mono);font-size:13px;color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">${esc(label)} \u2192</a>`).join("")}</div>` : ""}
    </div>
  </div>
</section>`).join("")}
${ledgerFooterCompact()}`;
  const extraCss = `@media (max-width:900px){.sec-2col{grid-template-columns:minmax(0,1fr)!important}}`;
  const jsonLd = [
    { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` }, { "@type": "ListItem", position: 2, name: "Crawler", item: canonical }] },
    { "@type": "WebPage", "@id": canonical, name: title, description, publisher: { "@type": "Organization", name: "Havok Holdings LLC", url: "https://havok.holdings" } },
  ];
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/crawler", extraCss, jsonLd, body });
}
