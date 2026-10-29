#!/usr/bin/env node
// Every accept of every paid route's 402 asks the amount the machine price
// surfaces publish: list (or the quoted range) plus the chain's settlement
// premium, raised to the chain's floor, both read from /api/pricing. Boots
// the real server on three rails (Base, Optimism with a premium, Robinhood
// Chain with its floor) against a local /supported stub; no payment is made.
// The premium is also on llms.txt, the openapi document and the connector's
// payment.info, derived from the same map.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { getFreePorts } from "./lib/free-port.js";
import { NETWORKS } from "../src/payments.js";

const OP = "eip155:10", RH = "eip155:4663", BASE_NET = "eip155:8453";
const PREMIUM_USD = 0.001;
const CONCURRENCY = 12;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const [port, facPort] = await getFreePorts(2);
const base = `http://127.0.0.1:${port}`;
const nameOf = Object.fromEntries(Object.entries(NETWORKS).map(([n, c]) => [c, n]));
const microOf = (usd) => Math.round(Number(String(usd ?? "").replace(/[^0-9.]/g, "")) * 1e6);

const facilitator = createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    if (req.url === "/supported") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ kinds: [BASE_NET, OP, RH].map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: {} }));
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((resolve) => facilitator.listen(facPort, "127.0.0.1", resolve));
const stub = `http://127.0.0.1:${facPort}`;

let serverLog = "";
const env = { ...process.env };
delete env.STATE_DATABASE_URL; delete env.REDIS_URL;
const child = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...env,
    PORT: String(port), FREE_MODE: "", NODE_ENV: "test",
    NETWORK: "base", PAYMENT_NETWORKS: "base,optimism,robinhood",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    FACILITATOR_URL: stub, SOLVADOR_KEY: "test-key", SOLVADOR_FACILITATOR_URL: stub, ROBINHOOD_FACILITATOR_URL: stub,
    NETWORK_PRICE_PREMIUMS: `${OP}=${PREMIUM_USD}`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
    MPP_SECRET_KEY: "test-accept-prices-secret",
    OPENROUTER_TTS_ENABLED: "true", X_BEARER_TOKEN: "test", APOLLO_API_KEY: "test",
    FACILITATOR_GAS_CHECK: "off", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
    MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", STATS_ALLOW_EPHEMERAL: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => { serverLog += d; });
child.stderr.on("data", (d) => { serverLog += d; });

const failures = [];
const fail = (where, problem) => failures.push(`${where}: ${problem}`);

try {
  let up = false;
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* booting */ }
    await wait(250);
  }
  if (!up) throw new Error(`server did not boot: ${serverLog.slice(-1200)}`);

  const pricing = await (await fetch(`${base}/api/pricing`)).json();
  const endpoints = Array.isArray(pricing.endpoints) ? pricing.endpoints : [];
  if (endpoints.length < 400) throw new Error(`/api/pricing listed ${endpoints.length} endpoints`);
  const premiums = pricing.payment?.premiumUsdByNetwork || {};
  const floors = pricing.payment?.minPriceUsdByNetwork || {};
  if (JSON.stringify(premiums) !== JSON.stringify({ optimism: PREMIUM_USD })) fail("/api/pricing", `payment.premiumUsdByNetwork is ${JSON.stringify(premiums)}, expected the configured premium under its public name`);
  if (!(floors.robinhood > 0)) fail("/api/pricing", `payment.minPriceUsdByNetwork carries no Robinhood floor (${JSON.stringify(floors)})`);
  if (!Array.isArray(pricing.payment?.networks) || !["base", "optimism", "robinhood"].every((n) => pricing.payment.networks.includes(n))) {
    throw new Error(`the boot does not offer all three rails (${JSON.stringify(pricing.payment?.networks)}): ${serverLog.split("\n").filter((l) => /dropped|WARNING/.test(l)).slice(0, 6).join(" | ")}`);
  }

  // The amount one network asks for a price: list plus its premium, raised to its floor.
  const expectMicro = (usd, network) => {
    const name = nameOf[network] || "";
    return Math.max(microOf(usd) + microOf(premiums[name] || 0), microOf(floors[name] || 0));
  };

  let cursor = 0, acceptsChecked = 0, networksSeen = new Set(), quotedChecked = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < endpoints.length) {
      const endpoint = endpoints[cursor++];
      const method = String(endpoint.method || "GET").toUpperCase();
      const route = `${method} ${endpoint.path}`;
      let paymentRequired;
      try {
        const response = await fetch(`${base}${endpoint.path}`, { method, headers: { "content-type": "application/json" }, body: ["POST", "PUT", "PATCH"].includes(method) ? "{}" : undefined, signal: AbortSignal.timeout(20_000) });
        if (response.status !== 402) { fail(route, `expected 402, got ${response.status}`); continue; }
        paymentRequired = JSON.parse(Buffer.from(response.headers.get("payment-required") || "", "base64").toString("utf8"));
      } catch (error) { fail(route, `request failed: ${error?.message || error}`); continue; }
      const accepts = Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
      if (!accepts.length) { fail(route, "402 without accepts"); continue; }
      for (const a of accepts) {
        if (!nameOf[a.network]) continue;
        networksSeen.add(a.network);
        acceptsChecked++;
        const amount = Number(a.amount);
        if (endpoint.quoted === true) {
          quotedChecked++;
          const min = expectMicro(endpoint.quoteRange?.minUsd, a.network), max = expectMicro(endpoint.quoteRange?.maxUsd, a.network);
          if (!(amount >= min && amount <= max)) fail(route, `${a.scheme} on ${a.network} asks ${amount}, outside ${min}..${max} (published range plus premium, floored)`);
        } else {
          const want = expectMicro(endpoint.price, a.network);
          if (amount !== want) fail(route, `${a.scheme} on ${a.network} asks ${amount}, the price surfaces say ${want} (list ${endpoint.price} plus premium ${premiums[nameOf[a.network]] || 0}, floor ${floors[nameOf[a.network]] || 0})`);
        }
      }
    }
  }));
  if (!networksSeen.has(OP) || !networksSeen.has(RH) || !networksSeen.has(BASE_NET)) fail("catalog", `accepts were seen on ${[...networksSeen].join(", ")} only`);
  if (!quotedChecked) fail("catalog", "no quoted route was checked against its range");

  // The same premium on the prose and document surfaces.
  const llms = await (await fetch(`${base}/llms.txt`)).text();
  // Chain bullets stay bare (chain: asset (CAIP-2)); the premium and the floor are stated once in the x402 paragraph.
  if (!/on Optimism every call quotes \$0\.001 above its list price/.test(llms)) fail("/llms.txt", "the x402 paragraph does not name the Optimism premium");
  if (!/on Robinhood Chain every call costs at least \$/.test(llms)) fail("/llms.txt", "the chain note does not name the Robinhood Chain floor");
  if (/\[Optimism\]\([^)]*\): USDC \(`eip155:10`\);/.test(llms)) fail("/llms.txt", "a chain bullet carries a clause");
  const llmsFull = await (await fetch(`${base}/llms-full.txt`)).text();
  if (!/on Optimism every call quotes \$0\.001 above its list price/.test(llmsFull) || !/premiumUsdByNetwork/.test(llmsFull)) fail("/llms-full.txt", "does not name the Optimism premium and the /api/pricing field");
  const openapi = await (await fetch(`${base}/openapi.json`)).json();
  if (!/premiumUsdByNetwork/.test(String(openapi?.info?.["x-guidance"] || ""))) fail("/openapi.json", "info.x-guidance does not name payment.premiumUsdByNetwork");
  const op = openapi?.paths?.["/api/hash"]?.post?.["x-payment-info"];
  if (JSON.stringify(op?.premiumUsdByNetwork) !== JSON.stringify({ optimism: PREMIUM_USD })) fail("/openapi.json", `POST /api/hash x-payment-info.premiumUsdByNetwork is ${JSON.stringify(op?.premiumUsdByNetwork)}`);
  const mcp = await (await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "payment.info", arguments: {} } }) })).text();
  if (!/on Optimism every call quotes \$0\.001 above its list price/.test(mcp) || !/premiumUsdByNetwork/.test(mcp)) fail("/mcp payment.info", "does not name the Optimism premium and the /api/pricing field");

  console.log(`accepts checked: ${acceptsChecked} on ${networksSeen.size} networks across ${endpoints.length} routes (${quotedChecked} on quoted routes)`);
  for (const problem of failures.slice(0, 40)) console.error(`FAIL - ${problem}`);
  if (failures.length > 40) console.error(`... ${failures.length - 40} more failure(s)`);
  console.log(`${failures.length ? "FAILED" : "OK"}: ${failures.length} failure(s)`);
  process.exitCode = failures.length ? 1 : 0;
} catch (e) {
  console.error(`FAIL - ${e?.message || e}`);
  process.exitCode = 1;
} finally {
  try { child.kill("SIGKILL"); } catch { /* stopped */ }
  await new Promise((resolve) => facilitator.close(resolve));
}
