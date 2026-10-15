#!/usr/bin/env node
// Two MCP wire contracts, on both connectors.
//
// 1. Protocol versions. The hosted /mcp answers `initialize` through the
//    SDK's Server, which echoes a version it supports and otherwise answers
//    its latest. A 2026-07-28 client that opens with `initialize` is served
//    the negotiated revision, and tools/list plus a free tool call work under
//    it. A request carrying only the 2026-07-28 header (no handshake) gets a
//    400 whose body is not the modern UnsupportedProtocolVersionError, which
//    is the signal a dual-era client reads to fall back to `initialize`.
//
// 2. Tool input element bound. Both connectors refuse a tools/call whose
//    arguments hold more array elements plus object members than
//    MCP_MAX_TOOL_INPUT_ELEMENTS, with InvalidParams and the SDK's wording.
//    The counting rule is checked against the SDK's own McpServer option, the
//    bound against the body parser it sits behind and the largest
//    handler-capped input, and the two copies (src/ and the stdio package)
//    against each other.
//
//   node scripts/test-mcp-protocol-input-bound.js
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { getFreePort } from "./lib/free-port.js";
import * as hosted from "../src/mcp-flagship.js";
import * as stdio from "../mcp/output-schemas.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SUPPORTED_PROTOCOL_VERSIONS, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const MAX = hosted.MCP_MAX_TOOL_INPUT_ELEMENTS;
const series = (n, f = (i) => i % 10) => Array.from({ length: n }, (_, i) => f(i));

// --- the two copies agree ----------------------------------------------------
ok(MAX === stdio.MCP_MAX_TOOL_INPUT_ELEMENTS, `src and the stdio package carry the same bound (${MAX} / ${stdio.MCP_MAX_TOOL_INPUT_ELEMENTS})`);
const fixtures = [
  {}, [], 0, null, "s", { a: 1 }, [1, 2, 3], { a: [1, { b: 2, c: [3, 4] }], d: null },
  { slug: "x", params: { values: series(1000) } }, JSON.parse('{"__proto__":{"x":1},"y":2}'),
];
for (const f of fixtures) {
  ok(hosted.toolInputElementCount(f) === stdio.toolInputElementCount(f), `both copies count ${JSON.stringify(f).slice(0, 40)} the same (${hosted.toolInputElementCount(f)})`);
}
ok(hosted.toolInputElementCount({ a: [1, { b: 2, c: [3, 4] }], d: null }) === 8, "members and elements at every depth are counted (8)");
ok(hosted.toolInputElementCount({ big: series(10 * MAX) }) === MAX + 1, "counting stops one past the bound on a huge tree");
ok(hosted.toolInputBoundRefusal("t", { v: series(MAX - 1) }) === null, "an input at the bound passes (MAX - 1 elements + 1 member)");
ok(/^Invalid arguments for tool t: arguments contain more than the maximum of \d+ elements$/.test(hosted.toolInputBoundRefusal("t", { v: series(MAX) }) || ""), "one past the bound is refused with the SDK's wording");
ok(stdio.toolInputBoundRefusal("t", { v: series(MAX) }) === hosted.toolInputBoundRefusal("t", { v: series(MAX) }), "both copies word the refusal the same");

// --- the counting rule is the SDK's own --------------------------------------
// McpServer applies maxToolInputElements in its tools/call handler; drive one
// with a small bound and compare its verdicts to ours on the same inputs.
{
  const SMALL = 25;
  const sdk = new McpServer({ name: "sdk", version: "0" }, { maxToolInputElements: SMALL });
  sdk.registerTool("t", { inputSchema: undefined }, async () => ({ content: [{ type: "text", text: "ran" }] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await sdk.connect(a);
  const client = new Client({ name: "c", version: "0" });
  await client.connect(b);
  const shapes = [
    { v: series(SMALL - 1) }, { v: series(SMALL) }, { a: { b: { c: series(20) } }, d: [1, 2] },
    { a: { b: { c: series(21) } }, d: [1, 2] }, Object.fromEntries(series(SMALL, (i) => [`k${i}`, 1])),
    Object.fromEntries(series(SMALL + 1, (i) => [`k${i}`, 1])), { a: [[[[1, 2, 3]]]], b: series(18) },
  ];
  for (const s of shapes) {
    let sdkRefused = false;
    try {
      const r = await client.callTool({ name: "t", arguments: s });
      sdkRefused = r.isError === true && /more than the maximum/.test(r.content?.[0]?.text || "");
    } catch (e) { sdkRefused = /more than the maximum/.test(e.message); }
    const oursRefused = hosted.toolInputBoundRefusal("t", s, SMALL) !== null;
    ok(sdkRefused === oursRefused, `same verdict as the SDK's maxToolInputElements on a ${hosted.toolInputElementCount(s, 1e9)}-element input (refused: ${oursRefused})`);
  }
  await client.close();
}

// --- the bound fits the inputs and the parser in front of it -----------------
{
  const server = readFileSync(join(ROOT, "src/server.js"), "utf8");
  const m = server.match(/app\.use\(express\.json\(\{ limit: "(\d+)kb" \}\)\);/);
  ok(m, "the global JSON body parser is found in server.js");
  const parserBytes = Number(m?.[1]) * 1024;
  ok(MAX >= Math.floor(parserBytes / 2), `the bound (${MAX}) is at least the most elements a ${m?.[1]}kb body can carry at two bytes each (${Math.floor(parserBytes / 2)}), so it never refuses a body the parser accepts`);
  ok(server.indexOf(m?.[0]) >= 0 && server.indexOf(m?.[0]) < server.indexOf("mountMcp(app, CATALOG"), "/mcp is mounted behind that parser");
  // Largest handler-capped series input: three 10,000-value arrays.
  const stats = readFileSync(join(ROOT, "src/tools/stats-kit.js"), "utf8");
  const cap = Number(stats.match(/value\.length > (\d+)\) throw bad/)?.[1]);
  ok(cap === 10000, `the stats series cap is read from its handler (${cap})`);
  ok(MAX > 3 * cap + 10, `three capped series plus the call wrapper fit under the bound (${3 * cap + 10} < ${MAX})`);
  // Every schema-declared array bound is far below it.
  const srcFiles = ["src/server.js", ...readdirSync(join(ROOT, "src/tools")).filter((f) => f.endsWith(".js")).map((f) => `src/tools/${f}`)];
  const declared = srcFiles.flatMap((f) => [...readFileSync(join(ROOT, f), "utf8").matchAll(/maxItems:\s*([\d_]+)/g)].map((x) => Number(x[1].replace(/_/g, ""))));
  const maxItems = Math.max(0, ...declared);
  ok(maxItems < cap && cap < MAX, `the largest inputSchema maxItems (${maxItems}, ${declared.length} declared) is below the handler caps, which are below the bound`);
}

// --- hosted connector, booted --------------------------------------------------
const PORT = await getFreePort();
const B = `http://127.0.0.1:${PORT}`;
const proc = spawn("node", ["src/server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", STATE_DATABASE_URL: "", UPSTREAM_COSTS_JSON: "" },
  stdio: ["ignore", "ignore", "inherit"],
});
const kill = () => { try { proc.kill("SIGKILL"); } catch {} };
process.on("exit", kill);
let up = false;
for (let i = 0; i < 240 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch {} if (!up) await new Promise((r) => setTimeout(r, 500)); }
ok(up, "server booted");

const rpc = async (path, method, params, { version, id = 1 } = {}) => {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (version) headers["mcp-protocol-version"] = version;
  const res = await fetch(`${B}${path}`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  let body = null; try { body = JSON.parse(line ? line.slice(5) : text); } catch {}
  return { status: res.status, body };
};

{
  const init = await rpc("/mcp", "initialize", { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "modern", version: "1" } });
  const negotiated = init.body?.result?.protocolVersion;
  ok(init.status === 200 && init.body?.result?.serverInfo?.name === "agent402", `initialize with 2026-07-28 is answered (status ${init.status})`);
  ok(SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated), `it negotiates a version the server supports (${negotiated}; supported ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`);
  const list = await rpc("/mcp", "tools/list", undefined, { version: negotiated, id: 2 });
  const names = (list.body?.result?.tools || []).map((t) => t.name);
  ok(list.status === 200 && names.includes("catalog.call") && names.includes("catalog.search"), `tools/list under the negotiated version lists the catalog tools (${names.length} tools)`);
  const call = await rpc("/mcp", "tools/call", { name: "catalog.call", arguments: { slug: "hash", params: { text: "agent402", algorithm: "sha256" } } }, { version: negotiated, id: 3 });
  const text = call.body?.result?.content?.[0]?.text || "";
  ok(call.status === 200 && call.body?.result?.isError !== true && /[0-9a-f]{64}/.test(text), `a free tool runs under the negotiated version (${text.slice(0, 80)})`);
  const modern = await rpc("/mcp", "tools/list", undefined, { version: "2026-07-28", id: 4 });
  ok(modern.status === 400 && modern.body?.error?.code !== -32022, `a header-only 2026-07-28 request is a 400 without the modern -32022 error (code ${modern.body?.error?.code}), so a dual-era client falls back to initialize`);
}

{
  // The largest handler-capped input passes the bound end to end.
  const x = series(10000), y = x.map((v) => 2 * v + 1);
  const r = await rpc("/mcp", "tools/call", { name: "catalog.call", arguments: { slug: "linear-regression", params: { x, y, predict: series(10000) } } }, { id: 5 });
  ok(r.status === 200 && !r.body?.error && /slope/.test(r.body?.result?.content?.[0]?.text || ""), `three 10,000-value series (${hosted.toolInputElementCount({ slug: 1, params: { x, y, predict: x } })} elements) run on /mcp`);
}

// --- hosted handler with a small bound (the parser cap hides the default) ----
{
  const { mountMcp } = await import("../src/mcp-http.js");
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  const catalog = { "POST /api/echo": { slug: "echo", name: "echo", price: "$0.001", description: "echo", category: "test", route: "POST /api/echo", handler: async (i) => ({ n: Object.keys(i || {}).length }), discovery: { input: {} } } };
  mountMcp(app, catalog, { baseUrl: "http://t", isComputePayable: () => true, maxToolInputElements: 40 });
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/mcp`;
  const post = async (args) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "catalog.call", arguments: args } }) });
    const t = await res.text(); const line = t.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : t);
  };
  const under = await post({ slug: "echo", params: Object.fromEntries(series(38, (i) => [`k${i}`, 1])) });
  ok(!under.error, `at the bound (40 elements) the call goes through (${JSON.stringify(under).slice(0, 80)})`);
  const over = await post({ slug: "echo", params: Object.fromEntries(series(39, (i) => [`k${i}`, 1])) });
  ok(over.error?.code === ErrorCode.InvalidParams && /more than the maximum of 40 elements/.test(over.error?.message || ""), `one past it is InvalidParams before the tool runs (${over.error?.code} ${over.error?.message})`);
  srv.close();
}

// --- stdio package: no byte cap in front, so the bound is what refuses -------
{
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(ROOT, "mcp/index.js")], cwd: ROOT,
    env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", AGENT402_URL: B },
    stderr: "ignore",
  });
  const client = new Client({ name: "stdio-test", version: "0" });
  await client.connect(transport);
  let refused = null;
  try { await client.callTool({ name: "catalog.call", arguments: { slug: "stats-summary", params: { values: series(MAX) } } }); }
  catch (e) { refused = e; }
  ok(refused?.code === ErrorCode.InvalidParams && /more than the maximum of 51200 elements/.test(refused?.message || ""), `stdio refuses an over-bound argument tree with InvalidParams (${refused?.code} ${refused?.message?.slice(0, 90)})`);
  const r = await client.callTool({ name: "catalog.call", arguments: { slug: "stats-summary", params: { values: series(10000) } } });
  ok(r.isError !== true && /mean/.test(r.content?.[0]?.text || ""), `stdio forwards a capped 10,000-value series (${(r.content?.[0]?.text || "").slice(0, 60)})`);
  await client.close();
}

kill();
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
