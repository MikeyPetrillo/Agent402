// Verified-list preference (GB02): when routeQuery candidates TIE on the
// existing ranking, prefer a route present on an operator-configured HTTPS
// JSON feed. Flag OFF by default. Offline — feed is injected, never fetched.
import { routeQuery, _cacheForTests, _setBazaarQualityForTest } from "../src/x402-index.js";
import {
  DEFAULT_VERIFIED_LIST_URL,
  verifiedListEnabled,
  verifiedListUrl,
  parseVerifiedFeed,
  routeOnVerifiedList,
  refreshVerifiedList,
  _setVerifiedListForTest,
  _resetVerifiedListForTest,
} from "../src/verified-list.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const savedFlag = process.env.X402_VERIFIED_LIST;
const savedUrl = process.env.X402_VERIFIED_LIST_URL;
const restore = () => {
  if (savedFlag === undefined) delete process.env.X402_VERIFIED_LIST;
  else process.env.X402_VERIFIED_LIST = savedFlag;
  if (savedUrl === undefined) delete process.env.X402_VERIFIED_LIST_URL;
  else process.env.X402_VERIFIED_LIST_URL = savedUrl;
  _resetVerifiedListForTest();
};

const ctx = {
  baseUrl: "https://agent402.tools",
  catalog: { "POST /api/ocr-local": { name: "OCR", slug: "ocr-local", category: "vision", price: "$0.01", description: "ocr a thing" } },
  prices: { "ocr-local": 0.01 },
  network: "base",
  toolCount: 1,
  walletName: "agent402.base.eth",
};

function seedEqualPair() {
  const cache = _cacheForTests();
  cache.clear();
  _setBazaarQualityForTest("https://a.example", null);
  _setBazaarQualityForTest("https://b.example", null);
  const seed = (origin) => cache.set(origin, {
    manifest: { name: origin, homepage: origin },
    openapiSummary: null,
    tools: [{ seller: origin, method: "POST", route: "/api/ocr", slug: "ocr", name: "ocr", description: "ocr a thing", category: "vision", tags: ["ocr"], price: 0.003 }],
    fetchedAt: Date.now(),
    error: null,
    history: [1, 1, 1, 1, 1],
  });
  seed("https://a.example");
  seed("https://b.example");
}

function extSellers(queryOpts = {}) {
  const r = routeQuery({ query: "ocr", top: 10, include: "external", ...ctx, ...queryOpts });
  return r.results.filter((x) => typeof x.seller === "string" && x.seller.startsWith("https://"));
}

// ---------------------------------------------------------------------------
// Flag default + URL default
// ---------------------------------------------------------------------------
delete process.env.X402_VERIFIED_LIST;
delete process.env.X402_VERIFIED_LIST_URL;
ok(verifiedListEnabled() === false, "flag default is off (unset)");
ok(verifiedListUrl() === DEFAULT_VERIFIED_LIST_URL, "default feed URL is the published https endpoint");
ok(DEFAULT_VERIFIED_LIST_URL === "https://samedaydesk.com/x402/verified.json", "default URL is the documented feed location");
process.env.X402_VERIFIED_LIST = "off";
ok(verifiedListEnabled() === false, "flag 'off' is off");
process.env.X402_VERIFIED_LIST = "false";
ok(verifiedListEnabled() === false, "flag 'false' is off");
process.env.X402_VERIFIED_LIST = "on";
ok(verifiedListEnabled() === true, "flag 'on' is on");
process.env.X402_VERIFIED_LIST = "true";
ok(verifiedListEnabled() === true, "flag 'true' is on");
process.env.X402_VERIFIED_LIST_URL = "https://other.example/feed.json";
ok(verifiedListUrl() === "https://other.example/feed.json", "X402_VERIFIED_LIST_URL overrides the default (provider-neutral)");

// ---------------------------------------------------------------------------
// Feed contract
// ---------------------------------------------------------------------------
const parsed = parseVerifiedFeed({
  routes: [
    "https://b.example/api/ocr",
    { url: "https://c.example/api/scan" },
    { origin: "https://d.example", route: "/api/hash", method: "POST" },
    { origin: "https://e.example", path: "api/thumb" },
  ],
  sellers: ["https://listed-seller.example", { origin: "https://also-listed.example/" }],
  urls: ["https://f.example/v1/read"],
  origins: ["https://origin-only.example"],
});
ok(parsed.routes.has("https://b.example\t*\t/api/ocr"), "string route → origin + any-method path");
ok(parsed.routes.has("https://c.example\t*\t/api/scan"), "{url} route object");
ok(parsed.routes.has("https://d.example\tPOST\t/api/hash"), "{origin,route,method} is method-scoped");
ok(parsed.routes.has("https://e.example\t*\t/api/thumb"), "path without a leading slash is normalised");
ok(parsed.routes.has("https://f.example\t*\t/v1/read"), "urls[] is an alias of routes[]");
ok(parsed.sellers.has("https://listed-seller.example") && parsed.sellers.has("https://also-listed.example"), "sellers[] accepts strings and {origin}, trailing slash folded");
ok(parsed.sellers.has("https://origin-only.example"), "origins[] is an alias of sellers[]");

const fromArray = parseVerifiedFeed(["https://g.example", "https://g.example/api/foo"]);
ok(fromArray.sellers.has("https://g.example") && fromArray.routes.has("https://g.example\t*\t/api/foo"), "bare JSON array of origin + route strings");
ok(parseVerifiedFeed("not-json").sellers.size === 0 && parseVerifiedFeed(null).routes.size === 0, "bad / empty body → empty feed (fail-open)");

// ---------------------------------------------------------------------------
// Match helper: flag off ignores the feed; flag on matches route or seller
// ---------------------------------------------------------------------------
_setVerifiedListForTest(parsed);
delete process.env.X402_VERIFIED_LIST;
ok(routeOnVerifiedList({ seller: "https://b.example", method: "POST", route: "/api/ocr" }) === false,
  "flag off: a listed route is NOT preferred");
process.env.X402_VERIFIED_LIST = "on";
ok(routeOnVerifiedList({ seller: "https://b.example", method: "POST", route: "/api/ocr" }) === true,
  "flag on: listed path matches any method");
ok(routeOnVerifiedList({ seller: "https://d.example", method: "POST", route: "/api/hash" }) === true,
  "flag on: method-scoped route matches POST");
ok(routeOnVerifiedList({ seller: "https://d.example", method: "GET", route: "/api/hash" }) === false,
  "flag on: method-scoped route does not match a different method");
ok(routeOnVerifiedList({ seller: "https://listed-seller.example", method: "GET", route: "/anything" }) === true,
  "flag on: seller-level entry matches every route at that origin");
ok(routeOnVerifiedList({ seller: "https://a.example", method: "POST", route: "/api/ocr" }) === false,
  "flag on: unlisted origin is not preferred");

// ---------------------------------------------------------------------------
// routeQuery: flag OFF — listing does not change a true ranking tie
// ---------------------------------------------------------------------------
seedEqualPair();
_setVerifiedListForTest(parseVerifiedFeed({ routes: ["https://b.example/api/ocr"] }));
delete process.env.X402_VERIFIED_LIST;
const off = extSellers();
ok(off.length === 2, `flag off: both equal candidates still return (got ${off.length})`);
ok(off[0].seller === "https://a.example" && off[1].seller === "https://b.example",
  `flag off: insertion order preserved on a tie — listed b does not jump (got ${off.map((x) => x.seller).join(", ")})`);
ok(off.every((x) => x.why.verifiedList === undefined), "flag off: why.verifiedList is absent");
ok(off[0].why.tiebreaks.includes("verified-list") === false, "flag off: tiebreaks list is unchanged");

// ---------------------------------------------------------------------------
// routeQuery: flag ON — listed route wins the remaining tie
// ---------------------------------------------------------------------------
process.env.X402_VERIFIED_LIST = "on";
const on = extSellers();
ok(on.length === 2 && on[0].seller === "https://b.example" && on[1].seller === "https://a.example",
  `flag on: listed route ranks first among equal candidates (got ${on.map((x) => x.seller).join(", ")})`);
ok(on[0].why.verifiedList === true && on[1].why.verifiedList === false, "flag on: why.verifiedList reports membership");
ok(on[0].why.tiebreaks[on[0].why.tiebreaks.length - 1] === "verified-list", "flag on: verified-list is the last tiebreak");

// Score still wins: a unique slug match beats a listed peer.
const cache = _cacheForTests();
cache.set("https://a.example", {
  manifest: { name: "a", homepage: "https://a.example" },
  tools: [{ seller: "https://a.example", method: "POST", route: "/api/unique-ocr", slug: "unique-ocr", name: "unique ocr", description: "ocr a thing", category: "vision", tags: ["ocr"], price: 0.003 }],
  fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1],
});
const scored = extSellers({ query: "unique-ocr" });
ok(scored[0].seller === "https://a.example", "flag on: a stronger lexical match still beats a listed peer");

// Refresh: injected fetch, no network. Failed refresh keeps the previous set.
process.env.X402_VERIFIED_LIST = "on";
_setVerifiedListForTest(parseVerifiedFeed({ sellers: ["https://keep.example"] }));
await refreshVerifiedList({ fetchImpl: async () => { throw new Error("boom"); } });
ok(routeOnVerifiedList({ seller: "https://keep.example", route: "/", method: "GET" }) === true,
  "flag on: failed refresh keeps the previous feed");
await refreshVerifiedList({ fetchImpl: async () => ({ html: JSON.stringify({ sellers: ["https://new.example"] }) }) });
ok(routeOnVerifiedList({ seller: "https://new.example", route: "/", method: "GET" }) === true
  && routeOnVerifiedList({ seller: "https://keep.example", route: "/", method: "GET" }) === false,
  "flag on: successful refresh replaces the set");
delete process.env.X402_VERIFIED_LIST;
await refreshVerifiedList({ fetchImpl: async () => ({ html: JSON.stringify({ sellers: ["https://ignored.example"] }) }) });
ok(routeOnVerifiedList({ seller: "https://ignored.example", route: "/", method: "GET" }) === false,
  "flag off: refresh does not apply preference");

restore();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
