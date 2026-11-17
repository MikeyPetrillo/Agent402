// CLEANROOM 10: implement per spec 10
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
// CLEANROOM 10: implement per spec 10

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
// CLEANROOM 10: implement per spec 10
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
