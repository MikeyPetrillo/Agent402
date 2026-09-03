// Served pages for prepaid card credits: /credits (buy a pack, how to use the
// key) and /credits/thanks (claims the key ONCE and shows it). Shared ledger
// shell + REPORTS_CSS; external JS (site CSP drops inline script).
import { CREDIT_PACKS } from "./credits.js";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { REPORTS_CSS } from "./human-reports-page.js";

export function creditsPage(baseUrl) {
  const cards = Object.entries(CREDIT_PACKS).map(([key, p]) => `
    <div class="pcard" data-pack="${esc(key)}" style="text-align:center;">
      <div class="k">${esc(p.label)}</div>
      <div style="font-family:var(--font-mono);font-size:34px;color:var(--ink);letter-spacing:-.02em;margin:6px 0 2px;">$${(p.cents / 100).toFixed(0)}</div>
      <p style="margin:4px 0 16px;">${esc(p.cents === 2000 ? "about 20,000 calls at the $0.001 floor, or fifty deep research reports" : p.cents === 5000 ? "try the whole catalog; research, dossiers, audits included" : "for a team or an agent fleet; never expires")}</p>
      <button class="btn btn-primary" style="width:100%;justify-content:center" data-pack-buy="${esc(key)}">Buy $${(p.cents / 100).toFixed(0)} of credits →</button>
      <div class="err" id="err-${esc(key)}"></div>
    </div>`).join("");
  const body = `
<div class="wrap">
  <section class="hero">
    <div class="eyebrow">Prepaid credits · every tool · no wallet</div>
    <h1>One card, <em>every tool.</em></h1>
    <p class="lede">Buy credits once, get a key, spend it across all 500+ pay-per-call tools and every report - per request, at list price, debited only when a call succeeds. <b>No account, no subscription, no wallet.</b> The card-native twin of paying per call in USDC.</p>
    <div class="trust"><span><span class="dot"></span> Debited only on a successful call</span><span><span class="dot"></span> Never expires</span><span><span class="dot"></span> Secured by Stripe</span></div>
  </section>
  <section>
    <div class="products">${cards}</div>
    <p class="note">Your key is shown once on the next page and emailed to you · keep it secret · balance at <span style="font-family:var(--font-mono);">GET /api/credits/balance</span> · agents with a wallet can skip this and pay per call over x402 / MPP</p>
  </section>
  <section>
    <div class="hm-obsidian" style="border-radius:18px;background:var(--obsidian-bg);border:1px solid var(--obsidian-border);color:var(--on-dark);padding:26px 28px;">
      <div style="font-family:var(--font-mono);font-size:11.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--dk-muted);margin-bottom:12px;">How it works</div>
      <pre style="margin:0;font-family:var(--font-mono);font-size:12.5px;line-height:1.8;color:var(--on-dark2);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># any paid tool, any language - just the header</span>
curl -H "Authorization: Bearer a402_…" ${esc(baseUrl)}/api/whois?domain=example.com
<span style="color:var(--accent-lit);">HTTP/2 200</span>  X-Credits-Balance: 19.999

<span style="color:var(--dk-muted3);"># a report, the same way</span>
curl -X POST -H "Authorization: Bearer a402_…" -H "content-type: application/json" \\
  -d '{"ticker":"AAPL"}' ${esc(baseUrl)}/v1/dossier

<span style="color:var(--dk-muted3);"># balance</span>
curl -H "Authorization: Bearer a402_…" ${esc(baseUrl)}/api/credits/balance</pre>
    </div>
  </section>
</div>
${ledgerFooterCompact()}
<script src="/js/credits.js"></script>`;
  return ledgerShell({
    title: "Agent402 Credits: prepaid card credits for 500+ tools",
    description: "Buy $20, $50 or $100 by card, get a key, spend it on 500+ pay-per-call tools and every report at list price. Debited only on success. No account, no wallet.",
    canonical: `${baseUrl}/credits`, baseUrl, activePath: "/credits", extraCss: REPORTS_CSS, body,
    jsonLd: { "@context": "https://schema.org", "@type": "Product", "@id": `${baseUrl}/credits#product`, name: "Agent402 prepaid credits", description: "Prepaid card credits for every pay-per-call tool and report, debited per successful call.", image: `${baseUrl}/card.png`, url: `${baseUrl}/credits`, brand: { "@type": "Brand", name: "Agent402" }, offers: Object.entries(CREDIT_PACKS).map(([key, p]) => ({ "@type": "Offer", name: `${p.label} ($${(p.cents / 100).toFixed(0)})`, price: (p.cents / 100).toFixed(2), priceCurrency: "USD", url: `${baseUrl}/credits`, availability: "https://schema.org/InStock", seller: { "@type": "Organization", name: "Havok Holdings LLC" } })) },
  });
}

export function creditsThanksPage(sessionId, baseUrl) {
  const body = `
<div class="wrap" style="padding-top:28px;">
  <div id="app" data-session="${esc(sessionId)}"><div class="status"><h2><span class="spin"></span>Minting your key…</h2><p>One moment.</p></div></div>
</div>
${ledgerFooterCompact()}
<script src="/js/credits-thanks.js"></script>`;
  return ledgerShell({
    title: "Your credits key - Agent402",
    description: "Your Agent402 prepaid credits key.",
    canonical: `${baseUrl}/credits`, baseUrl, activePath: "/credits", extraCss: REPORTS_CSS, body, robots: "noindex, nofollow",
  });
}
