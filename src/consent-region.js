// Whether a page visitor is asked before any analytics loads, from the CDN's
// country header for this one request (GET /api/consent-region, read by
// assets/js/analytics-consent.js when the browser's time zone is not European).
//
// Asked first: the EU, the EEA (Iceland, Liechtenstein, Norway), the UK and
// Switzerland, with the territories their rules reach that carry their own
// country code (the outermost regions, Aland, Gibraltar, the Crown
// dependencies). A code the CDN uses for "cannot tell" (XX, T1 for Tor) asks
// too. No header (a host with no CDN in front) answers "unknown", and the
// browser's time zone stands. The answer is never cached and names nothing but
// that one bit and where it came from; the country itself is not logged or kept.

export const ASK_FIRST_COUNTRIES = Object.freeze([
  // EU 27
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  // EEA, UK, Switzerland
  "IS", "LI", "NO", "GB", "CH",
  // Territories under those rules with their own code
  "AX", "GP", "MQ", "GF", "RE", "YT", "MF", "GI", "GG", "JE", "IM",
]);
const ASK = new Set(ASK_FIRST_COUNTRIES);
// The CDN's codes for a country it could not name.
const UNNAMED = new Set(["XX", "T1"]);

/** { asksFirst, source } for one request's country header value. */
export function consentRegionFor(header) {
  const v = typeof header === "string" ? header.trim().toUpperCase() : "";
  if (!/^[A-Z][A-Z0-9]$/.test(v)) return { asksFirst: false, source: "unknown" };
  if (UNNAMED.has(v)) return { asksFirst: true, source: "unnamed" };
  return { asksFirst: ASK.has(v), source: "country" };
}

export function consentRegionRoute(req, res) {
  const header = req.get ? req.get("cf-ipcountry") : undefined;
  const out = consentRegionFor(typeof header === "string" ? header.slice(0, 8) : "");
  res.set("Cache-Control", "private, no-store").set("Vary", "*").json(out);
}
