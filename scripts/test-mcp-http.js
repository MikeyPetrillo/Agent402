// Exercise the remote MCP connector end to end over real HTTP JSON-RPC:
// initialize → tools/list → search_tools → find_tool → call_tool (free CPU
// tool, exact output) → flagship wallet-only tool by name (must refuse with
// guidance, not execute). Run against a server started with FREE_MODE or paid
// mode — the /mcp endpoint sits before the paywall either way.
import { createHash } from "node:crypto";
import { FLAGSHIP_SLUGS, FLAGSHIP_MCP_NAMES } from "../src/mcp-flagship.js";

const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";

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
assert(
  typeof init.result?.instructions === "string" && init.result.instructions.includes("web.search") && init.result.instructions.includes("claude mcp add"),
  "initialize.instructions orients with web.search front door + install one-liners"
);

const list = await rpc("tools/list", {});
const names = (list.result?.tools ?? []).map((t) => t.name).sort();
// Flagship-first surface: meta discovery + demand SKUs. Glama's well-scoped
// band is ~3–15; keep the list tight and SWAP flagships rather than grow.
// Smithery Naming wants dotted domain.action names (not snake_case).
const META = [
  "catalog.search", "catalog.find", "catalog.call", "payment.info",
  "server.describe", "sellers.list", "demand.request",
];
const FLAGSHIP_NAMES = FLAGSHIP_SLUGS.map((s) => FLAGSHIP_MCP_NAMES[s] || s.replace(/-/g, "_"));
const EXPECTED_LIST = [...META, ...FLAGSHIP_NAMES].sort();
assert(
  names.length === EXPECTED_LIST.length && EXPECTED_LIST.every((n) => names.includes(n)),
  `tools/list is the flagship set (got ${names.length}: ${names.join(",")}; expected ${EXPECTED_LIST.join(",")})`
);
assert(
  names.length <= 16,
  `tools/list stays flagship-sized (<=16), got ${names.length}`
);
assert(
  !names.includes("generate_hash") && !names.includes("convert_units"),
  "old free-utility curated names are no longer listed (still route as aliases)"
);
assert(
  !names.includes("about_agent402") && !names.includes("top_x402_sellers") &&
    !names.includes("describe_agent402") && !names.includes("list_x402_sellers") &&
    !names.includes("search_web") && !names.includes("describe_server") &&
    !names.includes("search_tools") && !names.includes("call_tool"),
  "legacy snake/digit names are aliases only, not listed"
);
assert(
  names.every((n) => /^[a-z]+(\.[a-z]+)+$/.test(n)),
  "every listed tool name is dotted domain.action for Smithery Naming"
);
assert(
  (list.result?.tools ?? []).every((t) => t.title && typeof t.annotations?.readOnlyHint === "boolean"),
  "every tool carries a title + safety annotations (directory requirement)"
);
assert(
  (list.result?.tools ?? []).every((t) => t.outputSchema?.type === "object" && t.outputSchema?.properties && Object.keys(t.outputSchema.properties).length > 0),
  "every tool carries a named-field outputSchema (Smithery Capability Quality)"
);
assert(
  typeof init.result?.serverInfo?.description === "string" && init.result.serverInfo.description.length > 40,
  "initialize.serverInfo.description is set"
);
assert(
  typeof init.result?.serverInfo?.websiteUrl === "string" && init.result.serverInfo.websiteUrl.includes("http"),
  "initialize.serverInfo.websiteUrl is set"
);
// Writers: demand.request (wish) + memory.write (durable state). Everything else
// is read-only so clients that trust readOnlyHint are not misled.
const writers = (list.result?.tools ?? []).filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
assert(
  writers.length === 2 && writers.includes("demand.request") && writers.includes("memory.write"),
  `writers are demand.request + memory.write (got ${writers.join(",") || "none"})`
);

// Legacy free-utility aliases still route (not listed, but CallTool works).
for (const alias of ["convert_base64", "base64_convert", "base64"]) {
  const enc = await rpc("tools/call", { name: alias, arguments: { text: "hi", mode: "encode" } });
  const encText = enc.result?.content?.[0]?.text ?? "";
  assert(!enc.result?.isError && encText.includes("aGk="), `legacy alias "${alias}" still routes (got ${encText.slice(0, 80)})`);
}
// get_payment_info accepts its prior name too.
for (const alias of ["get_payment_info", "payment_info"]) {
  const pi = await rpc("tools/call", { name: alias, arguments: {} });
  assert(!pi.result?.isError && (pi.result?.content?.[0]?.text ?? "").includes("freeTier"), `payment info routes via "${alias}"`);
}

const privacy = await fetch(`${BASE}/privacy`);
assert(privacy.ok && (await privacy.text()).includes("Privacy policy"), "/privacy serves the policy (directory requirement)");

const search = await rpc("tools/call", { name: "search_tools", arguments: { query: "convert kilometers to miles" } });
const searchText = search.result?.content?.[0]?.text ?? "";
assert(searchText.includes("unit-convert"), "search_tools finds long-tail unit-convert");

// Front-door bias: search the web → search slug near the top.
const webSearch = await rpc("tools/call", { name: "search_tools", arguments: { query: "search the web for x402 adoption" } });
const webText = webSearch.result?.content?.[0]?.text ?? "";
assert(webText.includes('"slug": "search"') || webText.includes('"slug":"search"'), `search_tools front-door lands on search (got ${webText.slice(0, 200)})`);

// find_tool: resolve a plain-language task to a ready-to-call tool.
const find = await rpc("tools/call", { name: "find_tool", arguments: { task: "convert kilometers to miles", limit: 3 } });
const findText = find.result?.content?.[0]?.text ?? "";
assert(!find.result?.isError && findText.includes("unit-convert") && findText.includes("callWith"), "find_tool resolves a long-tail task with a ready call_tool invocation");
const findParsed = (() => { try { return JSON.parse(findText); } catch { return null; } })();
const findTop = findParsed?.results?.[0];
assert(findTop && Array.isArray(findTop.required), `find_tool top result carries required:[] (got ${JSON.stringify(findTop?.required)})`);
const findKeys = findTop ? Object.keys(findTop) : [];
assert(findKeys.indexOf("callWith") < findKeys.indexOf("description") && findKeys.indexOf("example") < findKeys.indexOf("description"), `callWith + example come before description (keys: ${findKeys.join(",")})`);

// Front-door find: "answer this question with citations" → answer
const findAnswer = await rpc("tools/call", { name: "find_tool", arguments: { task: "answer this question with citations: what is x402?", limit: 3 } });
const findAnswerText = findAnswer.result?.content?.[0]?.text ?? "";
assert(findAnswerText.includes('"slug": "answer"') || findAnswerText.includes('"slug":"answer"'), `find_tool front-door lands on answer (got ${findAnswerText.slice(0, 240)})`);

const call = await rpc("tools/call", {
  name: "call_tool",
  arguments: { slug: "unit-convert", params: { value: 42, from: "kilometers", to: "miles" } },
});
const callText = call.result?.content?.[0]?.text ?? "";
assert(!call.result?.isError && callText.includes("26.097590074"), `free CPU tool executes with exact output (got ${callText.slice(0, 120)})`);

const callStr = await rpc("tools/call", {
  name: "call_tool",
  arguments: { slug: "unit-convert", params: '{"value": 42, "from": "kilometers", "to": "miles"}' },
});
const callStrText = callStr.result?.content?.[0]?.text ?? "";
assert(!callStr.result?.isError && callStrText.includes("26.097590074"), `call_tool accepts params as a JSON string (got ${callStrText.slice(0, 120)})`);

// Flagship wallet-only by name → refused, never executed for free.
//
// TWO LEGITIMATE REFUSAL SHAPES, because the connector answers differently
// depending on whether the target has MPP_SECRET_KEY set:
//
//   • native MPP (prod): JSON-RPC error -32042 carrying payment challenges, so
//     the caller can pay in-band.
//   • no MPP (a FREE_MODE instance, a self-host without the key): a result with
//     isError and prose pointing at agent402-mcp + AGENT_KEY.
//
// This asserted ONLY the second, so it failed against production from the day
// native MPP landed on /mcp (2026-08-19) and nobody saw it for five days: the
// deploy step that runs it was continue-on-error, so it printed into a green
// log. It surfaced within one run of that step becoming a real gate.
//
// What both shapes must prove is the SAME thing, and it is the only thing that
// matters here: the tool did not run for free.
const paid = await rpc("tools/call", { name: "web.search", arguments: { q: "x402" } });
const paidText = paid.result?.content?.[0]?.text ?? "";
const mppRefusal = paid.error?.code === -32042;
const legacyRefusal = paid.result?.isError === true;
assert(mppRefusal || legacyRefusal,
  `flagship wallet-only tool (web.search) is refused on the free tier (got ${JSON.stringify(paid).slice(0, 140)})`);
if (mppRefusal) {
  assert(Array.isArray(paid.error?.data?.challenges) && paid.error.data.challenges.length > 0,
    "the MPP refusal carries payment challenges, so a caller can actually pay it");
  assert(paid.error.data?.httpStatus === 402, "and reports the 402 it came from");
} else {
  assert(paidText.includes("agent402-mcp") && paidText.includes("AGENT_KEY"),
    "the non-MPP refusal explains the paid path (agent402-mcp + AGENT_KEY)");
}
// The bypass check, and it holds for either shape: no search results came back.
assert(!paidText.includes("<html") && !/"results"\s*:/.test(paidText),
  "wallet-only tool did NOT execute");

// describe_server (+ prior describe_agent402 / about_agent402 aliases).
for (const aboutName of ["server.describe", "describe_server", "describe_agent402", "about_agent402"]) {
  const about = await rpc("tools/call", { name: aboutName, arguments: {} });
  const aboutText = about.result?.content?.[0]?.text ?? "";
  assert(!about.result?.isError, `${aboutName} succeeds`);
  assert(aboutText.includes("firstJob") && aboutText.includes("search"), `${aboutName} leads with search/answer front door`);
  assert(aboutText.includes("Havok Holdings LLC"), `${aboutName} credits Havok Holdings LLC`);
  assert(aboutText.includes("claude mcp add") && aboutText.includes("cursorMcpJson"), `${aboutName} includes install one-liners`);
  assert(aboutText.includes("500+"), `${aboutName} uses evergreen 500+ count`);
  assert(!aboutText.includes("generate_hash"), `${aboutName} does not advertise removed curated utilities`);
  assert(about.result?.structuredContent?.service, `${aboutName} returns structuredContent`);
  // Regression: firstJob once named a real competitor ("Agent402 is the
  // tools layer beside LLM gateways") in this
  // live, agent-served response - a direct violation of the project's own
  // "we deliberately do not name competing sellers anywhere in user-facing
  // copy" rule (src/economy.js). Found in a link/leak audit, not by any
  // existing test. Locks the whole about/describe response text, not just
  // firstJob, since any field here is equally "live positioning copy".
  // The blocklist is carried as sha256(lowercased name) so the repository
  // itself does not carry the names; every token and adjacent-token pair of
  // the live text is hashed and compared.
  const BLOCKED = new Set(["2730e2594becc4582df422b58e9d3359fbd1d7b82d53d1ad5636c5e3ec45b354", "01c3da860e982239f3184399b0351e6df3ee44b2ca9e3cc92d4abc2ece515121", "72ab0dc27727ed4346174222e725411b078852148334449c88cb4fd0ecdf9057", "3b052c232320e46ee0898092758e0bbb07190328a61a0ee5d2c6fd120f47c9e7", "9f102ed2e830dfd78882522cbf76d69907480812ec6ca53890f50e8242894e7a", "9ec9140c50bf098e9feea4d8d28ece7c224a260f0b8e98ebbce30f424ad931a7"]);
  const toks = aboutText.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const grams = [...toks, ...toks.slice(0, -1).map((t, i) => `${t} ${toks[i + 1]}`)];
  const hit = grams.find((g) => BLOCKED.has(createHash("sha256").update(g).digest("hex")));
  assert(!hit, `${aboutName} names a third-party seller ("${hit}") in its positioning copy`);
}

// Sample listed tool: catalog.search outputSchema + structuredContent.
const searchToolDef = (list.result?.tools ?? []).find((t) => t.name === "catalog.search");
assert(searchToolDef?.outputSchema?.properties?.results, "catalog.search lists outputSchema.properties.results");
assert(search.result?.structuredContent?.results, "catalog.search call returns structuredContent.results");

// sellers.list wire=mpp: the MPP leaderboard behind the same tool (2026-08-18).
// The board may still be warming in CI (first on-chain read is +120s after
// boot), so the shape is asserted, never a non-empty ranking.
{
  const def = (list.result?.tools ?? []).find((t) => t.name === "sellers.list");
  assert(def?.inputSchema?.properties?.wire?.enum?.includes("mpp"), "sellers.list advertises the wire parameter with mpp");
  const mpp = await rpc("tools/call", { name: "sellers.list", arguments: { wire: "mpp", limit: 5 } });
  const sc = mpp.result?.structuredContent;
  assert(!mpp.result?.isError && sc, "sellers.list wire=mpp succeeds with structuredContent");
  assert(sc.wire === "mpp" && Array.isArray(sc.results) && /mpp-leaderboard/.test(sc.source || "") && /Tempo/.test(sc.measure || ""), "wire=mpp result: wire, results[], source=/api/mpp-leaderboard, measure names Tempo");
  assert(sc.results.every((r) => typeof r.wallet === "string" && r.network === "eip155:4217" && typeof r.routable === "boolean"), "wire=mpp rows carry recipient wallet, Tempo network, routable flag");
  const x402 = await rpc("tools/call", { name: "sellers.list", arguments: { limit: 3 } });
  assert(!x402.result?.isError && Array.isArray(x402.result?.structuredContent?.results) && !x402.result?.structuredContent?.wire, "default wire (x402) is unchanged");
}

console.log("\nremote MCP connector: all checks passed");
