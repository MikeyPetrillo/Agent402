#!/usr/bin/env node
// /integrations/claude-managed-agents (src/managed-agents-page.js) and the
// connector listing it relies on (/mcp?tool_names=underscore).
//
// Part 1 (in process) renders the page and reads its visible text: the agent
// definition is the one the page exports, every name it enables is a plain
// name the connector lists, figures come from the code that decides them, and
// what Anthropic's product does is attributed to its documentation.
// Part 2 boots a FREE_MODE server on port 0 with MANAGED_AGENTS_PAGE unset:
// the route answers with noindex and no listing surface (integrations index,
// sitemaps, /llms.txt, /llms-full.txt) links it; and the connector lists every
// tool under a plain name with ?tool_names=underscore, dotted without it, and
// runs a call made by either spelling. Part 3 boots with MANAGED_AGENTS_PAGE=on
// (the control): every listing surface links and dates the page, no noindex.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { bootServer } from "./lib/boot-server.js";
import { managedAgentsPage, managedAgentsListed, agentDefinition, ENVIRONMENT, MANAGED_AGENTS_SLUG, MANAGED_AGENTS_NAME, BETA_HEADER, DISCOVERY_TOOLS, PAID_TOOL_NAME, SERVER_NAME, connectorUrl } from "../src/managed-agents-page.js";
import { PLATFORM_INTEGRATIONS, listedPlatformIntegrations } from "../src/platform-integrations.js";
import { integrationSlugs } from "../src/integration-pages.js";
import { pageLastmod, PAGE_SOURCES } from "../src/page-dates.js";
import { MAX_CALLS_PER_BURST, MAX_CALLS_PER_WINDOW } from "../src/rate-limit.js";
import { plainToolName, resolveListedName, PLAIN_TOOL_NAMES_VALUE, plainNamesHandler } from "../src/mcp-flagship.js";

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); pass++; };
const BASE = "https://example.test";
const CATALOG = {
  "GET /api/search": { slug: "search", name: "Web search", price: "$0.010" },
  "GET /api/answer": { slug: "answer", name: "Cited answer", price: "$0.02", modelBacked: true },
  "POST /api/hash": { slug: "hash", name: "Hash", price: "$0.001" },
  "POST /api/uuid": { slug: "uuid", name: "UUID", price: "$0.001" },
};
const visible = (html) => {
  const doc = new JSDOM(html).window.document;
  for (const el of doc.querySelectorAll("head, script, style")) el.remove();
  return (doc.body?.textContent || "").replace(/\s+/g, " ");
};
const main = (html) => { const v = visible(html); const a = v.indexOf("agent402 / integrations"); const b = v.indexOf("All integrations", a); return v.slice(a, b + "All integrations".length); };
const PLAIN = /^[a-zA-Z0-9_-]{1,113}$/; // the tool name rule Claude Managed Agents enforces

// --- Part 1 -----------------------------------------------------------------
{
  const html = managedAgentsPage(BASE, CATALOG, { env: { MPP_SECRET_KEY: "k" } });
  const t = main(html);
  const def = agentDefinition(BASE);
  // The agent definition: the connector on the plain-names URL, a matching toolset, plain names only.
  eq(def.mcp_servers[0].url, connectorUrl(BASE), "the agent names the connector's plain-names URL");
  ok(connectorUrl(BASE) === `${BASE}/mcp?tool_names=${PLAIN_TOOL_NAMES_VALUE}`, "the URL carries the connector's own query value");
  const ts = def.tools.find((x) => x.type === "mcp_toolset");
  ok(ts && ts.mcp_server_name === SERVER_NAME && def.mcp_servers[0].name === SERVER_NAME, "the toolset references the declared server");
  const names = ts.configs.map((c) => c.name);
  ok(names.every((n) => PLAIN.test(n)), `every enabled MCP tool name is a plain name (${names.join(", ")})`);
  ok(names.every((n) => resolveListedName(n) !== n || n === n.replace(/\./g, "")), "every enabled name resolves on the connector");
  ok(DISCOVERY_TOOLS.every((d) => names.includes(plainToolName(d))), "the four discovery tools are enabled by their plain names");
  ok(ts.configs.find((c) => c.name === "catalog_call") && !ts.configs.find((c) => c.name === "catalog_call").permission_policy, "catalog_call keeps the documented default policy");
  ok(def.tools.some((x) => x.type === "custom" && x.name === PAID_TOOL_NAME && PLAIN.test(PAID_TOOL_NAME)), "the paid-call custom tool is declared");
  ok(!def.tools.some((x) => x.type === "custom" && /^(mcp__|ant__)/.test(x.name)), "no reserved custom tool prefix");
  eq(ENVIRONMENT.config.networking.allow_mcp_servers, true, "the environment lets the session reach the declared server");
  // The commands on the page are the exported definition, on this base URL.
  const pres = [...new JSDOM(html).window.document.querySelectorAll("pre")].map((p) => p.textContent);
  ok(pres.some((p) => p.includes(JSON.stringify(def, null, 2))), "the agent request body is the exported definition");
  ok(pres.some((p) => p.includes(`anthropic-beta: ${BETA_HEADER}`)), "the beta header is sent");
  ok(pres.some((p) => p.includes('"type": "user.tool_confirmation"')) && pres.some((p) => p.includes("agent.custom_tool_use")), "approval and custom tool steps are shown");
  // Figures from the code.
  ok(t.includes(`${MAX_CALLS_PER_BURST} a minute and ${MAX_CALLS_PER_WINDOW} an hour`), "the free limits are the rate limiter's");
  ok(/\b2 pure-CPU tools run free on the connector/.test(t), "the free count is the catalog's free-tier count");
  ok(t.includes("free on /mcp") && t.includes("$0.01") && t.includes("$0.02"), "cards: free label for a free-tier tool, catalog prices for paid ones");
  ok(t.includes("model-backed"), "the model-backed tool is labeled");
  ok(!/\$\d/.test(main(managedAgentsPage(BASE, {}, { env: { MPP_SECRET_KEY: "k" } }))), "no catalog, no price");
  // Wires: the connector's own account.
  ok(t.includes("payable in the call on this connector over x402 or MPP"), "paid boot with MPP: both wires");
  ok(main(managedAgentsPage(BASE, CATALOG, { env: {} })).includes("over x402:"), "paid boot without MPP: x402 alone");
  const free = main(managedAgentsPage(BASE, CATALOG, { env: { FREE_MODE: "true" } }));
  ok(free.includes("This instance runs in free mode") && !free.includes("payable in the call"), "FREE_MODE: no in-call payment offered");
  // Anthropic's product is attributed to its documentation, linked.
  for (const href of ["https://platform.claude.com/docs/en/managed-agents/mcp-connector", "https://platform.claude.com/docs/en/managed-agents/quickstart", "https://platform.claude.com/docs/en/managed-agents/vaults"]) ok(html.includes(`href="${href}"`), `links ${href}`);
  for (const unattributed of ["Managed Agents cannot", "Managed Agents does not", "Anthropic's proxy", "will pay", "is not supported by"]) ok(!t.includes(unattributed), `no unattributed claim about the platform ("${unattributed}")`);
  ok(!html.includes("—") && !/\bcolour|favour|behaviour\b/.test(t), "no em dash, US spelling");
  ok(/<h1[^>]*>Agent402 with Claude Managed Agents<\/h1>/.test(html) && html.includes(`<link rel="canonical" href="${BASE}/integrations/${MANAGED_AGENTS_SLUG}"`), "heading and canonical");
  eq((html.match(/<h1\b/g) || []).length, 1, "one h1");
}
{
  ok(PLATFORM_INTEGRATIONS.some((p) => p.slug === MANAGED_AGENTS_SLUG && p.name === MANAGED_AGENTS_NAME), "the platform list names the page");
  // The listing switch: unset, off or any other text leaves the page unlisted; on (any case) lists it.
  for (const v of [undefined, "", "off", "true", "1", "onn"]) {
    const env = v === undefined ? {} : { MANAGED_AGENTS_PAGE: v };
    ok(!managedAgentsListed(env) && !listedPlatformIntegrations(env).some((p) => p.slug === MANAGED_AGENTS_SLUG), `MANAGED_AGENTS_PAGE=${JSON.stringify(v)}: unlisted`);
    ok(listedPlatformIntegrations(env).some((p) => p.slug === "agentcore"), `MANAGED_AGENTS_PAGE=${JSON.stringify(v)}: an entry with no switch stays listed`);
  }
  for (const v of ["on", " ON "]) ok(managedAgentsListed({ MANAGED_AGENTS_PAGE: v }) && listedPlatformIntegrations({ MANAGED_AGENTS_PAGE: v }).some((p) => p.slug === MANAGED_AGENTS_SLUG), `MANAGED_AGENTS_PAGE=${JSON.stringify(v)}: listed`);
  const robotsOf = (html) => (/<meta name="robots" content="([^"]*)"/.exec(html) || [])[1] || "";
  ok(/\bnoindex\b/.test(robotsOf(managedAgentsPage(BASE, CATALOG, { env: {} }))), "unlisted: the page carries a noindex robots meta");
  ok(!/noindex/.test(robotsOf(managedAgentsPage(BASE, CATALOG, { env: { MANAGED_AGENTS_PAGE: "on" } }))) && robotsOf(managedAgentsPage(BASE, CATALOG, { env: { MANAGED_AGENTS_PAGE: "on" } })).startsWith("index"), "listed: the page is indexable");
  ok(!integrationSlugs().includes(MANAGED_AGENTS_SLUG), "no package page shares the slug");
  ok(pageLastmod(`/integrations/${MANAGED_AGENTS_SLUG}`), "the page has a date");
  assert.deepEqual(PAGE_SOURCES[`/integrations/${MANAGED_AGENTS_SLUG}`], ["src/managed-agents-page.js"], "dated from its own module"); pass++;
  // The plain-name rule round-trips: a name is renamed only when it resolves back.
  eq(plainToolName("catalog.search"), "catalog_search", "catalog.search -> catalog_search");
  eq(plainToolName("decide.feedback"), "decide_feedback", "decide.feedback -> decide_feedback");
  eq(plainToolName("hash"), "hash", "a dotless name is unchanged");
  eq(resolveListedName("decide_feedback"), "decide.feedback", "decide_feedback resolves");
}

// --- Part 2 -----------------------------------------------------------------
const BOOT_ENV = { FREE_MODE: "true", NODE_ENV: "test", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", TEMPO_API_KEY: "", MPP_SECRET_KEY: "" };
// What every listing surface says about the page on one boot.
async function listings(srv) {
  const get = async (p) => { const r = await fetch(`${srv.url}${p}`); return { status: r.status, text: await r.text(), robots: r.headers.get("x-robots-tag") || "" }; };
  const page = await get(`/integrations/${MANAGED_AGENTS_SLUG}`);
  const index = await get("/integrations");
  const sitemaps = {};
  for (const sm of ["/sitemap-learn.xml", "/sitemap.xml"]) {
    const x = await get(sm);
    sitemaps[sm] = { status: x.status, row: x.text.split("<url>").find((u) => new RegExp(`<loc>[^<]*/integrations/${MANAGED_AGENTS_SLUG}</loc>`).test(u)) || "", agentcore: x.text.includes("/integrations/agentcore</loc>") };
  }
  const llms = {};
  for (const f of ["/llms.txt", "/llms-full.txt"]) {
    const x = await get(f);
    llms[f] = { status: x.status, links: x.text.includes(`/integrations/${MANAGED_AGENTS_SLUG}`), agentcore: x.text.includes("/integrations/agentcore") };
  }
  return { get, page, index, sitemaps, llms };
}

// The plain-names handler in process: a thrown error's message is renamed and
// its data kept; a refusal keeps its _meta and a JSON text block (a payment
// offer) as built; a tool's own data is never renamed.
{
  const offer = JSON.stringify({ x402Version: 2, resource: { description: "web.search via catalog.call" } });
  const thrown = await plainNamesHandler("tools/call", async () => { const e = new Error("Payment Required: see payment.info"); e.data = { note: "payment.info" }; throw e; })({ params: { name: "catalog_call" } }).catch((e) => e);
  ok(thrown.message === "Payment Required: see payment_info" && thrown.data.note === "payment.info", `a thrown error's message is renamed, its data kept (${thrown.message})`);
  const refusal = await plainNamesHandler("tools/call", async () => ({ isError: true, content: [{ type: "text", text: offer }, { type: "text", text: "Pay it; see payment.info." }], _meta: { m: "catalog.call" } }))({ params: { name: "catalog_call" } });
  ok(refusal.content[0].text === offer && refusal.content[1].text === "Pay it; see payment_info." && refusal._meta.m === "catalog.call", "a refusal: prose renamed, the JSON offer and _meta kept");
  const data = await plainNamesHandler("tools/call", async () => ({ content: [{ type: "text", text: "page text naming web.search" }] }))({ params: { name: "catalog_call" } });
  ok(data.content[0].text === "page text naming web.search", "a tool's own data is returned as the tool gave it");
  const guide = await plainNamesHandler("tools/call", async () => ({ content: [{ type: "text", text: "{\"usage\": \"catalog.call\"}" }], structuredContent: { usage: "catalog.call" }, _meta: { m: "catalog.call" } }))({ params: { name: "catalog_search" } });
  ok(guide.content[0].text.includes("catalog_call") && guide.structuredContent.usage === "catalog_call" && guide._meta.m === "catalog.call", "a guidance tool's text and structured answer are renamed, _meta kept");
}

const srv = await bootServer({ stores: "managed-agents-page", env: { ...BOOT_ENV, MANAGED_AGENTS_PAGE: "" } });
try {
  const { get, page, index, sitemaps, llms } = await listings(srv);
  eq(page.status, 200, "the route answers 200 while unlisted");
  ok(/\bnoindex\b/.test(page.robots) && /<meta name="robots" content="noindex/.test(page.text), "unlisted: X-Robots-Tag and robots meta say noindex");
  const t = main(page.text);
  ok(t.includes("Attach the connector") && t.includes("Run a free tool") && t.includes("Pay for calls") && t.includes("Limits"), "the sections");
  ok(page.text.includes(`${srv.url.replace(/\/$/, "")}/mcp?tool_names=underscore`) || /\/mcp\?tool_names=underscore/.test(page.text), "the served page names the plain-names URL");
  ok(index.status === 200 && !index.text.includes(`/integrations/${MANAGED_AGENTS_SLUG}`) && index.text.includes('href="/integrations/agentcore"'), "unlisted: the integrations index does not link the page (agentcore still listed)");
  for (const [sm, x] of Object.entries(sitemaps)) ok(x.status === 200 && !x.row && x.agentcore, `unlisted: ${sm} leaves the page out (agentcore still listed)`);
  for (const [f, x] of Object.entries(llms)) ok(x.status === 200 && !x.links && x.agentcore, `unlisted: ${f} does not link the page (agentcore still listed)`);

  // The connector: plain names with the query, dotted without it, and a call by either spelling.
  const rpc = async (path, method, params, id = 1) => {
    const r = await fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    return r.json();
  };
  const init = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "managed-agents-test", version: "0" } };
  const initPlain = await rpc("/mcp?tool_names=underscore", "initialize", init);
  const initDotted = await rpc("/mcp", "initialize", init);
  const plainTools = (await rpc("/mcp?tool_names=underscore", "tools/list", {}, 2)).result.tools;
  const dottedTools = (await rpc("/mcp", "tools/list", {}, 2)).result.tools;
  const plain = plainTools.map((x) => x.name);
  // Every dotted tool name the default listing lists, found as its own token
  // (not inside a host name or a longer dotted word).
  const dottedNames = dottedTools.map((x) => x.name).filter((n) => n.includes("."));
  const tokenOf = (n) => new RegExp(`(?<![A-Za-z0-9_./#-])${n.replace(/\./g, "\\.")}(?!\\.?[A-Za-z0-9_])`, "g");
  const namedIn = (v) => { const t = typeof v === "string" ? v : JSON.stringify(v); return dottedNames.filter((n) => tokenOf(n).test(t)); };
  ok(dottedNames.length >= 10 && namedIn(dottedTools.map(({ name, ...rest }) => rest)).length > 0, `the default listing's text names dotted tools (${namedIn(dottedTools.map(({ name, ...rest }) => rest)).join(", ")})`);
  for (const t of plainTools) { const left = namedIn(t); ok(left.length === 0, `plain listing: ${t.name} (name, title, description, schemas) names no dotted tool (${left.join(", ") || "none"})`); }
  // The plain listing is the default one with each dotted tool name in its plain spelling, nothing else changed.
  const swapped = JSON.parse(dottedNames.reduce((t, n) => t.replace(tokenOf(n), n.replace(/\./g, "_")), JSON.stringify(dottedTools)));
  assert.deepEqual(plainTools, swapped, "the plain listing differs from the default only in the tool names"); pass++;
  ok(namedIn(initPlain.result).length === 0 && namedIn(initDotted.result).length > 0, `initialize instructions: plain names under the query (${namedIn(initPlain.result).join(", ") || "none"}), dotted without it`);
  const plainAnswers = {
    "server_describe": await rpc("/mcp?tool_names=underscore", "tools/call", { name: "server_describe", arguments: {} }, 20),
    "payment_info": await rpc("/mcp?tool_names=underscore", "tools/call", { name: "payment_info", arguments: {} }, 21),
    "catalog_search": await rpc("/mcp?tool_names=underscore", "tools/call", { name: "catalog_search", arguments: { query: "hash" } }, 22),
    "catalog_search (no query)": await rpc("/mcp?tool_names=underscore", "tools/call", { name: "catalog_search", arguments: {} }, 23),
    "catalog_call (unknown slug)": await rpc("/mcp?tool_names=underscore", "tools/call", { name: "catalog_call", arguments: { slug: "no-such-tool-xyz" } }, 24),
    "unknown tool": await rpc("/mcp?tool_names=underscore", "tools/call", { name: "no_such_tool", arguments: {} }, 25),
    "catalog_call (a paid tool, unpaid)": await rpc("/mcp?tool_names=underscore", "tools/call", { name: "catalog_call", arguments: { slug: "search", params: { q: "x" } } }, 27),
  };

  for (const [what, r] of Object.entries(plainAnswers)) { const left = namedIn(r); ok(left.length === 0 && (r.result || r.error), `plain answer ${what} names no dotted tool (${left.join(", ") || "none"})`); }
  const dottedDescribe = await rpc("/mcp", "tools/call", { name: "server.describe", arguments: {} }, 26);
  ok(namedIn(dottedDescribe.result).length > 0, `CONTROL: server.describe without the query names dotted tools (${namedIn(dottedDescribe.result).slice(0, 4).join(", ")})`);
  ok(plain.length > 0 && plain.every((n) => PLAIN.test(n)), `?tool_names=underscore lists every tool under a plain name (${plain.filter((n) => !PLAIN.test(n)).join(", ") || "all plain"})`);
  ok(DISCOVERY_TOOLS.every((d) => plain.includes(plainToolName(d))) && plain.includes("catalog_call"), "the names the page enables are listed");
  const dotted = (await rpc("/mcp", "tools/list", {}, 3)).result.tools.map((x) => x.name);
  ok(dotted.includes("catalog.search") && !dotted.includes("catalog_search"), "without the query the listing is unchanged");
  eq((await rpc("/mcp?tool_names=other", "tools/list", {}, 4)).result.tools.some((x) => x.name === "catalog.search"), true, "another query value lists dotted names");
  const hashPlain = await rpc("/mcp?tool_names=underscore", "tools/call", { name: "catalog_call", arguments: { slug: "hash", params: { text: "hello world", algo: "sha256" } } }, 5);
  ok(!hashPlain.result?.isError && JSON.stringify(hashPlain.result).includes("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"), "catalog_call runs a free tool");
  const findPlain = await rpc("/mcp?tool_names=underscore", "tools/call", { name: "catalog_find", arguments: { task: "hash text with sha256" } }, 6);
  ok(!findPlain.result?.isError && JSON.stringify(findPlain.result).includes("hash"), "catalog_find answers");
  const dottedCall = await rpc("/mcp?tool_names=underscore", "tools/call", { name: "catalog.search", arguments: { query: "hash" } }, 7);
  ok(!dottedCall.result?.isError, "the dotted spelling still runs under the query");
  eq((await get(`/integrations/${MANAGED_AGENTS_SLUG}-nope`)).status, 404, "an unknown slug is still a 404");
} finally { await srv.stop(); }

// --- Part 3: the control, MANAGED_AGENTS_PAGE=on lists it everywhere --------
const on = await bootServer({ stores: "managed-agents-page-on", env: { ...BOOT_ENV, MANAGED_AGENTS_PAGE: "on" } });
try {
  const { page, index, sitemaps, llms } = await listings(on);
  ok(page.status === 200 && !/noindex/.test(page.robots) && !/<meta name="robots" content="noindex/.test(page.text), "listed: no noindex on the page");
  ok(index.status === 200 && index.text.includes(`href="/integrations/${MANAGED_AGENTS_SLUG}"`), "listed: the integrations index links the page");
  for (const [sm, x] of Object.entries(sitemaps)) ok(x.row && /<lastmod>\d{4}-\d{2}-\d{2}/.test(x.row), `listed: ${sm} lists and dates the page`);
  for (const [f, x] of Object.entries(llms)) ok(x.links, `listed: ${f} links the page`);
} finally { await on.stop(); }

console.log(`\nmanaged agents page: ${pass} passed`);
