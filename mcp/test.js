// End-to-end test of the Agent402 MCP server: spawns a paywalled API instance
// (x402 active, facilitator never contacted) plus the MCP server over stdio,
// and drives it with a real MCP client. Asserts the wallet-less path: catalog
// loads, search works, proof-of-work settles a call, wallet-only tools fail
// with guidance instead of crashing.
//
//   node mcp/test.js          (run from the repo root)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3005;
const API = `http://localhost:${PORT}`;

const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };
const text = (result) => result.content?.map((c) => (c.type === "text" ? c.text : `<${c.type}>`)).join("\n") ?? "";

// 1) Boot a paywalled API instance (PoW gate live, facilitator not contacted).
const api = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    NETWORK: "base",
    FACILITATOR_URL: "https://facilitator.payai.network",
    X402_SYNC_ON_START: "false",
    POW_DIFFICULTY: "12",
    PORT: String(PORT),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
let up = false;
for (let i = 0; i < 30 && !up; i++) {
  up = await fetch(`${API}/health`).then((r) => r.ok).catch(() => false);
  if (!up) await new Promise((r) => setTimeout(r, 1000));
}
if (!up) fail("API instance did not become healthy");

// 2) Connect a real MCP client to the server over stdio (no AGENT_KEY → PoW mode).
const env = { ...process.env, AGENT402_URL: API };
delete env.AGENT_KEY;
const client = new Client({ name: "agent402-mcp-test", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "mcp", "index.js")], env }));

try {
  // tools/list: curated + meta tools present, catalog NOT dumped wholesale
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const required of ["search_tools", "call_tool", "payment_info", "extract", "render", "hash", "memory-write"]) {
    if (!names.includes(required)) fail(`tools/list missing "${required}" (got: ${names.join(", ")})`);
  }
  if (tools.length > 30) fail(`tools/list too large (${tools.length}) — must stay curated, not dump the catalog`);
  const hashTool = tools.find((t) => t.name === "hash");
  if (!hashTool.inputSchema?.properties?.text) fail("hash tool lost its input schema");
  console.log(`tools/list → ${tools.length} tools, curated set + search/call/payment_info ✓`);

  // search_tools finds catalog tools that are not first-class
  const search = await client.callTool({ name: "search_tools", arguments: { query: "convert miles to kilometers" } });
  if (!text(search).includes("convert-miles-to-kilometers")) fail(`search_tools missed the conversion tool: ${text(search).slice(0, 300)}`);
  console.log("search_tools finds long-tail catalog tools ✓");

  // first-class tool, no wallet → settles via proof-of-work
  const hashed = await client.callTool({ name: "hash", arguments: { text: "hello world" } });
  if (hashed.isError || !text(hashed).includes("b94d27b9")) fail(`PoW-paid hash call wrong: ${text(hashed).slice(0, 300)}`);
  console.log("first-class call settled with proof-of-work ✓");

  // call_tool reaches the long tail with payment handled
  const converted = await client.callTool({ name: "call_tool", arguments: { slug: "convert-miles-to-kilometers", params: { value: 10 } } });
  if (converted.isError || !text(converted).includes("16.09344")) fail(`call_tool conversion wrong: ${text(converted).slice(0, 300)}`);
  console.log("call_tool long-tail call settled with proof-of-work ✓");

  // wallet-only tool without a key → helpful error, not a crash
  const render = await client.callTool({ name: "render", arguments: { url: "https://example.com" } });
  if (!render.isError || !text(render).includes("AGENT_KEY")) fail(`wallet-only tool should explain AGENT_KEY: ${text(render).slice(0, 300)}`);
  console.log("wallet-only tool returns funding guidance without a key ✓");

  // payment_info reports the mode honestly
  const info = await client.callTool({ name: "payment_info", arguments: {} });
  if (!text(info).includes("proof-of-work")) fail(`payment_info should report proof-of-work mode: ${text(info).slice(0, 300)}`);
  console.log("payment_info reports proof-of-work mode ✓");

  console.log("\nMCP e2e: all assertions passed");
} finally {
  await client.close().catch(() => {});
  api.kill("SIGKILL");
}
process.exit(0);
