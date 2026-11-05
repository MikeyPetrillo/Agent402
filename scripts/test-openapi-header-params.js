// Locks the openapi.json header-parameter fix (2026-08-16 audit): every
// operation's `parameters` only ever declared query/path params (GET) or
// requestBody (POST) - the two headers every catalog tool actually accepts,
// X-Pow-Solution (free-tier PoW alternative to x402 payment) and
// Idempotency-Key (safe-retry dedup), were real and documented in prose
// (/docs, /llms.txt, quickstart) but invisible to any OpenAPI-driven client
// (Postman, codegen, an agent framework reading the spec instead of prose).
//
// This boots FREE_MODE, fetches /openapi.json, and asserts:
//   1. Idempotency-Key is declared as `in: header` on every operation sampled.
//   2. X-Pow-Solution is declared on PoW-eligible (non-wallet-only) tools.
//   3. X-Pow-Solution is ABSENT on a known wallet-only tool (memory) - PoW
//      cannot pay for it, so advertising the header there would mislead a
//      codegen client into thinking it has a free-tier option that doesn't
//      exist.
//   4. Neither header is ever marked `required` (both are optional).
//
//   node scripts/test-openapi-header-params.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3097;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  const spec = await (await fetch(`${BASE}/openapi.json`)).json();
  const pricing = await (await fetch(`${BASE}/api/pricing`)).json();
  const catalog = pricing.endpoints || [];
  ok(catalog.length > 0, "catalog is non-empty");

  const opFor = (path) => Object.values(spec.paths[path] || {})[0];
  const paramNamed = (op, name) => (op?.parameters || []).find((p) => p.name === name);

  let idemDeclared = 0, idemOptional = 0;
  for (const tool of catalog.slice(0, 30)) {
    const op = opFor(tool.path);
    const p = paramNamed(op, "Idempotency-Key");
    if (p && p.in === "header") idemDeclared++;
    if (p && p.required !== true) idemOptional++;
  }
  ok(idemDeclared === 30, `Idempotency-Key declared as in:header on first 30 tools (got ${idemDeclared}/30)`);
  ok(idemOptional === 30, `Idempotency-Key is never required (got ${idemOptional}/30 optional)`);

  // hash is a well-known PoW-eligible (compute-payable) tool.
  const hashOp = opFor("/api/hash");
  const powParam = paramNamed(hashOp, "X-Pow-Solution");
  ok(!!powParam, "X-Pow-Solution declared on a PoW-eligible tool (hash)");
  ok(powParam?.in === "header", "X-Pow-Solution is in:header");
  ok(powParam?.required !== true, "X-Pow-Solution is not required (x402 payment is the alternative)");

  // memory is wallet-only (payment = identity) - PoW must never be advertised.
  const memoryTool = catalog.find((t) => t.slug === "memory-get" || t.path === "/api/memory");
  if (memoryTool) {
    const memOp = opFor(memoryTool.path);
    ok(!paramNamed(memOp, "X-Pow-Solution"), "X-Pow-Solution is ABSENT on a wallet-only tool (memory)");
  } else {
    ok(false, "found a wallet-only tool (memory) in the live catalog to check against");
  }

  proc.kill("SIGKILL");
} catch (e) {
  fail(e?.message || String(e));
}

console.log(`\nOK: ${pass} passed`);
process.exit(0);
