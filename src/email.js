// Minimal transactional email sender for the human front door - so a buyer who
// closes the tab still gets their report link. Provider-agnostic, dependency-
// free (plain fetch over each provider's HTTP API). Supports Zoho ZeptoMail
// (recommended - the domain is already on Zoho) and Resend. Gated on the
// provider's key + EMAIL_FROM - a no-op that returns false when unconfigured, so
// nothing breaks before email is set up. NEVER throws into the caller.
import { createJsonDocument } from "./json-document.js";
import { trackStoreReady, stateDbEnabled } from "./state-db.js";
import { upgradeOffer, priceUsd } from "./report-upgrade.js";
import { REPORT_MODEL_NOTE, reportIsModelWritten } from "./report-disclosure.js";
import { headerText, escapeHtml } from "./email-text.js";
import { MAX_FULL_PER_SUB_30D } from "./monitor-scheduler.js";
import { CANCEL_EFFECT } from "./stripe-subscriptions.js";
import { START_NOW_CONFIRMATION } from "./checkout-consent.js";

const RESEND_URL = "https://api.resend.com/emails";
// ZeptoMail region base (api.zeptomail.com default; .eu / .in for those regions).
const ZEPTO_URL = () => (process.env.ZEPTOMAIL_URL || "https://api.zeptomail.com/v1.1/email").trim();

const key = (n) => (process.env[n] || "").trim();

// Send outcomes. Until 2026-10-01 a refused send returned false with nothing
// logged, and every caller treats email as best-effort, so when the provider's
// prepaid credits ran out every report link, credits key, alert confirmation
// and monitor email stopped going out with no trace anywhere (ZeptoMail
// answered 429 TM_5001 / LE_102 "Credit exhausted" for over a week). A refusal
// now logs its status and the provider's error CODE (never an address or a
// body), and the last outcome is kept on the volume so /api/gateway-status can
// page on it across restarts.
const EMAIL_STATUS_FILE = process.env.EMAIL_STATUS_FILE || "/data/email-status.json";
let outcome = null; // { ok, at, status, code, provider, failuresSinceOk, sentTotal, failedTotal }
let outcomeDoc = null;
const outcomeStore = () => (outcomeDoc ||= createJsonDocument({ file: EMAIL_STATUS_FILE, log: () => {} }));
function loadOutcome() {
  if (outcome) return outcome;
  const d = outcomeStore();
  outcome = d.loadSync(null);
  if (d.backend === "pg") trackStoreReady(d.load(null).then((j) => { if (j && typeof j === "object" && outcome && outcome.at === null) Object.assign(outcome, j); }));
  if (!outcome || typeof outcome !== "object") outcome = { ok: null, at: null, status: null, code: null, provider: null, failuresSinceOk: 0, sentTotal: 0, failedTotal: 0 };
  return outcome;
}
// With the state database, start the row read at module load so the boot
// awaits it (trackStoreReady) and the first status read is not "unknown".
if (stateDbEnabled()) loadOutcome();
function persistOutcome() {
  void outcomeStore().save(outcome); // no volume and no database: memory only
}
/** Provider error code from a refusal body, bounded and code-shaped only. */
export function providerErrorCode(bodyText) {
  try {
    const j = JSON.parse(bodyText);
    const c = j?.error?.details?.[0]?.code || j?.error?.code || j?.name || j?.code || null;
    return c && /^[A-Za-z0-9_.-]{1,40}$/.test(String(c)) ? String(c) : null;
  } catch { return null; }
}
export function noteEmailOutcome(ok, { status = null, code = null, provider = null } = {}) {
  const o = loadOutcome();
  const at = new Date().toISOString();
  o.ok = !!ok; o.at = at; o.status = status; o.code = ok ? null : code; o.provider = provider;
  if (ok) { o.failuresSinceOk = 0; o.sentTotal++; } else { o.failuresSinceOk++; o.failedTotal++; }
  const d = outcomeStore();
  if (d.backend === "pg") {
    // Two containers send at once during a deploy: each outcome is applied
    // to the row as it is (totals add, the newest outcome is the last one),
    // never a whole-body put of one container's counts over the other's.
    void d.update((b) => {
      const r = b && typeof b === "object" ? { ...b } : { ok: null, at: null, status: null, code: null, provider: null, failuresSinceOk: 0, sentTotal: 0, failedTotal: 0 };
      if (!r.at || at >= r.at) { r.ok = !!ok; r.at = at; r.status = status; r.code = ok ? null : code; r.provider = provider; }
      if (ok) { r.failuresSinceOk = 0; r.sentTotal = (Number(r.sentTotal) || 0) + 1; } else { r.failuresSinceOk = (Number(r.failuresSinceOk) || 0) + 1; r.failedTotal = (Number(r.failedTotal) || 0) + 1; }
      return r;
    }, { fallback: null }).then((r) => { if (r.ok && r.body && typeof r.body === "object") Object.assign(outcome, r.body); });
  } else persistOutcome();
  if (!ok) console.warn(`[email] send refused by ${provider || "provider"}: HTTP ${status ?? "error"}${code ? ` ${code}` : ""} (${o.failuresSinceOk} in a row since the last delivered send)`);
}
/** One word publicly; counts and the last code for the operator. */
export function emailSendStatus({ full = false } = {}) {
  if (!emailEnabled()) return { status: "unconfigured" };
  const o = loadOutcome();
  const status = o.ok === null ? "unknown" : (o.ok ? "ok" : (o.code === "LE_102" || /credit|quota|limit/i.test(String(o.code || "")) || o.status === 429 ? "exhausted" : "failing"));
  return full ? { status, lastAt: o.at, lastStatus: o.status, lastCode: o.code, provider: o.provider, failuresSinceOk: o.failuresSinceOk, sentTotal: o.sentTotal, failedTotal: o.failedTotal } : { status };
}

export function emailEnabled() {
  return Boolean(key("EMAIL_FROM") && (key("ZEPTOMAIL_TOKEN") || key("RESEND_API_KEY")));
}

/** Send one email via whichever provider is configured. 2xx -> true; never throws. */
// Every outbound message ends with the sender's postal address, appended in
// sendEmail rather than in each template so a new sender cannot leave it out.
// COMPANY_POSTAL_ADDRESS holds the address of the entity that sends the mail.
// Unset, mail still goes out (a missing variable must not black out a paying
// subscriber's monitor report) and each send logs a warning.
let postalWarnAt = 0;
/** The sender's postal address as one line ("a, b, c"), or null when unset.
 *  /company prints this same value, so the page and the mail footer agree. */
export function companyPostalLine() {
  const a = (process.env.COMPANY_POSTAL_ADDRESS || "").trim();
  return a ? a.replace(/\s*\n\s*/g, ", ") : null;
}
export function postalAddress() {
  const a = (process.env.COMPANY_POSTAL_ADDRESS || "").trim();
  if (a) return a;
  const now = Date.now();
  if (now - postalWarnAt > 600_000) {
    postalWarnAt = now;
    console.warn("[email] COMPANY_POSTAL_ADDRESS is unset - outbound mail carries no postal address. Set it on the host.");
  }
  return null;
}

function withPostalFooter(html, text) {
  const addr = postalAddress();
  if (!addr) return { html, text };
  const esc = String(addr).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const line = esc.replace(/\s*\n\s*/g, ", ");
  return {
    html: typeof html === "string"
      ? `${html}\n<p style="margin:18px 0 0;font-size:12px;color:#626970;">${line}</p>`
      : html,
    text: typeof text === "string" ? `${text}\n\n${String(addr).replace(/\s*\n\s*/g, ", ")}` : text,
  };
}

// Caller headers as a plain {name: value} object of strings, or null when
// there are none. Names are header tokens; values lose control characters.
function mimeHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || v == null) continue;
    out[k] = String(v).replace(/[\r\n\x00-\x1f\x7f]/g, " ");
  }
  return Object.keys(out).length ? out : null;
}

// One provider attempt: true on 2xx. Records the outcome either way.
async function sendVia(provider, { from, to, subject, html, text, headers }) {
  try {
    let res;
    if (provider === "zeptomail") {
      // ZeptoMail: token is the FULL "Zoho-enczapikey <token>" value or just the
      // token; accept both. from must be a verified ZeptoMail sender address.
      const tok = key("ZEPTOMAIL_TOKEN");
      const auth = /^Zoho-enczapikey/i.test(tok) ? tok : `Zoho-enczapikey ${tok}`;
      const mh = mimeHeaders(headers);
      res = await fetch(ZEPTO_URL(), {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          from: { address: from, name: key("EMAIL_FROM_NAME") || "Agent402" },
          to: [{ email_address: { address: to } }],
          subject, htmlbody: html, textbody: text,
          // Custom headers (List-Unsubscribe and List-Unsubscribe-Post) ride in
          // ZeptoMail's mime_headers object, string keys to string values.
          ...(mh ? { mime_headers: mh } : {}),
        }),
        signal: AbortSignal.timeout(12_000),
      });
    } else {
      res = await fetch(RESEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key("RESEND_API_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, html, text, ...(headers && typeof headers === "object" ? { headers } : {}) }),
        signal: AbortSignal.timeout(12_000),
      });
    }
    const code = res.ok ? null : providerErrorCode(await res.text().catch(() => ""));
    noteEmailOutcome(res.ok, { status: res.status, code, provider });
    return res.ok;
  } catch (e) {
    noteEmailOutcome(false, { status: null, code: e?.name === "TimeoutError" ? "timeout" : "network", provider });
    return false;
  }
}

/** Send one email. With both providers configured, ZeptoMail goes first and a
 *  refused send is retried once on Resend (2026-10-01: ZeptoMail's prepaid
 *  credits ran out and its account review blocked buying more, which stopped
 *  every email; a second provider keeps mail flowing through either outage).
 *  2xx -> true; never throws. */
export async function sendEmail({ to, subject, html, text, headers = null }) {
  if (!emailEnabled() || !to) return false;
  ({ html, text } = withPostalFooter(html, text));
  const msg = { from: key("EMAIL_FROM"), to, subject, html, text, headers };
  const providers = [...(key("ZEPTOMAIL_TOKEN") ? ["zeptomail"] : []), ...(key("RESEND_API_KEY") ? ["resend"] : [])];
  for (const p of providers) if (await sendVia(p, msg)) return true;
  return false;
}

/** "Here's your report" email with the durable link. Best-effort. */
// Header material: no control characters and a hard length (email-text.js).
const hdr = headerText;
// Origin of a delivered-report URL, so the upgrade link is absolute even when
// the caller did not pass a base URL. Never throws on junk.
function originOf(url) {
  try { return new URL(String(url)).origin; } catch { return ""; }
}
// The model-written note under the open-report link, for a kind a model writes.
function modelNoteParts(kind) {
  if (!reportIsModelWritten(kind)) return { html: "", text: "" };
  return { html: `<p style="color:#626970;font-size:12px;margin:0 0 16px">${escapeHtml(REPORT_MODEL_NOTE)}</p>`, text: `${REPORT_MODEL_NOTE}\n` };
}

export function buildReportReadyEmail({ reportUrl, productLabel, subjectOf, kind = null, baseUrl = "", receipt = null, startNow = false }) {
  const subj = `Your ${hdr(productLabel || "report", 60)} is ready`;
  const on = subjectOf ? ` on “${hdr(subjectOf)}”` : "";
  // Retention loop: if a monitor watches this kind of thing, offer it with the
  // target prefilled. The link only PREFILLS the storefront (a GET that fills a
  // form), so an email client following it can never start a checkout. Label
  // and price come from the monitor product table, never from copy here.
  const up = upgradeOffer(kind, subjectOf, baseUrl || originOf(reportUrl));
  const note = modelNoteParts(kind);
  const rcpt = receiptParts(receipt, baseUrl || originOf(reportUrl));
  // The durable-medium confirmation of the start-now choice made at checkout.
  const sn = startNow === true ? { html: `<p style="color:#626970;font-size:12px">${escapeHtml(START_NOW_CONFIRMATION)}</p>`, text: `\n${START_NOW_CONFIRMATION}\n` } : { html: "", text: "" };
  const upHtml = up
    ? `<p style="color:#3A3F45;border-top:1px solid #D9DDE1;padding-top:16px;margin-top:26px">Want this kept current? Our ${escapeHtml(up.label)} re-checks ${escapeHtml(hdr(up.target || "it"))} on a schedule and emails you up to ${MAX_FULL_PER_SUB_30D} fresh reports in any 30 days, ${escapeHtml(up.priceUsd)} a month, cancel any time. <a href="${escapeAttr(up.url)}" style="color:#0F5E43;font-weight:600">Start monitoring →</a></p>`
    : "";
  const upText = up
    ? `\nWant this kept current? Our ${up.label} re-checks ${hdr(up.target || "it")} on a schedule and emails you up to ${MAX_FULL_PER_SUB_30D} fresh reports in any 30 days, ${up.priceUsd} a month, cancel any time:\n${up.url}\n`
    : "";
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#111315">
    <h2 style="font-weight:500;color:#111315">Your ${escapeHtml(productLabel || "report")} is ready</h2>
    <p style="color:#3A3F45">Your report${escapeHtml(on)} is finished and waiting for you. It's yours to keep: open it any time with the link below.</p>
    <p style="margin:26px 0"><a href="${escapeAttr(reportUrl)}" style="background:#0F5E43;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;display:inline-block">Open your report →</a></p>
    <p style="color:#626970;font-size:13px">Or paste this link into your browser:<br>${escapeHtml(reportUrl)}</p>
    ${note.html}
    ${sn.html}
    ${upHtml}
    ${rcpt.html}
    <p style="color:#626970;font-size:12px;margin-top:28px">Agent402 · cited reports · pay per report</p>
  </div>`;
  const text = `Your ${productLabel || "report"}${on} is ready.\n\nOpen it here (yours to keep): ${reportUrl}\n${note.text ? `\n${note.text}` : ""}${sn.text}${upText}${rcpt.text}\nAgent402`;
  return { subject: subj, html, text };
}

/** The signed purchase receipt's lines in the report-ready email: the
 *  compact JWS and where to check it. Empty when none was signed. */
function receiptParts(receipt, origin) {
  if (typeof receipt !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(receipt)) return { html: "", text: "" };
  const verify = `${origin || ""}/api/receipts/verify`;
  return {
    html: `<p style="color:#626970;font-size:12px;border-top:1px solid #D9DDE1;padding-top:16px;margin-top:26px">Signed receipt for this purchase (check it with a POST to ${escapeHtml(verify)}, sending { "receipt", "body": the report text }):<br><code style="word-break:break-all;font-size:11px">${escapeHtml(receipt)}</code></p>`,
    text: `\nSigned receipt for this purchase (check it with a POST to ${verify}, sending { "receipt", "body": the report text }):\n${receipt}\n`,
  };
}

/** The latest paid period's signed receipt in a monitor email: the compact
 *  JWS, the period statement its answer digest covers, and where to check
 *  both. Empty when none was signed (signing off, or a period that paid
 *  nothing). */
export function periodReceiptParts(signedReceipt, origin) {
  const r = signedReceipt && typeof signedReceipt === "object" ? signedReceipt : null;
  if (!r || typeof r.receipt !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(r.receipt) || typeof r.statement !== "string") return { html: "", text: "" };
  const verify = `${origin || ""}/api/receipts/verify`;
  const lead = `Signed receipt for your latest subscription payment (check it with a POST to ${verify}, sending { "receipt", "body": the period statement below })`;
  return {
    html: `<p style="color:#626970;font-size:12px;border-top:1px solid #D9DDE1;padding-top:16px;margin-top:22px">${escapeHtml(lead)}:<br><code style="word-break:break-all;font-size:11px">${escapeHtml(r.receipt)}</code><br>Period statement:<br><code style="word-break:break-all;font-size:11px">${escapeHtml(r.statement)}</code></p>`,
    text: `\n${lead}:\n${r.receipt}\nPeriod statement:\n${r.statement}\n`,
  };
}

export async function sendReportReadyEmail({ to, ...rest }) {
  const { subject, html, text } = buildReportReadyEmail(rest);
  return sendEmail({ to, subject, html, text });
}

/** The price sentence of a monitor subscription, from the product's price and,
 *  when a promotion code changed the first period, the first-period and
 *  renewal amounts Stripe reported at checkout. "" when no price is known. */
export function subscriptionPriceText({ priceCents = null, firstPeriodCents = null, renewalCents = null } = {}) {
  const list = Number(priceCents);
  const first = Number(firstPeriodCents);
  const renew = Number(renewalCents);
  const hasList = Number.isFinite(list) && list > 0;
  const hasRenew = renewalCents != null && Number.isFinite(renew) && renew >= 0;
  if (firstPeriodCents != null && Number.isFinite(first) && first >= 0 && (!hasList || first !== list || (hasRenew && renew !== first))) {
    const then = hasRenew ? `${priceUsd(renew)} a month` : "the monthly amount shown in your billing portal";
    return `${first === 0 ? "Free" : priceUsd(first)} for the first month with your promotion code, then ${then}, billed in advance.`;
  }
  if (hasRenew && hasList && renew !== list) return `${priceUsd(renew)} a month, billed in advance.`;
  return hasList ? `${priceUsd(list)} a month, billed in advance.` : "";
}

/** Monitor delivery / alert email. reason: welcome | scheduled | change | tls-expiring | filing | recall | digest | safety-change | trial-ending. Best-effort.
 *  trial-ending: a first month a promotion code made free ends on `renewsOn`
 *  (YYYY-MM-DD), and the first full charge follows unless the subscriber cancels.
 *  `kind` is the monitored report's kind; without it a "digest" (the IPO
 *  watch's only reason) reads as the code-written IPO digest. */
export function buildMonitorEmail({ reason, label, target, changes = [], reportUrl, manageUrl, kind = null, priceCents = null, firstPeriodCents = null, renewalCents = null, rail = "card", cancelUrl = null, withTerms = false, signedReceipt = null, renewsOn = null, startNow = false }) {
  // A wallet (MPP) subscriber has no Stripe portal: its link is a status
  // endpoint, and it cancels with a POST to its cancel endpoint or by revoking
  // the authorization it signed. A card subscriber cancels in the portal the
  // manage link opens (or, before any report, from the page that emails one).
  const mpp = rail === "mpp";
  const keyedManage = /[?&]k=/.test(String(manageUrl || ""));
  const cancelHow = mpp
    ? (cancelUrl
      ? `Cancel anytime by sending a POST request to ${cancelUrl} (the link carries your manage token), or by revoking the authorization you signed for this subscription.`
      : "Cancel anytime by revoking the authorization you signed for this subscription.")
    : keyedManage
      ? "Cancel anytime online through the manage or cancel link below."
      : "Cancel anytime online: open the manage or cancel link below, enter your checkout email, and we email you a link to cancel.";
  const t = hdr(target);
  const lbl = hdr(label || "monitor", 60);
  const subjects = {
    welcome: `Your ${lbl} is live: first report for ${t}`,
    scheduled: `${lbl}: fresh report for ${t}`,
    change: `Change detected on ${t}`,
    "tls-expiring": `Certificate for ${t} is expiring`,
    filing: `New 13F filing: ${t}`,
    problem: `We could not complete your ${lbl} for ${t}`,
    recall: `New FDA recall activity: ${t}`,
    "safety-change": `Token risk changed: ${t}`,
    "filing-new": `New SEC filing: ${t}`,
    digest: `${lbl}: this week's filings${t && t !== "all" ? ` for ${t}` : ""}`,
    "trial-ending": `Your free month of the ${lbl} for ${t} ends soon`,
  };
  const leads = {
    welcome: `Your monitor for ${t} is active. Here is your first report, and we will email you again whenever something changes.`,
    scheduled: `Your scheduled re-run for ${t} is done. Nothing further is needed from you.`,
    change: `Our latest check of ${t} found changes since the last report:`,
    "tls-expiring": `Heads up: the TLS certificate for ${t} is close to expiry.`,
    filing: `${t} has a new SEC 13F filing. Your fresh holdings + changes report is ready.`,
    problem: mpp
      ? `We could not produce a report for ${t}. We will keep trying, first within the hour and then daily; if the target is wrong, you can cancel (see below) and subscribe again with a corrected one.`
      : `We could not produce a report for ${t}. We will keep trying, first within the hour and then daily; if the target is wrong, you can cancel or re-subscribe with a corrected one from the manage link below.`,
    recall: `The FDA recall feeds show new activity for ${t} since your last report:`,
    "safety-change": `The on-chain safety picture for this token changed since your last brief:`,
    "filing-new": `${t} has filed with the SEC since your last report. Here is what landed, with the new document read and explained:`,
    digest: `Your weekly IPO pipeline digest is ready${t && t !== "all" ? ` (filers matching "${t}")` : ""}.`,
    "trial-ending": (() => {
      const full = Number.isFinite(Number(renewalCents)) && Number(renewalCents) > 0 ? Number(renewalCents) : Number(priceCents);
      const amount = Number.isFinite(full) && full > 0 ? `$${(full / 100).toFixed(2)} a month` : "the monthly price";
      return `The free first month of your monitor for ${t} ends${renewsOn ? ` on ${renewsOn}` : " soon"}. Unless you cancel before then, your card is charged ${amount} plus applicable tax, and again each month until you cancel.`;
    })(),
  };
  const subj = subjects[reason] || `${lbl}: update for ${t}`;
  // A "problem" mail reports a run that produced nothing, so it carries no note.
  const note = reason === "problem" || reason === "trial-ending" ? { html: "", text: "" } : modelNoteParts(kind || (reason === "digest" ? "ipo" : null));
  const lead = leads[reason] || `Your ${lbl} has an update for ${t}.`;
  // A readable "why you got this": recurring mail must say who asked for it
  // and how to stop it, in words, next to the manage link (which stays the
  // keyed one the caller passed - never widened here).
  const why = `You are getting this because you subscribed to the ${lbl} for ${t} on agent402.tools. It runs on its own until you cancel.`;
  const whyHtml = `<p style="color:#626970;font-size:12px;margin-top:26px">${escapeHtml(why)}</p>`;
  const whyText = `${why}\n`;
  // The welcome mail is the subscriber's record of the purchase, so it states
  // the renewal terms in full: price and period (when the caller passes the
  // product's price), renewal until canceled, the online cancel path and what
  // canceling does, as the terms say them. Later mails do not repeat them.
  // A first run that failed sends a problem mail instead (withTerms), which
  // then carries the same terms.
  const priceText = subscriptionPriceText({ priceCents, firstPeriodCents, renewalCents });
  const pricePart = priceText ? `${priceText} ` : "";
  const termsUrl = `${originOf(reportUrl)}/terms`;
  const renewal = (reason === "welcome" || reason === "trial-ending" || (reason === "problem" && withTerms))
    ? `Your subscription: ${pricePart}It renews each month until you cancel. ${cancelHow} ${CANCEL_EFFECT}${reason === "welcome" && startNow === true ? ` ${START_NOW_CONFIRMATION}` : ""}`
    : "";
  const renewalHtml = renewal ? `<p style="color:#3A3F45;font-size:13px;border-top:1px solid #D9DDE1;padding-top:14px;margin-top:22px">${escapeHtml(renewal)} <a href="${escapeAttr(termsUrl)}" style="color:#3A3F45">Terms</a></p>` : "";
  const renewalText = renewal ? `${renewal}\nTerms: ${termsUrl}\n\n` : "";
  const rcpt = periodReceiptParts(signedReceipt, originOf(reportUrl));
  const list = (changes || []).slice(0, 12);
  const changesHtml = list.length ? `<ul style="color:#3A3F45;padding-left:18px">${list.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>` : "";
  const changesText = list.length ? `\n${list.map((c) => `- ${c}`).join("\n")}\n` : "";
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#111315">
    <h2 style="font-weight:500;color:#111315">${escapeHtml(subj)}</h2>
    <p style="color:#3A3F45">${escapeHtml(lead)}</p>${changesHtml}
    <p style="margin:26px 0"><a href="${escapeAttr(reportUrl)}" style="background:#0F5E43;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;display:inline-block">Open the report →</a></p>
    <p style="color:#626970;font-size:13px">Or paste this link into your browser:<br>${escapeHtml(reportUrl)}</p>
    ${note.html}
    ${renewalHtml}
    ${rcpt.html}
    ${whyHtml}
    <p style="color:#626970;font-size:12px;margin-top:12px">Agent402 · ${escapeHtml(lbl)} · ${mpp
      ? `<a href="${escapeAttr(manageUrl || reportUrl)}" style="color:#626970">subscription status</a>${cancelUrl ? ` · cancel: send a POST request to ${escapeHtml(cancelUrl)}` : " · cancel by revoking your authorization"}`
      : `<a href="${escapeAttr(manageUrl || reportUrl)}" style="color:#626970">manage or cancel</a>`}</p>
  </div>`;
  const stopText = mpp
    ? `Subscription status: ${manageUrl || reportUrl}\n${cancelUrl ? `Cancel (send a POST request): ${cancelUrl}` : "Cancel: revoke the authorization you signed for this subscription."}`
    : `Manage or cancel (change your card, or stop the emails): ${manageUrl || reportUrl}`;
  const text = `${subj}\n\n${lead}\n${changesText}\nOpen the report: ${reportUrl}\n\n${note.text ? `${note.text}\n` : ""}${renewalText}${rcpt.text}${whyText}\n${stopText}\n\nAgent402`;
  return { subject: subj, html, text };
}

export async function sendMonitorEmail({ to, ...rest }) {
  const { subject, html, text } = buildMonitorEmail(rest);
  return sendEmail({ to, subject, html, text });
}

function escapeAttr(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
