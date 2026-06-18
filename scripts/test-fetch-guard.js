// fetch-guard.js attribution tests — boot a tiny local upstream that returns
// configurable responses, then exercise safeFetch against it and assert the
// statusCode our error carries (the value the catch-all in server.js maps to
// the HTTP response). The contract being tested:
//
//   • upstream 4xx → our 422   (caller-attributable: bad URL)
//   • upstream 5xx → our 502   (upstream-attributable: try again later)
//   • timeout      → our 504
//   • response shape includes a `contentType` field for both binary and text
//
// No network egress — assertions run against a mocked global fetch so this
// passes in any sandbox (CI, local, restricted networks).
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (label) => console.log("  ✓", label);

// We can't safeFetch 127.0.0.1 (the SSRF guard correctly blocks it), so the
// offline assertions exercise the non-2xx branch by stubbing global fetch
// before importing safeFetch. This is the cleanest way to test the attribution
// logic in isolation without standing up a public test domain.
async function withMockedFetch(response, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

// Build a Response-shaped object the safeFetch path actually consumes.
function fakeResponse({ status = 200, contentType = "application/octet-stream", body = "" }) {
  const buf = Buffer.from(body);
  const stream = new ReadableStream({
    start(c) { c.enqueue(buf); c.close(); },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "https://example.test/",
    body: stream,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? contentType : null) },
  };
}

// Bypass assertPublicUrl by passing a non-private public hostname; the DNS
// lookup happens before we get to fetch(), so we need a real-resolving name.
// We won't actually hit it (fetch is mocked), but the resolution must succeed.
const PUBLIC = "https://example.com/anything";

const { safeFetch } = await import("../src/tools/fetch-guard.js");

console.log("\nfetch-guard attribution:");

// upstream 404 → 422
await withMockedFetch(fakeResponse({ status: 404, body: "not found" }), async () => {
  try {
    await safeFetch(PUBLIC);
    fail("expected throw on upstream 404");
  } catch (e) {
    if (e.statusCode !== 422) fail(`upstream 404 → expected our 422, got ${e.statusCode}; msg=${e.message}`);
    if (!/HTTP 404/.test(e.message)) fail(`upstream 404 message must name the upstream status; got: ${e.message}`);
    if (!/check the URL/i.test(e.message)) fail(`upstream 404 message must give the caller a next step; got: ${e.message}`);
  }
});
ok("upstream 404 → our 422 with actionable message");

// upstream 410 → 422 (other caller-attributable codes)
await withMockedFetch(fakeResponse({ status: 410 }), async () => {
  try { await safeFetch(PUBLIC); fail("expected throw on upstream 410"); }
  catch (e) { if (e.statusCode !== 422) fail(`upstream 410 → expected 422, got ${e.statusCode}`); }
});
ok("upstream 410 → our 422");

// upstream 403 → 422
await withMockedFetch(fakeResponse({ status: 403 }), async () => {
  try { await safeFetch(PUBLIC); fail("expected throw on upstream 403"); }
  catch (e) { if (e.statusCode !== 422) fail(`upstream 403 → expected 422, got ${e.statusCode}`); }
});
ok("upstream 403 → our 422");

// upstream 503 → 502 (upstream is broken, not the caller)
await withMockedFetch(fakeResponse({ status: 503 }), async () => {
  try {
    await safeFetch(PUBLIC);
    fail("expected throw on upstream 503");
  } catch (e) {
    if (e.statusCode !== 502) fail(`upstream 503 → expected our 502, got ${e.statusCode}; msg=${e.message}`);
    if (!/HTTP 503/.test(e.message)) fail(`upstream 503 message must name the upstream status; got: ${e.message}`);
    if (!/try again/i.test(e.message)) fail(`upstream 503 message must hint retry; got: ${e.message}`);
  }
});
ok("upstream 503 → our 502 with retry hint");

// upstream 500 → 502
await withMockedFetch(fakeResponse({ status: 500 }), async () => {
  try { await safeFetch(PUBLIC); fail("expected throw on upstream 500"); }
  catch (e) { if (e.statusCode !== 502) fail(`upstream 500 → expected 502, got ${e.statusCode}`); }
});
ok("upstream 500 → our 502");

// happy text: contentType surfaced
await withMockedFetch(fakeResponse({ status: 200, contentType: "text/html; charset=utf-8", body: "<html>" }), async () => {
  const r = await safeFetch(PUBLIC);
  if (r.html !== "<html>") fail(`text body wrong: ${r.html}`);
  if (!/text\/html/.test(r.contentType)) fail(`contentType missing from text response; got: ${r.contentType}`);
});
ok("text response surfaces contentType");

// happy binary: contentType surfaced
await withMockedFetch(fakeResponse({ status: 200, contentType: "audio/mpeg", body: "ID3\u0003\u0000" }), async () => {
  const r = await safeFetch(PUBLIC, { binary: true });
  if (!Buffer.isBuffer(r.buffer)) fail("binary mode must return Buffer");
  if (r.contentType !== "audio/mpeg") fail(`contentType missing from binary response; got: ${r.contentType}`);
});
ok("binary response surfaces contentType");

console.log("\nfetch-guard: all attribution assertions passed");

// ---------------------------------------------------------------------------
// media-kit Content-Type fail-fast: a caller paste-error (HTML URL when media
// expected) must be rejected before ffprobe runs, with a message that names
// the actual problem. This is the second user-facing improvement.
// ---------------------------------------------------------------------------
console.log("\nmedia-kit fail-fast on non-media Content-Type:");

const { MEDIA_TOOLS } = await import("../src/tools/media-kit.js");
const mediaInfo = MEDIA_TOOLS.find((t) => t.slug === "media-info");
if (!mediaInfo) fail("media-info tool not found in MEDIA_TOOLS");

await withMockedFetch(fakeResponse({ status: 200, contentType: "text/html; charset=utf-8", body: "<html>not a podcast</html>" }), async () => {
  try {
    await mediaInfo.handler({ url: PUBLIC });
    fail("expected media-info to reject text/html before ffprobe");
  } catch (e) {
    if (e.statusCode !== 422) fail(`html→media-info: expected 422, got ${e.statusCode}; msg=${e.message}`);
    if (!/text\/html/.test(e.message)) fail(`html→media-info message must name the offending content-type; got: ${e.message}`);
    if (!/webpage URL/i.test(e.message)) fail(`html→media-info message must explain the likely caller mistake; got: ${e.message}`);
  }
});
ok("media-info rejects text/html with paste-error hint (no ffprobe spawned)");

await withMockedFetch(fakeResponse({ status: 200, contentType: "application/json", body: '{"not":"media"}' }), async () => {
  try {
    await mediaInfo.handler({ url: PUBLIC });
    fail("expected media-info to reject application/json before ffprobe");
  } catch (e) {
    if (e.statusCode !== 422) fail(`json→media-info: expected 422, got ${e.statusCode}`);
  }
});
ok("media-info rejects application/json");

// Sanity: an octet-stream upstream (common for direct media hosts that don't
// set audio/* properly) must NOT be rejected by the pre-screen — we want
// ffprobe to make the final call.
await withMockedFetch(fakeResponse({ status: 200, contentType: "application/octet-stream", body: "\u0000\u0000\u0000" }), async () => {
  try {
    await mediaInfo.handler({ url: PUBLIC });
    // If ffprobe is not installed locally we'll throw 422 from run() — that's
    // a different code path. We only fail this assertion if the error message
    // matches the pre-screen (which would mean we wrongly rejected it here).
  } catch (e) {
    if (/webpage URL/i.test(e.message)) fail(`octet-stream must NOT trip the pre-screen; got: ${e.message}`);
  }
});
ok("media-info does NOT pre-reject application/octet-stream (lets ffprobe decide)");

console.log("\nmedia-kit fail-fast: all assertions passed");
console.log("\ntest-fetch-guard: ALL PASS");
process.exit(0);
