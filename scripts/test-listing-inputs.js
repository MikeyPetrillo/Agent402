#!/usr/bin/env node
// The listing pass's purposeful inputs (scripts/listing-inputs.json) against
// each route's published input schema, before any money moves: a key that is
// not a live priced route, a body that misses a required field, carries a
// field the schema does not name, or breaks a type or enum fails here.
// Boots a FREE_MODE server on a free port and reads its /openapi.json and
// /api/pricing (RUGCHECK_TOOLS=on so the token brief is listed); the X data
// routes, listed only with an X key, are read from their kit's own schema.
// Nothing calls a tool and nothing pays.
//
//   node scripts/test-listing-inputs.js
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { getFreePort } from "./lib/free-port.js";
import { parseInputs } from "./payai-listing-pass.js";
import { X_DATA_TOOLS } from "../src/tools/x-data-kit.js";
import { EXTERNAL_EXAMPLE_INPUT } from "../src/tools/route-execute.js";
import { requestExampleOf } from "../src/openapi-request.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// The routes the owner asked for purposeful inputs on. The two route-execute
// tiers that exist to buy from an outside seller carry the same task as their
// published example (src/tools/route-execute.js EXTERNAL_EXAMPLE_INPUT).
const REQUIRED_ROUTES = [
  "POST /v1/research/pro", "POST /v1/research/max", "POST /v1/linkedin-article",
  "POST /v1/token-risk", "POST /v1/token-risk/pro", "POST /v1/token-brief",
  "POST /v1/ticker-pack", "POST /v1/recall-report", "POST /api/x-users-lookup",
  "POST /v1/premium/chat/completions", "POST /v1/premium/messages", "POST /v1/premium/gemini",
  "POST /v1/premium/responses", "POST /api/llm-premium",
  "POST /api/route/execute-max", "POST /api/route/execute-pro",
];

async function bootServer() {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.join(HERE, ".."),
    env: { ...process.env, FREE_MODE: "true", PORT: String(port), RUGCHECK_TOOLS: "on", X_BEARER_TOKEN: "", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", SOLANA_LEADERBOARD: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`; const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return { base, child }; } catch { /* booting */ }
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${log.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill("SIGKILL"); throw new Error(`no /health in 120s\n${log.slice(-2000)}`);
}

const raw = JSON.parse(readFileSync(path.join(HERE, "listing-inputs.json"), "utf8"));
const inputs = parseInputs(raw, "listing-inputs.json");
ok(inputs.size === Object.keys(raw).length, `the file parses as an inputs map (${inputs.size} routes)`);
for (const k of REQUIRED_ROUTES) ok(inputs.has(k), `${k} has a purposeful input`);
for (const k of ["POST /api/route/execute-max", "POST /api/route/execute-pro"]) {
  ok(JSON.stringify(inputs.get(k)) === JSON.stringify(EXTERNAL_EXAMPLE_INPUT), `${k}: the input is the tier's published external example`);
}
const text = readFileSync(path.join(HERE, "listing-inputs.json"), "utf8");
ok(!/—/.test(text), "no em dash in the inputs");
ok(!/(sk-|Bearer |0x[0-9a-fA-F]{64}|PRIVATE|SECRET|api[_-]?key\s*[:=])/.test(text), "no key, token or secret-shaped string in the inputs");

const { base, child } = await bootServer();
try {
  const [openapi, pricing] = await Promise.all(["/openapi.json", "/api/pricing"].map(async (p) => (await fetch(`${base}${p}`, { signal: AbortSignal.timeout(60_000) })).json()));
  const kitSchema = new Map(X_DATA_TOOLS.map((t) => [t.route, { schema: t.discovery?.inputSchema, price: t.price }]));
  const ajv = new Ajv({ strict: false, allErrors: true });
  for (const [key, body] of inputs) {
    const [method, p] = key.split(" ");
    const op = openapi.paths?.[p]?.[method.toLowerCase()];
    const schema = op ? (method === "GET" ? null : requestExampleOf(op)?.schema) : kitSchema.get(key)?.schema;
    const priced = (pricing.endpoints || []).some((e) => e.method === method && e.path === p) || kitSchema.has(key);
    ok(priced, `${key} is a priced route`);
    if (method === "GET") {
      const params = new Set((op?.parameters || []).map((x) => x.name));
      const extra = Object.keys(body).filter((k) => !params.has(k));
      ok(!!op && extra.length === 0, `${key}: every query field is a published parameter${extra.length ? ` (unknown: ${extra.join(", ")})` : ""}`);
      continue;
    }
    if (!schema) { ok(false, `${key}: no published input schema to check against`); continue; }
    const s = { type: "object", ...schema };
    const valid = ajv.validate(s, body);
    ok(valid, `${key}: the body validates against the published schema${valid ? "" : ` (${ajv.errorsText(ajv.errors)})`}`);
    const props = new Set(Object.keys(schema.properties || {}));
    const unknown = Object.keys(body).filter((k) => !props.has(k));
    ok(unknown.length === 0, `${key}: every field is one the schema names${unknown.length ? ` (unknown: ${unknown.join(", ")})` : ""}`);
  }
  // Bounds the schemas state in prose.
  ok(String(raw["POST /v1/research/pro"].query).length <= 2000 && raw["POST /v1/research/pro"].focus.length <= 8, "the research question fits its 2000-char and 8-focus bounds");
  ok(String(raw["POST /v1/linkedin-article"].topic).length <= 600, "the article topic fits its 600-char bound");
  ok(raw["POST /api/x-users-lookup"].usernames.length >= 1 && raw["POST /api/x-users-lookup"].usernames.length <= 10, "the X lookup names 1 to 10 usernames");
  ok(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw["POST /v1/token-brief"].mint), "the token brief names a base58 Solana mint");
  ok(/^0x[0-9a-fA-F]{40}$/.test(raw["POST /v1/token-risk"].address) && /^0x[0-9a-fA-F]{40}$/.test(raw["POST /v1/token-risk/pro"].address), "the token risk inputs name a 0x token address");
} finally {
  child.kill("SIGTERM");
}

// The validator itself catches a typo.
{
  const ajv = new Ajv({ strict: false });
  const schema = { type: "object", properties: { query: { type: "string" }, recency: { type: "string", enum: ["week", "month", "year", "any"] } }, required: ["query"] };
  ok(!ajv.validate(schema, { querry: "x" }) && !ajv.validate(schema, { query: "x", recency: "decade" }), "a missing required field or an out-of-enum value fails validation");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
