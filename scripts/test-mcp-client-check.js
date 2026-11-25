// test-mcp-client-check - scripts/mcp-client-check.js (the hosted connector
// read by an independent @modelcontextprotocol/sdk client) passes against a
// real FREE_MODE boot (with and without MPP_SECRET_KEY set: no paywall, so no
// payment capability either way) and against paid boots (x402 and MPP in the
// call, and x402 alone), and fails against a connector that drifted. Every
// run is made twice: with the SDK v1 Client on 2025-11-25 (initialize) and
// with the SDK v2 Client pinned to 2026-07-28 (server/discover and the
// per-request envelope), so both protocol revisions the connector serves are
// read by a reference client.
//
// The positive half boots src/server.js on PORT=0, reads the bound port back,
// and runs the check against it: exit 0, every check line ok, the JSON summary
// written. The negative half is the live control the positive half needs: a
// stub connector built on the same SDK (the shapes the check reads, nothing
// else) passes the check unchanged, and each deliberate break (a tool missing
// from tools/list, an empty description, a wrong free-tool answer, a payment
// ask carried as structuredContent on a tool with an outputSchema, a paid tool
// that runs unpaid) makes the
// check exit non-zero naming that check. Without the unchanged stub passing,
// a break's failure would prove nothing about the assertion it targets.
//
//   node scripts/test-mcp-client-check.js        (offline: no network, no spend)
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { AjvJsonSchemaValidator as AjvJsonSchemaValidatorV2 } from "@modelcontextprotocol/client/validators/ajv";
import { bootServer as bootPaid } from "./lib/boot-server.js";
import { FLAGSHIP_OUTPUT_SCHEMAS, META_OUTPUT_SCHEMAS, outputSchemaFromExample } from "../src/mcp-flagship.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = join(ROOT, "scripts", "mcp-client-check.js");
const TMP = mkdtempSync(join(tmpdir(), "a402-mcp-client-check-"));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Asynchronous on purpose: the stub connectors below live in THIS process, so
// a blocking spawnSync would starve them and every check would time out.
const PROTOCOLS = ["2025-11-25", "2026-07-28"];
function runCheck(baseUrl, outName, protocol = "2025-11-25") {
  const out = join(TMP, `${protocol}-${outName}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHECK], {
      env: { ...process.env, TARGET_URL: baseUrl, MCP_CHECK_TARGET: "", MCP_CHECK_OUT: out, MCP_CHECK_CALL_TIMEOUT_MS: "20000", MCP_CHECK_PROTOCOL: protocol },
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
  // Both reference clients: SDK v1 (2025-11-25) and SDK v2 (2026-07-28).
  const validators = [new AjvJsonSchemaValidator(), new AjvJsonSchemaValidatorV2()];
  const compiles = (schema) => { try { for (const v of validators) v.getValidator(schema); return null; } catch (err) { return err.message; } };
  const tables = { ...Object.fromEntries(Object.entries(FLAGSHIP_OUTPUT_SCHEMAS).map(([k, v]) => [`flagship ${k}`, v])), ...Object.fromEntries(Object.entries(META_OUTPUT_SCHEMAS).map(([k, v]) => [`meta ${k}`, v])) };
  const bad = Object.entries(tables).map(([k, s]) => [k, compiles(s)]).filter(([, e]) => e);
  ok(Object.keys(tables).length >= 10 && bad.length === 0, `every hand-written outputSchema compiles under both SDK validators (${Object.keys(tables).length} schemas)${bad.length ? `: ${bad.map(([k, e]) => `${k}: ${e}`).join("; ")}` : ""}`);
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

async function bootServer(mppKey = "") {
  const child = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      FREE_MODE: "true",
      MPP_SECRET_KEY: mppKey,
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

// Twice: with no MPP key, and with MPP_SECRET_KEY set. A FREE_MODE boot has no
// paywall, so the key changes nothing: no payment capability advertised, no
// paid tool run, the same setup text.
for (const [label, mppKey] of [["FREE_MODE", ""], ["FREE_MODE with MPP_SECRET_KEY set", randomBytes(24).toString("hex")]]) {
  let child = null;
  try {
    const booted = await bootServer(mppKey);
    child = booted.child;
    ok(booted.port > 0, `${label}: server booted on PORT=0 and printed the bound port (${booted.port})`);
    for (const protocol of PROTOCOLS) {
      const r = await runCheck(`http://127.0.0.1:${booted.port}`, `real-${mppKey ? "key" : "nokey"}.json`, protocol);
      const tag = `${label} (${protocol})`;
      ok(r.status === 0, `${tag}: the check exits 0 against the real connector${r.status === 0 ? "" : `\n${r.stdout}\n${r.stderr}`}`);
      const lines = r.stdout.split("\n").filter((l) => /^(ok|FAIL) - /.test(l));
      ok(lines.length >= 10 && lines.every((l) => l.startsWith("ok - ")), `${tag}: every check line is ok (${lines.length} lines)`);
      ok(r.summary && r.summary.failed === 0 && r.summary.passed === lines.length && r.summary.target.endsWith("/mcp") && r.summary.protocol === protocol, `${tag}: the JSON summary matches the lines (passed, failed, target, protocol)`);
      const opener = protocol === "2026-07-28" ? "server/discover" : "initialize";
      for (const name of [opener, "tools/list", "server.describe", "payment.info", "catalog.search", "catalog.find", "sellers.list", "catalog.call", "web.search without payment", "memory.write without payment", "catalog.call search without payment", "tasks"]) {
        ok((r.summary?.checks || []).some((c) => c.name.startsWith(name) && c.ok), `${tag}: summary carries a passing "${name}" check`);
      }
    }
    const init = await fetch(`http://127.0.0.1:${booted.port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    }).then((x) => x.text());
    ok(/"capabilities"/.test(init) && !/"payment"\s*:\s*\{\s*"methods"/.test(init), `${label}: initialize advertises no payment capability`);
    const discover = await fetch(`http://127.0.0.1:${booted.port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" } } } }),
    }).then((x) => x.text());
    ok(/"supportedVersions":\[[^\]]*"2026-07-28"/.test(discover) && /"capabilities"/.test(discover) && !/"payment"\s*:\s*\{\s*"methods"/.test(discover), `${label}: server/discover lists 2026-07-28 and advertises no payment capability`);
  } catch (err) {
    ok(false, `${label}: real server: ${err.message}`);
  } finally {
    if (child) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  }
}

// ------------------------------------------------------------ paid boot
// The same check against a boot WITH a paywall (x402 and MPP in the call, as
// production runs): there the unpaid asks carry real offers, and each one
// must still be a result this client reads.
{
  const facilitator = createHttpServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/supported") return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
      if (req.url === "/rpc") return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }));
      res.end("{}");
    });
  });
  await new Promise((r) => facilitator.listen(0, "127.0.0.1", r));
  const FAC = `http://127.0.0.1:${facilitator.address().port}`;
  for (const [label, mppKey] of [["x402 and MPP", randomBytes(24).toString("hex")], ["x402 alone", ""]]) {
    let srv = null;
    try {
      srv = await bootPaid({
        stores: `mcp-client-check-paid-${mppKey ? "both" : "x402"}`,
        args: ["--import", "./scripts/lib/loopback-only-preload.js"],
        env: {
          NODE_ENV: "test", BASE_URL: "https://agent402.tools", REDIS_URL: "", STATE_DATABASE_URL: "", TARGET_URL: "", POSTHOG_API_KEY: "",
          STATS_ALLOW_EPHEMERAL: "true", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", REVENUE_WARMUP: "off",
          TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", ROBINHOOD_RELAYER_KEY: "",
          FREE_MODE: "", TRUST_PROXY_HOPS: "1", MPP_SECRET_KEY: mppKey,
          WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
          FACILITATOR_URL: FAC, PAYAI_FACILITATOR_URL: FAC, AGENT402_BASE_RPC: `${FAC}/rpc`, EVM_RPC_8453: `${FAC}/rpc`, FACILITATOR_GAS_CHECK: "off",
          CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYAI_API_KEY_ID: "", PAYAI_API_KEY_SECRET: "", SOLVADOR_KEY: "", CIRCLE_FACILITATOR_API_KEY: "",
          AGENT402_MCP_MAX_PER_MIN: "1000000", AGENT402_MCP_MAX_PER_HOUR: "1000000", AGENT402_SHOW_ROUTER: "1",
        },
      });
      for (const protocol of PROTOCOLS) {
        const r = await runCheck(srv.url, `paid-${mppKey ? "both" : "x402"}.json`, protocol);
        const tag = `paid boot (${label}, ${protocol})`;
        ok(r.status === 0, `${tag}: the check exits 0${r.status === 0 ? "" : `\n${r.stdout}\n${r.stderr}`}`);
        // market.quote is a flagship only where the catalog lists stock-quote
        // (this boot has no stock provider), macro.series only where it lists
        // us-macro-series: the six listed paid flagships, macro.series when
        // listed, the former web.search by name, and catalog.call.
        const pricingCheck = (r.summary?.checks || []).find((c) => c.name.startsWith("catalog: /api/pricing") && c.ok);
        const stockListed = /^stock-quote listed/.test(String(pricingCheck?.detail || ""));
        const macroListed = /\bus-macro-series listed/.test(String(pricingCheck?.detail || ""));
        const want = 8 + (stockListed ? 1 : 0) + (macroListed ? 1 : 0);
        ok(!stockListed, `${tag}: the catalog of a boot with no stock provider does not list stock-quote`);
        const unpaid = (r.summary?.checks || []).filter((c) => / without payment: /.test(c.name));
        ok(unpaid.length === want && unpaid.every((c) => c.ok), `${tag}: every listed flagship and catalog.call answer an unpaid ask the client reads (${unpaid.filter((c) => c.ok).length} of ${unpaid.length}, want ${want})`);
        const offers = r.stdout.split("\n").filter((l) => / without payment: /.test(l));
        ok(offers.length === want, `${tag}: one line per unpaid ask`);
      }
    } catch (err) {
      ok(false, `paid boot (${label}): ${err?.stack || err}`);
    } finally {
      if (srv) await srv.stop();
    }
  }
  facilitator.closeAllConnections?.();
  await new Promise((r) => facilitator.close(r));
}

// ------------------------------------------------------------ stub control

const META_TOOLS = ["catalog.search", "catalog.find", "catalog.call", "payment.info", "server.describe", "sellers.list", "demand.request"];
const CORE_FLAGSHIP_TOOLS = ["pdf.markdown", "weather.current", "browser.render", "audio.transcribe", "memory.read", "memory.write"];
const FORMER_FLAGSHIP_TOOLS = ["web.search", "web.answer", "web.news"];
const text = (obj, extra = {}) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], ...extra });

/** A connector that answers exactly the shapes the check reads, on both
 *  protocol revisions (SDK v2 createMcpHandler: 2026-07-28, and 2025-era
 *  traffic served stateless). `brk` names one deliberate drift; `stock` is
 *  whether its catalog lists stock-quote (and so market.quote). */
function stubConnector(brk = null, { stock = true } = {}) {
  // The drifts in the stock listing: market.quote listed while the catalog
  // does not list stock-quote, and the reverse.
  const catalogStock = brk === "stock-listed-off" ? false : brk === "stock-unlisted-on" ? true : stock;
  const toolStock = brk === "stock-listed-off" ? true : brk === "stock-unlisted-on" ? false : stock;
  const FLAGSHIP_TOOLS = toolStock ? [...CORE_FLAGSHIP_TOOLS, "market.quote"] : CORE_FLAGSHIP_TOOLS;
  const app = express();
  app.get("/api/pricing", (_req, res) => res.json({ endpoints: [{ slug: "hash" }, { slug: "unit-convert" }, ...(catalogStock ? [{ slug: "stock-quote" }] : [])] }));
  app.use(express.json({ limit: "1mb" }));
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "agent402", version: "stub" }, {
      capabilities: { tools: {} },
      instructions: "Stub connector for the client check: call catalog.find with your task, then catalog.call.",
    });
    server.setRequestHandler("tools/list", async () => ({
      tools: [...META_TOOLS, ...FLAGSHIP_TOOLS, ...(brk === "former-listed" ? ["web.search"] : [])]
        .filter((name) => !(brk === "missing-tool" && name === "demand.request"))
        .map((name) => ({
          name,
          description: brk === "empty-description" && name === "catalog.find" ? "" : `${name} on the stub connector.`,
          inputSchema: { type: "object", properties: {}, additionalProperties: true },
          // The drift that reached review: a tool that lists an outputSchema
          // and answers its payment ask as structuredContent.
          ...(brk === "ask-in-structured" && name === "browser.render" ? { outputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false } } : {}),
        })),
    }));
    server.setRequestHandler("tools/call", async (req) => {
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
      if (name === "catalog.call" && args.slug === "search" && brk === "paid-runs") return text({ results: [{ title: "ran unpaid" }] });
      if (FLAGSHIP_TOOLS.includes(name) || FORMER_FLAGSHIP_TOOLS.includes(name) || name === "catalog.call") {
        const offer = { x402Version: 2, error: "Payment required", resource: { url: "http://stub/mcp" }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 60 }] };
        return { content: [{ type: "text", text: JSON.stringify(offer) }, { type: "text", text: `${name} needs per-call payment: run npx agent402-mcp with AGENT_KEY.` }], isError: true, ...(brk === "ask-in-structured" && name === "browser.render" ? { structuredContent: offer } : {}) };
      }
      return { content: [{ type: "text", text: `Unknown tool "${name}".` }], isError: true };
    });
    return server;
  });
  const serve = toNodeHandler(handler);
  app.all("/mcp", (req, res) => serve(req, res, req.body));
  return new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve({ listener, port: listener.address().port }));
  });
}

const EXPECTED_FAILS = {
  "missing-tool": /^FAIL - tools\/list: .*missing: demand\.request/m,
  "empty-description": /^FAIL - tools\/list: .*catalog\.find: empty description/m,
  "wrong-answer": /^FAIL - catalog\.call: /m,
  "ask-in-structured": /^FAIL - browser\.render without payment: .*the client could not read the answer/m,
  "stock-listed-off": /^FAIL - tools\/list: .*market\.quote is listed but the catalog does not list stock-quote/m,
  "stock-unlisted-on": /^FAIL - tools\/list: .*missing: market\.quote/m,
  "paid-runs": /^FAIL - catalog\.call search without payment: /m,
  "former-listed": /^FAIL - tools\/list: .*former flagships are listed: web\.search/m,
};

for (const protocol of PROTOCOLS) {
  for (const stock of [true, false]) {
    const stub = await stubConnector(null, { stock });
    const r = await runCheck(`http://127.0.0.1:${stub.port}`, `stub-control-${stock}.json`, protocol);
    const tag = `control (${protocol}, stock ${stock ? "listed" : "not listed"})`;
    ok(r.status === 0, `${tag}: the unchanged stub connector passes the check${r.status === 0 ? "" : `\n${r.stdout}\n${r.stderr}`}`);
    const quoteAsk = (r.summary?.checks || []).some((c) => c.name.startsWith("market.quote without payment") && c.ok);
    const quoteRefused = (r.summary?.checks || []).some((c) => c.name.startsWith("market.quote unlisted") && c.ok);
    ok(stock ? quoteAsk && !quoteRefused : quoteRefused && !quoteAsk, `${tag}: market.quote is asked to pay exactly when the catalog lists stock-quote, and checked refused otherwise`);
    stub.listener.close();
  }
}
// The SDK v2 client checks structuredContent against the outputSchema only on a
// result that is not an error, so a payment ask carried that way still reads
// on 2026-07-28; the break is a drift only the v1 client (2025-11-25) catches.
const BREAK_PROTOCOLS = { "ask-in-structured": ["2025-11-25"] };
for (const [brk, re] of Object.entries(EXPECTED_FAILS)) {
  for (const protocol of BREAK_PROTOCOLS[brk] || PROTOCOLS) {
    const stub = await stubConnector(brk);
    const r = await runCheck(`http://127.0.0.1:${stub.port}`, `stub-${brk}.json`, protocol);
    ok(r.status !== 0, `break "${brk}" (${protocol}): the check exits non-zero`);
    ok(re.test(r.stdout), `break "${brk}" (${protocol}): the failing line names the drifted check${re.test(r.stdout) ? "" : `\n${r.stdout}`}`);
    ok(r.summary && r.summary.failed >= 1, `break "${brk}" (${protocol}): the JSON summary counts the failure`);
    stub.listener.close();
  }
}

{
  // Nothing listening: a transport failure is a non-zero exit, never a hang.
  const probe = express().listen(0, "127.0.0.1");
  await new Promise((r) => probe.on("listening", r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const r = await runCheck(`http://127.0.0.1:${deadPort}`, "dead.json");
  ok(r.status !== 0 && /^FAIL - initialize/m.test(r.stdout), "an unreachable connector fails the initialize check and exits non-zero");
  const m = await runCheck(`http://127.0.0.1:${deadPort}`, "dead.json", "2026-07-28");
  ok(m.status !== 0 && /^FAIL - server\/discover/m.test(m.stdout), "an unreachable connector fails the server/discover check and exits non-zero (2026-07-28)");
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\ntest-mcp-client-check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
