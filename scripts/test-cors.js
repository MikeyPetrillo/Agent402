#!/usr/bin/env node
// Cross-origin access for the machine surfaces (src/cors.js).
//
// Boots the real server and drives it the way a browser would: a preflight
// first, then the request. The unit half pins the allow/deny decision and the
// echo validation; the booted half proves the middleware runs BEFORE the gates
// (a preflight is never asked to pay and never spends a limiter token) and
// that the payment headers a buyer must read are on the expose list.
import { spawn } from "node:child_process";
import { corsAllowsPath, corsAllowHeaders, CORS_EXPOSE_HEADERS, CORS_DEFAULT_ALLOW_HEADERS } from "../src/cors.js";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`FAIL: ${m}`); } };

// --- decision -------------------------------------------------------------
for (const p of ["/api/hash", "/api/find", "/v1/chat/completions", "/.well-known/x402", "/openapi.json", "/llms.txt"])
  ok(corsAllowsPath(p), `machine surface allowed: ${p}`);
// HTML pages are read on our own origin; nothing cross-origin needs them, and
// they render third-party seller text.
for (const p of ["/", "/marketplace", "/reports", "/docs", "/tools/hash"])
  ok(!corsAllowsPath(p), `page surface NOT allowed: ${p}`);
// `/mcp` is NOT ours: src/mcp-http.js sets its own complete CORS including
// DELETE (session termination) and the Mcp-Session-Id expose header. Listing
// it here made this middleware answer the preflight first with a method list
// that omitted DELETE, which shipped to prod and broke browser MCP session
// termination for one deploy.
for (const p of ["/mcp", "/mcp/", "/mcpfoo"])
  ok(!corsAllowsPath(p), `the MCP connector answers its own CORS, not this middleware: ${p}`);

// Express routes case-insensitively (`case sensitive routing` is never set),
// so the deny list must too, or /api/status/PROBE reaches the handler while
// failing the deny test and inheriting the /api/ allow.
for (const p of ["/api/status/PROBE", "/API/STATUS/PROBE", "/__OPERATOR/stats"])
  ok(!corsAllowsPath(p), `the deny list is case-insensitive, like the router: ${p}`);
ok(corsAllowsPath("/API/hash"), "a normal tool path still allows whatever its casing");

// The operator control plane and the uptime-record writer stay closed. Note
// honestly which of these the deny list is actually load-bearing for: only
// `/api/status/probe` matches an allow prefix, so it is the one a mutation
// removing CORS_DENY_PREFIXES kills. The `/__operator` entries pass because no
// allow prefix matches them either way - the deny entry is a documented belt
// against a future `/api/__operator`-shaped path, not a live gate.
for (const p of ["/__operator", "/__operator/stats", "/__operator/credits.json", "/api/status/probe", "/api/route/external-debug"])
  ok(!corsAllowsPath(p), `operator surface denied: ${p}`);
ok(!corsAllowsPath("/api/status/probe"), "the deny list is load-bearing for the probe writer");

// The echo is bounded and validated, never reflected raw.
ok(corsAllowHeaders("payment-signature, content-type") === "payment-signature, content-type", "well-formed request headers echo");
ok(corsAllowHeaders("") === CORS_DEFAULT_ALLOW_HEADERS.join(", "), "absent list falls back to the fixed list");
for (const bad of ["x-a\r\nInjected: 1", "bad header", "a".repeat(2000), Array.from({ length: 40 }, () => "x-a").join(",")])
  ok(corsAllowHeaders(bad) === CORS_DEFAULT_ALLOW_HEADERS.join(", "), `malformed/oversized list refused: ${String(bad).slice(0, 24)}`);

// The four headers an x402/MPP buyer cannot act without.
for (const h of ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "WWW-Authenticate", "Payment-Receipt"])
  ok(CORS_EXPOSE_HEADERS.includes(h), `payment header exposed: ${h}`);

// --- booted ---------------------------------------------------------------
const PORT = await getFreePort();
const base = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stdout.on("data", () => {});
srv.stderr.on("data", () => {});
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  ok(up, "server booted");

  // A preflight is answered before any gate: 204, no body, and the client's
  // own payment header is allowed.
  const pre = await fetch(`${base}/api/hash`, {
    method: "OPTIONS",
    headers: { origin: "https://example.com", "access-control-request-method": "POST", "access-control-request-headers": "content-type, payment-signature" },
  });
  ok(pre.status === 204, `preflight is 204 (got ${pre.status})`);
  ok(pre.headers.get("access-control-allow-origin") === "*", "preflight allows any origin");
  ok(/payment-signature/i.test(pre.headers.get("access-control-allow-headers") || ""), "preflight allows the payment header");
  ok((pre.headers.get("access-control-allow-methods") || "").includes("POST"), "preflight allows POST");
  ok(Number(pre.headers.get("access-control-max-age")) > 0, "preflight is cacheable");
  ok(!pre.headers.get("access-control-allow-credentials"), "preflight never allows credentials");

  // The real call carries the expose list, so a browser can read the challenge.
  const res = await fetch(`${base}/api/hash`, {
    method: "POST", headers: { origin: "https://example.com", "content-type": "application/json" }, body: JSON.stringify({ text: "x" }),
  });
  ok(res.headers.get("access-control-allow-origin") === "*", "response allows any origin");
  const exposed = (res.headers.get("access-control-expose-headers") || "").toLowerCase();
  for (const h of ["payment-required", "www-authenticate", "payment-receipt", "x-credits-balance"])
    ok(exposed.includes(h), `response exposes ${h}`);
  ok(!res.headers.get("access-control-allow-credentials"), "response never allows credentials");

  // A page surface and the operator plane stay closed on the wire, not just in
  // the pure function.
  const page = await fetch(`${base}/`, { headers: { origin: "https://example.com" } });
  ok(!page.headers.get("access-control-allow-origin"), "a page sends no allow-origin");
  const op = await fetch(`${base}/__operator/stats`, { headers: { origin: "https://example.com" } });
  ok(!op.headers.get("access-control-allow-origin"), "the operator plane sends no allow-origin");
  // ...and an operator preflight is NOT short-circuited into a 204 success.
  const opPre = await fetch(`${base}/__operator/stats`, { method: "OPTIONS", headers: { origin: "https://example.com", "access-control-request-method": "GET" } });
  ok(opPre.status !== 204 || !opPre.headers.get("access-control-allow-origin"), "operator preflight is not granted");
} finally {
  srv.kill("SIGKILL");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
