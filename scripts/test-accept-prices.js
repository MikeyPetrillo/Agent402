#!/usr/bin/env node
// Every accept of every paid route's 402 asks the amount the machine price
// surfaces publish: list (or the quoted range) plus the chain's settlement
// premium, raised to the chain's floor, both read from /api/pricing. Boots
// the real server on three rails (Base, Optimism with a premium, Robinhood
// Chain with no floor, the default) against a local /supported stub; no
// payment is made. A second, short boot sets ROBINHOOD_MIN_PRICE_USD and
// reads that the floor comes back exactly where it was.
// The premium is also on llms.txt, the openapi document and the connector's
// payment.info, derived from the same map.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { bootServer } from "./lib/boot-server.js";
import { NETWORKS } from "../src/payments.js";

const OP = "eip155:10", RH = "eip155:4663", BASE_NET = "eip155:8453";
const PREMIUM_USD = 0.001;
const CONCURRENCY = 12;
let base = "";
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
await new Promise((resolve) => facilitator.listen(0, "127.0.0.1", resolve));
const facPort = facilitator.address().port;
const stub = `http://127.0.0.1:${facPort}`;

// The servers inherit this process's environment: these are removed from it
// (not blanked), so each boot reads them unset.
for (const k of ["STATE_DATABASE_URL", "REDIS_URL", "ROBINHOOD_MIN_PRICE_USD", "NETWORK_PRICE_FLOORS", "NETWORK_PRICE_PREMIUMS"]) delete process.env[k];
// Boot on port 0; `log` reads the server's output so far.
async function boot(label, extraEnv = {}) {
  const srv = await bootServer({
    stores: label,
    env: {
      FREE_MODE: "", NODE_ENV: "test",
      NETWORK: "base", PAYMENT_NETWORKS: "base,optimism,robinhood",
      WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
      FACILITATOR_URL: stub, SOLVADOR_KEY: "test-key", SOLVADOR_FACILITATOR_URL: stub, ROBINHOOD_FACILITATOR_URL: stub,
      NETWORK_PRICE_PREMIUMS: `${OP}=${PREMIUM_USD}`,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "",
      MPP_SECRET_KEY: "test-accept-prices-secret",
      OPENROUTER_TTS_ENABLED: "true", X_BEARER_TOKEN: "test", APOLLO_API_KEY: "test",
      FACILITATOR_GAS_CHECK: "off", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
      MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", STATS_ALLOW_EPHEMERAL: "true",
      ...extraEnv,
    },
  }).catch((e) => { throw new Error(`server did not boot: ${String(e.message).slice(-1200)}`); });
  return { child: srv.child, url: srv.url, get log() { return srv.log(); } };
}
const rhAmountOf = async (url, path, method = "POST") => {
  const r = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
  const pr = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8"));
  const by = Object.fromEntries((pr.accepts || []).filter((a) => a.scheme === "exact").map((a) => [a.network, a.amount]));
  return by;
};
let main = null;
let knob = null;

const failures = [];
const fail = (where, problem) => failures.push(`${where}: ${problem}`);

try {
  main = await boot("accept-prices");
  base = main.url;

  const pricing = await (await fetch(`${base}/api/pricing`)).json();
  const endpoints = Array.isArray(pricing.endpoints) ? pricing.endpoints : [];
  if (endpoints.length < 400) throw new Error(`/api/pricing listed ${endpoints.length} endpoints`);
  const premiums = pricing.payment?.premiumUsdByNetwork || {};
  const floors = pricing.payment?.minPriceUsdByNetwork || {};
  if (JSON.stringify(premiums) !== JSON.stringify({ optimism: PREMIUM_USD })) fail("/api/pricing", `payment.premiumUsdByNetwork is ${JSON.stringify(premiums)}, expected the configured premium under its public name`);
  if (Object.keys(floors).length) fail("/api/pricing", `payment.minPriceUsdByNetwork names a floor with none set (${JSON.stringify(floors)})`);
  if (!Array.isArray(pricing.payment?.networks) || !["base", "optimism", "robinhood"].every((n) => pricing.payment.networks.includes(n))) {
    throw new Error(`the boot does not offer all three rails (${JSON.stringify(pricing.payment?.networks)}): ${main.log.split("\n").filter((l) => /dropped|WARNING/.test(l)).slice(0, 6).join(" | ")}`);
  }

  // The amount one network asks for a price: list plus its premium, raised to its floor.
  const expectMicro = (usd, network) => {
    const name = nameOf[network] || "";
    return Math.max(microOf(usd) + microOf(premiums[name] || 0), microOf(floors[name] || 0));
  };

  let cursor = 0, acceptsChecked = 0, networksSeen = new Set(), quotedChecked = 0;
  // Routes whose eip155:4663 exact amount is under the $0.004 the floor used
  // to raise it to: the listings whose Robinhood amount this change lowers.
  const OLD_FLOOR_UNITS = 4000;
  const underOldFloor = new Set();
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
        if (a.network === RH && a.scheme === "exact" && amount < OLD_FLOOR_UNITS) underOldFloor.add(route);
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
  if (/every call costs at least \$/.test(llms)) fail("/llms.txt", "names a floor with none set");
  if (/\[Optimism\]\([^)]*\): USDC \(`eip155:10`\);/.test(llms)) fail("/llms.txt", "a chain bullet carries a clause");
  const llmsFull = await (await fetch(`${base}/llms-full.txt`)).text();
  if (!/on Optimism every call quotes \$0\.001 above its list price/.test(llmsFull) || !/premiumUsdByNetwork/.test(llmsFull)) fail("/llms-full.txt", "does not name the Optimism premium and the /api/pricing field");
  const openapi = await (await fetch(`${base}/openapi.json`)).json();
  if (!/premiumUsdByNetwork/.test(String(openapi?.info?.["x-guidance"] || ""))) fail("/openapi.json", "info.x-guidance does not name payment.premiumUsdByNetwork");
  const op = openapi?.paths?.["/api/hash"]?.post?.["x-payment-info"];
  if (JSON.stringify(op?.premiumUsdByNetwork) !== JSON.stringify({ optimism: PREMIUM_USD })) fail("/openapi.json", `POST /api/hash x-payment-info.premiumUsdByNetwork is ${JSON.stringify(op?.premiumUsdByNetwork)}`);
  const mcp = await (await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "payment.info", arguments: {} } }) })).text();
  if (!/on Optimism every call quotes \$0\.001 above its list price/.test(mcp) || !/premiumUsdByNetwork/.test(mcp)) fail("/mcp payment.info", "does not name the Optimism premium and the /api/pricing field");

  // A $0.001 route asks 1000 USDG base units on Robinhood, exactly what it
  // asks on Base (no floor).
  const cheap = await rhAmountOf(base, "/api/hash");
  if (cheap[RH] !== "1000" || cheap[BASE_NET] !== "1000") fail("POST /api/hash", `asks ${cheap[RH]} on ${RH} and ${cheap[BASE_NET]} on Base; expected 1000 on both`);
  console.log(`routes whose ${RH} amount is under the old $0.004 floor (now their list price): ${underOldFloor.size}`);

  // The knob restores the floor exactly: a second boot with
  // ROBINHOOD_MIN_PRICE_USD=0.004 asks 4000 on Robinhood for the same route,
  // 1000 on Base, and publishes the floor on /api/pricing and llms.txt.
  knob = await boot("accept-prices-knob", { ROBINHOOD_MIN_PRICE_USD: "0.004" });
  const knobBase = knob.url;
  const k = await rhAmountOf(knobBase, "/api/hash");
  if (k[RH] !== "4000" || k[BASE_NET] !== "1000") fail("knob boot POST /api/hash", `asks ${k[RH]} on ${RH} and ${k[BASE_NET]} on Base; expected 4000 and 1000`);
  const kp = await (await fetch(`${knobBase}/api/pricing`)).json();
  if (JSON.stringify(kp.payment?.minPriceUsdByNetwork) !== JSON.stringify({ robinhood: 0.004 })) fail("knob boot /api/pricing", `minPriceUsdByNetwork is ${JSON.stringify(kp.payment?.minPriceUsdByNetwork)}`);
  if (!/on Robinhood Chain every call costs at least \$0\.004/.test(await (await fetch(`${knobBase}/llms.txt`)).text())) fail("knob boot /llms.txt", "does not name the restored floor");

  console.log(`accepts checked: ${acceptsChecked} on ${networksSeen.size} networks across ${endpoints.length} routes (${quotedChecked} on quoted routes)`);
  for (const problem of failures.slice(0, 40)) console.error(`FAIL - ${problem}`);
  if (failures.length > 40) console.error(`... ${failures.length - 40} more failure(s)`);
  console.log(`${failures.length ? "FAILED" : "OK"}: ${failures.length} failure(s)`);
  process.exitCode = failures.length ? 1 : 0;
} catch (e) {
  console.error(`FAIL - ${e?.message || e}`);
  process.exitCode = 1;
} finally {
  try { main?.child.kill("SIGKILL"); } catch { /* stopped */ }
  try { knob?.child.kill("SIGKILL"); } catch { /* stopped */ }
  await new Promise((resolve) => facilitator.close(resolve));
}
