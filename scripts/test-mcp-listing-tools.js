#!/usr/bin/env node
// The listing scripts and the hosted connector's MCP tool listings
// (scripts/lib/mcp-listings.js): refresh-bazaar.js MODE=mcp, bazaar-presence.js,
// bazaar-validate.js --mcp and keepalive-plan.js mcp.
//
//   node scripts/test-mcp-listing-tools.js
//
// Offline. The pure halves run on fixtures; the dry run is the script itself
// against a stub catalog on port 0; the buy is the script itself against the
// REAL server booted in paid mode (Base) with a stub facilitator that records
// every /verify and /settle and settles nothing on a chain, signed with a
// throwaway key.
//   - the script's list of MCP tool listings is the server's own;
//   - a feed row at /mcp#<tool> is read as that tool's listing, and stale mode
//     never reads it as a stale route;
//   - an explicit slug list buys exactly the listed slugs: any other slug
//     refuses the whole run before anything is asked or signed;
//   - the dry run prints each listing's list price and the total, and sends
//     nothing to the connector;
//   - an offer that is not the tool's MCP listing offer is never signed;
//   - a listing is bought once: one verify, one settle, on the resource /mcp
//     with an MCP extension; a settle that fails is not sent again;
//   - a boot with no x402 on the connector buys nothing and fails validation;
//   - the presence check finds the listings, pages on one that was listed and
//     left, never on one not yet listed, and never buys one;
//   - the plan lists them, refuses over its cap, and the burner low-water
//     figure covers the pass;
//   - the workflow buys only an explicit list, the scheduled run only behind
//     its switch.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/file-mode.js";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generatePrivateKey } from "viem/accounts";
import { load } from "js-yaml";
import { bootServer } from "./lib/boot-server.js";
import {
  MCP_LISTING_TOOLS, mcpListingRoutes, selectMcpListings, mcpOfferProblems, mcpToolOfResource, isMcpFeedRow, mcpListingKey, usdText,
} from "./lib/mcp-listings.js";
import { buyMcpListing, X402_PAYMENT_META, X402_PAYMENT_RESPONSE_META } from "./lib/mcp-x402-client.js";
import { staleCandidates } from "./refresh-bazaar.js";
import { decide, issueBody, issueListedKeys, logLines, listingKeyOnHost, mcpCatalogRows, readListing } from "./bazaar-presence.js";
import { run as planRun, mcpPassRoutes } from "./keepalive-plan.js";
import { aboveCeilingRoutes, passMicros, burnerLowWaterUsd, microsToUsd } from "./lib/keepalive-plan.js";
import { runMcpValidation, mcpListingOfferProblems } from "./bazaar-validate.js";

const { MCP_X402_SLUGS, MCP_X402_TRANSPORT } = await import("../src/mcp-x402-routes.js");
const { FLAGSHIP_MCP_NAMES } = await import("../src/mcp-flagship.js");
const bazaar = await import("@x402/extensions/bazaar");

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const ORIGIN = "https://agent402.tools";
const SIX = "search,search-news,answer,stock-quote,render,memory-read";

// ---- the list is the server's ------------------------------------------------------
{
  const server = Object.fromEntries(MCP_X402_SLUGS.map((s) => [s, FLAGSHIP_MCP_NAMES[s]]));
  ok(JSON.stringify(server) === JSON.stringify(MCP_LISTING_TOOLS) && Object.keys(MCP_LISTING_TOOLS).length === 6, `the scripts' MCP tool listings are the server's twins, in order (${Object.values(MCP_LISTING_TOOLS).join(", ")})`);
  ok(Object.keys(MCP_LISTING_TOOLS).join(",") === SIX && MCP_X402_TRANSPORT === "streamable-http", "the six fixed-price flagship tools, over streamable-http");
}

// ---- fixtures ----------------------------------------------------------------------
const PRICES = { search: "$0.010", "search-news": "$0.010", answer: "$0.080", "stock-quote": "$0.001", render: "$0.010", "memory-read": "$0.001" };
const PATHS = { search: ["GET", "/api/search"], "search-news": ["GET", "/api/search-news"], answer: ["POST", "/api/answer"], "stock-quote": ["GET", "/api/stock-quote"], render: ["POST", "/api/render"], "memory-read": ["GET", "/api/memory"] };
const PRICING = {
  endpoints: [
    ...Object.keys(PRICES).map((slug) => ({ slug, method: PATHS[slug][0], path: PATHS[slug][1], price: PRICES[slug] })),
    { slug: "hash", method: "POST", path: "/api/hash", price: "$0.001", computePayable: true },
    { slug: "memory-write", method: "POST", path: "/api/memory", price: "$0.002" },
    { slug: "report", method: "POST", path: "/api/report", price: "$0.85" },
  ],
};
const SPEC = { paths: Object.fromEntries(Object.values(PATHS).map(([m, p]) => [p, { [m.toLowerCase()]: { parameters: [{ name: "q", example: "x402" }] } }])) };
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const offerFor = (toolName, micros, over = {}) => ({
  x402Version: 2, error: "Payment required",
  resource: { url: `${ORIGIN}/mcp`, description: toolName, mimeType: "application/json" },
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: String(micros), asset: USDC, payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }],
  extensions: bazaar.declareDiscoveryExtension({ toolName, transport: "streamable-http", inputSchema: { type: "object", properties: { q: { type: "string" } } }, example: { q: "x402" } }),
  ...over,
});

// ---- feed rows ---------------------------------------------------------------------
{
  ok(mcpToolOfResource(`${ORIGIN}/mcp#web.search`, "agent402.tools") === "web.search" && mcpListingKey("web.search") === "/mcp#web.search", "a feed resource /mcp#web.search on our host is the web.search listing");
  ok(mcpToolOfResource(`${ORIGIN}/mcp`, "agent402.tools") === null && mcpToolOfResource("https://other.example/mcp#web.search", "agent402.tools") === null
    && mcpToolOfResource(`${ORIGIN}/api/search#web.search`, "agent402.tools") === null && mcpToolOfResource(`${ORIGIN}/mcp#a b\n`, "agent402.tools") === null && mcpToolOfResource("not a url", "agent402.tools") === null,
    "no fragment, another host, another path, or a fragment that is no tool name is not a listing of ours");
  ok(listingKeyOnHost(`${ORIGIN}/mcp#web.news`, "agent402.tools") === "/mcp#web.news" && listingKeyOnHost(`${ORIGIN}/api/hash`, "agent402.tools") === "/api/hash" && listingKeyOnHost("https://x.example/api/hash", "agent402.tools") === null,
    "the presence check keys an MCP listing by /mcp#<tool> and a route by its path");
  const rows = [{ resource: `${ORIGIN}/mcp#web.search`, type: "mcp", serviceName: "Web search" }, { resource: `${ORIGIN}/mcp`, serviceName: "x" }, { resource: `${ORIGIN}/api/hash`, type: "http", serviceName: "Hash" }];
  ok(isMcpFeedRow(rows[0]) && isMcpFeedRow(rows[1]) && !isMcpFeedRow(rows[2]) && !isMcpFeedRow(null), "a row of type mcp, or on the connector's path, is an MCP row");
  ok(staleCandidates(rows).length === 1 && staleCandidates(rows)[0].resource.endsWith("/api/hash"), "stale mode reads no MCP row as a route whose name drifted");
}

// ---- selection: the listed slugs and nothing else ------------------------------------
{
  const all = selectMcpListings(PRICING, SIX.split(","));
  ok(all.refused.length === 0 && all.routes.map((r) => r.toolName).join(",") === "web.search,web.news,web.answer,market.quote,browser.render,memory.read", "the six slugs select the six listings");
  ok(passMicros(all.routes) === 112000 && usdText(112000) === "$0.112" && usdText(1000) === "$0.001" && usdText(80000) === "$0.080" && usdText(2500000) === "$2.500" && usdText(1234) === "$0.001234",
    `their list prices sum in micro-USD and print as the catalog prints them (${usdText(passMicros(all.routes))})`);
  const extra = selectMcpListings(PRICING, ["search", "hash", "memory-write", "nope", "report"]);
  ok(extra.routes.length === 1 && extra.refused.map((r) => r.slug).join(",") === "hash,memory-write,nope,report" && extra.refused.every((r) => r.why === "not an MCP tool listing"),
    "a slug that is not an MCP tool listing (a free tool, a writer, an unknown, a report) is refused by name");
  ok(selectMcpListings(PRICING, ["search", "search", " search "]).routes.length === 1, "a slug named twice is bought once");
  ok(selectMcpListings({ endpoints: PRICING.endpoints.filter((e) => e.slug !== "render") }, ["render"]).refused[0]?.why === "not in the live catalog", "a listing the catalog does not carry is refused");
  const quoted = { endpoints: PRICING.endpoints.map((e) => (e.slug === "answer" ? { ...e, quoted: true } : e.slug === "render" ? { ...e, price: "free" } : e)) };
  const q = selectMcpListings(quoted, ["answer", "render"]);
  ok(q.routes.length === 0 && /exempt kind \(quoted\)/.test(q.refused[0].why) && q.refused[1].why === "unpriced", "the exempt kinds stand for an MCP listing too, and an unpriced one is refused");
  ok(mcpListingRoutes(PRICING).length === 6 && mcpListingRoutes({}).length === 0 && selectMcpListings(PRICING, []).routes.length === 0, "no slugs, no listings");
}

// ---- the offer check ---------------------------------------------------------------
{
  const good = offerFor("web.search", 10000);
  const args = { toolName: "web.search", origin: ORIGIN, micros: 10000 };
  ok(mcpOfferProblems(good, args).length === 0, "the tool's MCP listing offer at the list price has no problem");
  const bad = (over, re, label) => { const p = mcpOfferProblems({ ...good, ...over }, args); ok(p.some((x) => re.test(x)), `${label} (${p.join("; ").slice(0, 110)})`); };
  bad({ resource: { url: `${ORIGIN}/api/search` } }, /resource is/, "an offer naming the HTTP route is refused");
  bad({ extensions: offerFor("web.news", 10000).extensions }, /toolName is "web\.news"/, "another tool's extension is refused");
  bad({ extensions: bazaar.declareDiscoveryExtension({ method: "GET", input: { q: "x" } }) }, /type is/, "an HTTP discovery extension is refused");
  bad({ extensions: {} }, /no bazaar discovery extension/, "an offer with no discovery extension is refused");
  bad({ accepts: [{ ...good.accepts[0], amount: "10001" }] }, /list price/, "a Base accept asking another amount is refused");
  bad({ accepts: [{ ...good.accepts[0], network: "eip155:10" }] }, /no exact accept on eip155:8453/, "an offer with no Base accept is refused");
  bad({ x402Version: 1 }, /x402Version/, "a v1 offer is refused");
  const sse = JSON.parse(JSON.stringify(good)); sse.extensions.bazaar.info.input.transport = "sse";
  ok(mcpOfferProblems(sse, args).some((x) => /transport/.test(x)), "another transport is refused");
  const noSchema = JSON.parse(JSON.stringify(good)); delete noSchema.extensions.bazaar.info.input.inputSchema;
  ok(mcpOfferProblems(noSchema, args).some((x) => /inputSchema/.test(x)), "a missing input schema is refused");
  ok(mcpOfferProblems(null, args)[0] === "no PaymentRequired object" && mcpOfferProblems(good, { ...args, origin: "http://127.0.0.1:1" }).length === 1, "no offer, or another origin, is refused");
  const validators = { validateDiscoveryExtension: bazaar.validateDiscoveryExtension, validateDiscoveryExtensionSpec: bazaar.validateDiscoveryExtensionSpec };
  ok(mcpListingOfferProblems(good, args, validators).length === 0, "the validation adds the protocol's validators and passes the good offer");
  const drift = JSON.parse(JSON.stringify(good)); drift.extensions.bazaar.info.input.toolName = 7;
  ok(mcpListingOfferProblems(drift, args, validators).some((x) => /^validateDiscoveryExtension/.test(x)), "an extension the protocol's validator refuses is named by that validator");
}

// ---- one buy, in memory: never sign a wrong offer, never send twice --------------------
{
  const route = { slug: "search", toolName: "web.search", micros: 10000 };
  const mk = (answers) => { const calls = []; return { calls, callTool: async (name, args, meta) => { calls.push({ name, meta }); const a = answers[calls.length - 1]; if (a instanceof Error) throw a; return a; } }; };
  const ask = (offer) => ({ isError: true, structuredContent: offer, content: [{ type: "text", text: JSON.stringify(offer) }] });
  let signed = 0;
  const signPayment = async () => { signed++; return { x402Version: 2, payload: { signature: "0x00" } }; };
  const paidOk = { content: [{ type: "text", text: "{}" }], _meta: { [X402_PAYMENT_RESPONSE_META]: { success: true, transaction: "0x1" } } };

  let c = mk([ask(offerFor("web.search", 10000)), paidOk]);
  let r = await buyMcpListing({ ...c, signPayment, route, args: { q: "x" }, origin: ORIGIN });
  ok(r.ok && signed === 1 && c.calls.length === 2 && !c.calls[0].meta && c.calls[1].meta?.[X402_PAYMENT_META]?.payload?.signature === "0x00", "a buy is one unpaid ask, one signature, one paid call carrying the payment in _meta");

  signed = 0; c = mk([ask(offerFor("web.search", 10000, { resource: { url: `${ORIGIN}/api/search` } })), paidOk]);
  r = await buyMcpListing({ ...c, signPayment, route, origin: ORIGIN });
  ok(!r.ok && !r.signed && signed === 0 && c.calls.length === 1 && /not this tool's MCP listing offer/.test(r.why), `the HTTP route's offer (a build without the twins) is never signed (${String(r.why).slice(0, 90)})`);

  signed = 0; c = mk([ask(offerFor("web.search", 20000)), paidOk]);
  r = await buyMcpListing({ ...c, signPayment, route, origin: ORIGIN });
  ok(!r.ok && signed === 0 && c.calls.length === 1, "an offer above the list price is never signed");

  signed = 0; c = mk([{ content: [{ type: "text", text: "served free" }] }]);
  r = await buyMcpListing({ ...c, signPayment, route, origin: ORIGIN });
  ok(!r.ok && signed === 0 && /without asking for a payment/.test(r.why), "a tool that answers without a payment is not a buy");

  signed = 0; c = mk([{ isError: true, content: [{ type: "text", text: "wallet required: run the npm package" }] }]);
  r = await buyMcpListing({ ...c, signPayment, route, origin: ORIGIN });
  ok(!r.ok && signed === 0 && /no x402 offer/.test(r.why), "a refusal with no x402 offer (no paywall on the connector) is not a buy");

  signed = 0; c = mk([ask(offerFor("web.search", 10000)), new Error("timeout")]);
  r = await buyMcpListing({ ...c, signPayment, route, origin: ORIGIN });
  ok(!r.ok && r.sent && signed === 1 && c.calls.length === 2 && /not sent again/.test(r.why), "a paid call that does not answer is reported and never sent again");

  signed = 0; c = mk([ask(offerFor("web.search", 10000)), { isError: true, content: [{ type: "text", text: "settlement failed" }], _meta: { [X402_PAYMENT_RESPONSE_META]: { success: false } } }]);
  r = await buyMcpListing({ ...c, signPayment, route, origin: ORIGIN });
  ok(!r.ok && r.sent && signed === 1 && c.calls.length === 2 && /did not settle/.test(r.why), "a settle that fails is reported and never sent again");

  signed = 0; c = mk([ask(offerFor("web.search", 10000)), paidOk]);
  r = await buyMcpListing({ ...c, signPayment: async () => { throw new Error("selected accept refused: over the cap"); }, route, origin: ORIGIN });
  ok(!r.ok && !r.sent && c.calls.length === 1 && /no payment was signed/.test(r.why), "a signature the cap refuses sends nothing");
}

// ---- the presence check ------------------------------------------------------------
{
  const pricing = PRICING;
  const httpKeys = pricing.endpoints.map((e) => e.path);
  const mcpKeys = Object.values(MCP_LISTING_TOOLS).map(mcpListingKey);
  const reading = (keys) => ({ pricing, passes: [{ keys: new Set(keys) }, { keys: new Set(keys) }] });
  ok(mcpCatalogRows(pricing).length === 6 && mcpCatalogRows(pricing)[0].key === "MCP /mcp#web.search" && mcpCatalogRows(pricing)[0].slug === "search", "the catalog's MCP listings are read as MCP /mcp#<tool>");

  // Before the first listing buy: none listed, none seen.
  let d = decide({ reading: reading(httpKeys), prev: { missing: {}, unreadable: 0 } });
  ok(d.notYetListed.length === 6 && d.newlyMissing.length === 0 && d.repeat.length === 0 && d.buy.length === 0 && d.action === "none" && d.state.mcpSeen.length === 0,
    "six MCP listings never seen in the listing are not yet listed: not missing, not bought, no page");
  ok(logLines(d).some((l) => /MCP tool listings not yet listed[^\n]*: 6\./.test(l)), "the log counts them");
  d = decide({ reading: reading(httpKeys), prev: d.state });
  ok(d.action === "none" && d.repeat.length === 0, "nor on the check after");

  // Listed: seen and remembered.
  d = decide({ reading: reading([...httpKeys, ...mcpKeys]), prev: { missing: {}, unreadable: 0 } });
  ok(d.notYetListed.length === 0 && d.newlyMissing.length === 0 && d.state.mcpSeen.join(",") === [...Object.values(MCP_LISTING_TOOLS)].sort().join(","), `a reading that holds the six listings finds them (${d.state.mcpSeen.join(", ")})`);
  const seenState = d.state;
  // One leaves.
  const without = [...httpKeys, ...mcpKeys.filter((k) => k !== "/mcp#web.answer")];
  d = decide({ reading: reading(without), prev: seenState });
  const ex = d.exempt.find((e) => e.key === "MCP /mcp#web.answer");
  ok(d.newlyMissing.length === 1 && ex?.why === "mcp listing" && d.buy.length === 0 && d.state.missing["MCP /mcp#web.answer"] === "mcp listing" && d.action === "none",
    "a listing that was seen and leaves is missing, is never bought by this check, and does not page on the first check");
  ok(d.state.mcpSeen.includes("web.answer"), "it stays remembered as seen");
  const d2 = decide({ reading: reading(without), prev: d.state });
  ok(d2.repeat.length === 1 && d2.action === "open" && d2.buy.length === 0, "still missing on the next check: the issue opens, nothing bought");
  const body = issueBody(d2);
  ok(/- `MCP \/mcp#web\.answer`: not bought here: an MCP tool listing/.test(body) && /bazaar-mcp-listings\.yml/.test(body) && !/\$\s?\d/.test(body), "the issue names the listing, why it was not bought, and the pass that buys it, with no figure");
  ok(issueListedKeys(body).has("MCP /mcp#web.answer"), "and the listing is read back from the issue body");
  // State lost with that issue open: the listing counts as missing before, never as not yet listed.
  const lost = decide({ reading: reading(without), prev: null, openIssue: true, issueListed: issueListedKeys(body) });
  ok(lost.repeat.length === 1 && lost.notYetListed.length === 0 && lost.action === "update", "with the state lost, a listing the open issue names is a repeat miss");
  // It returns: the issue closes.
  const back = decide({ reading: reading([...httpKeys, ...mcpKeys]), prev: d2.state, openIssue: true });
  ok(back.action === "close" && back.repeat.length === 0, "the issue closes when the listing is back");
  // A missing HTTP route is still bought as before, and an MCP listing never rides in the buy.
  const mixed = decide({ reading: reading([...httpKeys.filter((k) => k !== "/api/hash"), ...mcpKeys.filter((k) => k !== "/mcp#web.search")]), prev: seenState });
  ok(mixed.buy.map((b) => b.slug).join(",") === "hash" && mixed.exempt.some((e) => e.why === "mcp listing"), "a missing route is bought as before; the MCP listing beside it is not in the buy");
  // An unreadable check keeps what was seen.
  const blind = decide({ reading: null, prev: seenState });
  ok(blind.state.mcpSeen.length === 6 && blind.notYetListed.length === 0, "an unreadable check keeps the seen listings");

  // The reader finds the six rows in a feed.
  const items = [
    ...httpKeys.map((p) => ({ resource: `${ORIGIN}${p}`, type: "http" })),
    ...Object.values(MCP_LISTING_TOOLS).map((t) => ({ resource: `${ORIGIN}/mcp#${t}`, type: "mcp" })),
    { resource: "https://other.example/mcp#web.search", type: "mcp" },
  ];
  const fetchJson = async (url) => {
    if (url.endsWith("/api/pricing")) return pricing;
    const u = new URL(url);
    const offset = Number(u.searchParams.get("offset") || 0);
    return { items: offset === 0 ? items : [], pagination: { total: items.length, limit: 1000, offset } };
  };
  const got = await readListing({ target: ORIGIN, registryUrl: "https://registry.example/resources", fetchJson });
  const keys = got?.passes?.[0]?.keys || new Set();
  ok(mcpKeys.every((k) => keys.has(k)) && keys.has("/api/hash") && keys.size === new Set(httpKeys).size + 6, `a feed read holds the six MCP listings of ours beside the routes (${keys.size} keys)`);
  const dRead = decide({ reading: got, prev: { missing: {}, unreadable: 0 } });
  ok(dRead.state.mcpSeen.length === 6 && dRead.newlyMissing.length === 0, "and the decision over that read finds all six listed");
}

// ---- the plan ----------------------------------------------------------------------
{
  const lines = [];
  const dir = mkdtempSync(join(tmpdir(), "mcp-plan-"));
  const out = join(dir, "out");
  const fetchPricing = async () => PRICING;
  let code = await planRun(["mcp"], { env: { MAX_SPEND_USD: "1", GITHUB_OUTPUT: out }, log: (l) => lines.push(l), err: (l) => lines.push(l), fetchPricing });
  const written = readFileSync(out, "utf8");
  ok(code === 0 && written.includes(`slugs=${SIX}\n`) && /count=6/.test(written), `the plan writes the six slugs for the buy (${written.replace(/\n/g, " ")})`);
  ok(lines.some((l) => /MCP tool listings live in the catalog[^\n]*: 6 \(web\.search, /.test(l)) && !lines.some((l) => /\$\s?\d/.test(l)), "its log names the tools and no figure");
  code = await planRun(["mcp"], { env: { MAX_SPEND_USD: "0.10" }, log: () => {}, err: (l) => lines.push(l), fetchPricing });
  ok(code === 3 && lines.some((l) => /refusing: 6 routes/.test(l)), "it refuses when the listings together are over the cap");
  code = await planRun(["mcp"], { env: {}, log: () => {}, err: () => {}, fetchPricing });
  ok(code === 3, "and with no cap set");
  const exempt = { endpoints: PRICING.endpoints.map((e) => (e.slug === "answer" ? { ...e, quoted: true } : e)) };
  ok(mcpPassRoutes(exempt).length === 5 && !mcpPassRoutes(exempt).some((r) => r.slug === "answer"), "an exempt kind is left out of the plan");
  const low = [];
  await planRun(["low-water"], { env: {}, log: (l) => low.push(l), err: () => {}, fetchPricing });
  const tail = microsToUsd(passMicros(aboveCeilingRoutes(PRICING)));
  ok(Number(low[0]) === burnerLowWaterUsd(tail + 0.112) && tail === 0.85, `the burner low-water figure covers one pass above the ceiling and one MCP listings pass (${low[0]})`);
  const big = { endpoints: [...PRICING.endpoints.filter((e) => e.slug !== "answer"), { slug: "answer", method: "POST", path: "/api/answer", price: "$19.50" }, { slug: "pack", method: "POST", path: "/api/pack", price: "$0.60" }] };
  const lowBig = [];
  await planRun(["low-water"], { env: {}, log: (l) => lowBig.push(l), err: () => {}, fetchPricing: async () => big });
  const tailBig = microsToUsd(passMicros(aboveCeilingRoutes(big)));
  ok(Number(lowBig[0]) === burnerLowWaterUsd(tailBig + microsToUsd(passMicros(mcpPassRoutes(big)))) && Number(lowBig[0]) > burnerLowWaterUsd(tailBig), `a dearer MCP pass raises the figure (${lowBig[0]} over ${burnerLowWaterUsd(tailBig)})`);
}

// ---- the script, as a process ----------------------------------------------------------
const runScript = (script, args, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, env: { ...process.env, BURNER_KEY: "", KEY_FILE: "/nonexistent/agent-key", POW_SECRET: "", SLUGS: "", MODE: "", DRY_RUN: "", MAX_SPEND_USD: "", PAY_NETWORK: "", REQUIRE_SLUGS: "", ...env } });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.on("exit", (code) => resolve({ code, out, err, all: out + err }));
});

// The dry run against a stub catalog: exact output, nothing sent to /mcp.
{
  let mcpHits = 0, hits = 0;
  const stub = createServer((req, res) => {
    hits++;
    if (req.url.startsWith("/mcp")) { mcpHits++; res.writeHead(500); return res.end(); }
    const body = req.url === "/api/pricing" ? PRICING : req.url === "/openapi.json" ? SPEC : null;
    res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body || {}));
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const T = `http://127.0.0.1:${stub.address().port}`;
  try {
    const dry = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, MODE: "mcp", DRY_RUN: "1", SLUGS: SIX });
    const want = [
      `MCP tool listings to buy through ${T}/mcp (x402 MCP transport, Base, one buy each): 6`,
      "  web.search (search) $0.010",
      "  web.news (search-news) $0.010",
      "  web.answer (answer) $0.080",
      "  market.quote (stock-quote) $0.001",
      "  browser.render (render) $0.010",
      "  memory.read (memory-read) $0.001",
      "Total: 6 listings, $0.112",
      "DRY_RUN=1: nothing signed, nothing sent.",
      "",
    ].join("\n");
    ok(dry.code === 0 && dry.out === want && dry.err === "", `the six-slug dry run prints each listing, its price and the total, exactly (${JSON.stringify(dry.all.slice(-90))})`);
    ok(mcpHits === 0, "the dry run sends nothing to the connector");
    const one = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, MODE: "mcp", DRY_RUN: "1", SLUGS: "memory-read" });
    ok(one.code === 0 && /\n {2}memory\.read \(memory-read\) \$0\.001\nTotal: 1 listing, \$0\.001\n/.test(one.out) && !/web\./.test(one.out), "one slug: one listing and its own total");
    const more = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, MODE: "mcp", DRY_RUN: "1", SLUGS: `${SIX},hash` });
    ok(more.code === 2 && /refused "hash": not an MCP tool listing/.test(more.err) && /Refusing the whole run; nothing bought/.test(more.err) && !/Total:/.test(more.out), "a list that holds more than the listed slugs refuses the whole run");
    const before = hits;
    const none = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, MODE: "mcp", SLUGS: "" });
    ok(none.code === 2 && /needs an explicit SLUGS list/.test(none.err) && hits === before, "no slug list: refused before anything is read");
    const spaces = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, MODE: "mcp", SLUGS: " , ," });
    ok(spaces.code === 2 && /needs an explicit SLUGS list/.test(spaces.err), "a list of blanks is no list");
    // A paying run over more than the listed slugs refuses before the key is read or the connector asked.
    const paying = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, MODE: "mcp", SLUGS: "search,report", BURNER_KEY: generatePrivateKey() });
    ok(paying.code === 2 && /refused "report"/.test(paying.err) && mcpHits === 0 && !/Paying via/.test(paying.all), "a paying run refuses the same list before it loads a key or asks the connector");
    const cap = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, MODE: "mcp", DRY_RUN: "1", SLUGS: SIX, MAX_SPEND_USD: "0.10" });
    ok(cap.code === 2 && /over the MAX_SPEND_USD cap/.test(cap.err) && !/\$\s?\d/.test(cap.all), "listings over the spend cap refuse the run, with no figure");
    const sol = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, MODE: "mcp", DRY_RUN: "1", SLUGS: SIX, PAY_NETWORK: "solana" });
    ok(sol.code === 2 && /Base only/.test(sol.err), "another pay network is refused");
  } finally {
    stub.closeAllConnections?.();
    await new Promise((r) => stub.close(r));
  }
}

// ---- booted: the real connector, a stub facilitator ------------------------------------
const BASE_NET = "eip155:8453";
const TMP = mkdtempSync(join(tmpdir(), "mcp-listing-tools-"));
const seen = { verify: [], settle: [] };
const stubState = { settleFail: false };
let txN = 0;
const facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: BASE_NET }], extensions: [], signers: {} });
    if (req.url === "/rpc") return reply({ jsonrpc: "2.0", id: 1, result: "0x0" });
    let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") { seen.verify.push(parsed); return reply({ isValid: true, payer }); }
    if (req.url === "/settle") {
      seen.settle.push(parsed);
      if (stubState.settleFail) return reply({ success: false, errorReason: "transaction_failed", transaction: "", network: BASE_NET, payer });
      return reply({ success: true, transaction: `0x${(++txN).toString(16).padStart(64, "0")}`, network: BASE_NET, payer });
    }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;
const QUIET = {
  NODE_ENV: "test", REDIS_URL: "", STATE_DATABASE_URL: "", TARGET_URL: "", POSTHOG_API_KEY: "",
  STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
  MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off",
  AGENT402_MCP_MAX_PER_MIN: "1000", AGENT402_MCP_MAX_PER_HOUR: "100000", AGENT402_MCP_REQ_PER_MIN: "1000", AGENT402_MCP_REQ_PER_HOUR: "100000",
};
let paid = null, free = null;
try {
  paid = await bootServer({
    stores: "mcp-listing-tools",
    args: ["--import", "./scripts/lib/loopback-only-preload.js"],
    env: {
      ...QUIET, FREE_MODE: "", BASE_URL: ORIGIN, TRUST_PROXY_HOPS: "1",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
      FACILITATOR_URL: FAC, PAYAI_FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, EVM_RPC_8453: `${FAC}/rpc`, FACILITATOR_GAS_CHECK: "off",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", CIRCLE_FACILITATOR_API_KEY: "",
      MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", ROBINHOOD_RELAYER_KEY: "",
      SALES_LEDGER_DB: join(TMP, "sales.db"), REFUND_DB_DIR: TMP, HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
    },
  });
  const T = paid.url;
  const livePricing = await (await fetch(`${T}/api/pricing`)).json();
  const live = mcpListingRoutes(livePricing);
  ok(live.some((r) => r.slug === "memory-read"), `the paid boot carries MCP listing tools (${live.map((r) => r.toolName).join(", ")})`);

  // Validation of the live offers.
  const vLines = [];
  const vCode = await runMcpValidation({ target: T, env: { LISTING_ORIGIN: ORIGIN }, log: (l) => vLines.push(l) });
  ok(vCode === 0 && live.every((r) => vLines.some((l) => l.startsWith(`ok   MCP ${r.toolName} - valid MCP listing offer`))) && vLines.includes("BAZAAR VALIDATION OK"),
    `bazaar-validate --mcp passes every live MCP listing offer (${vLines.filter((l) => /^(ok|FAIL|\?\?)/.test(l)).length} read, exit ${vCode})`);
  const wrongOrigin = [];
  const wCode = await runMcpValidation({ target: T, env: {}, log: (l) => wrongOrigin.push(l) });
  ok(wCode === 1 && wrongOrigin.some((l) => /^FAIL MCP memory\.read - resource is "https:\/\/agent402\.tools\/mcp"/.test(l)), "an offer whose resource is not the expected origin's /mcp fails validation (exit 1)");
  const asProcess = await runScript("scripts/bazaar-validate.js", ["--mcp"], { TARGET_URL: T, LISTING_ORIGIN: ORIGIN });
  ok(asProcess.code === 0 && /BAZAAR VALIDATION OK/.test(asProcess.out), "the --mcp flag runs it as a process");

  // The dry run with the offer check.
  const chk = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, LISTING_ORIGIN: ORIGIN, MODE: "mcp", DRY_RUN: "1", CHECK_OFFER: "1", SLUGS: "memory-read" });
  ok(chk.code === 0 && /offer memory\.read: the MCP listing offer, at the list price/.test(chk.out) && seen.verify.length === 0 && seen.settle.length === 0, "the dry run's offer check reads the offer and pays nothing");
  const chkBad = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, MODE: "mcp", DRY_RUN: "1", CHECK_OFFER: "1", SLUGS: "memory-read" });
  ok(chkBad.code === 1 && /offer memory\.read: NOT the MCP listing offer/.test(chkBad.out), "and says so when the offer is not the listing's");

  // The buy, as the workflow runs it. memory.read answers every wallet (its example lists keys).
  const KEY = generatePrivateKey();
  const buy = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, LISTING_ORIGIN: ORIGIN, MODE: "mcp", SLUGS: "memory-read", BURNER_KEY: KEY, MAX_SPEND_USD: "1" });
  ok(buy.code === 0 && /\n {2}OK memory\.read\n/.test(buy.out) && /1 ok, 0 failed, 1 signature\(s\)/.test(buy.out), `the buy settles the listing once (${buy.all.split("\n").filter((l) => /OK|FAIL|complete/.test(l)).join(" | ")})`);
  ok(seen.verify.length === 1 && seen.settle.length === 1, `one verify and one settle reached the facilitator (${seen.verify.length}, ${seen.settle.length})`);
  const settled = seen.settle[0]?.paymentPayload || {};
  ok(settled.resource?.url === `${ORIGIN}/mcp` && settled.extensions?.bazaar?.info?.input?.type === "mcp" && settled.extensions.bazaar.info.input.toolName === "memory.read",
    `the settled payment names the resource /mcp and the MCP extension for memory.read (${settled.resource?.url})`);
  ok(String(settled.payload?.authorization?.value) === "1000" && seen.settle[0]?.paymentRequirements?.network === BASE_NET, "at the listing's list price, on Base");
  ok(!/\$\s?\d/.test(buy.out.split("\n").filter((l) => !/refusing accept/.test(l)).join("\n")) && !buy.all.includes(KEY), "a paying run's log names no price, total or cap, and never the key");

  // A slug outside the list beside a good one: nothing is bought.
  const n0 = seen.settle.length;
  const mixed = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, LISTING_ORIGIN: ORIGIN, MODE: "mcp", SLUGS: "memory-read,memory-write", BURNER_KEY: KEY });
  ok(mixed.code === 2 && seen.settle.length === n0 && seen.verify.length === 1, "a list with one slug outside the MCP listings buys nothing at all");

  // An origin the offer does not name: never signed.
  const off = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, MODE: "mcp", SLUGS: "memory-read", BURNER_KEY: KEY });
  ok(off.code === 1 && /FAIL memory\.read: the offer is not this tool's MCP listing offer/.test(off.err) && /0 ok, 1 failed, 0 signature\(s\)/.test(off.out) && seen.verify.length === 1, "an offer that is not the listing's is not signed (0 signatures)");

  // A settle that fails: one attempt, not sent again, exit 1.
  stubState.settleFail = true;
  const s0 = seen.settle.length;
  const bad = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, LISTING_ORIGIN: ORIGIN, MODE: "mcp", SLUGS: "memory-read", BURNER_KEY: KEY });
  stubState.settleFail = false;
  ok(bad.code === 1 && /FAIL memory\.read: the payment did not settle/.test(bad.err) && /0 ok, 1 failed, 1 signature\(s\)/.test(bad.out) && /Failed buys \(1\): memory\.read/.test(bad.err), `a settle that fails fails the run (${bad.err.split("\n")[0].slice(0, 100)})`);
  ok(seen.settle.length - s0 >= 1 && new Set(seen.settle.slice(s0).map((x) => x.paymentPayload?.payload?.authorization?.nonce)).size === 1, "with one signature: nothing is signed or sent a second time");

  // A cap under the listing's price: refused before anything is signed.
  const v0 = seen.verify.length;
  const capped = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, LISTING_ORIGIN: ORIGIN, MODE: "mcp", SLUGS: "memory-read", BURNER_KEY: KEY, MAX_SPEND_USD: "0.0005" });
  ok(capped.code === 2 && seen.verify.length === v0, "a cap under the listing's price refuses the run before a signature");

  // No x402 on the connector (FREE_MODE): nothing to buy, validation fails.
  free = await bootServer({ stores: "mcp-listing-tools-free", env: { ...QUIET, FREE_MODE: "true", BASE_URL: ORIGIN } });
  const fLines = [];
  const fCode = await runMcpValidation({ target: free.url, env: { LISTING_ORIGIN: ORIGIN }, log: (l) => fLines.push(l) });
  ok(fCode === 1 && fLines.some((l) => /^FAIL MCP memory\.read - no x402 offer/.test(l)), `a boot with no paywall has no MCP listing offer to validate (exit ${fCode})`);
  const fBuy = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: free.url, LISTING_ORIGIN: ORIGIN, MODE: "mcp", SLUGS: "memory-read", BURNER_KEY: KEY });
  ok(fBuy.code === 1 && /0 ok, 1 failed, 0 signature\(s\)/.test(fBuy.out), "and the buy signs nothing there");
} catch (e) {
  ok(false, e?.stack || String(e));
} finally {
  if (paid) await paid.stop();
  if (free) await free.stop();
  facilitator.closeAllConnections?.();
  await new Promise((r) => facilitator.close(r));
}

// ---- the workflow ------------------------------------------------------------------
{
  const src = read(".github/workflows/bazaar-mcp-listings.yml");
  const wf = load(src);
  const steps = wf.jobs?.buy?.steps || [];
  const plan = steps.find((s) => s.id === "plan") || {};
  const buy = steps.find((s) => /refresh-bazaar\.js/.test(String(s.run || ""))) || {};
  const install = steps.find((s) => /npm ci/.test(String(s.run || ""))) || {};
  ok(wf.on?.workflow_dispatch?.inputs?.slugs?.default === "" && (wf.on?.schedule || []).length === 1, "the workflow is dispatched with an explicit slug list (empty by default) and scheduled once");
  ok(wf.concurrency?.group === load(read(".github/workflows/bazaar-keepalive-tail.yml")).concurrency?.group && wf.concurrency?.["cancel-in-progress"] === false, "it shares the keep-alive passes' concurrency group: one burner, one pass at a time");
  ok(buy.env?.MODE === "mcp" && buy.env?.SLUGS === "${{ steps.plan.outputs.slugs }}" && buy.env?.PAY_NETWORK === "base" && /steps\.plan\.outputs\.slugs != ''/.test(String(buy.if)) && /steps\.plan\.outputs\.slugs != ''/.test(String(install.if)),
    "the buy is MODE=mcp over the plan step's slugs, and neither it nor the install runs without them");
  ok(!plan.env?.BURNER_KEY && !install.env && buy.env?.BURNER_KEY === "${{ secrets.BURNER_KEY }}" && /BURNER_KEY is not set[^\n]*exit 1/.test(buy.run) && /add-mask::\$BURNER_KEY/.test(buy.run), "only the buy step holds the key, masked, and a missing key fails the pass");
  ok(plan.env?.ASKED === "${{ inputs.slugs }}" && !/\$\{\{/.test(String(plan.run)) && !/\$\{\{/.test(String(buy.run)) && plan.run.includes('[[ "$ASKED" =~ ^[a-z0-9-]+(,[a-z0-9-]+)*$ ]]'),
    "the dispatched list reaches the shell through the environment only, and must be a comma list of slugs");
  ok(/"\$ENABLED" = "on"/.test(plan.run) && plan.env?.ENABLED === "${{ vars.BAZAAR_MCP_KEEPALIVE }}" && /keepalive-plan\.js mcp/.test(plan.run), "the scheduled run buys only while the repo variable BAZAAR_MCP_KEEPALIVE is on, from the plan's list");
  ok(plan.env?.MAX_SPEND_USD === buy.env?.MAX_SPEND_USD && /'1'/.test(String(buy.env?.MAX_SPEND_USD)), "the plan and the buy read one pass cap");
  ok(/gh issue create/.test(JSON.stringify(wf.jobs?.report || {})) && wf.jobs?.report?.if === "always()" && Number.isInteger(wf.jobs?.buy?.["timeout-minutes"]), "a failed pass pages, and the job is bounded");
  ok(!/removes a resource|30-day (removal|rule)/i.test(src) && /observed to leave the Bazaar listing after about 30 days/.test(src), "it states the 30-day behavior as observed");
  // The plan step as written: a dispatch with a list, without one, with a hostile one; a schedule on and off.
  const runPlan = (env) => new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-wf-"));
    const outFile = join(dir, "out");
    const child = spawn("bash", ["-c", plan.run], { cwd: dir, env: { PATH: process.env.PATH, GITHUB_OUTPUT: outFile, ...env } });
    let text = "";
    child.stdout.on("data", (d) => { text += d; });
    child.stderr.on("data", (d) => { text += d; });
    child.on("exit", (code) => { let o = ""; try { o = readFileSync(outFile, "utf8"); } catch { /* none */ } resolve({ code, text, out: o }); });
  });
  const a = await runPlan({ EVENT: "workflow_dispatch", ASKED: SIX });
  ok(a.code === 0 && a.out === `slugs=${SIX}\n`, "a dispatch with the six slugs hands exactly them to the buy");
  const b = await runPlan({ EVENT: "workflow_dispatch", ASKED: "" });
  ok(b.code === 0 && b.out === "" && /nothing bought/.test(b.text), "a dispatch with no slugs buys nothing");
  const c = await runPlan({ EVENT: "workflow_dispatch", ASKED: "search\nslugs=hash" });
  const c2 = await runPlan({ EVENT: "workflow_dispatch", ASKED: "search;id" });
  ok(c.code === 1 && c.out === "" && c2.code === 1 && c2.out === "", "a list that is not a comma list of slugs fails the step and writes nothing");
  const off = await runPlan({ EVENT: "schedule", ASKED: "", ENABLED: "" });
  ok(off.code === 0 && off.out === "" && /is off/.test(off.text), "a scheduled run with the switch off buys nothing");
  const claude = read("CLAUDE.md");
  ok(/`BAZAAR_MCP_KEEPALIVE`/.test(claude) && /bazaar-mcp-listings\.yml/.test(claude), "CLAUDE.md documents the workflow and its switch");
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
