// /101 - "x402 & MPP 101": a presenter-mode walkthrough for people who know
// nothing about this space, built to be TALKED THROUGH with a prospect on a
// call or a screen share (the operator, 2026-08-18: "I need an x402 101 section so I
// can walk it through potential customers"). Plain language, one idea per
// slide, an analogy that holds from start to finish (a vending machine: the
// price is on the glass, you put a coin in, you get the item and a receipt,
// no membership), speaker notes for the presenter (N key), and one LIVE
// demo slide that makes the real request against this server so the
// audience watches a 402 turn into a 200 in front of them:
//   1. ask without paying  -> the real 402, decoded into English (both wires)
//   2. pay with a puzzle   -> proof-of-work in the browser, the tool answers
//   3. the paid rail        -> the newest real settlement on each chain, from
//                              /api/revenue, with its explorer link
// Real numbers doctrine: nothing on the demo slide is mocked - the 402, the
// puzzle, the result and the receipts are fetched from this server at click
// or load time. Counts in copy stay evergreen ("500+"). No em dashes.
// Behaviour lives in assets/js/x402-101.js (CSP: no inline scripts).
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { routingProofSentence } from "./routing-proof.js";
import { powCostPhrase } from "./pow.js";

// [id, kicker, headline, bodyHtml (trusted, authored here), notesText, opts]
// notesText is the presenter's talk track - shown only with the N key / print.
export const SLIDES = [
  {
    id: "cover", kicker: "x402 & MPP 101",
    headline: "How software pays for things.",
    body: `<p class="s101-lead">A ten-minute walkthrough of the two open protocols that let an AI agent pay for what it uses, per request, with no account. Nothing here is a mock: on slide 4 you will watch a real payment request happen on this server.</p>
<p class="s101-hint">Presenter: <kbd>&rarr;</kbd> / <kbd>&larr;</kbd> to move, <kbd>N</kbd> for your speaker notes, <kbd>P</kbd> to print the deck as one page.</p>`,
    notes: "Frame the ten minutes: one problem, one old idea, one live demo, then what it means for them. Ask what they already know about crypto payments; if the answer is 'nothing', say that is the right starting point, because this is not really about crypto - it is about HTTP.",
  },
  {
    id: "problem", kicker: "01 / the problem",
    headline: "An AI agent cannot sign up for anything.",
    body: `<p>Send a software agent to do a real job and it constantly needs things it does not have: a live web page, a filing, a conversion, a piece of data. Every one of those sits behind a signup, an API key, a credit card, or a terms-of-service checkbox.</p>
<p>A person clicks through that in a minute. A program cannot: it has no inbox to confirm, no card, no authority to accept terms, and no way to keep twenty keys safe.</p>
<div class="s101-analogy"><span>Analogy</span> Imagine sending a robot to buy a coffee, and every cafe in town requires a membership card, a phone number and a monthly plan before it will sell one cup.</div>`,
    notes: "The key sentence: 'the useful internet is behind signups, and a program cannot sign up.' Most listeners immediately see the problem in their own product: their API needs a key. Ask: how would an agent get one of your keys today? Usually a human does it by hand.",
  },
  {
    id: "402", kicker: "02 / the old idea",
    headline: "The web already had a button for this: <span class=\"s101-accent\">402 Payment Required</span>.",
    body: `<p>When the web's rules were written in 1997, the authors reserved a response code for "this costs money" and never used it, because card payments could not fit inside a single web request. Stablecoins changed that: a payment can now be a small signed message that travels inside the request itself.</p>
<div class="s101-analogy"><span>Analogy</span> A vending machine. The price is printed on the glass (the 402). You put a coin in (the payment rides on the retry). You get the item (the answer) and a receipt. No membership, no account, no login.</div>
<p>Two open protocols do exactly this: <strong>x402</strong> (started by Coinbase) and <strong>MPP</strong>, the Machine Payments Protocol (started by Tempo, on a standards track). Same idea, two dialects of the same handshake.</p>`,
    notes: "Do not go deep on blockchains here. The point is that a payment can be a signed note inside an HTTP request. If asked 'why now': stablecoins made a dollar-denominated payment small and cheap enough to ride in a header, and the settlement companies (Coinbase, Stripe/Tempo) built the plumbing.",
  },
  {
    id: "demo", kicker: "03 / watch it happen", live: true,
    headline: "A real request, right now.",
    body: `<div class="s101-demo" id="s101-demo">
  <div class="s101-step" data-step="1">
    <div class="s101-step-h"><span class="s101-num">1</span><strong>Ask without paying.</strong> <span class="s101-muted">The agent calls a tool on this server with no payment attached.</span></div>
    <button class="s101-btn" id="s101-ask" type="button">GET agent402.tools/api/uuid &rarr;</button>
    <div class="s101-out" id="s101-ask-out" aria-live="polite"></div>
  </div>
  <div class="s101-step" data-step="2">
    <div class="s101-step-h"><span class="s101-num">2</span><strong>Pay.</strong> <span class="s101-muted">Two ways to put a coin in: money from a wallet, or, on the free tier, a short burst of computer work (a puzzle: ${esc(powCostPhrase())}). This browser has no wallet, so it will solve the puzzle.</span></div>
    <button class="s101-btn" id="s101-pay" type="button" disabled>Solve the puzzle and retry &rarr;</button>
    <div class="s101-out" id="s101-pay-out" aria-live="polite"></div>
  </div>
  <div class="s101-step" data-step="3">
    <div class="s101-step-h"><span class="s101-num">3</span><strong>The paid rail, for real.</strong> <span class="s101-muted">When the coin is money, the payment settles on a public ledger and anyone can check it. These are the newest real payments to this server, read live from the chain:</span></div>
    <div class="s101-out" id="s101-receipts" aria-live="polite"><span class="s101-muted">loading the latest settlements&hellip;</span></div>
  </div>
</div>`,
    notes: "Click step 1. Read the decoded 402 out loud: 'the server says: this costs a tenth of a cent, pay in USDC, on any of these chains, to this address, valid for five minutes.' Point out the two headers: same offer, two dialects (x402 and MPP). Click step 2: 'this browser has no wallet, so it pays with a fraction of a second of work instead of money' - the tool answers. Then step 3: 'when it IS money, here is a real payment from a few minutes ago, on a public ledger; click it.' That is the whole protocol.",
  },
  {
    id: "recap", kicker: "04 / what just happened",
    headline: "Ask. Pay. Get. Three steps, a couple of seconds.",
    body: `<ol class="s101-steps">
<li><strong>Ask.</strong> The agent makes an ordinary web request. The server answers 402 and, in the headers, quotes a price: which currency, which chain, which address, how much, valid until when.</li>
<li><strong>Pay.</strong> The agent's wallet signs a permission slip for exactly that amount ("move $0.001 from me to them, valid for five minutes") and repeats the same request with the slip attached. The key never leaves the agent, and it pays no network fee.</li>
<li><strong>Get.</strong> The server checks the slip, does the work, moves the money on chain, and returns the answer with a receipt that ties this payment to this response.</li>
</ol>
<div class="s101-analogy"><span>Why it works for machines</span> There is nothing to sign up for, so there is nothing to leak. Payment is the identity. One receipt per call means an agent's spending is legible line by line.</div>`,
    notes: "This is the slide to slow down on. The permission slip is the concept people miss: the agent never 'sends money' in the sense of a bank transfer; it signs an authorization and the seller's settlement service moves the funds. That is why it costs the buyer no gas and why the key stays private.",
  },
  {
    id: "wires", kicker: "05 / two dialects, one price",
    headline: "x402 and MPP: same handshake, different headers.",
    body: `<div class="s101-table"><table>
<thead><tr><th></th><th>x402</th><th>MPP</th></tr></thead>
<tbody>
<tr><th>Started by</th><td>Coinbase (x402.org)</td><td>Tempo, with Stripe (mpp.dev), on the IETF standards track</td></tr>
<tr><th>The price rides in</th><td><code>PAYMENT-REQUIRED</code> header</td><td><code>WWW-Authenticate: Payment</code> (the web's normal login mechanism)</td></tr>
<tr><th>The payment rides in</th><td><code>PAYMENT-SIGNATURE</code> header</td><td><code>Authorization: Payment</code> header</td></tr>
<tr><th>The receipt</th><td><code>PAYMENT-RESPONSE</code></td><td>signed <code>Payment-Receipt</code></td></tr>
<tr><th>Settles</th><td>USDC via a facilitator (Base, Solana, Polygon and 9 more)</td><td>the same way on Base/Celo, or natively on Tempo</td></tr>
</tbody></table></div>
<p>Agent402 answers <strong>both</strong> on the same 402 at the same price. The buyer's software picks the dialect; the seller does not have to choose.</p>`,
    notes: "If the audience is non-technical, the one line to keep is: 'two dialects of the same idea, and we speak both.' If they are technical: MPP reuses the web's standard auth headers, which is why it is on a standards track; x402 has the larger installed base today. Neither requires the other.",
  },
  {
    id: "money", kicker: "06 / the money",
    headline: "Dollars on a public ledger, and receipts anyone can check.",
    body: `<p><strong>Stablecoins</strong> are dollars that live on a public ledger: USDC is designed to hold one dollar. Payments here are USDC (or USDG on Robinhood Chain), so nobody prices anything in a volatile token.</p>
<p><strong>Twelve chains.</strong> A buyer pays on whichever chain their wallet already uses; the 402 lists every rail with its own amount, the list price on most and a little more on a rail whose settlement carries a fee. On the EVM chains the buyer pays no network fee at all.</p>
<p><strong>Every payment is a public record.</strong> That is what makes this an economy rather than a wire: sellers can be ranked by settlements the chain actually shows, revenue can be published with proof, and a router can try sellers with proven settlement before anyone untested.</p>
<p class="s101-links"><a href="/revenue">Live transactions with every figure linked to its receipt &rarr;</a></p>`,
    notes: "Anticipate 'is this crypto speculation?' - no: dollar stablecoins only, and no native token is required from the buyer on the EVM chains. The public-ledger point is the strategic one: it enables trust without accounts. Show /revenue if you have time; every number links to chain proof.",
  },
  {
    id: "agent402", kicker: "07 / where we sit",
    headline: "Most of the ecosystem ships the protocol. Agent402 ships the market that runs on it.",
    body: `<div class="s101-grid">
<div><div class="s101-tag">Buy</div><strong>500+ pay-per-call tools</strong><p>Web search with citations, headless browser, PDFs, OCR, financial and SEC data, an OpenAI-compatible LLM gateway. Every one priced per call and settled on chain over x402 or MPP; the model-backed ones are marked as such.</p></div>
<div><div class="s101-tag">Route</div><strong>An open index and a Smart Order Router</strong><p>One call resolves a task to the best seller across the whole ecosystem, ours or anyone's, buys the result from that seller and sells it to the agent. ${routingProofSentence()}</p></div>
<div><div class="s101-tag">Sell</div><strong>The tollbooth</strong><p>One line in front of any site or API: humans browse free, agents pay per request over both wires, straight to your wallet. Non-custodial, no signup, nothing deducted from your price.</p></div>
<div><div class="s101-tag">Prove</div><strong>Numbers you can check</strong><p>Live transaction counts by rail and wire (external revenue underneath), an on-chain seller leaderboard, uptime measured from outside, refunds ledgered.</p></div>
</div>`,
    notes: "Tailor to who is in the room. A data or API company: lead with Sell (the tollbooth turns their existing API into something agents can pay for in an afternoon). An agent builder: lead with Buy and Route (one integration, 500+ tools, and a router that shops the whole ecosystem for them). Both: the payment is the identity, so there is no onboarding on either side.",
  },
  {
    id: "meaning", kicker: "08 / why it matters",
    headline: "Agentic finance: agents that pay and get paid on their own.",
    body: `<p>Once the plumbing works, a market forms on top of it: price discovery, routing between competing sellers, reliability signals, receipts, transparent revenue. Software agents become customers and, just as quickly, vendors.</p>
<p>The practical test for any of it: <em>could the software complete the purchase with no human awake?</em> If a human has to approve, register or paste a key, it is not agentic.</p>
<p class="s101-links"><a href="/agentic-finance">The definition and the stack &rarr;</a> <a href="/glossary">Every term, defined once &rarr;</a></p>`,
    notes: "This is where the category name earns its keep, but keep the brand first: 'Agent402 is the applied layer of agentic finance.' If they want the vocabulary, send them the glossary after the call rather than reading it out.",
  },
  {
    id: "next", kicker: "09 / try it",
    headline: "Ten minutes in, you have seen a real one. Here is how to try it yourself.",
    body: `<div class="s101-grid s101-grid-3">
<div><strong>Play with the tools</strong><p>Try any free-tier tool in the browser, no wallet.</p><a href="/playground">/playground &rarr;</a></div>
<div><strong>Add it to an agent</strong><p>Claude, Cursor, or any MCP client in one line; SDKs for OpenAI, LangChain, Vercel AI and more.</p><a href="/docs#add">/docs &rarr;</a></div>
<div><strong>Sell into it</strong><p>Put a price on your API or site with the tollbooth, and register on the index.</p><a href="/sell">/sell &rarr;</a></div>
</div>
<p class="s101-hint">Questions to leave them with: which of your endpoints would an agent pay for today? And what would your agent buy if it could?</p>`,
    notes: "Close with a concrete next step for their role, and offer to run the live demo against THEIR endpoint next time (the tollbooth makes any URL demo-able in minutes). Send them this deck's URL after the call: agent402.tools/101 - it works as a leave-behind, and P prints it as one page.",
  },
];

const CSS = `
html{scroll-behavior:smooth}
.s101-wrap{scroll-snap-type:y proximity}
.s101-slide{min-height:calc(100vh - 64px);scroll-snap-align:start;border-bottom:1px solid var(--hairline);display:flex;align-items:center}
.s101-in{max-width:1080px;margin:0 auto;padding:56px 30px;width:100%}
.s101-kicker{font-family:var(--font-mono);font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin-bottom:16px}
.s101-h{font-weight:800;font-size:clamp(34px,5vw,58px);line-height:1.02;letter-spacing:-.03em;margin:0 0 26px;color:var(--ink)}
.s101-accent{color:var(--accent)}
.s101-slide p{font-size:19px;line-height:1.6;color:var(--muted);margin:0 0 16px;max-width:820px}
.s101-lead{font-size:22px!important;color:var(--ink)!important}
.s101-hint{font-family:var(--font-mono);font-size:13px!important;color:var(--faint)!important}
.s101-hint kbd{border:1px solid var(--hairline);padding:1px 6px;font-family:var(--font-mono)}
.s101-analogy{border-left:3px solid var(--accent);padding:10px 0 10px 18px;margin:22px 0;font-size:18px;line-height:1.55;color:var(--ink);max-width:820px}
.s101-analogy span{display:block;font-family:var(--font-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:6px}
.s101-steps{padding-left:22px;max-width:820px}
.s101-steps li{font-size:19px;line-height:1.6;color:var(--muted);margin-bottom:12px}
.s101-steps li strong{color:var(--ink)}
.s101-table{overflow-x:auto;margin:0 0 18px}
.s101-table table{border-collapse:collapse;width:100%;min-width:640px;font-size:15.5px;border:1px solid var(--hairline);background:var(--card)}
.s101-table th,.s101-table td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--hairline);vertical-align:top;color:var(--muted)}
.s101-table thead th{font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);border-bottom:1px solid var(--hairline)}
.s101-table tbody th{color:var(--ink);font-weight:700;width:180px}
.s101-table code{font-family:var(--font-mono);font-size:13.5px;color:var(--ink)}
.s101-grid{display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--hairline);background:var(--card);margin-bottom:18px}
.s101-grid>div{padding:20px 22px;border-right:1px solid var(--hairline);border-bottom:1px solid var(--hairline)}
.s101-grid>div strong{display:block;font-size:19px;color:var(--ink);margin:0 0 6px}
.s101-grid>div p{font-size:15.5px!important;margin:0 0 8px}
.s101-grid>div a{font-family:var(--font-mono);font-size:13px;color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent)}
.s101-grid-3{grid-template-columns:1fr 1fr 1fr}
.s101-tag{font-family:var(--font-mono);font-size:11px;letter-spacing:.12em;color:var(--accent);margin-bottom:8px}
.s101-links a{font-family:var(--font-mono);font-size:14px;color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);margin-right:18px}
.s101-demo{border:1px solid var(--hairline);background:var(--card)}
.s101-step{padding:18px 22px;border-bottom:1px solid var(--hairline)}
.s101-step-h{font-size:16.5px;line-height:1.5;color:var(--ink);margin-bottom:10px}
.s101-num{display:inline-block;width:24px;height:24px;border:1px solid var(--hairline);text-align:center;font-family:var(--font-mono);font-size:12px;line-height:22px;margin-right:10px}
.s101-muted{color:var(--muted);font-weight:400}
.s101-btn{background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:13.5px;border:none;padding:11px 16px;cursor:pointer}
.s101-btn[disabled]{background:var(--hairline);color:var(--faint);cursor:not-allowed}
.s101-out{font-family:var(--font-mono);font-size:13px;line-height:1.7;margin-top:12px;white-space:pre-wrap;word-break:break-word;color:var(--ink)}
.s101-out .ok{color:var(--green,#1f7a3a);font-weight:700}
.s101-out .k{color:var(--muted)}
.s101-out details{margin-top:6px}
.s101-out summary{cursor:pointer;color:var(--faint);font-size:12px}
.s101-out pre{background:var(--surface);color:var(--on-dark,#eee);padding:10px 12px;font-size:11.5px;overflow-x:auto;margin:6px 0 0}
.s101-out a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent)}
.s101-notes{display:none;margin-top:26px;border:1.5px dashed var(--accent);padding:14px 18px;font-size:15.5px;line-height:1.55;color:var(--ink);background:var(--paper);max-width:820px}
.s101-notes span{display:block;font-family:var(--font-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:6px}
body.s101-show-notes .s101-notes{display:block}
.s101-bar{position:sticky;bottom:0;z-index:5;background:var(--surface);color:var(--on-dark,#eee);font-family:var(--font-mono);font-size:12px;padding:8px 16px;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}
.s101-bar button{background:transparent;border:1px solid var(--dark-border2,#555);color:inherit;font-family:inherit;font-size:12px;padding:4px 10px;cursor:pointer}
.s101-bar .s101-progress{color:var(--dk-muted,#aaa)}
@media (max-width:900px){.s101-grid,.s101-grid-3{grid-template-columns:1fr}.s101-slide{min-height:auto}}
@media print{.s101-slide{min-height:auto;page-break-inside:avoid;border-bottom:1px solid #999}.s101-notes{display:block!important}.s101-bar,.s101-btn{display:none!important}}
`;

export function x402101Page(baseUrl) {
  const canonical = `${baseUrl}/101`;
  const title = "x402 & MPP 101 - how software pays for things, in ten minutes";
  const description = "A plain-language walkthrough of how an AI agent pays for what it uses over the x402 and MPP protocols: the 402 quote, the payment, the receipt, with a live demo against a real server. Presenter mode with speaker notes.";
  const slides = SLIDES.map((s, i) => `
<section class="s101-slide" id="${esc(s.id)}" data-index="${i}">
  <div class="s101-in">
    <div class="s101-kicker">${esc(s.kicker)}</div>
    ${i === 0 ? `<h1 class="s101-h">${s.headline}</h1>` : `<h2 class="s101-h">${s.headline}</h2>`}
    ${s.body}
    <aside class="s101-notes"><span>Speaker notes</span>${esc(s.notes)}</aside>
  </div>
</section>`).join("");
  const howToLd = {
    "@type": "HowTo", "@id": `${canonical}#howto`, name: "How an AI agent pays for a request over x402 or MPP",
    description,
    step: [
      { "@type": "HowToStep", name: "Ask", text: "The agent makes an ordinary HTTP request. The server answers 402 Payment Required and quotes a price in the headers: currency, chain, address, amount, expiry." },
      { "@type": "HowToStep", name: "Pay", text: "The agent's wallet signs an authorization for exactly that amount and repeats the request with the payment attached (x402 PAYMENT-SIGNATURE, or MPP Authorization: Payment)." },
      { "@type": "HowToStep", name: "Get", text: "The server verifies, does the work, settles the payment on chain, and returns the answer with a receipt." },
    ],
  };
  const orgLd = { "@type": "Organization", "@id": `${baseUrl}/#organization`, name: "Agent402", url: baseUrl };
  const breadcrumbLd = { "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Agent402", item: `${baseUrl}/` },
    { "@type": "ListItem", position: 2, name: "x402 & MPP 101", item: canonical },
  ] };
  const body = `
<div class="s101-wrap" id="s101" data-count="${SLIDES.length}">
${slides}
</div>
<div class="s101-bar">
  <span><button type="button" id="s101-prev">&larr; prev</button> <button type="button" id="s101-next">next &rarr;</button> <button type="button" id="s101-notes-toggle">notes (N)</button> <button type="button" id="s101-print">print (P)</button></span>
  <span class="s101-progress" id="s101-progress">1 / ${SLIDES.length}</span>
  <span>x402 &amp; MPP 101 &middot; agent402.tools/101</span>
</div>
<script src="/js/x402-101.js" defer></script>
${ledgerFooterCompact()}`;
  return ledgerShell({
    title, description, canonical, baseUrl, activePath: "/what-is-x402", extraCss: CSS,
    jsonLd: [orgLd, breadcrumbLd, howToLd],
    body,
  });
}
