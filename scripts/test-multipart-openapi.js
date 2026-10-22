#!/usr/bin/env node
// Every multipart route (discovery bodyType "form-data") publishes its body on
// /openapi.json as multipart/form-data, and the published example, sent the
// way the document describes it, reaches the route:
//   - paid mode (stub facilitator, no payment): the unpaid call answers 402,
//     carrying a bazaar input that says form-data;
//   - FREE_MODE (handler runs, every model key blank so nothing reaches an
//     upstream): the multipart call is parsed and passes to the upstream step
//     (a 503 without a key), never the 400 or 415 a wrong body gets, while the
//     JSON body the document used to describe still answers 400.
// Nothing pays and nothing calls a vendor.
//
//   node scripts/test-multipart-openapi.js
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePorts } from "./lib/free-port.js";
import { isMultipartOperation, requestExampleOf, multipartBodyFrom, MULTIPART_TYPE } from "../src/openapi-request.js";
import { STT_TOOLS } from "../src/tools/stt-kit.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FIXTURE = readFileSync(path.join(ROOT, "assets/fixtures/sample-speech.wav"));

// Keys a serving path could reach: blank on both boots, so a handler that runs
// stops at the missing key and nothing leaves the machine.
const NO_KEYS = { OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", ELEVENLABS_API_KEY: "", UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: "" };
const QUIET = { X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", SOLANA_LEADERBOARD: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", STATS_ALLOW_EPHEMERAL: "true" };

async function boot(port, env) {
  const child = spawn(process.execPath, ["src/server.js"], { cwd: ROOT, env: { ...process.env, ...NO_KEYS, ...QUIET, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 480; i++) {
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).ok) return { base, child }; } catch { /* booting */ }
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${log.slice(-2000)}`);
    await wait(250);
  }
  child.kill("SIGKILL"); throw new Error(`no /health\n${log.slice(-2000)}`);
}

const send = (url, op) => {
  const ex = requestExampleOf(op).example;
  return fetch(url, { method: "POST", headers: { Accept: "application/json" }, body: multipartBodyFrom(ex, { bytes: FIXTURE, type: "audio/wav", filename: "sample-speech.wav" }), signal: AbortSignal.timeout(30_000) });
};
const decode = (h) => { try { return JSON.parse(Buffer.from(h || "", "base64").toString("utf8")); } catch { return null; } };

const formDataRoutes = STT_TOOLS.filter((t) => t.discovery?.bodyType === "form-data").map((t) => t.route);
ok(formDataRoutes.length >= 2, `the kit declares its multipart routes (${formDataRoutes.join(", ")})`);

const [paidPort, freePort, facPort] = await getFreePorts(3);
const facilitator = createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    if (req.url === "/supported") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} })); }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => facilitator.listen(facPort, "127.0.0.1", r));

const servers = [];
try {
  const [paid, free] = await Promise.all([
    boot(paidPort, { FREE_MODE: "", NODE_ENV: "test", NETWORK: "base", PAYMENT_NETWORKS: "base", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", FACILITATOR_URL: `http://127.0.0.1:${facPort}`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "" }),
    boot(freePort, { FREE_MODE: "true" }),
  ]);
  servers.push(paid.child, free.child);

  const spec = await (await fetch(`${paid.base}/openapi.json`, { signal: AbortSignal.timeout(60_000) })).json();
  const multipartOps = [];
  for (const [p, methods] of Object.entries(spec.paths || {})) for (const [m, op] of Object.entries(methods || {})) if (isMultipartOperation(op)) multipartOps.push([`${m.toUpperCase()} ${p}`, op]);
  ok(JSON.stringify(multipartOps.map(([k]) => k).sort()) === JSON.stringify([...formDataRoutes].sort()), `the multipart operations on /openapi.json are exactly the form-data routes (${multipartOps.length})`);

  for (const [key, op] of multipartOps) {
    const p = key.split(" ")[1];
    const content = op.requestBody?.content || {};
    ok(Object.keys(content).length === 1 && content[MULTIPART_TYPE], `${key}: the body is published as multipart/form-data only`);
    const schema = content[MULTIPART_TYPE]?.schema;
    ok(schema?.properties?.file?.type === "string" && schema.properties.file.format === "binary" && (schema.required || []).includes("file"), `${key}: the schema names a required binary file part`);
    ok(content[MULTIPART_TYPE]?.example && typeof content[MULTIPART_TYPE].example === "object", `${key}: the example is published with it`);

    const r = await send(`${paid.base}${p}`, op);
    await r.text().catch(() => "");
    ok(r.status === 402, `${key}: the published example sent as multipart answers 402 unpaid (got ${r.status})`);
    const pr = decode(r.headers.get("payment-required"));
    ok(pr?.extensions?.bazaar?.info?.input?.bodyType === "form-data", `${key}: the 402's bazaar input says form-data`);

    const f = await send(`${free.base}${p}`, op);
    const fb = await f.json().catch(() => ({}));
    ok(f.status !== 400 && f.status !== 415 && f.status !== 404, `${key}: the multipart example is parsed by the route on FREE_MODE (got ${f.status}${fb?.error ? ` ${String(fb.error).slice(0, 80)}` : ""})`);
    const j = await fetch(`${free.base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestExampleOf(op).example), signal: AbortSignal.timeout(30_000) });
    await j.text().catch(() => "");
    ok(j.status === 400, `${key}: control - the same example as a JSON body is refused with 400 (got ${j.status})`);
  }

  // A JSON route is untouched.
  const jsonOp = spec.paths?.["/api/transcribe"]?.post;
  ok(!!jsonOp?.requestBody?.content?.["application/json"] && !isMultipartOperation(jsonOp), "a JSON route keeps its application/json body");
} finally {
  for (const c of servers) c.kill("SIGKILL");
  facilitator.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
