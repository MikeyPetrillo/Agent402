#!/usr/bin/env node
// Unicode-aware query tokenization (src/query-terms.js), shared by /api/route,
// /api/find and the /api/index search. Reported from outside 2026-09-10: every
// router split on [^a-z0-9]+, so a CJK query produced zero terms and zero rows
// while its English twin ranked three sellers. Offline, synthetic catalog.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
process.env.X402_INDEX_CRAWL = "off";
import { queryTerms, termMatcher, splitTokens, isCjkTerm } from "../src/query-terms.js";
const { routeQuery, _cacheForTests, allIndexedTools } = await import("../src/x402-index.js");
const { findTools } = await import("../src/find.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- tokenization ---------------------------------------------------------------
ok(eq(queryTerms("JSON to CSV"), ["json", "to", "csv"]), "Latin runs are lower-cased terms, unchanged from before");
ok(eq(queryTerms("中国供应商核验"), ["中国", "国供", "供应", "应商", "商核", "核验", "中国供应商核验"]), "a CJK run becomes character bigrams plus the whole run (the reporter's own query)");
ok(eq(queryTerms("東京"), ["東京", "東京"].slice(0, 1)) || eq(queryTerms("東京"), ["東京"]), "a two-character CJK run is one term, not a duplicated bigram");
ok(eq(queryTerms("核"), ["核"]), "a lone CJK character is a term on its own");
ok(eq(queryTerms("ip geolocation for 東京 Tokyo"), ["ip", "geolocation", "for", "東京", "tokyo"]), "mixed scripts tokenize side by side");
ok(eq(queryTerms("한국어 검색"), ["한국", "국어", "한국어", "검색"]), "Hangul is treated as CJK (bigrams + run)");
ok(eq(queryTerms("café résumé"), ["café", "résumé"]), "accented Latin letters are letters, not separators");
ok(eq(queryTerms("a—b–c"), ["a", "b", "c"]), "dashes of every width separate terms");
ok(queryTerms("x".repeat(5) + " " + "y".repeat(5), { max: 1 }).length === 1, "the term cap is honoured");
ok(eq(queryTerms("csv csv CSV"), ["csv"]), "terms are deduplicated");
ok(eq(splitTokens("Gzip, HTML-strip"), ["gzip", "html", "strip"]), "splitTokens is the lower-cased token list");
ok(isCjkTerm("中国") && !isCjkTerm("ip") && !isCjkTerm("中国x"), "isCjkTerm is true only for all-CJK terms");

// --- matching --------------------------------------------------------------------
ok(termMatcher("ip")("gzip") === false && termMatcher("ip")("ip info") === true, "a short Latin term still matches whole tokens only (the 2026-08-28 gzip rule)");
ok(termMatcher("geo")("geolocation") === true, "a three-letter Latin term matches by substring, as before");
ok(termMatcher("中国")("verify a 中国供应商 (china supplier)") === true && termMatcher("中国")("中华") === false, "a CJK bigram matches by substring; unrelated characters do not");

// --- /api/route: a seller whose listing carries Chinese text is found by a Chinese query ---
{
  const cache = _cacheForTests(); cache.clear();
  const t = (route, slug, name, description) => ({ seller: "https://cn.example", method: "POST", route, slug, name, description, category: "data", tags: [], price: 0.01, networks: ["eip155:8453"] });
  cache.set("https://cn.example", { manifest: { name: "cn", homepage: "https://cn.example" }, openapiSummary: null, tools: [
    t("/api/supplier", "china-supplier-evidence", "China supplier evidence", "中国供应商核验: verify a Chinese supplier's registration and evidence."),
    t("/api/weather", "weather", "Weather", "Current weather by city."),
  ], fetchedAt: Date.now(), error: null, history: [1, 1, 1] });
  const ctx = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "w" };
  const zh = routeQuery({ query: "中国供应商核验", top: 5, include: "all", ...ctx });
  ok(zh.count === 1 && zh.results[0]?.slug === "china-supplier-evidence", `a Chinese query finds the seller whose listing carries that text (got ${zh.count}: ${zh.results.map((r) => r.slug).join(",")})`);
  ok(zh.results[0]?.score >= 6 && zh.results[0]?.why?.matchedOn?.text >= 6, "every bigram of the query matched the description text (score comes from text, honestly)");
  const partial = routeQuery({ query: "供应商", top: 5, include: "all", ...ctx });
  ok(partial.count === 1 && partial.results[0]?.slug === "china-supplier-evidence", "a shorter Chinese query (a substring of the listing) still matches");
  const miss = routeQuery({ query: "天气预报", top: 5, include: "all", ...ctx });
  ok(miss.count === 0, "a Chinese query with no lexical hit returns zero rows - the router is lexical, it does not translate");
  const en = routeQuery({ query: "china supplier", top: 5, include: "all", ...ctx });
  ok(en.results[0]?.slug === "china-supplier-evidence", "the English query is unchanged");
  // /api/index search
  const idx = allIndexedTools({ search: "供应商", excludeOrigin: "https://agent402.tools" });
  const idxRows = Array.isArray(idx) ? idx : (idx.tools || idx.results || idx.items || []);
  ok(idxRows.some((r) => r.slug === "china-supplier-evidence"), "the /api/index search accepts a CJK term too");
  cache.clear();
}

// --- /api/find: a catalog tool tagged in Chinese ------------------------------------
{
  const catalog = {
    "POST /api/translate": { slug: "translate", name: "Translate", description: "Translate text between languages. 翻译文本。", price: "$0.002", category: "text", tags: ["translation"], discovery: { input: {} } },
    "POST /api/hash": { slug: "hash", name: "Hash", description: "SHA-256 of text.", price: "$0.001", category: "encoding", tags: [], discovery: { input: {} } },
  };
  const r = findTools(catalog, "翻译文本", { k: 3, baseUrl: "https://agent402.tools" });
  ok(r.results?.[0]?.slug === "translate", `/api/find ranks a tool whose description carries the query's characters (got ${r.results?.map((x) => x.slug).join(",")})`);
  ok((findTools(catalog, "sha 256 hash", { k: 3, baseUrl: "https://agent402.tools" }).results?.[0]?.slug) === "hash", "an ordinary Latin query is unchanged");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
