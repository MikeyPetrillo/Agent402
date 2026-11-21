#!/usr/bin/env node
// Offline test for per-chain price floors (src/network-floors.js) and the one
// funnel every accept is priced through (priceForNetwork in src/payments.js).
//
// The rule: no chain carries a floor by default, Robinhood Chain included, so
// every chain quotes the list price (plus its premium). A floor set by
// ROBINHOOD_MIN_PRICE_USD or NETWORK_PRICE_FLOORS still raises that chain's
// quote exactly as before: the eip155:4663 accept is raised for a cheap tool
// and untouched for a dear one, no other chain moves, the metered per-request
// quote is floored too, a premium still only adds, and every surface that
// states a floor reads it. Our own relayer's minimum sale price
// (ROBINHOOD_RELAYER_MIN_PRICE_USD) is parsed here too.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { childJson } from "./lib/child-json.js";
import { strict as assert } from "node:assert";
import { networkPriceFloors, applyNetworkFloor, networkFloorUsd, ROBINHOOD_CAIP2, ROBINHOOD_MIN_PRICE_DEFAULT_USD, ROBINHOOD_RELAYER_MIN_PRICE_DEFAULT_USD, robinhoodRelayerMinPriceUsd, robinhoodRelayerMinUnits } from "../src/network-floors.js";
import { acceptsForItem, priceForNetwork, parseNetworkPremiums, premiumUsdByNetworkName, premiumClause } from "../src/payments.js";

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const RH = ROBINHOOD_CAIP2, BASE = "eip155:8453", OP = "eip155:10";
// The floor the knob set in production before it was dropped, and the code
// default before that: setting either restores it exactly.
const OLD = { ROBINHOOD_MIN_PRICE_USD: "0.004" };
const FLOOR = "$0.004";
const rails = { evmCaip2: [BASE, OP, RH], svmCaip2: [], stellarCaip2: [], avmCaip2: [], walletAddress: "0x0000000000000000000000000000000000000001" };
const priceOn = async (opt, req = {}) => (typeof opt.price === "function" ? opt.price({ adapter: { req, getBody: () => ({}) } }) : opt.price);

console.log("per-chain price floors");

await check("no chain carries a floor by default, Robinhood Chain included", () => {
  assert.equal(ROBINHOOD_MIN_PRICE_DEFAULT_USD, 0);
  const f = networkPriceFloors({});
  assert.equal(f.size, 0);
  assert.equal(networkFloorUsd(RH, f), 0);
  assert.equal(networkFloorUsd(BASE, f), 0);
  assert.equal(applyNetworkFloor("$0.001", RH, f), "$0.001");
  assert.equal(networkPriceFloors({ ROBINHOOD_MIN_PRICE_USD: "" }).size, 0, "blank reads as unset");
});

await check("ROBINHOOD_MIN_PRICE_USD restores a floor exactly; \"0\" is none; a negative or malformed value is refused for the default (none)", () => {
  assert.equal(networkFloorUsd(RH, networkPriceFloors(OLD)), 0.004);
  assert.equal(networkFloorUsd(RH, networkPriceFloors({ ROBINHOOD_MIN_PRICE_USD: "0.006" })), 0.006);
  assert.equal(networkPriceFloors(OLD).size, 1, "Robinhood only");
  assert.equal(networkPriceFloors({ ROBINHOOD_MIN_PRICE_USD: "0" }).size, 0);
  assert.equal(networkPriceFloors({ ROBINHOOD_MIN_PRICE_USD: "-1" }).size, 0);
  assert.equal(networkPriceFloors({ ROBINHOOD_MIN_PRICE_USD: "abc" }).size, 0);
  assert.equal(networkFloorUsd(RH, networkPriceFloors({ NETWORK_PRICE_FLOORS: `${RH}=0.005` })), 0.005, "NETWORK_PRICE_FLOORS names it too");
});

await check("the relayer minimum: default $0.004 (4000 USDG base units), tunable, \"0\" any price, a bad value refused for the default", () => {
  assert.equal(ROBINHOOD_RELAYER_MIN_PRICE_DEFAULT_USD, 0.004);
  assert.equal(robinhoodRelayerMinPriceUsd({}), 0.004);
  assert.equal(robinhoodRelayerMinUnits({}), 4000n);
  assert.equal(robinhoodRelayerMinUnits({ ROBINHOOD_RELAYER_MIN_PRICE_USD: "0.01" }), 10000n);
  assert.equal(robinhoodRelayerMinUnits({ ROBINHOOD_RELAYER_MIN_PRICE_USD: "0" }), 0n);
  assert.equal(robinhoodRelayerMinUnits({ ROBINHOOD_RELAYER_MIN_PRICE_USD: "-1" }), 4000n);
  assert.equal(robinhoodRelayerMinUnits({ ROBINHOOD_RELAYER_MIN_PRICE_USD: "x" }), 4000n);
  assert.equal(robinhoodRelayerMinUnits({ ROBINHOOD_RELAYER_MIN_PRICE_USD: " " }), 4000n);
});

await check("applyNetworkFloor (floor set) raises only below the floor, exactly, and leaves unreadable prices alone", () => {
  const f = networkPriceFloors(OLD);
  assert.equal(applyNetworkFloor("$0.001", RH, f), FLOOR);
  assert.equal(applyNetworkFloor("$0.07", RH, f), "$0.07");
  assert.equal(applyNetworkFloor(FLOOR, RH, f), FLOOR);
  assert.equal(applyNetworkFloor("$0.001", BASE, f), "$0.001");
  assert.equal(applyNetworkFloor("free", RH, f), "free");
});

await check("a premium still only adds, and the floor applies after it", () => {
  const p = parseNetworkPremiums(`${RH}=0.001`), f = networkPriceFloors(OLD);
  assert.equal(priceForNetwork("$0.001", RH, p, f), FLOOR, "0.001 + 0.001 is still below the floor");
  assert.equal(priceForNetwork("$0.001", RH, p, networkPriceFloors({})), "$0.002", "no floor: list plus premium");
  assert.equal(priceForNetwork("$0.07", RH, p, f), "$0.071");
  assert.equal(priceForNetwork("$0.001", OP, parseNetworkPremiums(`${OP}=0.001`), f), "$0.002", "Optimism keeps its premium and gets no floor");
});

await check("402 (default, no floor): a $0.001 tool quotes $0.001 on eip155:4663 like every other chain", async () => {
  const opts = acceptsForItem({ slug: "cheap", price: "$0.001" }, rails);
  assert.equal(await priceOn(opts.find((o) => o.network === RH)), "$0.001");
  assert.equal(await priceOn(opts.find((o) => o.network === BASE)), "$0.001");
  const metered = acceptsForItem({ slug: "metered", price: "$0.001", quote: () => 0.002 }, rails);
  assert.equal(await priceOn(metered.find((o) => o.network === RH), {}), "$0.002", "a metered quote is not raised either");
});

await check("402 (default): the USDG money parser turns the $0.001 accept into 1000 base units on eip155:4663", async () => {
  const opts = acceptsForItem({ slug: "cheap", price: "$0.001" }, rails);
  const { makeUsdgScheme } = await import("../src/payments.js");
  const amount = await makeUsdgScheme().parsePrice(await priceOn(opts.find((o) => o.network === RH)), RH);
  assert.equal(String(amount.amount), "1000");
});

// With the knob set, a fresh process (the floors are read once at import)
// quotes exactly what the old floor quoted.
await check("ROBINHOOD_MIN_PRICE_USD=0.004 restores the old 402 exactly (fresh process): $0.001 -> 4000 base units on 4663, 1000 elsewhere", async () => {
  const { execFileSync } = await import("node:child_process");
  const code = `
    const { acceptsForItem, makeUsdgScheme } = await import(${JSON.stringify(new URL("../src/payments.js", import.meta.url).href)});
    const rails = ${JSON.stringify(rails)};
    const out = {};
    for (const [slug, price] of [["cheap", "$0.001"], ["dear", "$0.07"]]) {
      for (const o of acceptsForItem({ slug, price }, rails)) out[slug + "@" + o.network] = typeof o.price === "function" ? await o.price({ adapter: { req: {}, getBody: () => ({}) } }) : o.price;
    }
    out.units = String((await makeUsdgScheme().parsePrice(out["cheap@${RH}"], "${RH}")).amount);
    console.log(JSON.stringify(out));
    process.exit(0);`;
  const env = { ...process.env, ...OLD, NETWORK_PRICE_PREMIUMS: "", NETWORK_PRICE_FLOORS: "" };
  const out = childJson(execFileSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" }));
  assert.equal(out[`cheap@${RH}`], FLOOR);
  assert.equal(out[`cheap@${BASE}`], "$0.001");
  assert.equal(out[`dear@${RH}`], "$0.07");
  assert.equal(out.units, "4000");
});

await check("402 (floor set): a metered per-request quote is floored on eip155:4663 only", async () => {
  const f = networkPriceFloors(OLD);
  assert.equal(priceForNetwork("$0.002", RH, new Map(), f), FLOOR);
  assert.equal(priceForNetwork("$0.002", BASE, new Map(), f), "$0.002");
  assert.equal(priceForNetwork("$0.09", RH, new Map(), f), "$0.09");
});

await check("every surface that states a floor reads the same map, and states none by default", async () => {
  const { readFileSync } = await import("node:fs");
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  // Every offered chain's floor, by public name (a ROBINHOOD_MIN_PRICE_USD or NETWORK_PRICE_FLOORS entry).
  assert.match(src("server.js"), /publicNetworks\(\)\.map\(\(n\) => \[n, networkFloorUsd\(PAY_NETWORKS\[n\]\)\]\)\.filter\(\(\[, usd\]\) => usd > 0\)/, "/api/pricing");
  assert.match(src("server.js"), /\{ minPriceUsdByNetwork: floors \}/, "/api/pricing");
  assert.match(src("server.js"), /floorUsd: caip2 \? networkFloorUsd\(caip2\) : 0/, "chain page extras");
  // llms.txt states every floor once, in the x402 paragraph, from the floors
  // map; the chain list stays chain: asset (CAIP-2) only (test-legal-claims
  // pins that shape).
  const { floorClause, llmsTxt, llmsFullTxt } = await import("../src/seo.js");
  assert.equal(floorClause(new Map()), "", "no floor, no clause");
  assert.match(floorClause(new Map([[RH, 2000], [OP, 1500]])), /^on Robinhood Chain every call costs at least \$0\.002, the floor its 402 quotes; on Optimism every call costs at least \$0\.0015, the floor its 402 quotes$/, "each floored chain is named from the rails list");
  const llms = llmsFullTxt("https://agent402.tools", {});
  assert.ok(!/every call costs at least/.test(llms), "llms-full.txt states no floor by default");
  for (const t of [llms, llmsTxt("https://agent402.tools", {})]) assert.ok(!/^- \[[^\]]+\]\([^)]+\): [A-Z.]+ \(`[^`]+`\).+$/m.test(t), "no llms.txt chain line carries a floor or premium clause");
  assert.ok((src("guides.js").match(/\$\{networkFloorUsd\(ROBINHOOD_CAIP2\)\}/g) || []).length >= 2, "guides");
  assert.ok((src("guides.js").match(/networkFloorUsd\(ROBINHOOD_CAIP2\) > 0 \?/g) || []).length >= 2, "the guides state a floor only when one is set");
  const { guidePage } = await import("../src/guides.js");
  const g = String((guidePage("https://agent402.tools", "usdg-payments-robinhood-chain"))?.html ?? guidePage("https://agent402.tools", "usdg-payments-robinhood-chain"));
  assert.ok(!/whichever is higher/.test(g), "the USDG guide states no floor by default");
  assert.match(src("mcp-http.js"), /networkFloorUsd\(ROBINHOOD_CAIP2\) > 0 \?/, "MCP payment.info states a floor only when one is set");
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
  assert.doesNotMatch(src("seo.js"), /premiums\.get\(c\.caip2\)/, "the chain bullets stay bare; the premium is stated in the x402 paragraph");
  assert.match(src("pages.js"), /premiumUsdByNetwork: premium/, "openapi x-payment-info");
  assert.match(src("pages.js"), /payment\.premiumUsdByNetwork/, "openapi guidance names the field");
  assert.match(src("mcp-http.js"), /\$\{premiumClause\(\)\}/, "MCP payment.info");
});

// The /changelog page (and CHANGELOG.md, which test-changelog-parity holds to
// the same words) is read on servers that set the floor as well as on ones
// that do not, so an item that says Robinhood Chain quotes its list price
// states it only for a server that leaves ROBINHOOD_MIN_PRICE_USD unset, and
// says a server that sets it keeps that floor: both halves are what the code
// does, checked here beside the words.
await check("the changelog's Robinhood price item holds on a server that sets the floor and on one that does not", async () => {
  const { CHANGELOG_ENTRIES } = await import("../src/changelog.js");
  const items = CHANGELOG_ENTRIES.flatMap((e) => e.items || []).filter((i) => i.includes("eip155:4663") && /list price/.test(i) && i.includes("ROBINHOOD_MIN_PRICE_USD"));
  assert.ok(items.length >= 1, "the item that states Robinhood Chain's list price is found");
  for (const item of items) {
    const listPrice = item.split(/(?<=\.)\s+/).find((s) => /list price/.test(s)) || "";
    assert.match(listPrice, /leaves `?ROBINHOOD_MIN_PRICE_USD`? unset|without `?ROBINHOOD_MIN_PRICE_USD`?/, `the list-price sentence is scoped to a server without the floor: "${listPrice}"`);
    assert.match(item, /sets it keeps that floor/, "the item says a server that sets ROBINHOOD_MIN_PRICE_USD keeps that floor");
  }
  assert.equal(applyNetworkFloor("$0.001", RH, networkPriceFloors({})), "$0.001", "unset: the list price");
  assert.equal(applyNetworkFloor("$0.001", RH, networkPriceFloors(OLD)), FLOOR, "set: that floor");
});

// A floor, a premium and a relayer minimum are read through the same integer
// scaling the challenge is minted with (src/base-units.js), so a value whose
// float product sits just under a half (0.0040005 * 1e6 is 4000.4999...)
// gives the same micro-dollars in a floor as in the amount a buyer signs.
await check("floors, premiums and the relayer minimum scale a price as the minted amount does", async () => {
  const { usdToBaseUnits } = await import("../src/base-units.js");
  const EDGE = "0.0040005", want = Number(usdToBaseUnits(EDGE, 6));
  assert.equal(want, 4001, "the exact scaling rounds the half up");
  assert.notEqual(Math.round(Number(EDGE) * 1e6), want, "control: the float product rounds it down");
  assert.equal(networkPriceFloors({ NETWORK_PRICE_FLOORS: `${BASE}=${EDGE}` }).get(BASE), want, "NETWORK_PRICE_FLOORS");
  assert.equal(networkPriceFloors({ ROBINHOOD_MIN_PRICE_USD: EDGE }).get(RH), want, "ROBINHOOD_MIN_PRICE_USD");
  assert.equal(robinhoodRelayerMinUnits({ ROBINHOOD_RELAYER_MIN_PRICE_USD: EDGE }), BigInt(want), "the relayer minimum in base units");
  assert.equal(parseNetworkPremiums(`${OP}=${EDGE}`).get(OP), want, "NETWORK_PRICE_PREMIUMS");
  // A price at the edge is compared and added in the same units.
  const floors = new Map([[BASE, 4001]]);
  assert.equal(applyNetworkFloor(`$${EDGE}`, BASE, floors), `$${EDGE}`, "a price that scales to the floor is at the floor, and is left as quoted");
  assert.equal(priceForNetwork(`$${EDGE}`, OP, new Map([[OP, 1000]]), new Map()), "$0.005001", "a premium adds to the exact micro-dollars");
  // The guides' worked amounts are the same scaling of the catalog price: a
  // page rendered over a catalog priced at the edge prints the minted amount.
  const { howToPayPage } = await import("../src/how-to-pay.js");
  const { guidePage } = await import("../src/guides.js");
  const pay = howToPayPage("https://x.test", { "POST /api/hash": { slug: "hash", price: `$${EDGE}`, route: "POST /api/hash", name: "Hash", description: "d", category: "encoding" } });
  assert.ok(pay.includes(`&quot;amount&quot;:&quot;${want}&quot;`) && !pay.includes("&quot;amount&quot;:&quot;4000&quot;"), "the how-to-pay page's worked amount");
  const guide = guidePage("https://x.test", "x402-in-5-minutes", { "POST /api/extract": { slug: "extract", price: `$${EDGE}` } });
  assert.ok(guide.includes(String(want)) && !/\b4000\b/.test(guide), "the quickstart guide's worked amount");
});

console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
