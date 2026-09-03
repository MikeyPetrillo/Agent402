// Locks the fix for a real, upstream-disclosed payment bypass
// (x402-foundation/x402 CHANGELOG, @x402/core 2.21.0, commit 5192e50):
// the compiled wildcard-route regex used `.*?` without the dotAll flag, so a
// percent-encoded ECMAScript line terminator (U+2028, LF, CR) surviving path
// normalization would fail to match, causing requiresPayment() to return
// false and the middleware to skip payment verification and settlement
// entirely - a request to a paid wildcard route landed on the handler for
// free.
//
// This is not theoretical for us: /api/convert/* and /api/convert-* (the
// retired pairwise unit-converter compatibility shim, ~970 legacy paths,
// server.js's extraRoutes) are real, currently-registered wildcard routes.
// Found in an internal audit 2026-08-16 while investigating whether the
// @x402/express pin (was 2.16.0, before this fix) needed bumping - it did,
// not just for hygiene but because this exact bug was live in production.
//
// Requires the real (non-FREE_MODE) paywall path with a stub facilitator,
// same pattern as test-head-paywall.js.
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const PORT = 3091, FAC_PORT = 3092;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const facilitator = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
});
await new Promise((r) => facilitator.listen(FAC_PORT, r));

const proc = spawn("node", ["src/server.js"], {
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
    MPP_SECRET_KEY: "test-mpp-secret",
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", PAYMENT_NETWORKS: "base",
  },
  stdio: "ignore",
});

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

try {
  const BASE = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  // Baseline: an ordinary request to the wildcard-matched legacy route must
  // require payment (402) - proves the route is actually paywall-gated,
  // so the payloads below are testing a real gate, not an already-open door.
  const normal = await fetch(`${BASE}/api/convert-miles-to-kilometers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: 1 }) });
  ok(normal.status === 402, `ordinary /api/convert-* request requires payment (got ${normal.status})`);

  // The actual disclosed bypass shape: a percent-encoded ECMAScript line
  // terminator inside the wildcard-matched segment. The only failure mode
  // is a free 200 that actually performed the conversion (the bypass) -
  // a 402 (still gated) or a clean 404/400 (path doesn't resolve) are both
  // fine outcomes.
  const payloads = [
    { name: "LINE SEPARATOR U+2028 (%E2%80%A8)", path: "/api/convert-miles-to-kilometers%E2%80%A8x" },
    { name: "LF (%0A)", path: "/api/convert-miles-to-kilometers%0Ax" },
    { name: "CR (%0D)", path: "/api/convert-miles-to-kilometers%0Dx" },
    { name: "PARAGRAPH SEPARATOR U+2029 (%E2%80%A9)", path: "/api/convert-miles-to-kilometers%E2%80%A9x" },
  ];
  for (const p of payloads) {
    const res = await fetch(`${BASE}${p.path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: 1 }) });
    // Exactly 402, not merely "not 200": this route also has its own strict
    // downstream unit-pair parser, which independently 404s a mangled path
    // regardless of the x402-level gate - so "not 200" alone would pass even
    // if the payment gate itself silently stopped firing (a real regression
    // that would still bite any route whose downstream handler is more
    // permissive about what it accepts). Requiring exactly 402 proves the
    // gate itself is still active, not just that this particular route
    // happens to have a second line of defense.
    ok(res.status === 402, `${p.name}: still requires payment on the wildcard route (got ${res.status})`);
  }

  console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} finally {
  try { proc.kill("SIGKILL"); } catch {}
  try { facilitator.close(); } catch {}
}
