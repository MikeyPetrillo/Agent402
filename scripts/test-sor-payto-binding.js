#!/usr/bin/env node
// Settlement evidence is BOUND to the wallet it was measured at (2026-09-03),
// and kept PER WALLET (2026-09-28).
//
// The x402 leaderboard groups origins by payTo, so an origin whose registry
// listing merely NAMES a heavily paid third-party wallet sat in that wallet's
// row and inherited its settled count. provenPayToMatches could not catch it:
// that belt binds an origin's OWN observed address, and the attacker's own
// address had no history ("unknown", which does not refuse). So the attacker
// cleared the Base floor on someone else's money and its live 402 named its
// own wallet.
//
// The 2026-09-03 fix bound the evidence to the UNION of the wallets an origin
// was credited with, beside a MAX of their counts. That left the union hole:
// an origin credited with busy wallet W's history that also listed one
// resource at its own wallet V (V then sat in the union) cleared on W's
// history and was paid at V. Now every figure is kept against the wallet it
// was measured at, and the wallet the live 402 names must clear the floor on
// ITS OWN evidence (src/evidence-binding.js + dispatch-eligibility.js
// evidencePayToVerdict); the resolver runs that check on the probe's 402, and
// the payer re-checks the accept it signs against the same clearing wallets.
//
// Offline: fake leaderboard rows, fake 402s, no server, nothing spent.
import { readFileSync } from "node:fs";
import { buildEvidenceBinding, baseLiveGate, rowWalletFigures } from "../src/evidence-binding.js";
import { dispatchEligibility, evidencePayToVerdict, DISPATCH_DETAILS, dispatchLegend } from "../src/dispatch-eligibility.js";
import { foldBazaarQuality } from "../src/x402-index.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const W = "0x" + "aa".repeat(20); // the heavily paid wallet
const X = "0x" + "bb".repeat(20); // the attacker's own wallet
const V = "0x" + "cc".repeat(20); // a thin wallet the same origin also lists
const HONEST = "https://honest.example";
const ATTACKER = "https://attacker.example";
const FLOORS = { minSettled: 50, minPayers: 3 };
const hdr = (payTo) => Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "1000", payTo, maxTimeoutSeconds: 60 }] })).toString("base64");

// --- 1. The binding: history measured at W counts only where W is paid --------
// One leaderboard row keyed by W, listing both origins (the attacker's
// registry item named W as its payTo).
const row = { wallet: W, wallets: [W], origins: [HONEST, ATTACKER], homepage: HONEST, callsSettled: 5000, uniqueBuyers: 40 };
const binding = buildEvidenceBinding({ leaderboardRows: [row], ...FLOORS });
ok(binding.get(HONEST)?.byWallet.get(W)?.settled === 5000 && binding.get(ATTACKER)?.byWallet.get(W)?.payers === 40 && binding.get(HONEST).clearing.has(W), "both origins on the row are credited W's figures, kept against W");
ok(binding.get(ATTACKER).ownSettled === 0 && binding.get(ATTACKER).ownPayers === undefined, "a leaderboard row is never the origin's OWN evidence (that is the chain join on its own address)");

const gateFor = (b, payTo, extra = {}) => baseLiveGate({ networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0.01, ...FLOORS, binding: b, header: hdr(payTo), body: "{}", ...extra });
const honestGate = gateFor(binding.get(HONEST), W);
ok(honestGate.ok === true && JSON.stringify(honestGate.evidenceWallets) === JSON.stringify([W]), "honest origin: its live 402 pays W -> paid, and the payer is handed exactly [W]");
const att = gateFor(binding.get(ATTACKER), X);
ok(att.ok === false && att.detail === "evidence_payto_mismatch" && att.livePayTo === X && att.payTos.includes(W), "attacker origin on the same row: its live 402 pays X -> refused, detail evidence_payto_mismatch, naming both wallets");
ok(gateFor(binding.get(ATTACKER), W).ok === true, "the attacker origin passes only by asking to be paid at W itself - then the money goes to the proven wallet, not the attacker");
const unreadable = baseLiveGate({ networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0.01, ...FLOORS, binding: binding.get(ATTACKER), header: "not-a-402", body: "" });
ok(unreadable.ok === false && unreadable.detail === "evidence_payto_unverified" && unreadable.livePayTo === null, "an unreadable live payTo is NOT a match: bound evidence stays unproven until the 402 names the wallet");
ok(baseLiveGate({ networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0.01, ...FLOORS, binding: binding.get(ATTACKER), livePayTo: W.toUpperCase().replace("0X", "0x") }).ok === true, "the wallet compare is case-insensitive (EVM), and a pre-decoded livePayTo is accepted");
ok(baseLiveGate({ networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0.01, ...FLOORS, binding: null, header: hdr(X), body: "{}" }).ok === true, "no binding on record (an origin absent from every source) leaves the gate as it was");

// --- 2. THE UNION HOLE ---------------------------------------------------------
// HONEST is credited W's leaderboard history AND lists one resource at its own
// thin wallet V (a single Bazaar call). Under the union rule V sat beside W and
// a 402 paying V was accepted on W's 5,000 calls. Per wallet, V has 1 call.
const union = buildEvidenceBinding({ leaderboardRows: [{ ...row, origins: [HONEST] }], bazaarQuality: [[HONEST, { calls30d: 1, payers30d: 1, payTos: [V] }]], ...FLOORS });
ok(union.get(HONEST).payTos.has(V) && union.get(HONEST).payTos.has(W) && union.get(HONEST).byWallet.get(V).settled === 1, "the origin holds evidence at both wallets, each kept against its own wallet");
ok([...union.get(HONEST).clearing].join() === W, "only W clears the floor on its own evidence");
const hole = gateFor(union.get(HONEST), V);
ok(hole.ok === false && hole.detail === "evidence_payto_mismatch", "UNION HOLE CLOSED: a live 402 paying V is refused although W's history clears (V's own 1 call does not)");
ok(gateFor(union.get(HONEST), W).ok === true, "...and the same origin paid at W is still paid");
ok(!gateFor(union.get(HONEST), W).evidenceWallets.includes(V), "the payer is handed only the clearing wallet, never the union (V is absent)");
// The same hole one level down: a MAX taken per figure across wallets. W has
// the calls, V has the payers; neither clears alone.
const mixed = buildEvidenceBinding({ leaderboardRows: [{ wallet: W, wallets: [W], origins: [HONEST], callsSettled: 1000, uniqueBuyers: 2 }], bazaarQuality: [[HONEST, { calls30d: 10, payers30d: 9, payTos: [V] }]], ...FLOORS });
ok(mixed.get(HONEST).clearing.size === 0, "cross-wallet mixing: W 1000 calls / 2 payers, V 10 calls / 9 payers -> no wallet clears");
ok(!(mixed.get(HONEST).settled >= 50 && mixed.get(HONEST).payers >= 3), "the projection is the best SINGLE wallet (never W's calls beside V's payers)");
const mixedLabel = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: mixed.get(HONEST).settled, payers: mixed.get(HONEST).payers, spendChains: ["base"], ...FLOORS, evidence: mixed.get(HONEST), livePayTo: W });
ok(mixedLabel.eligible === false && mixedLabel.reason === "settlement_required", "label: the mixed origin reads settlement_required");
const forced = baseLiveGate({ networks: ["eip155:8453"], settled: 1000, payers: 9, priceUsd: 0.01, ...FLOORS, binding: mixed.get(HONEST), livePayTo: W });
ok(forced.ok === false && forced.detail === "evidence_payto_mismatch", "even handed the old MAX-merged figures (1000 / 9), the gate refuses: no wallet clears on its own");

// --- 3. Multi-wallet leaderboard rows: the scan's per-wallet evidence ----------
const twoWalletRow = { wallet: W, wallets: [W, V], origins: [HONEST], homepage: HONEST, callsSettled: 5100, uniqueBuyers: 42 };
const perWallet = buildEvidenceBinding({ leaderboardRows: [twoWalletRow], walletEvidence: { [W]: { callsSettled: 5000, uniqueBuyers: 40 }, [V]: { callsSettled: 100, uniqueBuyers: 2 } }, ...FLOORS });
ok(perWallet.get(HONEST).byWallet.get(W).settled === 5000 && perWallet.get(HONEST).byWallet.get(V).payers === 2 && [...perWallet.get(HONEST).clearing].join() === W, "a two-wallet row is credited per wallet from the scan's per-wallet evidence, never its totals");
ok(gateFor(perWallet.get(HONEST), V).ok === false, "...so a 402 paying the thin wallet V is refused though the row's totals (5100 / 42) clear");
ok(rowWalletFigures(twoWalletRow, null).length === 0 && !buildEvidenceBinding({ leaderboardRows: [twoWalletRow], ...FLOORS }).has(HONEST), "a multi-wallet row with no per-wallet evidence (a snapshot persisted before it existed) credits nothing: its totals cannot be split");
ok(rowWalletFigures({ wallet: W, wallets: [W], callsSettled: 70, uniqueBuyers: 4 }, null)[0][1].settled === 70, "a single-wallet row's totals ARE that wallet's figures");
const rowNoWallets = { wallet: W, origins: [ATTACKER], callsSettled: 5000 };
ok(buildEvidenceBinding({ leaderboardRows: [rowNoWallets] }).get(ATTACKER).payTos.has(W), "a row with no `wallets` list falls back to its primary `wallet`");
ok(!buildEvidenceBinding({ leaderboardRows: [{ wallet: "not-an-address", origins: [ATTACKER], callsSettled: 5000 }] }).has(ATTACKER)
  && baseLiveGate({ networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0.01, ...FLOORS, binding: { byWallet: new Map() }, livePayTo: X }).ok === false,
  "evidence with no readable wallet to keep it against never clears the gate");

// --- 4. The chain join and the Bazaar are bound per wallet too ----------------
const chainJoined = buildEvidenceBinding({ chainProven: new Map([[HONEST, { settled: 600, payers: 9, payTo: W, source: "chain" }]]), ...FLOORS });
ok(chainJoined.get(HONEST).ownSettled === 600 && chainJoined.get(HONEST).ownPayers === 9 && chainJoined.get(HONEST).byWallet.get(W)?.settled === 600, "the chain join is the origin's own evidence, kept against its own address");
ok(evidencePayToVerdict({ evidence: chainJoined.get(HONEST), livePayTo: W, ...FLOORS }).ok === true
  && evidencePayToVerdict({ evidence: chainJoined.get(HONEST), livePayTo: X, ...FLOORS }).verdict === "evidence_payto_mismatch"
  && evidencePayToVerdict({ evidence: chainJoined.get(HONEST), livePayTo: null, ...FLOORS }).verdict === "evidence_payto_unverified",
  "own evidence is bound like any other: it counts for a 402 paying its address, not for another or an unreadable one");
ok(evidencePayToVerdict({ evidence: buildEvidenceBinding({ chainProven: new Map([[HONEST, { settled: 600, payers: 1, payTo: W }]]) }).get(HONEST), livePayTo: W, ...FLOORS }).ok === false, "own evidence that fails the breadth floor does not clear (a count one wallet made is not proof)");
const bazaar = buildEvidenceBinding({ bazaarQuality: [[ATTACKER, { calls30d: 900, payers30d: 12, payTos: [W] }], [HONEST, { calls30d: 0, payers30d: 0, payTos: [X] }]], ...FLOORS });
ok(bazaar.get(ATTACKER).byWallet.get(W)?.settled === 900 && bazaar.get(ATTACKER).settled === 900 && bazaar.get(ATTACKER).payers === 12 && !bazaar.has(HONEST), "Bazaar quality with calls is kept against the listed payTo; a zero-count entry contributes nothing");
ok(baseLiveGate({ networks: ["eip155:8453"], settled: 900, payers: 12, priceUsd: 0.01, ...FLOORS, binding: bazaar.get(ATTACKER), livePayTo: X }).detail === "evidence_payto_mismatch", "an origin cleared on Bazaar counts measured at W is refused when its live 402 pays X");
ok(!buildEvidenceBinding({ bazaarQuality: [[ATTACKER, { calls30d: 900, payers30d: 12, payTos: [W, V] }]] }).has(ATTACKER), "Bazaar counts over two wallets with no per-wallet split are attributed to neither");
// The fold keeps the split, and keeps it OFF the served object.
{
  const qmap = new Map();
  foldBazaarQuality(qmap, HONEST, { l30DaysTotalCalls: 400, l30DaysUniquePayers: 8 }, W);
  foldBazaarQuality(qmap, HONEST, { l30DaysTotalCalls: 2, l30DaysUniquePayers: 1 }, V);
  foldBazaarQuality(qmap, HONEST, { l30DaysTotalCalls: 100, l30DaysUniquePayers: 11 }, W.toUpperCase().replace("0X", "0x"));
  const q = qmap.get(HONEST);
  ok(q.byPayTo[W].calls === 500 && q.byPayTo[W].payers === 11 && q.byPayTo[V].calls === 2, "foldBazaarQuality splits calls (summed) and payers (max) by the declared payTo");
  ok(!Object.keys(q).includes("byPayTo") && !JSON.stringify(q).includes("byPayTo"), "the split is non-enumerable: the public `bazaar` object never carries it");
  const fromFold = buildEvidenceBinding({ bazaarQuality: [[HONEST, q]], ...FLOORS });
  ok(fromFold.get(HONEST).byWallet.get(V).settled === 2 && gateFor(fromFold.get(HONEST), V).ok === false && gateFor(fromFold.get(HONEST), W).ok === true, "an origin whose Bazaar figures span W and V clears only where W is paid");
}

// --- 5. The committed seed is NOT evidence (2026-09-28) ------------------------
// It named origins with counts attributable to no wallet, so a seeded origin
// cleared the floor with no binding and no payer figure. Passing it now changes
// nothing: a seed-only origin has no evidence at all.
const seedOnly = buildEvidenceBinding({ seedOrigins: { [ATTACKER]: 500 } });
ok(!seedOnly.has(ATTACKER), "a seed-only origin has no entry in the evidence map (the seed input is ignored)");
const seedLabel = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: seedOnly.get(ATTACKER)?.settled || 0, payers: seedOnly.get(ATTACKER)?.payers, spendChains: ["base"], ...FLOORS, evidence: seedOnly.get(ATTACKER), livePayTo: X });
ok(seedLabel.eligible === false && seedLabel.reason === "settlement_required", "SEED-ONLY ORIGIN NO LONGER CLEARS: it reads settlement_required");
const seeded = buildEvidenceBinding({ seedOrigins: { [ATTACKER]: 500 }, leaderboardRows: [row] });
ok(seeded.get(ATTACKER).settled === 5000 && !("seedSettled" in seeded.get(ATTACKER)), "beside real evidence the seed adds nothing");
const seededGate = baseLiveGate({ networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0.01, ...FLOORS, binding: seeded.get(ATTACKER), livePayTo: X });
ok(seededGate.ok === false && seededGate.detail === "evidence_payto_mismatch", "a seeded origin is bound like any other: its 402 paying X is refused (the seed once skipped this check)");
ok(JSON.stringify(baseLiveGate({ networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0.01, ...FLOORS, binding: seeded.get(ATTACKER), livePayTo: W }).evidenceWallets) === JSON.stringify([W]), "...and paid at W it hands the payer [W], never null");

// --- 6. The public label: same function, the crawled address standing in -------
const label = (livePayTo) => dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 5000, payers: 40, spendChains: ["base", "solana"], ...FLOORS, evidence: binding.get(ATTACKER), livePayTo });
ok(label(X).eligible === false && label(X).reason === "settlement_required" && label(X).chains.base.detail === "evidence_payto_mismatch", "label: an origin advertising a wallet other than the one its history was measured at reads settlement_required (evidence_payto_mismatch)");
ok(label(null).eligible === false && label(null).chains.base.detail === "evidence_payto_unverified", "label: an origin with bound history and no readable own address reads settlement_required (evidence_payto_unverified)");
ok(label(W).eligible === true && label(W).reason === "eligible", "label: the origin advertising W reads eligible");
const unbound = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 5000, payers: 40, spendChains: ["base"], ...FLOORS });
ok(unbound.eligible === true, "a caller that passes no evidence gets the pre-binding verdict (every other caller is unchanged)");
ok(typeof DISPATCH_DETAILS.evidence_payto_mismatch === "string" && dispatchLegend().routerDispatchDetail.evidence_payto_mismatch === DISPATCH_DETAILS.evidence_payto_mismatch && dispatchLegend().routerDispatchDetail.evidence_payto_unverified, "both detail values are in the published legend");

// --- 7. The call sites, pinned from source: a correct primitive that nothing
// calls would pass every assertion above.
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = server.slice(server.indexOf("async function resolveExternalSeller("), server.indexOf("async function diagnoseExternalSeller("));
  ok(/const ev = dispatchEvidence\(\);/.test(fn) && /binding: ev\.binding\.get\(norm\(r\.seller\)\)/.test(fn) && /settled: ev\.settled\.get\(norm\(r\.seller\)\)/.test(fn), "the resolver's Base branch reads settled, payers and the binding from dispatchEvidence() onto every candidate");
  ok(/const livePayTo = await readLivePayTo\(\);\s*\n\s*const gate = baseLiveGate\(\{[^\n]*binding: r\.binding, livePayTo \}\)/.test(fn) && fn.indexOf("baseLiveGate({") > fn.indexOf("live = probe.status === 402"), "the resolver re-runs the labelled gate AFTER the probe with the candidate's binding and the live 402's payTo");
  ok(/if \(!gate\.ok\) \{[\s\S]{0,400}live = false;/.test(fn), "a failed binding gate drops the candidate (live = false), it is never paid");
  ok(/evidenceWallets = gate\.evidenceWallets;/.test(fn) && !/\[\.\.\.r\.binding\.payTos\]/.test(fn), "a passed gate hands the payer the wallets whose OWN evidence clears (gate.evidenceWallets), never the union of credited wallets");
  ok(/evidence: ev\.binding\.get\(origin\)/.test(server) && /livePayTo: \(typeof row\.payToByNetwork\?\.\["eip155:8453"\]/.test(server), "withDispatchFields labels rows with the binding and the advertised Base payTo");
  const at = server.indexOf("function buildEvidenceBindingByOrigin(");
  const builder = server.slice(at, server.indexOf("\n}\n", at));
  ok(/leaderboardRows: getLeaderboardSnapshot\(\)\?\.leaderboard/.test(builder) && /walletEvidence: getLeaderboardWalletEvidence\(\)/.test(builder) && /bazaarQuality: bazaarQualityEntries\(\)/.test(builder) && /chainProven,/.test(builder)
    && /minSettled: SOR_MIN_SETTLED_TX,/.test(builder) && /minPayers: SOR_MIN_DISTINCT_PAYERS,/.test(builder),
    "the binding is built from the leaderboard, its per-wallet evidence, the Bazaar and the chain join, on the router's own floors");
  const de = server.slice(server.indexOf("function dispatchEvidence()"), server.indexOf("function spendChainsConfigured()"));
  ok(/for \(const \[origin, e\] of binding\)/.test(de) && /settled\.set\(origin, e\.settled\)/.test(de) && /payers\.set\(origin, e\.payers\)/.test(de) && !/bazaarQualityEntries|getLeaderboardSnapshot/.test(de), "settled and payers are projections of the binding, never a separate MAX over the raw sources");
  ok(!/function buildSettledByOrigin\(|function buildPayersByOrigin\(/.test(server), "the old per-source MAX builders are gone, so nothing can read the unbound maps");
  ok(!/seed/i.test(builder) && server.split("\n").filter((l) => /SOR_SEED_ORIGINS/.test(l) && !/^\s*\/\//.test(l)).length === 2 && /const seedHint = Object\.hasOwn\(SOR_SEED_ORIGINS, norm\(r\.seller\)\);/.test(server), "the seed reaches nothing but the operator diagnostic's seedHint (never the binding)");
  const index = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  ok(/foldBazaarQuality\(qualityByOrigin, origin, item\.quality, t\?\.payToByNetwork\?\.\["eip155:8453"\]/.test(index), "the Bazaar quality fold keeps each counted resource's Base payTo beside the counts");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
