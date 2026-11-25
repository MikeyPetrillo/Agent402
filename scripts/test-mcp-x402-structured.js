#!/usr/bin/env node
// The x402 PaymentRequired as structuredContent on the hosted connector's
// payment asks (src/mcp-x402.js fitsListedOutputSchema, src/mcp-http.js
// listedOutputSchemaOf): the transport's structured copy rides exactly where
// it validates against the called tool's listed outputSchema, and every
// reference SDK client still reads the ask as a tool result.
//
//   node scripts/test-mcp-x402-structured.js
//
// Module half: every flagship's hand-written outputSchema admits a
// PaymentRequired under both SDK validators (v1 and v2 clients), and
// catalog.call's envelope does not.
// Booted half: the REAL server in paid mode (Base, the MPP gates on, the decide
// tools listed) against a stub facilitator that answers /supported only:
//   (a) every listed tool whose unpaid call answers an x402 ask (every paid
//       flagship) carries structuredContent equal to the PaymentRequired in
//       its first text block, and that object validates against the tool's
//       listed outputSchema; catalog.call's ask carries none; an unlisted
//       former flagship's ask carries it (no schema to hold it to);
//   (b) the reference SDK client (v1, 2025 era, tools listed first so its
//       output check is armed) and the v2 client (2026-07-28) call each of
//       them unpaid and read an isError result: never -32602;
//   a flagship whose run outlasts the blocking wait (decide.execute) is never
//   offered over x402 on the connector, and its answer carries neither.
// Nothing is paid, nothing leaves the machine (loopback-only preload).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import "./lib/file-mode.js";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { AjvJsonSchemaValidator as AjvJsonSchemaValidatorV2 } from "@modelcontextprotocol/client/validators/ajv";
import { bootServer } from "./lib/boot-server.js";

const { FLAGSHIP_OUTPUT_SCHEMAS, META_OUTPUT_SCHEMAS, FLAGSHIP_MCP_NAMES, FORMER_FLAGSHIP_MCP_NAMES } = await import("../src/mcp-flagship.js");
const { paymentRequiredOfResult: PR, fitsListedOutputSchema } = await import("../src/mcp-x402.js");
const { MCP_X402_SLUGS } = await import("../src/mcp-x402-routes.js");

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const validators = [["v1", new AjvJsonSchemaValidator()], ["v2", new AjvJsonSchemaValidatorV2()]];
const failsUnder = (schema, value) => validators.filter(([, v]) => !v.getValidator(schema)(value).valid).map(([n]) => n);

// ---- module half -----------------------------------------------------------------
const SAMPLE = {
  x402Version: 2,
  error: "Payment required",
  resource: { url: "https://agent402.tools/mcp", description: "sample", mimeType: "application/json" },
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }],
  extensions: { bazaar: { info: { input: { type: "mcp" } } } },
};
{
  const bad = Object.keys(FLAGSHIP_MCP_NAMES).filter((slug) => FLAGSHIP_OUTPUT_SCHEMAS[slug]).map((slug) => [slug, failsUnder(FLAGSHIP_OUTPUT_SCHEMAS[slug], SAMPLE)]).filter(([, f]) => f.length);
  ok(bad.length === 0, `every flagship's hand-written outputSchema admits a PaymentRequired under both SDK validators${bad.length ? `: ${bad.map(([s, f]) => `${s} (${f})`).join(", ")}` : ""}`);
  ok(MCP_X402_SLUGS.every((slug) => FLAGSHIP_OUTPUT_SCHEMAS[slug] && fitsListedOutputSchema(SAMPLE, FLAGSHIP_OUTPUT_SCHEMAS[slug])), `every twin flagship (${MCP_X402_SLUGS.join(", ")}) has a hand-written schema the codec's check admits it under`);
  ok(failsUnder(META_OUTPUT_SCHEMAS["catalog.call"], SAMPLE).length === 2 && !fitsListedOutputSchema(SAMPLE, META_OUTPUT_SCHEMAS["catalog.call"]), "catalog.call's envelope schema (slug and result required) does not admit it, under either SDK validator or the codec's check");
}

// ---- booted half -----------------------------------------------------------------
const BASE_NET = "eip155:8453";
const TMP = mkdtempSync(join(tmpdir(), "mcp-x402-structured-"));
const facilitator = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/supported") return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: BASE_NET }], extensions: [], signers: {} }));
    if (req.url === "/rpc") return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }));
    // No payment is ever presented here: a verify or settle is a test failure.
    failed++; console.error(`FAIL - the facilitator was asked ${req.url}`);
    res.end("{}");
  });
});
await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
const FAC = `http://127.0.0.1:${facilitator.address().port}`;
const ENV = {
  FREE_MODE: "", NODE_ENV: "test", BASE_URL: "https://agent402.tools", TRUST_PROXY_HOPS: "1",
  WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
  FACILITATOR_URL: FAC, PAYAI_FACILITATOR_URL: FAC, SOLVADOR_FACILITATOR_URL: FAC, PAYMENT_SETTLE_FALLBACK: "", AGENT402_BASE_RPC: `${FAC}/rpc`, EVM_RPC_8453: `${FAC}/rpc`, FACILITATOR_GAS_CHECK: "off",
  CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", CIRCLE_FACILITATOR_API_KEY: "",
  MPP_SECRET_KEY: "test-mcp-x402-structured-secret", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", ROBINHOOD_RELAYER_KEY: "", POSTHOG_API_KEY: "",
  // The decide tools are listed (and asked for) only where the decide service
  // is configured; nothing here reaches it (no call runs unpaid).
  DECIDE_SERVICE_URL: "http://127.0.0.1:9", DECIDE_INTERNAL_TOKEN: "test-mcp-x402-structured-token-0123456789",
  REDIS_URL: "", STATE_DATABASE_URL: "", TARGET_URL: "",
  STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
  MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off",
  SALES_LEDGER_DB: join(TMP, "sales.db"), REFUND_DB_DIR: TMP, HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
  AGENT402_MCP_MAX_PER_MIN: "1000", AGENT402_MCP_MAX_PER_HOUR: "100000",
  AGENT402_MCP_REQ_PER_MIN: "1000", AGENT402_MCP_REQ_PER_HOUR: "100000",
};

// Arguments that pass each tool's own input checks, from its listed input schema.
const argsFor = (tool) => {
  const props = tool.inputSchema?.properties || {};
  const out = {};
  for (const [k, p] of Object.entries(props)) {
    if (!(tool.inputSchema?.required || []).includes(k)) continue;
    const t = Array.isArray(p.type) ? p.type[0] : p.type;
    if (p.enum) out[k] = p.enum[0];
    else if (/url/i.test(k)) out[k] = "https://example.com/a.pdf";
    else if (t === "number" || t === "integer") out[k] = 1;
    else if (t === "boolean") out[k] = true;
    else if (t === "object") out[k] = {};
    else if (t === "array") out[k] = [];
    else out[k] = "x402";
  }
  return out;
};
const KNOWN_ARGS = {
  "pdf.markdown": { url: "https://example.com/a.pdf" },
  "weather.current": { lat: 48.86, lon: 2.35 },
  "macro.series": { seriesId: "UNRATE" },
  "browser.render": { url: "https://example.com" },
  "audio.transcribe": { url: "https://example.com/a.mp3" },
  "memory.read": { key: "structured-check" },
  "memory.write": { key: "structured-check", value: 1 },
  "decide.plan": { task: "find the ENS owner of vitalik.eth" },
  // The route's published example: a free plan sketch, priced at its steps.
  "decide.execute": { steps: ["ens-resolve", "wallet-balance"], params: { 1: { name: "vitalik.eth" } } },
};

// Flagships whose run can outlast the connector's blocking wait: never offered
// over x402 on the connector (src/mcp-http.js isLongCall).
const LONG_CALLS = new Set(["decide.execute"]);

let srv = null;
const clients = [];
try {
  srv = await bootServer({ stores: "mcp-x402-structured", args: ["--import", "./scripts/lib/loopback-only-preload.js"], env: ENV });
  const B = srv.url;
  const v1 = new Client({ name: "test-mcp-x402-structured", version: "0.0.0" });
  await v1.connect(new StreamableHTTPClientTransport(new URL(`${B}/mcp`), { requestInit: { headers: { "X-Forwarded-For": "203.0.113.70" } } }));
  clients.push(v1);
  const listed = (await v1.listTools()).tools; // arms the client's output check
  const flagshipNames = new Set(Object.values(FLAGSHIP_MCP_NAMES));
  const flagships = listed.filter((t) => flagshipNames.has(t.name));
  ok(flagships.length >= 8 && flagships.every((t) => t.outputSchema) && ["decide.plan", "decide.execute", "pdf.markdown", "browser.render", "memory.read"].every((n) => flagships.some((t) => t.name === n)),
    `the boot lists the flagships, each with an outputSchema (${flagships.map((t) => t.name).join(", ")})`);

  const v2mod = await import("@modelcontextprotocol/client");
  const v2 = new v2mod.Client({ name: "test-mcp-x402-structured-2026", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await v2.connect(new v2mod.StreamableHTTPClientTransport(new URL(`${B}/mcp`), { requestInit: { headers: { "X-Forwarded-For": "203.0.113.71" } } }));
  clients.push(v2);
  await v2.listTools();
  ok(v2.getProtocolEra() === "modern", "the v2 client settles on 2026-07-28");

  const asks = [
    ...flagships.map((t) => ({ name: t.name, args: KNOWN_ARGS[t.name] || argsFor(t), schema: t.outputSchema, expectStructured: true, longCall: LONG_CALLS.has(t.name) })),
    { name: "catalog.call", args: { slug: "search", params: { q: "x402" } }, schema: listed.find((t) => t.name === "catalog.call")?.outputSchema, expectStructured: false },
    { name: "catalog.call", args: { slug: "render", params: { url: "https://example.com" } }, schema: listed.find((t) => t.name === "catalog.call")?.outputSchema, expectStructured: false },
    // A former flagship: unlisted, so no client holds its ask to a schema.
    { name: FORMER_FLAGSHIP_MCP_NAMES.search, args: { q: "x402" }, schema: null, expectStructured: true },
  ];
  let reachable = 0;
  for (const a of asks) {
    const label = a.name === "catalog.call" ? `catalog.call ${a.args.slug}` : a.name;
    for (const [era, client] of [["2025 (SDK v1)", v1], ["2026-07-28 (SDK v2)", v2]]) {
      let r = null, threw = null;
      try { r = await client.callTool({ name: a.name, arguments: a.args }); } catch (e) { threw = e; }
      // (b) the reference client reads the unpaid ask as a tool result.
      ok(!threw && r?.isError === true, `${label}, ${era}: the unpaid call is read as an isError result, not thrown${threw ? ` (${threw.code ?? ""} ${String(threw.message).slice(0, 160)})` : ""}`);
      if (!r) continue;
      const pr = PR(r);
      if (a.longCall) {
        // Its run outlasts the blocking wait, so it is never offered over
        // x402 here (paid over MPP as a task, or on its HTTP route): no
        // PaymentRequired, in the text or as structuredContent.
        ok(!pr && !("structuredContent" in r) && /blocking wait/.test(String(r.content?.[0]?.text)), `${label}, ${era}: a long call answers no x402 offer and no structuredContent`);
        continue;
      }
      ok(pr?.x402Version === 2 && Array.isArray(pr.accepts) && pr.accepts.some((x) => x.network === BASE_NET), `${label}, ${era}: the first text block is the x402 PaymentRequired${pr ? "" : ` (${String(r.content?.[0]?.text).slice(0, 200)})`}`);
      if (!pr) continue;
      if (era.startsWith("2025")) reachable++;
      // (a) the structured copy, exactly where the listed schema admits it.
      if (a.expectStructured) {
        ok(JSON.stringify(r.structuredContent) === JSON.stringify(pr), `${label}, ${era}: structuredContent is the PaymentRequired (${JSON.stringify(r.structuredContent ?? null).slice(0, 80)})`);
        if (a.schema) ok(failsUnder(a.schema, r.structuredContent).length === 0, `${label}, ${era}: it validates against the listed outputSchema under both SDK validators`);
      } else {
        ok(!("structuredContent" in r) && a.schema && failsUnder(a.schema, pr).length === 2, `${label}, ${era}: no structuredContent, since the listed envelope schema does not admit the PaymentRequired`);
      }
    }
  }
  ok(reachable === asks.filter((x) => !x.longCall).length, `every ask checked reached the x402 wire (${reachable} of ${asks.filter((x) => !x.longCall).length}; long calls: ${[...LONG_CALLS].join(", ")})`);
} catch (e) {
  ok(false, `booted half: ${e?.stack || String(e)}${srv ? `\n${srv.log().slice(-2000)}` : ""}`);
} finally {
  for (const c of clients) { try { await c.close(); } catch { /* closed */ } }
  await srv?.stop();
  facilitator.closeAllConnections?.();
  await new Promise((r) => facilitator.close(r));
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
