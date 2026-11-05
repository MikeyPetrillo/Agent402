// The crawler revalidates instead of re-downloading.
//
// WHY. We visit every seed origin every CRAWL_INTERVAL_MS - 288 times a day per
// origin - and re-downloaded the whole document each time: a manifest capped at
// 4MB, an openapi at 12MB, for content our own comments call slow-changing.
// Across the index that is on the order of 650,000 unconditional fetches a day
// aimed at other people's servers. A seller noticed and told us.
//
// The origin's half of the contract (answering 304, omitting the body) is not
// ours to prove, so this asserts OUR half against real Response objects: that
// we send the validators we hold, that a 304 is read as success rather than as
// an upstream error, and that nothing changes for callers who did not opt in.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { safeFetch } from "../src/tools/fetch-guard.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const DOC = JSON.stringify({ x402Version: 1, resources: [] });
const ETAG = '"v1-abc"';
const LASTMOD = "Wed, 21 Oct 2026 07:28:00 GMT";
const orig = globalThis.fetch;
let sent = null;

// A public host that is never actually contacted: fetch is stubbed below, and
// assertPublicUrl only needs the name to resolve to something non-private.
const URL_ = "https://example.com/.well-known/x402";

const stub = (respond) => async (url, init) => { sent = init?.headers || {}; return respond(); };
const res200 = () => new Response(DOC, { status: 200, headers: { "content-type": "application/json", ETag: ETAG, "Last-Modified": LASTMOD } });
const res304 = () => new Response(null, { status: 304, headers: { ETag: ETAG } });
const resNoValidators = () => new Response(DOC, { status: 200, headers: { "content-type": "application/json" } });

try {
  // --- 1. a first fetch surfaces the validators to store -------------------
  globalThis.fetch = stub(res200);
  const first = await safeFetch(URL_, { allowNotModified: true });
  ok(first.html === DOC, "a normal fetch still returns the document");
  ok(first.validators?.etag === ETAG && first.validators?.lastModified === LASTMOD,
    "ETag and Last-Modified are surfaced so a caller can revalidate next time");
  ok(!sent["If-None-Match"], "with nothing stored we send no conditional header");

  // --- 2. holding validators, we actually send them ------------------------
  globalThis.fetch = stub(res304);
  const second = await safeFetch(URL_, { validators: first.validators, allowNotModified: true });
  ok(sent["If-None-Match"] === ETAG, "we send If-None-Match with the stored ETag");
  ok(sent["If-Modified-Since"] === LASTMOD, "and If-Modified-Since with the stored date");
  ok(second.notModified === true, "a 304 is read as notModified");
  ok(second.html === undefined, "and carries no body to parse");

  // --- 3. A 304 IS NOT AN ERROR. `response.ok` is false for 304, so without
  // explicit handling a perfectly good conditional request surfaces as a 422
  // "check the URL is correct and publicly reachable" - a healthy seller
  // reported as broken, and a crawl that never stops re-downloading.
  globalThis.fetch = stub(res304);
  let threw = null;
  try { await safeFetch(URL_, { validators: first.validators }); } catch (e) { threw = e; }
  // 502, not 422: 304 is below 400 so it falls through to the upstream-5xx
  // branch. That classification is defensible - a caller who sent no validators
  // and got a 304 is talking to a misbehaving origin - and the point of the
  // assertion is only that the behaviour is OPT-IN, so no existing caller of
  // safeFetch changes because of this feature.
  ok(threw && threw.statusCode === 502,
    "without allowNotModified a 304 still raises: the behaviour is opt-in, so no existing caller changes");

  // --- 4. caller headers win over stored validators ------------------------
  globalThis.fetch = stub(res200);
  await safeFetch(URL_, { validators: { etag: ETAG }, allowNotModified: true, headers: { "If-None-Match": '"caller"' } });
  ok(sent["If-None-Match"] === '"caller"', "an explicit caller header is never overwritten by a stored validator");

  // --- 5. an origin that sends no validators ------------------------------
  globalThis.fetch = stub(resNoValidators);
  const bare = await safeFetch(URL_, { allowNotModified: true });
  ok(bare.html === DOC && bare.validators === null,
    "an origin sending neither header returns null validators, so we simply never revalidate it");

  // --- 6. a 304 on a request we never sent validators for is still handled --
  globalThis.fetch = stub(res304);
  const odd = await safeFetch(URL_, { allowNotModified: true });
  ok(odd.notModified === true, "an unsolicited 304 does not throw either");
} finally {
  globalThis.fetch = orig;
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
