// The vendor's per-route bazaar check runs after boot, in slices, never in
// one synchronous loop while the server is starting (src/bazaar-route-check.js).
//   - control: the vendor middleware built plainly runs its check on its own
//     (an invalid declaration is warned about shortly after construction);
//   - built through withBazaarHidden it does not, and every route keeps its
//     own bazaar declaration object afterwards;
//   - the sliced check validates every route, warns as the vendor does, and
//     yields between short slices.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer } from "@x402/express";
import { x402ResourceServer } from "@x402/core/server";
import { validateBazaarRouteExtensions } from "@x402/extensions/bazaar";
import { checkBazaarRoutesInSlices, withBazaarHidden } from "../src/bazaar-route-check.js";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bootServer } from "./lib/boot-server.js";
import { MCP_X402_SLUGS, MCP_X402_PREFIX } from "../src/mcp-x402-routes.js";
import { FLAGSHIP_MCP_NAMES } from "../src/mcp-flagship.js";
import { paymentRequiredOfResult } from "../src/mcp-x402.js";
import { STOCK_SLUGS, stockToolServed } from "../src/tools/stock-provider.js";

const BOOT_STOCK_ENV = { STOCK_DATA_PROVIDER: "databento", DATABENTO_API_KEY: "db-test-key-not-real" };
/** The dotted names the boot serves: every twin the stock switch serves on its env. */
const EXPECTED_MCP = MCP_X402_SLUGS.filter((s) => !STOCK_SLUGS.has(s) || stockToolServed(s, BOOT_STOCK_ENV)).map((s) => FLAGSHIP_MCP_NAMES[s]);

/** The MCP tool declarations a paid boot of the real server serves
 *  (src/payments.js builds them from mcpX402PaymentSpecs(catalog) and each
 *  twin's offer carries its own): { route, toolName, extensions }, for every
 *  twin whose call answers an offer. */
async function liveMcpSpecs() {
  const facilitator = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/supported") return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
      if (req.url === "/rpc") return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }));
      res.end("{}");
    });
  });
  await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
  const FAC = `http://127.0.0.1:${facilitator.address().port}`;
  let srv = null, client = null;
  try {
    srv = await bootServer({
      stores: "bazaar-route-check",
      args: ["--import", "./scripts/lib/loopback-only-preload.js"],
      env: {
        NODE_ENV: "test", BASE_URL: "https://agent402.tools", REDIS_URL: "", STATE_DATABASE_URL: "", TARGET_URL: "", POSTHOG_API_KEY: "",
        STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off",
        TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", ROBINHOOD_RELAYER_KEY: "", MPP_SECRET_KEY: "",
        FREE_MODE: "", TRUST_PROXY_HOPS: "1", BAZAAR_ROUTE_CHECK: "off",
        // An active stock provider: market.quote still follows the stock switch
        // (stockToolServed, stock-history only). The loopback preload keeps
        // any read on this host.
        ...BOOT_STOCK_ENV, DATABENTO_WARM: "off",
        WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
        FACILITATOR_URL: FAC, PAYAI_FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, EVM_RPC_8453: `${FAC}/rpc`, FACILITATOR_GAS_CHECK: "off",
        CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", CIRCLE_FACILITATOR_API_KEY: "",
        AGENT402_MCP_MAX_PER_MIN: "1000000", AGENT402_MCP_MAX_PER_HOUR: "1000000", AGENT402_MCP_REQ_PER_MIN: "1000000", AGENT402_MCP_REQ_PER_HOUR: "1000000",
      },
    });
    client = new Client({ name: "test-bazaar-route-check", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
    const out = [];
    for (const slug of MCP_X402_SLUGS) {
      const toolName = FLAGSHIP_MCP_NAMES[slug];
      const offer = paymentRequiredOfResult(await client.callTool({ name: toolName, arguments: {} }));
      if (!offer) continue;
      out.push({ route: `GET ${MCP_X402_PREFIX}${slug}`, toolName, extensions: offer?.extensions || null });
    }
    return out;
  } finally {
    try { await client?.close(); } catch { /* closed */ }
    if (srv) await srv.stop();
    facilitator.closeAllConnections?.();
    await new Promise((r) => facilitator.close(r));
  }
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const accepts = { scheme: "exact", network: "eip155:8453", payTo: "0x000000000000000000000000000000000000dEaD", price: "$0.001" };
const bazaar = (n) => ({ info: { input: { type: "http", method: "POST", bodyType: "json", body: { n } } }, schema: { type: "object", properties: { input: { type: "object", properties: { body: { type: "object", properties: { n: { type: "string" } }, required: ["n"] } } } } } });
const makeRoutes = () => ({
  "POST /api/good": { accepts, description: "good", extensions: { bazaar: bazaar("text") } },
  "POST /api/bad": { accepts, description: "bad", extensions: { bazaar: bazaar(7) } }, // a number where the schema says string
});
const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(" ")); };
try {
  {
    const routes = makeRoutes();
    paymentMiddlewareFromHTTPServer(new x402HTTPResourceServer(new x402ResourceServer([]), routes), undefined, undefined, false);
    await sleep(300);
    ok(warnings.some((w) => /api\/bad.*invalid bazaar extension/.test(w)), `control: the plainly built middleware runs the vendor's check by itself (${warnings.length} warning(s))`);
  }
  warnings.length = 0;
  {
    const routes = makeRoutes();
    const before = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, v.extensions.bazaar]));
    const httpServer = new x402HTTPResourceServer(new x402ResourceServer([]), routes);
    const mw = withBazaarHidden(routes, () => paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));
    await sleep(300);
    ok(typeof mw === "function", "the middleware is built");
    ok(warnings.length === 0, `built with the declarations hidden, the vendor runs no check of its own (${warnings.length} warning(s))`);
    ok(Object.entries(routes).every(([k, v]) => v.extensions?.bazaar === before[k]), "every route keeps its own bazaar declaration object");
    ok(httpServer.routes === routes, "the server still reads the same route objects");

    const r = await checkBazaarRoutesInSlices(routes);
    ok(r.routes === 2, `the sliced check visits every declared route (${r.routes})`);
    ok(warnings.some((w) => /api\/bad.*invalid bazaar extension/.test(w)) && !warnings.some((w) => /api\/good/.test(w)), "it warns as the vendor does, for the invalid route only");
  }
  // The connector's MCP tool declarations (src/mcp-x402-routes.js), read from
  // a paid boot of the real server: valid, so no warning.
  warnings.length = 0;
  {
    const specs = await liveMcpSpecs();
    const routes = Object.fromEntries(specs.map((sp) => [sp.route, { accepts, description: sp.toolName, extensions: sp.extensions }]));
    const N = EXPECTED_MCP.length;
    ok(N >= 5 && !EXPECTED_MCP.includes("market.quote"), `the switch serves ${N} MCP tool declarations, market.quote not among them (${EXPECTED_MCP.join(", ")})`);
    ok(JSON.stringify(specs.map((sp) => sp.toolName)) === JSON.stringify(EXPECTED_MCP) && specs.every((sp) => sp.extensions?.bazaar?.info?.input?.type === "mcp"), `the catalog yields exactly those MCP tool declarations (${specs.map((sp) => sp.toolName).join(", ")})`);
    const r = await checkBazaarRoutesInSlices(routes);
    ok(r.routes === N && warnings.length === 0, `the sliced check passes every MCP tool declaration without a warning (${warnings.length}: ${warnings[0]?.slice(0, 140) || "none"})`);
    // Control: the vendor's route check alone reports each of them, which is what the boot logged.
    warnings.length = 0;
    validateBazaarRouteExtensions(routes);
    ok(warnings.length === N && warnings.every((w) => /must NOT have additional properties/.test(w)), `control: the vendor's route check alone warns on all ${N} (${warnings.length})`);
    // Control: an MCP declaration that IS invalid still warns.
    warnings.length = 0;
    const [first] = specs;
    const twin = JSON.parse(JSON.stringify(first.extensions));
    twin.bazaar.info.input.extra = "not in the schema";
    const noTool = JSON.parse(JSON.stringify(first.extensions));
    delete noTool.bazaar.info.input.toolName;
    const bad = await checkBazaarRoutesInSlices({ [first.route]: { accepts, extensions: twin }, "GET /__mcp-x402/none": { accepts, extensions: noTool }, "POST /api/bad": makeRoutes()["POST /api/bad"] });
    ok(bad.routes === 3 && warnings.length === 3 && warnings.some((w) => w.includes(first.route) && /additional properties/.test(w)) && warnings.some((w) => /mcp-x402\/none.*invalid bazaar extension/.test(w)) && warnings.some((w) => /api\/bad/.test(w)),
      `an MCP declaration with an extra input property, one with no tool name, and an invalid HTTP one each still warn (${warnings.length})`);
  }
  warnings.length = 0;
  {
    const routes = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`POST /api/r${i}`, { accepts, extensions: { bazaar: bazaar("x") } }]));
    // The slicing is pinned as work first: each check burns 4 ms, so a 15 ms
    // slice holds four of them (five with a late clock read), on any host. A
    // turn that held more ran past its slice. The time is then the least of
    // three runs: a host busy with other work stretches one turn of one run.
    let seen = 0, yields = 0, inTurn = 0, mostInTurn = 0, longest = Infinity;
    const burn = () => { seen++; inTurn++; mostInTurn = Math.max(mostInTurn, inTurn); const end = performance.now() + 4; while (performance.now() < end) { /* work */ } };
    for (let k = 0; k < 3 && longest >= 40; k++) {
      seen = 0; yields = 0; inTurn = 0;
      const r = await checkBazaarRoutesInSlices(routes, { sliceMs: 15, validate: burn, yieldTurn: () => { yields++; inTurn = 0; return new Promise((res) => setImmediate(res)); } });
      longest = Math.min(longest, r.longestTurnMs);
    }
    ok(seen === 60, `all 60 routes checked (${seen})`);
    ok(yields >= 10 && mostInTurn <= 5, `the work is cut into turns of a slice each (${yields} yields, at most ${mostInTurn} checks in one turn)`);
    ok(longest < 40, `...and the turns are short (longest ${longest} ms, the least of up to three runs)`);
  }
} finally {
  console.warn = origWarn;
}
console.log(`\ntest-bazaar-route-check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
