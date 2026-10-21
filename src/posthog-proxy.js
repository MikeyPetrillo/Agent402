// What the first-party analytics proxy (/e/*, src/server.js) relays. The
// browser library is loaded with api_host set to <base>/e
// (src/ledger-chrome.js posthogSnippet, assets/js/posthog-loader.js), and it
// asks that host for these kinds of path (POSTHOG_LIBRARY_PATHS lists each one
// with the feature that requests it):
//   static/<file>.js            the library and the extensions it lazy-loads
//                               (array.js, web-vitals.js, ...), from the assets host
//   array/<token>/config[.js]   the project's remote config
//   e/, i/v0/e/, batch/, ...    event ingestion, and flags/ or decide/ for
//                               the flag check, from the ingestion host
//   api/surveys/, ...           the library's read endpoints for surveys, early
//                               access features and web experiments, and
//                               site_app/<id>/<token>/<hash>/ for site apps
// Nothing else is relayed: any other path answers 404 before an upstream call.

const STATIC_FILE = /^static\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:js|css)$/;
const REMOTE_CONFIG = /^array\/[A-Za-z0-9_-]{1,128}\/config(?:\.js)?$/;
const INGEST = /^(?:e|i\/v0\/e|batch|capture|s|engage|track|flags|decide)\/?$/;
const LIBRARY_API = /^api\/(?:surveys|early_access_features|web_experiments)\/?$/;
const SITE_APP = /^site_app\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/?$/;

/** Every path the browser library asks its api_host for, with the feature that
 *  asks. `used` marks the ones the site's own config (posthogSnippet) turns on,
 *  or that the project's remote config can turn on with no change here (the
 *  lazily loaded extensions). Each must stay relayed; the proxy test checks
 *  every row. */
export const POSTHOG_LIBRARY_PATHS = Object.freeze([
  // The loader and the bundles it can name.
  { path: "static/array.js", feature: "the library (the loader's script tag)", used: true },
  { path: "static/array.full.js", feature: "the full bundle", used: false },
  { path: "static/main.js", feature: "the module bundle", used: false },
  // Remote config, read at init.
  { path: "array/phc_TOKEN/config", feature: "remote config (JSON)", used: true },
  { path: "array/phc_TOKEN/config.js", feature: "remote config (script, with site apps inlined)", used: true },
  // Flags, read at init.
  { path: "flags/", feature: "feature flags and remote settings", used: true },
  { path: "flags", feature: "feature flags (no trailing slash)", used: true },
  { path: "decide/", feature: "feature flags (earlier library versions)", used: true },
  // Ingestion.
  { path: "e/", feature: "events: $pageview, $pageleave (a beacon), $web_vitals, $exception", used: true },
  { path: "e", feature: "events (no trailing slash)", used: true },
  { path: "i/v0/e/", feature: "events (ingestion endpoint)", used: true },
  { path: "batch/", feature: "batched events", used: true },
  { path: "capture/", feature: "events (capture alias)", used: false },
  { path: "track/", feature: "events (track alias)", used: false },
  { path: "engage/", feature: "person properties (earlier library versions)", used: false },
  { path: "s/", feature: "session recording snapshots (off: disable_session_recording)", used: false },
  // Lazily loaded extensions, each its own script under static/.
  { path: "static/web-vitals.js", feature: "web vitals (capture_performance.web_vitals)", used: true },
  { path: "static/exception-autocapture.js", feature: "exception autocapture (remote config)", used: true },
  { path: "static/dead-clicks-autocapture.js", feature: "dead click autocapture (remote config)", used: true },
  { path: "static/tracing-headers.js", feature: "tracing headers", used: false },
  { path: "static/recorder.js", feature: "session recording (off)", used: false },
  { path: "static/lazy-recorder.js", feature: "session recording, lazy bundle (off)", used: false },
  { path: "static/posthog-recorder.js", feature: "session recording, recorder bundle (off)", used: false },
  { path: "static/surveys.js", feature: "surveys (off: disable_surveys)", used: false },
  { path: "static/toolbar.js", feature: "the toolbar, opened from the analytics app", used: true },
  { path: "static/toolbar.css", feature: "the toolbar's stylesheet", used: true },
  // The library's read endpoints for features the site has off.
  { path: "api/surveys/", feature: "survey definitions (off: disable_surveys)", used: false },
  { path: "api/early_access_features/", feature: "early access features (getEarlyAccessFeatures)", used: false },
  { path: "api/web_experiments/", feature: "web experiments (off by library default)", used: false },
  { path: "site_app/1/phc_TOKEN/abc123/", feature: "site apps (off: opt_in_site_apps)", used: false },
]);

/** True when `sub` (the path after /e/, no query string) is one the library uses. */
export function posthogProxyPathAllowed(sub) {
  const s = String(sub ?? "");
  if (s.length > 256 || s.includes("..") || s.includes("//") || s.includes("\\")) return false;
  return STATIC_FILE.test(s) || REMOTE_CONFIG.test(s) || INGEST.test(s) || LIBRARY_API.test(s) || SITE_APP.test(s);
}

/** True when an upstream response of this content type may be relayed. A
 *  page (text/html, or any XML document type a browser renders) never is: this
 *  origin serves the library's scripts and JSON, nothing a browser would render. */
export function posthogProxyTypeAllowed(contentType) {
  const t = String(contentType || "").toLowerCase();
  return !/text\/html|application\/xhtml|image\/svg|\bxml\b/.test(t);
}

// A refused path a browser sent from one of this site's own pages
// (Sec-Fetch-Site: same-origin) is the library asking for a path this list
// does not hold: logged once per distinct path, a bounded number per process,
// so a library change shows up in the logs instead of as missing analytics.
// Scanners and other callers do not send the header, so they cannot fill it.
const REFUSED_SEEN_MAX = 32;
const refusedSeen = new Set();
/** Note a refused path; returns the log line written, or null. */
export function noteRefusedPosthogPath(sub, fetchSite, log = console.warn) {
  if (String(fetchSite || "").toLowerCase() !== "same-origin") return null;
  const key = String(sub ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 120);
  if (refusedSeen.has(key) || refusedSeen.size >= REFUSED_SEEN_MAX) return null;
  refusedSeen.add(key);
  const line = `[posthog-proxy] refused a same-origin library path not on the allowlist: /e/${key}`;
  log(line);
  return line;
}
export function _resetRefusedPosthogPathsForTest() { refusedSeen.clear(); }
