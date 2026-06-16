// Edge / runtime-agnostic tollbooth — the same pay-per-crawl gate, built on the
// Web Crypto + Fetch APIs so it runs anywhere: Cloudflare Workers, Next.js
// middleware (edge), Deno, Bun, and Node 20+. No node:* imports.
//
//   const gate = createEdgeTollbooth({ secret: env.TOLLBOOTH_SECRET });
//   const blocked = await gate(request);   // Response(402) if must pay, else null
//
// See worker.js for a Cloudflare Worker entry, and the README for Next.js.
import { makeBotMatcher, AI_BOTS } from "./bots.js";
import { memorySink } from "./sinks.js";

export { memorySink, kvStatsSink, httpStatsSink } from "./sinks.js";

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
 * single-use replay backend: { claim(token, expMs) => bool|Promise<bool> } that
 * atomically returns true only the first time a token is seen — e.g. a Cloudflare
 * KV wrapper; defaults to in-isolate memory.
 */
export function createEdgePow({ secret, difficulty = 18, ttlMs = 5 * 60 * 1000, store } = {}) {
  if (!secret) throw new Error("createEdgePow requires a stable `secret` string");
  const mem = new Map();
  const MAX = 50_000; // bound memory: edge runtimes have no timer to sweep, so prune on write
  const used = store || {
    // Atomic single-use claim. The body is synchronous (no await), so two
    // concurrent claims of the same token cannot both win within an isolate —
    // closing the TOCTOU that a separate has()+add() would open.
    claim: (k, exp) => {
      const e = mem.get(k);
      if (e && e >= Date.now()) return false; // a still-valid entry => already used
      if (mem.size >= MAX) {
        const now = Date.now();
        for (const [kk, ee] of mem) if (ee < now) mem.delete(kk);          // drop expired first
        if (mem.size >= MAX) mem.delete(mem.keys().next().value);          // hard cap: evict oldest
      }
      mem.set(k, exp);
      return true;
    },
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
    if (parts.length < 5) return { ok: false, reason: "malformed token" };
    const sig = parts.pop();
    const [chal, expStr, diffStr] = parts;
    const res = parts.slice(3).join("."); // resource may itself contain dots (e.g. /post.html?v=1.2)
    const expected = await hmac(secret, parts.join("."));
    if (!constEq(sig, expected)) return { ok: false, reason: "bad signature" };
    if (res !== resource) return { ok: false, reason: "wrong resource" };
    if (Date.now() > Number(expStr)) return { ok: false, reason: "expired" };
    const h = await sha256(`${chal}:${nonce}`);
    if (leadingZeroBits(h) < Number(diffStr)) return { ok: false, reason: "insufficient work" };
    // Atomically claim single-use only AFTER the work is validated, so an invalid
    // attempt never consumes the token and concurrent dupes can't both pass.
    if (!(await used.claim(token, Number(expStr)))) return { ok: false, reason: "already used" };
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
    // "bots" (default, charge AI crawler UAs) | "all" (charge all but free()) |
    // "strict" (charge anything that isn't a real-browser request). An explicit
    // charge()/free() still wins. Default preserves the original behavior.
    mode = "bots",
    charge,
    free,
    resourceBaseUrl = "",
    // Observe-only mode: count what would have been charged but never 402. Lets
    // operators run the gate on a live site for a week before flipping on enforcement.
    observe = false,
    // Pluggable durable-stats sink. Default = in-memory (per-isolate, so on the
    // edge it dies with the isolate — pass kvStatsSink(env.TOLLBOOTH_KV) for
    // cross-isolate aggregation).
    statsSink,
    message = "This resource charges automated / AI clients per request. Humans browse free; bots pay in USDC via x402 or by solving a proof-of-work.",
  } = config;

  const isBot = makeBotMatcher(botUserAgents);
  const powEngine = pow ? createEdgePow({ secret, difficulty: powDifficulty, store }) : null;
  const mem = memorySink();
  const sink = statsSink || mem;
  const writeThrough = statsSink && statsSink !== mem;
  // Stats must never break a request path — a buggy custom sink can throw
  // synchronously; we shrug and continue.
  const incr = (k, n = 1) => {
    try { mem.incr(k, n); } catch { /* ignore */ }
    if (writeThrough) { try { sink.incr(k, n); } catch { /* ignore */ } }
  };

  const looksHuman = (request) => {
    const ua = request.headers.get("user-agent") || "";
    const accept = request.headers.get("accept") || "";
    return /mozilla\/5\.0/i.test(ua) && /text\/html/i.test(accept);
  };
  const shouldCharge = (request) => {
    try {
      if (typeof free === "function" && free(request)) return false;
      if (typeof charge === "function") return Boolean(charge(request));
    } catch { return true; /* fail closed: charge on predicate error */ }
    if (mode === "all") return true;
    if (mode === "strict") return !looksHuman(request);
    return isBot(request.headers.get("user-agent") || ""); // "bots" (default)
  };

  async function gate(request) {
    incr("requests");
    if (!shouldCharge(request)) { incr("freeAllowed"); return null; }
    if (observe) { incr("wouldCharge"); return null; }
    const u = new URL(request.url);
    const resource = (resourceBaseUrl ? resourceBaseUrl.replace(/\/$/, "") : "") + u.pathname + u.search;

    const sol = request.headers.get("x-pow-solution");
    if (powEngine && sol) {
      const r = await powEngine.verify(sol, resource);
      if (r.ok) { incr("powSolved"); return null; }
    }

    incr("charged");
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
  }

  // Operator surface: in-process mirror (sync), durable snapshot (async),
  // and an explicit flush() for edge runtimes — the Worker should call this
  // inside ctx.waitUntil so buffered KV writes actually happen.
  gate.observe = observe;
  gate.stats = () => ({ ...mem.snapshot(), observe });
  gate.snapshot = async () => ({ ...(await sink.snapshot()), observe });
  // flush() is typically wired to ctx.waitUntil — swallow errors so a sink
  // outage can't surface as an unhandled rejection after the response.
  gate.flush = async () => { try { if (sink.flush) await sink.flush(); } catch { /* ignore */ } };
  return gate;
}
