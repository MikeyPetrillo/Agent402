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

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

process.env.POSTHOG_API_KEY = "phc_test_compliance";
process.env.COMPANY_POSTAL_ADDRESS = "Havok Holdings LLC\nPO Box 65\nSample Town, NC 00000";
const BASE = "https://agent402.tools";
const { termsPage } = await import("../src/terms.js");
const { privacyPage } = await import("../src/privacy.js");
const { buildMonitorEmail } = await import("../src/email.js");
const { monitorThanksPage, monitorsPage } = await import("../src/monitors-page.js");
const { RENEWAL_TERMS, MONITOR_PRODUCTS } = await import("../src/stripe-subscriptions.js");
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
const ROOT = new URL("..", import.meta.url).pathname;
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
  ok(/cancel anytime online/i.test(body) && /end of the period you paid for/.test(body), `welcome email ${part}: how to cancel online and what canceling does`);
  ok(body.includes(`${BASE}/terms`), `welcome email ${part}: links the terms`);
}
const scheduled = buildMonitorEmail({ reason: "scheduled", label: product.label, target: "example.com", reportUrl: `${BASE}/m/r1`, manageUrl, kind: product.kind, priceCents: product.price });
ok(!/a month/.test(scheduled.text), "control: a scheduled report email does not repeat the purchase terms");
const noPrice = buildMonitorEmail({ reason: "welcome", label: product.label, target: "example.com", reportUrl: `${BASE}/m/r1`, manageUrl, kind: product.kind });
ok(/renews each month until you cancel/i.test(noPrice.text) && !/\$NaN|undefined/.test(noPrice.text), "a welcome email built without a price still states the renewal and cancel terms");
const thanks = monitorThanksPage("cs_test_1", BASE);
ok(strip(thanks).includes(RENEWAL_TERMS), "/monitors/thanks shows the renewal sentence the storefront shows");

// 6. Copyright agent and process
const cr = termsText.slice(termsText.indexOf("Copyright complaints"));
ok(cr.length > 0 && /designated agent/i.test(cr), "terms: a copyright section names a designated agent");
ok(cr.includes("mike@agent402.tools") && cr.includes(COMPANY_PHONE.display) && cr.includes("PO Box 65"), "terms: the agent's email, business phone and postal address");
ok(/counter-notice/i.test(cr) && /10 to 14 business days/.test(cr) && /repeat infringers/.test(cr), "terms: counter-notice, restore window and repeat-infringer policy");
ok(/under penalty of perjury/.test(cr) && /physical or electronic signature/.test(cr), "terms: the notice elements");
delete process.env.COMPANY_POSTAL_ADDRESS;
const termsNoAddr = strip(termsPage(BASE));
ok(!/PO Box/.test(termsNoAddr) && /\/company/.test(termsNoAddr.slice(termsNoAddr.indexOf("Copyright complaints"))), "with no postal address set, the section points to /company instead of printing one");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
