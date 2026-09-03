#!/usr/bin/env node
// Real sample reports (assets/samples -> /reports/sample/<product>).
//
// Every fixture must be a finished report a buyer could have received (a stub
// with "..." in it is exactly what these replaced), every served sample page
// must be indexable with its own title/canonical/JSON-LD, the JSON the viewer
// fetches must be the done-shaped bundle, and the /reports cards must link the
// sample only for products that have one. Boots a FREE_MODE server (no Stripe:
// the sample routes are mounted regardless of checkout).
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { getFreePort } from "./lib/free-port.js";
import { SAMPLES, SAMPLE_PRODUCTS, sampleLinkFor, samplePaths } from "../src/sample-reports.js";
import { HUMAN_PRODUCTS } from "../src/human-checkout.js";

let pass = 0;
let proc = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures (offline) ----
const files = readdirSync("assets/samples").filter((f) => f.endsWith(".json"));
ok(files.length >= 4, `at least four sample fixtures exist (${files.length})`);
ok(SAMPLE_PRODUCTS.length === files.length, `every fixture loads (${SAMPLE_PRODUCTS.length} of ${files.length})`);
for (const product of SAMPLE_PRODUCTS) {
  const s = SAMPLES[product];
  const raw = JSON.parse(readFileSync(`assets/samples/${product}.json`, "utf8"));
  ok(HUMAN_PRODUCTS[product] && s.slug === HUMAN_PRODUCTS[product].slug && s.kind === HUMAN_PRODUCTS[product].kind, `${product}: fixture maps to a sold product (${s.slug}, ${s.kind})`);
  ok(s.report.length >= 4000 && !/\n\.\.\.\n|Example Corp|EXMP/.test(s.report), `${product}: a real finished report (${s.report.length} chars, no stub markers)`);
  ok(s.title && !/[—–]/.test(s.title) && s.input && s.at, `${product}: title, input and generation date present ("${s.title.slice(0, 50)}")`);
  ok(s.status === "done" && s.sample === true && s.product === product && Number.isFinite(s.priceUsd) && s.priceUsd >= 2, `${product}: served shape is a done bundle flagged sample with the card price ($${s.priceUsd})`);
  ok(!raw.email && !raw.sessionId && !raw.buyerKey, `${product}: fixture carries no buyer fields`);
  // A recall report cites its three FDA feeds; a domain audit measures rather
  // than cites; every other kind is a web/EDGAR synthesis with many sources.
  const minSources = s.kind === "domain" ? 0 : s.kind === "recall" ? 3 : 5;
  ok(s.sources.length >= minSources, `${product}: cites at least ${minSources} sources (${s.sources.length})`);
}
ok(sampleLinkFor("dossier") === "/reports/sample/dossier" && sampleLinkFor("research-pro") === null, "sampleLinkFor: a slug with a fixture links, one without does not");
ok(samplePaths().every((p) => p.startsWith("/reports/sample/")), "sample paths live under /reports/sample/");

// ---- booted server ----
const PORT = await getFreePort();
const B = `http://127.0.0.1:${PORT}`;
proc = spawn("node", ["src/server.js"], { env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", STRIPE_SECRET_KEY: "" }, stdio: "ignore" });
try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }
  ok((await fetch(`${B}/health`)).ok, "server booted (FREE_MODE, no Stripe)");

  for (const product of SAMPLE_PRODUCTS) {
    const page = await fetch(`${B}/reports/sample/${product}`);
    const html = await page.text();
    const s = SAMPLES[product];
    ok(page.status === 200 && !/noindex/i.test(page.headers.get("x-robots-tag") || ""), `${product}: page 200 and not noindex`);
    ok(html.includes(`<title>${escapeHtml(s.title)} (free sample)</title>`) || html.includes(`(free sample)</title>`), `${product}: own <title>`);
    ok(html.includes(`rel="canonical" href="${"http://127.0.0.1:" + PORT}/reports/sample/${product}"`) || html.includes(`/reports/sample/${product}"`), `${product}: canonical is the sample URL`);
    ok(html.includes('"@type":"Report"') && html.includes('"isAccessibleForFree":true') && html.includes('"@type":"Product"'), `${product}: Report + Product JSON-LD`);
    ok(html.includes('data-api="/api/reports/sample/"') && html.includes("/js/report-view.js"), `${product}: renders through the shared viewer`);
    ok(!/<meta name="robots" content="noindex/.test(html), `${product}: meta robots allows indexing`);
    const j = await (await fetch(`${B}/api/reports/sample/${product}`)).json();
    ok(j.status === "done" && j.sample === true && j.report === s.report && j.product === product, `${product}: JSON is the done bundle the viewer expects`);
  }
  const nf = await fetch(`${B}/reports/sample/not-a-product`);
  ok(nf.status === 404 && (await fetch(`${B}/api/reports/sample/not-a-product`)).status === 404, "unknown product -> 404 on both routes");

  const reports = await (await fetch(`${B}/reports`)).text();
  const links = reports.match(/href="\/reports\/sample\/[a-z-]+"/g) || [];
  ok(links.length >= SAMPLE_PRODUCTS.length, `/reports links the samples (${links.length} links for ${SAMPLE_PRODUCTS.length} fixtures)`);
  ok(!reports.includes('href="/reports/sample/domain-audit-pro"') && !reports.includes('href="/reports/sample/research-pro"'), "/reports does not link a sample that does not exist");

  const sm = await (await fetch(`${B}/sitemap-reports.xml`)).text();
  ok(SAMPLE_PRODUCTS.every((p) => sm.includes(`/reports/sample/${p}</loc>`)), "every sample is in sitemap-reports.xml");

  console.log(`\nPASS - ${pass} checks (real sample reports served, indexable, linked)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) { fail(e?.stack || String(e)); }

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
