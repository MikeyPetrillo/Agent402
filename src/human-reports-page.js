// Served pages for the human front door: the checkout page (/reports) and the
// report-delivery page (/r/:sessionId and /m/:reportId). Rendered through the
// shared ledger shell (2026-08-22 redesign) so they carry the site's nav,
// footer, tokens, fonts and SEO head like every other page; the page-level
// classes below are consumed by assets/js/reports.js and report-view.js
// (keep the class names stable - the scripts select on them).
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { sampleLinkFor, SAMPLES } from "./sample-reports.js";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { monitorMapJson } from "./report-upgrade.js";
import { priceUsdFor } from "./report-tiers.js";

// Shared by /reports, /r/:id, /m/:id and the monitors pages.
export const REPORTS_CSS = `
  .wrap{max-width:940px;margin:0 auto;padding:0 26px}
  .eyebrow{font-family:var(--font-mono);font-size:11.5px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
  .btn{font-family:var(--font-body);font-size:15px;font-weight:500;border-radius:999px;border:1px solid transparent;cursor:pointer;padding:11px 18px;transition:transform .12s ease,border-color .15s ease;display:inline-flex;gap:8px;align-items:center;text-decoration:none;white-space:nowrap}
  .btn:hover{transform:translateY(-1px)}
  .btn-primary{background:var(--btn-bg);color:var(--btn-fg);box-shadow:var(--btn-shadow)}
  .btn-ghost{background:var(--chip-bg);color:var(--ink);border-color:var(--dash)}.btn-ghost:hover{border-color:var(--ink);color:var(--ink)}
  .btn:disabled{opacity:.5;cursor:default;transform:none}
  .hero{padding:64px 0 20px}.hero h1{font-weight:500;font-size:clamp(34px,5vw,56px);line-height:1.02;letter-spacing:-.035em;margin:14px 0 0;color:var(--ink);text-wrap:balance}.hero h1 em{font-style:normal;color:var(--faint)}
  .lede{font-size:19px;line-height:1.5;color:var(--muted);max-width:620px;margin:16px 0 0;font-weight:300}.lede b{color:var(--ink);font-weight:500}
  .products{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:18px;margin-top:8px}
  /* Cards are a flex column so the buy button sits on one baseline across a
     grid row however long the copy above it runs (the error slot takes the
     slack); the grid already stretches cards to equal height. */
  .pcard{display:flex;flex-direction:column;border:1px solid var(--hairline);border-radius:18px;background:var(--card);padding:24px;box-shadow:inset 0 1px 0 var(--card-inset),0 1px 2px rgba(0,0,0,.08)}
  .pcard .err{margin-top:auto;padding-top:8px}
  .pcard h3{font-weight:500;font-size:21px;letter-spacing:-.02em;margin:0;color:var(--ink)}.pcard .k{font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:8px}
  .pcard p{color:var(--muted);font-size:15px;line-height:1.5;margin:8px 0 16px;font-weight:300}
  /* Report bodies can carry markdown tables (filings, holders). Wide tables get
     their own scroll so the page body never scrolls sideways. */
  .tablewrap{overflow-x:auto;margin:14px 0;border:1px solid var(--hairline);border-radius:12px}
  .tablewrap table{width:100%;border-collapse:collapse;font-size:14px}
  .tablewrap th{text-align:left;font-weight:500;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);padding:9px 12px;border-bottom:1px solid var(--hairline);white-space:nowrap}
  .tablewrap td{padding:9px 12px;border-bottom:1px solid var(--hairline);vertical-align:top;font-variant-numeric:tabular-nums}
  .tablewrap tr:last-child td{border-bottom:0}
  .pcard.sel{border-color:var(--ink);box-shadow:0 0 0 1px var(--ink)}
  .field{display:flex;gap:8px;background:var(--paper);border:1px solid var(--dash);border-radius:12px;padding:6px 6px 6px 14px;margin-bottom:12px}
  .field:focus-within{border-color:var(--ink)}
  .field input{flex:1;border:0;background:transparent;color:var(--ink);font-family:var(--font-body);font-size:16px;outline:none;min-width:0}
  .gets{font-size:13.5px;line-height:1.55;color:var(--muted);margin:0 0 6px}.gets b{color:var(--ink);font-weight:500}
  .note{font-family:var(--font-mono);font-size:11.5px;color:var(--faint);margin-top:16px}
  .err{color:#A5322B;font-size:14px;margin-top:8px;min-height:18px}
  .trust{display:flex;gap:20px;flex-wrap:wrap;color:var(--muted);font-size:14px;margin-top:16px}
  .trust span{display:inline-flex;gap:7px;align-items:center}.dot{width:5px;height:5px;border-radius:50%;background:var(--accent)}
  .report{background:var(--card);border:1px solid var(--hairline);border-radius:18px;padding:34px 38px;margin-top:24px}
  .report h1{font-weight:500;font-size:30px;letter-spacing:-.03em;margin:0 0 6px;color:var(--ink)}.report h2{font-weight:500;font-size:22px;letter-spacing:-.02em;margin:28px 0 8px;color:var(--ink)}.report h3{font-weight:500;font-size:18px;margin:20px 0 6px;color:var(--ink)}
  .report p{color:var(--muted);margin:0 0 14px;line-height:1.65}.report a{word-break:break-word;color:var(--accent)}
  .report ol,.report ul{color:var(--muted);line-height:1.6}
  .cite{font-family:var(--font-mono);font-size:.72em;font-weight:500;color:var(--accent);vertical-align:super}
  @keyframes sp{to{transform:rotate(360deg)}}
  .spin{display:inline-block;width:16px;height:16px;border:2px solid var(--dash);border-top-color:var(--ink);border-radius:50%;animation:sp .8s linear infinite;vertical-align:-3px;margin-right:8px}
  .status{background:var(--card);border:1px solid var(--hairline);border-radius:18px;padding:44px 34px;text-align:center;margin-top:24px}
  .status h2{font-weight:500;font-size:24px;letter-spacing:-.02em;margin:0 0 10px;color:var(--ink)}.status p{color:var(--muted);max-width:460px;margin:0 auto 8px;line-height:1.55}
  .report-actions{display:flex;gap:10px;align-items:center;margin:22px 0 4px;flex-wrap:wrap}
  .keep-hint{color:var(--muted);font-size:13px;margin-top:8px;line-height:1.5}
  .keep-hint ul{margin:6px 0 0;padding-left:18px}
  .rpt-head{border-bottom:1px solid var(--ink);padding-bottom:18px;margin-bottom:26px}
  .rpt-brand{display:flex;align-items:baseline;gap:9px;font-family:var(--font-mono);margin-bottom:14px}
  .rpt-brand .n{font-weight:500;color:var(--ink);font-size:15px}.rpt-brand .s{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
  .rpt-title{font-weight:500;font-size:34px;letter-spacing:-.03em;line-height:1.08;margin:0;color:var(--ink);text-wrap:balance}
  .rpt-meta{font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-top:10px}
  .upsell{border:1px solid var(--hairline);border-radius:18px;background:var(--card);padding:24px 26px;margin-top:24px;box-shadow:inset 0 1px 0 var(--card-inset)}
  .upsell .k{font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:8px}
  .upsell h3{font-weight:500;font-size:21px;letter-spacing:-.02em;margin:0;color:var(--ink)}
  .upsell p{color:var(--muted);font-size:15px;line-height:1.5;margin:8px 0 16px;font-weight:300}
  .upsell .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  @media print{
    @page{margin:18mm 16mm}
    nav,footer,.no-print,.ml-mobile-menu{display:none!important}
    html,body{background:#fff;color:#111}
    .wrap{max-width:100%;padding:0}
    .report{border:0;padding:0;margin:0;background:#fff;box-shadow:none}
    .rpt-head{border-bottom-color:#111;margin-bottom:22px}
    .rpt-brand .n{color:#111}.rpt-brand .s,.rpt-meta{color:#555}
    .rpt-title,.report h1,.report h2,.report h3{color:#0d1a14}
    .report p,.report ol,.report ul{color:#222}
    .cite{color:#0F5E43}
    .report a{color:#0F5E43;text-decoration:none}
    h1,h2,h3,.rpt-head{break-after:avoid;page-break-after:avoid}
    p,li{orphans:3;widows:3}
  }
`;

export function humanReportsPage(baseUrl) {
  // DERIVED, never typed: this string is the meta + og description, i.e. what
  // Google and every link preview show. It said "$1 or $2 by card and $0.20 to
  // $1.10" for a full day after the 2026-08-23 repricing, because prices moved
  // in three places and the prose that quotes them was not one of them.
  const cardCents = Object.values(HUMAN_PRODUCTS).map((p) => p.price).filter((n) => Number.isFinite(n));
  const cardLo = Math.min(...cardCents) / 100, cardHi = Math.max(...cardCents) / 100;
  const agent = Object.values(HUMAN_PRODUCTS).map((p) => priceUsdFor(p.slug)).filter((n) => Number.isFinite(n));
  const agentLo = Math.min(...agent).toFixed(2), agentHi = Math.max(...agent).toFixed(2);
  const R = HUMAN_PRODUCTS;
    // Price on the BUTTON, from the product table. A card with a single tier had
  // no price anywhere until the Stripe page, which is the worst place to learn
  // one. `data-price` also lets the tier buttons update it without a reload.
  const usd = (cents) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);
  const buyBtn = (kind, key, label) => `<button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px" data-buy="${esc(kind)}" data-price-for="${esc(kind)}">${esc(label)} <span class="bprice">${usd(R[key].price)}</span></button>`;
  const body = `
<div class="wrap">
  <div id="checkout-note" hidden class="note" style="margin:0 0 18px;padding:12px 16px;border:1px solid var(--hairline);border-radius:12px;background:var(--card);">
    Checkout canceled, nothing was charged. Pick a report below whenever you are ready. Every price is on its button.
  </div>
  <section class="hero">
    <div class="eyebrow">Cited reports · one price per report · no subscription · price on every button</div>
    <h1>A finished report, <em>not a chat answer.</em></h1>
    <p class="lede">Deep research on any question, due diligence on any public company, a 13F breakdown of any fund, a graded audit of any domain. Grounded in live sources, fully cited, in about two minutes. <b>Nothing to sign up for, nothing recurring.</b> Pay by card at checkout and the report is yours. Agents skip the card and pay per call over x402 or MPP.</p>
    <div class="trust"><span><span class="dot"></span> Every claim cited</span><span><span class="dot"></span> If a report fails, you're auto-refunded</span><span><span class="dot"></span> Secured by Stripe</span><span><span class="dot"></span> PDF + data appendix</span></div>
    <div class="samples-strip" style="margin-top:18px;padding:14px 16px;border:1px solid var(--hairline);background:var(--card);">
    <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin-bottom:8px;">read a real one first</div>
    <div style="display:flex;gap:8px 18px;flex-wrap:wrap;font-size:14px;">${Object.values(SAMPLES).map((x) => `<a href="/reports/sample/${esc(x.product)}" style="color:var(--ink);">${esc(x.label)}: ${esc(x.input)} →</a>`).join("")}</div>
  </div>
</section>
  <section>
    <p class="note" style="margin:0 0 16px;">Card prices include payment processing, which has a fixed cost per charge. An agent paying per call over x402 or MPP pays the tool's own price instead, which sits just above what the report costs us to produce. Both buy the same report.</p>
    <div class="products">
      <div class="pcard" data-kind="research">
        <div class="k">Deep research</div>
        <h3>Ask a hard question</h3>
        <p>Multiple live web searches, ranked sources, a cited report on whatever you ask.</p>
        <div class="field"><input id="in-research" type="text" placeholder="e.g. How do AI agents pay for APIs in 2026?"></div>
        <div class="gets"><b>What you get:</b> a cited answer of about 1,500 words, the ranked sources with links, data tables you can download, delivered in one to three minutes.</div>
        <div class="err" id="err-research"></div>
        ${buyBtn("research", "research", "Get report")}
        <div class="note" style="margin-top:10px;">${sampleLink("research")}<a href="/tools/research" style="color:var(--muted);">Sample output + API docs →</a></div>
      </div>
      <div class="pcard" data-kind="dossier">
        <div class="k">Due-diligence dossier</div>
        <h3>Everything on a public company</h3>
        <p>SEC filings, insider filings, financials and red flags - cited. Data a chatbot can't reach.</p>
        <div class="field"><input id="in-dossier" type="text" placeholder="A US ticker, e.g. AAPL" style="text-transform:uppercase"></div>
        <div class="gets"><b>What you get:</b> business, financials, filings, insider activity and red flags in about 2,400 words, every figure cited to the filing, plus the financial tables.</div>
        <div class="err" id="err-dossier"></div>
        ${buyBtn("dossier", "dossier", "Get dossier")}
        <div class="note" style="margin-top:10px;">${sampleLink("dossier")}<a href="/tools/dossier" style="color:var(--muted);">Sample output + API docs →</a></div>
      </div>
      <div class="pcard" data-kind="filing">
        <div class="k">SEC filing report</div>
        <h3>What did they just file</h3>
        <p>The company's newest SEC filings, with the document itself read and explained in plain language, cited to the filing.</p>
        <div class="field"><input id="in-filing" type="text" placeholder="A US ticker, e.g. AAPL" style="text-transform:uppercase"></div>
        <div class="gets"><b>What you get:</b> the newest 10-K, 10-Q or 8-K read for you: what changed, what the numbers say, what the notes disclose, cited to the document.</div>
        <div class="err" id="err-filing"></div>
        ${buyBtn("filing", "filing-report", "Get the report")}
        <div class="note" style="margin-top:10px;"><a href="/tools/filing-report" style="color:var(--muted);">Sample output + API docs &rarr;</a></div>
      </div>
      <div class="pcard" data-kind="ticker">
        <div class="k">Ticker pack</div>
        <h3>One ticker, the whole picture</h3>
        <p>Company dossier, recent SEC filings, insider buying and selling, and which institutions hold it, in one cited report. Cheaper than buying the parts.</p>
        <div class="field"><input id="in-ticker" type="text" placeholder="A US ticker, e.g. AAPL" style="text-transform:uppercase"></div>
        <div class="gets"><b>What you get:</b> the dossier, the insider-flow report and the 5%+ holders in one bundle, three reports for one price.</div>
        <div class="err" id="err-ticker"></div>
        ${buyBtn("ticker", "ticker-pack", "Get the pack")}
        <div class="note" style="margin-top:10px;"><a href="/tools/ticker-pack" style="color:var(--muted);">Sample output + API docs &rarr;</a></div>
      </div>
      <div class="pcard" data-kind="token">
        <div class="k">Token due diligence</div>
        <h3>Is this Solana token safe to touch</h3>
        <p>Mint and freeze authority, LP lock, holder concentration, liquidity and every named risk flag, graded and cited from on-chain sources.</p>
        <div class="field"><input id="in-token" type="text" placeholder="A Solana mint address"></div>
        <div class="gets"><b>What you get:</b> a graded safety read: authorities, liquidity, holder concentration, trading flow and every named risk flag, cited on-chain.</div>
        <div class="err" id="err-token"></div>
        ${buyBtn("token", "token-brief", "Get the brief")}
        <div class="note" style="margin-top:10px;"><a href="/tools/token-brief" style="color:var(--muted);">Sample output + API docs &rarr;</a></div>
      </div>
      <div class="pcard" data-kind="fund">
        <div class="k">Fund tracker</div>
        <h3>Follow the smart money</h3>
        <p>What a fund holds, and what it bought, added, trimmed and exited last quarter, from SEC 13F filings, cited.</p>
        <div class="field"><input id="in-fund" type="text" placeholder="A fund, e.g. Berkshire Hathaway"></div>
        <div class="gets"><b>What you get:</b> the top holdings, what the fund bought, added, trimmed and exited last quarter, with the full 13F table to download.</div>
        <div class="err" id="err-fund"></div>
        ${buyBtn("fund", "fund-report", "Get report")}
        <div class="note" style="margin-top:10px;">${sampleLink("fund-report")}<a href="/tools/fund-report" style="color:var(--muted);">Sample output + API docs →</a></div>
      </div>
      <div class="pcard" data-kind="insider">
        <div class="k">Insider flow</div>
        <h3>Who's buying, who's selling</h3>
        <p>Every Form 4 against a company with the actual transactions parsed: open-market buys and sales by insider, awards and exercises set apart, a grounded signal read. SEC EDGAR, cited.</p>
        <div class="field"><input id="in-insider" type="text" placeholder="A US ticker, e.g. AAPL" style="text-transform:uppercase"></div>
        <div class="gets"><b>What you get:</b> every Form 4 parsed: who bought and sold on the open market, awards and exercises set apart, a net-flow read, the transactions table.</div>
        <div class="err" id="err-insider"></div>
        ${buyBtn("insider", "insider-report", "Get report")}
        <div class="note" style="margin-top:10px;">${sampleLink("insider-report")}<a href="/tools/insider-report" style="color:var(--muted);">Sample output + API docs →</a></div>
      </div>
      <div class="pcard" data-kind="market">
        <div class="k">Market / competitor brief</div>
        <h3>Who's in the market, and how they differ</h3>
        <p>Market at a glance, the key players and pricing, recent moves, differentiation, risks and a bottom line. Live web research with citations, nothing from memory.</p>
        <div class="field"><input id="in-market" type="text" placeholder="A market, category or company, e.g. AI agent payment rails"></div>
        <div class="gets"><b>What you get:</b> the market, the key players and their pricing, recent moves, differentiation and risks, about 2,200 words, cited to live sources.</div>
        <div class="err" id="err-market"></div>
        ${buyBtn("market", "market-brief", "Get brief")}
        <div class="note" style="margin-top:10px;">${sampleLink("market-brief")}<a href="/tools/market-brief" style="color:var(--muted);">Sample output + API docs →</a></div>
      </div>
      <div class="pcard" data-kind="linkedin">
        <div class="k">LinkedIn article</div>
        <h3>A publish-ready LinkedIn article, with the images</h3>
        <p>Grounded research with cited sources, three headline options, a hook-first body with facts linked to their sources, key takeaways, a companion post with hashtags, and generated images at LinkedIn's own sizes: cover 1920x1080, link-share 1200x627, feed square and portrait. Paste and publish.</p>
        <div class="field"><input id="in-linkedin" type="text" placeholder="Your topic, e.g. why AI agents will pay for APIs with stablecoins"></div>
        <div class="gets"><b>What you get:</b> the article, three headline options, key takeaways, a companion post and cover plus inline images cut to LinkedIn's sizes.</div>
        <div class="err" id="err-linkedin"></div>
        ${buyBtn("linkedin", "linkedin-article", "Get the article")}
        <div class="note" style="margin-top:10px;">${sampleLink("linkedin-article")}<a href="/tools/linkedin-article" style="color:var(--muted);">Sample output + API docs →</a></div>
      </div>
      <div class="pcard" data-kind="recall">
        <div class="k">FDA recall report</div>
        <h3>Is it recalled?</h3>
        <p>Every FDA drug, food and device recall record for a product, brand or ingredient: firm, class, reason, status, distribution. Organized and explained, cited to the FDA feeds.</p>
        <div class="field"><input id="in-recall" type="text" placeholder="A drug, food, brand or device, e.g. losartan"></div>
        <div class="gets"><b>What you get:</b> every recall record for the product with firm, class, reason, status and distribution, explained, with the FDA rows to download.</div>
        <div class="err" id="err-recall"></div>
        ${buyBtn("recall", "recall-report", "Get report")}
        <div class="note" style="margin-top:10px;">${sampleLink("recall-report")}<a href="/tools/recall-report" style="color:var(--muted);">Sample output + API docs →</a></div>
      </div>
      <div class="pcard" data-kind="domain">
        <div class="k">Domain audit</div>
        <h3>Is your domain secure?</h3>
        <p>SPF, DMARC, DKIM, TLS and security headers, one graded report with the exact fixes. Why your mail hits spam, answered.</p>
        <div class="field"><input id="in-domain" type="text" placeholder="A domain, e.g. example.com"></div>
        <div class="gets"><b>What you get:</b> a letter grade, SPF, DMARC, DKIM, MX, TLS, security headers and the www twin checked live, and a numbered fix list you can act on today.</div>
        <div class="err" id="err-domain"></div>
        ${buyBtn("domain", "domain-audit", "Get audit")}
        <div class="note" style="margin-top:10px;">${sampleLink("domain-audit")}<a href="/tools/domain-audit" style="color:var(--muted);">Sample output + API docs →</a></div>
      </div>
    </div>
    <p class="note">One-time charge · card or Link · no subscription, no auto-renew · agents buy the same reports over x402 / MPP in USDC · want it re-run on change? <a href="/monitors" style="color:var(--ink);">Monitors</a></p>
    <p class="note">Free SEC filing pages, no card needed: <a href="/reports/insider" style="color:var(--ink);">insider filings by ticker</a> · <a href="/reports/fund" style="color:var(--ink);">13F holdings by fund</a> · <a href="/reports/dossier" style="color:var(--ink);">company profiles by ticker</a></p>
  </section>
</div>
${ledgerFooterCompact()}
<script src="/js/reports.js"></script>`;
  return ledgerShell({
    title: "Agent402 Reports: research, dossiers, 13F, insider flow, audits",
    description: `Cited reports, $${cardLo} to $${cardHi} by card and $${agentLo} to $${agentHi} for an agent paying per call: deep research, company dossier, fund 13F, insider flow, market brief, SEC filings, domain security, Solana token safety, FDA recalls.`,
    canonical: `${baseUrl}/reports`, baseUrl, activePath: "/reports", extraCss: REPORTS_CSS, body,
    jsonLd: { "@context": "https://schema.org", "@type": "ItemList", "@id": `${baseUrl}/reports#products`, name: "Agent402 reports", itemListElement: Object.entries(R).map(([key, p], i) => ({ "@type": "ListItem", position: i + 1, item: { "@type": "Product", name: p.label, image: `${baseUrl}/tools/${p.slug}/card.png`, url: `${baseUrl}/reports`, brand: { "@type": "Brand", name: "Agent402" }, offers: { "@type": "Offer", price: (p.price / 100).toFixed(2), priceCurrency: "USD", availability: "https://schema.org/InStock", url: `${baseUrl}/reports`, seller: { "@type": "Organization", name: "Havok Holdings LLC" } } } })) },
  });
}

// Delivery page: polls /api/r/:id (or `api`) and renders the report client-side.
const sampleLink = (slug) => { const p = sampleLinkFor(slug); return p ? `<a href="${esc(p)}" style="margin-right:10px;">See a real sample →</a>` : ""; };

export function reportDeliveryPage(sessionId, { api = "/api/r/", waitCopy = "Most reports take one to three minutes; the deepest take up to five. Keep this page open, it appears here automatically.", baseUrl = "https://agent402.tools", robots = "noindex, nofollow", title = "Your report - Agent402", description = "Your Agent402 report.", canonical = `${baseUrl}/reports`, note = "Your report is yours to keep - bookmark this page or use the link we emailed you.", jsonLd, extraHtml = "", extraScripts = "" } = {}) {
  const body = `
<div class="wrap" style="padding-top:28px;">
  <div id="app" data-session="${esc(sessionId)}" data-api="${esc(api)}" data-monitors="${esc(monitorMapJson())}"><div class="status"><h2><span class="spin"></span>Preparing your report…</h2><p>${esc(waitCopy)}</p><p id="rv-elapsed" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);"></p></div></div>
  ${extraHtml}
  ${note ? `<p class="note no-print">${esc(note)}</p>` : ""}
</div>
${ledgerFooterCompact()}
<script src="/js/report-view.js"></script>${extraScripts}`;
  return ledgerShell({
    title, description, canonical, baseUrl, activePath: "/reports", extraCss: REPORTS_CSS, body, robots, ...(jsonLd ? { jsonLd } : {}),
  });
}
