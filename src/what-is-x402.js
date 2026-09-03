// /what-is-x402 — the SEO pillar page for "x402" and "MPP" (Aug 2026 revamp).
// Owns the definitional content: what x402 is, what MPP is, how they differ
// on the wire, why agents need per-call payment, why HTTP 402 sat unused for
// ~30 years, which chains settle it, who is actually using it, and a
// nine-question FAQ as full visible prose (not an accordion — crawlable,
// scannable, no interaction required to read it).
//
// Every dynamic number is a real server-side data binding, never invented:
// the rails table sums live GET /api/stats per-network settlement counts
// (joined through stats.js's CAIP2_NAMES, the same map that produces those
// counter keys — a local copy here would be a second list that could drift),
// and the adoption table is the live leaderboard snapshot's top rows.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { RAILS } from "./rails.js";
import { CAIP2_NAMES } from "./stats.js";

const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");
const fmtUsd = (n) =>
  `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STEPS = [
  ["01", "The agent asks for something", "A plain HTTP request, with no credentials attached. There is no account to authenticate against, so nothing to send."],
  ["02", "The server answers 402 with a price", "The response names the amount, the asset, the chain, and where to pay. This is machine-readable, so the caller does not need documentation to understand the terms."],
  ["03", "The agent signs a payment and retries", "It signs an EIP-3009 stablecoin transfer authorization with its own key and repeats the identical request, carrying the authorization in a header. Funds are never handed to the seller's server."],
  ["04", "The server verifies, settles, and answers", "A facilitator checks and settles the authorization on chain, then the server returns the real response plus a receipt. The caller experiences one request that cost a fraction of a cent."],
];

const COMPARE = [
  ["Full name", "x402", "MPP, the Machine Payments Protocol"],
  ["Origin", "Open standard published by Coinbase", "IETF-track specification (tempoxyz/mpp)"],
  ["Challenge", "402 with an x402 JSON body of payment requirements", "402 with a standard WWW-Authenticate: Payment header"],
  ["Credential", "X-PAYMENT header carrying the signed authorization", "Authorization: Payment, the normal HTTP auth slot"],
  ["Receipt", "Settlement details returned in the response body", "Payment-Receipt response header"],
  ["Settlement", "EIP-3009 stablecoin authorization, verified by a facilitator", "Identical: EIP-3009, same facilitator, same price"],
  ["Client", "@x402/fetch and other x402 clients", "mppx and any HTTP client that speaks the Payment scheme"],
  ["On Agent402", "Served on every paid route", "Served on the same routes, no configuration either side"],
];

const FAQS = [
  ["What is x402?", "x402 is an open payment protocol that finally uses HTTP status code 402 Payment Required. A client asks for a resource, gets a price back, pays in a stablecoin, and the same request goes through. It lets a program buy one thing in one round trip with no subscription, no checkout page and no account."],
  ["What is MPP, the Machine Payments Protocol?", "MPP is the IETF-track standard that gives HTTP a native Payment authorization scheme. The server answers 402 with a WWW-Authenticate: Payment challenge, the client retries with Authorization: Payment credentials, and the settled response returns a Payment-Receipt header. It is a second wire for the same idea as x402, with the same EIP-3009 USDC settlement underneath."],
  ["What is the difference between x402 and MPP?", "They differ in wire format, not in economics. x402 carries payment requirements in its own JSON body and an X-PAYMENT header; MPP uses standard HTTP authentication headers, WWW-Authenticate: Payment and Authorization: Payment, plus a Payment-Receipt on success. Both settle the same EIP-3009 USDC authorization through the same facilitator at the same price. A server can answer both on one route, which is what Agent402 does, so the buyer's client chooses."],
  ["What are agentic payments?", "Agentic payments are purchases made by software rather than people. An AI agent cannot sign up for twenty APIs, because it has no email, no credit card and no way to accept terms, but it can pay a fraction of a cent per call from its own wallet. The wallet is the identity, so there is nothing to register and no key to rotate."],
  ["Why was HTTP 402 unused for thirty years?", "HTTP reserved 402 Payment Required in 1997 as a placeholder for a digital cash system that never arrived. Card payments needed a redirect, a session and a human, none of which fit inside a single HTTP response. Stablecoins made a one-round-trip machine payment practical, so the status code finally has a payment system to describe."],
  ["Do I need a wallet or crypto to call an x402 API?", "Not always. Some servers, including Agent402, offer a proof-of-work tier where your own machine solves a single-use sha256 puzzle instead of paying, costing about a second of CPU. A wallet is needed only for calls that cost the operator real money, and those quote their price in the 402 challenge before anything is charged."],
  ["Which blockchains settle x402 payments?", "It depends on the server. Agent402 settles on twelve rails: USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar and Algorand, plus USDG on Robinhood Chain. Gas is sponsored by the facilitator on EVM chains, so callers need only the stablecoin. Base carries the most volume and is the chain most public x402 indexes measure."],
  ["How do I sell an API over x402?", "Put an x402 paywall in front of your endpoint so unpaid requests answer 402 with your price and payment terms, then register the origin with a public index so buyers and routers can find you. See /sell for Agent402's own free, no-signup listing flow and how it prices routed calls."],
  ["Is an x402 payment refundable if the call fails?", "On a correctly implemented server the payment only completes alongside a successful response, so a failed call is never charged. Because settlement happens on a public chain, both sides can verify independently what was actually paid rather than relying on an invoice."],
];

const TOC = [
  ["#402", "The status code nobody used"],
  ["#how", "How a paid request works"],
  ["#compare", "x402 vs MPP, side by side"],
  ["#agentic", "What agentic payments are"],
  ["#chains", "Which chains settle it"],
  ["#who", "Who is using it today"],
  ["#start", "How to start, either side"],
  ["#faq", "Questions"],
];

/** Real per-rail settlement counts, sorted by volume. Never invented: a rail
 * with no recorded settlements yet reads "·", not "0" pretending to be data
 * we actually have. */
function railsByVolume(stats) {
  const byNet = stats?.toolCallsServed?.viaUSDCByNetwork || {};
  return RAILS.map((r) => {
    const key = CAIP2_NAMES[r.caip2] || r.name.toLowerCase();
    const n = Number(byNet[key]) || 0;
    return { name: r.name, asset: r.asset, caip2: r.caip2, n, calls: n ? fmtNum(n) : "·" };
  }).sort((a, b) => b.n - a.n);
}

/** Live leaderboard top rows, best-effort excluding Agent402's own row so the
 * adoption table reads as third-party evidence rather than a self-citation —
 * matches this page's own point that a neutral index should be checkable
 * against itself. Name-match only (leaderboard rows carry no explicit
 * "is this us" flag); worst case a self row slips through, which is a
 * cosmetic miss, not a wrong number. */
function adoptionRows(leaderboardSnapshot, limit = 6) {
  const board = Array.isArray(leaderboardSnapshot?.leaderboard) ? leaderboardSnapshot.leaderboard : [];
  return board
    .filter((r) => !/^agent402/i.test(String(r?.name || "")))
    .slice(0, limit)
    .map((r, i) => ({
      rank: String(i + 1).padStart(2, "0"),
      name: r.name,
      usd: fmtUsd(r.totalUsd || 0),
      calls: fmtNum(r.callsSettled),
      buyers: fmtNum(r.uniqueBuyers),
    }));
}

export function whatIsX402Page(baseUrl, { stats, leaderboardSnapshot } = {}) {
  const canonical = `${baseUrl}/what-is-x402`;
  const title = "What is x402? What is MPP? A plain-English guide to agentic payments";
  const description =
    "x402 is an open protocol that finally uses HTTP 402 Payment Required, letting software pay per request in USDC. MPP is the IETF-track version of the same handshake. How both work, which chains settle them, and who is actually using them today.";

  const rails = railsByVolume(stats);
  const mppWire = fmtNum(stats?.toolCallsServed?.viaMPPWire);
  const board = adoptionRows(leaderboardSnapshot);
  const boardSellers = Number.isFinite(leaderboardSnapshot?.totalSellers) ? fmtNum(leaderboardSnapshot.totalSellers) : null;
  const windowLabel = leaderboardSnapshot?.windowLabel || "7d";

  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", url: baseUrl, logo: { "@type": "ImageObject", url: `${baseUrl}/logo.png` }, sameAs: [`https://github.com/MikeyPetrillo/Agent402`, "https://x.com/Agent402Tools"] };
  const breadcrumbLd = { "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "What is x402 and MPP", item: canonical },
  ] };
  const articleLd = { "@type": "TechArticle", "@id": `${canonical}#article`, headline: title, description, inLanguage: "en", publisher: { "@id": `${baseUrl}/#organization` }, author: { "@id": `${baseUrl}/#organization` }, mainEntityOfPage: canonical, about: [{ "@type": "Thing", name: "x402" }, { "@type": "Thing", name: "Machine Payments Protocol" }, { "@type": "Thing", name: "Agentic payments" }] };
  const termsLd = { "@type": "DefinedTermSet", "@id": `${canonical}#terms`, name: "Agentic payment terms", hasDefinedTerm: [
    { "@type": "DefinedTerm", name: "x402", description: "An open payment protocol built on the HTTP 402 Payment Required status code. A client requests a resource, receives a price and payment terms, signs a stablecoin authorization, and the same request completes." },
    { "@type": "DefinedTerm", name: "MPP (Machine Payments Protocol)", description: "An IETF-track HTTP authorization scheme named Payment. The server answers 402 with a WWW-Authenticate: Payment challenge, the client sends Authorization: Payment credentials, and the settled response carries a Payment-Receipt header." },
    { "@type": "DefinedTerm", name: "Agentic payments", description: "Machine-to-machine purchases initiated by software rather than a person, paid from the agent's own wallet without signup, card or human approval." },
    { "@type": "DefinedTerm", name: "Facilitator", description: "A service that verifies and settles an x402 or MPP payment authorization on chain, and which can sponsor gas so the payer needs only the stablecoin." },
    { "@type": "DefinedTerm", name: "Proof of work tier", description: "A payment alternative in which a caller solves a single-use, slug-scoped sha256 puzzle instead of paying, spending CPU rather than money." },
  ] };
  const faqLd = { "@type": "FAQPage", "@id": `${canonical}#faq`, mainEntity: FAQS.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) };

  const extraCss = `
.wx-scroll{overflow-x:auto}
.wx-scroll table{min-width:640px}
table{border-collapse:collapse;width:100%}
@media (max-width:900px){.wx-2col{grid-template-columns:minmax(0,1fr)!important}}
`;

  const tocHtml = TOC.map(([href, label]) =>
    `<a href="${href}" style="padding:11px 18px;border-bottom:1px solid var(--dark-border);text-decoration:none;color:var(--on-dark2);font-size:14px;">${esc(label)}</a>`
  ).join("");

  const stepsHtml = STEPS.map(([n, t, b]) =>
    `<div style="padding:22px 24px;border-bottom:1px solid var(--hairline);"><div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:9px;">${esc(n)}</div><h3 style="font-weight:800;font-size:17px;margin:0 0 8px;color:var(--ink);">${esc(t)}</h3><p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0;">${esc(b)}</p></div>`
  ).join("");

  const compareRowsHtml = COMPARE.map(([label, x, m]) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:700;padding:14px 18px;color:var(--ink);width:210px;">${esc(label)}</th><td style="padding:14px 18px;color:var(--muted);">${esc(x)}</td><td style="padding:14px 18px;color:var(--muted);">${esc(m)}</td></tr>`
  ).join("");

  const railsRowsHtml = rails.map((r) =>
    `<tr style="border-bottom:1px solid var(--hairline);"><th scope="row" style="text-align:left;font-weight:700;padding:12px 18px;color:var(--ink);">${esc(r.name)}</th><td style="padding:12px 18px;font-family:var(--font-mono);font-size:12.5px;color:var(--muted);">${esc(r.asset)}</td><td style="padding:12px 18px;font-family:var(--font-mono);font-size:12.5px;color:var(--faint);">${esc(r.caip2)}</td><td style="padding:12px 18px;text-align:right;font-family:var(--font-mono);font-size:13px;color:var(--on-dark);font-variant-numeric:tabular-nums;">${esc(r.calls)}</td></tr>`
  ).join("");

  const adoptionHtml = board.length
    ? board.map((r) =>
        `<tr style="border-bottom:1px solid var(--dark-border);color:var(--on-dark);"><td style="padding:12px 18px;color:var(--dk-muted3);">${esc(r.rank)}</td><td style="padding:12px 18px;">${esc(r.name)}</td><td style="padding:12px 18px;text-align:right;color:var(--on-dark2);">${esc(r.usd)}</td><td style="padding:12px 18px;text-align:right;color:var(--dk-muted2);">${esc(r.calls)}</td><td style="padding:12px 18px;text-align:right;color:var(--dk-muted2);">${esc(r.buyers)}</td></tr>`
      ).join("")
    : `<tr><td colspan="5" style="padding:20px 18px;color:var(--dk-muted3);">unavailable: the leaderboard snapshot has not populated yet</td></tr>`;

  const faqHtml = FAQS.map(([q, a]) =>
    `<article style="padding:26px 0;border-bottom:1px solid var(--hairline);"><h3 style="font-weight:800;font-size:19px;margin:0 0 12px;color:var(--ink);">${esc(q)}</h3><p style="font-size:16px;line-height:1.65;color:var(--muted);margin:0;">${esc(a)}</p></article>`
  ).join("");

  const body = `
<header style="border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:52px 30px 44px;">
    <nav aria-label="Breadcrumb" style="font-family:var(--font-mono);font-size:12px;color:var(--faint);margin-bottom:22px;">
      <a href="/" style="color:var(--muted);text-decoration:none;">agent402</a> / <span style="color:var(--ink);">what is x402 + mpp</span>
    </nav>
    <div class="wx-2col" style="display:grid;grid-template-columns:1.1fr .9fr;gap:50px;align-items:start;">
      <div>
        <h1 style="font-weight:800;font-size:56px;line-height:.94;letter-spacing:-.035em;margin:0 0 24px;color:var(--ink);">What are <span style="color:var(--accent);">x402</span> and <span style="color:var(--accent);">MPP</span>?</h1>
        <p style="font-size:19px;line-height:1.5;color:var(--on-dark2);margin:0 0 20px;"><strong style="color:var(--ink);font-weight:700;">x402 is an open protocol that lets software pay for a single HTTP request in stablecoins.</strong> The server answers <span style="font-family:var(--font-mono);font-size:17px;">402 Payment Required</span> with a price, the client signs a payment, and the same request completes. <strong style="color:var(--ink);font-weight:700;">MPP, the Machine Payments Protocol, is the IETF-track version of that same handshake</strong>, carried in standard HTTP authentication headers.</p>
        <p style="font-size:16px;line-height:1.6;color:var(--muted);margin:0;">No subscription, no checkout page, no account. That matters because an AI agent cannot open one: paying per call is the only purchase an autonomous program can actually make on its own. Both protocols are the wire underneath <a href="/agentic-finance" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">Agentic Finance</a>, agents that pay and get paid on their own; every term on this page is defined in the <a href="/glossary" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">glossary</a>. New to all of it? Start with the <a href="/101" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">ten-minute 101</a>.</p>
      </div>
      <div style="border:1px solid var(--hairline);background:var(--surface);">
        <div style="padding:12px 18px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;letter-spacing:.08em;color:var(--dk-muted);">ON THIS PAGE</div>
        <div style="display:flex;flex-direction:column;">${tocHtml}</div>
      </div>
    </div>
  </div>
</header>

<section id="402" style="max-width:900px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">01 / HISTORY</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--ink);">The status code the web reserved and never used.</h2>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);margin:0 0 18px;">When HTTP/1.1 was written in 1997 its authors set aside a response code for the case where a client had to pay before it could have something: <span style="font-family:var(--font-mono);font-size:15.5px;color:var(--ink);">402 Payment Required</span>. The spec marked it reserved for future use, and there it sat for roughly thirty years, one of the few status codes almost no server ever sent.</p>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);margin:0 0 18px;">The reason was not neglect. Card payments cannot fit inside one HTTP response: they need a redirect to a hosted page, a session, a stored credential, and a human to approve the charge. A protocol-level "pay me for this request" was unimplementable with the payment rails of the time.</p>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);margin:0;">Stablecoins changed the arithmetic. A signed transfer authorization is small enough to travel in a header, cheap enough to be worth a tenth of a cent, and needs no merchant account. x402 is what the 402 status code looks like once a payment system exists that can settle inside a single round trip.</p>
</section>

<section id="how" style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">02 / THE HANDSHAKE</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--ink);">How a paid request actually works.</h2>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 32px;">Four steps, one round trip from the caller's point of view. Nothing here requires a browser, a human, or an account.</p>
  <div class="wx-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--hairline);">
    <div style="background:var(--card);border-right:1px solid var(--hairline);">${stepsHtml}</div>
    <div style="background:var(--surface);">
      <div style="display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;letter-spacing:.06em;color:var(--dk-muted);"><span style="color:var(--accent-lit);">●</span><span>on the wire</span></div>
      <pre style="margin:0;padding:20px 18px;font-family:var(--font-mono);font-size:12px;line-height:1.85;color:var(--on-dark);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># 1. the agent asks, without paying
</span>POST /api/edgar-filing-text

<span style="color:var(--dk-muted3);"># 2. the server quotes a price
</span><span style="color:var(--accent-lit);">HTTP/1.1 402 PAYMENT REQUIRED</span>
WWW-Authenticate: Payment
  realm="agent402", amount="0.004",
  asset="USDC", network="base"

<span style="color:var(--dk-muted3);"># 3. the agent signs and retries
</span>POST /api/edgar-filing-text
Authorization: Payment
  &lt;EIP-3009 authorization&gt;

<span style="color:var(--dk-muted3);"># 4. verified, settled, delivered
</span><span style="color:var(--accent-lit);">HTTP/1.1 200 OK</span>
Payment-Receipt: 0x8f2a&hellip;c41d
<span style="color:var(--faint);">{ "filing": "10-K", "text": "&hellip;" }</span></pre>
    </div>
  </div>
  <p style="font-size:15px;line-height:1.65;color:var(--faint);max-width:820px;margin:22px 0 0;">The payment settles only alongside a successful response, so a failed call is never charged. Because settlement lands on a public chain, both sides can check afterwards what was actually paid instead of trusting an invoice.</p>
</section>

<section id="compare" style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">03 / COMPARISON</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--ink);">x402 vs MPP, side by side.</h2>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 30px;">They differ in wire format, not in economics. Same signed authorization, same facilitator, same price, same guarantee. A server can answer both on one route, which is what Agent402 does, so the buyer's client decides which dialect to speak.</p>
  <div class="wx-scroll">
    <table style="font-size:14.5px;border:1px solid var(--hairline);background:var(--card);">
      <thead><tr style="border-bottom:1px solid var(--hairline);font-family:var(--font-mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);"><th scope="col" style="text-align:left;font-weight:700;padding:13px 18px;">&nbsp;</th><th scope="col" style="text-align:left;font-weight:700;padding:13px 18px;color:var(--accent);">x402</th><th scope="col" style="text-align:left;font-weight:700;padding:13px 18px;color:var(--accent);">MPP</th></tr></thead>
      <tbody>${compareRowsHtml}</tbody>
    </table>
  </div>
</section>

<section id="agentic" style="max-width:900px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">04 / AGENTIC PAYMENTS</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--ink);">What agentic payments are, and why they had to exist.</h2>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);margin:0 0 18px;"><strong style="color:var(--ink);font-weight:700;">Agentic payments are purchases made by software rather than people.</strong> An AI agent working a real task keeps running into things it cannot answer from memory: fetch a live page, pull a filing, convert a file, check an address on a chain.</p>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);margin:0 0 18px;">Signing up for twenty APIs is not something it can do. It has no email inbox to confirm, no credit card, no authority to accept terms of service, and no way to rotate the keys it would collect. Every one of those is a human step wedged in front of a machine task.</p>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);margin:0 0 24px;">Paying a fraction of a cent per call, from a wallet it controls, is a step it can take unattended. That inverts the model: instead of registering for access, the agent simply pays for the one thing it needs, and the payment is the identity. Nothing to sign up for means nothing to leak.</p>
  <div style="border-left:2px solid var(--accent);padding:4px 0 4px 20px;">
    <p style="font-size:17px;line-height:1.6;color:var(--on-dark2);margin:0;font-weight:500;">The practical test of an agentic payment: could the software complete the purchase with no human awake? If a human has to approve, register, or paste a key, it is not agentic.</p>
  </div>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);margin:24px 0 0;">Agentic payments are the wire. What forms on top of them once thousands of agents and sellers transact - price discovery, routing between competing sellers, reliability signals, receipts, transparent revenue - is <a href="/agentic-finance" style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);">Agentic Finance</a>, and Agent402 is built as its applied layer.</p>
</section>

<section id="chains" style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">05 / SETTLEMENT</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--ink);">Which chains settle x402 payments?</h2>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 30px;">The protocol is chain-agnostic; each server picks what it accepts. Agent402 settles on twelve rails, so a buyer pays on whichever chain it already holds stablecoins on. Gas is sponsored by the facilitator on EVM chains, which means a caller needs only the stablecoin and no native gas token. Counts below are real settled calls per rail.</p>
  <div class="wx-scroll">
    <table style="font-size:14.5px;border:1px solid var(--hairline);background:var(--card);">
      <thead><tr style="border-bottom:1px solid var(--hairline);font-family:var(--font-mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);"><th scope="col" style="text-align:left;font-weight:700;padding:13px 18px;">chain</th><th scope="col" style="text-align:left;font-weight:700;padding:13px 18px;">asset</th><th scope="col" style="text-align:left;font-weight:700;padding:13px 18px;">caip-2</th><th scope="col" style="text-align:right;font-weight:700;padding:13px 18px;">calls settled</th></tr></thead>
      <tbody>${railsRowsHtml}</tbody>
    </table>
  </div>
  <p style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);margin:16px 0 0;">live from GET /api/stats · ${esc(mppWire)} of these settled over the MPP wire rather than x402</p>
</section>

<section id="who" style="background:var(--surface);margin-top:64px;border-top:1px solid var(--hairline);border-bottom:1px solid var(--hairline);">
  <div style="max-width:1180px;margin:0 auto;padding:56px 30px;">
    <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">06 / ADOPTION</div>
    <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--on-dark);">Who is actually settling x402 payments?</h2>
    <p style="font-size:17px;line-height:1.65;color:var(--dk-muted2);max-width:820px;margin:0 0 30px;">Not a forecast: a ranking of real sellers by Base USDC settled volume, built by crawling public x402 sellers and reading the chain. Agent402 is excluded from this view, because a neutral index should be checkable against itself.</p>
    <div class="wx-scroll">
      <table style="font-family:var(--font-mono);font-size:13px;border:1.5px solid var(--dark-border2);background:var(--card);">
        <thead><tr style="border-bottom:1px solid var(--dark-border2);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--dk-muted3);"><th scope="col" style="text-align:left;font-weight:400;padding:12px 18px;width:40px;">#</th><th scope="col" style="text-align:left;font-weight:400;padding:12px 18px;">seller</th><th scope="col" style="text-align:right;font-weight:400;padding:12px 18px;">usdc settled</th><th scope="col" style="text-align:right;font-weight:400;padding:12px 18px;">calls</th><th scope="col" style="text-align:right;font-weight:400;padding:12px 18px;">buyers</th></tr></thead>
        <tbody>${adoptionHtml}</tbody>
      </table>
    </div>
    <div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:16px;font-family:var(--font-mono);font-size:12.5px;color:var(--dk-muted3);">
      ${boardSellers ? `<span>${esc(boardSellers)} sellers scanned · ${esc(windowLabel)} window · hourly snapshot</span>` : `<span>seller count unavailable this snapshot</span>`}
      <a href="/leaderboard" style="color:var(--accent-lit);text-decoration:none;">full leaderboard →</a>
      <a href="/marketplace" style="color:var(--accent-lit);text-decoration:none;">browse every seller →</a>
    </div>
  </div>
</section>

<section id="start" style="max-width:1180px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">07 / GET STARTED</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 20px;color:var(--ink);">Start on either side of the 402.</h2>
  <p style="font-size:17px;line-height:1.65;color:var(--muted);max-width:820px;margin:0 0 30px;">x402 has two sides, and both are open. Charge for what you serve, or pay for what you need.</p>
  <div class="wx-2col" style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--hairline);">
    <div style="padding:26px;border-right:1px solid var(--hairline);background:var(--card);display:flex;flex-direction:column;">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:16px;">SELL</div>
      <h3 style="font-weight:800;font-size:21px;margin:0 0 12px;color:var(--ink);">Charge agents for your API</h3>
      <p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0 0 18px;flex:1;">Put an x402 paywall in front of your endpoint, then register the origin so buyers and routers can find you. Free to list, no signup, and nothing deducted from your price: buyers pay straight into your wallet.</p>
      <pre style="margin:0 0 18px;background:var(--surface);border:1px solid var(--dark-border);color:var(--on-dark);padding:14px;font-family:var(--font-mono);font-size:11.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># we probe, you appear
</span>curl -X POST https://agent402.tools/api/index/register \
  -H 'content-type: application/json' \
  -d '{"origin":"https://api.you.com"}'</pre>
      <a href="/sell" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:13px;text-decoration:none;padding:12px 18px;align-self:flex-start;">List your API →</a>
    </div>
    <div style="padding:26px;background:var(--card);display:flex;flex-direction:column;">
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:16px;">BUY</div>
      <h3 style="font-weight:800;font-size:21px;margin:0 0 12px;color:var(--ink);">Let your agent pay for tools</h3>
      <p style="font-size:14.5px;line-height:1.6;color:var(--muted);margin:0 0 18px;flex:1;">Paste one MCP URL into Claude, Cursor, or any streamable-HTTP client and your agent can buy from 500+ tools. Pure-CPU tools run free over proof-of-work, so you can try it without a wallet.</p>
      <pre style="margin:0 0 18px;background:var(--surface);border:1px solid var(--dark-border);color:var(--on-dark);padding:14px;font-family:var(--font-mono);font-size:11.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># zero install
</span>claude mcp add --transport http \
  agent402 https://agent402.tools/mcp</pre>
      <a href="/docs#add" style="background:transparent;border:1px solid var(--hairline);color:var(--ink);font-family:var(--font-mono);font-weight:700;font-size:13px;text-decoration:none;padding:11px 18px;align-self:flex-start;">Add to your agent →</a>
    </div>
  </div>
</section>

<section id="faq" style="max-width:900px;margin:0 auto;padding:64px 30px 0;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:12px;">08 / QUESTIONS</div>
  <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 30px;color:var(--ink);">Questions people and agents ask.</h2>
  <div style="display:flex;flex-direction:column;gap:0;border-top:1px solid var(--hairline);">${faqHtml}</div>
</section>

<section style="max-width:1180px;margin:0 auto;padding:56px 30px 56px;">
  <div style="background:var(--surface);border:1px solid var(--hairline);padding:52px 44px;position:relative;overflow:hidden;">
    <div style="position:absolute;right:26px;top:-36px;font-weight:900;font-size:220px;line-height:1;color:transparent;-webkit-text-stroke:2px #ffffff10;pointer-events:none;">402</div>
    <div style="position:relative;">
      <h2 style="font-weight:800;font-size:38px;line-height:1.02;letter-spacing:-.025em;margin:0 0 16px;color:var(--on-dark);">Now put it to work.</h2>
      <p style="font-size:16.5px;line-height:1.6;color:var(--dk-muted2);margin:0 0 28px;max-width:540px;">Agent402 is the applied layer for both protocols: an open index, a neutral router, and an on-chain ranking of every x402 seller. Free to list, free to browse.</p>
      <div style="display:flex;gap:11px;flex-wrap:wrap;">
        <a href="/sell" style="background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:14px 24px;">List your API - free →</a>
        <a href="/" style="background:transparent;border:1.5px solid var(--dark-border2);color:var(--on-dark);font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;padding:13px 24px;">SEE THE INDEX</a>
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
    jsonLd: [orgLd, breadcrumbLd, articleLd, termsLd, faqLd],
    extraCss,
    body,
  });
}
