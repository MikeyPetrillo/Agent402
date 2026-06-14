// Offline end-to-end test for the tollbooth (Node). Humans pass free, AI bots
// are charged 402, a solved proof-of-work unlocks, solutions are single-use and
// resource-bound — including resources that contain dots/query strings — and the
// reverse proxy pins the host and strips forgeable trust headers.
import express from "express";
import http from "node:http";
import { createHash } from "node:crypto";
import { createTollbooth, createProxy } from "./index.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const lz = (buf) => { let n = 0; for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; } return n; };
const solve = (chal, diff) => { let n = 0; while (lz(createHash("sha256").update(`${chal}:${n}`).digest()) < diff) n++; return n; };

const app = express();
app.use(createTollbooth({ powDifficulty: 16, payTo: "0x000000000000000000000000000000000000dEaD" }));
app.use((_req, res) => res.status(200).send("PREMIUM CONTENT"));
const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;

const humanUA = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" };
const botUA = { "user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" };

// Solve a 402 challenge for `path` and return the X-Pow-Solution header value.
async function payWith(path) {
  const r = await fetch(`${base}${path}`, { headers: botUA });
  if (r.status !== 402) fail(`expected 402 for ${path}, got ${r.status}`);
  const q = await r.json();
  if (!q.proofOfWork?.challenge) fail(`no PoW challenge for ${path}`);
  return `${q.proofOfWork.token}:${solve(q.proofOfWork.challenge, q.proofOfWork.difficulty)}`;
}

try {
  // 1. Human passes free.
  let r = await fetch(`${base}/article`, { headers: humanUA });
  if (r.status !== 200 || (await r.text()) !== "PREMIUM CONTENT") fail(`human should pass free, got ${r.status}`);
  console.log("1. human (browser UA) -> 200 free ✓");

  // 2. Bot charged 402 with both rails.
  r = await fetch(`${base}/article`, { headers: botUA });
  const quote = await r.json();
  if (r.status !== 402 || !quote.proofOfWork?.challenge || !quote.accepts?.[0]?.payTo) fail("bot should get 402 with PoW + x402");
  console.log("2. bot (ClaudeBot UA) -> 402 with PoW + x402 quote ✓");

  // 3. Solve -> 200.
  const sol = `${quote.proofOfWork.token}:${solve(quote.proofOfWork.challenge, quote.proofOfWork.difficulty)}`;
  r = await fetch(`${base}/article`, { headers: { ...botUA, "x-pow-solution": sol } });
  if (r.status !== 200 || r.headers.get("x-tollbooth-paid") !== "pow") fail(`valid PoW should serve 200, got ${r.status}`);
  console.log("3. bot solves proof-of-work -> 200 ✓");

  // 4. Replay rejected (single-use).
  r = await fetch(`${base}/article`, { headers: { ...botUA, "x-pow-solution": sol } });
  if (r.status === 200) fail("replayed PoW solution must not be accepted");
  console.log(`4. replayed solution -> ${r.status} (single-use) ✓`);

  // 5. Resource-bound.
  r = await fetch(`${base}/other`, { headers: { ...botUA, "x-pow-solution": sol } });
  if (r.status === 200) fail("PoW token bound to /article must not work on /other");
  console.log(`5. cross-resource reuse -> ${r.status} (resource-bound) ✓`);

  // 6. REGRESSION (bug 1.1): resources with dots / query strings must work.
  for (const path of ["/blog/post.html", "/a?v=1.2.3", "/feed.xml?since=2024.01"]) {
    const s = await payWith(path);
    r = await fetch(`${base}${path}`, { headers: { ...botUA, "x-pow-solution": s } });
    if (r.status !== 200) fail(`dotted/query path ${path} should unlock with valid PoW, got ${r.status}`);
  }
  console.log("6. dotted paths + query strings unlock correctly ✓");

  console.log("\ngate: all assertions passed ✓");
} finally {
  server.close();
}

// ---- Reverse-proxy: host pinning + header stripping (bugs 2.1 / 2.3) ----
const upstream = http.createServer((q, s) => {
  s.writeHead(200, { "content-type": "application/json" });
  s.end(JSON.stringify({ host: q.headers.host, headers: q.headers }));
});
await new Promise((r) => upstream.listen(0, r));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

const proxyApp = express();
proxyApp.use(createTollbooth({ free: () => true })); // let everything through to exercise the proxy
proxyApp.use(createProxy(upstreamBase));
const proxyServer = proxyApp.listen(0);
const proxyBase = `http://127.0.0.1:${proxyServer.address().port}`;

try {
  const r = await fetch(`${proxyBase}/x`, {
    headers: { "x-tollbooth-paid": "x402", "x-forwarded-host": "evil.example", "x-custom": "ok" },
  });
  const seen = await r.json();
  if (seen.host !== `127.0.0.1:${upstream.address().port}`) fail(`proxy must pin host to upstream, saw ${seen.host}`);
  if (seen.headers["x-tollbooth-paid"]) fail("proxy must strip client-forged X-Tollbooth-Paid");
  if (seen.headers["x-forwarded-host"]) fail("proxy must strip client X-Forwarded-Host");
  if (seen.headers["x-custom"] !== "ok") fail("proxy should forward normal headers");
  console.log("7. proxy pins host + strips forged trust headers, forwards normal ones ✓");
} finally {
  proxyServer.close();
  upstream.close();
}

console.log("\nagent402-tollbooth: all assertions passed ✓");
