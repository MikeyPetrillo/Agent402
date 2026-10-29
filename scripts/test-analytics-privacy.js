// Page analytics in a real DOM (jsdom), offline:
//   - the PostHog loader sends no query string but utm_* on any URL property,
//     and still redacts bearer paths;
//   - Global Privacy Control: PostHog does not load, GA stays denied, no strip;
//   - the footer's "analytics choices" button is rendered hidden, shown by the
//     GA loader, and reopens the strip for any visitor (not only Europe);
//   - /privacy lists what the counter receives and has a children statement.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const PH = readFileSync(new URL("../assets/js/posthog-loader.js", import.meta.url), "utf8");
const GA = readFileSync(new URL("../assets/js/ga-loader.js", import.meta.url), "utf8");
const { ledgerFooterCompact } = await import("../src/ledger-chrome.js");

// A page with the shell's islands and footer; the loader runs after parsing,
// as a deferred script does.
function page({ url = "https://agent402.tools/monitors", gpc = false, tz = "America/New_York", stored = null } = {}) {
  const html = `<!doctype html><html><head><script id="unused"></script></head><body>
<script type="application/json" id="posthog-config">{"key":"phc_test","cfg":{"api_host":"https://agent402.tools/e"}}</script>
<script type="application/json" id="ga-config">{"id":"G-TEST1234"}</script>
<main>page</main>${ledgerFooterCompact()}</body></html>`;
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const w = dom.window;
  if (gpc) Object.defineProperty(w.navigator, "globalPrivacyControl", { value: true, configurable: true });
  w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: tz }) }) };
  if (stored) w.localStorage.setItem("a402-analytics-consent", stored);
  return dom;
}
const posthogInit = (w) => w.posthog && Array.isArray(w.posthog._i) ? w.posthog._i[0] : null;
const consentDefault = (w) => [...(w.dataLayer || [])].map((a) => [...a]).find((a) => a[0] === "consent" && a[1] === "default")?.[2];
const stripOf = (w) => w.document.querySelector('[aria-label="Analytics choice"]');
// jsdom fires DOMContentLoaded after construction; the loader's own listener
// was added first, so it has run when this one resolves.
const settled = (w) => new Promise((r) => (w.document.readyState === "loading" ? w.document.addEventListener("DOMContentLoaded", () => r()) : r()));
const runGa = async (w) => { w.eval(GA); await settled(w); };
const scriptSrcs = (w) => [...w.document.querySelectorAll("script[src]")].map((s) => s.src);

// --- PostHog URL sanitizer ---------------------------------------------------
{
  const dom = page({ url: "https://agent402.tools/monitors?product=recall-watch&target=metformin&utm_source=email&utm_campaign=d2#frag" });
  dom.window.eval(PH);
  const init = posthogInit(dom.window);
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
  const dom = page({ gpc: true, tz: "Europe/Berlin" });
  dom.window.eval(PH);
  ok(!dom.window.posthog && !scriptSrcs(dom.window).some((s) => /\/static\/array\.js/.test(s)), "GPC: PostHog does not load (no stub, no library request)");
  await runGa(dom.window);
  ok(consentDefault(dom.window)?.analytics_storage === "denied", "GPC: GA analytics storage is denied");
  ok(!stripOf(dom.window), "GPC: no consent strip, even in a European time zone");
  ok(dom.window.document.querySelector("[data-analytics-choices]").hidden === true, "GPC: the analytics choices button stays hidden");
}
{
  // GPC beats a stored "granted".
  const dom = page({ gpc: true, stored: "granted" });
  await runGa(dom.window);
  ok(consentDefault(dom.window)?.analytics_storage === "denied", "GPC: a stored Allow does not override the signal");
}
{
  // Controls: without GPC the same pages load PostHog and ask in Europe.
  const dom = page({ tz: "Europe/Berlin" });
  dom.window.eval(PH);
  ok(!!posthogInit(dom.window), "control: no GPC, PostHog loads");
  await runGa(dom.window);
  ok(consentDefault(dom.window)?.analytics_storage === "denied" && !!stripOf(dom.window), "control: no GPC, a European time zone starts denied and sees the strip");
}

// --- Footer button reopens the strip, outside Europe too ---------------------
{
  const html = ledgerFooterCompact();
  const tags = html.match(/<button[^>]*data-analytics-choices[^>]*>([^<]*)<\/button>/g) || [];
  ok(tags.length === 1 && /type="button"/.test(tags[0]) && /\bhidden\b/.test(tags[0]) && />analytics choices</.test(tags[0]), "footer: one hidden, labeled \"analytics choices\" button");
  ok(/\.ml-foot-links > button \{[^}]*color: var\(--muted\)/.test(readFileSync(new URL("../src/ledger-chrome.js", import.meta.url), "utf8")), "footer button is styled with tokens");

  const dom = page({ tz: "America/Chicago", stored: "granted" });
  const w = dom.window;
  await runGa(w);
  const btn = w.document.querySelector("[data-analytics-choices]");
  ok(!stripOf(w), "outside Europe with a stored choice: no strip on load");
  ok(btn.hidden === false, "the GA loader shows the button");
  btn.click();
  ok(!!stripOf(w) && w.localStorage.getItem("a402-analytics-consent") === null, "clicking it clears the stored choice and opens the strip");
  ok(w.document.activeElement && w.document.activeElement.textContent === "No thanks", "focus moves into the strip");
  btn.click();
  ok(w.document.querySelectorAll('[aria-label="Analytics choice"]').length === 1, "a second click does not stack a second strip");
  w.document.cookie = "_ga=GA1.1.123; path=/";
  w.document.cookie = "_ga_TEST1234=GS1.1.1; path=/";
  const no = [...stripOf(w).querySelectorAll("button")].find((b) => b.textContent === "No thanks");
  no.click();
  const updates = [...w.dataLayer].map((a) => [...a]).filter((a) => a[0] === "consent" && a[1] === "update");
  ok(updates.length === 1 && updates[0][2].analytics_storage === "denied", "No thanks sends a denied consent update");
  ok(w.localStorage.getItem("a402-analytics-consent") === "denied" && !stripOf(w), "the denial is stored and the strip closes");
  ok(!/_ga/.test(w.document.cookie), `withdrawing removes the _ga cookies (left: "${w.document.cookie}")`);
}
{
  // No GA island (GA unset or a bearer page): the button never shows.
  const dom = new JSDOM(`<!doctype html><body>${ledgerFooterCompact()}</body>`, { url: "https://agent402.tools/", runScripts: "outside-only" });
  await runGa(dom.window);
  ok(dom.window.document.querySelector("[data-analytics-choices]").hidden === true, "without GA configured the button stays hidden");
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
  ok(/Global Privacy Control signal, the cookie stays off, you are not asked, and the page counter does not load/.test(text), "/privacy states the GPC behavior");
  ok(/"analytics choices" at the foot of the page/.test(text) && /Wherever you are/.test(text), "/privacy says where to change the choice");
  // The rights section names the consent basis; the loader keys the wait on
  // the browser's time zone, so the section says so beside it.
  ok(/consent, for the analytics cookie[^.]*\.[^.]*European time zone, the cookie waits for your choice/.test(text), "/privacy's rights section says the cookie waits for a choice where the browser reports a European time zone");
  ok(/not directed at children/.test(text) && /under 13/.test(text) && /18 and older/.test(text), "/privacy has a children statement matching /terms");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
