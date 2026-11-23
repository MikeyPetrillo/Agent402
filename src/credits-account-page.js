// The credits balance page (/credits/account) and its small notices: the
// sign-in form is drawn here, and the page's script (assets/credits/account.js) replaces it with the
// signed-in view (balances, history by tool, top-up, CSV, refund, new key)
// when the session cookie is good. Served only while credits are on sale
// (src/credits-account.js). External JS (the site CSP drops inline script),
// served from the page's own path so it too exists only while sales are on.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { REPORTS_CSS } from "./human-reports-page.js";
import { ACCOUNT_PATH } from "./credits-account.js";
import { signInLifeWords, lowBalanceWords } from "./credits-figures.js";

export const ACCOUNT_CSS = `
  .acct-bal{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;margin-top:8px}
  .acct-card{min-width:0;border:1px solid var(--hairline);border-radius:var(--radius);background:var(--card);padding:24px}
  .acct-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 20px}
  .acct-id{font-family:var(--font-mono);font-size:var(--fs-xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);white-space:nowrap}
  .acct-amt{font-family:var(--font-mono);font-size:var(--fs-3xl);color:var(--ink);letter-spacing:-.02em;font-variant-numeric:tabular-nums;margin:6px 0 2px}
  .acct-meta{display:flex;flex-wrap:wrap;gap:4px 18px;font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--faint);font-variant-numeric:tabular-nums}
  .acct-meta>span{white-space:nowrap}
  .acct-state{font-size:var(--fs-sm);font-weight:500;white-space:nowrap}.acct-state.ok{color:var(--ok)}.acct-state.warn{color:var(--warn)}.acct-state.off{color:var(--faint)}
  .acct-row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px;margin-top:18px}
  .acct-row select,.acct-row input{min-height:40px;border:1px solid var(--control);border-radius:var(--radius);background:var(--paper);color:var(--ink);font-family:var(--font-body);font-size:var(--fs-md);padding:0 10px}
  .acct-row label{display:flex;flex-direction:column;gap:6px;font-size:var(--fs-sm);font-weight:500;color:var(--ink)}
  .acct-check{display:flex!important;flex-direction:row!important;align-items:center;gap:8px;min-height:24px;font-weight:400!important;color:var(--muted)!important}
  .acct-section{margin-top:22px}
  .acct-section h3{font-weight:600;font-size:var(--fs-lg);margin:0 0 4px;color:var(--ink)}
  .acct-section p{font-size:var(--fs-md);line-height:1.55;color:var(--muted);margin:4px 0 0;max-width:72ch}
  .acct-key{font-family:var(--font-mono);font-size:var(--fs-sm);background:var(--panel);color:var(--on-panel);padding:14px 16px;border-radius:var(--radius);overflow-wrap:anywhere;user-select:all;margin:12px 0 0}
  .acct-msg{font-size:var(--fs-md);line-height:1.5;color:var(--muted);margin-top:10px;min-height:0}
  .acct-msg.bad{color:var(--bad)}
  .acct-signin{max-width:520px}
  .acct-signin form{margin-top:4px}
  @media (max-width:600px){.acct-card{padding:18px}.acct-amt{font-size:var(--fs-2xl)}}
`;

const shell = ({ title, description, body, baseUrl }) => ledgerShell({
  title, description, canonical: `${baseUrl}${ACCOUNT_PATH}`, baseUrl, activePath: "/credits", extraCss: REPORTS_CSS + ACCOUNT_CSS, body, robots: "noindex, nofollow",
});

export function creditsAccountPage(baseUrl) {
  const body = `
<div class="wrap">
  <section class="hero">
    <div class="eyebrow">Prepaid credits · your balance</div>
    <h1>Your credits <em>balance.</em></h1>
    <p class="lede">See what your balance holds and what it paid for, add to it, download its history, ask for the unspent balance back, or issue a new key. Sign in with the email you bought credits with; no key is needed.</p>
  </section>
  <div id="app" data-api="${ACCOUNT_PATH}"><div class="status"><h2><span class="spin"></span>Loading your balance</h2><p>One moment.</p></div></div>
  <template id="acct-signin">
    <section class="acct-signin">
      <div class="pcard">
        <div class="k">Sign in by email</div>
        <form id="acct-signin-form" novalidate>
          <label class="flabel" for="in-email">Purchase email</label>
          <div class="field"><input id="in-email" name="email" type="email" autocomplete="email" placeholder="e.g. you@company.com" aria-describedby="err-email"></div>
          <button class="btn btn-primary" type="submit">Email me a sign-in link</button>
          <div class="err" id="err-email" aria-live="polite"></div>
        </form>
        <p class="note">The link works once, for ${signInLifeWords()}. Keys are stored only as a hash, so a lost key cannot be shown again; once signed in you can issue a new one.</p>
      </div>
    </section>
  </template>
  <noscript><div class="status"><h2>This page needs JavaScript</h2><p>Your key keeps working without it: <span style="font-family:var(--font-mono)">GET /api/credits/balance</span> with the key reads the balance.</p></div></noscript>
</div>
${ledgerFooterCompact()}
<script src="${ACCOUNT_PATH}/app.js"></script>`;
  return shell({ title: "Your Agent402 credits balance", description: "Sign in by email to see your prepaid credits balance and its history, add to it, export a CSV, ask for the unspent balance back, or issue a new key.", body, baseUrl });
}

/** The page a sign-in link opens: one button spends the token (a mail scanner's fetch does not). */
export function creditsVerifyPage(baseUrl, token) {
  const body = `
<div class="wrap" style="padding-top:28px;">
  <div class="status">
    <h2>Sign in to your balance</h2>
    <p>This link works once. Press the button to sign in on this device.</p>
    <form method="post" action="${ACCOUNT_PATH}/verify" style="margin-top:18px">
      <input type="hidden" name="t" value="${esc(token)}">
      <button class="btn btn-primary" type="submit">Sign in</button>
    </form>
  </div>
</div>
${ledgerFooterCompact()}`;
  return shell({ title: "Sign in to your Agent402 credits balance", description: "Sign in to your prepaid credits balance.", body, baseUrl });
}

export function creditsNoticePage(baseUrl, title, html) {
  const body = `
<div class="wrap" style="padding-top:28px;">
  <div class="status"><h2>${esc(title)}</h2>${html}</div>
</div>
${ledgerFooterCompact()}`;
  return shell({ title: `${title} - Agent402 credits`, description: "Agent402 prepaid credits.", body, baseUrl });
}

export function creditsNoticeOffPage(baseUrl, keyId, k) {
  const body = `
<div class="wrap" style="padding-top:28px;">
  <div class="status">
    <h2>Stop low-balance emails</h2>
    <p>We email you once each time the balance on key <span style="font-family:var(--font-mono)">${esc(keyId)}</span> drops under ${lowBalanceWords()}. Receipts and sign-in links still arrive.</p>
    <form method="post" action="/credits/low-balance/off" style="margin-top:18px">
      <input type="hidden" name="key" value="${esc(keyId)}"><input type="hidden" name="k" value="${esc(k)}"><input type="hidden" name="confirm" value="1">
      <button class="btn btn-primary" type="submit">Stop these emails</button>
    </form>
  </div>
</div>
${ledgerFooterCompact()}`;
  return shell({ title: "Stop low-balance emails - Agent402 credits", description: "Turn off the low-balance email for a prepaid credits balance.", body, baseUrl });
}
