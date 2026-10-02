// Which listed routes exist. A seller's listing merges their own documents with
// registry rows (minted by any past settled payment, never retired upstream)
// and earlier live 402s, and the merge only adds - so a route the seller
// removed stayed listed and re-registering could not clear it. Pinned offline
// against a stubbed fetch:
//   1. stampDeclared marks routes the seller's documents name (exact, template);
//   2. a 410 on the row's own verb drops any row, declared or not, and the mark
//      keeps the next crawl's merge from restoring it;
//   3. an UNDECLARED row whose own verb answers 404/405 twice, at least
//      MISS_CONFIRM_MS apart, is dropped (one reading mid-deploy is not); the
//      mark hides only undeclared rows, so a route the seller declares again
//      returns; a live answer clears a pending miss; re-registering clears all;
//   4. an undeclared row that answers a live 402 is kept and stamped;
//   5. nothing non-definitive drops a row (5xx, 429, 400, a thrown fetch), a
//      declared row survives a 404, a URL template is never judged, and an
//      inferred verb must miss on every verb tried;
//   6. an undeclared row needs a live proof every LIVE_PROOF_MAX_AGE_MS, which
//      carry-forward preserves across crawls;
//   7. marks lapse after GONE_ROUTE_TTL_MS.
import assert from "node:assert/strict";
process.env.X402_INDEX_CRAWL = "off";
const {
  enrichLiveQuotes, dropGoneRoutes, isRouteGone, markRouteGone, _resetGoneRoutes, GONE_ROUTE_TTL_MS,
  stampDeclared, needsLiveProof, LIVE_PROOF_MAX_AGE_MS, carryForwardLearnedQuotes, listingBasisProjection,
  quoteIsStale, networksNeedLiveVerify, MISS_CONFIRM_MS, clearGoneMarks, goneMark,
} = await import("../src/x402-index.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const ORIGIN = "https://example.com"; // resolves: the SSRF guard checks the host before the (stubbed) fetch
const accepts = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", payTo: "0x9fb365E4E9385E2a39FeBAd70368267e6f571d9A", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }] };
const header = Buffer.from(JSON.stringify(accepts)).toString("base64");
const stub = (rules) => async (url, init = {}) => {
  const u = new URL(String(url)); const m = String(init.method || "GET").toUpperCase();
  const status = rules[`${m} ${u.pathname}`] ?? 404;
  if (status === "throw") throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
  const headers = new Headers(status === 402 ? { "payment-required": header } : {});
  return new Response("{}", { status, headers });
};
const row = (route, method = "POST", extra = {}) => ({ seller: "example.com", route, method, slug: route.slice(1).replace(/\//g, "-"), price: 0.01, paid: true, networks: ["eip155:8453"], provenance: "bazaar", ...extra });
const routes = (arr) => arr.map((t) => t.route).join(",");
const logs = [];
const origLog = console.log; console.log = (...a) => { logs.push(a.join(" ")); };
const orig = globalThis.fetch;

try {
  _resetGoneRoutes();

  // --- 1. stampDeclared
  const st = stampDeclared(
    [row("/v1/a"), row("/v1/items/42"), row("/v1/b?x=1"), row("/v1/c")],
    [{ route: "/v1/a" }, { route: "/v1/items/{id}" }, { route: "/v1/b" }],
  );
  ok(st[0].declared === true && st[1].declared === true && st[2].declared === true, "exact paths, an instance of a declared template and a path with a query are declared");
  ok(st[3].declared === false, "a route the documents do not name is undeclared");

  // --- 2. a 410 on the row's own verb drops any row
  globalThis.fetch = stub({ "POST /v1/jobs": 410, "POST /v1/web/read": 402 });
  const t410 = [row("/v1/jobs", "POST", { declared: true }), row("/v1/web/read", "POST", { declared: false })];
  const same = t410;
  await enrichLiveQuotes(t410, ORIGIN, { ignoreBudget: true });
  ok(routes(same) === "/v1/web/read", `a 410 drops even a declared row, in place (got ${routes(same)})`);
  ok(isRouteGone(ORIGIN, "POST", "/v1/jobs"), "and marks it gone");
  ok(logs.some((l) => /live-410: .*\/v1\/jobs answered POST 410 Gone; dropped the row/.test(l)), "and logs it");
  globalThis.fetch = async () => { throw new Error("a marked route must not be probed"); };
  const rebuilt410 = [row("/v1/jobs", "POST", { declared: true }), row("/v1/web/read", "POST", { declared: false, liveProvenAt: Date.now() })];
  await enrichLiveQuotes(rebuilt410, ORIGIN);
  ok(routes(rebuilt410) === "/v1/web/read", "the next crawl's rebuilt row is dropped before any probe, declared or not");
  ok(!isRouteGone("https://other.example", "POST", "/v1/jobs") && !isRouteGone(ORIGIN, "GET", "/v1/jobs"), "the mark is per origin and per verb");

  // --- 3. an undeclared row that answers 404 on its own verb leaves; declaring it again brings it back
  globalThis.fetch = stub({ "POST /v1/old": 404, "POST /v1/gone405": 405 });
  const first = [row("/v1/old", "POST", { declared: false }), row("/v1/gone405", "POST", { declared: false })];
  await enrichLiveQuotes(first, ORIGIN, { ignoreBudget: true });
  ok(first.length === 2, "one 404/405 reading keeps the row (a deploy blip is not a retirement)");
  ok(goneMark(ORIGIN, "POST", "/v1/old")?.kind === "pending" && !isRouteGone(ORIGIN, "POST", "/v1/old"), "and records a pending miss");
  await enrichLiveQuotes(first, ORIGIN, { ignoreBudget: true });
  ok(first.length === 2, "a second miss inside the confirm window still keeps it");
  const backdate = Date.now() - MISS_CONFIRM_MS - 60_000;
  markRouteGone(ORIGIN, "POST", "/v1/old", { at: backdate, kind: "pending" });
  markRouteGone(ORIGIN, "POST", "/v1/gone405", { at: backdate, kind: "pending" });
  const miss = [row("/v1/old", "POST", { declared: false }), row("/v1/gone405", "POST", { declared: false })];
  await enrichLiveQuotes(miss, ORIGIN, { ignoreBudget: true });
  ok(miss.length === 0, `a miss confirmed after the window drops the rows (left ${routes(miss)})`);
  ok(logs.some((l) => /live-miss: .*\/v1\/old is not in the seller's documents and answered POST 404/.test(l)), "and logged as a miss");
  globalThis.fetch = async () => { throw new Error("must not probe"); };
  const again = [row("/v1/old", "POST", { declared: false })];
  await enrichLiveQuotes(again, ORIGIN);
  ok(again.length === 0, "a rebuilt undeclared row for a missed route stays out");
  const declaredAgain = [row("/v1/old", "POST", { declared: true, quoteSource: "live-402", quoteObservedAt: Date.now() })];
  dropGoneRoutes(declaredAgain, ORIGIN);
  ok(declaredAgain.length === 1, "a missed route the seller now declares is listed again");
  ok(clearGoneMarks(ORIGIN) >= 2 && !isRouteGone(ORIGIN, "POST", "/v1/old") && !isRouteGone(ORIGIN, "POST", "/v1/jobs"), "re-registering clears every mark on the origin");
  markRouteGone(ORIGIN, "POST", "/v1/blip", { kind: "pending" });
  globalThis.fetch = stub({ "POST /v1/blip": 402 });
  await enrichLiveQuotes([row("/v1/blip", "POST", { declared: false })], ORIGIN, { ignoreBudget: true });
  ok(goneMark(ORIGIN, "POST", "/v1/blip") == null, "a live 402 clears a pending miss");

  // --- 4. an undeclared row answering a live 402 is kept and stamped
  globalThis.fetch = stub({ "POST /v1/live": 402 });
  const live = [row("/v1/live", "POST", { declared: false })];
  await enrichLiveQuotes(live, ORIGIN);
  ok(live.length === 1 && live[0].liveProvenAt > 0, "an undeclared row that answers 402 stays and is stamped live");
  const basis = listingBasisProjection(live[0]);
  ok(basis.declared === false && basis.source === "registry" && typeof basis.lastVerifiedAt === "string", `the seller view says why it is listed (${JSON.stringify(basis)})`);

  // --- 5. nothing non-definitive drops a row
  globalThis.fetch = stub({ "POST /v1/e500": 500, "POST /v1/e429": 429, "POST /v1/e400": 400, "POST /v1/timeout": "throw", "POST /v1/doc": 404, "POST /v1/tpl/{id}": 404 });
  const keep = [
    row("/v1/e500", "POST", { declared: false }), row("/v1/e429", "POST", { declared: false }), row("/v1/e400", "POST", { declared: false }),
    row("/v1/timeout", "POST", { declared: false }), row("/v1/doc", "POST", { declared: true }), row("/v1/tpl/{id}", "POST", { declared: false }),
  ];
  await enrichLiveQuotes(keep, ORIGIN, { ignoreBudget: true });
  ok(keep.length === 6, `5xx, 429, 400, a timeout, a declared 404 and a template drop nothing (left ${routes(keep)})`);
  globalThis.fetch = stub({ "POST /v1/inf1": 404, "GET /v1/inf1": 402, "POST /v1/inf2": 404, "GET /v1/inf2": 404, "POST /v1/inf3": 405, "GET /v1/inf3": 500 });
  const inferred = [
    row("/v1/inf1", "POST", { declared: false, methodInferred: true }),
    row("/v1/inf2", "POST", { declared: false, methodInferred: true }),
    row("/v1/inf3", "POST", { declared: false, methodInferred: true }),
  ];
  for (const r of ["/v1/inf2", "/v1/inf3"]) markRouteGone(ORIGIN, "POST", r, { at: Date.now() - MISS_CONFIRM_MS - 60_000, kind: "pending" });
  await enrichLiveQuotes(inferred, ORIGIN, { ignoreBudget: true });
  ok(routes(inferred) === "/v1/inf1,/v1/inf3", `an inferred verb is dropped only when every verb misses (left ${routes(inferred)})`);
  ok(!isRouteGone(ORIGIN, "POST", "/v1/inf1") && !isRouteGone(ORIGIN, "POST", "/v1/inf3") && isRouteGone(ORIGIN, "POST", "/v1/inf2"), "only the route that missed on every verb is marked");
  ok(!isRouteGone(ORIGIN, "POST", "/v1/e500"), "no mark for a non-definitive answer");

  // --- 6. the live-proof window, and carry-forward
  const fresh = row("/v1/p", "POST", { declared: false, liveProvenAt: Date.now() - 60_000 });
  const stale = row("/v1/p", "POST", { declared: false, liveProvenAt: Date.now() - LIVE_PROOF_MAX_AGE_MS - 60_000 });
  const never = row("/v1/p", "POST", { declared: false });
  const docd = row("/v1/p", "POST", { declared: true });
  const legacy = row("/v1/p", "POST");
  ok(!needsLiveProof(fresh) && needsLiveProof(stale) && needsLiveProof(never), "an undeclared row needs a proof when it has none or it is older than the window");
  ok(!needsLiveProof(docd) && !needsLiveProof(legacy), "a declared row, or one crawled before stamping, does not");
  // enrichLiveQuotes has no clause of its own for this: every row that needs a
  // proof must already be a probe candidate through the staleness tests.
  const old8 = Date.now() - LIVE_PROOF_MAX_AGE_MS - 60_000;
  const shapes = [
    row("/v1/s1", "POST", { declared: false }),
    row("/v1/s2", "POST", { declared: false, quoteSource: "live-402", quoteObservedAt: old8, networksVerifiedAt: old8 }),
    row("/v1/s3", "POST", { declared: false, networksVerifiedAt: old8 }),
    row("/v1/s4", "POST", { declared: false, price: null }),
    row("/v1/s5", "POST", { declared: false, networks: [] }),
  ];
  ok(shapes.every((t) => !needsLiveProof(t) || !(Number(t.price) > 0) || !(t.networks || []).length || quoteIsStale(t) || networksNeedLiveVerify(t)),
    "every row that needs a live proof is already a probe candidate");
  const prev = { tools: [{ route: "/v1/p", method: "POST", price: 0.01, networks: ["eip155:8453"], quoteSource: "live-402", quoteObservedAt: Date.now() - 60_000, liveProvenAt: Date.now() - 60_000 }] };
  const next = [row("/v1/p", "POST", { declared: false })];
  carryForwardLearnedQuotes(next, prev);
  ok(next[0].liveProvenAt > 0 && !needsLiveProof(next[0]), "carry-forward keeps the proof, so a proven route is not re-probed every crawl");

  // --- 7. marks lapse
  markRouteGone(ORIGIN, "POST", "/v1/lapsed", { at: Date.now() - GONE_ROUTE_TTL_MS - 1000, kind: "410" });
  const back = [row("/v1/lapsed", "POST", { declared: true })];
  ok(dropGoneRoutes(back, ORIGIN) === 0 && back.length === 1, "a mark older than the TTL no longer hides the route");
  markRouteGone(ORIGIN, "POST", "/v1/lapsed", { kind: "410" });
  ok(dropGoneRoutes(back, ORIGIN) === 1 && back.length === 0, "a fresh mark does");
  // The re-registration path clears the origin's marks before it re-reads.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  const reg = src.indexOf("clearGoneMarks(origin);");
  ok(reg > 0 && reg < src.indexOf("if (forcedCrawlDue(origin))", reg) && src.indexOf("if (forcedCrawlDue(origin))", reg) - reg < 400, "re-registration calls clearGoneMarks before its forced crawl");
} finally {
  globalThis.fetch = orig;
  console.log = origLog;
  _resetGoneRoutes();
}
console.log(`test-gone-routes: ${n} passed`);
