#!/usr/bin/env node
// Consumer-facing obligations, read from what the server renders (offline):
//   - age: terms and privacy say 18 and older, not directed at children,
//     nothing knowingly collected under 13, and how to have it deleted;
//   - fonts: no source file or rendered page loads a font or stylesheet from a
//     third-party host, and the CSP allows fonts from our own origin only;
//   - page analytics: the PostHog config renders with autocapture, session
//     recording and heatmaps off;
//   - recurring email: every monitor email carries its manage-or-cancel link;
//   - renewal: the monitor welcome email states the price, the monthly
//     renewal until canceled and the online cancel path, and the thanks page
//     shows the same renewal sentence as the storefront;
//   - copyright: /terms names a designated agent (email, phone, postal
//     address when set) and the notice and counter-notice steps.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { textNamesUrl } from "./lib/url-host.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

process.env.POSTHOG_API_KEY = "phc_test_compliance";
process.env.COMPANY_POSTAL_ADDRESS = "Havok Holdings LLC\nPO Box 65\nSample Town, NC 00000";
const BASE = "https://agent402.tools";
const { termsPage } = await import("../src/terms.js");
const { privacyPage } = await import("../src/privacy.js");
const { buildMonitorEmail, subscriptionPriceText } = await import("../src/email.js");
const { monitorThanksPage, monitorsPage } = await import("../src/monitors-page.js");
const { RENEWAL_TERMS, CANCEL_EFFECT, MONITOR_PRODUCTS } = await import("../src/stripe-subscriptions.js");
const { priceUsd } = await import("../src/report-upgrade.js");
const { COMPANY_PHONE } = await import("../src/company.js");
const sec = await import("../src/security-headers.js");

const strip = (h) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const terms = termsPage(BASE), termsText = strip(terms);
const privacy = privacyPage(BASE), privacyText = strip(privacy);

// 1. Age
ok(/at least 18/.test(termsText) && /not directed at children/.test(termsText) && /under 13/.test(termsText), "terms: 18 and older, not directed at children, nothing knowingly collected under 13");
ok(/18 and older/.test(privacyText) && /under 13/.test(privacyText) && /we will delete it/.test(privacyText), "privacy: children statement says how to have a child's data deleted");

// 2. Externally loaded fonts and stylesheets
const FONT_HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|p\.typekit\.net|fonts\.bunny\.net|use\.fontawesome\.com|@import\s+url\(\s*["']?https?:/i;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    const s = statSync(p);
    if (s.isDirectory()) { if (n !== "node_modules" && n !== "fixtures") walk(p); }
    else if (/\.(js|mjs|css|html)$/.test(n)) files.push(p);
  }
})(join(ROOT, "src"));
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    const s = statSync(p);
    if (s.isDirectory()) { if (n !== "fixtures") walk(p); }
    else if (/\.(js|css|html)$/.test(n)) files.push(p);
  }
})(join(ROOT, "assets"));
const offenders = files.filter((f) => FONT_HOSTS.test(readFileSync(f, "utf8")));
ok(files.length > 50, `control: the scan read the served trees (${files.length} files)`);
ok(FONT_HOSTS.test('<link href="https://fonts.googleapis.com/css2?family=Inter">') && FONT_HOSTS.test("@import url('https://cdn.example/x.css')"), "control: the pattern sees a Google Fonts link and a remote @import");
ok(offenders.length === 0, `no served source loads a third-party font or stylesheet (${offenders.map((f) => f.slice(ROOT.length)).join(", ") || "none"})`);
for (const [name, html] of [["/terms", terms], ["/privacy", privacy], ["/monitors", monitorsPage(BASE)]]) {
  ok(!FONT_HOSTS.test(html) && /href="\/fonts\/geist-400-latin\.woff2"/.test(html), `${name}: fonts load from our own origin only`);
}
for (const analytics of [false, true]) {
  const csp = sec.contentSecurityPolicy({ analytics });
  ok(/(^|; )font-src 'self'(;|$)/.test(csp), `CSP (analytics ${analytics}): font-src is 'self' only`);
  ok(/(^|; )style-src 'self' 'unsafe-inline'(;|$)/.test(csp), `CSP (analytics ${analytics}): style-src names no outside host`);
}

// 3. Page analytics
const island = terms.match(/<script type="application\/json" id="posthog-config">([^<]+)<\/script>/);
ok(!!island, "control: with the key set, the page carries the PostHog config island");
const ph = island ? JSON.parse(island[1].replace(/\\u003c/g, "<")) : { cfg: {} };
ok(ph.cfg.autocapture === false, "PostHog: autocapture off (no clicks or inputs captured)");
ok(ph.cfg.disable_session_recording === true, "PostHog: session recording off");
ok(!ph.cfg.enable_heatmaps && !ph.cfg.capture_dead_clicks, "PostHog: heatmaps and dead-click capture not turned on");
ok(ph.cfg.persistence === "sessionStorage", "PostHog: no cookie (session storage only)");
ok(/no session replay/i.test(privacyText) && /Google Analytics/.test(privacyText), "privacy names the page counter, its lack of replay, and Google Analytics");

// 4. Recurring email carries its stop path
const manageUrl = `${BASE}/monitors/manage?report=r1&k=sig`;
for (const reason of ["welcome", "scheduled", "change", "tls-expiring", "filing", "problem", "recall", "safety-change", "filing-new", "digest"]) {
  const m = buildMonitorEmail({ reason, label: "Domain security monitor", target: "example.com", reportUrl: `${BASE}/m/r1`, manageUrl, kind: "domain" });
  ok(m.html.includes(manageUrl.replace(/&/g, "&amp;")) && m.text.includes(manageUrl) && /until you cancel/.test(m.text), `monitor email (${reason}): manage-or-cancel link in HTML and text`);
}

// 5. Renewal terms after purchase
const product = MONITOR_PRODUCTS["domain-monitor"];
const price = priceUsd(product.price);
const welcome = buildMonitorEmail({ reason: "welcome", label: product.label, target: "example.com", reportUrl: `${BASE}/m/r1`, manageUrl, kind: product.kind, priceCents: product.price });
for (const [part, body] of [["text", welcome.text], ["HTML", strip(welcome.html) + welcome.html]]) {
  ok(body.includes(`${price} a month`), `welcome email ${part}: states the price per month (${price})`);
  ok(/renews each month until you cancel/i.test(body), `welcome email ${part}: renews each month until canceled`);
  ok(/cancel anytime online through the manage or cancel link below/i.test(body) && body.includes(CANCEL_EFFECT), `welcome email ${part}: how to cancel online and what canceling does`);
  ok(/end of the period you already paid for/.test(body) && /not renewed/.test(body) && /no partial refund/.test(body), `welcome email ${part}: active to the end of the paid period, not renewed, no partial refund`);
  ok(body.includes(`${BASE}/terms`), `welcome email ${part}: links the terms`);
}
const scheduled = buildMonitorEmail({ reason: "scheduled", label: product.label, target: "example.com", reportUrl: `${BASE}/m/r1`, manageUrl, kind: product.kind, priceCents: product.price });
ok(!/a month/.test(scheduled.text), "control: a scheduled report email does not repeat the purchase terms");
const noPrice = buildMonitorEmail({ reason: "welcome", label: product.label, target: "example.com", reportUrl: `${BASE}/m/r1`, manageUrl, kind: product.kind });
ok(/renews each month until you cancel/i.test(noPrice.text) && !/\$NaN|undefined/.test(noPrice.text), "a welcome email built without a price still states the renewal and cancel terms");
// A wallet (MPP) subscriber has no portal: its emails name its cancel endpoint and the authorization.
const mppManage = `${BASE}/api/mpp/monitors/mpp_1?token=tok`, mppCancel = `${BASE}/api/mpp/monitors/mpp_1/cancel?token=tok`;
for (const reason of ["welcome", "scheduled", "problem"]) {
  const m = buildMonitorEmail({ reason, label: product.label, target: "example.com", reportUrl: `${BASE}/m/r1`, manageUrl: mppManage, kind: product.kind, priceCents: product.price, rail: "mpp", cancelUrl: mppCancel, withTerms: reason === "problem" });
  for (const [part, body] of [["text", m.text], ["HTML", m.html.replace(/&amp;/g, "&")]]) {
    ok(body.includes(mppCancel) && /POST request/.test(body), `MPP ${reason} email ${part}: names the POST cancel endpoint`);
    ok(!/manage or cancel link/i.test(body) && !/change your card/.test(body), `MPP ${reason} email ${part}: no card-portal cancel instruction`);
  }
  if (reason !== "scheduled") ok(/revoking the authorization/.test(m.text) && /renews each month until you cancel/i.test(m.text), `MPP ${reason} email: the renewal terms and the authorization path`);
}
const mppNoCancel = buildMonitorEmail({ reason: "welcome", label: product.label, target: "example.com", reportUrl: `${BASE}/m/r1`, manageUrl: mppManage, kind: product.kind, priceCents: product.price, rail: "mpp" });
ok(/revoking the authorization/.test(mppNoCancel.text) && !/manage or cancel link/.test(mppNoCancel.text), "MPP welcome email without a cancel endpoint still names the authorization path");

// A first report that failed: the problem email carries the renewal terms and the cancel path.
const firstFail = buildMonitorEmail({ reason: "problem", label: product.label, target: "example.com", reportUrl: `${BASE}/monitors`, manageUrl: `${BASE}/monitors#manage`, kind: product.kind, priceCents: product.price, withTerms: true });
ok(firstFail.text.includes(`${price} a month`) && /renews each month until you cancel/i.test(firstFail.text) && /enter your checkout email/.test(firstFail.text) && firstFail.text.includes(CANCEL_EFFECT), "first-run problem email: price, renewal, how to cancel and what canceling does");
const laterFail = buildMonitorEmail({ reason: "problem", label: product.label, target: "example.com", reportUrl: `${BASE}/m/r1`, manageUrl, kind: product.kind, priceCents: product.price });
ok(!/a month/.test(laterFail.text), "control: a later problem email does not repeat the purchase terms");

// A promotion code: the first period and the renewal as Stripe reported them.
const promo = buildMonitorEmail({ reason: "welcome", label: product.label, target: "example.com", reportUrl: `${BASE}/m/r1`, manageUrl, kind: product.kind, priceCents: product.price, firstPeriodCents: 123, renewalCents: 456 });
ok(promo.text.includes("$1.23 for the first month with your promotion code, then $4.56 a month"), "promo welcome email: the first-period and renewal prices read at checkout");
ok(subscriptionPriceText({ priceCents: 500, firstPeriodCents: 0, renewalCents: 500 }) === "Free for the first month with your promotion code, then $5 a month, billed in advance.", "a free first month reads as free, then the renewal price");
ok(subscriptionPriceText({ priceCents: 500, firstPeriodCents: 250 }) === "$2.50 for the first month with your promotion code, then the monthly amount shown in your billing portal, billed in advance.", "an unread renewal amount points to the billing portal, never a typed price");
ok(subscriptionPriceText({ priceCents: 500, firstPeriodCents: 400, renewalCents: 400 }).startsWith("$4 for the first month"), "a lasting discount states the discounted renewal");
ok(subscriptionPriceText({ priceCents: 500 }) === "$5 a month, billed in advance." && subscriptionPriceText({}) === "", "no promotion: the catalog price; no price: nothing");

const thanks = monitorThanksPage("cs_test_1", BASE);
ok(strip(thanks).includes(RENEWAL_TERMS), "/monitors/thanks shows the renewal sentence the storefront shows");
ok(strip(thanks).replace(/&#39;/g, "'").includes(CANCEL_EFFECT), "/monitors/thanks says what canceling does");
const thanksJs = readFileSync(join(ROOT, "assets/js/monitor-thanks.js"), "utf8");
ok(/s\.priceText/.test(thanksJs), "/monitors/thanks draws the price sentence /api/monitors/confirm returns");
const serverSrc = readFileSync(join(ROOT, "src/server.js"), "utf8");
const confirmSrc = serverSrc.slice(serverSrc.indexOf('app.get("/api/monitors/confirm"'), serverSrc.indexOf('app.get("/monitors/manage"'));
ok(/priceText = r\.status === "active" \? subscriptionPriceText\(r\)/.test(confirmSrc) && /res\.json\(\{[^}]*\.\.\.\(priceText \? \{ priceText \} : \{\}\)[,} ]/.test(confirmSrc), "/api/monitors/confirm derives the price sentence from the subscription record and returns it");
ok(/s\.signedReceipt/.test(thanksJs) && /signedReceipt: last/.test(confirmSrc), "/monitors/thanks draws the latest period's signed receipt /api/monitors/confirm returns");
{
  const { buildMonitorEmail } = await import("../src/email.js");
  const base = { reason: "scheduled", label: "Domain security monitor", target: "example.com", reportUrl: "https://agent402.tools/m/abc", manageUrl: "https://agent402.tools/monitors/manage?report=abc&k=T" };
  const withR = buildMonitorEmail({ ...base, signedReceipt: { receipt: "aa.bb.cc", statement: "{\"kind\":\"monitor-subscription-period\"}" } });
  ok(withR.text.includes("aa.bb.cc") && withR.text.includes("monitor-subscription-period") && textNamesUrl(withR.text, "agent402.tools", "/api/receipts/verify") && withR.html.includes("aa.bb.cc"), "a monitor email carries the latest period's signed receipt, its statement and where to check them");
  const noR = buildMonitorEmail(base);
  ok(!/Signed receipt/.test(noR.text) && !/Signed receipt/.test(noR.html), "a monitor email with no receipt says nothing about one");
}

// 6. Copyright agent and process
const cr = termsText.slice(termsText.indexOf("Copyright complaints"));
ok(cr.length > 0 && /designated agent/i.test(cr), "terms: a copyright section names a designated agent");
ok(cr.includes("mike@agent402.tools") && cr.includes(COMPANY_PHONE.display) && cr.includes("PO Box 65"), "terms: the agent's email, business phone and postal address");
ok(/counter-notice/i.test(cr) && /10 to 14 business days/.test(cr) && /repeat infringers/.test(cr), "terms: counter-notice, restore window and repeat-infringer policy");
ok(/the person who sent the notice or that person's agent/.test(cr.replace(/&#39;/g, "'")), "terms: counter-notice consent to service from the notifier or that person's agent");
ok(/take reasonable steps to notify the person who provided it, where we can identify them/.test(cr) && !/promptly and tell the person/.test(cr), "terms: notice to the provider is reasonable steps, not a promise");
ok(/shared answer page deletes it, so it cannot be restored/.test(cr) && /for material we can restore, restore it/.test(cr), "terms: no restoration promised for a deleted shared answer");
const subsTerms = termsText.slice(termsText.indexOf("Subscriptions (monitors)"));
ok(/POST request to the cancel link/.test(subsTerms) && /revoking the authorization/.test(subsTerms) && /stays active until the end of the period you already paid for and is not renewed/.test(subsTerms) && /no partial refund for the remaining days/.test(subsTerms), "terms: each rail's cancel path and what canceling does");
ok(/under penalty of perjury/.test(cr) && /physical or electronic signature/.test(cr), "terms: the notice elements");
delete process.env.COMPANY_POSTAL_ADDRESS;
const termsNoAddr = strip(termsPage(BASE));
ok(!/PO Box/.test(termsNoAddr) && /\/company/.test(termsNoAddr.slice(termsNoAddr.indexOf("Copyright complaints"))), "with no postal address set, the section points to /company instead of printing one");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
