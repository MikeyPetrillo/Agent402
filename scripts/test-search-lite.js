// search-lite: input validation and output shaping, offline.
//
// Every fetch is stubbed; no request leaves the process and no key is spent
// (the key below is a fake string the stub checks for). Pins:
//   1. a bad input is refused 400 BEFORE any upstream call (a >= 400 is never
//      charged, so validation must not cost a Brave request either);
//   2. with no key the route says it is not configured (503), still with zero
//      upstream calls;
//   3. one call = exactly ONE /web/search request, carrying only q and count;
//   4. the answer carries {query, count, results[{title, url, description}]}
//      plus the untrustedContent marker, and nothing else from Brave's body;
//   5. the upstream error mapping is the one `search` uses (429 -> 503,
//      5xx -> 502, transport failure -> 504);
//   6. the call is metered under its own caller name;
//   7. the tool is wallet-only: never reachable on the free PoW tier;
//   8. the published OpenAPI parameter carries the type the schema declares,
//      so the example an agent copies validates against it;
//   9. a generic SERP query still resolves to the full `search` tool on both
//      resolvers - the cheaper sample must not take the generic intent.
//
// The crawler is switched off for the router import below. Static imports run
// first, but none of them reads this variable and x402-index.js is imported
// dynamically further down, after this line has run.
process.env.X402_INDEX_CRAWL ??= "off";
import { SEARCH_TOOLS, braveCallMeter } from "../src/tools/search.js";
import { isComputePayable } from "../src/pow.js";
import { openapiSpec } from "../src/pages.js";
import { findTools } from "../src/find.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const tool = SEARCH_TOOLS.find((t) => t.slug === "search-lite");
ok(!!tool, "search-lite is in SEARCH_TOOLS");
ok(tool?.route === "GET /api/search-lite", `route is GET /api/search-lite (got ${tool?.route})`);
ok(tool?.price === "$0.008", `price is $0.008 (got ${tool?.price})`);
ok(tool?.category === "web", "category is web");
ok(/untrusted/i.test(tool?.description || ""), "description documents the untrusted-content policy");
ok(tool?.discovery?.output?.example?.untrustedContent === true, "output example carries untrustedContent");
ok(JSON.stringify(tool?.discovery?.inputSchema?.required) === '["q"]', "only q is required");

// The price must clear the margin bound against the web plan's per-request rate.
{
  const price = Number(String(tool.price).replace("$", ""));
  ok(0.005 / price <= 0.7, `upstream per-request rate is within the margin bound of $${price}`);
  ok(0.005 / (price - 0.001) > 0.7, "and one settlement step lower would not be, so the price is the floor, not a guess");
}

// Every call spends the Brave subscription, so it must never be reachable on
// the free proof-of-work tier. Pinned for the whole kit, not just this tool.
ok(!isComputePayable(tool), "search-lite is wallet-only (in WALLET_ONLY_SLUGS, never PoW-eligible)");
{
  const free = SEARCH_TOOLS.filter((t) => isComputePayable(t)).map((t) => t.slug);
  ok(free.length === 0, `no search-kit tool is PoW-eligible${free.length ? ` (found: ${free.join(", ")})` : ""}`);
}

const search = SEARCH_TOOLS.find((t) => t.slug === "search");
ok(/search-lite/.test(search.description), "search's description points at search-lite for a quick sample");

// --- what /openapi.json publishes for the input -----------------------------
// The handler takes a whole number and the schema says so, but the spec is the
// surface a code generator reads: a parameter published as a string beside a
// numeric example is an example that does not validate against its own type.
{
  const spec = openapiSpec("https://agent402.test", Object.fromEntries(SEARCH_TOOLS.map((t) => [t.route, t])));
  const params = spec.paths["/api/search-lite"]?.get?.parameters ?? [];
  const count = params.find((p) => p.name === "count");
  ok(count?.in === "query", "count is published as a query parameter");
  ok(count?.schema?.type === "integer", `count is published as the type the schema declares (got ${count?.schema?.type})`);
  ok(Number.isInteger(count?.example), `its example is an integer (got ${JSON.stringify(count?.example)})`);
  const q = params.find((p) => p.name === "q");
  ok(q?.schema?.type === "string" && q?.required === true, "q stays a required string");
  // The rule, not just this row: every documented example must validate
  // against the type published beside it, for every tool in the kit.
  const mismatched = [];
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const op of Object.values(ops)) {
      for (const p of op?.parameters ?? []) {
        if (p.in !== "query" || p.example === undefined) continue;
        const t = p.schema?.type;
        const okType = t === "string" ? typeof p.example === "string"
          : t === "integer" ? Number.isInteger(p.example)
          : t === "number" ? typeof p.example === "number"
          : t === "boolean" ? typeof p.example === "boolean" : false;
        if (!okType) mismatched.push(`${path}?${p.name}: ${t} vs ${JSON.stringify(p.example)}`);
      }
    }
  }
  ok(mismatched.length === 0, `every published query example matches its declared type${mismatched.length ? ` - ${mismatched.join("; ")}` : ""}`);
}

// --- ranking: the generic intent stays on the full tool ----------------------
// search-lite is cheaper and carries the same "serp" tag, so on a one-word
// generic query the two tie on score and the price tie-break would hand the
// intent to the 5-result sample. `search` carries a curated "serp" alias for
// exactly that, and an alias scores like a slug. Pinned on both resolvers,
// because /api/route and /api/find have disagreed before.
{
  const { routeQuery } = await import("../src/x402-index.js");
  const catalog = Object.fromEntries(SEARCH_TOOLS.map((t) => [t.route, t]));
  const route = (q) => routeQuery({ query: q, top: 5, include: "local", baseUrl: "https://agent402.test", catalog, toolCount: SEARCH_TOOLS.length }).results.map((r) => r.slug);
  const find = (q) => findTools(catalog, q, { k: 5 }).results.map((r) => r.slug);
  ok(search.aliases?.includes("serp"), "search carries the curated serp alias");
  for (const q of ["serp", "web search", "search the web", "google search"]) {
    ok(route(q)[0] === "search", `/api/route: ${JSON.stringify(q)} resolves to search (got ${route(q).slice(0, 3).join(", ")})`);
    ok(find(q)[0] === "search", `/api/find: ${JSON.stringify(q)} resolves to search (got ${find(q).slice(0, 3).join(", ")})`);
  }
  // The sample is still findable - this is an ordering rule, not a hidden tool.
  ok(route("serp").includes("search-lite") && find("serp").includes("search-lite"), "search-lite is still returned for the same query");
  ok(route("quick web sample")[0] === "search-lite", `a query naming the sample resolves to it (got ${route("quick web sample").slice(0, 3).join(", ")})`);
}

// --- stubbed upstream --------------------------------------------------------
const realFetch = globalThis.fetch;
const calls = [];
let respond = null;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  return respond(String(url), init);
};
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const FAKE_KEY = "test-key-not-a-real-subscription";
const savedKey = process.env.BRAVE_API_KEY;

async function expectStatus(input, status, label) {
  const before = calls.length;
  try {
    await tool.handler(input);
    ok(false, `${label} (did not throw)`);
  } catch (e) {
    ok(e.statusCode === status, `${label} -> ${status} (got ${e.statusCode}: ${e.message})`);
  }
  return calls.length - before;
}

try {
  // 1. Input validation, with a key set so a pass would reach the stub.
  process.env.BRAVE_API_KEY = FAKE_KEY;
  respond = () => { throw new Error("upstream must not be reached on invalid input"); };
  for (const [input, label] of [
    [{}, "missing q"],
    [{ q: "" }, "empty q"],
    [{ q: "   " }, "whitespace q"],
    [{ q: 42 }, "non-string q"],
    [{ q: "x402", count: 0 }, "count 0"],
    [{ q: "x402", count: 6 }, "count 6"],
    [{ q: "x402", count: 20 }, "count 20"],
    [{ q: "x402", count: -1 }, "count -1"],
    [{ q: "x402", count: 2.5 }, "count 2.5"],
    [{ q: "x402", count: "abc" }, "count 'abc'"],
    [{ q: "x402", count: "6" }, "count '6' (query-string form)"],
  ]) {
    const made = await expectStatus(input, 400, `rejects ${label}`);
    ok(made === 0, `rejecting ${label} made zero upstream calls`);
  }
  {
    let msg = "";
    try { await tool.handler({ q: "x", count: 9 }); } catch (e) { msg = e.message; }
    ok(/1 to 5/.test(msg) && /search/.test(msg), `the count refusal names the range and the tool to use instead (got: ${msg})`);
  }

  // 2. No key: validation passes, then 503, still no upstream call.
  delete process.env.BRAVE_API_KEY;
  {
    const made = await expectStatus({ q: "x402" }, 503, "no key configured");
    ok(made === 0, "an unconfigured deployment makes zero upstream calls");
  }
  process.env.BRAVE_API_KEY = FAKE_KEY;

  // 3 + 4. Happy path: Brave body with more results and more fields than we keep.
  const braveBody = {
    type: "search",
    query: { original: "x402 payment protocol" },
    web: {
      results: Array.from({ length: 7 }, (_, n) => ({
        title: `Result ${n}`,
        url: `https://example.com/${n}`,
        description: `Snippet ${n}`,
        age: "2 days ago",
        page_age: "2026-09-20T00:00:00",
        profile: { name: "Example" },
        extra_snippets: ["more"],
        meta_url: { hostname: "example.com" },
      })),
    },
    news: { results: [{ title: "ignored" }] },
  };
  respond = () => jsonRes(200, braveBody);

  const meterBefore = braveCallMeter();
  let before = calls.length;
  const out = await tool.handler({ q: "  x402 payment protocol  " });
  ok(calls.length - before === 1, `one call made exactly one upstream request (made ${calls.length - before})`);
  const meterAfter = braveCallMeter();
  ok((meterAfter.byCaller["search-lite"] || 0) - (meterBefore.byCaller["search-lite"] || 0) === 1,
    "the request is metered under caller search-lite");
  ok((meterAfter.byPath["/web/search"] || 0) - (meterBefore.byPath["/web/search"] || 0) === 1,
    "on the /web/search path");

  const sent = new URL(calls[calls.length - 1].url);
  ok(sent.origin === "https://api.search.brave.com" && sent.pathname === "/res/v1/web/search",
    `upstream is the Brave web search endpoint (got ${sent.origin}${sent.pathname})`);
  ok(sent.searchParams.get("q") === "x402 payment protocol", "query is trimmed before it is sent");
  ok(sent.searchParams.get("count") === "5", `default count is 5 (sent ${sent.searchParams.get("count")})`);
  ok([...sent.searchParams.keys()].sort().join(",") === "count,q", `only q and count are sent (got ${[...sent.searchParams.keys()].join(",")})`);
  ok(calls[calls.length - 1].init?.headers?.["X-Subscription-Token"] === FAKE_KEY, "the subscription token rides the header, not the URL");
  ok(!sent.toString().includes(FAKE_KEY), "the key never appears in the request URL");

  ok(JSON.stringify(Object.keys(out).sort()) === JSON.stringify(["count", "query", "results", "untrustedContent"]),
    `top-level keys are exactly query, count, results, untrustedContent (got ${Object.keys(out).join(",")})`);
  ok(out.query === "x402 payment protocol", "query echoes the trimmed input");
  ok(out.untrustedContent === true, "result is marked untrusted");
  ok(out.results.length === 5 && out.count === 5, `five results kept of seven returned (got ${out.results.length}, count ${out.count})`);
  ok(out.results.every((r) => JSON.stringify(Object.keys(r)) === JSON.stringify(["title", "url", "description"])),
    "each result carries only title, url and description");
  ok(out.results[0].title === "Result 0" && out.results[4].url === "https://example.com/4", "results keep upstream rank order");

  // Explicit counts, including the query-string form.
  for (const [count, want] of [[1, "1"], ["3", "3"], [5, "5"]]) {
    before = calls.length;
    const r = await tool.handler({ q: "x402", count });
    const u = new URL(calls[calls.length - 1].url);
    ok(calls.length - before === 1 && u.searchParams.get("count") === want && r.results.length === Number(want) && r.count === Number(want),
      `count ${JSON.stringify(count)} sends count=${want} and returns ${want} result(s)`);
  }
  // An empty count means the default.
  await tool.handler({ q: "x402", count: "" });
  ok(new URL(calls[calls.length - 1].url).searchParams.get("count") === "5", "an empty count is the default");

  // Missing fields on a result become null, not undefined (stable shape).
  respond = () => jsonRes(200, { web: { results: [{ url: "https://example.com/only-url" }] } });
  const sparse = await tool.handler({ q: "x402" });
  ok(sparse.results.length === 1 && sparse.results[0].title === null && sparse.results[0].description === null
    && sparse.results[0].url === "https://example.com/only-url", "a result missing fields reads null");

  // No web block at all: an honest empty answer, not a crash.
  respond = () => jsonRes(200, { type: "search" });
  const empty = await tool.handler({ q: "x402" });
  ok(empty.count === 0 && Array.isArray(empty.results) && empty.results.length === 0 && empty.untrustedContent === true,
    "no web results -> count 0 and an empty array");

  // 5. Error mapping, identical to search.
  respond = () => jsonRes(429, {});
  await expectStatus({ q: "x402" }, 503, "upstream 429");
  respond = () => jsonRes(500, {});
  await expectStatus({ q: "x402" }, 502, "upstream 500");
  respond = () => jsonRes(401, {});
  await expectStatus({ q: "x402" }, 502, "upstream 401");
  respond = () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); };
  await expectStatus({ q: "x402" }, 504, "upstream transport failure");
  {
    let msg = "";
    respond = () => jsonRes(500, { secret: "upstream body" });
    try { await tool.handler({ q: "x402" }); } catch (e) { msg = e.message; }
    ok(!/upstream body/.test(msg), "the upstream body is never echoed into the error");
  }
} finally {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.BRAVE_API_KEY; else process.env.BRAVE_API_KEY = savedKey;
}

console.log(`\ntest-search-lite: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
