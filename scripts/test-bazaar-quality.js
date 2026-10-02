// Bazaar quality ingestion (2026-08-19): Coinbase-measured 30-day calls /
// distinct payers ride from the Bazaar feed into the index (per resource + per
// origin), into /api/find external results (field + tiebreak), and into the
// SOR gate as positive evidence (folded as MAX in server.js). Offline.
import { readFileSync } from "node:fs";
import { routeQuery, bazaarItemToTool, bazaarQualityFor, bazaarQualityEntries, _setBazaarQualityForTest, _cacheForTests, indexSnapshot, foldBazaarQuality } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

// 1. per-resource quality on the synthesized tool
const item = { resource: "https://q.example/api/ocr", description: "OCR an image", accepts: [{ network: "eip155:8453", amount: "3000", payTo: "0x" + "1".repeat(40), extra: { name: "USD Coin" } }], quality: { l30DaysTotalCalls: 931, l30DaysUniquePayers: 927, lastCalledAt: "2026-08-19T13:00:07.39Z" } };
const t = bazaarItemToTool(item, "https://q.example");
ok(t && t.quality && t.quality.calls30d === 931 && t.quality.payers30d === 927 && t.quality.lastCalledAt === "2026-08-19T13:00:07.39Z", "bazaarItemToTool carries the resource's 30-day quality");
ok(bazaarItemToTool({ ...item, quality: undefined }, "https://q.example").quality === null, "no quality object -> null, never a fake zero");

// 2. per-origin fold: calls summed, payers MAX (never a double-counting sum)
_setBazaarQualityForTest("https://q.example", null);
ok(bazaarQualityFor("https://q.example") === null, "unknown origin -> null");
_setBazaarQualityForTest("https://a.example", { calls30d: 10, payers30d: 2, lastCalledAt: "2026-08-10T00:00:00Z" });
_setBazaarQualityForTest("https://b.example", { calls30d: 3, payers30d: 50, lastCalledAt: "2026-08-18T00:00:00Z" });
ok(bazaarQualityFor("https://b.example/").payers30d === 50 && bazaarQualityEntries().some(([o]) => o === "https://a.example"), "origin lookup tolerates a trailing slash; entries enumerate");

// 3. routeQuery: equal match + equal health -> more Bazaar payers first; field rides on external rows only
const cache = _cacheForTests(); cache.clear();
const seed = (origin, slug) => cache.set(origin, { manifest: { name: origin, homepage: origin }, openapiSummary: null, tools: [{ seller: origin, method: "POST", route: `/api/${slug}`, slug, name: slug, description: "ocr a thing", category: "vision", tags: ["ocr"], price: 0.003 }], fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1] });
seed("https://a.example", "ocr"); seed("https://b.example", "ocr");
const ctx = { baseUrl: "https://agent402.tools", catalog: { "POST /api/ocr-local": { name: "OCR", slug: "ocr-local", category: "vision", price: "$0.01", description: "ocr a thing" } }, prices: { "ocr-local": 0.01 }, network: "base", toolCount: 1, walletName: "agent402.base.eth" };
const r = routeQuery({ query: "ocr", top: 10, include: "external", ...ctx });
const ext = r.results.filter((x) => x.seller !== "agent402.tools" && x.seller.startsWith("https://"));
ok(ext.length === 2 && ext[0].seller === "https://b.example", `equal match + health: the seller more wallets paid this month ranks first (got ${ext.map((x) => x.seller).join(", ")})`);
ok(ext[0].bazaar?.payers30d === 50 && ext[1].bazaar?.payers30d === 2, "external rows carry the Bazaar quality object");
const local = routeQuery({ query: "ocr", top: 10, ...ctx }).results.find((x) => x.slug === "ocr-local");
ok(local && local.bazaar === undefined, "local rows never carry a bazaar object");
const snap = indexSnapshot(ctx);
const b = (snap.sellers || []).find((s) => s.origin === "https://b.example");
ok(b && b.bazaar?.payers30d === 50 && b.bazaar?.calls30d === 3, "index snapshot sellers expose bazaar quality");

// 4. `curated` (2026-09-29): the bulk feed now carries Coinbase's editorial
// flag per item. Folded per origin, served on index rows, and read by the
// router ONLY as the last tie-break: after match, health, payers and price.
{
  const m = new Map();
  foldBazaarQuality(m, "https://c.example", { l30DaysTotalCalls: 5, l30DaysUniquePayers: 1 }, null, { curated: false });
  ok(m.get("https://c.example").curated === false, "fold: an uncurated resource reads curated false");
  foldBazaarQuality(m, "https://c.example", { l30DaysTotalCalls: 5, l30DaysUniquePayers: 1 }, null, { curated: true });
  foldBazaarQuality(m, "https://c.example", { l30DaysTotalCalls: 5, l30DaysUniquePayers: 1 }, null);
  ok(m.get("https://c.example").curated === true, "fold: any curated resource marks the origin, and a later plain one does not clear it");
  ok(Object.keys(m.get("https://c.example")).includes("curated"), "fold: curated is an enumerable field (served on index rows)");
  const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  ok(/curated: item\.curated === true && isBazaarDiscoveryUrl\(source\.url\)/.test(src), "fold: curated is read from the Coinbase feed only, never from an open registry's own item");
}
{
  const seedP = (origin, slug, price, health = 1) => cache.set(origin, { manifest: { name: origin, homepage: origin }, openapiSummary: null, tools: [{ seller: origin, method: "POST", route: `/api/${slug}`, slug, name: slug, description: `${slug} a thing`, category: "x", tags: [slug], price }], fetchedAt: Date.now(), error: null, history: health === 1 ? [1, 1, 1, 1, 1] : [1, 0, 0, 0, 0] });
  const run = (q) => routeQuery({ query: q, top: 10, include: "external", ...ctx }).results.filter((x) => x.seller.startsWith("https://"));
  cache.clear();
  // equal on everything: the curated seller first (its origin sorts second in cache order)
  seedP("https://plain.example", "geocode", 0.003); seedP("https://cur.example", "geocode", 0.003);
  _setBazaarQualityForTest("https://plain.example", { calls30d: 1, payers30d: 5, lastCalledAt: null, payTos: [], curated: false });
  _setBazaarQualityForTest("https://cur.example", { calls30d: 1, payers30d: 5, lastCalledAt: null, payTos: [], curated: true });
  let rr = run("geocode");
  ok(rr[0]?.seller === "https://cur.example", `equal match, health, payers and price: the Bazaar-curated seller orders first (got ${rr.map((x) => x.seller).join(", ")})`);
  ok(rr[0].bazaar?.curated === true && rr[1].bazaar?.curated === false, "route rows expose curated beside the payer counts");
  {
    const { routeTiebreakLabels } = await import("../src/route-order.js");
    const w = rr[0].why || {};
    ok(JSON.stringify(w.tiebreaks) === JSON.stringify(routeTiebreakLabels()) && w.tiebreaks.some((l) => /payers/.test(l)) && w.tiebreaks.some((l) => /curated/.test(l)), `why.tiebreaks names payers and curated, from route-order.js (got ${JSON.stringify(w.tiebreaks)})`);
    ok(w.bazaarPayers30d === 5 && w.bazaarCurated === true && rr[1].why?.bazaarCurated === false, "why carries the payer count and curated flag the row was sorted on");
  }
  const idx = indexSnapshot(ctx).sellers.find((x) => x.origin === "https://cur.example");
  ok(idx?.bazaar?.curated === true, "index rows expose curated");
  // CONTROL: without the flag the same pair keeps cache order.
  _setBazaarQualityForTest("https://cur.example", { calls30d: 1, payers30d: 5, lastCalledAt: null, payTos: [], curated: false });
  rr = routeQuery({ query: "geocode a thing", top: 10, include: "external", ...ctx }).results.filter((x) => x.seller.startsWith("https://"));
  ok(rr[0]?.seller === "https://plain.example", "control: with neither curated, cache order decides");
  // never over more payers
  cache.clear();
  seedP("https://paid.example", "translate", 0.003); seedP("https://cur2.example", "translate", 0.003);
  _setBazaarQualityForTest("https://paid.example", { calls30d: 1, payers30d: 9, lastCalledAt: null, payTos: [], curated: false });
  _setBazaarQualityForTest("https://cur2.example", { calls30d: 1, payers30d: 3, lastCalledAt: null, payTos: [], curated: true });
  ok(run("translate")[0]?.seller === "https://paid.example", "curated never lifts a seller over one more wallets paid");
  // never over cheaper
  cache.clear();
  seedP("https://cur3.example", "summarize", 0.005); seedP("https://cheap.example", "summarize", 0.002);
  _setBazaarQualityForTest("https://cheap.example", { calls30d: 1, payers30d: 5, lastCalledAt: null, payTos: [], curated: false });
  _setBazaarQualityForTest("https://cur3.example", { calls30d: 1, payers30d: 5, lastCalledAt: null, payTos: [], curated: true });
  ok(run("summarize")[0]?.seller === "https://cheap.example", "curated never lifts a seller over a cheaper equal");
  // never over healthier
  cache.clear();
  seedP("https://cur4.example", "whois", 0.003, 0); seedP("https://healthy.example", "whois", 0.003);
  _setBazaarQualityForTest("https://healthy.example", { calls30d: 1, payers30d: 5, lastCalledAt: null, payTos: [], curated: false });
  _setBazaarQualityForTest("https://cur4.example", { calls30d: 1, payers30d: 5, lastCalledAt: null, payTos: [], curated: true });
  ok(run("whois")[0]?.seller === "https://healthy.example", "curated never lifts a seller over a healthier one");
  // never over a better match
  cache.clear();
  seedP("https://exact.example", "weather", 0.003); seedP("https://cur5.example", "weather-extra", 0.003);
  _setBazaarQualityForTest("https://exact.example", { calls30d: 1, payers30d: 5, lastCalledAt: null, payTos: [], curated: false });
  _setBazaarQualityForTest("https://cur5.example", { calls30d: 1, payers30d: 5, lastCalledAt: null, payTos: [], curated: true });
  ok(run("weather")[0]?.seller === "https://exact.example", "curated never lifts a seller over a better-matched one");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
