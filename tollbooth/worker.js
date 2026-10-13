// Cloudflare Worker entry for the tollbooth, open-source pay-per-crawl on the
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

// Constant-time string compare, Cloudflare Workers don't ship node:crypto's
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
  // Best-effort claim. KV has no native compare-and-set, so this is get-then-put
  // (eventually consistent), concurrent dupes across isolates/locations can
  // both observe "unseen" and both pass. For STRICT single-use use the Durable
  // Object store below. Returns true only the first time a token is seen.
  claim: async (k, expMs) => {
    if ((await kv.get(k)) != null) return false;
    await kv.put(k, "1", { expiration: Math.ceil(expMs / 1000) });
    return true;
  },
});

// F05: strict single-use replay claim via a Durable Object. A DO instance is
// single-threaded: every request addressed to one DO id is serialized, so the
// get-then-put INSIDE it is ATOMIC across all isolates and locations (KV is
// eventually consistent and has no compare-and-set). Each token is routed to its
// own DO id, so claims only ever contend on the exact token they concern.
export class TollboothReplay {
  constructor(state) { this.state = state; }
  async fetch(request) {
    let expMs = 0;
    try { expMs = Number((await request.json()).expMs) || 0; } catch { /* */ }
    const already = await this.state.storage.get("claimed");
    if (already != null) return Response.json({ granted: false });
    await this.state.storage.put("claimed", 1);
    // Auto-expire the DO storage at the token's expiry, the token is worthless
    // after that, so the claim record can be dropped and storage stays bounded.
    if (expMs > Date.now()) { try { await this.state.storage.setAlarm(expMs); } catch { /* */ } }
    return Response.json({ granted: true });
  }
  async alarm() { try { await this.state.storage.deleteAll(); } catch { /* */ } }
}

export const durableObjectStore = (namespace) => ({
  claim: async (k, expMs) => {
    const stub = namespace.get(namespace.idFromName(k));
    const resp = await stub.fetch("https://tollbooth-replay/claim", { method: "POST", body: JSON.stringify({ expMs }) });
    const { granted } = await resp.json();
    return granted === true;
  },
});

export default {
  async fetch(request, env, ctx) {
    if (!env.TOLLBOOTH_SECRET) {
      return new Response("Tollbooth misconfigured: set TOLLBOOTH_SECRET (wrangler secret put TOLLBOOTH_SECRET)", { status: 500 });
    }
    // F05: pick the replay store, strongest first. A Durable Object
    // (TOLLBOOTH_REPLAY) gives ATOMIC, strict single-use across isolates and
    // locations. KV is a best-effort fallback (eventually consistent; concurrent
    // dupes can both pass). With neither, protection is per-isolate only.
    const enforcing = env.TOLLBOOTH_OBSERVE !== "true";
    // FR4-04: FAIL CLOSED in enforcing mode without an ATOMIC replay store. A
    // Durable Object (TOLLBOOTH_REPLAY) gives strict single-use across isolates
    // and locations. KV is eventually consistent (get-then-put, NOT atomic), so
    // concurrent duplicate PoW solutions can both pass, a warning does not
    // protect a production deployment. Refuse to enforce on a non-atomic (or
    // absent) store unless the operator sets an explicit, loud insecure override.
    const allowNonAtomic = env.TOLLBOOTH_ALLOW_NON_ATOMIC_REPLAY === "true";
    if (enforcing && !env.TOLLBOOTH_REPLAY && !allowNonAtomic) {
      return new Response(
        "Tollbooth misconfigured: enforcing mode requires an ATOMIC replay store. Bind a Durable Object as TOLLBOOTH_REPLAY (see deploy/cloudflare/wrangler.toml), run in observe mode (TOLLBOOTH_OBSERVE=true), or accept non-atomic replay explicitly with TOLLBOOTH_ALLOW_NON_ATOMIC_REPLAY=true.",
        { status: 500 }
      );
    }
    let replayStore;
    if (env.TOLLBOOTH_REPLAY) {
      replayStore = durableObjectStore(env.TOLLBOOTH_REPLAY);
    } else if (env.TOLLBOOTH_KV) {
      replayStore = kvStore(env.TOLLBOOTH_KV);
      if (enforcing) console.warn("agent402-tollbooth: ENFORCING on eventually-consistent KV via explicit TOLLBOOTH_ALLOW_NON_ATOMIC_REPLAY override (get-then-put is NOT atomic: concurrent duplicate solutions across isolates/locations can both pass). Bind a Durable Object as TOLLBOOTH_REPLAY for strict single-use.");
    } else if (enforcing) {
      console.warn("agent402-tollbooth: ENFORCING with NO replay store via explicit TOLLBOOTH_ALLOW_NON_ATOMIC_REPLAY override: proof-of-work replay protection is per-isolate only. Bind a Durable Object for production.");
    }
    // Durable stats live in KV if a namespace is bound. Without it, the dashboard
    // is per-isolate (dies on cold start), fine for dev, useless for prod.
    const statsSink = env.TOLLBOOTH_KV
      ? kvStatsSink(env.TOLLBOOTH_KV, { bucket: env.TOLLBOOTH_STATS_BUCKET || "default" })
      : undefined;
    const gate = createEdgeTollbooth({
      secret: env.TOLLBOOTH_SECRET,
      price: env.TOLLBOOTH_PRICE || "$0.001",
      payTo: env.TOLLBOOTH_PAYTO || null,
      network: env.TOLLBOOTH_NETWORK || "base",
      asset: env.TOLLBOOTH_ASSET || "USDC",
      powDifficulty: env.TOLLBOOTH_POW_BITS ? Number(env.TOLLBOOTH_POW_BITS) : undefined,
      store: replayStore,
      observe: env.TOLLBOOTH_OBSERVE === "true",
      statsSink,
    });

    // Free, never-gated operator endpoints. Mounted BEFORE the gate so they
    // can't be paywalled, and so the dashboard polls work even when the rest
    // of the origin is fully gated.
    const u = new URL(request.url);
    if (u.pathname === "/__tollbooth" || u.pathname === "/__tollbooth/") {
      return new Response(dashboardHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (u.pathname === "/__tollbooth/stats") {
      // Optional bearer-token gate, share with your monitoring caller. We
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
    // Flush any buffered stats to KV after we've replied, survives the response.
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
