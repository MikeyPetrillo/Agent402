// search-suggest reads Wikipedia's opensearch API the way its etiquette asks,
// and keeps its answer shape (offline: fetch is stubbed, no network).
//   - the read goes to en.wikipedia.org/w/api.php?action=opensearch with the
//     partial query and the caller's count, under a User-Agent that names the
//     client, says "bot" and gives contact details;
//   - the answer is { query, count, suggestions: string[] } plus the source's
//     credit; the description ends with the attribution sentence;
//   - reads are serial (never two in flight), held under the per-minute
//     ceiling (a caller that would wait too long is answered 503 before any
//     read), and a bounded number of callers wait;
//   - the source's 429 is a 503 and its other errors a 502, never its body.
//
//   node scripts/test-search-suggest-source.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const { SEARCH_TOOLS } = await import("../src/tools/search.js");
const src = await import("../src/tools/wikipedia-suggest.js");
const { WIKIPEDIA_ATTRIBUTION, WIKIPEDIA_CREDIT, ATTRIBUTIONS } = await import("../src/data-attribution.js");
const tool = SEARCH_TOOLS.find((t) => t.slug === "search-suggest");
const realFetch = globalThis.fetch;

const opensearch = (q, titles) => new Response(JSON.stringify([q, titles, titles.map(() => ""), titles.map((t) => `https://en.wikipedia.org/wiki/${encodeURIComponent(t)}`)]), { status: 200, headers: { "content-type": "application/json" } });

// --- the request and the answer ---
{
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url: new URL(String(url)), init }); return opensearch("machine lear", ["Machine learning", "Machine learning in biology", "Machine learning in physics"]); };
  try {
    const a = await tool.handler({ q: "  machine lear ", count: 2 });
    const { url, init } = seen[0];
    ok(seen.length === 1 && url.origin === "https://en.wikipedia.org" && url.pathname === "/w/api.php", `one read of en.wikipedia.org/w/api.php (${url.origin}${url.pathname})`);
    const p = url.searchParams;
    ok(p.get("action") === "opensearch" && p.get("search") === "machine lear" && p.get("limit") === "2" && p.get("namespace") === "0" && p.get("format") === "json", `opensearch with the trimmed query and the caller's count (${p})`);
    const ua = init?.headers?.["User-Agent"] || "";
    ok(/bot/i.test(ua) && /https:\/\/agent402\.tools/.test(ua) && /@agent402\.tools/.test(ua) && !/^Mozilla/.test(ua), `the User-Agent names the client, says bot and gives contact details (${ua})`);
    ok(a.query === "machine lear" && a.count === 2 && JSON.stringify(a.suggestions) === JSON.stringify(["Machine learning", "Machine learning in biology"]), `the answer keeps { query, count, suggestions } capped at count (${JSON.stringify(a)})`);
    ok(a.credit === WIKIPEDIA_CREDIT && /wikipedia\.org/.test(a.credit) && /CC BY-SA 4\.0/.test(a.credit), "every answer carries the source's credit with its link and license");
    const keys = Object.keys(a).filter((k) => !["query", "count", "suggestions", "credit"].includes(k));
    ok(keys.every((k) => k === "untrustedContent" || k === "_provenance" || /untrusted|provenance/i.test(k)), `no other field changes (${keys.join(", ") || "none"})`);
    const d = await tool.handler({ q: "x" });
    ok(new URL(String(seen[1].url)).searchParams.get("limit") === "5" && d.count === 3, "the default count is 5");
    await tool.handler({ q: "x", count: 99 });
    ok(new URL(String(seen[2].url)).searchParams.get("limit") === "20", "count is capped at 20");
  } finally { globalThis.fetch = realFetch; }
}
ok(ATTRIBUTIONS.wikipedia === WIKIPEDIA_ATTRIBUTION && tool.attribution === "wikipedia" && tool.description.endsWith(WIKIPEDIA_ATTRIBUTION), "the description ends with the Wikipedia attribution sentence");
ok(tool.discovery.output.example.credit === WIKIPEDIA_CREDIT && Array.isArray(tool.discovery.output.example.suggestions), "the published example carries the credit beside the suggestions");
ok(Array.isArray(tool.upstreamHosts) && tool.upstreamHosts.includes("en.wikipedia.org"), "the tool declares its upstream host");
ok(!/brave/i.test(String(src.wikipediaSuggestions)) && !/BRAVE/.test(String(tool.handler)), "no Brave key or host is read");

// --- missing input is a 400 before any read ---
{
  let reads = 0;
  globalThis.fetch = async () => { reads++; return opensearch("", []); };
  try {
    let e; try { await tool.handler({}); } catch (x) { e = x; }
    ok(e?.statusCode === 400 && reads === 0, "a missing q is a 400 with no read");
  } finally { globalThis.fetch = realFetch; }
}

// --- upstream errors ---
for (const [status, want] of [[429, 503], [500, 502], [403, 502]]) {
  globalThis.fetch = async () => new Response("<html>internal detail</html>", { status });
  try {
    let e; try { await tool.handler({ q: "abc" }); } catch (x) { e = x; }
    ok(e?.statusCode === want && !/internal detail/.test(e?.message || ""), `upstream ${status} answers ${want} without its body (${e?.statusCode} ${e?.message})`);
  } finally { globalThis.fetch = realFetch; }
}

// --- serial reads ---
{
  let inFlight = 0, maxInFlight = 0;
  globalThis.fetch = async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return opensearch("a", ["A"]); };
  try {
    const all = await Promise.all(Array.from({ length: 6 }, (_, k) => tool.handler({ q: `a${k}` })));
    ok(all.every((x) => x.count === 1) && maxInFlight === 1, `six concurrent callers are read one after another (most in flight ${maxInFlight})`);
  } finally { globalThis.fetch = realFetch; }
}

// --- the per-minute ceiling ---
{
  let t = 1_000_000, slept = [];
  src._setSuggestClockForTest(() => t, async (ms) => { slept.push(ms); t += ms; });
  let reads = 0;
  globalThis.fetch = async () => { reads++; return opensearch("a", ["A"]); };
  try {
    for (let k = 0; k < src.SUGGEST_MAX_PER_MINUTE; k++) await tool.handler({ q: "a" });
    ok(reads === src.SUGGEST_MAX_PER_MINUTE && slept.length === 0, `${src.SUGGEST_MAX_PER_MINUTE} reads in one minute run without waiting`);
    ok(src.SUGGEST_MAX_PER_MINUTE < 200, "the ceiling sits under the source's 200 a minute for an identified bot");
    let e; try { await tool.handler({ q: "a" }); } catch (x) { e = x; }
    ok(e?.statusCode === 503 && reads === src.SUGGEST_MAX_PER_MINUTE, `one more inside the same minute is a 503 with no read (${e?.statusCode})`);
    t += 60_000 - src.SUGGEST_MAX_WAIT_MS + 1; // room opens within the wait bound
    const a = await tool.handler({ q: "a" });
    ok(a.count === 1 && slept.length === 1 && slept[0] > 0 && slept[0] <= src.SUGGEST_MAX_WAIT_MS && reads === src.SUGGEST_MAX_PER_MINUTE + 1, `a caller within ${src.SUGGEST_MAX_WAIT_MS} ms of room waits, then reads (slept ${slept[0]} ms)`);
  } finally { globalThis.fetch = realFetch; src._setSuggestClockForTest(); }
}

// --- a bounded line of waiting callers ---
{
  let release, reads = 0;
  const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async () => { reads++; await gate; return opensearch("a", ["A"]); };
  try {
    const n = src.SUGGEST_MAX_WAITING;
    const held = Array.from({ length: n }, () => tool.handler({ q: "a" }).then((x) => x, (x) => x));
    let e; try { await tool.handler({ q: "a" }); } catch (x) { e = x; }
    ok(e?.statusCode === 503, `the caller past ${n} waiting is answered 503 (${e?.statusCode})`);
    release();
    const done = await Promise.all(held);
    ok(done.every((x) => x && x.count === 1) && reads === n, `the ${n} waiting callers are each served once (${reads} reads)`);
  } finally { globalThis.fetch = realFetch; src._setSuggestClockForTest(); }
}

console.log(`\ntest-search-suggest-source: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
