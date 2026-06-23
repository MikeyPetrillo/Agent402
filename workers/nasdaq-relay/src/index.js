// nasdaq-relay — Cloudflare Worker that proxies Nasdaq's keyless calendar
// API. Same pattern as yfinance-relay: exists because Railway's egress IP
// range is silently null-routed by Nasdaq's CloudFront edge (TCP ETIMEDOUT).
// Routing through Cloudflare moves the egress to CF's IP range.
//
// Surface (deliberately narrow):
//   • GET only — Nasdaq's calendar endpoint is GET; nothing else is needed.
//   • Path allowlist: /api/calendar/* exclusively. Refuses anything else
//     with 403 so this Worker can't be repurposed as a generic proxy.
//   • Bearer auth: Authorization: Bearer <token> must match the
//     RELAY_TOKEN Worker secret.

const UPSTREAM_HOST = "https://api.nasdaq.com";
const ALLOWED_PATH = /^\/api\/calendar\/[a-z]+$/;
const DEFAULT_UA = "Mozilla/5.0 (compatible; Agent402-nasdaq-relay/1.0; +https://agent402.tools)";

export default {
  async fetch(request, env) {
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }

    const expected = env.RELAY_TOKEN;
    if (!expected) {
      return new Response("relay not configured", { status: 503 });
    }
    const auth = request.headers.get("Authorization") || "";
    const got = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!constantTimeEqual(got, expected)) {
      return new Response("unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    if (!ALLOWED_PATH.test(url.pathname)) {
      return new Response("path not allowed (only /api/calendar/*)", { status: 403 });
    }

    const upstreamUrl = `${UPSTREAM_HOST}${url.pathname}${url.search}`;
    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: "GET",
        headers: {
          "User-Agent": request.headers.get("User-Agent") || DEFAULT_UA,
          Accept: "application/json,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      });
    } catch (e) {
      return new Response(`upstream fetch failed: ${e.message}`, { status: 502 });
    }

    const out = new Headers();
    for (const [k, v] of upstream.headers) {
      const lower = k.toLowerCase();
      if (lower === "set-cookie" || lower === "server" || lower === "x-served-by") continue;
      out.set(k, v);
    }
    out.set("X-Relay", "agent402-nasdaq-relay");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  },
};

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
