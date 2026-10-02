// Cross-origin access for the MACHINE surfaces only.
//
// Until 2026-09-19 this server sent no `Access-Control-*` header at all, which
// made it unusable from a browser: a page on another origin cannot read our
// response, and - the part that actually matters for x402 - cannot read the
// `PAYMENT-REQUIRED` / `WWW-Authenticate` headers even when it can send the
// request, because neither is on the CORS response-header safelist. So a
// browser-side buyer (a web app paying with a wallet extension, which is where
// a lot of client work starts) could not see our challenge, could not pay, and
// had no way to tell that from us being down. Measured against a peer seller
// the same day: they send `allow-origin: *` plus an expose list carrying the
// payment headers, and we sent nothing.
//
// The posture is deliberately narrow:
//   * ALLOW-LIST BY PATH. Machine surfaces only. HTML pages get nothing (they
//     are read by browsers on our own origin, and a page that renders
//     third-party seller text has no business being readable cross-origin).
//   * NEVER `Access-Control-Allow-Credentials`. With credentials off, `*` is
//     safe and no cookie or TLS client cert ever rides a cross-origin request,
//     so this grants the ability to READ a response the page could already
//     cause to be sent. It is not a CSRF surface.
//   * The operator surfaces are denied explicitly, belt-and-braces over the
//     prefix list, because a future `/api/__operator`-shaped path would
//     otherwise inherit the allow.
//
// Because the response never varies by origin (it is always `*`), no `Vary:
// Origin` is needed.

/** Path prefixes a cross-origin machine client may read. */
// `/mcp` is deliberately ABSENT: src/mcp-http.js has set its own complete CORS
// since long before this file existed, including `DELETE` (session
// termination) and the `Mcp-Session-Id` expose header. The first cut listed it
// here, and because this middleware mounts far earlier it answered the
// preflight first with `GET, HEAD, POST, OPTIONS` - silently dropping DELETE
// and breaking browser MCP session termination on prod for one deploy. Two
// modules must not write the same headers; the connector owns its own.
export const CORS_PREFIXES = ["/api/", "/v1/", "/.well-known/"];

/** Exact machine surfaces outside those prefixes. */
export const CORS_EXACT = new Set(["/openapi.json", "/llms.txt", "/api", "/v1"]);

/**
 * Denied whatever the prefixes say. `/__operator/*` is the operator's own
 * control plane; `/api/status/probe` writes the uptime record every public
 * availability claim rests on. Neither has a browser client, and both are
 * credential-gated, so exposing them buys nothing and widens the blast radius
 * of a leaked token to "any page the operator visits".
 */
export const CORS_DENY_PREFIXES = ["/__operator", "/api/status/probe", "/api/route/external-debug"];

/**
 * Response headers a cross-origin caller may READ. The payment four are the
 * point of the change; the rest are headers our own gates set and a client
 * needs to act on (a cache hit, a remaining credits balance, what a metered
 * call actually cost, whether a retry was replayed rather than re-charged).
 */
export const CORS_EXPOSE_HEADERS = [
  "PAYMENT-REQUIRED",
  "PAYMENT-RESPONSE",
  "WWW-Authenticate",
  "Payment-Receipt",
  "X-Cache",
  "X-Credits-Balance",
  "X-Metered-Usd",
  "X-Idempotent-Replay",
  "Retry-After",
  "Mcp-Session-Id",
  "Mcp-Protocol-Version",
  "Last-Event-Id",
  // Paging, so a BROWSER consumer can read it too: without these two exposed,
  // fetch() from a page sees the body and not the fact that the body is one
  // page of many, which is the misreading /api/index kept inviting.
  "Link",
  "X-Total-Count",
];

/**
 * Request headers allowed on a preflight when the client names none we can
 * echo. Every one is a header our own documented flows send.
 */
export const CORS_DEFAULT_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "Accept",
  "PAYMENT-SIGNATURE",
  "X-PAYMENT",
  "Payment-Identifier",
  "Idempotency-Key",
  "X-Pow-Solution",
  "Mcp-Session-Id",
  "Mcp-Protocol-Version",
  "Last-Event-Id",
];

export const CORS_METHODS = "GET, HEAD, POST, OPTIONS";
export const CORS_MAX_AGE = "86400";

// RFC 7230 token. A preflight's Access-Control-Request-Headers is
// attacker-influenced text that we would be reflecting into a response header,
// so it is validated rather than trusted, and bounded on both length and count.
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const MAX_ECHO_BYTES = 1024;
const MAX_ECHO_HEADERS = 32;

/** Does this path get cross-origin access? */
export function corsAllowsPath(path) {
  // LOWERCASED before the deny check: `app.set("case sensitive routing")` is
  // never called, so Express routes `/api/status/PROBE` to the same handler
  // while a case-sensitive deny test would miss it and fall through to the
  // `/api/` allow. Inert today (every operator surface is header-credential
  // gated and this server sets no ambient-authority cookie outside
  // /__operator), but the deny list is supposed to mean what it says.
  const p = String(path || "").toLowerCase();
  for (const deny of CORS_DENY_PREFIXES) if (p === deny || p.startsWith(`${deny}/`) || p.startsWith(deny)) return false;
  if (CORS_EXACT.has(p)) return true;
  return CORS_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * What to answer a preflight's `Access-Control-Request-Headers` with. The
 * request's own list is echoed when every entry is a well-formed token and the
 * list is small, so a client sending a header we have not thought of is not
 * blocked; anything malformed or oversized falls back to the fixed list rather
 * than reflecting it.
 */
export function corsAllowHeaders(requested) {
  const raw = String(requested || "");
  if (!raw) return CORS_DEFAULT_ALLOW_HEADERS.join(", ");
  if (Buffer.byteLength(raw) > MAX_ECHO_BYTES) return CORS_DEFAULT_ALLOW_HEADERS.join(", ");
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.length > MAX_ECHO_HEADERS) return CORS_DEFAULT_ALLOW_HEADERS.join(", ");
  if (!parts.every((p) => TOKEN.test(p))) return CORS_DEFAULT_ALLOW_HEADERS.join(", ");
  return parts.join(", ");
}

/**
 * Mount EARLY - ahead of the body parsers, the rate limiters and every payment
 * gate - so a preflight is answered without spending a rate-limit token, being
 * refused by the drain, or being asked to pay.
 */
export function corsMiddleware() {
  const expose = CORS_EXPOSE_HEADERS.join(", ");
  return function cors(req, res, next) {
    if (!corsAllowsPath(req.path)) return next();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", expose);
    if (req.method !== "OPTIONS") return next();
    // A preflight has no Origin-specific answer and never carries a body.
    res.setHeader("Access-Control-Allow-Methods", CORS_METHODS);
    res.setHeader("Access-Control-Allow-Headers", corsAllowHeaders(req.headers["access-control-request-headers"]));
    res.setHeader("Access-Control-Max-Age", CORS_MAX_AGE);
    res.setHeader("Content-Length", "0");
    return res.status(204).end();
  };
}
