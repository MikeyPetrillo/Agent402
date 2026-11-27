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
// The gap alone makes these a miss: every word of the query is covered by a
// tool's own text, so nothing else in find would mark them.
for (const q of ["ip address location", "country of an ip", "ip to city", "where is 8.8.8.8"]) {
  const r = findTools(catalog, q, { k: 3 });
  ok(r.results.length > 0 && r.capabilityGap === "ip-geolocation" && r.capabilityGapCovered === false && r.rarestTermCovered === false, `find: "${q}" is a miss on the gap alone (rarest "${r.rarestTerm}", covered ${r.rarestTermCovered})`);
}
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

// ---- the phrasing table: every row read by /api/find, /api/route and route-and-execute ----
// A positive asks where an IP address is, in whatever words. A negative names
// an IP, a place or a location for some other job, and is answered with no
// gap field on any surface (the gap list is the only thing that reads it, so
// such an answer is the one the ranking gave before the list existed).
const POSITIVE = [
  "ip geolocation", "ip geolocation country of an IP address", "geoip lookup", "geo ip", "ipgeo", "IP2Location lookup",
  "which country is this IP in", "what city is 1.1.1.1 in", "what country does this ip address belong to", "ip to city", "ip address to country code",
  "country of an ip", "country code for an ip address", "lat long for an ip address", "find latitude and longitude of ip", "map an ip to coordinates",
  "locate an ip address", "locate 8.8.8.8", "geolocate 8.8.8.8", "geo-locate ipv6 address", "where is 8.8.8.8", "where is this ip", "where's this ip address",
  "where is this ip located", "ip lookup location", "ip based location", "ip address location", "location of an ip address", "ip country lookup",
  "IP-Geolokalisierung", "geolocalizacion de ip", "city and region for ip 203.0.113.9",
];
const NEGATIVE = [
  "weather for my location", "place lookup", "ip address validation", "is this ip private", "geolocation of a photo exif", "locate a store near an address",
  "where is the ip for example.com", "where is the ip address of example.com", "what is my ip", "what's my ip address", "reverse dns for an ip",
  "ip location header parsing in nginx config", "IP law firm office locations", "ip camera locations in a warehouse", "locate the ip whitelist setting",
  "location of the ipv6 prefix in a cidr", "find the location header in an http response from 10.0.0.1", "geocode an address", "asn for an ip",
  "is this ip a tor exit", "ip reputation", "version 1.2.3.4 of the store locator package", "where are ip addresses allocated from", "where is ip-info documented",
  "dns a record ip for a host located in germany", "holidays in germany", "ip to asn lookup", "country info for brazil", "city population lookup",
  "timezone for a city", "subnet calculator for 10.0.0.0/8", "cidr contains ip", "latitude and longitude of a street address",
  "cidr math: is ip 10.1.2.3 in the subnet for our second location", "reverse dns for the ip of our colo location", "ping the ip at our warehouse location",
];
ok(POSITIVE.length >= 25 && NEGATIVE.length >= 25 && new Set([...POSITIVE, ...NEGATIVE]).size === POSITIVE.length + NEGATIVE.length, `the table holds ${POSITIVE.length} positive and ${NEGATIVE.length} negative phrasings`);
{
  const ran = [];
  const REQ = { headers: {} };
  // Every handler is a stub: the table drives the pick, never an upstream.
  const cat = {};
  for (const t of TOOLS) cat[t.route] = { ...t, handler: async () => { ran.push(t.slug); return { ok: true, from: t.slug }; } };
  const own = buildRouteExecuteTool({ getCatalog: () => cat, tier: { slug: "route-execute", execPriceUsd: 0.01, underlyingMaxUsd: 0.01 } });
  // The external tier over the index the router reads: its resolver hands the
  // handler the index's own rows for the task, in the index's order.
  const bought = [];
  const ext = buildRouteExecuteTool({ getCatalog: () => cat, tier: { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 }, externalEnabled: () => true,
    resolveExternal: async (task) => routeQuery({ query: task, top: 5, include: "external", ...CTX }).results.map((r) => ({ seller: r.seller, slug: r.slug, name: r.name, url: r.url, method: "POST", price: "$0.01", priceUsd: 0.01, networks: ["eip155:8453"], wire: "x402" })),
    payExternal: async (url) => { bought.push(url); return { result: { country: "US" }, quote: { usd: 0.01, network: "eip155:8453" }, receipt: { transaction: "0xTX", network: "eip155:8453" } }; } });
  const GAP_404 = /none of them offers IP geolocation/;
  const runOwn = async (q) => { ran.length = 0; try { return { r: await own.handler({ task: q, params: { ip: "8.8.8.8" } }, REQ) }; } catch (e) { return { e }; } };

  // Our own catalog: every positive is a miss on all three.
  cache.clear();
  for (const q of POSITIVE) {
    const f = findTools(catalog, q, { k: 3 }), r = route(q);
    const x = await runOwn(q);
    // (An answer with no row at all is a miss already and carries no field.)
    ok(capabilityGap(q)?.id === "ip-geolocation" && (f.results.length === 0 || (f.capabilityGap === "ip-geolocation" && f.capabilityGapCovered === false && f.rarestTermCovered === false))
      && (r.results.length === 0 || (r.capabilityGap === "ip-geolocation" && r.weakMatches === true && pickOf(r) === null))
      && x.e?.statusCode === 404 && ran.length === 0 && (f.results.length === 0 || (GAP_404.test(x.e.message) && /Nothing was run\. Nothing was charged\./.test(x.e.message))),
    `positive "${q}": a miss on find, on route, and the uncharged 404 on route-and-execute (find ${f.capabilityGap}/${f.rarestTermCovered}, route ${r.capabilityGap}/${r.weakMatches}, run ${x.e?.statusCode} ${ran.join()})`);
  }
  // Every negative: no gap field anywhere, and route-and-execute never answers the gap 404.
  for (const q of NEGATIVE) {
    const f = findTools(catalog, q, { k: 3 }), r = route(q);
    const x = await runOwn(q);
    ok(capabilityGap(q) === null && !("capabilityGap" in f) && !("capabilityGapCovered" in f) && !("capabilityGap" in r) && !("capabilityGapCovered" in r) && !(x.e && GAP_404.test(x.e.message)),
      `negative "${q}": no gap field on find or route, no gap refusal on route-and-execute (${capabilityGap(q)?.id || "none"}, ${x.e ? x.e.statusCode : `ran ${ran.join()}`})`);
  }
  // A place word that is not about the IP: the task runs the tool it always ran.
  // (Read over the kits that hold dns and cidr as well.)
  const { NETWORK_TOOLS } = await import("../src/tools/network-kit.js");
  const { KIT2 } = await import("../src/tools/kit2.js");
  const wideCatalog = { ...catalog };
  for (const t of [...NETWORK_TOOLS, ...KIT2]) wideCatalog[t.route] = t;
  const wideCat = {};
  for (const t of Object.values(wideCatalog)) wideCat[t.route] = { ...t, handler: async () => { ran.push(t.slug); return { ok: true, from: t.slug }; } };
  const wide = buildRouteExecuteTool({ getCatalog: () => wideCat, tier: { slug: "route-execute", execPriceUsd: 0.01, underlyingMaxUsd: 0.01 } });
  for (const [q, params, want] of [["dns a record ip for a host located in germany", { name: "example.com", type: "A" }, ["dns"]],
    ["cidr math: is ip 10.1.2.3 in the subnet for our second location", { cidr: "10.1.0.0/16", ip: "10.1.2.3" }, ["cidr"]],
    ["reverse dns for the ip of our colo location", { ip: "8.8.8.8" }, ["dns", "ip-info"]]]) {
    ran.length = 0;
    let e = null, out = null;
    try { out = await wide.handler({ task: q, params }, REQ); } catch (err) { e = err; }
    const f = findTools(wideCatalog, q, { k: 3 }), r = route(q, { catalog: wideCatalog, toolCount: Object.keys(wideCatalog).length });
    // (find and route each rank by their own weights; either pick is a tool that does it.)
    ok(!e && want.includes(out?.receipt?.slug) && ran.join() === out?.receipt?.slug && r.weakMatches !== true && want.includes(pickOf(r)) && want.includes(f.results?.[0]?.slug) && !("capabilityGap" in r) && !("capabilityGap" in f),
      `"${q}" runs ${want.join(" or ")} and reads as served on find and route (${e ? `${e.statusCode} ${String(e.message).slice(0, 80)}` : ran.join()}; route ${pickOf(r)}, find ${f.results?.[0]?.slug})`);
  }
  // A stuffed near name beside a seller NAMED for it: the named one is picked on every positive.
  cache.set("https://stuffed.example", seller("https://stuffed.example", { route: "/api/ip-lookup", slug: "ip-lookup", name: "IP lookup", tags: ["geolocation"], description: "ip geolocation geolocate geoip ip location where is this ip located country city coordinates latitude longitude" }));
  cache.set("https://geo.example", seller("https://geo.example", { route: "/api/ip-geolocation", slug: "ip-geolocation", name: "IP geolocation", description: "Country, city and coordinates for an address." }));
  for (const q of POSITIVE) {
    const r = route(q, { top: 10 });
    bought.length = 0;
    let e = null, out = null;
    try { out = await ext.handler({ task: q, include: "external", params: { ip: "8.8.8.8" } }, REQ); } catch (err) { e = err; }
    ok(pickOf(r) === "ip-geolocation" && r.results[0].seller === "https://geo.example" && r.capabilityGapCovered === true
      && !e && bought.length === 1 && /^https:\/\/geo\.example\//.test(bought[0]) && out?.receipt?.seller === "https://geo.example",
    `positive "${q}": the seller named for it is the pick on route and the one bought (route ${r.results[0]?.seller}, bought ${bought.join() || (e ? `${e.statusCode} ${String(e.message).slice(0, 80)}` : "none")})`);
  }
  // With that seller listed, a negative still carries no gap field.
  for (const q of NEGATIVE) {
    const r = route(q, { top: 10 });
    ok(!("capabilityGap" in r) && !("capabilityGapCovered" in r), `negative "${q}": no gap field with a named seller listed`);
  }
  cache.clear();
}
// Row names: a slug or a name alone names the capability; words split across the two, or a near name, do not.
for (const [slug, name, want] of [["ip-geolocation", "IP geolocation", true], ["geoip", "Lookup", true], ["ip-geo", "x", true], ["ip-country", "x", true], ["ip-to-city", "x", true], ["country-by-ip", "x", true], ["x", "IP locations", true], ["weather", "IP Geolocation", true], ["locate-ip", "x", true],
  ["geo", "IP", false], ["city-ip", "Weather by city", false], ["ip-location-header", "Parse the Location header", false], ["store-locator", "Locate IP cameras", false], ["ip-info", "IP address type and reverse DNS", false], ["asn-info", "IP to ASN lookup", false], ["ip-lookup", "IP lookup", false], ["country-info", "Country info", false]]) {
  ok(gapNamedBy(CAPABILITY_GAPS[0], slug, name) === want, `a row ${slug} / "${name}" ${want ? "is" : "is not"} named for IP geolocation`);
}
// Bounded on hostile text.
for (const s of [`where is ${"a ".repeat(240)}ip`, `${"where is ".repeat(60)}ip for`, `${" ip ".repeat(120)}location`, "1.1.1.".repeat(90), `${"country of an ".repeat(40)}ip`, `ip ${"to ".repeat(200)}city`]) {
  const t0 = performance.now();
  capabilityGap(s); gapNamedBy(CAPABILITY_GAPS[0], s, s);
  ok(performance.now() - t0 < 50, `a ${s.length}-character hostile query is read in bounded time`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
