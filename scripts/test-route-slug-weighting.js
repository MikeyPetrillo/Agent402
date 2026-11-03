#!/usr/bin/env node
// What a seller can buy by renaming, pinned as numbers.
//
// The router weights a query term at up to 10 in the slug (or a curated
// alias), 2 in the name, and 1 anywhere in the description, tags or category.
// Twice now we have told a seller those weights in an email, and both times
// they rewrote the operationId rather than the product. It worked, honestly,
// because the keywords were true of their endpoint - but the weighting is an
// incentive we publish, and nothing measured what it is worth.
//
// Measured 2026-09-19, before writing any of this down:
//
//   * PLACEMENT PREMIUM ~2.4x. The same words, same query, score 13 when they
//     sit in the description and 31 when they are moved into the slug. That is
//     the whole lever, and it is real. (A hand simulation of the per-term
//     arithmetic alone said 9 and 27; the live scorer is the oracle here,
//     because it also applies the name-as-implicit-alias rule, and the numbers
//     asserted below are its numbers, not the simulation's.)
//   * IT IS BOUNDED BY QUERY LENGTH. The gain is at most 4 per query TERM, so
//     a 40-keyword slug scores 8 to 12 on ordinary two and three word queries
//     against live winning scores of 14 to 28. A broad stuffer lands mid-pack;
//     it cannot buy the catalog. Stuffing only pays on long natural-language
//     queries, where the stuffer still has to match the words a user typed,
//     which means being on topic.
//   * A LENGTH PENALTY WOULD HIT THE WRONG PEOPLE. Sampled 429 external slugs:
//     94% are five tokens or fewer, and the long tail is almost entirely
//     FastAPI auto-generated ids (kr_news_kpop_api_v1_kr_news_kpop_get,
//     model_route_model_route_get) where the framework repeats the path into
//     the operationId. Those are accidents, not gaming, and a rule keyed on
//     length would demote them for using a default.
//
// So this file changes no behaviour. It exists so that the three facts above
// stay true: if a future weighting tweak makes stuffing pay materially more,
// or starts penalizing a framework-shaped slug, CI says so instead of a seller
// discovering it. Both directions are asserted, because a guard that only
// checks "stuffing does not win" would be satisfied by a ranker that had
// stopped working at all.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
const { routeQuery, _cacheForTests } = await import("../src/x402-index.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const cache = _cacheForTests();
const CTX = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "w" };
const entry = (origin, tools) => ({
  manifest: { name: origin, homepage: origin },
  tools: tools.map((t) => ({
    seller: origin, method: "POST", route: `/api/${t.slug}`, category: "data", tags: [],
    price: 0.01, networks: ["eip155:8453"], description: "", ...t,
  })),
  fetchedAt: Date.now(), error: null, history: [1, 1, 1],
});
const scoreOf = (q, slug) => {
  const r = routeQuery({ query: q, top: 20, include: "external", ...CTX }).results.find((x) => x.slug === slug);
  return r ? r.score : 0;
};
const rankOf = (q, slug) => {
  const rows = routeQuery({ query: q, top: 20, include: "external", ...CTX }).results;
  const i = rows.findIndex((x) => x.slug === slug);
  return i < 0 ? null : i + 1;
};

// The words are identical in both rows and in the query. Only PLACEMENT moves.
const WORDS = "Compare and rank candidates, alternatives, available tools, options, or possible next actions against the current task";
const QUERY = "rank these available tools against the current task";

cache.clear();
cache.set("https://placement.example", entry("https://placement.example", [
  { slug: "arbiter-compare", name: "Measure and rank a fixed candidate field", description: WORDS },
  { slug: "arbiter-rank-available-tools-choose-next-permitted-action-compare-candidates-options",
    name: "Rank and compare available tools, candidates, and options; choose the next permitted action", description: WORDS },
]));

const inText = scoreOf(QUERY, "arbiter-compare");
const inSlug = scoreOf(QUERY, "arbiter-rank-available-tools-choose-next-permitted-action-compare-candidates-options");
ok(inText > 0 && inSlug > 0, `both placements score at all (text ${inText}, slug ${inSlug}) - a zero here means the scorer stopped working, not that stuffing failed`);
ok(inSlug > inText, `the slug outranks the description for the same words (${inSlug} vs ${inText})`);
// ABSOLUTE, not a ratio. A ratio is the wrong invariant here and the first
// draft of this file proved it: raising the slug weight from 4 to 9 lifts BOTH
// rows, so the premium stayed inside a 2x-4x band and the mutation survived -
// the guard passed the one change it exists to catch. Pin the numbers.
ok(inText >= 11 && inText <= 15, `the description placement scores what it measured (${inText}, expected 13 +/- 2)`);
ok(inSlug >= 28 && inSlug <= 34, `the slug placement scores what it measured (${inSlug}, expected 31 +/- 3)`);

// And pin the WEIGHTS themselves, which is what the emails quoted and what a
// future tweak would move. Each row below carries the term in exactly ONE
// field, so a single-term query isolates that field's contribution.
cache.clear();
cache.set("https://weights.example", entry("https://weights.example", [
  { slug: "zzq-pelican-tool", name: "Nothing here", description: "Nothing here either." },
  { slug: "aaa", name: "A pelican counter", description: "Nothing here either." },
  { slug: "bbb", name: "Nothing here", description: "Counts every pelican." },
  { slug: "pelican", name: "Nothing here", description: "Nothing here either." },
]));
ok(scoreOf("pelican", "zzq-pelican-tool") === 4, `a term inside a longer slug is worth 4 (got ${scoreOf("pelican", "zzq-pelican-tool")})`);
// 7, not the 2 the weighting table suggests, and the number is right: a row's
// NAME is also turned into an implicit slug-form alias ("A pelican counter" ->
// a-pelican-counter, worth 4 as a substring) and `hay` is built FROM the name
// plus description, category and tags, so it scores there too. 4 + 2 + 1. The
// first draft of this line asserted 2 and was wrong about our own scorer.
ok(scoreOf("pelican", "aaa") === 7, `a term in the name is worth 4 + 2 + 1 (got ${scoreOf("pelican", "aaa")})`);
ok(scoreOf("pelican", "bbb") === 1, `a term in the description is worth 1 (got ${scoreOf("pelican", "bbb")})`);
ok(scoreOf("pelican", "pelican") === 10, `a slug that IS the term is worth 10 (got ${scoreOf("pelican", "pelican")})`);

// Restore the placement fixture for nothing further; the stuffer cases below
// set their own cache.

// A broad stuffer must not win ordinary short queries. This is the property
// that makes the premium above tolerable, so it is pinned beside it.
const STUFF = ["price","token","search","wallet","news","image","weather","data","swap","chain","market","text","score","rank","compare","balance","nft","quote","analyze","summary","translate","convert","audio","video","pdf","email","dns","whois","geo","stock","bond","fx","yield","gas","block","tx","nonce","holder","supply","pool"].join("-");
cache.clear();
cache.set("https://stuffer.example", entry("https://stuffer.example", [{ slug: STUFF, name: "Generic", description: "" }]));
cache.set("https://honest.example", entry("https://honest.example", [
  { slug: "token-price", name: "Token price", description: "The current price of a token in USD, from the deepest market." },
  { slug: "whois-lookup", name: "Whois lookup", description: "Registrar, nameservers and dates for a domain from whois." },
]));
for (const [q, honest] of [["token price", "token-price"], ["whois lookup", "whois-lookup"]]) {
  const s = scoreOf(q, STUFF), h = scoreOf(q, honest);
  ok(h > s, `"${q}": the honest two-token slug beats the 40-keyword slug (${h} vs ${s})`);
}

// A framework-generated slug is an accident, not an abuse. FastAPI repeats the
// path into the operationId, so these are long through no choice of the
// seller's. They must keep ranking for their own subject.
cache.clear();
cache.set("https://fastapi.example", entry("https://fastapi.example", [
  { slug: "kr_news_kpop_api_v1_kr_news_kpop_get", name: "Korean kpop news", description: "Recent Korean pop news headlines." },
  { slug: "model_route_model_route_get", name: "Model route", description: "Route a prompt to a model." },
]));
ok(rankOf("kpop news", "kr_news_kpop_api_v1_kr_news_kpop_get") === 1, "a FastAPI-shaped slug still ranks 1st for its own subject");
ok(scoreOf("model route", "model_route_model_route_get") > 0, "a path-repeating operationId is not zeroed");

// The slug is capped at 10 per term: a query that IS the slug cannot run away.
cache.clear();
cache.set("https://cap.example", entry("https://cap.example", [{ slug: "hash", name: "Hash", description: "sha256 of a string." }]));
const exact = scoreOf("hash", "hash");
ok(exact > 0 && exact <= 13, `an exact one-term slug match stays within the documented 10 + 2 + 1 (got ${exact})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
