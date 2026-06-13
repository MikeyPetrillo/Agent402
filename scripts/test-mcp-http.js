// Exercise the remote MCP connector end to end over real HTTP JSON-RPC:
// initialize → tools/list → search_tools → call_tool (free CPU tool, exact
// output) → call_tool on a wallet-only tool (must refuse with guidance, not
// execute). Run against a server started with FREE_MODE or paid mode — the
// /mcp endpoint sits before the paywall either way.
const BASE = process.env.TARGET_URL || "http://localhost:3000";

let nextId = 1;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const ct = (res.headers.get("content-type") || "").split(";")[0];
  if (ct === "text/event-stream") {
    const text = await res.text();
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    return JSON.parse(data);
  }
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok - ${msg}`);
}

const init = await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "test-mcp-http", version: "0.0.0" },
});
assert(init.result?.serverInfo?.name === "agent402", `initialize returns serverInfo.name=agent402 (got ${JSON.stringify(init.result?.serverInfo)})`);

const list = await rpc("tools/list", {});
const names = (list.result?.tools ?? []).map((t) => t.name).sort();
assert(
  ["about_agent402", "call_tool", "search_tools"].every((n) => names.includes(n)),
  `tools/list exposes search_tools, call_tool, about_agent402 (got ${names.join(",")})`
);
assert(
  (list.result?.tools ?? []).every((t) => t.title && t.annotations?.readOnlyHint === true),
  "every tool carries a title + read-only safety annotations (directory requirement)"
);

const privacy = await fetch(`${BASE}/privacy`);
assert(privacy.ok && (await privacy.text()).includes("Privacy policy"), "/privacy serves the policy (directory requirement)");

const search = await rpc("tools/call", { name: "search_tools", arguments: { query: "kilometers to miles" } });
const searchText = search.result?.content?.[0]?.text ?? "";
assert(searchText.includes("convert-kilometers-to-miles"), "search_tools finds convert-kilometers-to-miles");

const call = await rpc("tools/call", {
  name: "call_tool",
  arguments: { slug: "convert-kilometers-to-miles", params: { value: 42 } },
});
const callText = call.result?.content?.[0]?.text ?? "";
assert(!call.result?.isError && callText.includes("26.097590074"), `free CPU tool executes with exact output (got ${callText.slice(0, 120)})`);

// LLM clients often stringify object args — params as a JSON string must still work.
const callStr = await rpc("tools/call", {
  name: "call_tool",
  arguments: { slug: "convert-kilometers-to-miles", params: '{"value": 42}' },
});
const callStrText = callStr.result?.content?.[0]?.text ?? "";
assert(!callStr.result?.isError && callStrText.includes("26.097590074"), `call_tool accepts params as a JSON string (got ${callStrText.slice(0, 120)})`);

const paid = await rpc("tools/call", { name: "call_tool", arguments: { slug: "render", params: { url: "https://example.com" } } });
const paidText = paid.result?.content?.[0]?.text ?? "";
assert(paid.result?.isError === true, "wallet-only tool (render) is refused on the free tier");
assert(paidText.includes("agent402-mcp") && paidText.includes("AGENT_KEY"), "refusal explains the paid path (agent402-mcp + AGENT_KEY)");
assert(!paidText.includes("<html"), "wallet-only tool did NOT execute");

const about = await rpc("tools/call", { name: "about_agent402", arguments: {} });
assert((about.result?.content?.[0]?.text ?? "").includes("x402"), "about_agent402 describes paid access via x402");

console.log("\nremote MCP connector: all checks passed");
