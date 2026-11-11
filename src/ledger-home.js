// Machine Ledger: the home page ("Agent402 Ledger"), Aug 2026 revamp, trimmed
// 2026-11 to five blocks: hero (what it is, two actions, the live payments
// panel), the two doors (agents: endpoints, prices and the free tier; people:
// reports and monitors), three short claims with the chain marks, a two-line
// sell block, and a short FAQ. The full "Why pay here" rows and the comparison
// table live on /docs#why; the seller board on /leaderboard; the demand lanes
// on /tools/bestsellers; the proof-of-work demo on /playground.

import { siteOrgLd } from "./site-org.js";
import { ledgerShell, ledgerFooterCompact, esc, decideLive, sectionMeta, fmtNum } from "./ledger-chrome.js";
import { whyHomeClaims } from "./why.js";
import { decideConfig } from "./decide/config.js";
import { toolList } from "./pages.js";
import { RAILS, RAILS_SHORT } from "./rails.js";
import { CAIP2_NAMES } from "./stats.js";
import { chainMark, CHAIN_ORDER } from "./chain-logos.js";
import { routerPayChains } from "./tools/route-execute.js";
import { railKey, chainDisplayName } from "./rails.js";
import { tempoEnabled } from "./mpp-tempo.js";
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";
import { MAX_FULL_PER_SUB_30D } from "./monitor-scheduler.js";

import { REPO_URL } from "./repo-link.js";
import { powCostPhrase } from "./pow.js";
import { METERED_WIRES, meteredQuoteSentence, flatTiersLine } from "./metered-lead.js";
import { CATEGORY_LINE, leadSentence } from "./positioning.js";
// PRICES IN COPY ARE DERIVED, NEVER TYPED.
//
// These chips were hardcoded and went stale at the 2026-08-23 repricing: the
// homepage advertised "Dossier $1" against a $3 product, and "Monitor $3/mo"
// against $5. A visitor clicked a price we do not charge. The same class was
// caught in page meta descriptions the same week and fixed by deriving them;
// this is the instance that fix did not reach, because test-price-prose only
// reads a page's description, never its body.
const usd = (cents) => `$${Number(cents) % 100 === 0 ? Number(cents) / 100 : (Number(cents) / 100).toFixed(2)}`;
const cardCents = Object.values(HUMAN_PRODUCTS || {}).map((p) => Number(p?.price)).filter((n) => Number.isFinite(n) && n > 0);
const CARD_LO = cardCents.length ? Math.min(...cardCents) / 100 : 2;
const CARD_HI = cardCents.length ? Math.max(...cardCents) / 100 : 5;
const monCents = Object.values(MONITOR_PRODUCTS || {}).map((p) => Number(p?.price)).filter((n) => Number.isFinite(n) && n > 0);
const MON_USD = monCents.length ? Math.min(...monCents) / 100 : 5;
const usd0 = (n) => `$${Number(n).toFixed(0)}`;
// The AggregateOffer ceiling, read from the catalog rather than typed. It sat
// at a literal "1.50" while the real top price was $3.30 (route-execute-pro),
// so our structured data understated the range by more than half.
const maxPriceUsd = (catalog) => {
  const nums = Object.values(catalog || {}).map((t) => Number(String(t?.price ?? "").replace(/[^0-9.]/g, ""))).filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.max(...nums) : 1.5;
};
// The catalog's cheapest price, read the same way.
const minPriceUsd = (catalog) => {
  const nums = Object.values(catalog || {}).map((t) => Number(String(t?.price ?? "").replace(/[^0-9.]/g, ""))).filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? Math.min(...nums) : 0.001;
};
function cardPrice(product) {
  const p = HUMAN_PRODUCTS?.[product]?.price;
  return Number.isFinite(p) ? usd(p) : "";
}
function monitorPrice() {
  // Every monitor is the same price today; if that stops being true this reads
  // the cheapest, so the chip can never advertise less than we charge.
  const prices = Object.values(MONITOR_PRODUCTS || {}).map((m) => m?.price).filter(Number.isFinite);
  return prices.length ? usd(Math.min(...prices)) : "";
}

// A route's price as the catalog states it, or "" when the server does not
// serve that slug (the row then shows no figure rather than a typed one).
const slugPrice = (tools, slug) => String(tools.find((t) => t.slug === slug)?.price || "");

/** Real per-rail settlement counts, sorted by volume. Same CAIP2_NAMES join
 * as /what-is-x402's rails table - single source of truth, can't drift. */
export function railsByVolume(stats, { tempo = tempoEnabled() } = {}) {
  const byNet = stats?.toolCallsServed?.viaUSDCByNetwork || {};
  const rows = RAILS.map((r) => {
    const key = CAIP2_NAMES[r.caip2] || r.name.toLowerCase();
    const n = Number(byNet[key]) || 0;
    return { name: r.name, asset: r.asset, slug: railKey(r), href: `/${railKey(r)}`, title: `${r.name} x402 marketplace`, n, calls: n ? fmtNum(n) : "·" };
  });
  // Tempo settles over its own MPP relay, not an x402 facilitator, so it is
  // not in RAILS (which drives accepts and the on-chain scan). Its per-call
  // settlements are still tallied under the "tempo" key of the same counter,
  // so it gets a row here whenever it is enabled or has settled traffic.
  const tempoN = Number(byNet.tempo) || 0;
  if (tempo || tempoN) rows.push({ name: "Tempo", asset: "USDC.e", slug: "tempo", href: "/what-is-mpp", title: "Tempo native MPP settlement", n: tempoN, calls: tempoN ? fmtNum(tempoN) : "·" });
  return rows.sort((a, b) => b.n - a.n);
}

// The Decide planner, as a row of the agents table: rendered only when the
// decide tools are live (the chrome flag the server sets at boot); the price
// is read from the decide config.
function decideRowHtml() {
  const c = decideConfig();
  const usd = (n) => `$${Number(n).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `<a class="hm-decide" href="/decide" style="display:flex;justify-content:space-between;gap:12px;padding:11px 16px;border-top:1px solid rgba(255,255,255,.07);text-decoration:none;color:var(--on-panel-soft);"><span>POST /api/decide</span><span style="color:var(--accent-lit);white-space:nowrap;">from ${esc(usd(c.prices.quick))}</span></a>`;
}

// leaderboardSnapshot is still passed by the server; the seller board itself
// lives on /leaderboard since the 2026-11 trim, so the home page reads nothing from it.
// `proof` is the hero's first-party figures (src/home-proof.js
// homeProofFigures), read from caches by the server so the page never waits on
// a source; a figure the server has no value for is simply absent.
export function ledgerHomePage(baseUrl, catalog, stats, _leaderboardSnapshot, skillPacks, { settledOnChain = 0, external = null, proof = [], chainsOffered, mpp = true } = {}) {
  const tools = toolList(catalog);
  const count = tools.length;
  const packCount = Array.isArray(skillPacks) ? skillPacks.length : 42;
  const served = stats?.toolCallsServed || {};
  // The hero's paid figure is EXTERNAL payments only (buyers outside our
  // wallets, the /revenue headline); our own test purchases are footnoted
  // under it, and with no external reading the figure is left out rather than
  // replaced by a total that includes our own traffic.
  const hasExternal = external && Number.isFinite(Number(external.count)) && Number(settledOnChain) > 0;
  const ownTestPurchases = hasExternal ? Math.max(0, Number(settledOnChain) - Number(external.count)) : 0;
  // The live view's /embed may be framed only by agent402.tools, so a server
  // on any other origin (a self-hosted copy, CI on 127.0.0.1) links to it
  // instead of rendering a frame the browser would refuse.
  const liveEmbed = /^https:\/\/(www\.)?agent402\.tools\/?$/i.test(String(baseUrl || ""));
  const figures = (Array.isArray(proof) ? proof : []).filter((f) => f && f.value);
  // The revenue tag and the footnote speak to the paid figure, so they show only beside it.
  const paidShown = hasExternal && figures.some((f) => f.key === "paid");
  const heroFootnote = paidShown && ownTestPurchases > 0 ? `<div class="ml-meta" style="font-size:var(--fs-2xs);color:var(--on-panel-faint);margin:0;">${fmtNum(ownTestPurchases)} of our own test purchases are not counted above.</div>` : "";
  const proofMeta = ["Agent402", ...(paidShown ? [`$${Number(external.usd || 0).toFixed(2)} external revenue`] : [])];
  const proofHtml = figures.length
    ? `<div class="ml-meta" style="font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--on-panel-dim);margin:0;">${proofMeta.map((t) => `<span>${esc(t)}</span>`).join("")}</div>
          <div class="hm-own" style="--hm-own-n:${figures.length};">${figures.map((f) => `<a class="hm-own-fig" id="hm-own-${esc(f.key)}" href="${esc(f.href)}" data-as-of="${esc(f.asOf)}" title="as of ${esc(f.asOf)}"><span class="hm-own-v">${esc(f.value)}</span><span class="hm-own-l">${esc(f.label)}</span></a>`).join("")}</div>
          ${heroFootnote}`
    : "";
  // The lead sentence (src/positioning.js) with the wires this server offers
  // (the "/" route passes the MPP switch), each wire name linked.
  const wireLink = (href, t) => `<a href="${href}" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">${t}</a>`;
  const leadHtml = mpp
    ? esc(leadSentence({ mpp: true })).replace("x402 or MPP", `${wireLink("/what-is-x402", "x402")} or ${wireLink("/what-is-mpp", "MPP")}`)
    : esc(leadSentence({ mpp: false })).replace("over x402,", `over ${wireLink("/what-is-x402", "x402")},`);
  const viaPow = Number(served.viaProofOfWork) || 0;
  const rails = railsByVolume(stats);
  // One noun on every surface: the x402 chains, plus Tempo over MPP when it is
  // on. "N rails" counted Tempo as a chain beside copy that said N-1 chains.
  // The x402 chains the 402 offers right now when the server says (the "/"
  // route passes /api/rails "offered"); the static list only for a caller
  // that does not. Zero offered leaves the count out rather than claim it.
  const liveChains = chainsOffered === undefined ? RAILS.length : Number(chainsOffered) || 0;
  const tempoLive = rails.length > RAILS.length;
  const railCountLabel = liveChains > 0 ? `${liveChains} chains${tempoLive ? " + Tempo" : ""} live` : tempoLive ? "Tempo live" : "";
  // The chains the router can pay an outside seller on right now: its map
  // plus the EVM chains SOR_EVM_CHAINS lists.
  const routerChains = routerPayChains();

  const canonical = baseUrl + "/";
  // Title <= 70 and description <= 155 (the shell trims, but the homepage
  // snippet is written to fit so nothing is cut). Counts stay evergreen.
  const title = `Agent402: 500+ pay-per-call tools for AI agents over x402 and MPP`;
  // The exact live count (fmtNum(count)) stays out of the snippet on purpose: marketing counts are evergreen.
  const description = `Agentic Finance for AI agents: 500+ pay-per-call tools, metered models and finished reports over x402 and MPP, or by card. No signup, no API keys. Sell your API for USDC per call.`;

  const orgLd = siteOrgLd(baseUrl);
  const websiteLd = { "@type": "WebSite", "@id": `${baseUrl}/#website`, name: "Agent402", alternateName: ["Agent402.Tools", "Agent402 Tools", "Agent402 - applied layer of Agentic Finance"], url: baseUrl, publisher: { "@id": `${baseUrl}/#organization` }, description: "The applied layer of Agentic Finance: open index, Smart Order Router and on-chain ranking for agents paying and getting paid over x402 and MPP.", about: { "@type": "DefinedTerm", name: "Agentic Finance", alternateName: "AIFI", url: `${baseUrl}/agentic-finance` }, potentialAction: { "@type": "SearchAction", target: `${baseUrl}/api/find?q={search_term_string}`, "query-input": "required name=search_term_string" } };
  const appLd = { "@type": "SoftwareApplication", "@id": `${baseUrl}/#app`, name: "Agent402", url: baseUrl, applicationCategory: "DeveloperApplication", operatingSystem: RAILS.map((r) => r.name).join(", "), license: "https://www.gnu.org/licenses/agpl-3.0.html", description: `Open-source, self-hostable Agentic Finance server for x402 + MPP: ${fmtNum(count)} pay-per-call tools for AI agents (${packCount} of them multi-tool skill packs), plus an open index, Smart Order Router and on-chain seller leaderboard.`, offers: { "@type": "AggregateOffer", offerCount: String(count), lowPrice: String(minPriceUsd(catalog)), highPrice: maxPriceUsd(catalog).toFixed(2), priceCurrency: "USD", description: `Per-call micropayments in USDC and USDG across ${RAILS.length} chains, free with proof-of-work, or by card: finished reports ${usd0(CARD_LO)} to ${usd0(CARD_HI)}, monitors ${usd0(MON_USD)} a month` } };
  const surfacesLd = { "@type": "ItemList", "@id": `${baseUrl}/#surfaces`, name: "Free x402 discovery primitives", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Find - resolve a task to the best-matching tool", url: `${baseUrl}/api/find` },
    { "@type": "ListItem", position: 2, name: "Route - neutral Smart Order Router across every x402 seller", url: `${baseUrl}/api/route` },
    { "@type": "ListItem", position: 3, name: "Leaderboard - on-chain ranking by USDC settled volume", url: `${baseUrl}/api/leaderboard` },
    { "@type": "ListItem", position: 4, name: "Marketplace - every indexed seller, tool count, network, health", url: `${baseUrl}/marketplace` },
  ] };
  // Four questions, each a short answer: selling, card reports and failed
  // reports are answered by the sections above, the rest by /faq.
  const faqs = [
    { q: "What is agentic finance?", a: "Agentic finance (AIFI for short) is software agents paying and getting paid on their own: finding a service, paying per request from their own wallet over open protocols such as x402 and MPP, and keeping the receipt. Agent402 is its applied layer: the tools agents buy, the index and router that find a seller, and the tollbooth that lets a site charge agents. Full explainer at /agentic-finance." },
    { q: "How does an agent call a model?", a: `POST ${METERED_WIRES[0].path} with a model and your messages, no API key and no account (the Anthropic Messages and OpenAI Responses wires have metered routes too). ${meteredQuoteSentence().replace(/`/g, "")} Model-backed: third-party models answer. ${flatTiersLine().replace(/`/g, "")}` },
    { q: "Do I need a wallet to try it?", a: `No. The pure-CPU tools are payable in compute: your own machine solves a single-use, slug-scoped sha256 proof-of-work instead of paying, which costs ${powCostPhrase()}. A wallet only matters for tools that cost real money to run, and those quote their price in the 402 challenge before anything is charged.` },
    { q: "Is it open source, and can I run my own?", a: "Yes. The server is AGPL-3.0 and self-hostable; the client SDK, MCP connector and tollbooth packages are MIT. Clone it and run FREE_MODE=true npm start to serve the catalog as an HTTP API plus MCP with no payments; a tool that calls a third-party API answers 503 until you set that provider's key." },
  ];
  const faqLd = { "@type": "FAQPage", "@id": `${baseUrl}/#faq`, mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) };

  const extraCss = `
.hm-hero { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; align-items: center; }
.hm-live-stats { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 12px 10px; padding: 16px 22px 14px; border-top: 1px solid rgba(255,255,255,.07); }
.hm-live-stats[hidden] { display: none; }
.hm-own { display: grid; grid-template-columns: repeat(2, auto); justify-content: start; gap: 14px 48px; }
@media (min-width: 601px) and (max-width: 900px) { .hm-own { grid-template-columns: repeat(var(--hm-own-n), auto); justify-content: space-between; column-gap: 18px; } }
.hm-own-fig { display: flex; flex-direction: column; gap: 6px; text-decoration: none; min-width: 0; }
.hm-own-v { font-weight: 500; font-size: var(--fs-2xl); line-height: 1; letter-spacing: -.03em; color: var(--on-panel); font-variant-numeric: tabular-nums; white-space: nowrap; }
.hm-own-l { font-family: var(--font-mono); font-size: var(--fs-2xs); letter-spacing: .12em; text-transform: uppercase; color: var(--on-panel-faint); white-space: nowrap; }
.hm-own-fig:hover .hm-own-l { color: var(--accent-lit); }
.hm-doors { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.hm-claims { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 20px; }
.hm-card { border-radius: var(--radius); background: var(--card); border: 1px solid var(--hairline); box-shadow: inset 0 1px 0 var(--card-inset), 0 1px 2px rgba(0,0,0,.08); }
.hm-milled { border-radius: var(--radius); background: var(--milled-bg); border: 1px solid var(--milled-border); box-shadow: inset 0 1px 0 var(--card-inset), inset 0 -1px 0 rgba(0,0,0,.06), var(--shadow-lg); }
.hm-obsidian { border-radius: var(--radius); background: var(--obsidian-bg); color: var(--on-panel); border: 1px solid var(--obsidian-border); box-shadow: inset 0 1px 0 rgba(255,255,255,.10), 0 18px 40px rgba(0,0,0,.22); }
.hm-kicker { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--accent); margin-bottom: 12px; }
.hm-h2 { font-weight:700; font-size: var(--fs-3xl); line-height: 1.05; letter-spacing: -.03em; margin: 0; color: var(--ink); text-wrap: balance; }
.hm-lede { font-size: var(--fs-lg); line-height: 1.55; color: var(--muted); font-weight: 300; }
.hm-claim { padding: 22px 24px; display: flex; flex-direction: column; gap: 8px; }
.hm-claim h3 { font-weight: 600; font-size: var(--fs-lg); line-height: 1.3; letter-spacing: -.01em; margin: 0; color: var(--ink); text-wrap: balance; }
.hm-claim p { font-size: var(--fs-md); line-height: 1.55; color: var(--muted); margin: 0; font-weight: 300; text-wrap: pretty; }
.hm-claim a { margin-top: auto; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--dash); align-self: flex-start; white-space: nowrap; }
.hm-door { padding: 32px; display: flex; flex-direction: column; gap: 16px; }
.hm-door p { margin: 0; font-size: var(--fs-base); line-height: 1.55; font-weight: 400; text-wrap: pretty; }
.hm-door .hm-door-act { margin-top: auto; display: flex; flex-wrap: wrap; gap: 10px; padding-top: 4px; }
.hm-door-agents p { color: var(--on-panel-soft); }
.hm-door-agents strong { color: var(--on-panel); font-weight: 600; }
.hm-door-people p { color: var(--muted); }
.hm-door-people strong { color: var(--ink); font-weight: 600; }
.hm-door .ml-ticks { margin: 0; }
.hm-marks { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-top: 18px; color: var(--muted); }
.hm-marks a { color: var(--muted); display: inline-flex; padding: 4px; }
.hm-marks a:hover { color: var(--ink); }
.hm-marks .hm-marks-k { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--faint); letter-spacing: .14em; text-transform: uppercase; }
@media (max-width: 900px) { .hm-hero, .hm-doors, .hm-claims { grid-template-columns: minmax(0,1fr) !important; } .hm-h2 { font-size: var(--fs-2xl); } }
@media (max-width: 600px) { .hm-live-stats, .hm-own { grid-template-columns: 1fr 1fr !important; } .hm-own { column-gap: 10px; } .hm-own-l { letter-spacing: .08em; } .hm-live-tail { display: none; } .hm-ptable a { flex-wrap: wrap; } .hm-ptable a > span { white-space: nowrap; } }
`;

  // The chain marks as one compact row of icon links, each to that chain's
  // marketplace page; Tempo has no traced mark, so it is named in text.
  const railMarksHtml = CHAIN_ORDER.map(([slug, name]) =>
    `<a href="/${slug}" title="${esc(name)} x402 marketplace" aria-label="${esc(name)}">${chainMark(slug, 18)}</a>`
  ).join("");
  // Tempo is NOT an x402 rail (no facilitator settles it - it rides its own
  // MPP relay, see src/mpp-tempo.js), so it never joins the marks above.
  const tempoMarkHtml = tempoEnabled()
    ? `<a href="/what-is-mpp" title="Tempo native MPP settlement" style="font-family:var(--font-mono);font-size:var(--fs-xs);">+ Tempo</a>`
    : "";

  const claimsHtml = whyHomeClaims().map((c) =>
    `<div class="hm-card hm-claim" id="why-${esc(c.id)}"><h3>${esc(c.t)}</h3><p>${esc(c.s)}</p><a href="${esc(c.link[0])}">${esc(c.link[1])} &rarr;</a></div>`
  ).join("");

  const faqHtml = faqs.map((f) =>
    `<details style="border-bottom:1px solid var(--hairline);"><summary style="list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 0;"><h3 style="font-weight:600;font-size:var(--fs-lg);margin:0;color:var(--ink);">${esc(f.q)}</h3><span class="ml-faq-mark" style="font-family:var(--font-mono);font-weight:400;font-size:var(--fs-lg);color:var(--accent);line-height:1;flex:none;">+</span></summary><p style="font-size:var(--fs-base);line-height:1.65;color:var(--muted);margin:0;padding:0 0 20px;max-width:76ch;font-weight:300;">${esc(f.a)}</p></details>`
  ).join("");

  const panelLink = 'style="color:var(--on-panel);text-decoration:none;border-bottom:1px solid var(--panel-rule-2);"';
  const rowStyle = 'style="display:flex;justify-content:space-between;gap:12px;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.07);text-decoration:none;color:var(--on-panel-soft);"';
  const priceStyle = 'style="color:var(--accent-lit);white-space:nowrap;"';

  const body = `
<header style="position:relative;overflow:hidden;">
  <canvas class="hm-aura" aria-hidden="true"></canvas>
  <div style="max-width:1180px;margin:0 auto;padding:84px 30px 56px;position:relative;">
    <div class="hm-hero">
      <div class="ml-stagger" style="display:flex;flex-direction:column;gap:26px;">
        <h1 class="ml-hero-h1" style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-hero);line-height:.98;margin:0;color:var(--ink);text-wrap:balance;">${esc(CATEGORY_LINE)}</h1>
        <p class="hm-lede" style="margin:0;text-wrap:pretty;">${leadHtml}</p>
        <p style="margin:0;font-size:var(--fs-base);line-height:1.55;color:var(--muted);text-wrap:pretty;">Web search, browser rendering, SEC filings, market data and more: an agent sends a request, gets a price back in the <span style="font-family:var(--font-mono);color:var(--ink);">402</span>, pays it from its own wallet, and gets the answer.</p>
        <div class="ml-hero-ctas" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
          <a class="btn btn-primary" href="/docs#add">Add to your agent</a>
          <a class="btn btn-secondary" href="/tools">Browse tools</a>
        </div>
        <div class="ml-items" style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--muted);gap:8px 18px;align-items:center;">
          ${railCountLabel ? `<span style="display:inline-flex;align-items:center;gap:10px;white-space:nowrap;"><span class="ml-dot"></span>${railCountLabel}</span>` : ""}
          <a href="${REPO_URL}" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);white-space:nowrap;">open source</a>
        </div>
      </div>

      <div class="hm-obsidian receipt" style="overflow:hidden;padding-bottom:22px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 12px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.07);">
          <span style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--on-panel-dim);display:inline-flex;align-items:center;gap:8px;min-width:0;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent-lit);animation:ml-pulse 1.8s ease-in-out infinite;flex:none;"></span><span class="hm-live-h" style="white-space:nowrap;">live · every x402 and MPP payment<span class="hm-live-tail"> we see on chain</span></span></span>
          <a href="https://live.agent402.tools" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent-lit);text-decoration:none;white-space:nowrap;">full screen ↗</a>
        </div>
        ${liveEmbed
          ? `<link rel="preconnect" href="https://live.agent402.tools"><iframe id="hm-live" src="https://live.agent402.tools/embed" title="Live x402 and MPP payments, read from the chain" style="display:block;width:100%;height:400px;border:0;background:var(--panel);"></iframe>`
          : `<a id="hm-live-link" href="https://live.agent402.tools" style="display:flex;align-items:center;justify-content:center;height:400px;background:var(--panel);color:var(--accent-lit);font-family:var(--font-mono);font-size:var(--fs-sm);text-decoration:none;">watch every x402 and MPP payment, live ↗</a>`}
        <div class="hm-live-stats" id="hm-live-stats" hidden>
          <div class="ml-meta" style="grid-column:1/-1;font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--on-panel-dim);"><span>whole x402 + MPP ecosystem</span><span>last hour</span><span>all sellers, not only us</span></div>
          ${[["hm-live-n", "payments · 1h"], ["hm-live-usd", "settled"], ["hm-live-buyers", "paying agents"], ["hm-live-pm", "per minute"]].map(([id, label]) => `<div><div id="${id}" style="font-weight:500;font-size:var(--fs-2xl);letter-spacing:-.03em;color:var(--on-panel);font-variant-numeric:tabular-nums;"></div><div style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--on-panel-faint);margin-top:6px;white-space:nowrap;">${label}</div></div>`).join("")}
        </div>
        <div style="padding:14px 22px 16px;border-top:1px solid rgba(255,255,255,.07);display:flex;flex-direction:column;gap:12px;">
          ${proofHtml}
          <div class="ml-items" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--on-panel-faint);gap:4px 16px;"><a href="https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns" style="color:var(--accent-lit);text-decoration:none;">verify settlements on Basescan ↗</a><span>+ <strong id="hm-freepow" style="color:var(--on-panel-soft);font-weight:500;">${fmtNum(viaPow)}</strong> free calls via proof-of-work</span></div>
        </div>
      </div>
    </div>
  </div>
</header>

<section style="max-width:1180px;margin:0 auto;padding:0 30px 20px;">
  <div class="hm-doors">
    <div class="hm-obsidian hm-door hm-door-agents on-panel">
      <div style="font-family:var(--font-mono);font-size:var(--fs-xs);letter-spacing:.18em;text-transform:uppercase;color:var(--on-panel-dim);">For agents</div>
      <h2 class="hm-h2" style="font-size:var(--fs-2xl);color:var(--on-panel);">Find a tool, pay the 402, get JSON.</h2>
      <p><strong>One free call</strong> finds the tool for any task. Pay per request in <strong>${esc(RAILS_SHORT)}</strong>, or over <strong>MPP</strong>${tempoMarkHtml ? ", natively on Tempo" : ""}. <strong>No API key.</strong> Connect over <a href="/guides/agent-hosts" ${panelLink}>MCP</a> or HTTP; machines read <a href="/llms.txt" ${panelLink}>llms.txt</a>, <a href="/openapi.json" ${panelLink}>openapi.json</a> and <a href="/.well-known/x402" ${panelLink}>.well-known/x402</a>.</p>
      <div class="hm-ptable" style="font-family:var(--font-mono);display:flex;flex-direction:column;border:1px solid rgba(255,255,255,.08);border-radius:var(--radius);overflow:hidden;font-size:var(--fs-sm);">
        <a href="/tools/v1-chat-metered" ${rowStyle}><span>POST /v1/metered/chat/completions</span><span ${priceStyle}>from ${esc(slugPrice(tools, "v1-chat-metered"))}</span></a>
        <a href="/api/find?q=whois" ${rowStyle}><span>GET /api/find?q=</span><span ${priceStyle}>free</span></a>
        <a href="/tools/answer" ${rowStyle}><span>GET /api/answer</span><span ${priceStyle}>${esc(slugPrice(tools, "answer"))}</span></a>
        <a href="/guides/smart-order-router" ${rowStyle}><span>POST /api/route/execute</span><span ${priceStyle}>from ${esc(slugPrice(tools, "route-execute"))}</span></a>
        <a href="/tools/bestsellers" ${rowStyle}><span>GET /api/bestsellers</span><span ${priceStyle}>${esc(slugPrice(tools, "bestsellers"))}</span></a>
        <a href="/pricing" style="display:flex;justify-content:space-between;gap:12px;padding:11px 16px;text-decoration:none;color:var(--on-panel-soft);"><span>GET /api/&lt;tool&gt;</span><span ${priceStyle}>from $${esc(String(minPriceUsd(catalog)))}</span></a>
        ${decideLive() ? decideRowHtml() : ""}
      </div>
      <p><strong>The pure-CPU tools are free:</strong> your machine solves a short proof-of-work instead of paying (${esc(powCostPhrase())}).</p>
      <div class="hm-door-act"><a class="btn btn-secondary btn-sm" href="/playground">Try them in the playground</a><a class="btn btn-secondary btn-sm" href="/docs">Read the docs</a></div>
    </div>
    <div class="hm-milled hm-door hm-door-people">
      <div style="font-family:var(--font-mono);font-size:var(--fs-xs);letter-spacing:.18em;text-transform:uppercase;color:var(--faint);">For people</div>
      <h2 class="hm-h2" style="font-size:var(--fs-2xl);">A cited report, by card.</h2>
      <p>Built from live data, with <strong>a PDF and data tables</strong>. Pay by card, <strong>no account</strong>.</p>
      <div class="hm-ptable" style="font-family:var(--font-mono);display:flex;flex-direction:column;border:1px solid var(--hairline);border-radius:var(--radius);overflow:hidden;font-size:var(--fs-sm);background:var(--card);">
        ${[["research", "Deep research"], ["dossier", "Company dossier"], ["fund-report", "Fund 13F report"], ["domain-audit", "Domain security audit"]]
          .map(([product, label]) => `<a class="hm-prow" data-product="${esc(product)}" href="/reports" style="display:flex;justify-content:space-between;gap:12px;padding:11px 16px;border-bottom:1px solid var(--hairline);text-decoration:none;color:var(--ink);"><span>${esc(label)}</span><span style="color:var(--accent);white-space:nowrap;">${esc(cardPrice(product))}</span></a>`)
          .join("\n        ")}
        <a class="hm-prow" data-product="monitor" href="/monitors" style="display:flex;justify-content:space-between;gap:12px;padding:11px 16px;text-decoration:none;color:var(--ink);"><span>Monitor a target</span><span style="color:var(--accent);white-space:nowrap;">${esc(monitorPrice())}/mo</span></a>
      </div>
      <ul class="ml-ticks">
        <li>A report that fails is refunded to your card automatically.</li>
        <li>A monitor re-checks its target on a schedule and emails up to ${MAX_FULL_PER_SUB_30D} fresh reports in any 30 days.</li>
        <li>Cancel a monitor anytime from the link in its emails.</li>
      </ul>
      <div class="hm-door-act"><a class="btn btn-secondary btn-sm" href="/reports">Browse reports</a><a class="btn btn-secondary btn-sm" href="/monitors">See monitors</a></div>
    </div>
  </div>
</section>

<section id="why" style="max-width:1180px;margin:0 auto;padding:64px 30px 0;scroll-margin-top:90px;">
  <h2 class="hm-h2" style="margin:0 0 22px;">Why pay here.</h2>
  <div class="hm-claims">${claimsHtml}</div>
  <div class="hm-marks"><span class="hm-marks-k">settles on</span>${railMarksHtml}${tempoMarkHtml}</div>
  <div style="font-family:var(--font-mono);font-size:var(--fs-sm);margin-top:18px;"><a href="/docs#why" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;white-space:nowrap;">all seven claims, with proof →</a></div>
</section>

<section id="sell" style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <h2 class="hm-h2">Sell to agents.</h2>
  ${sectionMeta(["free listing", "nothing deducted", "buyer wallet → your wallet"], "margin:10px 0 14px;")}
  <p class="hm-lede ml-measure" style="margin:0 0 18px;text-wrap:pretty;">List an x402 API and the router can send agents your way; it pays you on ${esc(routerChains.map(chainDisplayName).join(", "))}. Or put agent402-tollbooth in front of a site to charge AI crawlers per page. Sellers rank by settled volume on the <a href="/leaderboard" style="color:var(--ink);">leaderboard</a>.</p>
  <div style="font-family:var(--font-mono);font-size:var(--fs-sm);"><a href="/sell" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;white-space:nowrap;">everything for sellers → /sell</a></div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:64px 30px 64px;">
  <h2 class="hm-h2" style="margin:0 0 22px;">Questions.</h2>
  <div style="display:flex;flex-direction:column;gap:0;border-top:1px solid var(--hairline);max-width:900px;">${faqHtml}</div>
  <p style="font-size:var(--fs-base);color:var(--muted);margin:20px 0 0;">More on <a href="/faq" style="color:var(--accent);font-weight:500;font-family:var(--font-mono);">/faq</a>, and what agentic finance means on <a href="/agentic-finance" style="color:var(--accent);font-weight:500;font-family:var(--font-mono);">/agentic-finance</a>.</p>
  <style>section details > summary::-webkit-details-marker{display:none;} section details[open] .ml-faq-mark{transform:rotate(45deg);} .ml-faq-mark{transition:transform .15s ease;display:inline-block;}</style>
</section>

${ledgerFooterCompact()}

<script src="/js/hero-aura.js" defer></script>
<script src="/js/home-hero.js"></script>`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "", jsonLd: [orgLd, websiteLd, appLd, surfacesLd, faqLd], extraCss, body });
}
