// /api/route reads the served verdict /api/find reads (src/find.js
// rarestTermCovered): a query whose defining word the top row never
// mentions, with too little of the rest covered, is a miss (weakMatches,
// each row weak), not a pick. "ip geolocation" ranked ip-info first on the
// word "ip" alone, and neither ip-info nor asn-info gives a location. An
// outside seller that does offer it is still routed to, and route-execute's
// own-catalog path runs nothing for a task no tool here does.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
const { routeQuery, routeRarestVerdict, _cacheForTests } = await import("../src/x402-index.js");
const { KIT } = await import("../src/tools/kit.js");
const { NETWORK_TOOLS2 } = await import("../src/tools/network-kit2.js");
const { buildRouteExecuteTool } = await import("../src/tools/route-execute.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const catalog = {};
for (const t of [...KIT, ...NETWORK_TOOLS2]) catalog[t.route] = t;
const CTX = { baseUrl: "https://agent402.tools", catalog, prices: {}, network: "base", toolCount: Object.keys(catalog).length, walletName: "w" };
const cache = _cacheForTests();
cache.clear();
const route = (q, include = "all") => routeQuery({ query: q, top: 5, include, ...CTX });
const IP_TOOLS = new Set(["ip-info", "asn-info"]);
// The pick a caller acts on: the top row of an answer that reads as served.
const pickOf = (r) => (r.weakMatches || r.rarestTermCovered === false ? null : r.results?.[0]?.slug || null);

// Our own catalog has no IP geolocation tool (asn-info's country is the
// registry's, ip-info reads the address and its PTR record).
ok(!Object.values(catalog).some((t) => /geolocat|geoip/i.test(`${t.slug} ${t.name} ${t.description} ${(t.tags || []).join(" ")}`)), "no tool in these kits offers IP geolocation");

for (const q of ["ip geolocation", "geolocate ip address", "where is this IP located"]) {
  const r = route(q);
  const top = r.results?.[0]?.slug;
  ok(IP_TOOLS.has(top), `control: "${q}" still lists an IP tool first in the ranking (${top}), so the verdict below is what changed`);
  ok(r.rarestTermCovered === false && r.weakMatches === true && !IP_TOOLS.has(pickOf(r)) && r.results.every((x) => x.weak === true),
    `"${q}" reads as a miss, no IP tool is the pick (rarest ${r.rarestTerm}, covered ${r.rarestTermCovered}, share ${r.coverageShare})`);
}
for (const [q, want] of [["reverse dns for ip", "ip-info"], ["asn for ip", "asn-info"], ["is this ip address private", "ip-info"]]) {
  const r = route(q);
  ok(pickOf(r) === want && !r.results[0].weak, `"${q}" still picks ${want} (got ${pickOf(r)}; rarest ${r.rarestTerm} covered ${r.rarestTermCovered})`);
}

// An outside seller that does give an IP's location is the pick.
cache.set("https://geo.example", {
  manifest: { name: "geo", homepage: "https://geo.example" },
  tools: [{ seller: "https://geo.example", method: "POST", route: "/api/ip-geolocation", slug: "ip-geolocation", name: "IP geolocation", category: "data", tags: ["geolocation"], price: 0.01, networks: ["eip155:8453"], description: "Country, city and coordinates for an IP address." }],
  fetchedAt: Date.now(), error: null, history: [1, 1, 1],
});
{
  const r = route("ip geolocation");
  ok(pickOf(r) === "ip-geolocation" && r.rarestTermCovered === true, `an indexed seller that geolocates an IP is the pick (got ${pickOf(r)}, covered ${r.rarestTermCovered})`);
}
cache.clear();

// The verdict itself: the rarest defining word decides; a top row that misses
// it is served only when it covers two words, half their weight, one named.
ok(routeRarestVerdict(["ip", "geolocation"], [40, 0], 40, 0b01, 0b01).covered === false, "a top row covering only a two-letter word is not served");
ok(routeRarestVerdict(["reverse", "dns"], [3, 30], 40, 0b11, 0b01).covered === true, "a top row covering the rarest word is served");
ok(routeRarestVerdict(["convert", "statute", "miles", "kilometers"], [30, 0, 5, 5], 40, 0b1101, 0b1101).covered === true, "an incidental rare word no row writes does not unseat a top row that covers three words of the rest");
ok(routeRarestVerdict(["convert", "statute", "miles"], [30, 0, 5], 40, 0b101, 0b101).covered === false, "control: two covered words under half the weight stay a miss");
ok(routeRarestVerdict(["what", "is"], [1, 1], 2, 0, 0).rarestTerm === null, "function words define nothing: no verdict");

// route-execute's own-catalog path runs nothing for such a task.
{
  let ran = 0;
  const cat = {};
  for (const t of [...KIT, ...NETWORK_TOOLS2]) cat[t.route] = (t.slug === "ip-info" || t.slug === "asn-info") ? { ...t, handler: async (i) => { ran++; return t.slug === "ip-info" ? { ip: i?.ip, version: 4, scope: "private", ptr: [] } : { asn: 1 }; } } : t;
  const tool = buildRouteExecuteTool({ getCatalog: () => cat, tier: { slug: "route-execute", execPriceUsd: 0.01, underlyingMaxUsd: 0.01 } });
  let threw = null;
  try { await tool.handler({ task: "ip geolocation", params: { ip: "8.8.8.8" } }, {}); } catch (e) { threw = e; }
  ok(threw?.statusCode === 404 && ran === 0 && /none of them covers "geolocation"/.test(threw.message), `route-execute: "ip geolocation" runs nothing, 404 naming the word (${threw?.statusCode} ${String(threw?.message).slice(0, 80)})`);
  const r = await tool.handler({ task: "is this ip address private", params: { ip: "10.0.0.1" } }, {});
  ok(ran === 1 && r?.receipt?.slug === "ip-info", `control: route-execute still runs ip-info for an address-type task (${r?.receipt?.slug})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
