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
// store (src/sanctions-events.js) as a rejected transaction only when its
// payment proves its payer: the caller's `verify(req)` recovers the signer
// (an x402 exact authorization to our own payTo, inside its validity window)
// and the event names that signer, never an address the request merely
// states. A payment nothing here can verify (another rail, a forged or
// expired signature) is counted only. One event per payer and nonce, and at
// most GEO_EVENTS_PER_CLIENT_DAY per client address a day; past either, a
// count. A Tempo PUSH credential (payload type "hash") names a transfer the
// buyer already broadcast: the 451 then neither says nothing was charged nor
// carries `charged: false`, says the transfer was not claimed for the request,
// and the event names the transfer's sender as the chain shows it (the
// caller's `pushSender(req)`, a bounded receipt read), deduped on the
// transaction hash; a sender the chain does not show is a count. A refusal whose only reason is a country our own choice blocks
// rather than a sanctions program (NON_PROGRAM_COUNTRIES: Syria, whose
// program was revoked) is counted only, never recorded as a report. An event
// keeps the country or region code that is the refusal's reason (a report
// must state why), and nothing more of the location: a request that is served
// keeps no location at all, Cloudflare's other location headers (city,
// postal code, coordinates, time zone) are never read, and the log line names
// no location.
import { paymentHeaderOf } from "./payer.js";
import { provenX402Signer } from "./gateway-cache-scope.js";
import { NOT_CHARGED } from "./not-charged.js";

export const DEFAULT_SANCTIONED_COUNTRIES = Object.freeze(["CU", "IR", "KP", "SY"]);
// Countries in the block list by our own choice, not under a sanctions
// program today: a refusal from one is counted, never recorded as a report.
export const NON_PROGRAM_COUNTRIES = Object.freeze(new Set(["SY"]));
export const GEO_EVENTS_PER_CLIENT_DAY = 5;
const DAY_MS = 86_400_000;
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

/** Paths that answer from anywhere: the health probe, the legal pages and
 *  the assets those pages load (the self-hosted fonts, the logo, the icon).
 *  Never a paid route: scripts/test-sanctioned-regions.js holds every paid
 *  route class to that. */
export const SANCTIONS_EXEMPT_PATHS = Object.freeze(new Set(["/health", "/terms", "/privacy", "/dpa", "/accessibility", "/security", "/company", "/.well-known/security.txt", "/robots.txt", "/logo.svg", "/favicon.svg", "/favicon.ico", "/favicon.png"]));
// The fonts route serves one flat file name (src/server.js /fonts/:file).
const EXEMPT_PREFIX_RE = /^\/fonts\/[A-Za-z0-9._-]+\.woff2$/;
export function sanctionsExemptPath(path) {
  const p = String(path || "");
  return SANCTIONS_EXEMPT_PATHS.has(p) || EXEMPT_PREFIX_RE.test(p);
}

/** The payer a payment's own signature proves: an x402 v2 exact
 *  authorization to `payTo`, recovered (src/gateway-cache-scope.js), with
 *  its nonce; null for anything else (another rail, a forged or expired
 *  signature). Never throws. */
export async function verifiedGeoPayer(req, { payTo } = {}) {
  try {
    const header = paymentHeaderOf(req);
    if (!header || !payTo) return null;
    const payer = await provenX402Signer(header, { payTo });
    if (!payer) return null;
    let nonce = null;
    try { nonce = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"))?.payload?.authorization?.nonce ?? null; } catch { nonce = null; }
    return { payer, nonce };
  } catch { return null; }
}

export const SANCTIONED_REGION_TEXT = `This service is not available in your region. ${NOT_CHARGED}`;
// A push credential's money moved before the request arrived, so the refusal
// cannot say nothing was charged: it says what this server did with it.
export const SANCTIONED_REGION_PUSH_TEXT = "This service is not available in your region. The transfer this payment credential names was not claimed for this request.";

/** The transaction a Tempo PUSH credential (`Authorization: Payment <b64url
 *  JSON>`, payload type "hash") names, lowercased; null for anything else.
 *  Reads the credential's own words only; never throws. */
export function pushCredentialHashOf(req) {
  try {
    const auth = String(req?.headers?.authorization ?? "");
    const m = /^Payment\s+([A-Za-z0-9_\-+/=]{1,8192})$/.exec(auth.trim());
    if (!m) return null;
    const cred = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
    const p = cred?.payload;
    if (cred?.challenge?.method !== "tempo" || p?.type !== "hash") return null;
    const h = String(p.hash || "").toLowerCase();
    return /^0x[0-9a-f]{64}$/.test(h) ? h : null;
  } catch { return null; }
}

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

const counts = { refused: 0, refusedWithPayment: 0, byCountry: {}, lastAt: null, regionHeadersSeen: 0, cdnRequests: 0, eventsRecorded: 0, paymentUnverified: 0, paymentRepeat: 0, clientCapped: 0, nonProgram: 0 };

/**
 * The geo-payment event gate: resolves the event to record for a refused paid
 * request, or null (counted only). `verify(req)` resolves { payer, nonce } for
 * a payment whose signature proves its payer, else null. Dedupes per payer and
 * nonce, caps per client address per day. Exported for the tests.
 */
export function createGeoPaymentGate({ verify, perClientDay = GEO_EVENTS_PER_CLIENT_DAY, now = () => Date.now(), maxKeys = 10_000 } = {}) {
  const seen = new Map();    // `${payer}|${nonce}` -> at
  const byClient = new Map(); // client -> { day, n }
  const trim = (m) => { while (m.size > maxKeys) m.delete(m.keys().next().value); };
  return async function gate({ req, country, region }) {
    if (country && NON_PROGRAM_COUNTRIES.has(country)) { counts.nonProgram++; return null; }
    let proof = null;
    try { proof = typeof verify === "function" ? await verify(req) : null; } catch { proof = null; }
    if (!proof || typeof proof.payer !== "string" || !proof.payer) { counts.paymentUnverified++; return null; }
    const t = now();
    const key = `${proof.payer.toLowerCase()}|${String(proof.nonce ?? "")}`;
    const at = seen.get(key);
    if (at != null && t - at < DAY_MS) { counts.paymentRepeat++; return null; }
    const client = String(req?.ip || "?");
    const day = Math.floor(t / DAY_MS);
    const c = byClient.get(client);
    const n = c && c.day === day ? c.n : 0;
    if (n >= perClientDay) { counts.clientCapped++; return null; }
    byClient.delete(client); byClient.set(client, { day, n: n + 1 });
    seen.delete(key); seen.set(key, t);
    trim(seen); trim(byClient);
    counts.eventsRecorded++;
    return { payer: proof.payer, country, region };
  };
}

/** The operator view: counts by country and whether region data arrives. */
export function sanctionedRegionsView(env = process.env) {
  return {
    enabled: sanctionsGeoBlockEnabled(env),
    countries: [...sanctionedCountries(env)],
    ukraineRegions: SANCTIONED_UA_REGION_CODES.map((c) => `UA-${c}`),
    refused: counts.refused,
    refusedWithPayment: counts.refusedWithPayment,
    // Of those: recorded as a reportable event, and counted only (payment not
    // verified, a repeat of a recorded payment, past the per-client cap, or a
    // country blocked by choice rather than a program).
    eventsRecorded: counts.eventsRecorded,
    countedOnly: { unverified: counts.paymentUnverified, repeat: counts.paymentRepeat, clientCapped: counts.clientCapped, nonProgram: counts.nonProgram },
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
  counts.eventsRecorded = 0; counts.paymentUnverified = 0; counts.paymentRepeat = 0; counts.clientCapped = 0; counts.nonProgram = 0;
}

/**
 * The middleware. Mount after the CDN resolver (it sets req.viaCdn) and
 * before every payment gate, idempotency cache and async-job replay.
 * `trustedOf(req)` says whether the Cloudflare headers are Cloudflare's;
 * `verify(req)` resolves { payer, nonce } for a payment whose signature
 * proves its payer (else null); `record(event)` keeps a refused paid request
 * the gate passed, with its proven payer (best effort, never awaited).
 */
export function sanctionedRegionsMiddleware({ env = process.env, trustedOf = (req) => req.viaCdn === true, verify = null, pushSender = null, record = null, log = console.warn, gate = null, pushGate = null } = {}) {
  if (!sanctionsGeoBlockEnabled(env)) return function sanctionedRegionsOff(_req, _res, next) { next(); };
  const countries = sanctionedCountries(env);
  const passes = gate || createGeoPaymentGate({ verify });
  // A push transfer's event: the sender the chain shows, keyed on the hash.
  const pushPasses = pushGate || createGeoPaymentGate({
    verify: async (req) => {
      const hash = pushCredentialHashOf(req);
      if (!hash || typeof pushSender !== "function") return null;
      const sender = await pushSender(req);
      return typeof sender === "string" && sender ? { payer: sender, nonce: hash } : null;
    },
  });
  let loggedAt = 0;
  return function sanctionedRegions(req, res, next) {
    let trusted = false;
    try { trusted = trustedOf(req) === true; } catch { trusted = false; }
    if (trusted) {
      counts.cdnRequests++;
      if (header(req, "cf-region-code")) counts.regionHeadersSeen++;
    }
    if (sanctionsExemptPath(req.path)) return next();
    const hit = sanctionedLocationOf(req, { trusted, countries });
    if (!hit) return next();
    counts.refused++;
    const key = hit.country || "region";
    counts.byCountry[key] = (counts.byCountry[key] || 0) + 1;
    counts.lastAt = new Date().toISOString();
    const withPayment = Boolean(paymentHeaderOf(req) || req.headers?.authorization?.toString?.().startsWith?.("Payment "));
    const pushHash = withPayment ? pushCredentialHashOf(req) : null;
    if (withPayment) {
      counts.refusedWithPayment++;
      if (typeof record === "function") {
        try {
          Promise.resolve((pushHash ? pushPasses : passes)({ req, country: hit.country, region: hit.region }))
            .then((ev) => (ev ? record({ req, ...ev, ...(pushHash ? { pushHash } : {}) }) : null))
            .catch(() => {});
        } catch { /* never breaks the answer */ }
      }
    }
    if (Date.now() - loggedAt >= 60_000) {
      loggedAt = Date.now();
      log(`[sanctions-geo] refused a request from a blocked region before any payment work (${counts.refused} since start)`);
    }
    res.status(451);
    res.setHeader("Cache-Control", "no-store");
    if (pushHash) return res.json({ error: SANCTIONED_REGION_PUSH_TEXT, reason: "unavailable_in_region", transferClaimed: false });
    return res.json({ error: SANCTIONED_REGION_TEXT, reason: "unavailable_in_region", charged: false });
  };
}
