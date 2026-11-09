// Route a stubbed fetch by the URL's parsed host, never by a substring of the
// URL string.
//
// Why: `String(url).includes("api.example.com")` also matches
// "https://evil.test/?u=api.example.com" and "https://api.example.com.evil.test",
// so it is CodeQL's js/incomplete-url-substring-sanitization on every suite that
// writes it (three new alerts in one week of November 2026, each dismissed by
// hand as "used in tests"). In a stub it is harmless, but each new one is noise
// that hides a real finding, and the same line copied into src/ would be a hole.
// scripts/test-url-host-match.js keeps new tests on these helpers.
//
//   import { isHost, urlMatches } from "./lib/url-host.js";
//   globalThis.fetch = async (url, init) => isHost(url, "api.example.com") ? stub() : realFetch(url, init);

/** The lower-cased hostname of `url` (a string, URL or Request), or "" when it does not parse. */
export function hostOf(url) {
  try { return new URL(typeof url === "object" && url && "url" in url ? url.url : String(url)).hostname.toLowerCase(); } catch { return ""; }
}

/** True when `url`'s host is exactly `host` (case-insensitive). No subdomains, no substrings. */
export function isHost(url, host) {
  return hostOf(url) === String(host).toLowerCase();
}

/**
 * True when `url`'s host is `host` and its path starts with `pathPrefix`
 * (compared on the parsed pathname, so a query string cannot satisfy it).
 */
export function urlMatches(url, host, pathPrefix = "/") {
  if (!isHost(url, host)) return false;
  try { return new URL(typeof url === "object" && url && "url" in url ? url.url : String(url)).pathname.startsWith(pathPrefix); } catch { return false; }
}
