// Minimal transactional email sender for the human front door - so a buyer who
// closes the tab still gets their report link. Provider-agnostic, dependency-
// free (plain fetch over each provider's HTTP API). Supports Zoho ZeptoMail
// (recommended - the domain is already on Zoho) and Resend. Gated on the
// provider's key + EMAIL_FROM - a no-op that returns false when unconfigured, so
// nothing breaks before email is set up. NEVER throws into the caller.
import { upgradeOffer } from "./report-upgrade.js";

const RESEND_URL = "https://api.resend.com/emails";
// ZeptoMail region base (api.zeptomail.com default; .eu / .in for those regions).
const ZEPTO_URL = () => (process.env.ZEPTOMAIL_URL || "https://api.zeptomail.com/v1.1/email").trim();

const key = (n) => (process.env[n] || "").trim();

export function emailEnabled() {
  return Boolean(key("EMAIL_FROM") && (key("ZEPTOMAIL_TOKEN") || key("RESEND_API_KEY")));
}

/** Send one email via whichever provider is configured. 2xx -> true; never throws. */
export async function sendEmail({ to, subject, html, text, headers = null }) {
  if (!emailEnabled() || !to) return false;
  const from = key("EMAIL_FROM");
  try {
    if (key("ZEPTOMAIL_TOKEN")) {
      // ZeptoMail: token is the FULL "Zoho-enczapikey <token>" value or just the
      // token; accept both. from must be a verified ZeptoMail sender address.
      const tok = key("ZEPTOMAIL_TOKEN");
      const auth = /^Zoho-enczapikey/i.test(tok) ? tok : `Zoho-enczapikey ${tok}`;
      const res = await fetch(ZEPTO_URL(), {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          from: { address: from, name: key("EMAIL_FROM_NAME") || "Agent402" },
          to: [{ email_address: { address: to } }],
          subject, htmlbody: html, textbody: text,
        }),
        signal: AbortSignal.timeout(12_000),
      });
      return res.ok;
    }
    // Resend
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text, ...(headers && typeof headers === "object" ? { headers } : {}) }),
      signal: AbortSignal.timeout(12_000),
    });
    return res.ok;
  } catch { return false; }
}

/** "Here's your report" email with the durable link. Best-effort. */
// Header material: no control characters (header injection) and a hard length.
const hdr = (s, n = 100) => String(s ?? "").replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, n);
// Origin of a delivered-report URL, so the upgrade link is absolute even when
// the caller did not pass a base URL. Never throws on junk.
function originOf(url) {
  try { return new URL(String(url)).origin; } catch { return ""; }
}

export function buildReportReadyEmail({ reportUrl, productLabel, subjectOf, kind = null, baseUrl = "" }) {
  const subj = `Your ${hdr(productLabel || "report", 60)} is ready`;
  const on = subjectOf ? ` on “${hdr(subjectOf)}”` : "";
  // Retention loop: if a monitor watches this kind of thing, offer it with the
  // target prefilled. The link only PREFILLS the storefront (a GET that fills a
  // form), so an email client following it can never start a checkout. Label
  // and price come from the monitor product table, never from copy here.
  const up = upgradeOffer(kind, subjectOf, baseUrl || originOf(reportUrl));
  const upHtml = up
    ? `<p style="color:#35443c;border-top:1px solid #e3e7e4;padding-top:16px;margin-top:26px">Want this kept current? Our ${escapeHtml(up.label)} re-checks ${escapeHtml(hdr(up.target || "it"))} on a schedule and emails you a fresh report the moment it changes, ${escapeHtml(up.priceUsd)} a month, cancel any time. <a href="${escapeAttr(up.url)}" style="color:#15654a;font-weight:600">Start monitoring →</a></p>`
    : "";
  const upText = up
    ? `\nWant this kept current? Our ${up.label} re-checks ${hdr(up.target || "it")} on a schedule and emails you a fresh report when it changes, ${up.priceUsd} a month, cancel any time:\n${up.url}\n`
    : "";
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#14201b">
    <h2 style="font-weight:500;color:#14201b">Your ${escapeHtml(productLabel || "report")} is ready</h2>
    <p style="color:#35443c">Your report${escapeHtml(on)} is finished and waiting for you. It's yours to keep: open it any time with the link below.</p>
    <p style="margin:26px 0"><a href="${escapeAttr(reportUrl)}" style="background:#15654a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Open your report →</a></p>
    <p style="color:#8a948c;font-size:13px">Or paste this link into your browser:<br>${escapeHtml(reportUrl)}</p>
    ${upHtml}
    <p style="color:#8a948c;font-size:12px;margin-top:28px">Agent402 · cited reports · pay per report</p>
  </div>`;
  const text = `Your ${productLabel || "report"}${on} is ready.\n\nOpen it here (yours to keep): ${reportUrl}\n${upText}\nAgent402`;
  return { subject: subj, html, text };
}

export async function sendReportReadyEmail({ to, ...rest }) {
  const { subject, html, text } = buildReportReadyEmail(rest);
  return sendEmail({ to, subject, html, text });
}

/** Monitor delivery / alert email. reason: welcome | scheduled | change | tls-expiring | filing | recall | digest | safety-change. Best-effort. */
export function buildMonitorEmail({ reason, label, target, changes = [], reportUrl, manageUrl }) {
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
    "safety-change": `Token safety changed: ${t}`,
    "filing-new": `New SEC filing: ${t}`,
    digest: `${lbl}: this week's filings${t && t !== "all" ? ` for ${t}` : ""}`,
  };
  const leads = {
    welcome: `Your monitor for ${t} is active. Here is your first report, and we will email you again whenever something changes.`,
    scheduled: `Your scheduled re-run for ${t} is done. Nothing further is needed from you.`,
    change: `Our latest check of ${t} found changes since the last report:`,
    "tls-expiring": `Heads up: the TLS certificate for ${t} is close to expiry.`,
    filing: `${t} has a new SEC 13F filing. Your fresh holdings + changes report is ready.`,
    problem: `We have tried several times and could not produce a report for ${t}. We will keep trying daily; if the target is wrong, you can cancel or re-subscribe with a corrected one from the manage link below.`,
    recall: `The FDA recall feeds show new activity for ${t} since your last report:`,
    "safety-change": `The on-chain safety picture for this token changed since your last brief:`,
    "filing-new": `${t} has filed with the SEC since your last report. Here is what landed, with the new document read and explained:`,
    digest: `Your weekly IPO pipeline digest is ready${t && t !== "all" ? ` (filers matching "${t}")` : ""}.`,
  };
  const subj = subjects[reason] || `${lbl}: update for ${t}`;
  const lead = leads[reason] || `Your ${lbl} has an update for ${t}.`;
  // Plain-language "why you got this": recurring mail must say who asked for it
  // and how to stop it, in words, next to the manage link (which stays the
  // keyed one the caller passed - never widened here).
  const why = `You are getting this because you subscribed to the ${lbl} for ${t} on agent402.tools. It runs on its own until you cancel.`;
  const whyHtml = `<p style="color:#8a948c;font-size:12px;margin-top:26px">${escapeHtml(why)}</p>`;
  const whyText = `${why}\n`;
  const list = (changes || []).slice(0, 12);
  const changesHtml = list.length ? `<ul style="color:#35443c;padding-left:18px">${list.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>` : "";
  const changesText = list.length ? `\n${list.map((c) => `- ${c}`).join("\n")}\n` : "";
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#14201b">
    <h2 style="font-weight:500;color:#14201b">${escapeHtml(subj)}</h2>
    <p style="color:#35443c">${escapeHtml(lead)}</p>${changesHtml}
    <p style="margin:26px 0"><a href="${escapeAttr(reportUrl)}" style="background:#15654a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Open the report →</a></p>
    <p style="color:#8a948c;font-size:13px">Or paste this link into your browser:<br>${escapeHtml(reportUrl)}</p>
    ${whyHtml}
    <p style="color:#8a948c;font-size:12px;margin-top:12px">Agent402 · ${escapeHtml(lbl)} · <a href="${escapeAttr(manageUrl || reportUrl)}" style="color:#8a948c">manage or cancel</a></p>
  </div>`;
  const text = `${subj}\n\n${lead}\n${changesText}\nOpen the report: ${reportUrl}\n\n${whyText}\nManage or cancel (change your card, or stop the emails): ${manageUrl || reportUrl}\n\nAgent402`;
  return { subject: subj, html, text };
}

export async function sendMonitorEmail({ to, ...rest }) {
  const { subject, html, text } = buildMonitorEmail(rest);
  return sendEmail({ to, subject, html, text });
}

// Escapes quotes too: these values are text nodes today, but one move into an
// attribute would otherwise be an injection.
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function escapeAttr(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
