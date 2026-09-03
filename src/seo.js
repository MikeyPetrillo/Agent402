import { whyPointsPlain } from "./why.js";
import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable, POW_DIFFICULTY } from "./pow.js";
import { guideSlugs } from "./guides.js";
import { skillSlugs, SKILL_PACKS, PACK_PRICES } from "./skills.js";
import { BLOG_POSTS } from "./blog.js";
import { ADAPTERS } from "./adapter-docs.js";
import { RAILS, RAILS_OR } from "./rails.js";
import { CHAIN_PAGES } from "./market-page.js";
import { EXEC_TIERS } from "./tools/route-execute.js";
import { stripeEnabled } from "./mpp-stripe.js";
import { seededProgrammaticPaths } from "./programmatic-seeds.js";
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";
import { priceUsdFor } from "./report-tiers.js";
import { samplePaths } from "./sample-reports.js";
import { listPublicReports } from "./human-checkout.js";

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
    "Disallow: /api/convert/",
  ].join("\n");
  const blocks = agents.map((a) => `User-agent: ${a}\nAllow: /\n${costly}`).join("\n\n");
  return `${blocks}

User-agent: *
Allow: /
Disallow: /api/memory
Disallow: /__operator
Disallow: /r/
Disallow: /m/
Disallow: /monitors/thanks
Disallow: /monitors/manage
Disallow: /credits/thanks
Disallow: /api/r/
Disallow: /api/m/
Disallow: /api/credits/
Disallow: /api/convert/
Disallow: /api/monitors/
Disallow: /api/pow/
Disallow: /api/buy
${costly}

# Machine-readable catalogs for agents: ${baseUrl}/SKILL.md , ${baseUrl}/llms.txt , ${baseUrl}/openapi.json , ${baseUrl}/api/pricing , ${baseUrl}/api/cacheable , ${baseUrl}/.well-known/x402 , ${baseUrl}/api/reliability , ${baseUrl}/api/find?q={task} , ${baseUrl}/api/route , ${baseUrl}/api/leaderboard
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
    { loc: `${baseUrl}/credits`, priority: "0.8" },
    { loc: `${baseUrl}/shop`, priority: "0.9" },
    // Every x402 marketplace page (one per CHAIN_PAGES entry) - new chain
    // page = new sitemap entry, zero edits here.
    ...Object.keys(CHAIN_PAGES).map((key) => ({ loc: `${baseUrl}/${key}`, priority: "0.8" })),
    { loc: `${baseUrl}/faq`, priority: "0.8" },
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
    { loc: `${baseUrl}/analytics`, priority: "0.7" },
    { loc: `${baseUrl}/api/analytics`, priority: "0.6" },
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
    { loc: `${baseUrl}/markets`, priority: "0.8" },
    { loc: `${baseUrl}/digest`, priority: "0.6" },
    { loc: `${baseUrl}/security`, priority: "0.7" },
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
  const entries = [...staticUrls, ...programmaticUrls(baseUrl), ...guideUrls, ...skillUrls, ...toolUrls]
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
export function sitemapIndex(baseUrl) {
  const lastmod = BOOT_DATE;
  const subs = ["sitemap-pages.xml", "sitemap-reports.xml", "sitemap-tools.xml", "sitemap-guides.xml", "sitemap-skills.xml"];
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
    { loc: `${baseUrl}/credits`, priority: "0.8" },
    { loc: `${baseUrl}/shop`, priority: "0.9" },
    { loc: `${baseUrl}/quickstart`, priority: "0.9" },
    { loc: `${baseUrl}/what-is-x402`, priority: "0.9" },
    { loc: `${baseUrl}/what-is-mpp`, priority: "0.9" },
    { loc: `${baseUrl}/agentic-finance`, priority: "0.9" },
    { loc: `${baseUrl}/why`, priority: "0.8" },
    { loc: `${baseUrl}/markets`, priority: "0.8" },
    { loc: `${baseUrl}/digest`, priority: "0.6" },
    { loc: `${baseUrl}/security`, priority: "0.7" },
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
    { loc: `${baseUrl}/analytics`, priority: "0.7" },
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
    { loc: `${baseUrl}/contact`, priority: "0.5" },
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

export function llmsTxt(baseUrl, catalog) {
  const tools = toolList(catalog);
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
      return `- [${p.title}](${baseUrl}/skills/${p.slug}): ${p.tagline} (\`${p.slug}\`, ${p.toolSlugs.length} tools in one call: \`POST ${baseUrl}/api/skill/${p.slug}\`, $${price.toFixed(price < 0.1 ? 3 : 2)}, one x402 payment)`;
    })
    .join("\n");

  const chainItems = Object.entries(CHAIN_PAGES)
    .map(([key, c]) => `- [${c.chainName}](${baseUrl}/${key}): ${c.asset} via ${c.facilitatorLabel} (\`${c.caip2}\`)`)
    .join("\n");

  return `# Agent402.Tools

> Pay-per-call web tools for AI agents, payable over **x402 or MPP** - the applied layer of Agentic Finance: agents that pay and get paid on their own (explainer: /agentic-finance). **First job: search the web and answer questions** (\`/api/search\`, \`/api/answer\`, \`/api/search-news\`) - then the long catalog of 500+ tools via \`/api/find\`: deterministic utilities, a metered model gateway on the OpenAI and Anthropic wires (\`POST /v1/metered/chat/completions\`, \`POST /v1/metered/messages\`) and finished report products. Call an endpoint, receive an HTTP 402 carrying both offers (x402 PAYMENT-REQUIRED and MPP WWW-Authenticate: Payment), and settle from your own wallet - USDC via x402, or MPP on Base/Celo (USDC) or Tempo (USDC.e or PathUSD, native)${stripeEnabled() ? ", or by **card** on premium tools >= $0.50 (Stripe Shared Payment Token over MPP stripe/charge - no wallet, no stablecoin)" : ""} - or, on ${powCount} of the ${tools.length} tools, pay with proof-of-work (CPU) and skip the wallet entirely. No human, no signup, no API key: the payment is the identity (optional: a prepaid card-credits key, see below). Flat per-call prices from $0.001 - most tools $0.001–$0.02, with premium AI, media and multi-tool packs higher (up to $1.50); every price is in /api/pricing and quoted in the 402.

Base URL: ${baseUrl}

**Open source and two-sided.** Agent402 is the open-source, self-hostable applied layer of Agentic Finance (agents paying and getting paid on their own) for x402 and MPP (+ MCP server): 500+ pay-per-call tools for agents to buy (live web search + cited answers, browser rendering, PDFs, OCR, images, live financial / crypto / macro data, SEC EDGAR, wallet-keyed memory, a metered model gateway, finished reports), a neutral cross-seller index and on-chain leaderboard for the whole x402 ecosystem, and \`agent402-tollbooth\` for API sellers to charge AI crawlers per request. Maintainer: Havok Holdings LLC. Read every line and run it yourself: https://github.com/MikeyPetrillo/Agent402

**Why pay here (seven first-party differences, each proven on a live surface - full page: /why).** ${whyPointsPlain().map((line, i) => `(${i + 1}) ${line}`).join(" ")} Metered usage pricing: \`POST /v1/metered/chat/completions\` quotes each request from its body; prepaid card credits: /credits; finished reports and monitors: /reports and /monitors; buying on your behalf: \`POST /api/route/execute\`; proof: /status and /revenue.

**This is machine-to-machine commerce, and you can verify it.** Run the full loop with no human and no funds - \`node scripts/demo-payment.js\` discovers the catalog, gets quoted over HTTP 402, pays with compute, and uses the result. Every USDC call settles on-chain to agent402.base.eth on Base, verifiable on Basescan; live economy stats are at ${baseUrl}/api/stats and a machine-readable reliability report (each claim with a verification URL) at ${baseUrl}/api/reliability.

**Why agents use this instead of building it themselves.** You cannot sign up for anything: the useful web hides behind signups, captchas, API keys, and credit cards, none of which an autonomous agent can obtain - every capability here needs only the credential an agent already holds (its wallet, or its CPU). Capabilities your sandbox lacks (a headless browser, network egress, durable disk) are here because agents cannot self-host them mid-task. State survives the session and even crosses owners via wallet-keyed \`/api/memory\`. One x402-wrapped fetch (or the MCP server) covers the whole catalog - deterministic outputs, flat per-call prices, tested before every deploy, billed verifiably on-chain.

**No wallet? Pay with compute (proof-of-work).** ${powCount} of the ${tools.length} tools accept a sha256 proof-of-work puzzle (a fraction of a second of CPU) instead of USDC - no money and no AI tokens (no model in the serving path of these tools). Get a challenge at \`${baseUrl}/api/pow/challenge?slug=hash\`, find an integer nonce so that \`sha256(challenge + ":" + nonce)\` has at least ${POW_DIFFICULTY} leading zero bits, then resend the request with header \`X-Pow-Solution: <token>:<nonce>\`. **The response has two different fields and you use both: hash the \`challenge\` (32 hex chars), submit the \`token\` (the longer signed string).** Submitting the challenge you just hashed returns a 402 that looks exactly like an unpaid request, so this is the one step worth reading twice. The network / browser / storage tools that need wallet-bound identity or live egress stay wallet-only.

**Pay with USDC (x402).** Wrap fetch with \`@x402/fetch\`, register the exact EVM scheme with your signer, and call normally - the 402 is decoded, paid, and the result returned. Settlement uses ${RAILS_OR}; gas is sponsored by the facilitator on EVM chains, so callers need only hold the stablecoin. Send an \`Idempotency-Key\` header for safe retries: replaying the same key with the same payment/PoW credential returns the original result without paying again.

**No wallet, need the paid tools? Pay with prepaid card credits.** Buy $20, $50 or $100 at ${baseUrl}/credits (card, no account), get an a402_ key once, and send it as \`Authorization: Bearer a402_...\` on any paid tool - the list price is held before the call and debited only on a successful (200) response; \`X-Credits-Balance\` rides on every answer and \`GET ${baseUrl}/api/credits/balance\` reports the key. agent402-mcp (AGENT402_CREDITS_KEY) and agent402-client ({ creditsKey }) support it. Identity-bound tools (memory, my-usage) still need an x402 wallet - the payment is the identity there.

${reportsParagraph(baseUrl, tools)}

**Crypto derivatives, DeFi and Solana intel.** Live perpetuals and options, no exchange account: \`POST /api/perp-markets\` ($0.003) snapshots every listed perp, \`POST /api/perp-funding\` ($0.003) and \`POST /api/perp-funding-screener\` ($0.003) read funding rates now and across the book, and \`POST /api/perp-basis\` ($0.003), \`POST /api/perp-open-interest\` ($0.002), \`POST /api/perp-klines\` ($0.003) and \`POST /api/perp-orderbook\` ($0.002) cover premium, OI, candles and depth; the options book is \`POST /api/options-summary\` ($0.005), \`POST /api/crypto-options-chain\` ($0.004), \`POST /api/options-ticker\` ($0.002) and \`POST /api/options-volume\` ($0.002). DeFi: \`POST /api/defi-yields\` ($0.003) screens pools by chain, project and TVL, with \`POST /api/defi-protocols\` ($0.003), \`POST /api/defi-protocol\` ($0.002), \`POST /api/defi-chains\` ($0.002), \`POST /api/defi-fees\` ($0.003), \`POST /api/defi-dex-volume\` ($0.003), \`POST /api/stablecoins\` ($0.003) and history siblings for pools, chains and stablecoin supply. Solana: \`POST /api/sol-token-safety\` ($0.005) grades a mint (authorities, liquidity, holder concentration), \`POST /api/sol-token-report\` ($0.010) is the full risk write-up, and \`POST /api/sol-token-holders\` ($0.005), \`POST /api/sol-token-pairs\` ($0.003), \`POST /api/sol-trending\` ($0.003), \`POST /api/sol-price\` ($0.002), \`POST /api/sol-swap-quote\` ($0.003) and \`POST /api/sol-token-lookup\` ($0.002) cover concentration, pairs, trending, prices and routing. Market context: \`POST /api/crypto-news\` ($0.004), \`POST /api/crypto-indicators\` ($0.005), \`POST /api/crypto-market-pulse\` ($0.004), \`GET /api/coin-profile\` ($0.008), \`GET /api/coin-price-by-contract\` ($0.005) and \`GET /api/coin-ohlc\` ($0.008). Raw chain reads: \`POST /api/asset-transfers\` ($0.003), \`POST /api/token-balances\` ($0.002), \`POST /api/tx-receipt\` ($0.003) and \`POST /api/token-price-history\` ($0.004). Whole-site structure on demand: \`POST /api/site-map\` ($0.005) and \`POST /api/site-crawl\` ($0.02).

**Images and video, flat per call.** Text-to-image and text-to-video on the OpenAI wire, priced per picture or per clip rather than per token: \`POST /v1/images/fast\` ($0.02, budget), \`POST /v1/images/pro\` ($0.05, higher fidelity), \`POST /v1/images/generations\` ($0.08, flagship) and \`POST /v1/videos/generations\` ($0.20, one silent 4-second 720p clip, MP4 inline base64). Point any OpenAI SDK at base_url ${baseUrl}/v1 and call the path you want; a failed or timed-out generation is never charged.

**A failed call is not charged - structurally, and you can check it per response rather than trust us.** Settlement runs AFTER the tool handler and only completes for a successful (under-400) response: an error, a capacity 503, or an upstream 502 cancels settlement inside the payment middleware itself, so no money moves and there is nothing to claim.

Determine it from the response you already hold, without asking us:

- **No \`PAYMENT-RESPONSE\` header** - nothing settled. You were not charged. Safe to retry.
- **\`PAYMENT-RESPONSE\` present, receipt \`success: false\`** - settlement was attempted and REJECTED (a facilitator declining produces a 402 with this shape). You were not charged. Safe to retry with a fresh authorization.
- **\`PAYMENT-RESPONSE\` present, receipt not \`success: false\`, status under 400** - charged and served. Normal.
- **\`PAYMENT-RESPONSE\` present, receipt not \`success: false\`, status 400 or above** - the residual case: a settlement completed without a successful response. Do NOT blind-retry; this is the one shape where money may have moved without service. We count and alarm on it as an incident rather than claim it cannot happen.

Every x402 authorization is single-use, so any retry needs a fresh signature. Send an \`Idempotency-Key\` header and a retry of an already-served paid call replays the original result instead of charging again.

We state it this way deliberately: the honest guarantee is "settlement ordering makes an error non-chargeable, and here is how to verify it yourself", not "this can never happen". A contract you can check beats one you have to believe.

**MPP clients are first-class (dual-stack), and now a native second method too.** Every paid endpoint also speaks MPP (Machine Payments Protocol, the IETF-track \`Payment\` HTTP auth scheme): the same 402 carries a \`WWW-Authenticate: Payment\` challenge with TWO offers - \`evm\` charge (EIP-3009 USDC, settles on-chain identically to x402) and \`tempo\` charge (native TIP-1034/TIP-20, settled via Tempo's own relay, a genuinely different mechanism). Settled responses return a signed \`Payment-Receipt\` header either way. An \`mppx\` client (\`Fetch.from\` with \`evm.charge\` or \`tempo.charge\`) works out of the box - same URL, same price, whichever method your client speaks. The hosted MCP connector at \`${baseUrl}/mcp\` pays the same way: a wallet-only tool answers JSON-RPC error -32042 with the challenges, and an MCP client wrapped with mppx's \`McpClient.wrap()\` pays and retries on its own (receipt in \`_meta\`).

**How to read our 402 if you only speak one dialect.** The same response carries BOTH headers, always - \`WWW-Authenticate: Payment\` is additive, never a replacement for the real x402 \`PAYMENT-REQUIRED\` header (full \`accepts\` array, \`exact\` scheme, EIP-3009). A client that hard-fails on an unrecognized \`WWW-Authenticate\` scheme instead of also checking for \`PAYMENT-REQUIRED\` will bail with something like "no supported rail" on a 402 it could have paid - this has happened at least once (see issue #794). If your parser only understands one of the two dialects, check for the header it understands FIRST rather than trusting whichever header happens to be read first; do not treat an unrecognized \`WWW-Authenticate\` scheme as "this server has no payment option for me."

## Key machine surfaces
- [/SKILL.md](${baseUrl}/SKILL.md): agent-onboarding skill sheet - setup (MCP server / SDK / plain HTTP), discover, pay (x402, MPP or proof-of-work), read the 402, common issues. Start here if you are setting Agent402 up for the first time
- [/api/search](${baseUrl}/api/search): **front door** - live web search (title, URL, snippet). Start here to discover pages; follow with extract or answer
- [/api/answer](${baseUrl}/api/answer): **front door** - cited answer grounded in live web search results
- [/api/search-news](${baseUrl}/api/search-news): live news search for current events / headlines
- [/api/find](${baseUrl}/api/find): resolve a plain-language task to the best-matching tools with route, price, input schema, and a ready example (GET \`?q={task}\` or POST \`{"task":"..."}\`) - long-tail discovery behind the flagships
- [/api/route](${baseUrl}/api/route): Smart Order Router - rank tools across every x402 seller crawled from public registries; \`include:"external"\` excludes Agent402 for neutral cross-seller discovery
- [/api/route/execute](${baseUrl}/api/route/execute): the SOR that also PAYS. Send a task, and Agent402 resolves the best-matching tool, pays the seller over x402 on your behalf (any proven seller in the open index, not just ours), and relays the result with a receipt - one payment, one request, one wallet. You never hold a wallet on their chain or sign up with them. \`{"task":"...","include":"external"}\`. Proportional tiers: ${execTierSentence} - an over-cap task gets a self-correcting 409 naming the tier that fits
- [/api/index](${baseUrl}/api/index): JSON snapshot of every seller indexed (health, routable flag, crawl history)
- [/api/leaderboard](${baseUrl}/api/leaderboard): public on-chain ranking of x402 sellers by Base USDC settled volume (pipeline: Bazaar discovery → \`eth_getLogs\` on Base USDC → per-call ceiling filter → aggregate by payTo; params \`?sort=usd|calls\`, \`?top=N\`, \`?include=external|all\`) - same data as the MCP tool \`sellers.list\` and the \`agent402-client\` SDK method \`topSellers()\`
- [/api/mpp-index](${baseUrl}/api/mpp-index): the MPP seller index (live-verified WWW-Authenticate: Payment sellers with the payment offers their real 402 makes: method, recipient, currency, chain)
- [/api/mpp-leaderboard](${baseUrl}/api/mpp-leaderboard): on-chain ranking of MPP sellers by inbound USDC.e transfers on Tempo to their live recipient (window, distinct payers, volume; \`routable\` = the router will pay them)
- [/.well-known/x402](${baseUrl}/.well-known/x402): one-fetch service manifest (identity, payment options, capability map, MCP, trust signals)
- [/api/reliability](${baseUrl}/api/reliability): structured reliability / SLA report with a verification URL per claim
- [/api/pricing](${baseUrl}/api/pricing): machine-readable catalog (every endpoint, price, category, docs URL)
- [/openapi.json](${baseUrl}/openapi.json): full OpenAPI 3.1 spec with input / output schemas for every tool
- [/api/wishes](${baseUrl}/api/wishes): request a tool we do not have yet (clustered by demand; repeated asks get built)
- [/terms](${baseUrl}/terms): terms of service + acceptable-use policy - using the service (including programmatically) constitutes acceptance
- [/health](${baseUrl}/health): health check

## Connect via MCP
- [Hosted MCP connector](${baseUrl}/mcp): flagship-first remote MCP (search/answer/render/data/transcribe/memory + catalog.find / catalog.call for the 500+ long tail). Install one-liners:
  - Claude Code: \`claude mcp add --transport http agent402 ${baseUrl}/mcp\`
  - Cursor: add to \`~/.cursor/mcp.json\` → \`{"mcpServers":{"agent402":{"url":"${baseUrl}/mcp"}}}\`
  - Smithery: listed at https://smithery.ai/servers/mike-kq9d/agent402 (paste \`${baseUrl}/mcp\` at https://smithery.ai/new)
  - Every host, verified config blocks (Claude Code, Cursor, VS Code, Windsurf, Cline, Roo Code, OpenAI Codex CLI, Gemini CLI, Continue, ElizaOS, Bedrock AgentCore, any OpenAI or Anthropic SDK): [/guides/agent-hosts](${baseUrl}/guides/agent-hosts). Shortlinks: agent402.sh/claude, /cursor, /vscode, /windsurf, /cline, /roo, /codex, /gemini. Install script: \`curl -fsSL agent402.sh/install | sh\`
- [agent402-mcp](https://www.npmjs.com/package/agent402-mcp): npm MCP server with payment underneath (\`npx -y agent402-mcp\`, optional \`AGENT_KEY\` for USDC via x402 or \`AGENT402_CREDITS_KEY\` for prepaid card credits). Claude Code: \`claude mcp add agent402 -s user -- npx -y agent402-mcp@latest\`

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
- [GitHub repository](https://github.com/MikeyPetrillo/Agent402): full source, AGPL-3.0, self-hostable
- [agent402-tollbooth](${baseUrl}/tollbooth): open-source, self-hostable x402 pay-per-crawl gate for your own site
- [Skill packs JSON](${baseUrl}/api/skill-packs.json): machine-readable pack index
- [Tool docs](${baseUrl}/tools): human-readable documentation per tool
- [Security](${baseUrl}/security): disclosure policy with safe harbor, what data is held, key handling, controls in the serving path and on the code
- [Company](${baseUrl}/company): Havok Holdings LLC, what it sells, where the proof is, role mailboxes
- [Weekly digest](${baseUrl}/digest): one email a week with what a wallet or credits key spent here (calls, dollars, tools, chains); double opt-in, signed unsubscribe
- [Markets](${baseUrl}/markets): the keyless crypto market-data calls (market pulse, perps, options, DeFi, stablecoins, news, indicators) with one curl to copy
- [Prepaid card credits](${baseUrl}/credits): no wallet? buy $20-$100 of credits by card, then call any paid tool with the header "Authorization: Bearer a402_..." (debited per call on success; balance at GET /api/credits/balance)
- [Agentic Finance](${baseUrl}/agentic-finance): what the category is and where Agent402 sits in it
- [x402 & MPP 101](${baseUrl}/101): the ten-minute walkthrough for people new to the space - plain language, speaker notes, and a live demo (402 quote decoded, pay with a puzzle, real receipts)
- [Glossary](${baseUrl}/glossary): x402, MPP, HTTP 402, facilitator, EIP-3009, receipts, settlement, rails, dual-stack, PoW tier, SOR, tollbooth - every term defined once, with anchors
- [What is x402?](${baseUrl}/what-is-x402) / [What is MPP?](${baseUrl}/what-is-mpp): the two payment wires explained
- [Maintainer](https://github.com/MikeyPetrillo/Agent402): Havok Holdings LLC, mike@agent402.tools
`;
}
