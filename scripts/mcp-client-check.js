// mcp-client-check - the hosted MCP connector read by an independent, minimal
// client: the reference @modelcontextprotocol/sdk Client over its Streamable
// HTTP transport, nothing from src/. Our own harness (scripts/test-mcp-http.js,
// scripts/test-mcp-all.js) posts raw JSON-RPC and reads whatever comes back; a
// real client parses the initialize result, validates every tool's schemas,
// and rejects a structuredContent that does not match the listed outputSchema.
// This is the view a host like Claude, Cursor or an SDK-built agent gets, so
// it is the one a drift in tool names, descriptions or answer shapes would
// break first.
//
// What it does, in order (a handful of calls, like the heartbeat):
//   initialize; tools/list (every expected dotted name, a non-empty
//   description, an object inputSchema); server.describe; payment.info;
//   catalog.search; catalog.find; sellers.list; one free pure-CPU tool through
//   catalog.call (hash, checked against node:crypto); a wallet-only flagship
//   without payment (must answer a payment pointer, never run and never crash);
//   and the MCP Tasks extension's wire (an unknown task id and an undeclared
//   capability answer the codes the extension pins) where it is advertised.
// It spends nothing: the free tool runs on the free tier, the paid call carries
// no credential, and a task is never created without a settled paywall.
//
//   TARGET_URL=http://127.0.0.1:3000 node scripts/mcp-client-check.js
//   MCP_CHECK_TARGET=prod node scripts/mcp-client-check.js   (https://agent402.tools)
//   MCP_CHECK_OUT=/path/summary.json   writes a short JSON summary
//
// Prints one line per check (`ok - ...` / `FAIL - ...`) and exits non-zero on
// any failure, a transport failure included.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError, ResultSchema } from "@modelcontextprotocol/sdk/types.js";

const PROD_URL = "https://agent402.tools";
const base = (process.env.MCP_CHECK_TARGET || "").trim().toLowerCase() === "prod"
  ? PROD_URL
  : (process.env.TARGET_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const MCP_URL = new URL(`${base}/mcp`);
const PER_CALL_MS = Number(process.env.MCP_CHECK_CALL_TIMEOUT_MS) || 30_000;
const TOTAL_MS = Number(process.env.MCP_CHECK_TOTAL_TIMEOUT_MS) || 180_000;

// The listed surface as a client sees it (src/mcp-http.js lists these; the
// decide tools appear only on an instance with the decide service, so they are
// not required here).
const META_TOOLS = ["catalog.search", "catalog.find", "catalog.call", "payment.info", "server.describe", "sellers.list", "demand.request"];
const FLAGSHIP_TOOLS = ["web.search", "web.answer", "web.news", "browser.render", "market.quote", "audio.transcribe", "memory.read", "memory.write"];
const EXPECTED_TOOLS = [...META_TOOLS, ...FLAGSHIP_TOOLS];

const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
const TASK_INVALID_PARAMS = -32602;
const TASK_MISSING_CAPABILITY = -32021;
const METHOD_NOT_FOUND = -32601;
const MPP_PAYMENT_REQUIRED_CODES = new Set([-32042, -32043]);
const MPP_PAYMENT_REQUIRED_META = "org.paymentauth/payment-required";

const checks = [];
function record(name, ok, detail = "") {
  checks.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? "ok" : "FAIL"} - ${name}${!ok && detail ? `: ${detail}` : ""}`);
  return ok;
}
async function check(name, fn) {
  try {
    const detail = await fn();
    return record(name, true, typeof detail === "string" ? detail : "");
  } catch (err) {
    return record(name, false, String(err?.message || err).slice(0, 300));
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** The text answer of a tool result: content[0] is text, the text parses as JSON, no isError. */
function jsonAnswer(result, name) {
  assert(result && typeof result === "object", `${name}: no result object`);
  assert(result.isError !== true, `${name}: isError=true (${String(result.content?.[0]?.text || "").slice(0, 120)})`);
  assert(Array.isArray(result.content) && result.content.length > 0, `${name}: empty content`);
  assert(result.content[0].type === "text", `${name}: content[0].type is ${result.content[0].type}, not text`);
  let parsed;
  try { parsed = JSON.parse(result.content[0].text); } catch { throw new Error(`${name}: content[0].text is not JSON (${String(result.content[0].text).slice(0, 80)})`); }
  assert(parsed && typeof parsed === "object", `${name}: JSON answer is not an object`);
  return parsed;
}

function finish(fatal = null) {
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  const summary = {
    target: MCP_URL.toString(),
    at: new Date().toISOString(),
    client: "@modelcontextprotocol/sdk streamable-http",
    server: serverVersion,
    passed,
    failed,
    ...(fatal ? { fatal } : {}),
    checks,
  };
  const out = (process.env.MCP_CHECK_OUT || "").trim();
  if (out) { try { writeFileSync(out, JSON.stringify(summary, null, 2) + "\n"); } catch (err) { console.error(`could not write ${out}: ${err.message}`); } }
  console.log(`\nmcp-client-check: ${passed} passed, ${failed} failed against ${MCP_URL}${fatal ? ` (${fatal})` : ""}`);
  process.exit(failed === 0 && !fatal ? 0 : 1);
}

let serverVersion = null;
const totalTimer = setTimeout(() => { record("completes within the time budget", false, `${TOTAL_MS}ms elapsed`); finish("timed out"); }, TOTAL_MS);
totalTimer.unref?.();

const client = new Client({ name: "agent402-mcp-client-check", version: "1.0.0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(MCP_URL);
const opts = { timeout: PER_CALL_MS };
const callTool = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, opts);

// 1. initialize
const connected = await check("initialize: serverInfo.name is agent402, instructions and tools capability present", async () => {
  await client.connect(transport, opts);
  const info = client.getServerVersion();
  serverVersion = info ? { name: info.name, version: info.version } : null;
  assert(info?.name === "agent402", `serverInfo.name is ${JSON.stringify(info?.name)}`);
  const instructions = client.getInstructions();
  assert(typeof instructions === "string" && instructions.length > 40, "instructions missing or empty");
  const caps = client.getServerCapabilities() || {};
  assert(caps.tools, "capabilities.tools missing");
  return `build ${info.version}`;
});
if (!connected) finish("could not initialize");

// 2. tools/list
let listed = [];
await check("tools/list: every expected dotted tool is listed with a description and an object inputSchema", async () => {
  const { tools } = await client.listTools(undefined, opts);
  listed = tools;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const missing = EXPECTED_TOOLS.filter((n) => !byName.has(n));
  assert(missing.length === 0, `missing: ${missing.join(", ")} (listed: ${tools.map((t) => t.name).join(", ")})`);
  const bad = [];
  for (const t of tools) {
    if (typeof t.description !== "string" || !t.description.trim()) bad.push(`${t.name}: empty description`);
    if (!t.inputSchema || t.inputSchema.type !== "object") bad.push(`${t.name}: inputSchema.type is ${JSON.stringify(t.inputSchema?.type)}`);
    if (!/^[a-z]+(\.[a-z]+)+$/.test(t.name)) bad.push(`${t.name}: not a dotted name`);
  }
  assert(bad.length === 0, bad.join("; "));
  return `${tools.length} tools`;
});

// 3. server.describe
await check("server.describe: JSON answer naming the maintainer and the first job", async () => {
  const j = jsonAnswer(await callTool("server.describe"), "server.describe");
  assert(typeof j.maintainer === "string" && j.maintainer.includes("Havok Holdings LLC"), "maintainer missing");
  assert(typeof j.startHere?.firstJob === "string" && j.startHere.firstJob.length > 0, "startHere.firstJob missing");
});

// 4. payment.info
await check("payment.info: JSON answer with freeTier and pay", async () => {
  const j = jsonAnswer(await callTool("payment.info"), "payment.info");
  assert(j.freeTier && typeof j.freeTier === "object", "freeTier missing");
  assert(j.pay && typeof j.pay === "object", "pay missing");
});

// 5. catalog.search
await check("catalog.search: a unit-conversion query returns results that include unit-convert", async () => {
  const j = jsonAnswer(await callTool("catalog.search", { query: "convert kilometers to miles" }), "catalog.search");
  assert(Array.isArray(j.results) && j.results.length > 0, "results empty");
  assert(j.results.some((r) => r.slug === "unit-convert"), `unit-convert not among ${j.results.map((r) => r.slug).join(", ")}`);
});

// 6. catalog.find
await check("catalog.find: a task phrase resolves to a ready catalog.call invocation", async () => {
  const j = jsonAnswer(await callTool("catalog.find", { task: "convert kilometers to miles", limit: 3 }), "catalog.find");
  assert(Array.isArray(j.results) && j.results.length > 0, "results empty");
  const top = j.results[0];
  assert(top.slug === "unit-convert", `top pick is ${top.slug}`);
  assert(top.callWith?.name === "catalog.call" && top.callWith?.arguments?.slug === top.slug, "callWith is not a catalog.call invocation");
});

// 7. sellers.list (the board may still be warming on a fresh boot: shape only)
await check("sellers.list: JSON answer with a results array", async () => {
  const j = jsonAnswer(await callTool("sellers.list", { limit: 3 }), "sellers.list");
  assert(Array.isArray(j.results), "results is not an array");
  return `${j.results.length} rows`;
});

// 8. one free pure-CPU tool through catalog.call
await check("catalog.call: the free hash tool runs on the free tier and matches node:crypto", async () => {
  const text = "hello world";
  const expected = createHash("sha256").update(text).digest("hex");
  const r = await callTool("catalog.call", { slug: "hash", params: { text, algo: "sha256" } });
  const j = jsonAnswer(r, "catalog.call hash");
  assert(j.hex === expected, `hex is ${j.hex}`);
  assert(r.structuredContent?.result?.hex === expected, "structuredContent.result.hex does not match");
});

// 9. a wallet-only flagship without payment: a payment pointer, never a run
await check("web.search without payment: answers a payment pointer (challenges or the paid path), does not run", async () => {
  let r;
  try {
    r = await callTool("web.search", { q: "x402" });
  } catch (err) {
    // Native MPP on the connector: a JSON-RPC error carrying the challenges.
    assert(err instanceof McpError && MPP_PAYMENT_REQUIRED_CODES.has(err.code), `unexpected error: ${err?.message}`);
    assert(Array.isArray(err.data?.challenges) && err.data.challenges.length > 0, "payment error carries no challenges");
    return `JSON-RPC ${err.code} with ${err.data.challenges.length} challenge(s)`;
  }
  const text = String(r.content?.[0]?.text || "");
  assert(r.isError === true, "the call ran without payment");
  assert(!/"results"\s*:/.test(text) && !text.includes("<html"), "the answer carries search results");
  const challenges = r._meta?.[MPP_PAYMENT_REQUIRED_META];
  const namesPaidPath = /agent402-mcp|AGENT_KEY|MPP|x402/.test(text);
  assert(challenges || namesPaidPath, `neither challenges nor a paid path named: ${text.slice(0, 120)}`);
  return challenges ? "isError result with MPP challenges in _meta" : "isError result naming the paid path";
});

// 10. MCP Tasks extension wire, where advertised (a task only carries a paid
// run, so an instance without a paid path does not advertise it).
{
  const caps = client.getServerCapabilities() || {};
  const advertised = Boolean(caps.extensions?.[TASKS_EXTENSION]);
  const taskGet = (declare) => client.request({
    method: "tasks/get",
    params: { taskId: "0".repeat(48), ...(declare ? { _meta: { [CLIENT_CAPABILITIES_META]: { extensions: { [TASKS_EXTENSION]: {} } } } } : {}) },
  }, ResultSchema, opts);
  const codeOf = async (p) => { try { await p; return null; } catch (err) { return err instanceof McpError ? err.code : `thrown: ${err?.message}`; } };
  if (advertised) {
    await check("tasks: an unknown task id answers the extension's invalid-params code", async () => {
      const code = await codeOf(taskGet(true));
      assert(code === TASK_INVALID_PARAMS, `got ${code}`);
    });
    await check("tasks: a request that did not declare the extension answers the missing-capability code", async () => {
      const code = await codeOf(taskGet(false));
      assert(code === TASK_MISSING_CAPABILITY, `got ${code}`);
    });
  } else {
    await check("tasks: not advertised here (no paid path), and tasks/get is method-not-found rather than half-wired", async () => {
      const code = await codeOf(taskGet(true));
      assert(code === METHOD_NOT_FOUND, `got ${code}`);
    });
  }
}

try { await client.close(); } catch { /* the transport is stateless */ }
clearTimeout(totalTimer);
finish();
