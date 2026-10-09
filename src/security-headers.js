// Browser security headers. Every answer carries the three that bind any
// client (nosniff, HSTS, referrer policy). The document-only four (CSP, frame,
// permissions, cross-domain policy) go on pages, and on an API path only when
// the answer is HTML.
// The JSON API paths serve no document: a CSP, frame or permissions policy
// means nothing to the agent reading them and costs about half a kilobyte on
// every answer, including the 402 challenge, whose total header size a
// buyer's HTTP client bounds. Pages keep the full set. On an API path the
// document headers are set only when the answer turns out to be HTML (read
// off Content-Type as the head is written), so a page added under /api later
// is covered without anyone remembering this rule.
const DOCUMENT_HEADERS_SKIP = /^\/(api|v1|mcp)(\/|$)/;
const HTML_TYPE_RE = /^\s*text\/html\b/i;
function headIsHtml(res, headArgs) {
  if (HTML_TYPE_RE.test(String(res.getHeader("content-type") || ""))) return true;
  for (const a of headArgs) {
    if (a && typeof a === "object" && !Array.isArray(a)) {
      for (const [k, v] of Object.entries(a)) if (k.toLowerCase() === "content-type" && HTML_TYPE_RE.test(String(v))) return true;
    }
  }
  return false;
}
export function securityHeaders() {
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    if (DOCUMENT_HEADERS_SKIP.test(req.path)) {
      const writeHead = res.writeHead;
      res.writeHead = function (...args) {
        if (headIsHtml(res, args)) setDocumentHeaders(res);
        return writeHead.apply(this, args);
      };
      return next();
    }
    setDocumentHeaders(res);
    next();
  };
}
function setDocumentHeaders(res) {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  // Disable browser features we never use — defense-in-depth against any future
  // XSS or third-party script accidentally probing for them.
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader(
    "Content-Security-Policy",
    // script-src drops 'unsafe-inline' (2026-08-16): every page-behavior
    // script site-wide now lives in a real file under /js/:file (strict
    // filename allowlist, no path traversal - see server.js's /js/:file
    // route) or a dedicated route with its own scoped CSP (the SDK
    // playground's eval sandbox at /sdk-playground/sandbox). This is
    // defense-in-depth, not a fix for a live exploit — the site already
    // manually-escapes all third-party/user content (crawled seller names,
    // wish-board text, etc.) rather than relying on a templating engine's
    // automatic escaping, across hundreds of call sites; removing
    // 'unsafe-inline' means a future missed esc() call can no longer be
    // turned into a working <script> injection, only inert markup. One
    // narrow exception remains: unpkg.com, for the homepage's pinned,
    // SRI-verified d3 + topojson-client tags (the dot-map, Aug 2026 revamp -
    // the site's first-ever third-party script, an explicit, knowing
    // tradeoff against the "everything self-hosted" posture used everywhere
    // else, incl. fonts). A specific host, never a wildcard or 'unsafe-eval'
    // — SRI on the tags themselves is a second, independent layer (a
    // compromised unpkg response with a mismatched hash is refused by the
    // browser before it ever executes). connect-src's existing 'https:'
    // already covers the map's runtime fetch of the world-atlas geometry
    // from jsdelivr, so no change needed there. www.googletagmanager.com
    // (2026-10-01) serves the Google Analytics tag loaded by
    // assets/js/ga-loader.js when GA_MEASUREMENT_ID is set; its collection
    // requests ride the existing connect-src/img-src https:.
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' https://www.googletagmanager.com; connect-src 'self' https:; frame-src 'self' https://live.agent402.tools; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
  );
}

export { DOCUMENT_HEADERS_SKIP, setDocumentHeaders, headIsHtml };
