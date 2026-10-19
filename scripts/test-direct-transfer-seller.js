// A path seller whose manifest declares its own prefixed origin, whose Base
// accept carries no extra.name, and whose 402 asks for a direct transfer
// proved afterwards. Offline: the shapes are the ones such a seller serves.
//   - its manifest routes are read under its prefix, not dropped;
//   - its price is read from the USDC contract address;
//   - its route is labelled unpayable by a stock buyer, never routed.
import { normaliseManifestTools } from "../src/x402-index.js";
import { quoteFromAccepts } from "../src/x402-live-quote.js";
import { usdcDomainVerdict, unsignableByStockBuyer, evmDomainsOfAccepts, unsupportedPaymentMethodOf } from "../src/evm-usdc-domain.js";
import { dispatchEligibility } from "../src/dispatch-eligibility.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const ORIGIN = "https://fn.example.supabase.co/functions/v1/demo-api";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYTO = "0x4a8d590afbdeddd9c7aaf2743b18f8ede674873a";

// --- manifest routes relative to a declared prefixed origin -------------------
{
  const manifest = { x402Version: 2, origin: ORIGIN, tools: [{ route: "/v1/reconcile", method: "POST", price: "0.01", network: "eip155:8453", asset: BASE_USDC, payTo: PAYTO, scheme: "exact" }] };
  const rows = normaliseManifestTools(manifest, ORIGIN);
  const r = rows.find((x) => x.route === "/v1/reconcile");
  ok(!!r, `a route relative to the declared prefixed origin is kept (${JSON.stringify(rows.map((x) => x.route))})`);
  ok(r && Number(String(r.price).replace(/[^0-9.]/g, "")) === 0.01, `and keeps its price (${r?.price})`);
  const other = normaliseManifestTools({ x402Version: 2, origin: "https://fn.example.supabase.co", tools: [{ route: "/v1/reconcile", method: "POST", price: "0.01" }] }, ORIGIN);
  ok(!other.some((x) => x.route === "/v1/reconcile"), "a manifest declaring the bare host is still read host-absolute (a route outside the prefix stays out)");
  const already = normaliseManifestTools({ x402Version: 2, origin: ORIGIN, tools: [{ route: "/functions/v1/demo-api/v1/x", method: "POST", price: "0.01" }] }, ORIGIN);
  ok(already.some((x) => x.route === "/v1/x"), "a route already written with the prefix is not prefixed twice");
}

// --- price from the USDC contract when extra.name is absent ------------------
const ACCEPT = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: BASE_USDC, payTo: PAYTO, maxTimeoutSeconds: 300, extra: { paymentMethod: "direct-transfer" } };
{
  const q = quoteFromAccepts([ACCEPT]);
  ok(q && q.price === 0.01, `a nameless Base accept on the USDC contract prices at its amount (${q?.price})`);
  const unknownAsset = quoteFromAccepts([{ ...ACCEPT, asset: "0x0000000000000000000000000000000000000001" }]);
  ok(unknownAsset && unknownAsset.price === null, "a nameless accept on an unknown token still has no price (never a guess)");
}

// --- a transfer proved afterwards is unpayable by a stock buyer --------------
{
  ok(unsupportedPaymentMethodOf(ACCEPT) === "direct-transfer", "direct-transfer is recognized");
  ok(unsupportedPaymentMethodOf({ ...ACCEPT, extra: { paymentMethod: "eip3009" } }) === null, "an EIP-3009 method decides nothing");
  ok(unsupportedPaymentMethodOf({ ...ACCEPT, extra: { paymentMethod: "x402" } }) === null, "an unfamiliar label decides nothing (only explicit transfer-proof names refuse)");
  const v = usdcDomainVerdict(ACCEPT);
  ok(v.verdict === "payment_method_unsupported" && unsignableByStockBuyer(v), `the live accept reads as unsignable (${v.verdict})`);
  const stored = evmDomainsOfAccepts([ACCEPT])["eip155:8453"];
  ok(stored && stored.paymentMethod === "direct-transfer" && !("name" in stored), `the index keeps the method for a nameless accept (${JSON.stringify(stored)})`);
  const elig = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 0, priceUsd: 0.01, usdcDomain: stored });
  ok(elig.eligible === false && elig.chains?.base?.reason === "payment_method_unsupported", `a $0.01 route is not routed, and says why (${elig.chains?.base?.reason})`);
  const plain = dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: 0, priceUsd: 0.01, usdcDomain: evmDomainsOfAccepts([{ ...ACCEPT, extra: { name: "USD Coin", version: "2" } }])["eip155:8453"] });
  ok(plain.chains?.base?.reason !== "payment_method_unsupported", `a standard accept at the same price is unaffected (${plain.chains?.base?.reason})`);
}

console.log(`\ntest-direct-transfer-seller: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
