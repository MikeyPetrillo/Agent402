// Exercise the remote MCP connector end to end over real HTTP JSON-RPC:
// initialize → tools/list → search_tools → find_tool → call_tool (free CPU
// tool, exact output) → flagship wallet-only tool by name (must refuse in a
// shape the connector serves, not execute). Run against a server started with
// FREE_MODE or paid mode; against a local target it also boots a paid server
// (paywall and MPP gates) and reads the same refusal there.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
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
// A flagship whose route is absent from this server's catalog (the decide
// tools without the decide service) is not listed, by design.
const pricingDoc = await (await fetch(`${BASE}/api/pricing`)).json().catch(() => ({}));
const served = JSON.stringify(pricingDoc);
const inCatalog = (slug) => slug !== "decide" && slug !== "decide-execute" ? true : served.includes(slug === "decide" ? '"/api/decide"' : '"/api/decide/execute"');
// decide.feedback (free, no catalog route) is listed alongside the decide tools.
// Hosts truncate or skip long descriptions: every listed one stays within 400 characters.
for (const t of (list.result?.tools ?? [])) assert((t.description || "").length <= 400, `${t.name} description is ${(t.description || "").length} characters (limit 400)`);
// sellers.list is listed only when the connector opts in (AGENT402_SHOW_ROUTER=1).
const EXPECTED_META = process.env.AGENT402_SHOW_ROUTER === "1" ? META : META.filter((n) => n !== "sellers.list");
const EXPECTED_LIST = [...EXPECTED_META, ...FLAGSHIP_SLUGS.filter(inCatalog).map((s) => FLAGSHIP_MCP_NAMES[s] || s.replace(/-/g, "_")), ...(inCatalog("decide") && served.includes('"/api/decide"') ? ["decide.feedback"] : [])].sort();
assert(
  names.length === EXPECTED_LIST.length && EXPECTED_LIST.every((n) => names.includes(n)),
  `tools/list is the flagship set (got ${names.length}: ${names.join(",")}; expected ${EXPECTED_LIST.join(",")})`
);
// 16, plus the three decide tools when the decide service is configured.
const SIZE_CAP = 16 + (served.includes('"/api/decide"') ? 3 : 0);
assert(
  names.length <= SIZE_CAP,
  `tools/list stays flagship-sized (<=${SIZE_CAP}), got ${names.length}`
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
// A host may run a read-only tool without asking its user, so readOnlyHint is
// true only for a tool that cannot charge here and writes nothing. "Can
// charge" is derived, never listed: a flagship charges unless its slug is in
// the connector's free table (isComputePayable, the proof-of-work allowlist
// less the wallet-only set); catalog.call charges when any catalog entry
// does; a tool with no catalog entry has no paid route to reach.
const tool = (n) => (list.result?.tools ?? []).find((t) => t.name === n);
const mppHere = !!init.result?.capabilities?.experimental?.payment;
const slugOfName = Object.fromEntries(Object.entries(FLAGSHIP_MCP_NAMES).map(([slug, n]) => [n, slug]));
// The free table is read from the server under test (/api/pricing marks each
// entry computePayable), not imported from src/pow.js: the deploy job runs this
// suite against production from an install with no native modules built.
const pricedSlugs = (pricingDoc.endpoints ?? []).map((e) => e.slug).filter(Boolean);
assert(pricedSlugs.length > 100, `the pricing document lists the catalog's slugs (${pricedSlugs.length})`);
const freeSlugs = new Set((pricingDoc.endpoints ?? []).filter((e) => e.computePayable === true).map((e) => e.slug));
assert(freeSlugs.size > 0 && freeSlugs.size < pricedSlugs.length, `the pricing document marks the proof-of-work tools (${freeSlugs.size} of ${pricedSlugs.length})`);
const isComputePayable = ({ slug }) => freeSlugs.has(slug);
const anyPaidSlug = pricedSlugs.some((slug) => !isComputePayable({ slug }));
const canCharge = (n) => (n === "catalog.call" ? anyPaidSlug : n in slugOfName ? !isComputePayable({ slug: slugOfName[n] }) : false);
// The free tools that leave a row behind (a recorded request, a step verdict).
const FREE_WRITERS = new Set(["demand.request", "decide.feedback"]);
const NET_HINTS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
let chargers = 0;
for (const t of (list.result?.tools ?? [])) {
  const charges = canCharge(t.name);
  if (charges) chargers++;
  const wantReadOnly = !charges && !FREE_WRITERS.has(t.name);
  assert(t.annotations.readOnlyHint === wantReadOnly, `${t.name} readOnlyHint is ${wantReadOnly} (${charges ? "can charge" : FREE_WRITERS.has(t.name) ? "free, writes" : "free, writes nothing"}; got ${t.annotations.readOnlyHint})`);
  if (wantReadOnly) assert(t.annotations.destructiveHint === false, `${t.name} is read-only and not destructive`);
  // A flagship that can charge carries the network hints, memory.write aside (checked below).
  if (charges && t.name in slugOfName && t.name !== "memory.write") {
    for (const [k, v] of Object.entries(NET_HINTS)) assert(t.annotations[k] === v, `${t.name} ${k} is ${v} (got ${t.annotations[k]})`);
  }
}
assert(chargers >= 2 && canCharge("web.search") && canCharge("memory.read") && !canCharge("catalog.search"), `the derivation finds the tools that can charge (${chargers})`);
assert(tool("catalog.search")?.annotations.readOnlyHint === true && tool("web.search")?.annotations.readOnlyHint === false, "catalog.search is read-only and web.search is not");
void served;
{
  const ann = tool("memory.write")?.annotations || {};
  assert(ann.readOnlyHint === false && ann.destructiveHint === true, `memory.write is annotated as a write that replaces a stored value (got ${JSON.stringify(ann)})`);
}
{
  const call = (list.result?.tools ?? []).find((t) => t.name === "catalog.call");
  const ann = call?.annotations || {};
  // catalog.call reaches the network whether or not MPP is on, so it is never
  // read-only and always open-world.
  assert(ann.readOnlyHint === false && ann.openWorldHint === true,
    `catalog.call is annotated not read-only and open-world (got ${JSON.stringify(ann)})`);
  // Without MPP no listed text may offer to take payment on this connector.
  if (!mppHere) {
    const texts = (list.result?.tools ?? []).map((t) => t.description).join(" ") + " " + init.result.instructions;
    assert(!/payable (right )?here over MPP|pay it here over MPP|payable there over MPP/.test(texts), "without MPP, no tool description or instruction offers payment on this connector");
  }
}

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
// The refusal's shape follows the wires the target's connector takes in the
// call (src/mcp-http.js translateMppResponse, src/mcp-x402.js
// buildPaymentRequiredResult; src/connector-pay.js connectorWires):
//   • "mpp+x402" (production: a paywall and the MPP gates): a tool result with
//     isError, the x402 PaymentRequired as JSON in its first text block, and
//     the MPP challenges in _meta["org.paymentauth/payment-required"]
//     ({ httpStatus: 402, challenges }).
//   • "mpp": the same _meta challenges, no x402 offer.
//   • "x402": the PaymentRequired in the first text block, no MPP _meta.
//   • "mpp-error": JSON-RPC -32042 carrying { httpStatus: 402, challenges }
//     (a caller on the tasks path keeps the error form).
//   • "none" (FREE_MODE, no wire): isError with prose pointing at agent402-mcp
//     + AGENT_KEY.
// A refusal of any other shape fails. This assertion is what the deploy job
// runs against production, so the paid boot below asserts the same function
// on a local paid server: a shape change fails CI before it reaches main.
// Whatever the shape, the tool must not have run for free.
const PAYMENT_REQUIRED_META = "org.paymentauth/payment-required";
function paidRefusalKind(resp) {
  if (resp?.error) {
    const d = resp.error.data;
    return resp.error.code === -32042 && d?.httpStatus === 402 && Array.isArray(d?.challenges) && d.challenges.length > 0 ? "mpp-error" : null;
  }
  const r = resp?.result;
  if (r?.isError !== true) return null;
  const texts = (r.content || []).map((c) => (c && typeof c.text === "string" ? c.text : ""));
  let pr = null;
  try { pr = JSON.parse(texts[0] || ""); } catch { pr = null; }
  const x402 = pr?.x402Version === 2 && Array.isArray(pr.accepts) && pr.accepts.length > 0;
  const m = r._meta?.[PAYMENT_REQUIRED_META];
  const mpp = m?.httpStatus === 402 && Array.isArray(m.challenges) && m.challenges.length > 0;
  if (r._meta && Object.hasOwn(r._meta, PAYMENT_REQUIRED_META) && !mpp) return null;
  if (mpp && x402) return "mpp+x402";
  if (mpp) return "mpp";
  if (x402) return "x402";
  const all = texts.join("\n");
  return all.includes("agent402-mcp") && all.includes("AGENT_KEY") ? "none" : null;
}
/** The bypass check: no tool output came back, whatever the shape. The x402
 *  offer's own block is left out: its discovery extension carries an example
 *  output, which is a description of the tool, not a run of it. */
function ranForFree(resp) {
  const texts = (resp?.result?.content || []).map((c) => (c && typeof c.text === "string" ? c.text : ""));
  let first = null;
  try { first = JSON.parse(texts[0] || ""); } catch { first = null; }
  const all = (first?.x402Version === 2 && Array.isArray(first.accepts) ? texts.slice(1) : texts).join("\n");
  return Boolean(resp?.result?.structuredContent) || all.includes("<html") || /"results"\s*:/.test(all);
}
const paid = await rpc("tools/call", { name: "web.search", arguments: { q: "x402" } });
const paidKind = paidRefusalKind(paid);
assert(paidKind !== null,
  `flagship wallet-only tool (web.search) is refused in a shape the connector serves: ${paidKind} (got ${JSON.stringify(paid).slice(0, 200)})`);
assert(!ranForFree(paid), "wallet-only tool did NOT execute");

// The paid boot: the refusal a server with a paywall and the MPP gates (the
// production configuration) answers, read by the same function. Skipped
// only when TARGET_URL is a remote host (the deploy job's production read),
// where the boot would add nothing to what was just asserted there.
{
  const target = new URL(BASE);
  const remote = !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
  if (remote) {
    assert(paidKind === "mpp+x402", `production's refusal carries both wires (${paidKind})`);
  } else {
    const { createServer } = await import("node:http");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { randomBytes } = await import("node:crypto");
    const { bootServer } = await import("./lib/boot-server.js");
    const fac = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(req.url === "/supported" ? { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} } : req.url === "/rpc" ? { jsonrpc: "2.0", id: 1, result: "0x0" } : {}));
      });
    });
    await new Promise((r) => fac.listen(0, "127.0.0.1", r));
    const FAC = `http://127.0.0.1:${fac.address().port}`;
    const TMP = mkdtempSync(join(tmpdir(), "mcp-http-paid-"));
    let srv = null;
    try {
      srv = await bootServer({
        stores: "mcp-http-paid", args: ["--import", "./scripts/lib/loopback-only-preload.js"],
        env: {
          FREE_MODE: "", NODE_ENV: "test", BASE_URL: "https://agent402.tools", TRUST_PROXY_HOPS: "1",
          WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
          FACILITATOR_URL: FAC, PAYAI_FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, EVM_RPC_8453: `${FAC}/rpc`, FACILITATOR_GAS_CHECK: "off",
          CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", CIRCLE_FACILITATOR_API_KEY: "",
          MPP_SECRET_KEY: randomBytes(24).toString("hex"), TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", ROBINHOOD_RELAYER_KEY: "", POSTHOG_API_KEY: "",
          REDIS_URL: "", STATE_DATABASE_URL: "", TARGET_URL: "", STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
          MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off",
          SALES_LEDGER_DB: join(TMP, "sales.db"), REFUND_DB_DIR: TMP, HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
        },
      });
      const post = async (body) => {
        const res = await fetch(`${srv.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
        const text = await res.text();
        const data = (res.headers.get("content-type") || "").startsWith("text/event-stream") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("") : text;
        return JSON.parse(data);
      };
      await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test-mcp-http-paid", version: "0.0.0" } } });
      const ask = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "web.search", arguments: { q: "x402" } } });
      assert(paidRefusalKind(ask) === "mpp+x402",
        `paid boot (paywall and MPP gates, as production): web.search's refusal carries the x402 offer and the MPP challenges (${paidRefusalKind(ask)}: ${JSON.stringify(ask).slice(0, 160)})`);
      assert(!ranForFree(ask), "paid boot: wallet-only tool did NOT execute");
    } finally {
      if (srv) await srv.stop();
      fac.closeAllConnections?.();
      await new Promise((r) => fac.close(r));
    }
  }
}

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
  assert(!aboutText.includes("clientsSeenSinceBoot"), `${aboutName} does not republish caller-chosen client names (operator surface only)`);
  // Regression: firstJob once named a real competitor ("Agent402 is the
  // tools layer beside LLM gateways") in this
  // live, agent-served response - a direct violation of the project's own
  // "we deliberately do not name competing sellers anywhere in user-facing
  // copy" rule. Found in a link/leak audit, not by any
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
// The tool is listed only when the connector opts in (AGENT402_SHOW_ROUTER=1).
if (process.env.AGENT402_SHOW_ROUTER === "1") {
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

{
  // A body that is not JSON is a JSON-RPC parse error, not the site's generic 400.
  const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{not json" });
  const j = await res.json().catch(() => null);
  assert(res.status === 400 && j?.jsonrpc === "2.0" && j?.error?.code === -32700 && j?.id === null, `malformed JSON answers -32700 (got ${res.status} ${JSON.stringify(j)?.slice(0, 120)})`);
}

console.log("\nremote MCP connector: all checks passed");
