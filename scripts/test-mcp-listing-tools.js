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
  mcpListingSlugsOf, mcpSignableOffer, publishedPayTo, MCP_OFFER_MAX_VALIDITY_SECONDS,
} from "./lib/mcp-listings.js";
import { buyMcpListing, askMcpOffer, signedPaymentProblems, X402_PAYMENT_META, X402_PAYMENT_RESPONSE_META } from "./lib/mcp-x402-client.js";
import { staleCandidates, buyMcpListings, buildPayClient, signedSpendBudget } from "./refresh-bazaar.js";
import { decide, issueBody, issueListedKeys, logLines, listingKeyOnHost, mcpCatalogRows, readListing, run as runPresence } from "./bazaar-presence.js";
import { run as planRun, mcpPassRoutes } from "./keepalive-plan.js";
import { aboveCeilingRoutes, passMicros, burnerLowWaterUsd, microsToUsd } from "./lib/keepalive-plan.js";
import { runMcpValidation, mcpListingOfferProblems } from "./bazaar-validate.js";
import { decide as decideIssue, issueBody as issueOf, recordedSlugs } from "./mcp-listings-issue.js";

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
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const OTHER = "0x00000000000000000000000000000000000000A1";
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
  const args = { toolName: "web.search", origin: ORIGIN, micros: 10000, payTo: PAY_TO };
  ok(mcpOfferProblems(good, args).length === 0, "the tool's MCP listing offer at the list price has no problem");
  const bad = (over, re, label) => { const p = mcpOfferProblems({ ...good, ...over }, args); ok(p.some((x) => re.test(x)), `${label} (${p.join("; ").slice(0, 110)})`); };
  bad({ resource: { url: `${ORIGIN}/api/search` } }, /resource is/, "an offer naming the HTTP route is refused");
  bad({ extensions: offerFor("web.news", 10000).extensions }, /toolName is "web\.news"/, "another tool's extension is refused");
  bad({ extensions: bazaar.declareDiscoveryExtension({ method: "GET", input: { q: "x" } }) }, /type is/, "an HTTP discovery extension is refused");
  bad({ extensions: {} }, /no bazaar discovery extension/, "an offer with no discovery extension is refused");
  bad({ accepts: [{ ...good.accepts[0], amount: "10001" }] }, /list price/, "a Base accept asking another amount is refused");
  bad({ accepts: [{ ...good.accepts[0], network: "eip155:10" }] }, /no exact accept on eip155:8453/, "an offer with no Base accept is refused");
  bad({ x402Version: 1 }, /x402Version/, "a v1 offer is refused");
  // What a signature would authorize: where it pays, for how long, and that there is one accept to sign.
  bad({ accepts: [{ ...good.accepts[0], payTo: OTHER }] }, /published receiving address/, "an offer at the list price paying ANOTHER address is refused");
  bad({ accepts: [{ ...good.accepts[0], payTo: undefined }] }, /published receiving address/, "an offer with no payTo is refused");
  bad({ accepts: [{ ...good.accepts[0], maxTimeoutSeconds: 10 * 365 * 86400 }] }, /validity window/, "an offer asking a ten-year validity window is refused");
  bad({ accepts: [{ ...good.accepts[0], maxTimeoutSeconds: MCP_OFFER_MAX_VALIDITY_SECONDS + 1 }] }, /validity window/, "one second past the bounded window is refused");
  bad({ accepts: [{ ...good.accepts[0], maxTimeoutSeconds: undefined }] }, /validity window/, "an offer with no validity window is refused");
  bad({ accepts: [good.accepts[0], { ...good.accepts[0], payTo: OTHER }] }, /2 exact USDC accepts .* not exactly one/, "two exact USDC accepts on Base are refused: the signer could pick either");
  bad({ accepts: [{ ...good.accepts[0], asset: OTHER }] }, /no exact accept on eip155:8453/, "a Base accept in another asset is refused");
  ok(mcpOfferProblems({ ...good, accepts: [{ ...good.accepts[0], maxTimeoutSeconds: MCP_OFFER_MAX_VALIDITY_SECONDS }] }, args).length === 0 && mcpOfferProblems({ ...good, accepts: [{ ...good.accepts[0], payTo: PAY_TO.toLowerCase() }] }, args).length === 0, "the bound itself and another letter case of the address pass");
  // Other ways to pay on Base ride beside the plain accept (Permit2, a batched authorization with a week-long window): never the ones signed.
  const beside = { ...good, accepts: [{ ...good.accepts[0], scheme: "upto", extra: { assetTransferMethod: "permit2" } }, good.accepts[0], { ...good.accepts[0], maxTimeoutSeconds: 604900, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: OTHER } }, { ...good.accepts[0], network: "eip155:10" }] };
  // The Permit2 marker alone (exact, Base, USDC, the same pay-to and window) keeps an accept out.
  const permit2 = { ...good.accepts[0], extra: { ...good.accepts[0].extra, assetTransferMethod: "permit2" } };
  const marked = mcpSignableOffer({ ...good, accepts: [permit2, good.accepts[0]] });
  ok(marked?.accepts.length === 1 && marked.accepts[0] === good.accepts[0] && mcpSignableOffer({ ...good, accepts: [permit2] }) === null && mcpOfferProblems({ ...good, accepts: [permit2, good.accepts[0]] }, args).length === 0,
    "an exact USDC accept on Base marked Permit2 is never the one signed, and beside the plain accept the offer still passes");
  const eip3009 = { ...good.accepts[0], extra: { ...good.accepts[0].extra, assetTransferMethod: "eip3009" } };
  ok(mcpSignableOffer({ ...good, accepts: [eip3009] })?.accepts[0] === eip3009, "control: the same accept marked eip3009 is the one signed");
  const signable = mcpSignableOffer(beside);
  ok(mcpOfferProblems(beside, args).length === 0 && signable?.accepts.length === 1 && signable.accepts[0] === good.accepts[0] && signable.resource === beside.resource && mcpSignableOffer({ ...good, accepts: [] }) === null,
    "beside other Base accepts the plain one is checked, and it alone is handed to the signer");
  ok(publishedPayTo({ payment: { x402: { payTo: PAY_TO } } }) === PAY_TO && publishedPayTo({ payment: { x402: { payTo: "0x12" } } }) === null && publishedPayTo({}) === null && publishedPayTo(null) === null, "the published receiving address is read from the service manifest, or is none");
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
  // The connector's ask: the offer as JSON in the first text block, no structuredContent.
  const ask = (offer) => ({ isError: true, content: [{ type: "text", text: JSON.stringify(offer) }, { type: "text", text: "This tool requires payment." }] });
  ok((await askMcpOffer(async () => ask(offerFor("web.search", 10000)), "web.search", {})).offer?.accepts?.length === 1 && (await askMcpOffer(async () => ({ isError: true, structuredContent: offerFor("web.search", 10000), content: [] }), "web.search", {})).offer?.x402Version === 2,
    "the offer is read from the first text block, and from structuredContent where a server sends it");
  let signed = 0, lastSigned = null;
  const authFor = (over = {}) => ({ x402Version: 2, payload: { signature: "0x00", authorization: { to: PAY_TO, value: "10000", validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 60), ...over } } });
  const signPayment = async (offer) => { signed++; lastSigned = offer; return authFor(); };
  // Every buy below is held to the published receiving address.
  const buy1 = (o) => buyMcpListing({ payTo: PAY_TO, ...o });
  const paidOk = { content: [{ type: "text", text: "{}" }], _meta: { [X402_PAYMENT_RESPONSE_META]: { success: true, transaction: "0x1" } } };

  let c = mk([ask(offerFor("web.search", 10000)), paidOk]);
  let r = await buy1({ ...c, signPayment, route, args: { q: "x" }, origin: ORIGIN });
  ok(r.ok && signed === 1 && c.calls.length === 2 && !c.calls[0].meta && c.calls[1].meta?.[X402_PAYMENT_META]?.payload?.signature === "0x00", "a buy is one unpaid ask, one signature, one paid call carrying the payment in _meta");

  signed = 0; c = mk([ask(offerFor("web.search", 10000, { resource: { url: `${ORIGIN}/api/search` } })), paidOk]);
  r = await buy1({ ...c, signPayment, route, origin: ORIGIN });
  ok(!r.ok && !r.signed && signed === 0 && c.calls.length === 1 && /not this tool's MCP listing offer/.test(r.why), `the HTTP route's offer (a build without the twins) is never signed (${String(r.why).slice(0, 90)})`);

  signed = 0; c = mk([ask(offerFor("web.search", 20000)), paidOk]);
  r = await buy1({ ...c, signPayment, route, origin: ORIGIN });
  ok(!r.ok && signed === 0 && c.calls.length === 1, "an offer above the list price is never signed");

  signed = 0; c = mk([{ content: [{ type: "text", text: "served free" }] }]);
  r = await buy1({ ...c, signPayment, route, origin: ORIGIN });
  ok(!r.ok && signed === 0 && /without asking for a payment/.test(r.why), "a tool that answers without a payment is not a buy");

  signed = 0; c = mk([{ isError: true, content: [{ type: "text", text: "wallet required: run the npm package" }] }]);
  r = await buy1({ ...c, signPayment, route, origin: ORIGIN });
  ok(!r.ok && signed === 0 && /no x402 offer/.test(r.why), "a refusal with no x402 offer (no paywall on the connector) is not a buy");

  signed = 0; c = mk([ask(offerFor("web.search", 10000)), new Error("timeout")]);
  r = await buy1({ ...c, signPayment, route, origin: ORIGIN });
  ok(!r.ok && r.sent && signed === 1 && c.calls.length === 2 && /not sent again/.test(r.why), "a paid call that does not answer is reported and never sent again");

  signed = 0; c = mk([ask(offerFor("web.search", 10000)), { isError: true, content: [{ type: "text", text: "settlement failed" }], _meta: { [X402_PAYMENT_RESPONSE_META]: { success: false } } }]);
  r = await buy1({ ...c, signPayment, route, origin: ORIGIN });
  ok(!r.ok && r.sent && signed === 1 && c.calls.length === 2 && /did not settle/.test(r.why), "a settle that fails is reported and never sent again");

  signed = 0; c = mk([ask(offerFor("web.search", 10000)), paidOk]);
  r = await buy1({ ...c, signPayment: async () => { throw new Error("selected accept refused: over the cap"); }, route, origin: ORIGIN });
  ok(!r.ok && !r.sent && c.calls.length === 1 && /no payment was signed/.test(r.why), "a signature the cap refuses sends nothing");

  // Where the money goes and for how long: never signed otherwise.
  for (const [over, label] of [
    [{ payTo: OTHER }, "an offer at the list price to another address"],
    [{ maxTimeoutSeconds: 10 * 365 * 86400 }, "an offer with a ten-year validity window"],
  ]) {
    const o = offerFor("web.search", 10000); o.accepts = [{ ...o.accepts[0], ...over }];
    signed = 0; c = mk([ask(o), paidOk]);
    r = await buy1({ ...c, signPayment, route, origin: ORIGIN });
    ok(!r.ok && !r.signed && signed === 0 && c.calls.length === 1, `${label} is never signed (${String(r.why).slice(-70)})`);
  }
  { const o = offerFor("web.search", 10000); o.accepts = [o.accepts[0], { ...o.accepts[0], payTo: OTHER }];
    signed = 0; c = mk([ask(o), paidOk]);
    r = await buy1({ ...c, signPayment, route, origin: ORIGIN });
    ok(!r.ok && signed === 0 && c.calls.length === 1, "an offer with two exact USDC accepts on Base is never signed"); }
  { const o = offerFor("web.search", 10000); o.accepts = [{ ...o.accepts[0], maxTimeoutSeconds: 604900, extra: { name: "GatewayWalletBatched", verifyingContract: OTHER } }, o.accepts[0]];
    signed = 0; lastSigned = null; c = mk([ask(o), paidOk]);
    r = await buy1({ ...c, signPayment, route, origin: ORIGIN });
    ok(r.ok && signed === 1 && lastSigned.accepts.length === 1 && lastSigned.accepts[0].maxTimeoutSeconds === 60 && lastSigned.accepts[0].extra?.verifyingContract === undefined, "the signer is handed the one checked accept, never the batched one listed before it"); }
  signed = 0; c = mk([ask(offerFor("web.search", 10000)), paidOk]);
  r = await buyMcpListing({ ...c, signPayment, route, origin: ORIGIN });
  ok(!r.ok && signed === 0 && c.calls.length === 0 && /no published receiving address/.test(r.why), "with no published receiving address to hold the offer to, nothing is asked or signed");
  // The signed authorization is read back before it is sent.
  for (const [over, re, label] of [
    [{ to: OTHER }, /another address/, "an authorization that pays another address"],
    [{ value: "10001" }, /list price/, "an authorization for another amount"],
    [{ validBefore: String(Math.floor(Date.now() / 1000) + 10 * 365 * 86400) }, /longer than the bounded window/, "an authorization valid for ten years"],
  ]) {
    c = mk([ask(offerFor("web.search", 10000)), paidOk]);
    r = await buy1({ ...c, signPayment: async () => authFor(over), route, origin: ORIGIN });
    ok(!r.ok && r.signed && !r.sent && c.calls.length === 1 && re.test(r.why), `${label} is not sent`);
  }
  ok(signedPaymentProblems(authFor(), { micros: 10000, payTo: PAY_TO }).length === 0 && signedPaymentProblems({ payload: {} }, { micros: 10000, payTo: PAY_TO })[0] === "no readable transfer authorization", "the read-back passes the authorization the offer asked for, and refuses a payload without one");
}

// ---- the two holds on what a run may sign, with the real capped client --------------------
{
  const key = generatePrivateKey();
  const mkRoutes = () => [{ slug: "search", toolName: "web.search", micros: 10000 }, { slug: "search-news", toolName: "web.news", micros: 10000 }, { slug: "memory-read", toolName: "memory.read", micros: 1000 }];
  const quiet = { log: () => {}, err: () => {} };
  const valueOf = (payment) => String(payment?.payload?.authorization?.value);
  // A buy that signs whatever offer it is given: what a missed offer check would do.
  const blindBuy = (offerOf) => async ({ signPayment, route }) => {
    try { const payment = await signPayment(offerOf(route)); return { ok: true, signed: true, sent: true, payment }; } catch (e) { return { ok: false, signed: false, sent: false, why: String(e?.message || e) }; }
  };
  // The capped client logs each refusal; those lines are kept out of this
  // suite's output, and every assertion is printed with the real console.
  const origError = console.error, origLog = console.log;
  const mute = () => { console.error = () => {}; console.log = () => {}; };
  const say = (c, m) => { console.error = origError; console.log = origLog; ok(c, m); mute(); };
  mute();
  try {
    // The per-listing hold: the first tool's offer asks ten times its list
    // price, while nothing is signed yet and the run total would cover it.
    {
      const routes = mkRoutes().reverse();
      const budget = signedSpendBudget(routes.reduce((n, r) => n + r.micros, 0) / 1e6);
      const client = await buildPayClient(budget, { key });
      const seenValues = [];
      const out = await buyMcpListings({ routes, budget, callTool: null, signPayment: async (offer) => { const p = await client.createPaymentPayload(offer); seenValues.push(valueOf(p)); return p; }, origin: ORIGIN, payTo: PAY_TO, ...quiet,
        buy: blindBuy((r) => offerFor(r.toolName, r.toolName === "memory.read" ? 10000 : r.micros)) });
      say(out.okCount === 2 && out.failed.join() === "memory.read" && seenValues.join() === "10000,10000" && budget.signatures === 2 && budget.signedMicros === 20000,
        `an offer asking above its listing's list price is not signed, though the run's total would still cover it (signed ${seenValues.join(",")}; failed ${out.failed.join()})`);
      let after = null;
      try { await client.createPaymentPayload(offerFor("memory.read", 1000)); after = "signed"; } catch { after = "refused"; }
      say(after === "refused" && budget.signatures === 2, "once the loop ends nothing more is signable with that client");
    }
    // The run total: the sum of the listed prices, and no signature past it.
    {
      const routes = mkRoutes().slice(0, 2);
      const budget = signedSpendBudget(0.015); // one listing fits, two do not
      const client = await buildPayClient(budget, { key });
      const asked = [];
      const out = await buyMcpListings({ routes, budget, callTool: null, signPayment: (offer) => client.createPaymentPayload(offer), origin: ORIGIN, payTo: PAY_TO, ...quiet,
        buy: async (o) => { asked.push(o.route.toolName); return blindBuy((r) => offerFor(r.toolName, r.micros))(o); } });
      say(out.okCount === 1 && out.failed.join() === "web.news" && asked.join() === "web.search" && budget.signatures === 1 && budget.signedMicros === 10000, `a listing that does not fit under what the run may still sign is not asked for (asked ${asked.join()})`);
    }
    {
      // The same total held at the signature itself: a second signature of a listing already bought.
      const routes = [mkRoutes()[0]];
      const budget = signedSpendBudget(0.01);
      const client = await buildPayClient(budget, { key });
      let second = null;
      const out = await buyMcpListings({ routes, budget, callTool: null, signPayment: (offer) => client.createPaymentPayload(offer), origin: ORIGIN, payTo: PAY_TO, ...quiet,
        buy: async (o) => { const first = await blindBuy((r) => offerFor(r.toolName, r.micros))(o); try { await o.signPayment(offerFor(o.route.toolName, o.route.micros)); second = "signed"; } catch { second = "refused"; } return first; } });
      say(out.okCount === 1 && second === "refused" && budget.signatures === 1 && budget.signedMicros === 10000, "past the listings' list prices together, a further signature is refused");
    }
  } finally { console.error = origError; console.log = origLog; }
}

// ---- the presence check ------------------------------------------------------------
{
  const pricing = PRICING;
  const httpKeys = pricing.endpoints.map((e) => e.path);
  const mcpKeys = Object.values(MCP_LISTING_TOOLS).map(mcpListingKey);
  const reading = (keys) => ({ pricing, passes: [{ keys: new Set(keys) }, { keys: new Set(keys) }] });
  // The listings are counted while the scheduled MCP pass is on (BAZAAR_MCP_KEEPALIVE=on).
  const decideOn = (o) => decide({ mcpKeepalive: true, ...o });
  ok(mcpCatalogRows(pricing).length === 6 && mcpCatalogRows(pricing)[0].key === "MCP /mcp#web.search" && mcpCatalogRows(pricing)[0].slug === "search", "the catalog's MCP listings are read as MCP /mcp#<tool>");

  // Before the first listing buy: none listed, none seen.
  let d = decideOn({ reading: reading(httpKeys), prev: { missing: {}, unreadable: 0 } });
  ok(d.notYetListed.length === 6 && d.newlyMissing.length === 0 && d.repeat.length === 0 && d.buy.length === 0 && d.action === "none" && d.state.mcpSeen.length === 0,
    "six MCP listings never seen in the listing are not yet listed: not missing, not bought, no page");
  ok(logLines(d).some((l) => /MCP tool listings not yet listed[^\n]*: 6\./.test(l)), "the log counts them");
  d = decideOn({ reading: reading(httpKeys), prev: d.state });
  ok(d.action === "none" && d.repeat.length === 0, "nor on the check after");

  // Listed: seen and remembered.
  d = decideOn({ reading: reading([...httpKeys, ...mcpKeys]), prev: { missing: {}, unreadable: 0 } });
  ok(d.notYetListed.length === 0 && d.newlyMissing.length === 0 && d.state.mcpSeen.join(",") === [...Object.values(MCP_LISTING_TOOLS)].sort().join(","), `a reading that holds the six listings finds them (${d.state.mcpSeen.join(", ")})`);
  const seenState = d.state;
  // One leaves.
  const without = [...httpKeys, ...mcpKeys.filter((k) => k !== "/mcp#web.answer")];
  d = decideOn({ reading: reading(without), prev: seenState });
  const ex = d.exempt.find((e) => e.key === "MCP /mcp#web.answer");
  ok(d.newlyMissing.length === 1 && ex?.why === "mcp listing" && d.buy.length === 0 && d.state.missing["MCP /mcp#web.answer"] === "mcp listing" && d.action === "none",
    "a listing that was seen and leaves is missing, is never bought by this check, and does not page on the first check");
  ok(d.state.mcpSeen.includes("web.answer"), "it stays remembered as seen");
  const d2 = decideOn({ reading: reading(without), prev: d.state });
  ok(d2.repeat.length === 1 && d2.action === "open" && d2.buy.length === 0, "still missing on the next check: the issue opens, nothing bought");
  const body = issueBody(d2);
  ok(/- `MCP \/mcp#web\.answer`: not bought here: an MCP tool listing/.test(body) && /bazaar-mcp-listings\.yml/.test(body) && !/\$\s?\d/.test(body), "the issue names the listing, why it was not bought, and the pass that buys it, with no figure");
  ok(issueListedKeys(body).has("MCP /mcp#web.answer"), "and the listing is read back from the issue body");
  // State lost with that issue open: the listing counts as missing before, never as not yet listed.
  const lost = decideOn({ reading: reading(without), prev: null, openIssue: true, issueListed: issueListedKeys(body) });
  ok(lost.repeat.length === 1 && lost.notYetListed.length === 0 && lost.action === "update", "with the state lost, a listing the open issue names is a repeat miss");
  // It returns: the issue closes.
  const back = decideOn({ reading: reading([...httpKeys, ...mcpKeys]), prev: d2.state, openIssue: true });
  ok(back.action === "close" && back.repeat.length === 0, "the issue closes when the listing is back");
  // A missing HTTP route is still bought as before, and an MCP listing never rides in the buy.
  const mixed = decideOn({ reading: reading([...httpKeys.filter((k) => k !== "/api/hash"), ...mcpKeys.filter((k) => k !== "/mcp#web.search")]), prev: seenState });
  ok(mixed.buy.map((b) => b.slug).join(",") === "hash" && mixed.exempt.some((e) => e.why === "mcp listing"), "a missing route is bought as before; the MCP listing beside it is not in the buy");
  // An unreadable check keeps what was seen.
  const blind = decideOn({ reading: null, prev: seenState });
  ok(blind.state.mcpSeen.length === 6 && blind.notYetListed.length === 0, "an unreadable check keeps the seen listings");


  // With the scheduled MCP pass off (the default), nothing re-buys a listing:
  // one that left is logged and counts as nothing, so it never holds the
  // issue open over a route, and a route that goes missing still pages.
  {
    const off = decide({ reading: reading(without), prev: seenState });
    ok(off.newlyMissing.length === 0 && off.mcpUncounted.length === 1 && off.mcpUncounted[0].key === "MCP /mcp#web.answer" && !Object.hasOwn(off.state.missing, "MCP /mcp#web.answer") && off.action === "none" && off.state.mcpSeen.includes("web.answer"),
      "switch off: a listing that left is not counted as missing, not remembered as missing, and still remembered as seen");
    ok(logLines(off).some((l) => /MCP tool listings absent, not counted while the scheduled MCP listings pass is off \(BAZAAR_MCP_KEEPALIVE\): 1\./.test(l)), "switch off: the log counts it");
    const off2 = decide({ reading: reading(without), prev: off.state });
    ok(off2.repeat.length === 0 && off2.action === "none", "switch off: still absent on the next check, no issue opens");
    // The issue opened while the switch was on closes once it is off, though the listing is still absent.
    ok(decide({ reading: reading(without), prev: d2.state, openIssue: true }).action === "close", "switch off: an issue opened over a listing closes, the listing still absent");
    // State lost with that issue open: the listing it names is not a repeat miss.
    const lostOff = decide({ reading: reading(without), prev: null, openIssue: true, issueListed: issueListedKeys(body) });
    ok(lostOff.repeat.length === 0 && lostOff.action === "close", "switch off, state lost: a listing the open issue names is not a repeat miss");
    // A route missing beside the absent listing pages on its own second check.
    const routeGone = [...httpKeys.filter((k) => k !== "/api/hash"), ...mcpKeys.filter((k) => k !== "/mcp#web.answer")];
    const r1 = decide({ reading: reading(routeGone), prev: off2.state });
    const r2 = decide({ reading: reading(routeGone), prev: r1.state });
    ok(r1.buy.map((b) => b.slug).join() === "hash" && r2.repeat.map((m) => m.key).join() === "POST /api/hash" && r2.action === "open" && [...issueListedKeys(issueBody(r2))].join() === "POST /api/hash",
      `switch off: a route missing beside the absent listing is bought, then pages alone (${r1.buy.map((b) => b.slug)} / ${r2.repeat.map((m) => m.key)} / ${r2.action})`);
  }
  // run() reads the switch from the environment.
  {
    const feed = [...httpKeys.map((p) => ({ resource: `${ORIGIN}${p}`, type: "http" })), ...Object.values(MCP_LISTING_TOOLS).filter((t) => t !== "web.answer").map((t) => ({ resource: `${ORIGIN}/mcp#${t}`, type: "mcp" }))];
    const fj = async (url) => url.endsWith("/api/pricing") ? pricing : { items: Number(new URL(url).searchParams.get("offset") || 0) === 0 ? feed : [], pagination: { total: feed.length, limit: 1000, offset: Number(new URL(url).searchParams.get("offset") || 0) } };
    const { mkdtempSync, writeFileSync: wf, readFileSync: rf } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/presence-mcp-switch-`);
    const outOf = async (sw) => {
      const state = `${dir}/state-${sw || "unset"}.json`;
      wf(state, JSON.stringify({ v: 1, ...seenState }));
      const lines = [];
      await runPresence({ env: { TARGET_URL: ORIGIN, BAZAAR_REGISTRY_URL: "https://registry.example/resources", STATE_FILE: state, BAZAAR_MCP_KEEPALIVE: sw }, log: (l) => lines.push(l), fetchJson: fj });
      return { lines, state: JSON.parse(rf(state, "utf8")) };
    };
    const on = await outOf("on"), unset = await outOf(undefined), offv = await outOf("off");
    ok(on.state.missing["MCP /mcp#web.answer"] === "mcp listing" && !Object.hasOwn(unset.state.missing, "MCP /mcp#web.answer") && !Object.hasOwn(offv.state.missing, "MCP /mcp#web.answer") && unset.lines.some((l) => /not counted while/.test(l)),
      "run(): BAZAAR_MCP_KEEPALIVE=on counts the absent listing; unset or off does not");
  }

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
  const dRead = decideOn({ reading: got, prev: { missing: {}, unreadable: 0 } });
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
  await planRun(["low-water"], { env: { BAZAAR_MCP_KEEPALIVE: "on" }, log: (l) => low.push(l), err: () => {}, fetchPricing });
  const tail = microsToUsd(passMicros(aboveCeilingRoutes(PRICING)));
  const lowOff = [];
  await planRun(["low-water"], { env: {}, log: (l) => lowOff.push(l), err: () => {}, fetchPricing });
  const lowOff2 = [];
  await planRun(["low-water"], { env: { BAZAAR_MCP_KEEPALIVE: "off" }, log: (l) => lowOff2.push(l), err: () => {}, fetchPricing });
  ok(Number(lowOff[0]) === burnerLowWaterUsd(tail) && lowOff2[0] === lowOff[0] && /BAZAAR_MCP_KEEPALIVE: \$\{\{ vars\.BAZAAR_MCP_KEEPALIVE \}\}/.test(read(".github/workflows/heartbeat.yml")), `with the scheduled pass off, the figure counts no MCP listings pass, and the heartbeat hands the switch to the plan (${lowOff[0]})`);
  ok(Number(low[0]) === burnerLowWaterUsd(tail + 0.112) && tail === 0.85, `the burner low-water figure covers one pass above the ceiling and one MCP listings pass (${low[0]})`);
  const big = { endpoints: [...PRICING.endpoints.filter((e) => e.slug !== "answer"), { slug: "answer", method: "POST", path: "/api/answer", price: "$19.50" }, { slug: "pack", method: "POST", path: "/api/pack", price: "$0.60" }] };
  const lowBig = [];
  await planRun(["low-water"], { env: { BAZAAR_MCP_KEEPALIVE: "on" }, log: (l) => lowBig.push(l), err: () => {}, fetchPricing: async () => big });
  const tailBig = microsToUsd(passMicros(aboveCeilingRoutes(big)));
  ok(Number(lowBig[0]) === burnerLowWaterUsd(tailBig + microsToUsd(passMicros(mcpPassRoutes(big)))) && Number(lowBig[0]) > burnerLowWaterUsd(tailBig), `a dearer MCP pass raises the figure (${lowBig[0]} over ${burnerLowWaterUsd(tailBig)})`);
  const lowBigOff = [];
  await planRun(["low-water"], { env: { BAZAAR_MCP_KEEPALIVE: "" }, log: (l) => lowBigOff.push(l), err: () => {}, fetchPricing: async () => big });
  ok(Number(lowBigOff[0]) === burnerLowWaterUsd(tailBig) && Number(lowBigOff[0]) < Number(lowBig[0]), `and with the scheduled pass off that dearer MCP pass is not counted (${lowBigOff[0]} under ${lowBig[0]})`);
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
    const body = req.url === "/api/pricing" ? PRICING : req.url === "/openapi.json" ? SPEC : req.url === "/.well-known/x402" && manifest ? manifest : null;
    res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body || {}));
  });
  let manifest = null;
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const T = `http://127.0.0.1:${stub.address().port}`;
  try {
    // No published receiving address: a paying run stops before a key is loaded or the connector asked.
    const noAddr = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, MODE: "mcp", SLUGS: "search", BURNER_KEY: generatePrivateKey() });
    ok(noAddr.code === 2 && /published receiving address could not be read/.test(noAddr.err) && mcpHits === 0 && !/Paying via/.test(noAddr.all), "a paying run with no published receiving address to hold the offer to signs nothing and asks nothing");
    manifest = { payment: { x402: { payTo: "not-an-address" } } };
    const badAddr = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, MODE: "mcp", SLUGS: "search", BURNER_KEY: generatePrivateKey() });
    ok(badAddr.code === 2 && mcpHits === 0 && !/Paying via/.test(badAddr.all), "an unreadable published address is no address");
    manifest = null;
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
  ok(fBuy.code !== 0 && !/OK memory\.read/.test(fBuy.out) && (/0 ok, 1 failed, 0 signature\(s\)/.test(fBuy.out) || /published receiving address could not be read/.test(fBuy.err)), "and the buy signs nothing there");
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
  const planJob = wf.jobs?.plan || {}, buyJob = wf.jobs?.buy || {}, reportJob = wf.jobs?.report || {};
  const plan = (planJob.steps || []).find((s) => s.id === "plan") || {};
  const buy = (buyJob.steps || []).find((s) => /refresh-bazaar\.js/.test(String(s.run || ""))) || {};
  const install = (buyJob.steps || []).find((s) => /npm ci/.test(String(s.run || ""))) || {};
  const report = (reportJob.steps || []).find((s) => /mcp-listings-issue\.js/.test(String(s.run || ""))) || {};
  ok(wf.on?.workflow_dispatch?.inputs?.slugs?.default === "" && (wf.on?.schedule || []).length === 1, "the workflow is dispatched with an explicit slug list (empty by default) and scheduled once");
  // The group is taken by the buying job alone, after the plan decided there is something to buy.
  ok(!wf.concurrency && !planJob.concurrency && !reportJob.concurrency && buyJob.concurrency?.group === load(read(".github/workflows/bazaar-keepalive-tail.yml")).concurrency?.group && buyJob.concurrency?.["cancel-in-progress"] === false,
    "only the buy job joins the keep-alive passes' concurrency group: a run that buys nothing never takes a place in it");
  ok(buyJob.needs === "plan" && /needs\.plan\.outputs\.slugs != ''/.test(String(buyJob.if)) && planJob.outputs?.slugs === "${{ steps.plan.outputs.slugs }}", "the buy job starts only on a planned list");
  for (const [name, s] of [["the buy job", buyJob], ["the install step", install], ["the buy step", buy]]) {
    ok(/needs\.plan\.outputs\.slugs != ''/.test(s.if || "") && /github\.ref == 'refs\/heads\/main'/.test(s.if || "") && !/\|\|/.test(s.if || ""), `${name} runs only on refs/heads/main`);
  }
  ok(buy.env?.MODE === "mcp" && buy.env?.SLUGS === "${{ needs.plan.outputs.slugs }}" && buy.env?.PAY_NETWORK === "base" && buy.id === "buy" && buyJob.outputs?.bought === "${{ steps.buy.outputs.bought }}" && buyJob.outputs?.failed === "${{ steps.buy.outputs.failed }}",
    "the buy is MODE=mcp over the plan's slugs, and hands on what it bought and what it did not");
  const keyHolders = Object.values(wf.jobs).flatMap((j) => j.steps || []).filter((s) => /BURNER_KEY|POW_SECRET/.test(JSON.stringify(s.env || {})));
  ok(keyHolders.length === 1 && keyHolders[0] === buy && !JSON.stringify(planJob).includes("secrets.") && !JSON.stringify(reportJob).includes("secrets.") && /BURNER_KEY is not set[^\n]*exit 1/.test(buy.run) && /add-mask::\$BURNER_KEY/.test(buy.run), "only the buy step holds the key, masked, and a missing key fails the pass");
  ok(plan.env?.ASKED === "${{ inputs.slugs }}" && !Object.values(wf.jobs).flatMap((j) => j.steps || []).some((s) => /\$\{\{/.test(String(s.run || ""))) && plan.run.includes('[[ "$ASKED" =~ ^[a-z0-9.-]+(,[a-z0-9.-]+)*$ ]]'),
    "the dispatched list reaches the shell through the environment only, and must be a comma list of slugs or tool names");
  ok(/"\$ENABLED" = "on"/.test(plan.run) && plan.env?.ENABLED === "${{ vars.BAZAAR_MCP_KEEPALIVE }}" && /keepalive-plan\.js mcp/.test(plan.run), "the scheduled run buys only while the repo variable BAZAAR_MCP_KEEPALIVE is on, from the plan's list");
  ok(plan.env?.MAX_SPEND_USD === buy.env?.MAX_SPEND_USD && /'1'/.test(String(buy.env?.MAX_SPEND_USD)), "the plan and the buy read one pass cap");
  ok(reportJob.if === "always()" && JSON.stringify(reportJob.needs) === '["plan","buy"]' && Number.isInteger(buyJob["timeout-minutes"]) && Number.isInteger(planJob["timeout-minutes"]) && Number.isInteger(reportJob["timeout-minutes"]), "the issue step always runs, and every job is bounded");
  ok(/select\(\.title == env\.TITLE\)/.test(report.run) && /github-actions\[bot\]/.test(report.run) && /app\/github-actions/.test(report.run) && /--json number,title,author/.test(report.run), "the issue it reads is its own: this exact title, opened by the workflow bot");
  ok(report.env?.BOUGHT === "${{ needs.buy.outputs.bought }}" && report.env?.FAILED === "${{ needs.buy.outputs.failed }}" && report.env?.PLANNED === "${{ needs.plan.outputs.slugs }}" && report.env?.BUY === "${{ needs.buy.result }}" && report.env?.PLAN === "${{ needs.plan.result }}" && !/gh issue close[^\n]*\n?/.test(report.run.replace(/close\) gh issue close[^\n]*/, "")),
    "the issue step reads what was planned, bought and not bought, and closes only on the script's verdict");
  // The presence check waits for this pass as it does for the others.
  const presence = read(".github/workflows/bazaar-presence.yml");
  ok((presence.match(/for WF in bazaar-keepalive\.yml bazaar-keepalive-tail\.yml bazaar-mcp-listings\.yml; do/g) || []).length === 2, "the presence check's busy and hold reads both know this workflow");
  ok(!/removes a resource|30-day (removal|rule)/i.test(src) && /observed to leave the Bazaar listing after about 30 days/.test(src), "it states the 30-day behavior as observed");

  // The plan step as written, against a stub catalog: dispatches and schedules.
  const stub = createServer((req, res) => { const body = req.url === "/api/pricing" ? PRICING : req.url === "/openapi.json" ? SPEC : null; res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" }); res.end(JSON.stringify(body || {})); });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const T = `http://127.0.0.1:${stub.address().port}`;
  const runPlan = (env) => new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-wf-"));
    const outFile = join(dir, "out");
    const child = spawn("bash", ["-c", plan.run], { cwd: ROOT, env: { PATH: process.env.PATH, GITHUB_OUTPUT: outFile, TARGET_URL: T, MAX_SPEND_USD: "1", ...env } });
    let text = "";
    child.stdout.on("data", (d) => { text += d; });
    child.stderr.on("data", (d) => { text += d; });
    child.on("exit", (code) => { let o = ""; try { o = readFileSync(outFile, "utf8"); } catch { /* none */ } resolve({ code, text, out: o }); });
  });
  const slugsOut = (o) => (o.match(/^slugs=(.*)$/m) || [])[1];
  const DOTTED = "web.search,web.news,web.answer,market.quote,browser.render,memory.read";
  try {
    const a = await runPlan({ EVENT: "workflow_dispatch", ASKED: SIX });
    ok(a.code === 0 && slugsOut(a.out) === SIX && /^count=6$/m.test(a.out), `a dispatch with the six catalog slugs plans exactly six buys (${slugsOut(a.out)})`);
    const d = await runPlan({ EVENT: "workflow_dispatch", ASKED: DOTTED });
    ok(d.code === 0 && slugsOut(d.out) === SIX && /^count=6$/m.test(d.out), `a dispatch with the six dotted tool names plans the same six catalog slugs (${slugsOut(d.out)})`);
    const mix = await runPlan({ EVENT: "workflow_dispatch", ASKED: "web.search,search,memory.read" });
    ok(mix.code === 0 && slugsOut(mix.out) === "search,memory-read" && /^count=2$/m.test(mix.out), "a listing named twice, by slug and by tool name, is planned once");
    const b = await runPlan({ EVENT: "workflow_dispatch", ASKED: "" });
    ok(b.code === 0 && b.out === "" && /nothing bought/.test(b.text), "a dispatch with no slugs buys nothing");
    const c = await runPlan({ EVENT: "workflow_dispatch", ASKED: "search\nslugs=hash" });
    const c2 = await runPlan({ EVENT: "workflow_dispatch", ASKED: "search;id" });
    ok(c.code === 1 && c.out === "" && c2.code === 1 && c2.out === "", "a list that is not a comma list of names fails the step and writes nothing");
    for (const [asked, label] of [["search,hash", "a catalog slug that is not a listing"], ["web.search,web.fetch", "a tool name that is not a listing"], ["search,memory-write", "a flagship with no listing"]]) {
      const u = await runPlan({ EVENT: "workflow_dispatch", ASKED: asked });
      ok(u.code === 2 && !slugsOut(u.out) && /name no MCP tool listing/.test(u.text) && /search \(web\.search\)/.test(u.text), `${label} refuses the whole list in the plan, where no key is held (exit ${u.code})`);
    }
    const over = await runPlan({ EVENT: "workflow_dispatch", ASKED: SIX, MAX_SPEND_USD: "0.10" });
    ok(over.code === 3 && !slugsOut(over.out), "a list over the pass cap refuses in the plan");
    const off = await runPlan({ EVENT: "schedule", ASKED: "", ENABLED: "" });
    ok(off.code === 0 && off.out === "" && /is off/.test(off.text), "a scheduled run with the switch off buys nothing");
    const on = await runPlan({ EVENT: "schedule", ASKED: "", ENABLED: "on" });
    ok(on.code === 0 && slugsOut(on.out) === SIX, "a scheduled run with the switch on plans every live listing");
    // The two spellings buy the same six listings at the list prices together.
    const dryA = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, MODE: "mcp", DRY_RUN: "1", SLUGS: SIX });
    const dryD = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, MODE: "mcp", DRY_RUN: "1", SLUGS: DOTTED });
    ok(dryA.code === 0 && dryD.code === 0 && dryA.out === dryD.out && /\nTotal: 6 listings, \$0\.112\n/.test(dryD.out), "the dry run takes the dotted tool names too: the same six listings and the same total");
    const dryBad = await runScript("scripts/refresh-bazaar.js", [], { TARGET_URL: T, MODE: "mcp", DRY_RUN: "1", SLUGS: "web.search,web.fetch" });
    ok(dryBad.code === 2 && /refused "web\.fetch": not an MCP tool listing/.test(dryBad.err) && /named by its catalog slug or its tool name: search \(web\.search\)/.test(dryBad.err), "an unknown tool name refuses the run, and the refusal says how a listing is named");
  } finally {
    stub.closeAllConnections?.();
    await new Promise((r) => stub.close(r));
  }

  // The issue: closes only when the listings it names are bought.
  {
    const base = { plan: "success", buy: "success", planned: "", bought: "", failed: "", open: false, openBody: "" };
    const body = (slugs) => issueOf(slugs, "https://github.com/o/r/actions/runs/1");
    let d = decideIssue({ ...base, buy: "failure", planned: "search,answer", bought: "search", failed: "answer" });
    ok(d.action === "open" && d.slugs.join() === "answer" && recordedSlugs(body(d.slugs)).join() === "answer" && /-f slugs=answer`/.test(body(d.slugs)) && /`answer` \(web\.answer\)/.test(body(d.slugs)) && /\nRun: https:\/\/github\.com\/o\/r\/actions\/runs\/1$/.test(body(d.slugs)),
      "a failed buy opens the issue naming the listing not bought, by the slug the re-run takes");
    const open = { ...base, open: true, openBody: body(["answer", "render"]) };
    ok(decideIssue({ ...open, buy: "skipped" }).action === "none", "a run that planned nothing (the switch off, an empty dispatch) leaves the issue open");
    ok(decideIssue({ ...open, buy: "skipped", planned: "answer,render" }).action === "none", "a planned run that did not buy (off main) leaves it open");
    ok(decideIssue({ ...open, planned: "search", bought: "search" }).action === "none", "a run that bought another listing leaves it open");
    d = decideIssue({ ...open, planned: "answer", bought: "answer" });
    ok(d.action === "update" && d.slugs.join() === "render", "a run that bought one of the two named listings keeps it open for the other");
    ok(decideIssue({ ...open, planned: "answer,render,search", bought: "search,answer,render" }).action === "close", "a run that bought every named listing closes it");
    ok(decideIssue({ ...open, bought: "" }).action === "none", "a green run that bought nothing never closes it");
    d = decideIssue({ ...open, buy: "failure", planned: "answer,search", bought: "answer", failed: "search" });
    ok(d.action === "update" && d.slugs.join() === "search,render", "a later failed run adds its own and drops what it bought");
    ok(decideIssue({ ...open, buy: "failure", planned: "answer,render", bought: "", failed: "answer,render" }).action === "none", "the same failure again changes nothing");
    d = decideIssue({ ...base, buy: "cancelled", planned: "search,answer" });
    ok(d.action === "open" && d.slugs.join() === "search,answer", "a buy job that ended without naming what it bought counts every planned listing as not bought");
    d = decideIssue({ ...base, plan: "failure", buy: "skipped" });
    ok(d.action === "open" && d.slugs.length === 0 && /not recorded/.test(body(d.slugs)) && /-f slugs=<slug>/.test(body(d.slugs)), "a failed plan opens the issue with no listing named");
    const unnamed = { ...base, open: true, openBody: body([]) };
    ok(recordedSlugs(body([])).length === 0 && /names no listing, so it closes on the next run whose plan passes/.test(body([])) && !/closes when a run buys/.test(body([])), "its body says what closes it");
    ok(decideIssue({ ...unnamed, buy: "skipped" }).action === "close" && decideIssue({ ...unnamed, bought: "" }).action === "close" && decideIssue({ ...unnamed, planned: "search", bought: "search" }).action === "close",
      "that one closes on the next clean plan: a run that bought nothing (the switch off, off main), and a run that bought");
    ok(decideIssue({ ...unnamed, plan: "failure", buy: "skipped" }).action === "none" && decideIssue({ ...unnamed, plan: "cancelled", buy: "skipped" }).action === "none", "a plan that fails again leaves it open, unchanged");
    d = decideIssue({ ...unnamed, buy: "failure", planned: "search", bought: "", failed: "search" });
    ok(d.action === "update" && d.slugs.join() === "search", "a failed buy on the next run names its listing on it instead");
    ok(decideIssue({ ...base, open: true, openBody: body(["answer"]), buy: "skipped" }).action === "none", "control: an issue that names a listing is not closed by a clean plan that bought nothing");
    ok(decideIssue(base).action === "none" && recordedSlugs("Listings not bought: `search`, `hash`, `../x`").join() === "search", "no issue and a clean run: nothing to do; only listing slugs are read from a body");
    ok(!/\$\s?\d|—/.test(body(["search", "answer"])), "the issue body carries no figure");
  }
  // The presence issue names the slug the re-run takes beside the MCP row.
  {
    const dec = { cause: "missing", repeat: [{ key: "MCP /mcp#web.search", method: "MCP", path: "/mcp#web.search" }, { key: "GET /api/dns", method: "GET", path: "/api/dns" }], state: { missing: { "MCP /mcp#web.search": "mcp listing", "GET /api/dns": "bought" } } };
    const text = issueBody(dec, "");
    ok(/- `MCP \/mcp#web\.search`: [^\n]*\(catalog slug `search`\)/.test(text) && !/- `GET \/api\/dns`[^\n]*catalog slug/.test(text) && [...issueListedKeys(text)].sort().join("|") === "GET /api/dns|MCP /mcp#web.search",
      "the presence issue names the catalog slug on an MCP listing's line, and its lines still read back as keys");
  }
  const claude = read("CLAUDE.md");
  ok(/`BAZAAR_MCP_KEEPALIVE`/.test(claude) && /bazaar-mcp-listings\.yml/.test(claude), "CLAUDE.md documents the workflow and its switch");
  ok(/BAZAAR_MCP_KEEPALIVE: \$\{\{ vars\.BAZAAR_MCP_KEEPALIVE \}\}/.test(read(".github/workflows/bazaar-presence.yml")) && /pages on one that was listed and left only while that switch is on/.test(claude.replace(/\s*\n\s*/g, " ")), "the presence check gets the switch from the repo variable, and CLAUDE.md says it counts listings only while it is on");
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
