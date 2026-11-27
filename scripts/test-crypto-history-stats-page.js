#!/usr/bin/env node
// /crypto-history-stats-api, the page written for the searches for a crypto
// history API. It promotes only the routes whose answers are computed here
// from a coin's past prices, and says what they are: statistics, not a price
// series. Pinned here: 200, its title, description and canonical; a short lead
// and body; the source's credit with its link, the non-affiliation line and
// the not-advice line; each route at its catalog price with its published
// example input; no figure from an answer and no route that returns a series;
// the sitemap, /llms.txt and its links.
//
//   node scripts/test-crypto-history-stats-page.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";
import { stripTags } from "./lib/html-text.js";

const SITE = "https://agent402.tools";
const PATH = "/crypto-history-stats-api";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const decode = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const titleOf = (html) => decode((html.match(/<title>([^<]*)<\/title>/) || [])[1] || "");
const canonOf = (html) => (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1] || null;
const descOf = (html) => decode((html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "");
const mainOf = (html) => { const start = html.indexOf('class="sl-wrap"'); const end = html.indexOf("<footer", start); return html.slice(start, end > start ? end : undefined); };
/** The page's own prose: the main column with code blocks, scripts and styles removed. */
const proseOf = (html) => decode(stripTags(mainOf(html).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<pre[\s\S]*?<\/pre>/g, " "), " ")).replace(/\s+/g, " ").trim();
const words = (s) => s.split(/\s+/).filter(Boolean).length;

// PORT=0, the bound port read back: no port is picked before the server binds it.
const srv = await bootServer({
  stores: "crypto-history-stats-page",
  env: { FREE_MODE: "true", BASE_URL: SITE, X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0" },
});
const get = async (p) => { const r = await fetch(`${srv.url}${p}`, { redirect: "manual" }); return { status: r.status, text: await r.text() }; };

try {
  const pricing = JSON.parse((await get("/api/pricing")).text);
  const bySlug = new Map(pricing.endpoints.map((e) => [e.slug, e]));
  const year = bySlug.get("token-diligence"), peg = bySlug.get("stablecoin-depeg-watch");
  ok(year && `${year.method} ${year.path}` === "POST /api/token-diligence" && year.modelBacked === false, "the catalog serves POST /api/token-diligence, not model-backed");
  ok(peg && `${peg.method} ${peg.path}` === "GET /api/stablecoin-depeg-watch" && peg.modelBacked === false, "the catalog serves GET /api/stablecoin-depeg-watch, not model-backed");

  const r = await get(PATH);
  ok(r.status === 200, `${PATH} answers 200 (${r.status})`);
  const html = r.text, main = mainOf(html), prose = proseOf(html);
  const title = titleOf(html), desc = descOf(html);
  ok(title === "Crypto history stats API: return and drawdown | Agent402" && title.length <= 60, `${PATH} carries its title, 60 characters at most (${title.length}: ${title})`);
  ok(desc.length >= 120 && desc.length <= 155, `${PATH} meta description is 120 to 155 characters (${desc.length})`);
  ok(/computed/.test(desc) && /Not a price feed\./.test(desc) && /Information only\./.test(desc), `${PATH} meta description says computed, not a price feed, information only (${desc})`);
  ok(canonOf(html) === `${SITE}${PATH}`, `${PATH} is canonical to itself (${canonOf(html)})`);
  const lead = decode(stripTags((html.match(/<p class="sl-lead">([\s\S]*?)<\/p>/) || [])[1] || "", " ")).replace(/\s+/g, " ").trim();
  ok(lead && words(lead) <= 50, `${PATH} lead is at most 50 words (${words(lead)})`);
  ok(words(prose) <= 1000, `${PATH} body is at most 1,000 prose words (${words(prose)})`);

  // What the page is allowed to promise: computed figures, never the series.
  ok(/not the price series behind them/.test(lead), `${PATH} lead says the routes do not return the price series`);
  ok(/They do not return candles, a price series or a coin's price on a past date/.test(prose), `${PATH} says what the routes do not return`);
  ok(!/historical data api/i.test(`${title} ${desc} ${prose}`), `${PATH} never calls itself a historical data API`);
  ok(!/consolidated/i.test(prose), `${PATH} does not say consolidated`);
  // The source's credit, with its link, in the body beside the routes, and once more under Source and use.
  const credit = 'Powered by <a href="https://www.coingecko.com/en/api" rel="noopener">CoinGecko</a>';
  ok(main.split(credit).length - 1 === 2, `${PATH} carries the linked credit twice (${main.split(credit).length - 1})`);
  ok(main.indexOf('<p class="sl-credit">') > 0 && main.indexOf('<p class="sl-credit">') < main.indexOf("<h2"), `${PATH} shows the credit before the first section`);
  ok(/Agent402 is not affiliated with or endorsed by CoinGecko\./.test(prose), `${PATH} says Agent402 is not affiliated with or endorsed by the source`);
  ok(/Information only, not investment advice\./.test(prose), `${PATH} says information only, not investment advice`);
  ok(/deterministic code, with no model in either route/.test(prose), `${PATH} scopes its no-model sentence to the two routes it names`);

  // Routes, catalog prices and published example inputs.
  ok(prose.includes(`POST /api/token-diligence costs ${year.price} a coin`), `${PATH} quotes token-diligence at its catalog price (${year.price})`);
  ok(prose.includes(`GET /api/stablecoin-depeg-watch costs ${peg.price} a call`), `${PATH} quotes stablecoin-depeg-watch at its catalog price (${peg.price})`);
  const quoted = [...prose.matchAll(/\$\d+(?:\.\d+)?/g)].map((m) => m[0]);
  const named = new Set([year.price, peg.price]);
  ok(quoted.length === 2 && quoted.every((q) => named.has(q)), `${PATH} quotes only those two catalog prices (${quoted.join(", ")})`);
  const { BUNDLE_TOOLS } = await import("../src/tools/bundle-kit.js");
  const { CRYPTO_SCREENS_TOOLS } = await import("../src/tools/crypto-screens-kit.js");
  const yDef = BUNDLE_TOOLS.find((t) => t.slug === "token-diligence"), pDef = CRYPTO_SCREENS_TOOLS.find((t) => t.slug === "stablecoin-depeg-watch");
  const code = decode(main);
  ok(code.includes(`curl -i -X POST ${SITE}/api/token-diligence`) && code.includes(`-d '${JSON.stringify(yDef.discovery.input)}'`), `${PATH} shows a curl of token-diligence's published example input`);
  ok(code.includes(`curl -i "${SITE}/api/stablecoin-depeg-watch?${new URLSearchParams(Object.entries(pDef.discovery.input).map(([k, v]) => [k, String(v)]))}"`), `${PATH} shows a curl of stablecoin-depeg-watch's published example input`);
  for (const f of ["return1yPct", "maxDrawdown1yPct", "volatilityAnnualizedPct", "candles", "maxDeviation24hBps", "maxDeviation7dBps", "method"]) ok(prose.includes(f), `${PATH} names the answer field ${f}`);
  // Both tools are cleared as computed answers; a tool marked a raw pass-through is never named.
  ok(yDef.resale === "computed" && yDef.resaleCleared === true && pDef.resale === "computed" && pDef.resaleCleared === true, "both routes are marked computed and cleared in their kits");
  const { CRYPTO_TOOLS } = await import("../src/tools/crypto-kit.js");
  const { CRYPTO_MARKETS_TOOLS } = await import("../src/tools/crypto-markets-kit.js");
  const { ALCHEMY_DATA_TOOLS } = await import("../src/tools/alchemy-data-kit.js");
  const { DERIVATIVES_TOOLS } = await import("../src/tools/derivatives-kit.js");
  const series = [...CRYPTO_TOOLS, ...CRYPTO_MARKETS_TOOLS].filter((t) => t.resale === "barred").map((t) => t.slug)
    .concat(ALCHEMY_DATA_TOOLS.map((t) => t.slug), DERIVATIVES_TOOLS.map((t) => t.slug), ["crypto-indicators"]);
  const namedSeries = series.filter((s) => new RegExp(`(^|[^a-z0-9-])${s}([^a-z0-9-]|$)`).test(code));
  ok(series.includes("crypto-history") && series.includes("coin-ohlc") && series.includes("token-price-history") && series.includes("perp-klines") && namedSeries.length === 0, `${PATH} names no route that passes a source's series through (${namedSeries.join(", ") || "none"})`);
  // No figure from an answer: outside the two prices, the request examples and
  // the fixed windows, the page prints no number with a decimal point or a percent.
  const figures = [...prose.matchAll(/-?\d+\.\d+|\d+(?:\.\d+)?%/g)].map((m) => m[0]).filter((n) => !named.has(`$${n}`));
  ok(figures.length === 0, `${PATH} prints no figure from an answer (${figures.join(", ") || "none"})`);

  const sitemaps = (await Promise.all(["/sitemap.xml", "/sitemap-pages.xml", "/sitemap-guides.xml"].map(get))).map((x) => x.text).join("\n");
  ok(sitemaps.includes(`<loc>${SITE}${PATH}</loc>`), `${PATH} is in the sitemap`);
  // The short index keeps what the page is and the credit; the full one adds the not-advice words.
  const lineOf = (text) => text.split("\n").find((l) => l.startsWith(`- [${PATH}](${SITE}${PATH})`)) || "";
  const short = lineOf((await get("/llms.txt")).text), full = lineOf((await get("/llms-full.txt")).text);
  const CREDIT = /Powered by CoinGecko \(https:\/\/www\.coingecko\.com\/en\/api\)/;
  ok(CREDIT.test(short) && /not a price series/.test(short), `${PATH} is listed in /llms.txt with what it is and the credit (${short})`);
  ok(CREDIT.test(full) && /not a price series/.test(full) && /information only, not investment advice/.test(full), `${PATH} is listed in /llms-full.txt with the credit and the not-advice words`);
  for (const href of ["/tools/token-diligence", "/tools/stablecoin-depeg-watch", "/insider-trades-api", "/start", "/how-to-pay"]) {
    ok(main.includes(`href="${href}"`), `${PATH} links ${href}`);
    ok((await get(href)).status === 200, `${href} answers 200`);
  }
  ok(mainOf((await get("/insider-trades-api")).text).includes(`href="${PATH}"`), `/insider-trades-api links ${PATH}`);
} finally {
  await srv.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
