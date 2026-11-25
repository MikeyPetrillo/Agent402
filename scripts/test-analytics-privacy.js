// Page analytics in a real DOM (jsdom), offline:
//   - one consent decision (assets/js/analytics-consent.js) gates both
//     counters: in the EU, the EEA, the UK and Switzerland (a European or
//     missing time zone, or the CDN's country for this request) NEITHER the
//     Google tag NOR the PostHog library is requested before "Allow";
//   - PostHog keeps nothing in the browser (memory persistence);
//   - the two answers look the same; the strip is announced (aria-live);
//   - the PostHog loader sends no query string but utm_* on any URL property,
//     and still redacts bearer paths;
//   - Global Privacy Control: nothing loads, no strip, no choices button;
//   - the footer's "analytics choices" button is rendered hidden, shown by the
//     consent module, and reopens the strip for any visitor (not only Europe);
//     withdrawing stops both counters and removes the GA cookies;
//   - GET /api/consent-region answers one bit from the country header;
//   - /privacy says all of this.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const CONSENT = readFileSync(new URL("../assets/js/analytics-consent.js", import.meta.url), "utf8");
const PH = readFileSync(new URL("../assets/js/posthog-loader.js", import.meta.url), "utf8");
const GA = readFileSync(new URL("../assets/js/ga-loader.js", import.meta.url), "utf8");
const { ledgerFooterCompact, analyticsSnippets } = await import("../src/ledger-chrome.js");

// A page with the shell's islands and footer. `region` is what the server's
// /api/consent-region answers ({asksFirst}), "fail" for a request that errors.
function page({ url = "https://agent402.tools/monitors", gpc = false, tz = "America/New_York", stored = null, webdriver = false, region = { asksFirst: false, source: "country" }, ga = true, ph = true, phHost = "https://agent402.tools/e" } = {}) {
  const island = JSON.stringify({ key: "phc_test", cfg: { api_host: phHost, persistence: "memory" } }).replace(/</g, "\\u003c");
  const html = `<!doctype html><html><head><script id="unused"></script></head><body>
${ph ? `<script type="application/json" id="posthog-config">${island}</script>` : ""}
${ga ? '<script type="application/json" id="ga-config">{"id":"G-TEST1234"}</script>' : ""}
<main>page</main>${ledgerFooterCompact()}</body></html>`;
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const w = dom.window;
  if (gpc) Object.defineProperty(w.navigator, "globalPrivacyControl", { value: true, configurable: true });
  Object.defineProperty(w.navigator, "webdriver", { value: webdriver, configurable: true });
  w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: tz }) }) };
  if (stored) w.localStorage.setItem("a402-analytics-consent", stored);
  // No network: the region read is answered here, and counted.
  w.__regionReads = 0;
  w.XMLHttpRequest = class {
    open(method, path) { this.path = path; }
    send() {
      w.__regionReads++;
      setTimeout(() => {
        if (region === "fail") return this.onerror && this.onerror();
        this.status = 200; this.responseText = JSON.stringify(region); this.onload && this.onload();
      }, 0);
    }
  };
  return dom;
}
const tick = () => new Promise((r) => setTimeout(r, 5));
// jsdom fires DOMContentLoaded after construction; run the three scripts in
// the order the shell renders them, then let the region read answer.
async function run(dom, { consent = true } = {}) {
  const w = dom.window;
  if (consent) w.eval(CONSENT);
  w.eval(PH);
  w.eval(GA);
  await new Promise((r) => (w.document.readyState === "loading" ? w.document.addEventListener("DOMContentLoaded", () => r()) : r()));
  await tick();
  return w;
}
const posthogInit = (w) => w.posthog && Array.isArray(w.posthog._i) ? w.posthog._i[0] : null;
const dl = (w) => [...(w.dataLayer || [])].map((a) => [...a]);
const consentDefault = (w) => dl(w).find((a) => a[0] === "consent" && a[1] === "default")?.[2];
const stripOf = (w) => w.document.querySelector('[aria-label="Analytics choice"]');
const scriptSrcs = (w) => [...w.document.querySelectorAll("script[src]")].map((s) => s.src);
const gtagLoaded = (w) => scriptSrcs(w).some((s) => /googletagmanager\.com\/gtag\/js\?id=G-TEST1234/.test(s));
const nothingLoaded = (w) => !gtagLoaded(w) && !w.posthog && !scriptSrcs(w).some((s) => /\/static\/array\.js/.test(s)) && !(w.dataLayer || []).length;
const button = (w, label) => [...(stripOf(w)?.querySelectorAll("button") || [])].find((b) => b.textContent === label);

// --- The shell renders the consent module first ------------------------------
{
  process.env.POSTHOG_API_KEY = "phc_test"; process.env.GA_MEASUREMENT_ID = "G-TEST1234";
  const html = analyticsSnippets("https://agent402.tools", "https://agent402.tools/monitors");
  const order = ["analytics-consent.js", "posthog-loader.js", "ga-loader.js"].map((f) => html.indexOf(f));
  ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], "the shell renders the consent module before both loaders");
  ok(/"persistence":"memory"/.test(html), "the PostHog island asks for memory persistence");
  delete process.env.POSTHOG_API_KEY; delete process.env.GA_MEASUREMENT_ID;
  ok(analyticsSnippets("https://agent402.tools", "https://agent402.tools/") === "", "no counter configured: no consent module either");
}

// --- Europe: nothing loads before Allow -------------------------------------
for (const [label, opts] of [
  ["a European time zone", { tz: "Europe/Berlin" }],
  ["Cyprus (Asia/Nicosia)", { tz: "Asia/Nicosia" }],
  ["an unknown time zone", { tz: "" }],
  ["a non-European zone whose request the CDN places in the EU", { tz: "America/New_York", region: { asksFirst: true, source: "country" } }],
  ["a region read that fails", { tz: "America/New_York", region: "fail" }],
]) {
  const w = await run(page(opts));
  ok(nothingLoaded(w), `${label}: neither the Google tag nor the PostHog library loads before a choice`);
  ok(!!stripOf(w), `${label}: the strip asks`);
}
{
  const w = await run(page({ tz: "Europe/Paris" }));
  ok(w.__regionReads === 0, "a European time zone asks without a region read");
  const strip = stripOf(w);
  ok(strip.getAttribute("aria-live") === "polite", "the strip is announced (aria-live polite)");
  const no = button(w, "No thanks"), yes = button(w, "Allow");
  ok(no && yes && no.style.cssText === yes.style.cssText, "Allow and No thanks are styled the same");
  ok(/var\(--/.test(yes.style.cssText) && !/#[0-9a-f]{3,6}\b/i.test(yes.style.cssText), "the buttons use design tokens, no raw hex");
  ok(/Google Analytics/.test(strip.textContent) && /page counter/.test(strip.textContent), "the strip names both counters");
  yes.click();
  await tick();
  ok(gtagLoaded(w) && consentDefault(w)?.analytics_storage === "granted", "Allow loads the Google tag, granted");
  const init = posthogInit(w);
  ok(!!init && init[0] === "phc_test" && init[1].persistence === "memory", "Allow loads PostHog, memory persistence only");
  ok(w.localStorage.getItem("a402-analytics-consent") === "granted" && !stripOf(w), "the choice is kept and the strip closes");
}
{
  const w = await run(page({ tz: "Europe/Paris" }));
  button(w, "No thanks").click();
  await tick();
  ok(nothingLoaded(w) && w.localStorage.getItem("a402-analytics-consent") === "denied", "No thanks: nothing loads and the denial is kept");
  const again = await run(page({ tz: "Europe/Paris", stored: "denied" }));
  ok(nothingLoaded(again) && !stripOf(again), "a kept denial: nothing loads, no strip");
}

// --- Elsewhere: granted by default ------------------------------------------
{
  const w = await run(page({ tz: "America/Chicago" }));
  ok(w.__regionReads === 1, "a non-European zone reads the region once");
  ok(gtagLoaded(w) && !!posthogInit(w) && !stripOf(w), "outside the asked region both counters load, no strip");
}
{
  const w = await run(page({ tz: "America/Chicago" }), { consent: false });
  ok(nothingLoaded(w), "no consent module on the page (an older cached page): nothing loads");
}

// --- PostHog library host: the page's own origin, never text from the page ---
{
  const own = await run(page({ stored: "granted" }));
  ok(scriptSrcs(own).includes("https://agent402.tools/e/static/array.js") && posthogInit(own)?.[1].api_host === "https://agent402.tools/e", "the library loads from the page's own /e proxy");
  for (const host of ["https://evil.example/e", "javascript:alert(1)//", "\"><img src=x onerror=alert(1)>"]) {
    const w = await run(page({ stored: "granted", phHost: host, ga: false }));
    ok(!scriptSrcs(w).some((s) => !s.startsWith("https://agent402.tools/")) && scriptSrcs(w).includes("https://agent402.tools/e/static/array.js") && posthogInit(w)?.[1].api_host === "https://agent402.tools/e", `an island naming another api_host (${host.slice(0, 24)}) still loads only from the page's own origin`);
  }
}

// --- PostHog URL sanitizer ---------------------------------------------------
{
  const w = await run(page({ url: "https://agent402.tools/monitors?product=recall-watch&target=metformin&utm_source=email&utm_campaign=d2#frag", stored: "granted" }));
  const init = posthogInit(w);
  ok(!!init && init[0] === "phc_test", "PostHog initializes with the island's key");
  const send = init && init[1].before_send;
  ok(typeof send === "function", "the loader installs a before_send hook");
  const ev = {
    event: "$pageview",
    properties: {
      $current_url: "https://agent402.tools/monitors?product=recall-watch&target=metformin&utm_source=email&utm_campaign=d2#frag",
      $pathname: "/monitors",
      $referrer: "https://agent402.tools/reports?target=aspirin&utm_medium=mail",
      $referring_domain: "agent402.tools",
      $session_entry_url: "https://agent402.tools/monitors?target=metformin",
      $prev_pageview_pathname: "/r/cs_secret123",
      $web_vitals_LCP_event: { name: "LCP", value: 1, $current_url: "https://agent402.tools/monitors?target=metformin" },
      $browser: "Chrome",
    },
    $set: { $current_url: "https://agent402.tools/x?session=abc" },
    $set_once: { $initial_current_url: "https://agent402.tools/alerts/confirm?id=a1&k=sig", $initial_referrer: "$direct", $initial_person_info: { u: "https://agent402.tools/m?target=x", r: "https://search.example/?q=metformin" } },
  };
  const out = send(ev);
  const p = out.properties;
  ok(p.$current_url === "https://agent402.tools/monitors?utm_source=email&utm_campaign=d2", `$current_url keeps utm_* and drops target and the fragment (${p.$current_url})`);
  ok(p.$referrer === "https://agent402.tools/reports?utm_medium=mail", `$referrer drops its target (${p.$referrer})`);
  ok(p.$session_entry_url === "https://agent402.tools/monitors", "$session_entry_url drops the query");
  ok(p.$web_vitals_LCP_event.$current_url === "https://agent402.tools/monitors", "a nested URL (web vitals event) is cleaned too");
  ok(p.$prev_pageview_pathname === "/r/[redacted]", `a bearer path is still redacted (${p.$prev_pageview_pathname})`);
  ok(p.$pathname === "/monitors" && p.$referring_domain === "agent402.tools" && p.$browser === "Chrome", "non-URL properties and a bare path stay as they are");
  ok(out.$set.$current_url === "https://agent402.tools/x", "$set URLs drop a session id");
  ok(out.$set_once.$initial_current_url === "https://agent402.tools/alerts/[redacted]", `$set_once bearer URL redacted with no query (${out.$set_once.$initial_current_url})`);
  ok(out.$set_once.$initial_referrer === "$direct", "\"$direct\" is left alone");
  ok(out.$set_once.$initial_person_info.u === "https://agent402.tools/m" && out.$set_once.$initial_person_info.r === "https://search.example/", "compressed person info (u, r) is cleaned");
  ok(!JSON.stringify(out).includes("metformin") && !JSON.stringify(out).includes("aspirin"), "no typed subject survives anywhere in the event");
  ok(init[1].disable_session_recording !== true, "control: replay flag untouched on a public path");
}

// --- Global Privacy Control --------------------------------------------------
{
  const w = await run(page({ gpc: true, tz: "Europe/Berlin" }));
  ok(nothingLoaded(w), "GPC: neither counter loads (no stub, no library request, no tag)");
  ok(!stripOf(w), "GPC: no consent strip, even in a European time zone");
  ok(w.document.querySelector("[data-analytics-choices]").hidden === true, "GPC: the analytics choices button stays hidden");
  ok(w.__regionReads === 0, "GPC: no region read");
}
{
  const w = await run(page({ gpc: true, stored: "granted", tz: "America/Chicago" }));
  ok(nothingLoaded(w), "GPC: a stored Allow does not override the signal");
}

// --- Automated browsers are internal traffic ---------------------------------
{
  const gaConfig = (w) => dl(w).find((a) => a[0] === "config")?.[2];
  const bot = await run(page({ webdriver: true, stored: "granted" }));
  ok(gaConfig(bot)?.traffic_type === "internal", "an automated browser (navigator.webdriver) is tagged traffic_type=internal");
  ok(gtagLoaded(bot), "the automated browser still loads the tag (the page load a tool measures is unchanged)");
  const human = await run(page({ webdriver: false, stored: "granted" }));
  ok(gaConfig(human) && !("traffic_type" in gaConfig(human)), "control: a browser without navigator.webdriver carries no traffic_type");
  const marked = await run(page({ url: "https://agent402.tools/monitors?internal=1", stored: "granted" }));
  ok(gaConfig(marked)?.traffic_type === "internal", "control: ?internal=1 still tags the browser");
}

// --- Footer button reopens the strip, outside Europe too ---------------------
{
  const html = ledgerFooterCompact();
  const tags = html.match(/<button[^>]*data-analytics-choices[^>]*>([^<]*)<\/button>/g) || [];
  ok(tags.length === 1 && /type="button"/.test(tags[0]) && /\bhidden\b/.test(tags[0]) && />analytics choices</.test(tags[0]), "footer: one hidden, labeled \"analytics choices\" button");
  ok(/\.ml-foot-links > button \{[^}]*color: var\(--muted\)/.test(readFileSync(new URL("../src/ledger-chrome.js", import.meta.url), "utf8")), "footer button is styled with tokens");

  const w = await run(page({ tz: "America/Chicago", stored: "granted" }));
  const btn = w.document.querySelector("[data-analytics-choices]");
  ok(!stripOf(w), "outside Europe with a stored choice: no strip on load");
  ok(btn.hidden === false, "the consent module shows the button");
  btn.click();
  ok(!!stripOf(w) && w.localStorage.getItem("a402-analytics-consent") === null, "clicking it clears the stored choice and opens the strip");
  ok(w.document.activeElement && w.document.activeElement.textContent === "No thanks", "focus moves into the strip");
  btn.click();
  ok(w.document.querySelectorAll('[aria-label="Analytics choice"]').length === 1, "a second click does not stack a second strip");
  w.document.cookie = "_ga=GA1.1.123; path=/";
  w.document.cookie = "_ga_TEST1234=GS1.1.1; path=/";
  const send = posthogInit(w)[1].before_send;
  button(w, "No thanks").click();
  const updates = dl(w).filter((a) => a[0] === "consent" && a[1] === "update");
  ok(updates.length === 1 && updates[0][2].analytics_storage === "denied", "No thanks sends a denied consent update");
  ok(w.localStorage.getItem("a402-analytics-consent") === "denied" && !stripOf(w), "the denial is stored and the strip closes");
  ok(!/_ga/.test(w.document.cookie), `withdrawing removes the _ga cookies (left: "${w.document.cookie}")`);
  ok(send({ event: "$pageleave", properties: {} }) === null, "withdrawing stops PostHog: later events are dropped before they are sent");
}
{
  // No counter islands (none configured, or a bearer page without GA and PostHog off): the button never shows.
  const w = await run(page({ ga: false, ph: false }));
  ok(w.document.querySelector("[data-analytics-choices]").hidden === true && !w.a402Consent, "without a counter configured the module does nothing and the button stays hidden");
}

// --- GET /api/consent-region -------------------------------------------------
{
  const { consentRegionFor, consentRegionRoute, ASK_FIRST_COUNTRIES } = await import("../src/consent-region.js");
  for (const c of ["DE", "fr", "IE", "IS", "LI", "NO", "GB", "CH", "CY", "RE"]) ok(consentRegionFor(c).asksFirst === true, `country ${c} asks first`);
  for (const c of ["US", "CA", "JP", "BR"]) ok(consentRegionFor(c).asksFirst === false, `country ${c} does not`);
  ok(consentRegionFor("XX").asksFirst === true && consentRegionFor("T1").asksFirst === true, "an unnamed country (XX, Tor) asks");
  ok(consentRegionFor(undefined).source === "unknown" && consentRegionFor(undefined).asksFirst === false && consentRegionFor("not a code").source === "unknown", "no header: unknown, and the browser's time zone stands");
  ok(ASK_FIRST_COUNTRIES.length >= 32, "the list holds the EU, the EEA, the UK and Switzerland");
  const h = {}; let body = null;
  const res = { set(k, v) { h[k.toLowerCase()] = v; return this; }, json(b) { body = b; return this; } };
  consentRegionRoute({ get: (k) => (k === "cf-ipcountry" ? "DE" : undefined) }, res);
  ok(body && body.asksFirst === true && Object.keys(body).sort().join() === "asksFirst,source", "the route answers one bit and its source, never the country");
  ok(/no-store/.test(h["cache-control"]) && /private/.test(h["cache-control"]), "the answer is never cached");
}

// --- /privacy copy -----------------------------------------------------------
{
  const { privacyPage } = await import("../src/privacy.js");
  // Visible text of the page, read through a DOM rather than a tag regex.
  const text = new JSDOM(privacyPage("https://agent402.tools")).window.document.body.textContent.replace(/\s+/g, " ");
  ok(!/page path, referrer and screen size/.test(text), "/privacy no longer under-lists the counter as path, referrer and screen size");
  for (const phrase of ["page views, page leaves", "page load timings (web vitals)", "operating system", "device type", "utm_* campaign parameters", "the address of the page that linked you here"]) {
    ok(text.includes(phrase), `/privacy lists: ${phrase}`);
  }
  ok(!/session storage/.test(text) && /keeps nothing in your browser/.test(text), "/privacy says the counter keeps nothing in the browser");
  ok(/European Union, the European Economic Area, the United Kingdom or Switzerland, neither Google Analytics nor the page counter loads until you choose "Allow"/.test(text), "/privacy says neither counter loads in Europe before Allow");
  ok(/Global Privacy Control signal, neither counter loads and you are not asked/.test(text), "/privacy states the GPC behavior");
  ok(/"analytics choices" at the foot of the page/.test(text) && /Wherever you are/.test(text), "/privacy says where to change the choice");
  ok(/consent, for the analytics counters/.test(text), "/privacy's rights section names consent as the counters' basis");
  ok(/not directed at children/.test(text) && /under 13/.test(text) && /18 and older/.test(text), "/privacy has a children statement matching /terms");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
