// Offline: an Algorand seller is paid only at the address its proof was
// counted at. The catalog is built from a stubbed facilitator (no network),
// candidates come from the router's own builder, and each one is handed
// through route-execute to payX402 with a sentinel AVM signer, so "paid"
// means "reached the signer" and nothing touches algod.
//   - proven at payTo A, live 402 names B: refused before signing
//   - proven at A, live 402 names A: paid
//   - a route our crawl also saw binds to the crawled payTo
//   - a row with no address to bind, or two that disagree, is not a candidate
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.OUTBOUND_LEDGER_FILE = join(mkdtempSync(join(tmpdir(), "algo-payto-proof-")), "outbound-spend.ndjson");
(await import("../src/tools/sanctions-kit.js")).__seedPayoutListForTests();
const algosdk = (await import("algosdk")).default;
const buyer = await import("../src/x402-buyer.js");
const sellers = await import("../src/algorand-sellers.js");
const { algorandProofBinding } = await import("../src/dispatch-eligibility.js");
const { resolvedCandidateOf } = await import("../src/sor-candidates.js");
const { buildRouteExecuteTool } = await import("../src/tools/route-execute.js");

let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log(`ok - ${name}`); } else { failed++; console.log(`FAIL - ${name}`); } };

const ALGO_CAIP2 = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k";
const USDC_ASA = "31566704";
const addr = () => algosdk.generateAccount().addr.toString();
const [A, B, F3, F4, C4, C5, F5] = Array.from({ length: 7 }, addr);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const accept = (payTo) => ({ scheme: "exact", network: ALGO_CAIP2, asset: USDC_ASA, amount: "5000", ...(payTo ? { payTo } : {}), maxTimeoutSeconds: 60 });

// --- the facilitator, stubbed --------------------------------------------------
const merchants = [
  { id: "m1", totalVerifications: 900 },                 // its route's accept names A
  { id: "m2", totalVerifications: 800 },                 // no address anywhere
  { id: "m3", totalVerifications: 700, address: F3 },    // address on the merchant record
  { id: "m4", totalVerifications: 600 },                 // accept F4, our crawl saw C4
  { id: "m5", totalVerifications: 500 },                 // no address on the facilitator side; crawl saw C5
];
const resources = [
  { merchantId: "m1", resourceUrl: "https://one.example/price", method: "GET", description: "crypto price check", accepts: [accept(A)] },
  { merchantId: "m2", resourceUrl: "https://two.example/price", method: "GET", description: "crypto price check", accepts: [accept(null)] },
  { merchantId: "m3", resourceUrl: "https://three.example/price", method: "GET", description: "crypto price check", accepts: [accept(null)] },
  { merchantId: "m4", resourceUrl: "https://four.example/price", method: "GET", description: "crypto price check", accepts: [accept(F4)] },
  { merchantId: "m5", resourceUrl: "https://five.example/price", method: "GET", description: "crypto price check", accepts: [accept(null)] },
];
// What each seller's live 402 names, set per case.
const livePayTo = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.pathname === "/discovery/merchants") return new Response(JSON.stringify({ items: Number(u.searchParams.get("offset")) ? [] : merchants }), { status: 200 });
  if (u.pathname === "/discovery/resources") return new Response(JSON.stringify({ items: Number(u.searchParams.get("offset")) ? [] : resources }), { status: 200 });
  const payTo = livePayTo.get(u.origin);
  if (!payTo) throw new Error(`unexpected fetch ${u.href}`);
  return { status: 402, headers: { get: (n) => (String(n).toLowerCase() === "payment-required" ? b64({ x402Version: 2, accepts: [accept(payTo)] }) : null) }, json: async () => ({}), text: async () => "{}" };
};

sellers.setAlgorandCrawlSources({
  crawledResources: async () => [
    { url: "https://four.example/price", method: "GET", description: "ours", amountAtomic: "5000", payTo: C4 },
    { url: "https://five.example/price", method: "GET", description: "ours", amountAtomic: "5000", payTo: C5 },
  ],
  countInbound: async () => 0,
});
sellers._resetForTest();
const catalog = await sellers.algorandCatalog();
const row = (host) => catalog.find((r) => r.origin === `https://${host}.example`);
ok(catalog.length === 5, `the stubbed facilitator catalog builds (${catalog.length} rows)`);
ok(row("one")?.facilitatorPayTo === A, "a facilitator row records its accept's payTo");
ok(row("three")?.facilitatorPayTo === F3, "and falls back to the merchant record's address");
ok(row("two")?.facilitatorPayTo === null, "a row naming no address records none");
ok(row("five")?.source === "both" && row("five")?.payTo === C5 && row("five")?.verifs === 500, "a route our crawl also saw keeps the facilitator count and our payTo");

// --- the verdict ---------------------------------------------------------------
{
  ok(algorandProofBinding(row("one")).payTo === A && algorandProofBinding(row("one")).basis === "facilitator", "facilitator-only row binds to the facilitator's address");
  ok(algorandProofBinding(row("five")).payTo === C5 && algorandProofBinding(row("five")).basis === "crawl", "a crawl+facilitator row binds to the crawled payTo");
  ok(algorandProofBinding({ source: "both", payTo: C5, facilitatorPayTo: C5 }).payTo === C5, "crawl and facilitator agreeing bind to that address");
  ok(algorandProofBinding(row("four")).verdict === "proof_payto_conflict", "crawl and facilitator disagreeing: no single address, not dispatched");
  ok(algorandProofBinding(row("two")).verdict === "proof_payto_unbound", "no address to bind: not dispatched");
  ok(algorandProofBinding({ source: "crawl", payTo: C5, facilitatorPayTo: A }).payTo === C5, "a crawl-only row never reads a facilitator address");
  ok(algorandProofBinding({ facilitatorPayTo: A.toLowerCase() }).verdict === "proof_payto_unbound", "an address is never case-folded into a binding");
}

// --- the router's candidates -----------------------------------------------------
const { candidates, dropped } = sellers.algorandRouterCandidates(catalog, "crypto price check", { capUsd: 0.5, minVerifs: 50, network: ALGO_CAIP2 });
const bySeller = new Map(candidates.map((c) => [c.seller, c]));
ok(candidates.length === 3, `three bound candidates (${candidates.map((c) => c.seller).join(", ")})`);
ok(bySeller.get("https://one.example")?.chainProvenPayTo === A, "candidate one carries A");
ok(bySeller.get("https://three.example")?.chainProvenPayTo === F3, "candidate three carries its merchant address");
ok(bySeller.get("https://five.example")?.chainProvenPayTo === C5, "candidate five carries the crawled payTo");
ok(dropped.proof_payto_unbound === 1 && dropped.proof_payto_conflict === 1, `dropped by verdict: ${JSON.stringify(dropped)}`);
console.log(`# facilitator-listed sellers not dispatched for want of a bindable address in this fixture: ${Object.values(dropped).reduce((a, b) => a + b, 0)} of ${catalog.length}`);

// --- through route-execute to the signer ----------------------------------------
process.env.ALGORAND_UPSTREAM_BUYER_MNEMONIC = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);
buyer.__setBuyerAddressGuardForTest(false);
const avm = await buyer.getUpstreamBuyerAvm();
let signs = 0;
avm.client.createPaymentPayload = async () => { signs++; throw new Error("SENTINEL: reached the AVM signer"); };
const payReq = { header: (n) => (String(n).toLowerCase() === "x-payment" ? b64({ x402Version: 2, accepted: { network: ALGO_CAIP2 }, payload: {} }) : undefined) };
async function buy(seller, live) {
  const c = bySeller.get(seller);
  assert(c, `no candidate for ${seller}`);
  livePayTo.set(seller, live);
  // The resolver's own precedence: no EVM binding on this chain, so the
  // candidate's chainProvenPayTo is what travels.
  const resolved = resolvedCandidateOf(c, { provenPayTo: new Map().get(c.seller) || c.chainProvenPayTo || null });
  let sent = null;
  const tool = buildRouteExecuteTool({
    getCatalog: () => ({}), tier: { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 },
    resolveExternal: async (_t, { chain }) => (chain === "algorand" ? resolved : null),
    payExternal: async (url, opts) => { sent = opts.provenPayTo; return buyer.payX402(url, opts); },
    externalEnabled: () => true, externalChains: () => ["algorand"],
  });
  const before = signs;
  let err = null;
  try { await tool.handler({ task: "crypto price check", include: "external" }, payReq); } catch (e) { err = e; }
  return { signed: signs - before, err, sent };
}
{
  const r = await buy("https://one.example", B);
  ok(r.sent === A, "route-execute hands the proven address to the payer");
  ok(r.signed === 0 && /Refusing to pay|not the address/i.test(String(r.err?.message)), `proven at A, live 402 names B: refused before signing (${r.signed} signs; ${r.err?.message?.slice(0, 90)})`);
}
{
  const r = await buy("https://one.example", A);
  ok(r.signed === 1, `proven at A, live 402 names A: paid (${r.signed} signs)`);
}
{
  const r = await buy("https://three.example", B);
  ok(r.signed === 0, "proven at the merchant's address, live 402 names another: refused before signing");
}
{
  const bad = await buy("https://five.example", F5);
  ok(bad.signed === 0, "crawl+facilitator row, live 402 names an address other than the crawled one: refused");
  const good = await buy("https://five.example", C5);
  ok(good.signed === 1, "crawl+facilitator row, live 402 names the crawled payTo: paid");
}

// --- the server reaches this builder ----------------------------------------------
{
  const { readFileSync } = await import("node:fs");
  const srv = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const branch = srv.slice(srv.indexOf('} else if (chain === "algorand") {'), srv.indexOf('} else if (chain === "solana") {'));
  ok(/candidates = algo\.candidates;/.test(branch) && /algorandRouterCandidates\(await algorandCatalog\(\), task,/.test(branch), "the resolver's Algorand candidates come from algorandRouterCandidates");
  ok(!/chainProvenPayTo:/.test(branch), "and the branch sets no address of its own");
}

globalThis.fetch = realFetch;
delete process.env.ALGORAND_UPSTREAM_BUYER_MNEMONIC;
console.log(`\ntest-algorand-payto-proof: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
