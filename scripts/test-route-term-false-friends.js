#!/usr/bin/env node
// The router matches a query term of three or more characters as a substring,
// so "add" also read as the opening of "address": a calculator task ("add and
// multiply") scored every row named or described with an address, and a row
// whose NAME holds the word (the name counts at slug weight too) ranked beside
// the calculator. Named exceptions (src/query-terms.js TERM_FALSE_FRIENDS):
// "add" is not matched where the text goes on "addr...", and "and" is not
// matched inside "candle" (a row named for candles outranked the tool a
// "mean, range and outliers" task asks for).
//   - "add" scores nothing on a row whose only hit is "address" or "addr";
//   - controls: "add" still matches add, adds, added, adder, addition and
//     padding as before; "address" and "addr" queries match address rows as
//     before; every other term's score is the plain substring score.
// Offline: routeQuery over kits and a seeded seller cache.
//
//   node scripts/test-route-term-false-friends.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
const { routeQuery, _cacheForTests } = await import("../src/x402-index.js");
const { TERM_FALSE_FRIENDS, substringMatcher } = await import("../src/query-terms.js");
const { KIT: KIT1 } = await import("../src/tools/kit.js");
const { KIT2 } = await import("../src/tools/kit2.js");
const KIT = [...KIT1, ...KIT2];

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

// ---- the matcher ----
ok(typeof substringMatcher === "function" && TERM_FALSE_FRIENDS && Object.keys(TERM_FALSE_FRIENDS).join() === "add,and", `the exception list is two named terms (${Object.keys(TERM_FALSE_FRIENDS || {}).join(", ")})`);
if (fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
const add = substringMatcher("add");
for (const s of ["ip address type", "ip-address", "known-address label lookup", "addr", "wallet addresses", "addressable"]) ok(add(s) === false, `"add" is not read inside "${s}"`);
for (const s of ["add two numbers", "adds a row", "added", "adder", "addition", "padding", "add-liquidity", "address book: add an address"]) ok(add(s) === true, `"add" still matches "${s}"`);
for (const [term, s] of [["address", "ip address type"], ["addr", "wallet addr"], ["addr", "address"], ["calc", "calculator"], ["dns", "reverse-dns"]]) ok(substringMatcher(term)(s) === s.includes(term), `"${term}" matches "${s}" as a plain substring`);

// "and" is not read inside "candle" or "candles"; everywhere else it is the plain substring.
const and = substringMatcher("and");
for (const s of ["coin ohlc candle statistics", "coin-ohlc-candle-statistics", "candles", "4-hour candles", "candlestick"]) ok(and(s) === false, `"and" is not read inside "${s}"`);
for (const s of ["heat index and wind chill", "random", "standard", "brand", "scandal", "candid", "candle and wick", "andes"]) ok(and(s) === true, `"and" still matches "${s}"`);

for (const term of ["constructor", "tostring", "hasownproperty", "__proto__"]) ok(substringMatcher(term)(`x ${term} y`) === true && substringMatcher(term)("nothing") === false, `"${term}" is an ordinary term (no inherited key reads as an entry)`);

// ---- the router, own catalog ----
const catalog = {};
for (const t of KIT) catalog[t.route] = t;
const cache = _cacheForTests();
cache.clear();
const CTX = { baseUrl: "https://agent402.tools", catalog, prices: {}, network: "base", toolCount: Object.keys(catalog).length, walletName: "w" };
const route = (q, include = "local") => routeQuery({ query: q, top: 25, include, ...CTX }).results;
const row = (q, slug, include) => route(q, include).find((r) => r.slug === slug) || null;
const has = (slug) => KIT.some((t) => t.slug === slug);
ok(has("calc") && has("ip-info") && /address/i.test(KIT.find((t) => t.slug === "ip-info").name), "the kit holds calc and ip-info, whose name holds the word address");
for (const q of ["calculator: add, subtract, multiply, divide", "add"]) {
  const r = route(q);
  ok(row(q, "ip-info") === null, `"${q}": ip-info is not a result at all (its only hit was "address")`);
  ok(q === "add" || r[0]?.slug === "calc", `"${q}": calc is first (${r.slice(0, 3).map((x) => x.slug).join(", ")})`);
}
{
  // "and" in ip-info's name still scores as it always has; "add" adds nothing to it.
  const withAdd = row("calculator for math: add and multiply", "ip-info"), without = row("calculator for math: and multiply", "ip-info");
  ok(withAdd && without && withAdd.score === without.score, `"add" adds nothing to ip-info's score (${withAdd?.score} with, ${without?.score} without)`);
}
// Arithmetic on two numbers is the calculator's (its aliases name the task whole:
// "add-two-numbers", "sum-two-numbers"); a date sum stays date arithmetic's, and
// a bare "add" or "sum" is not the calculator's word.
for (const q of ["add two numbers", "sum of two numbers", "subtract two numbers", "multiply two numbers", "divide two numbers"]) {
  const r = route(q);
  ok(r[0]?.slug === "calc", `"${q}": calc is first (${r.slice(0, 3).map((x) => x.slug).join(", ")})`);
}
{
  const calc = KIT.find((t) => t.slug === "calc");
  ok(!calc.aliases.includes("add") && !calc.aliases.includes("sum") && !calc.aliases.includes("plus"), `calc holds no bare "add", "sum" or "plus" alias (${calc.aliases.join(", ")})`);
  // /api/find reads a query word inside a longer word of a tool's text, so an alias never holds "tip" ("multiply" does:
  // "tip calculator dollars" would read as covered by the calculator).
  ok(!calc.aliases.some((x) => /tip/.test(x)), "no calc alias holds the letters of another task's word (tip)");
  for (const [q, want] of [["add days to a date", "add-time"], ["add", "add-time"]]) {
    if (!has(want)) { ok(false, `the kit holds ${want}`); continue; }
    const r = route(q);
    ok(r[0]?.slug === want, `CONTROL "${q}": ${want} is still first (${r.slice(0, 3).map((x) => x.slug).join(", ")})`);
  }
}
// Controls: an address query reaches ip-info as before.
for (const q of ["ip address", "classify an address", "addr"]) ok(row(q, "ip-info") !== null, `"${q}" still reaches ip-info`);

// ---- the router, an outside seller's rows ----
const seller = (origin, tools) => ({ manifest: { name: "s", homepage: origin }, tools: tools.map((t) => ({ seller: origin, method: "POST", route: `/api/${t.slug}`, category: "data", tags: [], price: 0.01, networks: ["eip155:8453"], description: "", ...t })), fetchedAt: Date.now(), error: null, history: [1, 1, 1] });
cache.set("https://s.example", seller("https://s.example", [
  { slug: "address-validate", name: "Address validation", description: "Validate a postal address" },
  { slug: "add-numbers", name: "Add numbers", description: "Adds a list of numbers" },
  { slug: "padding-oracle", name: "Padding check", description: "Checks padding" },
]));
{
  const r = route("add", "external").map((x) => x.slug);
  ok(r.includes("add-numbers") && r.includes("padding-oracle") && !r.includes("address-validate"), `outside rows: "add" matches add-numbers and padding-oracle, not address-validate (${r.join(", ")})`);
  const a = route("address", "external").map((x) => x.slug);
  ok(a.join() === "address-validate", `outside rows: "address" matches address-validate alone, as before (${a.join(", ")})`);
  // The slug weight of a match is unchanged: 10 exact-covered, 4 substring, 2 name, 1 text.
  const s = row("add numbers", "add-numbers", "external");
  ok(s?.match?.matchedOn?.slug === 20 || s?.matched?.matchedOn?.slug === 20 || s?.matchedOn?.slug === 20 || s?.score >= 20, `a slug the query covers keeps its full weight (${s?.score})`);
}
// The router: a row named for candles scores nothing for the word "and".
{
  const { CRYPTO_MARKETS_TOOLS } = await import("../src/tools/crypto-markets-kit.js");
  const { KIT3 = [] } = await import("../src/tools/kit3.js").catch(() => ({}));
  const wide = { ...catalog };
  for (const t of [...CRYPTO_MARKETS_TOOLS, ...KIT3]) wide[t.route] = t;
  const ctx = { ...CTX, catalog: wide, toolCount: Object.keys(wide).length };
  const rows = (q) => routeQuery({ query: q, top: 25, include: "local", ...ctx }).results;
  const ohlc = (q) => rows(q).find((r) => r.slug === "coin-ohlc") || null;
  ok(/candle/i.test(CRYPTO_MARKETS_TOOLS.find((t) => t.slug === "coin-ohlc").name), "coin-ohlc's name holds the word candle");
  // (Its description holds the word "and" itself, which scores as text; the slug and name parts do not move.)
  const parts = (r) => { const m = r?.matchedOn || r?.match?.matchedOn || {}; return `${m.slug}/${m.name}`; };
  const withAnd = ohlc("candle statistics and"), without = ohlc("candle statistics");
  ok(withAnd && without && parts(withAnd) === parts(without) && withAnd.score - without.score <= 1, `"and" adds nothing to coin-ohlc's slug or name score (${parts(withAnd)} with, ${parts(without)} without)`);
  // The task that showed it: the numeric outlier tool is first again, ahead of
  // the coin routes whose names say statistics (it carries the alias "anomalies").
  const { STATS_TOOLS } = await import("../src/tools/stats-kit.js");
  const all = { ...wide };
  for (const t of STATS_TOOLS) all[t.route] = t;
  const top = routeQuery({ query: "statistics on numerical data: mean, range, anomalies and outliers", top: 5, include: "local", ...CTX, catalog: all, toolCount: Object.keys(all).length }).results.map((r) => r.slug);
  ok(top[0] === "outliers", `"statistics on numerical data: mean, range, anomalies and outliers" ranks outliers first (${top.join(", ")})`);
  const m = ohlc("and")?.matchedOn || ohlc("and")?.match?.matchedOn;
  ok(!ohlc("and") || !m || (m.slug === 0 && m.name === 0), `a bare "and" scores nothing on coin-ohlc's slug or name (${JSON.stringify(m || null)})`);
}
cache.clear();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
