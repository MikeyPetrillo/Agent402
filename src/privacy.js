// Privacy policy — a stable URL is required for listing the remote MCP
// connector in Anthropic's directory, and it should be true: this service
// has no accounts, so there is genuinely little to say.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

import { REPO_URL, repoUrl } from "./repo-link.js";
import { DEFAULTS as TRAFFIC_DEFAULTS } from "./traffic-classifier.js";
export function privacyPage(baseUrl) {
  const title = "Privacy - Agent402";
  const description = "Agent402's privacy policy: no accounts, no ad trackers, page analytics with a consent choice in Europe. What we process, why, how long we keep it, and how to have it erased.";
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
<p class="pv-updated">Agent402 (agent402.tools) - last updated 2026-10-02.</p>
</section>

<section>
<div class="pv-body">
<p>Agent402 has no accounts and no ad trackers on its pages. Pages run a first-party page counter
(PostHog, served from our own domain: page path, referrer and screen size, a random per-visit id held in
session storage, never a cookie, never your IP forwarded to the analytics provider). The same tool keeps a
session replay of some visits (what was clicked, scrolled and shown, and the browser console messages)
so we can see where a page or a checkout goes wrong; every form field is masked, and no replay is kept
on a private link (a paid report, a receipt, a signed alert or manage link, a checkout return page). Pages also run
<b>Google Analytics</b> to count visits and see how people find the site. It sets a measurement cookie
(<code>_ga</code>) and Google receives your IP address and browser details under
<a href="https://policies.google.com/privacy" rel="noopener">Google's privacy policy</a>. Advertising
features, ad personalization and Google signals are off. If your browser's time zone is in Europe, the
cookie is off until you choose "Allow" in the strip at the bottom of the page, and Google only receives
cookieless pings before that; your choice is kept in your browser. Pages whose address is itself a private
link (a paid report, a receipt, a signed alert or manage link) do not load Google Analytics. Free email
alerts, the weekly spend digest and the tollbooth waitlist are the forms that take an address, and each
says so where you enter it; a card purchase gives us the email you enter at checkout. Everything we
keep, and for how long, is listed below. The entire server is <a href="${REPO_URL}" rel="noopener">open source</a>,
so every claim below is verifiable in code.</p>

<h2>What we process, and why</h2>
<ul>
  <li><b>Tool inputs.</b> The data you send to a tool (text to hash, a URL to render, …) is processed
  in memory to compute the response. It is not stored, except in these cases:
  <ul>
    <li>the <code>/api/memory</code> tools, whose purpose <i>is</i> storage (see below);</li>
    <li>some tools that read public data cache their answer for between one minute and one day, keyed
    by the input that produced it (a domain, an address to geocode, a URL), so a repeat call is faster;
    identical repeat calls to the AI gateway and identical retries carrying an
    <code>Idempotency-Key</code> are cached for up to ten minutes;</li>
    <li>a search on <code>/api/find</code> or the connector's <code>catalog.find</code> that finds no
    matching tool, and a request sent to <code>/api/wish</code>, is kept as text on our demand board
    together with a hash of your IP address combined with the day (never the address itself);</li>
    <li>for a decision bought on <code>/api/decide</code>, we keep the task you describe, the plan we
    returned, the paying wallet and any feedback you report on its steps, for 30 days;</li>
    <li>for a paid call, the sales ledger keeps the tool's name and a SHA-256 hash of the response we
    served, so a receipt can prove what was delivered; the response itself is not kept;</li>
    <li>a verdict you leave on a paid call through <code>/api/feedback</code>, including the reason
    you write, is kept with that call's transaction id and is never published.</li>
  </ul></li>
  <li><b>IP addresses.</b> Used for rate limiting and in standard operational logs (request path, status
  code) for abuse prevention and debugging. Most rate-limit counters are kept in process memory for up
  to one hour. The free trial's counters are kept in our Redis store, with the address (for IPv6, its
  /64 prefix) in the counter's key, for one hour, or 24 hours for the per-client daily allowance. We also
  keep keyed hashes of addresses, never the addresses themselves: in daily traffic statistics (request
  classes, paths and User-Agent product names; each day is deleted after ${TRAFFIC_DEFAULTS.retentionDays} days), in the record that limits how often a dropped
  connection is excused from payment (24 hours), and on the demand board and the waitlist (combined
  with the day). The tollbooth waitlist form stores the name, email, organisation and message you type;
  it does not store your IP address or browser string.</li>
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
  <li><b>Card purchases (reports and monitors).</b> Card details are entered on Stripe's
  hosted checkout and processed by <a href="https://stripe.com/privacy" rel="noopener">Stripe</a>; we never see card
  numbers. Stripe gives us the email address you entered, a customer and session id, and the payment
  status. A delivered report is private to its link unless you choose "Make public" on it, which gives it a second, unguessable address that anyone can read and search engines may index (you can make it private again any time, and the report never contains your name or email). We use the email to deliver what you bought and, after a one-off report, for at most two follow-up emails about that purchase (the monitor for the same subject two days later, other reports a week later), each carrying a link that stops them; if a report fails we email you about the refund. The report link, monitor reports and alerts are
  sent through a transactional email provider (ZeptoMail, with Resend as a fallback). Stripe keeps the
  email address with your payment; the record on our server holds the session id, your input and the
  finished report, not the email. Prepaid credits are not currently sold; for a key that already exists
  we keep a hash of the key (never the key), its balance and the calls it paid for. For a monitor
  we also keep the subject you asked us to watch (a domain, ticker, fund, token or query) and the
  reports we generated, for the life of the subscription. The input you give a report (a ticker, a
  domain, a research question) is stored with the paid session so the report can be generated once and
  served back to you; the finished report is served at an unguessable link and is not published.</li>
  <li><b>Operational telemetry.</b> The server records service events (tool called, payment settled,
  errors) with metadata - tool name, HTTP status, price, settlement chain, the paying wallet
  address (already public on-chain) and, on a settled payment, the first word of the caller's
  User-Agent - in a server-side analytics tool (PostHog). This is used to run
  the service: reliability, abuse prevention, and knowing what sells. It does not include tool inputs,
  prompts, outputs, cookies, or browser fingerprints; an error event carries our error message (at
  most 200 characters), which can name the input value that was refused.</li>
  <li><b>Payment metadata.</b> An x402 payment token can carry optional annotation fields (a resource URL, a
  description, a <code>reason</code> string) that some buyers use to label a purchase. Agent402 reads <i>only</i>
  the cryptographically-signed payer wallet address from the token - the exact field the settlement authorization
  covers, and one that is already public on-chain. Those annotation fields are never parsed, logged, or retained,
  so a buyer that inadvertently placed personal data in them does not expose it to us. Data-minimisation by
  construction, not by policy.</li>
  <li><b>Memory tools.</b> Data written via <code>/api/memory</code> is stored on our server keyed to the
  paying wallet, readable only by that wallet (or wallets it explicitly grants), until the owner deletes
  it or its TTL expires. A tamper-evident audit log of accesses is kept for the namespace owner.</li>
  <li><b>Weekly spend digest.</b> If you subscribe an email to a wallet (by signing a message with it) or to an existing credits key (by presenting it), we store that address, the wallet address or the key's id, and the dates we sent to it, and send a confirmation link first: no digest is sent until you click it, and an unconfirmed signup is deleted after three days. Each digest carries an unsubscribe link that removes the address. The key itself is never stored by the form.</li>
  <li><b>Free email alerts.</b> If you enter an email on a free report page to be told when a company, fund, domain or product changes, we store that address, the subject you chose and the dates we checked and emailed, and we send you a confirmation link first: nothing is watched and nothing else is sent until you click it. Alert emails go out at most once a day, only when something changed, through the same transactional provider, and every one carries a one-click unsubscribe link that ends the alert and stops all email. We do not use the address for anything else and do not share it.</li>
</ul>

<h2>Third parties</h2>
<ul>
  <li>Tools that fetch external URLs (<code>extract</code>, <code>render</code>, <code>screenshot</code>, …)
  contact those sites from our server with the URL you provided. Tools that read a third-party data
  source send it what the lookup needs (a ticker, a token or wallet address, a domain, a query).</li>
  <li><code>/api/search</code> and the other web search tools forward the query to the Brave Search API to produce results.</li>
  <li>The <code>/api/code-run</code> tools run the code you send in a sandbox operated by E2B.</li>
  <li><code>/api/route</code>, <code>/api/route/execute</code> and <code>/api/decide</code> may send the
  task text you give them to a judgment model operated by TypeSafe to choose among candidate tools;
  <code>/api/decide</code> also sends it to AI models via OpenRouter and to an OpenAI embedding model to
  build the plan. When route-and-execute or a decision's execution buys from an outside seller on your
  behalf, that seller receives the request it needs to answer, sent and paid for by us.</li>
  <li>Card payments and subscriptions are processed by Stripe; transactional email (report links,
  monitor and free alerts, the weekly digest) is sent through ZeptoMail, with Resend as a fallback. Report products read public sources named in each
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
for rate limiting and the hashed records described above. Tool calls made through it are processed
exactly like the HTTP API.</p>

<h2>Retention</h2>
<p>Operational logs are kept for our hosting platform's default log retention. Rate-limit counters
expire with their window (one hour, or 24 hours for the free trial's daily allowance). Memory-tool data
persists until deleted by its owner or TTL expiry. Card-purchase records (session id, input, the
finished report) are kept while the report link or subscription is live and for accounting afterwards.
Free-alert and weekly-digest records keep your email until you unsubscribe, when the address is
removed; an unconfirmed signup is deleted after three days. Follow-up email records drop the address
when you stop them. Decisions bought on <code>/api/decide</code> are deleted after 30 days. You can ask
us at the address below to delete your email from our alert, digest, follow-up, subscription and
waitlist records; the card processor's copy is deleted through Stripe. The sales ledger keeps wallet addresses and transaction ids, which are already public
on-chain. Aggregate, non-personal counters (total calls served per tool) are kept for the public
<a href="/api/stats">/api/stats</a> page.</p>

<h2>Abuse &amp; legal requests</h2>
<p>Wallet addresses associated with <a href="/terms">terms</a> violations may be blocked and retained
on a blocklist for as long as needed to enforce the block. We disclose information and preserve
records in response to valid legal process, and report content where the law requires it. Requests
and abuse reports: <a href="mailto:mike@agent402.tools">mike@agent402.tools</a>.</p>

<h2>Operator &amp; contact</h2>
<p>Agent402.Tools is operated by <strong><a href="https://havok.holdings" rel="noopener">Havok Holdings LLC</a></strong>. Contact: <a href="mailto:mike@agent402.tools">mike@agent402.tools</a>,
<a href="${repoUrl("issues")}" rel="noopener">GitHub issues</a>,
or <a href="https://x.com/Agent402Tools" rel="noopener">@Agent402Tools on X</a>.</p>
</div>
</section>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/privacy", extraCss, body });
}
