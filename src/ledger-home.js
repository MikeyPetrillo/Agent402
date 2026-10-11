// Machine Ledger — Home page ("Agent402 Ledger"), Aug 2026 revamp.
// Hero (dot world map + live counter panel + rail marks), agent-pays
// transcript, real PoW demo, sell block, index/leaderboard, lane-level
// demand teaser, FAQ, closing CTA, footer.

import { crawlIntervalLabel } from "./crawl-cadence.js";
import { ledgerShell, ledgerFooterCompact, esc, decideLive, sectionMeta } from "./ledger-chrome.js";
import { whySectionHtml, whyJsonLd, WHY_SECTION_CSS } from "./why.js";
import { decideConfig } from "./decide/config.js";
import { toolList } from "./pages.js";
import { isComputePayable } from "./pow.js";
import { RAILS } from "./rails.js";
import { CAIP2_NAMES } from "./stats.js";
import { chainMark, CHAIN_ORDER } from "./chain-logos.js";
import { railKey } from "./rails.js";
import { tempoEnabled } from "./mpp-tempo.js";
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";

import { REPO_URL } from "./repo-link.js";
import { powCostPhrase } from "./pow.js";
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

const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");
// A route's price as the catalog states it, or "" when the server does not
// serve that slug (the row then shows no figure rather than a typed one).
const slugPrice = (tools, slug) => String(tools.find((t) => t.slug === slug)?.price || "");

// Lane-level demand teaser only - see /sell's identical rule. Per-tool slugs
// and purchase counts are the paid /api/bestsellers product, not derivable
// from a block explorer; the pre-revamp design
// draft for this section rendered exact slugs+counts sourced from a
// topPaidTools field this session removed from /api/stats as a real
// privacy fix (see PR #774) - ported here as lanes instead, matching /sell.
const DEMAND_LANES = [
  ["Hashing & encoding", "sha256/sha512 digests, HMAC, base64, JWT decoding."],
  ["Market & financial data", "Live quotes, historical series, Treasury yield curves, SEC lookups."],
  ["Live web search & cited answers", "Ranked results, and grounded answers with sources attached."],
];

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

/** Live leaderboard top rows, excluding Agent402's own row (best-effort name
 * match - same approach as /what-is-x402's adoption table). */
function externalLeaderboardRows(leaderboardSnapshot, limit = 6) {
  const board = Array.isArray(leaderboardSnapshot?.leaderboard) ? leaderboardSnapshot.leaderboard : [];
  return board
    .filter((r) => !/^agent402/i.test(String(r?.name || "")))
    .slice(0, limit)
    .map((r, i) => ({
      rank: String(i + 1).padStart(2, "0"),
      name: r.name,
      usd: `$${Number(r.totalUsd || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      calls: fmtNum(r.callsSettled),
      buyers: fmtNum(r.uniqueBuyers),
    }));
}

// Capability chips - a concrete row of what the catalog answers, each chip a
// direct internal link to that tool's own page (the pages search engines and
// LLM crawlers actually land on). Labels are ours; every PRICE is read from
// the live catalog, never typed here: a hand-typed price on the homepage is
// the same rot class test-docs-truth exists to catch in the docs. A slug the
// running server does not serve (env-gated kit, self-host without a key)
// simply drops its chip rather than linking to a 404.
const CAPABILITY_CHIPS = [
  ["perp-funding", "Perp funding rates"],
  ["perp-markets", "Every listed perp"],
  ["crypto-options-chain", "Options chain"],
  ["defi-yields", "DeFi yield screener"],
  ["stablecoins", "Stablecoin supply"],
  ["sol-token-safety", "Solana token safety"],
  ["sol-token-report", "Solana risk report"],
  ["crypto-market-pulse", "Crypto market pulse"],
  ["coin-profile", "Coin profile"],
  ["asset-transfers", "Wallet transfers"],
  ["site-crawl", "Crawl a site to markdown"],
  ["v1-images-fast", "Text to image"],
  ["v1-videos", "Text to video"],
];


// Third door: Agent402 Decide, a band under the two doors. Rendered only when
// the decide tools are live (the chrome flag the server sets at boot); every
// figure is read from the decide config.
function decideDoorHtml() {
  const c = decideConfig();
  const usd = (n) => `$${Number(n).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `<div class="hm-milled hm-decide" style="margin-top:20px;padding:28px 32px;display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:28px;align-items:center;">
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div style="font-family:var(--font-mono);font-size:var(--fs-xs);letter-spacing:.18em;text-transform:uppercase;color:var(--faint);">Agent402 Decide</div>
      <h2 class="hm-h2" style="font-size:var(--fs-2xl);margin:0;">Describe the job. Get the plan.</h2>
      <p class="hm-lede" style="margin:0;font-size:var(--fs-base);">One call returns which tools to use, in what order, with fallbacks and params that validate, across this catalog and outside x402 sellers. Every seller is scored by the same formula. ${esc(usd(c.prices.quick))} to ${esc(usd(c.prices.full))} a decision, returned as credit when Agent402 runs the plan.</p>
      <a href="/decide" style="font-size:var(--fs-base);font-weight:500;color:var(--ink);text-decoration:none;">See how it decides →</a>
    </div>
    <div style="font-family:var(--font-mono);display:flex;flex-direction:column;border:1px solid var(--hairline);background:var(--card);font-size:var(--fs-sm);">
      <a href="/decide" style="display:flex;justify-content:space-between;padding:11px 16px;border-bottom:1px solid var(--hairline);text-decoration:none;color:var(--ink);"><span>POST /api/decide</span><span style="color:var(--accent);">from ${esc(usd(c.prices.quick))}</span></a>
      <a href="/decide#connect" style="display:flex;justify-content:space-between;padding:11px 16px;border-bottom:1px solid var(--hairline);text-decoration:none;color:var(--ink);"><span>POST /api/decide/execute</span><span style="color:var(--accent);">credit applies</span></a>
      <a href="/decide#connect" style="display:flex;justify-content:space-between;padding:11px 16px;text-decoration:none;color:var(--ink);"><span>POST /api/decide/feedback</span><span style="color:var(--accent);">free</span></a>
    </div>
  </div>`;
}

export function ledgerHomePage(baseUrl, catalog, stats, leaderboardSnapshot, skillPacks, { settledOnChain = 0 } = {}) {
  const tools = toolList(catalog);
  const count = tools.length;
  const freeCount = tools.filter(isComputePayable).length;
  const packCount = Array.isArray(skillPacks) ? skillPacks.length : 42;
  const served = stats?.toolCallsServed || {};
  const viaUsdc = Number(served.viaUSDC) || 0;
  // Hero counter = the chain-derived settled count (same two ledger reads as
  // /revenue - the numbers must agree across surfaces); the in-process tally
  // is the fallback only while the ledger is still warming after a boot.
  // Two DIFFERENT quantities, so the label has to follow which one we got:
  // settledOnChain counts inbound on-chain transfers to our wallets (ours
  // included), viaUsdc counts calls this server actually served for a
  // stablecoin payment. The fallback exists because the ledger warms after a
  // boot, but a number that changes meaning silently is worse than a number
  // that is briefly missing.
  const heroFromChain = Number(settledOnChain) > 0;
  const heroCount = heroFromChain ? Number(settledOnChain) : viaUsdc;
  // The live view's /embed may be framed only by agent402.tools, so a server
  // on any other origin (a self-hosted copy, CI on 127.0.0.1) links to it
  // instead of rendering a frame the browser would refuse.
  const liveEmbed = /^https:\/\/(www\.)?agent402\.tools\/?$/i.test(String(baseUrl || ""));
  const heroLabel = heroFromChain ? "on-chain settlements · all rails · ours included" : "calls served for a stablecoin payment";
  const viaPow = Number(served.viaProofOfWork) || 0;
  const mppWire = Number(served.viaMPPWire) || 0;
  const rails = railsByVolume(stats);
  const attributed = rails.reduce((sum, r) => sum + r.n, 0);
  const board = externalLeaderboardRows(leaderboardSnapshot);

  const canonical = baseUrl + "/";
  // Title <= 70 and description <= 155 (the shell trims, but the homepage
  // snippet is written to fit so nothing is cut). Counts stay evergreen.
  const title = `Agent402: 500+ pay-per-call tools for AI agents over x402 and MPP`;
  // The exact live count (fmtNum(count)) stays out of the snippet on purpose: marketing counts are evergreen.
  const description = `Agentic Finance for AI agents: 500+ pay-per-call tools, metered models and finished reports over x402 and MPP, or by card. No signup, no API keys. Sell your API for USDC per call.`;

  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", alternateName: ["Agent402.Tools", "Agent402 Tools", "agent402.tools"], url: baseUrl, knowsAbout: ["Agentic Finance", "AIFI", "x402", "Machine Payments Protocol (MPP)", "agentic payments", "AI agents"], logo: { "@type": "ImageObject", url: `${baseUrl}/logo.png` }, email: "mike@agent402.tools", parentOrganization: { "@type": "Organization", name: "Havok Holdings LLC" }, sameAs: [REPO_URL, "https://x.com/Agent402Tools", "https://www.npmjs.com/package/agent402-mcp", "https://www.npmjs.com/package/agent402-client", "https://www.npmjs.com/package/agent402-tollbooth", "https://pypi.org/project/agent402-langchain/", "https://www.x402scan.com/server/07eb3020-932a-436d-a739-557b6e47101d"] };
  const websiteLd = { "@type": "WebSite", "@id": `${baseUrl}/#website`, name: "Agent402", alternateName: ["Agent402.Tools", "Agent402 Tools", "Agent402 - applied layer of Agentic Finance"], url: baseUrl, publisher: { "@id": `${baseUrl}/#organization` }, description: "The applied layer of Agentic Finance: open index, Smart Order Router and on-chain ranking for agents paying and getting paid over x402 and MPP.", about: { "@type": "DefinedTerm", name: "Agentic Finance", alternateName: "AIFI", url: `${baseUrl}/agentic-finance` }, potentialAction: { "@type": "SearchAction", target: `${baseUrl}/api/find?q={search_term_string}`, "query-input": "required name=search_term_string" } };
  const appLd = { "@type": "SoftwareApplication", "@id": `${baseUrl}/#app`, name: "Agent402", url: baseUrl, applicationCategory: "DeveloperApplication", operatingSystem: RAILS.map((r) => r.name).join(", "), license: "https://www.gnu.org/licenses/agpl-3.0.html", description: `Open-source, self-hostable Agentic Finance server for x402 + MPP: ${fmtNum(count)} pay-per-call tools for AI agents (${packCount} of them multi-tool skill packs), plus an open index, Smart Order Router and on-chain seller leaderboard.`, offers: { "@type": "AggregateOffer", offerCount: String(count), lowPrice: "0.001", highPrice: maxPriceUsd(catalog).toFixed(2), priceCurrency: "USD", description: `Per-call micropayments in USDC and USDG across ${RAILS.length} chains, free with proof-of-work, or by card: finished reports ${usd0(CARD_LO)} to ${usd0(CARD_HI)}, monitors ${usd0(MON_USD)} a month` } };
  const datasetLd = { "@type": "Dataset", "@id": `${baseUrl}/#leaderboard`, name: "x402 seller leaderboard - Base USDC settled volume", description: "Hourly on-chain snapshot ranking every indexed x402 seller by Base USDC settled volume: calls settled, total USD, unique buyers per seller.", creator: { "@id": `${baseUrl}/#organization` }, license: "https://www.gnu.org/licenses/agpl-3.0.html", isAccessibleForFree: true, distribution: { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${baseUrl}/api/leaderboard` } };
  const surfacesLd = { "@type": "ItemList", "@id": `${baseUrl}/#surfaces`, name: "Free x402 discovery primitives", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Find - resolve a task to the best-matching tool", url: `${baseUrl}/api/find` },
    { "@type": "ListItem", position: 2, name: "Route - neutral Smart Order Router across every x402 seller", url: `${baseUrl}/api/route` },
    { "@type": "ListItem", position: 3, name: "Leaderboard - on-chain ranking by USDC settled volume", url: `${baseUrl}/api/leaderboard` },
    { "@type": "ListItem", position: 4, name: "Marketplace - every indexed seller, tool count, network, health", url: `${baseUrl}/marketplace` },
  ] };
  const faqs = [
    { q: "What is agentic finance?", a: "Agentic finance (AIFI for short) is software agents transacting on their own: discovering a service, paying per request from a non-custodial wallet over open protocols such as x402 and MPP, receiving a verifiable receipt, and earning per request in return. Agent402 is its applied layer: the tools agents buy, the index and Smart Order Router that find and pay the best seller, the tollbooth that lets any site earn from agents, and on-chain transparency for all of it. Full explainer at /agentic-finance." },
    { q: "How do I sell my API for USDC per call?", a: "Register your origin in the \"Sell into the agent economy\" section above, or read the full seller guide at /sell for pricing, routing and health details. If your site is not x402-native yet, agent402-tollbooth is an open pay-per-crawl gate you can install instead." },
    { q: "Do I need a wallet to try it?", a: `No. The pure-CPU tools are payable in compute: your own machine solves a single-use, slug-scoped sha256 proof-of-work instead of paying, which costs ${powCostPhrase()}. A wallet only matters for tools that cost real money to run, and those quote their price in the 402 challenge before anything is charged.` },
    { q: "Can I pay by card instead of crypto?", a: `Yes. Finished, cited reports at /reports (${usd0(CARD_LO)} to ${usd0(CARD_HI)} by card, auto-refunded if a report fails) and monitors at /monitors (${usd0(MON_USD)} a month, cancel anytime). The card price includes payment processing. An agent paying per call in USDC over x402 or MPP pays the lower tool price for the same report.` },
    { q: "What is a report, and what if it fails?", a: "A report is a finished deliverable, not a chat answer: live data (SEC EDGAR, openFDA, your domain's DNS and TLS, grounded web search) composed and synthesized, with research and filing reports citing their sources, a PDF download, and data tables where the report has them. Payment is verified before anything is generated; if generation fails after payment, the card is refunded automatically and the x402 settlement is cancelled." },
    { q: "Is it open source, and can I run my own?", a: "Yes. The server is AGPL-3.0 and self-hostable; the client SDK, MCP connector and tollbooth packages are MIT. Clone it and run FREE_MODE=true npm start to serve the catalog as an HTTP API plus MCP with no payments; a tool that calls a third-party API answers 503 until you set that provider's key." },
  ];
  const faqLd = { "@type": "FAQPage", "@id": `${baseUrl}/#faq`, mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) };

  const extraCss = `
.hm-hero { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; align-items: center; }
.hm-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.hm-doors { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.hm-card { border-radius: var(--radius); background: var(--card); border: 1px solid var(--hairline); box-shadow: inset 0 1px 0 var(--card-inset), 0 1px 2px rgba(0,0,0,.08); }
.hm-milled { border-radius: var(--radius); background: var(--milled-bg); border: 1px solid var(--milled-border); box-shadow: inset 0 1px 0 var(--card-inset), inset 0 -1px 0 rgba(0,0,0,.06), var(--shadow-lg); }
.hm-obsidian { border-radius: var(--radius); background: var(--obsidian-bg); color: var(--on-panel); border: 1px solid var(--obsidian-border); box-shadow: inset 0 1px 0 rgba(255,255,255,.10), 0 18px 40px rgba(0,0,0,.22); }
.hm-kicker { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--accent); margin-bottom: 12px; }
.hm-h2 { font-weight:700; font-size: var(--fs-3xl); line-height: 1.05; letter-spacing: -.03em; margin: 0; color: var(--ink); text-wrap: balance; }
.hm-lede { font-size: var(--fs-lg); line-height: 1.55; color: var(--muted); font-weight: 300; }
.hm-row { display: grid; grid-template-columns: 170px 1fr 200px; gap: 24px; padding: 22px 0; border-bottom: 1px solid var(--hairline); align-items: baseline; }
.hm-chip { display: inline-flex; align-items: center; gap: 7px; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--muted); padding: 8px 12px; border: 1px solid var(--dash); border-radius: var(--radius); background: var(--chip-bg); text-decoration: none; }
.hm-term { font-family: var(--font-mono); font-size: var(--fs-sm); line-height: 1.8; color: var(--on-panel-soft); white-space: pre-wrap; word-break: break-word; margin: 0; }
@media (max-width: 900px) { .hm-hero, .hm-2col, .hm-doors, .hm-decide { grid-template-columns: minmax(0,1fr) !important; } .hm-row { grid-template-columns: 1fr !important; gap: 6px; } .hm-h2 { font-size: var(--fs-2xl); } }
@media (max-width: 600px) { .hm-live-stats { grid-template-columns: 1fr 1fr !important; } .hm-live-tail { display: none; } .hm-ptable a { flex-wrap: wrap; } .hm-ptable a > span:first-child { min-width: 0; overflow-wrap: anywhere; } .why-cmp td { min-width: 150px; } }
@media (max-width: 480px) { .hm-reg-row { flex-direction: column !important; } .hm-reg-row button { width: 100%; } }
.hm-sellcard { padding: 26px; display: flex; flex-direction: column; }
.hm-sellk { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--accent); margin-bottom: 14px; }
.hm-sellcard h3 { font-weight: 600; font-size: var(--fs-xl); margin: 0 0 10px; color: var(--ink); letter-spacing: -.02em; }
.hm-sellcard > p { font-size: var(--fs-base); line-height: 1.6; color: var(--muted); margin: 0 0 14px; font-weight: 300; }
.hm-sellpre { margin: 0 0 16px; background: var(--panel); color: var(--on-panel); padding: 14px; border-radius: var(--radius); font-size: var(--fs-xs); }
.hm-sellact { margin-top: auto; }
#hm-demo-in { border: 1px solid var(--dash); border-radius: var(--radius); }
#hm-demo-in:focus { border-color: var(--accent); outline: none; }
${WHY_SECTION_CSS}
`;

  const railLinksHtml = CHAIN_ORDER.map(([slug, name]) =>
    `<a href="/${slug}" title="${esc(name)} x402 marketplace" class="hm-chip">${chainMark(slug, 16)}<span>${esc(name)}</span></a>`
  ).join("");
  // Tempo is NOT an x402 rail (no facilitator settles it - it rides its own
  // MPP relay, see src/mpp-tempo.js), so it never joins railLinksHtml above.
  // Text-styled on purpose, not a borrowed vector mark - we don't have
  // verified rights to trace Tempo's logo asset.
  const tempoChipHtml = tempoEnabled()
    ? `<a href="/what-is-mpp" title="Tempo native MPP settlement" class="hm-chip"><span style="font-weight:700;color:var(--ink);">Tempo</span><span style="color:var(--faint);">native MPP</span></a>`
    : "";

  const railRowsHtml = rails.map((r) =>
    `<a href="${esc(r.href)}" title="${esc(r.title)}" style="display:flex;flex-direction:column;gap:9px;padding:15px 16px;text-decoration:none;color:var(--on-panel-soft);border-right:1px solid var(--panel-rule);border-bottom:1px solid var(--panel-rule);"><span style="display:flex;align-items:center;gap:9px;">${chainMark(r.slug, 19)}<span style="font-weight:500;font-size:var(--fs-base);color:var(--on-panel);">${esc(r.name)}</span></span><span style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-family:var(--font-mono);"><span style="font-weight:500;font-size:var(--fs-lg);color:var(--on-panel);font-variant-numeric:tabular-nums;">${esc(r.calls)}</span><span style="font-size:var(--fs-2xs);letter-spacing:.1em;text-transform:uppercase;color:var(--on-panel-faint);">calls · ${esc(r.asset)}</span></span></a>`
  ).join("");

  const leaderboardRowsHtml = board.length
    ? board.map((r) => `<tr style="border-bottom:1px solid var(--panel-rule);color:var(--on-panel);"><td style="padding:11px 18px;color:var(--on-panel-faint);">${esc(r.rank)}</td><td style="padding:11px 18px;">${esc(r.name)}</td><td style="padding:11px 18px;text-align:right;color:var(--on-panel-soft);">${esc(r.usd)}</td><td style="padding:11px 18px;text-align:right;color:var(--on-panel-muted);">${esc(r.calls)}</td><td style="padding:11px 18px;text-align:right;color:var(--on-panel-muted);">${esc(r.buyers)}</td></tr>`).join("")
    : `<tr><td colspan="5" style="padding:20px 18px;color:var(--on-panel-faint);">unavailable - the leaderboard snapshot has not populated yet</td></tr>`;

  const demandLanesHtml = DEMAND_LANES.map(([lane, body_], i) =>
    `<div style="display:grid;grid-template-columns:28px 1fr;gap:14px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hairline);"><span style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);">${String(i + 1).padStart(2, "0")}</span><div><div style="font-size:var(--fs-base);color:var(--ink);font-weight:500;">${esc(lane)}</div><div style="font-size:var(--fs-md);color:var(--muted);margin-top:2px;font-weight:300;">${esc(body_)}</div></div></div>`
  ).join("");

  const faqHtml = faqs.map((f) =>
    `<details style="border-bottom:1px solid var(--hairline);"><summary style="list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 0;"><h3 style="font-weight:600;font-size:var(--fs-lg);margin:0;color:var(--ink);">${esc(f.q)}</h3><span class="ml-faq-mark" style="font-family:var(--font-mono);font-weight:400;font-size:var(--fs-lg);color:var(--accent);line-height:1;flex:none;">+</span></summary><p style="font-size:var(--fs-base);line-height:1.65;color:var(--muted);margin:0;padding:0 0 20px;max-width:76ch;font-weight:300;">${esc(f.a)}</p></details>`
  ).join("");

  const body = `
<header style="position:relative;overflow:hidden;">
  <div style="max-width:1180px;margin:0 auto;padding:84px 30px 56px;position:relative;">
    <div class="hm-hero">
      <div class="ml-stagger" style="display:flex;flex-direction:column;gap:26px;">
        <div class="ml-hero-eyebrow" style="font-family:var(--font-mono);font-size:var(--fs-xs);letter-spacing:.18em;text-transform:uppercase;color:var(--faint);">No account. No API key. No card on file.</div>
        <h1 class="ml-hero-h1" style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-hero);line-height:.98;margin:0;color:var(--ink);text-wrap:balance;">Pay for any API call <span style="color:var(--faint);">without an account.</span></h1>
        <p class="hm-lede" style="margin:0;">An agent sends a request, gets a price back in the <span style="font-family:var(--font-mono);color:var(--ink);">402</span>, pays it from its own wallet over <a href="/what-is-x402" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">x402</a> or <a href="/what-is-mpp" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">MPP</a>, and the call is served. 500+ tools priced in cents, models metered under a quoted ceiling, and a receipt on every settled call.</p>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div class="ml-hero-ctas" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
            <a class="btn btn-primary" href="/docs#add">Add to your agent</a>
            <a class="btn btn-secondary" href="/tools">Browse tools</a>
          </div>
          <a href="/guides/agent-hosts" style="align-self:flex-start;font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--muted);text-decoration:none;border-bottom:1px solid var(--hairline);">Claude, Cursor, VS Code, Windsurf, Cline, Codex, Gemini CLI &rarr;</a>
        </div>
        <div class="ml-items" style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--muted);gap:8px 18px;align-items:center;">
          <span style="display:inline-flex;align-items:center;gap:10px;"><span class="ml-dot"></span>${rails.length} rails live</span>
          <a href="/status" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">status</a>
          <a href="/api/reliability" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">reliability</a>
          <a href="${REPO_URL}" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">open source</a>
          <a href="/marketplace" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">the index</a>
        </div>
      </div>

      <div class="hm-obsidian receipt" style="overflow:hidden;padding-bottom:22px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 12px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.07);">
          <span style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--on-panel-dim);display:inline-flex;align-items:center;gap:8px;min-width:0;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent-lit);box-shadow:0 0 10px var(--accent-lit);animation:ml-pulse 1.8s ease-in-out infinite;flex:none;"></span><span class="hm-live-h" style="white-space:nowrap;">live · every x402 and MPP payment<span class="hm-live-tail"> we see on chain</span></span></span>
          <a href="https://live.agent402.tools" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent-lit);text-decoration:none;white-space:nowrap;">full screen ↗</a>
        </div>
        ${liveEmbed
          ? `<iframe id="hm-live" src="https://live.agent402.tools/embed" title="Live x402 and MPP payments, read from the chain" style="display:block;width:100%;height:340px;border:0;background:var(--panel);"></iframe>`
          : `<a id="hm-live-link" href="https://live.agent402.tools" style="display:flex;align-items:center;justify-content:center;height:340px;background:var(--panel);color:var(--accent-lit);font-family:var(--font-mono);font-size:var(--fs-sm);text-decoration:none;">watch every x402 and MPP payment, live ↗</a>`}
        <div class="hm-live-stats" style="padding:16px 22px 14px;border-top:1px solid rgba(255,255,255,.07);display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px 10px;">
          <div><div id="hm-live-n" style="font-weight:500;font-size:var(--fs-2xl);letter-spacing:-.03em;color:var(--on-panel);font-variant-numeric:tabular-nums;">-</div><div style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--on-panel-faint);margin-top:6px;white-space:nowrap;">payments · 1h</div></div>
          <div><div id="hm-live-usd" style="font-weight:500;font-size:var(--fs-2xl);letter-spacing:-.03em;color:var(--on-panel);font-variant-numeric:tabular-nums;">-</div><div style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--on-panel-faint);margin-top:6px;white-space:nowrap;">settled</div></div>
          <div><div id="hm-live-buyers" style="font-weight:500;font-size:var(--fs-2xl);letter-spacing:-.03em;color:var(--on-panel);font-variant-numeric:tabular-nums;">-</div><div style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--on-panel-faint);margin-top:6px;white-space:nowrap;">paying agents</div></div>
          <div><div id="hm-live-pm" style="font-weight:500;font-size:var(--fs-2xl);letter-spacing:-.03em;color:var(--on-panel);font-variant-numeric:tabular-nums;">-</div><div style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--on-panel-faint);margin-top:6px;white-space:nowrap;">per minute</div></div>
        </div>
        <div style="padding:12px 22px 16px;border-top:1px solid rgba(255,255,255,.07);display:flex;flex-direction:column;gap:10px;">
          <div>
            <div id="hm-counter" data-via-usdc="${esc(heroCount)}" style="font-family:var(--font-body);font-weight:500;font-size:var(--fs-2xl);line-height:.95;letter-spacing:-.035em;color:var(--on-panel);font-variant-numeric:tabular-nums;">${heroCount ? fmtNum(heroCount) : ""}</div>
            <div id="hm-counter-empty" style="display:${heroCount ? "none" : "flex"};align-items:center;gap:11px;">
              <span style="width:8px;height:8px;border-radius:50%;background:var(--accent-lit);flex:none;animation:ml-pulse 1.6s ease-in-out infinite;"></span>
              <span style="font-family:var(--font-mono);font-size:var(--fs-base);color:var(--on-panel-soft);">Settlement count loading</span>
            </div>
            <div style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;color:var(--on-panel-faint);margin-top:8px;">${heroLabel}</div>
          </div>
          <div class="ml-items" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--on-panel-faint);gap:4px 16px;"><a href="https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns" style="color:var(--accent-lit);text-decoration:none;">verify settlements on Basescan ↗</a><span>+ <strong id="hm-freepow" style="color:var(--on-panel-soft);font-weight:500;">${fmtNum(viaPow)}</strong> calls to the free tools (proof-of-work, no payment)</span></div>
        </div>
      </div>
    </div>
  </div>
</header>

<section style="max-width:1180px;margin:0 auto;padding:0 30px 20px;">
  <div class="hm-doors">
    <div class="hm-milled" style="padding:32px;display:flex;flex-direction:column;gap:16px;">
      <div style="font-family:var(--font-mono);font-size:var(--fs-xs);letter-spacing:.18em;text-transform:uppercase;color:var(--faint);">For people</div>
      <h2 class="hm-h2" style="font-size:var(--fs-2xl);">A finished report, cited and delivered.</h2>
      <p class="hm-lede" style="margin:0;font-size:var(--fs-base);">Built from live data, with a PDF download and data tables where the report has them, and refunded if it fails. Or subscribe and get the re-run in your inbox when something moves.</p>
      <div class="hm-ptable" style="font-family:var(--font-mono);display:flex;flex-direction:column;border:1px solid var(--hairline);border-radius:var(--radius);overflow:hidden;font-size:var(--fs-sm);background:var(--card);">
        ${[["research", "Deep research"], ["dossier", "Company dossier"], ["fund-report", "Fund 13F report"], ["domain-audit", "Domain security audit"]]
          .map(([product, label]) => `<a class="hm-prow" data-product="${esc(product)}" href="/reports" style="display:flex;justify-content:space-between;gap:12px;padding:11px 16px;border-bottom:1px solid var(--hairline);text-decoration:none;color:var(--ink);"><span>${esc(label)}</span><span style="color:var(--accent);white-space:nowrap;">${esc(cardPrice(product))}</span></a>`)
          .join("\n        ")}
        <a class="hm-prow" data-product="monitor" href="/monitors" style="display:flex;justify-content:space-between;gap:12px;padding:11px 16px;text-decoration:none;color:var(--ink);"><span>Monitor a target</span><span style="color:var(--accent);white-space:nowrap;">${esc(monitorPrice())}/mo</span></a>
      </div>
      <a href="/reports" style="font-size:var(--fs-base);font-weight:500;color:var(--ink);text-decoration:none;">Browse reports →</a>
      <div class="ml-items" style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--muted);gap:6px 16px;">
        <span>free previews:</span>
        <a href="/reports/insider" style="color:var(--muted);">insider trades</a>
        <a href="/reports/fund" style="color:var(--muted);">13F holdings</a>
        <a href="/reports/dossier" style="color:var(--muted);">dossiers</a>
      </div>
    </div>
    <div class="hm-obsidian" style="padding:32px;display:flex;flex-direction:column;gap:16px;">
      <div style="font-family:var(--font-mono);font-size:var(--fs-xs);letter-spacing:.18em;text-transform:uppercase;color:var(--on-panel-dim);">For agents</div>
      <h2 class="hm-h2" style="font-size:var(--fs-2xl);color:var(--on-panel);">Find a tool, pay the 402, get JSON.</h2>
      <p style="margin:0;color:var(--on-panel-muted);font-size:var(--fs-base);line-height:1.5;font-weight:300;">Resolve any task in one free call, then pay per request in USDC on ${RAILS.length} chains or natively over MPP${tempoChipHtml ? " on Tempo" : ""}. Free tier by proof-of-work. Discoverable from <a href="/llms.txt" style="color:var(--on-panel);text-decoration:none;border-bottom:1px solid var(--panel-rule-2);">llms.txt</a>, <a href="/openapi.json" style="color:var(--on-panel);text-decoration:none;border-bottom:1px solid var(--panel-rule-2);">openapi.json</a>, <a href="/.well-known/x402" style="color:var(--on-panel);text-decoration:none;border-bottom:1px solid var(--panel-rule-2);">.well-known/x402</a> and the <a href="/docs#add" style="color:var(--on-panel);text-decoration:none;border-bottom:1px solid var(--panel-rule-2);">MCP connector</a>.</p>
      <div class="hm-ptable" style="font-family:var(--font-mono);display:flex;flex-direction:column;border:1px solid rgba(255,255,255,.08);border-radius:var(--radius);overflow:hidden;font-size:var(--fs-sm);">
        <a href="/api/find?q=whois" style="display:flex;justify-content:space-between;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.07);text-decoration:none;color:var(--on-panel-soft);"><span>GET /api/find?q=</span><span style="color:var(--accent-lit);white-space:nowrap;">free</span></a>
        <a href="/tools" style="display:flex;justify-content:space-between;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.07);text-decoration:none;color:var(--on-panel-soft);"><span>GET /api/&lt;tool&gt;</span><span style="color:var(--accent-lit);white-space:nowrap;">from $0.001</span></a>
        <a href="/guides/agent-hosts" style="display:flex;justify-content:space-between;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.07);text-decoration:none;color:var(--on-panel-soft);"><span>POST /v1/metered/chat/completions</span><span style="color:var(--accent-lit);white-space:nowrap;">from ${esc(slugPrice(tools, "v1-chat-metered"))}</span></a>
        <a href="/tools/answer" style="display:flex;justify-content:space-between;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.07);text-decoration:none;color:var(--on-panel-soft);"><span>GET /api/answer</span><span style="color:var(--accent-lit);white-space:nowrap;">${esc(slugPrice(tools, "answer"))}</span></a>
        <a href="/guides/smart-order-router" style="display:flex;justify-content:space-between;padding:11px 16px;text-decoration:none;color:var(--on-panel-soft);"><span>POST /api/route/execute</span><span style="color:var(--accent-lit);white-space:nowrap;">${esc(slugPrice(tools, "route-execute"))} + seller</span></a>
      </div>
      <div class="ml-items" style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--on-panel-dim);"><span title="POST-only JSON-RPC endpoint - not a browsable page">/mcp</span><a href="/api/pricing" style="color:var(--on-panel-dim);text-decoration:none;">/api/pricing</a><a href="/playground" style="color:var(--on-panel-dim);text-decoration:none;">playground · free</a></div>
    </div>
  </div>
  ${decideLive() ? decideDoorHtml() : ""}
</section>

${whySectionHtml()}

<section style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div class="hm-kicker">$ GET /api/pow/challenge?slug=hash</div>
  <h2 class="hm-h2">Some tools are free.</h2>
  ${sectionMeta(["pure-CPU tools only", "no wallet", "runs in this tab"], "margin:10px 0 14px;")}
  <p class="hm-lede ml-measure" style="margin:0 0 26px;">The pure-CPU tools (hashing, encoding, math, conversion and the like) need no payment: the server issues a signed sha256 puzzle, your machine solves it (${esc(powCostPhrase())}), and the call is served. Every other tool is paid per call from a wallet. Press the button: your browser fetches a real challenge from the live server, solves it here, and makes a real call.</p>
  <div class="hm-2col" style="gap:0;border-radius:var(--radius);overflow:hidden;border:1px solid var(--hairline);">
    <div style="padding:26px;background:var(--card);border-right:1px solid var(--hairline);">
      <label for="hm-demo-in" style="display:block;font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:10px;">Text to hash</label>
      <input id="hm-demo-in" type="text" value="hello" placeholder="anything at all" style="width:100%;background:var(--paper);color:var(--ink);font-family:var(--font-mono);font-size:var(--fs-md);padding:13px 14px;margin-bottom:14px;box-sizing:border-box;" / aria-label="anything at all">
      <button type="button" id="hm-demo-run" class="btn btn-secondary" style="width:100%;">Run it free →</button>
      <ol style="margin:20px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:0;border-top:1px solid var(--hairline);">
        <li style="display:grid;grid-template-columns:22px 1fr;gap:12px;padding:13px 0;border-bottom:1px solid var(--hairline);"><span id="hm-step1-mark" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent);">·</span><span><span style="font-size:var(--fs-md);color:var(--ink);font-weight:500;">Request a challenge</span><br><span id="hm-step1" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);">signed, single-use, scoped to one tool</span></span></li>
        <li style="display:grid;grid-template-columns:22px 1fr;gap:12px;padding:13px 0;border-bottom:1px solid var(--hairline);"><span id="hm-step2-mark" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent);">·</span><span><span style="font-size:var(--fs-md);color:var(--ink);font-weight:500;">Solve it in your browser</span><br><span id="hm-step2" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);">~65k hashes at 16 bits</span></span></li>
        <li style="display:grid;grid-template-columns:22px 1fr;gap:12px;padding:13px 0;"><span id="hm-step3-mark" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent);">·</span><span><span style="font-size:var(--fs-md);color:var(--ink);font-weight:500;">Call the tool, free</span><br><span id="hm-step3" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);">hash the challenge, submit the token</span></span></li>
      </ol>
    </div>
    <div style="background:var(--panel);color:var(--on-panel);display:flex;flex-direction:column;">
      <div style="padding:14px 20px;border-bottom:1px solid var(--panel-rule-2);font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.08em;color:var(--on-panel-dim);display:flex;justify-content:space-between;gap:12px;">
        <span>POST /api/hash</span>
        <span id="hm-demo-status" style="color:var(--on-panel-faint);">ready</span>
      </div>
      <pre id="hm-demo-out" class="hm-term" style="padding:20px;flex:1;color:var(--on-panel);"># the same three steps, from a shell:
curl -s '/api/pow/challenge?slug=hash'
# solve: sha256("&lt;challenge&gt;:" + nonce) with N leading zero bits
curl -X POST /api/hash \\
  -H 'content-type: application/json' \\
  -H 'X-Pow-Solution: &lt;token&gt;:&lt;nonce&gt;' \\
  -d '{"text":"hello","algo":"sha256"}'</pre>
      <div id="hm-demo-receipt" style="padding:14px 20px;border-top:1px solid var(--panel-rule-2);font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent-lit);">no wallet needed · press Run to spend CPU instead</div>
    </div>
  </div>
  <div class="ml-items" style="margin-top:16px;gap:8px 20px;font-family:var(--font-mono);font-size:var(--fs-sm);">
    <a href="/playground" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">try every free tool in the playground →</a>
    <a href="/guides/x402-in-5-minutes" style="color:var(--muted);text-decoration:none;">how the free tier works →</a>
  </div>
</section>

<section id="sell" style="max-width:1180px;margin:0 auto;padding:70px 30px 0;">
  <div class="hm-kicker">$ POST /api/index/register</div>
  <h2 class="hm-h2">Sell into the agent economy.</h2>
  ${sectionMeta(["free listing", "nothing deducted", "non-custodial"], "margin:10px 0 14px;")}
  <p class="hm-lede ml-measure" style="margin:0 0 30px;">Agents are already buying, and they cannot fill in a signup form. If you run an API - or a site AI crawlers keep scraping for free - the same rails that let them buy let you charge. Money moves buyer wallet → your wallet. Nothing sits in between.</p>
  <div class="hm-2col" style="margin-bottom:28px;">
    <div class="hm-card hm-sellcard">
      <div class="hm-sellk">01 / List an x402 API</div>
      <h3>Get routed by the Smart Order Router</h3>
      <p>Serve x402 challenges and register your origin. You are ranked next to our own ${fmtNum(count)} tools on the same terms.</p>
      <ul class="ml-ticks">
        <li>Crawled at once, re-probed ${esc(crawlIntervalLabel())}</li>
        <li>Shortlisted by task match, then health, payers and price</li>
        <li>A public leaderboard row once on-chain volume shows</li>
      </ul>
      <pre class="hm-term hm-sellpre"><span style="color:var(--on-panel-faint);"># or paste your origin below, same call
</span>curl -X POST https://agent402.tools/api/index/register \\
  -H 'content-type: application/json' \\
  -d '{"origin":"https://seller.example"}'</pre>
      <div class="hm-sellact">
        <div class="hm-reg-row" style="display:flex;gap:10px;">
          <input id="hm-reg-origin" type="url" placeholder="https://api.yourdomain.com" style="flex:1;min-width:0;font-family:var(--font-mono);font-size:var(--fs-sm);padding:11px 14px;border:1px solid var(--dash);border-radius:var(--radius);background:var(--paper);color:var(--ink);" aria-label="https://api.yourdomain.com">
          <button id="hm-reg-go" class="btn btn-primary">List it →</button>
        </div>
        <div id="hm-reg-out" style="font-size:var(--fs-sm);color:var(--faint);margin-top:8px;">Free, no account. Listed once your x402 surface answers.</div>
      </div>
    </div>
    <div class="hm-card hm-sellcard">
      <div class="hm-sellk">02 / Tollbooth a site</div>
      <h3>Charge AI crawlers per page</h3>
      <p>Put an open pay-per-crawl gate in front of any site. People read it as before; crawlers pay per page.</p>
      <ul class="ml-ticks">
        <li>Known bots get <span style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);">402 Payment Required</span></li>
        <li>They pay in USDC or solve a proof-of-work</li>
        <li>No CDN lock-in, no merchant of record, no signup</li>
      </ul>
      <pre class="hm-term hm-sellpre"><span style="color:var(--on-panel-faint);"># express · next.js · cloudflare · proxy · wordpress
</span>npm i agent402-tollbooth</pre>
      <div class="hm-sellact">
        <a class="btn btn-secondary" href="/tollbooth">Gate your crawlers →</a>
        <div style="font-size:var(--fs-sm);color:var(--faint);margin-top:8px;">MIT licensed middleware. You keep your wallet.</div>
      </div>
    </div>
  </div>

  <div class="hm-2col" style="align-items:start;">
    <table style="font-family:var(--font-mono);font-size:var(--fs-sm);border:1px solid var(--hairline);border-radius:var(--radius);overflow:hidden;background:var(--card);width:100%;border-collapse:separate;border-spacing:0;">
      <caption style="text-align:left;font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);padding:0 0 10px;">What a seller gets</caption>
      <tbody>
        <tr><th scope="row" style="text-align:left;font-weight:500;padding:12px 18px;color:var(--ink);border-bottom:1px solid var(--hairline);">Listing fee</th><td style="padding:12px 18px;text-align:right;color:var(--accent);white-space:nowrap;border-bottom:1px solid var(--hairline);">$0</td></tr>
        <tr><th scope="row" style="text-align:left;font-weight:500;padding:12px 18px;color:var(--ink);border-bottom:1px solid var(--hairline);">Commission</th><td style="padding:12px 18px;text-align:right;color:var(--accent);white-space:nowrap;border-bottom:1px solid var(--hairline);">0%</td></tr>
        <tr><th scope="row" style="text-align:left;font-weight:500;padding:12px 18px;color:var(--ink);border-bottom:1px solid var(--hairline);">Routing</th><td style="padding:12px 18px;text-align:right;color:var(--muted);white-space:nowrap;border-bottom:1px solid var(--hairline);">health-aware</td></tr>
        <tr><th scope="row" style="text-align:left;font-weight:500;padding:12px 18px;color:var(--ink);border-bottom:1px solid var(--hairline);">Discovery</th><td style="padding:12px 18px;text-align:right;color:var(--muted);white-space:nowrap;border-bottom:1px solid var(--hairline);">4 surfaces</td></tr>
        <tr><th scope="row" style="text-align:left;font-weight:500;padding:12px 18px;color:var(--ink);border-bottom:1px solid var(--hairline);">How Agent402 earns</th><td style="padding:12px 18px;text-align:right;color:var(--muted);white-space:nowrap;border-bottom:1px solid var(--hairline);">buyer-side</td></tr>
        <tr><th scope="row" style="text-align:left;font-weight:500;padding:12px 18px;color:var(--ink);">Cross-chain buyers</th><td style="padding:12px 18px;text-align:right;color:var(--muted);white-space:nowrap;">Base · Algorand</td></tr>
      </tbody>
    </table>
    <div style="padding-top:26px;">
      <p style="font-size:var(--fs-base);line-height:1.6;color:var(--muted);margin:0;">No listing fee and no commission. A buyer pays your wallet directly from your own 402, which names your payTo and not ours, so nothing is deducted and nothing routes through us unless a buyer asks our router to buy from you and resell the result.</p>
      <div style="margin-top:16px;font-family:var(--font-mono);font-size:var(--fs-sm);"><a href="/sell" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">everything for sellers → /sell</a></div>
    </div>
  </div>
</section>

<section style="max-width:1180px;margin:64px auto 0;padding:0 30px;">
  <div class="hm-obsidian" style="padding:48px 40px;">
    <div class="hm-kicker" style="color:var(--accent-lit);">$ GET /api/leaderboard?include=external</div>
    <h2 class="hm-h2" style="color:var(--on-panel);">The open index for every seller.</h2>
    ${sectionMeta(["hourly on-chain snapshot", "Bazaar → eth_getLogs → aggregate by payTo"], "margin:10px 0 14px;color:var(--on-panel-faint);")}
    <p style="font-size:var(--fs-lg);line-height:1.6;color:var(--on-panel-muted);max-width:76ch;margin:0 0 30px;font-weight:300;">The x402 sellers we can crawl, ranked by <strong style="color:var(--on-panel);font-weight:500;">real Base USDC settled volume</strong> - not self-reported traffic. The rows below are the head of the board; the full ranking is at <a href="/leaderboard" style="color:var(--on-panel);">/leaderboard</a>. <span style="font-family:var(--font-mono);font-size:var(--fs-md);color:var(--on-panel);">include=external</span> excludes us from our own ranking, because a neutral index has to be checkable.</p>

    <div style="border:1px solid var(--panel-rule-2);border-radius:var(--radius);overflow:hidden;background:rgba(255,255,255,.025);">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:13px 18px;border-bottom:1px solid var(--panel-rule-2);font-family:var(--font-mono);">
        <span style="font-size:var(--fs-2xs);color:var(--on-panel-muted);letter-spacing:.1em;">OTHER SELLERS · BY USDC SETTLED · 7d</span>
        <span style="display:flex;align-items:center;gap:6px;font-size:var(--fs-2xs);color:var(--accent-lit);"><span style="width:6px;height:6px;border-radius:50%;background:var(--accent-lit);display:inline-block;animation:ml-pulse 1.8s ease-in-out infinite;"></span>LIVE</span>
      </div>
      <!-- Five mono columns are ~520px wide; inside the card's overflow:hidden
           at a 375px viewport the usdc/calls/buyers columns were clipped with
           no way to reach them (reported from outside 2026-09-08). Wide content
           scrolls inside its own container; the page never scrolls sideways. -->
      <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;" tabindex="0" aria-label="Seller leaderboard table, scrolls sideways on narrow screens">
      <table style="font-family:var(--font-mono);font-size:var(--fs-sm);width:100%;min-width:520px;">
        <thead><tr style="border-bottom:1px solid var(--panel-rule);color:var(--on-panel-faint);"><th scope="col" style="text-align:left;font-weight:400;padding:9px 18px;width:34px;">#</th><th scope="col" style="text-align:left;font-weight:400;padding:9px 18px;">seller</th><th scope="col" style="text-align:right;font-weight:400;padding:9px 18px;">usdc settled</th><th scope="col" style="text-align:right;font-weight:400;padding:9px 18px;">calls</th><th scope="col" style="text-align:right;font-weight:400;padding:9px 18px;">buyers</th></tr></thead>
        <tbody>${leaderboardRowsHtml}</tbody>
      </table>
      </div>
      <div style="padding:11px 18px;border-top:1px solid var(--panel-rule-2);font-family:var(--font-mono);font-size:var(--fs-2xs);color:var(--on-panel-faint);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;"><span>Agent402 excluded · hourly snapshot</span><a href="/leaderboard" style="color:var(--accent-lit);text-decoration:none;">full leaderboard →</a></div>
    </div>

    <div style="margin-top:30px;border-top:1px solid var(--panel-rule-2);padding-top:24px;">
      <h3 style="font-weight:600;font-size:var(--fs-xl);margin:0;color:var(--on-panel);letter-spacing:-.02em;">Settled on every rail, not just Base.</h3>
      ${sectionMeta(["calls settled per rail", "live from /api/stats"], "margin:10px 0 16px;color:var(--on-panel-faint);")}
      <p style="font-size:var(--fs-base);line-height:1.6;color:var(--on-panel-muted);max-width:76ch;margin:0 0 20px;font-weight:300;">All ${rails.length} rails${rails.length > RAILS.length ? ` (${RAILS.length} x402 chains plus Tempo over MPP)` : ""} carry real settled traffic, not just the headline one. Buyers pay on the chain they already hold stablecoins on, gas is sponsored on EVM, and the router pays external sellers on that same chain.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:0;border:1px solid var(--panel-rule-2);border-radius:var(--radius);overflow:hidden;">${railRowsHtml}</div>
      <div class="ml-items" style="gap:8px 26px;margin-top:16px;font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--on-panel-faint);">
        <span><strong style="color:var(--on-panel);font-weight:500;">${fmtNum(attributed)}</strong> of ${fmtNum(viaUsdc)} paid calls carry a per-rail tag</span>
        <span><strong style="color:var(--accent-lit);font-weight:500;">${fmtNum(mppWire)}</strong> settled over the MPP wire</span>
        <a href="/what-is-x402" style="color:var(--accent-lit);text-decoration:none;">how the dual stack works →</a>
      </div>
    </div>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div class="hm-kicker">$ GET /api/bestsellers · ${esc(slugPrice(tools, "bestsellers"))}</div>
  <h2 class="hm-h2">What agents actually pay for.</h2>
  ${sectionMeta(["lanes shown", "figures are a paid read"], "margin:10px 0 14px;")}
  <p class="hm-lede ml-measure" style="margin:0 0 24px;">Settlements are on chain, but <em style="color:var(--ink);font-style:normal;font-weight:400;">which tool an agent bought</em> is not - so this is the one demand signal no block explorer can reconstruct. Here are the lanes agents spend most in. The full per-tool ranking is itself a paid tool.</p>
  <div class="hm-card" style="overflow:hidden;">
    ${demandLanesHtml}
    <a href="/tools/bestsellers" style="display:grid;grid-template-columns:28px 1fr auto;gap:14px;align-items:center;padding:16px 20px;text-decoration:none;background:var(--panel);color:var(--on-panel);">
      <span style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--on-panel-faint);">·</span>
      <span style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--on-panel-muted);">the full ranking, plus buyer-diversity, revenue and trend lenses</span>
      <span style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent-lit);white-space:nowrap;">${esc(slugPrice(tools, "bestsellers"))} →</span>
    </a>
  </div>
  <div class="ml-items" style="gap:8px 20px;margin-top:16px;font-family:var(--font-mono);font-size:var(--fs-sm);">
    <a href="/sell" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">list an API in one of these lanes →</a>
    <a href="/tools" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">all ${fmtNum(count)} tools →</a>
    <a href="/pricing" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">price list →</a>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);letter-spacing:.14em;text-transform:uppercase;margin-bottom:14px;">settles on</div>
  <div style="display:flex;flex-wrap:wrap;gap:10px;">${railLinksHtml}${tempoChipHtml}<a href="/reports" class="hm-chip" style="background:var(--btn-bg);color:var(--btn-fg);border-color:transparent;">Card via Stripe</a></div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:70px 30px 20px;">
  <div class="hm-kicker">$ GET /faq</div>
  <h2 class="hm-h2" style="margin:0 0 28px;">Questions people and agents ask.</h2>
  <div style="display:flex;flex-direction:column;gap:0;border-top:1px solid var(--hairline);max-width:900px;">${faqHtml}</div>
  <p style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--muted);margin:20px 0 0;">More, including data handling and the OpenAI-compatible gateway: <a href="/faq" style="color:var(--accent);font-weight:500;">/faq</a></p>
  <style>section details > summary::-webkit-details-marker{display:none;} section details[open] .ml-faq-mark{transform:rotate(45deg);} .ml-faq-mark{transition:transform .15s ease;display:inline-block;}</style>
</section>

<section style="max-width:1180px;margin:0 auto;padding:30px 30px 64px;">
  <div class="hm-obsidian" style="padding:56px 46px;position:relative;overflow:hidden;">
    <div style="position:relative;">
      <h2 class="hm-h2" style="color:var(--on-panel);margin:0 0 16px;">Not x402-native yet?<br>You still have a way in.</h2>
      <p style="font-size:var(--fs-lg);line-height:1.6;color:var(--on-panel-muted);margin:0 0 30px;max-width:64ch;font-weight:300;">You do not have to rebuild anything. <strong style="color:var(--on-panel);font-weight:500;">agent402-tollbooth</strong> drops a pay-per-crawl gate in front of a site that speaks no protocol at all, and adding a tool to the catalog itself is roughly fifteen lines. Either route, you keep your own paywall and your own wallet.</p>
      <div style="display:flex;gap:11px;flex-wrap:wrap;">
        <a class="btn btn-primary on-panel" href="#sell">List your API - free →</a>
        <a class="btn btn-secondary on-panel" href="/tollbooth">Tollbooth a site</a>
        <a class="btn btn-secondary on-panel" href="/contribute">Contribute a tool</a>
      </div>
    </div>
  </div>
</section>

${ledgerFooterCompact()}

<script src="/js/home-hero.js"></script>`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "", jsonLd: [orgLd, websiteLd, appLd, datasetLd, surfacesLd, faqLd, whyJsonLd(baseUrl)], extraCss, body });
}
