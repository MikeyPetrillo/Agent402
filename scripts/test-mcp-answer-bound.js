// test-mcp-answer-bound - the hosted connector's free tool answers and its
// catalog.search row count are bounded, and a cut is said in fields.
// Offline: a bare express app + mountMcp over a stub catalog.
//
// What this pins:
//  - a free answer past the ceiling comes back as valid JSON under it, with
//    answerBound (the partial-answer fields, in bytes) and one entry per cut;
//  - an answer under the ceiling is byte-identical to the handler's;
//  - the text block and structuredContent agree on a cut answer;
//  - catalog.search never returns more than its published maximum, whatever
//    the caller sends as `limit` (negative, fractional, huge, not a number);
//  - a limiter that refuses says how many seconds until it has room.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
process.env.AGENT402_MCP_MAX_PER_MIN = "1000000";
process.env.AGENT402_MCP_MAX_PER_HOUR = "1000000";
process.env.AGENT402_MCP_REQ_PER_MIN = "1000000";
process.env.AGENT402_MCP_REQ_PER_HOUR = "1000000";
process.env.X402_INDEX_CRAWL = "off";
process.env.X402_SYNC_ON_START = "false";
const MAX = 64 * 1024;
process.env.AGENT402_MCP_MAX_ANSWER_BYTES = String(MAX);

import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "a402-mcp-bound-"));
process.env.REFUND_DB_DIR = TMP;

const { mountMcp } = await import("../src/mcp-http.js");
const { boundAnswer, withAnswerBound, mcpMaxAnswerBytes, MCP_MAX_ANSWER_DEFAULT_BYTES } = await import("../src/mcp-answer-bound.js");
const { createLimiter } = await import("../src/rate-limit.js");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  FAIL ${msg}`); } };
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

// ------------------------------------------------------------------ unit
{
  const small = { a: 1, rows: [1, 2, 3] };
  const r = boundAnswer(small, 1024);
  ok(r.value === small && r.bound === null, "an answer under the ceiling is returned as is, with no bound");

  const rows = Array.from({ length: 5000 }, (_, i) => ({ i, name: `row-${i}`, note: "x".repeat(40) }));
  const big = boundAnswer({ title: "t", rows, after: "kept-if-room" }, MAX);
  ok(big.bound && bytes(big.value) <= MAX, `a long list is cut under the ceiling (${bytes(big.value)} of ${MAX})`);
  ok(big.bound.truncated === true && big.bound.complete === false && big.bound.unit === "bytes", "the bound carries truncated/complete in the partial-answer vocabulary, in bytes");
  ok(big.bound.matched === bytes({ title: "t", rows, after: "kept-if-room" }) && big.bound.returned === bytes(big.value), "matched is the bytes produced, returned the bytes kept");
  const cut = big.bound.cuts.find((c) => c.path === "rows");
  ok(cut && cut.kind === "array" && cut.matched === 5000 && cut.returned === big.value.rows.length && cut.returned < 5000 && cut.truncated === true, "the cut list is named by path with its row counts");
  ok(big.value.rows.every((row, i) => row.i === i), "the kept rows are the first rows, in order");
  ok(bytes(withAnswerBound(big.value, big.bound)) <= MAX, "the cut answer with its answerBound block still fits the ceiling");
  // catalog.call's outputSchema names every field the bound carries, and every
  // field of a cut entry, as boundAnswer emits them.
  {
    const { META_OUTPUT_SCHEMAS } = await import("../src/mcp-flagship.js");
    const d = String(META_OUTPUT_SCHEMAS["catalog.call"]?.properties?.answerBound?.description || "");
    const named = (k) => new RegExp(`(^|[^A-Za-z])${k}([^A-Za-z]|$)`).test(d);
    const keys = [...Object.keys(big.bound), ...Object.keys(big.bound.cuts[0] || {})];
    const missing = [...new Set(keys)].filter((k) => !named(k));
    ok(keys.length >= 12 && missing.length === 0, `the answerBound outputSchema names every field the bound carries${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  }

  const str = boundAnswer({ text: "y".repeat(500_000) }, MAX);
  const sc = str.bound?.cuts.find((c) => c.path === "text");
  ok(str.bound && bytes(str.value) <= MAX && sc?.kind === "string" && sc.matched === 500_000 && sc.returned === str.value.text.length, "a long string is cut and named with its character counts");

  // Escape-heavy text serializes at several bytes a character.
  const esc = boundAnswer({ text: "\u0001".repeat(200_000) }, MAX);
  ok(esc.bound && bytes(withAnswerBound(esc.value, esc.bound)) <= MAX, "an escape-heavy string still lands under the ceiling");

  const wide = boundAnswer(Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`key${i}`, i])), MAX);
  const oc = wide.bound?.cuts.find((c) => c.kind === "object");
  ok(wide.bound && bytes(wide.value) <= MAX && oc && oc.matched === 20_000 && oc.returned === Object.keys(wide.value).length, "a wide object keeps its first keys and says how many of how many");

  const arr = boundAnswer(Array.from({ length: 50_000 }, (_, i) => i), MAX);
  const wrapped = withAnswerBound(arr.value, arr.bound);
  ok(Array.isArray(wrapped.result) && wrapped.answerBound === arr.bound, "an answer that is not an object is wrapped as { result, answerBound }");

  const many = boundAnswer(Array.from({ length: 200 }, () => "z".repeat(5000)), 8192);
  ok(many.bound.cuts.length <= 20 && many.bound.cutsListed === many.bound.cuts.length && many.bound.cutsTotal >= many.bound.cutsListed, "the list of cuts is itself bounded and counted");

  ok(mcpMaxAnswerBytes({}) === MCP_MAX_ANSWER_DEFAULT_BYTES && mcpMaxAnswerBytes({ AGENT402_MCP_MAX_ANSWER_BYTES: "nope" }) === MCP_MAX_ANSWER_DEFAULT_BYTES && mcpMaxAnswerBytes({ AGENT402_MCP_MAX_ANSWER_BYTES: "0" }) === MCP_MAX_ANSWER_DEFAULT_BYTES, "an unset or unusable ceiling reads as the default");
  ok(["1", "512", "1023", "-5"].every((v) => mcpMaxAnswerBytes({ AGENT402_MCP_MAX_ANSWER_BYTES: v }) === MCP_MAX_ANSWER_DEFAULT_BYTES), "a ceiling under the 1024-byte floor reads as the default");
  ok(mcpMaxAnswerBytes({ AGENT402_MCP_MAX_ANSWER_BYTES: "1024" }) === 1024 && mcpMaxAnswerBytes({ AGENT402_MCP_MAX_ANSWER_BYTES: "2048.7" }) === 2048, "a ceiling at or over the floor is used, in whole bytes");

  // Room is kept for the answerBound block: rows whose estimate is exact (short
  // strings) fill the budget to the byte, and the answer with its block must
  // still fit the ceiling.
  const tight = boundAnswer(Array.from({ length: 20_000 }, (_, i) => String(i).padStart(10, "x")), MAX);
  const tightSent = withAnswerBound(tight.value, tight.bound);
  ok(tight.bound && bytes(tightSent) <= MAX, `a list of short strings cut to the budget still fits with its answerBound block (${bytes(tightSent)} of ${MAX})`);
  ok(tight.bound && bytes(tight.value) > MAX / 2, `and the cut keeps most of the ceiling (${bytes(tight.value)} of ${MAX})`);
}

// --------------------------------------------------------------- limiter
{
  const lim = createLimiter("t-retry", { perMin: 2, perHour: 100 });
  ok(lim.check("k").limited === false && lim.check("k").retryAfterSeconds === undefined, "a served check carries no retry time");
  const refused = lim.check("k");
  ok(refused.limited === true && Number.isInteger(refused.retryAfterSeconds) && refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 60, `a refused burst names whole seconds inside the burst window (got ${refused.retryAfterSeconds})`);
  const hour = createLimiter("t-retry-h", { perMin: 100, perHour: 2 });
  hour.check("k"); hour.check("k");
  const r2 = hour.check("k");
  ok(r2.limited === true && r2.retryAfterSeconds > 60 && r2.retryAfterSeconds <= 3600, `a refused hour budget names the hour window's wait (got ${r2.retryAfterSeconds})`);
  ok(hour.peek("k").retryAfterSeconds === r2.retryAfterSeconds || hour.peek("k").retryAfterSeconds === r2.retryAfterSeconds - 1, "peek reports the same wait");
}

// ------------------------------------------------------------- connector
const def = (slug, handler) => ({
  route: `GET /api/${slug}`, slug, name: slug, category: "test", price: "$0.001", description: `${slug} widget test tool`,
  tags: ["widget"], discovery: { inputSchema: { properties: { q: { type: "string" } } }, input: { q: "x" } }, handler,
});
const BIG_ROWS = Array.from({ length: 4000 }, (_, i) => ({ i, pad: "p".repeat(60) }));
const CATALOG = {
  "GET /api/big": def("big", async () => ({ label: "big", rows: BIG_ROWS })),
  "GET /api/small": def("small", async () => ({ label: "small", rows: [1, 2, 3] })),
};
// Enough tools that an unclamped search would return more than the maximum.
for (let i = 0; i < 60; i++) CATALOG[`GET /api/w${i}`] = def(`w${i}`, async () => ({ ok: true }));

const app = express();
app.use(express.json({ limit: "1mb" }));
mountMcp(app, CATALOG, { baseUrl: "http://localhost", isComputePayable: () => true, taskStoreDir: join(TMP, "store") });
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  if ((res.headers.get("content-type") || "").includes("event-stream")) {
    return JSON.parse(text.split("\n").find((l) => l.startsWith("data:")).slice(5).trim());
  }
  return JSON.parse(text);
}

try {
  const big = (await rpc("tools/call", { name: "catalog.call", arguments: { slug: "big", params: {} } })).result;
  const text = big?.content?.[0]?.text || "";
  const parsed = JSON.parse(text);
  ok(Buffer.byteLength(text) <= MAX, `an oversized free answer's text block is under the ceiling (${Buffer.byteLength(text)} of ${MAX})`);
  ok(parsed.answerBound?.truncated === true && parsed.answerBound.complete === false && parsed.answerBound.unit === "bytes" && parsed.answerBound.maxBytes === MAX, "the text block carries answerBound in fields");
  ok(parsed.rows.length < BIG_ROWS.length && parsed.answerBound.cuts.some((c) => c.path === "rows" && c.matched === BIG_ROWS.length && c.returned === parsed.rows.length), "the cut list is named with kept and produced row counts");
  ok(big.structuredContent?.slug === "big" && big.structuredContent.answerBound?.truncated === true && big.structuredContent.result.rows.length === parsed.rows.length, "structuredContent agrees with the text block and carries answerBound on the envelope");
  ok(big.isError !== true, "a cut answer is still a success");

  const small = (await rpc("tools/call", { name: "catalog.call", arguments: { slug: "small", params: {} } })).result;
  ok(small.content[0].text === JSON.stringify({ label: "small", rows: [1, 2, 3] }, null, 2) && small.structuredContent.answerBound === undefined && small.structuredContent.result.answerBound === undefined, "an answer under the ceiling is unchanged and carries no answerBound");

  const search = async (limit) => (await rpc("tools/call", { name: "catalog.search", arguments: { query: "widget", ...(limit === undefined ? {} : { limit }) } })).result.structuredContent;
  const dflt = await search(undefined);
  ok(dflt.results.length === 10 && dflt.matched === 62 && dflt.limitMax === 25, `the default is 10 rows of the matched count (got ${dflt.results.length} of ${dflt.matched})`);
  for (const [limit, want] of [[-1, 1], [-50, 1], [0, 10], [0.5, 10], [3.9, 3], [25, 25], [26, 25], [1e9, 25], ["7", 7], ["all", 10], [null, 10], [Infinity, 10]]) {
    const s = await search(limit);
    ok(s.results.length === want && s.returned === want && s.truncated === true, `limit ${JSON.stringify(limit) ?? String(limit)} answers ${want} rows (got ${s.results.length})`);
  }
  const over = await search(1e9);
  ok(over.requestedExceededMax === true, "a limit above the maximum is said in a field");
} finally {
  server.close();
  server.closeAllConnections?.();
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\ntest-mcp-answer-bound: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
