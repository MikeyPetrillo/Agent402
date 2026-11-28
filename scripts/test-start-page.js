#!/usr/bin/env node
// /start and the Base gas fact.
//
//   node scripts/test-start-page.js
//
// Offline renders, then one FREE_MODE boot of the real server.
//   - /start gives one step per app (Claude desktop, Claude Code, Cursor), each
//     read from mcpInstallHints (the connector's own install lines, with the
//     package version derived, never typed), and names no app this server's
//     docs do not give a path for.
//   - Each offer reads its switch: the card report line only with the
//     storefront on, the credits line only with credits on sale; the free
//     tool count is the catalog's proof-of-work count.
//   - The Base gas sentence (src/base-no-gas.js) is on /start, the /base page
//     (and on no other chain page), the Base line of /llms.txt, the hosted
//     connector's payment.info, the README, the wiki pages on paying and
//     getting started, and the agent402-client README.
//   - /start is in the docs nav, the sitemap, /llms.txt and the page dates.
//   - The phone path is an app entry like the others: the hosted address, or
//     the credits connector address only with credits on sale and the sign-in
//     on; no card or credits word with sales off; its first prompt names a
//     tool on the free list, and that tool answers through a local /mcp.
//   - /faq answers the newcomer's four questions; each reads its switch, the
//     structured data carries the visible answers, and the data answer's
//     sentences are on /privacy.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { jsonLdBlocks } from "./lib/html-text.js";
import { pageText } from "./lib/html-text.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bootServer } from "./lib/boot-server.js";

const { startPage, startApps, START_PATH, START_FIRST_PROMPT, START_PHONE_ID, START_TEAM_NOTE } = await import("../src/start-page.js");
const { FREE_TIER_SLUGS } = await import("../src/free-tier.js");
const { createHash } = await import("node:crypto");
const { BASE_NO_GAS_SENTENCE, BASE_NO_GAS_SHORT, BASE_NO_GAS_PLAIN } = await import("../src/base-no-gas.js");
const { mcpInstallHints, AGENT402_MCP_VERSION } = await import("../src/mcp-flagship.js");
const { HUMAN_PRODUCTS } = await import("../src/human-checkout.js");
const { NAV_PRIMARY_ACTION } = await import("../src/ledger-chrome.js");
const { cardReportPriceRange } = await import("../src/report-tiers.js");

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ORIGIN = "https://agent402.tools";
// What a reader sees (scripts/lib/html-text.js: case-blind, stripped until stable).
const plain = (html) => pageText(html);

// ---- offline renders ----------------------------------------------------------
const catalog = {
  "POST /api/hash": { slug: "hash", route: "POST /api/hash", price: "$0.001" },
  "POST /api/uuid": { slug: "uuid", route: "POST /api/uuid", price: "$0.001" },
  "POST /api/render": { slug: "render", route: "POST /api/render", price: "$0.005" },
};
const { isComputePayable } = await import("../src/pow.js");
const powCount = Object.values(catalog).filter(isComputePayable).length;
const install = mcpInstallHints(ORIGIN);
const range = cardReportPriceRange(HUMAN_PRODUCTS);

const allOn = plain(startPage(ORIGIN, catalog, { credits: true, connector: true, storefront: true }));
const allOff = plain(startPage(ORIGIN, catalog, { credits: false, connector: false, storefront: false }));
const creditsOnly = plain(startPage(ORIGIN, catalog, { credits: true, connector: false, storefront: true }));
const CONNECTOR_URL = `${ORIGIN}/mcp/credits`;

const apps = startApps(ORIGIN);
ok(apps.map((a) => a.name).join() === "On your phone,Claude desktop,Cursor,Claude Code", `one step per app, in order (${apps.map((a) => a.name).join(", ")})`);
{
  // The phone path, in both switch states, from the same list the page renders.
  const offHtml = startPage(ORIGIN, catalog, { credits: false, connector: false, storefront: false });
  const onHtml = startPage(ORIGIN, catalog, { credits: true, connector: true, storefront: true });
  const phoneOff = apps.find((a) => a.id === START_PHONE_ID), phoneOn = startApps(ORIGIN, { connector: true }).find((a) => a.id === START_PHONE_ID);
  const cardOf = (html) => { const at = html.indexOf(`id="${START_PHONE_ID}"`); return at < 0 ? "" : plain(html.slice(at, html.indexOf('<div id="', at + 10) > 0 ? html.indexOf('<div id="', at + 10) : html.indexOf("</section>", at))); };
  ok(phoneOff?.copy === install.hostedUrl && cardOf(offHtml).includes(install.hostedUrl) && !cardOf(offHtml).includes("/mcp/credits"), "sales off: the phone card pastes the hosted connector address");
  ok(phoneOn?.copy === CONNECTOR_URL && cardOf(onHtml).includes(CONNECTOR_URL), "credits and the sign-in on: the phone card pastes the credits connector address");
  ok(phoneOff && !/card|credit/i.test(`${phoneOff.step} ${phoneOff.after} ${phoneOff.then} ${phoneOff.promptLabel}`) && /free tools run from your phone with no wallet/.test(phoneOff.then) && /paid tools run from a computer with a wallet/.test(phoneOff.then), "sales off: the phone steps say what runs with no wallet and offer no card or credits");
  ok(phoneOn && /A card pays for most paid tools/.test(phoneOn.then) && /sign in with your email/.test(phoneOn.after) && cardOf(onHtml).includes("A card pays for most paid tools"), "credits and the sign-in on: the phone steps say a card pays for paid tools after an email sign-in");
  ok([offHtml, onHtml].every((h) => plain(h).includes(START_TEAM_NOTE)) && readFileSync(join(ROOT, "wiki/MCP-Connector.md"), "utf8").includes("an Owner adds it under Organization settings → Connectors → Add → Custom → *Web*"), "both switch states: /start says an Owner adds the connector on Team and Enterprise plans, and the wiki gives that path");
  // The meta description offers card payment only while a card offer is on the page.
  const metaOf = (html) => (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
  const storeOnlyHtml = startPage(ORIGIN, catalog, { credits: false, connector: false, storefront: true });
  const creditsNoConnHtml = startPage(ORIGIN, catalog, { credits: true, connector: false, storefront: false });
  ok(metaOf(offHtml) && !/card/i.test(metaOf(offHtml)) && /with USDC on Base/.test(metaOf(offHtml)), `every switch off: the meta description offers no card (${metaOf(offHtml)})`);
  ok([onHtml, storeOnlyHtml, creditsNoConnHtml].every((h) => /pay by card or with USDC on Base/.test(metaOf(h))), "the card storefront or credits on sale: the meta description offers card payment");
  ok(phoneOff && /claude\.ai/.test(phoneOff.step) && /Add custom connector/.test(phoneOff.step) && /Claude app/.test(phoneOff.then), "the phone steps add the connector in the browser and use it in the Claude app");
  ok(FREE_TIER_SLUGS.has(START_FIRST_PROMPT.slug) && isComputePayable({ slug: START_FIRST_PROMPT.slug, route: "POST /api/x", price: "$0.001" }), `the first prompt's tool is on the free list (${START_FIRST_PROMPT.slug})`);
  ok(phoneOff?.prompt === START_FIRST_PROMPT.text && cardOf(offHtml).includes(START_FIRST_PROMPT.text) && cardOf(onHtml).includes(START_FIRST_PROMPT.text), "the phone card ends on the first prompt, in both states");
  ok(/data-name="the connector address"/.test(offHtml) && /data-name="the first prompt"/.test(offHtml), "the address and the prompt sit in code blocks (each gets a copy button)");
  const ld = JSON.parse(jsonLdBlocks(offHtml).find((j) => /"HowTo"/.test(j)));
  const step = ld.step.find((x) => x.name === "On your phone");
  ok(step && step.text.includes(install.hostedUrl) && step.text.includes(START_FIRST_PROMPT.text) && !/credit/i.test(JSON.stringify(ld)), "the page's structured data carries the phone step and offers no credits with sales off");
  ok(/<p class="st-ask"[^>]*>Ask this to check the connection:<\/p>\s*<div class="ml-code[^"]*" data-name="the first prompt"/.test(offHtml) && phoneOff.promptLabel === "Ask this to check the connection:", "the prompt's label is its own line, directly above the prompt block");
  const { CONNECTOR_MENU_STEP } = await import("../src/start-page.js");
  ok(apps.find((a) => a.id === "claude-desktop").step === CONNECTOR_MENU_STEP && /Customize, then Connectors/.test(CONNECTOR_MENU_STEP) && /Customize, then Connectors/.test(phoneOff.step), "the desktop and phone steps name the same menu path");
  const printed = ["README.md", "wiki/MCP-Connector.md", "wiki/Getting-Started.md", "mcp/README.md", "llms-install.md"].map((f) => [f, readFileSync(join(ROOT, f), "utf8")]);
  ok(printed.every(([, t]) => !/Settings\s*(→|>|,|->)\s*(open )?Connectors/.test(t)) && printed.filter(([, t]) => /Customize → Connectors/.test(t)).length === printed.length, `every printed copy of the menu path agrees (${printed.filter(([, t]) => !/Customize → Connectors/.test(t)).map(([f]) => f).join(", ") || "all"})`);
}
ok(apps.find((a) => a.id === "claude-desktop").copy === install.hostedUrl && allOff.includes(install.hostedUrl), "Claude desktop pastes the hosted connector address from the install hints");
ok(apps.find((a) => a.id === "claude-code").copy === install.claudeCodeHosted && allOff.includes(install.claudeCodeHosted), "Claude Code runs the hosted install line from the install hints");
ok(apps.find((a) => a.id === "cursor").copy === `"agent402": ${JSON.stringify(install.cursorMcpJson.mcpServers.agent402, null, 2)}` && allOff.includes('"url": "https://agent402.tools/mcp"'), "Cursor adds the install hints' agent402 entry, the server alone");
// Each config step says "add this agent402 entry under mcpServers", so the block is that entry, never the wrapper around it.
for (const [label, html] of [["all off", allOff], ["all on", allOn]]) ok(!/"mcpServers"/.test(html), `${label}: no config block repeats the mcpServers wrapper the step names`);
ok(/^claude mcp add --transport http -s user agent402 \S+\/mcp$/.test(install.claudeCodeHosted) && / -s user /.test(install.claudeCodeNpm), `the hosted Claude Code line adds the server for the user, like the npm line (${install.claudeCodeHosted})`);
ok(NAV_PRIMARY_ACTION.label === "Add to your agent" && NAV_PRIMARY_ACTION.href === START_PATH, `the header's Add to your agent goes to the page that adds it (${NAV_PRIMARY_ACTION.href})`);
ok(!/ChatGPT/i.test(allOn), "names no app without a documented path");
{
  const src = readFileSync(join(ROOT, "src/start-page.js"), "utf8");
  ok(!/agent402-mcp@\d/.test(src) && !src.includes(AGENT402_MCP_VERSION) && !/https:\/\/agent402\.tools/.test(src), "the page module types no package version and no host");
}
ok(powCount > 0 && allOn.includes(`${powCount} tools run free on the connector above`), `the free tool count is the catalog's proof-of-work count (${powCount})`);
ok(!/proof of work|proof-of-work|EIP-3009|facilitator/i.test(plain(allOn) + plain(allOff)), "the page a newcomer reads names no proof of work, EIP or facilitator");
ok(allOn.includes(`Credits by card.`) && allOn.includes("/credits"), "credits on sale: the credits line is there");
ok(!/credits/i.test(allOff), "credits not on sale: the page says nothing about credits");
ok(allOn.includes(CONNECTOR_URL), "credits on sale and the connector sign-in on: the credits line names the credits connector address");
ok(creditsOnly.includes("Credits by card.") && !creditsOnly.includes("/mcp/credits"), "credits on sale, connector sign-in off: no credits connector address");
{
  // The switches themselves: the default render reads both, and names the address only with both on.
  const keep = { CREDITS_SALES: process.env.CREDITS_SALES, MCP_OAUTH: process.env.MCP_OAUTH };
  const render = (sales, oauth) => {
    if (sales == null) delete process.env.CREDITS_SALES; else process.env.CREDITS_SALES = sales;
    if (oauth == null) delete process.env.MCP_OAUTH; else process.env.MCP_OAUTH = oauth;
    return plain(startPage(ORIGIN, catalog));
  };
  ok(render("on", "on").includes(CONNECTOR_URL), "CREDITS_SALES=on and MCP_OAUTH=on: the default render names the credits connector");
  ok(!render("on", null).includes("/mcp/credits"), "MCP_OAUTH unset: the default render does not name it");
  ok(!render(null, "on").includes("/mcp/credits"), "CREDITS_SALES unset: the default render does not name it");
  for (const [k, v] of Object.entries(keep)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
}
{
  const src = readFileSync(join(ROOT, "src/start-page.js"), "utf8");
  ok(!/\$\d/.test(src.replace(/\$\{/g, "")), "the page module types no dollar amount");
}
ok(range && allOn.includes(`Reports by card.`) && allOn.includes(`${range.text} by card`) && allOn.includes("model-backed"), `storefront on: the report line quotes the product table's range (${range?.text}) and says model-backed`);
ok(!/Reports by card/.test(allOff) && !allOff.includes("/reports"), "storefront off: no report line");
ok(allOff.includes("Without a wallet") && allOff.includes("Free tools."), "the free tools stay with both switches off");
ok(allOn.includes("Pay from a wallet") && allOn.includes("Buy USDC on Base") && allOn.includes("basescan.org/address/<your address>"), "the wallet section: buy USDC on Base, send it, check the balance");
{
  // A funded wallet must end in a working connection: the npm server (Node.js
  // named), set up once with the key in the keychain, then a config per app.
  const { walletSetup } = await import("../src/start-page.js");
  const w = walletSetup(ORIGIN);
  const desktop = w.apps.find((a) => a.id === "wallet-claude-desktop");
  const cfg = JSON.parse(`{${desktop.copy}}`).agent402;
  ok(w.setup === `${install.npm} setup` && allOn.includes(w.setup) && allOff.includes(w.setup), `the wallet section gives the setup command (${w.setup})`);
  ok(/Node\.js/.test(allOff) && /keychain/.test(allOff), "it says the npm server needs Node.js and keeps the key in the keychain");
  ok(cfg.command === "npx" && cfg.args.join(" ").includes(`agent402-mcp@${AGENT402_MCP_VERSION}`) && !cfg.env, "the Claude desktop wallet config runs the pinned npm server and carries no key");
  ok(w.apps.map((a) => a.name).sort().join() === "Claude Code,Claude desktop,Cursor" && w.apps.every((a) => allOff.includes(a.copy.split("\n")[0].trim())), "every app the page names has a wallet setup on the page");
  ok(w.apps.find((a) => a.id === "wallet-claude-code").copy === install.claudeCodeNpm, "Claude Code's wallet line is the install hints' npm line");
  // Card first while credits and the connector are on.
  const on = startPage(ORIGIN, catalog, { credits: true, connector: true, storefront: true });
  const appsOn = startApps(ORIGIN, { connector: true });
  ok(appsOn.find((a) => a.id === "claude-desktop").copy === CONNECTOR_URL && on.indexOf('id="apps"') < on.indexOf('id="fund"') && /pay by card/i.test(plain(on).slice(0, plain(on).indexOf("Pay from a wallet"))), "credits and the connector on: the app cards give the credits connector first, before the wallet section");
  ok(plain(on).includes(install.hostedUrl) && /free tools/i.test(plain(on)), "the hosted /mcp address is still named, for the free tools");
  ok(/class="ml-code[^"]*"[^>]*data-name="Claude desktop setup"/.test(on) && /data-name="Wallet setup"/.test(on), "commands sit in code blocks (each gets a copy button)");
}
ok(allOn.includes(BASE_NO_GAS_PLAIN) && allOff.includes(BASE_NO_GAS_PLAIN) && !allOn.includes(BASE_NO_GAS_SENTENCE), "the page states the Base gas fact in plain words (the technical sentence stays on /base)");

// ---- the credits pages name the connector while it is on ----------------------
{
  const { creditsPage, creditsThanksPage } = await import("../src/credits-page.js");
  const { balanceName } = await import("../src/credits-account-page.js");
  const on = creditsPage(ORIGIN, true, catalog, { connector: true });
  const off = creditsPage(ORIGIN, true, catalog, { connector: false });
  ok(plain(on).includes(CONNECTOR_URL) && !plain(off).includes(CONNECTOR_URL), "/credits names the credits connector address only while the connector is on");
  ok(creditsThanksPage("cs_x", ORIGIN, { connector: true }).includes(`data-connector="${CONNECTOR_URL}"`) && !/data-connector=/.test(creditsThanksPage("cs_x", ORIGIN, { connector: false })), "the page after purchase carries the connector address only while it is on");
  const a = { keyId: "025c9fb4de8f", createdAt: "2026-11-23T10:00:00Z" }, b = { keyId: "7a1100aa9e01", createdAt: "2026-11-23T20:00:00Z" }, c = { keyId: "00aa11bb22cc", createdAt: "2026-10-01T00:00:00Z" };
  ok(balanceName(a, [a, c]) === "Balance bought Nov 23, 2026" && balanceName(a, [a, b]) === "Balance bought Nov 23, 2026 (de8f)" && balanceName(b, [a, b]) === "Balance bought Nov 23, 2026 (9e01)", "a balance is named by its purchase day, with the key id's last four only beside a same-day twin");
}

// ---- /faq: the newcomer's four questions ---------------------------------------
{
  const { faqItems, faqPage, FAQ_FREE_Q, FAQ_CRYPTO_Q, FAQ_PHONE_Q, FAQ_DATA_Q, faqDataSentences } = await import("../src/pages.js");
  const { setPublicIndexOfferedChains } = await import("../src/facilitator-public-index.js");
  const { privacyPage } = await import("../src/privacy.js");
  const off = faqItems({ creditsOnSale: false, connector: false, storefront: false });
  const on = faqItems({ creditsOnSale: true, connector: true, storefront: true });
  const salesOnly = faqItems({ creditsOnSale: true, connector: false, storefront: false });
  const a = (items, q) => items.find((it) => it.q === q)?.a || "";
  for (const q of [FAQ_FREE_Q, FAQ_CRYPTO_Q, FAQ_PHONE_Q, FAQ_DATA_Q]) ok(off.filter((it) => it.q === q).length === 1 && a(off, q).length > 40, `/faq answers "${q}" once`);
  ok([FAQ_FREE_Q, FAQ_CRYPTO_Q, FAQ_PHONE_Q].every((q) => !/credit|card|\/reports/i.test(a(off, q))), "every switch off: the free, crypto and phone answers offer no card, credits or reports");
  ok(a(on, FAQ_CRYPTO_Q).includes('href="/reports"') && a(on, FAQ_CRYPTO_Q).includes('href="/credits"') && !a(salesOnly, FAQ_CRYPTO_Q).includes("/reports") && a(salesOnly, FAQ_CRYPTO_Q).includes("/credits"), "the crypto answer names card reports and credits each by its own switch");
  ok(/most paid tools by card from a credits balance/.test(a(on, FAQ_PHONE_Q)) && !/card|credit/i.test(a(salesOnly, FAQ_PHONE_Q)) && /Paid tools run from a computer with a wallet/.test(a(salesOnly, FAQ_PHONE_Q)), "the phone answer says a card pays only with credits on sale and the connector sign-in on");
  ok([off, on].every((items) => a(items, FAQ_PHONE_Q).includes(`href="${START_PATH}#${START_PHONE_ID}"`)) && startPage(ORIGIN, catalog).includes(`id="${START_PHONE_ID}"`), "the phone answer links the phone card on /start");
  ok(!/\$\d/.test(a(off, FAQ_FREE_Q) + a(off, FAQ_CRYPTO_Q) + a(off, FAQ_PHONE_Q) + a(off, FAQ_DATA_Q)) && a(off, FAQ_FREE_Q).includes('href="/pricing"'), "the four answers type no price; the free answer links /pricing");
  // Both states of the facilitator public index disclosure: /privacy scopes its
  // no-sale sentence while the disclosure renders, and the FAQ says the same.
  const prevChains = process.env.FACILITATOR_PUBLIC_INDEX_CHAINS;
  for (const chains of ["", "robinhood"]) {
    if (chains) process.env.FACILITATOR_PUBLIC_INDEX_CHAINS = chains; else delete process.env.FACILITATOR_PUBLIC_INDEX_CHAINS;
    setPublicIndexOfferedChains(chains ? [chains] : []);
    const privacy = plain(privacyPage(ORIGIN));
    const answer = a(faqItems({ creditsOnSale: false, connector: false, storefront: false }), FAQ_DATA_Q);
    const sentences = faqDataSentences();
    const label = chains ? "public index listed" : "public index unset";
    ok(sentences.length === 3 && sentences.every((s) => privacy.includes(s) && answer.includes(s)) && answer.includes('href="/privacy"'), `${label}: the data answer links /privacy and its sentences are on /privacy word for word`);
    ok(chains ? /beyond what this list describes/.test(answer) : /or any other purpose\./.test(answer), `${label}: the data answer's no-sale sentence is /privacy's for that state`);
    ok(/AI model provider/.test(answer) && /forwarded to the upstream model\s+provider/.test(privacy) && answer.includes('href="/privacy#third-parties"'), `${label}: the data answer says model-backed tools forward input to the model provider, as /privacy does`);
  }
  if (prevChains === undefined) delete process.env.FACILITATOR_PUBLIC_INDEX_CHAINS; else process.env.FACILITATOR_PUBLIC_INDEX_CHAINS = prevChains;
  setPublicIndexOfferedChains([]);
  // The structured data and the page a reader sees carry the same answers.
  const html = faqPage(ORIGIN);
  const ld = jsonLdBlocks(html).map((b) => JSON.parse(b)).flat().find((j) => j["@type"] === "FAQPage");
  const seen = plain(html);
  const qs = (ld?.mainEntity || []).map((e) => e.name);
  ok(ld && [FAQ_FREE_Q, FAQ_CRYPTO_Q, FAQ_PHONE_Q, FAQ_DATA_Q].every((q) => qs.includes(q)) && new Set(qs).size === qs.length, `the FAQ structured data parses and holds the four questions once each (${qs.length} questions)`);
  ok(ld && ld.mainEntity.every((e) => e["@type"] === "Question" && e.acceptedAnswer?.["@type"] === "Answer" && seen.includes(plain(`<p>${e.name}</p>`)) && seen.includes(plain(`<p>${e.acceptedAnswer.text}</p>`))), "every structured answer is the answer the page shows");
}

// ---- the static trees --------------------------------------------------------
for (const f of ["README.md", "wiki/Paying-with-x402.md", "wiki/Getting-Started.md", "client/README.md"]) {
  ok(readFileSync(join(ROOT, f), "utf8").includes(BASE_NO_GAS_SENTENCE), `${f} states the Base gas sentence`);
}
{
  const dates = readFileSync(join(ROOT, "src/page-dates.js"), "utf8");
  ok(/"\/start": \["src\/start-page\.js"/.test(dates), "/start has a page-dates entry");
}

// ---- one boot ------------------------------------------------------------------
const srv = await bootServer({ stores: "start-page", env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" } });
let client;
try {
  const get = async (p) => { const r = await fetch(srv.url + p); return { status: r.status, text: await r.text() }; };
  const start = await get(START_PATH);
  ok(start.status === 200 && /<title>Start here/.test(start.text), "/start answers 200 with its title");
  const startText = plain(start.text);
  ok(/claude mcp add --transport http -s user agent402 https?:\/\/\S+\/mcp/.test(startText), "the served page carries the Claude Code line");
  ok(!/Credits by card/.test(startText), "the served page offers no credits while CREDITS_SALES is unset");
  ok(start.text.includes(BASE_NO_GAS_PLAIN), "the served page states the Base gas fact in plain words");

  const home = await get("/");
  ok(/href="\/start" class="mlnav-row"/.test(home.text), "the docs nav panel links /start");

  const base = await get("/base");
  ok(base.status === 200 && base.text.includes(BASE_NO_GAS_SENTENCE), "/base states the Base gas sentence");
  for (const p of ["/ink", "/arc", "/solana"]) {
    const r = await get(p);
    ok(r.status === 200 && !r.text.includes(BASE_NO_GAS_SENTENCE), `${p} does not carry the Base sentence`);
  }

  const llms = await get("/llms.txt");
  const baseLine = llms.text.split("\n").find((l) => l.startsWith("- [Base](")) || "";
  const llmsLines = llms.text.split("\n");
  const gasAt = llmsLines.indexOf(BASE_NO_GAS_SHORT);
  ok(gasAt > 0 && /^- \[[^\]]+\]\([^)]+\): /.test(llmsLines[gasAt - 1]) && llmsLines.slice(llmsLines.indexOf("## Settlement chains"), gasAt).includes(baseLine), `/llms.txt states the short Base gas sentence on its own line after the settlement chains (line ${gasAt})`);
  ok(baseLine && !baseLine.includes("ETH") && llmsLines.filter((l) => l.includes(BASE_NO_GAS_SHORT)).length === 1, "the Base chain line stays chain, asset and id; the sentence appears once");
  ok(/^- \[Start here\]\(\S+\/start\): /m.test(llms.text), "/llms.txt links /start under Connect via MCP");
  ok(/^- \[Start here\]\(\S+\/start\): [^\n]*phone/m.test(llms.text), "/llms.txt says /start covers a phone");
  ok(new RegExp(`id="${START_PHONE_ID}"`).test(start.text) && startText.includes(START_FIRST_PROMPT.text) && !/credit/i.test(startText), "the served page carries the phone card and its first prompt, and no credits word while CREDITS_SALES is unset");
  const faq = await get("/faq");
  ok(faq.status === 200 && /Does it work on my phone\?/.test(faq.text) && new RegExp(`href="${START_PATH}#${START_PHONE_ID}"`).test(faq.text), "the served /faq answers the phone question and links the phone card");

  const pages = await get("/sitemap-pages.xml");
  const all = await get("/sitemap.xml");
  ok(/<loc>[^<]*\/start<\/loc>/.test(pages.text) && /<loc>[^<]*\/start<\/loc>/.test(all.text), "both sitemaps list /start");

  client = new Client({ name: "test-start-page", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
  const pi = await client.callTool({ name: "payment.info", arguments: {} });
  const info = pi.structuredContent || JSON.parse(pi.content?.[0]?.text || "{}");
  ok(info.pay?.baseGas === BASE_NO_GAS_SENTENCE, "payment.info states the Base gas sentence (pay.baseGas)");
  ok(/\/start$/.test(String(info.pay?.start || "")), "payment.info points at /start");
  ok(info.credits && !("connector" in info.credits), "payment.info names no credits connector while CREDITS_SALES and MCP_OAUTH are unset");
  // The first prompt's tool, run the way a connected app runs it, on the connector.
  const run = await client.callTool({ name: "catalog.call", arguments: { slug: START_FIRST_PROMPT.slug, params: START_FIRST_PROMPT.input } });
  const want = createHash("sha256").update(START_FIRST_PROMPT.input.text).digest("hex");
  ok(!run.isError && JSON.stringify(run.structuredContent || run.content).includes(want) && START_FIRST_PROMPT.text.includes(START_FIRST_PROMPT.input.text), `the first prompt's tool answers on a local /mcp (${START_FIRST_PROMPT.slug}: ${want.slice(0, 12)}…)`);
  const pricing = await (await fetch(`${srv.url}/api/pricing`)).json();
  const row = (pricing.tools || pricing.endpoints || []).find((t) => t.slug === START_FIRST_PROMPT.slug);
  ok(row && (row.computePayable === true || row.free === true), `the live catalog lists that tool as free with compute (${JSON.stringify(row && { computePayable: row.computePayable })})`);
} finally {
  try { await client?.close(); } catch {}
  await srv.stop();
}

// ---- a boot with credits on sale and the connector sign-in off: no connector line ----
{
  const srv3 = await bootServer({ stores: "start-page-sales-only", env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", CREDITS_SALES: "on", MCP_OAUTH: "", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" } });
  let c3;
  try {
    c3 = new Client({ name: "test-start-page", version: "0.0.0" });
    await c3.connect(new StreamableHTTPClientTransport(new URL(`${srv3.url}/mcp`)));
    const pi = await c3.callTool({ name: "payment.info", arguments: {} });
    const info = pi.structuredContent || JSON.parse(pi.content?.[0]?.text || "{}");
    ok(info.credits?.onSale === true && !("connector" in info.credits), `CREDITS_SALES on, MCP_OAUTH off: payment.info sells credits and names no connector (${JSON.stringify(Object.keys(info.credits || {}))})`);
    const page = await (await fetch(`${srv3.url}${START_PATH}`)).text();
    ok(/Credits by card/.test(page) && !/\/mcp\/credits/.test(page), "CREDITS_SALES on, MCP_OAUTH off: /start offers credits and names no connector");
  } finally {
    try { await c3?.close(); } catch {}
    await srv3.stop();
  }
}

// ---- a boot with both switches on: payment.info names the credits connector ----
const srv2 = await bootServer({ stores: "start-page-connector", env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", CREDITS_SALES: "on", MCP_OAUTH: "on", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" } });
let client2;
try {
  client2 = new Client({ name: "test-start-page", version: "0.0.0" });
  await client2.connect(new StreamableHTTPClientTransport(new URL(`${srv2.url}/mcp`)));
  const pi = await client2.callTool({ name: "payment.info", arguments: {} });
  const info = pi.structuredContent || JSON.parse(pi.content?.[0]?.text || "{}");
  ok(/\/mcp\/credits$/.test(String(info.credits?.connector || "")), `payment.info names the credits connector with both switches on (${info.credits?.connector})`);
  const r = await fetch(`${srv2.url}${START_PATH}`);
  ok(/\/mcp\/credits/.test(await r.text()), "the served /start names the credits connector with both switches on");
} finally {
  try { await client2?.close(); } catch {}
  await srv2.stop();
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
