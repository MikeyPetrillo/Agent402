// /api/pow/challenge is the entire free tier. Every PoW-eligible call starts
// here — the buyer GETs a challenge, solves a sha256 puzzle, and resends with
// the `X-Pow-Solution: <token>:<nonce>` header. If the envelope shape drifts
// (token rename, missing rule, difficulty changed type), every buyer-side
// SDK and the `scripts/demo-payment.js` reference path break silently.
//
// This test boots FREE_MODE and locks the challenge contract:
//
//   1. GET /api/pow/challenge?slug=<known-pow-slug> → 200 application/json.
//   2. Response shape: { algorithm:'sha256', challenge:string,
//      difficulty:number, slug:string (echoed), rule:string,
//      expiresAt:number (unix seconds), ttlSeconds:number,
//      submitHeader:'X-Pow-Solution', submitFormat:'<token>:<nonce>',
//      token:string }
//   3. Difficulty is positive (otherwise the puzzle is trivial; a regression
//      to 0 would un-gate the free tier entirely).
//   4. expiresAt is in the future and ttlSeconds matches the gap (within
//      a few seconds of wall-clock skew).
//   5. Unknown / wallet-only slug → 404 with an explanatory error.
//   6. No slug parameter → 404 (no wildcard tokens).
//   7. /api/pow info endpoint returns the documented summary + eligibleTools
//      array + difficultyBits matching the challenge's difficulty.
//
//   node scripts/test-pow-challenge-envelope.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3083;
const BASE = `http://localhost:${PORT}`;

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

  // /api/pow info — pick a known compute-payable slug from eligibleTools.
  const infoRes = await fetch(`${BASE}/api/pow`);
  ok(infoRes.status === 200, `/api/pow → 200 (got ${infoRes.status})`);
  const info = await infoRes.json();
  ok(info.type === "proof-of-work", `/api/pow type='proof-of-work' (got ${info.type})`);
  ok(typeof info.summary === "string" && info.summary.length > 0, "info.summary is non-empty");
  ok(Array.isArray(info.eligibleTools) && info.eligibleTools.length > 0, `info.eligibleTools is non-empty array (got ${info.eligibleTools?.length})`);
  ok(typeof info.difficultyBits === "number" && info.difficultyBits > 0, `info.difficultyBits is positive number (got ${info.difficultyBits})`);
  ok(typeof info.ttlSeconds === "number" && info.ttlSeconds > 0, `info.ttlSeconds is positive number (got ${info.ttlSeconds})`);
  ok(info.submitHeader === "X-Pow-Solution", `info.submitHeader='X-Pow-Solution' (got ${info.submitHeader})`);
  ok(info.submitFormat === "<token>:<nonce>", `info.submitFormat='<token>:<nonce>' (got ${info.submitFormat})`);
  ok(typeof info.challengeUrl === "string" && info.challengeUrl.endsWith("/api/pow/challenge"), `info.challengeUrl ends with /api/pow/challenge (got ${info.challengeUrl})`);

  // Pick a known PoW slug — convert-kilometers-to-miles is in WALLET_ONLY_SLUGS' inverse
  // (pure CPU, always PoW-eligible). Falls back to info.eligibleTools[0] if not found.
  const TARGET = info.eligibleTools.includes("convert-kilometers-to-miles")
    ? "convert-kilometers-to-miles"
    : info.eligibleTools[0];

  // Happy path — known slug returns the full envelope.
  const before = Math.floor(Date.now() / 1000);
  const res = await fetch(`${BASE}/api/pow/challenge?slug=${TARGET}`);
  const after = Math.floor(Date.now() / 1000);
  ok(res.status === 200, `/api/pow/challenge?slug=${TARGET} → 200 (got ${res.status})`);
  ok((res.headers.get("content-type") || "").includes("application/json"), "content-type is application/json");
  const ch = await res.json();

  // Envelope shape lock — every field a buyer-side SDK reads.
  ok(ch.algorithm === "sha256", `algorithm='sha256' (got ${ch.algorithm})`);
  ok(typeof ch.challenge === "string" && ch.challenge.length > 0, `challenge is non-empty string (got len ${ch.challenge?.length})`);
  ok(typeof ch.difficulty === "number" && ch.difficulty > 0, `difficulty is positive number (got ${ch.difficulty}) — 0 would un-gate free tier`);
  ok(ch.slug === TARGET, `slug is echoed (got ${ch.slug}, expected ${TARGET})`);
  ok(typeof ch.rule === "string" && ch.rule.includes("sha256") && ch.rule.includes("leading zero"), `rule describes the sha256 leading-zero puzzle (got "${ch.rule?.slice(0, 80)}…")`);
  ok(typeof ch.expiresAt === "number", `expiresAt is number (got ${typeof ch.expiresAt})`);
  ok(ch.expiresAt > before, `expiresAt is in the future (expiresAt=${ch.expiresAt}, now≈${before})`);
  ok(typeof ch.ttlSeconds === "number" && ch.ttlSeconds > 0, `ttlSeconds is positive (got ${ch.ttlSeconds})`);
  // ttlSeconds ≈ (expiresAt - issueTime); allow 5 seconds of wall-clock skew.
  const skew = Math.abs((ch.expiresAt - before) - ch.ttlSeconds);
  ok(skew <= 5, `expiresAt - now ≈ ttlSeconds (gap=${ch.expiresAt - before}, ttl=${ch.ttlSeconds}, skew=${skew}s)`);
  ok(ch.submitHeader === "X-Pow-Solution", `submitHeader='X-Pow-Solution' (got ${ch.submitHeader})`);
  ok(ch.submitFormat === "<token>:<nonce>", `submitFormat='<token>:<nonce>' (got ${ch.submitFormat})`);
  ok(typeof ch.token === "string" && ch.token.length > 0, `token is non-empty (got len ${ch.token?.length})`);
  // Token must include the slug — proves the challenge is slug-scoped and
  // can't be retargeted to a different tool.
  ok(ch.token.includes(TARGET), `token is slug-scoped (token contains '${TARGET}')`);
  // Info's difficultyBits == challenge difficulty — drift would mean the
  // documented difficulty disagrees with the issued one.
  ok(ch.difficulty === info.difficultyBits, `challenge difficulty matches info.difficultyBits (challenge=${ch.difficulty}, info=${info.difficultyBits})`);

  // Negative: unknown slug → 404 with explanatory error (not 500, not 200).
  const unknown = await fetch(`${BASE}/api/pow/challenge?slug=this-tool-does-not-exist`);
  ok(unknown.status === 404, `unknown slug → 404 (got ${unknown.status})`);
  const unknownBody = await unknown.json();
  ok(typeof unknownBody.error === "string" && unknownBody.error.includes("Unknown"), `unknown-slug error mentions 'Unknown' (got '${unknownBody.error}')`);

  // Negative: missing slug → 404 (no wildcard tokens — a future regression
  // that issued a wildcard challenge would let a free-tier caller hit any
  // tool with one challenge).
  const noSlug = await fetch(`${BASE}/api/pow/challenge`);
  ok(noSlug.status === 404, `no slug → 404 (got ${noSlug.status}) — no wildcard tokens`);

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
