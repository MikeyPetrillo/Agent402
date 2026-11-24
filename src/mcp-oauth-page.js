// The connector sign-in page (src/mcp-oauth.js): one server-drawn page per
// step (email, code, choose a balance and a daily cap), plain forms with no
// script, so it works with the strict policy the sign-in answers carry
// (no framing, forms only to this site, the card checkout and the app's own
// return address).
import { ledgerShell, esc } from "./ledger-chrome.js";
import { REPORTS_CSS } from "./human-reports-page.js";
import { ACCOUNT_CSS, balanceName } from "./credits-account-page.js";
import { ACCOUNT_PATH } from "./credits-account.js";

export const OAUTH_CONSENT_PATH = "/oauth/consent";

const CONSENT_CSS = `
  .oc-wrap{max-width:560px}
  .oc-h1{font-family:var(--font-body);font-weight:800;font-size:var(--fs-2xl);letter-spacing:-.02em;line-height:1.2;margin:0 0 8px;color:var(--ink)}
  .oc-app{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);overflow-wrap:break-word;word-break:normal}
  .oc-list{margin:10px 0 0;padding:0 0 0 18px;color:var(--muted);font-size:var(--fs-md);line-height:1.55}
  .oc-pick{display:flex;flex-direction:column;gap:8px;margin-top:10px}
  .oc-pick label{display:flex;align-items:center;gap:10px;font-size:var(--fs-md);color:var(--ink)}
  .oc-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
  .oc-wrap .btn{min-height:44px}
  .oc-wrap .err{color:var(--bad);margin-top:8px;padding-top:0}
  .oc-wrap .acct-msg{margin:0 0 8px}
  .oc-wrap form + form{margin-top:12px}
`;

// The sign-in pages close with the legal links and the help address only:
// the site footer's dozens of links would lead away mid sign-in.
const MINIMAL_FOOTER = `<footer style="border-top:1px solid var(--hairline);margin-top:40px;"><div style="max-width:1180px;margin:0 auto;padding:18px 30px;display:flex;flex-wrap:wrap;gap:8px 18px;font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);"><span>Agent402</span><a href="/privacy" style="color:var(--faint);display:inline-block;padding:4px 0;">Privacy</a><a href="/terms" style="color:var(--faint);display:inline-block;padding:4px 0;">Terms</a><a href="mailto:help@agent402.tools" style="color:var(--faint);display:inline-block;padding:4px 0;">help@agent402.tools</a></div></footer>`;

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const ERR_ID = "oc-err";

// `withAction`: false when the form's buttons name the action themselves.
function hidden(rid, csrf, action, withAction = true) {
  return `<input type="hidden" name="rid" value="${esc(rid)}"><input type="hidden" name="csrf" value="${esc(csrf)}">${withAction ? `<input type="hidden" name="action" value="${esc(action)}">` : ""}`;
}

function appBlock(client) {
  return `<p class="note">Connecting <span class="oc-app">${esc(client.name)}</span>, which returns to <span class="oc-app">${esc(client.returnHost)}</span>.</p>`;
}

/**
 * @param {object} v
 * @param {"email"|"code"|"choose"} v.step
 * @param {{name:string, returnHost:string}} v.client
 * @param {boolean} [v.locked]  the email is locked out: the code form is disabled and a new code offered
 */
export function consentPage(baseUrl, v) {
  const { step, client, rid, csrf, message = "", error = "", email = "", balances = [], packs = [], capUsd = 5, capMaxUsd = 100, salesOn = false, locked = false } = v;
  // The error line sits under the field it is about, tied to it; a status
  // message sits under the heading.
  const errLine = error ? `<div class="err" id="${ERR_ID}" role="alert">${esc(error)}</div>` : "";
  const tie = (on = true) => (error && on ? ` aria-describedby="${ERR_ID}" aria-invalid="true"` : "");
  const status = message && !error ? `<p class="acct-msg" role="status">${esc(message)}</p>` : "";
  const usable = balances.filter((b) => !b.disabled && !b.refund);
  const canBuy = salesOn && packs.length > 0;
  const buy = (label, { primary = false, errorHere = false } = {}) => canBuy ? `
      <form method="post" action="${OAUTH_CONSENT_PATH}">
        ${hidden(rid, csrf, "buy")}
        <label class="flabel" for="oc-pack">${esc(label)}</label>
        <div class="acct-row" style="margin-top:0"><select id="oc-pack" name="pack"${tie(errorHere)}>${packs.map((p) => `<option value="${esc(p.id)}">${esc(usd(p.usd))} of credits</option>`).join("")}</select>
        <button class="btn ${primary ? "btn-primary" : "btn-secondary"}" type="submit">Buy by card</button></div>
        ${errorHere ? errLine : ""}
      </form>` : "";
  const another = `<form method="post" action="${OAUTH_CONSENT_PATH}" class="oc-row">${hidden(rid, csrf, "restart")}<button class="btn btn-secondary btn-sm" type="submit">Use another email</button></form>`;
  let title, inner;
  if (step === "email") {
    title = "Sign in by email";
    inner = `
      ${appBlock(client)}
      ${status}
      <form method="post" action="${OAUTH_CONSENT_PATH}">
        ${hidden(rid, csrf, "email")}
        <label class="flabel" for="oc-email">Email for your credits balance</label>
        <div class="field"><input id="oc-email" name="email" type="email" autocomplete="email" required value="${esc(email)}"${tie()}></div>
        ${errLine}
        <div class="oc-row"><button class="btn btn-primary" type="submit">Email me a code</button></div>
      </form>
      ${canBuy ? `<p class="note">No credits yet? Sign in with your email, then buy a balance by card.</p>` : ""}`;
  } else if (step === "code") {
    title = "Enter your code";
    const off = locked ? " disabled" : "";
    inner = `
      ${appBlock(client)}
      ${status}
      <form method="post" action="${OAUTH_CONSENT_PATH}">
        ${hidden(rid, csrf, "code")}
        <label class="flabel" for="oc-code">Six-digit code sent to <span class="oc-app">${esc(email)}</span></label>
        <div class="field"><input id="oc-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required${off}${tie()}></div>
        ${errLine}
        <div class="oc-row"><button class="btn btn-primary" type="submit"${off}>Continue</button></div>
      </form>
      <form method="post" action="${OAUTH_CONSENT_PATH}" class="oc-row">${hidden(rid, csrf, "email")}<input type="hidden" name="email" value="${esc(email)}"><button class="btn btn-secondary btn-sm" type="submit">Send a new code</button></form>
      ${another}`;
  } else if (usable.length) {
    title = "Allow this app to pay from your credits";
    inner = `
      ${appBlock(client)}
      <p class="note">Signed in as <span class="oc-app">${esc(email)}</span>.</p>
      ${status}
      <form method="post" action="${OAUTH_CONSENT_PATH}">
        ${hidden(rid, csrf, "approve", false)}
        <div class="oc-pick" role="radiogroup" aria-label="Balance">
          ${usable.map((b, i) => `<label><input type="radio" name="keyId" value="${esc(b.keyId)}"${i === 0 ? " checked" : ""}> ${esc(balanceName(b, usable))}: ${esc(usd(b.balanceUsd))}</label>`).join("")}
        </div>
        <label class="flabel" for="oc-cap" style="margin-top:14px">Daily spending cap (USD, UTC day)</label>
        <div class="field"><input id="oc-cap" name="capUsd" inputmode="decimal" value="${esc(Number(capUsd).toFixed(2))}" required${tie()}></div>
        ${errLine}
        <ul class="oc-list">
          <li>The app pays for Agent402 tool calls from this balance, at list price, only when a call succeeds.</li>
          <li>It cannot spend more than the cap in one day, or more than the balance holds.</li>
          <li>It cannot read or move the balance, or buy from outside sellers.</li>
          <li>You can change the cap or disconnect it on your <a href="${ACCOUNT_PATH}">balance page</a> at any time (up to ${esc(usd(capMaxUsd))} a day).</li>
        </ul>
        <div class="oc-row"><button class="btn btn-primary" type="submit" name="action" value="approve">Allow</button><button class="btn btn-secondary" type="submit" name="action" value="deny" formnovalidate>Deny</button></div>
      </form>`;
  } else {
    title = canBuy ? "Add credits to connect" : "No open balance on this email";
    inner = `
      ${appBlock(client)}
      <p class="note">Signed in as <span class="oc-app">${esc(email)}</span>. No open balance is on this email.</p>
      ${status}
      ${canBuy ? buy("Buy a balance by card", { primary: true, errorHere: true }) : errLine}
      <form method="post" action="${OAUTH_CONSENT_PATH}" class="oc-row">${hidden(rid, csrf, "deny")}<button class="btn btn-secondary" type="submit">Deny</button></form>`;
  }
  const body = `
<div class="wrap" style="padding-top:28px;">
  <section class="acct-signin oc-wrap"><div class="pcard"><h1 class="oc-h1">${esc(title)}</h1>${inner}</div></section>
</div>
${MINIMAL_FOOTER}`;
  return ledgerShell({ title: "Connect an app to your Agent402 credits", description: "Sign in by email and let an app pay for Agent402 tool calls from your prepaid credits, under a daily cap.", canonical: `${baseUrl}${OAUTH_CONSENT_PATH}`, baseUrl, activePath: "/credits", extraCss: REPORTS_CSS + ACCOUNT_CSS + CONSENT_CSS, body, robots: "noindex, nofollow", minimal: true });
}

const ERROR_CSS = `
  .status h1{font-family:var(--font-body);font-weight:800;font-size:var(--fs-xl);letter-spacing:-.02em;margin:0 0 10px;color:var(--ink)}
`;

/** A sign-in step that cannot go on (an unknown app, a return address it did not register, an expired request). */
export function consentErrorPage(baseUrl, title, text) {
  const body = `
<div class="wrap" style="padding-top:28px;">
  <div class="status"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>
</div>
${MINIMAL_FOOTER}`;
  return ledgerShell({ title: `${title} - Agent402`, description: "Connect an app to your Agent402 credits.", canonical: `${baseUrl}${OAUTH_CONSENT_PATH}`, baseUrl, activePath: "/credits", extraCss: REPORTS_CSS + ERROR_CSS, body, robots: "noindex, nofollow", minimal: true });
}
