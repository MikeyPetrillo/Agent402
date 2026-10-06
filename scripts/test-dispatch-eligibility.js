#!/usr/bin/env node
// Router dispatch eligibility, labelled (src/dispatch-eligibility.js).
// Fixtures are the rows an outside public-facts readout (2026-09-02) found a
// buyer agent over-reading on our own surfaces, so the label that would have
// prevented each misreading is pinned by name.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dispatchEligibility, spendChainsOf, SPEND_CHAIN_BY_NETWORK, DISPATCH_REASONS, dispatchLegend } from "../src/dispatch-eligibility.js";
import { EXTERNAL_CHAIN_BY_NETWORK } from "../src/tools/route-execute.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const all = ["base", "solana", "algorand", "tempo"];

// The chain map cannot drift from the one route-execute pays with.
for (const [net, chain] of Object.entries(EXTERNAL_CHAIN_BY_NETWORK)) ok(SPEND_CHAIN_BY_NETWORK[net] === chain, `network ${net} maps to ${chain} in both modules`);
ok(spendChainsOf(["eip155:8453", SOL, "eip155:1"]).join(",") === "base,solana", "spendChainsOf keeps only chains a wallet can pay, in order, deduped");

// x402video / researcher.now / viridis: routable, healthy, NO networks.
{
  const v = dispatchEligibility({ routable: true, networks: [], settled: 0, spendChains: all });
  ok(v.eligible === false && v.reason === "network_unknown", "routable + no networks -> not eligible, network_unknown (the readout's first three rows)");
}
// conc-exe: routable false, networks + 38 calls / 7 payers in 30 days.
{
  const v = dispatchEligibility({ routable: false, networks: ["eip155:8453", SOL], settled: 38, payers: 7, spendChains: all });
  ok(v.eligible === false && v.reason === "crawl_failed" && v.chains.base?.reason === "crawl_failed", "settlement history + failed crawl -> crawl_failed (proven past activity is not current dispatchability)");
}
// an OCR seller (Base): routable, 3,769 calls, 5 payers -> eligible on Base.
{
  const v = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 3769, payers: 5, spendChains: all });
  ok(v.eligible === true && v.reason === "eligible" && v.chain === "base" && v.chains.base.eligible, "Base seller above the floor with breadth -> eligible");
  ok(v.basis.settled === 3769 && v.basis.payers === 5 && v.basis.minSettled === 50, "the basis names the numbers the verdict rests on");
}
// A Base seller under the floor.
{
  const v = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 12, payers: 4, spendChains: all });
  ok(v.eligible === false && v.reason === "settlement_required" && /floor/.test(v.chains.base.detail), "Base seller below the floor -> settlement_required with the gate's own detail");
  const w = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 500, payers: 1, spendChains: all });
  ok(w.eligible === false && w.reason === "settlement_required" && /distinct payer/.test(w.chains.base.detail), "count without breadth is settlement_required too (one wallet can manufacture a count)");
}
// A Solana-only seller: the router tries it; proof is read at pay time.
{
  const v = dispatchEligibility({ routable: true, networks: [SOL], settled: 0, spendChains: all });
  ok(v.eligible === true && v.reason === "settlement_checked_at_pay_time" && v.chain === "solana", "Solana-only seller -> eligible, settlement_checked_at_pay_time");
  const w = dispatchEligibility({ routable: true, networks: [SOL], settled: 0, spendChains: ["base"] });
  ok(w.eligible === false && w.reason === "no_supported_route", "the same seller on a host with no Solana wallet -> no_supported_route");
}
// Base below the floor AND Solana advertised: eligible via Solana, Base reason kept per chain.
{
  const v = dispatchEligibility({ routable: true, networks: ["eip155:8453", SOL], settled: 3, spendChains: all });
  ok(v.eligible === true && v.chain === "solana" && v.chains.base.reason === "settlement_required", "multi-chain: eligible on the chain that admits it, the other chain's reason still visible");
}
// Row-level blocks.
{
  const a = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 999, payers: 9, priceUsd: 0, spendChains: all });
  ok(a.eligible === false && a.reason === "price_unknown", "a route row with no known price -> price_unknown (the OCR seller's second row)");
  const b = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 999, payers: 9, priceUsd: 0.05, urlTemplate: true, spendChains: all });
  ok(b.eligible === false && b.reason === "url_template", "an unsubstituted path template is never spent against");
  const c = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 999, payers: 9, spendChains: all });
  ok(c.eligible === true, "seller-level (no price passed) is not blocked by price");
}
// Local row.
ok(dispatchEligibility({ local: true }).reason === "local_catalog" && dispatchEligibility({ local: true }).eligible === true, "this host's own row is local_catalog");
// Shared-wallet evidence is bound to its wallet (2026-09-03; the full fixture
// lives in test-sor-payto-binding.js). Here: the label surface only.
{
  const W = "0x" + "aa".repeat(20), X = "0x" + "bb".repeat(20);
  const evidence = { byWallet: new Map([[W, { settled: 5000, payers: 40 }]]), ownSettled: 0, ownPayers: undefined };
  const at = (livePayTo) => dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 5000, payers: 40, spendChains: all, evidence, livePayTo });
  ok(at(W).eligible === true && at(X).eligible === false && at(X).reason === "settlement_required" && at(X).chains.base.detail === "evidence_payto_mismatch", "history inherited from wallet W counts only for an origin paid at W; paid at X reads settlement_required (evidence_payto_mismatch)");
  ok(at(null).eligible === false && at(null).chains.base.detail === "evidence_payto_unverified", "and an unreadable own address reads settlement_required (evidence_payto_unverified), never eligible");
  ok(dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 5000, payers: 40, spendChains: all, evidence: { byWallet: new Map([[W, { settled: 5000, payers: 40 }], [X, { settled: 1, payers: 1 }]]) }, livePayTo: X }).eligible === false, "a wallet credited beside a clearing one is judged on its OWN evidence (per wallet, never the union)");
}
// A Base accept under the wrong EIP-712 domain name (a seller, 2026-09-10):
// unpayable by every stock buyer, whatever its settlement history says.
{
  const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const wrong = { asset: BASE_USDC, name: "USDC" }, right = { asset: BASE_USDC, name: "USD Coin" };
  const v = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 5000, payers: 40, spendChains: all, usdcDomain: wrong });
  ok(v.eligible === false && v.reason === "usdc_domain_mismatch" && v.chains.base.reason === "usdc_domain_mismatch", "a Base seller above the floor whose accept names \"USDC\" is refused usdc_domain_mismatch (history cannot make an unsignable accept payable)");
  ok(/"USDC"/.test(v.chains.base.detail) && /"USD Coin"/.test(v.chains.base.detail) && v.chains.base.advertisedName === "USDC" && v.chains.base.expectedName === "USD Coin", "the Base verdict names the advertised and the expected domain name");
  ok(dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 5000, payers: 40, spendChains: all, usdcDomain: right }).eligible === true, "the same seller naming \"USD Coin\" is eligible");
  ok(dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 5000, payers: 40, spendChains: all, usdcDomain: null }).eligible === true && dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 5000, payers: 40, spendChains: all }).eligible === true, "no observation (null / omitted) decides nothing");
  ok(dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 5000, payers: 40, spendChains: all, usdcDomain: { asset: "0x" + "ab".repeat(20), name: "USDC" } }).eligible === true, "another asset on Base is unknown, never a refusal");
  const below = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 3, spendChains: all, usdcDomain: wrong });
  ok(below.reason === "usdc_domain_mismatch", "a wrong domain outranks settlement_required (it is the thing to fix first, and it explains the missing history)");
  const multi = dispatchEligibility({ routable: true, networks: ["eip155:8453", SOL], settled: 5000, payers: 40, spendChains: all, usdcDomain: wrong });
  ok(multi.eligible === true && multi.chain === "solana" && multi.chains.base.reason === "usdc_domain_mismatch", "a seller also on Solana stays eligible there; the Base reason is still visible per chain");
  ok(dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0, spendChains: all, usdcDomain: wrong }).reason === "price_unknown", "row-level blocks (price, template) still come first: nothing about the accept matters on a row the router never spends against");
  ok(typeof dispatchLegend().evmDomainByNetwork === "string" && /usdc_domain_mismatch/.test(dispatchLegend().evmDomainByNetwork), "the legend explains evmDomainByNetwork and names the reason it feeds");
}
// Unknown networks that are not spend chains at all.
{
  const v = dispatchEligibility({ routable: true, networks: ["eip155:1"], settled: 100, payers: 5, spendChains: all });
  ok(v.eligible === false && v.reason === "no_supported_route", "a seller on a chain we hold no wallet for -> no_supported_route, never network_unknown");
}
// Every reason the function can emit is in the published legend.
{
  const src = readFileSync(new URL("../src/dispatch-eligibility.js", import.meta.url), "utf8");
  const emitted = [...src.matchAll(/reason: "([a-z_]+)"/g)].map((m) => m[1]);
  for (const r of new Set(emitted)) ok(r in DISPATCH_REASONS, `reason "${r}" is documented in DISPATCH_REASONS`);
  const legend = dispatchLegend();
  ok(legend.routerDispatchReason === DISPATCH_REASONS && /crawl readiness/.test(legend.routable), "the legend ships the reason vocabulary and says what routable means");
}
// routerDispatchByChain is keyed by the chains THIS host can pay on, and the
// legend must say so (issue #1376, 2026-09-17: an outside reader measured two
// sellers declaring nano:mainnet, saw the map name only base, and read that as
// the router ignoring the seller's other chains. The map was right; the legend
// had never said what its keys were).
{
  const all = ["base", "solana", "algorand", "tempo"];
  // The report's own fixtures: a Nano-first seller and a five-chain seller.
  const nanoFirst = dispatchEligibility({ routable: true, networks: ["nano:mainnet", "eip155:8453", "eip155:1"], settled: 0, spendChains: all });
  ok(Object.keys(nanoFirst.chains).join() === "base" && nanoFirst.reason === "settlement_required", "a Nano-first seller that also advertises Base is judged on base alone; nano is absent from the map, not refused in it");
  const fiveChain = dispatchEligibility({ routable: true, networks: ["eip155:8453", "eip155:137", "eip155:42161", "nano:mainnet", "eip155:196"], settled: 100, payers: 5, spendChains: all });
  ok(Object.keys(fiveChain.chains).join() === "base" && fiveChain.eligible === true, "a five-chain seller's map names only the chain we can pay on");
  const nanoOnly = dispatchEligibility({ routable: true, networks: ["nano:mainnet"], settled: 100, payers: 5, spendChains: all });
  ok(nanoOnly.reason === "no_supported_route" && Object.keys(nanoOnly.chains).length === 0, "a Nano-only seller reads no_supported_route with an empty map");
  const legend = dispatchLegend({ spendChains: all });
  ok(Array.isArray(legend.routerSpendChains) && legend.routerSpendChains.join() === all.join(), "the legend lists the chains this host holds a spending wallet for");
  ok(/base, solana, algorand, tempo/.test(legend.routerDispatchByChain) && /missing from this map/.test(legend.routerDispatchByChain) && /cannot pay on/.test(legend.routerDispatchByChain), "the legend says the map is keyed by those chains and that a missing chain is unpayable here, never a verdict");
  ok(/no_supported_route/.test(legend.routerDispatchByChain), "the legend names the reason a seller outside that set reads");
  const dflt = dispatchLegend();
  ok(dflt.routerSpendChains.join() === "base" && /\(base\)/.test(dflt.routerDispatchByChain), "with no chains given the legend names base alone (the one wallet every host has)");
  ok(dispatchLegend({ spendChains: [] }).routerSpendChains.join() === "base", "an empty chain list falls back to base rather than publishing an empty set");
  // server.js hands the legend its live chain set at every call site, so the
  // published list cannot drift from the set the verdicts are computed on.
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const calls = (server.match(/\bdispatchLegend\(/g) || []).length;
  const wired = (server.match(/\bdispatchLegend\(\{ spendChains: spendChainsConfigured\(\) \}\)/g) || []).length;
  ok(calls >= 3 && wired === calls, `every dispatchLegend call in server.js passes spendChainsConfigured() (${wired} of ${calls} sites)`);
}
// The resolver's Base gate goes through this function (pinned from source).
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = server.slice(server.indexOf("async function resolveExternalSeller("), server.indexOf("async function diagnoseExternalSeller("));
  // Not anchored to one expression any more: the filter became a block when it
  // started tallying WHY it drops a candidate. What must not move is the
  // decision, so the comparison is pinned on its own AND the fail-open form is
  // forbidden by name. The first cut of that refactor wrote `!== false`, which
  // admits an undefined verdict and turns this fail-closed gate fail-open on a
  // spend path; a pin that only checked "calls dispatchEligibility" passed it.
  ok(/dispatchEligibility\(\{ routable: true, networks: r\.networks, settled: r\.settled, payers: r\.payers/.test(fn) && /\.chains\.base\?\.eligible === true/.test(fn), "resolveExternalSeller's Base gate is dispatchEligibility's Base verdict (label == decision)");
  ok(!/\.chains\.base\?\.eligible !== false/.test(fn), "the Base gate compares === true, never !== false (an undefined verdict must not admit a seller)");
  // The floors must be PASSED, not defaulted. dispatchEligibility declares
  // minSettled = 50 / minPayers = 3 in its own signature, so dropping these two
  // arguments leaves a gate that still works and silently stops honouring the
  // configured thresholds - the quietest possible way to change who gets paid.
  ok(/minSettled: SOR_MIN_SETTLED_TX/.test(fn) && /minPayers: SOR_MIN_DISTINCT_PAYERS/.test(fn),
    "the resolver passes the configured settlement floors rather than falling back to the defaults");
  ok(!/meetsRouterGate\(\{ settled: r\.settled/.test(fn), "the resolver no longer calls the raw gate beside the labelled one (two implementations would drift)");
  // The wrong-domain observation reaches the decision at all three points: the
  // crawl's observation in the pre-probe filter and the public label, and the
  // LIVE accept after the probe (a seller who fixed it since the crawl is
  // admitted; one who broke it since is not).
  ok(/usdcDomain: r\.evmDomainByNetwork\?\.\["eip155:8453"\] \|\| null \}\)/.test(fn), "the resolver's pre-probe Base gate passes the crawl's domain observation");
  // The gate must go through the shared predicate, not a string compare: a
  // Gateway-rail accept used to pass here as "unknown" and be refused one hop
  // later in payX402, and the next unsignable rail would do the same.
  ok(/usdcDomainVerdict\(liveBase\)/.test(fn) && /unsignableByStockBuyer\(domain\)/.test(fn) && !/domain\.verdict === "wrong_domain"/.test(fn) && /live = false/.test(fn.slice(fn.indexOf("usdcDomainVerdict(liveBase)"))), "the resolver re-reads the LIVE Base accept's domain after the probe and refuses every unsignable verdict through unsignableByStockBuyer, never a bare wrong_domain compare");
  ok(/usdcDomain: row\.evmDomainByNetwork\?\.\["eip155:8453"\] \|\| null,/.test(server), "withDispatchFields hands the row's observation to the label");
  const buyer = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
  const pay = buyer.slice(buyer.indexOf("export async function payX402("));
  ok(pay.indexOf("usdcDomainVerdict(payable)") > -1 && pay.indexOf("usdcDomainVerdict(payable)") < pay.indexOf("reserveSpend(quotedAtomic)"), "payX402 checks the accept it is about to SIGN, before any budget is held or anything signed");
  ok(/withDispatchFields\(r, \{ local: r\.seller === "self", rowLevel: true \}\)/.test(server), "/api/route rows are labelled with row-level price + template checks");
  // Security review 2026-09-02: the Solana SPL leaderboard attributes a payTo's
  // credits to every origin whose OWN manifest advertises that payTo (no
  // ownership check), and provenPayToMatches can only bind a BASE address - so
  // Solana evidence must never reach the maps the Base gate reads, or a fresh
  // origin clears the Base floor by naming someone else's Solana payTo.
  const at = server.indexOf("function buildEvidenceBindingByOrigin(");
  const builderFn = server.slice(at, server.indexOf("\n}\n", at));
  const evidenceFn = server.slice(server.indexOf("function dispatchEvidence()"), server.indexOf("function spendChainsConfigured()"));
  ok(at > -1 && !/solanaEvidenceByOrigin\(\)/.test(builderFn) && !/solanaEvidenceByOrigin\(\)/.test(evidenceFn), "Solana leaderboard evidence is NOT folded into the binding (or its settled/payers projections) the Base gate reads (self-declared payTo attribution cannot clear the Base floor)");
  const crossChain = dispatchEligibility({ routable: true, networks: ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"], settled: 0, payers: undefined, spendChains: ["base", "solana"], minSettled: 50, minPayers: 3 });
  ok(crossChain.chains.base.reason === "settlement_required" && crossChain.chains.solana.reason === "settlement_checked_at_pay_time", "an origin with only Solana evidence stays settlement_required on Base while Solana is read at pay time");
  ok(/executeViaWhenEligible: executeVia, executeViaCallableNow: false/.test(server) && /\{ executeVia, executeViaCallableNow: true \}/.test(server) && /executeViaCallableNow: true, executeViaLane: "unproven"/.test(server) && /unprovenTier === true/.test(server.slice(server.indexOf("function withDispatchFields"), server.indexOf("function withDispatchFields") + 4000)), "withDispatchFields moves executeVia to executeViaWhenEligible on a non-eligible row, keeps it callable on a Base unproven-tier row (executeViaLane unproven), and stamps executeViaCallableNow either way");
  ok(/routerDispatchByChain: v\.routerDispatchByChain/.test(server), "?seller= tool rows carry their own Base verdict (the seller row has no price, so it cannot show the unproven tier)");
  ok(/withDispatchSnapshot\(snapshot\)/.test(server) && (server.match(/withDispatchSnapshot\(snapshot\)/g) || []).length >= 2, "the marketplace and chain pages render the labelled snapshot");
}
// --- Base unproven tier label (2026-09-30) -------------------------------------
{
  const base = { routable: true, networks: ["eip155:8453"], spendChains: ["base"], minSettled: 50, minPayers: 3 };
  const thin = dispatchEligibility({ ...base, settled: 0, priceUsd: 0.01, unprovenMaxUsd: 0.01 });
  ok(thin.eligible === false && thin.chains.base.reason === "settlement_required" && thin.chains.base.unprovenTier === true && thin.chains.base.unprovenMaxUsd === 0.01, "below the floor at a price within the ceiling: still not eligible, but unprovenTier says it can be tried");
  ok(dispatchEligibility({ ...base, settled: 0, priceUsd: 0.05, unprovenMaxUsd: 0.01 }).chains.base.unprovenTier === undefined, "a price above the ceiling carries no tier");
  ok(dispatchEligibility({ ...base, settled: 0, priceUsd: 0.01, unprovenMaxUsd: 0 }).chains.base.unprovenTier === undefined, "a ceiling of 0 (switched off) carries no tier");
  ok(dispatchEligibility({ ...base, settled: 0, priceUsd: undefined, unprovenMaxUsd: 0.01 }).chains.base.unprovenTier === undefined, "an unknown price carries no tier");
  ok(dispatchEligibility({ ...base, settled: 500, payers: 40, priceUsd: 0.01, unprovenMaxUsd: 0.01 }).chains.base.unprovenTier === undefined, "a proven seller is eligible, not tiered");
  const wrongDomain = dispatchEligibility({ ...base, settled: 0, priceUsd: 0.01, unprovenMaxUsd: 0.01, usdcDomain: { asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", name: "USDC" } });
  ok(wrongDomain.chains.base.unprovenTier === undefined, "a wrong EIP-712 domain is something else wrong: no tier");
  ok(dispatchEligibility({ ...base, settled: 0, priceUsd: 0.01, unprovenMaxUsd: 0.01, deliveryFailing: { base: true } }).chains.base.unprovenTier === undefined, "a failing delivery memo is something else wrong: no tier");
  ok(dispatchEligibility({ ...base, settled: 0, priceUsd: 0.01, unprovenMaxUsd: 0.01, urlTemplate: true }).chains.base.unprovenTier === undefined, "a path template: no tier");
  ok(typeof dispatchLegend()["routerDispatchByChain.base.unprovenTier"] === "string", "the legend explains unprovenTier");
  const { readFileSync } = await import("node:fs");
  const srv = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/verdict\.chains\.base\?\.unprovenTier === true/.test(srv), "the resolver admits only on the label's own unprovenTier verdict");
  ok(/\(a\.unproven \? 1 : 0\) - \(b\.unproven \? 1 : 0\)\) \|\| \(b\.settled - a\.settled\)/.test(srv), "the resolver orders unproven Base candidates after every proven one");
  ok(/live && chain === "base" && r\.unproven[\s\S]{0,400}readLivePayTo\(\)[\s\S]{0,200}if \(!livePayTo\)/.test(srv), "an unproven Base candidate with an unreadable live payTo is not paid");
  ok(/r\.unproven && chain === "base" && r\.chainProvenPayTo/.test(srv), "the payment is pinned to the unproven candidate's own live payTo");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
