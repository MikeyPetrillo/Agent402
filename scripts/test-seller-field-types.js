// A crawled seller listing (parsed JSON) can carry a number, an object, an
// array or null where a string belongs (name, slug, description, category, route, tags,
// aliases). Routing reads those fields as text; a non-string name threw
// `(t.name || "").toLowerCase is not a function` and the uncaught exception
// took the whole server down. Every shape here must route without throwing,
// and the well-formed seller beside them must still be found.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
process.env.X402_INDEX_CRAWL = "off";
const { routeQuery, _cacheForTests, mergeManifestIntoTools, bazaarItemToTool, brokenListingsSummary, __setDiscoveryFetchForTest, __discoverSourceForTest } = await import("../src/x402-index.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const cache = _cacheForTests(); cache.clear();
const tool = (origin, over) => ({ seller: origin, method: "POST", route: "/api/ocr", slug: "ocr", name: "ocr", description: "ocr a thing", category: "vision", tags: ["ocr"], price: 0.003, ...over });
const seed = (origin, over) => cache.set(origin, { manifest: { name: origin, homepage: origin }, openapiSummary: null, tools: [tool(origin, over)], fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1] });
const shapes = {
  "a number name": { name: 404 },
  "an object name": { name: { en: "ocr" } },
  "an array name": { name: ["ocr"] },
  "a number slug": { slug: 7 },
  "an object description": { description: { text: "ocr" } },
  "a number category": { category: 5 },
  "a string of tags": { tags: "ocr,vision" },
  "tags holding objects": { tags: [{ t: "ocr" }, null, 3] },
  "a number route": { route: 12 },
  "aliases holding objects": { aliases: [{ a: 1 }, "ocr-alt"] },
  // Plain JSON whose object carries "toString" and "valueOf" keys that are
  // not functions: coercing it throws ("Cannot convert object to primitive value").
  "a price object with toString and valueOf keys": JSON.parse('{"price":{"toString":1,"valueOf":1}}'),
  "a maxAmountRequired object with a toString key": JSON.parse('{"maxAmountRequired":{"toString":1}}'),
  "an amount object with a valueOf key": JSON.parse('{"amount":{"valueOf":1}}'),
};
let i = 0;
for (const over of Object.values(shapes)) seed(`https://odd-${i++}.example`, over);
seed("https://good.example", {});
const ctx = { baseUrl: "https://agent402.tools", catalog: {}, prices: {} };

let r = null, err = null;
try { r = routeQuery({ query: "ocr a thing", top: 50, include: "external", ...ctx }); } catch (e) { err = e; }
ok(!err, `a route query over sellers with ${Object.keys(shapes).length} non-text field shapes answers (${err ? err.message : "no throw"})`);
ok(r?.results?.some((x) => x.seller === "https://good.example"), "the well-formed seller beside them is still found");
for (const k of ["price", "maxAmountRequired", "amount"]) {
  ok(cache.get(`https://odd-${Object.keys(shapes).findIndex((n) => JSON.stringify(shapes[n]).startsWith(`{"${k}"`))}.example`)?.tools?.[0]?.[k] === undefined, `${k === "amount" ? "an" : "a"} ${k} that is neither text nor a number is dropped as the entry is stored`);
}
ok(Object.keys(brokenListingsSummary().byOrigin).length === 0, `no listing broke while read (${JSON.stringify(brokenListingsSummary().byOrigin)})`);

// The real manifest merge path with the reviewer's exact JSON: the merged row
// carries no object price, the stored entry routes, nothing breaks.
{
  const O = "https://m.example";
  const manifestTools = JSON.parse('[{"route":"/api/a","method":"GET","name":"ocr a","description":"ocr a thing","price":{"toString":1,"valueOf":1}}]');
  const existing = [{ seller: O, route: "/api/a", method: "GET", name: "ocr a", description: "ocr a thing", networks: ["eip155:8453"] }];
  const merged = mergeManifestIntoTools(manifestTools, existing);
  ok(merged.length >= 1 && (merged[0].price == null || typeof merged[0].price === "string" || typeof merged[0].price === "number"), `the merge does not carry the object price (${typeof merged[0]?.price})`);
  cache.set(O, { manifest: { name: "m", homepage: O }, tools: merged, fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1] });
  let e2 = null, r2 = null;
  try { r2 = routeQuery({ query: "ocr a thing", top: 50, include: "external", ...ctx }); } catch (e) { e2 = e; }
  ok(!e2 && r2.results.some((x) => x.seller === O), `the merged seller is stored and routed (${e2 ? e2.message : "no throw"})`);
  ok(!brokenListingsSummary().byOrigin[O], "and its listing did not break");
}

// A registry item whose maxAmountRequired is {"toString":1}: read as no
// amount (the row stays, unpriced), never a throw that fails the source.
{
  const item = JSON.parse('{"resource":"https://b.example/api/x","accepts":[{"network":"eip155:8453","maxAmountRequired":{"toString":1},"payTo":"0x' + "ab".repeat(20) + '","asset":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","extra":{"name":{"toString":1}}}],"quality":{"l30DaysTotalCalls":{"valueOf":1},"l30DaysUniquePayers":{"toString":1}}}');
  let t = null, e3 = null;
  try { t = bazaarItemToTool(item, "https://b.example"); } catch (e) { e3 = e; }
  ok(!e3 && t && t.price === null && t.route === "/api/x", `bazaarItemToTool reads the object amount as none (${e3 ? e3.message : `price ${t?.price}`})`);
  // The same item inside a registry source beside good ones: the source is indexed.
  const good = (k) => ({ resource: `https://reg-good-${k}.example/api/ocr`, method: "POST", description: "ocr a thing", accepts: [{ network: "eip155:8453", amount: "3000", payTo: "0x" + "cd".repeat(20), asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", extra: { name: "USD Coin" } }] });
  const bad = JSON.parse(JSON.stringify(item).replace("https://b.example/api/x", "https://reg-bad.example/api/x"));
  // An item whose resource itself cannot be read as text.
  const worse = JSON.parse('{"resource":{"toString":1},"accepts":[]}');
  __setDiscoveryFetchForTest(async () => JSON.parse(JSON.stringify({ x402Version: 2, items: [good(0), bad, worse, good(1)] })));
  let e4 = null;
  try { await __discoverSourceForTest({ name: "stub registry", url: "https://stub-registry.example/list", synthesizeTools: true, seedImmediately: true }, null); } catch (e) { e4 = e; }
  __setDiscoveryFetchForTest(null);
  ok(!e4, `the source with unreadable items is read (${e4 ? e4.message : "no throw"})`);
  ok(cache.get("https://reg-good-0.example")?.tools?.length === 1 && cache.get("https://reg-good-1.example")?.tools?.length === 1, "the good items before and after the bad ones are indexed");
  const badRow = cache.get("https://reg-bad.example")?.tools?.[0];
  ok(!badRow || badRow.price == null, `the bad item is cleaned (no price) or dropped (${JSON.stringify(badRow?.price ?? null)})`);
}
console.log(`\ntest-seller-field-types: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
