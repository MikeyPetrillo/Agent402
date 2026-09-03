// Privacy policy — a stable URL is required for listing the remote MCP
// connector in Anthropic's directory, and it should be true: this service
// has no accounts, so there is genuinely little to say.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

export function privacyPage(baseUrl) {
  const title = "Privacy - Agent402";
  const description = "Agent402's privacy policy: no accounts, no cookies, first-party page analytics only. What we process, why, how long we keep it, and how to have it erased.";
  const canonical = `${baseUrl}/privacy`;

  const extraCss = `
.pv-wrap{max-width:760px;margin:0 auto;padding:56px 30px}
.pv-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px}
.pv-h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px}
.pv-updated{font-family:var(--font-mono);font-size:13px;color:var(--faint);margin:0 0 32px}
.pv-body p,.pv-body li{font-size:15px;line-height:1.55;color:var(--muted)}
.pv-body p{margin:0 0 14px}
.pv-body ul{margin:0 0 18px;padding:0 0 0 22px}
.pv-body li{margin-bottom:8px}
.pv-body h2{font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:36px 0 14px;color:var(--ink)}
.pv-body a{color:var(--accent);text-decoration:none}
.pv-body a:hover{text-decoration:underline}
.pv-body b,.pv-body strong{color:var(--ink);font-weight:600}
.pv-body i{font-style:italic}
.pv-body code{font-family:var(--font-mono);font-size:13px;background:var(--surface);color:var(--on-dark);padding:2px 7px;border:1px solid var(--hairline)}
@media(max-width:600px){.pv-h1{font-size:36px !important}}
`;

  const body = `
<div class="pv-wrap">
<section>
<div class="pv-eyebrow">$ GET /privacy</div>
<h1 class="pv-h1">Privacy policy</h1>
<p class="pv-updated">Agent402 (agent402.tools) - last updated 2026-08-27.</p>
</section>

<section>
<div class="pv-body">
<p>Agent402 has no accounts, no cookies and no ad trackers on its pages. Pages run a first-party page
counter (PostHog, served from our own domain: page path, referrer and screen size, a random per-visit id
held in session storage, never a cookie, never your IP forwarded to the analytics provider). Free email
alerts and the tollbooth waitlist are the only forms that take an address, and both say so where you
enter it. The only personal data we hold is what a card purchase needs to deliver what you bought (see
"Card purchases" below). The entire server is <a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener">open source</a>,
so every claim below is verifiable in code.</p>

<h2>What we process, and why</h2>
<ul>
  <li><b>Tool inputs.</b> The data you send to a tool (text to hash, a URL to render, …) is processed
  in memory to compute the response and is not stored - with one deliberate exception: the
  <code>/api/memory</code> tools, whose purpose <i>is</i> storage (see below).</li>
  <li><b>IP addresses.</b> Used for free-tier rate limiting (kept in process memory for up to one hour)
  and in standard, short-lived operational logs (request path, status code) for abuse prevention and debugging.
  The tollbooth waitlist form stores the name, email, organisation and message you type; it no longer stores
  your IP address or browser string.</li>
  <li><b>Error reports.</b> Server errors are sent to Sentry with the request data, headers and cookies stripped,
  so a crash report carries a stack trace and a tool name, never your input or address.</li>
  <li><b>AI gateway inputs.</b> Prompts and inputs sent to the <code>/v1</code> endpoints (chat,
  embeddings, images, speech) and other AI-proxy tools are <b>forwarded to the upstream model
  provider</b> (OpenAI, or the model operator serving the request via OpenRouter) to generate the
  response, subject to that provider's own privacy terms. We don't store gateway inputs or outputs
  beyond short-lived caches (minutes) that make repeated identical calls cheaper.</li>
  <li><b>On-chain payments.</b> For x402 and MPP payments there are no card numbers, names, or emails.
  Payments settle in USDC on the public Base blockchain (or the other chains listed at <a href="/pricing">/pricing</a>,
  USDG on Robinhood Chain, or MPP on Tempo) via the x402 or MPP protocol; wallet addresses, amounts, and
  timestamps are public on-chain by the protocol's design, not collected by us. Payment verification is
  performed by the payment facilitators (Coinbase CDP and per-chain facilitators, or Tempo's relay) and
  we keep a sales ledger of settled payments (wallet address, amount, chain, transaction id) for accounting
  and for refunding a call that was charged but failed.</li>
  <li><b>Card purchases (reports, monitors, prepaid credits).</b> Card details are entered on Stripe's
  hosted checkout and processed by <a href="https://stripe.com/privacy" rel="noopener">Stripe</a>; we never see card
  numbers. Stripe gives us the email address you entered, a customer and session id, and the payment
  status. A delivered report is private to its link unless you choose "Make public" on it, which gives it a second, unguessable address that anyone can read and search engines may index (you can make it private again any time, and the report never contains your name or email). We use the email to deliver what you bought and, after a one-off report, for at most two follow-up emails about that purchase (the monitor for the same subject two days later, other reports a week later), each carrying a link that stops them; if a report fails we email you about the refund - the report link, the prepaid-credits key,
  and monitor reports and alerts - sent through ZeptoMail, a transactional email provider. For a monitor
  we also keep the subject you asked us to watch (a domain, ticker, fund, token or query) and the
  reports we generated, for the life of the subscription. The input you give a report (a ticker, a
  domain, a research question) is stored with the paid session so the report can be generated once and
  served back to you; the finished report is served at an unguessable link and is not published.</li>
  <li><b>Operational telemetry.</b> The server records service events (tool called, payment settled,
  errors) with metadata - tool name, HTTP status, price, settlement chain, and the paying wallet
  address (already public on-chain) - in a server-side analytics tool (PostHog). This is used to run
  the service: reliability, abuse prevention, and knowing what sells. It never includes tool inputs,
  prompts, outputs, cookies, or browser fingerprints.</li>
  <li><b>Payment metadata.</b> An x402 payment token can carry optional annotation fields (a resource URL, a
  description, a <code>reason</code> string) that some buyers use to label a purchase. Agent402 reads <i>only</i>
  the cryptographically-signed payer wallet address from the token - the exact field the settlement authorization
  covers, and one that is already public on-chain. Those annotation fields are never parsed, logged, or retained,
  so a buyer that inadvertently placed personal data in them does not expose it to us. Data-minimisation by
  construction, not by policy.</li>
  <li><b>Memory tools.</b> Data written via <code>/api/memory</code> is stored on our server keyed to the
  paying wallet, readable only by that wallet (or wallets it explicitly grants), until the owner deletes
  it or its TTL expires. A tamper-evident audit log of accesses is kept for the namespace owner.</li>
  <li><b>Weekly spend digest.</b> If you subscribe an email to a wallet (by signing a message with it) or to a credits key (by presenting it), we store that address, the wallet address or the key's id, and the dates we sent to it, only after you click the confirmation link. Each digest carries an unsubscribe link that removes the address. The key itself is never stored by the form.</li>
  <li><b>Free email alerts.</b> If you enter an email on a free report page to be told when a company, fund, domain or product changes, we store that address, the subject you chose and the dates we checked and emailed, and we send you a confirmation link first: nothing is watched and nothing else is sent until you click it. Alert emails go out at most once a day, only when something changed, through the same transactional provider, and every one carries a one-click unsubscribe link that ends the alert and stops all email. We do not use the address for anything else and do not share it.</li>
</ul>

<h2>Third parties</h2>
<ul>
  <li>Tools that fetch external URLs (<code>extract</code>, <code>render</code>, <code>screenshot</code>, …)
  contact those sites from our server with the URL you provided.</li>
  <li><code>/api/search</code> forwards the query to the Brave Search API to produce results.</li>
  <li>Card payments and subscriptions are processed by Stripe; transactional email (report links, credit
  keys, monitor alerts) is sent through ZeptoMail. Report products read public sources named in each
  report (for example SEC EDGAR, openFDA, DNS and certificate-transparency logs, public blockchain
  explorers, and web search) and are synthesized by third-party AI models via OpenRouter, which receive
  the report's inputs and source material, not your email. When the optional Stripe ledger mirror is on,
  settled on-chain payments (wallet address, transaction id, amount) are recorded in Stripe for
  bookkeeping; no email or card data is involved in that mirror.</li>
  <li>Hosting is on Railway. On-chain settlement is on Base (Coinbase CDP facilitator) and the other
  facilitators named at <a href="/pricing">/pricing</a>.</li>
  <li>We do not sell or share data with anyone for advertising or any other purpose.</li>
</ul>

<h2>The MCP connector (${baseUrl}/mcp)</h2>
<p>The hosted connector is anonymous: requests carry no identity beyond the connecting IP, which is used
only for rate limiting as described above. Tool calls made through it are processed exactly like the
HTTP API.</p>

<h2>Retention</h2>
<p>Operational logs are short-lived (platform default, days not months). Rate-limit counters live in
process memory only. Memory-tool data persists until deleted by its owner or TTL expiry. Card-purchase
records (email, session id, input, the finished report) are kept while the report link or subscription is
live and for accounting afterwards; free-alert records (email, subject, check and send dates) are kept until you unsubscribe, and an unconfirmed signup is deleted after three days; you can ask us to delete any of them at the address below once the purchase
is complete. The sales ledger keeps wallet addresses and transaction ids, which are already public
on-chain. Aggregate, non-personal counters (total calls served per tool) are kept for the public
<a href="/api/stats">/api/stats</a> page.</p>

<h2>Abuse &amp; legal requests</h2>
<p>Wallet addresses associated with <a href="/terms">terms</a> violations may be blocked and retained
on a blocklist for as long as needed to enforce the block. We disclose information and preserve
records in response to valid legal process, and report content where the law requires it. Requests
and abuse reports: <a href="mailto:mike@agent402.tools">mike@agent402.tools</a>.</p>

<h2>Operator &amp; contact</h2>
<p>Agent402.Tools is operated by <strong><a href="https://havok.holdings" rel="noopener">Havok Holdings LLC</a></strong>. Contact: <a href="mailto:mike@agent402.tools">mike@agent402.tools</a>,
<a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">GitHub issues</a>,
or <a href="https://x.com/Agent402Tools" rel="noopener">@Agent402Tools on X</a>.</p>
</div>
</section>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/privacy", extraCss, body });
}
