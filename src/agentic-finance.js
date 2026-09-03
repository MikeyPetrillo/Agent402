// /agentic-finance - the category page. "Agentic Finance (AIFI)" is the
// moniker Agent402 positions itself under: software agents that discover,
// price, pay for and get paid for services on their own, over open payment
// protocols (x402, MPP), with a wallet as the identity. This page DEFINES the
// term (DefinedTerm + Article + FAQPage JSON-LD, the same structured-data
// pattern the homepage and the what-is pages already carry) and places
// Agent402 as its applied layer, with every claim linked to a live surface.
// Same design system as what-is-mpp.js. No live counts baked into copy:
// evergreen "500+" only, per the project rule.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const FAQS = [
  { q: "What is Agentic Finance (AIFI)?", a: "Agentic Finance, AIFI for short, is the practice of software agents transacting on their own: discovering a service, reading a machine-readable price, paying per request from a non-custodial wallet, receiving a verifiable receipt, and, on the other side, earning per request for what they serve. No accounts, no API keys, no invoices. The payment is the identity, and every settlement is on a public ledger." },
  { q: "How is agentic finance different from agentic payments or agentic commerce?", a: "Agentic payments is the plumbing: a wire format that lets a program pay another program (x402 and MPP are the two open ones). Agentic commerce usually means agents buying goods for humans through checkout flows. Agentic finance is the machine-to-machine economy that forms on top of the plumbing: price discovery, routing between competing sellers, reliability signals, treasury and spend controls, and transparent revenue, all operated by and for autonomous agents." },
  { q: "Which protocols does agentic finance run on today?", a: "Two open HTTP-native standards carry it: x402 (an HTTP 402 with machine-readable payment requirements, settled in USDC by a facilitator on chains such as Base, Solana, Polygon and others) and MPP, the Machine Payments Protocol (the IETF-track Payment HTTP authentication scheme, settled on Base and Celo, or natively on Tempo). Both put the price in the 402 and the payment in the retry, so an agent needs nothing but a funded wallet." },
  { q: "What does Agent402 do in agentic finance?", a: "Agent402 is the applied layer: a catalog of 500+ pay-per-call tools an agent can buy over x402 or MPP, the open cross-seller index and Smart Order Router that finds and pays the best external seller on the agent's behalf, an on-chain seller leaderboard, live transaction and revenue transparency, and the open-source tollbooth that lets any site or API earn per request from agents. It is open source and self-hostable." },
  { q: "Do agents need crypto to participate?", a: "To pay, an agent needs a wallet holding a stablecoin (USDC, or USDG on Robinhood Chain, or PathUSD/USDC on Tempo) on a supported chain; gas is sponsored on the EVM rails, so no native token is required. Agent402 also offers a free tier: pure-CPU tools are payable with a proof-of-work solve instead of money, so an agent without a wallet still has a path through." },
  { q: "Is agentic finance real today or a thesis?", a: "It is settling on mainnet every day. Agent402 publishes its own numbers live: thousands of external per-call payments settled on chain, twelve payment rails, and a daily canary that buys real tools over both x402 and MPP so the claim is re-proven continuously. Every figure on the revenue page links to its on-chain proof." },
  { q: "How do I start selling into agentic finance?", a: "Put a price on an endpoint and answer 402. The fastest path is the open-source agent402-tollbooth: one Express middleware or reverse proxy that charges AI agents per request over x402 and MPP while humans browse free, non-custodial, no signup. Then register your origin so the index and router can find you." },
];

const STACK = [
  ["Agents", "Autonomous software with a wallet: MCP-connected assistants, crawlers, trading and research agents, other services' agents.", "the buyers and, increasingly, the sellers"],
  ["Applied layer", "Discovery, routing, pricing, reliability, receipts, transparency. Where an agent finds the right service and pays it once, safely.", "Agent402: index, router, tools, tollbooth"],
  ["Payment protocols", "x402 (HTTP 402 with machine-readable requirements) and MPP (the Payment HTTP auth scheme). Open, HTTP-native, wallet-as-identity.", "the wire"],
  ["Rails and money", "Stablecoins settled on public chains: USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar and Algorand; USDG on Robinhood Chain; native Tempo.", "twelve rails today"],
];

const ROLES = [
  ["BUY", "500+ pay-per-call tools", "Search, browser, PDFs, OCR, live financial and crypto data, SEC filings, forecasting, an OpenAI-compatible LLM gateway. Every one deterministic, priced, and settled on chain, over x402 or MPP.", "/tools", "browse the catalog"],
  ["ROUTE", "Index + Smart Order Router", "One call resolves a task to the best seller across the whole ecosystem, ours or anyone's, pays them on the agent's behalf and relays the result. Only sellers with proven on-chain settlement are routable.", "/marketplace", "open index"],
  ["SELL", "Tollbooth", "Charge AI agents per request on your own site or API over both wires, humans free, non-custodial. Open source, one middleware.", "/sell", "sell into it"],
  ["PROVE", "On-chain transparency", "Live transaction counts by rail and wire (external revenue underneath, ours never counted as earnings), the seller leaderboard, uptime measured from outside, refunds ledgered. Numbers you can check, not claims.", "/revenue", "see the numbers"],
];

const TOC = [
  ["#definition", "The definition"],
  ["#stack", "The stack"],
  ["#agent402", "Where Agent402 sits"],
  ["#proof", "Is it real"],
  ["#faq", "Questions"],
];

export function agenticFinancePage(baseUrl) {
  const canonical = `${baseUrl}/agentic-finance`;
  const title = "What is Agentic Finance (AIFI)? Agents that pay and get paid, over x402 and MPP";
  const description =
    "Agentic Finance (AIFI) is software agents transacting on their own: discovering services, paying per request from a wallet over open protocols like x402 and MPP, receiving verifiable receipts, and earning per request in return. The definition, the stack, and where Agent402 fits as its applied layer.";

  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", url: baseUrl, logo: { "@type": "ImageObject", url: `${baseUrl}/logo.png` }, sameAs: ["https://github.com/MikeyPetrillo/Agent402", "https://x.com/Agent402Tools"], knowsAbout: ["Agentic Finance", "AIFI", "x402", "Machine Payments Protocol", "MPP", "agentic payments", "AI agents"] };
  const termLd = { "@type": "DefinedTerm", "@id": `${canonical}#term`, name: "Agentic Finance", alternateName: "AIFI", description: FAQS[0].a, url: canonical, inDefinedTermSet: { "@type": "DefinedTermSet", "@id": `${baseUrl}/glossary#set`, name: "Agentic Finance (AIFI) glossary", url: `${baseUrl}/glossary` } };
  const breadcrumbLd = { "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "Agentic Finance (AIFI)", item: canonical },
  ] };
  const articleLd = { "@type": "Article", "@id": `${canonical}#article`, headline: title, description, about: { "@id": `${canonical}#term` }, publisher: { "@id": `${baseUrl}/#organization` }, author: { "@id": `${baseUrl}/#organization` }, mainEntityOfPage: canonical, keywords: "agentic finance, AIFI, agentic payments, x402, MPP, machine payments protocol, AI agents, pay-per-call, machine-to-machine payments" };
  const faqLd = { "@type": "FAQPage", "@id": `${canonical}#faq`, mainEntity: FAQS.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) };

  const extraCss = `
@media (max-width:900px){.af-2col,.af-4col,.af-stack-row{grid-template-columns:minmax(0,1fr)!important}}
@media (min-width:901px) and (max-width:1100px){.af-4col{grid-template-columns:1fr 1fr!important}}
`;
  const tocHtml = TOC.map(([href, label]) =>
    `<a href="${href}" style="padding:11px 18px;border-bottom:1px solid var(--dark-border);text-decoration:none;color:var(--on-dark2);font-size:14px;">${esc(label)}</a>`
  ).join("");
  const stackHtml = STACK.map(([layer, what, who], i) =>
    `<div style="display:grid;grid-template-columns:150px 1fr 220px;gap:20px;padding:20px 24px;border-bottom:1px solid var(--hairline);align-items:baseline;" class="af-stack-row"><div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);">0${i + 1} · <span style="color:var(--ink);font-weight:800;font-family:var(--font-body);font-size:16px;">${esc(layer)}</span></div><p style="font-size:15px;line-height:1.6;color:var(--muted);margin:0;">${esc(what)}</p><div style="font-family:var(--font-mono);font-size:12px;color:var(--faint);">${esc(who)}</div></div>`
  ).join("");
  const rolesHtml = ROLES.map(([tag, h, p, href, cta]) =>
    `<div style="padding:24px;border-right:1px solid var(--hairline);border-bottom:1px solid var(--hairline);background:var(--card);display:flex;flex-direction:column;"><div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:12px;">${esc(tag)}</div><h3 style="font-weight:800;font-size:19px;margin:0 0 10px;color:var(--ink);">${esc(h)}</h3><p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0 0 16px;flex:1;">${esc(p)}</p><a href="${href}" style="font-family:var(--font-mono);font-size:13px;color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);align-self:flex-start;">${esc(cta)} →</a></div>`
  ).join("");
  const faqHtml = FAQS.map((f) =>
    `<article style="padding:26px 0;border-bottom:1px solid var(--hairline);"><h3 style="font-weight:800;font-size:19px;margin:0 0 12px;color:var(--ink);">${esc(f.q)}</h3><p style="font-size:16px;line-height:1.65;color:var(--muted);margin:0;">${esc(f.a)}</p></article>`
  ).join("");

  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:22px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">agentic finance (aifi)</span>
    </nav>
    <div class="af-2col" style="display:grid;grid-template-columns:1.1fr .9fr;gap:50px;align-items:start;">
      <div>
        <h1 style="font-weight:800;font-size:56px;line-height:.94;letter-spacing:-.035em;margin:0 0 24px;color:var(--ink);">Agentic Finance <span style="color:var(--accent);">(AIFI)</span></h1>
        <p id="definition" style="font-size:19px;line-height:1.5;color:var(--on-dark2);margin:0 0 20px;"><strong style="color:var(--ink);font-weight:700;">Agentic Finance is software agents transacting on their own:</strong> discovering a service, reading a machine-readable price, paying per request from a non-custodial wallet over open protocols like <a href="/what-is-x402" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">x402</a> and <a href="/what-is-mpp" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">MPP</a>, receiving a verifiable receipt, and, on the other side, earning per request for what they serve.</p>
        <p style="font-size:16px;line-height:1.6;color:var(--muted);margin:0;">No accounts, no API keys, no invoices. The payment is the identity and every settlement is on a public ledger. <strong style="color:var(--ink);">Agent402 is the applied layer of agentic finance</strong>: the tools agents buy, the index and router that find and pay the best seller, the tollbooth that lets any site earn from agents, and the transparency that proves it all on chain.</p>
      </div>
      <div style="border:1px solid var(--hairline);background:var(--surface);">
        <div style="padding:12px 18px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;color:var(--dk-muted);">ON THIS PAGE</div>
        <div style="display:flex;flex-direction:column;">${tocHtml}</div>
      </div>
    </div>
  </div>
</header>

<section id="stack" style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">01 / THE STACK</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--ink);">Four layers, top to bottom.</h2>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 30px;">Agentic payments are the wire. Agentic finance is what forms on top of it once thousands of agents and sellers are transacting: price discovery, routing between competing sellers, reliability signals, spend controls, receipts and transparent revenue. The middle two layers are where the leverage is.</p>
  <div style="border:1px solid var(--hairline);background:var(--card);">${stackHtml}</div>
</section>

<section id="agent402" style="background:var(--surface);margin-top:64px;border-top:1px solid var(--hairline);border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:56px 30px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">02 / THE APPLIED LAYER</div>
    <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--on-dark);">Where Agent402 sits.</h2>
    <p style="font-size:17px;line-height:1.65;color:var(--dk-muted2);max-width:820px;margin:0 0 30px;">Open source, self-hostable, two-sided, and live on both open protocols. Everything below settles on mainnet today, and every claim links to the surface that proves it.</p>
    <div class="af-4col" style="display:grid;grid-template-columns:repeat(4,1fr);border:1.5px solid var(--dark-border2);border-right:none;border-bottom:none;">${rolesHtml}</div>
  </div>
</section>

<section id="proof" style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">03 / IS IT REAL?</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--ink);">Settling on mainnet, every day.</h2>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 18px;">Agent402 publishes its own agentic-finance numbers live rather than asserting them: external per-call payments settled on chain by rail and by wire on the <a href="/revenue" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">revenue page</a>, the on-chain <a href="/leaderboard" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">seller leaderboard</a>, availability measured from outside on the <a href="/status" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">status page</a>, and a daily canary that buys real tools over both x402 and MPP so "it works" is re-proven continuously. Machine-readable: <a href="/api/revenue" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">/api/revenue</a>, <a href="/api/leaderboard" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">/api/leaderboard</a>, <a href="/api/status" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">/api/status</a>.</p>
</section>

<section id="faq" style="max-width:900px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">04 / QUESTIONS</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 30px;color:var(--ink);">Questions people and agents ask about agentic finance.</h2>
  <div style="display:flex;flex-direction:column;gap:0;border-top:1px solid var(--hairline);">${faqHtml}</div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:56px 30px 56px;">
  <div style="background:var(--surface);border:1px solid var(--hairline);padding:52px 44px;position:relative;overflow:hidden;">
    <div style="position:absolute;right:26px;top:-36px;font-weight:900;font-size:220px;line-height:1;color:transparent;-webkit-text-stroke:2px #ffffff10;pointer-events:none;">402</div>
    <div style="position:relative;">
      <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 16px;color:var(--on-dark);">Take part in agentic finance.</h2>
      <p style="font-size:16.5px;line-height:1.6;color:var(--dk-muted2);margin:0 0 28px;max-width:560px;">Give your agent 500+ tools it can pay for over x402 or MPP, or put a price on your own API and let agents pay you. Both are free to start.</p>
      <div style="display:flex;gap:11px;flex-wrap:wrap;">
        <a href="/docs#add" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:14px 24px;">ADD TO YOUR AGENT →</a>
        <a href="/sell" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">SELL YOUR API</a>
      </div>
    </div>
  </div>
</section>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title, description, canonical, baseUrl, activePath: "/what-is-x402", extraCss,
    ogImage: `${baseUrl}/og/agentic-finance.png`,
    jsonLd: [orgLd, termLd, breadcrumbLd, articleLd, faqLd],
    body,
  });
}
