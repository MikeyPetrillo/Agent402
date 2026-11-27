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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { ownStoreEnv } from "./lib/own-stores.js";
import { stripTags } from "./lib/html-text.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://agent402.tools";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const titleOf = (html) => decode((html.match(/<title>([^<]*)<\/title>/) || [])[1] || "");
const canonOf = (html) => (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1] || null;
const descOf = (html) => decode((html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "");
/** The page's own prose: the main column with code blocks, scripts and styles removed. */
function proseOf(html, wrapClass) {
  const start = html.indexOf(`class="${wrapClass}"`);
  const end = html.indexOf("<footer", start);
  const part = html.slice(start, end > start ? end : undefined)
    .replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<pre[\s\S]*?<\/pre>/g, " ");
  return decode(stripTags(part, " ")).replace(/\s+/g, " ").trim();
}
const words = (s) => s.split(/\s+/).filter(Boolean).length;
const leadOf = (html, re) => decode(stripTags((html.match(re) || [])[1] || "", " ")).replace(/\s+/g, " ").trim();

const PORT = await getFreePort();
const BASE = `http://127.0.0.1:${PORT}`;
const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, ...ownStoreEnv("new-guides-2026-11"), FREE_MODE: "true", PORT: String(PORT), BASE_URL: SITE, X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0" },
  stdio: "ignore",
});
const get = async (p) => { const r = await fetch(`${BASE}${p}`, { redirect: "manual" }); return { status: r.status, text: await r.text() }; };

try {
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
  ok(up, "server booted");

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
  }
} finally {
  proc.kill("SIGTERM");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
