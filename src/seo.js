import { whyPointsPlain } from "./why.js";
import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable, POW_DIFFICULTY } from "./pow.js";
import { guideSlugs } from "./guides.js";
import { skillSlugs, SKILL_PACKS, PACK_PRICES, PACK_PRICE_RANGE } from "./skills.js";
import { BLOG_POSTS } from "./blog.js";
import { ADAPTERS } from "./adapter-docs.js";
import { integrationSlugs } from "./integration-pages.js";
import { LEARN, learnSlugs } from "./learn.js";
import { RAILS_OR } from "./rails.js";
import { CHAIN_PAGES } from "./market-page.js";
import { EXEC_TIERS } from "./tools/route-execute.js";
import { stripeEnabled } from "./mpp-stripe.js";
import { mppMethodsProse } from "./mpp-offers.js";
import { mppFlagshipLlmsBlock } from "./mpp-flagship.js";
import { seededProgrammaticPaths } from "./programmatic-seeds.js";
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";
import { priceUsdFor } from "./report-tiers.js";
import { samplePaths } from "./sample-reports.js";
import { listPublicReports } from "./human-checkout.js";

import { REPO_URL } from "./repo-link.js";
import { creditsSalesEnabled } from "./credits-sales.js";
/** The llms.txt "finished reports" paragraph, DERIVED from the live catalog
 *  (route + price per slug) and the product tables (card + monitor prices),
 *  so it cannot quote a ladder that has since moved: a hand-written copy sat a
 *  full price change behind the code for four days (2026-08-23..27) on the one
 *  surface every LLM crawler reads. Guarded by scripts/test-price-prose.js. */
export function reportsParagraph(baseUrl, tools) {
  const bySlug = new Map((tools || []).map((t) => [t.slug, t]));
  const item = (slug) => { const t = bySlug.get(slug); return t ? `${t.route} (${t.price})` : null; };
  const list = (...slugs) => slugs.map(item).filter(Boolean).join(", ");
  const groups = [
    ["Deep research", list("research", "research-pro", "research-max")],
    ["Company due-diligence dossier", list("dossier", "dossier-max")],
    ["Ticker pack, three reports in one run", list("ticker-pack")],
    ["Fund 13F report", list("fund-report", "fund-report-max")],
    ["SEC filing report", list("filing-report")],
    ["Domain security audit", list("domain-audit", "domain-audit-pro")],
    ["FDA recall report", list("recall-report")],
    ["Insider flow report", list("insider-report")],
    ["Market / competitor brief", list("market-brief")],
    ["Solana token brief", list("token-brief")],
    ["Token risk", list("token-risk", "token-risk-pro")],
    ["LinkedIn article, ready to publish", list("linkedin-article")],
    ["IPO pipeline digest, deterministic", list("ipo-report")],
  ].filter(([, v]) => v);
  const agent = Object.values(HUMAN_PRODUCTS).map((p) => priceUsdFor(p.slug)).filter((n) => Number.isFinite(n));
  const card = Object.values(HUMAN_PRODUCTS).map((p) => p.price / 100);
  const monitor = Math.min(...Object.values(MONITOR_PRODUCTS).map((m) => m.price / 100));
  const usd = (n) => `$${n.toFixed(2)}`;
  const range = (xs) => (xs.length ? (Math.min(...xs) === Math.max(...xs) ? usd(xs[0]) : `${usd(Math.min(...xs))} to ${usd(Math.max(...xs))}`) : "");
  return `**Finished reports, for agents and people.** Cited, grounded report products with a data appendix - the same endpoint over x402/MPP or by card. An agent pays the tool price per call, ${range(agent)}. ${groups.map(([k, v]) => `${k}: ${v}.`).join(" ")} People buy the same reports by card at ${baseUrl}/reports for ${range(card)}: the card price includes payment processing, so an agent paying per call pays the lower tool price for the same report. Monitors (${usd(monitor)}/month by card at ${baseUrl}/monitors, or over MPP on Tempo) re-run a report on change and email the diff - domain security, SEC filings, Solana token safety, fund 13F, FDA recall, insider flow, IPO pipeline.`;
}

// Computed ONCE when this module loads (i.e. once per deploy, since Railway
// restarts the process), not per-request. Every sitemap lastmod below reuses
// this so it genuinely reflects "the deploy that regenerated this sitemap" -
// previously each call recomputed new Date() fresh, so hitting /sitemap.xml
// on day N+1 of the same deploy claimed everything had "just changed," a
// signal crawlers learn to discount.
const BOOT_DATE = new Date().toISOString().slice(0, 10);

// Programmatic SEO landing pages (one per seeded ticker / 13F manager). ONLY
// the curated seeds are advertised: an off-list slug still renders when it
// resolves on EDGAR, but a sitemap that enumerated an open URL space would
// invite crawlers to mint upstream requests forever. The hub pages get a
// higher priority than the entity pages that hang off them.
const publicReportUrls = (baseUrl) => { try { return listPublicReports().map((r) => ({ loc: `${baseUrl}/reports/public/${r.publicId}`, priority: "0.6" })); } catch { return []; } };
const programmaticUrls = (baseUrl) => [...samplePaths().map((p) => ({ loc: `${baseUrl}${p}`, priority: "0.8" })), ...publicReportUrls(baseUrl), ...seededProgrammaticPaths().map((p) => ({ loc: `${baseUrl}${p}`, priority: p.split("/").length === 3 ? "0.8" : "0.6" }))];

export function robotsTxt(baseUrl) {
  // Explicitly welcome AI/agent crawlers and search engines; point them at the
  // machine-readable surfaces. Disallow the wallet-scoped memory endpoints and
  // the token-gated operator dashboard (already 404 without the token - this
  // just keeps well-behaved crawlers from probing the path at all).
  const agents = [
    "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-Web", "anthropic-ai",
    "PerplexityBot", "Google-Extended", "Googlebot", "Bingbot", "Applebot", "Applebot-Extended",
    "CCBot", "Bytespider", "Amazonbot", "cohere-ai", "Meta-ExternalAgent", "DuckDuckBot",
    // Smithery registry scanner (User-Agent SmitheryBot/1.0) - needs to read
    // homepage + /llms.txt for the listing backlink check; never Disallow it.
    "SmitheryBot",
  ];
  // COST, not secrecy, is why the seller-scoped market views are disallowed.
  // `/<chain>?seller=<host>` and `/api/market/<chain>/panel` run a per-wallet
  // on-chain activity scan, and on Base that scan is a PAID CDP SQL query -
  // two of them per distinct wallet. With ~2,300 indexed sellers, one crawler
  // walking the seller roster costs ~4,600 billed queries, and every crawler
  // above is explicitly welcomed. One month's crawler traffic billed tens of
  // thousands of SQL queries, far above what the roster earned; the seller
  // roster is the only surface that multiplies a page view by a paid query.
  //
  // The pages themselves stay indexable - only the seller-SCOPED variants are
  // disallowed, so /base, /solana and /marketplace keep all their SEO value
  // while the parameter that costs money per crawl does not.
  // CRAWL BUDGET, third reason (2026-09-01, read off Search Console): the
  // retired /api/convert/* namespace (~970 routes cut 2026-08-25) was 1,053
  // of the 2,630 not-indexed URLs - Googlebot spent its budget on 4xx API
  // endpoints while 743 real pages sat "Discovered - currently not indexed".
  // Scanners also re-walk the same dead routes daily (38% of telemetry
  // volume). Nothing lives there; nobody loses by being told so.
  const costly = [
    "Disallow: /*?seller=",
    "Disallow: /api/market/",
  ];
  // EVERY GROUP GETS THESE, not only `User-agent: *`. A crawler obeys the one
  // group that names it and no other (RFC 9309), so a rule that lives only in
  // the wildcard group reaches none of the agents named above: each of them
  // read `Allow: /` and nothing else, and the bearer-token receipt pages, the
  // proof-of-work challenge endpoint and the wallet-keyed memory rows were
  // open to every one of them. Two costs, and the second is the measurable
  // one: those paths answer an unpaid crawler 4xx, which is what a search
  // console reports back as a crawl error on a healthy site, and a rule added
  // to stop exactly that (the /api/pow/ line) had no effect on the crawler it
  // was written for. Keep the explicit `Allow: /` in each block: the catalog
  // is FOR these agents, and the welcome is the point of naming them.
  const priv = [
    "Disallow: /api/memory",
    "Disallow: /__operator",
    "Disallow: /r/",
    "Disallow: /m/",
    "Disallow: /monitors/thanks",
    "Disallow: /monitors/manage",
    "Disallow: /credits/thanks",
    "Disallow: /api/r/",
    "Disallow: /api/m/",
    "Disallow: /api/credits/",
    "Disallow: /api/convert/",
    "Disallow: /api/monitors/",
    "Disallow: /api/pow/",
    "Disallow: /api/buy",
  ];
  const rules = [...priv, ...costly].join("\n");
  const blocks = agents.map((a) => `User-agent: ${a}\nAllow: /\n${rules}`).join("\n\n");
  return `${blocks}

User-agent: *
Allow: /
${rules}

# Machine-readable catalogs for agents: ${baseUrl}/SKILL.md , ${baseUrl}/llms.txt , ${baseUrl}/openapi.json , ${baseUrl}/api/pricing , ${baseUrl}/api/cacheable , ${baseUrl}/.well-known/x402 , ${baseUrl}/.well-known/agent-card.json , ${baseUrl}/.well-known/agent-registration.json , ${baseUrl}/api/reliability , ${baseUrl}/api/find?q={task} , ${baseUrl}/api/route , ${baseUrl}/api/leaderboard
# Crawling this catalog: every route and price is in ${baseUrl}/.well-known/x402 , ${baseUrl}/openapi.json and ${baseUrl}/api/pricing ; read those rather than each priced route. Crawl policy, including the hourly budget on unpaid price checks: ${baseUrl}/crawler
Sitemap: ${baseUrl}/sitemap.xml
Sitemap: ${baseUrl}/sitemapindex.xml
`;
}

export function sitemapXml(baseUrl, catalog) {
  // lastmod reflects the deploy that regenerated this sitemap (the pages are
  // server-rendered, so a deploy is the freshness signal crawlers should see).
  const lastmod = BOOT_DATE;
  const staticUrls = [
    { loc: `${baseUrl}/`, priority: "1.0" },
    { loc: `${baseUrl}/tools`, priority: "0.9" },
    { loc: `${baseUrl}/reports`, priority: "0.9" },
    { loc: `${baseUrl}/monitors`, priority: "0.8" },
    // A closed product takes no crawl slot: listed only while packs are on sale.
    ...(creditsSalesEnabled() ? [{ loc: `${baseUrl}/credits`, priority: "0.8" }] : []),
    { loc: `${baseUrl}/shop`, priority: "0.9" },
    // Every x402 marketplace page (one per CHAIN_PAGES entry) - new chain
    // page = new sitemap entry, zero edits here.
    ...Object.keys(CHAIN_PAGES).map((key) => ({ loc: `${baseUrl}/${key}`, priority: "0.8" })),
    { loc: `${baseUrl}/faq`, priority: "0.8" },
    { loc: `${baseUrl}/docs`, priority: "0.8" },
    { loc: `${baseUrl}/transparency`, priority: "0.4" },
    { loc: `${baseUrl}/llms.txt`, priority: "0.8" },
    { loc: `${baseUrl}/SKILL.md`, priority: "0.8" },
    { loc: `${baseUrl}/openapi.json`, priority: "0.7" },
    { loc: `${baseUrl}/api/pricing`, priority: "0.7" },
    { loc: `${baseUrl}/api/find`, priority: "0.7" },
    { loc: `${baseUrl}/.well-known/x402`, priority: "0.7" },
    { loc: `${baseUrl}/api/reliability`, priority: "0.6" },
    { loc: `${baseUrl}/api/stats`, priority: "0.6" },
    // Unified marketplace surface (the old /index and /marketplaces 301 here -
    // a sitemap must never list URLs that redirect).
    { loc: `${baseUrl}/marketplace`, priority: "0.9" },
    { loc: `${baseUrl}/mpp-marketplace`, priority: "0.9" },
    // Third-party tool index. Listed at a lower priority than our own catalog
    // on purpose: it is other people's endpoints reproduced with their own
    // descriptions, so it should never outrank the tools we actually operate.
    { loc: `${baseUrl}/marketplace/tools`, priority: "0.6" },
    { loc: `${baseUrl}/api/index`, priority: "0.6" },
    { loc: `${baseUrl}/sell`, priority: "0.8" },
    { loc: `${baseUrl}/api/route`, priority: "0.7" },
    { loc: `${baseUrl}/leaderboard`, priority: "0.8" },
    { loc: `${baseUrl}/api/leaderboard`, priority: "0.7" },
    { loc: `${baseUrl}/api/cacheable`, priority: "0.6" },
    { loc: `${baseUrl}/api/cache-stats`, priority: "0.5" },
    { loc: `${baseUrl}/tollbooth`, priority: "0.7" },
    { loc: `${baseUrl}/tollbooth/cloud`, priority: "0.7" },
    { loc: `${baseUrl}/integrations`, priority: "0.8" },
    { loc: `${baseUrl}/pricing`, priority: "0.8" },
    { loc: `${baseUrl}/changelog`, priority: "0.7" },
    { loc: `${baseUrl}/use-cases`, priority: "0.8" },
    { loc: `${baseUrl}/quickstart`, priority: "0.9" },
    { loc: `${baseUrl}/what-is-x402`, priority: "0.9" },
    { loc: `${baseUrl}/what-is-mpp`, priority: "0.9" },
    { loc: `${baseUrl}/agentic-finance`, priority: "0.9" },
    { loc: `${baseUrl}/why`, priority: "0.8" },
    { loc: `${baseUrl}/x402-test`, priority: "0.7" },
    { loc: `${baseUrl}/markets`, priority: "0.8" },
    ...(catalog && catalog["POST /api/decide"] ? [{ loc: `${baseUrl}/decide`, priority: "0.9" }] : []),
    { loc: `${baseUrl}/digest`, priority: "0.6" },
    { loc: `${baseUrl}/security`, priority: "0.7" },
    { loc: `${baseUrl}/crawler`, priority: "0.5" },
    { loc: `${baseUrl}/company`, priority: "0.7" },
    { loc: `${baseUrl}/proof`, priority: "0.7" },
    { loc: `${baseUrl}/terms`, priority: "0.3" },
    { loc: `${baseUrl}/privacy`, priority: "0.3" },
    { loc: `${baseUrl}/glossary`, priority: "0.8" },
    { loc: `${baseUrl}/101`, priority: "0.9" },
    { loc: `${baseUrl}/revenue`, priority: "0.6" },
    { loc: `${baseUrl}/blog`, priority: "0.8" },
    { loc: `${baseUrl}/compare`, priority: "0.8" },
    { loc: `${baseUrl}/community`, priority: "0.7" },
    { loc: `${baseUrl}/contribute`, priority: "0.7" },
    { loc: `${baseUrl}/workflows`, priority: "0.8" },
    { loc: `${baseUrl}/status`, priority: "0.7" },
    { loc: `${baseUrl}/badges`, priority: "0.5" },
    { loc: `${baseUrl}/sdk-playground`, priority: "0.7" },
    { loc: `${baseUrl}/docs/api/explorer`, priority: "0.8" },
    { loc: `${baseUrl}/docs/adapters`, priority: "0.8" },
    { loc: `${baseUrl}/docs/webhooks`, priority: "0.7" },
    { loc: `${baseUrl}/playground`, priority: "0.8" },
    ...BLOG_POSTS.map((p) => ({ loc: `${baseUrl}/blog/${p.slug}`, priority: "0.7" })),
    ...ADAPTERS.map((a) => ({ loc: `${baseUrl}/docs/adapters/${a.slug}`, priority: "0.7" })),
    ...learnIntegrationUrls(baseUrl),
  ];
  const guideUrls = [
    { loc: `${baseUrl}/guides`, priority: "0.8" },
    ...guideSlugs().map((s) => ({ loc: `${baseUrl}/guides/${s}`, priority: "0.8" })),
  ];
  const skillUrls = [
    { loc: `${baseUrl}/skills`, priority: "0.8" },
    ...skillSlugs().map((s) => ({ loc: `${baseUrl}/skills/${s}`, priority: "0.8" })),
  ];
  const toolUrls = toolList(catalog).map((t) => ({ loc: `${baseUrl}/tools/${t.slug}`, priority: "0.8" }));
  const entries = [...staticUrls, ...programmaticUrls(baseUrl), ...guideUrls, ...skillUrls, ...categoryUrls(baseUrl, catalog), ...toolUrls]
    .map((u) => `  <url><loc>${u.loc}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>${u.priority}</priority></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

// Sitemap index - splits the single sitemap into sub-sitemaps so crawlers
// don't have to parse 1,400+ URLs in one file. /sitemap.xml stays as the
// monolith for backwards compat; /sitemapindex.xml points to the splits.
function subSitemap(urls, lastmod) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>${u.priority}</priority></url>`).join("\n")}\n</urlset>`;
}
/** One /tools/category/<key> page per category the live catalog uses. */
function categoryUrls(baseUrl, catalog) {
  const used = new Set(toolList(catalog).map((t) => t.category));
  return Object.keys(CATEGORIES).filter((k) => used.has(k) && k !== "convert").map((k) => ({ loc: `${baseUrl}/tools/category/${k}`, priority: "0.7" }));
}
export function sitemapCategories(baseUrl, catalog) {
  return subSitemap(categoryUrls(baseUrl, catalog), BOOT_DATE);
}
export function sitemapIndex(baseUrl) {
  const lastmod = BOOT_DATE;
  const subs = ["sitemap-pages.xml", "sitemap-reports.xml", "sitemap-tools.xml", "sitemap-categories.xml", "sitemap-guides.xml", "sitemap-skills.xml", "sitemap-learn.xml"];
  const entries = subs.map((s) => `  <sitemap><loc>${baseUrl}/${s}</loc><lastmod>${lastmod}</lastmod></sitemap>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>`;
}
export function sitemapPages(baseUrl, catalog) {
  const lastmod = BOOT_DATE;
  const urls = [
    { loc: `${baseUrl}/`, priority: "1.0" },
    { loc: `${baseUrl}/tools`, priority: "0.9" },
    { loc: `${baseUrl}/reports`, priority: "0.9" },
    { loc: `${baseUrl}/monitors`, priority: "0.8" },
    // A closed product takes no crawl slot: listed only while packs are on sale.
    ...(creditsSalesEnabled() ? [{ loc: `${baseUrl}/credits`, priority: "0.8" }] : []),
    { loc: `${baseUrl}/shop`, priority: "0.9" },
    { loc: `${baseUrl}/quickstart`, priority: "0.9" },
    { loc: `${baseUrl}/what-is-x402`, priority: "0.9" },
    { loc: `${baseUrl}/what-is-mpp`, priority: "0.9" },
    { loc: `${baseUrl}/agentic-finance`, priority: "0.9" },
    { loc: `${baseUrl}/why`, priority: "0.8" },
    { loc: `${baseUrl}/x402-test`, priority: "0.7" },
    { loc: `${baseUrl}/markets`, priority: "0.8" },
    ...(catalog && catalog["POST /api/decide"] ? [{ loc: `${baseUrl}/decide`, priority: "0.9" }] : []),
    { loc: `${baseUrl}/digest`, priority: "0.6" },
    { loc: `${baseUrl}/security`, priority: "0.7" },
    { loc: `${baseUrl}/crawler`, priority: "0.5" },
    { loc: `${baseUrl}/company`, priority: "0.7" },
    { loc: `${baseUrl}/glossary`, priority: "0.8" },
    { loc: `${baseUrl}/101`, priority: "0.9" },
    { loc: `${baseUrl}/pricing`, priority: "0.8" },
    { loc: `${baseUrl}/integrations`, priority: "0.8" },
    { loc: `${baseUrl}/use-cases`, priority: "0.8" },
    { loc: `${baseUrl}/faq`, priority: "0.8" },
    // Unified marketplace surface (the old /index and /marketplaces 301 here).
    { loc: `${baseUrl}/marketplace`, priority: "0.9" },
    { loc: `${baseUrl}/mpp-marketplace`, priority: "0.9" },
    // Third-party tool index. Listed at a lower priority than our own catalog
    // on purpose: it is other people's endpoints reproduced with their own
    // descriptions, so it should never outrank the tools we actually operate.
    { loc: `${baseUrl}/marketplace/tools`, priority: "0.6" },
    { loc: `${baseUrl}/sell`, priority: "0.8" },
    { loc: `${baseUrl}/leaderboard`, priority: "0.8" },
    { loc: `${baseUrl}/docs`, priority: "0.8" },
    // Every x402 marketplace page (one per CHAIN_PAGES entry).
    ...Object.keys(CHAIN_PAGES).map((key) => ({ loc: `${baseUrl}/${key}`, priority: "0.8" })),
    { loc: `${baseUrl}/revenue`, priority: "0.6" },
    { loc: `${baseUrl}/changelog`, priority: "0.7" },
    { loc: `${baseUrl}/tollbooth`, priority: "0.7" },
    { loc: `${baseUrl}/tollbooth/cloud`, priority: "0.7" },
    { loc: `${baseUrl}/playground`, priority: "0.8" },
    { loc: `${baseUrl}/sdk-playground`, priority: "0.7" },
    { loc: `${baseUrl}/blog`, priority: "0.8" },
    { loc: `${baseUrl}/compare`, priority: "0.8" },
    { loc: `${baseUrl}/community`, priority: "0.7" },
    { loc: `${baseUrl}/contribute`, priority: "0.7" },
    { loc: `${baseUrl}/workflows`, priority: "0.8" },
    { loc: `${baseUrl}/status`, priority: "0.7" },
    { loc: `${baseUrl}/badges`, priority: "0.5" },
    { loc: `${baseUrl}/docs/api/explorer`, priority: "0.8" },
    { loc: `${baseUrl}/docs/adapters`, priority: "0.8" },
    { loc: `${baseUrl}/docs/webhooks`, priority: "0.7" },
    ...BLOG_POSTS.map((p) => ({ loc: `${baseUrl}/blog/${p.slug}`, priority: "0.7" })),
    ...ADAPTERS.map((a) => ({ loc: `${baseUrl}/docs/adapters/${a.slug}`, priority: "0.7" })),
    { loc: `${baseUrl}/privacy`, priority: "0.4" },
    { loc: `${baseUrl}/terms`, priority: "0.4" },
    { loc: `${baseUrl}/transparency`, priority: "0.4" },
  ];
  return subSitemap(urls, lastmod);
}
export function sitemapTools(baseUrl, catalog) {
  const lastmod = BOOT_DATE;
  return subSitemap(toolList(catalog).map((t) => ({ loc: `${baseUrl}/tools/${t.slug}`, priority: "0.8" })), lastmod);
}
export function sitemapReports(baseUrl) {
  return subSitemap(programmaticUrls(baseUrl), BOOT_DATE);
}
export function sitemapGuides(baseUrl) {
  const lastmod = BOOT_DATE;
  return subSitemap([{ loc: `${baseUrl}/guides`, priority: "0.8" }, ...guideSlugs().map((s) => ({ loc: `${baseUrl}/guides/${s}`, priority: "0.8" }))], lastmod);
}
// /learn explainers and the per-package /integrations pages. One list feeds
// both this sub-sitemap and the /sitemap.xml monolith (which is what
// scripts/indexnow-submit.js reads), so the two cannot drift.
export function learnIntegrationUrls(baseUrl) {
  return [
    { loc: `${baseUrl}/learn`, priority: "0.8" },
    ...learnSlugs().map((s) => ({ loc: `${baseUrl}/learn/${s}`, priority: "0.8" })),
    ...integrationSlugs().map((s) => ({ loc: `${baseUrl}/integrations/${s}`, priority: "0.7" })),
  ];
}
export function sitemapLearn(baseUrl) {
  return subSitemap(learnIntegrationUrls(baseUrl), BOOT_DATE);
}
export function sitemapSkills(baseUrl) {
  const lastmod = BOOT_DATE;
  return subSitemap([{ loc: `${baseUrl}/skills`, priority: "0.8" }, ...skillSlugs().map((s) => ({ loc: `${baseUrl}/skills/${s}`, priority: "0.8" }))], lastmod);
}

// Trims a tier dollar amount to the shortest exact representation (2 decimals
// when that's exact, else 3) so $0.01/$0.005/$3.30/$3.00 all read naturally.
const fmtExecTierUsd = (n) => {
  const s3 = n.toFixed(3);
  return s3.endsWith("0") ? n.toFixed(2) : s3;
};

import { decideConfig as _decideConfig } from "./decide/config.js";
const decidePrices = () => _decideConfig().prices;
const decideRoutingFeePct = () => _decideConfig().routingFeePct;
const decideCreditHours = () => _decideConfig().credit.ttlHours;

export function llmsTxt(baseUrl, catalog) {
  // Identity-bound routes, read from the same flag the gates and tool pages read
  // (isIdentityBoundRoute, stamped on each def at catalog build), never typed.
  const identityBoundDefs = Object.values(catalog || {}).filter((d) => d && d.identityBound);
  const identityBoundList = [
    ...(identityBoundDefs.some((d) => d.category === "memory") ? ["memory"] : []),
    ...[...new Set(identityBoundDefs.filter((d) => d.category !== "memory").map((d) => d.slug))].sort(),
  ].join(", ");
  // Route prices in this text are READ FROM THE CATALOG at render time. They
  // used to be typed by hand and eleven of thirty-eight were stale after two
  // repricings (found 2026-09-10); a price beside a route in llms.txt is a
  // quote an agent will act on. Unknown slug -> "see /api/pricing", never a number.
  const priceOfSlug = (slug) => {
    const def = Object.values(catalog || {}).find((d) => d && d.slug === slug);
    return def && typeof def.price === "string" ? def.price : "see /api/pricing";
  };
  const tools = toolList(catalog);
  // MPP start-here list, derived from src/mpp-flagship.js with catalog prices.
  const mppStartHereBlock = mppFlagshipLlmsBlock(catalog);
  const powCount = tools.filter(isComputePayable).length;
  // Derived from EXEC_TIERS, not hand-typed - a hardcoded list here is exactly
  // how the $3.30 route-execute-pro tier (added 2026-08-04) went missing from
  // this summary for weeks: a new tier landed in route-execute.js and nobody
  // remembered to touch this unrelated prose file too. Deriving it means a
  // future 5th tier can't repeat the same silent omission.
  const execTierSentence = EXEC_TIERS.map((t, i) => {
    // Real route path, same derivation as buildRouteExecuteTool() itself
    // (route-execute.js): "route-execute-plus" -> suffix "-plus" ->
    // /api/route/execute-plus, never /api/route/route-execute-plus.
    const routeSuffix = t.slug.replace("route-execute", "");
    return i === 0
      ? `$${fmtExecTierUsd(t.execPriceUsd)} covers tools <= $${fmtExecTierUsd(t.underlyingMaxUsd)}`
      : `\`/api/route/execute${routeSuffix}\` at $${fmtExecTierUsd(t.execPriceUsd)} covers <= $${fmtExecTierUsd(t.underlyingMaxUsd)}`;
  }).join(", ");

  // The llms.txt spec (llmstxt.org) wants: an H1, one summary blockquote, then
  // free-form "info" prose (NO headings), then H2 sections whose bodies are
  // lists of `[name](url): notes` markdown links. So all narrative lives in the
  // info block (bold leads, not headings), and every `##` section below is a
  // pure link list. Per-category tool sections list each tool as a link;
  // oversized generated families collapse to one summary link.
  const toolSections = Object.entries(CATEGORIES)
    .map(([key, { label }]) => {
      const inCat = tools.filter((t) => t.category === key);
      if (!inCat.length) return "";
      // Large categories drop the DESCRIPTIONS, not the tools. Collapsing them
      // to a single summary link made 165 endpoints unfindable by name in the
      // agent-readable catalog - including tools added specifically to be
      // discoverable. Name, link and price per line keeps every endpoint
      // listed at roughly a tenth of the bytes; the pointer below still leads
      // to the full schemas.
      if (inCat.length > 40) {
        const compact = inCat.map((t) => `- [${t.name}](${baseUrl}/tools/${t.slug}): ${t.price}/call`).join("\n");
        return `## Tools - ${label}\n\n${compact}\n\n- [Full input schemas for all ${inCat.length} ${label} endpoints](${baseUrl}/api/pricing)`;
      }
      const items = inCat.map(
        (t) => `- [${t.name}](${baseUrl}/tools/${t.slug}): ${t.price}/call. ${t.description}`
      );
      return `## Tools - ${label}\n\n${items.join("\n")}`;
    })
    .filter(Boolean)
    .join("\n\n");

  // Name the CALLABLE route and the price, not just the page. An agent reading
  // llms.txt could see that a pack existed but had to make another hop to learn
  // what it cost or how to invoke it, so the one-call purchase was a paragraph
  // of prose instead of an address.
  const packItems = SKILL_PACKS
    .map((p) => {
      const price = PACK_PRICES[p.slug] ?? 0.05;
      return `- [${p.title}](${baseUrl}/skills/${p.slug}): ${p.tagline} (\`${p.slug}\`, ${p.toolSlugs.length} tools in one call: \`POST ${baseUrl}/api/skill/${p.slug}\`, $${fmtExecTierUsd(price)}, one x402 payment)`;
    })
    .join("\n");

  const chainItems = Object.entries(CHAIN_PAGES)
    .map(([key, c]) => `- [${c.chainName}](${baseUrl}/${key}): ${c.asset} via ${c.facilitatorLabel} (\`${c.caip2}\`)`)
    .join("\n");

  return `# Agent402.Tools

> Pay-per-call web tools for AI agents, payable over **x402 or MPP** - the applied layer of Agentic Finance: agents that pay and get paid on their own (explainer: /agentic-finance). **First job: search the web and answer questions** (\`/api/search\`, \`/api/answer\`, \`/api/search-news\`) - then the long catalog of 500+ tools via \`/api/find\`: deterministic utilities, a metered model gateway on the OpenAI and Anthropic wires (\`POST /v1/metered/chat/completions\`, \`POST /v1/metered/messages\`) and finished report products. Call an endpoint, receive an HTTP 402 carrying both offers (x402 PAYMENT-REQUIRED and MPP WWW-Authenticate: Payment), and settle from your own wallet - USDC via x402, or MPP on Base/Celo (USDC) or Tempo (USDC.e or PathUSD, native)${stripeEnabled() ? ", or by **card** on premium tools >= $0.50 (Stripe Shared Payment Token over MPP stripe/charge - no wallet, no stablecoin)" : ""} - or, on ${powCount} of the ${tools.length} tools, pay with proof-of-work (CPU) and skip the wallet entirely. No human, no signup, no API key: the payment is the identity. Per-call prices from $0.001 (the metered gateway quotes each request from its body) - most tools $0.001–$0.02, with premium AI and media tiers higher and multi-tool packs ${PACK_PRICE_RANGE.text}; every price is in /api/pricing and quoted in the 402.

Base URL: ${baseUrl}

**Open source and two-sided.** Agent402 is the open-source, self-hostable applied layer of Agentic Finance (agents paying and getting paid on their own) for x402 and MPP (+ MCP server): 500+ pay-per-call tools for agents to buy (live web search + cited answers, browser rendering, PDFs, OCR, images, live financial / crypto / macro data, SEC EDGAR, wallet-keyed memory, a metered model gateway, finished reports), a neutral cross-seller index and on-chain leaderboard for the whole x402 ecosystem, and \`agent402-tollbooth\` for API sellers to charge AI crawlers per request. Maintainer: Havok Holdings LLC. Read every line and run it yourself: ${REPO_URL}

**Why pay here (seven first-party differences, each proven on a live surface - full page: /why).** ${whyPointsPlain().map((line, i) => `(${i + 1}) ${line}`).join(" ")} Metered usage pricing: \`POST /v1/metered/chat/completions\` quotes each request from its body; finished reports and monitors: /reports and /monitors; sourcing from other sellers: \`POST /api/route/execute\`; proof: /status and /revenue.

**This is machine-to-machine commerce, and you can verify it.** Run the full loop with no human and no funds - \`node scripts/demo-payment.js\` discovers the catalog, gets quoted over HTTP 402, pays with compute, and uses the result. Every stablecoin call settles on-chain on the rail the buyer chose, to the payTo its 402 named (on Base that is agent402.base.eth, verifiable on Basescan); live economy stats are at ${baseUrl}/api/stats and a machine-readable reliability report (each claim with a verification URL) at ${baseUrl}/api/reliability.

**Why agents use this instead of building it themselves.** You cannot sign up for anything: the useful web hides behind signups, captchas, API keys, and credit cards, none of which an autonomous agent can obtain - every capability here needs only the credential an agent already holds (its wallet, or its CPU). Capabilities your sandbox lacks (a headless browser, network egress, durable disk) are here because agents cannot self-host them mid-task. State survives the session and even crosses owners via wallet-keyed \`/api/memory\`. One x402-wrapped fetch (or the MCP server) covers the whole catalog - published schemas, per-call prices quoted before payment, the tools CI can run without third-party keys tested before every deploy, billed verifiably on-chain.

**No wallet? Pay with compute (proof-of-work).** ${powCount} of the ${tools.length} tools accept a sha256 proof-of-work puzzle (a fraction of a second of CPU) instead of USDC - no money and no AI tokens (no model in the serving path of these tools). Get a challenge at \`${baseUrl}/api/pow/challenge?slug=hash\`, find an integer nonce so that \`sha256(challenge + ":" + nonce)\` has at least ${POW_DIFFICULTY} leading zero bits, then resend the request with header \`X-Pow-Solution: <token>:<nonce>\`. **The response has two different fields and you use both: hash the \`challenge\` (32 hex chars), submit the \`token\` (the longer signed string).** Submitting the challenge you just hashed returns a 402 that looks exactly like an unpaid request, so this is the one step worth reading twice. The network / browser / storage tools that need wallet-bound identity or live egress stay wallet-only.

**Pay with USDC (x402).** Wrap fetch with \`@x402/fetch\`, register the exact EVM scheme with your signer, and call normally - the 402 is decoded, paid, and the result returned. Settlement uses ${RAILS_OR}; gas is sponsored by the facilitator on EVM chains, so callers need only hold the stablecoin. Send an \`Idempotency-Key\` header for safe retries: replaying the same key with the same payment/PoW credential returns the original result without paying again.

**Already hold a prepaid credits key?** New credits are not on sale; a key already issued keeps working. Send it as \`Authorization: Bearer a402_...\` on any paid tool - the list price is held before the call and debited only on a successful (200) response; \`X-Credits-Balance\` rides on every answer and \`GET ${baseUrl}/api/credits/balance\` reports the key. agent402-mcp (AGENT402_CREDITS_KEY) and agent402-client ({ creditsKey }) support it. Identity-bound tools (${identityBoundList}) still need an EVM x402 wallet - the payment is the identity there, so credits keys and Tempo are refused on them.

${reportsParagraph(baseUrl, tools)}

**Crypto derivatives, DeFi and Solana intel.** Live perpetuals and options, no exchange account: \`POST /api/perp-markets\` (${priceOfSlug("perp-markets")}) snapshots every listed perp, \`POST /api/perp-funding\` (${priceOfSlug("perp-funding")}) and \`POST /api/perp-funding-screener\` (${priceOfSlug("perp-funding-screener")}) read funding rates now and across the book, and \`POST /api/perp-basis\` (${priceOfSlug("perp-basis")}), \`POST /api/perp-open-interest\` (${priceOfSlug("perp-open-interest")}), \`POST /api/perp-klines\` (${priceOfSlug("perp-klines")}) and \`POST /api/perp-orderbook\` (${priceOfSlug("perp-orderbook")}) cover premium, OI, candles and depth; the options book is \`POST /api/options-summary\` (${priceOfSlug("options-summary")}), \`POST /api/crypto-options-chain\` (${priceOfSlug("crypto-options-chain")}), \`POST /api/options-ticker\` (${priceOfSlug("options-ticker")}) and \`POST /api/options-volume\` (${priceOfSlug("options-volume")}). DeFi: \`POST /api/defi-yields\` (${priceOfSlug("defi-yields")}) screens pools by chain, project and TVL, with \`POST /api/defi-protocols\` (${priceOfSlug("defi-protocols")}), \`POST /api/defi-protocol\` (${priceOfSlug("defi-protocol")}), \`POST /api/defi-chains\` (${priceOfSlug("defi-chains")}), \`POST /api/defi-fees\` (${priceOfSlug("defi-fees")}), \`POST /api/defi-dex-volume\` (${priceOfSlug("defi-dex-volume")}), \`POST /api/stablecoins\` (${priceOfSlug("stablecoins")}) and history siblings for pools, chains and stablecoin supply. Solana: \`POST /api/sol-token-safety\` (${priceOfSlug("sol-token-safety")}) grades a mint (authorities, liquidity, holder concentration), \`POST /api/sol-token-report\` (${priceOfSlug("sol-token-report")}) is the full risk write-up, and \`POST /api/sol-token-holders\` (${priceOfSlug("sol-token-holders")}), \`POST /api/sol-token-pairs\` (${priceOfSlug("sol-token-pairs")}), \`POST /api/sol-trending\` (${priceOfSlug("sol-trending")}), \`POST /api/sol-price\` (${priceOfSlug("sol-price")}), \`POST /api/sol-swap-quote\` (${priceOfSlug("sol-swap-quote")}) and \`POST /api/sol-token-lookup\` (${priceOfSlug("sol-token-lookup")}) cover concentration, pairs, trending, prices and routing. Market context: \`POST /api/crypto-news\` (${priceOfSlug("crypto-news")}), \`POST /api/crypto-indicators\` (${priceOfSlug("crypto-indicators")}), \`POST /api/crypto-market-pulse\` (${priceOfSlug("crypto-market-pulse")}), \`GET /api/coin-profile\` (${priceOfSlug("coin-profile")}), \`GET /api/coin-price-by-contract\` (${priceOfSlug("coin-price-by-contract")}) and \`GET /api/coin-ohlc\` (${priceOfSlug("coin-ohlc")}). Raw chain reads: \`POST /api/asset-transfers\` (${priceOfSlug("asset-transfers")}), \`POST /api/token-balances\` (${priceOfSlug("token-balances")}), \`POST /api/tx-receipt\` (${priceOfSlug("tx-receipt")}) and \`POST /api/token-price-history\` (${priceOfSlug("token-price-history")}). Whole-site structure on demand: \`POST /api/site-map\` (${priceOfSlug("site-map")}) and \`POST /api/site-crawl\` (${priceOfSlug("site-crawl")}).

**Images and video, flat per call.** Text-to-image and text-to-video on the OpenAI wire, priced per picture or per clip rather than per token: \`POST /v1/images/fast\` ($0.02, budget), \`POST /v1/images/pro\` ($0.05, higher fidelity), \`POST /v1/images/generations\` ($0.08, flagship) and \`POST /v1/videos/generations\` ($0.20, one silent 4-second 720p clip, MP4 inline base64). Point any OpenAI SDK at base_url ${baseUrl}/v1 and call the path you want; a failed or timed-out generation is not charged on x402.

**A failed call is not charged - structurally, and you can check it per response rather than trust us.** Settlement runs AFTER the tool handler and only completes for a successful (under-400) response: an error, a capacity 503, or an upstream 502 cancels settlement inside the payment middleware itself, so no money moves and there is nothing to claim. The exception is a Tempo push payment, sent before the call runs: if the call then fails, it is recorded as a refund owed to the paying wallet.

Determine it from the response you already hold, without asking us:

- **No \`PAYMENT-RESPONSE\` header** - nothing settled. You were not charged. Safe to retry.
- **\`PAYMENT-RESPONSE\` present, receipt \`success: false\`** - settlement was attempted and REJECTED (a facilitator declining produces a 402 with this shape). You were not charged. Safe to retry with a fresh authorization.
- **\`PAYMENT-RESPONSE\` present, receipt not \`success: false\`, status under 400** - charged and served. Normal.
- **\`PAYMENT-RESPONSE\` present, receipt not \`success: false\`, status 400 or above** - the residual case: a settlement completed without a successful response. Do NOT blind-retry; this is the one shape where money may have moved without service. We count and alarm on it as an incident rather than claim it cannot happen.

Every x402 authorization is single-use, so any retry needs a fresh signature. Send an \`Idempotency-Key\` header and a retry of an already-served paid call replays the original result instead of charging again. **Making many calls? Pay once instead of signing each one.** Exact x402 is one signature and one settlement per request, which is the wrong shape at volume. On the metered gateway, a one-time Permit2 approval for USDC on Base makes the per-request quote a CEILING and the call settles at actual usage under it (\`npx agent402-openclaw permit2-approve\`); it stays per-request priced and settles only on a 200. A prepaid credits key already issued also skips the per-call signature.

We state it this way deliberately: the honest guarantee is "settlement ordering makes an error non-chargeable, and here is how to verify it yourself", not "this can never happen". A contract you can check beats one you have to believe.

**MPP clients are first-class (dual-stack), and now a native second method too.** Every paid endpoint also speaks MPP (Machine Payments Protocol, the IETF-track \`Payment\` HTTP auth scheme): the same 402 carries \`WWW-Authenticate: Payment\` challenges, listed in this order: ${mppMethodsProse() || "none on this instance (MPP_SECRET_KEY / TEMPO_API_KEY unset)"}. \`/openapi.json\` publishes the same offers, in the same order, per route (\`x-payment-info.offers\`). A stock mppx client pays the first challenge it has a method for, so a wallet holding Tempo funds pays over Tempo; a client whose Tempo credential was just refused is shown the \`evm\` challenge first for a while. Settled responses return a signed \`Payment-Receipt\` header either way. An \`mppx\` client (\`Fetch.from\` with \`evm.charge\` or \`tempo.charge\`) works out of the box - same URL, same price, whichever method your client speaks. The hosted MCP connector at \`${baseUrl}/mcp\` pays the same way: a wallet-only tool answers with a readable tool result carrying the challenges in \`_meta["org.paymentauth/payment-required"]\` (a refused credential is JSON-RPC -32043), and an MCP client wrapped with mppx's \`McpClient.wrap()\` pays and retries on its own (receipt in \`_meta\`).${mppStartHereBlock ? `\n\n${mppStartHereBlock}` : ""}

**How to read our 402 if you only speak one dialect.** The same response carries BOTH headers, always - \`WWW-Authenticate: Payment\` is additive, never a replacement for the real x402 \`PAYMENT-REQUIRED\` header (full \`accepts\` array, \`exact\` scheme, EIP-3009). A client that hard-fails on an unrecognized \`WWW-Authenticate\` scheme instead of also checking for \`PAYMENT-REQUIRED\` will bail with something like "no supported rail" on a 402 it could have paid - this has happened at least once (see issue #794). If your parser only understands one of the two dialects, check for the header it understands FIRST rather than trusting whichever header happens to be read first; do not treat an unrecognized \`WWW-Authenticate\` scheme as "this server has no payment option for me." The JSON body of every paywall 402 also carries the same PaymentRequired object as the \`PAYMENT-REQUIRED\` header (\`x402Version\`, \`accepts\`, \`resource\`, \`extensions\`), beside our own fields; the header is authoritative.

## Key machine surfaces
- [/SKILL.md](${baseUrl}/SKILL.md): agent-onboarding skill sheet - setup (MCP server / SDK / plain HTTP), discover, pay (x402, MPP or proof-of-work), read the 402, common issues. Start here if you are setting Agent402 up for the first time
- [/api/search](${baseUrl}/api/search): **front door** - live web search (title, URL, snippet). Start here to discover pages; follow with extract or answer
- [/api/answer](${baseUrl}/api/answer): **front door** - cited answer grounded in live web search results
- [/api/search-news](${baseUrl}/api/search-news): live news search for current events / headlines
- [/api/find](${baseUrl}/api/find): resolve a plain-language task to the best-matching tools with route, price, input schema, and a ready example (GET \`?q={task}\` or POST \`{"task":"..."}\`) - long-tail discovery behind the flagships. A task that names several steps ("get the price, then compute RSI") also returns a free \`plan\`: each step ranked the same way, with an estimated total
- [/api/route](${baseUrl}/api/route): Smart Order Router - rank tools across every x402 seller crawled from public registries; \`include:"external"\` excludes Agent402 for neutral cross-seller discovery
- [/api/route/execute](${baseUrl}/api/route/execute): the SOR that also PAYS. Send a task, and Agent402 resolves the best-matching tool, buys the result from the seller over x402 (any proven seller in the open index, not just ours), and sells it to you with a receipt - one payment, one request, one wallet. You never hold a wallet on their chain or sign up with them. \`{"task":"...","include":"external"}\`. Proportional tiers: ${execTierSentence} - an over-cap task gets a self-correcting 409 naming the tier that fits${catalog["POST /api/decide"] ? `\n- [/api/decide](${baseUrl}/api/decide): a paid decision. Describe a job; get a call-ready plan over this catalog and outside x402 sellers with a recently verified 402: steps, fallbacks, params that validate against each tool's schema, cost and latency estimates. Depth quick $${decidePrices().quick} / plan $${decidePrices().plan} / full $${decidePrices().full}. The ranking formula has no first-party term and every tool carries firstParty. The fee returns as a ${decideCreditHours()}-hour credit toward \`POST /api/decide/execute\`, which runs the plan when paid on Base or by credits or card (third-party steps at the seller's price plus a ${decideRoutingFeePct()}% markup). Report outcomes free at \`POST /api/decide/feedback\`.` : ""}
- [/api/index](${baseUrl}/api/index): the seller index, PAGINATED - one page, 250 max, never the whole set. The response says so: complete false, a Link header with rel=next, and sellerCount for the total. For ONE origin use ?seller=<host>, which pages nothing and returns its full row with crawl history
- [/api/leaderboard](${baseUrl}/api/leaderboard): public on-chain ranking of x402 sellers by Base USDC settled volume, served as the TOP N and never the whole board - 25 rows by default, 50 the ceiling, and \`totalSellers\` carries how many are ranked in all, so a seller you cannot see in the rows may simply rank below them. Only sellers that SETTLED inside \`windowServed\` rank at all (pipeline: Bazaar discovery → \`eth_getLogs\` on Base USDC → per-call ceiling filter, reported as \`maxCallUsd\` → aggregate by payTo; params \`?sort=usd|calls\`, \`?top=N\`, \`?include=external|all\`) - same data as the MCP tool \`sellers.list\` and the \`agent402-client\` SDK method \`topSellers()\`
- [/api/mpp-index](${baseUrl}/api/mpp-index): the MPP seller index (live-verified WWW-Authenticate: Payment sellers with the payment offers their real 402 makes: method, recipient, currency, chain)
- [/api/mpp-leaderboard](${baseUrl}/api/mpp-leaderboard): on-chain ranking of MPP sellers by inbound USDC.e transfers on Tempo to their live recipient (window, distinct payers, volume; \`routable\` = the router will pay them)
- [/.well-known/x402](${baseUrl}/.well-known/x402): one-fetch service manifest (identity, payment options, capability map, MCP, trust signals)
- [/.well-known/agent-card.json](${baseUrl}/.well-known/agent-card.json): our A2A AgentCard (also at /.well-known/agent.json) - name, skills, transport. It declares HTTP+JSON rather than the spec's default JSONRPC because that is what we actually serve
- [/.well-known/agent-registration.json](${baseUrl}/.well-known/agent-registration.json): our ERC-8004 registration file. The identity is agent 94639 in the registry at eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432, owned by the wallet our 402s name as payTo, and the file lists every way to reach us with x402Support declared
- [/api/reliability](${baseUrl}/api/reliability): structured reliability / SLA report with a verification URL per claim
- [/api/pricing](${baseUrl}/api/pricing): machine-readable catalog (every endpoint, price, category, docs URL)
- [/openapi.json](${baseUrl}/openapi.json): full OpenAPI 3.1 spec with input / output schemas for every tool
- [/api/wishes](${baseUrl}/api/wishes): the demand board, aggregated; request a tool we do not have yet with \`POST /api/wish\` (clustered by demand; repeated asks get built)
- [/terms](${baseUrl}/terms): terms of service + acceptable-use policy - using the service (including programmatically) constitutes acceptance
- [/health](${baseUrl}/health): health check

## Connect via MCP
- [Hosted MCP connector](${baseUrl}/mcp): flagship-first remote MCP (search/answer/render/data/transcribe/memory + catalog.find / catalog.call for the 500+ long tail). Install one-liners:
  - Claude Code: \`claude mcp add --transport http agent402 ${baseUrl}/mcp\`
  - Cursor: add to \`~/.cursor/mcp.json\` → \`{"mcpServers":{"agent402":{"url":"${baseUrl}/mcp"}}}\`
  - Smithery: listed at https://smithery.ai/servers/mike-kq9d/agent402 (paste \`${baseUrl}/mcp\` at https://smithery.ai/new)
  - Every host, verified config blocks (Claude Code, Cursor, VS Code, Windsurf, Cline, Roo Code, OpenAI Codex CLI, Gemini CLI, Continue, ElizaOS, Bedrock AgentCore, any OpenAI or Anthropic SDK): [/guides/agent-hosts](${baseUrl}/guides/agent-hosts). Shortlinks: agent402.sh/claude, /cursor, /vscode, /windsurf, /cline, /roo, /codex, /gemini. Install script: \`curl -fsSL agent402.sh/install | sh\`
- [agent402-mcp](https://www.npmjs.com/package/agent402-mcp): npm MCP server with payment underneath (\`npx -y agent402-mcp\`, optional \`AGENT_KEY\` for USDC via x402 or \`AGENT402_CREDITS_KEY\` for a prepaid credits key already issued). Claude Code: \`claude mcp add agent402 -s user -- npx -y agent402-mcp@latest\`

## Framework adapters (zero-dependency npm)
- [agent402-openai-tools](https://www.npmjs.com/package/agent402-openai-tools): OpenAI function-calling (chat.completions / Assistants / Responses)
- [agent402-anthropic-tools](https://www.npmjs.com/package/agent402-anthropic-tools): Anthropic Messages API \`tool_use\`
- [agent402-ai-sdk](https://www.npmjs.com/package/agent402-ai-sdk): Vercel AI SDK (\`streamText\` / \`generateText\`)
- [agent402-langchain](https://www.npmjs.com/package/agent402-langchain): LangChain JS / LangGraph
- [agent402-llamaindex](https://www.npmjs.com/package/agent402-llamaindex): LlamaIndex TS
- [agent402-google-adk](https://www.npmjs.com/package/agent402-google-adk): Google ADK (Gemini agents)
- [agent402-strands](https://www.npmjs.com/package/agent402-strands): AWS Strands agent runtime
- [agent402-agentkit](https://www.npmjs.com/package/agent402-agentkit): Coinbase AgentKit action provider (CDP, Privy, ZeroDev, viem wallets)

## Skill packs (a whole job, one payment)
${packItems}

## Settlement chains
${chainItems}

${toolSections}

## Optional
- [GitHub repository](${REPO_URL}): full source, AGPL-3.0, self-hostable
- [agent402-tollbooth](${baseUrl}/tollbooth): open-source, self-hostable x402 pay-per-crawl gate for your own site
- [Skill packs JSON](${baseUrl}/api/skill-packs.json): machine-readable pack index
- [Tool docs](${baseUrl}/tools): human-readable documentation per tool
- [Security](${baseUrl}/security): disclosure policy with safe harbor, what data is held, key handling, controls in the serving path and on the code
- [Company](${baseUrl}/company): Havok Holdings LLC, what it sells, where the proof is, role mailboxes
- [Weekly digest](${baseUrl}/digest): one email a week with what a wallet or credits key spent here (calls, dollars, tools, chains); double opt-in, signed unsubscribe
- [Markets](${baseUrl}/markets): the keyless crypto market-data calls (market pulse, perps, options, DeFi, stablecoins, news, indicators) with one curl to copy
- [Prepaid credits](${baseUrl}/credits): not on sale; a key already issued pays any paid tool except the wallet-scoped ones with the header "Authorization: Bearer a402_..." (debited per call on success; balance at GET /api/credits/balance)
- [Agentic Finance](${baseUrl}/agentic-finance): what the category is and where Agent402 sits in it
- [Test your x402 client](${baseUrl}/x402-test): point any client at a real paid route and read why it was refused - which field differs from what was advertised, which schemes and networks are offered, whether the amount or the validity window is wrong. Refusals are free (an error status cancels settlement); every reason this server emits is listed there
- [x402 & MPP 101](${baseUrl}/101): the ten-minute walkthrough for people new to the space - plain language, speaker notes, and a live demo (402 quote decoded, pay with a puzzle, real receipts)
- [Glossary](${baseUrl}/glossary): x402, MPP, HTTP 402, facilitator, EIP-3009, receipts, settlement, rails, dual-stack, PoW tier, SOR, tollbooth - every term defined once, with anchors
- [What is x402?](${baseUrl}/what-is-x402) / [What is MPP?](${baseUrl}/what-is-mpp): the two payment wires explained
- [Learn](${baseUrl}/learn): explainers with real headers - [x402](${baseUrl}/learn/x402), [HTTP 402](${baseUrl}/learn/http-402), [MPP](${baseUrl}/learn/mpp), [agent payments](${baseUrl}/learn/agent-payments), [pay-per-call APIs](${baseUrl}/learn/pay-per-call-api), [payments over MCP](${baseUrl}/learn/mcp-payments)
- [Integrations](${baseUrl}/integrations): one page per published package (framework adapters, MCP server, buyer SDK, tollbooth, OpenClaw provider) with install line, example and payment modes
- [llms-full.txt](${baseUrl}/llms-full.txt): this file plus every catalog route (slug, method, route, price, one-line description) and the learn summaries
- [Maintainer](${REPO_URL}): Havok Holdings LLC, mike@agent402.tools
`;
}

/** /llms-full.txt: /llms.txt plus the WHOLE catalog, one line per route
 *  (slug, method + path, price, first sentence of the description), and the
 *  /learn summaries. Generated from the live catalog on each request, so a new
 *  or retired tool shows up or drops out with no edit here. */
export function llmsFullTxt(baseUrl, catalog) {
  const tools = toolList(catalog).slice().sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const firstSentence = (d) => {
    const t = String(d || "").replace(/\s+/g, " ").trim();
    const m = t.match(/^(.{20,240}?[.!?])(\s|$)/);
    return m ? m[1] : t.slice(0, 240);
  };
  const catalogLines = tools.map((t) => `- ${t.slug} | ${t.method} ${t.path} | ${t.price || "see /api/pricing"} | ${firstSentence(t.description)}`).join("\n");
  const learnLines = LEARN.map((l) => `- [${l.term}](${baseUrl}/learn/${l.slug}): ${l.summary}`).join("\n");
  return `${llmsTxt(baseUrl, catalog)}
## Learn (summaries)

${learnLines}

## Full catalog

Every priced route on ${baseUrl}, one per line: slug | method and path | price per call | description. Input and output schemas for each are in ${baseUrl}/openapi.json; a call without payment answers HTTP 402 with the same price in its headers.

${catalogLines}
`;
}
