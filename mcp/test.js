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
    "sellers.list", "route_and_execute",
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
  if (!names.every((n) => n === "route_and_execute" || /^[a-z]+(\.[a-z]+)+$/.test(n))) {
    fail("every listed tool name must be dotted domain.action (route_and_execute is the stdio-only exception)");
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

  // route_and_execute: the SOR external router. Without a task it self-explains;
  // with a task in PoW mode (no wallet) it returns the wallet-required guide
  // (external routing is wallet-only) rather than a crash. Both are non-throwing.
  const rNoTask = await client.callTool({ name: "route_and_execute", arguments: {} });
  if (!rNoTask.isError || !/requires a 'task'/i.test(text(rNoTask))) fail(`route_and_execute without task should self-explain, got: ${text(rNoTask).slice(0, 200)}`);
  const rTask = await client.callTool({ name: "route_and_execute", arguments: { task: "crypto news headlines" } });
  if (/Agent402 call failed|is not in the catalog/i.test(text(rTask))) fail(`route_and_execute with a task should reach the endpoint (wallet-required or a result), got: ${text(rTask).slice(0, 240)}`);
  console.log("route_and_execute self-explains without a task and reaches the SOR endpoint with one ✓");

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
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: String(Math.round(usd * 1e6)), asset: "0xUSDC", payTo: "0xdead", extra: { name: "USD Coin" } }],
    })).toString("base64");
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
    const stub = createServer((req, res) => {
      const send = (status, obj, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
      if (req.url.startsWith("/api/pricing")) return send(200, { endpoints: [catalogRow, refusedRow, ...plainRows], payment: { network: "base" } });
      const plain = PLAIN[req.url.split("?")[0]];
      if (plain) { req.resume(); res.writeHead(plain[0], { "Content-Type": "application/json" }); return res.end(plain[1]); }
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

    // wallet: the same cap, refused before any signature (unfunded throwaway key)
    const walletBefore = seen.authorized;
    const wallet = await connect({ AGENT_KEY: "0x" + "11".repeat(32), AGENT402_MAX_PER_CALL: "0.10" });
    try {
      const refused = await call(wallet, "premium-model");
      if (!refused.isError || !/Refused without paying/.test(text(refused))) {
        fail(`the wallet path must refuse an over-cap quote before signing: ${text(refused).slice(0, 300)}`);
      }
      if (seen.authorized !== walletBefore) fail("the wallet path paid a call it had refused");
      console.log("the wallet path reads the same quote and refuses before signing ✓");

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
    } finally { await wallet.close().catch(() => {}); }
    await new Promise((r) => stub.close(r));
  }

  console.log("\nMCP e2e: all assertions passed");
} finally {
  await client.close().catch(() => {});
  api.kill("SIGKILL");
}
process.exit(0);
