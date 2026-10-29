#!/usr/bin/env node
// Offline test for the per-chain price premium engine in src/payments.js.
//
// The rule it implements: anything settled through a fee-charging facilitator
// must be priced to cover the fee. The failure modes worth pinning are all
// silent-money bugs: a premium leaking onto fee-free rails (overcharging every
// buyer), float arithmetic inventing dust ($0.0020000000000000005 breaks
// byte-exact quote matching), a malformed config quoting below cost, and the
// dormant default not being byte-identical to the pre-engine behavior.
import { strict as assert } from "node:assert";
import { parseNetworkPremiums, priceWithPremium, acceptsForItem } from "../src/payments.js";

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log("per-chain price premiums");

check("unset config -> empty map -> every price passes through untouched", () => {
  const p = parseNetworkPremiums("");
  assert.equal(p.size, 0);
  assert.equal(priceWithPremium("$0.001", "eip155:10", p), "$0.001");
});

check("configured chain gets exactly the premium, others do not", () => {
  const p = parseNetworkPremiums("eip155:10=0.001,eip155:130=0.002");
  assert.equal(priceWithPremium("$0.001", "eip155:10", p), "$0.002");
  assert.equal(priceWithPremium("$0.001", "eip155:130", p), "$0.003");
  assert.equal(priceWithPremium("$0.001", "eip155:8453", p), "$0.001", "fee-free Base must never carry a premium");
});

check("money arithmetic is exact — no float dust", () => {
  const p = parseNetworkPremiums("eip155:10=0.001");
  assert.equal(priceWithPremium("$0.002", "eip155:10", p), "$0.003");
  assert.equal(priceWithPremium("$0.1", "eip155:10", p), "$0.101");
  assert.equal(priceWithPremium("$0.50", "eip155:10", p), "$0.501");
  // the classic: 0.1 + 0.2 style dust must not appear
  assert.ok(!/000000|999999/.test(priceWithPremium("$0.29", "eip155:10", p)));
});

check("negative and malformed entries are refused, never quoted below cost", () => {
  const p = parseNetworkPremiums("eip155:10=-0.001,garbage,eip155:130=abc,eip155:480=0.001");
  assert.equal(p.has("eip155:10"), false, "negative premium must be refused");
  assert.equal(p.has("eip155:130"), false, "non-numeric premium must be refused");
  assert.equal(p.get("eip155:480"), 1000, "the valid entry still parses");
});

check("an unparseable price passes through unchanged rather than quoting NaN", () => {
  const p = parseNetworkPremiums("eip155:10=0.001");
  assert.equal(priceWithPremium("weird", "eip155:10", p), "weird");
  assert.equal(priceWithPremium(undefined, "eip155:10", p), undefined);
});

check("dormant default: acceptsForItem output is byte-identical to pre-engine", () => {
  // No NETWORK_PRICE_PREMIUMS in the environment -> the engine must be
  // invisible. This is the guard that today's deploy changes nothing.
  assert.equal(process.env.NETWORK_PRICE_PREMIUMS || "", "", "test assumes a clean env");
  const rails = {
    evmCaip2: ["eip155:8453", "eip155:42220"], svmCaip2: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
    stellarCaip2: [], avmCaip2: [], walletAddress: "0xw", solanaWallet: "So1",
  };
  const a = acceptsForItem({ slug: "x", price: "$0.001" }, rails);
  assert.deepEqual(a, [
    { scheme: "exact", payTo: "0xw", price: "$0.001", network: "eip155:8453" },
    { scheme: "exact", payTo: "0xw", price: "$0.001", network: "eip155:42220" },
    { scheme: "exact", payTo: "So1", price: "$0.001", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
  ]);
});


// ---- per-request quote (metered tier, 2026-08-26) --------------------------
await (async () => {
  const rails = { evmCaip2: ["eip155:8453", "eip155:10"], svmCaip2: [], stellarCaip2: [], avmCaip2: [], walletAddress: "0x" + "a".repeat(40), solanaWallet: null, stellarWallet: null, algorandWallet: null, uptoCaip2: ["eip155:8453"] };
  const item = { slug: "v1-chat-metered", price: "$0.001", quote: (body) => (body?.max_tokens === 2000 ? 0.058011 : 0.001) };
  const a = acceptsForItem(item, rails);
  const req = { body: { max_tokens: 2000 } };
  const ctx = { adapter: { req, getBody: () => req.body } };
  const base = a.find((o) => o.network === "eip155:8453" && o.scheme === "exact");
  const upto = a.find((o) => o.network === "eip155:8453" && o.scheme === "upto");
  const basePrice = await base.price(ctx);
  const uptoPrice = await upto.price(ctx);
  const smallPrice = await base.price({ adapter: { req: {}, getBody: () => ({ max_tokens: 5 }) } });
  const junkPrice = await base.price({ adapter: { req: {}, getBody: () => { throw new Error("no body"); } } });
  const premiumPrice = await a.find((o) => o.network === "eip155:10").price(ctx);
  check("quote(): every option advertises a price FUNCTION (exact + upto)", () => assert.ok(a.every((o) => typeof o.price === "function")));
  check("quote(): the price resolves from the request body", () => assert.equal(basePrice, "$0.058011"));
  check("quote(): the resolved quote is stashed on the request for the upto meter's ceiling", () => assert.equal(req.__meteredQuoteUsd, 0.058011));
  check("quote(): a different body resolves a different price (the paid retry is re-quoted on ITS body)", () => assert.equal(smallPrice, "$0.001"));
  check("quote(): the upto ceiling is the same quote", () => assert.equal(uptoPrice, "$0.058011"));
  check("quote(): an unreadable body falls back to the catalog floor, never throws", () => assert.equal(junkPrice, "$0.001"));
  check("quote(): chain premiums apply on top of the quote", () => assert.equal(premiumPrice, priceWithPremium("$0.058011", "eip155:10")));
})();

// ---- price by model: a flat chat route's tierQuote (2026-09-22) ------------
await (async () => {
  const { LLM_GATEWAY_TOOLS, TIERS } = await import("../src/tools/llm-gateway-kit.js");
  const base = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat");
  const nano = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano");
  const rails = { evmCaip2: ["eip155:8453", "eip155:10"], svmCaip2: [], stellarCaip2: [], avmCaip2: [], walletAddress: "0x" + "a".repeat(40), solanaWallet: null, stellarWallet: null, algorandWallet: null, uptoCaip2: ["eip155:8453"] };
  const a = acceptsForItem(base, rails);
  const priceFor = async (item, body, network = "eip155:8453", scheme = "exact") => {
    const req = { body };
    const opt = acceptsForItem(item, rails).find((o) => o.network === network && o.scheme === scheme);
    // A static price (a route that lost its price function) is returned as is, so the checks below fail by name.
    return { price: typeof opt.price === "function" ? await opt.price({ adapter: { req, getBody: () => req.body } }) : opt.price, req };
  };
  const opus = { model: "anthropic/claude-opus-5", messages: [{ role: "user", content: "hi" }] };
  const mini = { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] };
  const up = await priceFor(base, opus);
  const same = await priceFor(base, mini);
  const upUpto = await priceFor(base, opus, "eip155:8453", "upto");
  const upPremium = await priceFor(base, opus, "eip155:10");
  const nanoUp = await priceFor(nano, opus);
  const junkOpt = acceptsForItem(base, rails).find((o) => o.network === "eip155:8453");
  const junk = typeof junkOpt.price === "function" ? await junkOpt.price({ adapter: { req: {}, getBody: () => { throw new Error("no body"); } } }) : junkOpt.price;
  check("tierQuote(): a flat route advertises a price FUNCTION on every option (exact + upto)", () => assert.ok(a.every((o) => typeof o.price === "function")));
  check("tierQuote(): base route + premium model resolves the premium price", () => assert.equal(up.price, "$0.5"));
  check("tierQuote(): the resolved price is stashed for the handler and the upto ceiling", () => assert.equal(up.req.__meteredQuoteUsd, TIERS["v1-chat-premium"].price));
  check("tierQuote(): base route + base model resolves the base price, unchanged", () => { assert.equal(same.price, "$0.02"); assert.equal(same.req.__meteredQuoteUsd, 0.02); });
  check("tierQuote(): the upto ceiling is the same home-tier price", () => assert.equal(upUpto.price, "$0.5"));
  check("tierQuote(): chain premiums apply on top of the home-tier price", () => assert.equal(upPremium.price, priceWithPremium("$0.5", "eip155:10")));
  check("tierQuote(): nano route + premium model resolves the premium price", () => assert.equal(nanoUp.price, "$0.5"));
  check("tierQuote(): an unreadable body falls back to the route's catalog price, never throws", () => assert.equal(junk, "$0.02"));
})();

// The public premium surfaces (/api/pricing, openapi x-payment-info,
// llms-full.txt, the connector's payment.info) read one helper over the
// OFFERED networks (src/public-networks.js), so a boot offering fewer rails
// quotes the same premiums on every surface: none for a chain it does not
// offer, the premium everywhere for one it does.
await (async () => {
  console.log("public premium surfaces");
  process.env.NETWORK_PRICE_PREMIUMS = "eip155:10=0.001";
  const { premiumUsdByNetworkName, premiumClause } = await import("../src/payments.js");
  const { publicNetworks, publicPremiumUsdByNetwork, publicPremiumClause } = await import("../src/public-networks.js");
  const { llmsFullTxt } = await import("../src/seo.js");
  const { openapiSpec } = await import("../src/pages.js");
  const { readFileSync } = await import("node:fs");
  const catalog = { "GET /api/uuid": { route: "GET /api/uuid", slug: "uuid", name: "uuid", category: "util", price: "$0.001", description: "d", tags: [], discovery: { inputSchema: {}, example: {} }, handler: async () => ({}) } };
  const premium = () => openapiSpec("http://x", catalog).paths["/api/uuid"]?.get?.["x-payment-info"]?.premiumUsdByNetwork;
  check("premiumUsdByNetworkName / premiumClause take the network names to keep", () => {
    const p = parseNetworkPremiums("eip155:10=0.001");
    assert.deepEqual(premiumUsdByNetworkName(p), { optimism: 0.001 });
    assert.deepEqual(premiumUsdByNetworkName(p, ["base"]), {});
    assert.deepEqual(premiumUsdByNetworkName(p, ["base", "optimism"]), { optimism: 0.001 });
    assert.equal(premiumClause(p, ["base"]), "");
    assert.match(premiumClause(p, ["optimism"]), /Optimism/);
  });
  process.env.PAYMENT_NETWORKS = "base";
  check("a boot offering Base alone quotes no premium on any surface", () => {
    assert.deepEqual(publicNetworks(), ["base"]);
    assert.deepEqual(publicPremiumUsdByNetwork(), {});
    assert.equal(publicPremiumClause(), "");
    assert.equal(premium(), undefined, "openapi x-payment-info");
    assert.ok(!/payment\.premiumUsdByNetwork/.test(llmsFullTxt("http://x", catalog)), "llms-full.txt");
  });
  process.env.PAYMENT_NETWORKS = "base,optimism";
  check("a boot offering Optimism quotes its premium on every surface, from the one helper", () => {
    assert.deepEqual(publicPremiumUsdByNetwork(), { optimism: 0.001 });
    assert.match(publicPremiumClause(), /on Optimism every call quotes \$0\.001 above its list price/);
    assert.deepEqual(premium(), { optimism: 0.001 }, "openapi x-payment-info");
    assert.match(llmsFullTxt("http://x", catalog), /payment\.premiumUsdByNetwork[^\n]*on Optimism every call quotes \$0\.001/, "llms-full.txt");
  });
  check("/api/pricing and the connector's payment.info read the same helper", () => {
    const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
    const mcp = readFileSync(new URL("../src/mcp-http.js", import.meta.url), "utf8");
    assert.match(server, /premiumUsdByNetwork: offered/);
    assert.match(server, /const offered = publicPremiumUsdByNetwork\(\)/);
    assert.ok(!/premiumUsdByNetworkName\(\)/.test(server), "/api/pricing no longer filters a full map by hand");
    assert.match(mcp, /import \{ publicPremiumClause as premiumClause \} from "\.\/public-networks\.js"/);
    assert.ok(!/from "\.\/payments\.js"/.test(mcp), "the connector reads no unfiltered premium helper");
  });
  delete process.env.NETWORK_PRICE_PREMIUMS;
  delete process.env.PAYMENT_NETWORKS;
})();

console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
