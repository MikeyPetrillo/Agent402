#!/usr/bin/env node
// Real sample reports (assets/samples -> /reports/sample/<product>).
//
// Every fixture must be a finished report a buyer could have received (a stub
// with "..." in it is exactly what these replaced), every served sample page
// must be indexable with its own title/canonical/JSON-LD, the JSON the viewer
// fetches must be the done-shaped bundle, and the /reports cards must link the
// sample only for products that have one. Boots a FREE_MODE server (no Stripe:
// the sample routes are mounted regardless of checkout).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { getFreePort } from "./lib/free-port.js";
import { SAMPLES, SAMPLE_PRODUCTS, sampleLinkFor, samplePaths, endsMidSentence, midSentence } from "../src/sample-reports.js";
import { HUMAN_PRODUCTS } from "../src/human-checkout.js";

let pass = 0;
let proc = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures (offline) ----
const files = readdirSync("assets/samples").filter((f) => f.endsWith(".json"));
ok(files.length >= 4, `at least four sample fixtures exist (${files.length})`);
// A fixture whose product is not on sale on this boot (the token brief without
// RUGCHECK_TOOLS=on) is not served; every other fixture loads.
const onSale = files.filter((f) => Object.hasOwn(HUMAN_PRODUCTS, f.replace(/\.json$/, "")));
ok(SAMPLE_PRODUCTS.length === onSale.length, `every fixture for a product on sale loads (${SAMPLE_PRODUCTS.length} of ${onSale.length})`);

// ---- hostile record fields through the server-side draw (offline) ----
// The sample page's report is drawn on the server by the viewer's own
// renderer (src/report-prerender.js). Every record field it prints and the
// markdown body must arrive as text: no tag, event attribute or script URL.
{
  const { reportDoneHtml } = await import("../src/report-prerender.js");
  const tag = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
  const hostile = {
    status: "done", sample: true, kind: "research", priceUsd: 5, at: "2026-11-17T00:00:00Z",
    title: `Title ${tag}`,
    input: `input ${tag}`,
    disclaimer: `note ${tag}`,
    report: [
      `## Heading ${tag}`,
      "",
      `Body <script>alert(3)</script> and <img src=x onerror=alert(4)> [x](https://evil.example/"onmouseover=alert(5)) [y](javascript:alert(6)) [1]`,
      "",
      "- item <svg onload=alert(7)>",
      "",
      "| head <b onclick=alert(8)> | b |",
      "|---|---|",
      "| <img src=x onerror=alert(9)> | d |",
    ].join("\n"),
    sources: [{ url: "https://evil.example/", title: `src ${tag}` }],
    tables: [{ label: `Rows: label ${tag}`, rows: [{ a: 1 }] }],
  };
  const html = reportDoneHtml(hostile, { origin: "https://agent402.tools" });
  const bad = [/<script/i, /<img\b/i, /<svg\b/i, /<b onclick/i, /<[^>]*\son[a-z]+\s*=/i, /href\s*=\s*["']?\s*javascript:/i];
  const hit = bad.filter((re) => re.test(html)).map(String);
  ok(hit.length === 0, `a hostile record draws no tag, event attribute or script URL (${hit.join(", ") || "none"})`);
  ok(html.includes("Title &quot;&gt;&lt;script&gt;") && html.includes("Body &lt;script&gt;alert(3)&lt;/script&gt;") && html.includes("&lt;img src=x onerror=alert(9)&gt;"), "control: the hostile title, body and table cell are drawn as escaped text");
  ok(/<a href="https:\/\/evil\.example\/&quot;onmouseover=alert\(5"/.test(html), "control: a cited-host link is drawn with its quote escaped inside href");
}
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
  // Complete: no section stops mid-sentence. Each block of text under a
  // heading ends on terminal punctuation, a table row, a rule, a link, a
  // hashtag line or a short list item (a headline option). The first
  // section is the code-written title and coverage line.
  const cut = s.report.split(/\n(?=#{1,4} )/).slice(1).map((sec) => sec.trim()).filter((sec) => sec.includes("\n"))
    .map((sec) => sec.slice(sec.lastIndexOf("\n") + 1).trim())
    .filter((last) => last && !/^#{1,4} /.test(last) && !/[.!?:)"'`*_|\]]$/.test(last) && !/^(---|\|.*\|)$/.test(last) && !/https?:\/\/\S+$/.test(last) && !/#\w+$/.test(last) && !/^- .{1,80}$/.test(last));
  ok(cut.length === 0, `${product}: every section ends on a complete sentence${cut.length ? ` (cut: ${JSON.stringify(cut[0].slice(-80))})` : ""}`);
}
// A fixture whose text stops mid-sentence is flagged, and the viewer says so
// on the page, so a cut-short sample never passes as a finished report.
ok(endsMidSentence("Done.\n\n## Sources\n1. x") === false && endsMidSentence("Ends here [3].") === false && endsMidSentence("*Not advice.*") === false, "endsMidSentence: a finished sentence (with citations or emphasis) is not flagged");
ok(endsMidSentence("Enable DNSSEC signing\n\n## Sources\n1. x") === true && endsMidSentence("- Inventories and intangible assets, net") === true, "endsMidSentence: a body that stops mid-sentence is flagged");
for (const product of SAMPLE_PRODUCTS) {
  const raw = JSON.parse(readFileSync(`assets/samples/${product}.json`, "utf8"));
  ok(!!SAMPLES[product].cutShort === endsMidSentence(raw.report), `${product}: cutShort flag (${!!SAMPLES[product].cutShort}) matches the fixture's last sentence`);
}
const viewer = readFileSync("assets/js/report-view.js", "utf8");
ok(/s\.cutShort === true \? '<div class="keep-hint no-print" id="cut-short-note">/.test(viewer), "the viewer prints the cut-short note for a flagged sample");
ok(midSentence("Deep research report") === "deep research report" && midSentence("SEC filing report") === "SEC filing report" && midSentence("FDA recall report") === "FDA recall report", "midSentence keeps acronyms and lowercases a plain first word");
ok(!/\.label\.toLowerCase\(\)|productLabel\(s\.kind\)\)\.toLowerCase\(\)/.test(viewer), "the viewer never lowercases a whole label (SEC, FDA, 13F keep their case)");

ok(sampleLinkFor("dossier") === "/reports/sample/dossier" && sampleLinkFor("research-pro") === null, "sampleLinkFor: a slug with a fixture links, one without does not");
ok(samplePaths().every((p) => p.startsWith("/reports/sample/")), "sample paths live under /reports/sample/");

// ---- booted server ----
let drawnPage = null;
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
    // Served already drawn: the report's own title as the page's one h1, its body, no loading spinner.
    const firstHeading = (String(s.report).match(/^## +(.+)$/m) || [])[1];
    ok(/<div id="app"[^>]*data-rendered="1">/.test(html) && !/class="spin"/.test(html) && (html.match(/<h1[\s>]/g) || []).length === 1 && html.includes(`<h1 class="rpt-title">${escapeHtml(s.title)}</h1>`), `${product}: served drawn, with the report title as its one h1 and no spinner`);
    ok(!firstHeading || html.includes(">" + escapeHtml(firstHeading).replace(/\*\*/g, "").slice(0, 20)), `${product}: the report body is in the served HTML ("${String(firstHeading).slice(0, 40)}")`);
    if (product === SAMPLE_PRODUCTS[0]) drawnPage = { product, html, j };
  }
  // The browser on a served-drawn page: the viewer keeps the markup as served
  // and wires its buttons; drawing the same record itself gives the same markup.
  {
    const { JSDOM } = await import("jsdom");
    const viewerJs = readFileSync("assets/js/report-view.js", "utf8");
    const run = async (html, prep = () => {}) => {
      const calls = [];
      const dom = new JSDOM(html.replace(/<script\b[^>]*src="[^"]*"[^>]*><\/script>/g, ""), { runScripts: "outside-only", url: `${B}/reports/sample/${drawnPage.product}` });
      prep(dom.window.document.getElementById("app"));
      dom.window.fetch = async (u, o) => { calls.push([String(u), o && o.method]); return { ok: true, json: async () => (String(u).includes("/api/buy") ? {} : drawnPage.j) }; };
      dom.window.eval(viewerJs);
      for (let i = 0; i < 20 && calls.length === 0; i++) await sleep(10);
      await sleep(30);
      return { dom, calls, app: dom.window.document.getElementById("app") };
    };
    const served = await run(drawnPage.html);
    const drawnHtml = served.app.innerHTML;
    ok(served.calls.length === 1 && served.calls[0][0].endsWith(`/api/reports/sample/${drawnPage.product}`) && served.app.querySelector(".rpt-title") && served.app.getAttribute("data-rendered") === "1", `the viewer reads the record once on a served-drawn page (${JSON.stringify(served.calls)})`);
    const form = served.dom.window.document.getElementById("sample-buy");
    served.dom.window.document.getElementById("sample-input").value = "AAPL";
    form.dispatchEvent(new served.dom.window.Event("submit", { cancelable: true }));
    await sleep(30);
    ok(served.calls.some(([u, m]) => u === "/api/buy" && m === "POST"), "the served-drawn page's buy box is wired (a submit asks /api/buy)");
    // Control: the same page as a client-drawn one (spinner, no data-rendered) draws the same markup.
    const client = await run(drawnPage.html, (app) => { app.removeAttribute("data-rendered"); app.innerHTML = '<div class="status"><span class="spin"></span></div>'; });
    const norm = (h) => h.replace(/(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/g, "DATE");
    ok(client.app.getAttribute("data-rendered") === null && client.app.querySelector(".rpt-title") && norm(client.app.innerHTML) === norm(drawnHtml), "the server's markup is the viewer's own: a client-drawn copy of the same record matches it");
  }
  const nf = await fetch(`${B}/reports/sample/not-a-product`);
  ok(nf.status === 404 && (await fetch(`${B}/api/reports/sample/not-a-product`)).status === 404, "unknown product -> 404 on both routes");

  const reports = await (await fetch(`${B}/reports`)).text();
  const links = reports.match(/href="\/reports\/sample\/[a-z-]+"/g) || [];
  ok(links.length >= SAMPLE_PRODUCTS.length, `/reports links the samples (${links.length} links for ${SAMPLE_PRODUCTS.length} fixtures)`);
  for (const p of SAMPLE_PRODUCTS) {
    const n = reports.split(`href="/reports/sample/${p}"`).length - 1;
    ok(n >= 2, `/reports links the ${p} sample from the strip and from its product card (${n} links)`);
  }
  ok(!reports.includes('href="/reports/sample/domain-audit-pro"') && !reports.includes('href="/reports/sample/research-pro"'), "/reports does not link a sample that does not exist");

  const sm = await (await fetch(`${B}/sitemap-reports.xml`)).text();
  ok(SAMPLE_PRODUCTS.every((p) => sm.includes(`/reports/sample/${p}</loc>`)), "every sample is in sitemap-reports.xml");

  console.log(`\nPASS - ${pass} checks (real sample reports served, indexable, linked)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) { fail(e?.stack || String(e)); }

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
