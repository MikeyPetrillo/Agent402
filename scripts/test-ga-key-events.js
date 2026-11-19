#!/usr/bin/env node
// The Google Analytics key events: the storefront scripts send the buy click
// and the checkout start to GA as well as to PostHog, so both can be marked
// key events in GA. Each script runs here in a sandbox with a stub DOM, a stub
// fetch and a recording gtag, and its own form or button is driven the way a
// buyer drives it. Every event carries the product and the kind only: what the
// buyer typed (a ticker, a question, a domain) never reaches GA.
//
// Offline: no server, no network, no browser.
import { readFileSync } from "node:fs";
import vm from "node:vm";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const src = (f) => readFileSync(new URL(`../assets/js/${f}`, import.meta.url), "utf8");
const TYPED = "TYPED-BY-BUYER-123";

function el(extra = {}) {
  const on = {};
  return {
    on, textContent: "", innerHTML: "", value: "", disabled: false, hidden: false, dataset: {},
    addEventListener(type, fn) { on[type] = fn; },
    getAttribute() { return null; }, setAttribute() {}, removeAttribute() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {} },
    ...extra,
  };
}

// Runs one script against a page made of `ids` (getElementById) and
// `lists` (querySelectorAll by selector), with fetch answering `reply`.
function run(file, { ids = {}, lists = {}, reply = { url: "https://checkout.example/session" }, gtag = true } = {}) {
  const events = [];
  const ph = [];
  const sandbox = {
    location: { search: "", pathname: "/reports" },
    document: {
      getElementById: (id) => ids[id] || null,
      querySelectorAll: (sel) => lists[sel] || [],
      querySelector: () => null,
      readyState: "complete",
      addEventListener() {},
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => reply }),
    URLSearchParams,
    posthog: { capture: (ev, props) => ph.push([ev, props]) },
    console,
  };
  if (gtag) sandbox.gtag = (...args) => events.push(args);
  sandbox.window = sandbox;
  vm.runInNewContext(src(file), sandbox, { filename: file });
  return { events, ph, sandbox };
}
const flush = () => new Promise((r) => setImmediate(r));
const names = (events) => events.filter((e) => e[0] === "event").map((e) => e[1]);
const leaks = (events) => JSON.stringify(events).includes(TYPED);

// --- /reports: the card form ---------------------------------------------------
async function reportsForm(opts = {}) {
  const btn = el();
  const form = el({ dataset: { kind: "dossier" }, querySelector: (s) => (s === "[data-buy]" ? btn : null) });
  const field = el({ value: TYPED });
  const r = run("reports.js", { ids: { "in-dossier": field, "err-dossier": el() }, lists: { ".pcard-form": [form] }, ...opts });
  await form.on.submit({ preventDefault() {} });
  await flush();
  return r;
}
{
  const { events, ph, sandbox } = await reportsForm();
  ok(JSON.stringify(names(events)) === JSON.stringify(["report_buy_click", "checkout_started"]), `/reports: GA gets report_buy_click, then checkout_started once the checkout opens (${names(events).join(", ")})`);
  const [, , click] = events[0] || [];
  ok(click && click.product === "dossier" && click.kind === "dossier" && click.transport_type === "beacon", "/reports: the click names the product and kind, sent as a beacon");
  ok(!leaks(events), "/reports: what the buyer typed never reaches GA");
  ok(ph.some(([ev]) => ev === "report_buy_click"), "/reports: PostHog still gets the click");
  ok(sandbox.location === "https://checkout.example/session", "/reports: the buyer is still sent to checkout");
}
{
  const { events } = await reportsForm({ reply: { error: "Could not start checkout." } });
  ok(JSON.stringify(names(events)) === JSON.stringify(["report_buy_click"]), "/reports control: a checkout that does not open sends no checkout_started");
}
{
  const { ph, sandbox } = await reportsForm({ gtag: false });
  ok(ph.length === 1 && sandbox.location === "https://checkout.example/session", "/reports: with GA off (no gtag) the buy goes through unchanged");
}

// --- programmatic report pages: the buy button ---------------------------------
async function reportBuy(opts = {}) {
  const btn = el({ dataset: { buyProduct: "insider-report", buyInput: TYPED } });
  const r = run("report-buy.js", { ids: { "err-buy": el() }, lists: { "[data-buy-product]": [btn] }, ...opts });
  await btn.on.click();
  await flush();
  return r;
}
{
  const { events } = await reportBuy();
  ok(JSON.stringify(names(events)) === JSON.stringify(["report_buy_click", "checkout_started"]), `report pages: report_buy_click then checkout_started (${names(events).join(", ")})`);
  ok(events.every((e) => e[2].product === "insider-report" && e[2].kind === "programmatic"), "report pages: product and kind programmatic on both events");
  ok(!leaks(events), "report pages: the page's own input never reaches GA");
}

// --- /monitors: the subscribe form ---------------------------------------------
async function monitorsForm(opts = {}) {
  const btn = el();
  const form = el({ dataset: { product: "domain-monitor" }, querySelector: (s) => (s === "[data-sub]" ? btn : null) });
  const r = run("monitors.js", { ids: { "in-domain-monitor": el({ value: TYPED }), "err-domain-monitor": el() }, lists: { ".pcard-form": [form] }, ...opts });
  await form.on.submit({ preventDefault() {} });
  await flush();
  return r;
}
{
  const { events } = await monitorsForm();
  ok(JSON.stringify(names(events)) === JSON.stringify(["monitor_subscribe_click", "monitor_checkout_started"]), `/monitors: monitor_subscribe_click then monitor_checkout_started (${names(events).join(", ")})`);
  ok(events.every((e) => e[2].product === "domain-monitor") && !leaks(events), "/monitors: the product only, never the watched target");
}
{
  const { events } = await monitorsForm({ reply: {} });
  ok(JSON.stringify(names(events)) === JSON.stringify(["monitor_subscribe_click"]), "/monitors control: no checkout_started when no checkout opens");
}

// --- the sample report page: read, its buy runs inside the page renderer --------
{
  const view = src("report-view.js");
  const sample = view.slice(view.indexOf("function wireSampleBuy"), view.indexOf("function titleKey"));
  ok(/ga\("report_buy_click", \{ product: s\.product, kind: "sample" \}\)/.test(sample) && /ga\("checkout_started", \{ product: s\.product, kind: "sample" \}\); window\.location = j\.url/.test(sample), "sample report: the buy sends report_buy_click and, once the checkout opens, checkout_started");
  ok(!/ga\([^)]*input/.test(sample), "sample report: the typed input is never a GA parameter");
}

// --- every GA event a site script sends is one of the key events ----------------
{
  const KEY_EVENTS = new Set(["report_buy_click", "checkout_started", "monitor_subscribe_click", "monitor_checkout_started"]);
  const { readdirSync } = await import("node:fs");
  const sent = [];
  for (const f of readdirSync(new URL("../assets/js/", import.meta.url)).filter((f) => f.endsWith(".js"))) {
    for (const m of src(f).matchAll(/\bga\("([a-z_]+)"/g)) sent.push([f, m[1]]);
  }
  ok(sent.length >= 8 && sent.every(([, ev]) => KEY_EVENTS.has(ev)), `site scripts send only the named key events to GA (${sent.length} call sites)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
