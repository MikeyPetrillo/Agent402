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
// RECORDS. Every refusal is counted in memory (operator view, by country).
// The 451 comes before any payment is verified, so a refused x402 (or any
// other) payment names no address in the sanctions events store
// (src/sanctions-events.js): it is counted in the hour's unproven-refusal
// aggregate row for its country or region (no address). The one payment this
// layer can prove is a Tempo PUSH credential (payload type "hash"): it names
// a transfer the buyer already broadcast, the 451 then neither says nothing
// was charged nor carries `charged: false`, says the transfer was not claimed
// for the request, and the event names the transfer's sender as the chain
// shows it (the caller's `pushSender(req)`, a bounded receipt read of a
// transfer to our payTo under a challenge we issued), deduped on the
// transaction hash; a sender the chain does not show is a count. A proven
// sender opens its own row only within GEO_EVENTS_PER_CLIENT_DAY new payments
// per client (an IPv6 address by its /64, an IPv4-mapped address as IPv4) a
// day and GEO_EVENTS_PER_HOUR in all; past either it is counted in the hour's
// geo-payment aggregate row for its country or region (a report, no address).
// The same transfer re-sent adds an attempt to its row. Nothing is dropped. A refusal whose only reason is a country our own choice blocks
// rather than a sanctions program (NON_PROGRAM_COUNTRIES: Syria, whose
// program was revoked) is counted only, never recorded as a report. An event
// keeps the country or region code that is the refusal's reason (a report
// must state why), and nothing more of the location: a request that is served
// keeps no location at all, Cloudflare's other location headers (city,
// postal code, coordinates, time zone) are never read, and the log line names
// no location.
import { paymentHeaderOf } from "./payer.js";
import { NOT_CHARGED } from "./not-charged.js";
import { limiterKey } from "./rate-limit.js";
import { cdnProxyEnabled, cdnOriginSecret } from "./cdn-client-ip.js";

export const DEFAULT_SANCTIONED_COUNTRIES = Object.freeze(["CU", "IR", "KP", "SY"]);
// Countries in the block list by our own choice, not under a sanctions
// program today: a refusal from one is counted, never recorded as a report.
export const NON_PROGRAM_COUNTRIES = Object.freeze(new Set(["SY"]));
export const GEO_EVENTS_PER_CLIENT_DAY = 5;
/** New proven geo-payment rows in all per hour; past it, the hour's aggregate. */
export const GEO_EVENTS_PER_HOUR = 100;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// Ukraine's ISO 3166-2 subdivisions: 43 Crimea, 40 Sevastopol, 14 Donetsk, 09 Luhansk.
export const SANCTIONED_UA_REGION_CODES = Object.freeze(["43", "40", "14", "09"]);
// The same regions by name, for a geolocation source that files them under
// another country code or spells the code differently.
const SANCTIONED_REGION_NAME_RE = /\b(crimea|krym|sevastopol|donetsk|luhansk|lugansk)\b/i;
// The ISO 3166-2 code each region name stands for, so a refusal records a code
// and never the header's own text.
const REGION_CODE_BY_NAME = Object.freeze({ crimea: "UA-43", krym: "UA-43", sevastopol: "UA-40", donetsk: "UA-14", luhansk: "UA-09", lugansk: "UA-09" });

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

/**
 * Whether the block can fire: it reads location only from a request the CDN
 * resolver proved came through Cloudflare, which needs CDN_PROXY and
 * CDN_ORIGIN_SECRET. "ok", "off" (the block is off), or "unproven" (on, with
 * no way to prove a request came through the CDN: it never refuses).
 */
export function geoBlockProvenance(env = process.env) {
  if (!sanctionsGeoBlockEnabled(env)) return "off";
  return cdnProxyEnabled(env) && cdnOriginSecret(env) ? "ok" : "unproven";
}

/**
 * The public sanctionsReport word: `due` while a report is due; otherwise
 * `attention` while the block is on and cannot fire (geoBlockProvenance
 * unproven) on an instance that takes payments (never under FREE_MODE);
 * otherwise the store's word (clear, unknown).
 */
export function sanctionsReportWord(storeWord, env = process.env) {
  if (storeWord === "due") return "due";
  if (env.FREE_MODE !== "true" && geoBlockProvenance(env) === "unproven") return "attention";
  return storeWord;
}

/** Boot: one warning when the block is on and cannot fire. Returns the provenance. */
export function warnGeoBlockProvenance({ env = process.env, log = console.warn } = {}) {
  const p = geoBlockProvenance(env);
  if (p === "unproven") log("[sanctions-geo] SANCTIONS_GEO_BLOCK is on but CDN_PROXY or CDN_ORIGIN_SECRET is unset: no request can be proven to come through the CDN, so the regional block never refuses; set both (or SANCTIONS_GEO_BLOCK=off)");
  return p;
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
 * code from the fixed list of blocked subdivisions ("UA-43"), null for a
 * whole blocked country; never a name, city or coordinate.
 * Reads the Cloudflare headers only when `trusted` is true. Pure.
 */
export function sanctionedLocationOf(req, { trusted = false, countries = sanctionedCountries() } = {}) {
  if (!trusted) return null;
  const country = header(req, "cf-ipcountry").toUpperCase();
  const regionCode = header(req, "cf-region-code").toUpperCase();
  const regionName = header(req, "cf-region");
  // A whole country: the country is the reason, so it is all that is kept.
  // A subdivision header is the caller's network to vary, and would open a
  // new row and aggregate key per value; only the fixed subdivision list
  // below keeps a region code.
  if (/^[A-Z]{2}$/.test(country) && countries.has(country)) return { country, region: null };
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

const counts = { refused: 0, refusedWithPayment: 0, byCountry: {}, lastAt: null, regionHeadersSeen: 0, cdnRequests: 0, eventsRecorded: 0, paymentUnverified: 0, paymentRepeat: 0, clientCapped: 0, hourCapped: 0, nonProgram: 0 };

/**
 * The geo-payment event gate: resolves what to record for a refused paid
 * request, or null (a country blocked by choice: counted only). `verify(req)`
 * resolves { payer, nonce } for a payment whose payer is proven (in
 * production only a Tempo push whose transfer to us the chain shows; an x402
 * payment is never verified before the 451, so it has no `verify`), else null. A proven payment resolves its event (the same payment re-sent
 * too: the store adds an attempt to its row); past the per-client day bound
 * or the hourly bound, or unproven, it resolves `{ aggregate: true, kind,
 * reason, country, region }` for the hour's aggregate row. Exported for the
 * tests.
 */
export function createGeoPaymentGate({ verify, perClientDay = GEO_EVENTS_PER_CLIENT_DAY, perHour = GEO_EVENTS_PER_HOUR, now = () => Date.now(), maxKeys = 10_000 } = {}) {
  const seen = new Map();    // `${payer}|${nonce}` -> at
  const byClient = new Map(); // client -> { day, n }
  let hour = -1, hourN = 0;
  const trim = (m) => { while (m.size > maxKeys) m.delete(m.keys().next().value); };
  const aggregate = (kind, reason, country, region) => ({ aggregate: true, kind, reason, country, region });
  return async function gate({ req, country, region }) {
    if (country && NON_PROGRAM_COUNTRIES.has(country)) { counts.nonProgram++; return null; }
    let proof = null;
    try { proof = typeof verify === "function" ? await verify(req) : null; } catch { proof = null; }
    if (!proof || typeof proof.payer !== "string" || !proof.payer) { counts.paymentUnverified++; return aggregate("unproven-refusal", "before-verify", country, region); }
    const t = now();
    const key = `${proof.payer.toLowerCase()}|${String(proof.nonce ?? "")}`;
    const event = { payer: proof.payer, country, region, ...(proof.amount != null ? { amount: String(proof.amount) } : {}), ...(proof.asset ? { asset: String(proof.asset) } : {}) };
    const at = seen.get(key);
    if (at != null && t - at < DAY_MS) { counts.paymentRepeat++; return event; }
    // One client: an IPv6 address by its /64, an IPv4-mapped one as IPv4.
    const client = limiterKey(String(req?.ip || "?"));
    const day = Math.floor(t / DAY_MS);
    const c = byClient.get(client);
    const n = c && c.day === day ? c.n : 0;
    if (n >= perClientDay) { counts.clientCapped++; return aggregate("geo-payment", "client-bound", country, region); }
    const h = Math.floor(t / HOUR_MS);
    if (h !== hour) { hour = h; hourN = 0; }
    if (hourN >= perHour) { counts.hourCapped++; return aggregate("geo-payment", "hour-bound", country, region); }
    hourN++;
    byClient.delete(client); byClient.set(client, { day, n: n + 1 });
    seen.delete(key); seen.set(key, t);
    trim(seen); trim(byClient);
    counts.eventsRecorded++;
    return event;
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
    // Of those: recorded as a row of its own; an attempt added to a row (the
    // same payment re-sent); counted in an hour's aggregate row (unverified,
    // past the per-client or the hourly bound); and counted only (a country
    // blocked by choice rather than a program).
    eventsRecorded: counts.eventsRecorded,
    repeats: counts.paymentRepeat,
    aggregated: { unverified: counts.paymentUnverified, clientBound: counts.clientCapped, hourBound: counts.hourCapped },
    countedOnly: { nonProgram: counts.nonProgram },
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
  counts.eventsRecorded = 0; counts.paymentUnverified = 0; counts.paymentRepeat = 0; counts.clientCapped = 0; counts.hourCapped = 0; counts.nonProgram = 0;
}

/**
 * The middleware. Mount after the CDN resolver (it sets req.viaCdn) and
 * before every payment gate, idempotency cache and async-job replay.
 * `trustedOf(req)` says whether the Cloudflare headers are Cloudflare's;
 * `verify(req)` resolves { payer, nonce } for a payment whose payer is
 * proven (else null; production passes none, since the 451 comes before any
 * payment is verified, and records a push through `pushSender`); `record(event)` keeps a refused paid request
 * as the gate resolved it: an event with its proven payer, or an aggregate
 * (`aggregate: true`, kind, reason; best effort, never awaited).
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
      // The reader answers the sender (a string), or the transfer as the
      // chain shows it ({ from, value, currency }): only then does the event
      // carry an amount and asset, and they are the chain's, never the
      // credential's own claim.
      const sender = await pushSender(req);
      if (typeof sender === "string") return sender ? { payer: sender, nonce: hash } : null;
      if (!sender || typeof sender.from !== "string" || !sender.from) return null;
      return { payer: sender.from, nonce: hash, amount: sender.value ?? null, asset: sender.currency ?? null };
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
