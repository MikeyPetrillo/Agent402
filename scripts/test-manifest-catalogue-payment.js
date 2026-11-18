#!/usr/bin/env node
// Guards how a seller's manifest hands its payment terms to the index: terms
// written on a catalogue entry (flat, as nested accepts, or once for the whole
// service) have to show up on the rows as networks, payees and a dollar price,
// or the router cannot send a buyer there. Runs offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { normaliseManifestTools } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };

const HOST = "https://seller.example";
const BASE_ID = "eip155:8453";
const BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WALLET = `0x${"a1".repeat(20)}`;
const show = (v) => JSON.stringify(v);
const chainsAre = (row, list) => show(row?.networks) === show(list);

// Each case: a manifest, how many rows it gives, and what each row must hold.
const manifestCases = [
  {
    what: "flat accept fields on a resources[] entry",
    manifest: { resources: [{ resource: `${HOST}/v1/topup`, scheme: "exact", network: BASE_ID, asset: BASE_USDC_CONTRACT, payTo: WALLET,
      amount: "100000", maxAmountRequired: "100000", extra: { name: "USD Coin", version: "2" } }] },
    rows: 1,
    each: (r) => [
      [chainsAre(r, [BASE_ID]), `networks ${show(r.networks)}`],
      [r.payToByNetwork?.[BASE_ID] === WALLET, "Base payee"],
      [r.price === "$0.1", `price ${r.price} from 100000 base units`],
      [r.evmDomainByNetwork?.[BASE_ID]?.name === "USD Coin", "EIP-712 domain name"],
    ],
  },
  {
    what: "accepts nested in a resources[] entry, maxAmountRequired only",
    manifest: { resources: [{ resource: `${HOST}/v1/lookup`,
      accepts: [{ scheme: "exact", network: BASE_ID, asset: BASE_USDC_CONTRACT, payTo: WALLET, maxAmountRequired: "30000", extra: { name: "USD Coin" } }] }] },
    rows: 1,
    each: (r) => [
      [chainsAre(r, [BASE_ID]), `networks ${show(r.networks)}`],
      [r.payToByNetwork?.[BASE_ID] === WALLET, "Base payee"],
      [r.price === "$0.03", `price ${r.price} from maxAmountRequired`],
    ],
  },
  {
    what: "one payment block for the whole service",
    manifest: {
      payment: { protocol: "x402", scheme: "exact", network: "base", asset: "USDC", asset_address: BASE_USDC_CONTRACT, pay_to: WALLET },
      endpoints: [{ path: "/stack", method: "POST", price: "$0.01" }, { path: "/stack/bulk", method: "POST", price: "$0.05" }],
    },
    rows: 2,
    each: (r) => [
      [chainsAre(r, [BASE_ID]), `${r.route}: "base" read as ${show(r.networks)}`],
      [r.payToByNetwork?.[BASE_ID] === WALLET, `${r.route}: the block's payee`],
    ],
    all: (rows) => [[show(rows.map((r) => r.price)) === show(["$0.01", "$0.05"]), `each entry keeps its own price: ${show(rows.map((r) => r.price))}`]],
  },
  {
    what: "a bare string sibling on a priced path",
    manifest: { resources: ["GET /ip-geo", { resource: `${HOST}/ip-geo`, method: "POST", network: BASE_ID, payTo: WALLET, asset: BASE_USDC_CONTRACT, amount: "1000" }] },
    rows: 2,
    all: (rows) => {
      const getRow = rows.find((r) => r.method === "GET");
      return [[chainsAre(getRow, [BASE_ID]), `the GET sibling takes the path's chain: ${show(getRow?.networks)}`]];
    },
  },
  {
    what: "a manifest that says nothing about money",
    manifest: { resources: ["POST /a", "POST /b"] },
    rows: 2,
    each: (r) => [
      [!(Array.isArray(r.networks) && r.networks.length > 0), `${r.route}: no chain`],
      [r.price === null, `${r.route}: no price`],
    ],
  },
];
for (const c of manifestCases) {
  const rows = normaliseManifestTools(c.manifest, HOST);
  ok(rows.length === c.rows, `${c.what}: ${rows.length} rows, expected ${c.rows}`);
  const verdicts = [...rows.flatMap((r) => (c.each ? c.each(r) : [])), ...(c.all ? c.all(rows) : [])];
  for (const [held, detail] of verdicts) ok(held, `${c.what}: ${detail}`);
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
