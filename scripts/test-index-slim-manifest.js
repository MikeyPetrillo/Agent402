#!/usr/bin/env node
// A crawled entry keeps the slim manifest, and a 304 still derives the same
// catalog.
//
// The crawl derives a seller's tools from its /.well-known/x402 document and
// then kept the whole parsed document on the cache entry, so every seller's
// full catalog document stayed on the heap between crawls. The entry now
// keeps the slim keys its readers use (name, homepage, payment, capabilities,
// description) plus, when the origin sends a validator, the document's body
// packed for the next crawl's 304. This test drives the real crawl through
// the __setCrawlFetchForTest seam with a stub that honors If-None-Match and
// requires:
//   - the entry holds no parsed catalog, and the replica copy no body;
//   - a 304 crawl derives exactly the tools and seller detail a full read did
//     (free_endpoints and catalog payment terms included);
//   - an origin without validators keeps no body and is read in full each time;
//   - a 304 with no kept body falls back to one full read, never to an empty
//     catalog;
//   - the seller's own description is kept whole for the listing check.
// Offline.
process.env.X402_INDEX_CRAWL = "off";
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = mkdtempSync(join(tmpdir(), "slim-manifest-"));
process.env.REMOVED_ORIGINS_FILE = join(dir, "removed-origins.json");
const {
  sellerDetail, __setCrawlFetchForTest, __resetRobotsCacheForTest, __crawlSellerForTest, _cacheForTests,
  _routerReplicaEntryOf, indexMemoryFigures,
} = await import("../src/x402-index.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const ETAGGED = "https://etagged.stubreg.xyz";
const PLAIN = "https://plain.stubreg.xyz";
const PAYTO = "0x00000000000000000000000000000000000000aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const LONG = "A seller description that runs past the persisted cap. ".repeat(12).trim();
const manifestOf = (origin) => ({
  x402Version: 2,
  name: `Stub ${origin.slice(8, 15)}`,
  description: LONG,
  homepage: origin,
  payment: { x402: { primaryNetwork: "eip155:8453" } },
  capabilities: { tools: 6 },
  free_endpoints: ["/api/free"],
  resources: [
    ...Array.from({ length: 5 }, (_, i) => ({
      resource: `${origin}/api/tool${i}`,
      description: `Tool ${i} answers a question.`,
      accepts: [{
        scheme: "exact", network: "eip155:8453", asset: USDC, maxAmountRequired: String(10000 * (i + 1)), payTo: PAYTO,
        extra: { name: "USD Coin", version: "2" },
        outputSchema: { input: { type: "http", method: "POST", bodyFields: { q: { type: "string", description: "x".repeat(200) } } } },
      }],
    })),
    { resource: `${origin}/api/free`, description: "A free route the seller declares free." },
  ],
});
const served = new Map([
  [`${ETAGGED}/robots.txt`, "User-agent: *\nAllow: /\n"],
  [`${ETAGGED}/.well-known/x402`, JSON.stringify(manifestOf(ETAGGED), null, 2)],
  [`${PLAIN}/robots.txt`, "User-agent: *\nAllow: /\n"],
  [`${PLAIN}/.well-known/x402`, JSON.stringify(manifestOf(PLAIN))],
]);
const etag = (url) => `"${Buffer.from(url).toString("base64").slice(-12)}"`;
const fetches = new Map();
let notModified = 0;
__setCrawlFetchForTest(async (url, opts = {}) => {
  fetches.set(url, (fetches.get(url) || 0) + 1);
  const body = served.get(url);
  if (body === undefined) throw Object.assign(new Error(`Upstream returned HTTP 404 for ${url}`), { statusCode: 422 });
  const withValidators = new URL(url).origin === new URL(ETAGGED).origin;
  const sent = opts.validators?.etag;
  if (withValidators && opts.allowNotModified && sent && sent === etag(url)) { notModified++; return { notModified: true, finalUrl: url, validators: null }; }
  return { html: body, finalUrl: url, validators: withValidators ? { etag: etag(url) } : null };
});

// What a reader sees, without the clocks (and the crawl history, which grows by one per crawl).
const CLOCKS = new Set(["history", "fetchedAt", "lastCrawledAt", "lastVerifiedAt", "quoteObservedAt", "networksVerifiedAt", "generatedAt", "observedAt", "checkedAt", "at"]);
const strip = (v) => JSON.stringify(v, (k, x) => (CLOCKS.has(k) ? undefined : x));
const crawl = async (origin) => { __resetRobotsCacheForTest(); fetches.clear(); await __crawlSellerForTest(origin); return sellerDetail(origin); };
const wellKnown = (o) => `${o}/.well-known/x402`;

for (const origin of [ETAGGED, PLAIN]) {
  const label = origin === ETAGGED ? "validators" : "no validators";
  const first = await crawl(origin);
  const e1 = _cacheForTests().get(origin);
  ok(first?.toolCount === 5, `${label}: the first crawl lists the paid routes and drops the declared free one (${first?.toolCount})`);
  ok(e1?.manifest?.slimmed === true && !("resources" in e1.manifest) && !("free_endpoints" in e1.manifest), `${label}: the entry keeps the slim manifest, not the catalog`);
  ok(e1?.manifest?.name && e1.manifest.homepage === origin && e1.manifest.payment?.x402?.primaryNetwork === "eip155:8453" && e1.manifest.capabilities?.tools === 6, `${label}: name, homepage, payment and declared tool count are kept`);
  ok(e1?.manifest?.description === LONG, `${label}: the seller's description is kept whole`);
  ok(first?.displayName === e1?.manifest?.name && first?.declaredToolCount === 6, `${label}: the detail still reads the name and the declared count (${first?.displayName}, ${first?.declaredToolCount})`);
  if (origin === ETAGGED) ok(Buffer.isBuffer(e1?.manifestBody), "validators: the packed body is kept for a 304");
  else ok(e1?.manifestBody == null, "no validators: no body is kept (no 304 can come)");
  ok(!("manifestBody" in (_routerReplicaEntryOf(e1) || {})), `${label}: the router replica copy carries no body`);

  const before = notModified;
  const second = await crawl(origin);
  const e2 = _cacheForTests().get(origin);
  if (origin === ETAGGED) {
    ok(notModified === before + 1 && fetches.get(wellKnown(origin)) === 1, `validators: the second crawl is one conditional read answered 304 (${fetches.get(wellKnown(origin))} read)`);
    ok(e2?.manifestBody === e1?.manifestBody, "validators: the 304 keeps the same packed body");
  } else {
    ok(notModified === before && fetches.get(wellKnown(origin)) === 1, "no validators: the second crawl reads the document in full, once");
  }
  ok(strip(second) === strip(first), `${label}: the second crawl derives the same seller detail`);
  ok(strip(e2?.tools) === strip(e1?.tools), `${label}: and the same tool rows`);
}

// A 304 with nothing kept (an entry that lost its body) reads the document
// again instead of deriving from nothing.
{
  const e = _cacheForTests().get(ETAGGED);
  const firstTools = strip(e.tools);
  _cacheForTests().set(ETAGGED, { ...e, manifestBody: undefined });
  const before = notModified;
  const d = await crawl(ETAGGED);
  ok(notModified === before + 1 && fetches.get(wellKnown(ETAGGED)) === 2, `a 304 with no kept body is followed by one full read (${fetches.get(wellKnown(ETAGGED))} reads)`);
  ok(d?.toolCount === 5 && strip(_cacheForTests().get(ETAGGED).tools) === firstTools, "and the catalog is the same");
  ok(Buffer.isBuffer(_cacheForTests().get(ETAGGED).manifestBody), "and the body is kept again");
}

const figures = indexMemoryFigures();
ok(figures.fullManifests === 0 && figures.slimManifests === 2, `no crawled entry holds a full manifest (${figures.fullManifests} full, ${figures.slimManifests} slim)`);
ok(figures.manifestBodies === 1 && figures.manifestBodyBytes > 0, `one packed body is held (${figures.manifestBodyBytes} bytes)`);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
