// Self-contained proof-of-work for the tollbooth: a no-wallet payment rail.
// A client without USDC proves it spent real CPU instead, the same scheme
// Agent402 uses, packaged standalone so the tollbooth has zero crypto deps.
//
// Tokens are HMAC-signed by this process (stateless to issue), bound to the
// exact resource they were minted for, expiry-checked, and single-use (a solved
// token is remembered until it expires). Solving costs the caller CPU; issuing
// and verifying cost us one hash + one HMAC.
//
// Single-use is only as wide as the store that records it. The default store is
// THIS PROCESS'S memory, which is exactly right for a single-process deploy and
// insufficient for anything else: a stable TOLLBOOTH_SECRET makes one token
// verifiable by every worker/instance sharing it, so a single solve would buy
// one free request PER PROCESS within the token's TTL (and again after a worker
// recycle). Multi-worker, multi-instance and serverless operators must pass a
// shared `replayStore` (see replay.js and the README).
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

/**
 * @param {object} [opts]
 * @param {string} [opts.secret]      HMAC secret binding challenges to this operator
 * @param {number} [opts.difficulty]  leading zero bits a solution must carry
 * @param {number} [opts.ttlMs]       challenge lifetime
 * @param {{claim:(token:string,expiresAtMs:number)=>boolean|Promise<boolean>}} [opts.replayStore]
 *        Shared single-use backend. `claim` must ATOMICALLY return true only the
 *        first time it sees a token, false on every later call. Mirrors the
 *        `store` contract of createEdgePow in edge.js (accepted here under that
 *        name too, so an edge snippet ports across unchanged). Defaults to an
 *        in-process Map: correct for one process, wrong for several.
 */
export function createPow({
  secret = process.env.TOLLBOOTH_SECRET || randomBytes(32).toString("hex"),
  difficulty = Number(process.env.TOLLBOOTH_POW_BITS) || 18,
  ttlMs = TTL_MS,
  replayStore,
  store,
} = {}) {
  const shared = replayStore || store;
  if (shared && typeof shared.claim !== "function") {
    // Loud at construction rather than silently falling back to per-process
    // memory: an operator who passes a misshapen store believes they have
    // cluster-wide single-use, and a silent fallback would leave the exact hole
    // they configured the store to close.
    throw new TypeError("createPow: replayStore must expose claim(token, expiresAtMs) => boolean | Promise<boolean>");
  }
  const used = new Map(); // token -> expiry(ms); only used by the default store
  // Default replay backend, kept as the default so existing single-process
  // deployments behave exactly as they did. The body is synchronous, so two
  // concurrent claims of the same token in one process cannot both win, which a
  // separate has()-then-set() would allow.
  const memoryStore = {
    claim: (token, expiresAtMs) => {
      const seen = used.get(token);
      if (seen !== undefined && seen >= Date.now()) return false; // a still-valid record => already spent
      used.set(token, expiresAtMs);
      return true;
    },
  };
  const replay = shared || memoryStore;
  const sweep = shared ? null : setInterval(() => {
    const now = Date.now();
    for (const [t, exp] of used) if (exp < now) used.delete(t);
  }, 60_000);
  sweep?.unref?.();

  const sign = (payload) => createHmac("sha256", secret).update(payload).digest("base64url");

  /** Mint a signed, resource-scoped challenge. `diff` lets the caller raise the
   *  difficulty for this one challenge (e.g. adaptive-under-load); verify reads
   *  the difficulty from the token, so any value is self-describing and safe. */
  function challenge(resource, diff = difficulty) {
    const d = Math.max(1, Math.min(Math.floor(Number(diff) || difficulty), 32));
    const chal = randomBytes(16).toString("hex");
    const exp = Date.now() + ttlMs;
    const payload = `${chal}.${exp}.${d}.${resource}`;
    const token = `${payload}.${sign(payload)}`;
    return {
      algorithm: "sha256",
      challenge: chal,
      difficulty: d,
      expires: exp,
      token,
      rule: `Find an integer nonce so sha256("${chal}:" + nonce) has >= ${d} leading zero bits, then resend the request with header  X-Pow-Solution: ${token}:<nonce>`,
    };
  }

  // Claim single-use, translating the store's answer into a verify() result.
  //
  // FAIL CLOSED: a store that throws or rejects means we cannot know whether this
  // token was already spent, so we refuse the request. Same posture as edge.js,
  // where a claim-store exception used to propagate out of verify instead of
  // becoming a denial. An outage on the replay store costs the operator a few
  // refused crawls; the alternative costs them the paywall.
  function claimSingleUse(token, expiresAtMs) {
    let claimed;
    try { claimed = replay.claim(token, expiresAtMs); }
    catch { return { ok: false, reason: "replay store unavailable" }; }
    if (claimed && typeof claimed.then === "function") {
      return claimed.then(
        (granted) => (granted === true ? { ok: true } : { ok: false, reason: "already used" }),
        () => ({ ok: false, reason: "replay store unavailable" }),
      );
    }
    return claimed === true ? { ok: true } : { ok: false, reason: "already used" };
  }

  /** Verify a "<token>:<nonce>" solution for a given resource.
   *
   *  SYNC-OR-ASYNC BY DESIGN. Returns a plain result object whenever the replay
   *  store answers synchronously (the default in-process store always does), and
   *  a Promise of that object when a shared store answers with one. It is NOT
   *  unconditionally async because verify() has always been synchronous here:
   *  every existing caller reads `.ok` off the return value, and `.ok` on a
   *  Promise is `undefined`, so a blanket change would deny every honest solve
   *  while ALSO making the replay check a no-op for anyone who ignored the
   *  promise. Callers that may be configured with an async store must handle a
   *  thenable (index.js does; `await` works for both shapes). */
  function verify(headerValue, resource) {
    if (!headerValue || typeof headerValue !== "string") return { ok: false, reason: "missing solution" };
    const cut = headerValue.lastIndexOf(":");
    if (cut < 0) return { ok: false, reason: "malformed solution" };
    const token = headerValue.slice(0, cut);
    const nonce = headerValue.slice(cut + 1);
    const parts = token.split(".");
    if (parts.length < 5) return { ok: false, reason: "malformed token" };
    const sig = parts.pop();
    const [chal, expStr, diffStr] = parts;
    const res = parts.slice(3).join("."); // resource may itself contain dots (e.g. /post.html?v=1.2)
    const expected = sign(parts.join("."));
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };
    if (res !== resource) return { ok: false, reason: "wrong resource" };
    if (Date.now() > Number(expStr)) return { ok: false, reason: "expired" };
    // Defence in depth: the difficulty rides INSIDE the signed token, so a
    // forged or downgraded token could claim difficulty 0 and pass with no work
    // at all. Hold every solution to the configured difficulty as well, so a
    // leaked or placeholder secret still costs a real solve instead of handing
    // over free passage.
    const claimed = Number(diffStr);
    if (!Number.isFinite(claimed) || claimed < difficulty) return { ok: false, reason: "difficulty below policy" };
    const hash = createHash("sha256").update(`${chal}:${nonce}`).digest();
    if (leadingZeroBits(hash) < claimed) return { ok: false, reason: "insufficient work" };
    // Claim LAST, once the solution is known good: a forged, expired or
    // under-worked attempt must never consume the token an honest solver is
    // still holding, and with a shared store this is the only step that can
    // cost a round trip.
    return claimSingleUse(token, Number(expStr));
  }

  return { challenge, verify, difficulty, replayStore: replay };
}
