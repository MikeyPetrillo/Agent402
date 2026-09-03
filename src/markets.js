// /markets - the front door for the keyless market-data tools.
//
// One page, one call to copy: crypto-market-pulse answers "what is the crypto
// market doing right now" in a single request, keyless, priced in tenths of a
// cent. Every other market-data tool (perps, options, signals, DeFi) is listed
// beneath it with its live price read from the catalog - never typed here, so
// the page cannot drift from /api/pricing (the rule test-price-prose enforces
// on the product pages). Deliberately narrow: an agent that lands here should
// leave with one curl, not a catalog.
import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Group definitions: slug order is the display order. Copy is what the tool
 *  RETURNS, not the upstream it reads - a buyer picks by answer, not by source. */
const GROUPS = [
  { id: "pulse", h: "Market pulse and signals", p: "Breadth, news and indicators for the whole market in one call each.",
    slugs: ["crypto-market-pulse", "crypto-news", "crypto-indicators"] },
  { id: "perps", h: "Perpetual futures", p: "Funding, open interest, basis, books and candles across every listed perp.",
    slugs: ["perp-markets", "perp-funding", "perp-funding-screener", "perp-open-interest", "perp-basis", "perp-orderbook", "perp-klines"] },
  { id: "options", h: "Options", p: "Chains, greeks, implied volatility and onchain options volume.",
    slugs: ["options-summary", "crypto-options-chain", "options-ticker", "options-volume"] },
  { id: "defi", h: "DeFi and stablecoins", p: "Yields, TVL, fees, DEX volume and stablecoin supply, current and historical.",
    slugs: ["defi-yields", "defi-yield-history", "defi-protocols", "defi-protocol", "defi-chains", "defi-chain-tvl-history", "stablecoins", "stablecoin-supply-history", "defi-fees", "defi-dex-volume"] },
];
export const MARKETS_HERO_SLUG = "crypto-market-pulse";
export const MARKETS_SLUGS = GROUPS.flatMap((g) => g.slugs);

const priceNum = (t) => Number(String(t?.price || "").replace("$", "")) || 0;
const fmtUsd = (n) => `$${n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;

/** Resolve the page's tools from the live catalog (route -> def). A slug that is
 *  not in the catalog is simply not rendered - a retired tool never leaves a
 *  dead card here. */
export function marketsTools(catalog) {
  const bySlug = new Map();
  for (const def of Object.values(catalog || {})) if (def?.slug) bySlug.set(def.slug, def);
  return MARKETS_SLUGS.map((s) => bySlug.get(s)).filter(Boolean);
}

export function marketsPage(baseUrl, catalog) {
  const tools = marketsTools(catalog);
  const bySlug = new Map(tools.map((t) => [t.slug, t]));
  const hero = bySlug.get(MARKETS_HERO_SLUG);
  const prices = tools.map(priceNum).filter((n) => n > 0);
  const lo = prices.length ? Math.min(...prices) : 0;
  const hi = prices.length ? Math.max(...prices) : 0;
  const canonical = `${baseUrl}/markets`;
  const title = "Crypto market data for agents, one call at a time";
  const description = `${tools.length} keyless market-data calls - perps, options, DeFi, stablecoins, news and indicators - ${fmtUsd(lo)} to ${fmtUsd(hi)} each, paid per request in USDC over x402 or MPP, or by card credits. No API key, no account.`;
  const heroPath = hero ? hero.route.split(" ")[1] : "/api/crypto-market-pulse";
  const heroInput = JSON.stringify(hero?.discovery?.input ?? { limit: 5 });
  const curl = `curl -X POST ${baseUrl}${heroPath} \\\n  -H "Content-Type: application/json" \\\n  -d '${heroInput}'`;

  const breadcrumbLd = { "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "Markets", item: canonical },
  ] };
  const listLd = { "@type": "ItemList", "@id": `${canonical}#list`, name: title, itemListElement: tools.map((t, i) => ({
    "@type": "ListItem", position: i + 1, name: t.name, description: t.description, url: `${baseUrl}/tools/${t.slug}`,
  })) };

  const extraCss = `
.mk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.mk-card{display:block;background:var(--card);border:1px solid var(--hairline);padding:16px 18px;text-decoration:none;color:var(--ink)}
.mk-card:hover{border-color:var(--accent)}
.mk-card .mk-name{font-family:var(--font-mono);font-size:13px;font-weight:700;margin:0 0 6px;display:flex;justify-content:space-between;gap:10px}
.mk-card .mk-price{color:var(--accent);font-weight:700;white-space:nowrap}
.mk-card p{font-size:13.5px;line-height:1.5;color:var(--muted);margin:0}
.mk-hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:34px;align-items:start}
@media (max-width:900px){.mk-hero{grid-template-columns:minmax(0,1fr)}}
.mk-pre{background:var(--surface);color:var(--on-dark);border:1px solid var(--hairline);padding:18px 20px;font-family:var(--font-mono);font-size:13px;line-height:1.6;overflow-x:auto;margin:0;white-space:pre}
`;

  const cardsHtml = (g) => g.slugs.map((s) => bySlug.get(s)).filter(Boolean).map((t) => `
      <a class="mk-card" href="/tools/${esc(t.slug)}">
        <div class="mk-name"><span>${esc(t.slug)}</span><span class="mk-price">${esc(t.price)}</span></div>
        <p>${esc(String(t.description || "").split(/(?<=\.)\s/)[0].slice(0, 180))}</p>
      </a>`).join("");
  const groupsHtml = GROUPS.map((g) => `
<section id="${g.id}" style="max-width:1180px;margin:0 auto;padding:40px 30px 0;">
  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
    <h2 style="font-weight:800;font-size:26px;line-height:1.1;letter-spacing:-.02em;margin:0;color:var(--ink);">${esc(g.h)}</h2>
    <p style="font-size:15px;color:var(--muted);margin:0;">${esc(g.p)}</p>
  </div>
  <div class="mk-grid">${cardsHtml(g)}</div>
</section>`).join("");

  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:22px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">markets</span>
    </nav>
    <div class="mk-hero">
      <div>
        <h1 style="font-weight:800;font-size:46px;line-height:.98;letter-spacing:-.035em;margin:0 0 18px;color:var(--ink);">The whole crypto market in one call.</h1>
        <p style="font-size:18px;line-height:1.55;color:var(--muted);margin:0 0 18px;">${esc(hero?.name || "Market pulse")} returns breadth, volume, open interest, funding extremes, the day's gainers and losers and BTC and ETH at a glance - one request, ${esc(hero?.price || "")}, no API key. ${tools.length - 1} more calls below cover perps, options, DeFi and stablecoins at ${esc(fmtUsd(lo))} to ${esc(fmtUsd(hi))} each.</p>
        <p style="font-size:14px;line-height:1.6;color:var(--muted);margin:0 0 22px;">Pay per request in USDC over <a href="/what-is-x402" style="color:var(--ink);">x402</a> or <a href="/what-is-mpp" style="color:var(--ink);">MPP</a> from any wallet, or by <a href="/credits" style="color:var(--ink);">card credits</a> with a Bearer key. The first call answers 402 with the price; the paid retry returns the data. A call that fails is never charged.</p>
        <div style="display:flex;gap:11px;flex-wrap:wrap;">
          <a href="/playground?slug=${esc(MARKETS_HERO_SLUG)}" style="background:var(--btn-bg);color:var(--btn-fg);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 22px;">TRY IT IN THE PLAYGROUND →</a>
          <a href="/tools/${esc(MARKETS_HERO_SLUG)}" style="border:1.5px solid var(--hairline);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:12px 22px;">DOCS + SAMPLE OUTPUT</a>
        </div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:8px;">the call</div>
        <pre class="mk-pre">${esc(curl)}</pre>
        <p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:10px 0 0;line-height:1.6;">Sources are public venue and aggregator feeds read live per call; nothing is cached across buyers longer than a minute. Every tool answers its own documented example in CI before it can ship.</p>
      </div>
    </div>
  </div>
</header>
${groupsHtml}
<section style="max-width:1180px;margin:0 auto;padding:48px 30px 56px;">
  <div style="background:var(--surface);border:1px solid var(--hairline);padding:40px 40px;">
    <h2 style="font-weight:800;font-size:30px;line-height:1.05;letter-spacing:-.025em;margin:0 0 12px;color:var(--on-dark);">Wire it into an agent.</h2>
    <p style="font-size:16px;line-height:1.6;color:var(--dk-muted2);margin:0 0 22px;max-width:640px;">Add the hosted MCP connector and these calls appear as tools, or call the routes directly with the x402 client of your choice. Every route here is also discoverable at /api/find by task ("funding rates", "stablecoin supply").</p>
    <div style="display:flex;gap:11px;flex-wrap:wrap;">
      <a href="/docs#add" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:14px 24px;">ADD TO YOUR AGENT →</a>
      <a href="/tools/category/crypto" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">EVERY CRYPTO TOOL</a>
      <a href="/credits" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">PREPAID CREDITS</a>
    </div>
  </div>
</section>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/markets", extraCss, jsonLd: [breadcrumbLd, listLd], body });
}
