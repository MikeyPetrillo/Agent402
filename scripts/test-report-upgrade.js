#!/usr/bin/env node
// Offline test: the RETENTION LOOP - a one-shot report buyer's path to the
// matching recurring monitor.
//
// The invariants that matter:
//   * the kind -> monitor mapping is DERIVED from MONITOR_PRODUCTS, so a report
//     kind with no monitor (linkedin; research/market-brief -> research watch, dossier -> filing watch since 2026-08-28)
//     offers NOTHING rather than a broken link
//   * label and price on every surface come from the product table - never a
//     hardcoded "$5 a month" that drifts the day pricing changes
//   * a hostile target is escaped in HTML and encoded in the URL, on the page,
//     in the prefilled storefront and in the email
//   * the deep link only PREFILLS: a GET can never create a Stripe session
//   * a report that IS a monitor delivery never up-sells what the reader has
//
// Runs the REAL report viewer (assets/js/report-view.js) in jsdom against the
// REAL delivery page, and the real email builders. Sends no email (the builders
// are pure; emailEnabled() is false without provider env anyway).
import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { monitorForKind, monitorPrefillUrl, upgradeOffer, monitorMapJson, priceUsd } from "../src/report-upgrade.js";
import { MONITOR_PRODUCTS } from "../src/stripe-subscriptions.js";
import { HUMAN_PRODUCTS } from "../src/human-checkout.js";
import { monitorsPage } from "../src/monitors-page.js";
import { reportDeliveryPage } from "../src/human-reports-page.js";
import { buildReportReadyEmail, buildMonitorEmail } from "../src/email.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "ok" : "NOT OK") + " - " + m); };

// A target that tries to break out of an attribute, an element and a query string.
const HOSTILE = 'evil.com" onerror="x"><script>alert(1)</script>&a=b';

// ---------------------------------------------------------------- 1. mapping
const EXPECTED = {
  domain: "domain-monitor",
  fund: "fund-monitor",
  recall: "recall-monitor",
  insider: "insider-monitor",
  token: "token-monitor",
  research: "research-monitor", // 2026-08-28: the saved-question weekly re-run
  dossier: "filing-monitor", // aliased 2026-08-28: a dossier reader is served by the filing watch
};
for (const [kind, product] of Object.entries(EXPECTED)) {
  const m = monitorForKind(kind);
  ok(product ? m?.product === product : m === null, `kind "${kind}" -> ${product || "no monitor"}`);
}
// Every one-shot product resolves through its kind (market-brief is kind
// "research", so it must offer nothing - the three no-monitor products).
const noMonitor = Object.entries(HUMAN_PRODUCTS).filter(([, p]) => !monitorForKind(p.kind)).map(([k]) => k);
ok(!noMonitor.includes("research") && !noMonitor.includes("dossier") && !noMonitor.includes("market-brief") && noMonitor.length === 1 && noMonitor[0] === "linkedin-article",
  "every report product has a monitor to offer except the LinkedIn article (research/market-brief -> research watch, dossier -> filing watch)");
ok(Object.entries(HUMAN_PRODUCTS).every(([, p]) => monitorForKind(p.kind) === null || Object.hasOwn(MONITOR_PRODUCTS, monitorForKind(p.kind).product)),
  "every mapped monitor product exists in MONITOR_PRODUCTS");
ok(monitorForKind("") === null && monitorForKind(null) === null && monitorForKind("nope") === null, "an unknown or empty kind maps to nothing");

// price + label come from the table, not from copy
const dm = monitorForKind("domain");
ok(dm.label === MONITOR_PRODUCTS["domain-monitor"].label && dm.price === MONITOR_PRODUCTS["domain-monitor"].price,
  "label and price are read from MONITOR_PRODUCTS");
ok(dm.priceUsd === priceUsd(MONITOR_PRODUCTS["domain-monitor"].price), "priceUsd is derived from the table price");
ok(priceUsd(500) === "$5" && priceUsd(1250) === "$12.50" && priceUsd(300) === "$3", "priceUsd formats whole dollars whole and cents to 2dp");

// ------------------------------------------------------------- 2. prefill URL
const url = monitorPrefillUrl("domain-monitor", HOSTILE, "https://agent402.tools");
ok(url.startsWith("https://agent402.tools/monitors?"), "prefill URL points at the storefront");
ok(!/["'<>]/.test(url), "a hostile target is percent-encoded in the URL (no raw quote or angle bracket)");
ok(new URL(url).searchParams.get("target") === HOSTILE.slice(0, 200) && new URL(url).searchParams.get("product") === "domain-monitor",
  "the URL round-trips product + target exactly");
const off = upgradeOffer("insider", "AAPL", "https://agent402.tools");
ok(off.product === "insider-monitor" && off.url === "https://agent402.tools/monitors?product=insider-monitor&target=AAPL", "upgradeOffer builds the deep link");
ok(upgradeOffer("linkedin", "anything", "https://agent402.tools") === null, "upgradeOffer returns null for a kind with no monitor (linkedin)");

// --------------------------------------------- 3. the prefilled storefront page
const plain = monitorsPage("https://agent402.tools");
const filled = monitorsPage("https://agent402.tools", { product: "insider-monitor", target: "AAPL" });
ok(!/value="/.test(plain.match(/<input id="in-insider-monitor"[^>]*>/)[0]), "no prefill: the input carries no value");
ok(/value="AAPL"/.test(filled.match(/<input id="in-insider-monitor"[^>]*>/)[0]), "prefill fills the matching product's input");
ok(!/value="/.test(filled.match(/<input id="in-domain-monitor"[^>]*>/)[0]), "prefill fills ONLY the matching product's input");
ok(/id="prefilled"/.test(filled) && /class="pcard sel"/.test(filled), "the prefilled card is marked");
ok(/noindex/.test(filled) && !/noindex/.test(plain), "a prefilled variant is kept out of the index; the plain page is not");

const hostilePage = monitorsPage("https://agent402.tools", { product: "domain-monitor", target: HOSTILE });
const hostileInput = hostilePage.match(/<input id="in-domain-monitor"[^>]*>/)[0];
// Parse it the way a browser would: the value must arrive intact as DATA, with
// no attribute and no element smuggled in alongside it.
const hostileDom = new JSDOM(hostilePage);
const hostileEl = hostileDom.window.document.getElementById("in-domain-monitor");
ok(!hostileEl.hasAttribute("onerror") && hostileEl.attributes.length <= 5, "a hostile target cannot inject an attribute into the input");
ok(hostileEl.getAttribute("value") === HOSTILE, "the hostile target arrives as the field's value, escaped, not as markup");
ok(hostileInput.includes("&quot;"), "the hostile target is HTML-escaped inside the value attribute");
ok(!hostilePage.includes("<script>alert(1)</script>"), "the hostile target never lands as live markup on the page");
ok(monitorsPage("https://agent402.tools", { product: "not-a-product", target: "AAPL" }) === plain, "an unknown product prefills nothing (identical to the plain page)");
ok(monitorsPage("https://agent402.tools", { product: "insider-monitor", target: "" }).includes('id="prefilled"'), "a product with no target still selects the card");

// The prefill route must never take money: structurally, the /monitors handler
// only renders, and the page module never touches the checkout creator.
const serverSrc = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const handler = serverSrc.match(/app\.get\("\/monitors",[\s\S]*?\n\}\);/)[0];
ok(/monitorsPage\(BASE_URL, prefill\)/.test(handler), "the /monitors route renders the page with the query prefill");
ok(!/createCheckout|subscribe|stripe/i.test(handler), "the /monitors GET never creates a checkout session");
const pageSrc = readFileSync(new URL("../src/monitors-page.js", import.meta.url), "utf8");
ok(!/createCheckout|new Stripe/.test(pageSrc), "the storefront page module never reaches Stripe");
ok(/no-store/.test(handler), "a prefilled variant is not cached (it carries someone's target)");

// ------------------------------------------------ 4. the delivered report page
const REPORT_VIEW_JS = readFileSync(new URL("../assets/js/report-view.js", import.meta.url), "utf8");
function inlineViewer(html) {
  const tag = '<script src="/js/report-view.js"></script>';
  if (!html.includes(tag)) throw new Error("reportDeliveryPage() no longer references /js/report-view.js - did the src path change?");
  return html.replace(tag, `<script>${REPORT_VIEW_JS}</script>`);
}
const pageHtml = reportDeliveryPage("cs_test", { baseUrl: "https://agent402.tools" });
ok(/data-monitors="/.test(pageHtml), "the delivery page carries the kind -> monitor map as data");
const mapAttr = JSON.parse(pageHtml.match(/data-monitors="([^"]*)"/)[1].replace(/&(quot|amp|lt|gt|#39);/g, (_, e) => ({ quot: '"', amp: "&", lt: "<", gt: ">", "#39": "'" }[e])));
const monitorKinds = new Set(Object.values(MONITOR_PRODUCTS).map((p) => p.kind));
ok([...monitorKinds].every((k) => mapAttr[k]) && mapAttr.dossier?.product === "filing-monitor" && mapAttr.ticker?.product === "insider-monitor", "every monitor kind is in the delivered map, and the aliased kinds (dossier, ticker) resolve to their monitor");
ok(mapAttr.domain.product === "domain-monitor" && mapAttr.domain.priceUsd === priceUsd(MONITOR_PRODUCTS["domain-monitor"].price) && mapAttr.domain.label === MONITOR_PRODUCTS["domain-monitor"].label,
  "the delivered map carries the table's product key, label and price");
ok(JSON.parse(monitorMapJson()).insider.product === "insider-monitor", "monitorMapJson keys by kind");

async function renderReport(record) {
  const vc = new VirtualConsole();       // swallow jsdom's "navigation not implemented"
  const posts = [];
  // The viewer polls the moment the script parses, so the stub must be in place
  // BEFORE parsing (beforeParse) - assigning window.fetch afterwards would miss
  // the first poll and wait out the viewer's 3s retry.
  const dom = new JSDOM(inlineViewer(pageHtml), {
    runScripts: "dangerously", url: "https://agent402.tools/r/cs_test", virtualConsole: vc,
    beforeParse(win) {
      win.fetch = async (u, init) => {
        if (String(u).startsWith("/api/subscribe")) { posts.push({ url: String(u), body: JSON.parse(init.body) }); return { json: async () => ({ url: "https://checkout.stripe.com/pay/cs_sub" }) }; }
        return { json: async () => record };
      };
    },
  });
  for (let i = 0; i < 100 && !dom.window.document.getElementById("report-body"); i++) await new Promise((r) => setTimeout(r, 10));
  return { dom, doc: dom.window.document, posts };
}
const doneDomain = { status: "done", kind: "domain", slug: "domain-audit", input: "example.com", title: "example.com", report: "# Audit\n\nGrade A. [1]", sources: [], tables: [], at: "2026-08-22T00:00:00Z" };

let r = await renderReport(doneDomain);
let box = r.doc.getElementById("upsell");
ok(!!box, "a domain report offers the domain monitor");
ok(box.getAttribute("data-product") === "domain-monitor" && box.getAttribute("data-target") === "example.com", "the CTA carries the matching product and the report's target");
ok(box.textContent.includes(MONITOR_PRODUCTS["domain-monitor"].label), "the CTA names the monitor from MONITOR_PRODUCTS");
const ctaPrices = [...box.textContent.matchAll(/\$[0-9.]+ a month/g)].map((x) => x[0]);
ok(ctaPrices.length >= 2 && ctaPrices.every((x) => x === `${priceUsd(MONITOR_PRODUCTS["domain-monitor"].price)} a month`),
  "EVERY price the CTA quotes comes from MONITOR_PRODUCTS (no copy carries its own number)");
ok(box.querySelector("a").getAttribute("href") === "/monitors?product=domain-monitor&target=example.com", "the CTA's plain link is the prefill deep link");
ok(/\bexample\.com\b/.test(box.textContent), "the CTA names what will be watched");

// clicking POSTs the existing subscribe flow with the target prefilled
r.doc.getElementById("up-go").click();
await new Promise((res) => setTimeout(res, 30));
ok(r.posts.length === 1 && r.posts[0].body.product === "domain-monitor" && r.posts[0].body.target === "example.com",
  "clicking the CTA POSTs /api/subscribe with the product and target");

// hostile target on the delivered page
r = await renderReport({ ...doneDomain, input: HOSTILE, title: HOSTILE });
box = r.doc.getElementById("upsell");
ok(!!box && r.doc.querySelectorAll("#upsell script").length === 0, "a hostile target injects no script into the CTA");
ok(box.getAttribute("data-target") === HOSTILE, "the hostile target survives escaping intact as data");
const href = box.querySelector("a").getAttribute("href");
ok(!/["'<>]/.test(href) && decodeURIComponent(href.split("target=")[1]) === HOSTILE, "the hostile target is percent-encoded in the CTA link");

// kinds with no monitor, and a monitor delivery, offer nothing
r = await renderReport({ ...doneDomain, kind: "research", slug: "research", input: "how do agents pay" });
box = r.doc.getElementById("upsell");
ok(box && box.getAttribute("data-product") === "research-monitor", "a research report offers the research watch (weekly re-run of the question)");
r = await renderReport({ ...doneDomain, kind: "dossier", slug: "dossier", input: "AAPL" });
box = r.doc.getElementById("upsell");
ok(box && box.getAttribute("data-product") === "filing-monitor" && box.getAttribute("data-target") === "AAPL", "a dossier offers the filing watch for its ticker");
r = await renderReport({ ...doneDomain, monitor: { label: "Domain security monitor", target: "example.com", reason: "change", changes: [] } });
ok(!r.doc.getElementById("upsell"), "a monitor delivery never up-sells the monitor the reader already pays for");

// ------------------------------------------------------------------ 5. emails
const em = buildReportReadyEmail({ reportUrl: "https://agent402.tools/r/cs_1", productLabel: "Domain security audit", subjectOf: "example.com", kind: "domain", baseUrl: "https://agent402.tools" });
ok(em.html.includes("https://agent402.tools/monitors?product=domain-monitor&amp;target=example.com"), "the one-shot delivery email links the prefilled monitor");
ok(em.text.includes("https://agent402.tools/monitors?product=domain-monitor&target=example.com"), "the plain-text email carries the same deep link");
ok(em.html.includes(MONITOR_PRODUCTS["domain-monitor"].label) && em.html.includes(`${priceUsd(MONITOR_PRODUCTS["domain-monitor"].price)} a month`), "the email's label and price come from MONITOR_PRODUCTS");
const emNone = buildReportReadyEmail({ reportUrl: "https://agent402.tools/r/cs_2", productLabel: "Deep research report", subjectOf: "anything", kind: "research", baseUrl: "https://agent402.tools" });
ok(/monitors\?product=research-monitor/.test(emNone.html) && /monitors\?product=research-monitor/.test(emNone.text), "a research delivery email offers the research watch");
const emHostile = buildReportReadyEmail({ reportUrl: "https://agent402.tools/r/cs_3", productLabel: "Domain security audit", subjectOf: HOSTILE, kind: "domain", baseUrl: "https://agent402.tools" });
ok(!emHostile.html.includes("<script>alert(1)</script>") && emHostile.html.includes("&lt;script&gt;"), "a hostile target is HTML-escaped in the email body");
ok(!/href="[^"]*<|href="[^"]*"[^>]*onerror/.test(emHostile.html), "a hostile target cannot break out of the email's href");
const emNoBase = buildReportReadyEmail({ reportUrl: "https://agent402.tools/r/cs_4", productLabel: "Insider flow report (Form 4)", subjectOf: "AAPL", kind: "insider" });
ok(emNoBase.html.includes("https://agent402.tools/monitors?product=insider-monitor"), "with no baseUrl the link is still absolute (origin taken from the report URL)");

const MANAGE = "https://agent402.tools/monitors/manage?report=abc123&k=SIGNED";
const mon = buildMonitorEmail({ reason: "change", label: "Domain security monitor", target: "example.com", changes: ["DMARC changed"], reportUrl: "https://agent402.tools/m/abc123", manageUrl: MANAGE });
ok(mon.text.includes("You are getting this because you subscribed"), "monitor mail says in plain language why it arrived");
ok(mon.html.includes("You are getting this because you subscribed"), "the HTML monitor mail carries the same line");
ok(mon.html.includes(MANAGE.replace(/&/g, "&amp;")) && mon.text.includes(MANAGE), "the keyed manage link is carried through unchanged");
ok(/manage or cancel/i.test(mon.html) && /Manage or cancel/.test(mon.text), "monitor mail keeps an explicit manage or cancel link");
const monNoManage = buildMonitorEmail({ reason: "welcome", label: "Fund 13F watch", target: "Berkshire", reportUrl: "https://agent402.tools/m/x" });
ok(monNoManage.text.includes("You are getting this because you subscribed"), "the why line is there even with no manage URL");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
