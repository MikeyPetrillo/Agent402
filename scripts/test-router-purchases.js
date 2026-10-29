#!/usr/bin/env node
// The router's own purchases are never a seller's proof, on every path the
// floor reads: the chain join (the merchant SQL leaves our wallets out), the
// Bazaar fold (the router's recorded purchases come off an origin's figures
// at the wallet it paid) and the Solana credit rule (a debit from one of our
// wallets is not a credit). A payer figure measured as zero is evidence, not
// a gap: it refuses at the breadth floor.
//
// Offline: the purchase store on a temp file, the binding on hand-built
// figures, the route-execute tool with a stub payer, no server, nothing spent.
import "./lib/file-mode.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createRouterPurchaseStore, PURCHASE_WINDOW_MS } from "../src/router-purchases.js";
import { buildEvidenceBinding } from "../src/evidence-binding.js";
import { meetsRouterGate } from "../src/settlement-proof.js";
import { merchantsQuery } from "../src/x402-economy.js";
import { OUR_EVM_WALLETS, OUR_SOLANA_WALLETS } from "../src/revenue-live.js";
import { creditFromTx } from "../src/solana-buyer.js";
import { buildRouteExecuteTool, EXEC_TIERS } from "../src/tools/route-execute.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = new URL("..", import.meta.url);
const W = "0x" + "aa".repeat(20);
const SELLER = "https://seller.example";
const FLOORS = { minSettled: 50, minPayers: 3 };

// --- 1. The store: window, one payer per chain, persistence ---------------
{
  const dir = mkdtempSync(join(tmpdir(), "a402-rp-"));
  const file = join(dir, "purchases.json");
  let t = 1_000_000_000_000;
  const store = createRouterPurchaseStore({ file, now: () => t });
  ok(store.at(SELLER, W).calls === 0 && store.at(SELLER, W).payers === 0, "nothing bought: zero calls, zero payers");
  for (let i = 0; i < 60; i++) { t += 1000; store.record({ origin: `${SELLER}/`, payTo: W.toUpperCase().replace("0X", "0x"), chain: "base" }); }
  ok(store.at(SELLER, W).calls === 60 && store.at(SELLER, W).payers === 1, `60 buys from one chain wallet: 60 calls, 1 payer (origin and wallet normalized)`);
  store.record({ origin: SELLER, payTo: W, chain: "solana" });
  ok(store.at(SELLER, W).payers === 2, "a second chain's spending wallet is a second payer");
  ok(!store.record({ origin: SELLER, payTo: "not-a-wallet", chain: "base" }) && !store.record({ origin: "nope", payTo: W }), "an unreadable wallet or origin records nothing");
  t += PURCHASE_WINDOW_MS + 1;
  ok(store.at(SELLER, W).calls === 0 && store.snapshot().size === 0, "purchases older than the Bazaar window fall out");
  t += 1000; store.record({ origin: SELLER, payTo: W, chain: "base" });
  await new Promise((r) => setTimeout(r, 400));
  const again = createRouterPurchaseStore({ file, now: () => t });
  const snap = again.snapshot();
  ok(snap.get(SELLER)?.get(W)?.calls === 1 && snap.get(SELLER).get(W).payers === 1, `the record survives a restart from the file (${JSON.stringify([...snap].map(([o, m]) => [o, [...m]]))})`);
  rmSync(dir, { recursive: true, force: true });
}

// --- 2. The Bazaar fold: the router's purchases come off the figures -------
{
  // A seller the Bazaar counts at 60 calls from one payer: all of them ours.
  const q = { calls30d: 60, payers30d: 1, payTos: [W] };
  const ours = new Map([[SELLER, new Map([[W, { calls: 60, payers: 1 }]])]]);
  const without = buildEvidenceBinding({ bazaarQuality: [[SELLER, q]], ...FLOORS });
  ok(without.get(SELLER)?.byWallet.get(W)?.settled === 60, "CONTROL: without the record the Bazaar figure stands");
  const netted = buildEvidenceBinding({ bazaarQuality: [[SELLER, q]], routerPurchases: ours, ...FLOORS });
  ok(!netted.has(SELLER) || !netted.get(SELLER).byWallet.has(W), "a seller whose every Bazaar call was the router's is credited nothing at that wallet");
  // Fifty unproven buys of ours plus two outside payers: the floor is not cleared.
  const q2 = { calls30d: 52, payers30d: 3, payTos: [W] };
  const b2 = buildEvidenceBinding({ bazaarQuality: [[SELLER, q2]], routerPurchases: new Map([[SELLER, new Map([[W, { calls: 50, payers: 1 }]])]]), ...FLOORS });
  const e2 = b2.get(SELLER);
  ok(e2?.byWallet.get(W)?.settled === 2 && e2.byWallet.get(W).payers === 2 && !e2.clearing.has(W), `router buys plus two outside payers do not qualify (settled ${e2?.byWallet.get(W)?.settled}, payers ${e2?.byWallet.get(W)?.payers})`);
  ok(buildEvidenceBinding({ bazaarQuality: [[SELLER, q2]], ...FLOORS }).get(SELLER).clearing.has(W), "CONTROL: the same figures with no router record clear the floor");
  // The deduction is per wallet and per origin: another origin at W, and
  // another wallet of the same origin, keep their figures.
  const OTHER = "https://other.example";
  const V = "0x" + "bb".repeat(20);
  const b3 = buildEvidenceBinding({ bazaarQuality: [[OTHER, { calls30d: 70, payers30d: 4, payTos: [W] }], [SELLER, { calls30d: 70, payers30d: 4, payTos: [V] }]], routerPurchases: ours, ...FLOORS });
  ok(b3.get(OTHER)?.byWallet.get(W)?.settled === 70 && b3.get(SELLER)?.byWallet.get(V)?.settled === 70, "another origin at the wallet, and another wallet of the origin, are untouched");
  // The label's wording: the reduced figures are noted as not credited.
  ok(e2.selfFunded.byWallet.get(W)?.settled === 52, "the figures that would have been credited are kept for the label only");
}

// --- 3. A measured zero refuses ------------------------------------------
{
  const z = buildEvidenceBinding({ bazaarQuality: [[SELLER, { calls30d: 80, payers30d: 1, payTos: [W] }]], routerPurchases: new Map([[SELLER, new Map([[W, { calls: 20, payers: 1 }]])]]), ...FLOORS });
  const e = z.get(SELLER)?.byWallet.get(W);
  ok(e && e.settled === 60 && e.payers === 0, `every payer netted away reads as 0, not unknown (${JSON.stringify(e)})`);
  ok(meetsRouterGate({ settled: 60, payers: 0, ...FLOORS }).ok === false && !z.get(SELLER).clearing.has(W) && z.get(SELLER).payers === 0, "payers 0 refuses at the breadth floor; the origin's projection says 0");
  const u = buildEvidenceBinding({ chainProven: new Map([[SELLER, { settled: 600, payers: undefined, payTo: W }]]), ...FLOORS });
  ok(u.get(SELLER).byWallet.get(W).payers === undefined && u.get(SELLER).clearing.has(W), "CONTROL: no payer figure at all stays unknown and does not refuse");
  const zc = buildEvidenceBinding({ chainProven: new Map([[SELLER, { settled: 600, payers: 0, payTo: W }]]), ...FLOORS });
  ok(zc.get(SELLER).byWallet.get(W).payers === 0 && !zc.get(SELLER).clearing.has(W), "a chain-join row measured at zero payers refuses too");
}

// --- 4. The chain join: the merchant SQL leaves our wallets out ------------
{
  const sql = merchantsQuery("2026-01-01 00:00:00");
  const listed = [...OUR_EVM_WALLETS].every((w) => sql.includes(`'${w}'`));
  ok(listed && /lower\(toString\(parameters\['from'\]\)\) NOT IN \(/.test(sql) && OUR_EVM_WALLETS.size > 0, `every one of our ${OUR_EVM_WALLETS.size} EVM wallets is excluded from the merchant payments and payers`);
  const custom = merchantsQuery("2026-01-01 00:00:00", { ourWallets: new Set(["0x" + "12".repeat(20)]) });
  ok(custom.includes(`'0x${"12".repeat(20)}'`) && !custom.includes([...OUR_EVM_WALLETS][0]), "the exclusion list is the wallet set given");
  ok(!/'[^']*'[^,)]*'/.test(custom.split("NOT IN (")[1].split(")")[0]), "the list is quoted hex only");
  const econ = readFileSync(new URL("src/x402-economy.js", ROOT), "utf8");
  ok(/const merchRes = await settle\(runSql\(merchantsQuery\(utcStamp\(7 \* DAY_MS\)\)\)\)/.test(econ), "the snapshot builder runs this query for topMerchants (the router's chain join reads them)");
  const server = readFileSync(new URL("src/server.js", ROOT), "utf8");
  const at = server.indexOf("function buildEvidenceBindingByOrigin(");
  const builder = server.slice(at, server.indexOf("\n}\n", at));
  ok(/routerPurchases: routerPurchasesSnapshot\(\)/.test(builder), "the server's binding is built with the router's purchase record");
  ok(/merchants: econ\.topMerchants/.test(server.slice(server.indexOf("function buildChainProven("), server.indexOf("function buildChainProven(") + 400)), "the chain join reads topMerchants");
}

// --- 5. Solana: a debit from one of our wallets is not a credit ------------
{
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const payTo = "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg";
  const ours = [...OUR_SOLANA_WALLETS][0];
  const tx = (funder) => ({ err: null,
    preTokenBalances: [{ accountIndex: 0, mint: USDC, owner: payTo, uiTokenAmount: { amount: "0" } }, { accountIndex: 1, mint: USDC, owner: funder, uiTokenAmount: { amount: "1000" } }],
    postTokenBalances: [{ accountIndex: 0, mint: USDC, owner: payTo, uiTokenAmount: { amount: "50" } }, { accountIndex: 1, mint: USDC, owner: funder, uiTokenAmount: { amount: "950" } }] });
  ok(OUR_SOLANA_WALLETS.size > 0 && creditFromTx(tx(ours), payTo).credited === false, "a credit funded by one of our Solana wallets is not credited (default set)");
  ok(creditFromTx(tx("FUNDERoutside1111111111111111111111111111111"), payTo).credited === true, "CONTROL: a credit funded by an outside wallet is credited");
  ok(creditFromTx(tx("FUNDERoutside1111111111111111111111111111111"), payTo, new Set(["FUNDERoutside1111111111111111111111111111111"])).credited === false, "the set given is the one read");
  const lb = readFileSync(new URL("src/solana-leaderboard.js", ROOT), "utf8");
  ok(/creditFromTx\(tx\.meta, payTo\)/.test(lb) && /const verdict = creditFromTx\(tx\?\.meta, payTo\);/.test(readFileSync(new URL("src/solana-buyer.js", ROOT), "utf8")), "the gate's count and the leaderboard scan both call the rule with the default set");
}

// --- 6. route-execute records its purchases through the real tool ---------
{
  const guard = await import("../src/external-spend-guard.js");
  guard.__reset();
  const recorded = [];
  const PRO = EXEC_TIERS.find((t) => t.slug === "route-execute-pro");
  const cand = { seller: SELLER, slug: "s", url: `${SELLER}/x`, method: "POST", price: "$0.001", networks: ["eip155:8453"], provenPayTo: W };
  const reqOn = { ip: "198.51.100.77", header: (n) => (n === "payment-signature" ? Buffer.from(JSON.stringify({ network: "eip155:8453", payload: {} })).toString("base64") : undefined) };
  const build = (pay) => buildRouteExecuteTool({ getCatalog: () => ({}), tier: PRO, resolveExternal: async () => [cand], payExternal: pay, externalEnabled: () => true, externalChains: () => ["base"], spendingWalletStatus: () => null, recordPurchase: (r) => recorded.push(r) });
  await build(async () => ({ result: { ok: 1 }, quote: { usd: 0.001 }, receipt: { transaction: "0xab" } })).handler({ task: "t", include: "external" }, reqOn);
  ok(recorded.length === 1 && recorded[0].origin === SELLER && recorded[0].payTo === W && recorded[0].chain === "base", `a paid leg records the purchase at the wallet the gate proved (${JSON.stringify(recorded[0])})`);
  await build(async () => ({ result: { ok: 1 }, quote: null, receipt: null })).handler({ task: "t", include: "external" }, reqOn);
  ok(recorded.length === 1, "a seller that served the unpaid request records no purchase");
  try { await build(async () => { throw Object.assign(new Error("no answer"), { statusCode: 502, committed: true, paidUnanswered: true }); }).handler({ task: "t", include: "external" }, reqOn); } catch { /* expected */ }
  ok(recorded.length === 2, "a payment that left and got no answer is recorded too (the safe direction)");
  try { await build(async () => { throw Object.assign(new Error("unreachable"), { statusCode: 502 }); }).handler({ task: "t", include: "external" }, reqOn); } catch { /* expected */ }
  ok(recorded.length === 2, "CONTROL: a pre-payment failure records nothing");
  guard.__reset();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
