// /start: one page that tells a newcomer which path to take in the app they
// already use, what they can do with no wallet, and how to fund a first wallet.
//
// Every install line is read from mcpInstallHints (src/mcp-flagship.js), the
// same object the connector's own instructions print, so a new connector URL
// or package version reaches this page with no edit here. Only apps with a
// path this server's own docs give step by step are listed (Claude desktop,
// Claude Code, Cursor), plus the phone path: the same custom connector, added
// from the phone's browser and used in the Claude app. Its steps follow the
// app publisher's own connector documentation, and its first prompt runs a
// free tool, so a phone user sees the connection work with no wallet.
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
import { BASE_NO_GAS_PLAIN } from "./base-no-gas.js";
import { WALLET_NEW_COMMAND } from "./get-a-wallet.js";
import { CHAIN_PAGES } from "./market-page.js";

export const START_PATH = "/start";
export const START_TITLE = "Start here";

const H2 = 'style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-2xl);letter-spacing:-.02em;margin:0 0 14px;"';
const H3 = 'style="font-family:var(--font-body);font-weight:600;font-size:var(--fs-xl);margin:0 0 8px;"';
const P = 'style="color:var(--muted);font-size:var(--fs-base);line-height:1.6;margin:0 0 12px;"';
const A = 'style="color:var(--ink);text-decoration:none;border-bottom:1px solid var(--accent);"';
const code = (s) => `<code style="font-family:var(--font-mono);font-size:var(--fs-code-inline);">${esc(s)}</code>`;
// A config step says "add this agent402 entry under mcpServers", so its block is that entry alone.
const entry = (server) => `"agent402": ${JSON.stringify(server, null, 2)}`;
// A command wraps at its spaces only: each token is held whole (a browser
// would otherwise break after a hyphen, splitting --transport or -s), and a
// token wider than the card scrolls inside its block. The copied text is unchanged.
const block = (text, name, style = "margin:auto 0 0") => codeBlock(`<code>${esc(text).replace(/\S+/g, (t) => `<span class="st-tok">${t}</span>`)}</code>`, { html: true, name, wrap: true, style });

// The first prompt a new connection is checked with: it asks for one free tool
// (a slug on the free list, run by the hosted connector with no wallet;
// scripts/test-start-page.js runs it through a local /mcp).
export const START_FIRST_PROMPT = { slug: "hash", input: { text: "hello" }, text: "Use Agent402 to get the SHA-256 hash of the word hello." };
export const START_PHONE_ID = "phone";
// The menu path in the Claude desktop app and on claude.ai, as the app's own
// connector documentation gives it; /docs prints this step for both.
export const CONNECTOR_MENU_STEP = "In the sidebar, open Customize, then Connectors. Choose Add, then Add custom connector, name it Agent402 and paste this address:";

/**
 * The apps this page names, each with its one step, read from the install hints.
 * `connector`: credits are on sale and the connector sign-in is on, so the
 * card path comes first: the app connects to the credits connector, which asks
 * for an email sign-in and pays from the balance (free tools run there too).
 * Otherwise the step is the hosted connector, whose tools without a wallet are
 * the free ones; a wallet pays through the npm server (walletSetup).
 */
export function startApps(baseUrl, { connector = false } = {}) {
  const install = mcpInstallHints(baseUrl);
  const credits = `${baseUrl}${CREDITS_CONNECTOR_PATH}`;
  const url = connector ? credits : install.hostedUrl;
  return [
    {
      id: START_PHONE_ID, name: "On your phone", copyName: "the connector address",
      step: "In your phone's browser, sign in at claude.ai and open Customize, then Connectors. Choose Add, then Add custom connector, name it Agent402 and paste this address:",
      copy: url,
      after: connector ? "Choose Continue, then Add, and sign in with your email when Claude asks." : "Choose Continue, then Add.",
      then: `In the Claude app, select + in a chat and find Agent402 under Connectors. ${connector
        ? "A card pays for paid tools from your credits balance, and the free tools run there too."
        : "The free tools run from your phone with no wallet; paid tools take a wallet set up on a computer (below)."}`,
      promptLabel: "Ask this to check the connection:",
      prompt: START_FIRST_PROMPT.text,
    },
    { id: "claude-desktop", name: "Claude desktop", step: CONNECTOR_MENU_STEP, copy: url },
    { id: "cursor", name: "Cursor", step: "In ~/.cursor/mcp.json, add this agent402 entry under mcpServers:", copy: entry(connector ? { url: credits } : install.cursorMcpJson.mcpServers.agent402) },
    { id: "claude-code", name: "Claude Code", step: "Run this in a terminal:", copy: connector ? install.claudeCodeHosted.replace(install.hostedUrl, credits) : install.claudeCodeHosted },
  ];
}

// The daily budget the npm server applies: none by default, for a new setup
// or an existing one (mcp/spend-ledger.js DAY_CAP_HOW, which
// scripts/test-package-readme-claims.js holds this sentence to).
export const SETUP_DAY_CAP_SENTENCE = "No daily budget is written or applied by default; setup prints one line showing how to set AGENT402_MAX_USD_PER_DAY if you want one, and the per-call cap (AGENT402_MAX_PER_CALL) still applies.";

/** The wallet path: the npm server, set up once from a terminal (it keeps the key in the OS keychain), then one config per app. */
export function walletSetup(baseUrl) {
  const install = mcpInstallHints(baseUrl);
  const npmServer = install.cursorNpmMcpJson.mcpServers.agent402;
  const config = entry({ command: npmServer.command, args: npmServer.args });
  return {
    setup: `${install.npm} setup`,
    apps: [
      { id: "wallet-claude-code", name: "Claude Code", step: "Run this in a terminal:", copy: install.claudeCodeNpm },
      { id: "wallet-claude-desktop", name: "Claude desktop", step: "In Settings, open Developer, choose Edit Config, and add this agent402 entry under mcpServers in claude_desktop_config.json, then restart Claude:", copy: config },
      { id: "wallet-cursor", name: "Cursor", step: "In ~/.cursor/mcp.json, add this agent402 entry under mcpServers:", copy: config },
    ],
    warning: install.walletWarning,
  };
}

/**
 * The page. `catalog` gives the proof-of-work count; `credits`, `connector`
 * and `storefront` default to this boot's switches, and a test passes them to
 * render each variant.
 */
export function startPage(baseUrl, catalog = {}, { credits = creditsSalesEnabled(), connector = creditsConnectorOn(), storefront = humanCheckoutEnabled() } = {}) {
  const canonical = `${baseUrl}${START_PATH}`;
  const title = "Start here - add Agent402 to Claude or Cursor";
  const description = "Add Agent402 to Claude desktop, Claude Code, Cursor or Claude on your phone. See what runs with no wallet, then pay by card or with USDC on Base.";
  const tools = Object.values(catalog || {}).filter((d) => d && d.slug);
  const powCount = tools.filter(isComputePayable).length;
  const reportRange = storefront ? cardReportPriceRange(HUMAN_PRODUCTS) : null;
  const viaCredits = Boolean(credits && connector);
  const apps = startApps(baseUrl, { connector: viaCredits });
  const wallet = walletSetup(baseUrl);
  const explorer = CHAIN_PAGES.base.explorerUrl;
  const hosted = mcpInstallHints(baseUrl).hostedUrl;
  const stepHtml = (a) => esc(a.step).replace(esc("~/.cursor/mcp.json"), code("~/.cursor/mcp.json")).replace("claude_desktop_config.json", code("claude_desktop_config.json"));
  const CARD = 'class="st-card" style="display:flex;flex-direction:column;border:1px solid var(--hairline);background:var(--card);border-radius:var(--radius);padding:18px 20px;"';
  // An app card's block follows its sentence; a wallet card's block sits on the row's shared baseline.
  const card = (a, blockStyle) => a.prompt ? `<div id="${esc(a.id)}" ${CARD}>
        <h3 ${H3}>${esc(a.name)}</h3>
        <div class="st-cols">
          <div>
            <p ${P}>${stepHtml(a)}</p>
            ${block(a.copy, a.copyName, "margin:0 0 12px")}
            <p ${P}>${esc(a.after)}</p>
          </div>
          <div>
            <p ${P}>${esc(a.then)}</p>
            <p class="st-ask" style="color:var(--ink);font-size:var(--fs-base);font-weight:600;line-height:1.6;margin:0 0 8px;">${esc(a.promptLabel)}</p>
            ${block(a.prompt, "the first prompt", "margin:0")}
          </div>
        </div>
      </div>` : `<div id="${esc(a.id)}" ${CARD}>
        <h3 ${H3}>${esc(a.name)}</h3>
        <p ${P}>${stepHtml(a)}</p>
        ${block(a.copy, `${a.name} setup`, blockStyle)}
      </div>`;
  const appCards = apps.map((a) => card(a, "margin:0")).join("\n      ");
  const walletCards = wallet.apps.map((a) => card(a)).join("\n      ");

  const appsLead = viaCredits
    ? `<p class="ml-measure" ${P}>This address pays for paid tools from a credits balance you buy by card: the app asks you to sign in with your email, and you set a daily cap. Free tools run there too. To use only the free tools, give the app ${code(hosted)} instead.</p>`
    : `<p class="ml-measure" ${P}>This connector runs the free tools with no wallet and no signup.${credits ? " Paid tools take a credits key or a wallet (below)." : " Paid tools take a wallet (below)."}</p>`;

  const noWallet = [
    powCount ? `<li><strong>Free tools.</strong> ${powCount} tools run free on the connector above, rate-limited, with no wallet and no signup. <a href="/tools" ${A}>Browse the tools</a> or <a href="/recipes" ${A}>things you can do</a>.</li>` : "",
    reportRange ? `<li><strong>Reports by card.</strong> Finished, model-backed reports at <a href="/reports" ${A}>/reports</a>, ${esc(reportRange.text)} by card.</li>` : "",
    credits ? `<li><strong>Credits by card.</strong> Prepaid credits at <a href="/credits" ${A}>/credits</a>: ${viaCredits ? "the connector above pays from your balance after an email sign-in, and " : ""}a credits key pays for most paid tools with no wallet.</li>` : "",
  ].filter(Boolean).join("\n        ");

  const walletSection = `<section id="fund" style="margin-bottom:24px;">
      <h2 ${H2}>Pay from a wallet</h2>
      <p class="ml-measure" ${P}>A wallet pays through the Agent402 npm server, which runs on your computer and needs Node.js. ${esc(wallet.warning)}</p>
      <p class="ml-measure" ${P}>No wallet yet? Run ${code(WALLET_NEW_COMMAND)} on your computer: it makes one, stores the key (never shown) and prints the address to fund.</p>
      <ol class="ml-measure" style="padding-left:22px;margin:0 0 16px;color:var(--ink);font-size:var(--fs-base);line-height:1.6;">
        <li style="margin:0 0 8px;">Create a new wallet in a wallet app and copy its private key.</li>
        <li style="margin:0 0 8px;">Buy USDC on Base and send it to that wallet's address. Where you buy it, choose Base as the network.</li>
        <li style="margin:0 0 8px;">Check the balance: open ${code(`${explorer}/address/<your address>`)} and find USDC under the token holdings.</li>
        <li style="margin:0 0 8px;">Run this once in a terminal. It asks for the key (the input is hidden), keeps it in your system's keychain, and prints the setup for each app:</li>
      </ol>
      ${block(wallet.setup, "Wallet setup")}
      <p class="ml-measure" ${P}>${esc(SETUP_DAY_CAP_SENTENCE)}</p>
      <p class="ml-measure" style="color:var(--muted);font-size:var(--fs-base);line-height:1.6;margin:16px 0 12px;">Then add the npm server to your app:</p>
      <div class="st-grid" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:16px;">
      ${walletCards}
      </div>
      <p class="ml-measure" ${P}>${esc(BASE_NO_GAS_PLAIN)}</p>
      <p class="ml-measure" ${P}>More on paying from a wallet: <a href="/how-to-pay" ${A}>how to pay</a>.</p>
    </section>`;

  const pageLd = { "@context": "https://schema.org", "@type": "HowTo", name: title, description, url: canonical, author: siteOrgRef(baseUrl),
    step: [...apps, ...wallet.apps].map((a) => ({ "@type": "HowToStep", name: a.name, text: [a.step, a.copy, ...(a.prompt ? [a.after, a.then, a.promptLabel, a.prompt] : [])].join(" ") })) };

  const body = `
  <div style="max-width:1180px;margin:0 auto;padding:50px 30px 64px;">
    <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:1.02;margin:0 0 40px;text-wrap:balance;">${esc(START_TITLE)}</h1>

    <section id="apps" style="margin-bottom:56px;">
      <h2 ${H2}>${viaCredits ? "Add Agent402 and pay by card" : "Add Agent402 to your app"}</h2>
      ${appsLead}
      <div class="st-grid" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;">
      ${appCards}
      </div>
    </section>

    ${noWallet ? `<section id="no-wallet" style="margin-bottom:56px;">
      <h2 ${H2}>Without a wallet</h2>
      <ul class="ml-ticks ml-measure" style="font-size:var(--fs-base);line-height:1.6;">
        ${noWallet}
      </ul>
    </section>` : ""}

    ${walletSection}
  </div>
  ${ledgerFooterCompact()}`;

  // The copy buttons are this page's only body buttons, and a newcomer taps them
  // on a phone: each is a 44px target. The phone card is the first row, its
  // browser steps beside its app steps; the one-line terminal command has the
  // last row to itself, so no card is stretched to a taller neighbor. At phone
  // width everything stacks.
  const extraCss = `main .ml-code-copy{min-height:44px;min-width:44px}.st-tok{white-space:nowrap}#${START_PHONE_ID},#claude-code{grid-column:1/-1}.st-cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 28px}@media (max-width:900px){.st-grid,.st-cols{grid-template-columns:minmax(0,1fr)!important}}`;
  return ledgerShell({ title, description, canonical, baseUrl, activePath: START_PATH, jsonLd: [pageLd], extraCss, body });
}
