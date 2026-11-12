// /sell: the seller front door. Two paths to get paid per call: list an
// existing x402 API on the open index (the five steps and the register form
// below), or tollbooth an existing site (/tollbooth).
//
// Commercial-sensitivity rule (same discipline as /api/stats' topPaidTools
// fix and sales-ledger.js's salesSummary contract): demand figures are the
// paid /api/bestsellers + /api/demand-radar reads, linked from the seller
// tools table. No tool slug is ever rendered next to a purchase count here.
//
// The register form reuses the exact id="list-api" markup + inline-script
// XSS posture from market-page.js (fetch → JSON → textContent only, never
// innerHTML) — real, tested, working functionality kept intact under the
// new visual treatment rather than dropped for a static curl example alone.
import { siteOrgLd } from "./site-org.js";
import { ledgerShell, ledgerFooterCompact, esc, codeBlock } from "./ledger-chrome.js";
import { RAILS, RAILS_AMP, chainDisplayName } from "./rails.js";
import { crawlIntervalLabel } from "./crawl-cadence.js";
import { routingProofSentence } from "./routing-proof.js";
import { ROUTE_ORDER } from "./route-order.js";
import { DISPATCH_REASONS } from "./dispatch-eligibility.js";
import { routerPayChains } from "./tools/route-execute.js";

// The chains the router can pay an outside seller on, read from route-execute
// (its map plus the EVM chains SOR_EVM_CHAINS lists, fixed for the process): it pays on the chain the BUYER paid on, from that chain's spending
// wallet, and never bridges to a seller's other chain. This page said a router
// "settles with you on your chain" when a buyer paid on one you do not accept.
const ROUTER_PAY_CHAINS = routerPayChains().map(chainDisplayName);
const listJoin = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
const ROUTER_CHAIN_SENTENCE = `When the router buys from a seller to resell the result to an agent, it pays the seller on the chain the agent paid on, so it reaches you only on chains you accept; it holds spending wallets for ${listJoin(ROUTER_PAY_CHAINS)}.`;

import { REPO_URL } from "./repo-link.js";
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

// Built per render: step 04 quotes routingProofSentence(), which reads the
// unproven-tier ceilings from env.
const registerSteps = () => [
  ["01", "Serve a 402", "Return HTTP 402 Payment Required with your price, asset, network and payTo address on the endpoints you want to charge for. Any x402 middleware does this."],
  ["02", "Register the origin", "One POST to /api/index/register. No account, no review queue, no waiting on us."],
  ["03", "Get crawled", `The crawler reads your manifest at once, records your tools and advertised chains, and re-probes it ${crawlIntervalLabel()}; health is scored from those probes. Probes are never paid calls.`],
  ["04", "Get ranked", `Your tools appear in Smart Order Router answers, shortlisted by how well they match a described task, so an accurate description is how you win it. The router buys from an outside seller only when the buyer asks for one (include: "external"). ${routingProofSentence()}`],
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
  ["delivery_failing", "Two of the router's recent paid calls to you, for different requests, did not deliver. It retries once that memo expires or a paid call to you delivers; fix the failing route first."],
];

// Each answer stands alone (it is also the FAQPage JSON-LD text); `links`
// render under the visible answer only.
const faqs = () => [
  { q: "What does it cost to list?", a: "Nothing. Listing is free, with no signup and no review queue, and nothing is deducted from your price: buyers pay your wallet directly." },
  { id: "earn", q: "How does Agent402 make money?", a: "Never from your sales: a buyer who pays you directly earns us nothing. We earn from buyers of our own 500+ tools, and from the router's disclosed spread when it buys from you at your full advertised price and resells the result. Asking us not to buy from you never changes your ranking, and we exclude ourselves from our own leaderboard.", links: [[`${REPO}/blob/main/src/route-order.js`, "ranking: route-order.js"], [`${REPO}/blob/main/src/ledger-leaderboard.js`, "self-exclusion: ledger-leaderboard.js"]] },
  { q: "How do agents find my API?", a: "Through the four surfaces above. The router runs a tool from this catalog unless the buyer asks for an outside seller (include: \"external\"), and its ranking order is in the router guide. GET /api/index?seller=<your host> returns its verdict for your origin.", links: [["/guides/smart-order-router", "the router guide"]] },
  { q: "What if my site is not an API?", a: "Use agent402-tollbooth, open MIT middleware for Express, Next.js, Cloudflare Workers, a reverse proxy or WordPress. People browse normally; known bots get a 402 and either pay in USDC or solve a proof-of-work.", links: [["/guides/coinbase-business-get-paid-by-agents", "paid into an exchange business account?"]] },
  { q: "Which chains can I get paid on?", a: `Advertise whichever you support. Agent402 itself accepts ${RAILS.length} rails: ${RAILS_AMP}. ${ROUTER_CHAIN_SENTENCE} With the x402 exact scheme on EVM chains, the facilitator submits the transfer and pays its gas, so neither side needs the native token.` },
  { id: "floor", q: "What is the settlement floor, and how do I get over it?", a: "A minimum of settled payments from distinct outside payers, read on chain, before the router treats a seller as proven; your seller-trust answer carries the exact gate. Payments funded from the wallet you are paid at, or from our own wallets (probes, payability checks, router purchases), never count. Below it you are still paid through the unproven lane." },
  { q: "What happens if my endpoint goes down?", a: `The probe that runs ${crawlIntervalLabel()} notices and your rolling health drops; you stay listed, and routing skips you until a probe succeeds again. A new seller with no probe history starts at full health.` },
];

// The paid seller reads: demand, payability and the outside audit. Prices come
// from the catalog the server passes in, never typed.
const SELLER_TOOLS = [
  ["bestsellers", "What agents pay for on this catalog, ranked by distinct buyers, sales, revenue or buyer diversity, with each tool's trend. Which tool was bought is in our sales ledger, not on chain."],
  ["demand-radar", "What agents asked this server for and did not find, ranked by cluster."],
  ["seller-payability", "Buys one call from your endpoint with our wallet and reports every leg, from the decoded 402 to the settlement receipt."],
  ["x402-audit", "Grades any x402 endpoint's payment-security posture from the outside, without paying it."],
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
    <div id="reg-out" role="status" aria-live="polite" style="font-size:var(--fs-sm);line-height:1.5;color:var(--muted);margin-top:8px;">We probe your origin and list you if it answers. An app under a path on a shared host registers with that path (https://host/app/name). An unreachable seller stays listed and is skipped by routing until it recovers.</div>
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
  const REGISTER_STEPS = registerSteps();
  const FAQS = faqs();
  const title = "Sell your API to AI agents - get paid USDC per call with x402";
  const description =
    "List your API on the open x402 index and get paid in USDC per call, straight to your wallet. Free listing, no signup, nothing deducted from your price. Or tollbooth a site so AI crawlers pay per page. See what agents already pay for.";

  const orgLd = siteOrgLd(baseUrl);
  const breadcrumbLd = { "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "Sell", item: canonical },
  ] };
  const serviceLd = { "@type": "Service", "@id": `${canonical}#service`, name: "x402 seller listing and routing", provider: { "@id": `${baseUrl}/#organization` }, serviceType: "API monetization for AI agents", description: "Free listing on the open x402 index, with ranking in the Smart Order Router and a public on-chain leaderboard for Base USDC settlement. Buyers pay the seller's wallet directly; nothing is deducted from the seller's price.", areaServed: "Worldwide", offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free listing, no signup, no commission deducted from seller revenue" } };
  const howToLd = { "@type": "HowTo", "@id": `${canonical}#howto`, name: "How to sell your API to AI agents with x402", description: "List an x402-native API on the open index so AI agents can discover it and pay per call in USDC.", totalTime: "PT15M", estimatedCost: { "@type": "MonetaryAmount", currency: "USD", value: "0" }, step: REGISTER_STEPS.map(([n, t, b], i) => ({ "@type": "HowToStep", position: i + 1, name: t, text: b })) };
  const faqLd = { "@type": "FAQPage", "@id": `${canonical}#faq`, mainEntity: FAQS.map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) };

  const extraCss = `
.sl-scroll{overflow-x:auto}
.sl-scroll table{min-width:640px}
table{border-collapse:collapse;width:100%}
.sl-details>summary{cursor:pointer;padding:14px 18px;font-weight:600;font-size:var(--fs-base);color:var(--ink)}
@media (max-width:900px){.sl-2col,.sl-hero{grid-template-columns:minmax(0,1fr)!important}}
`;

  const costsHtml = COSTS.map(costRow).join("");
  const registerStepsHtml = REGISTER_STEPS.map(([n, t, b]) =>
    `<li style="display:grid;grid-template-columns:52px 1fr;gap:14px;padding:20px 22px;border-bottom:1px solid var(--hairline);"><span style="font-family:var(--font-mono);font-weight:700;font-size:var(--fs-sm);color:var(--accent);">${esc(n)}</span><div><h3 style="font-weight:600;font-size:var(--fs-lg);margin:0 0 7px;color:var(--ink);">${esc(t)}</h3><p style="font-size:var(--fs-md);line-height:1.6;color:var(--muted);margin:0;">${esc(b)}</p></div></li>`
  ).join("");
  const whatWeReadHtml = WHAT_WE_READ.map(([label, value]) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:400;padding:9px 13px;color:var(--muted);">${esc(label)}</th><td style="padding:9px 13px;text-align:right;color:var(--ink);">${esc(value)}</td></tr>`
  ).join("") + `<tr><th scope="row" style="text-align:left;font-weight:400;padding:9px 13px;color:var(--muted);">what we never read</th><td style="padding:9px 13px;text-align:right;color:var(--accent);font-weight:700;">your keys or funds</td></tr>`;
  const surfacesHtml = SURFACES.map(([t, b, ref]) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:700;padding:16px 20px;color:var(--ink);width:220px;font-size:var(--fs-base);">${esc(t)}</th><td style="padding:16px 20px;color:var(--muted);font-size:var(--fs-md);line-height:1.55;">${esc(b)}</td><td style="padding:16px 20px;text-align:right;"><code style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ink);background:var(--card-zebra);padding:5px 9px;white-space:nowrap;">${esc(ref)}</code></td></tr>`
  ).join("");
  const sellerToolsHtml = SELLER_TOOLS.map(([slug, what]) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:400;padding:14px 18px;vertical-align:top;"><a href="/tools/${slug}" style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);white-space:nowrap;">${esc(slug)}</a></th><td style="padding:14px 18px;color:var(--muted);font-size:var(--fs-md);line-height:1.5;">${esc(what)}</td><td style="padding:14px 18px;text-align:right;font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);white-space:nowrap;vertical-align:top;">${price(slug) ? esc(price(slug)) : ""}</td></tr>`
  ).join("");
  const verdictsHtml = NEW_SELLER_VERDICTS.map(([code, todo]) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;vertical-align:top;font-weight:400;padding:14px 18px;"><code style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ink);background:var(--card-zebra);padding:4px 8px;white-space:nowrap;">${esc(code)}</code></th><td style="padding:14px 18px;color:var(--muted);font-size:var(--fs-sm);line-height:1.55;vertical-align:top;">${esc(DISPATCH_REASONS[code] || "")}</td><td style="padding:14px 18px;color:var(--ink);font-size:var(--fs-sm);line-height:1.55;vertical-align:top;">${esc(todo)}</td></tr>`
  ).join("");
  const faqHtml = FAQS.map(({ id, q, a, links }) =>
    `<article${id ? ` id="${id}"` : ""} style="padding:24px 0;border-bottom:1px solid var(--hairline);"><h3 style="font-weight:600;font-size:var(--fs-lg);margin:0 0 10px;color:var(--ink);">${esc(q)}</h3><p style="font-size:var(--fs-base);line-height:1.65;color:var(--muted);margin:0;">${esc(a)}</p>${links ? `<p class="ml-meta" style="font-family:var(--font-mono);font-size:var(--fs-xs);margin:10px 0 0;">${links.map(([href, label]) => `<span><a href="${esc(href)}"${href.startsWith("http") ? ' rel="noopener"' : ""} style="color:var(--muted);">${esc(label)} →</a></span>`).join("")}</p>` : ""}</article>`
  ).join("");
  const h2 = (text, mb = 16) => `<h2 style="font-weight:700;font-size:var(--fs-3xl);line-height:1.02;letter-spacing:-.025em;margin:0 0 ${mb}px;color:var(--ink);">${text}</h2>`;

  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:48px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);margin-bottom:22px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">sell</span>
    </nav>
    <div class="sl-hero" style="display:grid;grid-template-columns:1.1fr .9fr;gap:52px;align-items:start;">
      <div>
        <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.94;margin:0 0 22px;color:var(--ink);">Sell your API to AI agents</h1>
        <p class="ml-measure" style="font-size:var(--fs-lg);line-height:1.5;color:var(--muted);margin:0 0 30px;">Answer 402 with your price, register your origin, and agents pay your wallet per call; to charge AI crawlers on a site instead, use the tollbooth.</p>
        <div style="display:flex;flex-wrap:wrap;gap:11px;">
          <a class="btn btn-primary" href="#register">List an x402 API →</a>
          <a class="btn btn-secondary" href="/tollbooth">Tollbooth a site</a>
        </div>
      </div>
      <div style="border:1px solid var(--hairline);background:var(--panel);">
        <div style="padding:12px 18px;border-bottom:1px solid var(--panel-rule-2);font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.08em;color:var(--on-panel-dim);">WHAT IT COSTS YOU</div>
        <table class="ml-kv" style="font-family:var(--font-mono);font-size:var(--fs-sm);"><tbody>${costsHtml}</tbody></table>
        <a href="#earn" style="display:block;padding:12px 18px;border-top:1px solid var(--panel-rule-2);font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent-lit);text-decoration:none;">How we make money ↓</a>
      </div>
    </div>
  </div>
</header>

<section id="register" style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:12px;">$ POST /api/index/register</div>
  ${h2("Five steps, no account", 26)}
  <div class="sl-2col" style="display:grid;grid-template-columns:1.05fr .95fr;gap:0;border:1px solid var(--hairline);">
    <ol style="margin:0;padding:0;list-style:none;background:var(--card);">${registerStepsHtml}</ol>
    <div style="background:var(--footer-bg);padding:22px;">
      <div style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">One-liner, from a shell</div>
      ${codeBlock(`curl -X POST \\
  https://agent402.tools/api/index/register \\
  -H 'content-type: application/json' \\
  -d '{"origin":"https://seller.example"}'`, { name: "the register call", html: true, wrap: true, size: "xs", style: "margin:0 0 18px" })}
      ${formHtml}
      <div style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:18px 0 12px;">What we read from you</div>
      <table class="ml-kv" style="font-family:var(--font-mono);font-size:var(--fs-xs);border:1px solid var(--hairline);"><tbody>${whatWeReadHtml}</tbody></table>
    </div>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:12px;">$ POST /api/route</div>
  ${h2("How buyers reach you", 0)}
  <div class="ml-meta" style="margin:10px 0 14px;">${ROUTE_ORDER.map((o) => `<span>${esc(o.short)}</span>`).join("")}<span>then judged fit</span></div>
  <p class="ml-measure" style="font-size:var(--fs-lg);line-height:1.6;color:var(--muted);margin:0 0 28px;">Four places buyers find you. The router ranks matching tools from this catalog and the open index in the order above.</p>
  <div class="sl-scroll ml-rowlist" style="border:1px solid var(--hairline);background:var(--card);">
    <table style="font-size:var(--fs-md);"><tbody>${surfacesHtml}</tbody></table>
  </div>
</section>

<section id="new-sellers" style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:12px;">$ GET /api/index?seller=&lt;your host&gt;</div>
  ${h2("Listed, then paid")}
  <p class="ml-measure" style="font-size:var(--fs-lg);line-height:1.6;color:var(--muted);margin:0 0 28px;">Registering lists you at once. Being paid by the router is the second gate, described under Get ranked above and earned from real buyers past the <a href="#floor" style="color:var(--ink);">settlement floor</a>; your seller-trust answer carries its exact gate.</p>
  <details class="sl-details" style="border:1px solid var(--hairline);background:var(--card);">
    <summary>Router verdicts and what to do about each</summary>
    <div class="sl-scroll ml-rowlist" style="border-top:1px solid var(--hairline);">
      <table style="font-size:var(--fs-md);">
        <caption style="text-align:left;font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);padding:14px 18px;border-bottom:1px solid var(--hairline);">If routerDispatchReason says</caption>
        <thead><tr style="border-bottom:1px solid var(--hairline);font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);"><th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;">reason</th><th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;">what it means</th><th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;">what you can do</th></tr></thead>
        <tbody>${verdictsHtml}</tbody>
      </table>
    </div>
  </details>
</section>

<section id="seller-tools" style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  ${h2("Seller tools", 26)}
  <div class="sl-scroll ml-rowlist" style="border:1px solid var(--hairline);background:var(--card);">
    <table style="font-size:var(--fs-md);">
      <thead><tr style="border-bottom:1px solid var(--hairline);font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);"><th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;">tool</th><th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;">what it reads</th><th scope="col" style="text-align:right;font-weight:700;padding:12px 18px;">per read</th></tr></thead>
      <tbody>${sellerToolsHtml}</tbody>
    </table>
  </div>
</section>

<section id="faq" style="max-width:1180px;margin:0 auto;padding:60px 30px 56px;">
  ${h2("Seller questions", 26)}
  <div style="display:flex;flex-direction:column;gap:0;border-top:1px solid var(--hairline);max-width:900px;">${faqHtml}</div>
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
