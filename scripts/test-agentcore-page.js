#!/usr/bin/env node
// /integrations/agentcore (src/agentcore-page.js).
//
// Part 1 (in process) renders the page under each switch state and reads its
// visible text: the x402-alone sentence only while the MPP offer gate lists
// the Payments plugin's client, the MPP on Tempo paragraph only while Tempo is
// offered, and the X-Payment-Offers header only while both hold.
// Part 2 boots a FREE_MODE server on port 0 and reads the route, the
// integrations index, the sitemaps, /llms.txt and the page date.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { bootServer } from "./lib/boot-server.js";
import { agentcorePage, pluginGetsX402Alone, AGENTCORE_SLUG, AGENTCORE_NAME } from "../src/agentcore-page.js";
import { PLATFORM_INTEGRATIONS } from "../src/platform-integrations.js";
import { integrationSlugs, displayPrice } from "../src/integration-pages.js";
import { pageLastmod, PAGE_SOURCES } from "../src/page-dates.js";
import { OFFER_REQUEST_HEADER } from "../src/mpp-offer-gate.js";

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); pass++; };
const BASE = "https://example.test";
const CATALOG = {
  "GET /api/search": { slug: "search", name: "Web search", price: "$0.010" },
  "GET /api/answer": { slug: "answer", name: "Cited answer", price: "$0.02", modelBacked: true },
  "POST /api/hash": { slug: "hash", name: "Hash", price: "$0.001" },
};
// Visible text: scripts, styles, head and tags removed, entities decoded.
const visible = (html) => {
  // Parsed, never pattern-stripped: the page's own text as a browser lays it out.
  const doc = new JSDOM(html).window.document;
  for (const el of doc.querySelectorAll("head, script, style")) el.remove();
  return (doc.body?.textContent || "").replace(/\s+/g, " ");
};
const main = (html) => { const v = visible(html); const a = v.indexOf("agent402 / integrations"); const b = v.indexOf("All integrations", a); return v.slice(a, b + "All integrations".length); };
const render = (o) => main(agentcorePage(BASE, CATALOG, o));
const OPT_IN = `${OFFER_REQUEST_HEADER}: mpp`;

// --- Part 1: the copy follows the switches ---------------------------------
{
  // Gate at its default (python-httpx/), Tempo offered: x402 alone, and the opt-in header.
  const t = render({ tempo: true, env: {} });
  ok(pluginGetsX402Alone({}), "the default gate lists the plugin's client");
  ok(t.includes("is answered with the x402 offer alone") && t.includes("A request whose User-Agent starts with python-httpx/"), "default: x402-alone sentence, said of this server's answer to that User-Agent");
  ok(t.includes("x402 is this server's default for the Payments plugin's HTTP client"), "default: x402 named this server's default");
  ok(t.includes(OPT_IN), "default + Tempo: the opt-in header is named");
  ok(t.includes('network_preferences_config=["tempo:4217", "eip155:4217"]') && t.includes("buyer_pays_gas_fees=True"), "default + Tempo: the plugin configuration");
  ok(t.includes("USDC.e or PathUSD on Tempo"), "default + Tempo: the funds");
}
{
  // Gate at its default, Tempo not offered: no MPP paragraph, no header.
  const t = render({ tempo: false, env: {} });
  ok(t.includes("x402 offer alone"), "no Tempo: x402-alone sentence stays");
  ok(!t.includes(OFFER_REQUEST_HEADER), "no Tempo: no opt-in header");
  ok(!/\bMPP\b/.test(t) && !/Tempo/.test(t) && !t.includes("network_preferences_config"), "no Tempo: no MPP or Tempo text");
}
for (const [label, env] of [["gate off", { MPP_OFFER_WITHHOLD_USER_AGENTS: "off" }], ["gate lists another client", { MPP_OFFER_WITHHOLD_USER_AGENTS: "curl/" }]]) {
  ok(!pluginGetsX402Alone(env), `${label}: the plugin's client is not listed`);
  const t = render({ tempo: true, env });
  ok(!t.includes("x402 offer alone") && !t.includes("x402 is this server's default") && t.includes("Every 402 here carries the PAYMENT-REQUIRED header and the full x402 offer in the body, payable in USDC."), `${label}: no x402-alone claim`);
  ok(!t.includes(OFFER_REQUEST_HEADER), `${label}: no opt-in header (the challenges ride every 402)`);
  ok(t.includes("The same 402 carries the MPP challenges") && t.includes("network_preferences_config"), `${label} + Tempo: MPP paragraph without the header`);
  const n = render({ tempo: false, env });
  ok(!/\bMPP\b/.test(n) && !n.includes(OFFER_REQUEST_HEADER), `${label}, no Tempo: no MPP text`);
}
{
  // A listed prefix that the plugin's User-Agent starts with, in any case.
  ok(pluginGetsX402Alone({ MPP_OFFER_WITHHOLD_USER_AGENTS: "curl/, Python-HTTPX/" }), "a list with the plugin's prefix");
  ok(!pluginGetsX402Alone({ MPP_OFFER_WITHHOLD_USER_AGENTS: "python-httpx/1." }), "a narrower prefix the bare client does not match");
}
{
  // Setup, sample, derived prices and labels.
  const html = agentcorePage(BASE, CATALOG, { tempo: true, env: {} });
  const t = main(html);
  // The commands run as written: each is the Gateway example's own command (its README), on this base URL.
  const oneLine = (x) => x.replace(/\\\s*\n\s*/g, " ").replace(/[ \t]+/g, " ");
  const readme = readFileSync(new URL("../examples/agentcore-gateway/README.md", import.meta.url), "utf8");
  const readmeCommands = oneLine(readme).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("agentcore ")).map((l) => l.replaceAll("https://agent402.tools", BASE));
  const pageCommands = [...new JSDOM(html).window.document.querySelectorAll("pre")].flatMap((pre) => oneLine(pre.textContent).split("\n").map((l) => l.trim())).filter((l) => l.startsWith("agentcore "));
  const targets = pageCommands.filter((c) => c.startsWith("agentcore add gateway-target"));
  ok(targets.length === 2 && targets.every((c) => /--name \S+/.test(c) && /--outbound-auth NONE\b/.test(c) && /--gateway Agent402Gateway\b/.test(c)), `each gateway-target command names the target, its gateway and the outbound auth (${targets.join(" | ")})`);
  ok(readmeCommands.filter((c) => c.startsWith("agentcore add gateway-target")).length === 2 && pageCommands.length >= 5 && pageCommands.every((c) => readmeCommands.includes(c)), `every agentcore command on the page is the Gateway example's (${pageCommands.filter((c) => !readmeCommands.includes(c)).join(" | ") || "all found"})`);
  ok(pageCommands.includes("agentcore add gateway --name Agent402Gateway --protocol-type MCP --authorizer-type AWS_IAM") && pageCommands.indexOf("agentcore add gateway --name Agent402Gateway --protocol-type MCP --authorizer-type AWS_IAM") < pageCommands.indexOf(targets[0]), "the gateway the targets name is created first");
  ok(t.includes(`curl -s ${BASE}/openapi.json -o openapi.json`) && t.includes("--schema ./openapi.json"), "OpenAPI target commands on this base URL");
  ok(t.includes(`--endpoint ${BASE}/mcp`), "MCP target URL on this base URL");
  ok(html.includes("examples/agentcore-gateway"), "the Gateway example is linked");
  // AgentCore is AWS's product: what it does is attributed to AWS's documentation, with the link; the rest is what this server answers.
  ok(t.includes("This server answers an unpaid call to a paid route with 402, whether it arrives directly or through a Gateway target."), "where a paid call stands, said of this server");
  ok(/<a href="https:\/\/docs\.aws\.amazon\.com\/bedrock-agentcore\/latest\/devguide\/payments\.html"[^>]*>AWS's documentation<\/a> says AgentCore Payments /.test(html), "what AgentCore Payments does is attributed to AWS's documentation, linked");
  for (const unattributed of ["The Gateway does not pay", "The Gateway lists the tools", "The Gateway turns", "settles each 402", "The agent code holds no key", "spend limit bounds what it pays", "with nothing to configure", "The agent gets the connector's tools", "The plugin pays over x402", "The plugin calls sellers", "Gateway target can read", "paid from the wallet"]) {
    ok(!t.includes(unattributed), `no sentence states AWS's product behavior as fact ("${unattributed}")`);
  }
  ok(t.includes("with no extra configuration on this server's side"), "configuration is said of this server's side");
  ok(t.includes("direct_buy.py") && t.includes("agent_buy.py") && html.includes("examples/agentcore-x402-buyer"), "the sample and its two entry points");
  ok(t.includes("a cited answer from a model-backed tool"), "the answer step is labeled model-backed when the catalog says so");
  ok(!main(agentcorePage(BASE, { ...CATALOG, "GET /api/answer": { slug: "answer", name: "Cited answer", price: "$0.02" } }, { tempo: true, env: {} })).includes("model-backed tool"), "and not labeled when it does not");
  // Prices come from the catalog handed in, nothing typed.
  ok(t.includes("$0.01") && t.includes("$0.02") && t.includes("$0.001"), "tool card prices are the catalog's");
  const other = main(agentcorePage(BASE, { "POST /api/hash": { slug: "hash", name: "Hash", price: "$0.777" } }, { tempo: true, env: {} }));
  ok(other.includes("$0.777") && !other.includes("$0.001"), "a changed catalog price changes the card");
  ok(!/\$\d/.test(main(agentcorePage(BASE, {}, { tempo: true, env: {} }))), "with no catalog the page quotes no price");
  ok(!html.includes("—") && !/\bcolour|favour|behaviour\b/.test(t), "no em dash, US spelling");
  // AWS's trademark guidelines: the product is "Amazon Bedrock AgentCore", and
  // our own brand comes first (no AWS mark more prominent than ours).
  ok(/<h1[^>]*>Agent402 with Amazon Bedrock AgentCore<\/h1>/.test(html) && /<title>Agent402 with Amazon Bedrock AgentCore/.test(html) && !/AWS Bedrock AgentCore/.test(html), "the heading and title name Agent402 first and the product by its own name");
  ok(/<title>[^<]*Amazon Bedrock AgentCore/.test(html) && html.includes(`<link rel="canonical" href="${BASE}/integrations/${AGENTCORE_SLUG}"`), "title and canonical");
  eq((html.match(/<h1\b/g) || []).length, 1, "one h1");
}
{
  // One list feeds every surface; the slug is not also a package page.
  ok(PLATFORM_INTEGRATIONS.some((p) => p.slug === AGENTCORE_SLUG && p.name === AGENTCORE_NAME), "the platform list names the page");
  ok(!integrationSlugs().includes(AGENTCORE_SLUG), "no package page shares the slug");
  ok(pageLastmod(`/integrations/${AGENTCORE_SLUG}`), "the page has a date");
  assert.deepEqual(PAGE_SOURCES[`/integrations/${AGENTCORE_SLUG}`], ["src/agentcore-page.js"], "dated from its own module, not the package pages'"); pass++;
}

// --- Part 2: the served surfaces --------------------------------------------
const srv = await bootServer({ stores: "agentcore-page", env: { FREE_MODE: "true", NODE_ENV: "test", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", TEMPO_API_KEY: "", MPP_SECRET_KEY: "" } });
try {
  const get = async (p) => { const r = await fetch(`${srv.url}${p}`); return { status: r.status, text: await r.text() }; };
  const page = await get(`/integrations/${AGENTCORE_SLUG}`);
  eq(page.status, 200, "the route answers 200");
  const t = main(page.text);
  ok(t.includes("Set up the tools") && t.includes("Pay for calls") && t.includes("Run the sample"), "the three sections");
  // This boot offers no Tempo: the served page names no MPP path.
  ok(!/\bMPP\b/.test(t) && !t.includes(OFFER_REQUEST_HEADER), "a boot without Tempo serves no MPP text");
  // The tool cards carry this boot's own catalog prices.
  const pricing = await (await fetch(`${srv.url}/api/pricing`)).json();
  const rows = pricing.endpoints || [];
  const hash = rows.find((r) => r.slug === "hash");
  ok(hash && typeof hash.price === "string", "the catalog lists hash with a price");
  ok(page.text.includes(`href="/tools/hash"`) && t.includes(displayPrice(hash.price)), "the hash card shows the catalog price");
  const index = await get("/integrations");
  ok(index.status === 200 && index.text.includes(`href="/integrations/${AGENTCORE_SLUG}"`), "the integrations index links the page");
  for (const sm of ["/sitemap-learn.xml", "/sitemap.xml"]) {
    const x = await get(sm);
    const locs = [...x.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
    ok(locs.includes(`/integrations/${AGENTCORE_SLUG}`), `${sm} lists the page`);
    const row = x.text.split("<url>").find((u) => /<loc>[^<]*\/integrations\/agentcore<\/loc>/.test(u)) || "";
    ok(/<lastmod>\d{4}-\d{2}-\d{2}/.test(row), `${sm} dates the page`);
  }
  const llms = await get("/llms.txt");
  ok(llms.status === 200 && llms.text.split("\n").some((l) => l.startsWith(`- [${AGENTCORE_NAME}](`) && new URL(l.slice(l.indexOf("(") + 1, l.indexOf(")"))).pathname === `/integrations/${AGENTCORE_SLUG}`), "/llms.txt links the page");
  eq((await get("/integrations/agentcore-nope")).status, 404, "an unknown slug is still a 404");
  eq((await get("/integrations/strands")).status, 200, "a package page still answers");
} finally { await srv.stop(); }

console.log(`\nagentcore page: ${pass} passed`);
