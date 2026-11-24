// Requests from comprehensively sanctioned jurisdictions are answered 451
// before any payment work: no payment header is verified, nothing settles and
// no handler runs. A legal block, not a buyer limit: it touches only the
// regions US sanctions programs close (Cuba, Iran, North Korea, Syria, and
// the occupied Crimea, Sevastopol, Donetsk and Luhansk regions of Ukraine).
//
// WHERE THE LOCATION COMES FROM. Only Cloudflare's own headers, and only on a
// request the CDN resolver proved came through Cloudflare (req.viaCdn: a CDN
// peer that carried CDN_ORIGIN_SECRET, src/cdn-client-ip.js). From any other
// peer the headers are the client's own words and are never read, so a
// client cannot block or unblock itself by sending one.
//   - CF-IPCountry: ISO 3166-1 alpha-2, sent whenever Cloudflare's IP
//     geolocation is on (XX unknown, T1 Tor: neither is blocked).
//   - cf-region-code / cf-region: the first-level subdivision, sent only
//     while the zone's "Add visitor location headers" managed transform is
//     on. Without it the occupied regions of Ukraine cannot be told apart
//     from the rest of Ukraine here, and only the country set applies; the
//     operator view says so (regionHeaders: "absent").
//
// SWITCH. SANCTIONS_GEO_BLOCK (default on; "off" turns it off) and
// SANCTIONS_GEO_COUNTRIES (a comma list replacing the default country set).
// The exempt paths (/health and the legal pages) answer from anywhere.
//
// RECORDS. Every refusal is counted in memory (operator view, by country). A
// refused request that carried a payment is recorded in the sanctions events
// store (src/sanctions-events.js) as a rejected transaction, with the
// sanctioned country or region code that is the refusal's reason (a report
// must state why), and nothing more of the location: a request that is served
// keeps no location at all, and Cloudflare's other location headers (city,
// postal code, coordinates, time zone) are never read.
import { paymentHeaderOf } from "./payer.js";
import { NOT_CHARGED } from "./not-charged.js";

export const DEFAULT_SANCTIONED_COUNTRIES = Object.freeze(["CU", "IR", "KP", "SY"]);
// Ukraine's ISO 3166-2 subdivisions: 43 Crimea, 40 Sevastopol, 14 Donetsk, 09 Luhansk.
export const SANCTIONED_UA_REGION_CODES = Object.freeze(["43", "40", "14", "09"]);
// The same regions by name, for a geolocation source that files them under
// another country code or spells the code differently.
const SANCTIONED_REGION_NAME_RE = /\b(crimea|krym|sevastopol|donetsk|luhansk|lugansk)\b/i;
// The ISO 3166-2 code each region name stands for, so a refusal records a code
// and never the header's own text.
const REGION_CODE_BY_NAME = Object.freeze({ crimea: "UA-43", krym: "UA-43", sevastopol: "UA-40", donetsk: "UA-14", luhansk: "UA-09", lugansk: "UA-09" });
// A first-level subdivision code as Cloudflare sends it ("43", "UA-43", "THR").
const SUBDIVISION_CODE_RE = /^(?:[A-Z]{2}-)?[A-Z0-9]{1,3}$/;

/** Paths that answer from anywhere: the health probe and the legal pages. */
export const SANCTIONS_EXEMPT_PATHS = Object.freeze(new Set(["/health", "/terms", "/privacy", "/dpa", "/accessibility", "/security", "/company", "/.well-known/security.txt", "/robots.txt"]));

export const SANCTIONED_REGION_TEXT = `This service is not available in your region. ${NOT_CHARGED}`;

export function sanctionsGeoBlockEnabled(env = process.env) {
  return String(env.SANCTIONS_GEO_BLOCK ?? "").trim().toLowerCase() !== "off";
}

export function sanctionedCountries(env = process.env) {
  const raw = String(env.SANCTIONS_GEO_COUNTRIES ?? "").trim();
  if (!raw) return new Set(DEFAULT_SANCTIONED_COUNTRIES);
  const list = raw.split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s));
  return new Set(list.length ? list : DEFAULT_SANCTIONED_COUNTRIES);
}

const header = (req, name) => {
  const v = req?.headers?.[name];
  return typeof v === "string" ? v.trim().slice(0, 64) : "";
};

/**
 * The block verdict for a request: null (serve it) or { country, region }.
 * `country` is an ISO 3166-1 alpha-2 code (or null); `region` an ISO 3166-2
 * code ("UA-43") or null, never a name, city or coordinate.
 * Reads the Cloudflare headers only when `trusted` is true. Pure.
 */
export function sanctionedLocationOf(req, { trusted = false, countries = sanctionedCountries() } = {}) {
  if (!trusted) return null;
  const country = header(req, "cf-ipcountry").toUpperCase();
  const regionCode = header(req, "cf-region-code").toUpperCase();
  const regionName = header(req, "cf-region");
  if (/^[A-Z]{2}$/.test(country) && countries.has(country)) {
    const sub = SUBDIVISION_CODE_RE.test(regionCode) ? regionCode.replace(/^[A-Z]{2}-/, "") : "";
    return { country, region: sub ? `${country}-${sub}` : null };
  }
  // The region code arrives as the subdivision suffix ("43"); a full code
  // ("UA-43") is read the same way.
  const code = regionCode.replace(/^UA-/, "");
  if (country === "UA" && SANCTIONED_UA_REGION_CODES.includes(code)) return { country, region: `UA-${code}` };
  const named = regionName ? SANCTIONED_REGION_NAME_RE.exec(regionName) : null;
  if (named && (country === "UA" || country === "RU" || !country)) {
    return { country: /^[A-Z]{2}$/.test(country) ? country : null, region: REGION_CODE_BY_NAME[named[1].toLowerCase()] };
  }
  return null;
}

const counts = { refused: 0, refusedWithPayment: 0, byCountry: {}, lastAt: null, regionHeadersSeen: 0, cdnRequests: 0 };

/** The operator view: counts by country and whether region data arrives. */
export function sanctionedRegionsView(env = process.env) {
  return {
    enabled: sanctionsGeoBlockEnabled(env),
    countries: [...sanctionedCountries(env)],
    ukraineRegions: SANCTIONED_UA_REGION_CODES.map((c) => `UA-${c}`),
    refused: counts.refused,
    refusedWithPayment: counts.refusedWithPayment,
    byCountry: { ...counts.byCountry },
    lastAt: counts.lastAt,
    // "present" once a CDN request carried cf-region-code in this process;
    // "absent" while CDN requests arrive without it (the managed transform is
    // off: the occupied regions are not told apart); "no-cdn-traffic" before any.
    regionHeaders: counts.regionHeadersSeen > 0 ? "present" : counts.cdnRequests > 0 ? "absent" : "no-cdn-traffic",
  };
}

/** Tests. */
export function __resetSanctionedRegionsForTests() {
  counts.refused = 0; counts.refusedWithPayment = 0; counts.byCountry = {}; counts.lastAt = null; counts.regionHeadersSeen = 0; counts.cdnRequests = 0;
}

/**
 * The middleware. Mount after the CDN resolver (it sets req.viaCdn) and
 * before every payment gate, idempotency cache and async-job replay.
 * `trustedOf(req)` says whether the Cloudflare headers are Cloudflare's;
 * `record(event)` keeps a refused paid request (best effort, never awaited).
 */
export function sanctionedRegionsMiddleware({ env = process.env, trustedOf = (req) => req.viaCdn === true, record = null, log = console.warn } = {}) {
  if (!sanctionsGeoBlockEnabled(env)) return function sanctionedRegionsOff(_req, _res, next) { next(); };
  const countries = sanctionedCountries(env);
  let loggedAt = 0;
  return function sanctionedRegions(req, res, next) {
    let trusted = false;
    try { trusted = trustedOf(req) === true; } catch { trusted = false; }
    if (trusted) {
      counts.cdnRequests++;
      if (header(req, "cf-region-code")) counts.regionHeadersSeen++;
    }
    if (SANCTIONS_EXEMPT_PATHS.has(req.path)) return next();
    const hit = sanctionedLocationOf(req, { trusted, countries });
    if (!hit) return next();
    counts.refused++;
    const key = hit.country || "region";
    counts.byCountry[key] = (counts.byCountry[key] || 0) + 1;
    counts.lastAt = new Date().toISOString();
    const withPayment = Boolean(paymentHeaderOf(req) || req.headers?.authorization?.toString?.().startsWith?.("Payment "));
    if (withPayment) {
      counts.refusedWithPayment++;
      if (typeof record === "function") {
        try { Promise.resolve(record({ req, country: hit.country, region: hit.region })).catch(() => {}); } catch { /* never breaks the answer */ }
      }
    }
    if (Date.now() - loggedAt >= 60_000) {
      loggedAt = Date.now();
      log(`[sanctions-geo] refused a request from a sanctioned region (${hit.country || "?"}${hit.region ? ` ${hit.region}` : ""}) before any payment work (${req.method} ${req.path})`);
    }
    res.status(451);
    res.setHeader("Cache-Control", "no-store");
    return res.json({ error: SANCTIONED_REGION_TEXT, reason: "unavailable_in_region", charged: false });
  };
}
