#!/usr/bin/env node
// Arrival path of a paid call (src/sale-path.js), the operator cohort view and
// the Gateway test buyer's classification, offline.
//
//   node scripts/test-sale-path.js
//
// Module half (a ledger file written by a build before the path column):
//   - old rows read "unknown"; new rows carry "mcp", a package token or "http"
//   - salesByPath groups by path with sales, revenue and distinct payers
//   - a payer on the Gateway test buyer address is ours: its gateway-batched
//     row in the old file is swept internal at boot, and a new one records
//     internal, so neither counts as external batched revenue
//   - cohorts: 120 tools in a day is a sweep, a 3-hourly poller on two tools
//     is not, and the organic series drops the first and keeps the second
// Booted half (the REAL server, x402 paywall on, stub facilitator): a
// connector loopback call, an agent402-client call and a bare call each book
// their path on the ledger, /__operator/sales.json groups them, the failure
// monitor counts outcomes per path on /__operator/tool-failures.json, and
// /__operator/cohorts.json is operator-only. Nothing new reaches public
// surfaces.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getFreePorts } from "./lib/free-port.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = mkdtempSync(join(tmpdir(), "sale-path-"));
const FILE = join(TMP, "sales.db");
const GW_TEST_BUYER = "0x80665a362793b4b67b2ec58f5dd8f0006e5560c7";
const OLD = "0x00000000000000000000000000000000000a0001";

// ---- the file a build before the column wrote ---------------------------------
{
  const f = new Database(FILE);
  f.exec(`CREATE TABLE sales (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, slug TEXT NOT NULL, price_usd REAL NOT NULL, rail TEXT NOT NULL, network TEXT, payer TEXT, tx TEXT, internal INTEGER NOT NULL, wire TEXT, quote_usd REAL, response_sha256 TEXT, attest_uid TEXT, attest_tx TEXT)`);
  const ins = f.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?,?,?,?,?,?,?,?,?)");
  ins.run(Date.now() - 3600_000, "hash", 0.002, "usdc", "base", OLD, "0xold1", 0, "x402");
  ins.run(Date.now() - 3000_000, "uuid", 0.001, "usdc", "base", GW_TEST_BUYER, "gw-transfer-1", 0, "gateway-batched");
  f.close();
}
process.env.SALES_LEDGER_DB = FILE;
const sp = await import("../src/sale-path.js");
const sl = await import("../src/sales-ledger.js");
const { OUR_EVM_WALLETS } = await import("../src/revenue-live.js");

// ---- the path of a request ------------------------------------------------------
{
  const req = (headers, addr = "203.0.113.9") => ({ headers, socket: { remoteAddress: addr } });
  ok(sp.salePathOf(req({ "x-agent402-via": "mcp" }, "127.0.0.1")) === "mcp", "the connector's marker on a loopback socket reads mcp");
  ok(sp.salePathOf(req({ "x-agent402-via": "mcp", "user-agent": "agent402-client/0.8.21" }, "::ffff:127.0.0.1")) === "mcp", "the loopback marker wins over a User-Agent");
  ok(sp.salePathOf(req({ "x-agent402-via": "mcp" })) === "http", "the marker from a remote socket is plain http");
  ok(sp.salePathOf(req({ "user-agent": "agent402-client/0.8.21" })) === "agent402-client/0.8.21", "an agent402-client User-Agent books its product token");
  ok(sp.salePathOf(req({ "user-agent": "agent402-strands/0.1.13 agent402-client/0.8.21" })) === "agent402-strands/0.1.13", "an adapter built on the client books the adapter's own token");
  ok(sp.salePathOf(req({ "user-agent": "agent402-mcp/0.13.23" })) === "agent402-mcp/0.13.23", "the stdio MCP package books its token");
  ok(sp.salePathOf(req({ "user-agent": "curl/8.7.1" })) === "http" && sp.salePathOf(req({})) === "http", "any other User-Agent, or none, is http");
  ok(sp.salePathOf(req({ "user-agent": "agent402-unknown/1.0" })) === "http", "an unlisted package-looking token is http");
  ok(sp.salePathOf(req({ "user-agent": `agent402-client/${"9".repeat(60)}` })) === null || sp.salePathOf(req({ "user-agent": `agent402-client/${"9".repeat(60)}` })).length <= 40, "a stored token is at most 40 characters");
  ok(sp.cleanSalePath("agent402-client/0.8.21<script>") === null && sp.cleanSalePath("http") === "http" && sp.cleanSalePath("weird") === null, "only a fixed word or a well-formed package token is stored");
  ok(sp.salePathGroup(null) === "unknown" && sp.salePathGroup("agent402-client/0.8.21") === "agent402-client" && sp.salePathGroup("mcp") === "mcp", "groups: unknown, package name, mcp");
  const pkgs = ["client", "mcp", "openclaw", ...["agentkit", "ai-sdk", "anthropic-tools", "eliza", "google-adk", "langchain", "llamaindex", "openai-agents", "openai-tools", "strands"].map((a) => `adapters/${a}`)];
  for (const d of pkgs) {
    const name = JSON.parse(readFileSync(new URL(`../${d}/package.json`, import.meta.url), "utf8")).name;
    ok(sp.CLIENT_PACKAGES.includes(name), `${name} is on the package list`);
  }
  // Each adapter's User-Agent constant is its own name and current version
  // (the client reads VERSION, the mcp package reads its manifest).
  for (const a of ["agentkit", "ai-sdk", "anthropic-tools", "eliza", "google-adk", "langchain", "llamaindex", "openai-agents", "openai-tools", "strands"]) {
    const pkg = JSON.parse(readFileSync(new URL(`../adapters/${a}/package.json`, import.meta.url), "utf8"));
    const src = readFileSync(new URL(`../adapters/${a}/index.js`, import.meta.url), "utf8");
    const ua = (/const USER_AGENT = "([^"]+)";/.exec(src) || [])[1];
    const used = /"User-Agent": USER_AGENT/.test(src) || /new Agent402\(\{ userAgent: USER_AGENT/.test(src);
    ok(ua === `${pkg.name}/${pkg.version}` && used, `${a}: sends ${pkg.name}/${pkg.version} (${ua})`);
  }
  const py = readFileSync(new URL("../adapters/langchain-py/agent402_langchain/__init__.py", import.meta.url), "utf8");
  ok(/_USER_AGENT = f"agent402-langchain-py\/\{__version__\}"/.test(py) && (py.match(/"User-Agent": _USER_AGENT/g) || []).length === 3, "langchain-py sends agent402-langchain-py/<version> on every request");
  const mcpSrc = readFileSync(new URL("../mcp/index.js", import.meta.url), "utf8");
  ok(/h\.set\("user-agent", `agent402-mcp\/\$\{VERSION\}`\)/.test(mcpSrc), "the stdio MCP package sends agent402-mcp/<version>");
}

// ---- the Gateway test buyer is ours --------------------------------------------
ok(OUR_EVM_WALLETS.has(GW_TEST_BUYER), "the Gateway test buyer is in OUR_EVM_WALLETS");
{
  const g0 = sl.gatewayBatchedPayments();
  ok(g0.count === 1 && g0.externalCount === 0, `its pre-existing gateway-batched row was swept internal at boot (${JSON.stringify(g0)})`);
  sl.recordSale({ slug: "uuid", priceUsd: 0.001, rail: "usdc", network: "eip155:8453", payer: GW_TEST_BUYER.toUpperCase().replace("0X", "0x"), tx: "gw-transfer-2", wire: "gateway-batched", via: "agent402-client/0.8.21" });
  const g1 = sl.gatewayBatchedPayments();
  ok(g1.count === 2 && g1.externalCount === 0 && g1.externalUsd === 0, `a new batched buy from it records internal (${JSON.stringify(g1)})`);
}

// ---- old rows read unknown; new rows carry their path ----------------------------
{
  const A = "0x00000000000000000000000000000000000a0002", B = "0x00000000000000000000000000000000000a0003";
  sl.recordSale({ slug: "hash", priceUsd: 0.01, rail: "usdc", network: "base", payer: A, tx: "0xp1", wire: "x402", via: "mcp" });
  sl.recordSale({ slug: "hash", priceUsd: 0.01, rail: "usdc", network: "base", payer: B, tx: "0xp2", wire: "x402", via: "mcp" });
  sl.recordSale({ slug: "uuid", priceUsd: 0.02, rail: "usdc", network: "base", payer: A, tx: "0xp3", wire: "x402", via: "agent402-client/0.8.20" });
  sl.recordSale({ slug: "uuid", priceUsd: 0.02, rail: "usdc", network: "base", payer: A, tx: "0xp4", wire: "x402", via: "agent402-client/0.8.21" });
  sl.recordSale({ slug: "uuid", priceUsd: 0.03, rail: "usdc", network: "base", payer: B, tx: "0xp5", wire: "x402", via: "http" });
  sl.recordSale({ slug: "uuid", priceUsd: 0.03, rail: "usdc", network: "base", payer: B, tx: "0xp6", wire: "x402", via: "agent402-client/1.0<bad>" });
  const raw = new Database(FILE, { readonly: true });
  const vias = raw.prepare("SELECT tx, via FROM sales ORDER BY id").all();
  raw.close();
  ok(vias.find((r) => r.tx === "0xold1")?.via === null, "a row written before the column has no path");
  ok(vias.find((r) => r.tx === "0xp4")?.via === "agent402-client/0.8.21" && vias.find((r) => r.tx === "0xp1")?.via === "mcp", "new rows store the path");
  ok(vias.find((r) => r.tx === "0xp6")?.via === null, "a malformed path is not stored");
  const bp = sl.salesByPath({ days: 30 });
  ok(bp.unknown?.sales === 2 && bp.unknown?.payers === 2, `old rows and unstorable paths read "unknown" (${JSON.stringify(bp.unknown)})`);
  ok(bp.mcp?.sales === 2 && bp.mcp?.payers === 2 && bp.mcp?.revenueUsd === 0.02, `mcp: 2 sales, 2 payers, $0.02 (${JSON.stringify(bp.mcp)})`);
  ok(bp["agent402-client"]?.sales === 2 && bp["agent402-client"]?.payers === 1 && bp["agent402-client"]?.versions?.["agent402-client/0.8.20"] === 1, `one client path across versions, payers counted once (${JSON.stringify(bp["agent402-client"])})`);
  ok(bp.http?.sales === 1 && !("versions" in bp.http), "http is its own path");
  const sum = sl.salesSummary({ detailed: true });
  ok(sum.byPath?.mcp?.sales === 2, "the operator summary carries byPath");
  ok(!("byPath" in sl.salesSummary()), "the public summary does not");
}

// ---- cohorts ----------------------------------------------------------------------
{
  const raw = new Database(FILE);
  const ins = raw.prepare("INSERT INTO sales (ts, slug, price_usd, rail, network, payer, tx, internal, wire) VALUES (?,?,?,?,?,?,?,0,'x402')");
  const SWEEPER = "0x00000000000000000000000000000000000c0001", POLLER = "0x00000000000000000000000000000000000c0002";
  const now = Date.now();
  const dayStart = Math.floor((now - 2 * 86_400_000) / 86_400_000) * 86_400_000;
  raw.transaction(() => {
    for (let i = 0; i < 120; i++) ins.run(dayStart + 3_600_000 + i * 60_000, `tool-${i}`, 0.01, "usdc", "base", SWEEPER, `0xs${i}`);
    for (let h = 0; h < 6 * 24; h += 3) ins.run(now - 6 * 86_400_000 + h * 3_600_000, h % 2 ? "stock-quote" : "crypto-price", 0.005, "usdc", "base", POLLER, `0xq${h}`);
  })();
  raw.close();
  const c = sl.salesCohorts({ days: 30, fresh: true });
  const sw = c.wallets.find((w) => w.payer === SWEEPER);
  ok(sw && sw.kind === "sweep" && sw.maxToolsInDay === 120 && sw.tools === 120 && sw.calls === 120 && sw.usd === 1.2 && sw.firstSeen && sw.lastSeen, `120 tools in a day is a sweep (${JSON.stringify(sw)})`);
  ok(!c.wallets.some((w) => w.payer === POLLER), "a 3-hourly poller on two tools is not listed");
  const sweepDay = new Date(dayStart).toISOString().slice(0, 10);
  const d = c.daily.find((x) => x.day === sweepDay);
  ok(d && d.cohortSales === 120 && d.organicSales === d.sales - 120, `the organic series drops the sweeper's day (${JSON.stringify(d)})`);
  const pollerSales = c.daily.reduce((n, x) => n + x.organicSales, 0);
  ok(pollerSales >= 48, `the organic series keeps the poller's calls (${pollerSales} organic sales)`);
  ok(c.thresholds.toolsPerDay === 29 && c.window.days === 30, "default thresholds: more than 29 tools (the decide sweep rule), a 30-day window");
  const capped = sl.salesCohorts({ days: 400, fresh: true });
  ok(capped.window.days === 30, "the window is bounded at 30 days");
  const loose = sl.salesCohorts({ days: 30, toolsPerDay: 200, fresh: true });
  ok(!loose.wallets.some((w) => w.payer === SWEEPER), "the tools threshold is configurable");
  const burst = sl.salesCohorts({ days: 30, toolsPerDay: 500, callsPerHour: 50, fresh: true });
  ok(burst.wallets.find((w) => w.payer === SWEEPER)?.kind === "burst", "more than M calls in one hour is a burst");
  const cached = sl.salesCohorts({ days: 30 });
  ok(cached === sl.salesCohorts({ days: 30 }), "a repeat read inside the cache window is served from the cache");
  // The public decide figures still count the sweeper as external (owner rule).
  ok(sl.salesSummary().totals.external.sales >= 120, "public totals stay unadjusted");
}

// ---- booted half -------------------------------------------------------------------
const [PORT, FAC_PORT] = await getFreePorts(2);
const B = `http://127.0.0.1:${PORT}`;
const OP = "test-sale-path-operator-token-0123456789";
const TX = `0x${"5a".repeat(32)}`;
const BOOT_DB = join(TMP, "boot-sales.db");
let proc = null, facilitator = null;
const serverLog = [];
facilitator = createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const reply = (obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/rpc") return reply({ jsonrpc: "2.0", id: 1, result: "0x" + (1_000_000_000).toString(16).padStart(64, "0") });
    let parsed = {}; try { parsed = b ? JSON.parse(b) : {}; } catch { /* ignore */ }
    const payer = parsed.paymentPayload?.payload?.authorization?.from;
    if (req.url === "/verify") return reply({ isValid: true, payer });
    if (req.url === "/settle") return reply({ success: true, transaction: TX, network: "eip155:8453", payer });
    reply({});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));
const cleanup = () => { try { proc?.kill("SIGKILL"); } catch { /* */ } facilitator?.close(); rmSync(TMP, { recursive: true, force: true }); };
try {
  proc = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
      FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, PAYMENT_NETWORKS: "base",
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "", STATE_DATABASE_URL: "",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
      AGENT402_OPERATOR_TOKEN: OP, REFUND_DB_DIR: TMP, SALES_LEDGER_DB: BOOT_DB, HANGUP_FORGIVE_FILE: join(TMP, "hangup.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (chunk) => { for (const line of String(chunk).split("\n")) if (line.trim()) serverLog.push(line.slice(0, 400)); };
  proc.stdout.on("data", keep); proc.stderr.on("data", keep);
  let up = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch { /* booting */ } await sleep(500); }
  ok(up, "paid server booted");
  if (!up) throw new Error("server did not boot");
  const unpaid = await fetch(`${B}/api/uuid`);
  ok(unpaid.status === 402, `unpaid uuid -> 402 (got ${unpaid.status})`);
  const accepted = (JSON.parse(Buffer.from(unpaid.headers.get("payment-required"), "base64").toString("utf-8")).accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
  let nonceN = 0;
  const credential = (payer) => Buffer.from(JSON.stringify({
    x402Version: 2, resource: accepted.resource, accepted,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + (0x7000 + ++nonceN).toString(16).padStart(64, "0") } },
  })).toString("base64");
  const buy = (payer, headers) => fetch(`${B}/api/uuid`, { headers: { "payment-signature": credential(payer), ...headers } });
  // The connector's loopback: the marker the connector sets (src/mcp-mpp.js), on a local socket.
  const r1 = await buy("0x00000000000000000000000000000000000b0001", { "x-agent402-via": "mcp", "user-agent": "node" });
  const r2 = await buy("0x00000000000000000000000000000000000b0002", { "user-agent": "agent402-client/0.8.21" });
  const r3 = await buy("0x00000000000000000000000000000000000b0003", { "user-agent": "curl/8.7.1" });
  ok(r1.status === 200 && r2.status === 200 && r3.status === 200, `three paid calls answered 200 (${r1.status}, ${r2.status}, ${r3.status})`);
  let rows = [];
  for (let i = 0; i < 40; i++) {
    try { const d = new Database(BOOT_DB, { readonly: true }); rows = d.prepare("SELECT payer, via FROM sales WHERE slug = 'uuid' ORDER BY id").all(); d.close(); } catch { rows = []; }
    if (rows.length >= 3) break;
    await sleep(100);
  }
  const viaOf = (p) => rows.find((r) => r.payer === p)?.via;
  ok(viaOf("0x00000000000000000000000000000000000b0001") === "mcp", `the loopback call books mcp (${viaOf("0x00000000000000000000000000000000000b0001")})`);
  ok(viaOf("0x00000000000000000000000000000000000b0002") === "agent402-client/0.8.21", `the client call books its token (${viaOf("0x00000000000000000000000000000000000b0002")})`);
  ok(viaOf("0x00000000000000000000000000000000000b0003") === "http", `the bare call books http (${viaOf("0x00000000000000000000000000000000000b0003")})`);
  const auth = { "x-operator-token": OP };
  const sales = await (await fetch(`${B}/__operator/sales.json`, { headers: auth })).json();
  ok(sales.byPath?.mcp?.sales === 1 && sales.byPath?.["agent402-client"]?.sales === 1 && sales.byPath?.http?.sales === 1 && sales.byPath.mcp.payers === 1, `sales.json groups the three paths (${JSON.stringify(sales.byPath)})`);
  const tf = await (await fetch(`${B}/__operator/tool-failures.json`, { headers: auth })).json();
  ok(tf.byPath?.mcp?.day?.outside?.ok >= 1 && tf.byPath?.["agent402-client"]?.day?.outside?.ok >= 1 && tf.byPath?.http?.day && typeof tf.byPath.http.day.outsideErrors === "number", `tool-failures.json counts outcomes per path (${JSON.stringify(Object.keys(tf.byPath || {}))})`);
  const coh = await fetch(`${B}/__operator/cohorts.json`, { headers: auth });
  const cj = await coh.json();
  ok(coh.status === 200 && Array.isArray(cj.wallets) && Array.isArray(cj.daily) && cj.thresholds?.toolsPerDay === 29, "cohorts.json answers the operator");
  ok((await fetch(`${B}/__operator/cohorts.json`)).status === 404, "cohorts.json is 404 without the operator token");
  const pub = [await (await fetch(`${B}/api/stats`)).text(), await (await fetch(`${B}/api/gateway-status`)).text()].join("\n");
  ok(!/byPath|agent402-client\/0\.8|organicSales|cohortSales/.test(pub), "nothing of it reaches the public stats or gateway status");
  // The connector really sends that marker on its loopback (the caller path).
  const mpp = readFileSync(new URL("../src/mcp-mpp.js", import.meta.url), "utf8");
  ok(/"X-Agent402-Via": "mcp"/.test(mpp), "src/mcp-mpp.js sets the marker the ledger reads");
} catch (e) {
  ok(false, e?.stack || String(e));
  for (const l of serverLog.slice(-25)) console.error("  server:", l);
}
cleanup();
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
