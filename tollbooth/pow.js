// Self-contained proof-of-work for the tollbooth: a no-wallet payment rail.
// A client without USDC proves it spent real CPU instead — the same scheme
// Agent402 uses, packaged standalone so the tollbooth has zero crypto deps.
//
// Tokens are HMAC-signed by this process (stateless to issue), bound to the
// exact resource they were minted for, expiry-checked, and single-use (a solved
// token is remembered until it expires). Solving costs the caller CPU; issuing
// and verifying cost us one hash + one HMAC.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TTL_MS = 5 * 60 * 1000;

/** Count leading zero bits of a buffer (the proof-of-work difficulty metric). */
export function leadingZeroBits(buf) {
  let bits = 0;
  for (const b of buf) {
    if (b === 0) { bits += 8; continue; }
    bits += Math.clz32(b) - 24;
    break;
  }
  return bits;
}

export function createPow({
  secret = process.env.TOLLBOOTH_SECRET || randomBytes(32).toString("hex"),
  difficulty = Number(process.env.TOLLBOOTH_POW_BITS) || 18,
  ttlMs = TTL_MS,
} = {}) {
  const used = new Map(); // token -> expiry(ms)
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [t, exp] of used) if (exp < now) used.delete(t);
  }, 60_000);
  sweep.unref?.();

  const sign = (payload) => createHmac("sha256", secret).update(payload).digest("base64url");

  /** Mint a signed, resource-scoped challenge. */
  function challenge(resource) {
    const chal = randomBytes(16).toString("hex");
    const exp = Date.now() + ttlMs;
    const payload = `${chal}.${exp}.${difficulty}.${resource}`;
    const token = `${payload}.${sign(payload)}`;
    return {
      algorithm: "sha256",
      challenge: chal,
      difficulty,
      expires: exp,
      token,
      rule: `Find an integer nonce so sha256("${chal}:" + nonce) has >= ${difficulty} leading zero bits, then resend the request with header  X-Pow-Solution: ${token}:<nonce>`,
    };
  }

  /** Verify a "<token>:<nonce>" solution for a given resource. */
  function verify(headerValue, resource) {
    if (!headerValue || typeof headerValue !== "string") return { ok: false, reason: "missing solution" };
    const cut = headerValue.lastIndexOf(":");
    if (cut < 0) return { ok: false, reason: "malformed solution" };
    const token = headerValue.slice(0, cut);
    const nonce = headerValue.slice(cut + 1);
    const parts = token.split(".");
    if (parts.length !== 5) return { ok: false, reason: "malformed token" };
    const [chal, expStr, diffStr, res, sig] = parts;
    const expected = sign(`${chal}.${expStr}.${diffStr}.${res}`);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };
    if (res !== resource) return { ok: false, reason: "wrong resource" };
    if (Date.now() > Number(expStr)) return { ok: false, reason: "expired" };
    if (used.has(token)) return { ok: false, reason: "already used" };
    const hash = createHash("sha256").update(`${chal}:${nonce}`).digest();
    if (leadingZeroBits(hash) < Number(diffStr)) return { ok: false, reason: "insufficient work" };
    used.set(token, Number(expStr));
    return { ok: true };
  }

  return { challenge, verify, difficulty };
}
