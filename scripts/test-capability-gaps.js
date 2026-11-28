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
  // The time zone or local time of an IP is the same lookup: no tool here does it.
  "timezone of an IP address", "time zone for an ip", "local time for ip 8.8.8.8", "local time of an ip address", "what timezone is this ip in",
  "ip to timezone", "ip timezone lookup", "time zone of 1.1.1.1",
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
  // A time zone asked of a place, or converted, is a job the catalog does.
  "convert time zones", "local time in Tokyo", "time zone of new york", "what time zone is berlin in", "local time for a meeting across time zones",
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
// ---- the second family: a coin's price on a past date ----
// The look-back tools answer statistics and never a past price, so a task that
// asks what a coin cost on a date is a miss on all three surfaces unless a row
// is named for it. Every negative is answered with no gap field.
{
  const COIN = CAPABILITY_GAPS.find((g) => g.id === "coin-price-on-date");
  const { CRYPTO_MARKETS_TOOLS } = await import("../src/tools/crypto-markets-kit.js");
  const { CRYPTO_TOOLS } = await import("../src/tools/crypto-kit.js");
  const { ALCHEMY_DATA_TOOLS } = await import("../src/tools/alchemy-data-kit.js");
  const coinTools = [...TOOLS, ...CRYPTO_MARKETS_TOOLS, ...CRYPTO_TOOLS, ...ALCHEMY_DATA_TOOLS];
  const coinCatalog = {};
  for (const t of coinTools) coinCatalog[t.route] = t;
  const croute = (q, extra = {}) => route(q, { catalog: coinCatalog, toolCount: coinTools.length, ...extra });
  // Tasks the catalog serves that hold a coin word, a price word and a date.
  const COIN_OTHER_JOBS = ["web search bitcoin price in 2017", "sec filings mentioning bitcoin price in 2021", "onchain sql token prices in 2024", "erc20 token price history last week",
    "price history of a token on base in 2024", "crypto price history last year", "eth gas price last week", "gas price yesterday on ethereum", "historical gas prices on ethereum",
    "historical stablecoin peg usdt price", "usdc price depeg in march 2023", "news about ethereum price last week", "tweets about bitcoin price yesterday", "eth price for the day",
    "btc price of the day", "eth price chart in 2023", "bitcoin price chart last month", "bitcoin price candles last year", "bitcoin price percent move during 2022",
    "compare bitcoin price today with last year",
    "bitcoin price chart yesterday", "token price on solana yesterday", "token price on ethereum last week", "bitcoin price news in 2021", "historical bitcoin price candles",
    "btc price ohlc on 2021-01-01", "bitcoin price history in 2021", "historical nft floor price", "eth price feed on base yesterday", "wrapped bitcoin price on arbitrum in 2023",
    "average bitcoin price in 2021", "bitcoin price range last month", "bitcoin price vs ethereum price last year", "eth price in gwei yesterday", "bitcoin price next year",
    "bitcoin price this week", "search for bitcoin price in 2020", "stablecoin price deviation last week", "bitcoin etf price yesterday", "price of the day for bitcoin",
    "historical token holders and price", "dex pool price last week for a token", "bitcoin dominance and price in 2021", "price of bitcoin on the day", "bitcoin price today",
    "bitcoin price for the day", "what is the bitcoin price of the day", "coin price range last week", "token price history for the last month", "bitcoin price history last year",
    "how volatile was the bitcoin price last year", "bitcoin price drop last week", "how far is the bitcoin price from its high last year",
    // This year is not a past date (read against the clock, so the case holds next year too).
    `eth price in ${new Date().getUTCFullYear()}`, `bitcoin price in ${new Date().getUTCFullYear() + 1}`,
    "historical price of gold in bitcoin", "bitcoin price tweet from last week", "eth price high and low in 2021", "token price history statistics in 2024", "bitcoin market cap and price yesterday"];
  const COIN_POSITIVE = ["bitcoin price on 2021-01-01", "historical coin price", "coin snapshot on a date", "price of ETH last June", "historical crypto prices", "btc price in 2021",
    "what was the price of bitcoin on 01/02/2021", "ethereum price 3 years ago", "token price on a given date", "solana price yesterday", "price of dogecoin in March 2024",
    "bitcoin price in june 2021", "btc price on january 5 2021", "show me the eth price on a specific date", "coin-price-on-date"];
  const COIN_NEGATIVE = ["bitcoin price", "bitcoin price in november", "eth price in december", "what is the btc price in december", "btc price during june", "current coin price", "coin history statistics", "price change since a date", "fx rate on a date", "stock price history",
    "bitcoin price change since 2024-01-01", "token price on solana", "crypto price history", "historical fx rate", "eth price prediction in march", "bitcoin halving date",
    "historical ohlc", "price of gold last june", "weather on a date", "bitcoin price in usd", "eth gas price", "coin change since a date", "bitcoin return since 2021-01-01",
    "historical volatility of bitcoin price", "price alert for eth in december", "treasury yield on a date", "candle statistics for bitcoin", "ip geolocation",
    // A coin word, a price word and a past date, and one more word that makes it
    // another job: each of these is ranked and served as it was before the family.
    ...COIN_OTHER_JOBS];
  ok(!!COIN && new Set([...COIN_POSITIVE, ...COIN_NEGATIVE]).size === COIN_POSITIVE.length + COIN_NEGATIVE.length, "the coin table lists each phrasing once");
  const named = coinTools.filter((t) => gapNamedBy(COIN, t.slug, t.name)).map((t) => t.slug);
  ok(named.length === 0 && coinTools.some((t) => t.slug === "coin-history") && coinTools.some((t) => t.slug === "crypto-history") && coinTools.some((t) => t.slug === "token-price-history"), `no tool in these kits is named for a coin's price on a past date (${named.join(", ") || "none"})`);
  // coin-history's search names say what it answers, never the snapshot it once gave.
  const ch = coinTools.find((t) => t.slug === "coin-history");
  ok(ch.aliases.length > 0 && ch.aliases.every((a) => !/snapshot|price/.test(a)), `coin-history's aliases name a change since a date (${ch.aliases.join(", ")})`);
  for (const [slug, name, want] of [["historical-coin-price", "x", true], ["coin-price-on-date", "x", true], ["x", "Historical crypto prices", true], ["historical-coin-price-api", "x", true], ["x", "Historical bitcoin price lookup API", true], ["coin-history", "Coin change since a date", false],
    ["crypto-history", "Crypto price history statistics", false], ["token-price-history", "Token price history statistics (USD)", false], ["fx-historical", "Historical FX rate", false], ["crypto-price", "Crypto price", false]]) {
    ok(gapNamedBy(COIN, slug, name) === want, `a row ${slug} / "${name}" ${want ? "is" : "is not"} named for a coin's price on a past date`);
  }
  const ran = [];
  const REQ = { headers: {} };
  const cat = {};
  for (const t of coinTools) cat[t.route] = { ...t, handler: async () => { ran.push(t.slug); return { ok: true, from: t.slug }; } };
  const own = buildRouteExecuteTool({ getCatalog: () => cat, tier: { slug: "route-execute", execPriceUsd: 0.05, underlyingMaxUsd: 0.05 } });
  const bought = [];
  const ext = buildRouteExecuteTool({ getCatalog: () => cat, tier: { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 }, externalEnabled: () => true,
    resolveExternal: async (task) => routeQuery({ query: task, top: 5, include: "external", ...CTX, catalog: coinCatalog }).results.map((r) => ({ seller: r.seller, slug: r.slug, name: r.name, url: r.url, method: "POST", price: "$0.01", priceUsd: 0.01, networks: ["eip155:8453"], wire: "x402" })),
    payExternal: async (url) => { bought.push(url); return { result: { price: 1 }, quote: { usd: 0.01, network: "eip155:8453" }, receipt: { transaction: "0xTX", network: "eip155:8453" } }; } });
  const COIN_404 = /none of them offers a coin's price on a past date/;
  const runOwn = async (q) => { ran.length = 0; try { return { r: await own.handler({ task: q, params: { coin: "bitcoin", date: "2026-01-01" } }, REQ) }; } catch (e) { return { e }; } };
  cache.clear();
  for (const q of COIN_POSITIVE) {
    const f = findTools(coinCatalog, q, { k: 3 }), r = croute(q);
    const x = await runOwn(q);
    ok(capabilityGap(q)?.id === "coin-price-on-date" && f.results.length > 0 && f.capabilityGap === "coin-price-on-date" && f.capabilityGapCovered === false && f.rarestTermCovered === false
      && r.results.length > 0 && r.capabilityGap === "coin-price-on-date" && r.weakMatches === true && pickOf(r) === null
      && x.e?.statusCode === 404 && ran.length === 0 && COIN_404.test(x.e.message) && /Nothing was run\. Nothing was charged\./.test(x.e.message),
    `coin positive "${q}": a miss on find, on route, and the uncharged 404 on route-and-execute (find ${f.capabilityGap}/${f.rarestTermCovered}, route ${r.capabilityGap}/${r.weakMatches}, run ${x.e?.statusCode} ${ran.join()})`);
  }
  for (const q of COIN_NEGATIVE) {
    const f = findTools(coinCatalog, q, { k: 3 }), r = croute(q);
    const x = await runOwn(q);
    ok(capabilityGap(q)?.id !== "coin-price-on-date" && f.capabilityGap !== "coin-price-on-date" && r.capabilityGap !== "coin-price-on-date" && !(x.e && COIN_404.test(x.e.message)),
      `coin negative "${q}": no coin gap on find or route, no coin gap refusal on route-and-execute (${capabilityGap(q)?.id || "none"}, ${x.e ? x.e.statusCode : `ran ${ran.join()}`})`);
  }
  // The shape is positive: any positive with one more content word is another job.
  for (const q of COIN_POSITIVE.filter((p) => p !== "coin-price-on-date")) {
    for (const extra of ["chart", "gas", "history", "candles", "news", "peg", "compare", "search"]) {
      ok(capabilityGap(`${q} ${extra}`) === null && capabilityGap(`${extra} ${q}`) === null, `"${q}" with the word "${extra}" is in no gap family`);
    }
  }
  // The year a query names is read against the clock: the current year and later ones are not past.
  {
    const at = (iso) => Date.parse(iso);
    ok(capabilityGap("eth price in 2026", at("2026-11-27T12:00:00Z")) === null && capabilityGap("eth price in 2026", at("2026-01-01T00:00:00Z")) === null && capabilityGap("eth price in 2027", at("2026-06-01T00:00:00Z")) === null,
      "a price in the current year, or a later one, is not a past price");
    ok(capabilityGap("eth price in 2026", at("2027-01-01T00:00:00Z"))?.id === "coin-price-on-date" && capabilityGap("eth price in 2025", at("2026-11-27T12:00:00Z"))?.id === "coin-price-on-date",
      "CONTROL: the same words are a past price once the year has ended");
    ok(capabilityGap("bitcoin price on 2026-03-01", at("2026-11-27T12:00:00Z")) === null && capabilityGap("btc price in june 2026", at("2026-11-27T12:00:00Z")) === null && capabilityGap("btc price june 5 2026", at("2026-11-27T12:00:00Z")) === null
      && capabilityGap("bitcoin price on 2025-03-01", at("2026-11-27T12:00:00Z"))?.id === "coin-price-on-date" && capabilityGap("btc price last june", at("2026-11-27T12:00:00Z"))?.id === "coin-price-on-date",
      "a written date or a month in the current year is not read as past; one in an earlier year, or with no year, is");
  }
  ok(capabilityGap("token price on solana yesterday") === null && capabilityGap("price of the day for eth") === null && capabilityGap("eth price for the day") === null, "a token on a named chain and the price of the day are not a past price");
  // The tools that answer the neighbors still do, read as served.
  for (const [q, want] of [["price change since a date", ["coin-history"]], ["coin history statistics", ["coin-history", "crypto-history", "coin-market-chart-range"]], ["bitcoin price", ["crypto-price", "price-coingecko"]]]) {
    const f = findTools(coinCatalog, q, { k: 3 }), r = croute(q);
    ok(want.includes(f.results?.[0]?.slug) && f.rarestTermCovered !== false && want.includes(pickOf(r)) && !("capabilityGap" in f) && !("capabilityGap" in r), `"${q}" is served by ${want.join(" or ")} on find and route (find ${f.results?.[0]?.slug}, route ${pickOf(r)})`);
  }
  // A stuffed description clears nothing; a seller NAMED for it is the pick and the one bought.
  cache.set("https://stuffed.example", seller("https://stuffed.example", { route: "/api/coin-data", slug: "coin-data", name: "Coin data", tags: ["historical"], description: "historical coin price on a date bitcoin price on any past date snapshot last june" }));
  for (const q of COIN_POSITIVE) {
    const r = croute(q, { top: 10 });
    ok(r.weakMatches === true && r.capabilityGapCovered === false && pickOf(r) === null, `coin positive "${q}": a description-only listing does not clear the miss`);
  }
  cache.set("https://past.example", seller("https://past.example", { route: "/api/historical-coin-price", slug: "historical-coin-price", name: "Historical coin price", description: "The price of a coin on a past date." }));
  for (const q of COIN_POSITIVE) {
    const r = croute(q, { top: 10 });
    bought.length = 0;
    let e = null, out = null;
    try { out = await ext.handler({ task: q, include: "external", params: { coin: "bitcoin", date: "2021-01-01" } }, REQ); } catch (err) { e = err; }
    ok(pickOf(r) === "historical-coin-price" && r.results[0].seller === "https://past.example" && r.capabilityGapCovered === true
      && !e && bought.length === 1 && /^https:\/\/past\.example\//.test(bought[0]) && out?.receipt?.seller === "https://past.example",
    `coin positive "${q}": the seller named for it is the pick on route and the one bought (route ${r.results[0]?.seller}, bought ${bought.join() || (e ? `${e.statusCode} ${String(e.message).slice(0, 80)}` : "none")})`);
  }
  for (const q of COIN_NEGATIVE) {
    const r = croute(q, { top: 10 });
    ok(r.capabilityGap !== "coin-price-on-date", `coin negative "${q}": no coin gap field with a named seller listed`);
  }
  cache.clear();
  for (const s of [`price of ${"bitcoin ".repeat(60)}on ${"a ".repeat(100)}date`, `${"historical ".repeat(40)}coin price`, `${"2021 01 ".repeat(60)}btc price`, `coin price ${"on the given ".repeat(35)}day`]) {
    const t0 = performance.now();
    capabilityGap(s); gapNamedBy(COIN, s, s);
    ok(performance.now() - t0 < 50, `a ${s.length}-character hostile coin query is read in bounded time`);
  }
}

// ---- the third family: a stock's price history ----
// The price-history tools here read coins and tokens. While no stock tool is
// listed, a task that asks for a stock's price history is a miss on all three
// surfaces unless a row is named for it; once a stock history tool is listed
// the family is off. Every negative is answered with no gap field.
{
  const STOCK = CAPABILITY_GAPS.find((g) => g.id === "stock-price-history");
  const { STOCK_TICKERS } = await import("../src/capability-gaps.js");
  const { STOCK_SLUGS, stockToolServed } = await import("../src/tools/stock-provider.js");
  const { CRYPTO_MARKETS_TOOLS } = await import("../src/tools/crypto-markets-kit.js");
  const { CRYPTO_TOOLS } = await import("../src/tools/crypto-kit.js");
  const { ALCHEMY_DATA_TOOLS } = await import("../src/tools/alchemy-data-kit.js");
  const { FINANCE_TOOLS } = await import("../src/tools/finance-kit.js");
  const { readFileSync } = await import("node:fs");
  // The catalog as a boot with no stock provider lists it: no stock tool.
  const savedEnv = { STOCK_DATA_PROVIDER: process.env.STOCK_DATA_PROVIDER, DATABENTO_API_KEY: process.env.DATABENTO_API_KEY };
  delete process.env.STOCK_DATA_PROVIDER;
  const stockTools = [...TOOLS, ...CRYPTO_MARKETS_TOOLS, ...CRYPTO_TOOLS, ...ALCHEMY_DATA_TOOLS, ...FINANCE_TOOLS].filter((t) => !STOCK_SLUGS.has(t.slug));
  const stockCatalog = {};
  for (const t of stockTools) stockCatalog[t.route] = t;
  const sroute = (q, extra = {}) => route(q, { catalog: stockCatalog, toolCount: stockTools.length, ...extra });
  const STOCK_POSITIVE = ["stock price history", "historical stock prices", "AAPL price history", "stock price history for AAPL", "price history of AAPL", "tsla price history", "msft historical prices",
    "historical share prices", "share price history", "equity price history", "daily stock price history", "historical daily stock prices", "historical stock price data", "show me the price history of nvda",
    "what is the stock price history", "get historical stock prices", "NVDA stock price history", "stocks price history", "stock-price-history"];
  const STOCK_NEGATIVE = ["token price history", "crypto price history", "erc20 token price history last week", "stock market news", "treasury yield history", "fx history", "company financials",
    "sec filings for apple", "insider trades", "13f holdings", "stock quote", "stock price", "stock history", "stock news", "stock price prediction", "stock split history", "dividend history",
    "stock dividend history", "earnings history", "price history", "historical prices", "bitcoin price history", "BTC price history", "ETH price history", "LINK price history", "UNI price history",
    "SOL price history", "coin price history", "token price history for the last month", "nft floor price history", "gas price history", "gold price history", "house price history", "fx rate history",
    "historical fx rate", "exchange rate history", "treasury yield curve history", "interest rate history", "inflation history", "cpi history", "unemployment rate history", "apple revenue history",
    "company revenue history", "AAPL filings", "AAPL insider trades", "AAPL 10-k", "tesla sec filings", "stock market holidays", "stock exchange opening hours", "ticker symbol lookup",
    "institutional holdings of AAPL", "stock token price history on robinhood chain", "tokenized stock price history", "price history of a token on base", "share of voice history", "browser history",
    "git commit history", "wayback history of a website", "weather history", "current stock price", "stock price history for apple", "apple stock price history", "stock price history chart",
    "stock price history news", "historical stock volatility", "stock options price history", "bond price history", "etf holdings", "AAPL price", "AAPL history", "ip geolocation", "bitcoin price on 2021-01-01"];
  ok(!!STOCK && STOCK_POSITIVE.length >= 15 && STOCK_NEGATIVE.length >= 40 && new Set([...STOCK_POSITIVE, ...STOCK_NEGATIVE]).size === STOCK_POSITIVE.length + STOCK_NEGATIVE.length, `the stock table holds ${STOCK_POSITIVE.length} positive and ${STOCK_NEGATIVE.length} negative phrasings, each once`);
  ok(!stockToolServed("stock-history") && !stockTools.some((t) => STOCK_SLUGS.has(t.slug)), "no stock tool is listed on this catalog");
  const named = stockTools.filter((t) => gapNamedBy(STOCK, t.slug, t.name)).map((t) => t.slug);
  ok(named.length === 0 && stockTools.some((t) => t.slug === "token-price-history") && stockTools.some((t) => t.slug === "crypto-history"), `no listed tool in these kits is named for a stock's price history (${named.join(", ") || "none"})`);
  for (const [slug, name, want] of [["stock-history", "Stock historical bars", true], ["stock-price-history", "x", true], ["x", "Historical stock prices", true], ["equity-eod", "Equity EOD bars", true], ["x", "Share price history", true], ["stock-ohlc", "x", true],
    ["stock-quote", "Stock quote", false], ["stock-news", "Stock news", false], ["stock-split-history", "Stock split history", false], ["dividend-history", "Stock dividend history", false], ["insider-history", "Stock insider trade history", false],
    ["token-price-history", "Token price history statistics (USD)", false], ["crypto-history", "Crypto price history statistics", false], ["tokenized-stock-history", "x", false], ["treasury-yield-history", "Treasury yield history", false],
    ["revenue-share-history", "Revenue share history", false], ["stock", "History", false]]) {
    ok(gapNamedBy(STOCK, slug, name) === want, `a row ${slug} / "${name}" ${want ? "is" : "is not"} named for a stock's price history`);
  }
  // A ticker is read from a closed list: none is a coin symbol the crypto tools take, a coin word or a common word.
  {
    const src = readFileSync(new URL("../src/tools/crypto-kit.js", import.meta.url), "utf8");
    const table = src.slice(src.indexOf("const SYMBOL_TO_ID = {"), src.indexOf("};", src.indexOf("const SYMBOL_TO_ID = {")));
    const symbols = new Set([...table.matchAll(/\b([A-Z0-9]{2,10}): "/g)].map((m) => m[1].toLowerCase()));
    ok(symbols.has("btc") && symbols.has("link") && symbols.size >= 40, `the coin symbol table is read (${symbols.size} symbols)`);
    const clash = [...STOCK_TICKERS].filter((t) => symbols.has(t) || capabilityGap(`${t} price yesterday`)?.id === "coin-price-on-date" || !/^[a-z]{3,5}$/.test(t));
    ok(STOCK_TICKERS.size >= 10 && clash.length === 0, `no listed ticker is a coin symbol or a coin word (${clash.join(", ") || "none"})`);
    for (const sym of ["LINK", "UNI", "ATOM", "NEAR", "BTC", "OP", "META", "SPY", "ALL", "COST"]) ok(capabilityGap(`${sym} price history`) === null, `"${sym} price history" is in no gap family (a coin symbol or a word, never read as a ticker)`);
  }
  const ran = [];
  const REQ = { headers: {} };
  const cat = {};
  for (const t of stockTools) cat[t.route] = { ...t, handler: async () => { ran.push(t.slug); return { ok: true, from: t.slug }; } };
  const own = buildRouteExecuteTool({ getCatalog: () => cat, tier: { slug: "route-execute", execPriceUsd: 0.05, underlyingMaxUsd: 0.05 } });
  const bought = [];
  const ext = buildRouteExecuteTool({ getCatalog: () => cat, tier: { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 }, externalEnabled: () => true,
    resolveExternal: async (task) => routeQuery({ query: task, top: 5, include: "external", ...CTX, catalog: stockCatalog }).results.map((r) => ({ seller: r.seller, slug: r.slug, name: r.name, url: r.url, method: "POST", price: "$0.01", priceUsd: 0.01, networks: ["eip155:8453"], wire: "x402" })),
    payExternal: async (url) => { bought.push(url); return { result: { bars: [] }, quote: { usd: 0.01, network: "eip155:8453" }, receipt: { transaction: "0xTX", network: "eip155:8453" } }; } });
  const STOCK_404 = /none of them offers stock price history/;
  const runOwn = async (q) => { ran.length = 0; try { return { r: await own.handler({ task: q, params: { symbol: "AAPL" } }, REQ) }; } catch (e) { return { e }; } };
  cache.clear();
  for (const q of STOCK_POSITIVE) {
    const f = findTools(stockCatalog, q, { k: 3 }), r = sroute(q);
    const x = await runOwn(q);
    ok(capabilityGap(q)?.id === "stock-price-history" && f.results.length > 0 && f.capabilityGap === "stock-price-history" && f.capabilityGapCovered === false && f.rarestTermCovered === false
      && r.results.length > 0 && r.capabilityGap === "stock-price-history" && r.weakMatches === true && pickOf(r) === null && r.results.every((y) => y.weak === true) && /stock price history/.test(r.hint || "")
      && x.e?.statusCode === 404 && ran.length === 0 && STOCK_404.test(x.e.message) && /Nothing was run\. Nothing was charged\./.test(x.e.message),
    `stock positive "${q}": a miss on find, on route, and the uncharged 404 on route-and-execute (find ${f.capabilityGap}/${f.rarestTermCovered}, route ${r.capabilityGap}/${r.weakMatches}, run ${x.e?.statusCode} ${ran.join()})`);
  }
  for (const q of STOCK_NEGATIVE) {
    const f = findTools(stockCatalog, q, { k: 3 }), r = sroute(q);
    const x = await runOwn(q);
    ok(capabilityGap(q)?.id !== "stock-price-history" && f.capabilityGap !== "stock-price-history" && r.capabilityGap !== "stock-price-history" && !(x.e && STOCK_404.test(x.e.message)),
      `stock negative "${q}": no stock gap on find or route, no stock gap refusal on route-and-execute (${capabilityGap(q)?.id || "none"}, ${x.e ? x.e.statusCode : `ran ${ran.join()}`})`);
  }
  // The token tools still answer the tasks that name a token or a coin.
  for (const [q, want] of [["token price history", ["token-price-history"]], ["crypto price history", ["crypto-history", "token-price-history"]], ["BTC price history", ["token-price-history", "crypto-history"]]]) {
    const f = findTools(stockCatalog, q, { k: 3 }), r = sroute(q);
    const x = await runOwn(q);
    ok(want.includes(f.results?.[0]?.slug) && f.rarestTermCovered !== false && want.includes(pickOf(r)) && !("capabilityGap" in f) && !("capabilityGap" in r) && !x.e && want.includes(x.r?.receipt?.slug),
      `"${q}" is served by ${want.join(" or ")} on find, route and route-and-execute (find ${f.results?.[0]?.slug}, route ${pickOf(r)}, ran ${x.e ? x.e.statusCode : ran.join()})`);
  }
  // The shape is positive: any positive with one more content word is another job.
  for (const q of STOCK_POSITIVE.filter((p) => p !== "stock-price-history")) {
    for (const extra of ["token", "crypto", "news", "chart", "split", "dividend", "prediction", "volatility", "apple", "options"]) {
      ok(capabilityGap(`${q} ${extra}`) === null && capabilityGap(`${extra} ${q}`) === null, `"${q}" with the word "${extra}" is in no gap family`);
    }
  }
  // A stuffed description clears nothing; a seller NAMED for it is the pick and the one bought.
  cache.set("https://stuffed.example", seller("https://stuffed.example", { route: "/api/market-data", slug: "market-data", name: "Market data", tags: ["stock"], description: "stock price history historical stock prices AAPL price history daily bars" }));
  for (const q of STOCK_POSITIVE) {
    const r = sroute(q, { top: 10 });
    ok(r.weakMatches === true && r.capabilityGapCovered === false && pickOf(r) === null, `stock positive "${q}": a description-only listing does not clear the miss`);
  }
  cache.set("https://bars.example", seller("https://bars.example", { route: "/api/stock-price-history", slug: "stock-price-history", name: "Stock price history", description: "Daily bars for a US stock." }));
  for (const q of STOCK_POSITIVE) {
    const r = sroute(q, { top: 10 });
    bought.length = 0;
    let e = null, out = null;
    try { out = await ext.handler({ task: q, include: "external", params: { symbol: "AAPL" } }, REQ); } catch (err) { e = err; }
    ok(pickOf(r) === "stock-price-history" && r.results[0].seller === "https://bars.example" && r.capabilityGapCovered === true && !r.weakMatches
      && !e && bought.length === 1 && /^https:\/\/bars\.example\//.test(bought[0]) && out?.receipt?.seller === "https://bars.example",
    `stock positive "${q}": the seller named for it is the pick on route and the one bought (route ${r.results[0]?.seller}, bought ${bought.join() || (e ? `${e.statusCode} ${String(e.message).slice(0, 80)}` : "none")})`);
  }
  for (const q of STOCK_NEGATIVE) {
    const r = sroute(q, { top: 10 });
    ok(r.capabilityGap !== "stock-price-history", `stock negative "${q}": no stock gap field with a named seller listed`);
  }
  cache.clear();
  // The family turns itself off once a stock history tool is listed: the
  // switch is read on every query, and the task is ranked like any other.
  {
    process.env.STOCK_DATA_PROVIDER = "databento";
    process.env.DATABENTO_API_KEY = "test-key-not-a-secret";
    const listed = { ...stockCatalog };
    for (const t of FINANCE_TOOLS.filter((x) => x.slug === "stock-history")) listed[t.route] = t;
    ok(stockToolServed("stock-history") && Object.values(listed).some((t) => t.slug === "stock-history"), "CONTROL: with a provider selected and its key present, stock-history is listed");
    for (const q of STOCK_POSITIVE) {
      const f = findTools(listed, q, { k: 3 }), r = route(q, { catalog: listed, toolCount: Object.keys(listed).length });
      ok(capabilityGap(q) === null && !("capabilityGap" in f) && !("capabilityGap" in r) && r.weakMatches !== true, `listed: "${q}" is in no gap family and carries no gap field`);
    }
    for (const q of ["stock price history", "historical stock prices", "daily stock price history"]) {
      const f = findTools(listed, q, { k: 3 });
      // (Ranked by the plain weights again: the family no longer orders the rows.)
      ok(f.results?.some((x) => x.slug === "stock-history") && f.rarestTermCovered !== false, `listed: find "${q}" ranks stock-history among its top rows, read as served (${f.results?.slice(0, 3).map((x) => x.slug).join(", ")})`);
    }
    // A provider named with no key lists nothing, so the family stays on.
    delete process.env.DATABENTO_API_KEY;
    ok(!stockToolServed("stock-history") && capabilityGap("stock price history")?.id === "stock-price-history", "a provider named with no key lists no stock tool: the family is on");
    for (const k of Object.keys(savedEnv)) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  }
  for (const s of [`${"stock ".repeat(80)}price history`, `${"historical ".repeat(40)}stock price`, `aapl ${"price ".repeat(90)}history`, `stock price history ${"of the ".repeat(60)}`]) {
    const t0 = performance.now();
    capabilityGap(s); gapNamedBy(STOCK, s, s);
    ok(performance.now() - t0 < 50, `a ${s.length}-character hostile stock query is read in bounded time`);
  }
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
