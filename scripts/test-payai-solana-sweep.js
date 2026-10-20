// The PayAI Solana listing sweep's diff logic, against fixtures. Offline:
// the ops script (scripts/payai-solana-sweep.js) reads /api/pricing and the
// facilitator registry; this drives its pure functions and the registry
// walker with a stub fetch, so nothing leaves the machine.
//
//   node scripts/test-payai-solana-sweep.js
import assert from "node:assert/strict";
import {
  solanaRoutesFromPricing, solanaRowsFromRegistry, diffListing, walkRegistry, routeKey, originKey, SOLANA_MAINNET_CAIP2,
} from "./payai-solana-sweep.js";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const SOL = SOLANA_MAINNET_CAIP2;
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const ORIGIN = "https://agent402.tools";

// --- which of our routes accept Solana ------------------------------------
{
  const pricing = {
    payment: { networks: ["base", "solana"] },
    endpoints: [
      { method: "POST", path: "/api/hash", slug: "hash", price: "$0.001" },
      { method: "POST", path: "/api/memory-write", slug: "memory-write", identityBound: true },
      { method: "POST", path: "/api/research-report", slug: "research-report", networks: ["eip155:8453", "eip155:137"] },
      { method: "POST", path: "/api/on-solana-too", slug: "on-solana-too", networks: ["eip155:8453", SOL] },
      { method: "POST", path: "/api/metered-chat", slug: "metered-chat", quoted: true },
    ],
  };
  const { railOn, routes } = solanaRoutesFromPricing(pricing);
  ok(railOn, "the Solana rail is read from payment.networks");
  ok(routes.map((r) => r.path).join(",") === "/api/hash,/api/on-solana-too,/api/metered-chat", `an identity-bound route and an EVM-only route are left out, the rest kept (${routes.map((r) => r.path).join(",")})`);
  ok(!solanaRoutesFromPricing({ payment: { networks: ["base"] }, endpoints: pricing.endpoints }).railOn, "a host without the Solana rail reads railOn: false");
}

// --- which registry rows are ours, on mainnet ------------------------------
{
  const items = [
    { resource: "https://agent402.tools/api/hash", accepts: [{ network: SOL, payTo: "J7a" }], lastUpdated: "2026-10-01T00:00:00Z" },
    { resource: "https://AGENT402.tools/api/hash?text=hi", accepts: [{ network: SOL }], lastUpdated: "2026-10-02T00:00:00Z" },
    { resource: "https://agent402.tools/api/base-only", accepts: [{ network: "eip155:8453" }] },
    { resource: "https://agent402.tools/api/devnet-only", accepts: [{ network: DEVNET }] },
    { resource: "https://other.example/api/hash", accepts: [{ network: SOL }] },
    { resource: "not a url", accepts: [{ network: SOL }] },
    { accepts: [{ network: SOL }] },
  ];
  const rows = solanaRowsFromRegistry(items, ORIGIN);
  ok(rows.length === 2 && rows.every((r) => /agent402\.tools\/api\/hash/i.test(r.resource)), `only our origin's rows with a mainnet accept count (${rows.length})`);
  ok(routeKey("https://AGENT402.tools/api/hash?text=hi#x") === "agent402.tools/api/hash" && routeKey("https://agent402.tools/api/hash/") === "agent402.tools/api/hash", "a route key drops the query, hash, case and trailing slash");
  ok(originKey("https://Agent402.Tools/x") === "https://agent402.tools" && originKey("nope") === null, "an origin key is scheme + lowercased host");
}

// --- the diff --------------------------------------------------------------
{
  const ours = [
    { method: "POST", path: "/api/hash", slug: "hash" },
    { method: "POST", path: "/api/qr", slug: "qr" },
    { method: "GET", path: "/api/time-now", slug: "time-now" },
  ];
  const listed = [
    { resource: "https://agent402.tools/api/hash", lastUpdated: "2026-10-01T00:00:00Z" },
    { resource: "https://agent402.tools/api/hash?text=hi", lastUpdated: "2026-10-02T00:00:00Z" },
    { resource: "https://agent402.tools/api/retired-tool", lastUpdated: "2026-08-01T00:00:00Z" },
    { resource: "https://agent402.tools/api/time-now/", lastUpdated: null },
  ];
  const d = diffListing({ ours, listed, origin: ORIGIN });
  ok(d.counts.ours === 3 && d.counts.listed === 3 && d.counts.listedRows === 4, `counts: 3 ours, 3 distinct listed routes from 4 rows (${JSON.stringify(d.counts)})`);
  ok(d.missing.length === 1 && d.missing[0].path === "/api/qr", "a route sold on Solana and never listed is missing");
  ok(d.stale.length === 1 && d.stale[0].resource === "https://agent402.tools/api/retired-tool", "a listed route we no longer serve is stale");
  ok(d.stale[0].lastUpdated === "2026-08-01T00:00:00Z", "the stale row keeps its lastUpdated");
  const same = diffListing({ ours, listed: ours.map((r) => ({ resource: `${ORIGIN}${r.path}` })), origin: ORIGIN });
  ok(same.missing.length === 0 && same.stale.length === 0, "a listing that matches the catalog diffs to nothing");
  const empty = diffListing({ ours, listed: [], origin: ORIGIN });
  ok(empty.missing.length === 3 && empty.stale.length === 0, "an empty listing reads every route as missing, none stale");
}

// --- the registry walk ------------------------------------------------------
{
  const total = 2500;
  const all = Array.from({ length: total }, (_, i) => ({ resource: `https://s${i}.example/r`, accepts: [] }));
  const calls = [];
  const fetchJson = async (url) => {
    const u = new URL(url);
    const limit = Number(u.searchParams.get("limit")), offset = Number(u.searchParams.get("offset"));
    calls.push([limit, offset]);
    return { items: all.slice(offset, offset + limit), pagination: { limit, offset, total } };
  };
  const { items, total: t } = await walkRegistry("https://registry.example/discovery/resources", { fetchJson });
  ok(items.length === total && t === total, `the walk collects every row (${items.length} of ${t})`);
  ok(calls.length === 3 && calls.every(([l]) => l === 1000) && calls[2][1] === 2000, `three pages of 1000, advanced by the rows received (${JSON.stringify(calls)})`);
  // A registry that stops answering before its stated total is a fault, not the end.
  let err = null;
  try { await walkRegistry("https://registry.example/discovery/resources", { fetchJson: async () => ({ items: [], pagination: { total: 5 } }) }); } catch (e) { err = e; }
  ok(err && /stopped short: 0 of 5/.test(err.message), "an empty page before the total fails the walk instead of reading as zero rows");
  const noTotal = await walkRegistry("https://registry.example/x?seller=y", { fetchJson: async (url) => (/offset=0\b/.test(url) ? { items: [{ resource: "a" }] } : { items: [] }) });
  ok(noTotal.items.length === 1 && noTotal.total === 1, "without a stated total the walk ends on the first empty page and keeps the query string");
}

console.log(`test-payai-solana-sweep: ${n} passed`);
