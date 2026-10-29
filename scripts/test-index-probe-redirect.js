#!/usr/bin/env node
// Live probes go where the seller answers. A stored origin whose manifest is
// served from another origin by permanent redirect (the common case: an http
// key whose host answers over https) was probed at the stored key, where every
// unpaid request read 301, so the paywall stood as failed while the seller's
// real paywall was healthy. Offline: documents go through the crawl seam and
// probes through the probe seam, against loopback listeners, so the REAL
// crawl pipeline (crawlSeller -> enrichLiveQuotes -> probePaywall) runs with no
// network and no TLS. The seam maps https loopback URLs onto plain listeners,
// so an https upgrade can be exercised without a certificate.
//
// What is pinned:
//   * a recorded redirect origin is where probes are built from, keyed on the
//     recorded origin and not on the https scheme;
//   * without one, an http probe answered 301/308 with the same request over
//     https on the same host is asked once more there, and the answering URL
//     is what the index records;
//   * a redirect to another host is never followed: the 301 is the answer;
//   * the register door still refuses an http origin, and a registered seller's
//     detail shows the recorded redirect origin and the probed URL that answered.
process.env.X402_INDEX_CRAWL = "off";
process.env.X402_PAYWALL_PROBES_PER_CYCLE = "25";
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.REMOVED_ORIGINS_FILE = join(mkdtempSync(join(tmpdir(), "probe-redirect-")), "removed-origins.json");
}
const { createServer } = await import("node:http");
const idx = await import("../src/x402-index.js");
const {
  redirectedOriginOf, probeOriginOf, schemeUpgradeOf, probeSellerRoute, validateOriginInput, registerOrigin, sellerDetail,
  __setCrawlFetchForTest, __setProbeFetchForTest, __crawlSellerForTest, __testResetSubmitted, __resetRobotsCacheForTest, _cacheForTests,
} = idx;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

// ---------------------------------------------------------------- pure helpers
{
  ok(redirectedOriginOf("http://seller.test", "https://seller.test/.well-known/x402") === "https://seller.test", "a same-host scheme upgrade is a recorded redirect origin");
  ok(redirectedOriginOf("https://old.seller.test", "https://new.seller.test/.well-known/x402") === "https://new.seller.test", "another host is recorded as before");
  ok(redirectedOriginOf("https://www.seller.test", "https://seller.test/.well-known/x402") === null, "www on the same scheme is still the same origin");
  ok(redirectedOriginOf("https://seller.test", "https://seller.test/.well-known/x402") === null && redirectedOriginOf("https://seller.test", null) === null, "same origin or no final URL is not a redirect");

  ok(probeOriginOf("http://seller.test", "https://seller.test") === "https://seller.test", "probes build from the recorded redirect origin");
  ok(probeOriginOf("http://seller.test", "http://seller.test:8080") === "http://seller.test:8080", "keyed on the recorded origin, not on an https scheme");
  ok(probeOriginOf("http://seller.test", null) === "http://seller.test" && probeOriginOf("http://seller.test", "") === "http://seller.test", "no recorded redirect: the stored key");
  ok(probeOriginOf("https://apps.seller.test/app/one", "https://other.test") === "https://apps.seller.test/app/one", "a path seller's key is always its own");
  ok(probeOriginOf("http://seller.test", "ftp://seller.test") === "http://seller.test" && probeOriginOf("http://seller.test", "nonsense") === "http://seller.test", "an unusable recorded origin is ignored");

  ok(schemeUpgradeOf("http://seller.test/v1/q?x=1", "https://seller.test/v1/q?x=1") === "https://seller.test/v1/q?x=1", "the same request over https on the same host is an upgrade");
  ok(schemeUpgradeOf("http://seller.test/v1/q", "https://seller.test:8443/v1/q") === "https://seller.test:8443/v1/q", "a port on the same host is still the same host");
  ok(schemeUpgradeOf("http://seller.test/v1/q", "https://other.test/v1/q") === null, "another host is not followed");
  ok(schemeUpgradeOf("http://seller.test/v1/q", "http://seller.test/v1/q") === null, "http to http is not an upgrade");
  ok(schemeUpgradeOf("https://seller.test/v1/q", "https://seller.test/v2/q") === null, "an https target is never re-asked");
  ok(schemeUpgradeOf("http://seller.test/v1/q", "https://seller.test/v2/q") === null && schemeUpgradeOf("http://seller.test/v1/q?x=1", "https://seller.test/v1/q") === null, "a moved path or dropped query is not an upgrade");
  ok(schemeUpgradeOf("http://seller.test/v1/q", "/v1/q") === null && schemeUpgradeOf("http://seller.test/v1/q", null) === null && schemeUpgradeOf("http://seller.test/v1/q", "https://u:p@seller.test/v1/q") === null, "a relative, missing or credentialed location is not followed");
}

// ---------------------------------------------------------------- loopback sellers
const listen = (handler) => new Promise((resolve) => {
  const s = createServer(handler);
  s.listen(0, "127.0.0.1", () => resolve({ server: s, origin: `http://127.0.0.1:${s.address().port}` }));
});
const paywalled = (req, res) => { res.writeHead(402, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "payment required" })); };
const redirectTo = (base) => (req, res) => { res.writeHead(301, { location: `${base}${req.url}` }); res.end(); };
// The https twin of a listener: the probe seam below sends it to the plain port.
const httpsTwin = (origin) => origin.replace(/^http:/, "https:");

const live = await listen(paywalled);                               // the seller's paywall
const movedRecorded = await listen(redirectTo(httpsTwin(live.origin))); // stored key; manifest recorded as served from `live`
const movedUnrecorded = await listen(redirectTo(httpsTwin(live.origin))); // stored key; no redirect recorded
const leaving = await listen(redirectTo("https://other.seller.test"));   // redirects to another host
const servers = [live, movedRecorded, movedUnrecorded, leaving];

const asked = [];
__setProbeFetchForTest((url, opts) => {
  asked.push(url);
  // Loopback only: the seam stands in for the public-URL guard, which refuses
  // loopback and would be what production uses. An https loopback URL is sent
  // to its plain listener, so an upgrade is exercised without TLS.
  const u = new URL(url);
  if (u.hostname !== "127.0.0.1") return Promise.reject(Object.assign(new Error(`left the loopback: ${url}`), { code: "ENOTFOUND" }));
  return fetch(url.replace(/^https:/, "http:"), { ...opts, redirect: "manual" });
});
const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "5000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x" + "a1".repeat(20), maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }];
const manifestFor = (origin) => ({ x402Version: 2, name: "Quote seller", resources: [{ resource: `${origin}/v1/quote`, method: "GET", description: "One quote.", price: "$0.005", accepts }] });
const served = new Map(); // manifest URL -> { body, finalUrl }
__setCrawlFetchForTest(async (url) => {
  if (url.endsWith("/robots.txt")) return { html: "User-agent: *\nAllow: /\n", finalUrl: url, validators: null };
  const hit = served.get(url);
  if (!hit) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422 });
  return { html: JSON.stringify(hit.body), finalUrl: hit.finalUrl || url, validators: null };
});
const askedOf = (origin) => asked.filter((u) => u.startsWith(`${origin}/`));
const crawl = async (origin) => { asked.length = 0; __resetRobotsCacheForTest(); await __crawlSellerForTest(origin); return _cacheForTests().get(origin); };

// 1. The manifest was served from another origin: every probe is built from it.
{
  const key = movedRecorded.origin;
  served.set(`${key}/.well-known/x402`, { body: manifestFor(key), finalUrl: `${live.origin}/.well-known/x402` });
  const v = await crawl(key);
  ok(v?.redirectedTo === live.origin, `the crawl recorded the origin the manifest was served from (${v?.redirectedTo})`);
  ok(v?.paywall?.ok === true && v.paywall.status === 402, `paywall probed healthy at the recorded origin (${JSON.stringify(v?.paywall)})`);
  ok(v?.paywall?.url === `${live.origin}/v1/quote`, "paywall.url is the URL that answered");
  ok(askedOf(key).length === 0 && askedOf(live.origin).length > 0, `no probe went to the stored key; ${askedOf(live.origin).length} went to the recorded origin (quote probes included)`);
  ok(_cacheForTests().has(key) && !_cacheForTests().has(live.origin), "the stored key stays the index key; nothing is stored under the recorded origin");
}

// 2. Nothing recorded, the http probe answers 301 to the same host over https:
//    asked once more there, and the answering URL is recorded.
{
  const key = movedUnrecorded.origin;
  served.set(`${key}/.well-known/x402`, { body: manifestFor(key) });
  const v = await crawl(key);
  ok(!v?.redirectedTo, "no redirect recorded for this seller");
  ok(v?.paywall?.ok === true && v.paywall.status === 402, `paywall probed healthy after the upgrade (${JSON.stringify(v?.paywall)})`);
  ok(v?.paywall?.url === `${httpsTwin(live.origin)}/v1/quote`, "paywall.url is the https URL that answered");
  const first = asked.indexOf(`${key}/v1/quote`), second = asked.indexOf(`${httpsTwin(live.origin)}/v1/quote`);
  ok(first >= 0 && second > first, "the stored key was asked first, the upgraded URL after its 301");
  ok(asked.every((u) => u.startsWith(`${key}/`) || u.startsWith(`${httpsTwin(live.origin)}/`)), "only the stored key and its https upgrade were asked");
}

// 3. A 301 to another host is the answer, never followed.
{
  const key = leaving.origin;
  served.set(`${key}/.well-known/x402`, { body: manifestFor(key) });
  const v = await crawl(key);
  ok(v?.paywall?.ok === false && v.paywall.status === 301, `a redirect off the host reads as the 301 it is (${JSON.stringify(v?.paywall)})`);
  ok(v?.paywall?.url === `${key}/v1/quote`, "paywall.url stays the stored URL");
  ok(asked.every((u) => u.startsWith(`${key}/`)), "no request left the stored host");
}

// 4. The probe primitive itself: the second request goes through the same guard.
{
  const guarded = [];
  __setProbeFetchForTest((url, opts) => { guarded.push(url); return fetch(url.replace(/^https:/, "http:"), { ...opts, redirect: "manual" }); });
  const r = await probeSellerRoute(`${movedUnrecorded.origin}/v1/quote`, { method: "GET", headers: { Accept: "application/json" } });
  ok(r.res.status === 402 && r.url === `${httpsTwin(live.origin)}/v1/quote` && guarded.length === 2, "probeSellerRoute re-asks once, through the guard, and names the answering URL");
  const stay = await probeSellerRoute(`${leaving.origin}/v1/quote`, { method: "GET", headers: {} });
  ok(stay.res.status === 301 && stay.url === `${leaving.origin}/v1/quote` && guarded.length === 3, "a redirect off the host is returned as given, with no second request");
  __setProbeFetchForTest((url, opts) => { asked.push(url); return fetch(url.replace(/^https:/, "http:"), { ...opts, redirect: "manual" }); });
}

// 5. Registration: the door refuses an http origin, so a new listing never
//    carries the http form; a listed seller whose manifest is served from
//    another origin shows that origin and the probed URL on its detail.
{
  ok(validateOriginInput("http://seller.test", { selfOrigin: "https://agent402.tools" }).error != null, "the register door refuses an http origin");
  ok(validateOriginInput("http://seller.test", { selfOrigin: "https://agent402.tools", allowPath: true }).error != null, "also with a path allowed");
  __testResetSubmitted();
  __resetRobotsCacheForTest();
  asked.length = 0;
  const key = "https://seller.test";
  const servedFrom = "https://api.seller.test";
  served.set(`${key}/.well-known/x402`, { body: manifestFor(key), finalUrl: `${servedFrom}/.well-known/x402` });
  // Probes for both hosts land on loopback listeners: the stored host answers
  // 301 off the host, the served-from host answers the paywall.
  __setProbeFetchForTest((url, opts) => {
    asked.push(url);
    const mapped = url.startsWith(`${servedFrom}/`) ? url.replace(servedFrom, live.origin) : url.replace(key, leaving.origin);
    return fetch(mapped, { ...opts, redirect: "manual" });
  });
  const v = validateOriginInput(key, { selfOrigin: "https://agent402.tools" });
  const r = await registerOrigin(v.origin, {});
  ok(r?.listed === true && r.origin === key, `registered and listed under the stored key (${JSON.stringify({ listed: r?.listed, origin: r?.origin, error: r?.error })})`);
  const d = sellerDetail("seller.test");
  ok(d?.redirectedTo === servedFrom, `the detail shows the origin the manifest is served from (${d?.redirectedTo})`);
  ok(d?.paywall?.ok === true && d.paywall.url === `${servedFrom}/v1/quote`, `the detail's paywall.url is the probed URL that answered (${JSON.stringify(d?.paywall)})`);
  ok(asked.every((u) => u.startsWith(`${servedFrom}/`)), "every probe for the registered seller went to the served-from origin");
}

// 6. A document served from ANOTHER host is that host's document. A bare
//    origin whose manifest lands on an unrelated host that is not a listed
//    seller gets no rows from it; the seller's own subdomain, or a listed
//    self-canonical seller, is accepted as before.
{
  const { crossHostRedirectAccepted } = idx;
  __resetRobotsCacheForTest();
  // Every live probe lands on the paywall listener, whatever host it names.
  __setProbeFetchForTest((url, opts) => { asked.push(url); return fetch(url.replace(/^https?:\/\/[^/]+/, live.origin), { ...opts, redirect: "manual" }); });
  const bare = "https://bare.test", victim = "https://victim.test", own = "https://api.bare.test";
  served.set(`${bare}/.well-known/x402`, { body: manifestFor(bare), finalUrl: `${victim}/.well-known/x402` });
  served.set(`${bare}/openapi.json`, { body: { openapi: "3.0.0", paths: { "/v1/quote": { get: { summary: "One quote", "x-price": "$0.005" } } } }, finalUrl: `${victim}/openapi.json` });
  const v = await crawl(bare);
  ok(crossHostRedirectAccepted(bare, victim) === false, "an unrelated host that is not a listed seller is not this seller's");
  ok(!(v?.tools || []).length && !v?.redirectedTo, `no row is listed under the bare origin from the other host's documents (tools ${(v?.tools || []).length}, redirectedTo ${v?.redirectedTo})`);
  ok(/redirected to another host/.test(String(v?.error || "")) || (v?.fallbackErrors || []).some((f) => /redirected to another host/.test(f.error)), `the record says why (${String(v?.error || "").slice(0, 80)})`);
  // The seller's own subdomain: accepted, recorded, probed there.
  served.set(`${bare}/.well-known/x402`, { body: manifestFor(bare), finalUrl: `${own}/.well-known/x402` });
  served.delete(`${bare}/openapi.json`);
  const o = await crawl(bare);
  ok(crossHostRedirectAccepted(bare, own) && crossHostRedirectAccepted(own, bare) && o?.redirectedTo === own && (o?.tools || []).length > 0, `a move inside the seller's own domain is accepted and recorded (${o?.redirectedTo}, ${(o?.tools || []).length} rows)`);
  // A listed, self-canonical seller: accepted (computeAliasOrigins then folds the key into it).
  _cacheForTests().set(victim, { manifest: { name: "Victim", homepage: victim }, tools: [{ seller: victim, method: "GET", route: "/v1/quote", price: "$0.005", networks: ["eip155:8453"] }], fetchedAt: Date.now(), error: null, originResponded: true, history: [1, 1, 1] });
  ok(crossHostRedirectAccepted(bare, victim) === true, "a listed seller whose own manifest is self-canonical is accepted");
  _cacheForTests().set(victim, { manifest: { name: "Victim", homepage: "https://elsewhere.test" }, tools: [], fetchedAt: Date.now(), error: null, history: [1] });
  ok(crossHostRedirectAccepted(bare, victim) === false, "...but not one whose own manifest points at a third host");
  _cacheForTests().delete(victim);
  _cacheForTests().delete(bare);
}

__setProbeFetchForTest(null);
__setCrawlFetchForTest(null);
for (const s of servers) s.server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
