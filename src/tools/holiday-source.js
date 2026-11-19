// Holiday source: the per-(country, year) holiday lists behind public-holidays
// and the holidays kit, read from the Nager.Date v4 community API
// (https://nagerholidays.com/api/v4, spec /openapi/community-v4.json; v3 at
// date.nager.at reaches end of life 2027-01-31). Terms
// (https://date.nager.at/Legal/TermsOfService): commercial use of the web API
// requires an active sponsorship, which this service holds; the terms forbid
// operating a holiday portal or republishing the dataset, so nothing here
// stores a list beyond a short in-memory cache or serves browsable pages: each
// answer is one per-call computation over the lists it needed.
//
// Cache: one entry per (country, year) and one per (country, UTC day) for the
// upcoming-holidays read, each served without a refetch for FRESH_MS and, when
// the source fails, for at most MAX_AGE_MS (24 h) as a `stale` copy; an older
// entry is never served and is dropped. At most MAX_ENTRIES of each, oldest
// evicted. Errors are never cached. No in-flight sharing: each run's reads are
// its own, so every wait is a safeFetch that ends at the run's ceiling.
//
// Observance: the v4 lists carry each holiday on its calendar date (v3 moved
// some to the observed weekday). A business-day answer applies a published
// observance rule where one is in OBSERVANCE below, each cited by URL; any other
// country is answered from the listed dates alone and says so.
import { safeFetch } from "./fetch-guard.js";
import { ceilingPassed } from "../run-ceiling.js";

export const HOLIDAY_API = "https://nagerholidays.com/api/v4";
export const HOLIDAY_TYPES = Object.freeze(["Public", "Bank", "School", "Authorities", "Optional", "Observance"]);
// Accepted input years (the published public-holidays contract); the source
// itself serves a rolling window inside it and its refusal is passed on as a 400.
export const YEAR_MIN = 1975, YEAR_MAX = 2099;
export const FRESH_MS = 12 * 60 * 60 * 1000;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_ENTRIES = 500;
const MAX_ROWS = 200;
const DAY_MS = 86400000;

export function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// ── upstream read ────────────────────────────────────────────────────────────
async function defaultRead(url) {
  let html;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ({ html } = await safeFetch(url, { maxBytes: 1024 * 1024, ownUpstream: true }));
      break;
    } catch (e) {
      // One retry on a 5xx or a timeout; none once a run's ceiling has passed.
      if (attempt === 0 && !ceilingPassed() && (e.statusCode === 502 || e.statusCode === 504)) continue;
      throw e;
    }
  }
  if (!html || !String(html).trim()) return null; // 204: a known country with no rows
  try { return JSON.parse(html); } catch { throw bad("The holiday source returned non-JSON", 502); }
}
let read = defaultRead;
/** Tests only: replace the upstream read (url -> parsed JSON | null, or throw) and clear the caches. */
export function __setHolidayReadForTests(fn) { read = fn || defaultRead; YEAR_CACHE.clear(); NEXT_CACHE.clear(); }

// ── cache ────────────────────────────────────────────────────────────────────
const YEAR_CACHE = new Map(); // "CC:YYYY" -> { rows, fetchedAt }
const NEXT_CACHE = new Map(); // "CC:YYYY-MM-DD" -> { rows, fetchedAt }
export const __caches = { YEAR_CACHE, NEXT_CACHE };
let now = () => Date.now();
/** Tests only: a clock for cache ageing. */
export function __setNowForTests(fn) { now = fn || (() => Date.now()); }

function cacheGet(cache, key) {
  const e = cache.get(key);
  if (!e) return null;
  if (now() - e.fetchedAt >= MAX_AGE_MS) { cache.delete(key); return null; }
  return e;
}
function cachePut(cache, key, rows) {
  if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
    let oldestKey = null, oldestAt = Infinity;
    for (const [k, v] of cache) if (v.fetchedAt < oldestAt) { oldestAt = v.fetchedAt; oldestKey = k; }
    if (oldestKey !== null) cache.delete(oldestKey);
  }
  cache.set(key, { rows, fetchedAt: now() });
}

// ── input checks ─────────────────────────────────────────────────────────────
export function parseCountry(v, field = "country") {
  const c = String(v ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) throw bad(`${field} must be a 2-letter ISO 3166-1 code (e.g. US, DE, JP)`);
  return c;
}
export function parseYear(v, field = "year") {
  const y = Number(v);
  if (!Number.isInteger(y) || y < YEAR_MIN || y > YEAR_MAX) throw bad(`${field} must be an integer between ${YEAR_MIN} and ${YEAR_MAX}`);
  return y;
}
/** An ISO 3166-2 subdivision of `country` ("DE-BY"), or null when absent. */
export function parseSubdivision(v, country, field = "subdivision") {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim().toUpperCase();
  if (!/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(s)) throw bad(`${field} must be an ISO 3166-2 code such as DE-BY or US-CA`);
  if (s.slice(0, 2) !== country) throw bad(`${field} ${s} is not in country ${country}`);
  return s;
}
/** A list of holiday types (comma text or array), canonical case; null when absent. */
export function parseTypes(v, field = "types") {
  if (v === undefined || v === null || v === "") return null;
  const parts = (Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x ?? "").trim()).filter(Boolean);
  if (parts.length > HOLIDAY_TYPES.length) throw bad(`${field} lists at most ${HOLIDAY_TYPES.length} types`);
  const out = [];
  for (const p of parts) {
    const t = HOLIDAY_TYPES.find((x) => x.toLowerCase() === p.toLowerCase());
    if (!t) throw bad(`${field} must be among ${HOLIDAY_TYPES.join(", ")}`);
    if (!out.includes(t)) out.push(t);
  }
  return out.length ? out : null;
}
export function parseIsoDate(v, field = "date") {
  const s = String(v ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw bad(`${field} must be a date as YYYY-MM-DD`);
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (new Date(t).toISOString().slice(0, 10) !== s) throw bad(`${field} is not a calendar date: ${s}`);
  if (+m[1] < YEAR_MIN || +m[1] > YEAR_MAX) throw bad(`${field} must fall between ${YEAR_MIN} and ${YEAR_MAX}`);
  return s;
}

// ── rows ─────────────────────────────────────────────────────────────────────
function normalize(h) {
  if (!h || typeof h !== "object" || typeof h.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(h.date)) return null;
  const subs = Array.isArray(h.subdivisionCodes) ? h.subdivisionCodes.filter((s) => typeof s === "string").slice(0, 100) : null;
  return {
    date: h.date,
    name: typeof h.name === "string" ? h.name : null,
    nationalHoliday: h.nationalHoliday === true,
    subdivisionCodes: subs && subs.length ? subs : null,
    holidayTypes: Array.isArray(h.holidayTypes) ? h.holidayTypes.filter((t) => HOLIDAY_TYPES.includes(t)) : [],
  };
}
function rowsOf(j) {
  if (j === null) return [];
  if (!Array.isArray(j)) throw bad("The holiday source returned an unexpected shape", 502);
  return j.slice(0, MAX_ROWS).map(normalize).filter(Boolean);
}
function mapSourceError(e, country, what) {
  if (e?.upstreamStatus === 404) return bad(`no holiday data for country "${country}" - the source covers about 120 countries by ISO 3166-1 alpha-2 code`);
  if (e?.upstreamStatus === 400) return bad(`${what} is outside the years the holiday source publishes (a rolling window around the current year)`);
  return e;
}

/** The holiday rows of (country, year): { rows, fetchedAt, stale }. */
export async function holidaysForYear(country, year) {
  const key = `${country}:${year}`;
  const hit = cacheGet(YEAR_CACHE, key);
  if (hit && now() - hit.fetchedAt < FRESH_MS) return { rows: hit.rows, fetchedAt: hit.fetchedAt, stale: false };
  let rows;
  try {
    rows = rowsOf(await read(`${HOLIDAY_API}/Holidays/${country}/${year}`));
  } catch (e) {
    const mapped = mapSourceError(e, country, `year ${year}`);
    if (mapped.statusCode === 400 || !hit) throw mapped;
    console.warn(`[holidays] source failed - serving ${key} cached at ${new Date(hit.fetchedAt).toISOString()}`);
    return { rows: hit.rows, fetchedAt: hit.fetchedAt, stale: true };
  }
  cachePut(YEAR_CACHE, key, rows);
  return { rows, fetchedAt: now(), stale: false };
}

/** Upcoming holidays (next 365 days) of `country`: { rows, fetchedAt, stale }. */
export async function nextHolidays(country) {
  const key = `${country}:${new Date(now()).toISOString().slice(0, 10)}`;
  const hit = cacheGet(NEXT_CACHE, key);
  if (hit && now() - hit.fetchedAt < FRESH_MS) return { rows: hit.rows, fetchedAt: hit.fetchedAt, stale: false };
  let rows;
  try {
    rows = rowsOf(await read(`${HOLIDAY_API}/Holidays/${country}/Next`));
  } catch (e) {
    const mapped = mapSourceError(e, country, "the request");
    if (mapped.statusCode === 400 || !hit) throw mapped;
    return { rows: hit.rows, fetchedAt: hit.fetchedAt, stale: true };
  }
  cachePut(NEXT_CACHE, key, rows);
  return { rows, fetchedAt: now(), stale: false };
}

/** True when `row` applies in the region: nationwide, or listed for `subdivision`. */
export function appliesIn(row, subdivision) {
  if (row.nationalHoliday) return true;
  return !!subdivision && Array.isArray(row.subdivisionCodes) && row.subdivisionCodes.includes(subdivision);
}
export const hasAnyType = (row, types) => !types || row.holidayTypes.some((t) => types.includes(t));

// ── dates ────────────────────────────────────────────────────────────────────
export const toDay = (iso) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY_MS);
export const fromDay = (d) => new Date(d * DAY_MS).toISOString().slice(0, 10);
export const weekdayOf = (d) => new Date(d * DAY_MS).getUTCDay(); // 0 Sun .. 6 Sat
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A weekend as weekday numbers from "Sat,Sun"-style text; default Saturday and Sunday. */
export function parseWeekend(v, field = "weekend") {
  if (v === undefined || v === null || v === "") return [6, 0];
  const parts = (Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x ?? "").trim().slice(0, 3).toLowerCase()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const i = DAY_NAMES.findIndex((n) => n.toLowerCase() === p);
    if (i < 0) throw bad(`${field} lists weekday names such as Fri,Sat or Sat,Sun`);
    if (!out.includes(i)) out.push(i);
  }
  if (out.length > 3) throw bad(`${field} names at most three days`);
  return out;
}

// ── observance rules (each a published rule, cited) ──────────────────────────
export const OBSERVANCE = Object.freeze({
  // U.S. Office of Personnel Management, federal holidays: a Saturday holiday is
  // observed the preceding Friday, a Sunday holiday the following Monday
  // (5 U.S.C. 6103(b); Executive Order 11582).
  "us-federal": { source: "https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/", rule: "Saturday holiday observed the preceding Friday; Sunday holiday observed the following Monday" },
  // Federal Reserve Banks' holiday schedule: "For holidays falling on Saturday,
  // Federal Reserve Banks and Branches will be open the preceding Friday. For
  // holidays falling on Sunday, ... closed the following Monday."
  "us-fed": { source: "https://www.frbservices.org/about/holiday-schedules", rule: "Saturday holiday: open the preceding Friday; Sunday holiday: closed the following Monday" },
  // GOV.UK bank holidays: "If a bank holiday is on a weekend, a 'substitute'
  // weekday becomes a bank holiday, normally the following Monday."
  "gb-substitute": { source: "https://www.gov.uk/bank-holidays", rule: "a weekend bank holiday is replaced by the next weekday that is not already a holiday" },
  // Japan, Act on National Holidays as applied by JPX's published calendar:
  // "National holidays that fall on a Sunday are observed on the closest
  // following day that is not a national holiday", and a day between two
  // national holidays is a holiday (Article 3, paragraph 3).
  "jp-substitute": { source: "https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html", rule: "a Sunday national holiday moves to the next day that is not a national holiday; a weekday between two national holidays is a holiday" },
});
/** The observance rule a country's business days use under `basis`, or null. */
export function observanceFor(country, basis) {
  if (country === "US") return basis === "bank" ? "us-fed" : "us-federal";
  if (country === "GB") return "gb-substitute";
  if (country === "JP") return "jp-substitute";
  return null;
}

/** Map of day number -> { name, observedFrom|null } for the listed holidays
 *  `list` ({date,name}) after `rule`. Weekend days for the substitute rules are
 *  Saturday and Sunday, as those rules are written. */
export function applyObservance(list, rule) {
  const out = new Map();
  const listed = new Set(list.map((h) => toDay(h.date)));
  const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
  for (const h of sorted) {
    const d = toDay(h.date), wd = weekdayOf(d);
    if (rule === "us-federal" && (wd === 6 || wd === 0)) {
      out.set(d, { name: h.name, observedFrom: null });
      out.set(wd === 6 ? d - 1 : d + 1, { name: h.name, observedFrom: h.date });
    } else if (rule === "us-fed" && wd === 0) {
      out.set(d, { name: h.name, observedFrom: null });
      out.set(d + 1, { name: h.name, observedFrom: h.date });
    } else if (rule === "gb-substitute" && (wd === 6 || wd === 0)) {
      out.set(d, { name: h.name, observedFrom: null });
      let s = d + 1;
      while (weekdayOf(s) === 6 || weekdayOf(s) === 0 || listed.has(s) || out.has(s)) s++;
      out.set(s, { name: h.name, observedFrom: h.date });
    } else if (rule === "jp-substitute" && wd === 0) {
      out.set(d, { name: h.name, observedFrom: null });
      let s = d + 1;
      while (listed.has(s) || out.has(s)) s++;
      out.set(s, { name: h.name, observedFrom: h.date });
    } else if (!out.has(d)) {
      out.set(d, { name: h.name, observedFrom: null });
    }
  }
  if (rule === "jp-substitute") {
    for (const d of listed) {
      const mid = d + 1;
      if (listed.has(mid + 1) && !listed.has(mid) && !out.has(mid) && weekdayOf(mid) !== 0) {
        out.set(mid, { name: "National holiday (between two national holidays)", observedFrom: null });
      }
    }
  }
  return out;
}

/** A business-day calendar for a region over `years`: { closed, rule, rows, stale }.
 *  `basis` "public" uses Public holidays; "bank" uses Bank holidays and falls back
 *  to Public when the country tags none (`basisUsed` says which). */
export async function regionCalendar(country, subdivision, basis, years, { optional = [] } = {}) {
  const want = [...years, ...optional.filter((y) => !years.includes(y))];
  const reads = await Promise.all(want.map((y) => holidaysForYear(country, y).catch((e) => {
    // An optional year is read only so an observed date can move into range;
    // the source's window refusal there is not an error.
    if (optional.includes(y) && !years.includes(y) && e.statusCode === 400) return { rows: [], stale: false };
    throw e;
  })));
  const all = reads.flatMap((r) => r.rows).filter((r) => appliesIn(r, subdivision));
  let basisUsed = basis;
  let list = all.filter((r) => r.holidayTypes.includes(basis === "bank" ? "Bank" : "Public"));
  if (basis === "bank" && !all.some((r) => r.holidayTypes.includes("Bank"))) {
    basisUsed = "public";
    list = all.filter((r) => r.holidayTypes.includes("Public"));
  }
  const rule = observanceFor(country, basisUsed);
  // A rule written for nationwide holidays applies to nationwide rows; a
  // regional row stands on its own date, except the GOV.UK rule, which is
  // written for every UK nation's bank holidays.
  const ruled = rule && rule !== "gb-substitute" ? list.filter((r) => r.nationalHoliday) : list;
  const plain = rule && rule !== "gb-substitute" ? list.filter((r) => !r.nationalHoliday) : [];
  const closed = applyObservance(ruled, rule);
  for (const r of plain) { const d = toDay(r.date); if (!closed.has(d)) closed.set(d, { name: r.name, observedFrom: null }); }
  const regional = reads.some((r) => r.rows.some((x) => !x.nationalHoliday && x.holidayTypes.includes(basisUsed === "bank" ? "Bank" : "Public")));
  return { closed, rule, basisUsed, regional, stale: reads.some((r) => r.stale) };
}

/** The calendar years a span of day numbers touches ({ years }), and the next
 *  one as `optional` (a holiday there can be observed back inside the span). */
export function yearsFor(dLo, dHi) {
  const y0 = +fromDay(dLo).slice(0, 4), y1 = +fromDay(dHi).slice(0, 4);
  const years = [];
  for (let y = y0; y <= y1; y++) years.push(y);
  return { years, optional: y1 + 1 <= YEAR_MAX ? [y1 + 1] : [] };
}
