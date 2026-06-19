// Brave-search-kit tests — same shape as test-macro-kit.js and test-edgar-kit.js:
// strict on input validation (offline, deterministic) and tolerant of upstream
// errors on live calls. Fails only if an assertion breaks or if every live call
// fails (which would mean our integration is broken, not Brave's).
//
// Notes:
// - The validation block always runs — no key, no network required.
// - Live calls are OPT-IN via BRAVE_LIVE_TEST=1. Every `[test]` CI run firing
//   four Brave calls (4 routes × ~200 [test] commits/month) burns the Brave
//   subscription with traffic the daily paid-canary already covers post-deploy.
//   Local devs and special verification runs can still set BRAVE_LIVE_TEST=1
//   alongside BRAVE_API_KEY to exercise the real integration.
import { SEARCH_TOOLS } from "../src/tools/search.js";

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
  ["search-news", {}, "search-news rejects missing q"],
  ["search-news", { q: "" }, "search-news rejects empty q"],
  ["search-images", {}, "search-images rejects missing q"],
  ["search-suggest", {}, "search-suggest rejects missing q"],
]) {
  try { await h(slug)(args); ok(false, label); }
  catch (e) { ok(e.statusCode === 400, label + ` (got ${e.statusCode})`); }
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

// Live calls are opt-in. Every [test] CI run otherwise burns 4 Brave calls;
// the daily paid-canary (scripts/paid-canary.js) already exercises the real
// integration post-deploy and is the system-of-record for "Brave still works".
if (process.env.BRAVE_LIVE_TEST === "1") {
  // "agent402" is a high-uniqueness brand string that should hit our own site as
  // one of the top results — a useful smoke that Brave's index is fresh and
  // our parsing pulls the documented fields.
  await live("search", { q: "agent402.tools", count: 3 },
    (r) => r.query === "agent402.tools" && Array.isArray(r.results) && r.results.length > 0 && typeof r.results[0].title === "string" && typeof r.results[0].url === "string",
    "search agent402.tools count=3");

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
// integration. Without the opt-in we trust the paid-canary's daily live check.
const liveOptIn = process.env.BRAVE_LIVE_TEST === "1";
const keyConfigured = !!process.env.BRAVE_API_KEY;
if (assertFail > 0 || (liveOptIn && keyConfigured && liveOk === 0)) { console.error("search-kit: FAILED"); process.exit(1); }
console.log("search-kit: OK");
