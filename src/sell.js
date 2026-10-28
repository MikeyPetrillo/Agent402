// /sell — the seller front door (Aug 2026 revamp). Two paths to get paid per
// call: list an existing x402 API on the open index, or tollbooth an
// existing site so AI crawlers pay to fetch it.
//
// Commercial-sensitivity rule (same discipline as /api/stats' topPaidTools
// fix and sales-ledger.js's salesSummary contract): this page shows demand
// at LANE level only, with figures withheld and pointed at the paid
// /api/bestsellers + /api/demand-radar reads. No tool slug is ever rendered
// next to a purchase count here — that per-tool ranking is the one signal in
// the x402 ecosystem that cannot be reconstructed from the chain, and it is
// the product those two tools sell.
//
// The register form reuses the exact id="list-api" markup + inline-script
// XSS posture from market-page.js (fetch → JSON → textContent only, never
// innerHTML) — real, tested, working functionality kept intact under the
// new visual treatment rather than dropped for a static curl example alone.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { chainMark, CHAIN_ORDER } from "./chain-logos.js";
import { RAILS, railKey, RAILS_AMP } from "./rails.js";
import { crawlIntervalLabel } from "./crawl-cadence.js";
import { routerRankingSentence, routingProofSentence } from "./routing-proof.js";
import { ROUTE_ORDER } from "./route-order.js";
import { DISPATCH_REASONS } from "./dispatch-eligibility.js";
import { EXTERNAL_CHAIN_BY_NETWORK } from "./tools/route-execute.js";

// The chains the router can pay an outside seller on, read from route-execute's
// own map: it pays on the chain the BUYER paid on, from that chain's spending
// wallet, and never bridges to a seller's other chain. This page said a router
// "settles with you on your chain" when a buyer paid on one you do not accept.
const CHAIN_LABEL = { base: "Base", solana: "Solana", algorand: "Algorand", tempo: "Tempo" };
const ROUTER_PAY_CHAINS = [...new Set(Object.values(EXTERNAL_CHAIN_BY_NETWORK))].map((c) => CHAIN_LABEL[c] || c);
const listJoin = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
const ROUTER_CHAIN_SENTENCE = `When the router buys from a seller to resell the result to an agent, it pays the seller on the chain the agent paid on, so it reaches you only on chains you accept; it holds spending wallets for ${listJoin(ROUTER_PAY_CHAINS)}.`;

import { REPO_URL, ORG_SAME_AS } from "./repo-link.js";
const REPO = REPO_URL;

const COSTS = [
  ["listing fee", "$0", "green"],
  ["cut of your sales", "0%", "green"],
  ["signup / account", "none", "ink"],
  ["review queue", "none", "ink"],
  ["who holds your funds", "you do", "ink"],
  ["you keep your paywall", "yes", "ink"],
  ["seller tools", "optional, paid", "ink"],
];

// Lane-level only. Per-tool slugs and purchase counts are the paid
// /api/bestsellers product and are deliberately never rendered here — they
// are not derivable from the chain. The lanes are UNORDERED on purpose: an
// order would be a ranking claim this static page cannot derive (call volume
// and spend rank them differently), and the ranking is what the paid read sells.
const LANES = [
  ["Hashing & encoding", "sha256/sha512 digests, HMAC, base64, JWT decoding: called dozens of times inside a single job."],
  ["Market & financial data", "Live quotes, historical series, Treasury yield curves, SEC company lookups."],
  ["Media & documents", "Speech-to-text, OCR, PDF parsing, article extraction, browser rendering."],
  ["Inference", "Cheap chat tiers used inside agent loops, plus embeddings and generation."],
  ["Live web search & cited answers", "Ranked results, and grounded answers with sources attached."],
  ["Crypto & onchain reads", "Token prices and metadata, balances, transaction history, gas."],
];

// Built per render: step 04 quotes routingProofSentence(), which reads the
// unproven-tier ceilings from env.
const registerSteps = () => [
  ["01", "Serve a 402", "Return HTTP 402 Payment Required with your price, asset, network and payTo address on the endpoints you want to charge for. Any x402 middleware does this."],
  ["02", "Register the origin", "One POST to /api/index/register. No account, no review queue, no waiting on us."],
  ["03", "Get crawled", `The crawler reads your manifest at once, records your tools and advertised chains, and re-probes it ${crawlIntervalLabel()}; health is scored from those probes. Probes are never paid calls.`],
  ["04", "Get ranked", `Your tools appear in Smart Order Router answers: shortlisted by how well they match a described task, then ordered by crawl health, distinct payers and price (the full order is in the seller questions below). An accurate description is how you win it. The router buys from an outside seller only when the buyer asks for one (include: "external"). ${routingProofSentence()} GET /api/index?seller=<your host> shows its verdict for you.`],
  ["05", "Get paid", "Buyers pay your wallet directly, in the asset and on the chains your 402 names. Settled Base USDC volume shows up on the public on-chain leaderboard."],
];

const WHAT_WE_READ = [
  ["manifest", "/.well-known/x402"],
  ["your tools", "route · price · description"],
  ["your chains", "from the 402 challenge"],
  ["health probe", `${crawlIntervalLabel()}, never paid`],
];

const SURFACES = [
  ["Smart Order Router", "A buyer describes a task in words and the router ranks matching tools from this catalog and the open index. By default it runs a tool from this catalog; a buyer who passes include: \"external\" has it buy the result from the best outside seller instead and resell it.", "/api/route"],
  ["Marketplace directory", "Every indexed seller with tool count, advertised networks, last crawl and rolling health - browsable by humans and machines.", "/marketplace"],
  ["Per-chain market pages", "One page per settlement rail, so a buyer on Solana or Algorand can find sellers who take their chain.", "/solana"],
  ["On-chain leaderboard", "Ranked by real Base USDC settled. Once you have volume, you get a public row - and the row carries buyer diversity, not just dollars.", "/leaderboard"],
];

const COMMITMENTS = [
  "We never take custody of your funds. Buyers pay your wallet, not ours.",
  "We never deduct a commission from your advertised price.",
  "We never require an account, a contract, or a call with sales.",
  "If you ask us not to buy from you, your ranking does not change. Direct buyers are yours.",
  "We publish how the ranking works, and exclude ourselves from our own leaderboard.",
];

// New sellers: what each router verdict means and what the seller can do
// about it. The meaning column quotes the router's own reason text
// (src/dispatch-eligibility.js), so this page and a seller's /api/index
// verdict cannot word a reason differently. The settlement floor's figure is
// not typed on the page: it is a router setting (server config, readable in
// this repo), and a seller's own seller-trust answer carries its exact gate.
const NEW_SELLER_VERDICTS = [
  ["crawl_failed", "Serve your manifest, OpenAPI document or llms.txt at a public URL that answers with a parseable body. The next successful crawl restores routing; re-registering below crawls you now."],
  ["no_supported_route", "Advertise at least one chain the router pays on, alongside any others you support. The verdict at /api/index?seller=<your host> lists the chains it reads."],
  ["price_unknown", "Answer a bare unpaid request to every paid route with its 402, before you validate input. A route that needs a query parameter or a body still has to return its 402 to the crawler's empty probe, or no price can be read and the router never spends against an unknown one."],
  ["network_unknown", "Same fix: the paid route answered the probe with something other than a 402, so no chain was learned."],
  ["usdc_domain_mismatch", "Advertise the token's own EIP-712 name in the accept's extra (\"USD Coin\" for Base USDC). Until then no stock buyer can pay you, ours included."],
  ["gateway_rail_unsupported", "Nothing to fix: your batched rail works for buyers that speak it. To be routable today as well, add a second accept on the same chain signed under the token's own EIP-712 domain."],
  ["payment_method_unsupported", "Offer the standard exact scheme, where the buyer signs a USDC authorization and the facilitator settles it. A 402 that asks the buyer to send a transfer and prove it afterwards cannot be paid by a stock x402 buyer, ours included."],
  ["url_template", "Serve concrete paths; the router never buys a templated path such as /items/{id}."],
  ["category_excluded", "Nothing to fix: the route stays listed, buyers can still call it directly, and your other routes are judged on their own."],
  ["settlement_required", "If the verdict also carries unprovenTier: true, there is nothing to fix: you are callable now in the unproven lane, and payments from real outside buyers move you up."],
  ["settlement_self_funded", "Payments made with USDC your own paid wallet sent the payer are netted out. Only buyers' own money counts."],
  ["delivery_failing", "The router's last paid call to you did not deliver. It retries once that memo expires; fix the failing route first."],
];

// Prices come from the catalog the server passes in (priceNote), never typed.
const faqs = (priceNote) => [
  ["What does it cost to list?", "Nothing. Listing is free, there is no signup and no review queue, and no commission is deducted from your price. Buyers pay your wallet directly and Agent402 never holds seller funds. We never take a cut of your sales: we earn from buyers of our own tools and of the router (the spread when it buys from a seller and resells the result), and the seller tools on this page are optional paid reads."],
  ["How do agents find my API?", `Four places: the marketplace directory, the per-chain market pages, the Smart Order Router which ranks tools for a described task, and the public on-chain leaderboard once you have settled Base USDC volume. ${routerRankingSentence()} The router runs a tool from this catalog unless the buyer asks for an outside seller (include: "external"). ${routingProofSentence()} GET /api/index?seller=<your host> returns the router's verdict for your origin and the reason.`],
  ["What if my site is not an API?", "Use agent402-tollbooth - the pay-per-crawl mechanism is explained above under \"Charge the crawlers instead\". It ships as an open MIT middleware for Express, Next.js, Cloudflare Workers, a reverse proxy or WordPress: drop it in front of any site, no rebuild required."],
  ["Which chains can I get paid on?", `Advertise whichever you support. Agent402 itself accepts ${RAILS.length} rails: ${RAILS_AMP}. ${ROUTER_CHAIN_SENTENCE}`],
  ["How do I know what to charge, or what to build?", `Two paid intelligence tools: /api/bestsellers${priceNote("bestsellers")} ranks what agents actually pay for across a 500+-tool catalog by distinct buyers, sales, revenue or buyer diversity, with a trend against the previous window. /api/demand-radar${priceNote("demand-radar")} ranks what agents asked for and did not find. Neither can be reconstructed from on-chain data: settlements are public, but which tool was bought is not.`],
  ["What is the settlement floor, and how do I get over it?", "It is a minimum of settled payments from distinct outside payers that the router reads on chain before it treats a seller as proven. The exact gate for your origin, with its figures, is in your seller-trust answer. It is not a target to buy your way to: payments funded from the wallet you are paid at are netted out, and payments from our own wallets never count toward it, including purchases our router makes for its buyers. Until then a seller below it can still be paid through the unproven lane, but only buyers paying you directly move you toward the floor. Your own verdict and its reason are free at /api/index?seller=<your host>."],
  ["What happens if my endpoint goes down?", `The probe that runs ${crawlIntervalLabel()} notices and your rolling health drops; you stay listed, and routing skips you until a probe succeeds again. Health is a rolling window rather than a single failure, and a new seller with no probe history yet starts at full health in the rankings.`],
];

function costRow([label, value, tone]) {
  // The panel is obsidian in BOTH themes, so its accent text is --accent-lit,
  // the phosphor made for dark surfaces: light-mode --accent/--ok are the
  // deep greens for paper and read 2.5-3.5:1 here (rendered-contrast guard).
  const color = tone === "green" || tone === "accent" ? "var(--accent-lit)" : "var(--on-panel)";
  return `<tr style="border-bottom:1px solid var(--panel-rule);"><th scope="row" style="text-align:left;font-weight:400;padding:13px 18px;color:var(--on-panel-faint);">${esc(label)}</th><td style="padding:13px 18px;text-align:right;color:${color};font-weight:700;">${esc(value)}</td></tr>`;
}

const formHtml = `
  <div id="list-api" style="border:1px solid var(--hairline);border-top:none;background:var(--paper);padding:18px 20px;">
    <div style="font-weight:800;font-size:var(--fs-base);margin-bottom:8px;color:var(--ink);">Register in one call</div>
    <label for="reg-origin" style="display:block;font-family:var(--font-mono);font-size:var(--fs-2xs);color:var(--faint);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;">Your API's origin</label>
    <div style="display:flex;gap:10px;">
      <input id="reg-origin" type="url" placeholder="https://api.yourdomain.com" style="flex:1;font-family:var(--font-mono);font-size:var(--fs-sm);padding:9px 12px;border:1px solid var(--hairline);background:var(--paper);color:var(--ink);">
      <button class="btn btn-primary btn-sm" id="reg-go">Submit</button>
    </div>
    <div id="reg-out" role="status" aria-live="polite" style="font-size:var(--fs-sm);line-height:1.5;color:var(--muted);margin-top:8px;">Free, no account - we probe your origin's x402 surface and list you if it answers. An app served under a path on a shared host registers with that path (https://host/app/name); its documents are read from under it. An unreachable seller stays listed and is skipped by routing until it recovers.</div>
    <p style="font-size:var(--fs-sm);line-height:1.5;color:var(--faint);margin:10px 0 0;">Speak MPP? Register your MPP server on the <a href="/mpp-marketplace#list-api" style="color:var(--muted);">MPP marketplace →</a> (one call, or <code>POST /api/mpp-index/register {"origin", "path"}</code>); a seller whose x402 routes our crawl already sees answering MPP too is picked up automatically.</p>
  </div>
  <script src="/js/reg-form.js"></script>`;

// The price string for a catalog slug, or null when the catalog does not carry it (a
// render with no catalog, or a retired tool): the copy then omits the figure
// rather than quoting a stale one.
export function catalogPriceOf(catalog, slug) {
  for (const d of Object.values(catalog || {})) if (d && d.slug === slug && typeof d.price === "string") return d.price;
  return null;
}

export function sellPage(baseUrl, catalog = null) {
  const canonical = `${baseUrl}/sell`;
  const price = (slug) => catalogPriceOf(catalog, slug);
  const priceNote = (slug) => (price(slug) ? ` (${price(slug)} a read)` : "");
  const REGISTER_STEPS = registerSteps();
  const FAQS = faqs(priceNote);
  const title = "Sell your API to AI agents - get paid USDC per call with x402";
  const description =
    "List your API on the open x402 index and get paid in USDC per call, straight to your wallet. Free listing, no signup, nothing deducted from your price. Or tollbooth a site so AI crawlers pay per page. See what agents already pay for.";

  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", url: baseUrl, logo: { "@type": "ImageObject", url: `${baseUrl}/logo.png` }, sameAs: ORG_SAME_AS };
  const breadcrumbLd = { "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "Sell", item: canonical },
  ] };
  const serviceLd = { "@type": "Service", "@id": `${canonical}#service`, name: "x402 seller listing and routing", provider: { "@id": `${baseUrl}/#organization` }, serviceType: "API monetization for AI agents", description: "Free listing on the open x402 index, with ranking in the Smart Order Router and a public on-chain leaderboard for Base USDC settlement. Buyers pay the seller's wallet directly; nothing is deducted from the seller's price.", areaServed: "Worldwide", offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free listing, no signup, no commission deducted from seller revenue" } };
  const howToLd = { "@type": "HowTo", "@id": `${canonical}#howto`, name: "How to sell your API to AI agents with x402", description: "List an x402-native API on the open index so AI agents can discover it and pay per call in USDC.", totalTime: "PT15M", estimatedCost: { "@type": "MonetaryAmount", currency: "USD", value: "0" }, step: REGISTER_STEPS.map(([n, t, b], i) => ({ "@type": "HowToStep", position: i + 1, name: t, text: b })) };
  const faqLd = { "@type": "FAQPage", "@id": `${canonical}#faq`, mainEntity: FAQS.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) };

  const extraCss = `
sl-scroll,.sl-scroll{overflow-x:auto}
.sl-scroll table{min-width:640px}
table{border-collapse:collapse;width:100%}
@media (max-width:900px){.sl-2col,.sl-hero{grid-template-columns:minmax(0,1fr)!important}}
`;

  const costsHtml = COSTS.map(costRow).join("");
  const lanesHtml = LANES.map(([lane, body]) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:700;padding:13px 18px;color:var(--ink);font-size:var(--fs-base);">${esc(lane)}</th><td style="padding:13px 18px;color:var(--muted);font-size:var(--fs-md);line-height:1.5;">${esc(body)}</td></tr>`
  ).join("");
  const registerStepsHtml = REGISTER_STEPS.map(([n, t, b]) =>
    `<li style="display:grid;grid-template-columns:52px 1fr;gap:14px;padding:20px 22px;border-bottom:1px solid var(--hairline);"><span style="font-family:var(--font-mono);font-weight:700;font-size:var(--fs-sm);color:var(--accent);">${esc(n)}</span><div><h3 style="font-weight:600;font-size:var(--fs-lg);margin:0 0 7px;color:var(--ink);">${esc(t)}</h3><p style="font-size:var(--fs-md);line-height:1.6;color:var(--muted);margin:0;">${esc(b)}</p></div></li>`
  ).join("");
  const whatWeReadHtml = WHAT_WE_READ.map(([label, value]) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:400;padding:9px 13px;color:var(--muted);">${esc(label)}</th><td style="padding:9px 13px;text-align:right;color:var(--ink);">${esc(value)}</td></tr>`
  ).join("") + `<tr><th scope="row" style="text-align:left;font-weight:400;padding:9px 13px;color:var(--muted);">what we never read</th><td style="padding:9px 13px;text-align:right;color:var(--accent);font-weight:700;">your keys or funds</td></tr>`;
  const surfacesHtml = SURFACES.map(([t, b, ref]) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:700;padding:16px 20px;color:var(--ink);width:220px;font-size:var(--fs-base);">${esc(t)}</th><td style="padding:16px 20px;color:var(--muted);font-size:var(--fs-md);line-height:1.55;">${esc(b)}</td><td style="padding:16px 20px;text-align:right;"><code style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ink);background:var(--card-zebra);padding:5px 9px;white-space:nowrap;">${esc(ref)}</code></td></tr>`
  ).join("");
  // Rail marks with per-chain asset — built from chainMark()/CHAIN_ORDER (no
  // duplicated SVG path data) plus RAILS for the asset (USDC everywhere
  // except Robinhood Chain's USDG).
  const railAssetBySlug = new Map(RAILS.map((r) => [railKey(r), r.asset]));
  const railsHtml = CHAIN_ORDER.map(([slug, name]) => {
    const asset = railAssetBySlug.get(slug) || "USDC";
    return `<a href="/${slug}" title="${esc(name)} x402 marketplace" style="display:inline-flex;align-items:center;gap:8px;color:var(--ink);text-decoration:none;">${chainMark(slug, 21)}<span style="font-family:var(--font-mono);font-size:var(--fs-sm);white-space:nowrap;">${esc(name)}</span><span style="font-family:var(--font-mono);font-size:var(--fs-2xs);color:var(--faint);white-space:nowrap;">${esc(asset)}</span></a>`;
  }).join("");
  const commitmentsHtml = COMMITMENTS.map((c) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><td style="padding:12px 14px;color:var(--accent);font-family:var(--font-mono);font-size:var(--fs-sm);width:26px;">✓</td><td style="padding:12px 14px;color:var(--muted);font-size:var(--fs-md);line-height:1.5;">${esc(c)}</td></tr>`
  ).join("");
  const verdictsHtml = NEW_SELLER_VERDICTS.map(([code, todo]) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;vertical-align:top;font-weight:400;padding:14px 18px;"><code style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ink);background:var(--card-zebra);padding:4px 8px;white-space:nowrap;">${esc(code)}</code></th><td style="padding:14px 18px;color:var(--muted);font-size:var(--fs-sm);line-height:1.55;vertical-align:top;">${esc(DISPATCH_REASONS[code] || "")}</td><td style="padding:14px 18px;color:var(--ink);font-size:var(--fs-sm);line-height:1.55;vertical-align:top;">${esc(todo)}</td></tr>`
  ).join("");
  const faqHtml = FAQS.map(([q, a]) =>
    `<article style="padding:24px 0;border-bottom:1px solid var(--hairline);"><h3 style="font-weight:600;font-size:var(--fs-lg);margin:0 0 10px;color:var(--ink);">${esc(q)}</h3><p style="font-size:var(--fs-base);line-height:1.65;color:var(--muted);margin:0;">${esc(a)}</p></article>`
  ).join("");

  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:48px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin-bottom:22px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">sell</span>
    </nav>
    <div class="sl-hero" style="display:grid;grid-template-columns:1.1fr .9fr;gap:52px;align-items:start;">
      <div>
        <div style="font-family:var(--font-mono);font-size:var(--fs-xs);letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:20px;">for api operators &amp; site owners</div>
        <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.94;margin:0 0 22px;color:var(--ink);">Agents are buying.<br>Get <span style="color:var(--accent);">paid</span> for it.</h1>
        <p style="font-size:var(--fs-lg);line-height:1.5;color:var(--muted);margin:0 0 16px;">An AI agent cannot sign up for your API. It has no email, no card, and no way to accept your terms. What it can do is <strong style="color:var(--ink);font-weight:700;">pay a fraction of a cent per call, unattended</strong>, from its own wallet.</p>
        <p style="font-size:var(--fs-lg);line-height:1.6;color:var(--muted);margin:0 0 30px;">Serve an x402 challenge and register your origin: your tools join the open index, where agents and the Smart Order Router find them. Money moves buyer wallet to your wallet. We never hold it, and nothing is deducted from your price.</p>
        <div style="display:flex;flex-wrap:wrap;gap:11px;">
          <a class="btn btn-primary" href="#register">List an x402 API →</a>
          <a class="btn btn-secondary" href="/tollbooth">Tollbooth a site</a>
        </div>
      </div>
      <div style="border:1px solid var(--hairline);background:var(--panel);">
        <div style="padding:12px 18px;border-bottom:1px solid var(--panel-rule-2);font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.08em;color:var(--on-panel-dim);">WHAT IT COSTS YOU</div>
        <table class="ml-kv" style="font-family:var(--font-mono);font-size:var(--fs-sm);"><tbody>${costsHtml}</tbody></table>
        <a href="#earn" style="display:block;padding:12px 18px;border-top:1px solid var(--panel-rule-2);font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent-lit);text-decoration:none;">Read exactly how we make money ↓</a>
      </div>
    </div>
  </div>
</header>

<section style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <div class="ml-meta" style="font-size:var(--fs-sm);color:var(--accent);margin:0 0 12px;"><span>$ GET /api/bestsellers</span>${price("bestsellers") ? `<span>${esc(price("bestsellers"))} per read</span>` : ""}</div>
  <h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0;color:var(--ink);">Demand data from our own sales ledger.</h2>
  <div class="ml-meta" style="margin:10px 0 14px;"><span>lanes shown</span><span>figures are a paid read</span></div>
  <p style="font-size:var(--fs-lg);line-height:1.6;color:var(--muted);max-width:76ch;margin:0 0 28px;">Settlements land on chain, but <em style="color:var(--ink);">which tool an agent bought</em> does not, so these figures come from the sales ledger of the server that served each call and cannot be rebuilt from a block explorer. Below are the lanes agents buy in on this catalog, in no particular order. The ranking and the numbers behind it are a tool, not a marketing page.</p>
  <div class="sl-scroll ml-rowlist" style="border:1px solid var(--hairline);background:var(--card);">
    <table style="font-size:var(--fs-md);">
      <caption style="text-align:left;font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);padding:14px 18px;border-bottom:1px solid var(--hairline);"><span class="ml-meta" style="margin:0;font-size:inherit;color:inherit;"><span>Where the buying is</span><span>unranked, figures withheld</span></span></caption>
      <thead><tr style="border-bottom:1px solid var(--hairline);font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);"><th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;">lane</th><th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;">what agents buy in it</th></tr></thead>
      <tbody>${lanesHtml}
        <tr style="background:var(--footer-bg);"><th scope="row" style="text-align:left;font-weight:400;padding:16px 18px;color:var(--faint);font-family:var(--font-mono);font-size:var(--fs-xs);white-space:nowrap;">the figures</th><td style="padding:16px 18px;color:var(--muted);font-size:var(--fs-md);line-height:1.5;">Per-tool purchase counts, distinct buyers, revenue and buyer-diversity - plus each tool's trend against the previous window, over any 1-90 day span.</td><td style="padding:16px 18px;text-align:right;"><a href="/tools/bestsellers" style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);text-decoration:none;white-space:nowrap;">${esc(price("bestsellers") || "bestsellers")} →</a></td></tr>
      </tbody>
    </table>
  </div>
  <div class="sl-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--hairline);border-top:none;">
    <div style="padding:24px;border-right:1px solid var(--hairline);background:var(--footer-bg);">
      <h3 style="font-family:var(--font-mono);font-weight:600;font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 12px;">The unmet half</h3>
      <p style="font-size:var(--fs-base);line-height:1.6;color:var(--muted);margin:0 0 14px;">We also log what agents searched for and <strong style="color:var(--ink);">did not find</strong>. Those wish clusters are ranked at <span style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);white-space:nowrap;">/api/demand-radar</span>, tagged by whether agents asked outright or simply failed to discover something that already exists - and flagged when a cluster is within two signals of the build threshold. It is the closest thing to a build list for an x402 seller, read from what agents asked this server for.</p>
      <a href="/tools/demand-radar" style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);padding-bottom:1px;">demand radar →${price("demand-radar") ? ` ${esc(price("demand-radar"))} per read` : ""}</a>
    </div>
    <div style="padding:24px;background:var(--footer-bg);">
      <h3 style="font-family:var(--font-mono);font-weight:600;font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 12px;">What sells here</h3>
      <p style="font-size:var(--fs-base);line-height:1.6;color:var(--muted);margin:0;">Not novelty. The heaviest lanes are dull, deterministic and cheap - the calls an agent makes dozens of times inside a single job, where a wrong answer breaks the whole chain. You do not need novelty to sell into that. You need to be callable, correctly priced, and reachable when the router asks.</p>
    </div>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0;color:var(--ink);">Two ways in.</h2>
  <div class="ml-meta" style="margin:10px 0 14px;"><span>whether or not you speak the protocol yet</span></div>
  <div class="sl-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--hairline);margin-top:14px;">
    <div style="padding:28px;border-right:1px solid var(--hairline);background:var(--card);display:flex;flex-direction:column;">
      <div style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent);margin-bottom:16px;">01 / YOU HAVE AN API</div>
      <h3 style="font-weight:600;font-size:var(--fs-xl);margin:0 0 12px;color:var(--ink);">List it and get routed</h3>
      <p style="font-size:var(--fs-base);line-height:1.6;color:var(--muted);margin:0 0 14px;">Return a 402 with your price, asset, network and payTo on the endpoints you want to charge for, then register the origin.</p>
      <ul class="ml-ticks">
        <li>The crawler reads your manifest at once, then re-probes it ${crawlIntervalLabel()}</li>
        <li>Your tools rank in Smart Order Router answers, and a buyer who asks it for an outside seller can be routed to you</li>
      </ul>
      <pre style="margin:0 0 18px;background:var(--panel);border:1px solid var(--panel-rule);color:var(--on-panel);padding:14px;font-family:var(--font-mono);font-size:var(--fs-xs);line-height:1.75;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--on-panel-faint);"># what a buyer's agent sees
</span>HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6Mi&hellip;
<span style="color:var(--on-panel-faint);"># base64 JSON, decoded:
</span>{"x402Version":2,"accepts":[{"scheme":"exact",
  "network":"eip155:8453","amount":"4000",
  "asset":"0x833589fC&hellip;02913","payTo":"0xYourWallet&hellip;"}]}</pre>
      <div style="margin-top:auto;"><a class="btn btn-primary btn-sm" href="#register">Register your origin →</a></div>
    </div>
    <div style="padding:28px;background:var(--card);display:flex;flex-direction:column;">
      <div style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent);margin-bottom:16px;">02 / YOU HAVE A SITE</div>
      <h3 style="font-weight:600;font-size:var(--fs-xl);margin:0 0 12px;color:var(--ink);">Charge the crawlers instead</h3>
      <p style="font-size:var(--fs-base);line-height:1.6;color:var(--muted);margin:0 0 14px;">If AI crawlers are already taking your content for free, tollbooth puts an open pay-per-crawl gate in front of the site.</p>
      <ul class="ml-ticks">
        <li>People browse normally</li>
        <li>Known bots get a 402 and either pay in USDC or solve a proof-of-work</li>
        <li>MIT licensed middleware: no CDN lock-in, no merchant of record between you and the money</li>
      </ul>
      <pre style="margin:0 0 18px;background:var(--panel);border:1px solid var(--panel-rule);color:var(--on-panel);padding:14px;font-family:var(--font-mono);font-size:var(--fs-xs);line-height:1.75;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--on-panel-faint);"># express · next.js · cloudflare · proxy · wordpress
</span>npm i agent402-tollbooth</pre>
      <div class="ml-items" style="margin-top:auto;gap:10px 18px;align-items:center;"><a class="btn btn-secondary btn-sm" href="/tollbooth">Gate your crawlers →</a><a href="/guides/coinbase-business-get-paid-by-agents" style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--muted);text-decoration:none;">Paid into an exchange business account? →</a></div>
    </div>
  </div>
</section>

<section id="register" style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:12px;">$ POST /api/index/register</div>
  <h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0 0 16px;color:var(--ink);">Five steps, no account.</h2>
  <p style="font-size:var(--fs-lg);line-height:1.6;color:var(--muted);max-width:76ch;margin:0 0 30px;">There is no dashboard to log into and nothing to wait for. You serve a 402, you tell us where you live, and the crawler does the rest.</p>
  <div class="sl-2col" style="display:grid;grid-template-columns:1.05fr .95fr;gap:0;border:1px solid var(--hairline);">
    <ol style="margin:0;padding:0;list-style:none;background:var(--card);">${registerStepsHtml}</ol>
    <div style="background:var(--footer-bg);padding:22px;">
      <div style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">One-liner, from a shell</div>
      <pre style="margin:0 0 18px;background:var(--panel);border:1px solid var(--panel-rule);color:var(--on-panel);padding:15px;font-family:var(--font-mono);font-size:var(--fs-xs);line-height:1.8;white-space:pre-wrap;word-break:break-word;">curl -X POST \\
  https://agent402.tools/api/index/register \\
  -H 'content-type: application/json' \\
  -d '{"origin":"https://seller.example"}'</pre>
      ${formHtml}
      <div style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:18px 0 12px;">What we read from you</div>
      <table class="ml-kv" style="font-family:var(--font-mono);font-size:var(--fs-xs);border:1px solid var(--hairline);"><tbody>${whatWeReadHtml}</tbody></table>
      <p style="font-size:var(--fs-sm);line-height:1.6;color:var(--faint);margin:16px 0 0;">Already listed and nobody is paying? <span style="font-family:var(--font-mono);color:var(--muted);white-space:nowrap;">POST /api/seller-payability</span> buys one call from your own endpoint with our wallet and reports every leg: the 402 decoded, whether a stock client's signature was accepted, the settlement receipt.${price("seller-payability") ? ` It costs ${esc(price("seller-payability"))}.` : ""} Want the audit first? <span style="font-family:var(--font-mono);color:var(--muted);white-space:nowrap;">/api/x402-audit</span> grades any x402 endpoint's payment-security posture from the outside, without paying it${price("x402-audit") ? ` (${esc(price("x402-audit"))} a read)` : ""}. Run it on yourself before you list.</p>
    </div>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:12px;">$ POST /api/route</div>
  <h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0;color:var(--ink);">How buyers reach you.</h2>
  <div class="ml-meta" style="margin:10px 0 14px;">${ROUTE_ORDER.map((o) => `<span>${esc(o.short)}</span>`).join("")}<span>then judged fit</span></div>
  <p style="font-size:var(--fs-lg);line-height:1.6;color:var(--muted);max-width:76ch;margin:0 0 28px;">Four places buyers find you. In the router, a buyer describes a task and gets a ranked list of matching tools from this catalog and the open index; a new seller with no probe history starts at full crawl health in that ranking. Being paid by the router is a separate gate. ${esc(routingProofSentence())}</p>
  <div class="sl-scroll ml-rowlist" style="border:1px solid var(--hairline);background:var(--card);">
    <table style="font-size:var(--fs-md);">
      <tbody>${surfacesHtml}
        <tr style="background:var(--footer-bg);"><th scope="row" style="text-align:left;font-weight:400;padding:16px 18px;color:var(--faint);font-family:var(--font-mono);font-size:var(--fs-xs);">+ the rest</th><td style="padding:16px 18px;color:var(--muted);font-size:var(--fs-md);line-height:1.5;">Ranked by distinct buyers, sales, revenue or buyer-diversity - plus each tool's trend against the previous window, over any 1-90 day span.</td><td style="padding:16px 18px;text-align:right;"><a href="/tools/bestsellers" style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);text-decoration:none;white-space:nowrap;">${esc(price("bestsellers") || "bestsellers")} →</a></td></tr>
      </tbody>
    </table>
  </div>
</section>

<section id="new-sellers" style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:12px;">$ GET /api/index?seller=&lt;your host&gt;</div>
  <h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0;color:var(--ink);">New sellers: listed, then paid.</h2>
  <div class="ml-meta" style="margin:10px 0 14px;"><span>two separate gates</span><span>your verdict is free to read</span></div>
  <p style="font-size:var(--fs-lg);line-height:1.6;color:var(--muted);max-width:76ch;margin:0 0 14px;">Registering lists you at once: your tools appear in search, in router answers and on the market pages. Being paid by the router is the second gate, and it is earned from real buyers. ${esc(routingProofSentence())}</p>
  <p style="font-size:var(--fs-lg);line-height:1.6;color:var(--muted);max-width:76ch;margin:0 0 28px;">The settlement floor is a router setting that counts settled payments from distinct outside payers, read on chain; the exact gate for your origin, with its figures, is in your seller-trust answer. It is not a number to buy your way to: payments funded from the wallet you are paid at are netted out, and payments from our own wallets never count toward it: that includes our probes and payability checks, and the purchases our router makes for its buyers. The unproven lane pays you; it is buyers paying you directly that move you toward the floor. Nothing here sells placement. Your verdict, with the reason below, is at <span style="font-family:var(--font-mono);font-size:var(--fs-md);color:var(--ink);overflow-wrap:anywhere;">/api/index?seller=&lt;your host&gt;</span>.</p>
  <div class="sl-scroll ml-rowlist" style="border:1px solid var(--hairline);background:var(--card);">
    <table style="font-size:var(--fs-md);">
      <caption style="text-align:left;font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);padding:14px 18px;border-bottom:1px solid var(--hairline);">If routerDispatchReason says</caption>
      <thead><tr style="border-bottom:1px solid var(--hairline);font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);"><th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;">reason</th><th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;">what it means</th><th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;">what you can do</th></tr></thead>
      <tbody>${verdictsHtml}</tbody>
    </table>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:12px;">$ GET /.well-known/x402</div>
  <h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0 0 16px;color:var(--ink);">Get paid on the chains you accept.</h2>
  <p style="font-size:var(--fs-lg);line-height:1.6;color:var(--muted);max-width:76ch;margin:0 0 28px;">Advertise every rail you support: each one is another set of buyers who can pay you directly. ${esc(ROUTER_CHAIN_SENTENCE)} With the x402 exact scheme on EVM chains, the facilitator submits the transfer and pays its gas, so neither side needs the native token.</p>
  <div style="border:1px solid var(--hairline);background:var(--card);padding:26px;">
    <div class="ml-meta" style="font-size:var(--fs-2xs);letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:0 0 18px;"><span>x402 settlement rails</span><span>each opens that chain's market</span></div>
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:18px 26px;">${railsHtml}</div>
    <div style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin-top:20px;padding-top:16px;border-top:1px dashed var(--hairline);">x402 exact on EVM chains: the facilitator pays gas, neither side needs the native token</div>
  </div>
</section>

<section id="earn" style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <div class="sl-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--hairline);">
    <div style="padding:30px;border-right:1px solid var(--hairline);background:var(--footer-bg);">
      <div style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent);margin-bottom:14px;">HOW WE MAKE MONEY</div>
      <h2 style="font-weight:700;font-size:var(--fs-2xl);margin:0 0 14px;color:var(--ink);">Never from your sales</h2>
      <p style="font-size:var(--fs-base);line-height:1.6;color:var(--muted);margin:0 0 14px;">A buyer who discovers you and pays you directly costs you nothing and earns us nothing. We earn from buyers of our own 500+ tools, which sit in the same index as yours, and of the router.</p>
      <p style="font-size:var(--fs-base);line-height:1.6;color:var(--muted);margin:0 0 14px;">We earn when the <strong style="color:var(--ink);">router</strong> buys from you and resells the result to a buyer: the buyer pays us one flat price for the convenience of not integrating you, and we pay you your full advertised price. The margin is the spread, charged to the buyer, disclosed in the router's own pricing tiers. The seller tools on this page (bestsellers, demand radar, the payability check and the audit) are optional paid reads.</p>
      <p style="font-size:var(--fs-base);line-height:1.6;color:var(--muted);margin:0;">We would rather write that down than let you find it out. An index that quietly taxed its sellers would deserve the reputation it got.</p>
    </div>
    <div style="padding:30px;background:var(--footer-bg);">
      <div style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent);margin-bottom:14px;">WHAT WE WON'T DO</div>
      <h2 style="font-weight:700;font-size:var(--fs-2xl);margin:0 0 18px;color:var(--ink);">The commitments</h2>
      <table style="font-size:var(--fs-md);border:1px solid var(--hairline);"><tbody>${commitmentsHtml}</tbody></table>
      <p class="ml-meta" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin:14px 0 0;"><span>ranking: <a href="${esc(REPO)}/blob/main/src/route-order.js" rel="noopener" style="color:var(--muted);">route-order.js →</a></span><span>self-exclusion: <a href="${esc(REPO)}/blob/main/src/ledger-leaderboard.js" rel="noopener" style="color:var(--muted);">ledger-leaderboard.js →</a></span></p>
    </div>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0 0 26px;color:var(--ink);">Seller questions.</h2>
  <div style="display:flex;flex-direction:column;gap:0;border-top:1px solid var(--hairline);max-width:900px;">${faqHtml}</div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:48px 30px 56px;">
  <div class="ml-cta-panel" style="background:var(--panel);border:1px solid var(--hairline);padding:52px 44px;position:relative;overflow:hidden;">
    <div style="position:relative;">
      <h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0 0 14px;color:var(--on-panel);">One curl and you're listed.</h2>
      <p style="font-size:var(--fs-lg);line-height:1.6;color:var(--on-panel-muted);margin:0 0 28px;max-width:64ch;">No account, no review, nothing deducted. Registering reads your origin at once: if the crawler can reach your 402, you are in the index as soon as that read completes.</p>
      <div style="display:flex;gap:11px;flex-wrap:wrap;">
        <a class="btn btn-primary on-panel" href="#register">Register your origin →</a>
        <a class="btn btn-secondary on-panel" href="/tollbooth">Tollbooth a site</a>
        <a class="btn btn-secondary on-panel" href="/leaderboard">See the leaderboard</a>
      </div>
    </div>
  </div>
</section>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/sell",
    jsonLd: [orgLd, breadcrumbLd, serviceLd, howToLd, faqLd],
    extraCss,
    body,
  });
}
