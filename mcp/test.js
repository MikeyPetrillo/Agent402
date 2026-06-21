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
  for (const required of ["search_tools", "call_tool", "payment_info", "top_x402_sellers", "extract", "render", "hash", "memory-write"]) {
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

  // search_tools surfaces matching multi-tool workflow templates (skill packs)
  // so a task-shaped query also points the agent at the curated prompt — not
  // just at individual tools they'd have to stitch together themselves.
  const workflowSearch = await client.callTool({ name: "search_tools", arguments: { query: "security audit" } });
  if (!text(workflowSearch).includes("security-audit")) fail(`search_tools should recommend the security-audit workflow: ${text(workflowSearch).slice(0, 400)}`);
  if (!text(workflowSearch).includes("workflows")) fail(`search_tools response should include the workflows key: ${text(workflowSearch).slice(0, 400)}`);
  console.log("search_tools recommends matching workflow templates ✓");

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

  // top_x402_sellers: thin proxy over /api/leaderboard, free to call (no
  // payment / no PoW). Even when the leaderboard cache is warming (CI may run
  // before the first chain scan finishes) the envelope must be well-formed
  // and link back to the canonical /api/leaderboard.
  const sellers = await client.callTool({ name: "top_x402_sellers", arguments: { limit: 5, sort: "calls", include: "all" } });
  if (sellers.isError) fail(`top_x402_sellers should not error on warming cache: ${text(sellers).slice(0, 300)}`);
  const sellersJson = JSON.parse(text(sellers));
  if (sellersJson.sort !== "calls" || sellersJson.include !== "all") fail(`top_x402_sellers should echo sort+include (got sort=${sellersJson.sort}, include=${sellersJson.include})`);
  if (!Array.isArray(sellersJson.results) || sellersJson.results.length > 5) fail(`top_x402_sellers should honor limit (got ${sellersJson.results?.length} rows)`);
  if (typeof sellersJson.source !== "string" || !sellersJson.source.endsWith("/api/leaderboard")) fail(`top_x402_sellers should link to /api/leaderboard`);
  console.log("top_x402_sellers proxies the leaderboard with limit/sort/include ✓");

  // prompts/list: every skill pack registered with typed args; prompts/get
  // delegates rendering to the hosted service and substitutes args correctly.
  const { prompts } = await client.listPrompts();
  if (prompts.length < 6) fail(`prompts/list should expose >=6 skill packs, got ${prompts.length}`);
  const sa = prompts.find((p) => p.name === "security-audit");
  if (!sa) fail(`prompts/list should include "security-audit" (got: ${prompts.map((p) => p.name).join(", ")})`);
  if (!sa.arguments?.some((a) => a.name === "domain")) fail(`security-audit should declare "domain" argument`);
  console.log(`prompts/list → ${prompts.length} skill packs with typed arguments ✓`);

  const rendered = await client.getPrompt({ name: "security-audit", arguments: { domain: "stripe.com" } });
  const promptText = rendered.messages?.[0]?.content?.text ?? "";
  if (!promptText.includes("stripe.com")) fail(`prompts/get should substitute domain into text: ${promptText.slice(0, 300)}`);
  if (promptText.includes("example.com")) fail(`prompts/get should leave no unsubstituted placeholders: ${promptText.slice(0, 300)}`);
  if (!promptText.includes("cert-transparency")) fail(`prompts/get should name the tool plan: ${promptText.slice(0, 300)}`);
  console.log("prompts/get substitutes args and includes the tool plan ✓");

  // spend controls: refusals must happen BEFORE any payment is attempted, so a
  // throwaway (unfunded) key is safe here — no facilitator is ever contacted.
  const dummyKey = "0x" + "11".repeat(32);
  const capped = new Client({ name: "agent402-mcp-captest", version: "0.0.0" });
  await capped.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, "mcp", "index.js")],
    env: { ...process.env, AGENT402_URL: API, AGENT_KEY: dummyKey, AGENT402_MAX_PER_CALL: "0.0005", AGENT402_BUDGET: "0" },
  }));
  try {
    const refused = await capped.callTool({ name: "hash", arguments: { text: "x" } });
    if (!refused.isError || !text(refused).includes("Refused without paying")) {
      fail(`spend cap should refuse before paying: ${text(refused).slice(0, 300)}`);
    }
    console.log("spend controls refuse before any payment is signed ✓");
    const info2 = await capped.callTool({ name: "payment_info", arguments: {} });
    if (!text(info2).includes("spendControls") || !text(info2).includes("0.0005")) {
      fail(`payment_info should report spend controls: ${text(info2).slice(0, 300)}`);
    }
    console.log("payment_info reports spend controls ✓");
  } finally {
    await capped.close().catch(() => {});
  }

  console.log("\nMCP e2e: all assertions passed");
} finally {
  await client.close().catch(() => {});
  api.kill("SIGKILL");
}
process.exit(0);
