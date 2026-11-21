// The unproven-seller tier on the other EVM router chains
// (SOR_EVM_UNPROVEN_CHAINS, src/base-unproven.js): off for every chain the
// operator has not listed, a ceiling of its own, the same label, the same
// resolver recheck and the same payer checks as the Base lane, under the same
// per-seller and lane daily caps.
// Offline: stub sellers (stubbed fetch), a throwaway key, no network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "evm-unproven-chains-test-"));
process.env.OUTBOUND_LEDGER_FILE = join(scratch, "outbound-spend.ndjson");
process.env.WALLET_DAILY_LEDGER_FILE = join(scratch, "wallet-daily-spend.json");
process.env.SOR_ROUTER_PURCHASES_FILE = join(scratch, "router-purchases.json");
for (const k of Object.keys(process.env)) if (/^(SOR_|UPSTREAM_BUYER_LOW_USD)/.test(k)) delete process.env[k];
(await import("../src/tools/sanctions-kit.js")).__seedPayoutListForTests();
process.env.X402_UPSTREAM_BUYER_KEY = "0x" + randomBytes(32).toString("hex");

const chains = await import("../src/evm-buyer-chains.js");
const U = await import("../src/base-unproven.js");
const { dispatchEligibility } = await import("../src/dispatch-eligibility.js");
const buyer = await import("../src/x402-buyer.js");
const { payX402, getUpstreamBuyer, __setBuyerAddressGuardForTest, __resetSellerRefusalsForTest } = buyer;

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
__setBuyerAddressGuardForTest(false);
const OTHERS = Object.keys(chains.EVM_BUYER_CHAINS).filter((c) => c !== "base");

// --- the switch and the ceiling ------------------------------------------------
ok(typeof U.unprovenAllowanceUsdFor === "function" && typeof U.unprovenAllowanceAtomicFor === "function" && typeof U.evmUnprovenChains === "function", "base-unproven exports the per-chain ceiling");
const usdFor = (c) => (U.unprovenAllowanceUsdFor ? U.unprovenAllowanceUsdFor(c) : undefined);
ok(JSON.stringify(OTHERS.slice().sort()) === JSON.stringify(["arbitrum", "arc", "celo", "polygon", "robinhood"]), `the other EVM router chains are Celo, Polygon, Arbitrum, Arc and Robinhood (${OTHERS})`);
ok(OTHERS.every((c) => usdFor(c) === 0), "nothing listed: the tier is off on every chain but Base");
ok(usdFor("base") === U.baseUnprovenAllowanceUsd() && usdFor("base") > 0, "Base keeps its own ceiling");
ok(usdFor("solana") === 0 && usdFor("nonsense") === 0 && usdFor(undefined) === 0, "a chain outside the EVM buyer table has no ceiling here");
process.env.SOR_EVM_UNPROVEN_CHAINS = "celo, eip155:137 ,solana,nonsense,base";
ok(usdFor("celo") === 0.01 && usdFor("polygon") === 0.01 && U.EVM_UNPROVEN_DEFAULT_USD === 0.01, "a listed chain (by name or CAIP-2 id) is tried under the one-cent default");
ok(usdFor("arbitrum") === 0 && usdFor("arc") === 0 && usdFor("robinhood") === 0, "an unlisted chain stays off");
ok(JSON.stringify(U.evmUnprovenChains?.()) === '["celo","polygon"]', `the listed chains read back without Base or unknown names (${JSON.stringify(U.evmUnprovenChains?.())})`);
ok(U.unprovenAllowanceAtomicFor?.("celo") === 10000n && U.unprovenAllowanceAtomicFor?.("arbitrum") === 0n, "the atomic ceiling is the same figure at 6 decimals");
process.env.SOR_BASE_UNPROVEN_MAX_USD = "0.05";
ok(usdFor("celo") === 0.01 && usdFor("base") === 0.05, "Base's ceiling does not widen another chain's");
delete process.env.SOR_BASE_UNPROVEN_MAX_USD;
process.env.SOR_EVM_UNPROVEN_MAX_USD = "0.004"; ok(usdFor("celo") === 0.004 && usdFor("base") === U.baseUnprovenAllowanceUsd(), "SOR_EVM_UNPROVEN_MAX_USD sets the other chains' ceiling only");
process.env.SOR_EVM_UNPROVEN_MAX_USD = "abc"; ok(usdFor("celo") === 0.01, "a malformed ceiling reads as the default, never wider");
process.env.SOR_EVM_UNPROVEN_MAX_USD = "-1"; ok(usdFor("celo") === 0.01, "a negative ceiling reads as the default");
process.env.SOR_EVM_UNPROVEN_MAX_USD = "off"; ok(usdFor("celo") === 0, "'off' switches the other chains off");
process.env.SOR_EVM_UNPROVEN_MAX_USD = "0"; ok(usdFor("celo") === 0, "'0' switches the other chains off");
delete process.env.SOR_EVM_UNPROVEN_MAX_USD;

// --- the label: dispatchEligibility ---------------------------------------------
const verdictOn = (chain, over = {}) => dispatchEligibility({ routable: true, networks: [chains.EVM_BUYER_CHAINS[chain].caip2], settled: 2, payers: 1, priceUsd: 0.008, spendChains: [chain], minSettled: 50, minPayers: 3, ...over }).chains[chain];
{
  const celo = verdictOn("celo");
  ok(celo?.eligible === false && celo.reason === "settlement_required" && celo.unprovenTier === true && celo.unprovenMaxUsd === 0.01, `a listed chain's seller below the floor, priced within the ceiling, carries the tier (${JSON.stringify(celo)})`);
  ok(verdictOn("celo", { priceUsd: 0.02 })?.unprovenTier === undefined, "a price above the ceiling carries no tier");
  ok(verdictOn("arbitrum")?.unprovenTier === undefined && verdictOn("arbitrum")?.reason === "settlement_required", "an unlisted chain carries no tier");
  ok(verdictOn("celo", { settled: 500, payers: 9 })?.eligible === true && verdictOn("celo", { settled: 500, payers: 9 })?.unprovenTier === undefined, "CONTROL a seller above the floor is proven, with no tier");
  const W = "0x" + "1c".repeat(20), LIVE = "0x" + "2d".repeat(20);
  const mismatched = verdictOn("celo", { settled: 500, payers: 9, evidence: { byWallet: new Map([[W, { settled: 500, payers: 9 }]]) }, livePayToByChain: { celo: LIVE } });
  ok(mismatched?.eligible === false && mismatched?.unprovenTier === undefined, `a wallet problem is something else wrong: no tier (${JSON.stringify(mismatched)})`);
  ok(verdictOn("celo", { unprovenMaxUsdByChain: {} })?.unprovenTier === undefined, "a caller handing in no ceiling for the chain gets no tier");
  const base = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 2, payers: 1, priceUsd: 0.008, spendChains: ["base"], minSettled: 50, minPayers: 3 }).chains.base;
  ok(base?.unprovenTier === true && base.unprovenMaxUsd === U.baseUnprovenAllowanceUsd(), "CONTROL Base's own tier is unchanged");
}

// --- the resolver's recheck at the live payTo ------------------------------------
{
  const { unprovenLaneAtLivePayTo } = await import("../src/dispatch-eligibility.js");
  ok(typeof unprovenLaneAtLivePayTo === "function", "the resolver's recheck is one exported function");
  const row = { networks: ["eip155:42220"], settled: 2, payers: 1, priceUsd: 0.008, evmDomainByNetwork: { "eip155:42220": { name: "USDC", version: "2" } } };
  const LIVE = "0x" + "3e".repeat(20);
  const at = (chain, r, extra = {}) => unprovenLaneAtLivePayTo?.({ chain, row: r, livePayTo: LIVE, minSettled: 50, minPayers: 3, ...extra });
  ok(at("celo", row)?.unprovenTier === true, "a listed chain's candidate is admitted at its live payTo");
  ok(at("arbitrum", { ...row, networks: ["eip155:42161"] })?.unprovenTier !== true, "an unlisted chain's candidate is not");
  const shared = at("celo", { ...row, binding: { byWallet: new Map(), withheld: { byWallet: new Map([[LIVE, { settled: 900, payers: 40 }]]) } } });
  ok(shared?.unprovenTier !== true, `evidence withheld at a shared wallet keeps the candidate out of the lane (${JSON.stringify(shared)})`);
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(!/chain === "base" && r\.unproven/.test(src) && !/chain === "base" && verdict\.chains\.base\?\.unprovenTier/.test(src), "the resolver admits and rechecks an unproven candidate on the chain being paid, not on Base alone");
  ok(/unprovenLaneAtLivePayTo\(\{ chain,/.test(src), "the resolver rechecks through that function with the chain it is paying on");
}

// --- stub seller (the harness scripts/test-evm-buyer-chains.js uses) -------------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const PAYTO = "0x" + "4b".repeat(20);
const acceptOn = (chain, over = {}) => {
  const c = chains.EVM_BUYER_CHAINS[chain];
  return { scheme: "exact", network: c.caip2, asset: c.asset, amount: "8000", payTo: PAYTO, maxTimeoutSeconds: 300, extra: { name: c.domain.name, version: c.domain.version }, ...over };
};
let paidRequests = 0, lastPayload = null;
const realFetch = globalThis.fetch;
const seller = (accepts) => async (_url, init) => {
  const h = init?.headers || {};
  const sig = h["PAYMENT-SIGNATURE"] || h["payment-signature"] || h["X-PAYMENT"];
  const challenge = b64({ x402Version: 2, accepts });
  if (!sig) return { status: 402, headers: { get: (n) => (String(n).toLowerCase() === "payment-required" ? challenge : null) }, json: async () => ({}), text: async () => "{}" };
  paidRequests++;
  try { lastPayload = JSON.parse(Buffer.from(sig, "base64").toString("utf8")); } catch { lastPayload = null; }
  return new Response(JSON.stringify({ answer: 42 }), { status: 200, headers: { "content-type": "application/json", "payment-response": b64({ success: true, transaction: "0x" + "ab".repeat(32), network: accepts[0]?.network }) } });
};
const evm = await getUpstreamBuyer();
const realSign = evm.client.createPaymentPayload.bind(evm.client);
let signs = 0;
evm.client.createPaymentPayload = async (...a) => { signs++; return realSign(...a); };
const reset = () => { signs = 0; paidRequests = 0; lastPayload = null; __resetSellerRefusalsForTest(); };
const buy = (chain, accepts, extra = {}, host = `${chain}-seller.example`) => {
  globalThis.fetch = seller(accepts);
  return payX402(`https://${host}/x`, { maxAtomic: 500000n, method: "POST", body: {}, chain, ...extra }).then((r) => ({ r }), (e) => ({ e }));
};
process.env.SOR_EVM_CHAINS = "polygon,celo,arbitrum,arc,robinhood";

// --- the payer ---------------------------------------------------------------------
reset();
{
  const off = await buy("arbitrum", [acceptOn("arbitrum")], { allowUnproven: true });
  ok(off.e?.statusCode === 409 && /unproven lane is not on for arbitrum/.test(off.e.message) && signs === 0 && paidRequests === 0, `an unlisted chain is never paid in the lane (${off.e?.statusCode} ${off.e?.message})`);
  const over = await buy("celo", [acceptOn("celo", { amount: "20000" })], { allowUnproven: true });
  ok(over.e?.statusCode === 409 && /above the unproven ceiling 10000/.test(over.e.message) && signs === 0 && paidRequests === 0, `a quote above the chain's ceiling is refused on the accept being signed (${over.e?.statusCode} ${over.e?.message})`);
  const paid = await buy("celo", [acceptOn("celo")], { allowUnproven: true });
  ok(!paid.e && paid.r?.result?.answer === 42 && signs === 1 && paidRequests === 1 && lastPayload?.payload?.authorization?.value === "8000" && paid.r?.quote?.network === "eip155:42220", `a listed chain's seller within the ceiling is signed once, for the quote (${paid.e ? paid.e.message : "ok"})`);
  ok(Math.abs((await U.unprovenSellerSpentUsd({ payTo: PAYTO, origin: "https://celo-seller.example/x" })) - 0.008) < 1e-9, "the buy is booked against the seller's day");
  ok(Math.abs((await U.unprovenLaneSpentUsd()) - 0.008) < 1e-9, "and against the lane's day");
}
// The per-seller daily cap is one day across chains: a second chain in front
// of the same wallet buys no fresh day.
reset();
{
  process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD = "0.02";
  const two = await buy("celo", [acceptOn("celo")], { allowUnproven: true });
  ok(!two.e && signs === 1, `a second buy inside the seller's day is paid (${two.e?.message || "ok"})`);
  const three = await buy("celo", [acceptOn("celo")], { allowUnproven: true });
  ok(three.e?.statusCode === 409 && /daily cap per seller/.test(three.e.message) && signs === 1, `the seller's daily cap holds off Base (${three.e?.statusCode} ${three.e?.message})`);
  const other = await buy("polygon", [acceptOn("polygon")], { allowUnproven: true }, "polygon-front.example");
  ok(other.e?.statusCode === 409 && /daily cap per seller/.test(other.e.message) && signs === 1, `the same wallet on another chain shares that day (${other.e?.statusCode} ${other.e?.message})`);
  delete process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD;
}
// The lane's daily total holds across chains too.
reset();
{
  process.env.SOR_BASE_UNPROVEN_DAILY_USD = "0.02";
  const full = await buy("polygon", [acceptOn("polygon", { payTo: "0x" + "5c".repeat(20) })], { allowUnproven: true }, "polygon-other.example");
  ok(full.e?.statusCode === 409 && /daily cap across all sellers/.test(full.e.message) && signs === 0, `the lane's daily total holds off Base (${full.e?.statusCode} ${full.e?.message})`);
  delete process.env.SOR_BASE_UNPROVEN_DAILY_USD;
}
// A proven candidate on the same chain is untouched by the lane's ceiling.
reset();
{
  const proven = await buy("celo", [acceptOn("celo", { amount: "20000", payTo: "0x" + "6d".repeat(20) })], {}, "celo-proven.example");
  ok(!proven.e && signs === 1, `CONTROL a proven celo candidate above the unproven ceiling is paid (${proven.e?.message || "ok"})`);
}

// --- the legend names the listed chains, and only while one is listed -----------
{
  const { dispatchLegend } = await import("../src/dispatch-eligibility.js");
  const on = dispatchLegend({ spendChains: ["base", "celo", "polygon"] });
  ok(/celo, polygon/.test(on["routerDispatchByChain.<chain>.unprovenTier"] || ""), "the legend documents the tier on the listed chains");
  const saved = process.env.SOR_EVM_UNPROVEN_CHAINS; delete process.env.SOR_EVM_UNPROVEN_CHAINS;
  ok(dispatchLegend({ spendChains: ["base", "celo"] })["routerDispatchByChain.<chain>.unprovenTier"] === undefined, "and carries no such entry while none is listed");
  process.env.SOR_EVM_UNPROVEN_CHAINS = saved;
}

// --- the sentence public copy quotes ------------------------------------------------
{
  const { routingProofSentence } = await import("../src/routing-proof.js");
  const on = routingProofSentence();
  ok(/\$0\.01 a call on Celo and Polygon/.test(on), `the proof sentence names the listed chains with their ceiling (${on})`);
  delete process.env.SOR_EVM_UNPROVEN_CHAINS;
  const offS = routingProofSentence();
  ok(!/Celo|Polygon/.test(offS) && /on Base/.test(offS), "with nothing listed the sentence names no other chain");
}

// --- a booted server labels a listed chain's seller as callable in the lane -----
{
  globalThis.fetch = realFetch;
  const { writeFileSync } = await import("node:fs");
  const { bootServer } = await import("./lib/boot-server.js");
  const origin = "https://celo-unproven-seller.example";
  const now = Date.now();
  const entry = {
    manifest: { name: "Tide tables", homepage: origin }, fetchedAt: now, source: "manifest", error: null, history: [1, 1, 1, 1, 1],
    payToByNetwork: { "eip155:42220": "0x3D7718d5D868AF1Daae41D757244DE73DF72FB53" },
    evmDomainByNetwork: { "eip155:42220": { name: chains.EVM_BUYER_CHAINS.celo.domain.name, version: chains.EVM_BUYER_CHAINS.celo.domain.version } },
    tools: [{ seller: origin, method: "POST", route: "/v1/tide-table", slug: "tide-table", name: "Tide table", description: "Tide table for a harbor with high and low water times", category: "data", tags: [], price: 0.008, networks: ["eip155:42220"] }],
  };
  const dir = mkdtempSync(join(tmpdir(), "a402-evm-unproven-"));
  writeFileSync(join(dir, "x402-index-cache.ndjson"), [JSON.stringify({ savedAt: now, format: "ndjson-v1", origins: 1 }), JSON.stringify([origin, entry])].join("\n") + "\n");
  const bootEnv = { FREE_MODE: "true", INDEX_CACHE_FILE: join(dir, "x402-index-cache.json"), INDEX_FIRST_CRAWL_DELAY_MS: "999999999", X402_INDEX_CRAWL: "on", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", X402_ECONOMY_DB: join(dir, "econ.db"), SOR_EVM_CHAINS: "celo", SOR_EXTERNAL_ENABLED: "true" };
  const read = async (extra) => {
    const srv = await bootServer({ stores: "evm-unproven", env: { ...bootEnv, ...extra } });
    try {
      for (let i = 0; i < 120; i++) {
        try { const r = await fetch(`${srv.url}/api/index?seller=${encodeURIComponent(origin)}`); if (r.ok) return (await r.json()).tools?.[0] || null; } catch { /* booting */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      return null;
    } finally { await srv.stop(); }
  };
  const listed = await read({ SOR_EVM_UNPROVEN_CHAINS: "celo" });
  ok(listed?.routerDispatchByChain?.celo?.unprovenTier === true && listed.routerDispatchByChain.celo.unprovenMaxUsd === 0.01, `the seller's own tool row shows the tier on the listed chain (${JSON.stringify(listed?.routerDispatchByChain)})`);
  ok(!!listed?.executeVia && listed.executeViaCallableNow === true && listed.executeViaLane === "unproven", `and is callable now in the unproven lane (${JSON.stringify({ executeVia: !!listed?.executeVia, now: listed?.executeViaCallableNow, lane: listed?.executeViaLane })})`);
  const unlisted = await read({ SOR_EVM_UNPROVEN_CHAINS: "" });
  ok(unlisted?.routerDispatchByChain?.celo?.reason === "settlement_required" && unlisted.routerDispatchByChain.celo.unprovenTier === undefined && unlisted.executeViaCallableNow === false && unlisted.executeViaLane === undefined, `CONTROL unlisted, the same row is not callable (${JSON.stringify(unlisted?.routerDispatchByChain)})`);
}

console.log(`\ntest-evm-unproven-chains: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
