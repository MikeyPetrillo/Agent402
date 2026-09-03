#!/usr/bin/env node
// Full paid-route contract sweep for the data emitted in PAYMENT-REQUIRED.
// Boots the real server against a local /supported stub: no payment is made,
// but every catalog route builds the same x402 v2 challenge as production.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { getFreePorts } from "./lib/free-port.js";
import { parsePaymentRequired, ResourceInfoSchema } from "@x402/core/schemas";
import {
  validateDiscoveryExtension,
  validateDiscoveryExtensionSpec,
} from "@x402/extensions/bazaar";
import { boundedSchemaFromExample, SHAPE_HAPPY_PATH_ONLY } from "../src/openapi-schema.js";

const MAX_CHALLENGE_BYTES = 12_000;
const CURRENT_PRODUCTION_ROUTE_FLOOR = 560;
const CONCURRENCY = 12;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const [port, facPort] = await getFreePorts(2);
const base = `http://127.0.0.1:${port}`;

// Preserve the original helper contract: it exists for JSON object outputs.
// The new route-aware helper used by payments owns scalar/array handling.
for (const value of [null, "raw", [1, 2], 7, true]) {
  if (boundedSchemaFromExample(value, 500) !== null) {
    throw new Error(`boundedSchemaFromExample accepted non-object ${JSON.stringify(value)}`);
  }
}
if (boundedSchemaFromExample({ ok: true }, 500)?.type !== "object") {
  throw new Error("boundedSchemaFromExample stopped accepting object outputs");
}

const facilitator = createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    if (req.url === "/supported") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
        extensions: [], signers: {},
      }));
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((resolve) => facilitator.listen(facPort, "127.0.0.1", resolve));

let serverLog = "";
const child = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env,
    PORT: String(port), FREE_MODE: "", NODE_ENV: "test",
    NETWORK: "base", PAYMENT_NETWORKS: "base",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    FACILITATOR_URL: `http://127.0.0.1:${facPort}`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
    // Mirror the current production catalog gates without contacting any
    // upstream: payment middleware runs before handlers, so dummy non-secret
    // values are sufficient to include the nine gated paid routes.
    OPENROUTER_TTS_ENABLED: "true", X_BEARER_TOKEN: "test",
    APOLLO_API_KEY: "test",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
    MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    STATS_ALLOW_EPHEMERAL: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => { serverLog += d; });
child.stderr.on("data", (d) => { serverLog += d; });

const failures = [];
const fail = (route, problem) => failures.push(`${route}: ${problem}`);
const jsonType = (v) => Array.isArray(v) ? "array"
  : v === null ? "null"
  : Number.isInteger(v) ? "integer"
  : typeof v === "number" ? "number"
  : typeof v;

try {
  let up = false;
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* booting */ }
    await wait(250);
  }
  if (!up) throw new Error(`server did not boot: ${serverLog.slice(-1200)}`);

  const pricing = await (await fetch(`${base}/api/pricing`)).json();
  const endpoints = Array.isArray(pricing.endpoints) ? pricing.endpoints : [];
  if (!endpoints.length) throw new Error("/api/pricing listed no endpoints");
  if (endpoints.length < CURRENT_PRODUCTION_ROUTE_FLOOR) {
    throw new Error(`catalog shrank to ${endpoints.length}; expected at least ${CURRENT_PRODUCTION_ROUTE_FLOOR} current paid routes`);
  }

  let cursor = 0;
  const rows = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < endpoints.length) {
      const endpoint = endpoints[cursor++];
      const method = String(endpoint.method || "GET").toUpperCase();
      const route = `${method} ${endpoint.path}`;
      try {
        const response = await fetch(`${base}${endpoint.path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: ["POST", "PUT", "PATCH"].includes(method) ? "{}" : undefined,
          signal: AbortSignal.timeout(20_000),
        });
        const encoded = response.headers.get("payment-required") || "";
        rows.push({ endpoint, route, status: response.status, encoded });
      } catch (error) {
        fail(route, `request failed: ${error?.message || error}`);
      }
    }
  }));

  let requiredRoutes = 0;
  let variableRoutes = 0;
  let rawRoutes = 0;
  let largest = { route: "", bytes: 0 };
  let speechSeen = false;
  let specificTagSeen = false;

  for (const { endpoint, route, status, encoded } of rows) {
    if (status !== 402) { fail(route, `expected 402, got ${status}`); continue; }
    if (!encoded) { fail(route, "missing PAYMENT-REQUIRED header"); continue; }
    if (encoded.length > largest.bytes) largest = { route, bytes: encoded.length };
    if (encoded.length > MAX_CHALLENGE_BYTES) fail(route, `${encoded.length}-byte challenge exceeds ${MAX_CHALLENGE_BYTES}`);

    let paymentRequired;
    try { paymentRequired = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); }
    catch (error) { fail(route, `challenge is not base64 JSON: ${error?.message || error}`); continue; }

    const parsed = parsePaymentRequired(paymentRequired);
    if (!parsed.success) fail(route, `PaymentRequiredSchema: ${parsed.error.issues[0]?.message || "invalid"}`);
    const resource = ResourceInfoSchema.safeParse(paymentRequired.resource);
    if (!resource.success) fail(route, `ResourceInfoSchema: ${resource.error.issues[0]?.message || "invalid"}`);
    const tags = paymentRequired.resource?.tags;
    if (Array.isArray(tags) && tags.length > 5) fail(route, `resource carries ${tags.length} tags (max 5)`);
    if (endpoint.path === "/api/extract") {
      specificTagSeen = Array.isArray(tags) && tags.includes("scraping");
      if (!specificTagSeen) fail(route, `route-specific tag "scraping" was displaced (${JSON.stringify(tags)})`);
    }

    const extension = paymentRequired.extensions?.bazaar;
    if (!extension) { fail(route, "missing bazaar extension"); continue; }
    const spec = validateDiscoveryExtensionSpec(extension);
    if (!spec.valid) fail(route, `Bazaar spec: ${(spec.errors || []).join("; ")}`);
    const schema = validateDiscoveryExtension(extension);
    if (!schema.valid) fail(route, `Bazaar schema: ${(schema.errors || []).join("; ")}`);

    const example = extension.info?.output?.example;
    const outputSchema = extension.schema?.properties?.output?.properties?.example;
    // accepts[0].outputSchema (2026-09-02): the spec's own field carries the
    // extension's typed schema, on the FIRST accept only (one copy, never per
    // rail: the buyer echoes the challenge back).
    const accepts = Array.isArray(paymentRequired.accepts) ? paymentRequired.accepts : [];
    if (outputSchema) {
      if (JSON.stringify(accepts[0]?.outputSchema) !== JSON.stringify(outputSchema)) fail(route, "accepts[0].outputSchema is not the extension's typed output schema");
      if (accepts.slice(1).some((a) => a.outputSchema !== undefined)) fail(route, "outputSchema duplicated onto a later accept");
    } else if (accepts[0]?.outputSchema !== undefined) fail(route, "accepts[0].outputSchema present with no extension schema to source it");
    if (example === undefined || !outputSchema) continue;
    if (JSON.stringify(outputSchema).length > 500) fail(route, "output schema exceeds the 500-byte budget");

    const type = jsonType(example);
    if (type === "object") {
      const required = Array.isArray(outputSchema.required) ? outputSchema.required : [];
      const published = Object.keys(outputSchema.properties || {})
        .filter((key) => example[key] !== null && example[key] !== undefined);
      if (SHAPE_HAPPY_PATH_ONLY.has(endpoint.path)) {
        variableRoutes++;
        if (required.length) fail(route, `variable route invents required fields: ${required.join(",")}`);
      } else if (published.length) {
        requiredRoutes++;
        const missing = published.filter((key) => !required.includes(key));
        if (missing.length) fail(route, `published fixed fields are not required: ${missing.join(",")}`);
      }
    } else {
      rawRoutes++;
      const compatible = outputSchema.type === type
        || (type === "integer" && outputSchema.type === "number");
      if (!compatible) fail(route, `raw ${type} example is declared ${outputSchema.type || "without a type"}`);
    }

    if (endpoint.path === "/v1/audio/speech") {
      speechSeen = true;
      if (type === "object" || outputSchema.type === "object") {
        fail(route, "/v1/audio/speech raw output is still declared as an object");
      }
    }
  }

  if (rows.length !== endpoints.length) fail("catalog", `probed ${rows.length}/${endpoints.length} endpoints`);
  if (!speechSeen) fail("POST /v1/audio/speech", "route was not validated as a raw output");
  if (!specificTagSeen) fail("POST /api/extract", "representative route-specific tag did not survive sanitization");

  console.log(`catalog routes: ${endpoints.length}`);
  console.log(`route-aware required schemas: ${requiredRoutes}; variable schemas without required: ${variableRoutes}; raw/array schemas: ${rawRoutes}`);
  console.log(`largest challenge: ${largest.route} at ${largest.bytes} bytes`);
  if (failures.length) {
    for (const problem of failures.slice(0, 40)) console.error(`FAIL - ${problem}`);
    if (failures.length > 40) console.error(`... ${failures.length - 40} more failure(s)`);
  }
  console.log(`${failures.length ? "FAILED" : "OK"}: ${endpoints.length - failures.length}/${endpoints.length} route checks green`);
  process.exitCode = failures.length ? 1 : 0;
} finally {
  try { child.kill("SIGKILL"); } catch { /* stopped */ }
  await new Promise((resolve) => facilitator.close(resolve));
}
