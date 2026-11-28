#!/usr/bin/env node
// Two pages written for searches that reached this site with no page to
// answer them: /insider-trades-api (SEC Form 4 insider trades by API) and
// /guides/agent-to-agent-payments (one agent paying another over x402).
// Each answers 200 with its own title and canonical, keeps its lead and body
// short, quotes only prices the catalog serves for the routes it names, and
// is listed in the sitemap and /llms.txt. The Form 4 page carries the
// source, non-affiliation and not-advice lines, and marks the report product
// model-backed where it names it.
//
//   node scripts/test-new-guides-2026-11.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";
import { stripTags, stripElements, decodeEntities } from "./lib/html-text.js";

const SITE = "https://agent402.tools";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const decode = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const titleOf = (html) => decode((html.match(/<title>([^<]*)<\/title>/) || [])[1] || "");
const canonOf = (html) => (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1] || null;
const descOf = (html) => decode((html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "");
/** The page's own prose: the main column with code blocks, scripts and styles removed. */
function proseOf(html, wrapClass) {
  const start = html.indexOf(`class="${wrapClass}"`);
  const end = html.indexOf("<footer", start);
  const part = stripElements(html.slice(start, end > start ? end : undefined), ["script", "style", "pre"]);
  return decode(stripTags(part, " ")).replace(/\s+/g, " ").trim();
}
const words = (s) => s.split(/\s+/).filter(Boolean).length;
const leadOf = (html, re) => decode(stripTags((html.match(re) || [])[1] || "", " ")).replace(/\s+/g, " ").trim();

// PORT=0, the bound port read back: no port is picked before the server binds it.
const srv = await bootServer({
  stores: "new-guides-2026-11",
  env: { FREE_MODE: "true", BASE_URL: SITE, X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0" },
});
const BASE = srv.url;
const get = async (p) => { const r = await fetch(`${BASE}${p}`, { redirect: "manual" }); return { status: r.status, text: await r.text() }; };

try {
  ok(srv.port > 0, `server booted on the port it bound (${srv.port})`);

  const pricing = JSON.parse((await get("/api/pricing")).text);
  const price = new Map(pricing.endpoints.map((e) => [e.slug, e.price]));
  const pathOf = new Map(pricing.endpoints.map((e) => [e.slug, `${e.method} ${e.path}`]));
  const sitemaps = (await Promise.all(["/sitemap.xml", "/sitemap-pages.xml", "/sitemap-guides.xml"].map(get))).map((r) => r.text).join("\n");
  const llms = (await get("/llms.txt")).text;
  const inSitemap = (p) => sitemaps.includes(`<loc>${SITE}${p}</loc>`);

  // --- /insider-trades-api ------------------------------------------------
  {
    const path = "/insider-trades-api";
    const r = await get(path);
    ok(r.status === 200, `${path} answers 200 (${r.status})`);
    const html = r.text;
    ok(titleOf(html) === "Insider trades API: SEC Form 4 data for agents | Agent402", `${path} carries its title (${titleOf(html)})`);
    ok(canonOf(html) === `${SITE}${path}`, `${path} is canonical to itself (${canonOf(html)})`);
    ok(/Form 4/.test(descOf(html)) && /Information only/.test(descOf(html)), `${path} meta description names Form 4 and says information only (${descOf(html)})`);
    const prose = proseOf(html, "sl-wrap");
    const lead = leadOf(html, /<p class="sl-lead">([\s\S]*?)<\/p>/);
    ok(lead && words(lead) <= 50, `${path} lead is at most 50 words (${words(lead)})`);
    ok(words(prose) <= 1000, `${path} body is at most 1,000 prose words (${words(prose)})`);
    ok(/Agent402 is not affiliated with or endorsed by the SEC\./.test(prose), `${path} says Agent402 is not affiliated with or endorsed by the SEC`);
    ok(/Information only, not investment advice\./.test(prose), `${path} says information only, not investment advice`);
    ok(/public records published by the U\.S\. Securities and Exchange Commission on EDGAR/.test(prose), `${path} names SEC EDGAR as the public source`);
    // The cheapest Form 4 route, its price and its published example input.
    ok(pathOf.get("edgar-insider-trades") === "GET /api/edgar-insider-trades", "the catalog serves GET /api/edgar-insider-trades");
    ok(prose.includes(`GET /api/edgar-insider-trades costs ${price.get("edgar-insider-trades")} a call`), `${path} quotes the list route's catalog price (${price.get("edgar-insider-trades")})`);
    ok(html.includes(`curl -i &quot;${SITE}/api/edgar-insider-trades?ticker=AAPL&amp;days=30&quot;`) || html.includes(`curl -i "${SITE}/api/edgar-insider-trades?ticker=AAPL&amp;days=30"`), `${path} shows a curl of the published example input`);
    for (const f of ["accessionNumber", "filedDate", "displayNames", "url", "windowDays", "returned"]) ok(prose.includes(f), `${path} names the answer field ${f}`);
    // The report product: its catalog price, and model-backed in the same sentence.
    ok(pathOf.get("insider-report") === "POST /v1/insider-report", "the catalog serves POST /v1/insider-report");
    ok(prose.includes(`POST /v1/insider-report (${price.get("insider-report")} a call, model-backed)`), `${path} names the report at its catalog price and marks it model-backed where it names it`);
    // Every dollar figure in the prose is a price the catalog serves for a route the page names.
    const named = new Set([price.get("edgar-insider-trades"), price.get("insider-report")]);
    const quoted = [...prose.matchAll(/\$\d+(?:\.\d+)?/g)].map((m) => m[0]);
    ok(quoted.length >= 2 && quoted.every((q) => named.has(q)), `${path} quotes only catalog prices (${quoted.join(", ")})`);
    ok(inSitemap(path), `${path} is in the sitemap`);
    ok(llms.includes(`${SITE}${path}`), `${path} is listed in /llms.txt`);
    const hub = await get("/reports/insider");
    ok(hub.text.includes(`href="${path}"`), `/reports/insider links ${path}`);
  }

  // --- /guides/agent-to-agent-payments --------------------------------------
  {
    const path = "/guides/agent-to-agent-payments";
    const r = await get(path);
    ok(r.status === 200, `${path} answers 200 (${r.status})`);
    const html = r.text;
    ok(titleOf(html) === "Agent-to-agent payments over x402 - Agent402", `${path} carries its title (${titleOf(html)})`);
    ok(canonOf(html) === `${SITE}${path}`, `${path} is canonical to itself (${canonOf(html)})`);
    ok(/x402/.test(descOf(html)) && /agent/.test(descOf(html)), `${path} meta description names x402 and agents (${descOf(html)})`);
    const prose = proseOf(html, "gp-wrap");
    const firstP = leadOf(html, /<div class="gp-body">\s*<p>([\s\S]*?)<\/p>/);
    ok(firstP && words(firstP) <= 50, `${path} lead is at most 50 words (${words(firstP)})`);
    ok(words(prose) <= 1000, `${path} body is at most 1,000 prose words (${words(prose)})`);
    for (const h of ["PAYMENT-REQUIRED", "PAYMENT-SIGNATURE", "PAYMENT-RESPONSE", "EIP-3009"]) ok(prose.includes(h), `${path} names ${h}`);
    ok(prose.includes(`(${price.get("x402-verify")})`) && prose.includes(`costs ${price.get("extract")}`), `${path} quotes x402-verify and extract at their catalog prices`);
    const named = new Set([price.get("x402-verify"), price.get("extract")]);
    const quoted = [...prose.matchAll(/\$\d+(?:\.\d+)?/g)].map((m) => m[0]);
    ok(quoted.length >= 2 && quoted.every((q) => named.has(q)), `${path} quotes only catalog prices (${quoted.join(", ")})`);
    for (const href of ["/guides/sell-your-api-over-x402", "/.well-known/agent-card.json", "/.well-known/x402", "/tools/x402-verify", "/guides/smart-order-router"]) ok(html.includes(`href="${href}"`), `${path} links ${href}`);
    ok(inSitemap(path), `${path} is in the sitemap`);
    ok(llms.includes(`${SITE}${path}`), `${path} is listed in /llms.txt`);
    ok((await get("/guides")).text.includes(`href="${path}"`), `/guides lists ${path}`);
    ok((await get("/guides/sell-your-api-over-x402")).text.includes(`href="${path}"`), `the selling guide links ${path}`);
    // The buying sample holds the per-call ceiling the next paragraph advises,
    // with the buyer SDK's real option and method, and the ceiling covers the
    // call the sample makes.
    {
      const code = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => decodeEntities(stripTags(m[1], "")))
        .find((c) => c.includes("wrapFetchWithPayment(fetch, client)")) || "";
      const cap = Number(/new Agent402\(\{ maxPerCallUsd: ([\d.]+) \}\)\.guardX402Client\(client\);/.exec(code)?.[1]);
      ok(code.includes('import { Agent402 } from "agent402-client";') && cap > 0 && code.indexOf("guardX402Client(client)") < code.indexOf("wrapFetchWithPayment(fetch, client)"),
        `${path}: the buying sample sets a ceiling per call before it wraps fetch (maxPerCallUsd ${cap})`);
      const { Agent402 } = await import("../client/index.js");
      const guarded = [];
      const fake = { onBeforePaymentCreation(fn) { guarded.push(fn); return this; }, onAfterPaymentCreation() { return this; }, registerPolicy(fn) { guarded.push(fn); return this; } };
      let built = null, err = null;
      try { built = new Agent402({ maxPerCallUsd: cap }); built.guardX402Client(fake); } catch (e) { err = e; }
      ok(!err && typeof Agent402.prototype.guardX402Client === "function" && guarded.length >= 1, `${path}: that option and method are the buyer SDK's own (${err ? err.message : "constructed"})`);
      const usd = Number(String(price.get("extract")).replace("$", ""));
      ok(usd > 0 && usd <= cap, `${path}: the sample's ceiling covers the call it makes (${price.get("extract")} at most $${cap})`);
      ok(/a ceiling per call in code, as above/.test(prose), `${path}: the advice points at the sample`);
    }
  }
  // --- the Form 4 example and the card sentences ---------------------------
  {
    const { EDGAR_TOOLS } = await import("../src/tools/edgar-kit.js");
    const { insiderTradesApiPage } = await import("../src/search-landings.js");
    const list = EDGAR_TOOLS.find((t) => t.slug === "edgar-insider-trades");
    const ex = list.discovery.output.example;
    const row = ex.trades[0];
    // A Form 4 row names a person: the published example names nobody real
    // and no filing that could be looked up, while its input stays a ticker
    // the tool answers.
    ok(/^Example /.test(ex.name) && /^0+$/.test(ex.cik), `the example issuer is a made-up one (${ex.name}, ${ex.cik})`);
    ok(row.displayNames.every((n) => /^EXAMPLE /.test(n)), `the example filer is a made-up one (${row.displayNames.join("; ")})`);
    ok(/^0{10}-00-0{6}$/.test(row.accessionNumber) && row.url.includes(row.accessionNumber.replace(/-/g, "")), `the example accession number is a placeholder and its url carries it (${row.accessionNumber})`);
    ok(list.discovery.input.ticker === "AAPL", "the example input stays a real ticker");
    const catalog = { [list.route]: list, "POST /v1/insider-report": { route: "POST /v1/insider-report", slug: "insider-report", price: "$2", modelBacked: true, discovery: { input: { ticker: "AAPL" } } } };
    const text = (html) => proseOf(html, "sl-wrap");
    const off = insiderTradesApiPage(SITE, catalog, { storefront: false });
    const on = insiderTradesApiPage(SITE, catalog, { storefront: true });
    ok(/made-up issuer, filer and accession number/.test(text(off)), "the page says the example row is made up");
    ok(/each row of a live answer links the filing itself/.test(text(off)) && !/; each row links the filing itself/.test(text(off)), "the page claims the filing link for live rows only");
    ok(!/by card/i.test(text(off)) && !off.includes('<a href="/reports">Reports'), "with the storefront off the page offers no report by card");
    ok(/People can buy the same report by card at Reports ?\./.test(text(on)) && /Reports by card/.test(text(on)), "with the storefront on the page offers the report by card");
    ok(on.includes(`<a href="/reports">Reports</a>`) && on.includes(`<a href="/reports">Reports by card</a>`) && !/href="\/reports\/insider"[^>]*>(Reports by card|Insider flow reports)/.test(on), "the card sentences link /reports, not the free hub");
    const html = (await get("/insider-trades-api")).text;
    ok(!/by card/i.test(text(html)), "this boot holds no card key, and its page offers no report by card");
  }
} finally {
  await srv.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
