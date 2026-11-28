#!/usr/bin/env node
// Phrase aliases (src/phrase-aliases.js) and arithmetic written in words
// (src/query-terms.js arithmeticAsk), read by /api/find and /api/route.
//
// A curated alias scores word by word on /api/route, so an alias written for
// "current bitcoin price" also lifted its tool for "current gold price", and
// one written for a coin's volatility took "jpy volatility". A phrase alias
// earns its credit only when the query writes the whole phrase: its words
// next to each other, in any order, function words set aside.
//   - the rule, word by word;
//   - the table: every slug is a catalog tool, every phrase two words or more
//     and not already one of the tool's aliases;
//   - /api/route and /api/find over the kits: the phrases pick their tool, a
//     query holding one word of a phrase scores that tool exactly as a slug
//     substring does, and an outside seller's row of the same slug takes no
//     phrase credit;
//   - "5 plus 7" is the calculator's on both; "plus" outside an expression
//     stays the word of the tool named for it.
// Offline: routeQuery and findTools over kits and a seeded seller cache.
//
//   node scripts/test-phrase-aliases.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
const { routeQuery, _cacheForTests } = await import("../src/x402-index.js");
const { findTools } = await import("../src/find.js");
const { PHRASE_ALIASES, PHRASE_SKIP, phraseAliasHits } = await import("../src/phrase-aliases.js");
const { arithmeticAsk } = await import("../src/query-terms.js");
const { KIT: KIT1 } = await import("../src/tools/kit.js");
const { KIT2 } = await import("../src/tools/kit2.js");
const { CRYPTO_TOOLS } = await import("../src/tools/crypto-kit.js");
const { CRYPTO_MARKETS_TOOLS } = await import("../src/tools/crypto-markets-kit.js");
const { ALCHEMY_DATA_TOOLS } = await import("../src/tools/alchemy-data-kit.js");
const { CHAIN_TOOLS } = await import("../src/tools/chain-kit.js");
const { HOLIDAY_TOOLS } = await import("../src/tools/holidays-kit.js");
const finMath = await import("../src/tools/finance-math-kit.js");
const weatherCalc = await import("../src/tools/weather-calc-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const kitOf = (mod) => Object.values(mod).filter((v) => Array.isArray(v) && v.length && v.every((t) => t && typeof t.slug === "string" && typeof t.route === "string")).flat();

// A tool named for a tier, as the live catalog holds one: the word "plus" is its own.
const TIER = { route: "POST /api/route-execute-plus", slug: "route-execute-plus", name: "Route and execute (plus)", category: "x402", price: "$0.05", description: "Resolve a task to a tool and run it, plus tier.", tags: ["sor", "router"], discovery: { input: { task: "x" } }, handler: async () => ({}) };
const TOOLS = [...KIT1, ...KIT2, ...CRYPTO_TOOLS, ...CRYPTO_MARKETS_TOOLS, ...ALCHEMY_DATA_TOOLS, ...CHAIN_TOOLS, ...HOLIDAY_TOOLS, ...kitOf(finMath), ...kitOf(weatherCalc), TIER];
const catalog = {};
for (const t of TOOLS) catalog[t.route] = t;
const has = (slug) => TOOLS.some((t) => t.slug === slug);
const cache = _cacheForTests();
cache.clear();
const CTX = { baseUrl: "https://agent402.tools", catalog, prices: {}, network: "base", toolCount: Object.keys(catalog).length, walletName: "w" };
const route = (q, include = "local") => routeQuery({ query: q, top: 25, include, ...CTX }).results;
const slugPart = (r) => r?.why?.matchedOn?.slug ?? r?.matchedOn?.slug ?? null;
const find = (q) => findTools(catalog, q, { k: 5 });

// ---- the rule ----
const hit = (q, slug) => { const h = phraseAliasHits(q); return h ? [...(h.get(slug) || [])].sort().join(" ") : ""; };
for (const [q, slug, words] of [
  ["current bitcoin price", "crypto-price", "bitcoin current price"],
  ["Current BTC price?", "crypto-price", "btc current price"],
  ["what is the current price of bitcoin", "crypto-price", "bitcoin current price"],
  ["price of bitcoin, current", "crypto-price", "bitcoin current price"],
  ["current eth price in usd", "crypto-price", "current eth price"],
  ["bitcoin volatility", "crypto-history", "bitcoin volatility"],
  ["volatility of bitcoin", "crypto-history", "bitcoin volatility"],
  ["bitcoin volatility last 90 days", "crypto-history", "bitcoin volatility"],
  ["what was the ethereum volatility", "crypto-history", "ethereum volatility"],
  ["decode a base64 encoded string", "base64", "base64 decode encoded string"],
  ["decode the base64-encoded string scanned from a qr code", "base64", "base64 decode encoded string"],
  ["base64 encoded string to decode", "base64", "base64 decode encoded string"],
]) ok(hit(q, slug) === words, `"${q}" writes a phrase of ${slug} (${hit(q, slug) || "none"})`);
for (const q of ["current gold price", "current stock price", "current price", "bitcoin price", "current bitcoin", "jpy volatility", "implied volatility", "volatility", "bitcoin",
  // A qualifier between the words is another task.
  "bitcoin implied volatility", "current bitcoin etf price", "current gold price in bitcoin", "bitcoin options volatility", "current gas price on bitcoin",
  // The words in two different places are not a phrase.
  "bitcoin news and market volatility", "current weather and the price of gold in bitcoin",
  // A base64-encoded string another tool works on, or a decode of something else.
  "hash a base64 encoded string", "decode a base64 encoded jwt", "decode a base64 encoded gzip string", "base64 encoded string", "decode a base64 string",
  "", "   ", "the of a"]) ok(phraseAliasHits(q) === null, `"${q}" writes no phrase`);
ok(phraseAliasHits(null) === null && phraseAliasHits(undefined) === null && phraseAliasHits({ toString: 1 }) === null, "a value that is no query writes no phrase");
{
  const t0 = performance.now();
  for (const s of ["current ".repeat(600), "bitcoin price ".repeat(300), "volatility of ".repeat(300) + "bitcoin", "current bitcoin ".repeat(200) + "price"]) phraseAliasHits(s);
  ok(performance.now() - t0 < 50, "hostile repeats are read in bounded time");
}

// ---- the table ----
ok(Object.keys(PHRASE_ALIASES).length >= 2, `the table lists ${Object.keys(PHRASE_ALIASES).length} tools`);
ok(JSON.stringify(PHRASE_ALIASES) === JSON.stringify({ "crypto-price": ["current-bitcoin-price", "current-btc-price", "current-ethereum-price", "current-eth-price"], "crypto-history": ["bitcoin-volatility", "btc-volatility", "ethereum-volatility", "eth-volatility"], "base64": ["decode-base64-encoded-string"] }),
  "the table is the nine phrases these cases cover (a new phrase adds its own case and its neighbors' controls here)");
for (const [slug, phrases] of Object.entries(PHRASE_ALIASES)) {
  const tool = TOOLS.find((t) => t.slug === slug);
  ok(!!tool, `${slug} is a catalog tool`);
  for (const p of phrases) {
    const words = p.split("-");
    ok(/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(p) && words.length >= 2 && !words.some((w) => PHRASE_SKIP.has(w)), `${slug}: "${p}" is two words or more, none a function word`);
    ok(!(tool?.aliases || []).includes(p), `${slug}: "${p}" is not also a word-by-word alias`);
  }
}
ok(has("base64") && has("qr") && has("hash") && has("jwt-decode") && has("crypto-price") && has("crypto-history") && has("bond-price") && has("token-price") && has("business-days") && has("calc") && has("sun-times") && has("sharpe-ratio"), "the kits hold the tools and the neighbors these cases name");

// ---- /api/route ----
for (const [q, want] of [["current bitcoin price", "crypto-price"], ["what is the current price of bitcoin", "crypto-price"], ["current eth price", "crypto-price"],
  ["bitcoin volatility last 90 days", "crypto-history"], ["bitcoin volatility", "crypto-history"], ["volatility of ethereum", "crypto-history"],
  // One query per listed phrase, so a phrase taken off the table fails here.
  ["current btc price", "crypto-price"], ["current ethereum price", "crypto-price"], ["btc volatility", "crypto-history"], ["eth volatility last 30 days", "crypto-history"],
  ["decode a base64 encoded string scanned from a qr code", "base64"]]) {
  const r = route(q);
  ok(r[0]?.slug === want, `route "${q}" picks ${want} (${r.slice(0, 4).map((x) => `${x.slug}:${x.score}`).join(", ")})`);
}
{
  // Each word of the phrase scores once, at the weight of a covered name.
  const r = route("current bitcoin price").find((x) => x.slug === "crypto-price");
  ok(slugPart(r) === 30, `the three words of the phrase score 10 each on crypto-price, never more (${slugPart(r)})`);
}
// One word of a phrase earns that tool nothing beyond what its slug earns.
for (const [q, slug, want] of [["current gold price", "crypto-price", 4], ["current stock price", "crypto-price", 4], ["current price", "crypto-price", 4], ["bond price", "crypto-price", 4],
  ["jpy volatility", "crypto-history", 0], ["implied volatility", "crypto-history", 0], ["bitcoin implied volatility", "crypto-history", 0], ["current bitcoin etf price", "crypto-price", 4]]) {
  const row = route(q).find((x) => x.slug === slug);
  ok((slugPart(row) ?? 0) === want, `route "${q}": ${slug} takes ${want} for its slug and nothing for a phrase (${slugPart(row) ?? "not ranked"})`);
}
for (const [q, want] of [["bond price", "bond-price"], ["token price", "token-price"], ["token price history", "token-price-history"], ["business days", "business-days"], ["sharpe ratio", "sharpe-ratio"], ["bitcoin price", "crypto-price"]]) {
  ok(route(q)[0]?.slug === want, `CONTROL route "${q}" picks ${want} (${route(q).slice(0, 3).map((x) => x.slug).join(", ")})`);
}
ok(route("current gold price")[0]?.slug !== "crypto-price" && route("jpy volatility")[0]?.slug !== "crypto-history" && route("implied volatility")[0]?.slug !== "crypto-history", "a neighbor's query is not the phrase's tool's");
// An outside seller's row with the same slug is not this catalog's tool.
{
  const origin = "https://coins.example";
  cache.set(origin, { manifest: { name: "s", homepage: origin }, tools: [{ seller: origin, method: "GET", route: "/api/crypto-price", slug: "crypto-price", name: "Crypto price", description: "A coin price.", category: "data", tags: [], price: 0.001, networks: ["eip155:8453"] }], fetchedAt: Date.now(), error: null, history: [1, 1, 1] });
  const rows = routeQuery({ query: "current bitcoin price", top: 25, include: "all", ...CTX }).results.filter((x) => x.slug === "crypto-price");
  const ours = rows.find((x) => x.seller !== origin), theirs = rows.find((x) => x.seller === origin);
  ok(ours && theirs && slugPart(ours) === 30 && slugPart(theirs) === 4, `the phrase scores this catalog's tool (${slugPart(ours)}) and not an outside row of the same slug (${slugPart(theirs)})`);
  cache.clear();
}

// ---- /api/find ----
for (const [q, want] of [["current bitcoin price", "crypto-price"], ["current ethereum price", "crypto-price"], ["bitcoin volatility last 90 days", "crypto-history"], ["bitcoin volatility", "crypto-history"], ["volatility of bitcoin", "crypto-history"]]) {
  const r = find(q);
  ok(r.results[0]?.slug === want && r.rarestTermCovered !== false, `find "${q}" picks ${want}, read as served (${r.results.slice(0, 3).map((x) => x.slug).join(", ")}; rarest ${r.rarestTerm} covered ${r.rarestTermCovered})`);
}
{
  // The same words, the same weights: only the phrase standing whole differs.
  const score = (q) => find(q).results.find((x) => x.slug === "crypto-history")?.score ?? 0;
  ok(score("bitcoin volatility implied") > score("bitcoin implied volatility"), `find credits the phrase only where its words stand together (${Math.round(score("bitcoin volatility implied"))} vs ${Math.round(score("bitcoin implied volatility"))})`);
  const price = (q) => find(q).results.find((x) => x.slug === "crypto-price")?.score ?? 0;
  ok(price("current bitcoin price gold") > price("current gold bitcoin price"), "and the same for the price phrase");
}
for (const [q, want] of [["bond price", "bond-price"], ["token price", "token-price"], ["business days", "business-days"], ["bitcoin price", "crypto-price"]]) {
  ok(find(q).results[0]?.slug === want, `CONTROL find "${q}" picks ${want} (${find(q).results.slice(0, 3).map((x) => x.slug).join(", ")})`);
}
{
  // The string a query decodes is base64's job even where the query names the string's source.
  const q = "decode a base64 encoded string scanned from a qr code";
  const r = find(q);
  ok(r.results[0]?.slug === "base64" && r.rarestTermCovered !== false, `find "${q}" picks base64, read as served (${r.results.slice(0, 3).map((x) => x.slug).join(", ")}; rarest ${r.rarestTerm} covered ${r.rarestTermCovered})`);
  const score = (s) => find(s).results.find((x) => x.slug === "base64")?.score ?? 0;
  ok(score("decode a base64 encoded string gzip") > score("decode a base64 encoded gzip string"), `find credits the base64 phrase only where its words stand together (${Math.round(score("decode a base64 encoded string gzip"))} vs ${Math.round(score("decode a base64 encoded gzip string"))})`);
}
for (const [q, want] of [["hash a base64 encoded string", "hash"], ["decode a base64 encoded jwt", "jwt-decode"]]) {
  // These write no phrase (above), so find ranks them as before; route names the tool on this partial catalog.
  ok(route(q)[0]?.slug === want, `CONTROL route "${q}" stays ${want}'s (${route(q).slice(0, 2).map((x) => x.slug).join(", ")})`);
}
for (const q of ["jpy volatility", "implied volatility", "tip calculator dollars"]) ok(find(q).rarestTermCovered === false, `CONTROL find "${q}" stays a weak match`);

// ---- arithmetic written in words ----
for (const q of ["5 plus 7", "what is 5 plus 7", "seven plus five", "10 minus 3", "6 times 7", "what is 6 multiplied by 7", "1.5 plus 2"]) {
  const r = route(q), f = find(q);
  ok(arithmeticAsk(q)?.term === "calc" && r[0]?.slug === "calc" && f.results[0]?.slug === "calc" && f.rarestTermCovered !== false,
    `"${q}" is the calculator's on route and find (route ${r.slice(0, 2).map((x) => x.slug).join(", ")}; find ${f.results[0]?.slug}, covered ${f.rarestTermCovered})`);
  ok(!r.some((x) => x.slug === "route-execute-plus"), `"${q}": the tier tool is not ranked for an operator inside an expression`);
}
for (const [q, want] of [["plus tier", "route-execute-plus"], ["route execute plus", "route-execute-plus"], ["plus", "route-execute-plus"], ["sun times", "sun-times"]]) {
  const r = route(q), f = find(q);
  ok(arithmeticAsk(q) === null && r[0]?.slug === want && f.results[0]?.slug === want, `CONTROL "${q}" is no expression and stays ${want}'s (route ${r[0]?.slug}, find ${f.results[0]?.slug})`);
}
for (const q of ["5 plus", "plus 7", "a plus b", "c plus plus", "3 times a day", "two times", "v1.5 plus 2", "5 plus 7days", "1,000 plus 5", "iphone 15 plus specs", "disney plus 4k", "tip calculator dollars", "plus codes", "five star plus rating"]) {
  ok(arithmeticAsk(q) === null, `"${q}" is no expression`);
}
{
  const t0 = performance.now();
  for (const s of ["5 plus ".repeat(70), "1".repeat(400) + " plus 2", "seven ".repeat(80) + "plus", "5 multiplied ".repeat(40)]) arithmeticAsk(s);
  ok(performance.now() - t0 < 50, "hostile arithmetic text is read in bounded time");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
