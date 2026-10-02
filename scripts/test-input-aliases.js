#!/usr/bin/env node
// The alias layer may never change the MEANING of a call.
//
// It exists because 60 days of telemetry showed the buyers who explored the
// catalog and left failed only on 400s, and a third of plausible first attempts
// fail on the parameter NAME alone. It converts those into sales - but a layer
// that guesses wrong turns a correct call into a wrong one silently, which is
// far worse than a 400. These are the three rules that make that impossible.
import { applyInputAliases, PARAM_ALIASES } from "../src/input-aliases.js";
import { handlerInputOf } from "../src/handler-input.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const def = (required, properties) => ({ discovery: { inputSchema: { required, properties: Object.fromEntries(properties.map((p) => [p, { type: "string" }])) } } });

// --- it works at all -------------------------------------------------------
{
  const i = { domain: "github.com" };
  const filled = applyInputAliases(i, def(["host"], ["host"]));
  ok(i.host === "github.com" && filled.join() === "host", "a required `host` is filled from `domain`");
}
{
  const i = { number: 2026 };
  applyInputAliases(i, def(["value"], ["value"]));
  ok(i.value === 2026, "a required `value` is filled from `number`");
}
{
  const i = { q: "NVDA" };
  applyInputAliases(i, def(["ticker"], ["ticker"]));
  ok(i.ticker === "NVDA", "a required `ticker` is filled from `q`");
}

// --- rule 1: never overwrite, never invent ---------------------------------
{
  const i = { host: "real.example", domain: "decoy.example" };
  applyInputAliases(i, def(["host"], ["host"]));
  ok(i.host === "real.example", "a value the caller sent is never overwritten by a synonym");
}
{
  const i = { number: 5 };
  applyInputAliases(i, def([], ["value"]));
  ok(i.value === undefined, "an OPTIONAL parameter is never invented from a synonym");
}
{
  const i = { host: "" };
  applyInputAliases(i, def(["host"], ["host"]));
  ok(i.host === "", "a tool with no synonym present is left exactly as it was");
}

// --- rule 2: the synonym must not mean something else here -----------------
{
  // A tool that declares BOTH: `domain` is its own parameter, not a spelling
  // of `host`. Taking one for the other would corrupt the call.
  const i = { domain: "example.com" };
  applyInputAliases(i, def(["host"], ["host", "domain"]));
  ok(i.host === undefined, "a synonym that is itself a declared property is NEVER borrowed");
}

// --- rule 3: ambiguity answers 400, it does not guess ----------------------
{
  const i = { hostname: "a.example", domain: "b.example" };
  applyInputAliases(i, def(["host"], ["host"]));
  ok(i.host === undefined, "two candidate synonyms is ambiguity: nothing is filled");
}

// --- shape safety ----------------------------------------------------------
ok(applyInputAliases(null, def(["host"], ["host"])).length === 0, "a null input is handled");
ok(applyInputAliases({}, null).length === 0, "no tool def means no aliasing");
ok(applyInputAliases({ domain: "x" }, { discovery: {} }).length === 0, "a tool with no inputSchema is never aliased");
{
  const i = { domain: "x" };
  applyInputAliases(i, def(["host"], ["host"]));
  const again = applyInputAliases(i, def(["host"], ["host"]));
  ok(again.length === 0 && i.host === "x", "applying twice is idempotent (pricing and serving read one input)");
}

// --- the table itself ------------------------------------------------------
{
  const selfRef = Object.entries(PARAM_ALIASES).filter(([k, v]) => v.includes(k));
  ok(selfRef.length === 0, `no canonical name lists itself as its own synonym (${selfRef.map(([k]) => k).join(",") || "none"})`);
  const dupes = Object.entries(PARAM_ALIASES).filter(([, v]) => new Set(v).size !== v.length);
  ok(dupes.length === 0, "no alias list repeats a name");
}

// --- through the real input construction -----------------------------------
{
  const req = { query: {}, body: { expression: "2+2" } };
  const input = handlerInputOf(req, def(["expr"], ["expr"]));
  ok(input.expr === "2+2", "handlerInputOf fills the alias when given the tool def");
  ok(Array.isArray(req.__aliasedParams) && req.__aliasedParams.includes("expr"), "the fill is recorded on the request for telemetry");
}
{
  // The invariant src/handler-input.js exists to protect: pricing and serving
  // must read ONE object. A quote taken before the def is known must not see a
  // different input than the handler does.
  const req = { query: {}, body: { content: "hello" } };
  const priced = handlerInputOf(req);            // no def yet
  const served = handlerInputOf(req, def(["text"], ["text"]));
  ok(priced === served, "the same object is returned with and without a def");
  ok(served.text === "hello", "the later call with a def fills the alias in place");
}
{
  // An MCP-style envelope and an alias compose: unwrap first, then alias.
  const req = { query: {}, body: { input: { domain: "example.com" } } };
  const input = handlerInputOf(req, def(["host"], ["host"]));
  ok(input.host === "example.com", "an alias inside a {input:{...}} envelope still resolves");
}

// --- second pass (2026-09-19): the table covered 22 of 186 required names ---
// A sweep of every route's own required list found 164 names with no synonym
// at all, across 255 routes. Measured cause: barcode-lookup refused 1,160 of
// 1,180 external calls with its own 400, and `code` mapped only to `source`
// and `src` (aimed at code-running tools), so a caller sending `barcode` or
// `upc` could not be understood. These pin the pairs that matter and, just as
// importantly, the ones rule 2 must REFUSE to apply.
{
  const cases = [
    ["code", "barcode", "barcode-lookup"], ["code", "upc", "barcode-lookup"], ["code", "ean", "barcode-lookup"],
    ["coin", "symbol", "crypto-price"], ["coin", "ticker", "perp-funding"],
    ["hash", "txid", "tx-status"], ["hash", "transaction", "tx-receipt"],
    ["mint", "token", "sol-token-safety"], ["mint", "address", "sol-token-report"],
    ["values", "series", "stats-summary"], ["json", "body", "json-format"],
    ["prompt", "description", "image-gen"], ["html", "markup", "html-table"],
    ["spec", "openapi", "openapi-lint"], ["country", "countryCode", "public-holidays"],
    ["principal", "amount", "loan-payment"], ["years", "term", "bond-price"],
    ["horizon", "periods", "forecast-ses"], ["payload", "claims", "jwt-sign"],
  ];
  let filled = 0;
  for (const [canon, synonym] of cases) {
    const input = { [synonym]: "X" };
    applyInputAliases(input, def([canon], [canon]));
    if (input[canon] === "X") filled++;
  }
  ok(filled === cases.length, `every new pair fills its canonical field (${filled}/${cases.length})`);

  // Rule 2 in the cases that actually occur in the catalog: the synonym is a
  // real, different field on that tool, so the 400 is the better answer.
  const quoted = { currency: "usd" };
  applyInputAliases(quoted, def(["coin"], ["coin", "currency"]));
  ok(quoted.coin === undefined, "coin is NOT filled from `currency` on a tool that declares currency (it is the quote asset there, not the coin)");

  const responses = { text: { format: "json" } };
  applyInputAliases(responses, def(["input"], ["input", "text"]));
  ok(responses.input === undefined, "input is NOT filled from `text` on the Responses wire, where `text` is its own field");

  // Rule 1 and rule 3 still hold over the widened table.
  const present = { code: "737628064502", barcode: "0000" };
  applyInputAliases(present, def(["code"], ["code"]));
  ok(present.code === "737628064502", "a required field the caller DID send is never overwritten by a synonym");

  const two = { barcode: "1", upc: "2" };
  applyInputAliases(two, def(["code"], ["code"]));
  ok(two.code === undefined, "two matching synonyms is ambiguity, so the 400 stands rather than a guess");
}

// --- request shapes (2026-09-24): common search and page-contents field names ---
// Agents that switch base URL keep sending the field names they already use.
// These fill OPTIONAL fields and list-shaped ones, scoped by slug, under the
// same three rules; unmapped fields are named back in `ignoredParams`.
{
  const { applyShapeAliases, ignoredShapeParams, shapeRefusal, SHAPE_ALIASES } = await import("../src/input-aliases.js");
  const { withIgnoredParams, preValidateInput } = await import("../src/handler-input.js");
  const { withDomainFilter } = await import("../src/tools/search.js");
  const tool = (slug, required, properties) => ({ slug, ...def(required, properties) });
  const SEARCH = tool("search", ["q"], ["q", "count", "freshness"]);
  const LITE = tool("search-lite", ["q"], ["q", "count"]);
  const IMAGES = tool("search-images", ["q"], ["q", "count", "safesearch", "country"]);
  const EXTRACT = tool("extract", ["url"], ["url"]);
  const SITEMAP = tool("site-map", ["url"], ["url", "limit", "includeSubdomains", "search"]);

  // fills
  for (const alt of ["numResults", "num_results", "maxResults", "max_results", "num", "limit"]) {
    const i = { q: "x", [alt]: 7 };
    applyShapeAliases(i, SEARCH);
    ok(i.count === 7, `search: \`${alt}\` fills the optional \`count\``);
  }
  {
    const req = { query: {}, body: { query: "fed", numResults: 3 } };
    const input = handlerInputOf(req, LITE);
    ok(input.q === "fed" && input.count === 3, "through handlerInputOf: `query` -> q (required table) and `numResults` -> count (shape table)");
  }
  {
    const i = { q: "x", include_domains: ["a.com"], exclude_domains: "b.com" };
    applyShapeAliases(i, SEARCH);
    ok(Array.isArray(i.includeDomains) && i.includeDomains[0] === "a.com" && i.excludeDomains === "b.com", "snake-case domain lists reach includeDomains / excludeDomains");
  }
  {
    const i = { urls: ["https://example.com/a"] };
    applyShapeAliases(i, EXTRACT);
    ok(i.url === "https://example.com/a", "extract: a one-element `urls` list fills `url`");
    const j = { urls: ["https://example.com/a"] };
    applyShapeAliases(j, SITEMAP);
    ok(j.url === "https://example.com/a", "site-map: a one-element `urls` list fills `url`");
  }

  // rule 1: never overwrite, never invent
  {
    const i = { q: "x", count: 2, numResults: 9 };
    applyShapeAliases(i, SEARCH);
    ok(i.count === 2, "a `count` the caller sent is never overwritten by numResults");
    ok(ignoredShapeParams(i, SEARCH).includes("numResults"), "...and the unused numResults is named in ignoredParams");
  }
  {
    const i = { url: "https://real.example/", urls: ["https://decoy.example/"] };
    applyShapeAliases(i, EXTRACT);
    ok(i.url === "https://real.example/", "a `url` the caller sent is never replaced by `urls`");
    ok(shapeRefusal({ url: "https://a.example/", urls: ["x", "y"] }, EXTRACT) === null, "a caller who sent `url` is served it even beside a longer `urls`");
  }
  {
    const i = { q: "x", numResults: 4 };
    applyShapeAliases(i, tool("answer", ["q"], ["q"]));
    ok(i.count === undefined, "an unscoped tool gets no shape aliases at all");
    const j = { q: "x", numResults: 4 };
    applyShapeAliases(j, tool("search", ["q"], ["q"]));
    ok(j.count === undefined, "a scoped tool that does not declare `count` never has it invented");
    const k = { q: "x", include_domains: ["a.com"] };
    applyShapeAliases(k, IMAGES);
    ok(k.includeDomains === undefined && ignoredShapeParams(k, IMAGES).includes("include_domains"), "image search takes no domain list: not filled, named as ignored");
  }

  // rule 2: a synonym the tool declares means something else there
  {
    const i = { url: "https://x.example", limit: 5 };
    applyShapeAliases(i, tool("search", ["q"], ["q", "count", "limit"]));
    ok(i.count === undefined, "`limit` is not borrowed for `count` on a tool that declares its own `limit`");
  }

  // rule 3: ambiguity fills nothing and reports both
  {
    const i = { q: "x", numResults: 3, max_results: 8 };
    applyShapeAliases(i, SEARCH);
    ok(i.count === undefined, "two count synonyms is ambiguity: nothing is filled");
    const ig = ignoredShapeParams(i, SEARCH);
    ok(ig.includes("numResults") && ig.includes("max_results"), "...and both are named in ignoredParams rather than guessed between");
  }

  // arrays of URLs
  {
    const many = { urls: ["https://a.example/", "https://b.example/"] };
    applyShapeAliases(many, EXTRACT);
    ok(many.url === undefined, "several `urls` never fill `url` (no silent first-of-many)");
    const msg = shapeRefusal(many, EXTRACT);
    ok(typeof msg === "string" && /reads one per call/.test(msg) && /\/api\/find/.test(msg), "several `urls` get a self-explaining refusal pointing at the multi-URL search");
    const pv = preValidateInput(EXTRACT, { query: {}, body: { urls: ["https://a.example/", "https://b.example/"] } });
    ok(pv?.status === 400 && /reads one per call/.test(pv.body.error), "preValidateInput answers the same refusal before any payment round trip");
    const nonString = { urls: [{ url: "https://a.example/" }] };
    applyShapeAliases(nonString, EXTRACT);
    ok(nonString.url === undefined, "a one-element list that is not a URL string is not guessed at");
    ok(shapeRefusal({ urls: ["https://a.example/"] }, EXTRACT) === null, "a one-element list is never refused");
  }

  // unmapped fields: accepted, not applied, named
  {
    const i = { q: "x", type: "neural", startPublishedDate: "2026-01-01", useAutoprompt: true };
    ok(ignoredShapeParams(i, SEARCH).join() === "startPublishedDate,type,useAutoprompt", "search: date/type/autoprompt fields are named as ignored");
    ok(ignoredShapeParams({ url: "u", formats: ["markdown"], onlyMainContent: true }, EXTRACT).length === 0, "extract: markdown-only formats and onlyMainContent:true are what the tool does, so nothing is reported");
    ok(ignoredShapeParams({ url: "u", formats: ["markdown", "html"], onlyMainContent: false }, EXTRACT).join() === "formats,onlyMainContent", "extract: an html format or onlyMainContent:false is named as not applied");
    ok(ignoredShapeParams({ q: "x", type: "auto" }, tool("dns", ["name"], ["name", "type"])).length === 0, "a tool outside the scoped sets never reports ignoredParams");
    ok(ignoredShapeParams({ q: "x", type: "news" }, tool("search", ["q"], ["q", "type"])).length === 0, "a field the tool declares is never reported as ignored");
  }
  {
    const req = { query: {}, body: { q: "x", type: "neural" } };
    handlerInputOf(req, SEARCH);
    const result = { query: "x", count: 0, results: [] };
    const sent = withIgnoredParams(result, req);
    ok(sent !== result && sent.ignoredParams?.join() === "type" && result.ignoredParams === undefined, "withIgnoredParams adds the field on a COPY (the cached result stays caller-neutral)");
    ok(withIgnoredParams(result, { query: {}, body: {} }) === result, "no ignored fields = the result object unchanged");
    ok(withIgnoredParams([1, 2], req).length === 2 && !("ignoredParams" in withIgnoredParams([1], req)), "an array answer passes through");
  }
  {
    // Memo-hit path: the gate prices without a def, the dispatcher serves with one.
    const req = { query: {}, body: { query: "x", num_results: 2 } };
    const priced = handlerInputOf(req);
    const served = handlerInputOf(req, LITE);
    ok(priced === served && served.count === 2 && served.q === "x", "one object for pricing and serving: the later call with the def fills shape aliases in place");
  }

  // the table itself
  {
    const self = SHAPE_ALIASES.flatMap((e) => Object.entries({ ...(e.fill || {}), ...(e.arrayOfOne || {}) })).filter(([k, v]) => v.includes(k));
    ok(self.length === 0, "no shape canonical lists itself as its own synonym");
  }

  // the domain filter the search handlers apply
  {
    const one = withDomainFilter("rate decision", { includeDomains: ["https://Reuters.com/"] });
    ok(one.q === "rate decision site:reuters.com" && one.domainFilter.includeDomains[0] === "reuters.com", "one include domain becomes a site: operator (scheme, case and slash normalised)");
    const two = withDomainFilter("q", { includeDomains: "a.com,b.org", excludeDomains: '["c.net"]' });
    ok(two.q === "q (site:a.com OR site:b.org) -site:c.net", "several includes are OR'd; excludes are -site:; comma and JSON-array strings both parse");
    ok(withDomainFilter("q", {}).domainFilter === null && withDomainFilter("q", {}).q === "q", "no lists = the query untouched");
    const throws = (i, re) => { try { withDomainFilter("q", i); return false; } catch (e) { return e.statusCode === 400 && re.test(e.message); } };
    ok(throws({ includeDomains: ["a.com/blog"] }, /not a hostname/), "a path is refused 400, never approximated");
    ok(throws({ includeDomains: Array.from({ length: 11 }, (_, n) => `d${n}.com`) }, /at most 10/), "more than 10 domains is refused 400");
    ok(throws({ includeDomains: ["a.com"], excludeDomains: ["a.com"] }, /both/), "a domain in both lists is refused 400");
    try { withDomainFilter("x".repeat(395), { includeDomains: ["example.com"] }); ok(false, "an over-long filtered query is refused"); }
    catch (e) { ok(e.statusCode === 400 && /400 characters/.test(e.message), "an over-long filtered query is refused 400"); }
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
