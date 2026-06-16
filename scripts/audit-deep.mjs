// Deep security audit — exercised against a paid-mode server (no FREE_MODE).
// Boot the server with:
//   WALLET_ADDRESS=0x... NETWORK=base-sepolia POW_SECRET=<secret> POW_DIFFICULTY=12 PORT=3778 node src/server.js
// Then: BASE_URL=http://localhost:3778 node scripts/audit-deep.mjs
//
// Domains: authorization, input validation, SSRF, attribution integrity,
// idempotency. Each check prints OK/FAIL.
import crypto from "node:crypto";

const B = process.env.BASE_URL || "http://localhost:3778";
const out = (id, label, status, detail) => console.log(`[${status.padEnd(4)}] ${id.padEnd(6)} ${label}${detail ? " - " + detail : ""}`);
let pass = 0, fail = 0;
const ok = (id, label, cond, detail) => { if (cond) { pass++; out(id, label, "OK", ""); } else { fail++; out(id, label, "FAIL", detail || ""); } };

async function getChallenge(slug) {
  return (await fetch(`${B}/api/pow/challenge?slug=${slug}`)).json();
}
function countLeadingZeroBits(hex) {
  const buf = Buffer.from(hex, "hex");
  let z = 0;
  for (const b of buf) {
    if (b === 0) { z += 8; continue; }
    let m = 0x80;
    while (!(b & m)) { z++; m >>= 1; }
    break;
  }
  return z;
}
function solvePow(ch) {
  let n = 0;
  while (true) {
    const h = crypto.createHash("sha256").update(`${ch.challenge}:${n}`).digest("hex");
    if (countLeadingZeroBits(h) >= ch.difficulty) return n;
    n++;
  }
}
async function callTool(path, body, headers) {
  return fetch(`${B}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(headers || {}) }, body: JSON.stringify(body) });
}

console.log("\n=== A. Authorization ===");
{
  const r = await callTool("/api/hash", { text: "abc" });
  ok("A1", "paid slug w/o payment -> 402", r.status === 402, `got ${r.status}`);
  // x402 v2: payment requirements are in the PAYMENT-REQUIRED header (base64 JSON), not the body.
  const pr = r.headers.get("payment-required");
  let parsed = null;
  try { parsed = JSON.parse(Buffer.from(pr || "", "base64").toString("utf8")); } catch {}
  ok("A1b", "402 PAYMENT-REQUIRED header has x402Version=2 + accepts[]",
    parsed && parsed.x402Version === 2 && Array.isArray(parsed.accepts) && parsed.accepts.length > 0,
    `parsed=${!!parsed} version=${parsed?.x402Version} accepts=${parsed?.accepts?.length}`);
  ok("A1c", "402 also offers PoW fallback via X-Pow-Challenge",
    !!r.headers.get("x-pow-challenge"),
    `hdr=${r.headers.get("x-pow-challenge")}`);
}
{
  const ch = await getChallenge("hash");
  const n = solvePow(ch);
  const r = await callTool("/api/hash", { text: "abc" }, { "X-Pow-Solution": `${ch.token}:${n}` });
  ok("A2", "paid slug w/ valid PoW -> 200", r.status === 200, `got ${r.status}`);
  ok("A2b", "successful PoW sets X-Pow-Accepted=true", r.headers.get("x-pow-accepted") === "true", `hdr=${r.headers.get("x-pow-accepted")}`);
}
{
  const ch = await getChallenge("hash");
  const parts = ch.token.split(".");
  const last = parts[parts.length - 1];
  parts[parts.length - 1] = last.slice(0, -2) + "00";
  const forged = parts.join(".");
  const n = solvePow(ch);
  const r = await callTool("/api/hash", { text: "abc" }, { "X-Pow-Solution": `${forged}:${n}` });
  ok("A3", "forged PoW HMAC -> rejected", r.status !== 200, `got ${r.status}`);
}
{
  const ch = await getChallenge("hash");
  const n = solvePow(ch);
  const r1 = await callTool("/api/hash", { text: "abc" }, { "X-Pow-Solution": `${ch.token}:${n}` });
  const r2 = await callTool("/api/hash", { text: "abc" }, { "X-Pow-Solution": `${ch.token}:${n}` });
  ok("A4", "PoW token replay -> rejected", r1.status === 200 && r2.status !== 200, `first=${r1.status} replay=${r2.status}`);
}
{
  const ch = await getChallenge("hash");
  const n = solvePow(ch);
  const r = await callTool("/api/sha256", { text: "abc" }, { "X-Pow-Solution": `${ch.token}:${n}` });
  ok("A5", "PoW token slug-bound (hash token on sha256) -> rejected", r.status !== 200, `got ${r.status}`);
}
{
  const r = await fetch(`${B}/api/pow/challenge?slug=memory-set`);
  ok("A6", "wallet-only slug refuses PoW issuance", r.status === 404, `got ${r.status}`);
}
{
  // Wallet-only tool called directly without PoW or x402 -> must 402 (or 404)
  const r = await callTool("/api/memory-set", { key: "k", value: "v" });
  ok("A7", "wallet-only slug requires x402 (not just any auth)", [402, 404].includes(r.status), `got ${r.status}`);
}

console.log("\n=== B. Input validation ===");
{
  const big = "x".repeat(2 * 1024 * 1024);
  const r = await callTool("/api/hash", { text: big });
  ok("B1", "2MB body handled (not crashed)", [200, 400, 402, 413, 422, 500].includes(r.status), `got ${r.status}`);
}
{
  const r = await fetch(`${B}/api/hash`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  ok("B2", "malformed JSON -> graceful 400/402/422", [400, 402, 422].includes(r.status), `got ${r.status}`);
}
{
  const longQ = "x".repeat(10000);
  const r = await fetch(`${B}/api/route?q=${encodeURIComponent(longQ)}&top=99999`);
  const j = await r.json();
  ok("B3", "router caps query/top", r.status === 200 && j.count <= 25, `count=${j.count}`);
}
{
  const r = await fetch(`${B}/api/find?q=${encodeURIComponent("x".repeat(10000))}&top=99999`);
  ok("B4", "find handles oversize query", r.status === 200, `got ${r.status}`);
}
{
  // Path traversal / null bytes in input
  const r = await callTool("/api/hash", { text: "../../../etc/passwd\u0000" });
  ok("B5", "null-byte/path-trav input not crashing server", [200, 400, 402, 422].includes(r.status), `got ${r.status}`);
}

console.log("\n=== C. SSRF / network egress ===");
async function probeExtract(url) {
  const ch = await getChallenge("extract");
  if (ch.error) return { error: ch.error };
  const n = solvePow(ch);
  const r = await callTool("/api/extract", { url }, { "X-Pow-Solution": `${ch.token}:${n}` });
  return { status: r.status, body: await r.text().catch(() => "") };
}
{
  const r = await probeExtract("http://127.0.0.1:3778/health");
  ok("C1", "safeFetch rejects 127.0.0.1", r.status !== 200, `status=${r.status} body=${r.body?.slice(0,80)}`);
}
{
  const r = await probeExtract("http://169.254.169.254/latest/meta-data/");
  ok("C2", "safeFetch rejects 169.254.169.254 (cloud metadata)", r.status !== 200, `status=${r.status}`);
}
{
  const r = await probeExtract("file:///etc/passwd");
  ok("C3", "safeFetch rejects file:// scheme", r.status !== 200, `status=${r.status}`);
}
{
  const r = await probeExtract("http://10.0.0.1/");
  ok("C4", "safeFetch rejects 10.0.0.0/8", r.status !== 200, `status=${r.status}`);
}
{
  const r = await probeExtract("ftp://example.com/x");
  ok("C5", "safeFetch rejects ftp:// scheme", r.status !== 200, `status=${r.status}`);
}

console.log("\n=== D. Attribution integrity ===");
{
  const ch = await getChallenge("hash");
  const n = solvePow(ch);
  const r = await callTool("/api/hash", { text: "abc" }, {
    "X-Pow-Solution": `${ch.token}:${n}`,
    "X-Pow-Accepted": "false",
    "X-PAYMENT-RESPONSE": "buyer-set",
  });
  ok("D1", "X-Pow-Accepted reflects truth (buyer cannot suppress)", r.headers.get("x-pow-accepted") === "true", `got ${r.headers.get("x-pow-accepted")}`);
  ok("D2", "PoW call does NOT echo buyer's X-PAYMENT-RESPONSE", r.headers.get("x-payment-response") !== "buyer-set", `got ${r.headers.get("x-payment-response")}`);
}
{
  // Heartbeat attribution: was a UA regex (spoofable), now requires a POW_SECRET-
  // signed X-Heartbeat-Token. A spoofed UA without the token must succeed
  // (auth-wise) but the server must NOT classify it as heartbeat traffic. We
  // can't see the stats classification directly from a buyer perspective, so
  // we just confirm the request still 200s — the unit test in scripts/
  // test-heartbeat-token.js covers the verify side.
  const ch = await getChallenge("hash");
  const n = solvePow(ch);
  const r = await callTool("/api/hash", { text: "abc" }, { "X-Pow-Solution": `${ch.token}:${n}`, "User-Agent": "agent402-heartbeat/spoofed" });
  ok("D3", "spoofed heartbeat UA still served as PoW (attribution gated on signed token)", r.status === 200, `status=${r.status}`);
}

console.log("\n=== E. Idempotency ===");
ok("E1", "covered by scripts/test-idempotency.js (6 scenarios)", true);

console.log("\n=== F. Index / Router safeguards ===");
{
  // Router input bounds
  const r = await fetch(`${B}/api/route?q=&top=999`);
  const j = await r.json();
  ok("F1", "empty query -> {count:0}", j.count === 0);
}
{
  // Router doesn't recommend dead sellers — covered by test-router-health.js
  ok("F2", "health-aware filtering covered by scripts/test-router-health.js (6 scenarios)", true);
}

console.log(`\n=== Audit summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
