// test-mcp-client-check - scripts/mcp-client-check.js (the hosted connector
// read by an independent @modelcontextprotocol/sdk client) passes against a
// real FREE_MODE boot, and fails against a connector that drifted.
//
// The positive half boots src/server.js on PORT=0, reads the bound port back,
// and runs the check against it: exit 0, every check line ok, the JSON summary
// written. The negative half is the live control the positive half needs: a
// stub connector built on the same SDK (the shapes the check reads, nothing
// else) passes the check unchanged, and each deliberate break (a tool missing
// from tools/list, an empty description, a wrong free-tool answer) makes the
// check exit non-zero naming that check. Without the unchanged stub passing,
// a break's failure would prove nothing about the assertion it targets.
//
//   node scripts/test-mcp-client-check.js        (offline: no network, no spend)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { FLAGSHIP_OUTPUT_SCHEMAS, META_OUTPUT_SCHEMAS, outputSchemaFromExample } from "../src/mcp-flagship.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = join(ROOT, "scripts", "mcp-client-check.js");
const TMP = mkdtempSync(join(tmpdir(), "a402-mcp-client-check-"));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Asynchronous on purpose: the stub connectors below live in THIS process, so
// a blocking spawnSync would starve them and every check would time out.
function runCheck(baseUrl, outName) {
  const out = join(TMP, outName);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHECK], {
      env: { ...process.env, TARGET_URL: baseUrl, MCP_CHECK_TARGET: "", MCP_CHECK_OUT: out, MCP_CHECK_CALL_TIMEOUT_MS: "20000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 120_000);
    child.on("exit", (status) => {
      clearTimeout(timer);
      let summary = null;
      try { summary = JSON.parse(readFileSync(out, "utf8")); } catch { summary = null; }
      resolve({ status, stdout, stderr, summary });
    });
  });
}

// ------------------------------------------------- listed schemas compile

// The reference client compiles every listed outputSchema at tools/list and
// refuses the WHOLE listing on one bad schema. The hand-written tables and
// the schema inferred from a discovery example (the decide tools list that
// way, and only where the decide service is configured, so a local boot
// never lists them) must all compile under the SDK's own validator. The
// inferred shapes below include the one that reached production: an empty
// example array, whose item type was typeof undefined.
{
  const validator = new AjvJsonSchemaValidator();
  const compiles = (schema) => { try { validator.getValidator(schema); return null; } catch (err) { return err.message; } };
  const tables = { ...Object.fromEntries(Object.entries(FLAGSHIP_OUTPUT_SCHEMAS).map(([k, v]) => [`flagship ${k}`, v])), ...Object.fromEntries(Object.entries(META_OUTPUT_SCHEMAS).map(([k, v]) => [`meta ${k}`, v])) };
  const bad = Object.entries(tables).map(([k, s]) => [k, compiles(s)]).filter(([, e]) => e);
  ok(Object.keys(tables).length >= 10 && bad.length === 0, `every hand-written outputSchema compiles under the SDK validator (${Object.keys(tables).length} schemas)${bad.length ? `: ${bad.map(([k, e]) => `${k}: ${e}`).join("; ")}` : ""}`);
  const examples = {
    "empty array": { gaps: [] },
    "null field": { leftoverCredit: null },
    "array of objects": { steps: [{ step: 1 }] },
    "array of strings": { tags: ["a"] },
    "nested arrays": { rows: [[1, 2]] },
    "array with a null": { holes: [null] },
    "scalars and an object": { n: 1, s: "x", b: true, o: { k: 1 } },
    "not an object": "text",
  };
  const badEx = Object.entries(examples).map(([k, ex]) => [k, compiles(outputSchemaFromExample(ex))]).filter(([, e]) => e);
  ok(badEx.length === 0, `a schema inferred from a discovery example compiles for every example shape${badEx.length ? `: ${badEx.map(([k, e]) => `${k}: ${e}`).join("; ")}` : ""}`);
  const emptyArray = outputSchemaFromExample({ gaps: [] }).properties.gaps;
  ok(emptyArray.type === "array" && emptyArray.items === undefined, "an empty example array infers a typed array with no item type, never items.type \"undefined\"");
}

// ------------------------------------------------------------ real server

async function bootServer() {
  const child = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      FREE_MODE: "true",
      PORT: "0",
      X402_SYNC_ON_START: "false",
      X402_INDEX_CRAWL: "off",
      X402_PAYWALL_PROBES_PER_CYCLE: "0",
      AGENT402_TASK_DATA_DIR: join(TMP, "tasks"),
      AGENT402_MCP_MAX_PER_MIN: "1000000",
      AGENT402_SHOW_ROUTER: "1",
      AGENT402_MCP_MAX_PER_HOUR: "1000000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not listen within 120s\n${log.slice(-2000)}`)), 120_000);
    const onData = (d) => {
      log += d.toString();
      const m = log.match(/Agent402 listening on :(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code} before listening\n${log.slice(-2000)}`)); });
  });
  return { child, port };
}

{
  let child = null;
  try {
    const booted = await bootServer();
    child = booted.child;
    ok(booted.port > 0, `FREE_MODE server booted on PORT=0 and printed the bound port (${booted.port})`);
    const r = await runCheck(`http://127.0.0.1:${booted.port}`, "real.json");
    ok(r.status === 0, `the check exits 0 against the real connector${r.status === 0 ? "" : `\n${r.stdout}\n${r.stderr}`}`);
    const lines = r.stdout.split("\n").filter((l) => /^(ok|FAIL) - /.test(l));
    ok(lines.length >= 10 && lines.every((l) => l.startsWith("ok - ")), `every check line is ok (${lines.length} lines)`);
    ok(r.summary && r.summary.failed === 0 && r.summary.passed === lines.length && r.summary.target.endsWith("/mcp"), "the JSON summary matches the lines (passed, failed, target)");
    for (const name of ["initialize", "tools/list", "server.describe", "payment.info", "catalog.search", "catalog.find", "sellers.list", "catalog.call", "web.search without payment", "tasks"]) {
      ok((r.summary?.checks || []).some((c) => c.name.startsWith(name) && c.ok), `summary carries a passing "${name}" check`);
    }
  } catch (err) {
    ok(false, `real server: ${err.message}`);
  } finally {
    if (child) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  }
}

// ------------------------------------------------------------ stub control

const META_TOOLS = ["catalog.search", "catalog.find", "catalog.call", "payment.info", "server.describe", "sellers.list", "demand.request"];
const FLAGSHIP_TOOLS = ["web.search", "web.answer", "web.news", "browser.render", "market.quote", "audio.transcribe", "memory.read", "memory.write"];
const text = (obj, extra = {}) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], ...extra });

/** A connector that answers exactly the shapes the check reads. `brk` names one deliberate drift. */
function stubConnector(brk = null) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/mcp", async (req, res) => {
    const server = new Server({ name: "agent402", version: "stub" }, {
      capabilities: { tools: {} },
      instructions: "Stub connector for the client check: call catalog.find with your task, then catalog.call.",
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...META_TOOLS, ...FLAGSHIP_TOOLS]
        .filter((name) => !(brk === "missing-tool" && name === "demand.request"))
        .map((name) => ({
          name,
          description: brk === "empty-description" && name === "catalog.find" ? "" : `${name} on the stub connector.`,
          inputSchema: { type: "object", properties: {}, additionalProperties: true },
        })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      if (name === "server.describe") return text({ maintainer: "Havok Holdings LLC", startHere: { firstJob: "call catalog.find" } });
      if (name === "payment.info") return text({ freeTier: {}, pay: {} });
      if (name === "catalog.search") return text({ results: [{ slug: "unit-convert" }] });
      if (name === "catalog.find") return text({ results: [{ slug: "unit-convert", callWith: { name: "catalog.call", arguments: { slug: "unit-convert", params: {} } } }] });
      if (name === "sellers.list") return text({ results: [] });
      if (name === "catalog.call" && args.slug === "hash") {
        const hex = createHash("sha256").update(String(args.params?.text ?? "")).digest("hex");
        const result = { algo: "sha256", hex: brk === "wrong-answer" ? hex.split("").reverse().join("") : hex };
        return text(result, { structuredContent: { slug: "hash", result } });
      }
      if (name === "web.search") return { content: [{ type: "text", text: "search needs per-call payment: run npx agent402-mcp with AGENT_KEY." }], isError: true };
      return { content: [{ type: "text", text: `Unknown tool "${name}".` }], isError: true };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  return new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve({ listener, port: listener.address().port }));
  });
}

const EXPECTED_FAILS = {
  "missing-tool": /^FAIL - tools\/list: .*missing: demand\.request/m,
  "empty-description": /^FAIL - tools\/list: .*catalog\.find: empty description/m,
  "wrong-answer": /^FAIL - catalog\.call: /m,
};

{
  const stub = await stubConnector(null);
  const r = await runCheck(`http://127.0.0.1:${stub.port}`, "stub-control.json");
  ok(r.status === 0, `control: the unchanged stub connector passes the check${r.status === 0 ? "" : `\n${r.stdout}\n${r.stderr}`}`);
  stub.listener.close();
}
for (const [brk, re] of Object.entries(EXPECTED_FAILS)) {
  const stub = await stubConnector(brk);
  const r = await runCheck(`http://127.0.0.1:${stub.port}`, `stub-${brk}.json`);
  ok(r.status !== 0, `break "${brk}": the check exits non-zero`);
  ok(re.test(r.stdout), `break "${brk}": the failing line names the drifted check${re.test(r.stdout) ? "" : `\n${r.stdout}`}`);
  ok(r.summary && r.summary.failed >= 1, `break "${brk}": the JSON summary counts the failure`);
  stub.listener.close();
}

{
  // Nothing listening: a transport failure is a non-zero exit, never a hang.
  const probe = express().listen(0, "127.0.0.1");
  await new Promise((r) => probe.on("listening", r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const r = await runCheck(`http://127.0.0.1:${deadPort}`, "dead.json");
  ok(r.status !== 0 && /^FAIL - initialize/m.test(r.stdout), "an unreachable connector fails the initialize check and exits non-zero");
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\ntest-mcp-client-check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
