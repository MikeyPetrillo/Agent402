#!/usr/bin/env node
// The named source of a card sale (src/sale-source.js), from the page address
// to the sales ledger, offline.
//
//   node scripts/test-sale-source.js
//
// Module half:
//   - only a listed name in the strict shape is a source; anything else is dropped
//   - a ledger file written before the column gains it; a card sale stores its
//     source, a sale with an unlisted one stores none
//   - cardSalesBySource counts reports and subscription invoices per source,
//     and only the detailed (operator) summary carries it
//   - the report checkout and the monitor checkout put a listed source in the
//     session metadata and hand it to the sale hook from the PAID session
//   - the storefront scripts send the page's utm_source with the checkout
//     request, the page's storefront links carry it forward, and nothing is
//     written to browser storage
// Booted half (the REAL server, Stripe answered by a local stub): /api/buy and
// /api/subscribe carry a listed source into the session Stripe is asked for
// and drop any other; /__operator/sales.json counts a stored sale by source;
// no public surface names it.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/file-mode.js";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import Database from "better-sqlite3";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const TMP = mkdtempSync(join(tmpdir(), "sale-source-"));
const FILE = join(TMP, "sales.db");
const OLD_SCHEMA = "CREATE TABLE sales (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, slug TEXT NOT NULL, price_usd REAL NOT NULL, rail TEXT NOT NULL, network TEXT, payer TEXT, tx TEXT, internal INTEGER NOT NULL, wire TEXT)";
const OLD_INSERT = "INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?,?,?,?,?,?,?,?,?)";

// ---- the file a build before the column wrote ---------------------------------
{
  const f = new Database(FILE);
  f.exec(OLD_SCHEMA);
  f.prepare(OLD_INSERT).run(Date.now() - 3600_000, "dossier", 2, "card", "stripe", null, "pi_old", 0, "stripe-checkout");
  f.close();
}
process.env.SALES_LEDGER_DB = FILE;
const { cleanSaleSource, KNOWN_SALE_SOURCES } = await import("../src/sale-source.js");
const sl = await import("../src/sales-ledger.js");

// ---- what counts as a source ----------------------------------------------------
ok(KNOWN_SALE_SOURCES.includes("ask402") && cleanSaleSource("ask402") === "ask402", "a listed name is a source");
for (const bad of ["newsletter", "ASK402", " ask402", "ask402 ", "ask402<script>", "ask402\n", "a".repeat(33), "", "-ask402", "jane.doe@example.com", null, undefined, 7, ["ask402"], { toString: () => "ask402" }]) {
  ok(cleanSaleSource(bad) === null, `not a source: ${JSON.stringify(bad)}`);
}

// ---- the ledger stores it on a card sale ------------------------------------------
{
  sl.recordSale({ slug: "dossier", priceUsd: 2, rail: "card", network: "stripe", payer: null, tx: "pi_a", wire: "stripe-checkout", source: "ask402" });
  sl.recordSale({ slug: "research", priceUsd: 2, rail: "card", network: "stripe", payer: null, tx: "pi_b", wire: "stripe-checkout", source: "ask402" });
  sl.recordSale({ slug: "domain-monitor", priceUsd: 9, rail: "card", network: "stripe", payer: null, tx: "in_a", wire: "stripe-subscription", source: "ask402" });
  sl.recordSale({ slug: "dossier", priceUsd: 2, rail: "card", network: "stripe", payer: null, tx: "pi_c", wire: "stripe-checkout", source: "typed by a visitor" });
  sl.recordSale({ slug: "dossier", priceUsd: 2, rail: "card", network: "stripe", payer: null, tx: "pi_d", wire: "stripe-checkout" });
  const raw = new Database(FILE, { readonly: true });
  const rows = raw.prepare("SELECT tx, source FROM sales ORDER BY id").all();
  raw.close();
  const of = (tx) => rows.find((r) => r.tx === tx)?.source;
  ok(of("pi_old") === null, "a row written before the column has no source");
  ok(of("pi_a") === "ask402" && of("in_a") === "ask402", "a card sale and a subscription invoice store their source");
  ok(of("pi_c") === null && of("pi_d") === null, "an unlisted source, or none, stores nothing");
  const by = sl.cardSalesBySource({ days: 30 });
  ok(by.sources.ask402?.sales === 3 && by.sources.ask402.reports === 2 && by.sources.ask402.subscriptionInvoices === 1 && by.sources.ask402.revenueUsd === 13, `card sales by source: ${JSON.stringify(by.sources)}`);
  ok(Object.keys(by.sources).length === 1 && by.noSource.sales === 3 && by.noSource.revenueUsd === 6, `sales that named none are counted apart (${JSON.stringify(by.noSource)})`);
  const detailed = sl.salesSummary({ days: 30, detailed: true });
  const brief = sl.salesSummary({ days: 30 });
  ok(detailed.cardBySource?.sources?.ask402?.sales === 3, "the detailed (operator) summary carries the count");
  ok(!JSON.stringify(brief).includes("ask402") && !("cardBySource" in brief), "the plain summary does not");
  ok(!JSON.stringify(sl.cardSales({ days: 30 })).includes("ask402"), "the /revenue card figures do not");
}

// ---- report checkout: request -> session metadata -> the sale hook ----------------
{
  const { createHumanCheckout } = await import("../src/human-checkout.js");
  const sessions = {
    cs_src: { id: "cs_src", payment_status: "paid", payment_intent: "pi_src", metadata: { product: "dossier", input: "AAPL", source: "ask402" } },
    cs_bad: { id: "cs_bad", payment_status: "paid", payment_intent: "pi_bad", metadata: { product: "dossier", input: "AAPL", source: "someone@example.com" } },
    cs_none: { id: "cs_none", payment_status: "paid", payment_intent: "pi_none", metadata: { product: "dossier", input: "AAPL" } },
  };
  const stripe = {
    checkout: { sessions: {
      create: async (args) => { stripe._last = args; return { id: "cs_new", url: "https://checkout.stripe.com/pay/cs_new" }; },
      retrieve: async (id) => { const s = sessions[id]; if (!s) throw new Error("No such session"); return s; },
    } },
    refunds: { create: async () => ({ id: "re_1", status: "succeeded" }) },
  };
  const sales = [];
  const hc = createHumanCheckout({ stripe, generate: async (_k, slug, input) => ({ report: `# R (${slug})\n\n${input} [1]`, title: "T", sources: [], tables: [] }), baseUrl: "https://agent402.tools", storeDir: join(TMP, "human-checkout"), onSale: (s) => sales.push(s), log: () => {} });
  await hc.createSession("dossier", "AAPL", { source: "ask402" });
  ok(stripe._last.metadata.source === "ask402" && stripe._last.metadata.product === "dossier" && stripe._last.metadata.input === "AAPL", "a listed source rides in the report session's metadata");
  for (const bad of ["newsletter", "ask402<script>", "someone@example.com", { a: 1 }, ["ask402"]]) {
    await hc.createSession("dossier", "AAPL", { source: bad });
    ok(!("source" in stripe._last.metadata), `the report session carries no source for ${JSON.stringify(bad)}`);
  }
  await hc.createSession("dossier", "AAPL");
  ok(!("source" in stripe._last.metadata), "a checkout that named none carries none");
  const settle = async (id) => { for (let i = 0; i < 200; i++) { const r = await hc.fulfill(id); if (r.status === "done" || r.status === "error") return r; await new Promise((r2) => setTimeout(r2, 10)); } return { status: "timeout" }; };
  for (const id of Object.keys(sessions)) ok((await settle(id)).status === "done", `${id}: the report is delivered`);
  const sold = (id) => sales.find((s) => s.sessionId === id);
  ok(sold("cs_src")?.source === "ask402", "the sale hook reads the source from the paid session");
  ok(sold("cs_bad") && sold("cs_bad").source === null && sold("cs_none") && sold("cs_none").source === null, "session metadata that is not a listed source books none");
  hc.stop?.();
}

// ---- monitor checkout: request -> both metadata -> the invoice hook ---------------
{
  const { createStripeSubscriptions } = await import("../src/stripe-subscriptions.js");
  const stripe = {
    checkout: { sessions: { create: async (args) => { stripe._last = args; return { id: "cs_new", url: "https://checkout.stripe.com/pay/cs_new" }; }, retrieve: async () => { throw new Error("No such session"); } } },
    subscriptions: { retrieve: async (id) => ({ id, status: "active" }) },
    webhooks: { constructEvent: (body) => JSON.parse(body.toString()) },
  };
  const invoices = [];
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const subs = createStripeSubscriptions({ stripe, baseUrl: "https://agent402.tools", storePath: join(TMP, "subs.json"), onInvoicePaid: (i) => invoices.push(i) });
  await subs.createCheckout("domain-monitor", "example.com", { source: "ask402" });
  ok(stripe._last.metadata.source === "ask402" && stripe._last.subscription_data.metadata.source === "ask402", "a listed source rides on the monitor session and its subscription");
  await subs.createCheckout("domain-monitor", "example.com", { source: "newsletter" });
  ok(!("source" in stripe._last.metadata) && !("source" in stripe._last.subscription_data.metadata), "an unlisted source rides on neither");
  const paid = (id, sub, meta) => subs.handleWebhook(Buffer.from(JSON.stringify({ id: `evt_${id}`, type: "invoice.paid", data: { object: { id, subscription: sub, customer: "cus_1", amount_paid: 900, parent: { subscription_details: { metadata: meta } } } } })), "sig");
  await paid("in_src", "sub_src", { product: "domain-monitor", target: "example.com", source: "ask402" });
  await paid("in_bad", "sub_bad", { product: "domain-monitor", target: "example.com", source: "x y z" });
  await paid("in_none", "sub_none", { product: "domain-monitor", target: "example.com" });
  const inv = (id) => invoices.find((i) => i.invoiceId === id);
  ok(inv("in_src")?.source === "ask402", `a paid invoice hands its subscription's source to the sale hook (${JSON.stringify(inv("in_src"))})`);
  ok(inv("in_bad") && inv("in_bad").source === null && inv("in_none") && inv("in_none").source === null, "an invoice whose subscription names no listed source books none");
  delete process.env.STRIPE_WEBHOOK_SECRET;
}

// ---- the storefront scripts ---------------------------------------------------------
const js = (f) => readFileSync(new URL(`../assets/js/${f}`, import.meta.url), "utf8");
{
  // The tag block of site-chrome.js, run alone against a page address.
  const chrome = js("site-chrome.js");
  const block = chrome.slice(chrome.indexOf("window.a402Source="));
  ok(block.length > 0 && chrome.includes("window.a402Source="), "site-chrome.js defines the page's source");
  const tagged = (search, hrefs) => {
    const links = hrefs.map((h) => ({ h, getAttribute() { return this.h; }, setAttribute(_k, v) { this.h = v; } }));
    const sandbox = { location: { search }, URLSearchParams, document: { readyState: "complete", addEventListener() {}, querySelectorAll: () => links } };
    sandbox.window = sandbox;
    vm.runInNewContext(block, sandbox, { filename: "site-chrome.js" });
    return { source: sandbox.a402Source(), hrefs: links.map((l) => l.h) };
  };
  const HREFS = ["/reports", "/monitors#manage", "/reports/sample/dossier", "/docs", "/reports?product=dossier&input=AAPL", "https://example.com/reports", "/reportsx", "/monitors/"];
  const a = tagged("?utm_source=ask402&utm_medium=referral&utm_content=what-is-x402", HREFS);
  ok(a.source === "ask402", "the page's source is its utm_source");
  ok(JSON.stringify(a.hrefs) === JSON.stringify(["/reports?utm_source=ask402", "/monitors?utm_source=ask402#manage", "/reports/sample/dossier?utm_source=ask402", "/docs", "/reports?product=dossier&input=AAPL", "https://example.com/reports", "/reportsx", "/monitors/?utm_source=ask402"]), `storefront links carry it forward, nothing else changes (${JSON.stringify(a.hrefs)})`);
  for (const bad of ["?utm_source=Ask402", "?utm_source=ask402%3Cscript%3E", "?utm_source=a%20b", "?utm_source=" + "a".repeat(40), "?utm_source=", "", "?source=ask402"]) {
    const b = tagged(bad, HREFS);
    ok(b.source === "" && JSON.stringify(b.hrefs) === JSON.stringify(HREFS), `no source, no link change: ${bad || "(no query)"}`);
  }
  ok(!/localStorage|sessionStorage|document\.cookie/.test(block), "the tag is never written to browser storage");
}
{
  // Each buy script sends the page's source with its checkout request.
  const el = (extra = {}) => ({ on: {}, textContent: "", innerHTML: "", value: "", disabled: false, hidden: false, dataset: {}, addEventListener(t, fn) { this.on[t] = fn; }, getAttribute() { return null; }, setAttribute() {}, removeAttribute() {}, focus() {}, scrollIntoView() {}, querySelector() { return null; }, querySelectorAll() { return []; }, classList: { add() {}, remove() {} }, ...extra });
  const run = async (file, { ids, lists, drive, source }) => {
    const posts = [];
    const sandbox = {
      location: { search: "", pathname: "/reports" }, URLSearchParams, console,
      document: { getElementById: (id) => ids[id] || null, querySelectorAll: (s) => lists[s] || [], querySelector: () => null, readyState: "complete", addEventListener() {} },
      fetch: async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ url: "https://checkout.example/session" }) }; },
    };
    sandbox.window = sandbox;
    if (source !== undefined) sandbox.a402Source = () => source;
    vm.runInNewContext(js(file), sandbox, { filename: file });
    await drive();
    await new Promise((r) => setImmediate(r));
    return posts;
  };
  const cases = {
    "reports.js": () => { const btn = el(); const form = el({ dataset: { kind: "dossier" }, querySelector: (s) => (s === "[data-buy]" ? btn : null) }); return { ids: { "in-dossier": el({ value: "AAPL" }), "err-dossier": el() }, lists: { ".pcard-form": [form] }, drive: () => form.on.submit({ preventDefault() {} }), url: "/api/buy" }; },
    "monitors.js": () => { const btn = el(); const form = el({ dataset: { product: "domain-monitor" }, querySelector: (s) => (s === "[data-sub]" ? btn : null) }); return { ids: { "in-domain-monitor": el({ value: "example.com" }), "err-domain-monitor": el() }, lists: { ".pcard-form": [form] }, drive: () => form.on.submit({ preventDefault() {} }), url: "/api/subscribe" }; },
    "report-buy.js": () => { const btn = el({ dataset: { buyProduct: "insider-report", buyInput: "AAPL" } }); return { ids: { "err-buy": el() }, lists: { "[data-buy-product]": [btn] }, drive: () => btn.on.click(), url: "/api/buy" }; },
  };
  for (const [file, make] of Object.entries(cases)) {
    const c = make();
    const withSource = await run(file, { ...c, source: "ask402" });
    ok(withSource.length === 1 && withSource[0].url === c.url && withSource[0].body.source === "ask402", `${file}: the checkout request carries the page's source (${JSON.stringify(withSource[0]?.body)})`);
    const c2 = make();
    const none = await run(file, { ...c2, source: "" });
    ok(none.length === 1 && !("source" in none[0].body), `${file}: a page with no source sends none`);
    const c3 = make();
    const bare = await run(file, { ...c3 });
    ok(bare.length === 1 && !("source" in bare[0].body), `${file}: the checkout goes through before the page script has loaded`);
  }
  const view = js("report-view.js");
  ok((view.match(/source: \(window\.a402Source && window\.a402Source\(\)\) \|\| undefined/g) || []).length === 2, "report-view.js: its report and monitor checkouts send the page's source");
}

// ---- booted: the request reaches Stripe's session, the operator reads the count ---
const stripeCalls = [];
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    const path = String(req.url).split("?")[0];
    stripeCalls.push({ method: req.method, path, form: new URLSearchParams(body) });
    res.writeHead(200, { "content-type": "application/json", "request-id": "req_stub" });
    res.end(JSON.stringify(req.method === "POST" && path === "/v1/checkout/sessions" ? { id: "cs_test_stub", object: "checkout.session", url: "https://checkout.stripe.test/c/stub" } : { object: "list", data: [], has_more: false }));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const BOOT_DB = join(TMP, "boot-sales.db");
{
  // A stored sale under a name no page prints, so a public surface that held
  // it would be caught by the name alone.
  const f = new Database(BOOT_DB);
  f.exec(OLD_SCHEMA);
  f.exec("ALTER TABLE sales ADD COLUMN source TEXT");
  f.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire, source) VALUES (?,?,?,?,?,?,?,?,?,?)").run(Date.now() - 60_000, "dossier", 2, "card", "stripe", null, "pi_seeded", 0, "stripe-checkout", "seededsrc");
  f.prepare(OLD_INSERT).run(Date.now() - 50_000, "dossier", 2, "card", "stripe", null, "pi_plain", 0, "stripe-checkout");
  f.close();
}
const OP = "op-" + "7c".repeat(16);
let srv = null;
try {
  srv = await bootServer({
    stores: "sale-source",
    args: ["--import", "./scripts/lib/stripe-stub-preload.js"],
    env: { FREE_MODE: "true", STRIPE_SECRET_KEY: "sk_test_stub", STRIPE_STUB_PORT: String(stub.address().port), STRIPE_WEBHOOK_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", POSTHOG_API_KEY: "", CREDITS_SALES: "",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", AGENT402_OPERATOR_TOKEN: OP, SALES_LEDGER_DB: BOOT_DB },
  });
  const B = srv.url;
  const post = async (path, body) => { const r = await fetch(`${B}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const lastSession = () => stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/checkout/sessions").at(-1)?.form;
  const buy = await post("/api/buy", { product: "dossier", input: "AAPL", source: "ask402" });
  ok(buy.status === 200 && buy.json?.url === "https://checkout.stripe.test/c/stub", `/api/buy opens a checkout (${buy.status} ${JSON.stringify(buy.json)})`);
  ok(lastSession()?.get("metadata[source]") === "ask402" && lastSession()?.get("metadata[product]") === "dossier" && lastSession()?.get("metadata[input]") === "AAPL", "/api/buy: the session Stripe is asked for carries the source beside the product and input");
  // The card checkout routes share a per-address limit of a few calls a
  // minute: this half makes five, and the module half above covers every shape.
  for (const bad of ["ask402<script>"]) {
    const r = await post("/api/buy", { product: "dossier", input: "AAPL", source: bad });
    ok(r.status === 200 && lastSession() && !lastSession().has("metadata[source]") && ![...lastSession().keys()].some((k) => /source/.test(k)), `/api/buy: ${JSON.stringify(bad)} opens the checkout with no source`);
  }
  const plain = await post("/api/buy", { product: "dossier", input: "AAPL" });
  ok(plain.status === 200 && !lastSession().has("metadata[source]"), "/api/buy control: a request that names none carries none");
  const sub = await post("/api/subscribe", { product: "domain-monitor", target: "example.com", source: "ask402" });
  ok(sub.status === 200 && lastSession()?.get("mode") === "subscription" && lastSession().get("metadata[source]") === "ask402" && lastSession().get("subscription_data[metadata][source]") === "ask402", `/api/subscribe: the session and its subscription carry the source (${sub.status} ${JSON.stringify(sub.json)})`);
  const sub2 = await post("/api/subscribe", { product: "domain-monitor", target: "example.com", source: "newsletter" });
  ok(sub2.status === 200 && lastSession()?.get("mode") === "subscription" && ![...lastSession().keys()].some((k) => /source/.test(k)), "/api/subscribe: an unlisted source is dropped");
  const sales = await (await fetch(`${B}/__operator/sales.json`, { headers: { "x-operator-token": OP } })).json();
  ok(sales.cardBySource?.sources?.seededsrc?.sales === 1 && sales.cardBySource.sources.seededsrc.revenueUsd === 2 && sales.cardBySource.noSource?.sales === 1, `/__operator/sales.json counts card sales by source (${JSON.stringify(sales.cardBySource)})`);
  ok((await fetch(`${B}/__operator/sales.json`)).status === 404, "sales.json is 404 without the operator token");
  for (const p of ["/api/stats", "/api/revenue", "/revenue", "/api/gateway-status", "/reports", "/api/pricing", "/health"]) {
    const r = await fetch(`${B}${p}`);
    const text = await r.text();
    ok(r.status === 200 && !/seededsrc|cardBySource/.test(text), `${p}: the source is not on this public surface (${r.status})`);
  }
} catch (e) {
  ok(false, e?.stack || String(e));
  if (srv) for (const l of srv.log().split("\n").slice(-25)) console.error("  server:", l.slice(0, 300));
}
await srv?.stop();
stub.close();
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
