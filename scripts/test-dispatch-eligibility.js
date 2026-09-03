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
// strale (OCR, Base): routable, 3,769 calls, 5 payers -> eligible on Base.
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
  ok(a.eligible === false && a.reason === "price_unknown", "a route row with no known price -> price_unknown (strale's second OCR row)");
  const b = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 999, payers: 9, priceUsd: 0.05, urlTemplate: true, spendChains: all });
  ok(b.eligible === false && b.reason === "url_template", "an unsubstituted path template is never spent against");
  const c = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 999, payers: 9, spendChains: all });
  ok(c.eligible === true, "seller-level (no price passed) is not blocked by price");
}
// Local row.
ok(dispatchEligibility({ local: true }).reason === "local_catalog" && dispatchEligibility({ local: true }).eligible === true, "this host's own row is local_catalog");
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
// The resolver's Base gate goes through this function (pinned from source).
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = server.slice(server.indexOf("async function resolveExternalSeller("), server.indexOf("async function diagnoseExternalSeller("));
  ok(/dispatchEligibility\(\{ routable: true, networks: r\.networks, settled: r\.settled, payers: r\.payers/.test(fn) && /\.chains\.base\?\.eligible === true\)/.test(fn), "resolveExternalSeller's Base gate is dispatchEligibility's Base verdict (label == decision)");
  ok(!/meetsRouterGate\(\{ settled: r\.settled/.test(fn), "the resolver no longer calls the raw gate beside the labelled one (two implementations would drift)");
  ok(/withDispatchFields\(r, \{ local: r\.seller === "self", rowLevel: true \}\)/.test(server), "/api/route rows are labelled with row-level price + template checks");
  // Security review 2026-09-02: the Solana SPL leaderboard attributes a payTo's
  // credits to every origin whose OWN manifest advertises that payTo (no
  // ownership check), and provenPayToMatches can only bind a BASE address - so
  // Solana evidence must never reach the maps the Base gate reads, or a fresh
  // origin clears the Base floor by naming someone else's Solana payTo.
  const settledFn = server.slice(server.indexOf("function buildSettledByOrigin()"), server.indexOf("function buildSettledByOrigin()") + 2500).split("\nfunction ")[0];
  const payersFn = server.slice(server.indexOf("function buildPayersByOrigin()"), server.indexOf("function buildPayersByOrigin()") + 2500).split("\nfunction ")[0];
  ok(!/solanaEvidenceByOrigin\(\)/.test(settledFn) && !/solanaEvidenceByOrigin\(\)/.test(payersFn), "Solana leaderboard evidence is NOT folded into the settled/payers maps the Base gate reads (self-declared payTo attribution cannot clear the Base floor)");
  const crossChain = dispatchEligibility({ routable: true, networks: ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"], settled: 0, payers: undefined, spendChains: ["base", "solana"], minSettled: 50, minPayers: 3 });
  ok(crossChain.chains.base.reason === "settlement_required" && crossChain.chains.solana.reason === "settlement_checked_at_pay_time", "an origin with only Solana evidence stays settlement_required on Base while Solana is read at pay time");
  ok(/executeViaWhenEligible: executeVia, executeViaCallableNow: false/.test(server) && /\{ executeVia, executeViaCallableNow: true \}/.test(server), "withDispatchFields moves executeVia to executeViaWhenEligible on a non-eligible row and stamps executeViaCallableNow either way");
  ok(/withDispatchSnapshot\(snapshot\)/.test(server) && (server.match(/withDispatchSnapshot\(snapshot\)/g) || []).length >= 2, "the marketplace and chain pages render the labelled snapshot");
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
