// The stock-data switch on real boots (src/tools/stock-provider.js).
//
//   1. FREE_MODE, no provider (the default): the stock tools and the packs that
//      run them are absent from every listing surface (catalog, /api/pricing,
//      /openapi.json, llms.txt, llms-full.txt, /.well-known/x402, the sitemap,
//      /tools, /skills, the skill-pack index, /api/find, the MCP tool and
//      prompt lists, catalog.search), their pages are 404, and their routes
//      answer 503 not-offered.
//   2. Paid mode, no provider: the same routes answer that 503 with no payment
//      challenge (ahead of every gate), while a priced route still asks 402.
//   3. FREE_MODE, provider on (databento against a local stub through
//      scripts/lib/databento-stub-preload.js, so no market-data host is
//      reached): the tools and packs are back, and each tool's published
//      example answers 200 with its documented fields.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { bootServer } from "./lib/boot-server.js";
import { STOCK_SLUGS } from "../src/tools/stock-provider.js";
import { STOCK_PACK_SLUGS } from "../src/skills.js";

// The kit's published examples as the databento provider publishes them.
process.env.STOCK_DATA_PROVIDER = "databento";
const { FINANCE_TOOLS } = await import("../src/tools/finance-kit.js");
delete process.env.STOCK_DATA_PROVIDER;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
let facilitator = null, dbStub = null;
const cleanup = () => { for (const s of servers) s.child.kill("SIGKILL"); facilitator?.close(); dbStub?.close(); };
process.on("exit", cleanup);

const BASE_ENV = { X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", POSTHOG_API_KEY: "",
  AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999", STOCK_DATA_PROVIDER: "", DATABENTO_API_KEY: "", MARKET_TICK: "" };
async function boot(label, env, args = []) {
  const srv = await bootServer({ env: { ...BASE_ENV, ...env }, stores: label, args, timeoutMs: 180_000 });
  servers.push(srv);
  return { base: srv.url, child: srv.child };
}
const mcp = async (base, method, params = {}) => (await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).text();

const TOOL_RE = new RegExp(`\\b(${[...STOCK_SLUGS].join("|")})\\b`);
const PACK_RE = new RegExp(`\\b(${[...STOCK_PACK_SLUGS].join("|")})\\b`);
const NAMES_RE = new RegExp(`${TOOL_RE.source}|${PACK_RE.source}|market\\.quote|databento`, "i");
const SURFACES = ["/api/pricing", "/openapi.json", "/llms.txt", "/llms-full.txt", "/.well-known/x402", "/sitemap.xml", "/tools", "/skills", "/api/skill-packs.json",
  "/api/find?q=stock+quote+for+AAPL", "/api/find?q=price+an+option+on+a+stock", "/", "/docs", "/pricing", "/blog", "/.well-known/agent.json", "/api/index"];

try {
  // --- 1. FREE_MODE, no provider -------------------------------------------
  {
    const { base, child } = await boot("stock-off", { FREE_MODE: "true" });
    const leaks = [];
    for (const p of SURFACES) {
      const r = await fetch(`${base}${p}`);
      const m = (await r.text()).match(NAMES_RE);
      if (r.status !== 200) leaks.push(`${p} answered ${r.status}`);
      else if (m) leaks.push(`${p}: ${m[0]}`);
    }
    for (const [label, body] of [["tools/list", await mcp(base, "tools/list")], ["prompts/list", await mcp(base, "prompts/list")], ["initialize", await mcp(base, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })]]) {
      const m = body.match(NAMES_RE);
      if (m) leaks.push(`mcp ${label}: ${m[0]}`);
    }
    for (const q of ["stock quote", "stock price history", "options pricing on a stock", "company dossier"]) {
      const body = await mcp(base, "tools/call", { name: "catalog.search", arguments: { query: q } });
      const m = body.match(NAMES_RE);
      if (m) leaks.push(`catalog.search "${q}": ${m[0]}`);
    }
    ok(leaks.length === 0, `no provider: no listing surface names a stock tool, a stock pack or market.quote (${leaks.join("; ") || `${SURFACES.length + 7} surfaces read`})`);
    const pricing = await (await fetch(`${base}/api/pricing`)).json();
    ok((pricing.endpoints || []).length > 300, `control: the catalog is read (${(pricing.endpoints || []).length} entries)`);
    const pages = [];
    for (const s of STOCK_SLUGS) { const r = await fetch(`${base}/tools/${s}`); if (r.status !== 404) pages.push(`/tools/${s} ${r.status}`); }
    for (const s of STOCK_PACK_SLUGS) { const r = await fetch(`${base}/skills/${s}`); if (r.status !== 404) pages.push(`/skills/${s} ${r.status}`); }
    ok(pages.length === 0, `no provider: the tool and pack pages are not served (${pages.join(", ") || "all 404"})`);
    const routes = [];
    for (const path of [...[...STOCK_SLUGS].map((s) => `/api/${s}?symbol=AAPL`), ...[...STOCK_PACK_SLUGS].map((s) => `/api/skill/${s}`)]) {
      const r = await fetch(`${base}${path}`, path.includes("/skill/") ? { method: "POST", headers: { "content-type": "application/json" }, body: '{"ticker":"AAPL"}' } : {});
      const b = await r.json().catch(() => ({}));
      if (!(r.status === 503 && b.error === "not-offered" && /not currently offered/.test(b.message || ""))) routes.push(`${path} ${r.status}`);
    }
    ok(routes.length === 0, `no provider: every stock route and pack answers 503 not-offered (${routes.join(", ") || "all"})`);
    child.kill("SIGTERM");
  }

  // --- 2. paid mode, no provider: no payment challenge ----------------------
  {
    facilitator = createServer((req, res) => {
      let b = ""; req.on("data", (c) => { b += c; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url === "/rpc") return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }));
        res.end(JSON.stringify(req.url === "/supported" ? { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} } : {}));
      });
    });
    await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
    const FAC_PORT = facilitator.address().port;
    const { base, child } = await boot("stock-paid", { FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
      // The x402 middleware reads the facilitator's kinds at start.
      X402_SYNC_ON_START: "",
      FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, TRUST_PROXY_HOPS: "1", CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "" });
    // The payment gates are ready once a priced route asks 402 (the facilitator
    // read finishes after /health answers); only then is "no challenge" a finding.
    let priced = null;
    for (let i = 0; i < 60; i++) { priced = await fetch(`${base}/api/crypto-price?coins=bitcoin`); if (priced.status === 402) break; await sleep(500); }
    ok(priced.status === 402, `control: a priced route on the same boot asks 402 (got ${priced.status})`);
    const bad = [];
    for (const path of [...[...STOCK_SLUGS].map((s) => `/api/${s}?symbol=AAPL`), ...[...STOCK_PACK_SLUGS].map((s) => `/api/skill/${s}`)]) {
      for (const method of ["GET", "POST"]) {
        const r = await fetch(`${base}${path}`, method === "POST" ? { method, headers: { "content-type": "application/json" }, body: "{}" } : {});
        const b = await r.json().catch(() => ({}));
        if (!(r.status === 503 && b.error === "not-offered" && !r.headers.get("payment-required") && !r.headers.get("www-authenticate"))) bad.push(`${method} ${path} ${r.status}`);
      }
    }
    ok(bad.length === 0, `paid mode, no provider: the routes answer 503 with no payment challenge (${bad.join(", ") || "all"})`);
    child.kill("SIGTERM");
  }

  // --- 3. FREE_MODE, provider on (stubbed upstream) -------------------------
  {
    const bar = (day, close) => JSON.stringify({ hd: { ts_event: String(Date.parse(day) * 1e6) }, open: String(close - 1e9), high: String(close + 1e9), low: String(close - 2e9), close: String(close), volume: "1000" });
    const days = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10));
    dbStub = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const url = String(req.url || "");
        const send = (status, text) => { res.writeHead(status, { "content-type": "application/json" }); res.end(text); };
        if (url.startsWith("/v0/metadata.get_dataset_range")) return send(200, JSON.stringify({ end: days.at(-1) }));
        if (url.startsWith("/v0/metadata.get_cost")) return send(200, "0.00001");
        if (url.startsWith("/v0/timeseries.get_range")) return send(200, days.map((d, i) => bar(d, 100e9 + i * 1e9)).join("\n") + "\n");
        send(404, "{}");
      });
    });
    await new Promise((r) => dbStub.listen(0, "127.0.0.1", r));
    const DB_PORT = dbStub.address().port;
    const { base, child } = await boot("stock-on", { FREE_MODE: "true", STOCK_DATA_PROVIDER: "databento", DATABENTO_API_KEY: "db-test-key-not-real", DATABENTO_STUB_URL: `http://127.0.0.1:${DB_PORT}`, DATABENTO_WARM: "off" },
      ["--import", "./scripts/lib/databento-stub-preload.js"]);
    const pricing = await (await fetch(`${base}/api/pricing`)).json();
    const listed = new Set((pricing.endpoints || []).map((e) => e.slug));
    const missing = [...[...STOCK_SLUGS], ...[...STOCK_PACK_SLUGS].map((s) => `skill-${s}`)].filter((s) => !listed.has(s));
    ok(missing.length === 0, `provider on: every stock tool and pack is listed again (missing: ${missing.join(", ") || "none"})`);
    const kitPrice = Object.fromEntries(FINANCE_TOOLS.map((t) => [t.slug, t.price]));
    ok([...STOCK_SLUGS].every((s) => (pricing.endpoints || []).find((e) => e.slug === s)?.price === kitPrice[s]), "provider on: listed at the kit's prices");
    const openapi = await (await fetch(`${base}/openapi.json`)).json();
    ok([...STOCK_SLUGS].every((s) => openapi.paths?.[`/api/${s}`]), "provider on: /openapi.json carries the routes");
    ok(/market\.quote/.test(await mcp(base, "tools/list")), "provider on: the MCP flagship market.quote is listed");
    for (const t of FINANCE_TOOLS) {
      const r = await fetch(`${base}/api/${t.slug}?${new URLSearchParams(Object.entries(t.discovery.input).map(([k, v]) => [k, String(v)]))}`);
      const body = await r.json().catch(() => ({}));
      const absent = Object.keys(t.discovery.output.example).filter((k) => !(k in body));
      ok(r.status === 200 && absent.length === 0, `provider on: ${t.slug}'s published example answers 200 with every documented field (${r.status}; missing: ${absent.join(", ") || "none"})`);
    }
    const page = await fetch(`${base}/tools/stock-quote`);
    ok(page.status === 200, `provider on: the tool page is served (${page.status})`);
    child.kill("SIGTERM");
  }
} catch (e) {
  fail++; console.error(`FAIL - ${e?.stack || e}`);
} finally { cleanup(); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
