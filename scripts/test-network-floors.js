#!/usr/bin/env node
// Offline test for per-chain price floors (src/network-floors.js) and the one
// funnel every accept is priced through (priceForNetwork in src/payments.js).
//
// The rule: a call on a floored chain (Robinhood Chain) is never priced below that chain's floor. Pinned here: the
// eip155:4663 accept is raised for a cheap tool and untouched for a dear one,
// no other chain moves, the metered per-request quote is floored too, a
// premium still only adds, and every surface that states the floor reads it.
import { strict as assert } from "node:assert";
import { networkPriceFloors, applyNetworkFloor, networkFloorUsd, ROBINHOOD_CAIP2, ROBINHOOD_MIN_PRICE_DEFAULT_USD } from "../src/network-floors.js";
import { acceptsForItem, priceForNetwork, parseNetworkPremiums, premiumUsdByNetworkName, premiumClause } from "../src/payments.js";

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const RH = ROBINHOOD_CAIP2, BASE = "eip155:8453", OP = "eip155:10";
const FLOOR = "$" + ROBINHOOD_MIN_PRICE_DEFAULT_USD;
const rails = { evmCaip2: [BASE, OP, RH], svmCaip2: [], stellarCaip2: [], avmCaip2: [], walletAddress: "0x0000000000000000000000000000000000000001" };
const priceOn = async (opt, req = {}) => (typeof opt.price === "function" ? opt.price({ adapter: { req, getBody: () => ({}) } }) : opt.price);

console.log("per-chain price floors");

await check("the default Robinhood floor is $0.006", () => {
  assert.equal(ROBINHOOD_MIN_PRICE_DEFAULT_USD, 0.006);
});

await check("default: Robinhood Chain carries the floor, no other chain does", () => {
  const f = networkPriceFloors({});
  assert.equal(f.size, 1);
  assert.equal(networkFloorUsd(RH, f), ROBINHOOD_MIN_PRICE_DEFAULT_USD);
  assert.equal(networkFloorUsd(BASE, f), 0);
});

await check("ROBINHOOD_MIN_PRICE_USD tunes it; \"0\" turns it off; a negative is refused for the default", () => {
  assert.equal(networkFloorUsd(RH, networkPriceFloors({ ROBINHOOD_MIN_PRICE_USD: "0.01" })), 0.01);
  assert.equal(networkPriceFloors({ ROBINHOOD_MIN_PRICE_USD: "0" }).size, 0);
  assert.equal(networkFloorUsd(RH, networkPriceFloors({ ROBINHOOD_MIN_PRICE_USD: "-1" })), ROBINHOOD_MIN_PRICE_DEFAULT_USD);
});

await check("applyNetworkFloor raises only below the floor, exactly, and leaves unreadable prices alone", () => {
  const f = networkPriceFloors({});
  assert.equal(applyNetworkFloor("$0.001", RH, f), FLOOR);
  assert.equal(applyNetworkFloor("$0.07", RH, f), "$0.07");
  assert.equal(applyNetworkFloor(FLOOR, RH, f), FLOOR);
  assert.equal(applyNetworkFloor("$0.001", BASE, f), "$0.001");
  assert.equal(applyNetworkFloor("free", RH, f), "free");
});

await check("a premium still only adds, and the floor applies after it", () => {
  const p = parseNetworkPremiums(`${RH}=0.001`), f = networkPriceFloors({});
  assert.equal(priceForNetwork("$0.001", RH, p, f), FLOOR, "0.001 + 0.001 is still below the floor");
  assert.equal(priceForNetwork("$0.07", RH, p, f), "$0.071");
  assert.equal(priceForNetwork("$0.001", OP, parseNetworkPremiums(`${OP}=0.001`), f), "$0.002", "Optimism keeps its premium and gets no floor");
});

await check("402: a $0.001 tool quotes the floor on eip155:4663 and $0.001 everywhere else", async () => {
  const opts = acceptsForItem({ slug: "cheap", price: "$0.001" }, rails);
  assert.equal(await priceOn(opts.find((o) => o.network === RH)), FLOOR);
  assert.equal(await priceOn(opts.find((o) => o.network === BASE)), "$0.001");
});

await check("402: a $0.07 tool quotes $0.07 on every chain, Robinhood included", async () => {
  const opts = acceptsForItem({ slug: "dear", price: "$0.07" }, rails);
  for (const o of opts.filter((x) => x.network !== OP)) assert.equal(await priceOn(o), "$0.07", o.network);
});

await check("402: a metered per-request quote is floored on eip155:4663 only", async () => {
  const item = { slug: "metered", price: "$0.001", quote: () => 0.002 };
  const opts = acceptsForItem(item, rails);
  assert.equal(await priceOn(opts.find((o) => o.network === RH), {}), FLOOR);
  assert.equal(await priceOn(opts.find((o) => o.network === BASE), {}), "$0.002");
  const big = acceptsForItem({ slug: "metered", price: "$0.001", quote: () => 0.09 }, rails);
  assert.equal(await priceOn(big.find((o) => o.network === RH), {}), "$0.09");
});

await check("every surface that states the floor reads the same constant", async () => {
  const { readFileSync } = await import("node:fs");
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  assert.match(src("server.js"), /minPriceUsdByNetwork: \{ robinhood: networkFloorUsd\(RH_FLOOR_CAIP2\) \}/, "/api/pricing");
  assert.match(src("server.js"), /floorUsd: caip2 \? networkFloorUsd\(caip2\) : 0/, "chain page extras");
  assert.match(src("seo.js"), /\$\{networkFloorUsd\(ROBINHOOD_CAIP2\)\}/, "llms.txt");
  assert.ok((src("guides.js").match(/\$\{networkFloorUsd\(ROBINHOOD_CAIP2\)\}/g) || []).length >= 2, "guides");
  const { guidePage } = await import("../src/guides.js");
  const g = guidePage("https://agent402.tools", "usdg-payments-robinhood-chain");
  assert.ok(String(g?.html ?? g).includes(`$${ROBINHOOD_MIN_PRICE_DEFAULT_USD}`), "the USDG guide prints the floor");
});

// The settlement premium a chain adds is on the machine price surfaces too,
// keyed by the chain's public name and derived from the same map the accepts
// builder prices through (scripts/test-accept-prices.js reads the booted
// surfaces; this pins the derivation and that every surface reads it).
await check("the premium map and clause derive from NETWORK_PRICE_PREMIUMS, by public network name", async () => {
  assert.deepEqual(premiumUsdByNetworkName(parseNetworkPremiums("")), {});
  assert.equal(premiumClause(parseNetworkPremiums("")), "");
  const p = parseNetworkPremiums("eip155:10=0.001,eip155:4663=0.002,eip155:999999=0.5");
  assert.deepEqual(premiumUsdByNetworkName(p), { optimism: 0.001, robinhood: 0.002 }, "a chain no network is named for is left out");
  const clause = premiumClause(p);
  assert.match(clause, /on Optimism every call quotes \$0\.001 above its list price/);
  assert.match(clause, /on Robinhood Chain every call quotes \$0\.002 above its list price/);
  const { readFileSync } = await import("node:fs");
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  assert.match(src("server.js"), /premiumUsdByNetwork: offered/, "/api/pricing publishes premiumUsdByNetwork beside minPriceUsdByNetwork");
  assert.match(src("seo.js"), /\$\{premiumClause\(\)\}/, "llms-full.txt");
  assert.match(src("seo.js"), /premiums\.get\(c\.caip2\)/, "the chain bullets read the premium map");
  assert.match(src("pages.js"), /premiumUsdByNetwork: premium/, "openapi x-payment-info");
  assert.match(src("pages.js"), /payment\.premiumUsdByNetwork/, "openapi guidance names the field");
  assert.match(src("mcp-http.js"), /\$\{premiumClause\(\)\}/, "MCP payment.info");
});

console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
