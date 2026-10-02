// /what-is-mpp — the Machine Payments Protocol explainer (Aug 2026 revamp,
// restyled to match /what-is-x402's visual language - same section eyebrows,
// comparison table, FAQ prose, closing CTA). The search target stays the
// full phrase "machine payments protocol" (the bare acronym is owned by
// Medicare and public-policy degrees), so the page leads with an extractable
// entity-first definition and stays factual about the protocol's draft
// status. /what-is-x402 remains the broader executive explainer covering
// both protocols; this page is the dedicated landing page for MPP-specific
// search intent, and the two cross-link rather than duplicate scope.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

import { REPO_URL, ORG_SAME_AS } from "./repo-link.js";
import { mppFlagshipRows, mppFlagshipSnippet, mppFlagshipOffersPhrase, MPP_FLAGSHIP_SNIPPET_SLUG } from "./mpp-flagship.js";
const STEPS = [
  ["01", "The client requests a paid resource", "A plain HTTP request, no credentials attached. The server answers 402 Payment Required with a WWW-Authenticate: Payment challenge naming the price, the asset, the chain, and a one-time challenge id."],
  ["02", "The client signs and retries", "It signs a payment authorization for exactly that amount with its own wallet key and repeats the identical request, carrying the signed credential in an Authorization: Payment header. The key never leaves the client."],
  ["03", "The server verifies, runs, then settles", "The credential is checked against the challenge, the request runs, and the payment settles only when the response succeeds, so a failed call is not charged. The exception is a Tempo credential the client broadcast itself (push mode): that transfer is already on chain before the request runs."],
  ["04", "The response carries a receipt", "A signed Payment-Receipt header returns with the result - a verifiable record that this exact payment bought this exact answer."],
];

const COMPARE = [
  ["Payment terms ride in", "PAYMENT-REQUIRED header (base64 JSON offer)", "WWW-Authenticate: Payment challenge"],
  ["Payment rides in", "X-PAYMENT header", "Authorization: Payment header"],
  ["Proof of settlement", "PAYMENT-RESPONSE header", "Signed Payment-Receipt header"],
  ["Origin", "Coinbase (x402.org)", "Tempo (paymentauth.org, IETF-track)"],
  ["Settlement", "EIP-3009 stablecoin authorization, verified by a facilitator", "Depends on the method: MPP's evm method settles identically (EIP-3009, same facilitator); its tempo method settles natively via Tempo's own relay - a different mechanism entirely, same price"],
];

const FAQS = [
  { q: "What is the Machine Payments Protocol (MPP)?", a: "MPP is an open, IETF-track protocol that lets software pay for web services per request using HTTP's standard authentication mechanism. A paid endpoint answers an unpaid request with status 402 and a WWW-Authenticate: Payment challenge naming a price; the client answers with a signed stablecoin payment in an Authorization: Payment header; the server verifies it, runs the request, settles the payment on-chain, and returns the result with a signed Payment-Receipt header. No account, API key, or subscription is involved." },
  { q: "How is MPP different from x402?", a: "They are two dialects of the same idea - pay-per-request over HTTP 402, settled in stablecoins. x402 (from Coinbase) carries payment terms in a PAYMENT-REQUIRED header and the payment in a PAYMENT-SIGNATURE header; MPP carries the same handshake through the web's standard auth headers (WWW-Authenticate / Authorization, the mechanism defined in RFC 9110), which makes it a natural fit for the IETF standards track. A server can speak both from the same URL at the same price, and dual-stack servers exist today." },
  { q: "Is MPP a finished standard?", a: "It is IETF-track and in active development - the Payment HTTP authentication scheme is documented at paymentauth.org with the reference implementation in the tempoxyz/mpp repository. Live services accept MPP payments on mainnet today, so the wire format is real and settling, but as with any draft-stage protocol, details can still evolve." },
  { q: "Where can I see MPP working right now?", a: "Every paid endpoint on Agent402.Tools is dual-stack: the same 402 response carries both an x402 offer and a WWW-Authenticate: Payment challenge, a stock mppx client works unmodified, and settled responses return a signed Payment-Receipt. A real purchase settles over the native MPP wire daily as part of the service's paid canary, so the claim is continuously re-proven, not a demo that worked once." },
  { q: "How do I accept MPP payments on my own API?", a: "If you already speak x402, a translation layer can add MPP without touching settlement: answer 402s with an additional WWW-Authenticate: Payment challenge derived from your existing offer, and re-encode inbound Authorization: Payment credentials into your existing verification path. Agent402's implementation of exactly that pattern is open source (AGPL) in its server repository, and the mppx tooling in tempoxyz/mpp provides the client and codec primitives." },
];

const TOC = [
  ["#how", "How one payment works"],
  ["#compare", "MPP vs x402, side by side"],
  ["#live", "Where it settles today"],
  ["#start-here", "Start here: routes to try first"],
  ["#start", "Accept it on your own API"],
  ["#faq", "Questions"],
];

// "Start here" block: the MPP start-here set from src/mpp-flagship.js, with
// method, path and price read from the catalog passed in (never typed). No
// catalog, no block.
function startHereSection(baseUrl, catalog) {
  const rows = catalog ? mppFlagshipRows(catalog) : [];
  if (!rows.length) return "";
  const snipRow = rows.find((r) => r.slug === MPP_FLAGSHIP_SNIPPET_SLUG) || rows[0];
  const snipQuery = snipRow.slug === "crypto-price" ? "?coins=BTC,ETH&currency=usd" : "";
  const rowHtml = rows.map((r) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><td style="padding:11px 16px;font-family:var(--font-mono);font-size:13px;white-space:nowrap;"><a href="/tools/${esc(r.slug)}" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">${esc(r.method)} ${esc(r.path)}</a></td><td style="padding:11px 16px;font-family:var(--font-mono);font-size:13px;color:var(--accent);white-space:nowrap;" data-mpp-price="${esc(r.slug)}">${esc(r.price)}</td><td style="padding:11px 16px;color:var(--muted);">${esc(r.why)}</td></tr>`
  ).join("");
  return `
<section id="start-here" style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">04 / START HERE</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--ink);">New to MPP? Try these routes first.</h2>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 26px;">${rows.length} fast, low-priced routes across web search, crypto and market data, macro and SEC filings, DNS and network, weather and utilities. Every one answers in one call, returns JSON, and the routes ${esc(mppFlagshipOffersPhrase())}. The same list is in <a href="/llms.txt" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">/llms.txt</a> and marked <span style="font-family:var(--font-mono);font-size:15px;color:var(--ink);">x-mpp-flagship</span> in <a href="/openapi.json" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">/openapi.json</a>.</p>
  <div class="wm-scroll">
    <table style="font-size:14.5px;border:1px solid var(--hairline);background:var(--card);">
      <thead><tr style="border-bottom:1px solid var(--hairline);font-family:var(--font-mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);"><th scope="col" style="text-align:left;font-weight:700;padding:13px 16px;">Route</th><th scope="col" style="text-align:left;font-weight:700;padding:13px 16px;">Price</th><th scope="col" style="text-align:left;font-weight:700;padding:13px 16px;">What it returns</th></tr></thead>
      <tbody>${rowHtml}</tbody>
    </table>
  </div>
  <div style="margin-top:22px;border:1px solid var(--hairline);background:var(--surface);">
    <div style="padding:12px 18px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;letter-spacing:.06em;color:var(--dk-muted);">pay ${esc(snipRow.method)} ${esc(snipRow.path)} with mppx</div>
    <pre style="margin:0;padding:18px;font-family:var(--font-mono);font-size:12.5px;line-height:1.7;color:var(--on-dark);white-space:pre-wrap;word-break:break-word;">${esc(mppFlagshipSnippet(snipRow, baseUrl, snipQuery))}</pre>
  </div>
</section>`;
}

export function whatIsMppPage(baseUrl, catalog = null) {
  const startHere = startHereSection(baseUrl, catalog);
  const canonical = `${baseUrl}/what-is-mpp`;
  const title = "What is MPP? The Machine Payments Protocol, explained";
  const description =
    "MPP (Machine Payments Protocol) is an IETF-track standard that carries pay-per-request payments through HTTP's native authentication headers: a 402 response challenges with WWW-Authenticate: Payment, the client pays via Authorization: Payment, and a signed Payment-Receipt confirms settlement. What it is, how a payment works, how it compares to x402, and where it is live today.";

  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", url: baseUrl, logo: { "@type": "ImageObject", url: `${baseUrl}/logo.png` }, sameAs: ORG_SAME_AS };
  const breadcrumbLd = { "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "What is MPP", item: canonical },
  ] };
  const articleLd = { "@type": "Article", "@id": `${canonical}#article`, headline: title, description, publisher: { "@id": `${baseUrl}/#organization` }, author: { "@id": `${baseUrl}/#organization` }, mainEntityOfPage: canonical };
  const faqLd = { "@type": "FAQPage", "@id": `${canonical}#faq`, mainEntity: FAQS.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) };

  const extraCss = `
.wm-scroll{overflow-x:auto}
.wm-scroll table{min-width:640px}
table{border-collapse:collapse;width:100%}
@media (max-width:900px){.wm-2col{grid-template-columns:minmax(0,1fr)!important}}
`;

  const tocHtml = TOC.filter(([href]) => href !== "#start-here" || startHere).map(([href, label]) =>
    `<a href="${href}" style="padding:11px 18px;border-bottom:1px solid var(--dark-border);text-decoration:none;color:var(--on-dark2);font-size:14px;">${esc(label)}</a>`
  ).join("");

  const stepsHtml = STEPS.map(([n, t, b]) =>
    `<div style="padding:22px 24px;border-bottom:1px solid var(--hairline);"><div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:9px;">${esc(n)}</div><h3 style="font-weight:800;font-size:17px;margin:0 0 8px;color:var(--ink);">${esc(t)}</h3><p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0;">${esc(b)}</p></div>`
  ).join("");

  const compareRowsHtml = COMPARE.map(([label, x, m]) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:700;padding:14px 18px;color:var(--ink);width:220px;">${esc(label)}</th><td style="padding:14px 18px;color:var(--muted);">${esc(x)}</td><td style="padding:14px 18px;color:var(--muted);">${esc(m)}</td></tr>`
  ).join("");

  const faqHtml = FAQS.map((f) =>
    `<article style="padding:26px 0;border-bottom:1px solid var(--hairline);"><h3 style="font-weight:800;font-size:19px;margin:0 0 12px;color:var(--ink);">${esc(f.q)}</h3><p style="font-size:16px;line-height:1.65;color:var(--muted);margin:0;">${esc(f.a)}</p></article>`
  ).join("");

  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:22px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">what is mpp</span>
    </nav>
    <div class="wm-2col" style="display:grid;grid-template-columns:1.1fr .9fr;gap:50px;align-items:start;">
      <div>
        <h1 style="font-weight:800;font-size:56px;line-height:.94;letter-spacing:-.035em;margin:0 0 24px;color:var(--ink);">What is <span style="color:var(--accent);">MPP</span>?</h1>
        <p style="font-size:19px;line-height:1.5;color:var(--on-dark2);margin:0 0 20px;"><strong style="color:var(--ink);font-weight:700;">MPP, the Machine Payments Protocol, is an open, IETF-track standard</strong> that lets software pay for web services per request through HTTP's native authentication headers. A paid endpoint answers with <span style="font-family:var(--font-mono);font-size:17px;">402 Payment Required</span> and a <span style="font-family:var(--font-mono);font-size:15.5px;">WWW-Authenticate: Payment</span> challenge; the client answers with a signed stablecoin payment; the server verifies, settles on chain, and returns a signed receipt.</p>
        <p style="font-size:16px;line-height:1.6;color:var(--muted);margin:0;">No accounts, no API keys, no subscriptions. For the broader story of why machine payments exist and how x402 fits alongside MPP, see <a href="/what-is-x402" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">What is x402?</a> MPP is one of the two wires underneath <a href="/agentic-finance" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">Agentic Finance</a>; the vocabulary (challenge, credential, receipt, facilitator, settlement) is defined in the <a href="/glossary" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">glossary</a>.</p>
      </div>
      <div style="border:1px solid var(--hairline);background:var(--surface);">
        <div style="padding:12px 18px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;color:var(--dk-muted);">ON THIS PAGE</div>
        <div style="display:flex;flex-direction:column;">${tocHtml}</div>
      </div>
    </div>
  </div>
</header>

<section id="how" style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">01 / THE HANDSHAKE</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--ink);">How one MPP payment works.</h2>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 32px;">Two HTTP round trips, typically a couple of seconds. Because it rides the standard <span style="font-family:var(--font-mono);font-size:15px;color:var(--ink);">WWW-Authenticate</span> / <span style="font-family:var(--font-mono);font-size:15px;color:var(--ink);">Authorization</span> machinery defined in RFC 9110 - the same one behind every login prompt on the web - payment becomes just another HTTP auth scheme.</p>
  <div class="wm-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--hairline);">
    <div style="background:var(--card);border-right:1px solid var(--hairline);">${stepsHtml}</div>
    <div style="background:var(--surface);">
      <div style="display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;letter-spacing:.06em;color:var(--dk-muted);"><span style="color:var(--accent-lit);">●</span><span>on the wire</span></div>
      <pre style="margin:0;padding:20px 18px;font-family:var(--font-mono);font-size:12px;line-height:1.85;color:var(--on-dark);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># 1. the client asks, without paying
</span>POST /api/hash

<span style="color:var(--dk-muted3);"># 2. the server quotes a price (one challenge per method and chain)
</span><span style="color:var(--accent-lit);">HTTP/1.1 402 Payment Required</span>
WWW-Authenticate: Payment id="8w5V62E3&hellip;", realm="agent402.tools",
  method="evm", intent="charge", request="eyJhbW91bnQiOiIxMDAwIi&hellip;",
  expires="&hellip;", opaque="eyJ4NDAyIjoi&hellip;"

<span style="color:var(--dk-muted3);"># 3. the client signs and retries
</span>POST /api/hash
Authorization: Payment eyJjaGFsbGVuZ2UiOn&hellip;

<span style="color:var(--dk-muted3);"># 4. verified, the handler runs, then the payment settles
</span><span style="color:var(--accent-lit);">HTTP/1.1 200 OK</span>
Payment-Receipt: eyJtZXRob2QiOiJldm0i&hellip;
<span style="color:var(--faint);">{ "algo": "sha256", "hex": "&hellip;" }</span></pre>
    </div>
  </div>
</section>

<section id="compare" style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">02 / COMPARISON</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--ink);">MPP vs x402, side by side.</h2>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 30px;">Two dialects of the same idea: pay-per-request over HTTP 402, settled in stablecoins, no accounts. They differ in which headers carry the handshake, not in economics. A server can speak both from the same URL at the same price - that is how Agent402 runs today, one paywall, two wire formats. Settlement itself now branches: MPP's evm method still shares x402's exact settlement path, but Agent402 also speaks MPP's own tempo method natively - a genuinely separate settlement mechanism (Tempo's own relay), not a translation of the other two. (<a href="/glossary#facilitator" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">Facilitator</a>, <a href="/glossary#settlement" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">settlement</a> and <a href="/glossary#payment-receipt" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">receipt</a> are defined in the glossary.)</p>
  <div class="wm-scroll">
    <table style="font-size:14.5px;border:1px solid var(--hairline);background:var(--card);">
      <thead><tr style="border-bottom:1px solid var(--hairline);font-family:var(--font-mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);"><th scope="col" style="text-align:left;font-weight:700;padding:13px 18px;">&nbsp;</th><th scope="col" style="text-align:left;font-weight:700;padding:13px 18px;color:var(--accent);">x402</th><th scope="col" style="text-align:left;font-weight:700;padding:13px 18px;color:var(--accent);">MPP</th></tr></thead>
      <tbody>${compareRowsHtml}</tbody>
    </table>
  </div>
</section>

<section id="live" style="background:var(--surface);margin-top:64px;border-top:1px solid var(--hairline);border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:56px 30px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">03 / IS IT REAL?</div>
    <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--on-dark);">Where MPP settles today.</h2>
    <p style="font-size:17px;line-height:1.65;color:var(--dk-muted2);max-width:820px;margin:0 0 20px;">Every paid endpoint on <a href="/" style="color:var(--accent-lit);">Agent402.Tools</a> is dual-stack: the same 402 carries an x402 offer <em>and</em> an MPP challenge, a stock <span style="font-family:var(--font-mono);font-size:15px;color:var(--on-dark);">mppx</span> client works unmodified, and a real purchase settles over the native MPP wire every day as part of the service's paid canary - so "MPP works here" is continuously re-proven on mainnet, not demonstrated once. Other x402 sellers have begun advertising MPP as an alternate rail as well.</p>
    <p style="font-size:15px;line-height:1.6;color:var(--dk-muted3);margin:0;">Reference tooling: <a href="https://github.com/tempoxyz/mpp" rel="noopener" style="color:var(--accent-lit);">tempoxyz/mpp</a> on GitHub. Spec: the Payment auth scheme at <a href="https://paymentauth.org" rel="noopener" style="color:var(--accent-lit);">paymentauth.org</a>.</p>
  </div>
</section>

${startHere}
<section id="start" style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">${startHere ? "05" : "04"} / ACCEPT IT</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--ink);">How do I accept MPP payments on my own API?</h2>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 30px;">If you already speak x402, a translation layer can add MPP without touching settlement: answer 402s with an additional <span style="font-family:var(--font-mono);font-size:15px;color:var(--ink);">WWW-Authenticate: Payment</span> challenge derived from your existing offer, and re-encode inbound <span style="font-family:var(--font-mono);font-size:15px;color:var(--ink);">Authorization: Payment</span> credentials into your existing verification path. Agent402's implementation of exactly that pattern is open source (AGPL) in its server repository, and the mppx tooling in tempoxyz/mpp provides the client and codec primitives.</p>
  <div class="wm-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--hairline);">
    <div style="padding:26px;border-right:1px solid var(--hairline);background:var(--card);display:flex;flex-direction:column;">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:16px;">SELL</div>
      <h3 style="font-weight:800;font-size:21px;margin:0 0 12px;color:var(--ink);">List your API, both wires included</h3>
      <p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0 0 18px;flex:1;">Serve x402, register your origin, and MPP dual-stack support ships free alongside it. No signup, nothing deducted from your price.</p>
      <a href="/sell" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:13px;text-decoration:none;padding:12px 18px;align-self:flex-start;">List your API →</a>
    </div>
    <div style="padding:26px;background:var(--card);display:flex;flex-direction:column;">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:16px;">BUY</div>
      <h3 style="font-weight:800;font-size:21px;margin:0 0 12px;color:var(--ink);">Pay in either dialect</h3>
      <p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0 0 18px;flex:1;">An mppx client and an @x402/fetch client both work unmodified against every paid route on Agent402 - the buyer's client picks.</p>
      <a href="/docs#add" style="background:transparent;border:1px solid var(--hairline);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:13px;text-decoration:none;padding:11px 18px;align-self:flex-start;">Add to your agent →</a>
    </div>
  </div>
</section>

<section id="faq" style="max-width:900px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">${startHere ? "06" : "05"} / QUESTIONS</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 30px;color:var(--ink);">Questions people and agents ask.</h2>
  <div style="display:flex;flex-direction:column;gap:0;border-top:1px solid var(--hairline);">${faqHtml}</div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:56px 30px 56px;">
  <div style="background:var(--surface);border:1px solid var(--hairline);padding:52px 44px;position:relative;overflow:hidden;">
    <div style="position:absolute;right:26px;top:-36px;font-weight:900;font-size:220px;line-height:1;color:transparent;-webkit-text-stroke:2px #ffffff10;pointer-events:none;">402</div>
    <div style="position:relative;">
      <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 16px;color:var(--on-dark);">Now put it to work.</h2>
      <p style="font-size:16.5px;line-height:1.6;color:var(--dk-muted2);margin:0 0 28px;max-width:540px;">Agent402 speaks x402 and MPP on the same routes at the same price. Free to list, free to browse.</p>
      <div style="display:flex;gap:11px;flex-wrap:wrap;">
        <a href="/sell" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:14px 24px;">List your API - free →</a>
        <a href="/what-is-x402" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">WHAT IS x402?</a>
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
    activePath: "/what-is-x402",
    extraCss,
    jsonLd: [orgLd, breadcrumbLd, articleLd, faqLd],
    body,
  });
}
