#!/usr/bin/env node
// route-execute asks a judgment model which of find's candidates does the task,
// and may refuse before anything runs (src/tool-judge.js). Offline: the
// judgment endpoint is a stubbed fetch; fails open when it is unusable.
import assert from "node:assert/strict";
process.env.TYPESAFE_API_KEY = "test-key";
const { decide, judgeTool, criteriaFor, NONE, _jevReset, jevSpendStatus } = await import("../src/tool-judge.js");
const { buildRouteExecuteTool } = await import("../src/tools/route-execute.js");

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const A = { slug: "pdf-extract-pages", name: "PDF pages", description: "Extract pages from a PDF" };
const B = { slug: "html-to-json", name: "HTML to JSON", description: "Extract a web page into structured JSON" };

// --- decide (pure)
ok(decide([A, B], null).def === A && decide([A, B], null).selection.method === "lexical", "no judgment: find's order");
let d = decide([A, B], { choice: "html-to-json", confidence: 0.93 });
ok(d.def === B && d.selection.method === "judged" && d.selection.overrode === "pdf-extract-pages", "a confident pick overrides find's top");
d = decide([A, B], { choice: "html-to-json", confidence: 0.7 });
ok(d.def === A && d.selection.method === "lexical" && d.selection.judged.choice === "html-to-json", "a low-confidence pick is recorded, not acted on");
ok(decide([A, B], { choice: NONE, confidence: 0.95 }).action === "refuse", "a confident none-of-these refuses");
ok(decide([A, B], { choice: NONE, confidence: 0.86 }).action === "run", "a none-of-these under the refuse band still runs find's top");
ok(decide([A, B], { choice: "pdf-extract-pages", confidence: 0.9 }).selection.overrode === undefined, "confirming find's top records no override");
ok(criteriaFor([A])[NONE], "the no-match option is always offered");

// --- judgeTool: stubbed endpoint, fails open
const orig = globalThis.fetch;
const answer = (choice, confidence) => async () => new Response(JSON.stringify({ answers: { best: { choice, confidence } } }), { status: 200 });
_jevReset(); globalThis.fetch = answer("html-to-json", 0.93);
ok((await judgeTool("extract a web page into structured json", [A, B]))?.choice === "html-to-json", "reads the choice");
_jevReset(); globalThis.fetch = answer("some-other-tool", 0.99);
ok((await judgeTool("x", [A, B])) === null, "a choice outside the candidates is discarded");
_jevReset(); globalThis.fetch = async () => new Response("nope", { status: 500 });
ok((await judgeTool("x", [A, B])) === null, "an upstream error fails open");
_jevReset(); globalThis.fetch = async () => { throw new Error("timeout"); };
ok((await judgeTool("x", [A, B])) === null, "a throw fails open");
process.env.ROUTE_JUDGE = "off";
_jevReset(); globalThis.fetch = answer("html-to-json", 0.99);
ok((await judgeTool("x", [A, B])) === null, "ROUTE_JUDGE=off disables it");
delete process.env.ROUTE_JUDGE;

// --- through route-execute: the judged pick runs, a confident no-match refuses (404, nothing run)
const ran = [];
const CATALOG = {};
for (const t of [
  { route: "POST /api/pdf-extract-pages", slug: "pdf-extract-pages", name: "PDF pages", category: "pdf", price: "$0.002", description: "Extract pages from a PDF document into structured json", tags: ["pdf", "extract", "json"], discovery: { bodyType: "json", input: {} } },
  { route: "POST /api/html-to-json", slug: "html-to-json", name: "HTML to JSON", category: "web", price: "$0.002", description: "Extract a web page into structured json", tags: ["web", "extract", "json"], discovery: { bodyType: "json", input: {} } },
]) CATALOG[t.route] = { ...t, handler: async () => { ran.push(t.slug); return { ok: true }; } };
const tool = buildRouteExecuteTool({ getCatalog: () => CATALOG, baseUrl: "https://agent402.tools" });
_jevReset(); globalThis.fetch = answer("html-to-json", 0.95);
const out = await tool.handler({ task: "extract a web page into structured json", params: {} }, {});
ok(out.receipt.slug === "html-to-json" && out.receipt.selection?.method === "judged" && ran.at(-1) === "html-to-json", `the judged tool ran and the receipt says so (${JSON.stringify(out.receipt.selection)})`);
_jevReset(); globalThis.fetch = answer(NONE, 0.97);
ran.length = 0;
let refused = null;
try { await tool.handler({ task: "extract a web page into structured json", params: {} }, {}); } catch (e) { refused = e; }
ok(refused?.statusCode === 404 && /nothing was run or charged/.test(refused.message) && ran.length === 0, "a confident no-match is a 404 before anything runs");
_jevReset(); globalThis.fetch = async () => { throw new Error("down"); };
const open = await tool.handler({ task: "extract a web page into structured json", params: {} }, {});
ok(open.receipt.selection?.method === "lexical", "judge down: find's pick runs, receipt says lexical");
globalThis.fetch = orig;
console.log(`test-tool-judge: ${n} assertions ok`);

// --- is a 200 the route working or an error page?
{
  const { freeBodyByStructure, judgeFreeResponse } = await import("../src/tool-judge.js");
  ok(freeBodyByStructure('{"status":"ready"}') === "free", "a health body is free");
  ok(freeBodyByStructure("<!DOCTYPE html><html>docs</html>", "text/html") === "free", "a page is free");
  ok(freeBodyByStructure('{"error":"bad"}') === "error", "an error key is an error");
  ok(freeBodyByStructure('{"ok":false,"message":"nope"}') === "error", "ok:false is an error");
  ok(freeBodyByStructure('{"state":"missing_x_agent_id","code":"MISSING_AGENT_ID","message":"x-agent-id header is required"}') === "error", "the measured flipr body is an error");
  ok(freeBodyByStructure('{"note":"an api key is required for live data"}') === "unsure", "a short message about the request is unsure");
  ok(freeBodyByStructure('{"count":40,"health":[{"state":"MD"}]}') === "free", "real data is free");
  const o = globalThis.fetch;
  _jevReset(); globalThis.fetch = async () => new Response(JSON.stringify({ answers: { kind: { choice: "error", confidence: 0.95 } } }), { status: 200 });
  ok((await judgeFreeResponse('{"note":"an api key is required for live data"}', "application/json")) === "error", "an unsure body goes to the judge");
  _jevReset(); globalThis.fetch = async () => { throw new Error("down"); };
  ok((await judgeFreeResponse('{"note":"an api key is required"}', "application/json")) === null, "judge down: unsure stays unsure, never free");
  globalThis.fetch = o;
}
console.log(`test-tool-judge (with free-body): ${n} assertions ok`);

// --- refusal among affordable tools points at a pricier one that fits (409, nothing run)
{
  const ran2 = [];
  const CAT = {};
  for (const t of [
    { route: "POST /api/pdf-extract-pages", slug: "pdf-extract-pages", name: "PDF pages", category: "pdf", price: "$0.003", description: "Extract pages from a PDF into json", tags: ["pdf", "extract", "json", "page"], discovery: { bodyType: "json", input: {} } },
    { route: "POST /api/skill/structured-scrape", slug: "skill-structured-scrape", name: "Skill: Structured scrape", category: "skill-pack", price: "$0.032", description: "Pull structured data out of any web page into json", tags: ["web", "page", "json", "extract"], discovery: { bodyType: "json", input: {} } },
  ]) CAT[t.route] = { ...t, handler: async () => { ran2.push(t.slug); return {}; } };
  const rt = buildRouteExecuteTool({ getCatalog: () => CAT, baseUrl: "https://agent402.tools" });
  const o = globalThis.fetch;
  let calls = 0;
  _jevReset(); globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ answers: { best: calls === 1 ? { choice: NONE, confidence: 0.99 } : { choice: "skill-structured-scrape", confidence: 0.99 } } }), { status: 200 }); };
  let e409 = null;
  try { await rt.handler({ task: "extract a web page into structured json", params: {} }, {}); } catch (e) { e409 = e; }
  ok(e409?.statusCode === 409 && /skill-structured-scrape does/.test(e409.message) && /POST \/api\/skill\/structured-scrape/.test(e409.message) && ran2.length === 0, `points at the pricier tool that fits (${e409?.statusCode} ${String(e409?.message).slice(0, 120)})`);
  globalThis.fetch = o;
}
console.log(`test-tool-judge (with pricier fallback): ${n} assertions ok`);

// --- money guards: cached repeats cost nothing; the daily ceiling falls back to lexical
{
  _jevReset();
  let hits = 0;
  const o = globalThis.fetch;
  globalThis.fetch = async () => { hits++; return new Response(JSON.stringify({ answers: { best: { choice: "html-to-json", confidence: 0.95 } } }), { status: 200 }); };
  await judgeTool("same task", [A, B]); await judgeTool("same task", [A, B]); await judgeTool("SAME TASK ", [A, B]);
  ok(hits === 1 && jevSpendStatus().cacheHits === 2, `a repeated question is answered from cache (${hits} calls)`);
  ok(jevSpendStatus().tokens > 0 && jevSpendStatus().tokens < 5000, `a call is booked against the token ceiling (${jevSpendStatus().tokens})`);
  _jevReset(); process.env.JEV_DAILY_MAX_TOKENS = "10"; hits = 0;
  ok((await judgeTool("task over the ceiling", [A, B])) === null && hits === 0 && jevSpendStatus().refusedToday === 1, "past the daily ceiling no call is made and the router keeps find's order");
  process.env.JEV_DAILY_MAX_TOKENS = "off"; _jevReset();
  ok((await judgeTool("another", [A, B])) === null && hits === 0, "JEV_DAILY_MAX_TOKENS=off disables every judgment");
  delete process.env.JEV_DAILY_MAX_TOKENS;
  globalThis.fetch = o;
}
console.log(`test-tool-judge (with money guards): ${n} assertions ok`);

// --- outside sellers: the judgment reorders gated candidates or stops the router
{
  const { orderByJudgment } = await import("../src/tool-judge.js");
  const S = [{ seller: "https://a.test", slug: "pdf" }, { seller: "https://b.test", slug: "scrape" }, { seller: "https://c.test", slug: "json" }];
  const text = (r) => ({ name: r.slug, description: r.slug });
  const o = globalThis.fetch;
  _jevReset(); globalThis.fetch = async () => new Response(JSON.stringify({ answers: { best: { choice: "c1", confidence: 0.96 } } }), { status: 200 });
  let r = await orderByJudgment("scrape a page", S, text);
  ok(r.items[0].seller === "https://b.test" && r.items.length === 3 && r.selection.method === "judged", "a confident pick moves that seller first, keeping the rest as fallbacks");
  _jevReset(); globalThis.fetch = async () => new Response(JSON.stringify({ answers: { best: { choice: NONE, confidence: 0.97 } } }), { status: 200 });
  r = await orderByJudgment("book a flight", S, text);
  ok(r.refused === true && r.items.length === 0, "a confident none-of-these stops the router before any probe or payment");
  _jevReset(); globalThis.fetch = async () => { throw new Error("down"); };
  r = await orderByJudgment("scrape a page", S, text);
  ok(r.items[0].seller === "https://a.test" && !r.refused, "judge down: the gate's order stands");
  globalThis.fetch = o;
}
console.log(`test-tool-judge (with seller ordering): ${n} assertions ok`);

// --- a split judgment is a tie among equally fitting options; the cheapest wins
{
  const X = { slug: "a", price: "$0.01" }, Y = { slug: "b", price: "$0.001" }, Z = { slug: "c", price: "$0.005" };
  let d2 = decide([X, Y, Z], { choice: "a", confidence: 0.45, probabilities: { a: 0.45, b: 0.3, c: 0.15, none_of_these: 0.02 } });
  ok(d2.def === Y && d2.selection.method === "judged-tie" && d2.selection.tieBrokenBy === "price" && d2.selection.tiedWith === 3, `three equally fitting options: the cheapest runs (${JSON.stringify(d2.selection)})`);
  d2 = decide([X, Y], { choice: "a", confidence: 0.5, probabilities: { a: 0.5, b: 0.2, none_of_these: 0.3 } });
  ok(d2.def === X && d2.selection.method === "lexical", "plausible options carrying under the pick band are not a tie: lexical order stands");
  d2 = decide([{ slug: "p", price: "$0.002" }, { slug: "q", price: "$0.002" }], { choice: "q", confidence: 0.5, probabilities: { p: 0.45, q: 0.5 } });
  ok(d2.def.slug === "p", "equal prices keep the lexical order");
}
console.log(`test-tool-judge (with ties): ${n} assertions ok`);

// --- a cached verdict belongs to the list it judged, not to any list of that length
{
  const { orderByJudgment } = await import("../src/tool-judge.js");
  const o = globalThis.fetch;
  _jevReset();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ answers: { best: { choice: "c1", confidence: 0.95 } } }), { status: 200 }); };
  const text = (r) => ({ name: r.slug, description: r.slug });
  await orderByJudgment("same task", [{ slug: "pdf" }, { slug: "scrape" }], text);
  await orderByJudgment("same task", [{ slug: "weather" }, { slug: "fx" }], text);
  ok(calls === 2, `two different lists of the same length are judged separately (${calls} calls)`);
  await orderByJudgment("same task", [{ slug: "pdf" }, { slug: "scrape" }], text);
  ok(calls === 2, "the identical list is still served from cache");
  globalThis.fetch = o;
}
console.log(`test-tool-judge (with content-keyed cache): ${n} assertions ok`);

// --- the free /api/route path draws on only its share of the daily ceiling,
//     and a per-caller admission check runs only when a model call would be made
{
  const { orderByJudgment } = await import("../src/tool-judge.js");
  const o = globalThis.fetch;
  const text = (r) => ({ name: r.slug, description: r.slug });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ answers: { best: { choice: "c1", confidence: 0.95 } } }), { status: 200 }); };
  // A small ceiling: each call books its body bytes + 300, so a 2,400-token
  // day with a 50% free share fits one free call and more paid ones.
  process.env.JEV_DAILY_MAX_TOKENS = "2400";
  process.env.ROUTE_JUDGE_FREE_SHARE = "0.5";
  _jevReset();
  let r = await orderByJudgment("free task one", [{ slug: "a1" }, { slug: "b1" }], text, { pool: "free" });
  ok(r.selection?.method === "judged" && calls === 1, `a free call inside the free share is judged (${JSON.stringify(jevSpendStatus())})`);
  r = await orderByJudgment("free task two", [{ slug: "a2" }, { slug: "b2" }], text, { pool: "free" });
  ok(r.skipped === "budget" && calls === 1 && r.items.length === 2, `past the free share the free path is skipped with rows intact (${r.skipped}, ${calls} calls)`);
  const st = jevSpendStatus();
  ok(st.freeTokens > 0 && st.freeTokens <= st.freeCapTokens && st.tokens < st.capTokens, `the free path never books past its share (${st.freeTokens}/${st.freeCapTokens} of ${st.capTokens})`);
  r = await orderByJudgment("paid task", [{ slug: "a3" }, { slug: "b3" }], text);
  ok(r.selection?.method === "judged" && calls === 2, "the paid path still has the rest of the ceiling");
  delete process.env.JEV_DAILY_MAX_TOKENS; delete process.env.ROUTE_JUDGE_FREE_SHARE;

  _jevReset(); calls = 0;
  let admits = 0;
  const deny = () => { admits++; return false; };
  r = await orderByJudgment("rate task", [{ slug: "a4" }, { slug: "b4" }], text, { pool: "free", admit: deny });
  ok(r.skipped === "rate" && calls === 0 && admits === 1 && r.items.length === 2, "a denied admission skips the model call and keeps the rows");
  await orderByJudgment("cached task", [{ slug: "a5" }, { slug: "b5" }], text, { pool: "free", admit: () => true });
  admits = 0;
  r = await orderByJudgment("cached task", [{ slug: "a5" }, { slug: "b5" }], text, { pool: "free", admit: deny });
  ok(r.selection?.method === "judged" && admits === 0, "a cached verdict is served without spending the caller's allowance");
  globalThis.fetch = o;
}
console.log(`test-tool-judge (with free share + admission): ${n} assertions ok`);
