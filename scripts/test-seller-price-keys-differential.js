// Reading the snake_case price keys (price_usd, amount_usd,
// max_amount_required) must not move a price the readers already gave. The
// table below is a set of seller entries (manifest rows, whole manifests,
// OpenAPI operation payment objects) in camelCase-only, snake_case-only,
// both-spellings and mixed-family forms. BEFORE holds what each entry was
// priced before the snake_case keys were read (recorded by running the same
// rows through that revision of src/x402-index.js); NOW holds today's price.
//
// Asserted: every entry that had a price keeps it exactly, with no exception,
// an entry that had none may gain one, and NOW matches. A row or OpenAPI
// payment object carrying both priceUsd and price_usd so still reads price_usd
// (the row reader's order), and a price object still reads priceUsd.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
const ix = await import("../src/x402-index.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`FAIL - ${m}`); } };

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", PAY = "0x1111111111111111111111111111111111111111";
const flat = { network: "eip155:8453", asset: USDC, payTo: PAY };
const ROWS = [
  // camelCase only
  ["row", { price: "$5" }], ["row", { price: 0.02 }], ["row", { priceUsd: "0.01" }], ["row", { amountUsd: "0.01" }],
  ["row", { amount: "0.05" }], ["row", { ...flat, amount: "5000000" }], ["row", { ...flat, maxAmountRequired: "5000000" }],
  ["row", { price: { amountUsd: "0.01" } }], ["row", { price: { priceUsd: "0.01" } }], ["row", { price: { amount: "10000", ...flat } }],
  ["row", { accepts: [{ scheme: "exact", ...flat, amount: "5000000" }] }], ["row", { accepts: [{ scheme: "exact", ...flat, maxAmountRequired: "5000000" }] }],
  ["row", { payment: { ...flat, amount: "1000" } }], ["row", { payment: { ...flat, maxAmountRequired: "1000" } }],
  // snake_case only
  ["row", { price_usd: "0.01" }], ["row", { price_usd: 0.01 }], ["row", { amount_usd: "0.001" }], ["row", { ...flat, max_amount_required: "1000" }],
  ["row", { ...flat, max_amount_required: 1000 }], ["row", { max_amount_required: "1000" }],
  ["row", { price: { amount_usd: "0.003" } }], ["row", { price: { price_usd: "0.003" } }], ["row", { price: { ...flat, max_amount_required: "1000" } }],
  ["row", { accepts: [{ scheme: "exact", ...flat, max_amount_required: "1000" }] }], ["row", { payment: { ...flat, max_amount_required: "1000" } }],
  ["row", { payment: { accepts: [{ scheme: "exact", ...flat, max_amount_required: "1000" }] } }],
  // one family, both spellings
  ["row", { priceUsd: "5", price_usd: "0.001" }], ["row", { price_usd: "0.001", priceUsd: "5" }], ["row", { priceUsd: 0.001, price_usd: 9 }],
  ["row", { priceUsd: {}, price_usd: "0.002" }], ["row", { priceUsd: "0.002", price_usd: {} }], ["row", { priceUsd: "0.01", price_usd: "0.01" }],
  ["row", { price: { priceUsd: "5", price_usd: "0.001" } }], ["row", { price: { amountUsd: "5", amount_usd: "0.001" } }],
  ["row", { ...flat, maxAmountRequired: "5000000", max_amount_required: "1000" }],
  ["row", { accepts: [{ scheme: "exact", ...flat, maxAmountRequired: "5000000", max_amount_required: "1000" }] }],
  // two families at once
  ["row", { price: "$5", price_usd: "0.001" }], ["row", { price: "$5", amount_usd: "0.001" }], ["row", { priceUsd: "5", amount_usd: "0.001" }],
  ["row", { price_usd: "5", amount_usd: "0.001" }], ["row", { price: { priceUsd: "5", amount_usd: "0.001" } }],
  ["row", { price: { price_usd: "5", amount_usd: "0.001" } }], ["row", { price: { amountUsd: "5", price_usd: "0.001" } }],
  ["row", { amount: "0.05", max_amount_required: "1000" }], ["row", { amount: 0.05, max_amount_required: 1000 }],
  ["row", { price: "$5", max_amount_required: "1000" }], ["row", { priceUsd: "5", max_amount_required: "1000" }],
  ["row", { price_usd: "5", max_amount_required: "1000" }], ["row", { amount: "0.05", amount_usd: "0.001" }],
  ["row", { ...flat, amount: "5000000", max_amount_required: "1000" }], ["row", { ...flat, price: "$5", max_amount_required: "1000" }],
  ["row", { accepts: [{ scheme: "exact", ...flat, amount: "5000000" }], max_amount_required: "1000" }],
  ["row", { accepts: [{ scheme: "exact", ...flat, amount: "5000000", max_amount_required: "1000" }] }],
  ["row", { price: "$5", accepts: [{ scheme: "exact", ...flat, max_amount_required: "1000" }] }],
  ["row", { price: "$5", payment: { ...flat, max_amount_required: "1000" } }],
  ["row", { payment: { ...flat, amount: "5000000", max_amount_required: "1000" } }],
  ["row", { price: { amount: "0.05", max_amount_required: "1000" } }], ["row", { display: "$0.07", amount: "70000", currency: "USDC", max_amount_required: "1000" }],
  // unusable values
  ["row", { price_usd: { toString: 1 } }], ["row", { price: "$5", price_usd: "  " }], ["row", { price: "$5", max_amount_required: { valueOf: 2 } }],
  ["row", { amount: "0.05", max_amount_required: {} }],
  // service-wide payment block, rows that state nothing or a price of their own
  ["manifest", { payment: { ...flat, amount: "1000" }, resources: ["https://snake.example/api/a"] }],
  ["manifest", { payment: { ...flat, max_amount_required: "1000" }, resources: ["https://snake.example/api/a"] }],
  ["manifest", { payment: { ...flat, amount: "5000000", max_amount_required: "1000" }, resources: ["https://snake.example/api/a"] }],
  ["manifest", { payment: { ...flat, max_amount_required: "1000" }, resources: [{ resource: "https://snake.example/api/a", price: "$5" }] }],
  ["manifest", { accepts: [{ scheme: "exact", ...flat, amount: "1000" }], resources: [{ resource: "https://snake.example/api/a", amount: "2000" }] }],
  ["manifest", { accepts: [{ scheme: "exact", ...flat, amount: "1000" }], resources: [{ resource: "https://snake.example/api/a", amount: "2000", max_amount_required: "9000" }] }],
  // single-resource manifest
  ["manifest", { resource: "https://snake.example/api/a", accepts: [{ scheme: "exact", ...flat, maxAmountRequired: "1000" }] }],
  ["manifest", { resource: "https://snake.example/api/a", accepts: [{ scheme: "exact", ...flat, max_amount_required: "1000" }] }],
  ["manifest", { resource: "https://snake.example/api/a", accepts: [{ scheme: "exact", ...flat, amount: "5000000", max_amount_required: "1000" }] }],
  // OpenAPI operation payment objects
  ["openapi", { "x-payment-info": { priceUsd: "0.01" } }], ["openapi", { "x-payment-info": { price_usd: "0.01" } }],
  ["openapi", { "x-payment-info": { amountUsd: "0.01" } }], ["openapi", { "x-payment-info": { amount_usd: "0.01" } }],
  ["openapi", { "x-payment-info": { priceUsd: "5", price_usd: "0.001" } }], ["openapi", { "x-payment-info": { price_usd: 9, priceUsd: 0.001 } }],
  ["openapi", { "x-payment-info": { price: "5", amount_usd: "0.001" } }], ["openapi", { "x-payment-info": { amountUsd: "5", amount_usd: "0.001" } }],
  ["openapi", { "x-payment-info": { priceUsd: "5", amount_usd: "0.001" } }], ["openapi", { "x-payment-info": { price_usd: "5", amount_usd: "0.001" } }],
  ["openapi", { "x-payment-info": { amount_usd: 0 } }], ["openapi", { "x-payment-info": { price: 0, amount_usd: "0.001" } }],
  ["openapi", { "x-x402": { ...flat, amount: "1000" } }], ["openapi", { "x-x402": { ...flat, maxAmountRequired: "1000" } }],
  ["openapi", { "x-x402": { ...flat, max_amount_required: "1000" } }], ["openapi", { "x-x402": { ...flat, amount: "5000000", max_amount_required: "1000" } }],
  ["openapi", { "x-x402": { accepts: [{ scheme: "exact", ...flat, maxAmountRequired: "1000" }] } }],
  ["openapi", { "x-x402": { accepts: [{ scheme: "exact", ...flat, max_amount_required: "1000" }] } }],
  ["openapi", { "x-x402": { accepts: [{ scheme: "exact", ...flat, amount: "5000000", max_amount_required: "1000" }] } }],
  ["openapi", { "x-payment-info": { amount: "0.05", max_amount_required: "1000" } }],
  ["openapi", { "x-price-usd": "0.02", "x-payment-info": { amount_usd: "0.001" } }],
];
function priceWith(ix, row) {
  const p = rawPriceWith(ix, row);
  return typeof p === "number" ? `$${p}` : p;
}
function rawPriceWith(ix, [kind, v]) {
  const O = "https://snake.example";
  try {
    if (kind === "row") return ix.normaliseManifestTools({ resources: [{ resource: `${O}/api/a`, name: "a", ...v }] }, O)[0]?.price ?? null;
    if (kind === "manifest") return ix.normaliseManifestTools(v, O)[0]?.price ?? null;
    const r = ix.openapiOperationPayment(v);
    return r.paid === false ? "free" : (r.price ?? null);
  } catch (e) { return `THREW ${e.message}`; }
}

const BEFORE = ["$5", "$0.02", "$0.01", null, "$0.05", "$5", "$5", "$0.01", "$0.01", "$0.01", "$5", "$5", "$0.001", "$0.001", "$0.01", "$0.01", null, null, null, null, null, "$0.003", null, null, null, null, "$0.001", "$0.001", "$9", "$0.002", null, "$0.01", "$5", "$5", "$5", "$5", "$0.001", "$5", "$5", "$5", "$5", "$5", "$5", "$0.05", "$0.05", "$5", "$5", "$5", "$0.05", "$5", "$5", "$5", "$5", "$5", "$5", "$5", "$0.05", "$70000", null, null, "$5", "$0.05", "$0.001", null, "$5", "$5", "$0.002", "$0.002", "$0.001", null, "$5", "$0.01", "$0.01", "$0.01", null, "$0.001", "$9", "$5", "$5", "$5", "$5", null, "free", "$0.001", null, null, "$5", "$0.001", null, "$5", "$0.05", "$0.02"];
const NOW = ["$5", "$0.02", "$0.01", null, "$0.05", "$5", "$5", "$0.01", "$0.01", "$0.01", "$5", "$5", "$0.001", "$0.001", "$0.01", "$0.01", null, "$0.001", "$0.001", null, "$0.003", "$0.003", null, "$0.001", "$0.001", "$0.001", "$0.001", "$0.001", "$9", "$0.002", "$0.002", "$0.01", "$5", "$5", "$5", "$5", "$0.001", "$5", "$5", "$5", "$5", "$5", "$5", "$0.05", "$0.05", "$5", "$5", "$5", "$0.05", "$5", "$5", "$5", "$5", "$5", "$5", "$5", "$0.05", "$70000", null, "$5", "$5", "$0.05", "$0.001", "$0.001", "$5", "$5", "$0.002", "$0.002", "$0.001", "$0.001", "$5", "$0.01", "$0.01", "$0.01", "$0.01", "$0.001", "$9", "$5", "$5", "$5", "$5", null, "free", "$0.001", null, null, "$5", "$0.001", "$0.001", "$5", "$0.05", "$0.02"];

ok(ROWS.length === BEFORE.length && ROWS.length === NOW.length && ROWS.length >= 90, `the table lines up (${ROWS.length} rows)`);
let kept = 0, added = 0;
ROWS.forEach((row, i) => {
  const got = priceWith(ix, row), label = `#${i} ${row[0]} ${JSON.stringify(row[1]).slice(0, 140)}`;
  ok(got === NOW[i], `${label}: priced ${got}, recorded ${NOW[i]}`);
  if (BEFORE[i] != null) { kept++; ok(got === BEFORE[i], `${label}: was priced ${BEFORE[i]}, now ${got}`); }
  else if (got != null) added++;
});
ok(kept === BEFORE.filter((p) => p != null).length && kept >= 70 && added >= 10, `every entry that had a price is checked, and some gain one (${kept} kept, ${added} gained)`);

console.log(`test-seller-price-keys-differential: ${pass} passed, ${fail} failed (${ROWS.length} rows, ${kept} kept, ${added} gained)`);
process.exit(fail ? 1 : 0);
