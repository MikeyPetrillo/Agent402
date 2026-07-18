// Untrusted-content provenance (audit R-14). External web content — a rendered
// or extracted page, live search results — must carry a machine-readable
// `untrustedContent: true` marker so a downstream tool-enabled agent treats it
// as data to analyze, not instructions to obey. Offline + deterministic:
// mechanism unit tests, the extract/render article path, and a mocked-Brave
// runtime proof that the search handler actually stamps the marker.
//
//   node scripts/test-provenance.js
process.env.BRAVE_API_KEY = process.env.BRAVE_API_KEY || "test-key-provenance";

import { markUntrusted } from "../src/tools/provenance.js";
import { htmlToArticle } from "../src/tools/extract.js";
import { SEARCH_TOOLS } from "../src/tools/search.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// 1. markUntrusted: additive + non-destructive.
{
  const r = markUntrusted({ a: 1, b: "x" });
  ok(r.untrustedContent === true, "adds untrustedContent: true");
  ok(r.a === 1 && r.b === "x", "preserves existing keys");
  const orig = { a: 1 };
  markUntrusted(orig);
  ok(!("untrustedContent" in orig), "does not mutate the input (returns a new object)");
  ok(markUntrusted(null) === null, "null passes through unchanged");
  ok(markUntrusted("str") === "str", "non-object passes through unchanged");
  ok(Array.isArray(markUntrusted([1, 2])), "array passes through unchanged (never a bare-array wrap)");
}

// 2. Extract + render share htmlToArticle, so marking it covers both.
{
  const html = "<html><body><article><h1>Title</h1><p>" + "word ".repeat(60) + "</p></article></body></html>";
  const art = htmlToArticle(html, "https://example.com/a");
  ok(art.untrustedContent === true, "extracted/rendered article is marked untrusted");
  ok(art.url === "https://example.com/a" && typeof art.markdown === "string", "article keeps url + markdown (backward-compatible)");
}

// 3. Every content-returning search tool exists and the primary one documents
//    the policy in its description + example.
{
  const CONTENT_SLUGS = ["search", "search-news", "search-images", "search-videos", "search-suggest", "answer", "multi-search"];
  for (const slug of CONTENT_SLUGS) ok(!!SEARCH_TOOLS.find((t) => t.slug === slug), `search tool "${slug}" present`);
  const search = SEARCH_TOOLS.find((t) => t.slug === "search");
  ok(/untrusted/i.test(search.description), "search description documents the untrusted-content policy");
  ok(search.discovery?.output?.example?.untrustedContent === true, "search output example carries untrustedContent");
}

// 4. Runtime proof: the search handler stamps the marker on a live-shaped
//    Brave response (mock fetch — no network, no key spend).
{
  const search = SEARCH_TOOLS.find((t) => t.slug === "search");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ web: { results: [{ title: "T", url: "https://e.com", description: "d", age: null }] } }),
  });
  try {
    const out = await search.handler({ q: "hello world", count: 5 });
    ok(out.untrustedContent === true, "search handler stamps untrustedContent on a real-shaped response");
    ok(Array.isArray(out.results) && out.results[0].url === "https://e.com", "search handler still returns the results array");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
