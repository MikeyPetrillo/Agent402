// What the first-party analytics proxy (/e/*, src/server.js) relays. The
// browser library is loaded with api_host set to <base>/e
// (src/ledger-chrome.js posthogSnippet, assets/js/posthog-loader.js), and it
// asks that host for three kinds of path:
//   static/<file>.js            the library and the extensions it lazy-loads
//                               (array.js, web-vitals.js, ...), from the assets host
//   array/<token>/config[.js]   the project's remote config
//   e/, i/v0/e/, batch/, ...    event ingestion, and flags/ or decide/ for
//                               the flag check, from the ingestion host
// Nothing else is relayed: any other path answers 404 before an upstream call.

const STATIC_FILE = /^static\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:js|css)$/;
const REMOTE_CONFIG = /^array\/[A-Za-z0-9_-]{1,128}\/config(?:\.js)?$/;
const INGEST = /^(?:e|i\/v0\/e|batch|capture|s|engage|track|flags|decide)\/?$/;

/** True when `sub` (the path after /e/, no query string) is one the library uses. */
export function posthogProxyPathAllowed(sub) {
  const s = String(sub ?? "");
  if (s.length > 256 || s.includes("..") || s.includes("//") || s.includes("\\")) return false;
  return STATIC_FILE.test(s) || REMOTE_CONFIG.test(s) || INGEST.test(s);
}

/** True when an upstream response of this content type may be relayed. A
 *  page (text/html, or any XML document type a browser renders) never is: this
 *  origin serves the library's scripts and JSON, nothing a browser would render. */
export function posthogProxyTypeAllowed(contentType) {
  const t = String(contentType || "").toLowerCase();
  return !/text\/html|application\/xhtml|image\/svg|\bxml\b/.test(t);
}
