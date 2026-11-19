// The Kalshi switch (src/kalshi-switch.js, KALSHI_TOOLS) offline and on real boots.
//
//   0. The switch reads "on" only; with it off the kit makes no upstream read
//      (its one fetch refuses first), lists nothing, and the retired Polymarket
//      routes name no replacement.
//   1. FREE_MODE, switch off (the default): the Kalshi tools are absent from
//      every listing surface (catalog, /api/pricing, /openapi.json, llms.txt,
//      llms-full.txt, /.well-known/x402, the sitemap, /tools, /api/find, the MCP
//      tool and prompt lists, catalog.search), their pages are 404, their
//      routes answer 503 not-offered, catalog.call names them not offered, and
//      the weather-market tools are still listed.
//   2. Paid mode, switch off: the same routes answer that 503 with no payment
//      challenge (ahead of every gate), while a priced route still asks 402.
//   3. FREE_MODE, switch on: the tools are listed again at the kit's prices, on
//      /openapi.json, the MPP start-here list and their pages, and a call
//      reaches the handler (its own 400 for a missing field, never the 503).
//      No call here reaches the Kalshi host.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { bootServer } from "./lib/boot-server.js";

delete process.env.KALSHI_TOOLS;
const { KALSHI_SLUGS, kalshiToolsEnabled } = await import("../src/kalshi-switch.js");
const { PREDICTION_MARKET_TOOLS, predictionMarketToolsEnabled } = await import("../src/tools/prediction-market-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
let facilitator = null;
const cleanup = () => { for (const s of servers) s.child.kill("SIGKILL"); facilitator?.close(); };
process.on("exit", cleanup);

// --- 0. the switch and the kit, offline --------------------------------------
ok(kalshiToolsEnabled({}) === false && kalshiToolsEnabled({ KALSHI_TOOLS: "" }) === false, "off by default");
ok(kalshiToolsEnabled({ KALSHI_TOOLS: " On " }) === true && kalshiToolsEnabled({ KALSHI_TOOLS: "on" }) === true, "control: on (trimmed, any case) turns it on");
ok(["1", "true", "yes", "off", "onn"].every((v) => kalshiToolsEnabled({ KALSHI_TOOLS: v }) === false), "only the word on turns it on");
ok(PREDICTION_MARKET_TOOLS.length === KALSHI_SLUGS.size && PREDICTION_MARKET_TOOLS.every((t) => KALSHI_SLUGS.has(t.slug)), `the switch names exactly the kit's tools (${[...KALSHI_SLUGS].join(", ")})`);
ok(predictionMarketToolsEnabled({}).length === 0 && predictionMarketToolsEnabled({ KALSHI_TOOLS: "on" }).length === 4, "the kit lists none off, all four on");
{
  const realFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async () => { reads++; return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); };
  try {
    const refused = [];
    const inputs = { "kalshi-markets": { status: "open", limit: 1 }, "kalshi-event": { eventTicker: "PRES-24" }, "kalshi-live-data": { eventTicker: "KXBTC-26SEP1817" }, "kalshi-weather-index": { city: "miami" } };
    for (const t of PREDICTION_MARKET_TOOLS) {
      try { await t.handler(inputs[t.slug]); refused.push(`${t.slug} answered`); }
      catch (e) { if (!(e.statusCode === 503 && e.notOffered === true)) refused.push(`${t.slug} ${e.statusCode} ${String(e.message).slice(0, 60)}`); }
    }
    ok(refused.length === 0 && reads === 0, `switch off: every handler refuses 503 not-offered and makes no upstream read (${refused.join(", ") || "all refused"}; ${reads} reads)`);
    process.env.KALSHI_TOOLS = "on";
    await PREDICTION_MARKET_TOOLS.find((t) => t.slug === "kalshi-markets").handler({ status: "open", limit: 1 }).catch(() => {});
    ok(reads > 0, `control: switch on, the same handler reads its upstream (${reads} reads)`);
  } finally { globalThis.fetch = realFetch; delete process.env.KALSHI_TOOLS; }
}
{
  const { RETIRED_TOOLS } = await import("../src/retired-tools.js");
  const named = Object.entries(RETIRED_TOOLS).filter(([, e]) => KALSHI_SLUGS.has(e.replacement)).map(([s]) => s);
  ok(named.length === 0 && ["polymarket-search", "polymarket-market", "polymarket-orderbook", "polymarket-price-history"].every((s) => RETIRED_TOOLS[s] && RETIRED_TOOLS[s].replacement === null), `switch off: no retirement points at a Kalshi tool (${named.join(", ") || "none"})`);
}

const BASE_ENV = { X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", POSTHOG_API_KEY: "",
  AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999", KALSHI_TOOLS: "" };
async function boot(label, env) {
  const srv = await bootServer({ env: { ...BASE_ENV, ...env }, stores: label, timeoutMs: 180_000 });
  servers.push(srv);
  return { base: srv.url, child: srv.child };
}
const mcp = async (base, method, params = {}) => (await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).text();

const NAMES_RE = new RegExp(`\\bkalshi\\b|${[...KALSHI_SLUGS].join("|")}`, "i");
const SURFACES = ["/api/pricing", "/openapi.json", "/llms.txt", "/llms-full.txt", "/.well-known/x402", "/sitemap.xml", "/tools", "/skills", "/api/skill-packs.json",
  "/", "/docs", "/pricing", "/faq", "/what-is-mpp", "/og/markets.svg", "/.well-known/agent.json", "/api/index"];
// Pages whose prose must not name prediction markets either (the weather-market
// tools keep a "prediction-market" tag, which the listing JSON carries).
const PROSE = new Set(["/", "/docs", "/pricing", "/faq", "/what-is-mpp", "/og/markets.svg", "/llms.txt"]);
// Search answers echo the query, so they are read by the slugs they return.
const FINDS = ["prediction market odds", "kalshi markets", "event contract prices", "election odds"];

try {
  // --- 1. FREE_MODE, switch off ----------------------------------------------
  {
    const { base, child } = await boot("kalshi-off", { FREE_MODE: "true" });
    const leaks = [];
    for (const p of SURFACES) {
      const r = await fetch(`${base}${p}`);
      const text = await r.text();
      const m = text.match(NAMES_RE);
      if (r.status !== 200) leaks.push(`${p} answered ${r.status}`);
      else if (m) leaks.push(`${p}: ${m[0]}`);
      else if (PROSE.has(p) && /prediction.market/i.test(text)) leaks.push(`${p}: prediction market`);
    }
    for (const [label, body] of [["tools/list", await mcp(base, "tools/list")], ["prompts/list", await mcp(base, "prompts/list")], ["initialize", await mcp(base, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })]]) {
      const m = body.match(NAMES_RE);
      if (m) leaks.push(`mcp ${label}: ${m[0]}`);
    }
    for (const q of FINDS) {
      const found = await (await fetch(`${base}/api/find?q=${encodeURIComponent(q)}`)).json().catch(() => ({}));
      const fs = [...(found.results || []), ...(Array.isArray(found.weakMatches) ? found.weakMatches : [])].map((r) => r.slug).filter((x) => KALSHI_SLUGS.has(x));
      if (!Array.isArray(found.results)) leaks.push(`/api/find "${q}" unreadable`);
      if (fs.length) leaks.push(`/api/find "${q}": ${fs.join(",")}`);
      const body = JSON.parse((await mcp(base, "tools/call", { name: "catalog.search", arguments: { query: q } })).replace(/^[^{]*/, "")) ;
      const ss = (body.result?.structuredContent?.results || []).map((r) => r.slug).filter((x) => KALSHI_SLUGS.has(x));
      if (!body.result) leaks.push(`catalog.search "${q}" unreadable`);
      if (ss.length) leaks.push(`catalog.search "${q}": ${ss.join(",")}`);
    }
    ok(leaks.length === 0, `switch off: no listing surface names a Kalshi tool (${leaks.join("; ") || `${SURFACES.length + 3 + FINDS.length * 2} surfaces read`})`);
    const pricing = await (await fetch(`${base}/api/pricing`)).json();
    const listed = new Set((pricing.endpoints || []).map((e) => e.slug));
    ok(listed.size > 300 && listed.has("weather-market-brackets") && listed.has("weather-market-board"), `control: the catalog is read and the weather-market tools stay listed (${listed.size} entries)`);
    const pages = [];
    for (const s of KALSHI_SLUGS) { const r = await fetch(`${base}/tools/${s}`); if (r.status !== 404) pages.push(`/tools/${s} ${r.status}`); }
    ok(pages.length === 0, `switch off: the Kalshi tool pages are 404 (${pages.join(", ") || "all"})`);
    const routes = [];
    for (const s of KALSHI_SLUGS) {
      for (const method of ["GET", "POST"]) {
        const r = await fetch(`${base}/api/${s}${method === "GET" ? "?status=open" : ""}`, method === "POST" ? { method, headers: { "content-type": "application/json" }, body: "{}" } : {});
        const b = await r.json().catch(() => ({}));
        if (!(r.status === 503 && b.error === "not-offered" && b.slug === s && /not currently offered/.test(b.message || ""))) routes.push(`${method} /api/${s} ${r.status}`);
      }
    }
    ok(routes.length === 0, `switch off: every Kalshi route answers 503 not-offered naming the slug (${routes.join(", ") || "all"})`);
    const viaMcp = await mcp(base, "tools/call", { name: "catalog.call", arguments: { slug: "kalshi-markets", input: { status: "open" } } });
    ok(/not currently offered on this server\. \(kalshi-markets\)/.test(viaMcp), `switch off: catalog.call names the tool not offered (${viaMcp.slice(0, 160)})`);
    const poly = await fetch(`${base}/api/polymarket-search`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const pb = await poly.json().catch(() => ({}));
    ok(poly.status === 410 && pb.replacement === null, `switch off: a retired Polymarket route answers 410 with no replacement (${poly.status} ${JSON.stringify(pb.replacement)})`);
    child.kill("SIGTERM");
  }

  // --- 2. paid mode, switch off: no payment challenge ------------------------
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
    const { base, child } = await boot("kalshi-paid", { FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
      X402_SYNC_ON_START: "",
      FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`, TRUST_PROXY_HOPS: "1", CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "" });
    let priced = null;
    for (let i = 0; i < 60; i++) { priced = await fetch(`${base}/api/crypto-price?coins=bitcoin`); if (priced.status === 402) break; await sleep(500); }
    ok(priced.status === 402, `control: a priced route on the same boot asks 402 (got ${priced.status})`);
    const bad = [];
    for (const s of KALSHI_SLUGS) {
      for (const method of ["GET", "POST"]) {
        const r = await fetch(`${base}/api/${s}`, method === "POST" ? { method, headers: { "content-type": "application/json" }, body: "{}" } : {});
        const b = await r.json().catch(() => ({}));
        if (!(r.status === 503 && b.error === "not-offered" && !r.headers.get("payment-required") && !r.headers.get("www-authenticate"))) bad.push(`${method} /api/${s} ${r.status}`);
      }
    }
    ok(bad.length === 0, `paid mode, switch off: the routes answer 503 with no payment challenge (${bad.join(", ") || "all"})`);
    child.kill("SIGTERM");
  }

  // --- 3. FREE_MODE, switch on -------------------------------------------------
  {
    const { base, child } = await boot("kalshi-on", { FREE_MODE: "true", KALSHI_TOOLS: "on" });
    const pricing = await (await fetch(`${base}/api/pricing`)).json();
    const rows = new Map((pricing.endpoints || []).map((e) => [e.slug, e]));
    const missing = [...KALSHI_SLUGS].filter((s) => !rows.has(s));
    ok(missing.length === 0, `switch on: every Kalshi tool is listed again (missing: ${missing.join(", ") || "none"})`);
    ok(PREDICTION_MARKET_TOOLS.every((t) => rows.get(t.slug)?.price === t.price), "switch on: listed at the kit's prices");
    const openapi = await (await fetch(`${base}/openapi.json`)).json();
    ok([...KALSHI_SLUGS].every((s) => openapi.paths?.[`/api/${s}`]), "switch on: /openapi.json carries the routes");
    ok(/kalshi-markets/.test(await (await fetch(`${base}/llms.txt`)).text()), "switch on: llms.txt names kalshi-markets (the MPP start-here list)");
    const found = await (await fetch(`${base}/api/find?q=kalshi+markets`)).json().catch(() => ({}));
    ok((found.results || []).some((r) => KALSHI_SLUGS.has(r.slug)), "switch on (control for the search reads): /api/find returns a Kalshi tool");
    const page = await fetch(`${base}/tools/kalshi-markets`);
    ok(page.status === 200, `switch on: the tool page is served (${page.status})`);
    ok(/prediction-market family/.test(await (await fetch(`${base}/faq`)).text()), "switch on: the FAQ sentence reads as on main");
    const r = await fetch(`${base}/api/kalshi-event`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const b = await r.json().catch(() => ({}));
    ok(r.status === 400 && /eventTicker/.test(JSON.stringify(b)), `switch on: a call reaches the handler (its own 400, got ${r.status})`);
    const poly = await (await fetch(`${base}/api/polymarket-search`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json().catch(() => ({}));
    ok(poly.replacement?.slug === "kalshi-markets", `switch on: the retired Polymarket route names its Kalshi replacement again (${JSON.stringify(poly.replacement?.slug)})`);
    child.kill("SIGTERM");
  }
} catch (e) {
  fail++; console.error(`FAIL - ${e?.stack || e}`);
} finally { cleanup(); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
