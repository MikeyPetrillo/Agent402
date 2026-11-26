#!/usr/bin/env node
// The hosted connector's internal x402 twins of six flagships
// (src/mcp-x402-routes.js).
//
//   node scripts/test-mcp-x402-routes.js
//
// Module half, offline: the twin set, the flag only the gate sets, the
// idempotency binding that keeps a twin's answers apart from the HTTP
// route's, and the arrival path a twin's sale books.
// Booted half: the REAL server in paid mode on three rails (Base, Optimism
// with a premium, Robinhood Chain with its floor) against a stub facilitator
// that counts /verify and /settle:
//   - a twin answers the app's ordinary 404 without the loopback marker, with
//     a wrong secret, on another method, and for a slug with no twin;
//   - its 402 names the resource <BASE_URL>/mcp and carries a Bazaar
//     extension of type mcp (tool name, input schema, example arguments,
//     transport streamable-http) that the protocol's validators accept;
//   - every accept of every twin equals the HTTP route's, on every chain;
//   - a payment that echoes the twin's extension settles once and answers
//     200, booked on the arrival path x402-mcp;
//   - one payment is never spent on both: the HTTP route's payment resent to
//     the twin, and the twin's resent to the HTTP route, are refused unsettled;
//   - an error answer on a twin is not settled;
//   - a twin asked to respond-async answers in the request (402 unpaid);
//   - a twin's late settlement books the tool's catalog slug, not "mcp";
//   - no catalog surface names a twin.
// Restore leg: a chain whose facilitator fails its first /supported read is
// offered again by the twin once it answers, as by the HTTP route.
// Module half also: a flagged request the twins' paywall does not price runs
// the HTTP route's paywall (never on unpaid); a late settlement and a Gateway
// pending booking of a twin name the tool, not the connector.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/file-mode.js";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { validateDiscoveryExtension, validateDiscoveryExtensionSpec, extractDiscoveryInfoFromExtension } from "@x402/extensions/bazaar";
import { bootServer } from "./lib/boot-server.js";

const SECRET = (process.env.MCP_LOOPBACK_TEST_SECRET = "3c".repeat(24));
const MARKER = { "x-agent402-via": `mcp;k=${SECRET}` };
const twins = await import("../src/mcp-x402-routes.js");
const { salePathOf } = await import("../src/sale-path.js");
const { createIdempotency } = await import("../src/idempotency.js");
const { FLAGSHIP_MCP_NAMES } = await import("../src/mcp-flagship.js");
const { STOCK_SLUGS, stockToolServed } = await import("../src/tools/stock-provider.js");
const { lateSettleCandidate, createLateSettleBook } = await import("../src/late-settlements.js");
const { createAsyncJobs } = await import("../src/async-jobs.js");
const { x402HTTPResourceServer, x402ResourceServer } = await import("@x402/core/server");

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- module half ------------------------------------------------------------------
{
  ok(same([...twins.MCP_X402_SLUGS].sort(), ["memory-read", "pdf-to-markdown", "render", "stock-quote", "us-macro-series", "weather-current"]), "six flagships have a twin");
  ok(!twins.MCP_X402_SLUGS.some((s) => ["search", "search-news", "answer"].includes(s)) && twins.mcpX402SlugOfToolName("web.search") === null, "the former flagships have no twin, by slug or by their old names");
  ok(FLAGSHIP_MCP_NAMES.render === "browser.render" && FLAGSHIP_MCP_NAMES["memory-read"] === "memory.read", "render is browser.render and memory-read is memory.read");
  const fakeCatalog = {
    "GET /api/memory": { slug: "memory-read", price: "$0.001", discovery: { input: {}, inputSchema: { properties: { key: { type: "string" } } } } },
    "POST /api/render": { slug: "render", price: "$0.01", discovery: { input: { url: "https://example.com" }, inputSchema: { properties: { url: { type: "string" } }, required: ["url"] } } },
    "GET /api/weather-current": { slug: "weather-current", price: "$0.01", quote: () => 0.01 },
    "GET /api/uuid": { slug: "uuid", price: "$0.001" },
  };
  const entries = twins.mcpX402Entries(fakeCatalog);
  ok(same(entries.map((e) => `${e.toolName} ${e.route}`), ["browser.render POST /api/render", "memory.read GET /api/memory"]), "twins come from the catalog, fixed-price flagships only");
  const ext = twins.mcpX402DiscoveryExtension(entries[0]).bazaar;
  ok(ext?.info?.input?.type === "mcp" && ext.info.input.toolName === "browser.render" && ext.info.input.transport === "streamable-http"
    && same(ext.info.input.example, { url: "https://example.com" }) && ext.info.input.inputSchema?.type === "object", "the declared extension names the tool, transport, schema and example");
  ok(validateDiscoveryExtension(ext).valid && validateDiscoveryExtensionSpec(ext).valid, "the protocol's validators accept it");
  // The Bazaar calls an MCP tool with its example as the arguments, and an
  // empty example is not indexed: memory-read's route publishes {} (list
  // mode), so its twin lists the key memory-write's example writes.
  const memExt = twins.mcpX402DiscoveryExtension(entries[1]).bazaar;
  ok(entries[1].slug === "memory-read" && same(memExt?.info?.input?.example, { key: "research/task-42" }) && validateDiscoveryExtension(memExt).valid,
    "a twin whose route publishes an empty example lists arguments the Bazaar can call it with");
  ok(twins.mcpX402Example({ slug: "uuid", discovery: { input: {} } }) === undefined && same(twins.mcpX402Example({ slug: "memory-read", discovery: { input: { key: "k" } } }), { key: "k" }),
    "a published example with an argument is kept; an empty one with no fallback lists none");

  const gate = twins.createMcpX402Gate({ getCatalog: () => fakeCatalog });
  const reqOf = (url, { method = "GET", headers = {}, addr = "127.0.0.1" } = {}) => {
    const r = { url, method, headers: { ...headers }, socket: { remoteAddress: addr } };
    Object.defineProperty(r, "path", { get() { return this.url.split("?")[0]; } });
    return r;
  };
  const run = (r) => { let called = false; gate(r, {}, () => { called = true; }); return called; };
  const genuine = reqOf("/__mcp-x402/memory-read?key=a", { headers: { ...MARKER, authorization: "Bearer a402_x", "x-pow-solution": "s" } });
  run(genuine);
  ok(genuine.url === "/api/memory?key=a" && twins.isX402McpRequest(genuine), "a marked loopback request is rewritten to the tool's path and flagged");
  ok(!("authorization" in genuine.headers) && !("x-pow-solution" in genuine.headers), "another gate's credential is removed from it");
  ok(salePathOf(genuine) === "x402-mcp", "its sale books x402-mcp");
  for (const [label, r] of [
    ["no marker", reqOf("/__mcp-x402/memory-read")],
    ["a wrong secret", reqOf("/__mcp-x402/memory-read", { headers: { "x-agent402-via": `mcp;k=${"00".repeat(24)}` } })],
    ["a remote socket", reqOf("/__mcp-x402/memory-read", { headers: MARKER, addr: "203.0.113.9" })],
    ["another method", reqOf("/__mcp-x402/memory-read", { method: "POST", headers: MARKER })],
    ["a slug with no twin", reqOf("/__mcp-x402/uuid", { headers: MARKER })],
  ]) {
    run(r);
    ok(r.url.startsWith("/__mcp-x402/") && !twins.isX402McpRequest(r), `${label}: passed on unchanged and unflagged`);
  }
  const forged = reqOf("/api/memory", { headers: { "x-agent402-via": "x402-mcp", "user-agent": "x402-mcp" } });
  forged.__x402Mcp = true;
  run(forged);
  ok(!twins.isX402McpRequest(forged) && salePathOf(forged) === "http", "no header or property a caller sets marks a request x402-mcp");

  // respond-async never reaches the job runner from a twin.
  for (const [prefer, left] of [["respond-async", undefined], ["respond-async, wait=5", "wait=5"], ["wait=5,respond-async", "wait=5"], ["handling=lenient", "handling=lenient"]]) {
    const r = reqOf("/__mcp-x402/render", { method: "POST", headers: { ...MARKER, prefer } });
    run(r);
    ok(twins.isX402McpRequest(r) && r.headers.prefer === left, `Prefer "${prefer}" on a twin reads ${JSON.stringify(r.headers.prefer)}`);
  }
  const httpAsync = reqOf("/api/render", { method: "POST", headers: { prefer: "respond-async" } });
  run(httpAsync);
  ok(httpAsync.headers.prefer === "respond-async", "control: the HTTP route keeps its respond-async preference");

  // The job runner, given a twin's route as async (no twin is today): a paid
  // twin request asking respond-async is never taken as a job (its replay
  // would reach the twin's path without the marker); the HTTP route's is.
  {
    let created = 0;
    const jobs = createAsyncJobs({ port: 1, log: () => {}, asyncRouteOf: () => ({ slug: "render", price: "$0.01", asyncProfile: { slow: false, expectedSeconds: null, maxSeconds: 60 } }),
      store: { atCapacity: () => false, create: async () => { created++; return null; } } });
    const payAttempt = { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: { authorization: { from: "0x00000000000000000000000000000000000a0003", nonce: "0x" + "cd".repeat(32) } } })).toString("base64") };
    const asyncReq = (twin) => {
      const r = reqOf(twin ? "/__mcp-x402/render" : "/api/render", { method: "POST", headers: { ...(twin ? MARKER : {}), ...payAttempt, prefer: "respond-async", "content-type": "application/json" } });
      r.originalUrl = r.url; r.body = { url: "https://example.com" }; r.ip = "127.0.0.1";
      if (twin) run(r);
      return r;
    };
    const resOf = () => ({ code: 0, status(c) { this.code = c; return this; }, set() { return this; }, json() { return this; } });
    let passed = false;
    await jobs.middleware(asyncReq(true), resOf(), () => { passed = true; });
    ok(passed && created === 0, `a paid twin request asking respond-async runs in the request, no job (${created})`);
    passed = false;
    await jobs.middleware(asyncReq(false), resOf(), () => { passed = true; });
    ok(!passed && created === 1, `control: the HTTP route's is taken as a job (${created})`);
  }

  // The paywall dispatch: a flagged request the twins' paywall does not price
  // runs the HTTP route's paywall, never passed on unpaid.
  {
    const priced = new x402HTTPResourceServer(new x402ResourceServer([]), { "POST /api/render": { accepts: [], description: "d" } });
    const knows = twins.mcpX402Knows(priced);
    const calls = [];
    const main = (_q, _s, _n) => calls.push("main");
    const mcp = (_q, _s, _n) => calls.push("mcp");
    const mw = twins.mcpX402Dispatch({ main, mcp, knows });
    const flaggedOf = (url, method) => { const r = reqOf(url, { method, headers: MARKER }); run(r); return r; };
    const known = flaggedOf("/__mcp-x402/render", "POST");
    const unknown = flaggedOf("/__mcp-x402/memory-read", "GET");
    ok(twins.isX402McpRequest(known) && twins.isX402McpRequest(unknown), "both requests are flagged twins");
    for (const [label, r, want] of [["a flagged request the twins' paywall prices", known, "mcp"], ["a flagged request it does not price", unknown, "main"], ["an unflagged request", reqOf("/api/render", { method: "POST" }), "main"]]) {
      calls.length = 0;
      mw(r, {}, () => calls.push("next"));
      ok(calls.join() === want, `${label} runs the ${want === "mcp" ? "twins'" : "HTTP route's"} paywall (${calls.join()})`);
    }
    calls.length = 0;
    twins.mcpX402Dispatch({ main, mcp, knows: () => { throw new Error("x"); } })(known, {}, () => calls.push("next"));
    ok(calls.join() === "main", "a pricing read that throws runs the HTTP route's paywall");
    ok(twins.mcpX402Dispatch({ main, mcp: null, knows }) === main, "with no twins' paywall every request runs the HTTP route's");
  }

  // A twin's late settlement books the catalog slug, not "mcp".
  {
    const twinReq = reqOf("/__mcp-x402/memory-read", { headers: MARKER });
    run(twinReq);
    const tx = `0x${"77".repeat(32)}`;
    const ctxOf = (req, ext) => ({
      requirements: { network: "eip155:8453", payTo: "0x000000000000000000000000000000000000dEaD", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000" },
      paymentPayload: { resource: { url: "https://agent402.tools/mcp" }, ...(ext ? { extensions: ext } : {}), payload: { authorization: { from: "0x00000000000000000000000000000000000a0002", validBefore: "9999999999", nonce: `0x${"12".repeat(32)}` } } },
      error: { transaction: tx },
      ...(req ? { transportContext: { request: { adapter: { req } } } } : {}),
    });
    ok(lateSettleCandidate(ctxOf(twinReq))?.slug === "memory-read", `a twin's candidate carries its slug (${lateSettleCandidate(ctxOf(twinReq))?.slug})`);
    ok(lateSettleCandidate(ctxOf(null, { bazaar: { info: { input: { type: "mcp", toolName: "pdf.markdown" } } } }))?.slug === "pdf-to-markdown", "with no request, the /mcp resource's tool name maps to its slug");
    ok(lateSettleCandidate(ctxOf(null))?.slug === undefined, "with neither, no slug is claimed (the book reads the URL)");
    const dir = mkdtempSync(join(tmpdir(), "mcp-x402-late-"));
    try {
      const book = createLateSettleBook({ file: join(dir, "late.json"), log: () => {}, rpcFor: () => "http://127.0.0.1:9/rpc", fetchImpl: async () => { throw new Error("offline"); } });
      await book.book(lateSettleCandidate(ctxOf(twinReq)));
      const plain = lateSettleCandidate({ ...ctxOf(null), error: { transaction: `0x${"78".repeat(32)}` } });
      await book.book(plain);
      const open = (await book.operatorView()).open || [];
      const slugs = open.map((e) => e.slug).sort();
      ok(same(slugs, ["mcp", "memory-read"]), `the book keeps the twin's slug memory-read beside a URL-read one (${slugs.join(", ")})`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // Idempotency: one payment on the twin and on the HTTP route are two keys.
  const keys = [];
  const store = { get: async (k) => { keys.push(k); return null; }, claim: async () => true, set: async () => {}, release: async () => {}, renew: async () => {} };
  const idem = createIdempotency({ isCatalogRoute: () => true, store, implicitReplay: () => true });
  const pay = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: "eip155:8453" }, payload: { authorization: { from: "0x00000000000000000000000000000000000a0001", nonce: "0x" + "ab".repeat(32) } } })).toString("base64");
  const paidReq = (twin) => {
    const r = reqOf(twin ? "/__mcp-x402/memory-read" : "/api/memory", { headers: twin ? { ...MARKER, "payment-signature": pay } : { "payment-signature": pay } });
    r.header = (n) => r.headers[String(n).toLowerCase()];
    r.originalUrl = r.url;
    if (twin) run(r);
    return r;
  };
  const res = { on() {}, once() {}, setHeader() {}, getHeader() {}, json() {}, send() {}, end() {}, write() {}, writeHead() {}, status() { return this; } };
  await idem(paidReq(false), res, () => {});
  await idem(paidReq(true), res, () => {});
  // Each request also reads the payment's unconfirmed-settle answer, keyed on
  // the payment header alone (src/idempotency.js): one authorization is one
  // payment on any route, so that key is the same on both.
  ok(keys.length === 4 && keys[1] !== keys[3] && keys[0] === keys[2] && keys[0] !== keys[1], `the same payment on the twin and the HTTP route reads two idempotency keys, and one shared unconfirmed-settle key (${keys.length} reads)`);
}

// ---- booted half -------------------------------------------------------------------
const BASE_NET = "eip155:8453", OP = "eip155:10", RH = "eip155:4663";
const TMP = mkdtempSync(join(tmpdir(), "mcp-x402-"));
const SALES_DB = join(TMP, "sales.db");
const counts = { verify: 0, settle: 0 };
// Set: the next settle fails naming this transaction (a late settlement).
let settleFailTx = null;
const OP_TOKEN = "op-" + "5d".repeat(16);
let txN = 0;
const facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [BASE_NET, OP, RH].map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: {} });
    // An unreadable chain read: the local funding preflight steps aside.
    if (req.url === "/rpc") return reply({ jsonrpc: "2.0", id: 1, result: "0x0" });
    let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") { counts.verify++; return reply({ isValid: true, payer }); }
    if (req.url === "/settle" && settleFailTx) { counts.settle++; const transaction = settleFailTx; settleFailTx = null; return reply({ success: false, errorReason: "transaction_failed", transaction, network: parsed.paymentRequirements?.network || BASE_NET, payer }); }
    if (req.url === "/settle") { counts.settle++; return reply({ success: true, transaction: `0x${(++txN).toString(16).padStart(64, "0")}`, network: parsed.paymentRequirements?.network || BASE_NET, payer }); }
    reply({});
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;
let srv = null;
try {
  srv = await bootServer({
    stores: "mcp-x402",
    // Nothing leaves this host: every facilitator is the stub below.
    args: ["--import", "./scripts/lib/loopback-only-preload.js"],
    env: {
      FREE_MODE: "", NODE_ENV: "test", MCP_LOOPBACK_TEST_SECRET: SECRET, BASE_URL: "https://agent402.tools",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base,optimism,robinhood",
      FACILITATOR_URL: FAC, PAYAI_FACILITATOR_URL: FAC, ROBINHOOD_FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, FACILITATOR_GAS_CHECK: "off",
      NETWORK_PRICE_PREMIUMS: `${OP}=0.001`,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "test-key", SOLVADOR_FACILITATOR_URL: FAC,
      MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", CIRCLE_FACILITATOR_API_KEY: "", ROBINHOOD_RELAYER_KEY: "", POSTHOG_API_KEY: "",
      REDIS_URL: "", STATE_DATABASE_URL: "", TARGET_URL: "",
      // An active stock provider: stock-quote's twin still follows the stock
      // switch (stockToolServed), which serves stock-history alone. The
      // loopback preload keeps any read on this host.
      STOCK_DATA_PROVIDER: "databento", DATABENTO_API_KEY: "db-test-key-not-real", DATABENTO_WARM: "off",
      STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
      MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off",
      SALES_LEDGER_DB: SALES_DB, REFUND_DB_DIR: TMP, HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
      AGENT402_OPERATOR_TOKEN: OP_TOKEN, EVM_RPC_8453: `${FAC}/rpc`,
    },
  });
  const B = srv.url;
  const decode = (r) => JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8"));
  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  ok(same([...(pricing.payment?.networks || [])].sort(), ["base", "optimism", "robinhood"]), `the boot offers three rails (${JSON.stringify(pricing.payment?.networks)})`);
  const routeOf = Object.fromEntries((pricing.endpoints || []).map((e) => [e.slug, e]));

  // 404 without the secret, the same 404 an unregistered path answers.
  const plain404 = await fetch(`${B}/__mcp-x402-none/memory-read`);
  const plainBody = (await plain404.text()).replaceAll("/__mcp-x402-none/memory-read", "<path>");
  for (const [label, url, init] of [
    ["no marker", "/__mcp-x402/memory-read", {}],
    ["a wrong secret", "/__mcp-x402/memory-read", { headers: { "x-agent402-via": `mcp;k=${"00".repeat(24)}` } }],
    ["a marker without the secret", "/__mcp-x402/weather-current?lat=1&lon=2", { headers: { "x-agent402-via": "mcp" } }],
    ["another method", "/__mcp-x402/memory-read", { method: "POST", headers: { ...MARKER, "content-type": "application/json" }, body: "{}" }],
    ["a slug with no twin", "/__mcp-x402/uuid", { headers: MARKER }],
  ]) {
    const r = await fetch(`${B}${url}`, init);
    const body = (await r.text()).replaceAll(url.split("?")[0], "<path>");
    ok(r.status === 404 && plain404.status === 404 && body === plainBody && !r.headers.get("payment-required"), `${label}: the ordinary 404 (${r.status})`);
  }

  // Every twin: resource /mcp, a valid MCP extension, the HTTP route's accepts.
  // The twins served are the flagships the stock switch serves on this boot's
  // env: stock-quote (market.quote) is off whatever the provider says.
  const BOOT_STOCK_ENV = { STOCK_DATA_PROVIDER: "databento", DATABENTO_API_KEY: "db-test-key-not-real" };
  const expected = twins.MCP_X402_SLUGS.filter((s) => !STOCK_SLUGS.has(s) || stockToolServed(s, BOOT_STOCK_ENV));
  const present = twins.MCP_X402_SLUGS.filter((s) => routeOf[s]);
  ok(same(present, expected) && !present.includes("stock-quote"), `every twin the switch serves is served on this boot, and no other (${present.join(", ")})`);
  for (const slug of twins.MCP_X402_SLUGS.filter((s) => !expected.includes(s))) {
    const r = await fetch(`${B}/__mcp-x402/${slug}?symbol=AAPL`, { headers: MARKER });
    ok(r.status !== 402 && !r.headers.get("payment-required"), `${slug}: a twin the switch does not serve offers no payment (${r.status})`);
  }
  for (const slug of present) {
    const e = routeOf[slug];
    const method = String(e.method || "GET").toUpperCase();
    const body = method === "POST" ? "{}" : undefined;
    const hdr = method === "POST" ? { "content-type": "application/json" } : {};
    const httpR = await fetch(`${B}${e.path}`, { method, headers: hdr, body });
    const mcpR = await fetch(`${B}/__mcp-x402/${slug}`, { method, headers: { ...hdr, ...MARKER }, body });
    ok(httpR.status === 402 && mcpR.status === 402, `${slug}: both answer 402 unpaid (${httpR.status}, ${mcpR.status})`);
    if (httpR.status !== 402 || mcpR.status !== 402) continue;
    const h = decode(httpR), m = decode(mcpR);
    ok(m.resource?.url === "https://agent402.tools/mcp" && h.resource.url === `https://agent402.tools${e.path}`, `${slug}: the twin's resource is ${m.resource?.url}, the route's ${h.resource?.url}`);
    const bz = m.extensions?.bazaar;
    const info = bz && extractDiscoveryInfoFromExtension(bz, true);
    ok(bz?.info?.input?.type === "mcp" && bz.info.input.toolName === FLAGSHIP_MCP_NAMES[slug] && bz.info.input.transport === "streamable-http"
      && bz.info.input.inputSchema?.type === "object" && bz.info.input.example && typeof bz.info.input.example === "object" && Object.keys(bz.info.input.example).length > 0 && !("method" in bz.info.input),
    `${slug}: an MCP extension for ${FLAGSHIP_MCP_NAMES[slug]} with schema, a non-empty example and transport`);
    ok(validateDiscoveryExtension(bz).valid && validateDiscoveryExtensionSpec(bz).valid && info?.input?.type === "mcp", `${slug}: the protocol's validators accept the twin's extension`);
    ok(same(m.accepts, h.accepts) && m.accepts.length >= 3, `${slug}: every accept equals the HTTP route's (${m.accepts.length} accepts)`);
    ok(same([...new Set(m.accepts.map((a) => a.network))].sort(), [BASE_NET, OP, RH].sort()), `${slug}: priced on every offered chain`);
    const premium = m.accepts.find((a) => a.network === OP && a.scheme === "exact"), plain = m.accepts.find((a) => a.network === BASE_NET && a.scheme === "exact");
    ok(premium && plain && Number(premium.amount) === Number(plain.amount) + 1000, `${slug}: the chain premium applies on the twin as on the route (${plain?.amount} / ${premium?.amount})`);
    ok(m.extensions?.["payment-identifier"] !== undefined && same(m.extensions["payment-identifier"], h.extensions?.["payment-identifier"]), `${slug}: the payment-identifier declaration is the route's`);
    ok(Buffer.byteLength(mcpR.headers.get("payment-required")) < 8000, `${slug}: the twin's challenge header stays under 8 KB (${Buffer.byteLength(mcpR.headers.get("payment-required"))})`);
  }

  // Paying: memory.read answers offline (the payer's own empty namespace).
  const twinChallenge = decode(await fetch(`${B}/__mcp-x402/memory-read`, { headers: MARKER }));
  const httpChallenge = decode(await fetch(`${B}/api/memory`));
  const pick = (c) => c.accepts.find((a) => a.network === BASE_NET && a.scheme === "exact");
  // memory.read is identity-bound: the payer is the EIP-3009 signer, so each
  // payment is signed for real (the stub facilitator then accepts it).
  const TYPES = { TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ] };
  const credential = async (challenge, account, { echo = false } = {}) => {
    const accepted = pick(challenge);
    const t = Math.floor(Date.now() / 1000);
    const authorization = { from: account.address, to: accepted.payTo, value: String(accepted.amount), validAfter: String(t - 600), validBefore: String(t + 300), nonce: `0x${randomBytes(32).toString("hex")}` };
    const signature = await account.signTypedData({
      domain: { name: accepted.extra.name, version: accepted.extra.version, chainId: Number(accepted.network.split(":")[1]), verifyingContract: accepted.asset },
      types: TYPES, primaryType: "TransferWithAuthorization",
      message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
    });
    return Buffer.from(JSON.stringify({
      x402Version: 2, resource: challenge.resource, accepted,
      ...(echo ? { extensions: challenge.extensions } : {}),
      payload: { signature, authorization },
    })).toString("base64");
  };
  const onTwin = (cred, q = "") => fetch(`${B}/__mcp-x402/memory-read${q}`, { headers: { ...MARKER, "payment-signature": cred } });
  const onHttp = (cred, q = "") => fetch(`${B}/api/memory${q}`, { headers: { "payment-signature": cred } });
  const [A1, A2, A3] = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));
  const [P1, P2] = [A1, A2].map((a) => a.address.toLowerCase());

  const s0 = counts.settle;
  const c1 = await credential(twinChallenge, A1, { echo: true });
  const r1 = await onTwin(c1);
  const r1body = await r1.text();
  ok(r1.status === 200 && counts.settle === s0 + 1 && !!r1.headers.get("payment-response"), `a payment echoing the twin's extension settles once and answers 200 (${r1.status}, settles ${counts.settle - s0}) ${r1.status === 200 ? "" : r1body.slice(0, 200)}`);
  const s1 = counts.settle;
  const r1b = await onHttp(c1);
  ok(r1b.status === 409 && counts.settle === s1, `the twin's payment resent to the HTTP route is refused unsettled (${r1b.status})`);

  const c2 = await credential(httpChallenge, A2);
  const r2 = await onHttp(c2);
  ok(r2.status === 200 && counts.settle === s1 + 1, `the HTTP route's own payment settles (${r2.status})`);
  const s2 = counts.settle;
  const r2b = await onTwin(c2);
  ok(r2b.status === 409 && counts.settle === s2, `the HTTP route's payment resent to the twin is refused unsettled (${r2b.status})`);

  const v3 = counts.verify;
  const r3 = await onTwin(await credential(twinChallenge, A3, { echo: true }), "?key=no-such-key");
  ok(r3.status >= 400 && counts.settle === s2 && counts.verify > v3, `an error answer on the twin is verified and not settled (${r3.status})`);

  const echoedHttp = await credential(twinChallenge, A3, { echo: true });
  const r4 = await onHttp(echoedHttp);
  ok(r4.status === 402 && counts.settle === s2, `a payment echoing the twin's extension is refused on the HTTP route (${r4.status})`);

  let rows = [];
  for (let i = 0; i < 40; i++) {
    try { const d = new Database(SALES_DB, { readonly: true }); rows = d.prepare("SELECT payer, via, slug, wire FROM sales ORDER BY id").all(); d.close(); } catch { rows = []; }
    if (rows.length >= 2) break;
    await sleep(100);
  }
  const rowOf = (p) => rows.find((r) => String(r.payer).toLowerCase() === p);
  ok(rowOf(P1)?.via === "x402-mcp" && rowOf(P1)?.slug === "memory-read" && rowOf(P1)?.wire === "x402", `the twin's sale books slug memory-read, wire x402, path x402-mcp (${JSON.stringify(rowOf(P1))})`);
  ok(rowOf(P2)?.via === "http", `the HTTP route's sale books http (${rowOf(P2)?.via})`);
  ok(rows.length === 2, `exactly two sales were booked (${rows.length})`);

  // A late settlement on a twin books the tool's slug, not the connector's.
  const lateTx = `0x${"9a".repeat(32)}`;
  settleFailTx = lateTx;
  const [A4] = [privateKeyToAccount(generatePrivateKey())];
  const r5 = await onTwin(await credential(twinChallenge, A4, { echo: true }));
  await r5.arrayBuffer();
  let lateRow = null;
  for (let i = 0; i < 40 && !lateRow; i++) {
    const v = await (await fetch(`${B}/__operator/refunds.json`, { headers: { "x-operator-token": OP_TOKEN } })).json().catch(() => ({}));
    lateRow = (v.unconfirmedSettlements?.open || []).find((e) => String(e.tx || "").toLowerCase() === lateTx) || null;
    if (!lateRow) await sleep(100);
  }
  ok(r5.status !== 200 && lateRow?.slug === "memory-read", `a twin's settle failure naming a transaction is booked late under memory-read (${r5.status}, ${JSON.stringify(lateRow)})`);

  // respond-async: the twin answers its own 402 in the request.
  const twinAsync = await fetch(`${B}/__mcp-x402/render`, { method: "POST", headers: { "content-type": "application/json", prefer: "respond-async", ...MARKER }, body: JSON.stringify({ url: "https://example.com" }) });
  const twinAsyncOffer = twinAsync.status === 402 ? decode(twinAsync) : null;
  await twinAsync.arrayBuffer();
  ok(twinAsync.status === 402 && twinAsyncOffer?.resource?.url === "https://agent402.tools/mcp", `the twin asked to respond-async answers its own 402 in the request (${twinAsync.status})`);

  const surfaces = await Promise.all(["/api/pricing", "/openapi.json", "/llms.txt", "/llms-full.txt", "/sitemap.xml", "/sitemap-tools.xml", "/.well-known/x402"].map(async (p) => [p, await (await fetch(`${B}${p}`)).text()]));
  for (const [p, text] of surfaces) ok(!text.includes("__mcp-x402"), `${p} names no twin`);
} catch (e) {
  ok(false, e?.stack || String(e));
  if (srv) console.error(srv.log().slice(-3000));
} finally {
  await srv?.stop();
  facilitator.closeAllConnections?.();
  await new Promise((r) => facilitator.close(r));
  rmSync(TMP, { recursive: true, force: true });
}
// ---- restore leg: a chain dropped on a failed /supported read rejoins the twin ----
{
  const CELO = "eip155:42220";
  const celo = { up: false, reads: 0 };
  const base = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify(req.url === "/supported" ? { kinds: [{ x402Version: 2, scheme: "exact", network: BASE_NET }], extensions: [], signers: {} } : {}));
  });
  const celoFac = createServer((req, res) => {
    req.resume();
    if (req.url === "/supported") celo.reads++;
    if (req.url !== "/supported" || !celo.up) { res.writeHead(500, { Connection: "close" }); return res.end("Internal Server Error"); }
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: CELO }], extensions: [], signers: {} }));
  });
  await Promise.all([base, celoFac].map((x) => new Promise((r) => x.listen(0, "127.0.0.1", r))));
  const urlOf = (x) => `http://127.0.0.1:${x.address().port}`;
  let srv2 = null;
  try {
    srv2 = await bootServer({
      stores: "mcp-x402-restore",
      args: ["--import", "./scripts/lib/loopback-only-preload.js"],
      env: {
        FREE_MODE: "", NODE_ENV: "test", MCP_LOOPBACK_TEST_SECRET: SECRET, BASE_URL: "https://agent402.tools",
        WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base,celo",
        CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", FACILITATOR_URL: "", PAYAI_FACILITATOR_URL: urlOf(base), PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
        CELO_FACILITATOR_URL: urlOf(celoFac), CELO_FACILITATOR_KEY: "test-key", SOLVADOR_KEY: "", CIRCLE_FACILITATOR_API_KEY: "", MPP_SECRET_KEY: "",
        TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", ROBINHOOD_RELAYER_KEY: "", POSTHOG_API_KEY: "", PAYMENT_SETTLE_FALLBACK: "", X402_UPTO_NETWORKS: "",
        NETWORK_PRICE_PREMIUMS: `${CELO}=0.001`, NETWORK_PRICE_FLOORS: "", FACILITATOR_GAS_CHECK: "off",
        X402_RAIL_RECHECK_MS: "300", X402_RAIL_RECHECK_MAX_MS: "600",
        REDIS_URL: "", STATE_DATABASE_URL: "", TARGET_URL: "", STATS_ALLOW_EPHEMERAL: "true",
        X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off",
      },
    });
    const B2 = srv2.url;
    const offers = async () => {
      const [h, m] = await Promise.all([fetch(`${B2}/api/memory`), fetch(`${B2}/__mcp-x402/memory-read`, { headers: MARKER })]);
      const dec = (r) => (r.status === 402 ? JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8")) : null);
      const out = { http: dec(h), mcp: dec(m) };
      await Promise.all([h.arrayBuffer(), m.arrayBuffer()]);
      return out;
    };
    const netsOf = (o) => new Set((o?.accepts || []).map((a) => a.network));
    const first = await offers();
    ok(first.mcp && netsOf(first.mcp).has(BASE_NET) && !netsOf(first.mcp).has(CELO) && !netsOf(first.http).has(CELO), `restore leg: Celo fails its first /supported read, neither the twin nor the route offers it (${[...netsOf(first.mcp)].join(", ")})`);
    celo.up = true;
    let back = null;
    for (let i = 0; i < 200; i++) {
      const o = await offers();
      if (netsOf(o.http).has(CELO)) { back = o; break; }
      await sleep(100);
    }
    ok(back && netsOf(back.http).has(CELO), "control: the HTTP route offers Celo again without a restart");
    ok(back && netsOf(back.mcp).has(CELO) && same(back.mcp.accepts, back.http.accepts), `the twin offers Celo again, every accept equal to the route's (${[...netsOf(back?.mcp)].join(", ")})`);
    ok(back?.mcp?.resource?.url === "https://agent402.tools/mcp", "and its resource is still /mcp");
  } catch (e) {
    ok(false, e?.stack || String(e));
    if (srv2) console.error(srv2.log().slice(-3000));
  } finally {
    await srv2?.stop();
    for (const x of [base, celoFac]) { x.closeAllConnections?.(); await new Promise((r) => x.close(r)); }
  }
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
