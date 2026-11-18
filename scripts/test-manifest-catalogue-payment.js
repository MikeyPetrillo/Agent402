#!/usr/bin/env node
// Payment terms written INSIDE a manifest's catalogue entries (flat fields,
// nested accepts, a service-wide payment block) must reach the index rows as
// chains, receiving addresses and a dollar price. Without them a seller is
// listed but cannot be routed. Offline: no server, no network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { normaliseManifestTools } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };

const ORIGIN = "https://seller.example";
const BASE = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const P = "0x" + "a1".repeat(20);
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1. Flat payment fields on a resources[] entry.
{
  const rows = normaliseManifestTools({
    resources: [{
      scheme: "exact", network: BASE, amount: "100000", maxAmountRequired: "100000", payTo: P, asset: USDC,
      extra: { name: "USD Coin", version: "2" }, resource: `${ORIGIN}/v1/topup`,
    }],
  }, ORIGIN);
  ok(rows.length === 1, `flat entry gives one row (got ${rows.length})`);
  const r = rows[0] || {};
  ok(sameList(r.networks, [BASE]), `flat entry networks (got ${JSON.stringify(r.networks)})`);
  ok(r.payToByNetwork?.[BASE] === P, "flat entry payTo on Base");
  ok(r.price === "$0.1", `flat entry price reads base units (got ${r.price})`);
  ok(r.evmDomainByNetwork?.[BASE]?.name === "USD Coin", "flat entry carries the EIP-712 domain name");
}

// 2. Accepts nested in a resources[] entry, priced by maxAmountRequired only.
{
  const rows = normaliseManifestTools({
    resources: [{
      resource: `${ORIGIN}/v1/lookup`,
      accepts: [{ scheme: "exact", network: BASE, maxAmountRequired: "30000", asset: USDC, payTo: P, extra: { name: "USD Coin" } }],
    }],
  }, ORIGIN);
  ok(rows.length === 1, `nested accepts give one row (got ${rows.length})`);
  const r = rows[0] || {};
  ok(sameList(r.networks, [BASE]), `nested accepts networks (got ${JSON.stringify(r.networks)})`);
  ok(r.payToByNetwork?.[BASE] === P, "nested accepts payTo");
  ok(r.price === "$0.03", `maxAmountRequired prices the row (got ${r.price})`);
}

// 3. A service-wide payment block applies to every endpoint; the entries' own prices stand.
{
  const rows = normaliseManifestTools({
    payment: { protocol: "x402", scheme: "exact", network: "base", asset: "USDC", asset_address: USDC, pay_to: P },
    endpoints: [
      { path: "/stack", method: "POST", price: "$0.01" },
      { path: "/stack/bulk", method: "POST", price: "$0.05" },
    ],
  }, ORIGIN);
  ok(rows.length === 2, `service-wide block gives two rows (got ${rows.length})`);
  for (const r of rows) {
    ok(sameList(r.networks, [BASE]), `${r.route}: short network name normalizes to CAIP-2 (got ${JSON.stringify(r.networks)})`);
    ok(r.payToByNetwork?.[BASE] === P, `${r.route}: block payTo applies`);
  }
  ok(rows[0]?.price === "$0.01" && rows[1]?.price === "$0.05", `entry prices survive (got ${rows.map((r) => r.price)})`);
}

// 4. A thin string sibling on the same path inherits the chain.
{
  const rows = normaliseManifestTools({
    resources: ["GET /ip-geo", { resource: `${ORIGIN}/ip-geo`, method: "POST", network: BASE, payTo: P, asset: USDC, amount: "1000" }],
  }, ORIGIN);
  ok(rows.length === 2, `GET and POST rows (got ${rows.length})`);
  const get = rows.find((r) => r.method === "GET");
  ok(sameList(get?.networks, [BASE]), `GET sibling inherits the path's chain (got ${JSON.stringify(get?.networks)})`);
}

// 5. A manifest that declares nothing about money.
{
  const rows = normaliseManifestTools({ resources: ["POST /a", "POST /b"] }, ORIGIN);
  ok(rows.length === 2, `two bare rows (got ${rows.length})`);
  ok(rows.every((r) => !(Array.isArray(r.networks) && r.networks.length)), "no row invents a chain");
  ok(rows.every((r) => r.price === null), "no row invents a price");
}

// A catalogue row with only a bare `amount`, under a manifest whose accepts
// name USDC by contract address, is quoting base units (0.10 USDC), not $100000.
{
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const manifest = {
    x402Version: 2, network: "base", payTo: "0x" + "c3".repeat(20),
    accepts: [{ scheme: "exact", network: "base", amount: "100000", asset: USDC_BASE, payTo: "0x" + "c3".repeat(20) }],
    services: [{ method: "POST", path: "/check", name: "check", amount: "100000" }],
  };
  const [row] = normaliseManifestTools(manifest, "https://seller.example");
  ok(row?.price === "$0.1", `a bare amount under an accepts block with an asset address reads as base units (got ${row?.price})`);
  // Without payment context anywhere, a bare amount still means dollars.
  const plain = normaliseManifestTools({ services: [{ method: "POST", path: "/check", name: "check", amount: "2" }] }, "https://seller.example");
  ok(plain[0]?.price === "$2", `a bare amount with no payment context anywhere stays dollars (got ${plain[0]?.price})`);
  // A row's own dollar field wins over the manifest context.
  const own = normaliseManifestTools({ ...manifest, services: [{ method: "POST", path: "/check", name: "check", amount: "100000", price: "$0.25" }] }, "https://seller.example");
  ok(own[0]?.price === "$0.25", `a row's own price field is kept (got ${own[0]?.price})`);
  // A small whole figure stays dollars: 1 and "5" read as $1 and $5, never
  // $0.000001; a row with a unit or currency label is left to its own reading.
  for (const [amount, want] of [[1, "$1"], ["5", "$5"], [999, "$999"], [1000, "$0.001"], ["1000", "$0.001"], ["5000", "$0.005"]]) {
    const r = normaliseManifestTools({ ...manifest, services: [{ method: "POST", path: "/check", name: "check", amount }] }, "https://seller.example");
    ok(r[0]?.price === want, `bare amount ${JSON.stringify(amount)} under base-unit accepts reads ${want} (got ${r[0]?.price})`);
  }
  const labelled = normaliseManifestTools({ ...manifest, services: [{ method: "POST", path: "/check", name: "check", amount: 100000, unit: "usd" }] }, "https://seller.example");
  ok(labelled[0]?.price !== "$0.1", `a row with a unit label is not reread as base units (got ${labelled[0]?.price})`);
  // A ticker in the manifest accepts is not payment context.
  const ticker = normaliseManifestTools({ accepts: [{ network: "base", asset: "USDC", amount: "2" }], services: [{ method: "POST", path: "/check", name: "check", amount: "2" }] }, "https://seller.example");
  ok(ticker[0]?.price === "$2", `a ticker-only manifest accept leaves a bare amount as dollars (got ${ticker[0]?.price})`);
}

// A paths-manifest entry that lists its own `parameters` is still an x402
// entry; only verb keys and $ref mark an OpenAPI path item.
{
  const rows = normaliseManifestTools({ paths: { "/q": { methods: ["GET"], parameters: [{ name: "q" }], payment: { networks: ["eip155:8453"], payTo: "0x" + "ab".repeat(20) } } } }, "https://seller.example");
  ok(rows.length === 1 && (rows[0].networks || []).includes("eip155:8453"), `a paths entry with parameters is read (${rows.length} rows)`);
  const oa = normaliseManifestTools({ paths: { "/q": { get: { responses: {} }, parameters: [] } } }, "https://seller.example");
  ok(oa.every((r) => !(r.networks || []).length), "an OpenAPI path item keyed by verb is not read as a paths entry");
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
