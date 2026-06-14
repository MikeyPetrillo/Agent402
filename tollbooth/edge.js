// Edge / runtime-agnostic tollbooth — the same pay-per-crawl gate, built on the
// Web Crypto + Fetch APIs so it runs anywhere: Cloudflare Workers, Next.js
// middleware (edge), Deno, Bun, and Node 20+. No node:* imports.
//
//   const gate = createEdgeTollbooth({ secret: env.TOLLBOOTH_SECRET });
//   const blocked = await gate(request);   // Response(402) if must pay, else null
//
// See worker.js for a Cloudflare Worker entry, and the README for Next.js.
import { makeBotMatcher, AI_BOTS } from "./bots.js";

const te = new TextEncoder();

function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
function leadingZeroBits(bytes) {
  let n = 0;
  for (const b of bytes) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; }
  return n;
}
async function hmac(secret, payload) {
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, te.encode(payload)));
}
const sha256 = async (str) => new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(str)));
function constEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/**
 * Web Crypto proof-of-work. `secret` is required (edge runtimes can't keep a
 * random per-process secret across invocations). `store` is an optional
 * single-use replay backend ({ has(token), add(token, expMs) }, both async) —
 * e.g. a Cloudflare KV wrapper; defaults to in-isolate memory.
 */
export function createEdgePow({ secret, difficulty = 18, ttlMs = 5 * 60 * 1000, store } = {}) {
  if (!secret) throw new Error("createEdgePow requires a stable `secret` string");
  const mem = new Map();
  const used = store || {
    has: async (k) => { const e = mem.get(k); if (e && e < Date.now()) { mem.delete(k); return false; } return mem.has(k); },
    add: async (k, exp) => { mem.set(k, exp); },
  };

  async function challenge(resource) {
    const rnd = new Uint8Array(16);
    crypto.getRandomValues(rnd);
    const chal = toHex(rnd);
    const exp = Date.now() + ttlMs;
    const payload = `${chal}.${exp}.${difficulty}.${resource}`;
    const token = `${payload}.${await hmac(secret, payload)}`;
    return {
      algorithm: "sha256",
      challenge: chal,
      difficulty,
      expires: exp,
      token,
      rule: `Find an integer nonce so sha256("${chal}:" + nonce) has >= ${difficulty} leading zero bits, then resend with header  X-Pow-Solution: ${token}:<nonce>`,
    };
  }

  async function verify(headerValue, resource) {
    if (!headerValue || typeof headerValue !== "string") return { ok: false, reason: "missing solution" };
    const cut = headerValue.lastIndexOf(":");
    if (cut < 0) return { ok: false, reason: "malformed solution" };
    const token = headerValue.slice(0, cut);
    const nonce = headerValue.slice(cut + 1);
    const parts = token.split(".");
    if (parts.length !== 5) return { ok: false, reason: "malformed token" };
    const [chal, expStr, diffStr, res, sig] = parts;
    const expected = await hmac(secret, `${chal}.${expStr}.${diffStr}.${res}`);
    if (!constEq(sig, expected)) return { ok: false, reason: "bad signature" };
    if (res !== resource) return { ok: false, reason: "wrong resource" };
    if (Date.now() > Number(expStr)) return { ok: false, reason: "expired" };
    if (await used.has(token)) return { ok: false, reason: "already used" };
    const h = await sha256(`${chal}:${nonce}`);
    if (leadingZeroBits(h) < Number(diffStr)) return { ok: false, reason: "insufficient work" };
    await used.add(token, Number(expStr));
    return { ok: true };
  }

  return { challenge, verify, difficulty };
}

/**
 * Create the edge gate. Returns `async (request) => Response | null`:
 * a 402 `Response` when the client must pay, or `null` to allow the request
 * through (proxy it, or `NextResponse.next()`).
 */
export function createEdgeTollbooth(config = {}) {
  const {
    price = "$0.001",
    payTo = null,
    network = "base",
    asset = "USDC",
    pow = true,
    powDifficulty,
    secret,
    store,
    botUserAgents = AI_BOTS,
    charge,
    free,
    resourceBaseUrl = "",
    message = "This resource charges automated / AI clients per request. Humans browse free; bots pay in USDC via x402 or by solving a proof-of-work.",
  } = config;

  const isBot = makeBotMatcher(botUserAgents);
  const powEngine = pow ? createEdgePow({ secret, difficulty: powDifficulty, store }) : null;

  const shouldCharge = (request) => {
    if (typeof free === "function" && free(request)) return false;
    if (typeof charge === "function") return Boolean(charge(request));
    return isBot(request.headers.get("user-agent") || "");
  };

  return async function gate(request) {
    if (!shouldCharge(request)) return null;
    const u = new URL(request.url);
    const resource = (resourceBaseUrl ? resourceBaseUrl.replace(/\/$/, "") : "") + u.pathname + u.search;

    const sol = request.headers.get("x-pow-solution");
    if (powEngine && sol) {
      const r = await powEngine.verify(sol, resource);
      if (r.ok) return null;
    }

    const body = {
      error: "Payment Required",
      message,
      accepts: payTo ? [{ scheme: "exact", network, maxAmountRequired: String(price), asset, payTo, resource }] : [],
    };
    if (powEngine) body.proofOfWork = await powEngine.challenge(resource);
    return new Response(JSON.stringify(body), {
      status: 402,
      headers: { "content-type": "application/json", "x-tollbooth": "pay-per-crawl" },
    });
  };
}
