// Offline end-to-end test for the tollbooth: humans pass free, AI bots are
// charged 402, a solved proof-of-work unlocks, and solutions are single-use and
// resource-bound. No wallet, network, or chain needed.
import express from "express";
import { createHash } from "node:crypto";
import { createTollbooth } from "./index.js";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const lz = (buf) => { let bits = 0; for (const b of buf) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; } return bits; };
const solve = (chal, diff) => { let n = 0; while (lz(createHash("sha256").update(`${chal}:${n}`).digest()) < diff) n++; return n; };

const app = express();
app.use(createTollbooth({ powDifficulty: 16, payTo: "0x000000000000000000000000000000000000dEaD" }));
app.use((_req, res) => res.status(200).send("PREMIUM CONTENT"));
const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;

const humanUA = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" };
const botUA = { "user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" };

try {
  // 1. Human passes free.
  let r = await fetch(`${base}/article`, { headers: humanUA });
  if (r.status !== 200) fail(`human should pass free, got ${r.status}`);
  if ((await r.text()) !== "PREMIUM CONTENT") fail("human should receive the content");
  console.log("1. human (browser UA) -> 200 free ✓");

  // 2. Bot is charged 402 with both rails advertised.
  r = await fetch(`${base}/article`, { headers: botUA });
  if (r.status !== 402) fail(`bot should be charged 402, got ${r.status}`);
  const quote = await r.json();
  if (!quote.proofOfWork?.challenge) fail("402 must include a proof-of-work challenge");
  if (!quote.accepts?.[0]?.payTo) fail("402 must include an x402 quote when payTo is set");
  console.log("2. bot (ClaudeBot UA) -> 402 with PoW challenge + x402 quote ✓");

  // 3. Solve the PoW and retry -> 200.
  const nonce = solve(quote.proofOfWork.challenge, quote.proofOfWork.difficulty);
  const solution = `${quote.proofOfWork.token}:${nonce}`;
  r = await fetch(`${base}/article`, { headers: { ...botUA, "x-pow-solution": solution } });
  if (r.status !== 200) fail(`valid PoW should serve 200, got ${r.status}`);
  if (r.headers.get("x-tollbooth-paid") !== "pow") fail("response should be marked paid via pow");
  console.log("3. bot solves proof-of-work -> 200 ✓");

  // 4. Replaying the same solution is rejected (single-use).
  r = await fetch(`${base}/article`, { headers: { ...botUA, "x-pow-solution": solution } });
  if (r.status === 200) fail("a replayed PoW solution must not be accepted");
  console.log(`4. replayed PoW solution -> ${r.status} (single-use) ✓`);

  // 5. A token minted for /article must not work on /other.
  r = await fetch(`${base}/other`, { headers: { ...botUA, "x-pow-solution": solution } });
  if (r.status === 200) fail("a PoW token bound to /article must not work on /other");
  console.log(`5. cross-resource PoW reuse -> ${r.status} (resource-bound) ✓`);

  console.log("\nagent402-tollbooth: all assertions passed ✓");
} finally {
  server.close();
}
