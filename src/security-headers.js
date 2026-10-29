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
// The analytics tag's script host is allowed per answer: only an HTML body
// that carries the first-party GA loader (src/ledger-chrome.js gaSnippet,
// which leaves it off every bearer-link page) gets it in script-src.
const GA_SCRIPT_HOST = "https://www.googletagmanager.com";
const GA_LOADER_MARK = "/js/ga-loader.js";
function bodyCarriesGaLoader(body) {
  if (typeof body === "string") return body.includes(GA_LOADER_MARK);
  if (Buffer.isBuffer(body)) return body.includes(GA_LOADER_MARK);
  return false;
}
export function securityHeaders() {
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    const send = res.send;
    if (typeof send === "function") {
      res.send = function (body) {
        // Only the site policy is widened; a route that set its own is left as it is.
        if (!res.headersSent && res.getHeader("content-security-policy") === contentSecurityPolicy() && bodyCarriesGaLoader(body)) {
          res.setHeader("Content-Security-Policy", contentSecurityPolicy({ analytics: true }));
        }
        return send.apply(this, arguments);
      };
    }
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
  res.setHeader("Content-Security-Policy", contentSecurityPolicy());
}
export function contentSecurityPolicy({ analytics = false } = {}) {
  return (
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
    // turned into a working <script> injection, only inert markup. The one
    // script host beyond 'self' is www.googletagmanager.com, added only to
    // an answer whose body carries the GA loader (see securityHeaders); it
    // serves the Google Analytics tag loaded by assets/js/ga-loader.js when
    // GA_MEASUREMENT_ID is set, and its collection requests ride the
    // existing connect-src/img-src https:.
    // form-action: a form submits only to this origin, or to mailto: (the
    // /company contact form opens the visitor's email app). Card checkout is
    // a redirect, never a form post to another origin.
    // scripts/test-csp-form-action.js keeps every form in the tree inside it.
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self' https:; frame-src 'self' https://live.agent402.tools; object-src 'none'; base-uri 'self'; form-action 'self' mailto:; frame-ancestors 'self'"
  ).replace("script-src 'self';", analytics ? `script-src 'self' ${GA_SCRIPT_HOST};` : "script-src 'self';");
}

export { DOCUMENT_HEADERS_SKIP, setDocumentHeaders, headIsHtml };
