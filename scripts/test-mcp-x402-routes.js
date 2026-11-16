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
//   - no catalog surface names a twin.
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

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- module half ------------------------------------------------------------------
{
  ok(same([...twins.MCP_X402_SLUGS].sort(), ["answer", "memory-read", "render", "search", "search-news", "stock-quote"]), "six flagships have a twin");
  ok(FLAGSHIP_MCP_NAMES.render === "browser.render" && FLAGSHIP_MCP_NAMES["memory-read"] === "memory.read", "render is browser.render and memory-read is memory.read");
  const fakeCatalog = {
    "GET /api/memory": { slug: "memory-read", price: "$0.001", discovery: { input: {}, inputSchema: { properties: { key: { type: "string" } } } } },
    "POST /api/render": { slug: "render", price: "$0.01", discovery: { input: { url: "https://example.com" }, inputSchema: { properties: { url: { type: "string" } }, required: ["url"] } } },
    "GET /api/answer": { slug: "answer", price: "$0.01", quote: () => 0.01 },
    "GET /api/uuid": { slug: "uuid", price: "$0.001" },
  };
  const entries = twins.mcpX402Entries(fakeCatalog);
  ok(same(entries.map((e) => `${e.toolName} ${e.route}`), ["browser.render POST /api/render", "memory.read GET /api/memory"]), "twins come from the catalog, fixed-price flagships only");
  const ext = twins.mcpX402DiscoveryExtension(entries[0]).bazaar;
  ok(ext?.info?.input?.type === "mcp" && ext.info.input.toolName === "browser.render" && ext.info.input.transport === "streamable-http"
    && same(ext.info.input.example, { url: "https://example.com" }) && ext.info.input.inputSchema?.type === "object", "the declared extension names the tool, transport, schema and example");
  ok(validateDiscoveryExtension(ext).valid && validateDiscoveryExtensionSpec(ext).valid, "the protocol's validators accept it");

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
  ok(keys.length === 2 && keys[0] !== keys[1], `the same payment on the twin and the HTTP route reads two idempotency keys (${keys.length})`);
}

// ---- booted half -------------------------------------------------------------------
const BASE_NET = "eip155:8453", OP = "eip155:10", RH = "eip155:4663";
const TMP = mkdtempSync(join(tmpdir(), "mcp-x402-"));
const SALES_DB = join(TMP, "sales.db");
const counts = { verify: 0, settle: 0 };
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
      STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
      MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off",
      SALES_LEDGER_DB: SALES_DB, REFUND_DB_DIR: TMP, HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
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
    ["a marker without the secret", "/__mcp-x402/search?q=x", { headers: { "x-agent402-via": "mcp" } }],
    ["another method", "/__mcp-x402/memory-read", { method: "POST", headers: { ...MARKER, "content-type": "application/json" }, body: "{}" }],
    ["a slug with no twin", "/__mcp-x402/uuid", { headers: MARKER }],
  ]) {
    const r = await fetch(`${B}${url}`, init);
    const body = (await r.text()).replaceAll(url.split("?")[0], "<path>");
    ok(r.status === 404 && plain404.status === 404 && body === plainBody && !r.headers.get("payment-required"), `${label}: the ordinary 404 (${r.status})`);
  }

  // Every twin: resource /mcp, a valid MCP extension, the HTTP route's accepts.
  const present = twins.MCP_X402_SLUGS.filter((s) => routeOf[s]);
  ok(present.length === 6, `all six twins are served on this boot (${present.join(", ")})`);
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
      && bz.info.input.inputSchema?.type === "object" && bz.info.input.example && typeof bz.info.input.example === "object" && !("method" in bz.info.input),
    `${slug}: an MCP extension for ${FLAGSHIP_MCP_NAMES[slug]} with schema, example and transport`);
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
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
