#!/usr/bin/env node
// Listing coverage (scripts/listing-coverage.js) from fixtures, offline: the
// per-route, per-chain, per-registry verdict, the identity-bound and
// network-restricted rules, duplicate rows, the chain alias map, the OpenAPI
// example reader and the unioned walk.
//
//   node scripts/test-listing-coverage.js
import assert from "node:assert/strict";
import {
  CHAINS, chainOf, coverageFor, missingIn, routeSellsOn, rowsByRoute, examplesFromOpenapi, renderTable, walkUnion, priceToUsd,
} from "./listing-coverage.js";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const SOL = CHAINS.solana, BASE = CHAINS.base, POLY = CHAINS.polygon;
const ORIGIN = "https://agent402.tools";

ok(chainOf("Solana").caip2 === SOL && chainOf(SOL).name === "solana" && chainOf("nope") === null, "a chain resolves by alias or CAIP-2, unknown is null");
ok(priceToUsd("$0.010") === 0.01 && priceToUsd(null) === 0 && priceToUsd("from $0.08") === 0.08, "prices parse to USD");

// --- sells-on rules ---------------------------------------------------------
{
  const rails = ["base", "solana", "polygon"];
  ok(routeSellsOn({ path: "/api/hash" }, chainOf("solana"), rails), "an unrestricted route sells on every advertised rail");
  ok(!routeSellsOn({ path: "/api/memory", identityBound: true }, chainOf("solana"), rails) && routeSellsOn({ path: "/api/memory", identityBound: true }, chainOf("base"), rails), "an identity-bound route sells on EVM only");
  ok(!routeSellsOn({ path: "/api/x", networks: [BASE] }, chainOf("solana"), rails) && routeSellsOn({ path: "/api/x", networks: [BASE, SOL] }, chainOf("solana"), rails), "a networks list restricts the route");
  ok(!routeSellsOn({ path: "/api/hash" }, chainOf("stellar"), rails), "a rail the host does not advertise sells nothing");
  ok(routeSellsOn({ path: "/api/hash" }, chainOf("stellar"), null), "no rail list at all means every chain is possible");
}

// --- rows by route --------------------------------------------------------
{
  const rows = rowsByRoute([
    { resource: "https://agent402.tools/api/hash", accepts: [{ network: BASE }], lastUpdated: "2026-10-01T00:00:00Z" },
    { resource: "https://AGENT402.tools/api/hash?x=1", accepts: [{ network: SOL }], lastUpdated: "2026-10-05T00:00:00Z" },
    { resource: "https://other.example/api/hash", accepts: [{ network: SOL }] },
    { resource: "garbage" }, null,
  ], ORIGIN);
  const h = rows.get("agent402.tools/api/hash");
  ok(rows.size === 1 && h.rows === 2 && h.networks.has(BASE) && h.networks.has(SOL) && h.lastUpdated === "2026-10-05T00:00:00Z", "duplicate rows for one route union their accepts and keep the newest update");
}

// --- the coverage verdict ----------------------------------------------------
const pricing = {
  payment: { networks: ["base", "solana", "polygon"] },
  endpoints: [
    { method: "POST", path: "/api/hash", slug: "hash", price: "$0.001" },
    { method: "GET", path: "/api/uuid", slug: "uuid", price: "$0.001" },
    { method: "POST", path: "/api/memory", slug: "memory-write", price: "$0.001", identityBound: true },
    { method: "POST", path: "/api/evm-only", slug: "evm-only", price: "$0.60", networks: [BASE, POLY] },
    { method: "POST", path: "/v1/metered", slug: "metered", price: "$0.001", quoted: true },
    { method: "GET", path: "/api/hash", slug: "hash-get", price: "$0.001" },
    { path: 7 }, null,
  ],
};
const bazaar = [
  { resource: "https://agent402.tools/api/hash", accepts: [{ network: BASE }, { network: SOL }, { network: POLY }] },
  { resource: "https://agent402.tools/api/uuid", accepts: [{ network: BASE }] },
  { resource: "https://agent402.tools/api/memory", accepts: [{ network: BASE }, { network: POLY }] },
  { resource: "https://agent402.tools/api/evm-only", accepts: [{ network: BASE }, { network: POLY }] },
  { resource: "https://agent402.tools/api/retired", accepts: [{ network: BASE }] },
];
const payai = [
  { resource: "https://agent402.tools/api/hash?text=x", accepts: [{ network: SOL }] },
  { resource: "https://agent402.tools/api/uuid", accepts: [{ network: SOL }] },
];
const cov = coverageFor({ pricing, bazaarItems: bazaar, payaiItems: payai, origin: ORIGIN, chains: ["base", "solana", POLY] });
{
  ok(cov.routes.length === 5, `one route per path: ${cov.routes.length} (a second method on the same path shares its rows)`);
  const s = cov.summary;
  ok(s.bazaar.base.eligible === 5 && s.bazaar.base.listed === 4 && s.bazaar.base.missing === 1, `bazaar/base 4 of 5 listed (${JSON.stringify(s.bazaar.base)})`);
  ok(s.bazaar.solana.eligible === 3 && s.bazaar.solana.listed === 1 && s.bazaar.solana.missing === 2, `bazaar/solana: identity-bound and EVM-only routes are not eligible, uuid lacks the accept (${JSON.stringify(s.bazaar.solana)})`);
  ok(s.payai.solana.eligible === 3 && s.payai.solana.listed === 2 && s.payai.solana.missing === 1, `payai/solana 2 of 3 (${JSON.stringify(s.payai.solana)})`);
  ok(s.payai.base.listed === 0 && s.payai.base.missing === 5, "payai/base: rows without a Base accept list nothing");
  ok(s.bazaar.polygon.eligible === 5 && s.bazaar.polygon.listed === 3, "a chain given as CAIP-2 works like its alias");
  ok(s.bazaarRows === 5 && s.payaiRows === 2, "row counts cover every row under the origin, retired ones included");
  const memory = cov.routes.find((r) => r.slug === "memory-write");
  ok(memory.sells.solana === false && memory.bazaar.solana === null && memory.payai.solana === null, "a route that does not sell on a chain is neither listed nor missing there");
  ok(missingIn(cov, "payai", "solana").map((r) => r.path).join() === "/v1/metered", "missingIn names the quoted route PayAI lacks on Solana");
  ok(missingIn(cov, "bazaar", "solana").map((r) => r.path).join() === "/api/uuid,/v1/metered", "missingIn on the Bazaar names the row lacking the accept and the unlisted route");
  const metered = cov.routes.find((r) => r.slug === "metered");
  ok(metered.quoted === true && metered.bazaarRow === false && metered.payaiRow === false, "quoted and row-presence flags ride on the route");
  const table = renderTable(cov);
  ok(/bazaar\s+base\s+eip155:8453\s+5\s+4\s+1/.test(table) && /payai\s+solana/.test(table), "the table carries one line per registry and chain");
  assert.throws(() => coverageFor({ pricing, origin: ORIGIN, chains: ["mars"] }), /unknown chain/, "an unknown chain is refused");
  ok(true, "an unknown chain is refused");
  assert.throws(() => coverageFor({ pricing, origin: "nope" }), /bad origin/);
  ok(true, "a bad origin is refused");
}

// --- OpenAPI examples --------------------------------------------------------
{
  const ex = examplesFromOpenapi({ paths: {
    "/api/hash": { post: { requestBody: { content: { "application/json": { example: { text: "a" } } } } } },
    "/api/uuid": { get: { parameters: [{ name: "n", example: 2 }, { name: "x" }] } },
    "/api/empty": { get: {} },
  } });
  ok(ex.get("POST /api/hash").text === "a" && ex.get("GET /api/uuid").n === 2 && !("x" in ex.get("GET /api/uuid")) && Object.keys(ex.get("GET /api/empty")).length === 0, "examples come from the body example, else parameter examples, else {}");
}

// --- the unioned walk ------------------------------------------------------
{
  const pages = [
    { items: [{ resource: "a", lastUpdated: "1", accepts: [{ network: SOL }] }, { resource: "b", lastUpdated: "1", accepts: [] }], pagination: { total: 3 } },
    { items: [{ resource: "c", lastUpdated: "1", accepts: [] }], pagination: { total: 3 } },
  ];
  let calls = 0;
  const fetchJson = async () => pages[calls++ % 2];
  const r = await walkUnion("https://registry.example/resources", { walks: 2, fetchJson });
  ok(calls === 4 && r.items.length === 3 && r.total === 3, `two walks are unioned by resource and update (${calls} page reads, ${r.items.length} rows)`);
}

console.log(`test-listing-coverage: ${n} passed`);
