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
//   # secret (required): wrangler secret put TOLLBOOTH_SECRET
//   # optional single-use store: [[kv_namespaces]] binding = "TOLLBOOTH_KV"
import { createEdgeTollbooth } from "./edge.js";

const kvStore = (kv) => ({
  has: async (k) => (await kv.get(k)) != null,
  add: async (k, expMs) => kv.put(k, "1", { expiration: Math.ceil(expMs / 1000) }),
});

export default {
  async fetch(request, env) {
    if (!env.TOLLBOOTH_SECRET) {
      return new Response("Tollbooth misconfigured: set TOLLBOOTH_SECRET (wrangler secret put TOLLBOOTH_SECRET)", { status: 500 });
    }
    const gate = createEdgeTollbooth({
      secret: env.TOLLBOOTH_SECRET,
      price: env.TOLLBOOTH_PRICE || "$0.001",
      payTo: env.TOLLBOOTH_PAYTO || null,
      network: env.TOLLBOOTH_NETWORK || "base",
      powDifficulty: env.TOLLBOOTH_POW_BITS ? Number(env.TOLLBOOTH_POW_BITS) : undefined,
      store: env.TOLLBOOTH_KV ? kvStore(env.TOLLBOOTH_KV) : undefined,
    });

    const blocked = await gate(request);
    if (blocked) return blocked;

    // Allowed → proxy to the origin.
    const upstream = env.TOLLBOOTH_UPSTREAM;
    if (!upstream) return new Response("Tollbooth: set TOLLBOOTH_UPSTREAM to your origin", { status: 500 });
    const target = new URL(request.url);
    const origin = new URL(upstream);
    target.protocol = origin.protocol;
    target.hostname = origin.hostname;
    target.port = origin.port;
    return fetch(new Request(target.toString(), request));
  },
};
