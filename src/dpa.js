// /dpa - the Data Processing Addendum, offered to business customers on
// request: where a customer sends personal data in tool inputs, prompts,
// uploaded audio, memory documents or job results, we process it on the
// customer's behalf. It binds once a customer asks for it and we confirm it by
// email; it is not incorporated into the terms for every caller, since a
// wallet-only caller gives us no contact to keep its promises to.
// The sub-processor table is the /trust table (src/trust-page.js
// trustSubprocessors), so the two pages cannot list different processors;
// the mailbox that receives requests is added here. Outside sellers the
// router buys from and the data sources a lookup reads are recipients the
// caller's own call names, listed apart from the sub-processors. The change
// notice and the retention figures are constants below, read by the page and
// pinned by scripts/test-dpa-page.js.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { trustSubprocessors } from "./trust-page.js";
import { backupKeepDays } from "./backup.js";
import { IDEM_TTL_MS } from "./idempotency-store.js";
import { COMPANY_MAILBOXES } from "./company.js";
import { LEGAL_ENTITY_NAME, TRADE_NAME } from "./legal-entity.js";
import { companyPostalLine } from "./email.js";

export const DPA_DATE = "2026-11-25";
export const DPA_SUBPROCESSOR_NOTICE_DAYS = 30;
export const DPA_MAILBOX_ROW = Object.freeze({ category: "Mailbox", name: "Zoho Mail", gets: "Messages you send us, including data and rights requests" });

export function dpaPage(baseUrl) {
  const canonical = `${baseUrl}/dpa`;
  const title = "Data Processing Addendum - Agent402";
  const description = "Agent402's Data Processing Addendum, available to business customers on request: our role, the processing, the EU Standard Contractual Clauses and UK Addendum, sub-processors, other recipients, security measures and breach notice.";
  const mail = COMPANY_MAILBOXES.operator;
  const postal = companyPostalLine();
  const subs = [...trustSubprocessors(), DPA_MAILBOX_ROW];
  const cacheMin = Math.round(IDEM_TTL_MS / 60000);
  const extraCss = `
.dp-wrap{max-width:760px;margin:0 auto;padding:56px 30px}
.dp-eyebrow{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:18px}
.dp-h1{font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.96;margin:0 0 14px}
.dp-updated{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--faint);margin:0 0 32px}
.dp-body p,.dp-body li{font-size:var(--fs-prose);line-height:1.6;color:var(--muted)}
.dp-body p{margin:0 0 14px}
.dp-body ol,.dp-body ul{margin:0 0 18px;padding:0 0 0 22px}
.dp-body li{margin-bottom:8px}
.dp-body h2{font-family:var(--font-body);font-weight:700;font-size:var(--fs-3xl);line-height:1;letter-spacing:-.02em;margin:36px 0 14px;color:var(--ink)}
.dp-body a{color:var(--accent);text-decoration:none}
.dp-body a:hover{text-decoration:underline}
.dp-body b,.dp-body strong{color:var(--ink);font-weight:600}
.dp-body code{font-family:var(--font-mono);font-size:var(--fs-sm);background:var(--panel);color:var(--on-panel);padding:2px 7px;border:1px solid var(--hairline)}
.dp-table{width:100%;border-collapse:collapse;font-size:var(--fs-sm)}
.dp-table th,.dp-table td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--hairline);color:var(--muted)}
.dp-table th{color:var(--ink);font-weight:600}
@media(max-width:600px){.dp-h1{font-size:var(--fs-3xl) !important}}
`;
  const body = `
<div class="dp-wrap">
<section>
<div class="dp-eyebrow">$ GET /dpa</div>
<h1 class="dp-h1">Data Processing Addendum</h1>
<p class="dp-updated">Agent402 (agent402.tools) - last updated ${DPA_DATE}.</p>
</section>
<section>
<div class="dp-body">
<p>This addendum is <b>available on request</b> to business customers that use Agent402 to process personal
data. Ask for it at <a href="mailto:${esc(mail)}">${esc(mail)}</a>${postal ? ` or by mail to ${esc(postal)}` : ""},
naming the business and the contact we should write to. It applies to that customer from the day we confirm it
by email, and from then on it is part of the <a href="/terms">terms</a> between us; until then it is not. Where it
and the terms differ on personal data, this addendum governs; where it and the Standard Contractual Clauses
differ, the Clauses govern.</p>

<h2>1. Parties and roles</h2>
<p>"We" are <strong>${esc(LEGAL_ENTITY_NAME)}</strong>, doing business as <strong>${esc(TRADE_NAME)}</strong>, the operator of
Agent402 (see <a href="/company">/company</a>). "You" are the business customer. For personal data in what you
send to a tool or model through the service (tool inputs, prompts, uploaded audio and files, memory
documents, job and task results), you are the controller (or a processor for your own customer) and we are
your processor (or sub-processor). For the data we collect to run, bill and protect the service (payment
records, logs, rate limits, analytics), we are an independent controller, as the
<a href="/privacy">privacy policy</a> describes.</p>

<h2>2. The processing</h2>
<ul>
  <li><b>Subject matter and purpose:</b> computing the answer to each call you make, and keeping it only where
  the tool's purpose is storage (memory) or you asked for a later fetch (async jobs and tasks).</li>
  <li><b>Data subjects and categories:</b> whatever people and data you choose to send; the service asks for
  none. Do not send special category data unless the tool needs it and you have a lawful basis.</li>
  <li><b>Duration:</b> in memory for the call, then deleted, except: short caches of identical calls (up to
  ${cacheMin} minutes), memory data until you delete it or its time to live ends, and job and task results
  for the periods the privacy policy states. Nightly backups are deleted after ${backupKeepDays()} days.</li>
  <li><b>Instructions:</b> your calls and this addendum are your complete instructions. We process your data
  for no other purpose, never sell it, and never use it to train a model.</li>
</ul>

<h2>3. Our commitments</h2>
<ol>
  <li>People with access to your data are bound to confidentiality.</li>
  <li>We apply the security measures in section 6.</li>
  <li>We help you answer requests from data subjects (access, erasure, portability) for data we hold for you,
  and with impact assessments and consultations, as far as the service's records allow.</li>
  <li>We notify a personal data breach affecting your data without undue delay after becoming aware of it, to
  the customers we can identify and reach: by email to the contact you gave when you asked for this addendum,
  with what we know then and updates as we learn more. Where we cannot identify who was affected, we post the
  notice on <a href="/status">/status</a>.</li>
  <li>When you stop using the service, the data we hold for you is deleted on the schedules above; ask and we
  delete what remains sooner, except what the law requires us to keep.</li>
  <li>We make available what you need to verify these commitments: the server is open source, and we answer
  reasonable written questions. An audit beyond that is at your cost, on 30 days' notice, once a year.</li>
</ol>

<h2>4. Sub-processors</h2>
<p>You authorize the sub-processors below. Each processes your data under the data processing terms it offers
its customers, which we accept as written; we choose providers whose terms commit them to confidentiality,
security and processing only on our instructions, as Article 28(3) of the GDPR requires, and we remain
responsible to you for them. We announce a new or replaced sub-processor on the
<a href="/changelog">changelog</a> at least ${DPA_SUBPROCESSOR_NOTICE_DAYS} days before it receives your data; you may
object in that time, and if we cannot meet the objection you may stop using the service for the affected
processing.</p>
<div style="overflow-x:auto;margin:0 0 14px;"><table class="dp-table">
<thead><tr><th scope="col">Purpose</th><th scope="col">Sub-processor</th><th scope="col">What it receives</th></tr></thead>
<tbody>${subs.map((s) => `<tr><td>${esc(s.category)}</td><td>${esc(s.name)}</td><td>${esc(s.gets)}</td></tr>`).join("")}</tbody>
</table></div>

<h2>5. Recipients that are not our sub-processors</h2>
<p>Some calls exist to send a value you give to a third party that the call itself names. Those parties act on
their own terms, not as our sub-processors, and this addendum does not cover what they do with it; do not send
personal data to them under this addendum.</p>
<ul>
  <li><b>Outside sellers.</b> A route-and-execute or <code>/api/decide/execute</code> run buys the answer from an
  outside seller and sends that seller your inputs, sometimes to more than one seller and sometimes more than
  once (a retry or a fallback), as the <a href="/privacy">privacy policy</a> describes.</li>
  <li><b>Data sources.</b> A lookup sends the value it looks up to the source that answers it: a wallet address
  or transaction to a blockchain node provider, an IP address to an IP-to-network or reputation service, a
  domain or name to DNS resolvers, registration (RDAP) and naming services and certificate logs, and a query to
  the public data service the tool's page names.</li>
</ul>

<h2>6. International transfers</h2>
<p>The service runs in the United States. For personal data you transfer to us from the European Economic Area,
the <b>Standard Contractual Clauses</b> adopted by the European Commission in Implementing Decision (EU)
2021/914 are incorporated by reference: <b>Module Two</b> (controller to processor) where you are a controller,
and <b>Module Three</b> (processor to processor) where you are a processor. In them: clause 7 (docking) applies;
clause 9 option 2 (general authorization, with the notice in section 4); the optional wording in clause 11 does
not apply; clause 13, the competent supervisory authority is the one clause 13(a) names where you are
established in the European Union, and otherwise the one clause 13 names for your case; clause 17 option 1, the
law of Ireland; clause 18, the courts of Ireland. Annex I is sections 1 and 2 of this addendum, Annex II is
section 7, and Annex III is the table in section 4. For transfers from the United
Kingdom, the <b>International Data Transfer Addendum</b> to those Clauses issued by the UK Information
Commissioner (version B1.0) is incorporated, with its tables completed from this addendum, and either party
may end it as its section 19 allows. For transfers from Switzerland, the same Clauses apply with the Federal Act
on Data Protection in place of the GDPR and the Swiss Federal Data Protection and Information Commissioner as
the competent authority.</p>

<h2>7. Security measures</h2>
<ul>
  <li>Every connection is encrypted in transit (TLS, HSTS on every answer).</li>
  <li>The stores require credentials held only by the service; nightly backups are encrypted before upload and
  deleted after ${backupKeepDays()} days.</li>
  <li>Operator access needs a token; a browser session ends after 30 minutes without use and 8 hours at most.</li>
  <li>Payments carry no card data to us; card details stay on the card processor's hosted page.</li>
  <li>Tool inputs are not written to logs (the one exception, the text of an <code>onchain-sql</code> query the
  data service could not answer, is named in the privacy policy); prompts are sent to model providers configured not to keep or train on them
  where the provider offers it (see the <a href="/privacy">privacy policy</a>).</li>
  <li>Changes ship through review and an automated test suite; dependencies and code are scanned; security
  reports are handled under the <a href="/security">security policy</a>.</li>
</ul>

<h2>8. Contact</h2>
<p>Data protection questions, objections and breach contacts: <a href="mailto:${esc(mail)}">${esc(mail)}</a>.</p>
</div>
</section>
</div>
${ledgerFooterCompact()}`;
  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/dpa", extraCss, body });
}
