// Capability gaps (src/capability-gaps.js): one explicit list of tasks this
// host's own catalog does not do, read by /api/find, /api/route and
// route-and-execute. A query that asks for one is a miss unless a candidate
// row is NAMED for it (slug or name, never a description), and such a row,
// an outside seller's included, is the pick. Every other query is ranked,
// answered and run exactly as before: a place, a company or a country a
// query names is a value the tool takes, never a reason to call it a miss.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
const { routeQuery, routeQueryAsync, _cacheForTests } = await import("../src/x402-index.js");
const { capabilityGap, gapNamedBy, CAPABILITY_GAPS } = await import("../src/capability-gaps.js");
const { findTools } = await import("../src/find.js");
const { KIT } = await import("../src/tools/kit.js");
const { NETWORK_TOOLS2 } = await import("../src/tools/network-kit2.js");
const { DATA_TOOLS } = await import("../src/tools/data-kit.js");
const { GOV_TOOLS } = await import("../src/tools/gov-kit.js");
const { HOLIDAY_TOOLS } = await import("../src/tools/holidays-kit.js");
const { CHAIN_TOOLS } = await import("../src/tools/chain-kit.js");
const { buildRouteExecuteTool } = await import("../src/tools/route-execute.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const TOOLS = [...KIT, ...NETWORK_TOOLS2, ...DATA_TOOLS, ...GOV_TOOLS, ...HOLIDAY_TOOLS, ...CHAIN_TOOLS];
const catalog = {};
for (const t of TOOLS) catalog[t.route] = t;
const CTX = { baseUrl: "https://agent402.tools", catalog, prices: {}, network: "base", toolCount: Object.keys(catalog).length, walletName: "w" };
const cache = _cacheForTests();
cache.clear();
const route = (q, extra = {}) => routeQuery({ query: q, top: 5, include: "all", ...CTX, ...extra });
// The pick a caller acts on: the top row of an answer that does not read as a miss.
const pickOf = (r) => (r.weakMatches ? null : r.results?.[0]?.slug || null);
const flagged = (r) => r.weakMatches === true || "hint" in r || r.results.some((x) => "weak" in x) || "rarestTerm" in r || "rarestTermCovered" in r;
const GAP_QUERIES = ["ip geolocation", "geolocate ip address", "where is this IP located"];
const seller = (origin, tool) => ({ manifest: { name: "s", homepage: origin }, tools: [{ seller: origin, method: "POST", category: "data", tags: [], price: 0.01, networks: ["eip155:8453"], ...tool }], fetchedAt: Date.now(), error: null, history: [1, 1, 1] });

// ---- the matcher: the IP sense only ----
for (const q of [...GAP_QUERIES, "geoip", "geo-ip lookup", "ip-geolocation", "geolocate ip", "ip location", "location of an ip address", "where is 8.8.8.8 located", "IP address geolocation for 1.2.3.4"]) {
  ok(capabilityGap(q)?.id === "ip-geolocation", `"${q}" asks for IP geolocation`);
}
for (const q of ["weather for my location", "place lookup location", "geolocation of a street address", "geocode an address", "reverse dns for ip", "asn for ip", "is this ip address private", "where is the ip address for example.com",
  "weather forecast for Berlin", "whois for amazon", "earthquakes near california", "country info for brazil", "public holidays in germany", "token price on solana", "holidays in germany", "tip calculator", "zip code lookup", "store locator", ""]) {
  ok(capabilityGap(q) === null, `"${q}" is in no gap family`);
}
ok(gapNamedBy(CAPABILITY_GAPS[0], "ip-geolocation", "IP geolocation") && gapNamedBy(CAPABILITY_GAPS[0], "geoip", "Lookup") && gapNamedBy(CAPABILITY_GAPS[0], "ip-to-country", "IP to country"), "a row named for IP geolocation covers the gap");
ok(!gapNamedBy(CAPABILITY_GAPS[0], "ip-info", "IP address type and reverse DNS") && !gapNamedBy(CAPABILITY_GAPS[0], "geocode", "Geocode an address") && !gapNamedBy(CAPABILITY_GAPS[0], "weather", "Weather by location"), "a row named for something else does not");
// No tool of ours is named for it (the reason the family is on the list).
{
  const named = TOOLS.filter((t) => gapNamedBy(CAPABILITY_GAPS[0], t.slug, t.name)).map((t) => t.slug);
  ok(named.length === 0, `no tool in these kits is named for IP geolocation (${named.join(", ") || "none"})`);
}

// ---- /api/route: data values are never a miss ----
for (const [q, want] of [["weather forecast for Berlin", "weather-forecast"], ["whois for amazon", "whois"], ["earthquakes near california", "earthquakes"], ["country info for brazil", "country-info"],
  ["public holidays in germany", "public-holidays"], ["token price on solana", "token-price"], ["reverse dns for ip", "ip-info"], ["asn for ip", "asn-info"], ["is this ip address private", "ip-info"]]) {
  const r = route(q);
  ok(!flagged(r) && !("capabilityGap" in r), `"${q}" carries no miss flag, hint or weak row`);
  ok(pickOf(r) === want, `"${q}" picks ${want} (got ${pickOf(r)})`);
}

// ---- /api/route: the gap family is a miss on our own catalog ----
for (const q of GAP_QUERIES) {
  const r = route(q);
  ok(r.results.length > 0 && r.weakMatches === true && r.capabilityGap === "ip-geolocation" && r.capabilityGapCovered === false && pickOf(r) === null && r.results.every((x) => x.weak === true) && /IP geolocation/.test(r.hint || ""),
    `"${q}" reads as a miss with our own catalog (top ${r.results[0]?.slug}, gap ${r.capabilityGap}, covered ${r.capabilityGapCovered})`);
}

// ---- a listing that only DESCRIBES itself with the word clears nothing ----
cache.set("https://stuffed.example", seller("https://stuffed.example", { route: "/api/ip-lookup", slug: "ip-lookup", name: "IP lookup", tags: ["geolocation"], description: "ip geolocation geolocate geoip ip location where is this ip located country city coordinates" }));
for (const q of GAP_QUERIES) {
  const r = route(q, { top: 10 });
  ok(r.weakMatches === true && r.capabilityGapCovered === false && pickOf(r) === null && r.results.every((x) => x.weak === true), `"${q}": a description-only listing does not clear the miss or take the pick`);
}
// ...and stuffing data words changes no other query's verdict either way.
cache.set("https://wx.example", seller("https://wx.example", { route: "/api/weather-forecast", slug: "weather-forecast", name: "Weather forecast", description: "Weather forecast for a place. berlin london paris tokyo germany france" }));
{
  const r = route("weather forecast for berlin");
  ok(!flagged(r), "a listing that adds city names to its description changes no verdict (there is none to change)");
}

// ---- an outside seller NAMED for it is the pick, over the stuffed row ----
cache.set("https://geo.example", seller("https://geo.example", { route: "/api/ip-geolocation", slug: "ip-geolocation", name: "IP geolocation", description: "Country, city and coordinates for an address." }));
for (const q of GAP_QUERIES) {
  const r = route(q, { top: 10 });
  ok(pickOf(r) === "ip-geolocation" && r.results[0].seller === "https://geo.example" && r.capabilityGapCovered === true && !r.weakMatches && !("hint" in r) && r.results.every((x) => !("weak" in x)),
    `"${q}" picks the seller named for IP geolocation (got ${r.results[0]?.seller} ${r.results[0]?.slug}, covered ${r.capabilityGapCovered})`);
}
// A seller named by another word of the family is found however the query worded it.
cache.set("https://g2.example", seller("https://g2.example", { route: "/v1/geoip", slug: "geoip", name: "GeoIP", description: "Lookup." }));
cache.delete("https://geo.example");
{
  const r = route("where is this IP located", { top: 10 });
  ok(pickOf(r) === "geoip" && r.capabilityGapCovered === true, `"where is this IP located" finds a seller named geoip (got ${r.results[0]?.slug})`);
}
// A row that matches more of the query's words but is not named for the
// capability never outranks the row that is.
cache.set("https://near.example", seller("https://near.example", { route: "/api/ip-address-lookup", slug: "ip-address-lookup", name: "IP address lookup", description: "Lookup for an ip address." }));
{
  const q = "ip address lookup geolocation";
  const r = route(q, { top: 10 });
  const near = r.results.find((x) => x.slug === "ip-address-lookup"), named = r.results.find((x) => x.slug === "geoip");
  ok(near && named && near.score > named.score && pickOf(r) === "geoip" && r.results[0].seller === "https://g2.example", `"${q}": the named row is the pick over a better-scored near name (${r.results[0]?.slug}; scores ${named?.score} vs ${near?.score})`);
}
cache.delete("https://near.example");
cache.set("https://geo.example", seller("https://geo.example", { route: "/api/ip-geolocation", slug: "ip-geolocation", name: "IP geolocation", description: "Country, city and coordinates for an address." }));

// ---- nothing of the verdict is memoized: a memo-hit answer equals a fresh one ----
// The page path and the shortlist path share one scored memo (routeQueryAsync's
// scoredMemo): the second read of a query is a memo hit, at another `top`.
for (const q of [...GAP_QUERIES, "weather forecast for Berlin", "reverse dns for ip"]) {
  const fresh = await routeQueryAsync({ query: q, top: 10, include: "all", ...CTX });
  const memo = {};
  const first = await routeQueryAsync({ query: q, top: 3, include: "all", ...CTX, scoredMemo: memo });
  const again = await routeQueryAsync({ query: q, top: 10, include: "all", ...CTX, scoredMemo: memo });
  const view = (r) => JSON.stringify({ ...r, results: r.results.map((x) => [x.seller, x.slug, x.score, x.weak === true]) });
  ok(memo.key != null && view(again) === view(fresh) && view(routeQuery({ query: q, top: 10, include: "all", ...CTX })) === view(fresh), `"${q}": a memo-hit answer equals a fresh one (and the sync read)`);
  // (The per-seller cap follows `top`, so only the lead row and the verdict are compared.)
  ok(first.results[0]?.slug === fresh.results[0]?.slug && first.results[0]?.seller === fresh.results[0]?.seller && first.results.every((x) => x.weak === true) === fresh.results.every((x) => x.weak === true) && first.weakMatches === fresh.weakMatches && first.capabilityGapCovered === fresh.capabilityGapCovered, `"${q}": the shortlist read agrees with the page read`);
}
cache.delete("https://geo.example"); cache.delete("https://g2.example");
{
  const memo = {};
  await routeQueryAsync({ query: "ip geolocation", top: 3, include: "all", ...CTX, scoredMemo: memo });
  const again = await routeQueryAsync({ query: "ip geolocation", top: 10, include: "all", ...CTX, scoredMemo: memo });
  ok(again.weakMatches === true && again.results.every((x) => x.weak === true) && again.capabilityGapCovered === false, "a memo-hit miss still reads as a miss, every row weak");
}
cache.clear();

// ---- /api/find agrees on the family and keeps its own readings elsewhere ----
for (const q of GAP_QUERIES) {
  const r = findTools(catalog, q, { k: 3 });
  ok(r.capabilityGap === "ip-geolocation" && r.capabilityGapCovered === false && r.rarestTermCovered === false, `find: "${q}" is a miss (${r.results?.[0]?.slug}, covered ${r.rarestTermCovered})`);
}
for (const [q, want] of [["weather forecast for Berlin", "weather-forecast"], ["public holidays in germany", "public-holidays"], ["reverse dns for an ip", "ip-info"]]) {
  const r = findTools(catalog, q, { k: 3 });
  ok(r.results?.[0]?.slug === want && r.rarestTermCovered !== false && !("capabilityGap" in r), `find: "${q}" is served by ${want}, no gap field`);
}
{
  const withGeo = { ...catalog, "POST /api/ip-geolocation": { ...KIT.find((t) => t.slug === "ip-info"), route: "POST /api/ip-geolocation", slug: "ip-geolocation", name: "IP geolocation", description: "Country and city of an IP address.", tags: ["ip", "geolocation"], aliases: [] } };
  const r = findTools(withGeo, "ip geolocation", { k: 3 });
  ok(r.results?.[0]?.slug === "ip-geolocation" && r.capabilityGapCovered === true && r.rarestTermCovered !== false, "find: a catalog tool named for it clears the gap (the list never hides a tool we add)");
}

// ---- route-and-execute's own-catalog path ----
{
  const ran = [];
  const REQ = { headers: {} }; // a route call: the binder passes the request
  const STUB = new Set(["ip-info", "asn-info", "bank-holidays", "public-holidays", "weather-forecast"]);
  const cat = {};
  for (const t of TOOLS) cat[t.route] = STUB.has(t.slug) ? { ...t, handler: async () => { ran.push(t.slug); return { ok: true, from: t.slug }; } } : t;
  const tool = buildRouteExecuteTool({ getCatalog: () => cat, tier: { slug: "route-execute", execPriceUsd: 0.01, underlyingMaxUsd: 0.01 } });
  for (const q of ["ip geolocation", "geolocate ip address", "where is this IP located"]) {
    ran.length = 0;
    let threw = null;
    try { await tool.handler({ task: q, params: { ip: "8.8.8.8" } }, REQ); } catch (e) { threw = e; }
    ok(threw?.statusCode === 404 && ran.length === 0 && /none of them offers IP geolocation\. Nothing was run\. Nothing was charged\./.test(threw.message), `route-execute: "${q}" runs nothing, the uncharged 404 (${threw?.statusCode} ${String(threw?.message).slice(0, 190)})`);
  }
  // A step (no request) prints no charge claim, as every refusal here does.
  {
    let threw = null;
    try { await tool.handler({ task: "ip geolocation", params: {} }); } catch (e) { threw = e; }
    ok(threw?.statusCode === 404 && !/Nothing was charged/.test(threw.message), "route-execute: the 404 inside a step makes no charge claim");
  }
  // A country a task names is a value: these run, as they always have.
  for (const [q, want] of [["holidays in germany", "bank-holidays"], ["holidays in canada", "bank-holidays"], ["is today a holiday in germany", "bank-holidays"]]) {
    ran.length = 0;
    let threw = null, r = null;
    try { r = await tool.handler({ task: q, params: { country: "DE" } }, REQ); } catch (e) { threw = e; }
    ok(!threw && r?.receipt?.slug === want && ran.join() === want, `route-execute: "${q}" runs ${want} (${threw ? `${threw.statusCode} ${String(threw.message).slice(0, 70)}` : r?.receipt?.slug})`);
  }
  ran.length = 0;
  const r = await tool.handler({ task: "is this ip address private", params: { ip: "10.0.0.1" } }, REQ);
  ok(ran.join() === "ip-info" && r?.receipt?.slug === "ip-info", `control: route-execute still runs ip-info for an address-type task (${r?.receipt?.slug})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
