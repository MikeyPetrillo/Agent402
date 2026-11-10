// Browser security headers. Every answer carries the three that bind any
// client (nosniff, HSTS, referrer policy). The document-only four (CSP, frame,
// permissions, cross-domain policy) go on pages, and on an API path only when
// the answer is HTML; an API answer of a type a browser could open as a
// document gets a sandboxed policy instead (SANDBOX_CSP below).
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
// Any other answer on an API path that a browser could open as a document
// (SVG, XML, XHTML, an unknown or missing type) carries a policy that loads
// nothing and runs nothing: it is never one of our pages, so it needs no
// script, style or frame. The inert types below are data a browser shows as
// data (JSON, plain text, an event stream, media, a raster image, a PDF, an
// archive or an Office download) and keep the lean header set, so the 402
// challenge, the JSON answers and the media and file downloads are unchanged.
// A bodiless answer (204, 304) has nothing to open.
const SANDBOX_CSP = "default-src 'none'; sandbox";
const INERT_TYPE_RE = /^\s*(?:application\/(?:json|[\w.-]+\+json|x-ndjson|pdf|zip|gzip|x-gzip|octet-stream|msword|vnd\.ms-[\w.+-]+|vnd\.openxmlformats-officedocument\.[\w.+-]+|vnd\.oasis\.opendocument\.[\w.+-]+)|text\/(?:plain|event-stream|csv|markdown)|audio\/[\w.+-]+|video\/[\w.+-]+|image\/(?:png|jpeg|jpg|gif|webp|avif|bmp|tiff|x-icon|vnd\.microsoft\.icon|heic|heif))\s*(?:;|$)/i;
function headContentType(res, headArgs) {
  for (const a of headArgs) {
    if (a && typeof a === "object" && !Array.isArray(a)) {
      for (const [k, v] of Object.entries(a)) if (k.toLowerCase() === "content-type") return String(v);
    }
  }
  return String(res.getHeader("content-type") || "");
}
function headIsInert(res, headArgs) {
  const status = typeof headArgs[0] === "number" ? headArgs[0] : res.statusCode;
  if (status === 204 || status === 304) return true;
  return INERT_TYPE_RE.test(headContentType(res, headArgs));
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
// The three every answer carries. Strict-Transport-Security is sent on every
// answer, not only one read as secure: TLS ends at the edge, so whether a
// request "was https" is a reading of X-Forwarded-Proto that is only as good
// as TRUST_PROXY_HOPS, and an answer that lost the header to a wrong hop count
// would leave a browser free to downgrade. A browser ignores the header on an
// answer it received over plain http (RFC 6797 section 8.1), so a local http
// boot is unaffected by it.
const ALWAYS_HEADERS = Object.freeze([
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"],
]);
// A request the HTTP parser refuses (a malformed request line or header, a
// header block past the size limit, a request that never finished arriving)
// is answered by the server before any middleware runs, so the middleware
// below never sees it. The same status line Node writes by default, with the
// three headers above. Attach with httpServer.on("clientError", answerClientError).
const PARSER_STATUS = Object.freeze({
  HPE_HEADER_OVERFLOW: "431 Request Header Fields Too Large",
  HPE_CHUNK_EXTENSIONS_OVERFLOW: "413 Payload Too Large",
  ERR_HTTP_REQUEST_TIMEOUT: "408 Request Timeout",
});
export function clientErrorHead(code) {
  const status = (typeof code === "string" && Object.hasOwn(PARSER_STATUS, code) && PARSER_STATUS[code]) || "400 Bad Request";
  return `HTTP/1.1 ${status}\r\n${ALWAYS_HEADERS.map(([n, v]) => `${n}: ${v}\r\n`).join("")}Content-Length: 0\r\nConnection: close\r\n\r\n`;
}
export function answerClientError(err, socket) {
  // Nothing is written into an answer already under way, or to a socket that
  // can no longer take one (Node's own rule for its default answer).
  try {
    if (socket.writable && (!socket._httpMessage || !socket._httpMessage._headerSent)) socket.write(clientErrorHead(err?.code));
  } catch { /* the socket is closed below either way */ }
  socket.destroy(err);
}
export function securityHeaders() {
  return (req, res, next) => {
    for (const [name, value] of ALWAYS_HEADERS) res.setHeader(name, value);
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
        else if (!res.getHeader("content-security-policy") && !headIsInert(res, args)) res.setHeader("Content-Security-Policy", SANDBOX_CSP);
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

export { DOCUMENT_HEADERS_SKIP, setDocumentHeaders, headIsHtml, headIsInert, SANDBOX_CSP, ALWAYS_HEADERS };
