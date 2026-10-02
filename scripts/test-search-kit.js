// Brave-search-kit tests — same shape as test-macro-kit.js and test-edgar-kit.js:
// strict on input validation (offline, deterministic) and tolerant of upstream
// errors on live calls. Fails only if an assertion breaks or if every live call
// fails (which would mean our integration is broken, not Brave's).
//
// Notes:
// - The validation block always runs — no key, no network required.
// - Live calls are OPT-IN via BRAVE_LIVE_TEST=1. A `[test]` CI run firing one
//   live call per route in the block would burn the search subscription on
//   every commit, for coverage the daily paid-canary already has post-deploy.
//   Local devs and special verification runs can still set BRAVE_LIVE_TEST=1
//   alongside BRAVE_API_KEY to exercise the real integration.
import { SEARCH_TOOLS, cleanSnippet } from "../src/tools/search.js";

const h = (slug) => SEARCH_TOOLS.find((t) => t.slug === slug).handler;
let assertFail = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) console.log(`ok - ${m}`); else { assertFail++; console.error(`ASSERT FAIL - ${m}`); } };

// --- deterministic validation (no network, no key required) ---
// Each row asserts the handler throws a 400 Error on bad input. The 503
// "not configured" path only triggers AFTER input validation passes, so even
// without BRAVE_API_KEY these are exercised cleanly.
for (const [slug, args, label] of [
  ["search", {}, "search rejects missing q"],
  ["search", { q: "   " }, "search rejects empty q (whitespace)"],
  ["search-lite", {}, "search-lite rejects missing q"],
  ["search-lite", { q: "x402", count: 6 }, "search-lite rejects a count above 5"],
  ["search-news", {}, "search-news rejects missing q"],
  ["search-news", { q: "" }, "search-news rejects empty q"],
  ["search-images", {}, "search-images rejects missing q"],
  ["search-videos", {}, "search-videos rejects missing q"],
  ["search-videos", { q: "  " }, "search-videos rejects empty q (whitespace)"],
  ["search-suggest", {}, "search-suggest rejects missing q"],
]) {
  try { await h(slug)(args); ok(false, label); }
  catch (e) { ok(e.statusCode === 400, label + ` (got ${e.statusCode})`); }
}

// --- snippets reach the buyer as plain text with an ISO publishedAt (stubbed
// upstream: no key spent, no network) ---
{
  const realFetch = globalThis.fetch, realKey = process.env.BRAVE_API_KEY;
  process.env.BRAVE_API_KEY = "stub-not-a-real-key";
  const row = { title: "Stablecoins &amp; the <strong>GENIUS</strong> Act", url: "https://example.org/a", description: "Issuers <strong>must</strong> back &quot;one-to-one&quot; it&#39;s", age: "2 days ago", page_age: "2026-09-22T16:45:39" };
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes("/news/") ? { results: [{ ...row, meta_url: { hostname: "example.org" } }] } : { web: { results: [row, { title: "no age", url: "https://example.org/b" }] } }),
    { status: 200, headers: { "content-type": "application/json" } });
  try {
    const w = await h("search")({ q: "stablecoin regulation", count: 2 });
    ok(w.results[0].title === "Stablecoins & the GENIUS Act" && w.results[0].description === "Issuers must back \"one-to-one\" it's",
      "search strips the index's <strong> highlight and decodes entities in title and snippet");
    ok(w.results[0].publishedAt === "2026-09-22T16:45:39.000Z" && w.results[0].age === "2 days ago", "search carries publishedAt (ISO, UTC) beside the prose age");
    ok(w.results[1].publishedAt === null && w.results[1].description === null, "a row with no page_age or snippet reads null, never a guess");
    const n = await h("search-news")({ q: "stablecoin regulation" });
    ok(n.results[0].description.indexOf("<") === -1 && n.results[0].publishedAt === "2026-09-22T16:45:39.000Z" && n.results[0].source === "example.org",
      "search-news gets the same plain-text snippet and publishedAt");
    const l = await h("search-lite")({ q: "stablecoin regulation", count: 1 });
    ok(l.results[0].title === "Stablecoins & the GENIUS Act" && !("publishedAt" in l.results[0]), "search-lite snippets are cleaned too and keep their three documented fields");
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.BRAVE_API_KEY; else process.env.BRAVE_API_KEY = realKey;
  }
}

// --- live calls (tolerant of missing key / upstream rate-limiting) ---
async function live(slug, args, check, label) {
  try {
    const r = await h(slug)(args);
    if (check(r)) { liveOk++; console.log(`ok - ${label}: ${JSON.stringify(r).slice(0, 140)}`); }
    else { assertFail++; console.error(`ASSERT FAIL - ${label}: unexpected shape ${JSON.stringify(r).slice(0, 240)}`); }
  } catch (e) {
    liveErr++;
    console.warn(`warn - ${label}: upstream error (${e.statusCode || "?"}) ${e.message} — tolerated`);
  }
}

// Live calls are opt-in: without the flag this block spends nothing, which is
// why a route may be added here freely. The daily paid-canary
// (scripts/paid-canary.js) already exercises the real integration post-deploy
// and is the system-of-record for "the search upstream still works".
if (process.env.BRAVE_LIVE_TEST === "1") {
  // "agent402" is a high-uniqueness brand string that should hit our own site as
  // one of the top results — a useful smoke that Brave's index is fresh and
  // our parsing pulls the documented fields.
  await live("search", { q: "agent402.tools", count: 3 },
    (r) => r.query === "agent402.tools" && Array.isArray(r.results) && r.results.length > 0 && typeof r.results[0].title === "string" && typeof r.results[0].url === "string",
    "search agent402.tools count=3");

  // search-lite reads the same /web/search body as `search` and keeps three
  // fields of it. Only a live call proves that parse against the real body:
  // everything else covering this tool is stubbed. It must honour an explicit
  // count and carry no `age`, which is the difference a buyer pays less for.
  await live("search-lite", { q: "x402 payment protocol", count: 2 },
    (r) => r.query === "x402 payment protocol" && Array.isArray(r.results) && r.results.length > 0 && r.results.length <= 2
      && r.count === r.results.length && r.untrustedContent === true
      && r.results.every((x) => typeof x.url === "string" && !("age" in x)),
    "search-lite x402 payment protocol count=2");

  // Freshness filter exercises the optional knob. "Federal Reserve" is a
  // near-guaranteed news producer; pw (past week) should always return hits.
  await live("search-news", { q: "Federal Reserve", count: 5, freshness: "pw" },
    (r) => r.query === "Federal Reserve" && Array.isArray(r.results) && r.results.length > 0 && r.results.every((x) => typeof x.url === "string"),
    "search-news Federal Reserve freshness=pw");

  // Image search with strict safesearch (default). A landmark query is a stable
  // smoke — every result should include both a thumbnail and a source page URL.
  await live("search-images", { q: "golden gate bridge", count: 3 },
    (r) => r.query === "golden gate bridge" && Array.isArray(r.results) && r.results.length > 0 && r.results.every((x) => typeof x.thumbnail === "string" && typeof x.source === "string"),
    "search-images golden gate bridge count=3");

  // Video search — verified live against the current subscription 2026-07-13
  // (videos/search returned real results). Every result should carry a video
  // page URL; duration/creator ride best-effort from the video sub-object.
  await live("search-videos", { q: "agent payments", count: 3 },
    (r) => r.query === "agent payments" && Array.isArray(r.results) && r.results.length > 0 && r.results.every((x) => typeof x.url === "string"),
    "search-videos agent payments count=3");

  // Suggest should expand a brand prefix into completions. We don't assert any
  // specific suggestion (Brave can re-rank), just that we get a non-empty array
  // of strings.
  await live("search-suggest", { q: "agent4", count: 5 },
    (r) => r.query === "agent4" && Array.isArray(r.suggestions) && r.suggestions.length > 0 && r.suggestions.every((s) => typeof s === "string"),
    "search-suggest agent4 count=5");
} else {
  console.log("(skipping live Brave calls — set BRAVE_LIVE_TEST=1 to enable; paid-canary covers post-deploy verification)");
}

console.log(`\nvalidation asserts failed: ${assertFail} | live ok: ${liveOk} | live upstream-errors (tolerated): ${liveErr}`);
// Soft-fail mode: validation asserts are the always-on gate. Live calls only
// fail the suite when BRAVE_LIVE_TEST=1 was explicitly requested AND the key is
// set AND every live call failed — that combination genuinely means a broken
// Snippets are decoded before tags are stripped, so an escaped tag never comes back out as markup.
for (const [input, want] of [["a <strong>b</strong> &amp; c", "a b & c"], ["&lt;iframe src=x&gt;&lt;/iframe&gt;hi", "hi"], ["2 < 3 and 5 > 4", "2 < 3 and 5 > 4"], ["<<b>script>x", "x"]]) {
  const got = cleanSnippet(input);
  if (got !== want) { assertFail++; console.error(`FAIL cleanSnippet(${JSON.stringify(input)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
// integration. Without the opt-in we trust the paid-canary's daily live check.
const liveOptIn = process.env.BRAVE_LIVE_TEST === "1";
const keyConfigured = !!process.env.BRAVE_API_KEY;
if (assertFail > 0 || (liveOptIn && keyConfigured && liveOk === 0)) { console.error("search-kit: FAILED"); process.exit(1); }
console.log("search-kit: OK");
