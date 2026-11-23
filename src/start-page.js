// /start: one page that tells a newcomer which path to take in the app they
// already use, what they can do with no wallet, and how to fund a first wallet.
//
// Every install line is read from mcpInstallHints (src/mcp-flagship.js), the
// same object the connector's own instructions print, so a new connector URL
// or package version reaches this page with no edit here. Only apps with a
// path this server's own docs give step by step are listed (Claude desktop,
// Claude Code, Cursor).
//
// Each offer reads the switch that sells it: the card report line only while
// the storefront is on (humanCheckoutEnabled), the credits line only while
// credits are on sale (creditsSalesEnabled), and the credits connector address
// only while credits are on sale and the connector sign-in is on
// (creditsConnectorOn). Counts and prices come from the
// catalog and the product table at render time.
import { ledgerShell, ledgerFooterCompact, esc, codeBlock } from "./ledger-chrome.js";
import { siteOrgRef } from "./site-org.js";
import { mcpInstallHints } from "./mcp-flagship.js";
import { isComputePayable } from "./pow.js";
import { creditsSalesEnabled, creditsConnectorOn, CREDITS_CONNECTOR_PATH } from "./credits-sales.js";
import { HUMAN_PRODUCTS, humanCheckoutEnabled } from "./human-checkout.js";
import { cardReportPriceRange } from "./report-tiers.js";
import { BASE_NO_GAS_SENTENCE } from "./base-no-gas.js";
import { CHAIN_PAGES } from "./market-page.js";

export const START_PATH = "/start";
export const START_TITLE = "Start here";

const H2 = 'style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-2xl);letter-spacing:-.02em;margin:0 0 14px;"';
const H3 = 'style="font-family:var(--font-body);font-weight:600;font-size:var(--fs-xl);margin:0 0 8px;"';
const P = 'style="color:var(--muted);font-size:var(--fs-base);line-height:1.6;margin:0 0 12px;"';
const A = 'style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);"';
const code = (s) => `<code style="font-family:var(--font-mono);font-size:var(--fs-code-inline);">${esc(s)}</code>`;
const block = (text, name) => codeBlock(`<code>${esc(text)}</code>`, { html: true, name, wrap: true, style: "margin:auto 0 0" });

/** The apps this page names, each with its one step, read from the install hints. */
export function startApps(baseUrl) {
  const install = mcpInstallHints(baseUrl);
  return [
    { id: "claude-desktop", name: "Claude desktop", step: "In Settings, open Connectors, choose Add custom connector, name it Agent402 and paste this address:", copy: install.hostedUrl },
    { id: "claude-code", name: "Claude Code", step: "Run this in a terminal:", copy: install.claudeCodeHosted },
    { id: "cursor", name: "Cursor", step: "Add this to ~/.cursor/mcp.json:", copy: JSON.stringify(install.cursorMcpJson, null, 2) },
  ];
}

/**
 * The page. `catalog` gives the proof-of-work count; `credits`, `connector`
 * and `storefront` default to this boot's switches, and a test passes them to
 * render each variant.
 */
export function startPage(baseUrl, catalog = {}, { credits = creditsSalesEnabled(), connector = creditsConnectorOn(), storefront = humanCheckoutEnabled() } = {}) {
  const canonical = `${baseUrl}${START_PATH}`;
  const title = "Start here - add Agent402 to Claude or Cursor";
  const description = "Add Agent402 to Claude desktop, Claude Code or Cursor in one step, see what runs with no wallet, and fund a first wallet with USDC on Base.";
  const tools = Object.values(catalog || {}).filter((d) => d && d.slug);
  const powCount = tools.filter(isComputePayable).length;
  const reportRange = storefront ? cardReportPriceRange(HUMAN_PRODUCTS) : null;
  const apps = startApps(baseUrl);
  const explorer = CHAIN_PAGES.base.explorerUrl;

  const appCards = apps.map((a) => `<div id="${esc(a.id)}" class="st-card" style="display:flex;flex-direction:column;border:1px solid var(--hairline);background:var(--card);border-radius:var(--radius);padding:18px 20px;">
        <h3 ${H3}>${esc(a.name)}</h3>
        <p ${P}>${esc(a.step).replace(esc("~/.cursor/mcp.json"), code("~/.cursor/mcp.json"))}</p>
        ${block(a.copy, `${a.name} setup`)}
      </div>`).join("\n      ");

  const noWallet = [
    powCount ? `<li><strong>Free tools.</strong> ${powCount} tools run free with proof of work on the connector above, rate-limited, with no wallet and no signup. <a href="/tools" ${A}>Browse the tools</a>.</li>` : "",
    reportRange ? `<li><strong>Reports by card.</strong> Finished, model-backed reports at <a href="/reports" ${A}>/reports</a>, ${esc(reportRange.text)} by card.</li>` : "",
    credits ? `<li><strong>Credits by card.</strong> Prepaid credits at <a href="/credits" ${A}>/credits</a>: a credits key pays for paid tools with no wallet.${connector ? ` Or add ${code(`${baseUrl}${CREDITS_CONNECTOR_PATH}`)} as the connector address: you sign in with your email, and the app pays from your balance under a daily cap you set, with no key to copy.` : ""}</li>` : "",
  ].filter(Boolean).join("\n        ");

  const pageLd = { "@context": "https://schema.org", "@type": "HowTo", name: title, description, url: canonical, author: siteOrgRef(baseUrl),
    step: apps.map((a) => ({ "@type": "HowToStep", name: a.name, text: `${a.step} ${a.copy}` })) };

  const body = `
  <div style="max-width:1180px;margin:0 auto;padding:50px 30px 64px;">
    <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:1.02;margin:0 0 40px;text-wrap:balance;">${esc(START_TITLE)}</h1>

    <section id="apps" style="margin-bottom:56px;">
      <h2 ${H2}>Add Agent402 to your app</h2>
      <div class="st-grid" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;">
      ${appCards}
      </div>
    </section>

    ${noWallet ? `<section id="no-wallet" style="margin-bottom:56px;">
      <h2 ${H2}>Without a wallet</h2>
      <ul class="ml-ticks ml-measure" style="font-size:var(--fs-base);line-height:1.6;">
        ${noWallet}
      </ul>
    </section>` : ""}

    <section id="fund" style="margin-bottom:24px;">
      <h2 ${H2}>Fund a first wallet</h2>
      <ol class="ml-measure" style="padding-left:22px;margin:0 0 16px;color:var(--ink);font-size:var(--fs-base);line-height:1.6;">
        <li style="margin:0 0 8px;">Buy USDC on Base. Where you buy it, choose Base as the network.</li>
        <li style="margin:0 0 8px;">Send it to your wallet address. Use a new wallet for your agent and keep only a few dollars in it.</li>
        <li style="margin:0 0 8px;">Check the balance: open ${code(`${explorer}/address/<your address>`)} and find USDC under the token holdings.</li>
      </ol>
      <p class="ml-measure" ${P}>${esc(BASE_NO_GAS_SENTENCE)}</p>
      <p class="ml-measure" ${P}>To pay from the wallet, follow <a href="/how-to-pay" ${A}>how to pay</a>.</p>
    </section>
  </div>
  ${ledgerFooterCompact()}`;

  const extraCss = `@media (max-width:900px){.st-grid{grid-template-columns:minmax(0,1fr)!important}}`;
  return ledgerShell({ title, description, canonical, baseUrl, activePath: START_PATH, jsonLd: [pageLd], extraCss, body });
}
