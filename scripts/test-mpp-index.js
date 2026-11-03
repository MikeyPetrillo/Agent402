// Offline unit tests for the MPP index: origin validation (reused from the
// x402 side - protocol-agnostic) + the registerMppOrigin flow with an
// injected fake verifier + the snapshot honesty invariant. No network, no /data.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import {
  validateOriginInput, registerMppOrigin, mppIndexSnapshot, parseMppScanOrigins, parseMppScanList, probeTargetFromDiscovery, seedFromOrigins, discoverFromX402Crawl,
  __testResetSubmitted, __testSetSubmittedCap, __testReset,
} from "../src/mpp-index.js";
import { isMppChallenge } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// --- validation (same rules as the x402 side - shared, not duplicated) ---
ok(validateOriginInput("https://example.com").origin === "https://example.com", "plain https origin accepted");
ok(validateOriginInput("http://example.com").error != null, "http rejected");
ok(validateOriginInput("https://example.com/api").error != null, "path rejected (the mpp.orthogonal.com gateway-tenant gap)");
ok(validateOriginInput("not a url").error != null, "garbage rejected");

// --- isMppChallenge (reused, not reimplemented - pin the contract this module depends on) ---
ok(isMppChallenge("Payment realm=\"api.example.com\"") === true, "isMppChallenge: leading Payment token accepted");
ok(isMppChallenge("Bearer token") === false, "isMppChallenge: non-Payment scheme rejected");
ok(isMppChallenge(null) === false, "isMppChallenge: null header rejected");
ok(isMppChallenge("") === false, "isMppChallenge: empty header rejected");

// --- registerMppOrigin with an injected verifier ---
__testReset();
let verified = [];
const goodVerify = async (o) => {
  verified.push(o);
  return { origin: o, name: "Ext", description: "test", categories: ["data"], verified: true, verifiedAt: Date.now(), lastProbeError: null };
};
const badVerify = async (o) => {
  verified.push(o);
  return { origin: o, verified: false, lastProbeError: "no WWW-Authenticate: Payment challenge on the probed endpoint" };
};

let r = await registerMppOrigin("https://newseller.example", { verify: goodVerify });
ok(r.listed === true && r.origin === "https://newseller.example", "successful probe lists the origin");
ok(r.seller && r.seller.verified === true, "response carries a verified seller summary");
ok(verified.length === 1, "verifier invoked once for unknown origin");

r = await registerMppOrigin("https://deadseller.example", { verify: badVerify });
ok(r.listed === false && typeof r.error === "string", "failed probe returns an honest error, not listed");
ok(/WWW-Authenticate/.test(r.error), "error names the actual missing signal, not a generic failure");

// --- submission cap (same shape as the x402 side) ---
__testResetSubmitted();
__testSetSubmittedCap(1);
const capVerify = async (o) => { verified.push(o); return { origin: o, name: "Cap", verified: true, verifiedAt: Date.now() }; };

r = await registerMppOrigin("https://cap-first.example", { verify: capVerify });
ok(r.listed === true, "cap: first submission fills the cap and still lists");

const verifiedBefore = verified.length;
r = await registerMppOrigin("https://cap-second.example", { verify: capVerify });
ok(r.listed === false, "cap: new origin at cap is not listed");
ok(typeof r.error === "string" && /full/i.test(r.error), "cap: error is an honest capacity message");
ok(verified.length === verifiedBefore, "cap: rejected origin is never verified");

__testSetSubmittedCap();
__testResetSubmitted();

// --- snapshot honesty: unverified origins never count toward the shown total ---
__testReset();
await registerMppOrigin("https://real-one.example", { verify: goodVerify });
await registerMppOrigin("https://fake-one.example", { verify: badVerify });
const snap = mppIndexSnapshot();
ok(snap.verifiedSellers === 1, "snapshot counts only the verified seller, never the failed probe");
ok(snap.sellers.length === 1 && snap.sellers[0].origin === "https://real-one.example", "snapshot's seller list excludes the unverified origin entirely");

__testReset();

// --- second seed source: MPPScan's server-rendered origin list (2026-08-19) ---
{
  const page = `<script>self.__next_f.push([1,"[[\\"servers\\",\\"list\\"],{\\"input\\":{\\"originUrls\\":[\\"https://alpha.example\\",\\"https://beta.example/\\",\\"http://insecure.example\\",\\"https://alpha.example\\",\\"https://gamma.example/v1/tenant\\"]}}]"])</script>`;
  const got = parseMppScanOrigins(page);
  ok(got.length === 2 && got.includes("https://alpha.example") && got.includes("https://beta.example"), `parseMppScanOrigins: escaped SSR payload -> validated https origins, deduped, http and path-scoped dropped (got ${JSON.stringify(got)})`);
  ok(parseMppScanOrigins("<html>no data</html>").length === 0 && parseMppScanOrigins("").length === 0, "parseMppScanOrigins: no list -> []");
  // ReDoS guard: an unterminated list followed by a long whitespace run must
  // parse in linear time (the page is third-party input). ~1s before the
  // one-parse-per-item quantifier, 0ms after.
  const t0 = Date.now();
  parseMppScanOrigins('"originUrls": ["https://a.example"' + " ".repeat(50_000) + "x");
  ok(Date.now() - t0 < 200, `parseMppScanOrigins: unterminated list + 50k spaces parses in linear time (${Date.now() - t0}ms)`);
}
// --- MPPScan tRPC servers.list (primary source): shape + validation ----------------
{
  const body = { result: { data: { json: { origins: [
    { id: "a", name: "Alpha", description: "d".repeat(700), url: "https://alpha.example", logoUrl: "https://alpha.example/logo.svg", resourceCount: 3 },
    { id: "b", name: "Bad", url: "http://insecure.example" },
    { id: "c", name: "Path", url: "https://gamma.example/tenant" },
    { id: "d", name: "NoLogoHttp", url: "https://delta.example", logoUrl: "http://delta.example/x.png" },
  ], total: 314 } } } };
  const r = parseMppScanList(JSON.stringify(body));
  ok(r.total === 314 && r.rows.length === 2 && r.rows[0].origin === "https://alpha.example" && r.rows[0].description.length === 600 && r.rows[0].logoUrl.startsWith("https://") && r.rows[1].logoUrl === null, `parseMppScanList: total + validated https origins, description capped, http logo dropped (got ${r.rows.length} rows)`);
  ok(parseMppScanList('{"result":{"data":{"json":{"origins":[]}}}}').rows.length === 0 && parseMppScanList('{}').rows.length === 0, "parseMppScanList: empty/junk -> no rows");
}

// --- MPP discovery document -> probe target -----------------------------------
{
  const doc = { openapi: "3.1.0", paths: {
    "/v1/{id}": { get: { "x-payment-info": { offers: [] } } },
    "/v1/search": { post: { "x-payment-info": { offers: [] } } },
    "/v1/models": { get: { summary: "free" } },
    "/v1/quote": { get: { "x-payment-info": { offers: [] } } },
  } };
  const t = probeTargetFromDiscovery(doc);
  ok(t && t.method === "GET" && t.path === "/v1/quote", `probeTargetFromDiscovery: prefers a plain GET path with x-payment-info (got ${JSON.stringify(t)})`);
  ok(probeTargetFromDiscovery({ paths: { "/v1/search": { post: { "x-payment-info": {} } } } })?.method === "POST", "probeTargetFromDiscovery: falls back to a priced POST");
  ok(probeTargetFromDiscovery({ paths: { "/v1/models": { get: {} } } }) === null && probeTargetFromDiscovery(null) === null && probeTargetFromDiscovery({ paths: "x" }) === null, "probeTargetFromDiscovery: nothing priced / junk -> null");
}
ok("discoveryMppScan" in mppIndexSnapshot(), "snapshot exposes the MPPScan discovery status alongside the registry's");
// --- automatic detection from our own x402 crawl (dual-stack sellers) ------------
{
  __testReset();
  const st = discoverFromX402Crawl(["https://dual.example", "http://insecure.example", "https://dual.example", "https://path.example/v1"]);
  ok(st.origins === 4 && st.added === 1 && mppIndexSnapshot().discoveredTotal === 1, `x402-crawl seed: validated https origins only, deduped (added=${st.added})`);
  ok(seedFromOrigins(["https://dual.example"]) === 0 && seedFromOrigins(["https://second.example"], "x402-crawl") === 1, "seedFromOrigins: idempotent, counts only new origins");
  ok("discoveryX402Crawl" in mppIndexSnapshot(), "snapshot exposes the x402-crawl seed status");
  __testReset();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
