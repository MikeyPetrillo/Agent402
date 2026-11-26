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
import { siteOrgRef } from "./site-org.js";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { NAMED_CLIENT_BUDGET_MULTIPLIER, unpaidQuoteBudgetPerHour } from "./unpaid-quote-budget.js";
import { CRAWLER_UA, PROBE_UA, ROUTER_UA, FETCH_UA, FETCH_TOKEN, BROWSER_FETCH_UA, SITE_CRAWL_UA, SITE_CRAWL_TOKEN, CRAWLER_TOKEN, RETIRED_BARE_UA, SUGGEST_UA } from "./user-agents.js";
import { ROBOTS_CACHE_MS, ROBOTS_UNREADABLE_CACHE_MS, ROBOTS_BRAND_TOKEN, ROBOTS_UNGATED_READS } from "./tools/robots-gate.js";
import { IDEM_TTL_MS } from "./idempotency-store.js";
import { taskRetentionPublic } from "./mcp-tasks.js";
import { crawlIntervalLabel, slowOriginIntervalLabel, spanLabel, LIVE_QUOTE_MAX_AGE_MS, QUOTE_REFUSED_BACKOFF_MS, QUOTE_REFUSED_BACKOFF_MAX_MS } from "./crawl-cadence.js";
import { REVISIT_CAP_MS, REVISIT_HINT_FIELD, DAILY_BUDGET, REGISTRATION_HOURLY_MAX, REGISTRATION_HOST_HOURLY_MAX, REGISTRATION_PACE_MS, THROTTLE_DEFAULT_MS, THROTTLE_MAX_MS, REQUEST_LOG_KEEP_MS, probeShareLabel } from "./seller-load.js";

// The strings each component sends come from one list (src/user-agents.js),
// so the page cannot quote a User-Agent we do not use.
export { CRAWLER_UA };
// The product token robots.txt rules are matched on (ROBOTS_UA in
// src/x402-index.js; scripts/test-crawler-page.js pins the two together).
export const ROBOTS_TOKEN = CRAWLER_TOKEN;
// A robots group for the shorter token still applies to the crawler.
export const ROBOTS_LEGACY_TOKEN = "Agent402";

// Every span on this page is printed from the constant the code runs on
// (scripts/test-crawler-page.js fails on a figure typed into the prose).
const span = spanLabel;
// The revisit hint's worked example on the page, in seconds.
const HINT_EXAMPLE_SECONDS = 21600;

// What the crawler reads and how robots.txt applies to each read, written from
// src/x402-index.js (probePath, robotsForbids, enrichLiveQuotes, probePaywall,
// verifySuccessionMarkers) and src/mpp-index.js. scripts/test-crawler-page.js
// drives the real crawl against a stub origin and checks this page's claims.
const SECTIONS = [
  {
    h: "What the crawler reads",
    p: [
      `Agent402 publishes an index of services that advertise machine payments over x402 or MPP. For each x402 origin in it, the crawler reads <code>/robots.txt</code>, the x402 manifest at <code>/.well-known/x402</code>, and <code>/openapi.json</code> to name and describe the routes. When an origin publishes no manifest, it also tries <code>/agents.json</code> and then <code>/llms.txt</code>, two other places a service may list its paid routes.`,
      `It sends an unpaid request to paid routes the index lists, to read the price and payment networks in their 402 challenge. A route already read is asked again after ${esc(span(LIVE_QUOTE_MAX_AGE_MS))}, sooner only when the price your own documents state for it moves far from the one it quoted, or when you register again at <a href="/sell">/sell</a>. This request skips a route your own documents mark free. A <code>POST</code> goes only to a route your documents mark paid (a price, payment terms, a paid annotation, or a listing in <code>/.well-known/x402</code>), and carries one body at most: after an answer other than a 402, no second body is sent. A route that answers the request itself without a 402 (a success, or a refusal of its own such as a 400 or a 429) is not asked again for ${esc(span(QUOTE_REFUSED_BACKOFF_MS))}, and each further such answer doubles the wait, up to ${esc(span(QUOTE_REFUSED_BACKOFF_MAX_MS))}; registering again lifts the wait. A server error or a redirect starts no such wait. The check that a site's paid routes still ask for payment uses its cheapest paid route, and runs at most once in ${esc(span(LIVE_QUOTE_MAX_AGE_MS))} for a site whose paid routes are all priced above what our router buys, or sooner when you register again.`,
      `When one origin claims to have moved from another, it reads <code>/.well-known/agent402-succession</code> on both to confirm the claim. For the MPP index, it reads a registered server's <code>/openapi.json</code> and confirms the <code>WWW-Authenticate: Payment</code> challenge of one paid endpoint with a single unpaid request.`,
      `We do not log in, submit forms, or pay to see more. A 402 challenge is a public advertisement of price and payment rails, and asking for one with no credential is the ordinary way to read it.`,
    ],
  },
  {
    h: "Our User-Agents",
    p: [
      `Each part of our service that sends requests to your host names itself with its own User-Agent, so you can tell them apart in your logs and rate-limit or block one without the others:`,
      `<code>${esc(CRAWLER_UA)}</code>: the index crawler, reading the discovery documents listed above.`,
      `<code>${esc(PROBE_UA)}</code>: the unpaid request to a paid route that reads its price and payment networks from the 402 challenge, and checks that the route still asks for payment.`,
      `<code>${esc(ROUTER_UA)}</code>: our router buying from you for a paying caller, including the one unpaid request that opens each purchase. It also carries <code>X-Agent402-Via: router</code>.`,
      `<code>${esc(FETCH_UA)}</code>: a tool in our catalog fetching a URL its caller named, one request for one caller.`,
      `<code>${esc(BROWSER_FETCH_UA)}</code>: the same, for a tool that loads the page in a headless browser (render, screenshot, page speed): a browser's own string with the ${esc(FETCH_TOKEN)} token added, so the page renders as it does for a visitor (the page-speed tool's mobile measurement sends the mobile browser string with the same token).`,
      `<code>${esc(SITE_CRAWL_UA)}</code>: the multi-page site-crawl tool, run for one caller and limited to a few pages.`,
      `<code>${esc(SUGGEST_UA)}</code>: the search-suggest tool reading Wikipedia's title suggestions for one caller, one request at a time; it reads no other host.`,
      `No request to a site in our index, or to a URL a caller names, carries the older <code>${esc(RETIRED_BARE_UA)}</code> token; it remains only on the requests some catalog tools make to the fixed data APIs they are built on.`,
      `A User-Agent is text anyone can copy, so a request carrying one of these strings at a volume or cadence this page does not describe may not be ours. We keep a count of the requests each of these components sends each host, per minute, for ${esc(span(REQUEST_LOG_KEEP_MS))}: email us the host and the timestamps from that window and we will check them against it.`,
    ],
  },
  {
    h: "How it behaves",
    p: [
      `The crawler identifies itself on every document read as <code>${esc(CRAWLER_UA)}</code> and on every unpaid price check as <code>${esc(PROBE_UA)}</code>, so it can be recognized, rate-limited or blocked by name. robots.txt rules are matched on the product token <code>${esc(ROBOTS_TOKEN)}</code>, and a group written for <code>${esc(ROBOTS_LEGACY_TOKEN)}</code> applies too: the rules of every group that names either are combined, and the longest rule that matches a path decides it (RFC 9309), so a longer <code>Allow</code> in one group admits a path a shorter <code>Disallow</code> in another covers.`,
      `It honors <code>robots.txt</code>, with these exceptions. The x402 manifest at <code>/.well-known/x402</code> is read whatever robots.txt says: it is a protocol endpoint published to be fetched by payment clients. Once an origin publishes that manifest, <code>/openapi.json</code> is read under a rule written for every crawler (<code>User-agent: *</code>); a rule that names ${esc(ROBOTS_TOKEN)} still stops it. The unpaid request to a paid route, and the MPP index's two reads, are not robots-gated: they read the price a route quotes to every caller. <code>/agents.json</code> and <code>/llms.txt</code> always follow robots.txt, and a robots.txt we cannot fetch or parse does not block the crawl.`,
      `It re-reads an origin ${esc(crawlIntervalLabel())}, backs off on errors, sends conditional requests so an unchanged document costs a single 304, and caps what it will read from any one response.`,
      REVISIT_CAP_MS > 0
        ? `When your manifest and <code>/openapi.json</code> come back unchanged (a 304, or the same bytes as last time), the wait before the next read doubles each time, up to ${esc(span(REVISIT_CAP_MS))}. A changed document, a purchase from you that did not deliver, or registering again at <a href="/sell">/sell</a> puts the origin back on the regular cycle.`
        : `Every origin is read on the regular cycle.`,
      ...(REVISIT_CAP_MS > 0
        ? [`To set your own pace, add a top-level <code>"${esc(REVISIT_HINT_FIELD)}"</code> to your manifest at <code>/.well-known/x402</code>: a number of seconds to wait between reads, for example <code>"${esc(REVISIT_HINT_FIELD)}": ${HINT_EXAMPLE_SECONDS}</code> for ${esc(span(HINT_EXAMPLE_SECONDS * 1000))}. Each read then waits at least that long, up to ${esc(span(REVISIT_CAP_MS))}. It only ever lengthens our wait: a value shorter than our current wait changes nothing. A purchase from you that did not deliver, or registering again at <a href="/sell">/sell</a>, still brings the next read forward.`]
        : []),
      DAILY_BUDGET > 0
        ? `The crawler, the unpaid price checks and the MPP index's scheduled reads together keep to about ${esc(DAILY_BUDGET.toLocaleString("en-US"))} requests a day to one site on its own account (a crawl already under way finishes its reads), counted per registrable domain, or per hostname on shared hosting such as a platform subdomain or a cloud API host. The unpaid price checks take at most ${esc(probeShareLabel())} of that, so the document reads always have the rest. Past it, they wait for the next day (UTC). The reads a registration of the site asks for are counted apart and never use that allowance, so a registration someone else makes never holds back the site's own crawl${REGISTRATION_HOURLY_MAX > 0 ? `, and one caller's registrations send one site at most ${esc(String(REGISTRATION_HOURLY_MAX))} document reads and paywall checks an hour, however many of them name it` : ""}${REGISTRATION_HOST_HOURLY_MAX > 0 ? `. Past ${esc(String(REGISTRATION_HOST_HOURLY_MAX))} such reads of one site in an hour from every caller together, the rest are sent one every ${esc(String(REGISTRATION_PACE_MS / 1000))} seconds` : ""}. A name under a wildcard or dynamic DNS service is counted on its own allowance, like a site on any other shared hosting, whatever address it points at. A site whose documents moved to another site is counted on its own allowance. Every request that follows such a move to the other site, a document read or a price check, is held to ${esc(DAILY_BUDGET.toLocaleString("en-US"))} more a day there, apart from that site's own allowance: past it those requests are not sent until the next day, and the moved site's listing stays as it was. The router's request before a purchase for a paying caller is counted on its own, so buyers never use up that allowance, and purchases always go through.`
        : `This deployment sets no daily request budget per site.`,
      `A <code>429</code> or <code>503</code> answer pauses the crawl, the unpaid price checks and the MPP index's reads for that host until its <code>Retry-After</code>, or for ${esc(span(THROTTLE_DEFAULT_MS))} when it names no time, and never longer than ${esc(span(THROTTLE_MAX_MS))}. Your listing stays as it was while we wait.`,
      `To be read less often, email us the origin and we will move it to a slower cycle (${esc(slowOriginIntervalLabel())}) in both indexes; your listing and purchases for paying callers continue as before. If our crawler is causing you a problem, email us and we will stop it. A <code>Disallow</code> for ${esc(ROBOTS_TOKEN)} stops every read above except the manifest and the unpaid price check, and needs no message from us.`,
    ],
    links: [["/robots.txt", "Our own robots.txt"], ["mailto:help@agent402.tools", "help@agent402.tools"]],
  },
  {
    h: "Tool fetches for callers",
    p: [
      `Some tools in our catalog fetch a URL that a caller names: reading an article, a PDF, an image, an audio file or a feed, or checking a page's headers or metadata. Those requests send <code>${esc(FETCH_UA)}</code>, and the tools that load the page in a headless browser send <code>${esc(BROWSER_FETCH_UA)}</code>. Each is one request made for one caller, not a crawl.`,
      `Apart from the reads named next, a tool that returns a page's content, or something read from it (its text, markup, a screenshot, a PDF, image, audio file or feed, a page-speed measurement), first reads that site's <code>/robots.txt</code> and follows the rules for the token <code>${esc(FETCH_TOKEN)}</code>. A group written for <code>${esc(ROBOTS_BRAND_TOKEN)}</code> applies too; with no group for either, the rules for every crawler (<code>User-agent: *</code>) apply. A group is matched on its exact name, so a group for a product whose name is only part of ours does not apply. A path those rules disallow is not fetched: the call answers <code>403</code> with the rule that decided it. The rules read from a site are kept for ${esc(span(ROBOTS_CACHE_MS))}, and a robots.txt we cannot fetch or parse does not block the read (that outcome is kept for ${esc(span(ROBOTS_UNREADABLE_CACHE_MS))}).`,
      `The tools that read only a status or metadata are not robots-gated: ${esc(ROBOTS_UNGATED_READS)}.`,
      `The site-crawl and site-map tools send <code>${esc(SITE_CRAWL_UA)}</code> and follow the rules for the token <code>${esc(SITE_CRAWL_TOKEN)}</code>, which a rule naming ${esc(ROBOTS_LEGACY_TOKEN)} also matches: site-crawl on every page it reads, site-map on the start page it reads before the site's sitemaps.`,
      `A fetched page is returned to the caller and not stored. A paid answer is kept for ${esc(span(IDEM_TTL_MS))} so that the same payment sent again gets the same answer, and the result of a call run as an async job or an MCP task is kept for ${esc(taskRetentionPublic().keptFor)} so the caller can fetch it.`,
    ],
  },
  {
    h: "Router purchases",
    p: [
      `A crawl and a purchase are different acts and this page is linked from both, so it should say so. When our router buys from a service to resell the result to a caller it sends a real HTTP 402 payment, which is not a crawl: it is a customer.`,
      `Those requests identify themselves as <code>${esc(ROUTER_UA)}</code> and carry <code>X-Agent402-Via: router</code>. Either one separates a purchase from a probe in your logs.`,
      `<code>robots.txt</code> does not govern these. A purchase is a request for a service you advertised a price for, and declining one is a matter for your own endpoint, not for a crawl directive. If you would rather we did not buy from you at all, say so and we will stop.`,
    ],
  },
  {
    h: "Getting removed",
    p: [
      `Email <a href="mailto:help@agent402.tools">help@agent402.tools</a> from an address at the domain, or open an issue, and we will remove the origin from the index and stop crawling it. We do not require a reason and we do not argue about it.`,
      `A robots.txt rule limits what the crawler reads from the next cycle on, but it does not remove a listing: the row stays with what we last read. To be removed, email us.`,
    ],
  },
  {
    h: "What we publish",
    p: [
      `The public index carries what a service advertises about itself: its endpoints, the prices and payment networks it declares, whether our own probe could reach it, and the payout addresses it names in its own challenges. Payout addresses are public infrastructure - they appear in every challenge the service hands to every buyer.`,
      `We publish counts of settled payments per payee, read from public chains, and buyer figures in the index are counts. Payments on public chains are public: some of our pages show individual payments as the chain records them, for example the live view on our home page, which shows shortened payer addresses with links to the public transactions. We do not sell payer data.`,
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
        ? `Unpaid requests to priced routes are budgeted per client address, whatever the User-Agent (an IPv6 /64 counts as one address; on the one address Cloudflare Workers share, each User-Agent gets its own budget under a ceiling for the address). Past ${esc(n.toLocaleString("en-US"))} in an hour, the answer is a 429 with a <code>Retry-After</code> header that counts down to the top of the hour. A request that carries a payment, a credits key or a proof-of-work solution is never counted, and neither are the three documents above, <code>/mcp</code> or any page. Every purchase opens with one bare request, so buying is exempt from the first settlement onward: once a client settles a payment, nothing it sends is counted for the rest of that hour.`
        : `This server sets no hourly budget on unpaid requests to priced routes.`,
      n > 0
        ? `Named indexers, search engines and AI crawlers read against ${esc((n * NAMED_CLIENT_BUDGET_MULTIPLIER).toLocaleString("en-US"))} unpaid requests per address in an hour, on the same count as everything else from that address. If your index needs more than this, or we do not recognize it by name, email <a href="mailto:help@agent402.tools">help@agent402.tools</a> with the User-Agent it sends and the addresses it reads from.`
        : `If your index needs anything from us, email <a href="mailto:help@agent402.tools">help@agent402.tools</a> with the User-Agent it sends.`,
    ],
    links: [["/.well-known/x402", "The x402 manifest"], ["/openapi.json", "The OpenAPI document"], ["/api/pricing", "The price list"]],
  };
}

export function crawlerPage(baseUrl, { unpaidQuoteBudget = unpaidQuoteBudgetPerHour() } = {}) {
  const canonical = `${baseUrl}/crawler`;
  const title = "Agent402 crawler: what our index reads and how to crawl this catalog";
  const description = "What the Agent402 index reads, how the crawler behaves, how to have a service removed, how to crawl this catalog, and what we publish about payers.";
  const sections = [...SECTIONS, catalogCrawlSection(unpaidQuoteBudget)];
  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin-bottom:22px;"><a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">crawler</span></nav>
    <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:.98;margin:0 0 18px;color:var(--ink);max-width:900px;">Our crawler.</h1>
    <p style="font-size:var(--fs-lg);line-height:1.55;color:var(--muted);max-width:820px;margin:0;">Who we are, what we read, and how to be removed. If you found this page from a User-Agent in your logs, that was us.</p>
  </div>
</header>
${sections.map((s) => `
<section${s.id ? ` id="${esc(s.id)}"` : ""} style="max-width:1180px;margin:0 auto;padding:40px 30px 0;">
  <div style="display:grid;grid-template-columns:220px 1fr;gap:30px;padding-bottom:36px;border-bottom:1px solid var(--hairline);" class="sec-2col">
    <h2 style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);font-weight:700;margin:4px 0 0;">${esc(s.h)}</h2>
    <div>
      ${s.p.map((p) => `<p style="font-size:var(--fs-lg);line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 14px;">${p}</p>`).join("")}
      ${(s.links || []).length ? `<div style="display:flex;gap:18px;flex-wrap:wrap;">${s.links.map(([href, label]) => `<a href="${esc(href)}" style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">${esc(label)} \u2192</a>`).join("")}</div>` : ""}
    </div>
  </div>
</section>`).join("")}
${ledgerFooterCompact()}`;
  const extraCss = `@media (max-width:900px){.sec-2col{grid-template-columns:minmax(0,1fr)!important}}`;
  const jsonLd = [
    { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` }, { "@type": "ListItem", position: 2, name: "Crawler", item: canonical }] },
    { "@type": "WebPage", "@id": canonical, name: title, description, publisher: siteOrgRef(baseUrl) },
  ];
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/crawler", extraCss, jsonLd, body });
}
