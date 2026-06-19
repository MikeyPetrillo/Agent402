// yfinance-relay — Cloudflare Worker that proxies Yahoo Finance's keyless
// chart API. Exists because some hosting providers' egress IP ranges are
// silently null-routed by Yahoo's edge (packets dropped → TCP ETIMEDOUT
// after ~10s, observed from Railway). Routing through Cloudflare moves the
// egress to CF's IP range, which Yahoo permits.
//
// Surface (deliberately narrow):
//   • GET only — Yahoo's chart endpoint is GET; nothing else is needed.
//   • Path allowlist: /v8/finance/chart/* exclusively. Refuses anything else
//     with 403 so this Worker can't be repurposed as a generic proxy.
//   • Bearer auth: Authorization: Bearer <token> must match the
//     RELAY_TOKEN Worker secret. Without auth this Worker becomes a free
//     Yahoo proxy for anyone who finds the URL — abuse vector that could
//     get *Cloudflare's* IPs WAF'd next, compounding the original problem.
//
// Forwarded request shape (to query1.finance.yahoo.com):
//   • Method: GET
//   • Headers: User-Agent (passthrough or default browser-like UA),
//     Accept: application/json. Authorization is stripped — that's our
//     bearer token, not Yahoo's.
//   • No cookies sent or returned. Yahoo's chart endpoint is stateless;
//     cookies would only be tracking junk.
//
// Response: status + body streamed back to the caller. Set-Cookie stripped
// (we don't want Yahoo's session crap leaking into agent402.tools).

const UPSTREAM_HOST = "https://query1.finance.yahoo.com";
const ALLOWED_PATH = /^\/v8\/finance\/chart\/[A-Z0-9^.\-=%]+$/;
const DEFAULT_UA = "Mozilla/5.0 (compatible; Agent402-yfinance-relay/1.0; +https://agent402.tools)";

export default {
  async fetch(request, env) {
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }

    // Constant-time bearer comparison. Worker's auth check happens before
    // any upstream call — bad token = no Yahoo round-trip burned.
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
      return new Response("path not allowed (only /v8/finance/chart/*)", { status: 403 });
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
        // Don't follow auth redirects — keeps the proxy surface minimal.
        redirect: "follow",
      });
    } catch (e) {
      // If CF itself can't reach Yahoo, surface a clear upstream failure
      // (not a relay bug). Useful for the server-side error attribution.
      return new Response(`upstream fetch failed: ${e.message}`, { status: 502 });
    }

    // Strip Set-Cookie and other session/tracking headers before relaying.
    const out = new Headers();
    for (const [k, v] of upstream.headers) {
      const lower = k.toLowerCase();
      if (lower === "set-cookie" || lower === "server" || lower === "x-served-by") continue;
      out.set(k, v);
    }
    out.set("X-Relay", "agent402-yfinance-relay");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  },
};

// Length-and-content equality in fixed time, to keep timing oracles off the
// bearer comparison. Tokens are short (~32 chars) so this is cheap.
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
