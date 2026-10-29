// Privacy policy — a stable URL is required for listing the remote MCP
// connector in Anthropic's directory, and it should be true: this service
// has no accounts, so there is genuinely little to say.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

import { REPO_URL, repoUrl } from "./repo-link.js";
import { DEFAULTS as TRAFFIC_DEFAULTS } from "./traffic-classifier.js";
import { backupKeepDays } from "./backup.js";
import { WISH_STALE_DAYS, wishRetentionDays } from "./wish.js";
import { auditRetentionDays, AUDIT_SWEEP_MS } from "./memory-retention.js";
import { ADDRESS_MAX_AGE_MS, MAX_SEND_FAILURES, RECORD_KEEP_MS } from "./followups.js";
import { creditsSalesEnabled } from "./credits-sales.js";
import { IDEM_TTL_MS } from "./idempotency-store.js";
import { gatewayOfferPublic } from "./gateway-nanopayments.js";
const DAYS = (ms) => Math.round(ms / 86_400_000);
export function privacyPage(baseUrl) {
  const title = "Privacy - Agent402";
  const description = "Agent402's privacy policy: no accounts, Google Analytics (advertising features off), an analytics cookie choice you can change. What we process, why, how long we keep it, and how to have it erased.";
  const canonical = `${baseUrl}/privacy`;
  // The Circle Gateway batched option, read from the live offer every other
  // surface reads (src/gateway-nanopayments.js): its sentence and the scoping
  // of the on-chain sentences appear only while it is offered.
  const gatewayBatched = !!gatewayOfferPublic();

  const extraCss = `
.pv-wrap{max-width:760px;margin:0 auto;padding:56px 30px}
.pv-eyebrow{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:18px}
.pv-h1{font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.96;margin:0 0 14px}
.pv-updated{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--faint);margin:0 0 32px}
.pv-body p,.pv-body li{font-size:var(--fs-base);line-height:1.55;color:var(--muted)}
.pv-body p{margin:0 0 14px}
.pv-body ul{margin:0 0 18px;padding:0 0 0 22px}
.pv-body li{margin-bottom:8px}
.pv-body h2{font-family:var(--font-body);font-weight:700;font-size:var(--fs-3xl);line-height:1;letter-spacing:-.02em;margin:36px 0 14px;color:var(--ink)}
.pv-body a{color:var(--accent);text-decoration:none}
.pv-body a:hover{text-decoration:underline}
.pv-body b,.pv-body strong{color:var(--ink);font-weight:600}
.pv-body i{font-style:italic}
.pv-body code{font-family:var(--font-mono);font-size:var(--fs-sm);background:var(--panel);color:var(--on-panel);padding:2px 7px;border:1px solid var(--hairline)}
@media(max-width:600px){.pv-h1{font-size:var(--fs-3xl) !important}}
`;

  const body = `
<div class="pv-wrap">
<section>
<div class="pv-eyebrow">$ GET /privacy</div>
<h1 class="pv-h1">Privacy policy</h1>
<p class="pv-updated">Agent402 (agent402.tools) - last updated 2026-10-30.</p>
</section>

<section>
<div class="pv-body">
<p>Agent402 has no accounts. Pages run a first-party page counter
(PostHog, served from our own domain). It records page views, page leaves (time on the page and how far
you scrolled) and page load timings (web vitals), with your browser, user agent string, operating system,
device type, screen and window size, browser language and time zone, the page address with any query
string cut to its <code>utm_*</code> campaign parameters, and the address of the page that linked you here,
cut the same way. It keeps a random per-visit id in session storage, never a cookie; our server relays the
events and forwards only their body and content type, so your IP address is not passed on to the
analytics provider. It keeps no session
replay: nothing you click, type or see on a page is recorded. Pages also run
<b>Google Analytics</b> (advertising features off) to count visits and see how people find the site. It sets a measurement cookie
(<code>_ga</code>) and Google receives your IP address and browser details under
<a href="https://policies.google.com/privacy" rel="noopener">Google's privacy policy</a>. Advertising
features, ad personalization and Google signals are off. If your browser's time zone is in Europe, the
cookie is off until you choose "Allow" in the strip at the bottom of the page, and Google only receives
cookieless pings before that; your choice is kept in your browser. Wherever you are, you can make or
change that choice at any time with "analytics choices" at the foot of the page. If your browser sends the Global Privacy Control signal,
the cookie stays off, you are not asked, and the page counter does not load. Pages whose address is itself a private
link (a paid report, a receipt, a signed alert or manage link) do not load Google Analytics. Free email
alerts are the form that takes an address, and it
says so where you enter it; a card purchase gives us the email you enter at checkout. Everything we
keep, and for how long, is listed below, including the backups of it. The entire server is <a href="${REPO_URL}" rel="noopener">open source</a>,
so every claim below is verifiable in code.</p>

<h2>What we process, and why</h2>
<ul>
  <li><b>Tool inputs.</b> The data you send to a tool (text to hash, a URL to render, …) is processed
  in memory to compute the response. It is not stored, except in these cases:
  <ul>
    <li>the <code>/api/memory</code> tools, whose purpose <i>is</i> storage (see below);</li>
    <li>some tools that read public data cache their answer for between one minute and one day, keyed
    by the input that produced it (a domain, an address to geocode, a URL), so a repeat call is faster;
    identical repeat calls to the AI gateway, identical retries carrying an
    <code>Idempotency-Key</code> (or the x402 payment-identifier), and the JSON answer of a call paid
    with a signed EVM x402 payment (keyed by that payment's nonce, so a re-sent copy is answered without
    a second settlement; not on identity-bound routes such as memory, on routes with a lasting effect,
    or for streamed calls) are cached for up to ${Math.round(IDEM_TTL_MS / 60000)} minutes;</li>
    <li>a search on <code>/api/find</code> or the connector's <code>catalog.find</code> that finds no
    matching tool, and a request sent to <code>/api/wish</code>, is kept as text on our demand board
    together with a hash of your IP address combined with the day (never the address itself); an entry
    leaves the board after ${WISH_STALE_DAYS} days without a repeat, and each request's text and hash are
    deleted ${wishRetentionDays()} days after it was sent, leaving only its counts, kept under a keyed hash
    of the text (never the text);</li>
    <li>for a decision bought on <code>/api/decide</code>, we keep the task you describe, the plan we
    returned, the paying wallet and any feedback you report on its steps, for 30 days;</li>
    <li>for a paid call, the sales ledger keeps the tool's name and a SHA-256 hash of the response we
    served, so a receipt can prove what was delivered; the response itself is not kept. It also keeps
    how the call arrived: through our hosted MCP connector, from one of our client packages (its name
    and version, the first word of the User-Agent it sends), or as any other HTTP request;</li>
    <li>a verdict you leave on a paid call through <code>/api/feedback</code>, including the reason
    you write, is kept with that call's transaction id and is never published.</li>
  </ul></li>
  <li><b>IP addresses.</b> Used for rate limiting and in standard operational logs (request path, status
  code) for abuse prevention and debugging. Most rate-limit counters are kept in process memory for up
  to one hour. The free trial's counters (the <code>?trial=1</code> allowance on the pure-CPU tools, see the
  <a href="/terms">terms</a>) are kept in our Redis store, with the address (for IPv6, its
  /64 prefix) in the counter's key, for one hour, or 24 hours for the per-client daily allowance. We also
  keep keyed hashes of addresses, never the addresses themselves: in daily traffic statistics (request
  classes, paths and User-Agent product names; each day is deleted after ${TRAFFIC_DEFAULTS.retentionDays} days), in the record that limits how often a dropped
  connection is excused from payment (24 hours), and on the demand board (combined with the day).
  The tollbooth waitlist form is closed, and every record it collected has been deleted from our
  database; those records were never part of our offsite backups.</li>
  <li><b>AI gateway inputs.</b> Prompts and inputs sent to the <code>/v1</code> endpoints (chat in the
  OpenAI, Anthropic and Gemini wire formats, embeddings, images, speech and transcription, including the
  audio you upload) and other AI-proxy tools are <b>forwarded to the upstream model
  provider</b> (OpenAI, or the model operator serving the request via OpenRouter) to generate the
  response, subject to that provider's own privacy terms. We don't store gateway inputs or outputs
  beyond short-lived caches (minutes) that make repeated identical calls cheaper. For requests served
  via OpenRouter, our account keeps its optional prompt and completion logging off, routes only to
  endpoints that do not train on or publish request data, and does not let OpenRouter use inputs or
  outputs to improve its product. Request metadata such as the model, token counts and cost is still
  recorded for billing and monitoring, without the prompt or completion text.</li>
  <li><b>On-chain payments.</b> For x402 and MPP payments there are no card numbers, names, or emails.
  Payments settle in USDC on the public Base blockchain (or the other chains listed at <a href="/pricing">/pricing</a>,
  USDG on Robinhood Chain, or MPP on Base, Celo or Tempo) via the x402 or MPP protocol; ${gatewayBatched ? "for a payment settled on chain, " : ""}wallet addresses, amounts, and
  timestamps are public on-chain by the protocol's design, not collected by us. ${gatewayBatched ? "Circle Gateway batched payments are verified and settled by Circle Gateway off chain; the sales ledger keeps Gateway's transfer id for them. " : ""}Payment verification ${gatewayBatched ? "for every other payment " : ""}is
  performed by the payment facilitators (Coinbase CDP and per-chain facilitators, or Tempo's relay) and
  we keep a sales ledger of settled payments (wallet address, amount, chain, transaction id) for accounting
  and for refunding a call that was charged but failed.</li>
  <li><b>Card purchases (reports, monitors and prepaid credits).</b> Card details are entered on Stripe's
  hosted checkout and processed by <a href="https://stripe.com/privacy" rel="noopener">Stripe</a>; we never see card
  numbers. Stripe gives us the email address you entered, a customer and session id, and the payment
  status. A delivered report is private to its link unless you choose "Make public" on it, which gives it a second, unguessable address that anyone can read and search engines may index (you can make it private again any time, and the report never contains your name or email). We use the email to deliver what you bought and, after a one-off report, for at most two follow-up emails about that purchase (the monitor for the same subject two days later, other reports a week later), each carrying a link that stops them; if a report fails we email you about the refund. The report link, monitor reports and alerts are
  sent through a transactional email provider (ZeptoMail, with Resend as a fallback). Stripe keeps the
  email address with your payment; the report record on our server holds the session id, your input and the
  finished report, not the email. The email is kept in the follow-up and monitor records described here,
  and a failed report is counted against a SHA-256 hash of the address (never the address) for 24 hours so
  repeated failures for one buyer stop further charges. Prepaid credits ${creditsSalesEnabled() ? "are sold by card at /credits" : "are not currently sold"}; for each key
  we keep a hash of the key (never the key), its balance and the calls it paid for, and from its purchase the email, the
  billing country, state and postal code, any business tax ID you enter, your answers to the checkout's business-use and
  terms questions, and Stripe's fingerprint of the card (a token, never the card number). We use the billing address to
  apply sales tax, the tax ID to sell to a business in the EU or the UK, and the email and card fingerprint to enforce the
  daily purchase limit. For a monitor
  we also keep the subject you asked us to watch (a domain, ticker, fund, token or query), your email
  and the most recent 12 reports we generated, for the life of the subscription. The input you give a report (a ticker, a
  domain, a research question) is stored with the paid session so the report can be generated once and
  served back to you; the finished report is served at an unguessable link and is not published.</li>
  <li><b>Operational telemetry.</b> The server records service events (tool called, payment settled,
  errors) with metadata - tool name, HTTP status, price, settlement chain, the paying wallet
  address (already public on-chain) and, on a settled payment, the first word of the caller's
  User-Agent - in a server-side analytics tool (PostHog). This is used to run
  the service: reliability, abuse prevention, and knowing what sells. It does not include tool inputs,
  prompts, outputs, cookies, or browser fingerprints, with these exceptions: a tool call can carry a keyed
  hash of one declared input field (for example the ticker), so repeat use is countable without the value;
  a refused payment carries the resource URL the payment names and a coarse balance bucket for the paying
  wallet; and an error event carries our error message (at most 200 characters), which can name the input
  value that was refused.</li>
  <li><b>Payment metadata.</b> Beyond what the payment protocol needs to verify and settle a payment, our
  code reads these fields of a payment: the signed payer wallet address (already public on-chain), the
  scheme and network it settles on, the optional <code>payment-identifier</code> (used as an idempotency key
  and kept with the cached answer for up to ${Math.round(IDEM_TTL_MS / 60000)} minutes), the payment's nonce and network (as an
  idempotency key for a re-sent payment, held with the cached answer for up to ${Math.round(IDEM_TTL_MS / 60000)} minutes), the signers of a Solana payment (stored only
  as a keyed hash), the source address of a Tempo credential, the payer the settlement receipt names, and,
  on a refused payment, the resource URL it names (see telemetry above). The optional description and
  <code>reason</code> annotation fields are not read, logged or retained. The machine-readable list is in
  <a href="/.well-known/x402">/.well-known/x402</a> under <code>payment.dataHandling</code>: <code>readsOnly</code>
  names the fields read, and <code>readsAnnotationFields: false</code> states that the annotations are not.</li>
  <li><b>Memory tools.</b> Data written via <code>/api/memory</code> is stored on our server keyed to the
  paying wallet, readable only by that wallet (or wallets it explicitly grants), until the owner deletes
  it or its TTL expires. A tamper-evident audit log of accesses is kept for the namespace owner: each entry
  records the paying wallet, the key name and the action, and for counters and compare-and-set the values
  involved. Each entry is deleted ${auditRetentionDays()} days after it is written. Within ${Math.round(AUDIT_SWEEP_MS / 60000)} minutes of a key
  or document being deleted or expiring, the entries that name it lose the key name and values (the wallet,
  action and time stay, so the log still verifies), and a namespace with no keys, documents or grants left
  loses its whole log.</li>
  <li><b>Free email alerts.</b> If you enter an email on a free report page to be told when a company, fund, domain or product changes, we store that address, the subject you chose and the dates we checked and emailed, and we send you a confirmation link first: nothing is watched and nothing else is sent until you click it. Alert emails go out at most once a day, only when something changed, through the same transactional provider, and every one carries a one-click unsubscribe link that ends the alert and stops all email. We do not use the address for anything else and do not share it.</li>
</ul>

<h2>Third parties</h2>
<ul>
  <li>Tools that fetch external URLs (<code>extract</code>, <code>render</code>, <code>screenshot</code>, …)
  contact those sites from our server with the URL you provided. Tools that read a third-party data
  source send it what the lookup needs (a ticker, a token or wallet address, a domain, a query).</li>
  <li><code>/api/search</code> and the other web search tools forward the query to the Brave Search API to produce results.
  <code>/api/exa-search</code>, <code>/api/exa-answer</code> and <code>/api/exa-contents</code> send it to Exa, whose model
  writes the <code>/api/exa-answer</code> response. The <code>/api/x-*</code> tools send the handle, post id or query to the X API.</li>
  <li>The <code>/api/code-run</code> tools run the code you send in a sandbox operated by E2B.</li>
  <li><code>/api/route</code>, <code>/api/route/execute</code> and <code>/api/decide</code> may send the
  task text you give them to a judgment model operated by TypeSafe to choose among candidate tools;
  <code>/api/decide</code> also sends it to AI models via OpenRouter and to an OpenAI embedding model to
  build the plan. When route-and-execute or a decision's execution buys from an outside seller to resell
  the result to you, that seller receives the request it needs to answer, sent and paid for by us.</li>
  <li>Card payments and subscriptions are processed by Stripe; transactional email (report links,
  monitor and free alerts) is sent through ZeptoMail, with Resend as a fallback. Report products read public sources named in each
  report (for example SEC EDGAR, openFDA, DNS and certificate-transparency logs, public blockchain
  explorers, and web search) and are synthesized by third-party AI models via OpenRouter, which receive
  the report's inputs and source material, not your email. When the optional Stripe ledger mirror is on,
  settled on-chain payments (wallet address, transaction id, amount) are recorded in Stripe for
  bookkeeping; no email or card data is involved in that mirror.</li>
  <li>Hosting is on Railway, and the nightly backups described below are stored in object storage there.
  On-chain settlement is on Base (Coinbase CDP facilitator) and the other
  facilitators named at <a href="/pricing">/pricing</a>${gatewayBatched ? "; Circle Gateway batched payments settle off chain at Circle Gateway" : ""}.</li>
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
A prepaid credits key's record (the purchase details listed above and the calls it paid for) is kept for
the life of the key and three years after its last use, the period sales tax records must be kept, and is
deleted on request after that; within that period a deletion request removes what tax records do not need.
Free-alert records keep your email until you unsubscribe, when the address is
removed; an unconfirmed signup is deleted after three days. Follow-up email records delete the address
as soon as the last follow-up is sent, when you stop them or buy again, or after ${MAX_SEND_FAILURES} failed deliveries
in a row, and in any case ${DAYS(ADDRESS_MAX_AGE_MS)} days after the purchase; the rest of the record (the
product and the subject you asked about) is deleted ${DAYS(RECORD_KEEP_MS)} days after the purchase. Memory audit-log
entries are deleted ${auditRetentionDays()} days after they are written, and demand-board request text
${wishRetentionDays()} days after it was sent. Decisions bought on <code>/api/decide</code> are deleted after 30 days. You can ask
us at the address below to delete your email from our alert, follow-up and subscription
records; the card processor's copy is deleted through Stripe. The sales ledger keeps wallet addresses and transaction ids, which are already public
on-chain${gatewayBatched ? " (for a Circle Gateway batched payment, it keeps Gateway's transfer id instead)" : ""}. Aggregate, non-personal counters (total calls served per tool) are kept for the public
<a href="/api/stats">/api/stats</a> page.</p>
<p><b>Backups.</b> Each night we copy the stored records above (the state database, including the
email, memory and ledger records) to separate object storage, and each copy is deleted
after ${backupKeepDays()} days. A deletion you ask for therefore reaches the last backup that still holds
the record within ${backupKeepDays()} days.</p>

<h2>Your rights (EU and UK)</h2>
<p>If you are in the European Economic Area or the United Kingdom, the controller of the data described
on this page is <strong>Cardhavok LLC</strong>, doing business as <strong>Havok Holdings LLC</strong>
(see <a href="/company">/company</a>). Our legal bases are: the contract you enter by paying, for a paid
call or a purchase; our legitimate interest in running and protecting the service, for the operational logs,
rate limiting and abuse control above; and your consent, for the analytics cookie and for email alerts,
which you can withdraw at any time ("analytics choices" at the foot of the page, or the unsubscribe link
in every alert). Where your browser reports a European time zone, the cookie waits for your choice;
elsewhere it is set until you say no, and the choice is yours to make either way. You have the right to ask for access to your data, to have it corrected or erased, to
receive it in a portable form, to object to processing based on our legitimate interest, to withdraw
consent, and to complain to your supervisory authority. To exercise a right, email
<a href="mailto:mike@agent402.tools">mike@agent402.tools</a>; we answer within one month. The service is
operated from the United States, and the data described here is processed and stored there.</p>

<h2>Children</h2>
<p>The service is for people 18 and older (see the <a href="/terms">terms</a>) and is not directed at
children. We do not knowingly collect anything from anyone under 13; if you believe a child has sent us
an email address or other information, write to the address below and we will delete it.</p>

<h2>Abuse &amp; legal requests</h2>
<p>Wallet addresses associated with <a href="/terms">terms</a> violations may be blocked and retained
on a blocklist for as long as needed to enforce the block. We disclose information and preserve
records in response to valid legal process, and report content where the law requires it. Requests
and abuse reports: <a href="mailto:mike@agent402.tools">mike@agent402.tools</a>.</p>

<h2>Operator &amp; contact</h2>
<p>Agent402.Tools is operated by <strong>Cardhavok LLC</strong>, doing business as <strong><a href="https://havok.holdings" rel="noopener">Havok Holdings LLC</a></strong>. Contact: <a href="mailto:mike@agent402.tools">mike@agent402.tools</a>,
<a href="${repoUrl("issues")}" rel="noopener">GitHub issues</a>,
or <a href="https://x.com/Agent402Tools" rel="noopener">@Agent402Tools on X</a>.</p>
</div>
</section>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/privacy", extraCss, body });
}
