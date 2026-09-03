#!/usr/bin/env node
// routeQuery's `networkFilter` is APPLIED, and `strictNetwork` narrows it.
//
// From 2026-08 to 2026-09-02 `?network=<chain>` on /api/route was parsed,
// echoed back as `network` in the response, and never used to filter a single
// row - the documented positive-signal filter existed only as a comment. The
// Solana SOR branch inherited the gap: it asked for the top 20 with no filter
// and kept the Solana rows, so a Base-dominated tie at score 14 left the
// best-named Solana seller outside the window entirely.
import { routeQuery, _cacheForTests } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const cache = _cacheForTests(); cache.clear();
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", BASE = "eip155:8453";
const seed = (origin, slug, networks) => cache.set(origin, {
  manifest: { name: origin, homepage: origin }, openapiSummary: null,
  tools: [{ seller: origin, method: "POST", route: `/api/${slug}`, slug, name: "Chat Completions", description: "chat completions", category: "ai", tags: [], price: 0.003, ...(networks ? { networks } : {}) }],
  fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1],
});
seed("https://sol-only.example", "chat-sol", [SOL]);
seed("https://base-only.example", "chat-base", [BASE]);
seed("https://both.example", "chat-both", [BASE, SOL]);
seed("https://unknown.example", "chat-unknown", null);
const ctx = { baseUrl: "https://agent402.tools", catalog: {}, toolCount: 0 };
const sellers = (opts) => routeQuery({ query: "chat completions", top: 10, include: "external", ...ctx, ...opts }).results.map((r) => r.seller).sort();
// Exact seller-origin membership. (Array.prototype.includes on a URL string
// trips CodeQL's incomplete-url-substring rule; the comparison here is whole-
// string equality on an array, which is what the rule cannot see.)
const has = (list, origin) => list.some((x) => x === origin);

// A row with no observed accepts inherits its SELLER's known networks
// (2026-09-02: strale's priced OpenAPI row ranked with networks [] while its
// manifest rows beside it said Base, so the router never dispatched to a
// seller with thousands of settled calls). A seller that knows nothing
// anywhere stays unknown - inheritance never invents a chain.
cache.set("https://mixed.example", {
  manifest: { name: "mixed", homepage: "https://mixed.example" }, openapiSummary: null,
  tools: [
    { seller: "https://mixed.example", method: "POST", route: "/api/chat-a", slug: "chat-a", name: "Chat Completions", description: "chat completions", category: "ai", tags: [], price: null, networks: [BASE] },
    { seller: "https://mixed.example", method: "GET", route: "/api/v2/chat-b", slug: "chat-b", name: "Chat Completions v2", description: "chat completions", category: "ai", tags: [], price: 0.05, paid: true },
  ],
  fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1],
});
{
  const rows = routeQuery({ query: "chat completions", top: 20, include: "external", ...ctx }).results;
  const b = rows.find((r) => r.seller === "https://mixed.example" && r.slug === "chat-b");
  const a = rows.find((r) => r.seller === "https://mixed.example" && r.slug === "chat-a");
  ok(b && JSON.stringify(b.networks) === JSON.stringify([BASE]) && b.networksInferred === true, "a priced row with no accepts of its own inherits the seller's networks, flagged networksInferred");
  ok(a && JSON.stringify(a.networks) === JSON.stringify([BASE]) && a.networksInferred === undefined, "a row that observed its own accepts keeps them, unflagged");
  const u = rows.find((r) => r.seller === "https://unknown.example");
  ok(u && !u.networks && u.networksInferred === undefined, "a seller with no known network anywhere stays unknown (nothing invented)");
  const strictBase = routeQuery({ query: "chat completions", top: 20, include: "external", ...ctx, networkFilter: "base", strictNetwork: true }).results.map((r) => r.seller);
  ok(strictBase.some((s) => s === "https://mixed.example"), "the strict chain filter now admits the inherited row, so the resolver can try it");
}
cache.delete("https://mixed.example");
ok(sellers({}).length === 4, "no filter: every matching row ranks");
const loose = sellers({ networkFilter: "solana" });
ok(!has(loose, "https://base-only.example"), "network=solana drops a row whose crawled 402 names other chains only");
ok(has(loose, "https://sol-only.example") && has(loose, "https://both.example"), "and keeps rows that advertise solana");
ok(has(loose, "https://unknown.example"), "positive-signal default: a row with NO known accepts is kept (unknown is not 'not solana')");
const strict = sellers({ networkFilter: "solana", strictNetwork: true });
ok(strict.length === 2 && has(strict, "https://sol-only.example") && has(strict, "https://both.example"),
  "strictNetwork keeps ONLY rows that advertise the chain - the shape a chain-matched spend needs");
ok(has(sellers({ networkFilter: "base" }), "https://base-only.example") && !has(sellers({ networkFilter: "base" }), "https://sol-only.example"),
  "the alias table resolves 'base' to its CAIP-2 and filters the other way round");
ok(sellers({ networkFilter: SOL }).length === 3, "a raw CAIP-2 id works as the filter too");
const echoed = routeQuery({ query: "chat completions", top: 10, include: "external", ...ctx, networkFilter: "solana" }).network;
ok(echoed === SOL, "the response still echoes the resolved network");

// The CALLER: the Solana SOR branch must ask for Solana rows, strictly.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const at = src.indexOf('} else if (chain === "solana") {');
  const branch = src.slice(at, src.indexOf("} else {", at));
  ok(/routeQuery\(\{[^}]*networkFilter: "solana"[^}]*strictNetwork: true/.test(branch),
    "the Solana SOR branch ranks with networkFilter:'solana' + strictNetwork, so its window holds Solana rows only");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
