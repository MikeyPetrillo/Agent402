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
import { mintEdgeChallenge, translateEdgeCredential, isMppCredential } from "./edge-mpp.js";

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
    // F05: FAIL CLOSED — if the claim store is unavailable, deny rather than let
    // the exception propagate (or, worse, grant). Strict single-use needs an
    // atomic store (Durable Object); see worker.js durableObjectStore + the
    // wrangler template. A get-then-put KV store is best-effort only.
    let claimed;
    try { claimed = await used.claim(token, Number(expStr)); }
    catch { return { ok: false, reason: "replay store unavailable" }; }
    if (!claimed) return { ok: false, reason: "already used" };
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
    // Same contract as the Node build's verifyX402: (request, requirements) =>
    // boolean | Promise<boolean>. Without it this build has NO way to accept a
    // payment, which is why the accepts block below is withheld when it is
    // absent - see the note there.
    verifyX402 = null,
    // MPP (the "Payment" HTTP auth scheme) on the same verifier: default ON
    // whenever the USDC quote is live (payTo + verifyX402 + secret). The 402
    // gains a WWW-Authenticate: Payment challenge and an Authorization: Payment
    // credential is translated to PAYMENT-SIGNATURE and handed to verifyX402.
    // See edge-mpp.js. `mppAssetAddress`/`mppAssetName` name a token the
    // built-in USDC table does not know (the domain name is what a facilitator
    // verifies the EIP-3009 signature under).
    mpp = true,
    mppAssetAddress,
    mppAssetName,
    mppRealm,
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

  // Say it at construction, not when a buyer gives up. An operator who sets a
  // payTo here reasonably believes they are charging; without a verifier this
  // build can only ever serve proof-of-work, and the price would be fiction.
  if (payTo && !verifyX402) {
    console.warn(
      "agent402-tollbooth: payTo is set but no verifyX402 was supplied, so this edge build cannot accept a USDC payment. " +
      "The USDC quote is being WITHHELD from the 402 (proof-of-work still works). Pass verifyX402 to charge, or drop payTo to stop implying it."
    );
  }

  const mppOn = Boolean(mpp && secret && payTo && verifyX402);
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

  // Heuristic only. A bot can trivially set `User-Agent: Mozilla/5.0 …` and
  // `Accept: text/html` to pass — `strict` mode uses this as the lower bound
  // (charge anything that does NOT look like a browser), not as proof of
  // humanity. For hard guarantees use mode:"all" or `charge:` predicate.
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
    // F18: bind the canonical ORIGIN, not just path+query — otherwise a proof
    // for /x transfers to any other site sharing the secret. On the edge the
    // request URL already carries the real origin; prefer an explicit
    // resourceBaseUrl when configured.
    const origin = resourceBaseUrl ? resourceBaseUrl.replace(/\/$/, "") : u.origin;
    const resource = origin + u.pathname + u.search;
    // Additionally bind the HTTP METHOD in the PoW challenge (x402 `resource`
    // stays a plain URL for wire compatibility).
    const powResource = `${request.method || "GET"} ${resource}`;

    // An x402 payment presented on either header name. @x402/core emits
    // PAYMENT-SIGNATURE while older clients send X-PAYMENT, and a gate that
    // reads only one of them refuses buyers who did everything right.
    const paymentHeader = request.headers.get("payment-signature") || request.headers.get("x-payment");
    if (paymentHeader && verifyX402) {
      let paid = false;
      try {
        paid = await verifyX402(request, { price, network, asset, payTo, resource });
      } catch {
        // Fail CLOSED: a verifier that throws must not open the gate.
        paid = false;
      }
      if (paid) { incr("paid"); return null; }
    } else if (mppOn && isMppCredential(request.headers.get("authorization"))) {
      // MPP inbound: only a credential whose challenge id HMAC-verifies as
      // OURS, unexpired, and minted for THIS resource (a credential for /a
      // must not pay for /b - the challenge carries the resource it was minted
      // for). The verifier sees the same request with PAYMENT-SIGNATURE in
      // place of Authorization, exactly as an x402 client would have sent it.
      let paid = false;
      try {
        const t = await translateEdgeCredential(request.headers.get("authorization"), { secret });
        if (t && t.resource === resource) {
          const headers = new Headers(request.headers);
          headers.set("payment-signature", t.paymentSignature);
          headers.delete("authorization");
          paid = await verifyX402(new Request(request, { headers }), { price, network, asset, payTo, resource, accepted: t.accepted });
        }
      } catch { paid = false; }
      if (paid) { incr("paid"); incr("mppPaid"); return null; }
    }

    const sol = request.headers.get("x-pow-solution");
    if (powEngine && sol) {
      const r = await powEngine.verify(sol, powResource);
      if (r.ok) { incr("powSolved"); return null; }
    }

    incr("charged");
    const body = {
      error: "Payment Required",
      message,
      // Only advertise USDC when this build can actually ACCEPT it. Emitting an
      // accepts block with no verifier configured published a price that no
      // code path could honour: a crawler that paid correctly was 402'd
      // forever, money never moved, and the operator believed they were
      // charging. Quoting a price you cannot take is worse than quoting none.
      accepts: (payTo && verifyX402) ? [{ scheme: "exact", network, maxAmountRequired: String(price), asset, payTo, resource }] : [],
    };
    if (powEngine) body.proofOfWork = await powEngine.challenge(powResource);
    const headers = { "content-type": "application/json", "x-tollbooth": "pay-per-crawl" };
    if (mppOn) {
      // One evm/charge challenge for the gate's quote (never a price the
      // x402 path would not honour - both are built from the same fields).
      try {
        const minted = await mintEdgeChallenge({ secret, realm: mppRealm || u.host, price, network, asset, assetAddress: mppAssetAddress, assetName: mppAssetName, payTo, resource });
        if (minted) headers["www-authenticate"] = minted.header;
      } catch { /* a quote MPP cannot express is still a valid x402 402 */ }
    }
    return new Response(JSON.stringify(body), { status: 402, headers });
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
