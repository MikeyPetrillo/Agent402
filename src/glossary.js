// /glossary - the Agentic Finance (AIFI) glossary. One page that DEFINES the
// vocabulary the rest of the site uses (x402, MPP, facilitator, EIP-3009,
// receipts, PoW tier, SOR, tollbooth, ...) so every deep page can link a term
// to a definition instead of re-explaining it, and so search engines and
// answer engines get ONE canonical DefinedTermSet for the category (the
// /agentic-finance DefinedTerm's `inDefinedTermSet` points here). Each entry
// carries an anchor (`/glossary#facilitator`), the definition, and links to
// the page that goes deep. Same design system as what-is-mpp.js. Counts stay
// evergreen ("500+"), no live numbers baked in, no third-party names beyond
// the protocols' own homes.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { routingProofSentence } from "./routing-proof.js";
import { powCostPhrase } from "./pow.js";
import { LEARN_BY_GLOSSARY_ID, learnBySlug } from "./learn.js";

import { ORG_SAME_AS } from "./repo-link.js";
// { id, name, alt?: [names], def, see: [[href, label]] } - keep `def` a single
// plain-text paragraph: it is rendered verbatim AND emitted as the DefinedTerm
// description in JSON-LD, so no markup.
export const GLOSSARY = [
  { id: "agentic-finance", name: "Agentic Finance (AIFI)", alt: ["AIFI", "agentic finance"],
    def: "Software agents transacting on their own: discovering a service, reading a machine-readable price, paying per request from a non-custodial wallet over an open protocol such as x402 or MPP, receiving a verifiable receipt, and, on the other side, earning per request for what they serve. Agentic payments are the wire; agentic finance is the economy that forms on top of it - discovery, routing, pricing, reliability, receipts and transparency. Agent402 is its applied layer.",
    see: [["/agentic-finance", "the category page"]] },
  { id: "agentic-payments", name: "Agentic payments", alt: ["machine payments", "machine-to-machine payments"],
    def: "The plumbing that lets one program pay another per request without an account: an HTTP 402 response names a price, the client answers with a signed stablecoin payment, and the server verifies, settles and delivers. x402 and MPP are the two open, HTTP-native standards for it. Distinct from agentic commerce (agents buying goods for humans through checkout flows).",
    see: [["/what-is-x402", "What is x402?"], ["/what-is-mpp", "What is MPP?"]] },
  { id: "x402", name: "x402", alt: ["x402 protocol", "HTTP 402 payments"],
    def: "An open protocol, originally from Coinbase, that turns HTTP 402 Payment Required into a working payment flow: the server sends machine-readable payment requirements (price, asset, chain, recipient) in a PAYMENT-REQUIRED header, the client retries with a signed authorization in a PAYMENT-SIGNATURE (formerly X-PAYMENT) header, a facilitator verifies and settles it in USDC, and the response carries a PAYMENT-RESPONSE receipt.",
    see: [["/what-is-x402", "What is x402?"], ["/marketplace", "the x402 index"]] },
  { id: "mpp", name: "MPP (Machine Payments Protocol)", alt: ["Machine Payments Protocol", "Payment HTTP authentication scheme"],
    def: "An open, IETF-track protocol that carries pay-per-request payments through HTTP's standard authentication headers: a 402 response challenges with WWW-Authenticate: Payment, the client pays with an Authorization: Payment credential, and the settled response returns a signed Payment-Receipt. Its evm method settles like x402 (EIP-3009 via a facilitator); its tempo method settles natively on Tempo.",
    see: [["/what-is-mpp", "What is MPP?"], ["/mpp-marketplace", "the MPP index"]] },
  { id: "http-402", name: "HTTP 402 Payment Required", alt: ["402"],
    def: "The HTTP status code reserved since 1997 for exactly this and left unused for decades: the server is saying the resource exists but costs money. Both x402 and MPP use it as the price quote; the payment rides on the retry. Agent402 answers 402 on every paid route and 200 once a payment settles.",
    see: [["/what-is-x402#how", "how one payment works"]] },
  { id: "payment-requirements", name: "Payment requirements (x402 offer)", alt: ["PAYMENT-REQUIRED header", "accepts"],
    def: "The machine-readable price quote in an x402 402: a list of accepted ways to pay (called accepts), each naming the scheme, network, asset, amount, recipient and a validity window. A dual-stack server carries the same terms in an MPP challenge alongside it. It lives in the response HEADER, so a 402 with an empty body is still a full offer.",
    see: [["/what-is-x402#compare", "x402 vs MPP headers"]] },
  { id: "payment-challenge", name: "Payment challenge (MPP)", alt: ["WWW-Authenticate: Payment"],
    def: "MPP's price quote: a WWW-Authenticate: Payment header on the 402 naming the method (evm or tempo), the amount, the asset, the chain and a one-time challenge id. The client answers the challenge with an Authorization: Payment credential on the retry - the same mechanism (RFC 9110) behind every login prompt on the web.",
    see: [["/what-is-mpp#how", "how one MPP payment works"]] },
  { id: "facilitator", name: "Facilitator", alt: ["x402 facilitator"],
    def: "A service that verifies a signed payment authorization and broadcasts the on-chain transfer on the seller's behalf, so the seller needs no node, no gas and no key management. On x402 the facilitator settles EIP-3009 authorizations; different facilitators cover different chains, and a seller can hold several. Agent402 keeps its settlement ordering fixed: the tool runs first and settlement happens only on a successful response, so a failed x402 call is not charged.",
    see: [["/revenue", "settlement by rail, live"]] },
  { id: "eip-3009", name: "EIP-3009 (transferWithAuthorization)", alt: ["gasless USDC authorization"],
    def: "The token standard that makes x402 and MPP's evm method possible: the payer signs an off-chain authorization for an exact amount to an exact recipient within a validity window, and anyone (the facilitator) can submit it on chain. The payer pays no gas and never hands over a key. USDC implements it on every EVM rail Agent402 accepts.",
    see: [["/what-is-x402#how", "how one payment works"]] },
  { id: "payment-receipt", name: "Payment receipt", alt: ["PAYMENT-RESPONSE", "Payment-Receipt header"],
    def: "The proof that a specific payment bought a specific answer: on x402 the settled response carries a PAYMENT-RESPONSE header with the on-chain transaction; on MPP a signed Payment-Receipt header. Agent402 mirrors both on dual-stack routes and links every revenue figure to its receipt on chain.",
    see: [["/revenue", "receipts on /revenue"]] },
  { id: "settlement", name: "Settlement", alt: ["settle", "settled"],
    def: "The moment a payment authorization becomes an on-chain transfer. Settlement is what turns a signed promise into money in the seller's wallet; a payment can verify (the signature is good, the funds exist) and still fail to settle. Agent402 settles AFTER the tool runs and only on a successful response, publishes settlement counts by rail and wire, and ledgers the rare charged-but-failed case as a debt to refund.",
    see: [["/revenue", "settlements by rail and wire"], ["/status", "settlement freshness on /status"]] },
  { id: "non-custodial-wallet", name: "Non-custodial wallet (wallet as identity)", alt: ["payer", "wallet-as-identity"],
    def: "The agent's own key pair holding stablecoins. In agentic finance the payment IS the identity: there is no account to create, and the payer address on a settled payment is what a seller keys memory, usage history and quotas to. Keys never leave the client - the wallet signs an authorization and the facilitator broadcasts it.",
    see: [["/agentic-finance#faq", "do agents need crypto?"]] },
  { id: "rails", name: "Rails (stablecoin rails)", alt: ["payment rails", "chains"],
    def: "The chains and stablecoins a payment can settle on. Agent402 accepts USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar and Algorand, USDG on Robinhood Chain, and PathUSD/USDC natively on Tempo - a buyer picks any rail listed in the 402 at the same list price (fee-charging rails carry the fee in the quote).",
    see: [["/revenue", "transactions by rail"], ["/pricing", "pricing"]] },
  { id: "dual-stack", name: "Dual-stack (x402 + MPP)", alt: ["dual-stack seller"],
    def: "A server that answers ONE 402 with both an x402 offer and an MPP challenge for the same resource at the same price, and accepts either credential on the retry. A stock x402 client and a stock mppx client both work unmodified against it. Every paid route on Agent402 is dual-stack, and the open-source tollbooth adds it to any site.",
    see: [["/what-is-mpp#live", "where MPP settles today"], ["/sell", "sell dual-stack"]] },
  { id: "proof-of-work-tier", name: "Proof-of-work tier (free tier)", alt: ["PoW tier", "free tier"],
    def: `Agent402's no-wallet path: a pure-CPU tool can be paid for with a short proof-of-work solve instead of money. The solve is signed, single-use and scoped to the tool, so it costs the caller ${powCostPhrase()} and the operator nothing. Tools that spend money upstream (search, LLM gateway, browser) are wallet-only.`,
    see: [["/blog/proof-of-work-free-tier", "why a free tier"], ["/pricing", "which tools are free"]] },
  { id: "smart-order-router", name: "Smart Order Router (SOR)", alt: ["route-and-execute", "cross-seller routing"],
    def: `One call that resolves a task to the best seller across the whole ecosystem - Agent402's own catalog or any indexed external seller - pays that seller on the agent's behalf on the same chain the agent paid on, and relays the result with a receipt. ${routingProofSentence()}`,
    see: [["/guides/smart-order-router", "the SOR guide"], ["/marketplace", "the seller index"]] },
  { id: "seller-index", name: "Seller index and leaderboard", alt: ["x402 index", "MPP index", "leaderboard"],
    def: "Agent402's live map of who sells what over x402 and MPP: origins crawled from public manifests and facilitator registries, live-verified, and ranked by settlements actually observed on chain rather than by self-reported claims. The leaderboard is what makes routing safe; the index is what makes discovery possible.",
    see: [["/marketplace", "x402 index"], ["/mpp-marketplace", "MPP index"], ["/leaderboard", "leaderboard"]] },
  { id: "tollbooth", name: "Tollbooth (pay-per-crawl)", alt: ["agent402-tollbooth"],
    def: "The open-source middleware or reverse proxy that puts a price on a site or API for AI agents while humans browse free: it answers 402 over both x402 and MPP, verifies the payment, and lets the request through. Non-custodial, no signup, adaptive proof-of-work for the free path, deploy templates for Cloudflare, Next.js and Docker.",
    see: [["/sell", "sell into agentic finance"], ["/tollbooth/cloud", "hosted tollbooth"]] },
  { id: "pay-per-call", name: "Pay-per-call (pay-per-request)", alt: ["per-call pricing", "micropayments"],
    def: "Pricing where every request carries its own payment - fractions of a cent to a few cents - instead of a subscription, a quota or an API key. It is what makes an agent's spend legible (one receipt per call) and what lets a seller earn from a single request by a stranger with no onboarding.",
    see: [["/pricing", "how Agent402 prices"], ["/tools", "500+ priced tools"]] },
  { id: "deterministic-tool", name: "Deterministic tool", alt: ["deterministic endpoint"],
    def: "A tool whose output is a pure function of its input: same request, same answer, every time, with no language model in the serving path. Determinism is what lets an agent cache, retry safely and verify a paid answer, and what lets a catalog be tested end to end (every Agent402 tool that CI can run without a third-party key answers its own documented example there; the metered tools that need one are left out of that sweep so CI never spends upstream).",
    see: [["/tools", "the catalog"], ["/blog/why-we-built-agent402", "why deterministic"]] },
  { id: "idempotency-key", name: "Idempotency key", alt: ["Idempotency-Key header", "paid retry"],
    def: "A caller-chosen header that lets a paid request be retried without paying twice: the seller stores the first settled answer under the key and replays it to an identical retry. Agent402 commits the cached body only after settlement succeeds, so an unsettled attempt is never replayed as if it were paid.",
    see: [["/docs", "developer docs"]] },
  { id: "mcp", name: "MCP (Model Context Protocol)", alt: ["MCP server", "MCP connector"],
    def: "The open standard AI assistants use to discover and call tools. Agent402 exposes its catalog as a hosted MCP connector and an npm stdio server, so an assistant can find a tool, read its price and call it - paying over x402 or MPP, or with a proof-of-work solve on the free tier - without a human creating an account.",
    see: [["/docs#add", "add to Claude"], ["/blog/building-with-mcp", "building with MCP"]] },
  { id: "tempo", name: "Tempo", alt: ["tempo method", "Tempo chain"],
    def: "The payments-focused chain that is MPP's native settlement method (chain id 4217, TIP-20 tokens such as PathUSD and USDC.e). Its tempo/charge credentials are validated and broadcast through Tempo's own relay rather than an EIP-3009 facilitator, so accepting a tempo/charge payment needs no signing key on the server. Agent402 accepts it, and holds Tempo keys for two other jobs: sponsoring gas on monitor subscriptions paid over MPP, and paying other Tempo sellers through the router.",
    see: [["/what-is-mpp#compare", "MPP settlement methods"], ["/mpp-marketplace", "sellers on the MPP wire"]] },
];

export function glossaryPage(baseUrl) {
  const canonical = `${baseUrl}/glossary`;
  const title = "Agentic Finance (AIFI) glossary: x402, MPP, facilitators, receipts and every term, defined";
  const description =
    "Plain-English definitions of the vocabulary of Agentic Finance (AIFI): x402, MPP, HTTP 402, payment requirements and challenges, facilitators, EIP-3009, receipts, settlement, wallets as identity, rails, dual-stack, the proof-of-work free tier, the Smart Order Router, the tollbooth, and more. Each term links to the page that goes deep.";

  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", url: baseUrl, logo: { "@type": "ImageObject", url: `${baseUrl}/logo.png` }, sameAs: ORG_SAME_AS };
  const breadcrumbLd = { "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "Agentic Finance (AIFI)", item: `${baseUrl}/agentic-finance` },
    { "@type": "ListItem", position: 3, name: "Glossary", item: canonical },
  ] };
  const setLd = {
    "@type": "DefinedTermSet", "@id": `${canonical}#set`, name: "Agentic Finance (AIFI) glossary", url: canonical, description,
    publisher: { "@id": `${baseUrl}/#organization` },
    hasDefinedTerm: GLOSSARY.map((t) => ({
      "@type": "DefinedTerm",
      // The category term is defined on its own page; the glossary entry is
      // an alias to that @id so the two never diverge in the graph.
      "@id": t.id === "agentic-finance" ? `${baseUrl}/agentic-finance#term` : `${canonical}#${t.id}`,
      name: t.name, ...(t.alt?.length ? { alternateName: t.alt } : {}), description: t.def,
      url: `${canonical}#${t.id}`, inDefinedTermSet: { "@id": `${canonical}#set` },
    })),
  };
  const pageLd = { "@type": "WebPage", "@id": `${canonical}#page`, url: canonical, name: title, description, isPartOf: { "@id": `${baseUrl}/#website` }, mainEntity: { "@id": `${canonical}#set` }, publisher: { "@id": `${baseUrl}/#organization` } };

  const extraCss = `
.gl-index a{display:inline-block;padding:6px 11px;border:1px solid var(--hairline);text-decoration:none;color:var(--ink);font-size:13px;margin:0 6px 6px 0;}
.gl-index a:hover{border-color:var(--ink);}
.gl-term:target{background:var(--card);outline:1.5px solid var(--accent);outline-offset:0;}
.gl-term{scroll-margin-top:24px}
@media (max-width:900px){.gl-2col{grid-template-columns:minmax(0,1fr)!important}.gl-row{grid-template-columns:minmax(0,1fr)!important}}
`;

  const indexHtml = GLOSSARY.map((t) => `<a href="#${esc(t.id)}">${esc(t.name)}</a>`).join("");

  const termsHtml = GLOSSARY.map((t) => {
    const alt = t.alt?.length ? `<div style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin:0 0 12px;">also: ${t.alt.map(esc).join(" · ")}</div>` : "";
    const learn = LEARN_BY_GLOSSARY_ID[t.id] ? learnBySlug(LEARN_BY_GLOSSARY_ID[t.id]) : null;
    const seeList = [...(learn ? [[`/learn/${learn.slug}`, `${learn.term}, explained`]] : []), ...(t.see || [])];
    const see = seeList.length ? `<div style="font-family:var(--font-mono);font-size:12.5px;margin-top:14px;">${seeList.map(([href, label]) => `<a href="${esc(href)}" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);margin-right:16px;">${esc(label)} →</a>`).join("")}</div>` : "";
    return `<article id="${esc(t.id)}" class="gl-term gl-row" style="display:grid;grid-template-columns:300px 1fr;gap:28px;padding:26px 24px;border-bottom:1px solid var(--hairline);">
      <div><h2 style="font-weight:800;font-size:21px;line-height:1.15;margin:0 0 8px;color:var(--ink);"><dfn style="font-style:normal;">${esc(t.name)}</dfn></h2>${alt}<a href="#${esc(t.id)}" style="font-family:var(--font-mono);font-size:11px;color:var(--faint);text-decoration:none;">#${esc(t.id)}</a></div>
      <div><p style="font-size:16px;line-height:1.65;color:var(--muted);margin:0;">${esc(t.def)}</p>${see}</div>
    </article>`;
  }).join("");

  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:22px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <a href="/agentic-finance" style="color:var(--muted);text-decoration:none;">agentic finance (aifi)</a> / <span style="color:var(--ink);">glossary</span>
    </nav>
    <div class="gl-2col" style="display:grid;grid-template-columns:1.1fr .9fr;gap:50px;align-items:start;">
      <div>
        <h1 style="font-weight:800;font-size:52px;line-height:.96;letter-spacing:-.035em;margin:0 0 24px;color:var(--ink);">The <span style="color:var(--accent);">Agentic Finance</span> glossary</h1>
        <p style="font-size:19px;line-height:1.5;color:var(--on-dark2);margin:0 0 20px;"><strong style="color:var(--ink);font-weight:700;">Every term the agentic-finance stack uses, defined once.</strong> From the HTTP status code that started it to the facilitators, receipts and routers built on top. Each entry links to the page that goes deep, and each has its own anchor so any page can point at a definition instead of restating it.</p>
        <p style="font-size:16px;line-height:1.6;color:var(--muted);margin:0;">Start with <a href="/agentic-finance" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">what Agentic Finance (AIFI) is</a>, then the two wires: <a href="/what-is-x402" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">x402</a> and <a href="/what-is-mpp" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">MPP</a>. Longer explainers with real headers are in <a href="/learn" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">Learn</a>.</p>
      </div>
      <div style="border:1px solid var(--hairline);background:var(--card);padding:16px 18px 12px;">
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;color:var(--faint);margin-bottom:12px;">${GLOSSARY.length} TERMS</div>
        <div class="gl-index">${indexHtml}</div>
      </div>
    </div>
  </div>
</header>

<section style="max-width:1180px;margin:0 auto;padding:48px 30px 0;">
  <div style="border:1px solid var(--hairline);background:var(--paper);">${termsHtml}</div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:56px 30px 56px;">
  <div style="background:var(--surface);border:1px solid var(--hairline);padding:52px 44px;position:relative;overflow:hidden;">
    <div style="position:absolute;right:26px;top:-36px;font-weight:900;font-size:220px;line-height:1;color:transparent;-webkit-text-stroke:2px #ffffff10;pointer-events:none;">402</div>
    <div style="position:relative;">
      <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 16px;color:var(--on-dark);">Now see it settle.</h2>
      <p style="font-size:16.5px;line-height:1.6;color:var(--dk-muted2);margin:0 0 28px;max-width:560px;">Give your agent 500+ tools it can pay for over x402 or MPP, or put a price on your own API. Both are free to start.</p>
      <div style="display:flex;gap:11px;flex-wrap:wrap;">
        <a href="/docs#add" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:14px 24px;">ADD TO YOUR AGENT →</a>
        <a href="/agentic-finance" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">WHAT IS AGENTIC FINANCE?</a>
      </div>
    </div>
  </div>
</section>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title, description, canonical, baseUrl, activePath: "/agentic-finance", extraCss,
    ogImage: `${baseUrl}/og/agentic-finance.png`,
    jsonLd: [orgLd, breadcrumbLd, setLd, pageLd],
    body,
  });
}
