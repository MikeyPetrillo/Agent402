// /digest - subscribe an email to the identity you already pay with.
// Behaviour lives in /js/digest-signup.js (CSP: no inline scripts).
import { ledgerShell, esc } from "./ledger-chrome.js";

export function digestPage(baseUrl) {
  const body = `
<main style="max-width:720px;margin:0 auto;padding:56px 24px 80px;">
  <p style="font-family:var(--font-mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:0 0 12px;">weekly digest</p>
  <h1 style="font-weight:600;font-size:38px;letter-spacing:-.02em;margin:0 0 14px;color:var(--ink);">Your week, from the wallet you pay with.</h1>
  <p class="hm-lede" style="font-size:17px;max-width:600px;margin:0 0 26px;">One email a week: calls, dollars, the tools you used and the chains you paid on. For a credits key, the balance and a top-up link too. Nothing is sent for a quiet week, and every email carries an unsubscribe link. Your address is stored only after you click the confirmation.</p>

  <form class="dg-form" data-mode="wallet" style="display:grid;gap:12px;max-width:560px;border:1px solid var(--hairline);background:var(--card);padding:22px;">
    <div style="font-weight:600;">Pay with a wallet</div>
    <p style="margin:0;color:var(--muted);font-size:14px;">Prove the wallet is yours by signing a message with it (no transaction, no gas). EVM wallets on any of the rails.</p>
    <input class="dg-email" type="email" required placeholder="you@example.com" autocomplete="email" style="padding:11px 12px;border:1px solid var(--hairline);background:var(--paper);color:var(--ink);font-size:15px;">
    <input class="dg-wallet" type="text" required placeholder="0x… the address you pay from" style="padding:11px 12px;border:1px solid var(--hairline);background:var(--paper);color:var(--ink);font-family:var(--font-mono);font-size:13.5px;">
    <input class="dg-hp" type="text" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px;" aria-hidden="true">
    <button class="dg-submit hm-btn hm-btn-dark" type="submit">Sign with wallet and subscribe</button>
    <div class="dg-msg" style="font-size:14px;color:var(--muted);min-height:1.4em;" aria-live="polite"></div>
  </form>

  <form class="dg-form" data-mode="credits" style="display:grid;gap:12px;max-width:560px;border:1px solid var(--hairline);background:var(--card);padding:22px;margin-top:18px;">
    <div style="font-weight:600;">Pay with a credits key</div>
    <p style="margin:0;color:var(--muted);font-size:14px;">Presenting the key is the proof. It is sent once over HTTPS and never stored by this form; the digest is keyed to the key's id. The claim email for a new key carries this link already.</p>
    <input class="dg-email" type="email" required placeholder="you@example.com" autocomplete="email" style="padding:11px 12px;border:1px solid var(--hairline);background:var(--paper);color:var(--ink);font-size:15px;">
    <input class="dg-key" type="password" required placeholder="a402_…" autocomplete="off" style="padding:11px 12px;border:1px solid var(--hairline);background:var(--paper);color:var(--ink);font-family:var(--font-mono);font-size:13.5px;">
    <input class="dg-hp" type="text" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px;" aria-hidden="true">
    <button class="dg-submit hm-btn hm-btn-dark" type="submit">Subscribe</button>
    <div class="dg-msg" style="font-size:14px;color:var(--muted);min-height:1.4em;" aria-live="polite"></div>
  </form>

  <p style="margin:26px 0 0;font-size:14px;color:var(--muted);">Want it now instead of weekly? <a href="/tools/my-usage" style="color:var(--ink);">my-usage</a> is the same history as a paid, wallet-keyed tool call. Read how we handle the address in the <a href="/privacy" style="color:var(--ink);">privacy policy</a>.</p>
</main>`;
  return ledgerShell({
    title: "Weekly spend digest - Agent402",
    description: "One email a week with what your wallet or credits key spent on Agent402: calls, dollars, tools and chains. Double opt-in, one-click unsubscribe.",
    canonical: `${baseUrl}/digest`, baseUrl, activePath: "/digest", body,
    extraScripts: '<script src="/js/digest-signup.js"></script>',
  });
}
