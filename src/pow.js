// Proof-of-work: a no-wallet alternative to USDC payment for the cheap,
// CPU-only tools. An agent that cannot pay proves it spent real CPU instead.
//
// Flow (mirrors the x402 challenge/response shape):
//   1. GET /api/pow/challenge?slug=hash  -> a signed, single-use challenge.
//   2. Agent finds a nonce so sha256("<challenge>:<nonce>") has >= difficulty
//      leading zero bits.
//   3. Agent re-sends the tool request with header
//      X-Pow-Solution: <token>:<nonce>
//   4. This module verifies (one hash + one HMAC + a single-use check) and the
//      request is served free of charge.
//
// Challenges are stateless: the token is HMAC-signed by the server, so no state
// is stored when a challenge is issued. Only a *solved* challenge writes a row
// (for replay protection), so an attacker must burn CPU before costing us any
// storage. Tunable difficulty makes spam uneconomic while staying trivial for a
// one-off legitimate call.
import Database from "better-sqlite3";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = existsSync("/data") ? "/data" : "/tmp";
const db = new Database(join(DATA_DIR, "agent402-pow.db"));
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS pow_used (challenge TEXT PRIMARY KEY, exp INTEGER NOT NULL)");
db.exec("CREATE INDEX IF NOT EXISTS pow_used_exp ON pow_used (exp)");
const markStmt = db.prepare("INSERT INTO pow_used (challenge, exp) VALUES (?, ?)");
const pruneStmt = db.prepare("DELETE FROM pow_used WHERE exp < ?");

// Tools that cost real money or reach the network are NOT compute-payable —
// they stay wallet-only so PoW can't be used to farm Chromium/egress/storage.
const WALLET_ONLY_SLUGS = new Set([
  "extract", "meta", "dns", "render", "screenshot", "pdf",
  "memory-write", "memory-read", "memory-incr", "memory-grant", "memory-revoke",
  "memory-grants", "memory-log", "memory-remember", "memory-recall", "memory-forget",
  "http-check", "tls-cert", "whois", "robots-check", "sitemap",
  "email-validate", "ip-info", "search",
  "pdf-info", "pdf-merge", "pdf-extract-pages", "pdf-rotate", "images-to-pdf",
]);

/** A tool is compute-payable (PoW-eligible) if it is pure-CPU and ~free to serve. */
export function isComputePayable(tool) {
  return !WALLET_ONLY_SLUGS.has(tool.slug);
}

function clampInt(value, dflt, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

// Stable across restarts when POW_SECRET (or the CDP secret) is set; otherwise a
// random per-process secret (outstanding challenges simply expire on restart).
const SECRET = process.env.POW_SECRET || process.env.CDP_API_KEY_SECRET || randomBytes(32).toString("hex");
// 16 bits ≈ 65k hashes ≈ ~0.1-0.3s of client CPU: enough to make bulk abuse of
// the (near-free-to-serve) CPU tools uneconomic, while keeping a one-off call
// snappy. Higher difficulties have brutal tail latency (difficulty 20 p90 ≈ 12s)
// because solving is a memoryless random search. Tune via POW_DIFFICULTY.
export const POW_DIFFICULTY = clampInt(process.env.POW_DIFFICULTY, 16, 8, 28);
const TTL_SECONDS = clampInt(process.env.POW_TTL_SECONDS, 300, 30, 3600);

function sign(payload) {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24; // clz32 of an 8-bit value is 24..31
    break;
  }
  return bits;
}

/**
 * Issue a signed, single-use challenge. `slug` strictly scopes the token to
 * one tool so a challenge can't be retargeted at a different route.
 */
export function issueChallenge(slug) {
  const challenge = randomBytes(16).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = `${challenge}.${exp}.${POW_DIFFICULTY}.${slug}`;
  const token = `${payload}.${sign(payload)}`;
  // Opportunistically prune expired replay rows (cheap, indexed by exp).
  pruneStmt.run(Math.floor(Date.now() / 1000));
  return {
    algorithm: "sha256",
    challenge,
    difficulty: POW_DIFFICULTY,
    slug,
    rule: `Find an integer nonce such that sha256("${challenge}:" + nonce) has at least ${POW_DIFFICULTY} leading zero bits.`,
    expiresAt: exp,
    ttlSeconds: TTL_SECONDS,
    submitHeader: "X-Pow-Solution",
    submitFormat: "<token>:<nonce>",
    token,
  };
}

/**
 * Verify a submitted "<token>:<nonce>" against the route's slug. Returns
 * { ok: true } on success (and consumes the challenge), or { ok:false, reason }.
 */
export function verifySolution(headerValue, slug) {
  if (typeof headerValue !== "string" || !headerValue) return { ok: false, reason: "missing solution" };
  const sep = headerValue.lastIndexOf(":");
  if (sep < 0) return { ok: false, reason: "malformed solution (expected <token>:<nonce>)" };
  const token = headerValue.slice(0, sep);
  const nonce = headerValue.slice(sep + 1);
  if (!nonce) return { ok: false, reason: "missing nonce" };

  const parts = token.split(".");
  if (parts.length !== 5) return { ok: false, reason: "malformed token" };
  const [challenge, expStr, diffStr, tokSlug, sig] = parts;
  const payload = `${challenge}.${expStr}.${diffStr}.${tokSlug}`;

  // 1. Signature (constant-time).
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };

  // 2. Expiry.
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: "challenge expired" };

  // 3. Scope: token must be for exactly this tool (wildcards are not issued
  //    and not accepted — legacy "*" tokens fail here by design).
  if (tokSlug !== slug) return { ok: false, reason: `challenge scoped to "${tokSlug}", not "${slug}"` };

  // 4. Proof of work (difficulty is fixed in the signed token — cannot be downgraded).
  const difficulty = parseInt(diffStr, 10);
  const digest = createHash("sha256").update(`${challenge}:${nonce}`).digest();
  if (leadingZeroBits(digest) < difficulty) return { ok: false, reason: "insufficient work" };

  // 5. Single-use: the first valid submission wins; a replay hits the PK constraint.
  try {
    markStmt.run(challenge, exp);
  } catch {
    return { ok: false, reason: "challenge already used" };
  }
  // Prune here too, so a solve-heavy/issue-light workload can't grow the table.
  pruneStmt.run(Math.floor(Date.now() / 1000));
  return { ok: true };
}

/** Machine-readable description of the PoW option for discovery surfaces. */
export function powInfo(baseUrl, computeSlugs) {
  return {
    type: "proof-of-work",
    summary:
      "Agents without a wallet can access the pure-CPU tools by solving a sha256 puzzle (a fraction of a second of the caller's CPU) instead of paying USDC. No money, no AI tokens, no model involved. Request a challenge, solve it, and resend with the X-Pow-Solution header.",
    challengeUrl: `${baseUrl}/api/pow/challenge`,
    difficultyBits: POW_DIFFICULTY,
    ttlSeconds: TTL_SECONDS,
    submitHeader: "X-Pow-Solution",
    submitFormat: "<token>:<nonce>",
    eligibleTools: computeSlugs,
    note: "Network/browser/storage tools (render, screenshot, pdf, memory, http-check, etc.) remain wallet-only via x402.",
    solverExample:
      'const c = await (await fetch(BASE+"/api/pow/challenge?slug=hash")).json();\n' +
      'const { createHash } = await import("node:crypto");\n' +
      "let n = 0, lz = (b)=>{let t=0;for(const x of b){if(!x){t+=8;continue;}t+=Math.clz32(x)-24;break;}return t;};\n" +
      'while (lz(createHash("sha256").update(c.challenge+":"+n).digest()) < c.difficulty) n++;\n' +
      'const res = await fetch(BASE+"/api/hash",{method:"POST",headers:{"Content-Type":"application/json","X-Pow-Solution":c.token+":"+n},body:JSON.stringify({text:"hello"})});',
  };
}
