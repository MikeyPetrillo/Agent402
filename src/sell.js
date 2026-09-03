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
import { RAILS, railKey } from "./rails.js";

const REPO = "https://github.com/MikeyPetrillo/Agent402";

const COSTS = [
  ["listing fee", "$0", "green"],
  ["deducted from sellers", "0%", "green"],
  ["signup / account", "none", "ink"],
  ["review queue", "none", "ink"],
  ["who holds your funds", "you do", "ink"],
  ["you keep your paywall", "yes", "ink"],
  ["how we earn", "buyer side only", "accent"],
];

// Lane-level only. Per-tool slugs and purchase counts are the paid
// /api/bestsellers product and are deliberately never rendered here — they
// are the one demand signal nobody can reconstruct from the chain alone.
const LANES = [
  ["Hashing & encoding", "sha256/sha512 digests, HMAC, base64, JWT decoding: called dozens of times inside a single job."],
  ["Market & financial data", "Live quotes, historical series, Treasury yield curves, SEC company lookups."],
  ["Media & documents", "Speech-to-text, OCR, PDF parsing, article extraction, browser rendering."],
  ["Inference", "Cheap chat tiers used inside agent loops, plus embeddings and generation."],
  ["Live web search & cited answers", "Ranked results, and grounded answers with sources attached."],
  ["Crypto & onchain reads", "Token prices and metadata, balances, transaction history, gas."],
];

const REGISTER_STEPS = [
  ["01", "Serve a 402", "Return HTTP 402 Payment Required with your price, asset, network and payTo address on the endpoints you want to charge for. Any x402 middleware does this."],
  ["02", "Register the origin", "One POST to /api/index/register. No account, no review queue, no waiting on us."],
  ["03", "Get crawled", "The crawler reads your manifest, records your tools and advertised chains, and probes health hourly. Probes are never paid calls."],
  ["04", "Get routed", "The Smart Order Router ranks you by match score, then rolling health, then price - and sends matching buyer tasks your way."],
  ["05", "Get paid", "Buyers pay your wallet directly in USDC. Your settled volume shows up on the public on-chain leaderboard."],
];

const WHAT_WE_READ = [
  ["manifest", "/.well-known/x402"],
  ["your tools", "route · price · description"],
  ["your chains", "from the 402 challenge"],
  ["health probe", "hourly, never paid"],
];

const SURFACES = [
  ["Smart Order Router", "A buyer describes a task in words; the router resolves it to a tool and runs it. It does not care whose tool it is, and it will pay an external seller on the buyer's behalf.", "/api/route"],
  ["Marketplace directory", "Every indexed seller with tool count, advertised networks, last crawl and rolling health - browsable by humans and machines.", "/marketplace"],
  ["Per-chain market pages", "One page per settlement rail, so a buyer on Solana or Algorand can find sellers who take their chain.", "/solana"],
  ["On-chain leaderboard", "Ranked by real Base USDC settled. Once you have volume, you get a public row - and the row carries buyer diversity, not just dollars.", "/leaderboard"],
];

const COMMITMENTS = [
  "We never take custody of your funds. Buyers pay your wallet, not ours.",
  "We never deduct a commission from your advertised price.",
  "We never require an account, a contract, or a call with sales.",
  "We never rank you down for refusing the router - direct buyers are yours.",
  "We publish how the ranking works, and exclude ourselves from our own leaderboard.",
];

const FAQS = [
  ["What does it cost to list?", "Nothing. Listing is free, there is no signup and no review queue, and no commission is deducted from your price. Buyers pay your wallet directly and Agent402 never holds seller funds. We earn on the buyer side only, on the spread when a buyer asks the router to execute a call on their behalf."],
  ["How do agents find my API?", "Four surfaces: the marketplace directory, the per-chain market pages, the Smart Order Router which resolves a described task to a tool, and the public on-chain leaderboard once you have settled volume. The router ranks by match score, then rolling crawl health, then price."],
  ["What if my site is not an API?", "Use agent402-tollbooth - the pay-per-crawl mechanism is explained above under \"Charge the crawlers instead\". It ships as an open MIT middleware for Express, Next.js, Cloudflare Workers, a reverse proxy or WordPress: drop it in front of any site, no rebuild required."],
  ["Which chains can I get paid on?", "Advertise whichever you support. Agent402 settles across twelve rails: USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar and Algorand, plus USDG on Robinhood Chain. When a buyer pays on a chain you do not accept, the router pays you on your chain and relays the result."],
  ["How do I know what to charge, or what to build?", "Two paid intelligence tools, both half a cent a read. /api/bestsellers ranks what agents actually pay for across a 500+-tool catalog by distinct buyers, sales, revenue or buyer diversity, with a trend against the previous window. /api/demand-radar ranks what agents asked for and did not find. Neither can be reconstructed from on-chain data: settlements are public, but which tool was bought is not."],
  ["What happens if my endpoint goes down?", "The hourly probe notices and your rolling health drops, so the router routes around you until you recover. Health is a rolling window rather than a single failure, and new sellers are not punished for having no history yet."],
];

function costRow([label, value, tone]) {
  const color = tone === "green" ? "var(--green)" : tone === "accent" ? "var(--accent)" : "var(--on-dark)";
  return `<tr style="border-bottom:1px solid var(--dark-border);"><th scope="row" style="text-align:left;font-weight:400;padding:13px 18px;color:var(--dk-muted3);">${esc(label)}</th><td style="padding:13px 18px;text-align:right;color:${color};font-weight:700;">${esc(value)}</td></tr>`;
}

const formHtml = `
  <div id="list-api" style="border:1px solid var(--hairline);border-top:none;background:var(--paper);padding:18px 20px;">
    <div style="font-weight:800;font-size:15px;margin-bottom:8px;color:var(--ink);">Register in one call</div>
    <label for="reg-origin" style="display:block;font-family:var(--font-mono);font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;">Your API's origin</label>
    <div style="display:flex;gap:10px;">
      <input id="reg-origin" type="url" placeholder="https://api.yourdomain.com" style="flex:1;font-family:var(--font-mono);font-size:13px;padding:9px 12px;border:1px solid var(--hairline);background:var(--paper);color:var(--ink);">
      <button id="reg-go" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:13px;border:none;padding:9px 16px;cursor:pointer;">SUBMIT</button>
    </div>
    <div id="reg-out" role="status" aria-live="polite" style="font-family:var(--font-mono);font-size:12.5px;color:var(--muted);margin-top:8px;">Free, no account - we probe your origin's x402 surface and list you if it answers. Unreachable sellers drop out of routing (never off the roster) until they recover.</div>
    <p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:10px 0 0;">Speak MPP? Register your MPP server on the <a href="/mpp-marketplace#list-api" style="color:var(--muted);">MPP marketplace →</a> (one call, or <code>POST /api/mpp-index/register {"origin", "path"}</code>); dual-stack sellers our x402 crawl already sees answering MPP are picked up automatically.</p>
  </div>
  <script src="/js/reg-form.js"></script>`;

export function sellPage(baseUrl) {
  const canonical = `${baseUrl}/sell`;
  const title = "Sell your API to AI agents - get paid USDC per call with x402";
  const description =
    "List your API on the open x402 index and get paid in USDC per call, straight to your wallet. Free listing, no signup, nothing deducted from your price. Or tollbooth a site so AI crawlers pay per page. See what agents already pay for.";

  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", url: baseUrl, logo: { "@type": "ImageObject", url: `${baseUrl}/logo.png` }, sameAs: [REPO, "https://x.com/Agent402Tools"] };
  const breadcrumbLd = { "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "Sell", item: canonical },
  ] };
  const serviceLd = { "@type": "Service", "@id": `${canonical}#service`, name: "x402 seller listing and routing", provider: { "@id": `${baseUrl}/#organization` }, serviceType: "API monetization for AI agents", description: "Free listing on the open x402 index, with routing from the Smart Order Router and a public on-chain ranking. Buyers pay the seller's wallet directly; nothing is deducted from the seller's price.", areaServed: "Worldwide", offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free listing, no signup, no commission deducted from seller revenue" } };
  const howToLd = { "@type": "HowTo", "@id": `${canonical}#howto`, name: "How to sell your API to AI agents with x402", description: "List an x402-native API on the open index so AI agents can discover it and pay per call in USDC.", totalTime: "PT15M", estimatedCost: { "@type": "MonetaryAmount", currency: "USD", value: "0" }, step: REGISTER_STEPS.map(([n, t, b], i) => ({ "@type": "HowToStep", position: i + 1, name: t, text: b })) };
  const faqLd = { "@type": "FAQPage", "@id": `${canonical}#faq`, mainEntity: FAQS.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) };

  const extraCss = `
sl-scroll,.sl-scroll{overflow-x:auto}
.sl-scroll table{min-width:640px}
table{border-collapse:collapse;width:100%}
@media (max-width:900px){.sl-2col,.sl-hero{grid-template-columns:minmax(0,1fr)!important}}
`;

  const costsHtml = COSTS.map(costRow).join("");
  const lanesHtml = LANES.map(([lane, body], i) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><td style="padding:13px 18px;font-family:var(--font-mono);font-size:12px;color:var(--faint);">${String(i + 1).padStart(2, "0")}</td><th scope="row" style="text-align:left;font-weight:700;padding:13px 18px;color:var(--ink);font-size:15px;">${esc(lane)}</th><td style="padding:13px 18px;color:var(--muted);font-size:13.5px;line-height:1.5;">${esc(body)}</td></tr>`
  ).join("");
  const registerStepsHtml = REGISTER_STEPS.map(([n, t, b]) =>
    `<li style="display:grid;grid-template-columns:52px 1fr;gap:14px;padding:20px 22px;border-bottom:1px solid var(--hairline);"><span style="font-family:var(--font-mono);font-weight:700;font-size:13px;color:var(--accent);">${esc(n)}</span><div><h3 style="font-weight:800;font-size:16.5px;margin:0 0 7px;color:var(--ink);">${esc(t)}</h3><p style="font-size:14px;line-height:1.6;color:var(--muted);margin:0;">${esc(b)}</p></div></li>`
  ).join("");
  const whatWeReadHtml = WHAT_WE_READ.map(([label, value]) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:400;padding:9px 13px;color:var(--dk-muted3);">${esc(label)}</th><td style="padding:9px 13px;text-align:right;color:var(--on-dark);">${esc(value)}</td></tr>`
  ).join("") + `<tr><th scope="row" style="text-align:left;font-weight:400;padding:9px 13px;color:var(--dk-muted3);">what we never read</th><td style="padding:9px 13px;text-align:right;color:var(--accent-lit);">your keys or funds</td></tr>`;
  const surfacesHtml = SURFACES.map(([t, b, ref]) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:700;padding:16px 20px;color:var(--ink);width:220px;font-size:15px;">${esc(t)}</th><td style="padding:16px 20px;color:var(--muted);font-size:13.5px;line-height:1.55;">${esc(b)}</td><td style="padding:16px 20px;text-align:right;"><code style="font-family:var(--font-mono);font-size:11.5px;color:var(--ink);background:var(--card-zebra);padding:5px 9px;white-space:nowrap;">${esc(ref)}</code></td></tr>`
  ).join("");
  // Rail marks with per-chain asset — built from chainMark()/CHAIN_ORDER (no
  // duplicated SVG path data) plus RAILS for the asset (USDC everywhere
  // except Robinhood Chain's USDG).
  const railAssetBySlug = new Map(RAILS.map((r) => [railKey(r), r.asset]));
  const railsHtml = CHAIN_ORDER.map(([slug, name]) => {
    const asset = railAssetBySlug.get(slug) || "USDC";
    return `<a href="/${slug}" title="${esc(name)} x402 marketplace" style="display:inline-flex;align-items:center;gap:8px;color:var(--on-dark2);text-decoration:none;">${chainMark(slug, 21)}<span style="font-family:var(--font-mono);font-size:12.5px;white-space:nowrap;">${esc(name)}</span><span style="font-family:var(--font-mono);font-size:10px;color:var(--faint);white-space:nowrap;">${esc(asset)}</span></a>`;
  }).join("");
  const commitmentsHtml = COMMITMENTS.map((c) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><td style="padding:12px 14px;color:var(--accent);font-family:var(--font-mono);font-size:13px;width:26px;">✓</td><td style="padding:12px 14px;color:var(--muted);font-size:13.5px;line-height:1.5;">${esc(c)}</td></tr>`
  ).join("");
  const faqHtml = FAQS.map(([q, a]) =>
    `<article style="padding:24px 0;border-bottom:1px solid var(--hairline);"><h3 style="font-weight:800;font-size:18px;margin:0 0 10px;color:var(--ink);">${esc(q)}</h3><p style="font-size:15.5px;line-height:1.65;color:var(--muted);margin:0;">${esc(a)}</p></article>`
  ).join("");

  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:48px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:22px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">sell</span>
    </nav>
    <div class="sl-hero" style="display:grid;grid-template-columns:1.1fr .9fr;gap:52px;align-items:start;">
      <div>
        <div style="font-family:var(--font-mono);font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:20px;">for api operators &amp; site owners</div>
        <h1 style="font-weight:800;font-size:56px;line-height:.94;letter-spacing:-.035em;margin:0 0 22px;color:var(--ink);">Agents are buying.<br>Get <span style="color:var(--accent);">paid</span> for it.</h1>
        <p style="font-size:18px;line-height:1.5;color:var(--on-dark2);margin:0 0 16px;">An AI agent cannot sign up for your API. It has no email, no card, and no way to accept your terms. What it can do is <strong style="color:var(--ink);font-weight:700;">pay a fraction of a cent per call, unattended</strong>, from its own wallet.</p>
        <p style="font-size:16px;line-height:1.6;color:var(--muted);margin:0 0 30px;">Serve an x402 challenge, register your origin, and the index routes matching buyer tasks to you. Money moves buyer wallet to your wallet. We never hold it, and nothing is deducted from your price.</p>
        <div style="display:flex;flex-wrap:wrap;gap:11px;">
          <a href="#register" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:14px 22px;">LIST AN x402 API →</a>
          <a href="/tollbooth" style="background:transparent;border:1px solid var(--hairline);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 22px;">Tollbooth a site</a>
        </div>
      </div>
      <div style="border:1px solid var(--hairline);background:var(--surface);">
        <div style="padding:12px 18px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;color:var(--dk-muted);">WHAT IT COSTS YOU</div>
        <table style="font-family:var(--font-mono);font-size:13px;"><tbody>${costsHtml}</tbody></table>
        <a href="#earn" style="display:block;padding:12px 18px;border-top:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11.5px;color:var(--accent-lit);text-decoration:none;">Read exactly how we make money ↓</a>
      </div>
    </div>
  </div>
</header>

<section style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /api/bestsellers · $0.005 per read</div>
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
    <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0;color:var(--ink);">Demand you can't get anywhere else.</h2>
    <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">lanes shown · figures are a paid read</span>
  </div>
  <p style="font-size:16.5px;line-height:1.6;color:var(--muted);max-width:720px;margin:0 0 28px;">Settlements land on chain, but <em style="color:var(--on-dark2);">which tool an agent bought</em> never does - so this ledger cannot be reconstructed from a block explorer by anyone, including us. It is the one dataset in the x402 ecosystem that only the seller who served the call can see. Here are the lanes agents spend most in, in order. The numbers behind them are a tool, not a marketing page.</p>
  <div class="sl-scroll" style="border:1px solid var(--hairline);background:var(--card);">
    <table style="font-size:14px;">
      <caption style="text-align:left;font-family:var(--font-mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);padding:14px 18px;border-bottom:1px solid var(--hairline);">Where the buying is · ranked, figures withheld</caption>
      <thead><tr style="border-bottom:1px solid var(--hairline);font-family:var(--font-mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);"><th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;width:40px;">#</th><th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;">lane</th><th scope="col" style="text-align:left;font-weight:700;padding:12px 18px;">what agents buy in it</th></tr></thead>
      <tbody>${lanesHtml}
        <tr style="background:var(--footer-bg);"><th scope="row" style="text-align:left;font-weight:400;padding:16px 18px;color:var(--faint);font-family:var(--font-mono);font-size:12px;">the figures</th><td style="padding:16px 18px;color:var(--muted);font-size:13.5px;line-height:1.5;">Per-tool purchase counts, distinct buyers, revenue and buyer-diversity - plus each tool's trend against the previous window, over any 1-90 day span.</td><td style="padding:16px 18px;text-align:right;"><a href="/tools/bestsellers" style="font-family:var(--font-mono);font-size:13px;color:var(--accent-lit);text-decoration:none;white-space:nowrap;">$0.005 →</a></td></tr>
      </tbody>
    </table>
  </div>
  <div class="sl-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--hairline);border-top:none;">
    <div style="padding:24px;border-right:1px solid var(--hairline);background:var(--footer-bg);">
      <h3 style="font-family:var(--font-mono);font-weight:700;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 12px;">The unmet half</h3>
      <p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0 0 14px;">We also log what agents searched for and <strong style="color:var(--ink);">did not find</strong>. Those wish clusters are ranked at <span style="font-family:var(--font-mono);font-size:13px;color:var(--ink);">/api/demand-radar</span>, tagged by whether agents asked outright or simply failed to discover something that already exists - and flagged when a cluster is within two signals of the build threshold. It is the closest thing to a build list for an x402 seller, and nobody else is sitting on the data.</p>
      <a href="/tools/demand-radar" style="font-family:var(--font-mono);font-size:12.5px;color:var(--ink);text-decoration:none;border-bottom:1.5px solid var(--accent);padding-bottom:1px;">demand radar → $0.005 per read</a>
    </div>
    <div style="padding:24px;background:var(--footer-bg);">
      <h3 style="font-family:var(--font-mono);font-weight:700;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 12px;">What sells here</h3>
      <p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0;">Not novelty. The heaviest lanes are dull, deterministic and cheap - the calls an agent makes dozens of times inside a single job, where a wrong answer breaks the whole chain. You do not need novelty to sell into that. You need to be callable, correctly priced, and reachable when the router asks.</p>
    </div>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
    <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0;color:var(--ink);">Two ways in.</h2>
    <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">whether or not you speak the protocol yet</span>
  </div>
  <div class="sl-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--hairline);margin-top:14px;">
    <div style="padding:28px;border-right:1px solid var(--hairline);background:var(--card);display:flex;flex-direction:column;">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:16px;">01 / YOU HAVE AN API</div>
      <h3 style="font-weight:800;font-size:23px;margin:0 0 12px;color:var(--ink);">List it and get routed</h3>
      <p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0 0 18px;flex:1;">Return a 402 with your price, asset, network and payTo on the endpoints you want to charge for. Register the origin and the crawler reads your manifest on its next hourly pass. From then on the Smart Order Router can send you work, ranked against our own tools on the same terms.</p>
      <pre style="margin:0 0 18px;background:var(--surface);border:1px solid var(--dark-border);color:var(--on-dark);padding:14px;font-family:var(--font-mono);font-size:11.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># what a buyer's agent sees
</span>HTTP/1.1 402 Payment Required
x402-price: 0.004
x402-asset: USDC
x402-network: eip155:8453
x402-pay-to: 0xYourWallet&hellip;</pre>
      <a href="#register" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:13px;text-decoration:none;padding:12px 18px;align-self:flex-start;">REGISTER YOUR ORIGIN →</a>
    </div>
    <div style="padding:28px;background:var(--card);display:flex;flex-direction:column;">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:16px;">02 / YOU HAVE A SITE</div>
      <h3 style="font-weight:800;font-size:23px;margin:0 0 12px;color:var(--ink);">Charge the crawlers instead</h3>
      <p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0 0 18px;flex:1;">If AI crawlers are already taking your content for free, tollbooth is the open answer. Humans browse normally; known bots get a 402 and either pay in USDC or solve a proof-of-work. MIT licensed, one middleware, no CDN lock-in and no merchant of record standing between you and the money.</p>
      <pre style="margin:0 0 18px;background:var(--surface);border:1px solid var(--dark-border);color:var(--on-dark);padding:14px;font-family:var(--font-mono);font-size:11.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># express · next.js · cloudflare · proxy · wordpress
</span>npm i agent402-tollbooth</pre>
      <a href="/guides/coinbase-business-get-paid-by-agents" style="font-family:var(--font-mono);font-size:13px;color:var(--muted);text-decoration:none;margin-right:14px;">Coinbase Business account? →</a><a href="/tollbooth" style="background:transparent;border:1px solid var(--hairline);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:13px;text-decoration:none;padding:11px 18px;align-self:flex-start;">Gate your crawlers →</a>
    </div>
  </div>
</section>

<section id="register" style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ POST /api/index/register</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 16px;color:var(--ink);">Five steps, no account.</h2>
  <p style="font-size:16.5px;line-height:1.6;color:var(--muted);max-width:700px;margin:0 0 30px;">There is no dashboard to log into and nothing to wait for. You serve a 402, you tell us where you live, and the crawler does the rest.</p>
  <div class="sl-2col" style="display:grid;grid-template-columns:1.05fr .95fr;gap:0;border:1px solid var(--hairline);">
    <ol style="margin:0;padding:0;list-style:none;background:var(--card);">${registerStepsHtml}</ol>
    <div style="background:var(--footer-bg);padding:22px;">
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:12px;">One-liner (same thing, from a shell)</div>
      <pre style="margin:0 0 18px;background:var(--surface);border:1px solid var(--dark-border);color:var(--on-dark);padding:15px;font-family:var(--font-mono);font-size:11.5px;line-height:1.8;white-space:pre-wrap;word-break:break-word;">curl -X POST \\
  https://agent402.tools/api/index/register \\
  -H 'content-type: application/json' \\
  -d '{"origin":"https://api.you.com"}'</pre>
      ${formHtml}
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:18px 0 12px;">What we read from you</div>
      <table style="font-family:var(--font-mono);font-size:12px;border:1px solid var(--hairline);"><tbody>${whatWeReadHtml}</tbody></table>
      <p style="font-size:13px;line-height:1.6;color:var(--faint);margin:16px 0 0;">Want the audit first? <span style="font-family:var(--font-mono);color:var(--muted);">/api/x402-audit</span> grades any x402 endpoint's payment-security posture from the outside, without paying it. Run it on yourself before you list.</p>
    </div>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ POST /api/route</div>
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px;">
    <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0;color:var(--ink);">How buyers reach you.</h2>
    <span style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">match score → crawl health → price</span>
  </div>
  <p style="font-size:16.5px;line-height:1.6;color:var(--muted);max-width:720px;margin:0 0 28px;">Four surfaces, and the router is the one that matters. A buyer describes a task, the router resolves it to a tool, and it does not care whose tool it is. New sellers get the benefit of the doubt on health rather than being buried until they have a track record.</p>
  <div class="sl-scroll" style="border:1px solid var(--hairline);background:var(--card);">
    <table style="font-size:14px;">
      <tbody>${surfacesHtml}
        <tr style="background:var(--footer-bg);"><th scope="row" style="text-align:left;font-weight:400;padding:16px 18px;color:var(--faint);font-family:var(--font-mono);font-size:12px;">+ the rest</th><td style="padding:16px 18px;color:var(--muted);font-size:13.5px;line-height:1.5;">Ranked by distinct buyers, sales, revenue or buyer-diversity - plus each tool's trend against the previous window, over any 1-90 day span.</td><td style="padding:16px 18px;text-align:right;"><a href="/tools/bestsellers" style="font-family:var(--font-mono);font-size:13px;color:var(--accent-lit);text-decoration:none;white-space:nowrap;">$0.005 →</a></td></tr>
      </tbody>
    </table>
  </div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">$ GET /.well-known/x402</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 16px;color:var(--ink);">Get paid on your chain.</h2>
  <p style="font-size:16.5px;line-height:1.6;color:var(--muted);max-width:720px;margin:0 0 28px;">Advertise whichever rails you support. When a buyer pays on a chain you do not accept, the router settles with you on <em style="color:var(--on-dark2);">your</em> chain and relays the result - so a Solana buyer is not a lost sale for a Base-only seller. Gas is sponsored by the facilitator on EVM chains, so neither side needs the native token.</p>
  <div style="border:1px solid var(--hairline);background:var(--card);padding:26px;">
    <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:18px;">x402 settlement rails - each links to that chain's marketplace</div>
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:18px 26px;">${railsHtml}</div>
    <div style="font-family:var(--font-mono);font-size:11.5px;color:var(--faint);margin-top:20px;padding-top:16px;border-top:1px dashed var(--hairline);">gas sponsored by the facilitator on EVM chains - neither side needs the native token</div>
  </div>
</section>

<section id="earn" style="max-width:1180px;margin:0 auto;padding:60px 30px 0;">
  <div class="sl-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--hairline);">
    <div style="padding:30px;border-right:1px solid var(--hairline);background:var(--footer-bg);">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">HOW WE MAKE MONEY</div>
      <h2 style="font-weight:800;font-size:26px;margin:0 0 14px;color:var(--ink);">Buyer side, and only there</h2>
      <p style="font-size:15px;line-height:1.6;color:var(--muted);margin:0 0 14px;">A buyer who discovers you and pays you directly costs you nothing and earns us nothing. That is most traffic, and it is the point.</p>
      <p style="font-size:15px;line-height:1.6;color:var(--muted);margin:0 0 14px;">We earn when a buyer asks the <strong style="color:var(--ink);">router</strong> to execute on their behalf: they pay one flat fee for the convenience of not integrating you, and out of it you receive your full advertised price. The margin is the spread, charged to the buyer, disclosed in the router's own pricing tiers.</p>
      <p style="font-size:15px;line-height:1.6;color:var(--muted);margin:0;">We would rather write that down than let you find it out. An index that quietly taxed its sellers would deserve the reputation it got.</p>
    </div>
    <div style="padding:30px;background:var(--footer-bg);">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:14px;">WHAT WE WON'T DO</div>
      <h2 style="font-weight:800;font-size:26px;margin:0 0 18px;color:var(--ink);">The commitments</h2>
      <table style="font-size:14px;border:1px solid var(--hairline);"><tbody>${commitmentsHtml}</tbody></table>
      <p style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:14px 0 0;">verify in <a href="${esc(REPO)}/blob/main/src/x402-index.js" rel="noopener" style="color:var(--muted);">src/x402-index.js →</a></p>
    </div>
  </div>
</section>

<section style="max-width:900px;margin:0 auto;padding:60px 30px 0;">
  <h2 style="font-weight:800;font-size:34px;line-height:1.02;letter-spacing:-.025em;margin:0 0 26px;color:var(--ink);">Seller questions.</h2>
  <div style="display:flex;flex-direction:column;gap:0;border-top:1px solid var(--hairline);">${faqHtml}</div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:48px 30px 56px;">
  <div style="background:var(--surface);border:1px solid var(--hairline);padding:52px 44px;position:relative;overflow:hidden;">
    <div style="position:absolute;right:26px;top:-36px;font-weight:900;font-size:220px;line-height:1;color:transparent;-webkit-text-stroke:2px #ffffff10;pointer-events:none;">402</div>
    <div style="position:relative;">
      <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 14px;color:var(--on-dark);">One curl and you're listed.</h2>
      <p style="font-size:16.5px;line-height:1.6;color:var(--dk-muted2);margin:0 0 28px;max-width:520px;">No account, no review, nothing deducted. If the crawler can reach your 402, you are in the index on the next pass.</p>
      <div style="display:flex;gap:11px;flex-wrap:wrap;">
        <a href="#register" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:14px 24px;">REGISTER YOUR ORIGIN →</a>
        <a href="/tollbooth" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">Tollbooth a site</a>
        <a href="/leaderboard" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--dk-muted);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">SEE THE LEADERBOARD</a>
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
