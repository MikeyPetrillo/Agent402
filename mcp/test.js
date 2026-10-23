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

// 0) Offline unit tests: AGENT402_NETWORKS parsing + accept filtering — the
// path that lets this buyer settle USDG on Robinhood Chain (or pin any chain).
{
  const { parseNetworkPrefs, filterAcceptsByNetworks, withNetworkPreference } = await import("./networks.js");
  const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
  eq(parseNetworkPrefs("robinhood"), ["eip155:4663"], "robinhood maps to CAIP-2");
  eq(parseNetworkPrefs("arc"), ["eip155:5042"], "arc maps to CAIP-2");
  eq(parseNetworkPrefs("eip155:5042"), ["eip155:5042"], "a raw Arc CAIP-2 passes through (every published version)");
  eq(filterAcceptsByNetworks([{ network: "eip155:8453", asset: "b" }, { network: "eip155:5042", asset: "arc" }, { network: "eip155:5042002", asset: "testnet" }], ["eip155:5042"]).map((a) => a.asset), ["arc"], "an Arc preference picks the Arc accept only, never the testnet one");
  eq(parseNetworkPrefs("base, solana"), ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"], "list maps + trims");
  eq(parseNetworkPrefs("eip155:9999"), ["eip155:9999"], "raw CAIP-2 passes through");
  eq(parseNetworkPrefs(""), [], "unset -> no restriction");
  const accepts = [
    { network: "eip155:8453", asset: "usdc-base" },
    { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "usdc-sol" },
    { network: "eip155:4663", asset: "usdg" },
  ];
  eq(filterAcceptsByNetworks(accepts, []).length, 3, "no prefs -> untouched");
  eq(filterAcceptsByNetworks(accepts, ["eip155:4663"]).map((a) => a.asset), ["usdg"], "robinhood-only filter picks USDG");
  eq(filterAcceptsByNetworks(accepts, ["eip155:4663", "eip155:8453"]).map((a) => a.asset), ["usdg", "usdc-base"], "preference order respected");
  let threw = false;
  try { filterAcceptsByNetworks(accepts, ["eip155:1"]); } catch { threw = true; }
  if (!threw) fail("no-match filter must throw before paying");
  // withNetworkPreference: the wrapped client only ever sees filtered accepts
  const seen = [];
  const fake = { createPaymentPayload: (pr) => { seen.push(pr.accepts.map((a) => a.asset)); return "payload"; } };
  withNetworkPreference(fake, ["eip155:4663"]);
  if (fake.createPaymentPayload({ accepts }) !== "payload") fail("wrapped client must delegate");
  eq(seen[0], ["usdg"], "client sees only the preferred accept");
  console.log("networks.js unit tests \u2713 (parse, filter, preference order, no-match throw, client wrap)");
}
const text = (result) => result.content?.map((c) => (c.type === "text" ? c.text : `<${c.type}>`)).join("\n") ?? "";

// 0b) Shed-503 retry on discovery reads (./discovery.js): a 503 that names
// its delay is retried up to 3 tries with each wait capped; any other answer
// is returned as is. Then the real server process against a stub host that
// sheds: the catalog loads through one shed 503, and catalog.find that is
// shed 3 times reports the surface and the status.
{
  const { fetchDiscovery, getDiscoveryJson, shedRetryWaitMs } = await import("./discovery.js");
  const shed = (body, headers = {}) => new Response(JSON.stringify(body), { status: 503, headers: { "content-type": "application/json", ...headers } });
  const seq = (answers) => { const calls = []; return { calls, fetchImpl: async (u) => { calls.push(String(u)); return answers.length > 1 ? answers.shift() : answers[0]; } }; };
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  if (await shedRetryWaitMs(shed({ retryAfterSeconds: 2 })) !== 2000) fail("body retryAfterSeconds read as ms");
  if (await shedRetryWaitMs(shed({}, { "retry-after": "1" })) !== 1000) fail("Retry-After header read as ms");
  if (await shedRetryWaitMs(shed({ retryAfterSeconds: 600 })) !== 5000) fail("server delay capped at 5 s");
  if (await shedRetryWaitMs(shed({ error: "busy" })) !== null) fail("a 503 naming no delay is not a shed");
  if (await shedRetryWaitMs(new Response("{}", { status: 500, headers: { "retry-after": "1" } })) !== null) fail("only a 503 retries");
  {
    const s1 = seq([shed({ retryAfterSeconds: 2 }), new Response(JSON.stringify({ endpoints: [] }), { status: 200 })]);
    const out = await getDiscoveryJson("catalog load", "https://shed.example/api/pricing", undefined, { fetchImpl: s1.fetchImpl, sleep });
    if (!Array.isArray(out.endpoints) || s1.calls.length !== 2 || waits.join(",") !== "2000") fail(`one shed 503 then 200 must succeed after one wait (${s1.calls.length}, ${waits})`);
  }
  {
    waits.length = 0;
    const s2 = seq([shed({ retryAfterSeconds: 1 })]);
    let err = null;
    try { await getDiscoveryJson("catalog load", "https://shed.example/api/pricing?x=1", undefined, { fetchImpl: s2.fetchImpl, sleep }); } catch (e) { err = e; }
    if (!err || err.message !== "catalog load failed: HTTP 503 from /api/pricing after 3 attempts" || err.status !== 503) fail(`3 shed 503s must fail naming the surface: ${err && err.message}`);
    if (s2.calls.length !== 3 || waits.length !== 2) fail(`exactly 3 attempts and 2 waits (${s2.calls.length}, ${waits.length})`);
  }
  {
    const s3 = seq([shed({ error: "busy" })]);
    const { res, attempts } = await fetchDiscovery("https://shed.example/api/find", undefined, { fetchImpl: s3.fetchImpl, sleep });
    if (res.status !== 503 || attempts !== 1 || s3.calls.length !== 1) fail("a 503 without a delay is answered once");
  }

  const { createServer } = await import("node:http");
  const counts = { pricing: 0, find: 0 };
  const stub = createServer((req, res) => {
    const u = new URL(req.url, "http://stub");
    const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    const shedIt = () => send(503, { error: "The server is busy", retryAfterSeconds: 0 }, { "retry-after": "0" });
    if (u.pathname === "/api/pricing") {
      counts.pricing++;
      if (counts.pricing === 1) return shedIt();
      return send(200, { endpoints: [{ slug: "stub-hash", method: "GET", path: "/api/stub-hash", price: "$0.001", description: "Hash a string with SHA-256", category: "Text", computePayable: true }] });
    }
    if (u.pathname === "/openapi.json") return send(200, { paths: { "/api/stub-hash": { get: { parameters: [{ name: "text", required: true, schema: { type: "string" } }] } } } });
    if (u.pathname === "/api/find") { counts.find++; return shedIt(); }
    return send(404, { error: "not found" });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  const stubEnv = { ...process.env, AGENT402_URL: stubUrl };
  delete stubEnv.AGENT_KEY; delete stubEnv.SOLANA_AGENT_KEY; delete stubEnv.AGENT402_CREDITS_KEY;
  const shedClient = new Client({ name: "agent402-mcp-shed-test", version: "0.0.0" });
  await shedClient.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "mcp", "index.js")], env: stubEnv, stderr: "ignore" }));
  try {
    const found = await shedClient.callTool({ name: "catalog.search", arguments: { query: "hash a string" } });
    if (counts.pricing !== 2 || !text(found).includes("stub-hash")) fail(`catalog must load through one shed 503 (pricing reads ${counts.pricing}): ${text(found).slice(0, 200)}`);
    const shedFind = await shedClient.callTool({ name: "catalog.find", arguments: { task: "hash a string" } });
    if (!shedFind.isError || counts.find !== 3 || !/HTTP 503 from \/api\/find after 3 attempts/.test(text(shedFind))) fail(`catalog.find shed 3 times must name the surface and status (${counts.find}): ${text(shedFind)}`);
  } finally {
    await shedClient.close().catch(() => {});
    stub.close();
  }
  console.log("discovery.js shed-503 retry \u2713 (bounded, capped, 503-only; catalog loads through a shed, catalog.find names the surface)");
}

// 0c) Slow routes run as a job (./async-job.js): the catalog's
// async.recommended sends the paid call with Prefer: respond-async, the job
// link is polled honoring Retry-After, the route's 200 is the tool result,
// and a caller that asked for progress gets notifications/progress from the
// job's stage. Driven end to end through the real server process on the
// card-credits path (no wallet needed) against a stub host.
{
  const { awaitJob, shouldRequestAsync, retryAfterMs, AsyncJobPendingError } = await import("./async-job.js");
  if (!shouldRequestAsync({ recommended: true }) || shouldRequestAsync({ recommended: false }) || !shouldRequestAsync({ recommended: false }, true) || shouldRequestAsync({ recommended: true }, false) || shouldRequestAsync(null, true)) fail("shouldRequestAsync modes");
  if (retryAfterMs(new Headers({ "retry-after": "2" }), {}) !== 2000 || retryAfterMs(new Headers(), { pollIntervalSeconds: 600 }) !== 30000 || retryAfterMs(new Headers(), {}) !== 5000) fail("retryAfterMs: header, body, cap, default");
  const plain = new Response("{}", { status: 200 });
  if ((await awaitJob(plain, { baseUrl: "http://x" })) !== plain) fail("a non-202 answer is returned unchanged");
  let err = null;
  try { await awaitJob(new Response(JSON.stringify({ statusUrl: "https://evil.example/j" }), { status: 202 }), { baseUrl: "http://127.0.0.1:1", fetchImpl: async () => { throw new Error("must not fetch"); } }); } catch (e) { err = e; }
  if (!(err instanceof AsyncJobPendingError) || !/another origin/.test(err.message)) fail("a job link on another origin is never followed");

  const { createServer } = await import("node:http");
  const KEY = `a402_${"k".repeat(40)}`;
  const seen = { prefer: null, auth: null, polls: 0 };
  const stub = createServer((req, res) => {
    const u = new URL(req.url, "http://stub");
    const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    if (u.pathname === "/api/pricing") return send(200, { endpoints: [{ slug: "slow-report", method: "POST", path: "/v1/slow-report", price: "$0.60", description: "A slow report", category: "Research", computePayable: false, async: { recommended: true, expectedSeconds: 90, maxSeconds: 180, prefer: "respond-async", statusUrl: "/api/jobs/{id}" } }] });
    if (u.pathname === "/openapi.json") return send(200, { paths: { "/v1/slow-report": { post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" } } } } } } } } } });
    if (u.pathname === "/v1/slow-report") {
      seen.prefer = req.headers.prefer || null; seen.auth = req.headers.authorization || null; seen.polls = 0;
      return send(202, { jobId: "cd".repeat(24), status: "working", state: "queued", statusUrl: `/api/jobs/${"cd".repeat(24)}`, pollIntervalSeconds: 1 }, { location: `/api/jobs/${"cd".repeat(24)}`, "retry-after": "1" });
    }
    if (u.pathname.startsWith("/api/jobs/")) {
      seen.polls++;
      if (seen.polls === 1) return send(200, { status: "working", state: "running", stage: "searching", steps: { done: 1, total: 5 }, progress: 0.2, etaSeconds: 60 }, { "retry-after": "1" });
      if (seen.polls === 2) return send(200, { status: "working", state: "running", stage: "writing report", steps: { done: 4, total: 5 }, progress: 0.8, etaSeconds: 10 }, { "retry-after": "1" });
      return send(200, { status: "completed", state: "succeeded", progress: 1, result: { httpStatus: 200, headers: { "x-credits-balance": "9.40" }, body: { report: "the answer" } } });
    }
    return send(404, { error: "not found" });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubEnv = { ...process.env, AGENT402_URL: `http://127.0.0.1:${stub.address().port}`, AGENT402_CREDITS_KEY: KEY };
  delete stubEnv.AGENT_KEY; delete stubEnv.SOLANA_AGENT_KEY; delete stubEnv.AGENT402_BUDGET; delete stubEnv.AGENT402_MAX_PER_CALL; delete stubEnv.AGENT402_ASYNC;
  const jobClient = new Client({ name: "agent402-mcp-async-test", version: "0.0.0" });
  await jobClient.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "mcp", "index.js")], env: stubEnv, stderr: "ignore" }));
  try {
    const notes = [];
    const { CallToolResultSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const out = await jobClient.callTool({ name: "catalog.call", arguments: { slug: "slow-report", params: { query: "q" } } }, CallToolResultSchema, { onprogress: (p) => notes.push(p), timeout: 30_000 });
    if (out.isError || !text(out).includes("the answer")) fail(`the job's answer is the tool result: ${text(out).slice(0, 200)}`);
    if (seen.prefer !== "respond-async" || seen.auth !== `Bearer ${KEY}`) fail(`the paid call carries Prefer: respond-async and its credential (${seen.prefer}, ${seen.auth ? "auth" : "no auth"})`);
    if (seen.polls !== 3) fail(`the job link is polled until it is final (${seen.polls})`);
    const pcts = notes.map((n) => n.progress);
    if (pcts.join(",") !== "0,20,80,100" || !/writing report \(4 of 5 steps\)/.test(notes[2]?.message || "")) fail(`progress notifications follow the job stage and only rise (${JSON.stringify(notes)})`);
  } finally {
    await jobClient.close().catch(() => {});
    stub.close();
  }
  console.log("async-job.js ✓ (slow route asks for a job, polls Retry-After, answer delivered, progress notifications rise; other-origin link refused)");
}

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
  // tools/list: flagship + meta tools present, catalog NOT dumped wholesale.
  // Smithery Naming wants dotted domain.action; CallTool still accepts prior
  // snake/digit aliases and raw kebab slugs.
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const required of [
    "catalog.search", "catalog.find", "catalog.call", "payment.info", "server.describe",
    "sellers.list", "router.execute",
    "web.search", "web.answer", "web.news", "browser.render", "market.quote",
    "audio.transcribe", "memory.read", "memory.write",
  ]) {
    if (!names.includes(required)) fail(`tools/list missing "${required}" (got: ${names.join(", ")})`);
  }
  if (names.some((n) => n.includes("-"))) fail(`tools/list names must not use kebab, found: ${names.filter((n) => n.includes("-")).join(", ")}`);
  if (
    names.includes("payment_info") || names.includes("top_x402_sellers") ||
    names.includes("about_agent402") || names.includes("describe_agent402") ||
    names.includes("list_x402_sellers") || names.includes("search_tools") ||
    names.includes("search_web") || names.includes("describe_server") ||
    names.includes("list_top_sellers")
  ) {
    fail("legacy snake/digit names must not be listed (aliases only)");
  }
  if (!names.every((n) => /^[a-z]+(\.[a-z]+)+$/.test(n))) {
    fail("every listed tool name must be dotted domain.action");
  }
  // backward-compat: the raw kebab slug must still resolve on call.
  const kebabCall = await client.callTool({ name: "memory-write", arguments: { key: "k", value: "v" } });
  if (kebabCall.isError && /Unknown tool/i.test(text(kebabCall))) fail("kebab slug memory-write must still resolve (backward compat)");
  if (tools.length > 20) fail(`tools/list too large (${tools.length}) — must stay flagship-sized, not dump the catalog`);
  if (tools.length < 10) fail(`tools/list too small (${tools.length}) — flagships + meta missing`);
  const searchTool = tools.find((t) => t.name === "web.search");
  if (!searchTool?.inputSchema?.properties?.q) fail("web.search tool lost its input schema");
  if (!tools.every((t) => t.outputSchema?.type === "object" && t.outputSchema?.properties && Object.keys(t.outputSchema.properties).length > 0)) {
    fail("every tools/list entry must carry a named-field outputSchema");
  }
  console.log(`tools/list → ${tools.length} tools, flagship set + meta + outputSchema ✓`);

  // search_tools finds catalog tools that are not first-class
  const search = await client.callTool({ name: "search_tools", arguments: { query: "convert miles to kilometers" } });
  if (!text(search).includes("unit-convert")) fail(`search_tools missed the conversion tool: ${text(search).slice(0, 300)}`);
  console.log("search_tools finds long-tail catalog tools ✓");

  // The snake form of a listed dotted name is a CallTool alias too: a client
  // that cannot send a dot sends catalog_search, and it must reach the meta
  // tool, never fall through to the slug lookup as "catalog-search".
  const snakeSearch = await client.callTool({ name: "catalog_search", arguments: { query: "convert miles to kilometers" } });
  if (snakeSearch.isError || /Unknown tool slug/i.test(text(snakeSearch)) || !text(snakeSearch).includes("unit-convert")) fail(`catalog_search must alias catalog.search: ${text(snakeSearch).slice(0, 300)}`);
  const snakeFind = await client.callTool({ name: "catalog_find", arguments: { task: "convert miles to kilometers", limit: 3 } });
  if (snakeFind.isError || /Unknown tool slug/i.test(text(snakeFind)) || !text(snakeFind).includes("unit-convert")) fail(`catalog_find must alias catalog.find: ${text(snakeFind).slice(0, 300)}`);
  const snakePay = await client.callTool({ name: "payment_info", arguments: {} });
  if (snakePay.isError || !text(snakePay).includes("proof-of-work")) fail(`payment_info must alias payment.info: ${text(snakePay).slice(0, 300)}`);
  console.log("snake forms of the dotted meta names (catalog_search, catalog_find, payment_info) are CallTool aliases ✓");

  // No query: the empty answer names the argument instead of echoing "".
  const noQuery = await client.callTool({ name: "catalog.search", arguments: {} });
  const noQueryText = text(noQuery);
  // The text is the JSON envelope, so the quotes around query arrive escaped.
  if (noQuery.isError || !/needs a \\?"query\\?" argument/.test(noQueryText) || /matched \\?"\\?"/.test(noQueryText)) fail(`catalog.search without a query must name the query argument, got: ${noQueryText.slice(0, 300)}`);
  console.log("catalog.search without a query names the query argument ✓");

  // find_tool reaches long-tail via hosted /api/find
  const found = await client.callTool({ name: "find_tool", arguments: { task: "convert miles to kilometers", limit: 3 } });
  if (found.isError || !text(found).includes("unit-convert")) fail(`find_tool missed unit-convert: ${text(found).slice(0, 300)}`);
  console.log("find_tool resolves long-tail tasks ✓");

  // search_tools surfaces matching multi-tool workflow templates (skill packs)
  // so a task-shaped query also points the agent at the curated prompt — not
  // just at individual tools they'd have to stitch together themselves.
  const workflowSearch = await client.callTool({ name: "search_tools", arguments: { query: "security audit" } });
  if (!text(workflowSearch).includes("security-audit")) fail(`search_tools should recommend the security-audit workflow: ${text(workflowSearch).slice(0, 400)}`);
  if (!text(workflowSearch).includes("workflows")) fail(`search_tools response should include the workflows key: ${text(workflowSearch).slice(0, 400)}`);
  console.log("search_tools recommends matching workflow templates ✓");

  // long-tail pure-CPU via call_tool, no wallet → settles via proof-of-work
  const hashed = await client.callTool({ name: "call_tool", arguments: { slug: "hash", params: { text: "hello world" } } });
  if (hashed.isError || !text(hashed).includes("b94d27b9")) fail(`PoW-paid hash call wrong: ${text(hashed).slice(0, 300)}`);
  console.log("call_tool hash settled with proof-of-work ✓");

  // call_tool reaches the long tail with payment handled
  const converted = await client.callTool({ name: "call_tool", arguments: { slug: "unit-convert", params: { value: 10, from: "miles", to: "kilometers" } } });
  if (converted.isError || !text(converted).includes("16.09344")) fail(`call_tool conversion wrong: ${text(converted).slice(0, 300)}`);
  console.log("call_tool long-tail call settled with proof-of-work ✓");

  // wallet-only flagship without a key → helpful error, not a crash
  const render = await client.callTool({ name: "render_page", arguments: { url: "https://example.com" } });
  if (!render.isError || !text(render).includes("AGENT_KEY")) fail(`wallet-only tool should explain AGENT_KEY: ${text(render).slice(0, 300)}`);
  console.log("wallet-only tool returns funding guidance without a key ✓");

  // get_payment_info (+ payment_info alias) reports the mode honestly
  for (const payName of ["get_payment_info", "payment_info"]) {
    const info = await client.callTool({ name: payName, arguments: {} });
    if (!text(info).includes("proof-of-work")) fail(`${payName} should report proof-of-work mode: ${text(info).slice(0, 300)}`);
  }
  console.log("get_payment_info reports proof-of-work mode ✓");

  // list_top_sellers (+ prior list_x402_sellers / top_x402_sellers aliases).
  // Even when the leaderboard cache is warming the envelope must be well-formed.
  const sellers = await client.callTool({ name: "list_top_sellers", arguments: { limit: 5, sort: "calls", include: "all" } });
  if (sellers.isError) fail(`list_top_sellers should not error on warming cache: ${text(sellers).slice(0, 300)}`);
  const sellersJson = JSON.parse(text(sellers));
  if (sellersJson.sort !== "calls" || sellersJson.include !== "all") fail(`list_top_sellers should echo sort+include (got sort=${sellersJson.sort}, include=${sellersJson.include})`);
  if (!Array.isArray(sellersJson.results) || sellersJson.results.length > 5) fail(`list_top_sellers should honor limit (got ${sellersJson.results?.length} rows)`);
  if (typeof sellersJson.source !== "string" || !sellersJson.source.endsWith("/api/leaderboard")) fail(`list_top_sellers should link to /api/leaderboard`);
  for (const alias of ["list_x402_sellers", "top_x402_sellers"]) {
    const sellersAlias = await client.callTool({ name: alias, arguments: { limit: 3 } });
    if (sellersAlias.isError) fail(`${alias} alias should still route: ${text(sellersAlias).slice(0, 200)}`);
  }
  console.log("list_top_sellers proxies the leaderboard with limit/sort/include ✓");

  // router.execute: the SOR external router (route_and_execute stays a CallTool alias). Without a task it self-explains;
  // with a task in PoW mode (no wallet) it returns the wallet-required guide
  // (external routing is wallet-only) rather than a crash. Both are non-throwing.
  const rNoTask = await client.callTool({ name: "router.execute", arguments: {} });
  if (!rNoTask.isError || !/requires a 'task'/i.test(text(rNoTask))) fail(`router.execute without task should self-explain, got: ${text(rNoTask).slice(0, 200)}`);
  // The old name is a CallTool alias: it must reach the same handler, so with no
  // task it gives router.execute's own refusal, not an unknown-tool error.
  const rAliasNoTask = await client.callTool({ name: "route_and_execute", arguments: {} });
  if (!rAliasNoTask.isError || text(rAliasNoTask) !== text(rNoTask)) fail(`route_and_execute must alias router.execute (same no-task refusal), got: ${text(rAliasNoTask).slice(0, 200)}`);
  const rTask = await client.callTool({ name: "route_and_execute", arguments: { task: "crypto news headlines" } });
  if (/Agent402 call failed|is not in the catalog/i.test(text(rTask))) fail(`route_and_execute with a task should reach the endpoint (wallet-required or a result), got: ${text(rTask).slice(0, 240)}`);
  console.log("router.execute self-explains without a task, and the route_and_execute alias reaches the SOR endpoint ✓");

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
    const info2 = await capped.callTool({ name: "get_payment_info", arguments: {} });
    if (!text(info2).includes("spendControls") || !text(info2).includes("0.0005")) {
      fail(`get_payment_info should report spend controls: ${text(info2).slice(0, 300)}`);
    }
    console.log("get_payment_info reports spend controls ✓");
  } finally {
    await capped.close().catch(() => {});
  }

  // Spend caps are enforced against the amount the 402 ACTUALLY QUOTES, not the
  // catalog price. A route may quote per request from the body (a token-metered
  // route, or a chat route priced by the model named in it), and this server
  // pays whatever the challenge asks for - vendor spend controls are off
  // because the package bounds spend itself - so a cap read off /api/pricing
  // would not be a cap. Driven against a local stub seller: nothing is signed,
  // no key is spent, and the whole exchange stays on loopback.
  {
    const { createServer } = await import("node:http");
    const { getFreePort } = await import("../scripts/lib/free-port.js");
    const LIST_USD = 0.02, PREMIUM_USD = 0.5;
    const seen = { preflights: 0, authorized: 0 };
    const challenge = (usd) => Buffer.from(JSON.stringify({
      x402Version: 2,
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: String(Math.round(usd * 1e6)), asset: BASE_USDC, payTo: "0xdead", extra: { name: "USD Coin" } }],
    })).toString("base64");
    // A signable offer (real address shapes) at `amount` base units of Base
    // USDC, with optional extra fields.
    const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const signable = (path, amount, extra = {}) => Buffer.from(JSON.stringify({
      x402Version: 2,
      resource: { url: `http://127.0.0.1${path}`, description: "paid", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: String(amount), asset: BASE_USDC, payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2", ...extra } }],
    })).toString("base64");
    // /api/switch lists at $0.01 and quotes $5 on its 402 (the request the
    // wallet signs for); /api/hinted quotes 5000000 base units of USDC ($5)
    // beside a decimals hint of 18; /api/fixed quotes $0.01. Every unpaid
    // request is counted, and a request carrying a signature is counted and
    // answered 200.
    const switchRow = { slug: "switch", method: "POST", path: "/api/switch", price: "$0.01", description: "switch", category: "util", computePayable: false };
    const fixedRow = { slug: "fixed", method: "POST", path: "/api/fixed", price: "$0.01", description: "fixed", category: "util", computePayable: false };
    const hintedRow = { slug: "hinted", method: "POST", path: "/api/hinted", price: "$0.01", description: "hinted", category: "util", computePayable: false };
    seen.switchUnpaid = 0; seen.signed = 0;
    const catalogRow = { slug: "chat", method: "POST", path: "/v1/chat/completions", price: `$${LIST_USD}`, description: "chat", category: "llm", computePayable: false };
    // A route that refuses every request, the paid retry included, the way this
    // server's paywall does: 402 + PAYMENT-REQUIRED + a JSON body that mirrors
    // the header's offer beside our own reason/hint/retry (a refusal with a
    // hint carries no `error`). The offer is signable (real address shapes) so
    // the wallet path really pays and is refused, instead of stopping at the
    // cap.
    const refusedRow = { slug: "refused", method: "POST", path: "/api/refused", price: "$0.001", description: "refused", category: "util", computePayable: false };
    const refusedOffer = {
      x402Version: 2, error: "No matching payment requirements",
      resource: { url: "http://127.0.0.1/api/refused", description: "refused", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
      extensions: { bazaar: { info: { input: { type: "http", method: "POST", body: { text: "x" } } }, schema: { type: "object", properties: { input: { type: "object" } } } } },
    };
    // A $0.001 route whose 402 also carries a floored Robinhood (USDG) accept
    // at $0.005, as this server's does: the credits gate debits the route's
    // own quote, so a credits cap counts $0.001, not the other chain's floor.
    const flooredRow = { slug: "floored", method: "POST", path: "/api/floored", price: "$0.001", description: "floored", category: "util", computePayable: false };
    const flooredOffer = {
      x402Version: 2, resource: { url: "http://127.0.0.1/api/floored", description: "floored", mimeType: "application/json" },
      accepts: [
        { scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
        { scheme: "exact", network: "eip155:4663", amount: "5000", asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 300, extra: { name: "Global Dollar", version: "1" } },
      ],
    };
    seen.flooredPaid = 0;
    const { error: _offerError, ...refusedOfferKeys } = refusedOffer;
    const refusedBody = { reason: "requirements-mismatch", hint: "Echo the accepts entry you were offered verbatim.", retry: "rebuild-payment", ...refusedOfferKeys };
    seen.refusedPaid = 0;
    // Error bodies that are NOT an x402 offer must reach the agent exactly as
    // the seller wrote them: a validation 400 and an upstream 502, each a JSON
    // body with no x402Version. Spacing is deliberate, so a
    // parse-and-reserialize shows.
    const plainRows = [
      { slug: "plain-400", method: "POST", path: "/api/plain-400", price: "$0.001", description: "plain 400", category: "util", computePayable: false },
      { slug: "plain-502", method: "POST", path: "/api/plain-502", price: "$0.001", description: "plain 502", category: "util", computePayable: false },
    ];
    const PLAIN = {
      "/api/plain-400": [400, '{"error": "bad input", "expected": {"text": "string"}}'],
      "/api/plain-502": [502, '{"error": "upstream failed", "status": 502, "hint": "retry later"}'],
    };
    // A second origin a redirect points at. Every request it gets is counted:
    // a paid call must never reach it, unpaid or signed.
    const elsewhereSeen = { unpaid: 0, signed: 0 };
    const elsewhere = createServer((req, res) => {
      req.resume();
      if (req.headers["payment-signature"] || req.headers["x-payment"]) { elsewhereSeen.signed++; res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"from":"elsewhere"}'); }
      elsewhereSeen.unpaid++;
      res.writeHead(402, { "Content-Type": "application/json", "PAYMENT-REQUIRED": signable(req.url.split("?")[0], 1000) });
      res.end("{}");
    });
    await new Promise((r) => elsewhere.listen(0, "127.0.0.1", r));
    const ELSEWHERE = `http://127.0.0.1:${elsewhere.address().port}`;
    // /api/redir-first redirects before any 402; /api/redir-paid quotes an
    // honest 402 and redirects the signed retry.
    const redirRows = [
      { slug: "redir-first", method: "POST", path: "/api/redir-first", price: "$0.001", description: "redirect first", category: "util", computePayable: false },
      { slug: "redir-paid", method: "POST", path: "/api/redir-paid", price: "$0.001", description: "redirect paid", category: "util", computePayable: false },
    ];
    seen.redirPaidSigned = 0;
    const stub = createServer((req, res) => {
      const send = (status, obj, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
      if (req.url.startsWith("/api/pricing")) return send(200, { endpoints: [catalogRow, refusedRow, ...plainRows, switchRow, hintedRow, fixedRow, ...redirRows, flooredRow], payment: { network: "base" } });
      if (req.url.startsWith("/api/floored")) {
        req.resume();
        if (req.headers.authorization) { seen.flooredPaid++; return send(200, { ok: true }); }
        return send(402, {}, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(flooredOffer)).toString("base64") });
      }
      if (req.url.startsWith("/api/redir-first")) { req.resume(); res.writeHead(307, { Location: `${ELSEWHERE}${req.url}` }); return res.end(); }
      if (req.url.startsWith("/api/redir-paid")) {
        req.resume();
        if (req.headers["payment-signature"] || req.headers["x-payment"]) { seen.redirPaidSigned++; res.writeHead(307, { Location: `${ELSEWHERE}${req.url}` }); return res.end(); }
        return send(402, {}, { "PAYMENT-REQUIRED": signable("/api/redir-paid", 1000) });
      }
      const plain = PLAIN[req.url.split("?")[0]];
      if (plain) { req.resume(); res.writeHead(plain[0], { "Content-Type": "application/json" }); return res.end(plain[1]); }
      if (req.url.startsWith("/api/switch") || req.url.startsWith("/api/hinted") || req.url.startsWith("/api/fixed")) {
        req.resume();
        if (req.headers["payment-signature"] || req.headers["x-payment"]) { seen.signed++; return send(200, { ok: true }); }
        const path = req.url.split("?")[0];
        seen.switchUnpaid++;
        if (path === "/api/hinted") return send(402, {}, { "PAYMENT-REQUIRED": signable(path, 5000000, { decimals: 18 }) });
        return send(402, {}, { "PAYMENT-REQUIRED": signable(path, path === "/api/fixed" ? 10000 : 5000000) });
      }
      if (req.url.startsWith("/api/refused")) {
        if (req.headers["payment-signature"] || req.headers["x-payment"]) seen.refusedPaid++;
        req.resume();
        return send(402, refusedBody, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(refusedOffer)).toString("base64") });
      }
      if (req.url.startsWith("/openapi.json")) return send(200, { paths: {} });
      if (req.url.startsWith("/api/skill-packs.json")) return send(200, { packs: [] });
      if (req.url.startsWith("/v1/chat/completions")) {
        let body = "";
        req.on("data", (c) => (body += c));
        return req.on("end", () => {
          // The quote is a function of the body: the dearer model costs more.
          let model = ""; try { model = JSON.parse(body || "{}").model || ""; } catch { /* unparseable */ }
          const usd = model === "premium-model" ? PREMIUM_USD : LIST_USD;
          if (req.headers.authorization) { seen.authorized++; return send(200, { ok: true, model }); }
          seen.preflights++;
          return send(402, {}, { "PAYMENT-REQUIRED": challenge(usd) });
        });
      }
      return send(404, {});
    });
    const stubPort = await getFreePort();
    await new Promise((r) => stub.listen(stubPort, "127.0.0.1", r));
    const STUB = `http://127.0.0.1:${stubPort}`;
    const creditsKey = `a402_${"k".repeat(40)}`;
    const connect = async (env) => {
      const c = new Client({ name: "agent402-mcp-quotetest", version: "0.0.0" });
      await c.connect(new StdioClientTransport({
        command: process.execPath,
        args: [join(ROOT, "mcp", "index.js")],
        env: { ...process.env, AGENT402_URL: STUB, AGENT_KEY: "", SOLANA_AGENT_KEY: "", AGENT402_CREDITS_KEY: "", AGENT402_BUDGET: "", ...env },
      }));
      return c;
    };
    const call = (c, model) => c.callTool({ name: "catalog.call", arguments: { slug: "chat", params: { model, messages: [{ role: "user", content: "hi" }] } } });

    // credits: a quote above the cap is refused, and the key is never spent
    let credits = await connect({ AGENT402_CREDITS_KEY: creditsKey, AGENT402_MAX_PER_CALL: "0.10" });
    try {
      const refused = await call(credits, "premium-model");
      const t = text(refused);
      if (!refused.isError || !/Refused/.test(t)) fail(`an over-cap quote must be refused: ${t.slice(0, 300)}`);
      if (!t.includes("$0.5") || !t.includes("0.1")) fail(`the refusal must name the quote and the cap: ${t.slice(0, 300)}`);
      if (seen.authorized !== 0) fail("nothing may be paid for a refused call");
      if (seen.preflights !== 1) fail(`expected exactly one unpaid preflight, saw ${seen.preflights}`);
      console.log("a 402 quoting above the cap is refused without paying ✓");

      // ...and a quote inside the cap still pays
      const served = await call(credits, "mid-model");
      if (served.isError) fail(`a quote inside the cap must still pay: ${text(served).slice(0, 300)}`);
      if (seen.authorized !== 1) fail(`the under-cap call must be paid exactly once, saw ${seen.authorized}`);
      console.log("a quote inside the cap still pays ✓");
    } finally { await credits.close().catch(() => {}); }

    // credits: another chain's floor in the offer is not the debit. A per-call
    // cap of $0.004 serves the $0.001 route, and a $0.004 budget pays it four
    // times (counted at $0.005 it would refuse the first call).
    const callFloored = (c) => c.callTool({ name: "catalog.call", arguments: { slug: "floored", params: { text: "x" } } });
    credits = await connect({ AGENT402_CREDITS_KEY: creditsKey, AGENT402_MAX_PER_CALL: "0.004" });
    try {
      const served = await callFloored(credits);
      if (served.isError) fail(`a $0.001 credits call must not count another chain's floor against a $0.004 cap: ${text(served).slice(0, 300)}`);
      console.log("credits: a per-call cap below another chain's floor still serves the $0.001 route ✓");
    } finally { await credits.close().catch(() => {}); }
    credits = await connect({ AGENT402_CREDITS_KEY: creditsKey, AGENT402_MAX_PER_CALL: "off", AGENT402_BUDGET: "0.004" });
    try {
      const before = seen.flooredPaid;
      let servedCount = 0;
      for (let i = 0; i < 5; i++) { const r = await callFloored(credits); if (!r.isError) servedCount++; }
      if (seen.flooredPaid - before !== 4 || servedCount !== 4) fail(`a $0.004 credits budget must pay four $0.001 calls and refuse the fifth, paid ${seen.flooredPaid - before}`);
      console.log("credits: the budget is charged the debit ($0.001 a call), not the dearest accept ✓");
    } finally { await credits.close().catch(() => {}); }

    // wallet: the same cap, refused before any signature (unfunded throwaway key)
    const walletBefore = seen.authorized;
    const wallet = await connect({ AGENT_KEY: "0x" + "11".repeat(32), AGENT402_MAX_PER_CALL: "0.10" });
    try {
      const refused = await call(wallet, "premium-model");
      if (!refused.isError || !/Refused without paying/.test(text(refused))) {
        fail(`the wallet path must refuse an over-cap quote at signing: ${text(refused).slice(0, 300)}`);
      }
      if (seen.authorized !== walletBefore) fail("the wallet path paid a call it had refused");
      console.log("the wallet path refuses an over-cap quote at signing ✓");

      // A refused PAID call reads as its reason, not as the offer the 402 body
      // also carries: kilobytes of accepts and schemas an agent cannot act on.
      const denied = await wallet.callTool({ name: "catalog.call", arguments: { slug: "refused", params: { text: "x" } } });
      const t = text(denied);
      if (seen.refusedPaid < 1) fail(`the wallet path should have sent a paid retry to the refusing route (saw ${seen.refusedPaid})`);
      if (!denied.isError) fail(`a refused paid call must be an error: ${t.slice(0, 300)}`);
      if (!t.includes("requirements-mismatch") || !t.includes("rebuild-payment")) fail(`the refusal text must carry the reason and retry: ${t.slice(0, 300)}`);
      if (t.includes('"accepts"') || t.includes('"extensions"')) fail(`the refusal text must not carry the offer: ${t.slice(0, 300)}`);
      if (t.length >= 1000) fail(`the refusal text should be compact, got ${t.length} chars`);
      console.log(`a refused paid call reads as its reason, not the offer (${t.length} chars) ✓`);

      // Any other error body is returned as it came: no status, no option
      // count, no note about a PAYMENT-REQUIRED header that is not there.
      for (const row of plainRows) {
        const r = await wallet.callTool({ name: "catalog.call", arguments: { slug: row.slug, params: { text: "x" } } });
        const pt = text(r);
        if (!r.isError || pt !== PLAIN[row.path][1]) fail(`${row.slug}: an error body with no x402 offer must reach the agent byte-identical, got: ${pt.slice(0, 300)}`);
      }
      console.log("a plain 400 and 502 reach the agent byte-identical, with no offer note ✓");

      // No unpaid preflight on the wallet path: a capped call under the cap
      // makes exactly one request before it pays (the paid request's own 402),
      // then one signed request.
      seen.switchUnpaid = 0; seen.signed = 0;
      const fixed = await wallet.callTool({ name: "catalog.call", arguments: { slug: "fixed", params: { text: "x" } } });
      if (fixed.isError) fail(`a quote inside the cap must pay: ${text(fixed).slice(0, 300)}`);
      if (seen.switchUnpaid !== 1 || seen.signed !== 1) fail(`a capped wallet call must make one unpaid request then one signed one (saw ${seen.switchUnpaid} unpaid, ${seen.signed} signed)`);
      console.log("a capped wallet call sends no preflight: one 402, then the signed request ✓");

      // The cap holds on the payment that is SIGNED: the route lists at $0.01
      // and its 402 asks $5, and the signing guard refuses it.
      seen.switchUnpaid = 0; seen.signed = 0;
      const switched = await wallet.callTool({ name: "catalog.call", arguments: { slug: "switch", params: { text: "x" } } });
      if (seen.switchUnpaid !== 1) fail(`expected only the paid request's own 402, no preflight (saw ${seen.switchUnpaid} unpaid requests)`);
      if (seen.signed !== 0) fail("the wallet signed a $5 payment over a $0.10 cap");
      if (!switched.isError || !/Refused without paying/.test(text(switched)) || !/\$5\b/.test(text(switched))) fail(`a 402 quoting above the list price and the cap must be refused at signing: ${text(switched).slice(0, 300)}`);
      console.log("an over-cap 402 is refused at signing ✓");

      // A seller decimals hint does not lower the price: 5000000 base units of
      // USDC is $5 whatever decimals the accept declares.
      seen.signed = 0;
      const hinted = await wallet.callTool({ name: "catalog.call", arguments: { slug: "hinted", params: { text: "x" } } });
      if (seen.signed !== 0 || !hinted.isError || !/Refused without paying/.test(text(hinted))) fail(`a $5 quote declared at 18 decimals must be refused: ${text(hinted).slice(0, 300)}`);
      console.log("a quote is priced from the known asset, not the seller's decimals hint ✓");

      // A paid call never follows a redirect: not to another origin's 402,
      // and not with a signature already made.
      const first = await wallet.callTool({ name: "catalog.call", arguments: { slug: "redir-first", params: { text: "x" } } });
      if (!first.isError || !/never follow redirects/.test(text(first)) || !text(first).includes(ELSEWHERE)) fail(`a redirect before the 402 must be refused, naming where it pointed: ${text(first).slice(0, 300)}`);
      const paidRedirect = await wallet.callTool({ name: "catalog.call", arguments: { slug: "redir-paid", params: { text: "x" } } });
      if (seen.redirPaidSigned !== 1) fail(`control: the redirecting route must have received its signed retry (saw ${seen.redirPaidSigned})`);
      if (!paidRedirect.isError || !/never follow redirects/.test(text(paidRedirect))) fail(`a redirect of the signed retry must be refused: ${text(paidRedirect).slice(0, 300)}`);
      if (elsewhereSeen.unpaid !== 0 || elsewhereSeen.signed !== 0) fail(`the other origin must get no request at all (saw ${elsewhereSeen.unpaid} unpaid, ${elsewhereSeen.signed} signed)`);
      console.log("a paid call refuses a redirect, before the 402 and after signing; the other origin sees nothing ✓");
    } finally { await wallet.close().catch(() => {}); elsewhere.close(); }

    // The session budget is checked at signing too: $0.03 left, and the paid
    // request's 402 asks $5 for a route listed at $0.01.
    {
      const budgeted = await connect({ AGENT_KEY: "0x" + "11".repeat(32), AGENT402_MAX_PER_CALL: "off", AGENT402_BUDGET: "0.03" });
      try {
        seen.switchUnpaid = 0; seen.signed = 0;
        const r = await budgeted.callTool({ name: "catalog.call", arguments: { slug: "switch", params: { text: "x" } } });
        if (seen.signed !== 0 || !r.isError || !/AGENT402_BUDGET/.test(text(r))) fail(`the budget must hold at signing: ${text(r).slice(0, 300)}`);
        const info = JSON.parse(text(await budgeted.callTool({ name: "get_payment_info", arguments: {} })));
        if (info.spendControls?.maxPerCallUsd !== "unlimited" || info.spendControls?.spentThisSessionUsd !== 0) fail(`off disables the per-call cap and a refusal spends nothing: ${JSON.stringify(info.spendControls)}`);
        console.log("the session budget holds at signing; off disables the per-call cap ✓");
      } finally { await budgeted.close().catch(() => {}); }
    }

    // Defaults: with neither variable set, a $5 quote is refused (the default
    // per-call cap), the default covers the dearest tool in the catalog, and
    // there is no session budget (opt-in), so a long session is never refused.
    {
      const defaults = await connect({ AGENT_KEY: "0x" + "11".repeat(32), AGENT402_MAX_PER_CALL: "", AGENT402_BUDGET: "" });
      try {
        seen.signed = 0;
        const r = await defaults.callTool({ name: "catalog.call", arguments: { slug: "hinted", params: { text: "x" } } });
        if (seen.signed !== 0 || !r.isError || !/AGENT402_MAX_PER_CALL/.test(text(r))) fail(`the default per-call cap must refuse a $5 quote: ${text(r).slice(0, 300)}`);
        const info = JSON.parse(text(await defaults.callTool({ name: "get_payment_info", arguments: {} })));
        const perCall = info.spendControls?.maxPerCallUsd, budget = info.spendControls?.sessionBudgetUsd;
        if (!(Number.isFinite(perCall) && budget === "unlimited" && info.spendControls?.remainingUsd === "unlimited")) fail(`a finite default per-call cap and no default session budget expected: ${JSON.stringify(info.spendControls)}`);
        const pricing = await (await fetch(`${API}/api/pricing`)).json();
        const dearest = Math.max(...pricing.endpoints.map((e) => parseFloat(String(e.price).replace(/[^0-9.]/g, "")) || 0));
        if (!(dearest > 0 && perCall >= dearest)) fail(`the default per-call cap $${perCall} must cover the dearest catalog price $${dearest}`);
        console.log(`default caps: $${perCall} per call (dearest catalog price $${dearest}), no session budget ✓`);
      } finally { await defaults.close().catch(() => {}); }
    }
    await new Promise((r) => stub.close(r));
  }

  console.log("\nMCP e2e: all assertions passed");
} finally {
  await client.close().catch(() => {});
  api.kill("SIGKILL");
}
process.exit(0);
