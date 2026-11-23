// Terms of Service — a stable, public ToS URL is a submission requirement for
// the Anthropic connector directory. Kept short and honest: a no-account,
// open-source, pay-per-call tool service.
import { taskRetentionPublic } from "./mcp-tasks.js";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

import { REPO_URL } from "./repo-link.js";
import { gatewayOfferPublic } from "./gateway-nanopayments.js";
import { creditsSalesEnabled, creditsConnectorOn, CREDITS_CONNECTOR_PATH, creditsDailyMaxCents, creditsBalanceMaxCents, withCreditsSalesDate } from "./credits-sales.js";
import { answerShareEnabled, sharePagesMayBeLive } from "./answer-share.js";
import { publicIndexTermsText, withPublicIndexDate } from "./facilitator-public-index.js";
import { referralOffered } from "./referral-gate.js";
import { awsMarketplaceOffered } from "./aws-marketplace-gate.js";
import { AWS_UNANSWERED_SENTENCE } from "./aws-unanswered-copy.js";
import { IDEM_TTL_MS } from "./idempotency-store.js";
import { ROBOTS_UNGATED_READS } from "./tools/robots-gate.js";
import { refundClauseText } from "./refund-terms.js";
import { CONFORMANCE_PATH } from "./conformance-path.js";
import { connectorWires } from "./connector-pay.js";
import { COMPANY_PHONE, LEGAL_ENTITY_SENTENCE } from "./company.js";
import { companyPostalLine } from "./email.js";
import { lowBalanceWords, signInLifeWords } from "./credits-figures.js";
// Where a fraud-warning refund goes (src/credits.js fraudWarning and
// approveFraudRefund): automatically only to the warned payment's own card,
// and only when it can take the whole balance back; otherwise a person
// approves the ordinary refund, to the cards that paid, newest first.
const FRAUD_WARNING_REFUND = "automatically to that payment's card when that payment can take all of it back, otherwise after our review to the cards that paid for the key, newest payment first";
const FRAUD_WARNING_RULE = `A key whose payment the card network reports as possibly fraudulent is frozen, and its unspent balance is refunded ${FRAUD_WARNING_REFUND}.`;
export function termsPage(baseUrl) {
  // Prepaid credits wording follows the sales switch and the purchase limit.
  const creditsOnSale = creditsSalesEnabled();
  const connectorOn = creditsConnectorOn();
  const creditsLimitUsd = (creditsDailyMaxCents() / 100).toLocaleString("en-US");
  const creditsCapUsd = (creditsBalanceMaxCents() / 100).toLocaleString("en-US");
  const title = "Terms of Service - Agent402";
  const description = "Agent402 terms of service: open-source, pay-per-call web tools. As-is, no warranty, on-chain settlement.";
  const canonical = `${baseUrl}/terms`;
  // The Circle Gateway batched option, read from the live offer every other
  // surface reads (src/gateway-nanopayments.js): its paragraph and the scoping
  // of the on-chain sentences appear only while it is offered.
  const gatewayBatched = !!gatewayOfferPublic();
  // Sales through a referral network's links (src/referral-gate.js): stated only while this server has them.
  const referralOn = referralOffered();
  // Purchases through AWS Marketplace (src/aws-marketplace-gate.js): stated only while this server sells there.
  const awsOn = awsMarketplaceOffered();
  // Shared answer pages exist only while their switch is on, or while pages
  // made under it may still be served (src/answer-share.js): then the
  // paragraph reads in the past tense.
  const sharesOn = sharePagesMayBeLive();
  const sharesOffered = answerShareEnabled();
  // The public settlement index disclosure (FACILITATOR_PUBLIC_INDEX_CHAINS),
  // pointed to only while a chain is listed; the printed date then follows
  // FACILITATOR_PUBLIC_INDEX_SINCE when that is later (withPublicIndexDate).
  const publicIndex = publicIndexTermsText();
  // The refund sentences, from the one source the conformance document's
  // refundTerms also reads (src/refund-terms.js).
  const clause = (id) => refundClauseText(id, { gatewayBatched });
  // The wires the hosted connector takes in the call on this boot
  // (src/connector-pay.js): none in FREE_MODE, x402 alone without the MPP gates.
  const connectorWire = connectorWires().phrase;
  // The copyright agent's mail address is COMPANY_POSTAL_ADDRESS, the value
  // /company and every outbound email print; unset, the section points there.
  const postal = companyPostalLine();

  // The terms the model providers ask us to pass on to everyone who uses
  // their models through us (model-backed catalog tools and the /v1 routes).
  const modelOutputsSection = `
<h2 id="model-outputs">Model outputs</h2>
<p>Some answers are written in whole or in part by third-party AI models: the <code>/v1</code> gateway routes and the
catalog tools marked model-backed (reports, research, summaries, speech, transcription, images and others). When
you use them, you also agree to the following:</p>
<ul>
  <li><b>Provider terms:</b> your use of a model's output is also governed by the usage policies and terms of the
  provider whose model produced it, including <a href="https://openai.com/policies/usage-policies/" rel="noopener">OpenAI's usage policies</a>
  and the <a href="https://openrouter.ai/docs/features/provider-routing#terms-of-service" rel="noopener">model terms listed by OpenRouter</a>
  for the models served through it. Where those terms limit the use of output more than these terms do, they apply.</li>
  <li><b>No competing models:</b> don't use outputs to develop, train or improve an AI model that competes with the
  model that produced them, or to extract a model's behavior or weights.</li>
  <li><b>AI output stays AI output:</b> don't present AI output as made by a person, or use it to mislead anyone about
  whether content was generated by AI. Synthetic speech (from the speech and dubbing tools) must always be
  disclosed as AI-generated to the people who hear it, and must not imitate a real person's voice without that
  person's consent.</li>
  <li><b>No licensed advice:</b> don't use outputs to give others tailored advice that requires a professional
  license (legal, medical, financial, tax and the like) unless a qualified professional reviews it first.</li>
</ul>
`;
  // The clause for tools that fetch a URL their caller names, under the same
  // "last updated" date as the section above. The windows are the ones the
  // server runs with (src/idempotency-store.js, src/mcp-tasks.js); the robots
  // rule is src/tools/robots-gate.js, described on /crawler.
  const callerUrlSection = `
<h2 id="caller-urls">URLs you ask us to fetch</h2>
<p>Some tools fetch a web page, file or feed at a URL you name and return its content, or something read
from it, to you: for example the article, render, screenshot, PDF, image, audio and feed readers and the
skill packs built on them. When you use them:</p>
<ul>
  <li><b>Your right to the content:</b> you represent that you have the right to access the content at
  every URL you name and to use it as you do. You are responsible for following the terms of the site
  that serves it and the rights of whoever owns it, copyright included.</li>
  <li><b>How we fetch:</b> each URL is fetched for that call, at your request, as a browser would: without signing in,
  without cookies or credentials, and without getting past any access control. The request names itself
  as ours (see <a href="/crawler">/crawler</a>). Before returning a page's content we read the site's
  robots.txt, and we do not fetch a path it disallows for our fetch token; such a call answers 403.
  The tools that read only a status or metadata do not read robots.txt first: ${ROBOTS_UNGATED_READS}.</li>
  <li><b>What we keep:</b> fetched content is returned to you and not stored, except that a paid answer is
  kept for up to ${Math.round(IDEM_TTL_MS / 60000)} minutes so that the same payment sent again gets the same answer, and the
  result of a call you run as an async job or an MCP task is kept for ${taskRetentionPublic().keptFor} so you can fetch it.</li>
</ul>
`;

  const extraCss = `
.tm-wrap{max-width:760px;margin:0 auto;padding:56px 30px}
.tm-eyebrow{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:18px}
.tm-h1{font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.96;margin:0 0 14px}
.tm-updated{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--faint);margin:0 0 32px}
.tm-body p,.tm-body li{font-size:var(--fs-prose);line-height:1.6;color:var(--muted)}
.tm-body p{margin:0 0 14px}
.tm-body ul{margin:0 0 18px;padding:0 0 0 22px}
.tm-body li{margin-bottom:8px}
.tm-body h2{font-family:var(--font-body);font-weight:700;font-size:var(--fs-3xl);line-height:1;letter-spacing:-.02em;margin:36px 0 14px;color:var(--ink)}
.tm-body a{color:var(--accent);text-decoration:none}
.tm-body a:hover{text-decoration:underline}
.tm-body b,.tm-body strong{color:var(--ink);font-weight:600}
.tm-body code{font-family:var(--font-mono);font-size:var(--fs-sm);background:var(--panel);color:var(--on-panel);padding:2px 7px;border:1px solid var(--hairline)}
@media(max-width:600px){.tm-h1{font-size:var(--fs-3xl) !important}}
`;

  const body = `
<div class="tm-wrap">
<section>
<div class="tm-eyebrow">$ GET /terms</div>
<h1 class="tm-h1">Terms of Service</h1>
<p class="tm-updated">Agent402 (agent402.tools) - last updated 2026-11-24.</p>
</section>

<section>
<div class="tm-body">
<p>Agent402 provides web tools that clients - human-operated or autonomous agents - call over HTTP.
By using the service, including programmatically via the x402 payment protocol or the MCP connector,
you agree to these terms. If you operate an agent that uses the service, you are responsible for that
agent's use. You must be at least 18, able to form a binding contract, not barred from receiving
services under U.S. or other applicable law, and not located in an embargoed jurisdiction or listed on
any U.S. government sanctions list. The service is
<a href="${REPO_URL}" rel="noopener">open source</a>; these terms cover the hosted instance at agent402.tools.
If you do not agree to these terms, do not use the service.</p>

<h2>The service</h2>
<ul>
  <li><b>Utility tools:</b> small web tools that run as code. A pure-computation tool returns the same output for the same input; a live-data tool returns what its source reports at the time of the call. No language model writes a utility tool's answer. Where the router or the Decide planner chooses which tool to run, a judgment model can make that choice.</li>
  <li><b>AI gateway:</b> the <code>/v1</code> endpoints (chat in the OpenAI, Anthropic and Gemini wire formats, embeddings, image generation, speech and transcription) are our gateway service: each call runs on a <b>third-party AI model</b>, the one its tier serves (on embeddings, the model the request names); a call on a chat tier falls back to the next model on that tier when one fails; and each call is priced before it runs (a flat tier price, or a quote from the request on the metered routes). We use providers such as OpenAI and models served via OpenRouter. A small number of catalog tools use the same models. Outputs on these paths are generated by those models from the inputs you send.</li>
  <li><b>Report products and monitors:</b> finished, cited reports (company dossier, 13F fund report, insider flow, domain security audit, FDA recall, deep research and others) sold per run to agents over x402/MPP and to people by card at <a href="/reports">/reports</a>, and <b>monitors</b> - recurring subscriptions at <a href="/monitors">/monitors</a> that re-run a report when its subject changes and email the result. Reports are produced with third-party AI models from public sources named in the report; they are information, not professional, legal, financial, investment, or medical advice.</li>
  <li><b>Prepaid credits:</b> a card prepayment for Agent402's own services, for business and developer use, spent per call at list price through a bearer key. ${creditsOnSale ? `Credits are sold by card in fixed packs at <a href="/credits">/credits</a>. Each purchase issues a new key, and a balance can then be topped up with more packs from its balance page, so no key holds more than $${creditsCapUsd}: a top-up that would take a balance past it is refused before you pay, with the room left stated. You buy and manage credits signed in at <a href="/credits/account">/credits/account</a> with your email: a link we email you, valid once for ${signInLifeWords()}. A purchase belongs to that email. There you see each balance and its history, top it up, set daily and per-call spending limits, ask for the unspent balance back, issue a new key for a lost one, or revoke a key; a new key replaces the old one, which stops working at once, and keeps the balance and its history. Anyone holding a key can revoke it with <code>POST /api/credits/revoke</code> without spending it. We may decline a purchase, and refund it in full, to protect buyers and the service. A key whose payment is disputed is frozen while the dispute is open, and the dispute's outcome, decided by the card network and reported by Stripe, settles what goes back to the card. ${FRAUD_WARNING_RULE}` : "Prepaid credits are not currently sold; keys already issued keep working."} Credits are not money, a deposit, a gift card or a payment account: they cannot be cashed out (except as described below or where the law requires), transferred, resold, or used to pay anyone other than Agent402. Routes that buy from an outside seller with our wallet are paid with a wallet, not with credits. Agent402 is the seller of every answer it sells; the providers and sellers we buy from are our vendors.${connectorOn ? ` Whoever holds the key can spend the balance, so keep it secret. An app you connect at <code>${CREDITS_CONNECTOR_PATH}</code>, after signing in with the email that holds the balance, can also spend it, up to the daily cap you set for that app; you are responsible for the apps you connect, and you change a cap or disconnect an app on the balance page at any time.` : " The key is the only credential: whoever holds it can spend the balance, so keep it secret."} Credits never expire and carry no fees.</li>
  <li>${creditsOnSale ? "No account is needed to call the tools; prepaid credits are bought and managed signed in by email at /credits/account." : "No account."} Access is by paying per call (USDC/USDG via the x402 protocol or MPP; prices at <a href="/pricing">/pricing</a>), by card (Stripe Checkout, for reports and monitors${creditsOnSale ? ", and for prepaid credits" : ""}), or, on the pure-CPU tools, by solving a proof-of-work challenge or through the limited free trial where it is offered (<code>?trial=1</code> on the call, capped per client). The hosted MCP connector runs the pure-CPU tools free, rate-limited${connectorWire ? `, and a wallet can pay the other tools through it in the call, over ${connectorWire}` : ""}.</li>
  <li>Provided <b>"as is", without warranty</b> of any kind. We do not guarantee availability, fitness for a particular purpose, or that any tool or generated output will be error-free or accurate.</li>
</ul>

<h2>Acceptable use</h2>
<ul>
  <li>You must be <b>18 or older</b> (or the age of majority where you live, if higher) to use the service or buy anything on it. The service is not directed at children, and we do not knowingly collect anything from anyone under 13.</li>
  <li>Don't use the service to break the law, infringe others' rights, or attack the service or third parties (e.g. using the URL-fetching tools against targets you don't control).</li>
  <li>Don't attempt to bypass rate limits, payment, or the proof-of-work gate, or to disrupt availability for others.</li>
  <li><b>Generative paths:</b> don't use the AI gateway or any generative tool to create or attempt to create: child sexual abuse material (zero tolerance - we will block the wallet and report as required by law); non-consensual intimate imagery or sexual content depicting real people; content that impersonates a real person to deceive; material that infringes others' intellectual-property rights; or content whose creation or distribution is otherwise illegal in your jurisdiction or ours.</li>
  <li>Traffic through the AI gateway is also subject to the <b>usage policies of the upstream model providers</b> (including OpenAI's usage policies and the terms of OpenRouter and the model operators it serves). Those providers apply their own safety filtering and may refuse requests; their policies apply to your use through us. The GPT Image tools (image-gen, image-gen-hd and image-gen-premium) ask the provider for its less restrictive filtering level by default, and a caller may choose its stricter level; the provider's usage policies apply at either level. Don't attempt to circumvent, probe, or disable that safety filtering.</li>
  <li>Don't use the service to create malware or exploits for unauthorized use, to defraud, phish, spam, or deceive, or to process other people's personal data unlawfully.</li>
  <li><b>High-risk use is prohibited:</b> the service is not designed for, and must not be relied on in, any context where failure or inaccuracy could lead to death, personal injury, or severe damage - including medical treatment, life-safety systems, and operation of critical infrastructure.</li>
  <li>You are responsible for the inputs you send and how you use the outputs.</li>
</ul>

<h2>Generated content</h2>
<p>Outputs from the AI gateway are produced by third-party models from your inputs. We do not review
them, do not claim ownership of them, and do not publish or host them - they are returned to you and
not retained, with ${referralOn ? "three" : "two"} exceptions: short-lived caches that make repeated identical calls cheaper, ${referralOn ? "" : "and "}the
result of a call you run as an async job or an MCP task, which is kept for ${taskRetentionPublic().keptFor} after the job was
created so you can fetch it${referralOn ? `, and the answer to a call bought through a referral link, which is kept with its payment for up to
${Math.round(IDEM_TTL_MS / 60000)} minutes so that the same payment sent again gets the same answer` : ""}. Generated
content may be inaccurate, incomplete, or unsuitable for your purpose; it is not professional, legal,
financial, or medical advice. Your use of generated content, including any obligation to verify it or
mark it as AI-generated where the law or the section below requires, is your responsibility.</p>${sharesOn ? `
<p>A web.answer call made with <code>share=true</code>${sharesOffered ? " publishes" : " while sharing was offered published"} a shared answer page: it shows the
caller-supplied question and a model-generated answer, and we may remove it at any time.</p>` : ""}

${modelOutputsSection}${callerUrlSection}
<h2>Enforcement</h2>
<p>We may refuse service to, rate-limit, or block any wallet at our sole discretion, with or without
notice, including for violations of these terms or of upstream provider policies. Wallets used for
repeated violations are blocked permanently. We cooperate with law enforcement and will disclose
information and preserve records in response to valid legal process, and report content where the law
requires it. To report abuse, infringement, or illegal content involving this service, email
<a href="mailto:help@agent402.tools">help@agent402.tools</a> - reports are reviewed promptly.</p>

<h2>The published index</h2>
<p>We publish an index of services that advertise machine payments over x402 or MPP. It is built by
reading the discovery documents those services publish for that purpose - <code>/.well-known/x402</code>,
<code>/openapi.json</code>, <code>/llms.txt</code> - and the HTTP 402 challenge a paid route returns to an
unpaid request. We do not authenticate, submit forms, or read anything behind a paywall. Our crawler
identifies itself by name and honors <code>robots.txt</code>. See <a href="/crawler">/crawler</a> for the
User-Agent, the cadence, and how to have a service removed - by email or by disallowing the User-Agent,
with no reason required either way.</p>
<p>What the index reports about a service is what that service advertises about itself, plus our own
observations of it: whether our probe reached it, and what its own 402 challenges named. Settlement
figures are counts read from public blockchains. <b>The index publishes counts of payments received per
payee, and its buyer figures are counts.</b> Payments on public blockchains are public: some of our pages
show individual payments as the chain records them, for example the live payments view on our home page,
which shows shortened payer addresses with links to the public transactions. We do not sell payer data.</p>
<p>We claim no rights in the underlying facts a service publishes about itself; those are its own. We do
claim our compilation - the selection, arrangement, verification and history of the index - and our own
measurements and probe results, and we license them on the terms we publish for whichever surface you
obtained them from. Measurements made by third parties are attributed where displayed and are not
redistributed by us.</p>

<h2 id="copyright">Copyright complaints</h2>
<p>Some material on the service is stored or shown at a caller's request: memory-tool data, shared
answer pages, reports made public, and listings in the published index. Content our tools fetch from a
URL a caller names is passed to that caller (see <a href="#caller-urls">URLs you ask us to fetch</a>);
a notice may concern that content too, and a site can stop those reads for every caller with its
robots.txt. If you believe material on the service, or content it fetched for a caller, infringes your
copyright, send a notice to our designated agent:</p>
<p><b>Copyright agent</b>, ${LEGAL_ENTITY_SENTENCE}<br>
Email: <a href="mailto:mike@agent402.tools">mike@agent402.tools</a><br>
Phone: <a href="tel:${COMPANY_PHONE.tel}">${COMPANY_PHONE.display}</a><br>
${postal ? `Mail: ${esc(postal)}` : `Mail: the postal address on <a href="/company">/company</a>`}</p>
<p>A notice includes: your physical or electronic signature; the copyrighted work you say is infringed;
the material you want removed and where it is (a URL is best); your name, postal address, phone and
email; a statement that you believe in good faith the use is not authorized by the owner, its agent or
the law; and a statement that the notice is accurate and, under penalty of perjury, that you are the
owner or authorized to act for the owner. On a complete notice we remove or disable the material
promptly and take reasonable steps to notify the person who provided it, where we can identify them.
Removing a shared answer page deletes it, so it cannot be restored.</p>
<p>If your material was removed and you believe that was a mistake or a misidentification, send a
counter-notice to the same agent with: your physical or electronic signature; the material removed and
where it was before removal; a statement under penalty of perjury that you believe in good faith it was
removed by mistake or misidentification; your name, postal address and phone; and your consent to the
jurisdiction of the federal district court for your address (or, outside the United States, any judicial
district where we may be found) and to accept service from the person who sent the notice or that
person's agent. We forward the counter-notice to that person and, for material we can restore, restore it
in 10 to 14 business days unless they tell us they have filed a court action to keep it down.</p>
<p>We block the wallets, and end the subscriptions and keys, of repeat infringers.</p>

<h2>Payments</h2>
<p><b>On-chain (x402 / MPP).</b> Paid calls settle on public blockchains${gatewayBatched ? " (except Circle Gateway batched payments, below)" : ""} - USDC on Base and the other
chains listed at <a href="/pricing">/pricing</a>, USDG on Robinhood Chain, and MPP settlement on Base,
Celo or Tempo. ${clause("settle-after-success")} ${clause("final-before-call")}
${clause("late-landing")} ${clause("unconfirmed-eip3009")} ${clause("owed-not-served")}
${clause("finality")} Metered routes quote a ceiling before
payment and settle at or under it. You are responsible for your own wallet and keys; we never receive or
hold your private key.${publicIndex ? ` ${publicIndex}` : ""}</p>${gatewayBatched ? `
<p><b>Circle Gateway batched payments.</b> A Circle Gateway batched payment settles off chain at Gateway.
${clause("gateway-pending")}</p>` : ""}
${referralOn ? `<p id="referral-links"><b>Referral links.</b> A tool bought through a referral link is sold by Agent402 under these terms,
at the price listed for the same call on our own route. The payment is made to the referral network's
payment contract, which pays part to us and part to the reviewer. The network's own terms apply to its links,
reviews and rewards. A referral payment is settled after the call has run and before its answer is sent. If a
referral payment reaches us and the answer cannot be delivered, we record the full price you paid as owed to
the paying wallet and repay it on Base as described under refunds below; the answer to such a call then says
so and names the payment's transaction. A payment the network's contract pays to another merchant does not
reach us and is not recorded as owed; the answer names its transaction. Reviews on a referral network are written by
its reviewers, who can earn a commission. We do not write, edit, select or pay for reviews beyond that
commission. Market, filing and price data is information from the named source at the time of the call. It is
not investment, trading, legal or tax advice.</p>
` : ""}<p><b>Results from other sellers.</b> Some routes, such as <code>/api/route/execute</code> and
<code>/api/decide/execute</code>, can return a result that Agent402 obtained from a third-party seller.
Agent402 buys that result from the seller for its own account, with its own funds, and sells it to you;
your payment is a payment to Agent402 for the result, at the price shown before you pay. Agent402 does not
send, hold or exchange funds for you on these routes, and you have no account with the seller through us.
Where a route returns part of a payment as a service credit (for example the unspent budget of
<code>/api/decide/execute</code>), that credit is redeemable only for Agent402 services, for the period
stated on that route.</p>
<p><b>Refunds on-chain.</b> ${clause("ordinary-failure")} ${clause("charged-but-failed")}
${clause("repayment-process")} ${clause("repayment-proof")}
${clause("connection-closed-review")} ${clause("unidentified-payer")}
${clause("sanctions-before-repayment")} ${clause("rights-by-law")}
A machine-readable copy of these refund terms is published at <a href="${CONFORMANCE_PATH}"><code>${CONFORMANCE_PATH}</code></a>
(its <code>refundTerms</code>); where the two differ, these terms govern.</p>
<p><b>By card.</b> Card payments for reports and monitors, for pay-per-call purchases made with a card over MPP, and for prepaid credits are processed by
<a href="https://stripe.com" rel="noopener">Stripe</a> under Stripe's terms; we never see card numbers. ${clause("card-report")} A report that was delivered is final. ${creditsOnSale ? `Prepaid credits are consumed as you
call tools, and the unspent balance on a key is refundable on request, with no fee: send
<code>POST /api/credits/refund</code> with the key as <code>Authorization: Bearer a402_…</code>, and the whole
unspent balance, rounded up to the cent, is refunded to the card that bought the key, and the key is disabled.
The same request can be made from the balance page without the key. A balance topped up by more than one
payment is refunded to the cards that paid, newest payment first, never more than a payment has left.
A request made while a call on the key is still running moves nothing; send it again when the call ends. A
key we switched off keeps its unspent balance refundable the same way; while a dispute of the payment that
bought the key is open, the dispute settles what goes back to the card instead. A refund that cannot be sent
at once, or that Stripe reports as failed, stays owed to you, and we send it by hand if a repeated request
still fails. Card refunds take the time your card issuer takes to post them. A disputed purchase or top-up
freezes the key it loaded until the dispute's outcome, decided by the card network and reported by Stripe; a
fraud warning on one freezes the key, and its unspent balance is refunded ${FRAUD_WARNING_REFUND}. A refunded one takes what was refunded off the balance, and disables the key once
every payment on it is refunded in full. We email a receipt for each purchase and top-up, and a notice once each
time a balance drops under ${lowBalanceWords()} unless you turn that notice off.` : `Prepaid credits are consumed as you
call tools and are non-refundable except where required by law, with one exception: an unspent balance
under $10 on a key is refunded to its card on request to the email on the purchase. A refunded or
disputed purchase disables the key that purchase issued. A disputed purchase freezes the key it loaded until
the dispute's outcome, decided by the card network and reported by Stripe. ${FRAUD_WARNING_RULE}`} One buyer may buy at most $${creditsLimitUsd} of
credits in any 24 hours; a purchase past that is refunded in full and issues no key. Credits billed to an
address in the European Union or the United Kingdom are sold to businesses that enter a VAT number at
checkout; a purchase there without one is refunded in full and issues no key. Card prices include
payment processing and are shown before you pay. Prices are the same everywhere and include North Carolina
sales tax where it applies: for a credits key or a card payment billed to a North Carolina address, a
call that returns generated speech, audio or video, or that edits an image or audio file you send, includes
that tax.</p>
<p><b>If the service stops.</b> A prepaid credits balance is a prepayment for services we have not yet
delivered, and it should not depend on us being here forever. If we decide to stop operating the hosted
service, we will give at least 30 days notice on this site and by email to the address on each purchase,
keep the paid routes serving through the notice period so a balance can be spent, and refund any unspent
balance to the card that bought it, or, where that card can no longer be credited, by another method we
agree with you through the email on the purchase. The same applies to an unused monitor period. Nothing here waives a right you have by law,
and it does not apply to a balance disabled for a refund or dispute.</p>
<p><b>Free email alerts.</b> A free alert watches one subject with the same daily check a monitor uses and emails you when something changes, at most once a day. It is free, best-effort and not a monitor: no report is generated, delivery is not guaranteed, and we may pause or discontinue alerts at any time. It starts only after you confirm by email and ends the moment you use the unsubscribe link in any alert.</p>
<p><b>Subscriptions (monitors).</b> A monitor bills monthly in advance, by card through Stripe or over
MPP on Tempo from an authorization you sign, and renews each month until you cancel. Cancel a card subscription any
time in the Stripe Customer Portal, opened by the manage link in your monitor emails; if you no longer have those
emails, enter your checkout email under "Already subscribed?" on <a href="/monitors#manage">/monitors</a> and we email
you a new link. Cancel an MPP subscription with a POST request to the cancel link in your monitor emails (it carries
your manage token), or by revoking the authorization. A canceled subscription stays active until the end of the period
you already paid for and is not renewed; there is no partial refund for the remaining days. A monitor whose subject cannot be read (for example a
domain that does not resolve) keeps its free daily check, emails you once about the problem, and produces
no further paid reports until the subject is readable again; each subscription also has a cap on paid
re-runs per 30 days, above which it alerts without re-running.</p>

${awsOn ? `<h2 id="aws-marketplace">AWS Marketplace purchases</h2>
<p>Tools bought through AWS Marketplace are paid through AWS and billed on your AWS invoice. AWS's standard
contract for AWS Marketplace governs those purchases together with our refund rule for them: an input we refuse
before running the tool does not use the payment, and a call that does not complete can be sent again with the same
payment while it is valid. ${AWS_UNANSWERED_SENTENCE}</p>
` : ""}
<h2>Availability & changes</h2>
<p>The service may change, be rate-limited, or be discontinued at any time. We may update these terms;
the "last updated" date reflects the current version. Continued use after a change means you accept it.</p>

<h2>Indemnification</h2>
<p>You agree to indemnify and hold harmless Cardhavok LLC (doing business as Havok Holdings LLC) and the service's maintainers and
contributors from claims, damages, and reasonable costs (including legal fees) arising from your use of
the service, the inputs you send, the outputs you generate, or your violation of these terms or of
applicable law.</p>

<h2>Disclaimer of warranties</h2>
<p>THE SERVICE, THE TOOLS, AND ALL OUTPUTS (INCLUDING GENERATED CONTENT) ARE PROVIDED "AS IS" AND
"AS AVAILABLE", WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, AND
UNINTERRUPTED OR ERROR-FREE OPERATION. YOU USE THE SERVICE AT YOUR OWN RISK.</p>

<h2>Liability</h2>
<p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, CARDHAVOK LLC (DOING BUSINESS AS HAVOK HOLDINGS LLC), AGENT402, AND THEIR MAINTAINERS AND
CONTRIBUTORS ARE NOT LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR
PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, DATA, GOODWILL, OR DIGITAL ASSETS, ARISING FROM OR
RELATING TO USE OF THE SERVICE, THE TOOLS, GENERATED CONTENT, OR ON-CHAIN PAYMENTS - WHETHER IN
CONTRACT, TORT, OR OTHERWISE, AND EVEN IF ADVISED OF THE POSSIBILITY. TOTAL AGGREGATE LIABILITY FOR
ALL CLAIMS WILL NOT EXCEED THE GREATER OF THE AMOUNT YOU PAID FOR THE CALL AT ISSUE OR ONE U.S.
DOLLAR (US$1). Some jurisdictions do not allow certain limitations; where a limitation is not
permitted, liability is limited to the smallest amount the law allows.</p>

<h2>Governing law &amp; disputes</h2>
<p>These terms are governed by the laws of the <b>State of North Carolina</b> and applicable U.S.
federal law, without regard to conflict-of-laws rules. Before filing any claim, you agree to first
contact <a href="mailto:help@agent402.tools">help@agent402.tools</a> and attempt in good faith to
resolve the dispute informally for 30 days.</p>
<p><b>Arbitration and class-action waiver.</b> Any dispute not resolved informally will be settled by
<b>binding individual arbitration</b> administered by the American Arbitration Association under its
rules, conducted in English. <b>You and we each waive the right to a jury trial and to participate in
a class action, class arbitration, or representative proceeding</b> - disputes may be brought only in
an individual capacity. Either party may instead bring an individual claim in small-claims court, and
either party may seek injunctive relief in court for intellectual-property infringement, unauthorized
access, or abuse of the service. For any matter not subject to arbitration, you consent to the
exclusive jurisdiction and venue of the state and federal courts located in North Carolina. Any claim
must be filed within one year of when it arose, or it is permanently barred.</p>

<h2>General</h2>
<p>These terms are the entire agreement between you and Cardhavok LLC (doing business as Havok Holdings LLC) regarding the hosted
service, superseding any prior understanding. If any provision is found unenforceable, it will be
limited to the minimum extent necessary and the rest remains in effect. Our not enforcing a provision
is not a waiver of it. You may not assign these terms; we may assign them in connection with a merger,
acquisition, or sale of assets. We are not liable for delay or failure caused by events beyond our
reasonable control (including outages of blockchains, facilitators, or upstream model providers).
Sections on generated content, payments, indemnification, warranty disclaimer, liability, and disputes
survive any termination of your use.</p>

<h2>Operator &amp; contact</h2>
<p>Agent402.Tools is operated by <strong>Cardhavok LLC</strong>, doing business as <strong><a href="https://havok.holdings" rel="noopener">Havok Holdings LLC</a></strong>. Contact: <a href="mailto:help@agent402.tools">help@agent402.tools</a>,
<a href="${REPO_URL}" rel="noopener">the source repository on GitHub</a>,
or <a href="https://x.com/Agent402Tools" rel="noopener">@Agent402Tools on X</a>.</p>
</div>
</section>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/terms", extraCss, body: withPublicIndexDate(withCreditsSalesDate(body)) });
}
