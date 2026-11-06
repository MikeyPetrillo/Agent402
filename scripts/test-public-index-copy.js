#!/usr/bin/env node
// FACILITATOR_PUBLIC_INDEX_CHAINS (with _NAME, _POLICY_URL and _SINCE; ink is
// covered at the end, alone and with robinhood): while
// it lists robinhood, /privacy discloses that the facilitator that settles a
// Robinhood payment publishes it on its public index (every published field,
// the per-seller payer pages, permanence, where it is processed), the no-sale
// line is scoped to that list, /terms points to it, /.well-known/x402 carries
// publicSettlementIndex, llms.txt and the Robinhood rail page say it, and the
// legal pages print the later of their own date and the disclosure's. Any
// other value (solana included) renders nothing and warns at boot. Every page
// reads the switch at render time, so each case renders them again.
//   node scripts/test-public-index-copy.js        (offline, no server)
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { pageText } from "./lib/html-text.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const { privacyPage } = await import("../src/privacy.js");
const { termsPage } = await import("../src/terms.js");
const { serviceManifest } = await import("../src/discovery.js");
const { llmsTxt } = await import("../src/seo.js");
const { marketPage } = await import("../src/market-page.js");
const { publicIndexBootWarnings, publicIndexPageDate, setPublicIndexBootFacilitator, setPublicIndexOfferedChains, publicIndexUnofferedWarnings } = await import("../src/facilitator-public-index.js");

const ENV = ["FACILITATOR_PUBLIC_INDEX_CHAINS", "FACILITATOR_PUBLIC_INDEX_NAME", "FACILITATOR_PUBLIC_INDEX_POLICY_URL", "FACILITATOR_PUBLIC_INDEX_SINCE", "ROBINHOOD_FACILITATOR_URL", "INK_FACILITATOR_URL"];
const setEnv = (vars) => { for (const k of ENV) { if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; } };
const BASE = "https://agent402.tools";
const DATE_LINE = /last updated (\d{4}-\d{2}-\d{2})\./;
const ownDate = (file) => (readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8").match(DATE_LINE) || [])[1];
const PRIVACY_OWN = ownDate("privacy.js"), TERMS_OWN = ownDate("terms.js");
const manifest = () => serviceManifest({ baseUrl: BASE, network: "base", networks: ["base", "robinhood"], wallet: "0x000000000000000000000000000000000000dEaD", walletName: null, catalog: {}, toolCount: 0, powSlugs: [], powDifficulty: 20, prices: {} });
// Every case below renders with both chains offered unless it names the offer.
const render = (vars, offered = ["robinhood", "ink"]) => {
  setEnv(vars);
  setPublicIndexOfferedChains(offered);
  const p = privacyPage(BASE), t = termsPage(BASE);
  return { p, t, pt: pageText(p), tt: pageText(t), m: manifest(), llms: llmsTxt(BASE, {}), rail: marketPage("robinhood", BASE, { snapshot: { sellers: [] }, rail: null, activity: null }) };
};
const dateOf = (html) => (html.match(DATE_LINE) || [])[1];

const FIELDS = "publishes each settlement it relays on its public index: payer and payee wallets, amount, time, transaction hash, the service name, and the endpoint host and price paid. It also keeps a page for each seller that lists that seller's frequent payers. Entries on that index are permanent and outside our control, and the data sent to it is processed where that facilitator operates. Pay on another chain to keep a payment off that index.";
const TERMS = "On Robinhood Chain, the facilitator that settles a payment publishes it on its public index, as the privacy policy describes.";
const NO_SALE_OFF = "We do not sell or share data with anyone for advertising or any other purpose.";
const NO_SALE_ON = "We do not sell or share data with anyone for advertising, or for any purpose beyond what this list describes.";
const ANY = /public index/;

// --- off: nothing anywhere ---------------------------------------------------
for (const value of [undefined, "", " , ", "base,stellar", "solana", "Solana"]) {
  const r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: value, ROBINHOOD_FACILITATOR_URL: "https://first.example.test", FACILITATOR_PUBLIC_INDEX_SINCE: "2026-11-05" });
  const tag = JSON.stringify(value ?? "unset");
  ok(!ANY.test(r.pt) && !r.p.includes('id="public-settlement-index"'), `privacy ${tag}: no paragraph`);
  ok(r.pt.includes(NO_SALE_OFF) && !r.pt.includes(NO_SALE_ON), `privacy ${tag}: the no-sale line is unchanged`);
  ok(!ANY.test(r.tt) && !r.t.includes("/privacy#public-settlement-index"), `terms ${tag}: no sentence`);
  ok(!("publicSettlementIndex" in r.m.payment.dataHandling), `/.well-known/x402 ${tag}: no payment.dataHandling.publicSettlementIndex`);
  ok(!ANY.test(r.llms) && !/public index/.test(pageText(r.rail)), `llms.txt and /robinhood ${tag}: nothing said`);
  ok(dateOf(r.p) === PRIVACY_OWN && dateOf(r.t) === TERMS_OWN, `${tag}: both pages keep their own dates though _SINCE is set`);
}
ok(TERMS_OWN === "2026-11-04", "terms keeps its own date: its ungated text did not change");

// --- robinhood: the paragraph, scoped no-sale line, terms, machine surfaces ---
for (const value of ["robinhood", " Robinhood ,solana", "robinhood,stellar"]) {
  const r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: value, ROBINHOOD_FACILITATOR_URL: "https://first.example.test/x402,https://second.example.test" });
  const tag = JSON.stringify(value);
  ok(r.pt.includes(`On Robinhood Chain, the facilitator that settles the payment (first.example.test) ${FIELDS}`), `privacy ${tag}: the paragraph, word for word, naming the first listed host`);
  ok(!r.pt.includes("second.example.test") && !/Solana/.test(r.pt.slice(r.pt.indexOf("public index") - 200, r.pt.indexOf("public index") + 900)), `privacy ${tag}: no later fallback and no other chain named`);
  ok((r.pt.match(/public index/g) || []).length === 1 && /<li id="public-settlement-index">/.test(r.p), `privacy ${tag}: one paragraph carrying the anchor`);
  ok(r.pt.includes(NO_SALE_ON) && !r.pt.includes(NO_SALE_OFF), `privacy ${tag}: the no-sale line is scoped to the list`);
  ok(r.tt.includes(TERMS) && (r.tt.match(/public index/g) || []).length === 1 && r.t.includes('<a href="/privacy#public-settlement-index">privacy policy</a>'), `terms ${tag}: the sentence once, linking the paragraph`);
  const idx = r.m.payment.dataHandling.publicSettlementIndex;
  ok(JSON.stringify(idx) === JSON.stringify({ chains: ["robinhood"], hosts: ["first.example.test"], policy: `${BASE}/privacy#public-settlement-index` }), `/.well-known/x402 ${tag}: publicSettlementIndex ${JSON.stringify(idx)}`);
  ok(r.llms.includes(`(\`eip155:4663\`); the facilitator that settles it publishes each settlement on its public index (${BASE}/privacy#public-settlement-index)`) && (r.llms.match(/public index/g) || []).length === 1, `llms.txt ${tag}: the Robinhood line says it, once`);
  ok(r.rail.includes('href="/privacy#public-settlement-index"') && /public index/.test(pageText(r.rail)), `/robinhood ${tag}: the rail manifest links it`);
  for (const [name, html] of [["privacy", r.p], ["terms", r.t]]) ok(!/—/.test(html), `${name} ${tag}: no em dash`);
}
{
  const r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", ROBINHOOD_FACILITATOR_URL: "https://first.example.test" });
  ok(!/public index/.test(pageText(marketPage("base", BASE, { snapshot: { sellers: [] }, rail: null, activity: null }))) && r.rail.includes("public-settlement-index"), "only the Robinhood rail page carries the row");
}

// --- the boot chose a later listed facilitator: every surface names that one --
{
  const LIST = "https://first.example.test/x402,https://second.example.test";
  setPublicIndexBootFacilitator("robinhood", "https://second.example.test/");
  let r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", ROBINHOOD_FACILITATOR_URL: LIST });
  ok(r.pt.includes(`On Robinhood Chain, the facilitator that settles the payment (second.example.test) ${FIELDS}`) && !r.pt.includes("first.example.test"), "boot chose the second: privacy names it, not the first listed");
  ok(JSON.stringify(r.m.payment.dataHandling.publicSettlementIndex.hosts) === JSON.stringify(["second.example.test"]), "boot chose the second: /.well-known/x402 names it");
  r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", ROBINHOOD_FACILITATOR_URL: "https://first.example.test" });
  ok(r.pt.includes("(first.example.test)"), "a boot choice no longer listed is ignored: the first listed is named");
  setPublicIndexBootFacilitator("robinhood", "");
  r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", ROBINHOOD_FACILITATOR_URL: LIST });
  ok(r.pt.includes("(first.example.test)"), "before boot: the first listed is named");
}

// --- name and policy URL: escaped, and linked only as a parsed https URL -----
{
  let r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", ROBINHOOD_FACILITATOR_URL: "https://first.example.test", FACILITATOR_PUBLIC_INDEX_NAME: "Example Relay", FACILITATOR_PUBLIC_INDEX_POLICY_URL: "https://first.example.test/privacy" });
  ok(r.p.includes('the facilitator that settles the payment (Example Relay, first.example.test, <a href="https://first.example.test/privacy" rel="noopener">its privacy policy</a>) publishes'), "name, host and policy link render beside each other");
  ok(r.pt.replace(/ \)/g, ")").includes(`(Example Relay, first.example.test, its privacy policy) ${FIELDS}`), "the paragraph text with all three (the text reader spaces inline links)");
  r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", ROBINHOOD_FACILITATOR_URL: "https://first.example.test", FACILITATOR_PUBLIC_INDEX_NAME: '<img src=x onerror=alert(1)>"Relay"', FACILITATOR_PUBLIC_INDEX_POLICY_URL: "javascript:alert(1)" });
  const li = r.p.slice(r.p.indexOf('id="public-settlement-index"'), r.p.indexOf('id="public-settlement-index"') + 1200);
  ok(!li.includes("<img") && li.includes("&lt;img src=x onerror=alert(1)&gt;&quot;Relay&quot;") && !li.includes("javascript:") && !li.includes("<a "), "the name is escaped; a javascript: URL is not linked");
  for (const bad of ["http://first.example.test/privacy", "https://user:pw@first.example.test/p", "not a url", "ftp://first.example.test/p"]) {
    r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", ROBINHOOD_FACILITATOR_URL: "https://first.example.test", FACILITATOR_PUBLIC_INDEX_POLICY_URL: bad });
    ok(!r.p.slice(r.p.indexOf('id="public-settlement-index"'), r.p.indexOf('id="public-settlement-index"') + 1200).includes("<a "), `policy ${JSON.stringify(bad)}: not linked`);
  }
  r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", ROBINHOOD_FACILITATOR_URL: "<script>alert(1)</script>" });
  ok(r.pt.includes(`On Robinhood Chain, the facilitator that settles the payment ${FIELDS}`) && !/script|alert/.test(r.p.slice(r.p.indexOf("public-settlement-index"), r.p.indexOf("public-settlement-index") + 900)), "an unparsable URL names no host and prints nothing of the raw value");
  ok(JSON.stringify(r.m.payment.dataHandling.publicSettlementIndex.hosts) === "[]", "the manifest names no host it cannot parse");
}

// --- dates: the later of the page's own and _SINCE, while it renders --------
{
  const later = "2026-11-05";
  let r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", ROBINHOOD_FACILITATOR_URL: "https://first.example.test", FACILITATOR_PUBLIC_INDEX_SINCE: later });
  ok(dateOf(r.t) === (later > TERMS_OWN ? later : TERMS_OWN) && dateOf(r.p) === (later > PRIVACY_OWN ? later : PRIVACY_OWN), `_SINCE ${later}: each page prints the later date (terms ${dateOf(r.t)}, privacy ${dateOf(r.p)})`);
  ok(dateOf(r.t) === "2026-11-05", "terms moves to the disclosure's date while it renders");
  r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", FACILITATOR_PUBLIC_INDEX_SINCE: "2026-01-01" });
  ok(dateOf(r.t) === TERMS_OWN && dateOf(r.p) === PRIVACY_OWN, "an earlier _SINCE leaves both dates");
  for (const bad of ["2026-02-30", "11/05/2026", "2026-11-5", "soon"]) {
    r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", FACILITATOR_PUBLIC_INDEX_SINCE: bad });
    ok(dateOf(r.t) === TERMS_OWN, `_SINCE ${JSON.stringify(bad)} is not a date: ignored`);
  }
  setEnv({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", FACILITATOR_PUBLIC_INDEX_SINCE: "2026-12-01" });
  ok(publicIndexPageDate("2026-11-04", process.env, "2026-11-30") === "2026-11-04" && publicIndexPageDate("2026-11-04", process.env, "2026-12-01") === "2026-12-01", "a future _SINCE applies only once its day is reached");
}

// --- boot warnings: the switch tied to the config ----------------------------
{
  const w = (vars) => { setEnv(vars); return publicIndexBootWarnings().join("\n"); };
  ok(/lists solana: only robinhood and ink are known; nothing renders for it/.test(w({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood,solana", ROBINHOOD_FACILITATOR_URL: "https://a.example.test" })), "solana listed: a boot warning names it");
  ok(/lists robinhood but ROBINHOOD_FACILITATOR_URL has no parsable first host/.test(w({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood" })), "robinhood with no facilitator URL: a boot warning");
  ok(/lists robinhood but ROBINHOOD_FACILITATOR_URL has no parsable first host/.test(w({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", ROBINHOOD_FACILITATOR_URL: "not a url" })), "robinhood with an unparsable facilitator URL: a boot warning");
  ok(/POLICY_URL is not an https URL/.test(w({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", ROBINHOOD_FACILITATOR_URL: "https://a.example.test", FACILITATOR_PUBLIC_INDEX_POLICY_URL: "http://a.example.test/p" })), "an http policy URL: a boot warning");
  ok(/SINCE is not a YYYY-MM-DD date/.test(w({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", ROBINHOOD_FACILITATOR_URL: "https://a.example.test", FACILITATOR_PUBLIC_INDEX_SINCE: "2026-13-01" })), "an invalid date: a boot warning");
  ok(/has no effect while FACILITATOR_PUBLIC_INDEX_CHAINS lists no known chain/.test(w({ FACILITATOR_PUBLIC_INDEX_NAME: "Relay" })), "a name with no chain listed: a boot warning");
  ok(w({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", ROBINHOOD_FACILITATOR_URL: "https://a.example.test", FACILITATOR_PUBLIC_INDEX_NAME: "Relay", FACILITATOR_PUBLIC_INDEX_POLICY_URL: "https://a.example.test/p", FACILITATOR_PUBLIC_INDEX_SINCE: "2026-11-05" }) === "", "a complete, valid config warns nothing");
  ok(w({}) === "", "unset warns nothing");
  ok(/lists ink but INK_FACILITATOR_URL has no parsable first host; the \/privacy paragraph names no host$/.test(w({ FACILITATOR_PUBLIC_INDEX_CHAINS: "ink", ROBINHOOD_FACILITATOR_URL: "https://a.example.test" })), "ink with no Ink facilitator URL: a boot warning (the Robinhood list is not read for it)");
  ok(/lists ink but INK_FACILITATOR_URL has no parsable first host; the \/privacy paragraph names no host for Ink/.test(w({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood,ink", ROBINHOOD_FACILITATOR_URL: "https://a.example.test" })) && !/lists robinhood but/.test(w({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood,ink", ROBINHOOD_FACILITATOR_URL: "https://a.example.test" })), "both listed, Ink without a URL: only Ink is warned about");
  ok(w({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood,ink", ROBINHOOD_FACILITATOR_URL: "https://a.example.test", INK_FACILITATOR_URL: "https://a.example.test" }) === "", "both listed with their URLs: nothing to warn");
}

// --- ink: the same disclosure on Ink, alone or with Robinhood ----------------
{
  const { CHAIN_PAGES } = await import("../src/market-page.js");
  // Ink's rail page exists once Ink is in RAILS (graduated); before that it is absent.
  const inkPage = !!CHAIN_PAGES.ink;
  const TERMS_INK = "On Ink, the facilitator that settles a payment publishes it on its public index, as the privacy policy describes.";
  const TERMS_BOTH = "On Robinhood Chain and Ink, the facilitator that settles a payment publishes it on its public index, as the privacy policy describes.";
  // Ink alone: its own list names the host; the Robinhood list is not read for it.
  let r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "ink", ROBINHOOD_FACILITATOR_URL: "https://rh.example.test", INK_FACILITATOR_URL: "https://ink1.example.test/x402,https://ink2.example.test" });
  ok(r.pt.includes(`On Ink, the facilitator that settles the payment (ink1.example.test) ${FIELDS}`) && !/Robinhood Chain, the facilitator|rh\.example\.test|ink2\.example\.test/.test(r.pt), "ink: the paragraph names Ink and the first listed Ink host only");
  ok(r.pt.includes(NO_SALE_ON) && r.tt.includes(TERMS_INK) && (r.tt.match(/public index/g) || []).length === 1, "ink: the scoped no-sale line and the terms sentence");
  ok(JSON.stringify(r.m.payment.dataHandling.publicSettlementIndex) === JSON.stringify({ chains: ["ink"], hosts: ["ink1.example.test"], policy: `${BASE}/privacy#public-settlement-index` }), `ink: /.well-known/x402 publicSettlementIndex ${JSON.stringify(r.m.payment.dataHandling.publicSettlementIndex)}`);
  ok((r.llms.match(/public index/g) || []).length === (inkPage ? 1 : 0) && !/eip155:4663`\); the facilitator/.test(r.llms) && !/public index/.test(pageText(r.rail)), "ink: Robinhood's llms.txt line and rail page say nothing (Ink's own line says it once Ink has a page)");
  // The boot chose a later listed Ink facilitator: every surface names it.
  setPublicIndexBootFacilitator("ink", "https://ink2.example.test");
  r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "ink", INK_FACILITATOR_URL: "https://ink1.example.test/x402,https://ink2.example.test" });
  ok(r.pt.includes("(ink2.example.test)") && !r.pt.includes("ink1.example.test") && JSON.stringify(r.m.payment.dataHandling.publicSettlementIndex.hosts) === JSON.stringify(["ink2.example.test"]), "ink: the boot's choice is named on /privacy and /.well-known/x402");
  setPublicIndexBootFacilitator("ink", "");
  // Both, one facilitator: one host named once, both chains named.
  r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "ink,robinhood", ROBINHOOD_FACILITATOR_URL: "https://same.example.test", INK_FACILITATOR_URL: "https://same.example.test/" });
  ok(r.pt.includes(`On Robinhood Chain and Ink, the facilitator that settles the payment (same.example.test) ${FIELDS}`) && (r.pt.match(/same\.example\.test/g) || []).length === 1, "both, one facilitator: both chains named, the host once");
  ok((r.pt.match(/public index/g) || []).length === 1 && r.tt.includes(TERMS_BOTH), "both: one paragraph, and terms names both chains");
  ok(JSON.stringify(r.m.payment.dataHandling.publicSettlementIndex) === JSON.stringify({ chains: ["robinhood", "ink"], hosts: ["same.example.test"], policy: `${BASE}/privacy#public-settlement-index` }), "both: the manifest lists both chains and the host once");
  // Both, different facilitators: each host named with its chain.
  r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood,ink", ROBINHOOD_FACILITATOR_URL: "https://rh.example.test", INK_FACILITATOR_URL: "https://ink1.example.test", FACILITATOR_PUBLIC_INDEX_NAME: "Example Relay" });
  ok(r.pt.includes(`On Robinhood Chain and Ink, the facilitator that settles the payment (Example Relay, rh.example.test on Robinhood Chain, ink1.example.test on Ink) ${FIELDS}`), "both, two facilitators: each host named with its chain");
  ok(JSON.stringify(r.m.payment.dataHandling.publicSettlementIndex.hosts) === JSON.stringify(["rh.example.test", "ink1.example.test"]), "both, two facilitators: the manifest names both hosts");
  ok(r.llms.includes("(`eip155:4663`); the facilitator that settles it publishes each settlement on its public index") && (r.llms.match(/public index/g) || []).length === (inkPage ? 2 : 1), "both: llms.txt says it on the Robinhood line, and on Ink's once Ink has a rail page");
  // Once Ink has a rail page (at graduation), its llms.txt line and page say it too.
  const realInk = CHAIN_PAGES.ink;
  if (!realInk) CHAIN_PAGES.ink = { ...CHAIN_PAGES.robinhood, chainName: "Ink", ticker: "ETH", tickerLabel: "INK · MAINNET", caip2: "eip155:57073", asset: "USDC", networkParam: "ink", acceptNetwork: "eip155:57073", isNetwork: (n) => n === "eip155:57073", honestyNetworkPhrase: "the Ink network" };
  try {
    r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood,ink", ROBINHOOD_FACILITATOR_URL: "https://rh.example.test", INK_FACILITATOR_URL: "https://ink1.example.test" });
    ok(r.llms.includes(`(\`eip155:57073\`); the facilitator that settles it publishes each settlement on its public index (${BASE}/privacy#public-settlement-index)`) && (r.llms.match(/public index/g) || []).length === 2, "with an Ink rail page: its llms.txt line says it too");
    ok(marketPage("ink", BASE, { snapshot: { sellers: [] }, rail: null, activity: null }).includes('href="/privacy#public-settlement-index"'), "with an Ink rail page: its manifest links the disclosure");
    r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: "robinhood", ROBINHOOD_FACILITATOR_URL: "https://rh.example.test", INK_FACILITATOR_URL: "https://ink1.example.test" });
    ok(!marketPage("ink", BASE, { snapshot: { sellers: [] }, rail: null, activity: null }).includes("public-settlement-index") && (r.llms.match(/public index/g) || []).length === 1, "ink not listed: its page and line say nothing");
  } finally { if (!realInk) delete CHAIN_PAGES.ink; }
  for (const [name, html] of [["privacy", r.p], ["terms", r.t]]) ok(!/—/.test(html), `${name} with ink: no em dash`);
}
// --- offered: a listed chain renders only while this server offers it -------
{
  const URLS = { ROBINHOOD_FACILITATOR_URL: "https://rh.example.test", INK_FACILITATOR_URL: "https://ink1.example.test" };
  const said = (r) => [/public index/.test(r.pt), /public index/.test(r.tt), !!r.m.payment.dataHandling.publicSettlementIndex, /public index/.test(r.llms), /public index/.test(pageText(r.rail))];
  for (const [list, offered, expect] of [
    ["ink", [], null], ["ink", ["robinhood"], null], ["ink", ["ink"], ["ink"]],
    ["robinhood", [], null], ["robinhood", ["ink"], null], ["robinhood", ["robinhood"], ["robinhood"]],
    ["robinhood,ink", [], null], ["robinhood,ink", ["robinhood"], ["robinhood"]], ["robinhood,ink", ["ink"], ["ink"]], ["robinhood,ink", ["robinhood", "ink"], ["robinhood", "ink"]],
  ]) {
    const r = render({ FACILITATOR_PUBLIC_INDEX_CHAINS: list, ...URLS }, offered);
    const tag = `listed ${list}, offered [${offered.join(",")}]`;
    const idx = r.m.payment.dataHandling.publicSettlementIndex;
    if (!expect) {
      ok(said(r).every((x) => !x) && r.pt.includes(NO_SALE_OFF) && dateOf(r.t) === TERMS_OWN, `${tag}: no surface discloses anything (${said(r)})`);
    } else {
      const names = { robinhood: "Robinhood Chain", ink: "Ink" };
      const lead = `On ${expect.map((c) => names[c]).join(" and ")}, `;
      ok(r.pt.includes(`${lead}the facilitator`) && r.tt.includes(`${lead}the facilitator`) && (r.pt.match(/public index/g) || []).length === 1 && JSON.stringify(idx?.chains) === JSON.stringify(expect), `${tag}: privacy, terms and the manifest name only the offered chains, exactly (${JSON.stringify(idx?.chains)})`);
    }
    const warned = publicIndexUnofferedWarnings().join("\n");
    for (const c of list.split(",")) ok(offered.includes(c) ? !warned.includes(`lists ${c} `) : warned.includes(`lists ${c} but`) && warned.includes("is not offered"), `${tag}: ${c} ${offered.includes(c) ? "is not warned about" : "is named in the boot warning"}`);
  }
}
setPublicIndexOfferedChains([]);
setEnv({});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
