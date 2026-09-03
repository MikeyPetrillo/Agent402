// Machine Ledger — Home page ("Agent402 Ledger"), Aug 2026 revamp.
// Hero (dot world map + live counter panel + rail marks), agent-pays
// transcript, real PoW demo, sell block, index/leaderboard, lane-level
// demand teaser, FAQ, closing CTA, footer.

import { ledgerShell, ledgerFooterFull, esc } from "./ledger-chrome.js";
import { toolList } from "./pages.js";
import { isComputePayable } from "./pow.js";
import { RAILS } from "./rails.js";
import { CAIP2_NAMES } from "./stats.js";
import { chainMark, CHAIN_ORDER } from "./chain-logos.js";
import { railKey } from "./rails.js";
import { tempoEnabled } from "./mpp-tempo.js";
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";

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

// Lane-level demand teaser only - see /sell's identical rule. Per-tool slugs
// and purchase counts are the paid /api/bestsellers product and the one
// demand signal no block explorer can reconstruct; the pre-revamp design
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
function railsByVolume(stats) {
  const byNet = stats?.toolCallsServed?.viaUSDCByNetwork || {};
  return RAILS.map((r) => {
    const key = CAIP2_NAMES[r.caip2] || r.name.toLowerCase();
    const n = Number(byNet[key]) || 0;
    return { name: r.name, asset: r.asset, slug: railKey(r), n, calls: n ? fmtNum(n) : "·" };
  }).sort((a, b) => b.n - a.n);
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

function capabilityChipsHtml(tools) {
  const bySlug = new Map(tools.map((t) => [t.slug, t]));
  return CAPABILITY_CHIPS
    .map(([slug, label]) => {
      const t = bySlug.get(slug);
      if (!t) return "";
      return `<a href="/tools/${esc(slug)}" class="hm-chip"><span style="color:var(--ink);">${esc(label)}</span><span style="color:var(--faint);">${esc(t.price)}</span></a>`;
    })
    .filter(Boolean)
    .join("");
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
  const heroCount = Number(settledOnChain) || viaUsdc;
  const viaPow = Number(served.viaProofOfWork) || 0;
  const mppWire = Number(served.viaMPPWire) || 0;
  const viaRouter = Number(served.viaRouter) || 0;
  const routerPct = viaUsdc ? (viaRouter / viaUsdc < 0.001 ? "under 0.1%" : `${((100 * viaRouter) / viaUsdc).toFixed(1)}%`) : "0%";
  const rails = railsByVolume(stats);
  const attributed = rails.reduce((sum, r) => sum + r.n, 0);
  const board = externalLeaderboardRows(leaderboardSnapshot);
  const chipsHtml = capabilityChipsHtml(tools);

  const canonical = baseUrl + "/";
  const title = `Agent402.Tools - 500+ pay-per-call tools for AI agents, finished reports by card, the open x402 + MPP index`;
  const description = `Agent402 is the applied layer of Agentic Finance: the open index, Smart Order Router and on-chain ranking for agents that pay and get paid over x402 and MPP. Sell your API for USDC per call, or give your AI agent ${fmtNum(count)} pay-per-call tools. No signup, no API keys - the wallet is the identity.`;

  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", alternateName: "Agent402.Tools", url: baseUrl, knowsAbout: ["Agentic Finance", "AIFI", "x402", "Machine Payments Protocol (MPP)", "agentic payments", "AI agents"], logo: { "@type": "ImageObject", url: `${baseUrl}/logo.png` }, email: "mike@agent402.tools", parentOrganization: { "@type": "Organization", name: "Havok Holdings LLC" }, sameAs: ["https://github.com/MikeyPetrillo/Agent402", "https://x.com/Agent402Tools", "https://www.npmjs.com/package/agent402-mcp", "https://www.npmjs.com/package/agent402-client", "https://www.npmjs.com/package/agent402-tollbooth", "https://pypi.org/project/agent402-langchain/", "https://www.x402scan.com/server/07eb3020-932a-436d-a739-557b6e47101d"] };
  const websiteLd = { "@type": "WebSite", "@id": `${baseUrl}/#website`, name: "Agent402.Tools", alternateName: "Agent402 - applied layer of Agentic Finance", url: baseUrl, publisher: { "@id": `${baseUrl}/#organization` }, description: "The applied layer of Agentic Finance: open index, Smart Order Router and on-chain ranking for agents paying and getting paid over x402 and MPP.", about: { "@type": "DefinedTerm", name: "Agentic Finance", alternateName: "AIFI", url: `${baseUrl}/agentic-finance` }, potentialAction: { "@type": "SearchAction", target: `${baseUrl}/api/find?q={search_term_string}`, "query-input": "required name=search_term_string" } };
  const appLd = { "@type": "SoftwareApplication", "@id": `${baseUrl}/#app`, name: "Agent402", url: baseUrl, applicationCategory: "DeveloperApplication", operatingSystem: RAILS.map((r) => r.name).join(", "), license: "https://www.gnu.org/licenses/agpl-3.0.html", description: `Open-source, self-hostable Agentic Finance server for x402 + MPP: ${fmtNum(count)} pay-per-call tools and ${packCount}+ skill packs for AI agents, plus an open index, Smart Order Router and on-chain seller leaderboard.`, offers: { "@type": "AggregateOffer", offerCount: String(count), lowPrice: "0.001", highPrice: "1.50", priceCurrency: "USD", description: "Per-call micropayments in USDC on eleven chains plus USDG on Robinhood Chain, free with proof-of-work, or by card: finished reports ${usd0(CARD_LO)} to ${usd0(CARD_HI)}, monitors ${usd0(MON_USD)} a month, prepaid credits from $20" } };
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
    { q: "Do I need a wallet to try it?", a: "No. The pure-CPU tools are payable in compute: your own machine solves a single-use, slug-scoped sha256 proof-of-work instead of paying, which costs about a second of CPU. A wallet only matters for tools that cost real money to run, and those quote their price in the 402 challenge before anything is charged." },
    { q: "Can I pay by card instead of crypto?", a: `Yes. Finished, cited reports at /reports (${usd0(CARD_LO)} to ${usd0(CARD_HI)} by card, auto-refunded if a report fails), monitors at /monitors (${usd0(MON_USD)} a month, cancel anytime), and prepaid credits at /credits: buy $20, $50 or $100 once, get a key, and call any tool with Authorization: Bearer a402_..., debited only when a call succeeds. The card price includes payment processing: Stripe charges 2.9% + $0.30 per charge, so under about a dollar the fee costs more than the report. An agent paying per call in USDC over x402 or MPP pays the lower tool price for the same report.` },
    { q: "What is a report, and what if it fails?", a: "A report is a finished deliverable, not a chat answer: live data (SEC EDGAR, openFDA, your domain's DNS and TLS, grounded web search) composed and synthesized with every claim cited, plus a downloadable data appendix and PDF. Payment is verified before anything is generated; if generation fails after payment, the card is refunded automatically and the x402 settlement is cancelled." },
    { q: "Is it open source, and can I run my own?", a: "Yes. The server is AGPL-3.0 and self-hostable; the client SDK, MCP connector and tollbooth packages are MIT. Clone it and run FREE_MODE=true npm start for all tools as an HTTP API plus MCP, with no payments and no keys." },
  ];
  const faqLd = { "@type": "FAQPage", "@id": `${baseUrl}/#faq`, mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) };

  const extraCss = `
.hm-hero { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; align-items: center; }
.hm-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.hm-doors { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.hm-proof { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 24px; }
.hm-card { border-radius: 18px; background: var(--card); border: 1px solid var(--hairline); box-shadow: inset 0 1px 0 var(--card-inset), 0 1px 2px rgba(0,0,0,.08); }
.hm-milled { border-radius: 18px; background: var(--milled-bg); border: 1px solid var(--milled-border); box-shadow: inset 0 1px 0 var(--card-inset), inset 0 -1px 0 rgba(0,0,0,.06), var(--shadow-lg); }
.hm-obsidian { border-radius: 18px; background: var(--obsidian-bg); color: var(--on-dark); border: 1px solid var(--obsidian-border); box-shadow: inset 0 1px 0 rgba(255,255,255,.10), 0 18px 40px rgba(0,0,0,.22); }
.hm-btn { display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-body); font-weight: 500; font-size: 15px; text-decoration: none; padding: 13px 22px; border-radius: 999px; white-space: nowrap; transition: transform .12s ease, box-shadow .12s ease; }
.hm-btn:hover { transform: translateY(-1px); }
.hm-btn-dark { color: var(--btn-fg); background: var(--btn-bg); box-shadow: var(--btn-shadow); border: 0; cursor: pointer; }
.hm-btn-ghost { color: var(--ink); border: 1px solid var(--dash); background: var(--chip-bg); }
.hm-btn-ghost:hover { border-color: var(--ink); }
.hm-btn-lit { color: #0B0C0E; background: var(--accent-lit); border: 0; cursor: pointer; } /* phosphor reads dark-on-green in both themes */
.hm-kicker { font-family: var(--font-mono); font-size: 12.5px; color: var(--accent); margin-bottom: 12px; }
.hm-h2 { font-weight: 500; font-size: 40px; line-height: 1.05; letter-spacing: -.03em; margin: 0; color: var(--ink); text-wrap: balance; }
.hm-lede { font-size: 16.5px; line-height: 1.55; color: var(--muted); font-weight: 300; }
.hm-row { display: grid; grid-template-columns: 170px 1fr 200px; gap: 24px; padding: 22px 0; border-bottom: 1px solid var(--hairline); align-items: baseline; }
.hm-chip { display: inline-flex; align-items: center; gap: 7px; font-family: var(--font-mono); font-size: 12.5px; color: var(--muted); padding: 8px 12px; border: 1px solid var(--dash); border-radius: 8px; background: var(--chip-bg); text-decoration: none; }
.hm-term { font-family: var(--font-mono); font-size: 12.5px; line-height: 1.8; color: var(--on-dark2); white-space: pre-wrap; word-break: break-word; margin: 0; }
@media (max-width: 900px) { .hm-hero, .hm-2col, .hm-doors { grid-template-columns: minmax(0,1fr) !important; } .hm-proof, .hm-why { grid-template-columns: 1fr 1fr !important; } .hm-row { grid-template-columns: 1fr !important; gap: 6px; } .hm-h2 { font-size: 32px; } }
@media (max-width: 480px) { .hm-reg-row { flex-direction: column !important; } .hm-reg-row button { width: 100%; } .hm-proof, .hm-why { grid-template-columns: 1fr !important; } }
#hm-demo-in { border: 1px solid var(--dash); border-radius: 10px; }
#hm-demo-in:focus { border-color: var(--accent); outline: none; }
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
    `<a href="/${r.slug}" title="${esc(r.name)} x402 marketplace" style="display:flex;flex-direction:column;gap:9px;padding:15px 16px;text-decoration:none;color:var(--on-dark2);border-right:1px solid var(--dark-border);border-bottom:1px solid var(--dark-border);"><span style="display:flex;align-items:center;gap:9px;">${chainMark(r.slug, 19)}<span style="font-weight:500;font-size:14.5px;color:var(--on-dark);">${esc(r.name)}</span></span><span style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-family:var(--font-mono);"><span style="font-weight:500;font-size:17px;color:var(--on-dark);font-variant-numeric:tabular-nums;">${esc(r.calls)}</span><span style="font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dk-muted3);">${esc(r.asset)}</span></span></a>`
  ).join("");

  const leaderboardRowsHtml = board.length
    ? board.map((r) => `<tr style="border-bottom:1px solid var(--dark-border);color:var(--on-dark);"><td style="padding:11px 18px;color:var(--dk-muted3);">${esc(r.rank)}</td><td style="padding:11px 18px;">${esc(r.name)}</td><td style="padding:11px 18px;text-align:right;color:var(--on-dark2);">${esc(r.usd)}</td><td style="padding:11px 18px;text-align:right;color:var(--dk-muted2);">${esc(r.calls)}</td><td style="padding:11px 18px;text-align:right;color:var(--dk-muted2);">${esc(r.buyers)}</td></tr>`).join("")
    : `<tr><td colspan="5" style="padding:20px 18px;color:var(--dk-muted3);">unavailable - the leaderboard snapshot has not populated yet</td></tr>`;

  const demandLanesHtml = DEMAND_LANES.map(([lane, body_], i) =>
    `<div style="display:grid;grid-template-columns:28px 1fr;gap:14px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hairline);"><span style="font-family:var(--font-mono);font-size:12px;color:var(--faint);">${String(i + 1).padStart(2, "0")}</span><div><div style="font-size:15px;color:var(--ink);font-weight:500;">${esc(lane)}</div><div style="font-size:13.5px;color:var(--muted);margin-top:2px;font-weight:300;">${esc(body_)}</div></div></div>`
  ).join("");

  const faqHtml = faqs.map((f) =>
    `<details style="border-bottom:1px solid var(--hairline);"><summary style="list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 0;"><h3 style="font-weight:500;font-size:17px;margin:0;color:var(--ink);">${esc(f.q)}</h3><span class="ml-faq-mark" style="font-family:var(--font-mono);font-weight:400;font-size:20px;color:var(--accent);line-height:1;flex:none;">+</span></summary><p style="font-size:15.5px;line-height:1.65;color:var(--muted);margin:0;padding:0 0 20px;max-width:760px;font-weight:300;">${esc(f.a)}</p></details>`
  ).join("");

  const body = `
<header style="position:relative;overflow:hidden;">
  <div style="max-width:1180px;margin:0 auto;padding:84px 30px 56px;position:relative;">
    <div class="hm-hero">
      <div class="ml-stagger" style="display:flex;flex-direction:column;gap:26px;">
        <div class="ml-hero-eyebrow" style="font-family:var(--font-mono);font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--faint);">No account. No API key. No card on file.</div>
        <h1 class="ml-hero-h1" style="font-weight:500;font-size:72px;line-height:.98;letter-spacing:-.04em;margin:0;color:var(--ink);text-wrap:balance;">Pay for any API call <span style="color:var(--faint);">without an account.</span></h1>
        <p class="hm-lede" style="font-size:19px;max-width:560px;margin:0;">An agent sends a request, gets a price back in the <span style="font-family:var(--font-mono);font-size:16px;color:var(--ink);">402</span>, pays it from its own wallet over <a href="/what-is-x402" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">x402</a> or <a href="/what-is-mpp" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">MPP</a>, and the call is served: 500+ tools priced in cents, models metered under a quoted ceiling, finished reports priced in dollars. People pay the same price list by card. A receipt on every settled call, and nothing to sign up for first - the applied layer of <a href="/agentic-finance" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">agentic finance</a>.</p>
        <div class="ml-hero-ctas" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
          <a class="hm-btn hm-btn-dark" href="/reports">Buy a report</a>
          <a class="hm-btn hm-btn-ghost" href="/docs#add" style="font-family:var(--font-mono);font-size:13.5px;">Add to Claude</a>
          <a href="/guides/agent-hosts" style="font-family:var(--font-mono);font-size:12.5px;color:var(--muted);text-decoration:none;border-bottom:1px solid var(--hairline);">or Cursor, VS Code, Windsurf, Cline, Codex, Gemini CLI →</a>
        </div>
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;font-family:var(--font-mono);font-size:12.5px;color:var(--muted);">
          <span class="ml-dot"></span><span>${RAILS.length} rails live</span>
          <a href="/status" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">status</a>
          <a href="/api/reliability" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">reliability</a>
          <a href="https://github.com/MikeyPetrillo/Agent402" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">AGPL-3.0 source</a>
          <a href="/marketplace" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--dash);">the index</a>
        </div>
      </div>

      <div class="hm-obsidian" style="overflow:hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.07);">
          <span style="display:flex;gap:6px;"><span style="width:10px;height:10px;border-radius:50%;background:#3A3F45;display:inline-block;"></span><span style="width:10px;height:10px;border-radius:50%;background:#3A3F45;display:inline-block;"></span><span style="width:10px;height:10px;border-radius:50%;background:#3A3F45;display:inline-block;"></span></span>
          <span style="font-family:var(--font-mono);font-size:11.5px;color:var(--dk-muted);display:inline-flex;align-items:center;gap:8px;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent-lit);box-shadow:0 0 10px var(--accent-lit);animation:ml-pulse 1.8s ease-in-out infinite;"></span>live · GET /api/stats</span>
        </div>
        <pre class="hm-term" style="padding:20px 22px 16px;"><span style="color:var(--dk-muted3);">$</span> curl agent402.tools/api/whois?domain=example.com
<span style="color:#F0B35E;">HTTP/2 402</span>  payment-required: usdc · base · 0.001
<span style="color:var(--dk-muted3);">$</span> curl -H "PAYMENT-SIGNATURE: …" agent402.tools/api/whois?…
<span style="color:var(--accent-lit);">HTTP/2 200</span>  payment-response: settled · tx 0x9ec4…
{ "registrar": "IANA", "created": "1995-08-14", … }

<span style="color:var(--dk-muted3);"># same door, MPP wire</span>
<span style="color:var(--dk-muted3);">$</span> curl -H "Authorization: Payment …" agent402.tools/api/whois?…
<span style="color:var(--accent-lit);">HTTP/2 200</span>  Payment-Receipt: …</pre>
        <div style="padding:16px 22px 18px;border-top:1px solid rgba(255,255,255,.07);display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;">
          <div>
            <div id="hm-counter" data-via-usdc="${esc(heroCount)}" style="font-family:var(--font-body);font-weight:500;font-size:44px;line-height:.95;letter-spacing:-.035em;color:var(--on-dark);font-variant-numeric:tabular-nums;">${heroCount ? fmtNum(heroCount) : ""}</div>
            <div id="hm-counter-empty" style="display:${heroCount ? "none" : "flex"};align-items:center;gap:11px;">
              <span style="width:8px;height:8px;border-radius:50%;background:var(--accent-lit);flex:none;animation:ml-pulse 1.6s ease-in-out infinite;"></span>
              <span style="font-family:var(--font-mono);font-size:15px;color:var(--on-dark2);">Listening for on-chain payments…</span>
            </div>
            <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dk-muted3);margin-top:8px;">calls paid in stablecoin · all rails</div>
          </div>
          <div style="font-family:var(--font-mono);font-size:12px;color:var(--dk-muted3);text-align:right;">+ <strong id="hm-freepow" style="color:var(--on-dark2);font-weight:500;">${fmtNum(viaPow)}</strong> more served free over proof-of-work<br><a href="https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns" style="color:var(--accent-lit);text-decoration:none;">verify on Basescan ↗</a></div>
        </div>
      </div>
    </div>
  </div>
</header>

<section style="max-width:1180px;margin:0 auto;padding:0 30px 20px;">
  <div class="hm-doors">
    <div class="hm-milled" style="padding:32px;display:flex;flex-direction:column;gap:16px;">
      <div style="font-family:var(--font-mono);font-size:11.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--faint);">For people</div>
      <h2 class="hm-h2" style="font-size:30px;">A finished report, cited and delivered.</h2>
      <p class="hm-lede" style="margin:0;font-size:15.5px;">Due-diligence dossier, 13F fund report, domain security audit, deep research. Every claim cited to a live source, PDF and data appendix included, refunded if it fails. Or subscribe and get the re-run in your inbox when something moves.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;">
        ${[["dossier", "Dossier"], ["fund-report", "Fund 13F"], ["domain-audit", "Domain audit"], ["research", "Deep research"]]
          .map(([product, label]) => `<a href="/reports" class="hm-chip" style="font-family:var(--font-body);font-size:13px;border-radius:999px;">${esc(label)} ${esc(cardPrice(product))}</a>`)
          .join("\n        ")}
        <a href="/monitors" class="hm-chip" style="font-family:var(--font-body);font-size:13px;border-radius:999px;">Monitor ${esc(monitorPrice())}/mo</a>
        <a href="/credits" class="hm-chip" style="font-family:var(--font-body);font-size:13px;border-radius:999px;">Credits for any tool, from $20</a>
      </div>
      <a href="/reports" style="margin-top:6px;font-size:14.5px;font-weight:500;color:var(--ink);text-decoration:none;">Browse reports →</a>
      <p style="margin:10px 0 0;font-size:13px;color:var(--muted);">Free previews from the filings: <a href="/reports/insider" style="color:var(--ink);">insider trades by ticker</a> · <a href="/reports/fund" style="color:var(--ink);">fund holdings (13F)</a> · <a href="/reports/dossier" style="color:var(--ink);">company dossiers</a></p>
    </div>
    <div class="hm-obsidian" style="padding:32px;display:flex;flex-direction:column;gap:16px;">
      <div style="font-family:var(--font-mono);font-size:11.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--dk-muted);">For agents</div>
      <h2 class="hm-h2" style="font-size:30px;color:var(--on-dark);">Find a tool, pay the 402, get JSON.</h2>
      <p style="margin:0;color:var(--dk-muted2);font-size:15.5px;line-height:1.5;font-weight:300;">Resolve any task in one free call, then pay per request in USDC on ${RAILS.length} chains or natively over MPP${tempoChipHtml ? " on Tempo" : ""}. Free tier by proof-of-work. Discoverable from <a href="/llms.txt" style="color:var(--on-dark);text-decoration:none;border-bottom:1px solid var(--dark-border2);">llms.txt</a>, <a href="/openapi.json" style="color:var(--on-dark);text-decoration:none;border-bottom:1px solid var(--dark-border2);">openapi.json</a>, <a href="/.well-known/x402" style="color:var(--on-dark);text-decoration:none;border-bottom:1px solid var(--dark-border2);">.well-known/x402</a> and the <a href="/docs#add" style="color:var(--on-dark);text-decoration:none;border-bottom:1px solid var(--dark-border2);">MCP connector</a>.</p>
      <div style="font-family:var(--font-mono);display:flex;flex-direction:column;border:1px solid rgba(255,255,255,.08);border-radius:12px;overflow:hidden;font-size:12.5px;">
        <a href="/api/find?q=whois" style="display:flex;justify-content:space-between;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.07);text-decoration:none;color:var(--on-dark2);"><span>GET /api/find?q=</span><span style="color:var(--accent-lit);">free</span></a>
        <a href="/tools" style="display:flex;justify-content:space-between;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.07);text-decoration:none;color:var(--on-dark2);"><span>GET /api/&lt;tool&gt;</span><span style="color:var(--accent-lit);">from $0.001</span></a>
        <a href="/tools/dossier" style="display:flex;justify-content:space-between;padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.07);text-decoration:none;color:var(--on-dark2);"><span>POST /v1/dossier</span><span style="color:var(--accent-lit);">$0.55</span></a>
        <a href="/guides/smart-order-router" style="display:flex;justify-content:space-between;padding:11px 16px;text-decoration:none;color:var(--on-dark2);"><span>POST /api/route/execute</span><span style="color:var(--accent-lit);">$0.01 + seller</span></a>
      </div>
      <div style="display:flex;gap:18px;font-family:var(--font-mono);font-size:12.5px;color:var(--dk-muted);flex-wrap:wrap;"><span title="POST-only JSON-RPC endpoint - not a browsable page">/mcp</span><a href="/api/pricing" style="color:var(--dk-muted);text-decoration:none;">/api/pricing</a><a href="/playground" style="color:var(--dk-muted);text-decoration:none;">playground · free</a></div>
    </div>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:36px 30px 0;">
  <div class="hm-proof" style="padding:26px 0;border-top:1px solid var(--hairline);border-bottom:1px solid var(--hairline);">
    <div style="display:flex;flex-direction:column;gap:4px;"><span style="font-family:var(--font-mono);font-size:26px;letter-spacing:-.02em;color:var(--ink);font-variant-numeric:tabular-nums;">${heroCount ? fmtNum(heroCount) : "·"}</span><span style="font-size:13px;color:var(--faint);">calls settled on chain, all rails</span></div>
    <div style="display:flex;flex-direction:column;gap:4px;"><span style="font-family:var(--font-mono);font-size:26px;letter-spacing:-.02em;color:var(--ink);font-variant-numeric:tabular-nums;">${fmtNum(count)}</span><span style="font-size:13px;color:var(--faint);">tools · ${packCount}+ skill packs</span></div>
    <div style="display:flex;flex-direction:column;gap:4px;"><span style="font-family:var(--font-mono);font-size:26px;letter-spacing:-.02em;color:var(--ink);font-variant-numeric:tabular-nums;">${RAILS.length}</span><span style="font-size:13px;color:var(--faint);">settlement rails · x402 + MPP</span></div>
    <div style="display:flex;flex-direction:column;gap:4px;"><span style="font-family:var(--font-mono);font-size:26px;letter-spacing:-.02em;color:var(--accent);">0%</span><span style="font-size:13px;color:var(--faint);">deducted from sellers · open source</span></div>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:34px 30px 0;">
  <div style="display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:14px;">
    <span class="hm-kicker" style="margin:0;">$ GET /why</span>
    <span style="font-size:13.5px;color:var(--muted);">What is different about paying here. Every claim links to the surface that proves it.</span>
  </div>
  <div class="hm-why" style="display:grid;grid-template-columns:repeat(4,1fr);gap:0;border:1px solid var(--hairline);background:var(--card);">
    ${[
      ["Pay for what the model used", "The metered gateway quotes each request from its own body; upto settles the actual usage under that ceiling, with a receipt on every response.", "/why#actual"],
      ["A failed call is not charged", "Settlement runs after the answer and an error cancels it, so a response with no receipt moved no money; a keyed retry replays the paid answer instead of paying twice.", "/why#never-charged"],
      ["One key buys everything", "Models on three wires, embeddings, images, speech, 500+ tools, memory and finished reports, all on the same wallet or credits key.", "/why#one-key"],
      ["No wallet required", "Prepaid credits by card and card checkout for reports, beside USDC or USDG on twelve chains and native MPP.", "/why#no-wallet"],
    ].map(([h3, p, href]) => `<a href="${href}" style="display:block;padding:20px 22px;border-right:1px solid var(--hairline);text-decoration:none;color:inherit;"><div style="font-weight:700;font-size:15.5px;color:var(--ink);margin-bottom:8px;">${h3}</div><div style="font-size:13.5px;line-height:1.55;color:var(--muted);">${p}</div></a>`).join("")}
  </div>
  <div style="margin-top:14px;font-family:var(--font-mono);font-size:13px;"><a href="/why" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">all seven, with proof →</a></div>
</section>

${chipsHtml ? `<section style="max-width:1180px;margin:0 auto;padding:34px 30px 0;">
  <div style="display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;margin-bottom:14px;">
    <span class="hm-kicker" style="margin:0;">$ GET /api/find?q=funding+rate</span>
    <span style="font-size:13.5px;color:var(--muted);">Live derivatives, DeFi, Solana and market data as deterministic JSON. Flat price per call, no exchange account and no data-vendor contract.</span>
  </div>
  <div style="display:flex;flex-wrap:wrap;gap:10px;">${chipsHtml}</div>
  <div style="margin-top:14px;font-family:var(--font-mono);font-size:13px;"><a href="/tools/category/crypto" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">all crypto and DeFi tools →</a></div>
</section>` : ""}

<section style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div class="hm-kicker">$ GET /api/pow/challenge?slug=hash</div>
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
    <h2 class="hm-h2">Or pay with CPU instead.</h2>
    <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">no wallet · no signup · runs in this tab</span>
  </div>
  <p class="hm-lede" style="max-width:700px;margin:0 0 26px;">The pure-CPU tools are payable in compute: the server issues a signed sha256 puzzle, you burn a fraction of a second solving it, and the call is served free. This is not a diagram - press the button and your browser will fetch a real challenge from the live server, solve it here, and make a real paid call.</p>
  <div class="hm-2col" style="gap:0;border-radius:18px;overflow:hidden;border:1px solid var(--hairline);">
    <div style="padding:26px;background:var(--card);border-right:1px solid var(--hairline);">
      <label for="hm-demo-in" style="display:block;font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:10px;">Text to hash</label>
      <input id="hm-demo-in" type="text" value="hello" placeholder="anything at all" style="width:100%;background:var(--paper);color:var(--ink);font-family:var(--font-mono);font-size:14px;padding:13px 14px;margin-bottom:14px;box-sizing:border-box;" />
      <button type="button" id="hm-demo-run" class="hm-btn hm-btn-dark" style="width:100%;justify-content:center;font-size:14px;">Run it free →</button>
      <ol style="margin:20px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:0;border-top:1px solid var(--hairline);">
        <li style="display:grid;grid-template-columns:22px 1fr;gap:12px;padding:13px 0;border-bottom:1px solid var(--hairline);"><span id="hm-step1-mark" style="font-family:var(--font-mono);font-size:12px;color:var(--accent);">·</span><span><span style="font-size:14px;color:var(--ink);font-weight:500;">Request a challenge</span><br><span id="hm-step1" style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);">signed, single-use, scoped to one tool</span></span></li>
        <li style="display:grid;grid-template-columns:22px 1fr;gap:12px;padding:13px 0;border-bottom:1px solid var(--hairline);"><span id="hm-step2-mark" style="font-family:var(--font-mono);font-size:12px;color:var(--accent);">·</span><span><span style="font-size:14px;color:var(--ink);font-weight:500;">Solve it in your browser</span><br><span id="hm-step2" style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);">~65k hashes at 16 bits</span></span></li>
        <li style="display:grid;grid-template-columns:22px 1fr;gap:12px;padding:13px 0;"><span id="hm-step3-mark" style="font-family:var(--font-mono);font-size:12px;color:var(--accent);">·</span><span><span style="font-size:14px;color:var(--ink);font-weight:500;">Call the tool, free</span><br><span id="hm-step3" style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);">hash the challenge, submit the token</span></span></li>
      </ol>
    </div>
    <div style="background:var(--surface);color:var(--on-dark);display:flex;flex-direction:column;">
      <div style="padding:14px 20px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;color:var(--dk-muted);display:flex;justify-content:space-between;gap:12px;">
        <span>POST /api/hash</span>
        <span id="hm-demo-status" style="color:var(--dk-muted3);">idle</span>
      </div>
      <pre id="hm-demo-out" class="hm-term" style="padding:20px;flex:1;color:var(--on-dark);"># the same three steps, from a shell:
curl -s '/api/pow/challenge?slug=hash'
# solve: sha256("&lt;challenge&gt;:" + nonce) with N leading zero bits
curl -X POST /api/hash \\
  -H 'content-type: application/json' \\
  -H 'X-Pow-Solution: &lt;token&gt;:&lt;nonce&gt;' \\
  -d '{"text":"hello","algo":"sha256"}'</pre>
      <div id="hm-demo-receipt" style="padding:14px 20px;border-top:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11.5px;color:var(--accent-lit);">no wallet needed · press Run to spend CPU instead</div>
    </div>
  </div>
  <div style="margin-top:16px;display:flex;gap:20px;flex-wrap:wrap;font-family:var(--font-mono);font-size:13px;">
    <a href="/playground" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">try every free tool in the playground →</a>
    <a href="/guides/x402-in-5-minutes" style="color:var(--muted);text-decoration:none;">how the free tier works →</a>
  </div>
</section>

<section id="sell" style="max-width:1180px;margin:0 auto;padding:70px 30px 0;">
  <div class="hm-kicker">$ POST /api/index/register</div>
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
    <h2 class="hm-h2">Sell into the agent economy.</h2>
    <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">free listing · nothing deducted · non-custodial</span>
  </div>
  <p class="hm-lede" style="max-width:680px;margin:0 0 30px;">Agents are already buying, and they cannot fill in a signup form. If you run an API - or a site AI crawlers keep scraping for free - the same rails that let them buy let you charge. Money moves buyer wallet → your wallet. Nothing sits in between.</p>
  <div class="hm-2col" style="margin-bottom:20px;">
    <div class="hm-card" style="padding:26px;display:flex;flex-direction:column;">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">01 / LIST AN x402 API</div>
      <h3 style="font-weight:500;font-size:22px;margin:0 0 10px;color:var(--ink);letter-spacing:-.02em;">Get routed by the Smart Order Router</h3>
      <p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0 0 18px;flex:1;font-weight:300;">Serve x402 challenges, register your origin, and the index crawler picks you up hourly. You get ranked next to ${fmtNum(count)} of our own tools by match score, then health, then price - and a public leaderboard row once your on-chain volume shows up.</p>
      <pre class="hm-term" style="margin:0 0 14px;background:var(--surface);color:var(--on-dark);padding:14px;border-radius:12px;font-size:11.5px;"><span style="color:var(--dk-muted3);"># or paste your origin below - same call, no terminal needed
</span>curl -X POST https://agent402.tools/api/index/register \\
  -H 'content-type: application/json' \\
  -d '{"origin":"https://api.you.com"}'</pre>
      <div class="hm-reg-row" style="display:flex;gap:10px;margin-top:auto;">
        <input id="hm-reg-origin" type="url" placeholder="https://api.yourdomain.com" style="flex:1;min-width:0;font-family:var(--font-mono);font-size:13px;padding:11px 14px;border:1px solid var(--dash);border-radius:999px;background:var(--paper);color:var(--ink);">
        <button id="hm-reg-go" class="hm-btn hm-btn-dark" style="font-size:13.5px;padding:11px 18px;">List it →</button>
      </div>
      <div id="hm-reg-out" style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);margin-top:8px;">Free, no account - we probe your origin's x402 surface and list you if it answers.</div>
    </div>
    <div class="hm-card" style="padding:26px;display:flex;flex-direction:column;">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">02 / Tollbooth a site</div>
      <h3 style="font-weight:500;font-size:22px;margin:0 0 10px;color:var(--ink);letter-spacing:-.02em;">Charge AI crawlers per page</h3>
      <p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0 0 18px;flex:1;font-weight:300;">Humans browse free; known bots get <span style="font-family:var(--font-mono);font-size:13px;color:var(--ink);">402 Payment Required</span> and either pay in USDC or solve a proof-of-work. The open, crypto-native answer to closed pay-per-crawl: no CDN lock-in, no merchant-of-record, no signup.</p>
      <pre class="hm-term" style="margin:0 0 18px;background:var(--surface);color:var(--on-dark);padding:14px;border-radius:12px;font-size:11.5px;"><span style="color:var(--dk-muted3);"># express · next.js · cloudflare · proxy · wordpress
</span>npm i agent402-tollbooth</pre>
      <a class="hm-btn hm-btn-ghost" href="/tollbooth" style="align-self:flex-start;font-size:13.5px;">Gate your crawlers →</a>
    </div>
  </div>

  <table style="font-family:var(--font-mono);font-size:13px;border:1px solid var(--hairline);border-radius:14px;overflow:hidden;background:var(--card);width:100%;max-width:480px;border-collapse:separate;border-spacing:0;">
    <caption style="text-align:left;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);padding:0 0 10px;">What a seller gets - full detail at <a href="/sell" style="color:var(--faint);">/sell</a></caption>
    <tbody>
      <tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:500;padding:13px 18px;color:var(--ink);width:230px;border-bottom:1px solid var(--hairline);">Listing fee</th><td style="padding:13px 18px;text-align:right;color:var(--accent);white-space:nowrap;border-bottom:1px solid var(--hairline);">$0</td></tr>
      <tr><th scope="row" style="text-align:left;font-weight:500;padding:13px 18px;color:var(--ink);border-bottom:1px solid var(--hairline);">Commission</th><td style="padding:13px 18px;text-align:right;color:var(--accent);white-space:nowrap;border-bottom:1px solid var(--hairline);">0%</td></tr>
      <tr><th scope="row" style="text-align:left;font-weight:500;padding:13px 18px;color:var(--ink);border-bottom:1px solid var(--hairline);">Routing</th><td style="padding:13px 18px;text-align:right;color:var(--muted);white-space:nowrap;border-bottom:1px solid var(--hairline);">health-aware</td></tr>
      <tr><th scope="row" style="text-align:left;font-weight:500;padding:13px 18px;color:var(--ink);border-bottom:1px solid var(--hairline);">Discovery</th><td style="padding:13px 18px;text-align:right;color:var(--muted);white-space:nowrap;border-bottom:1px solid var(--hairline);">4 surfaces</td></tr>
      <tr><th scope="row" style="text-align:left;font-weight:500;padding:13px 18px;color:var(--ink);border-bottom:1px solid var(--hairline);">How Agent402 earns</th><td style="padding:13px 18px;text-align:right;color:var(--muted);white-space:nowrap;border-bottom:1px solid var(--hairline);">buyer-side</td></tr>
      <tr><th scope="row" style="text-align:left;font-weight:500;padding:13px 18px;color:var(--ink);">Cross-chain buyers</th><td style="padding:13px 18px;text-align:right;color:var(--muted);white-space:nowrap;">Base · Algorand</td></tr>
    </tbody>
  </table>
  <p style="font-family:var(--font-mono);font-size:12.5px;line-height:1.6;color:var(--faint);margin:14px 0 0;"><strong style="color:var(--ink);font-weight:500;">${fmtNum(viaRouter)}</strong> of ${fmtNum(viaUsdc)} paid calls (${esc(routerPct)}) came through the router, which is the only path Agent402 earns on. Every other paid call went buyer wallet to seller wallet.</p>
  <div style="margin-top:16px;font-family:var(--font-mono);font-size:13px;"><a href="/sell" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">everything for sellers → /sell</a></div>
</section>

<section style="max-width:1180px;margin:64px auto 0;padding:0 30px;">
  <div class="hm-obsidian" style="padding:48px 40px;">
    <div class="hm-kicker" style="color:var(--accent-lit);">$ GET /api/leaderboard?include=external</div>
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
      <h2 class="hm-h2" style="color:var(--on-dark);">The open index for every seller.</h2>
      <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--dk-muted3);">hourly on-chain snapshot · Bazaar → eth_getLogs → aggregate by payTo</span>
    </div>
    <p style="font-size:16px;line-height:1.6;color:var(--dk-muted2);max-width:700px;margin:0 0 30px;font-weight:300;">Every x402 seller we can crawl, ranked by <strong style="color:var(--on-dark);font-weight:500;">real Base USDC settled volume</strong> - not self-reported traffic. <span style="font-family:var(--font-mono);font-size:14px;color:var(--on-dark);">include=external</span> excludes us from our own ranking, because a neutral index has to be checkable.</p>

    <div style="border:1px solid var(--dark-border2);border-radius:14px;overflow:hidden;background:rgba(255,255,255,.025);">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:13px 18px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);">
        <span style="font-size:11px;color:var(--dk-muted2);letter-spacing:.1em;">OTHER SELLERS · BY USDC SETTLED · 7d</span>
        <span style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--accent-lit);"><span style="width:6px;height:6px;border-radius:50%;background:var(--accent-lit);display:inline-block;animation:ml-pulse 1.8s ease-in-out infinite;"></span>LIVE</span>
      </div>
      <table style="font-family:var(--font-mono);font-size:12.5px;width:100%;">
        <thead><tr style="border-bottom:1px solid var(--dark-border);color:var(--dk-muted3);"><th scope="col" style="text-align:left;font-weight:400;padding:9px 18px;width:34px;">#</th><th scope="col" style="text-align:left;font-weight:400;padding:9px 18px;">seller</th><th scope="col" style="text-align:right;font-weight:400;padding:9px 18px;">usdc settled</th><th scope="col" style="text-align:right;font-weight:400;padding:9px 18px;">calls</th><th scope="col" style="text-align:right;font-weight:400;padding:9px 18px;">buyers</th></tr></thead>
        <tbody>${leaderboardRowsHtml}</tbody>
      </table>
      <div style="padding:11px 18px;border-top:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;color:var(--dk-muted3);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;"><span>Agent402 excluded · hourly snapshot</span><a href="/leaderboard" style="color:var(--accent-lit);text-decoration:none;">full leaderboard →</a></div>
    </div>

    <div style="margin-top:30px;border-top:1px solid var(--dark-border2);padding-top:24px;">
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px;">
        <h3 style="font-weight:500;font-size:22px;margin:0;color:var(--on-dark);letter-spacing:-.02em;">Settled on every rail, not just Base.</h3>
        <span style="font-family:var(--font-mono);font-size:12px;color:var(--dk-muted3);">calls settled per rail · live from /api/stats</span>
      </div>
      <p style="font-size:15px;line-height:1.6;color:var(--dk-muted2);max-width:700px;margin:0 0 20px;font-weight:300;">All ${RAILS.length} rails carry real settled traffic, not just the headline one. Buyers pay on the chain they already hold stablecoins on, gas is sponsored on EVM, and the router pays external sellers on that same chain.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:0;border:1px solid var(--dark-border2);border-radius:12px;overflow:hidden;">${railRowsHtml}</div>
      <div style="display:flex;flex-wrap:wrap;gap:10px 26px;margin-top:16px;font-family:var(--font-mono);font-size:12.5px;color:var(--dk-muted3);">
        <span><strong style="color:var(--on-dark);font-weight:500;">${fmtNum(attributed)}</strong> of ${fmtNum(viaUsdc)} paid calls carry a per-rail tag</span>
        <span><strong style="color:var(--accent-lit);font-weight:500;">${fmtNum(mppWire)}</strong> settled over the MPP wire</span>
        <a href="/what-is-x402" style="color:var(--accent-lit);text-decoration:none;">how the dual stack works →</a>
      </div>
    </div>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div class="hm-kicker">$ GET /api/bestsellers · $0.005</div>
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
    <h2 class="hm-h2">What agents actually pay for.</h2>
    <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">lanes shown · figures are a paid read</span>
  </div>
  <p class="hm-lede" style="max-width:700px;margin:0 0 24px;">Settlements are on chain, but <em style="color:var(--ink);font-style:normal;font-weight:400;">which tool an agent bought</em> is not - so this is the one demand signal no block explorer can reconstruct. Here are the lanes agents spend most in. The full per-tool ranking is itself a paid tool.</p>
  <div class="hm-card" style="overflow:hidden;">
    ${demandLanesHtml}
    <a href="/tools/bestsellers" style="display:grid;grid-template-columns:28px 1fr auto;gap:14px;align-items:center;padding:16px 20px;text-decoration:none;background:var(--surface);color:var(--on-dark);">
      <span style="font-family:var(--font-mono);font-size:12px;color:var(--dk-muted3);">·</span>
      <span style="font-family:var(--font-mono);font-size:13px;color:var(--dk-muted2);">the full ranking, plus buyer-diversity, revenue and trend lenses</span>
      <span style="font-family:var(--font-mono);font-size:13px;color:var(--accent-lit);white-space:nowrap;">$0.005 →</span>
    </a>
  </div>
  <div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:16px;font-family:var(--font-mono);font-size:13px;">
    <a href="/sell" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">list an API in one of these lanes →</a>
    <a href="/tools" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">all ${fmtNum(count)} tools →</a>
    <a href="/pricing" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;">price list →</a>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:12px;color:var(--faint);letter-spacing:.14em;text-transform:uppercase;margin-bottom:14px;">settles on</div>
  <div style="display:flex;flex-wrap:wrap;gap:10px;">${railLinksHtml}${tempoChipHtml}<a href="/reports" class="hm-chip" style="background:var(--btn-bg);color:var(--btn-fg);border-color:transparent;">Card via Stripe</a></div>
</section>

<section style="max-width:900px;margin:0 auto;padding:70px 30px 20px;">
  <div class="hm-kicker">$ GET /faq</div>
  <h2 class="hm-h2" style="margin:0 0 28px;">Questions people and agents ask.</h2>
  <div style="display:flex;flex-direction:column;gap:0;border-top:1px solid var(--hairline);">${faqHtml}</div>
  <p style="font-family:var(--font-mono);font-size:13px;color:var(--muted);margin:20px 0 0;">More, including data handling and the OpenAI-compatible gateway: <a href="/faq" style="color:var(--accent);font-weight:500;">/faq</a></p>
  <style>section details > summary::-webkit-details-marker{display:none;} section details[open] .ml-faq-mark{transform:rotate(45deg);} .ml-faq-mark{transition:transform .15s ease;display:inline-block;}</style>
</section>

<section style="max-width:1180px;margin:0 auto;padding:30px 30px 64px;">
  <div class="hm-obsidian" style="padding:56px 46px;position:relative;overflow:hidden;">
    <div aria-hidden="true" style="position:absolute;right:26px;top:-36px;font-weight:600;font-size:240px;line-height:1;color:transparent;-webkit-text-stroke:1.5px #ffffff12;pointer-events:none;">402</div>
    <div style="position:relative;">
      <h2 class="hm-h2" style="color:var(--on-dark);margin:0 0 16px;">Not x402-native yet?<br>You still have a way in.</h2>
      <p style="font-size:16.5px;line-height:1.6;color:var(--dk-muted2);margin:0 0 30px;max-width:560px;font-weight:300;">You do not have to rebuild anything. <strong style="color:var(--on-dark);font-weight:500;">agent402-tollbooth</strong> drops a pay-per-crawl gate in front of a site that speaks no protocol at all, and adding a tool to the catalog itself is roughly fifteen lines. Either route, you keep your own paywall and your own wallet.</p>
      <div style="display:flex;gap:11px;flex-wrap:wrap;">
        <a class="hm-btn hm-btn-lit" href="#sell">List your API - free →</a>
        <a class="hm-btn" href="/tollbooth" style="color:var(--on-dark);border:1px solid var(--dark-border2);">Tollbooth a site</a>
        <a class="hm-btn" href="/contribute" style="color:var(--dk-muted);border:1px solid var(--dark-border2);">Contribute a tool</a>
      </div>
    </div>
  </div>
</section>

${ledgerFooterFull()}

<script src="/js/home-hero.js"></script>`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "", jsonLd: [orgLd, websiteLd, appLd, datasetLd, surfacesLd, faqLd], extraCss, body });
}
