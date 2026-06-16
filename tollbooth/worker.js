// Cloudflare Worker entry for the tollbooth — open-source pay-per-crawl on the
// edge. Deploy in front of your origin: humans pass through, AI crawlers pay
// (USDC via x402, or free proof-of-work).
//
// wrangler.toml:
//   name = "tollbooth"
//   main = "node_modules/agent402-tollbooth/worker.js"
//   [vars]
//   TOLLBOOTH_UPSTREAM = "https://your-origin.example.com"
//   TOLLBOOTH_PAYTO    = "0xYourWallet"        # optional (advertises USDC quote)
//   TOLLBOOTH_OBSERVE  = "true"                # optional: observe-only, never 402
//   TOLLBOOTH_STATS_TOKEN = "any long string"  # optional: gate /__tollbooth/stats
//   # secret (required): wrangler secret put TOLLBOOTH_SECRET
//   # optional single-use store: [[kv_namespaces]] binding = "TOLLBOOTH_KV"
//   # ↑ same TOLLBOOTH_KV is reused for durable stats aggregation across isolates.
import { createEdgeTollbooth, kvStatsSink } from "./edge.js";
import { dashboardHtml } from "./dashboard.js";

// Constant-time string compare — Cloudflare Workers don't ship node:crypto's
// timingSafeEqual. Short-circuiting `===` on a secret token leaks length and
// prefix bits to a sufficiently patient attacker; this doesn't.
function constEq(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const kvStore = (kv) => ({
  // Best-effort atomic claim. KV has no native compare-and-set, so this is
  // get-then-put (eventually consistent); for strict single-use, back it with a
  // Durable Object. Returns true only the first time a token is seen.
  claim: async (k, expMs) => {
    if ((await kv.get(k)) != null) return false;
    await kv.put(k, "1", { expiration: Math.ceil(expMs / 1000) });
    return true;
  },
});

export default {
  async fetch(request, env, ctx) {
    if (!env.TOLLBOOTH_SECRET) {
      return new Response("Tollbooth misconfigured: set TOLLBOOTH_SECRET (wrangler secret put TOLLBOOTH_SECRET)", { status: 500 });
    }
    if (!env.TOLLBOOTH_KV) {
      // No durable store → replay protection is per-isolate only; a solved token
      // can be reused across isolates within its TTL. Bind a KV namespace for prod.
      console.warn("agent402-tollbooth: no TOLLBOOTH_KV bound — proof-of-work replay protection is per-isolate only. Bind a KV namespace for production.");
    }
    // Durable stats live in KV if a namespace is bound. Without it, the dashboard
    // is per-isolate (dies on cold start) — fine for dev, useless for prod.
    const statsSink = env.TOLLBOOTH_KV
      ? kvStatsSink(env.TOLLBOOTH_KV, { bucket: env.TOLLBOOTH_STATS_BUCKET || "default" })
      : undefined;
    const gate = createEdgeTollbooth({
      secret: env.TOLLBOOTH_SECRET,
      price: env.TOLLBOOTH_PRICE || "$0.001",
      payTo: env.TOLLBOOTH_PAYTO || null,
      network: env.TOLLBOOTH_NETWORK || "base",
      powDifficulty: env.TOLLBOOTH_POW_BITS ? Number(env.TOLLBOOTH_POW_BITS) : undefined,
      store: env.TOLLBOOTH_KV ? kvStore(env.TOLLBOOTH_KV) : undefined,
      observe: env.TOLLBOOTH_OBSERVE === "true",
      statsSink,
    });

    // Free, never-gated operator endpoints. Mounted BEFORE the gate so they
    // can't be paywalled — and so the dashboard polls work even when the rest
    // of the origin is fully gated.
    const u = new URL(request.url);
    if (u.pathname === "/__tollbooth" || u.pathname === "/__tollbooth/") {
      return new Response(dashboardHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (u.pathname === "/__tollbooth/stats") {
      // Optional bearer-token gate — share with your monitoring caller. We
      // recommend setting this in any prod deploy: without it, anyone on the
      // internet can read aggregate counts (no per-request data, but still
      // potentially sensitive competitive info).
      if (env.TOLLBOOTH_STATS_TOKEN) {
        const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        if (!constEq(got, env.TOLLBOOTH_STATS_TOKEN)) return new Response("unauthorized", { status: 401 });
      }
      const snap = await gate.snapshot();
      return new Response(JSON.stringify(snap), { headers: { "content-type": "application/json" } });
    }

    const blocked = await gate(request);
    // Flush any buffered stats to KV after we've replied — survives the response.
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(gate.flush());
    if (blocked) return blocked;

    // Allowed → proxy to the origin.
    const upstream = env.TOLLBOOTH_UPSTREAM;
    if (!upstream) return new Response("Tollbooth: set TOLLBOOTH_UPSTREAM to your origin", { status: 500 });
    const target = new URL(request.url);
    const origin = new URL(upstream);
    target.protocol = origin.protocol;
    target.hostname = origin.hostname;
    target.port = origin.port;
    // Strip client-forgeable trust/forwarding headers before forwarding to origin.
    const headers = new Headers(request.headers);
    for (const h of ["x-tollbooth-paid", "x-tollbooth-error", "x-pow-error", "x-forwarded-host", "forwarded"]) headers.delete(h);
    headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") || "");
    const init = { method: request.method, headers, redirect: "manual" };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
    return fetch(target.toString(), init);
  },
};
