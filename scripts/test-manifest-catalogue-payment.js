#!/usr/bin/env node
// A seller can publish their payment terms INSIDE a catalogue entry. Three
// such shapes are live right now, and the catalogue reader took the entry's
// URL, name, description and price string and dropped everything about money:
//
//   resources: [{ resource, accepts: [{network, asset, payTo, …}] }]   nested
//   resources: [{ resource, scheme, network, asset, payTo, amount }]   flat
//   payment:   { network, asset_address, pay_to, … }                   service-wide
//
// The row came out with networks: [], so the seller's `networks` aggregate was
// empty and dispatch eligibility read `network_unknown`: on the marketplace,
// invisible to the router and to its own chain page. Same defect class as the
// single-resource manifest (scripts/test-single-resource-manifest.js) and the
// same cost — listed and unroutable is worse than absent, it looks like it
// worked.
//
// Measured against the live index 2026-09-15: 304 sellers labelled
// `network_unknown`, 83 still serving a manifest, and 59 of those 83 declaring
// a chain in one of these three shapes — 49 of them eip155:8453. The fixtures
// below are the exact shapes of three of them, with addresses replaced.
import { normaliseManifestTools } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
const BASE = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYTO = "0x00000000000000000000000000000000000000aa";

// --- shape 1: flat payment fields on the catalogue entry --------------------
{
  const ORIGIN = "https://flat.example";
  const tools = normaliseManifestTools({
    resources: [{
      scheme: "exact", network: BASE, maxAmountRequired: "100000", amount: "100000",
      resource: `${ORIGIN}/v1/topup`, description: "Top up credits.",
      mimeType: "application/json", payTo: PAYTO, asset: USDC,
      extra: { name: "USD Coin", version: "2" },
    }],
  }, ORIGIN);
  ok(tools.length === 1, `flat: ${tools.length} tools, want 1`);
  const t = tools[0] || {};
  ok(JSON.stringify(t.networks) === `["${BASE}"]`, `flat networks ${JSON.stringify(t.networks)} — this is the router-invisible case`);
  ok(t.payToByNetwork?.[BASE] === PAYTO, `flat payTo ${JSON.stringify(t.payToByNetwork)}`);
  ok(t.price === "$0.1", `flat price ${t.price} (100000 atomic USDC is $0.1)`);
  ok(t.evmDomainByNetwork?.[BASE]?.name === "USD Coin", `flat EIP-712 domain ${JSON.stringify(t.evmDomainByNetwork)}`);
}

// --- shape 2: accepts nested inside the catalogue entry ---------------------
{
  const ORIGIN = "https://nested.example";
  const tools = normaliseManifestTools({
    x402Version: 2,
    resources: [{
      resource: `${ORIGIN}/service`,
      accepts: [{
        scheme: "exact", network: BASE, asset: USDC, maxAmountRequired: "30000",
        resource: `${ORIGIN}/service`, description: "Pre-trade go/no-go verdict.",
        mimeType: "application/json", payTo: PAYTO, maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      }],
    }],
  }, ORIGIN);
  ok(tools.length === 1, `nested: ${tools.length} tools, want 1`);
  const t = tools[0] || {};
  ok(JSON.stringify(t.networks) === `["${BASE}"]`, `nested networks ${JSON.stringify(t.networks)}`);
  ok(t.payToByNetwork?.[BASE] === PAYTO, `nested payTo ${JSON.stringify(t.payToByNetwork)}`);
  ok(t.price === "$0.03", `nested price ${t.price} — maxAmountRequired is the v1 spelling and must be read`);
}

// --- shape 3: one service-wide payment block, many routes -------------------
{
  const ORIGIN = "https://service.example";
  const tools = normaliseManifestTools({
    x402Version: 2,
    service: { name: "Tech Detect", base_url: ORIGIN },
    payment: {
      protocol: "x402", scheme: "exact", network: "base", network_name: "Base Mainnet",
      chain_id: 8453, asset: "USDC", asset_address: USDC, pay_to: PAYTO,
    },
    endpoints: [
      { path: "/stack", method: "POST", name: "Detect stack", price: "$0.01" },
      { path: "/stack/bulk", method: "POST", name: "Detect in bulk", price: "$0.05" },
    ],
  }, ORIGIN);
  ok(tools.length === 2, `service-wide: ${tools.length} tools, want 2`);
  for (const t of tools) {
    ok(JSON.stringify(t.networks) === `["${BASE}"]`,
      `service-wide ${t.route}: networks ${JSON.stringify(t.networks)} — "base" must normalise to CAIP-2`);
    ok(t.payToByNetwork?.[BASE] === PAYTO, `service-wide ${t.route}: payTo ${JSON.stringify(t.payToByNetwork)}`);
  }
  ok(tools[0].price === "$0.01" && tools[1].price === "$0.05",
    `service-wide prices ${tools.map((t) => t.price).join(",")} — the entry's own price must survive`);
}

// --- a thin sibling on the same path inherits the chain ---------------------
{
  const ORIGIN = "https://sibling.example";
  const tools = normaliseManifestTools({
    resources: [`GET /ip-geo`, { resource: `${ORIGIN}/ip-geo`, method: "POST", network: BASE, payTo: PAYTO, asset: USDC, amount: "1000" }],
  }, ORIGIN);
  ok(tools.length === 2, `sibling: ${tools.length} tools, want 2`);
  const get = tools.find((t) => t.method === "GET") || {};
  ok(JSON.stringify(get.networks) === `["${BASE}"]`,
    `sibling GET networks ${JSON.stringify(get.networks)} — one path, one set of payment terms`);
}

// --- a manifest that declares nothing stays as it was -----------------------
{
  const ORIGIN = "https://silent.example";
  const tools = normaliseManifestTools({ resources: [`POST /a`, `POST /b`] }, ORIGIN);
  ok(tools.length === 2, `silent: ${tools.length} tools, want 2`);
  ok(tools.every((t) => !(t.networks || []).length), "a manifest that says nothing about money must not gain a chain");
  ok(tools.every((t) => t.price === null), "a manifest that names no price must not gain one");
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
