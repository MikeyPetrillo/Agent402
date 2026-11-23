// The connector sign-in page (src/mcp-oauth.js): one server-drawn page per
// step (email, code, choose a balance and a daily cap), plain forms with no
// script, so it works with the strict policy the sign-in answers carry
// (no framing, forms only to this site, the card checkout and the app's own
// return address).
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { REPORTS_CSS } from "./human-reports-page.js";
import { ACCOUNT_CSS } from "./credits-account-page.js";

export const OAUTH_CONSENT_PATH = "/oauth/consent";

const CONSENT_CSS = `
  .oc-wrap{max-width:560px}
  .oc-app{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);overflow-wrap:anywhere}
  .oc-list{margin:10px 0 0;padding:0 0 0 18px;color:var(--muted);font-size:var(--fs-md);line-height:1.55}
  .oc-pick{display:flex;flex-direction:column;gap:8px;margin-top:10px}
  .oc-pick label{display:flex;align-items:center;gap:10px;font-size:var(--fs-md);color:var(--ink)}
  .oc-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
`;

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

function hidden(rid, csrf, action) {
  return `<input type="hidden" name="rid" value="${esc(rid)}"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="${esc(action)}">`;
}

function appBlock(client) {
  return `<p class="note">Connecting <span class="oc-app">${esc(client.name)}</span>, which returns to <span class="oc-app">${esc(client.returnHost)}</span>.</p>`;
}

/**
 * @param {object} v
 * @param {"email"|"code"|"choose"} v.step
 * @param {{name:string, returnHost:string}} v.client
 */
export function consentPage(baseUrl, v) {
  const { step, client, rid, csrf, message = "", error = "", email = "", balances = [], packs = [], capUsd = 5, capMaxUsd = 100, salesOn = false } = v;
  const msg = error ? `<p class="err" role="alert">${esc(error)}</p>` : message ? `<p class="acct-msg" role="status">${esc(message)}</p>` : "";
  const buy = (label) => salesOn && packs.length ? `
      <form method="post" action="${OAUTH_CONSENT_PATH}" class="oc-row">
        ${hidden(rid, csrf, "buy")}
        <label class="flabel" for="oc-pack">${esc(label)}</label>
        <div class="acct-row" style="margin-top:0"><select id="oc-pack" name="pack">${packs.map((p) => `<option value="${esc(p.id)}">${esc(usd(p.usd))} of credits</option>`).join("")}</select>
        <button class="btn btn-secondary" type="submit">Buy by card</button></div>
      </form>` : "";
  let inner;
  if (step === "email") {
    inner = `
      <div class="k">Sign in by email</div>
      ${appBlock(client)}
      <form method="post" action="${OAUTH_CONSENT_PATH}">
        ${hidden(rid, csrf, "email")}
        <label class="flabel" for="oc-email">Email for your credits balance</label>
        <div class="field"><input id="oc-email" name="email" type="email" autocomplete="email" required value="${esc(email)}"></div>
        <button class="btn btn-primary" type="submit">Email me a code</button>
      </form>
      ${msg}
      ${buy("No credits yet? Buy a balance by card, then sign in with the email you paid with.")}`;
  } else if (step === "code") {
    inner = `
      <div class="k">Enter your code</div>
      ${appBlock(client)}
      ${msg}
      <form method="post" action="${OAUTH_CONSENT_PATH}">
        ${hidden(rid, csrf, "code")}
        <label class="flabel" for="oc-code">Six-digit code</label>
        <div class="field"><input id="oc-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>
        <button class="btn btn-primary" type="submit">Continue</button>
      </form>
      <form method="post" action="${OAUTH_CONSENT_PATH}" class="oc-row">${hidden(rid, csrf, "restart")}<button class="btn btn-secondary btn-sm" type="submit">Use another email</button></form>`;
  } else {
    const usable = balances.filter((b) => !b.disabled && !b.refund && !b.frozen);
    inner = `
      <div class="k">Allow this app to pay from your credits</div>
      ${appBlock(client)}
      <p class="note">Signed in as ${esc(email)}.</p>
      ${msg}
      ${usable.length ? `
      <form method="post" action="${OAUTH_CONSENT_PATH}">
        ${hidden(rid, csrf, "approve")}
        <div class="oc-pick" role="radiogroup" aria-label="Balance">
          ${usable.map((b, i) => `<label><input type="radio" name="keyId" value="${esc(b.keyId)}"${i === 0 ? " checked" : ""}> Balance ${esc(b.keyId)}: ${esc(usd(b.balanceUsd))}</label>`).join("")}
        </div>
        <label class="flabel" for="oc-cap" style="margin-top:14px">Daily spending cap (USD, UTC day)</label>
        <div class="field"><input id="oc-cap" name="capUsd" inputmode="decimal" value="${esc(Number(capUsd).toFixed(2))}" required></div>
        <ul class="oc-list">
          <li>The app pays for Agent402 tool calls from this balance, at list price, only when a call succeeds.</li>
          <li>It cannot spend more than the cap in one day, or more than the balance holds.</li>
          <li>It cannot read or move the balance, see your key, or buy from outside sellers.</li>
          <li>You can change the cap or disconnect it on your balance page at any time (up to ${esc(usd(capMaxUsd))} a day).</li>
        </ul>
        <div class="oc-row"><button class="btn btn-primary" type="submit">Allow</button></div>
      </form>` : `<p class="note">No open balance is on this email.</p>`}
      <form method="post" action="${OAUTH_CONSENT_PATH}" class="oc-row">${hidden(rid, csrf, "deny")}<button class="btn btn-secondary" type="submit">Deny</button></form>
      ${usable.length ? "" : buy("Buy a balance by card")}`;
  }
  const body = `
<div class="wrap" style="padding-top:28px;">
  <section class="acct-signin oc-wrap"><div class="pcard">${inner}</div></section>
</div>
${ledgerFooterCompact()}`;
  return ledgerShell({ title: "Connect an app to your Agent402 credits", description: "Sign in by email and let an app pay for Agent402 tool calls from your prepaid credits, under a daily cap.", canonical: `${baseUrl}${OAUTH_CONSENT_PATH}`, baseUrl, activePath: "/credits", extraCss: REPORTS_CSS + ACCOUNT_CSS + CONSENT_CSS, body, robots: "noindex, nofollow" });
}

/** A sign-in step that cannot go on (an unknown app, a return address it did not register, an expired request). */
export function consentErrorPage(baseUrl, title, text) {
  const body = `
<div class="wrap" style="padding-top:28px;">
  <div class="status"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>
</div>
${ledgerFooterCompact()}`;
  return ledgerShell({ title: `${title} - Agent402`, description: "Connect an app to your Agent402 credits.", canonical: `${baseUrl}${OAUTH_CONSENT_PATH}`, baseUrl, activePath: "/credits", extraCss: REPORTS_CSS, body, robots: "noindex, nofollow" });
}
