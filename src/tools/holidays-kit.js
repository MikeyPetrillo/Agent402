// Holidays kit: per-call answers computed over the holiday lists of
// src/tools/holiday-source.js (cached per country and year, at most 24 h) and
// over rule tables of our own, each cited where it is defined.
//   bank-holidays, school-holidays  one year's rows of one holiday type
//   next-holidays                   the source's upcoming-holidays read, filtered
//   long-weekends                   runs of 3+ days off, and bridge days, computed here
//   country-business-days           is a date a business day; add N; count between
//   business-day-planner            first dates that are business days in every region
//   settlement-calendar             a payment rail's settlement date for a send date
//   market-calendar                 exchange open/closed, next open and close (pure CPU,
//                                   src/tools/exchange-calendars.js)
// The holiday-source terms (cited in holiday-source.js) allow per-call answers
// and short caches and forbid a holiday portal or a republished dataset: these
// tools answer one question per call and serve no browsable listing.
import { markEndsAtCeiling } from "../run-ceiling.js";
import { attribute } from "../data-attribution.js";
import {
  bad, parseCountry, parseYear, parseSubdivision, parseTypes, parseIsoDate, parseWeekend,
  holidaysForYear, nextHolidays, appliesIn, hasAnyType, regionCalendar, yearsFor,
  toDay, fromDay, weekdayOf, DAY_NAMES, OBSERVANCE,
} from "./holiday-source.js";
import { parseExchange, exchangeStatus, daySchedule } from "./exchange-calendars.js";

const rowOut = (r) => ({ date: r.date, name: r.name, nationalHoliday: r.nationalHoliday, subdivisionCodes: r.subdivisionCodes, holidayTypes: r.holidayTypes });
const staleMark = (stale) => (stale ? { stale: true } : {});
const ruleOut = (rule) => (rule ? { id: rule, rule: OBSERVANCE[rule].rule, source: OBSERVANCE[rule].source } : null);

function parseBasis(v) {
  if (v === undefined || v === null || v === "") return "public";
  const b = String(v).trim().toLowerCase();
  if (b !== "public" && b !== "bank") throw bad('basis must be "public" or "bank"');
  return b;
}
function parseInt0(v, field, lo, hi, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${field} must be an integer from ${lo} to ${hi}`);
  return n;
}

function typeFilterTool({ slug, name, type, description, example, exampleInput, tags }) {
  return {
    route: `GET /api/${slug}`, name, slug, category: "time", price: "$0.001",
    description, tags,
    discovery: {
      input: exampleInput,
      inputSchema: {
        properties: {
          country: { type: "string", description: "ISO 3166-1 alpha-2 country code, e.g. US, AT" },
          year: { type: "integer", description: "calendar year" },
          subdivision: { type: "string", description: "optional ISO 3166-2 region (e.g. AT-9): nationwide rows plus that region's" },
        },
        required: ["country", "year"],
      },
      output: { example },
    },
    handler: async (i) => {
      const country = parseCountry(i.country);
      const year = parseYear(i.year);
      const subdivision = parseSubdivision(i.subdivision, country);
      const { rows, stale } = await holidaysForYear(country, year);
      const holidays = rows.filter((r) => r.holidayTypes.includes(type) && (!subdivision || appliesIn(r, subdivision))).map(rowOut);
      return {
        country, year, subdivision, type, count: holidays.length, holidays,
        ...(holidays.length ? {} : { note: `the source tags no ${type} days for ${subdivision || country} in ${year}` }),
        ...staleMark(stale),
      };
    },
  };
}

// ── business-day arithmetic over a region calendar ───────────────────────────
function regionClosed(cal, weekend, d) {
  if (cal.closed.has(d)) return { reason: "holiday", ...cal.closed.get(d) };
  if (weekend.includes(weekdayOf(d))) return { reason: "weekend" };
  return null;
}
async function calendarFor(country, subdivision, basis, dLo, dHi) {
  const { years, optional } = yearsFor(dLo, dHi);
  return regionCalendar(country, subdivision, basis, years, { optional });
}
const closedOut = (d, c) => ({ date: fromDay(d), reason: c.reason, ...(c.name ? { name: c.name } : {}), ...(c.observedFrom ? { observedFrom: c.observedFrom } : {}) });

// ── settlement rails ─────────────────────────────────────────────────────────
// Easter Sunday (Gregorian, anonymous algorithm) as a day number.
function easterDay(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Math.round(Date.UTC(y, month - 1, day) / 86400000);
}
// ECB, T2: "T2 is open from Monday to Friday and closed on Saturday and Sunday.
// For euro settlement, T2 is also closed on" 1 January, Good Friday, Easter
// Monday, 1 May, 25 December and 26 December.
export function t2Closed(d) {
  const iso = fromDay(d), y = +iso.slice(0, 4), md = iso.slice(5);
  const e = easterDay(y);
  if (md === "01-01") return "New Year's Day";
  if (d === e - 2) return "Good Friday";
  if (d === e + 1) return "Easter Monday";
  if (md === "05-01") return "Labour Day";
  if (md === "12-25") return "Christmas Day";
  if (md === "12-26") return "Boxing Day";
  return null;
}

const RAILS = {
  ach: {
    name: "ACH (FedACH)", region: ["US", null], basis: "bank",
    method: "Settlement days are Federal Reserve business days: Monday to Friday except the Federal Reserve holidays (the U.S. Bank-type national holidays from the holiday source, with the Federal Reserve's rule: a Saturday holiday leaves the preceding Friday open, a Sunday holiday closes the following Monday). Same-day ACH settles on the first such day on or after the send date; next-day ACH on the business day after it.",
    sources: ["https://www.frbservices.org/about/holiday-schedules", "https://www.nacha.org/"],
  },
  fedwire: {
    name: "Fedwire Funds", region: ["US", null], basis: "bank",
    method: "Real-time gross settlement on Federal Reserve business days: Monday to Friday except the Federal Reserve holidays (U.S. Bank-type national holidays, Saturday holidays not moved, Sunday holidays closing the following Monday). A payment sent on a closed day settles on the next business day.",
    sources: ["https://www.frbservices.org/about/holiday-schedules"],
  },
  "sepa-sct": {
    name: "SEPA Credit Transfer", t2: true,
    method: "Euro interbank settlement runs on T2 days: Monday to Friday except 1 January, Good Friday, Easter Monday, 1 May, 25 and 26 December (ECB). The payer's provider must credit the payee's provider by the end of the following business day (Directive (EU) 2015/2366, Article 83(1)).",
    sources: ["https://www.ecb.europa.eu/paym/target/t2/html/index.en.html", "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32015L2366"],
  },
  "sepa-instant": {
    name: "SEPA Instant Credit Transfer", always: true,
    method: "Available 24 hours a day on all calendar days of the year, with funds made available within ten seconds (EPC SCT Inst scheme; providers may announce short planned maintenance windows).",
    sources: ["https://www.europeanpaymentscouncil.eu/what-we-do/sepa-instant-credit-transfer"],
  },
  chaps: {
    name: "CHAPS", region: ["GB", "GB-ENG"], basis: "public",
    method: "The CHAPS system is open 6am to 6pm, Monday to Friday, excluding bank or public holidays in England and Wales (Bank of England); customer payments must be submitted by 5.40pm. England and Wales holidays come from the holiday source with GOV.UK's substitute-day rule for a holiday on a weekend.",
    sources: ["https://www.bankofengland.co.uk/payments/chaps", "https://www.gov.uk/bank-holidays"],
  },
};
export const RAIL_IDS = Object.keys(RAILS);
const RAIL_ALIASES = { ach: "ach", fedach: "ach", fedwire: "fedwire", wire: "fedwire", sepa: "sepa-sct", "sepa-sct": "sepa-sct", sct: "sepa-sct", "sepa-instant": "sepa-instant", "sct-inst": "sepa-instant", "sepa-inst": "sepa-instant", chaps: "chaps" };

// ── tools ────────────────────────────────────────────────────────────────────
export const HOLIDAY_TOOLS = [
  typeFilterTool({
    slug: "bank-holidays", name: "Bank holidays", type: "Bank",
    description: "Bank holidays for a country and year (optionally one region): the days the holiday dataset tags as bank holidays, with nationwide flag and the regions each applies to. About a dozen countries tag bank holidays separately; others answer an empty list with a note. ?country=US&year=2026",
    tags: ["holidays", "bank-holidays", "banking", "calendar", "country", "time"],
    exampleInput: { country: "US", year: 2026 },
    example: { country: "US", year: 2026, subdivision: null, type: "Bank", count: 11, holidays: [{ date: "2026-01-01", name: "New Year's Day", nationalHoliday: true, subdivisionCodes: null, holidayTypes: ["Public", "Bank"] }] },
  }),
  typeFilterTool({
    slug: "school-holidays", name: "School holidays", type: "School",
    description: "School holiday days for a country and year (optionally one region): the single days the holiday dataset tags as school holidays (not term breaks), with the regions each applies to. About ten countries tag them; others answer an empty list with a note. ?country=AT&year=2026",
    tags: ["holidays", "school-holidays", "education", "calendar", "country", "time"],
    exampleInput: { country: "AT", year: 2026 },
    example: { country: "AT", year: 2026, subdivision: null, type: "School", count: 5, holidays: [{ date: "2026-03-19", name: "Saint Joseph's Day", nationalHoliday: false, subdivisionCodes: ["AT-2", "AT-6", "AT-7", "AT-8"], holidayTypes: ["School"] }] },
  }),
  {
    route: "GET /api/next-holidays", name: "Next holidays", slug: "next-holidays", category: "time", price: "$0.001",
    description: "Upcoming holidays in a country over the next 365 days, soonest first, optionally narrowed to one region and to holiday types (Public, Bank, School, Authorities, Optional, Observance), with days until each. ?country=DE&subdivision=DE-BY",
    tags: ["holidays", "upcoming", "next-holiday", "calendar", "country", "time"],
    discovery: {
      input: { country: "DE", subdivision: "DE-BY", limit: 5 },
      inputSchema: {
        properties: {
          country: { type: "string", description: "ISO 3166-1 alpha-2 country code" },
          subdivision: { type: "string", description: "optional ISO 3166-2 region: nationwide holidays plus that region's" },
          types: { type: "string", description: "optional comma list of holiday types, e.g. Public or Public,Bank" },
          limit: { type: "integer", description: "most holidays to return (1-50, default 10)" },
        },
        required: ["country"],
      },
      output: { example: { country: "DE", subdivision: "DE-BY", asOf: "2026-11-18", count: 5, holidays: [{ date: "2026-12-25", name: "Christmas Day", daysUntil: 37, nationalHoliday: true, subdivisionCodes: null, holidayTypes: ["Public"] }] } },
    },
    handler: async (i) => {
      const country = parseCountry(i.country);
      const subdivision = parseSubdivision(i.subdivision, country);
      const types = parseTypes(i.types);
      const limit = parseInt0(i.limit, "limit", 1, 50, 10);
      const { rows, stale } = await nextHolidays(country);
      const asOf = new Date().toISOString().slice(0, 10);
      const t0 = toDay(asOf);
      const holidays = rows
        .filter((r) => (subdivision ? appliesIn(r, subdivision) : true) && hasAnyType(r, types) && r.date >= asOf)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, limit)
        .map((r) => ({ date: r.date, name: r.name, daysUntil: toDay(r.date) - t0, nationalHoliday: r.nationalHoliday, subdivisionCodes: r.subdivisionCodes, holidayTypes: r.holidayTypes }));
      return { country, subdivision, ...(types ? { types } : {}), asOf, count: holidays.length, holidays, ...staleMark(stale) };
    },
  },
  {
    route: "GET /api/long-weekends", name: "Long weekends", slug: "long-weekends", category: "time", price: "$0.001",
    description: "Long weekends in a country's year, computed from its public holidays: every run of 3 or more consecutive days off that includes a holiday, plus bridge days (one working day that, taken off, joins a holiday to a weekend) with the run length it makes. Region-aware. ?country=DE&year=2026",
    tags: ["holidays", "long-weekend", "bridge-day", "vacation", "calendar", "time"],
    discovery: {
      input: { country: "DE", year: 2026 },
      inputSchema: {
        properties: {
          country: { type: "string", description: "ISO 3166-1 alpha-2 country code" },
          year: { type: "integer", description: "calendar year" },
          subdivision: { type: "string", description: "optional ISO 3166-2 region whose own holidays count too" },
          minDays: { type: "integer", description: "shortest run to report (3-9, default 3)" },
          weekend: { type: "string", description: "optional weekend days, e.g. Fri,Sat (default Sat,Sun)" },
        },
        required: ["country", "year"],
      },
      output: { example: { country: "DE", year: 2026, subdivision: null, count: 4, longWeekends: [{ start: "2026-04-03", end: "2026-04-06", days: 4, holidays: ["Good Friday", "Easter Monday"] }], bridgeDays: [{ bridgeDay: "2026-01-02", start: "2026-01-01", end: "2026-01-04", days: 4, holidays: ["New Year's Day"] }, { bridgeDay: "2026-05-15", start: "2026-05-14", end: "2026-05-17", days: 4, holidays: ["Ascension Day"] }] } },
    },
    handler: async (i) => {
      const country = parseCountry(i.country);
      const year = parseYear(i.year);
      const subdivision = parseSubdivision(i.subdivision, country);
      const minDays = parseInt0(i.minDays, "minDays", 3, 9, 3);
      const weekend = parseWeekend(i.weekend);
      const lo = toDay(`${year}-01-01`), hi = toDay(`${year}-12-31`);
      const cal = await regionCalendar(country, subdivision, "public", [year], { optional: year + 1 <= 2099 ? [year + 1] : [] });
      const off = (d) => cal.closed.has(d) || weekend.includes(weekdayOf(d));
      const runs = [];
      for (let d = lo; d <= hi; d++) {
        if (!off(d) || (d > lo && off(d - 1))) continue;
        let e = d;
        while (e + 1 <= hi && off(e + 1)) e++;
        runs.push([d, e]);
      }
      const holidaysIn = (a, b) => { const n = []; for (let d = a; d <= b; d++) { const c = cal.closed.get(d); if (c && !n.includes(c.name)) n.push(c.name); } return n; };
      const longWeekends = runs.filter(([a, b]) => b - a + 1 >= minDays && holidaysIn(a, b).length)
        .map(([a, b]) => ({ start: fromDay(a), end: fromDay(b), days: b - a + 1, holidays: holidaysIn(a, b) }));
      const bridgeDays = [];
      for (let k = 0; k + 1 < runs.length; k++) {
        const [a1, b1] = runs[k], [a2, b2] = runs[k + 1];
        if (a2 - b1 !== 2) continue; // exactly one working day between
        const names = holidaysIn(a1, b2);
        if (!names.length || b2 - a1 + 1 < minDays) continue;
        bridgeDays.push({ bridgeDay: fromDay(b1 + 1), start: fromDay(a1), end: fromDay(b2), days: b2 - a1 + 1, holidays: names });
      }
      return {
        country, year, subdivision, count: longWeekends.length, longWeekends, bridgeDays,
        weekend: weekend.map((d) => DAY_NAMES[d]), observance: ruleOut(cal.rule),
        method: "Runs of consecutive days off (weekend days and public holidays) inside the year; a bridge day is the one working day between two such runs.",
        ...staleMark(cal.stale),
      };
    },
  },
  {
    route: "GET /api/country-business-days", name: "Business days by country", slug: "country-business-days", category: "time", price: "$0.002",
    description: "Holiday-aware business days for a country or region: check whether a date is a business day, add or subtract N business days, or count business days between two dates. Uses the country's public (or bank) holidays, a published observance rule where one exists (US federal, UK substitute days, Japan substitute holidays), and a weekend you can override. ?country=US&op=add&date=2026-07-02&days=1",
    tags: ["business-days", "working-days", "holidays", "settlement", "calendar", "time"],
    discovery: {
      input: { country: "US", op: "add", date: "2026-07-02", days: 1 },
      inputSchema: {
        properties: {
          country: { type: "string", description: "ISO 3166-1 alpha-2 country code" },
          subdivision: { type: "string", description: "optional ISO 3166-2 region whose own holidays also close business" },
          op: { type: "string", enum: ["check", "add", "count"], description: "check a date, add N business days, or count between from and to (default check)" },
          date: { type: "string", description: "YYYY-MM-DD for check and add" },
          days: { type: "integer", description: "business days to add (negative subtracts), -1000 to 1000" },
          from: { type: "string", description: "count: start date, counted" },
          to: { type: "string", description: "count: end date, not counted (at most 3 years after from)" },
          basis: { type: "string", enum: ["public", "bank"], description: "which holidays close business (default public; bank falls back to public where none are tagged)" },
          weekend: { type: "string", description: "optional weekend days, e.g. Fri,Sat (default Sat,Sun)" },
        },
        required: ["country"],
      },
      output: { example: { country: "US", subdivision: null, op: "add", date: "2026-07-02", days: 1, result: "2026-07-06", skipped: [{ date: "2026-07-03", reason: "holiday", name: "Independence Day", observedFrom: "2026-07-04" }, { date: "2026-07-04", reason: "holiday", name: "Independence Day" }, { date: "2026-07-05", reason: "weekend" }], basis: "public", weekend: ["Sat", "Sun"], observance: { id: "us-federal", rule: "Saturday holiday observed the preceding Friday; Sunday holiday observed the following Monday", source: "https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/" } } },
    },
    handler: async (i) => {
      const country = parseCountry(i.country);
      const subdivision = parseSubdivision(i.subdivision, country);
      const basis = parseBasis(i.basis);
      const weekend = parseWeekend(i.weekend);
      const op = i.op === undefined || i.op === null || i.op === "" ? "check" : String(i.op).trim().toLowerCase();
      if (!["check", "add", "count"].includes(op)) throw bad('op must be "check", "add" or "count"');
      if (weekend.length === 7) throw bad("weekend cannot be every day");
      const tail = (cal) => ({
        basis: cal.basisUsed, weekend: weekend.map((d) => DAY_NAMES[d]), observance: ruleOut(cal.rule),
        ...(!subdivision && cal.regional ? { note: "this country also has regional holidays; pass subdivision (ISO 3166-2) for a region's calendar - without it only nationwide holidays count" } : {}),
        ...staleMark(cal.stale),
      });
      if (op === "check") {
        const date = parseIsoDate(i.date);
        const d = toDay(date);
        const cal = await calendarFor(country, subdivision, basis, d, d);
        const c = regionClosed(cal, weekend, d);
        return { country, subdivision, op, date, weekday: DAY_NAMES[weekdayOf(d)], isBusinessDay: !c, ...(c ? { closed: closedOut(d, c) } : {}), ...tail(cal) };
      }
      if (op === "add") {
        const date = parseIsoDate(i.date);
        const days = parseInt0(i.days, "days", -1000, 1000, null);
        if (days === null) throw bad("days is required for op=add");
        const d0 = toDay(date), step = days < 0 ? -1 : 1;
        // A business day is at least one in seven days, so the walk spans at most 7x the count.
        const span = Math.abs(days) * 7 + 7;
        const cal = await calendarFor(country, subdivision, basis, Math.min(d0, d0 + step * span), Math.max(d0, d0 + step * span));
        let d = d0, left = Math.abs(days);
        const skipped = [];
        while (left > 0) {
          d += step;
          const c = regionClosed(cal, weekend, d);
          if (c) { if (skipped.length < 50) skipped.push(closedOut(d, c)); } else left--;
        }
        return { country, subdivision, op, date, days, result: fromDay(d), skipped, ...tail(cal) };
      }
      const from = parseIsoDate(i.from, "from"), to = parseIsoDate(i.to, "to");
      const a = toDay(from), b = toDay(to);
      if (Math.abs(b - a) > 1096) throw bad("from and to may be at most 3 years apart");
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const cal = await calendarFor(country, subdivision, basis, lo, hi);
      let n = 0;
      const holidaysOnWeekdays = [];
      for (let d = lo; d < hi; d++) {
        const c = regionClosed(cal, weekend, d);
        if (!c) n++;
        else if (c.reason === "holiday" && !weekend.includes(weekdayOf(d)) && holidaysOnWeekdays.length < 100) holidaysOnWeekdays.push(closedOut(d, c));
      }
      return { country, subdivision, op, from, to, businessDays: a <= b ? n : -n, calendarDays: b - a, holidaysOnWeekdays, ...tail(cal) };
    },
  },
  {
    route: "GET /api/business-day-planner", name: "Cross-border business-day planner", slug: "business-day-planner", category: "time", price: "$0.003",
    description: "First dates on or after a start date that are business days in every listed country or region at once (up to 6, e.g. US,GB-ENG,DE-BY,JP), for cross-border scheduling, settlements and meetings, with which region is closed on each skipped day. ?regions=US,GB-ENG,DE-BY&start=2026-12-25",
    tags: ["business-days", "cross-border", "scheduling", "holidays", "planner", "time"],
    discovery: {
      input: { regions: "US,GB-ENG,DE-BY", start: "2026-12-25", count: 2 },
      inputSchema: {
        properties: {
          regions: { type: "string", description: "comma list of ISO 3166-1 countries or ISO 3166-2 regions, 1 to 6" },
          start: { type: "string", description: "YYYY-MM-DD, first date considered" },
          count: { type: "integer", description: "how many common business days to return (1-10, default 1)" },
          basis: { type: "string", enum: ["public", "bank"], description: "which holidays close business (default public)" },
        },
        required: ["regions", "start"],
      },
      output: { example: { regions: ["US", "GB-ENG", "DE-BY"], start: "2026-12-25", count: 2, dates: ["2026-12-29", "2026-12-30"], skipped: [{ date: "2026-12-28", closedIn: [{ region: "GB-ENG", reason: "holiday", name: "St. Stephen's Day", observedFrom: "2026-12-26" }] }] } },
    },
    handler: async (i) => {
      const raw = (Array.isArray(i.regions) ? i.regions : String(i.regions ?? "").split(",")).map((s) => String(s ?? "").trim().toUpperCase()).filter(Boolean);
      if (!raw.length || raw.length > 6) throw bad("regions must list 1 to 6 countries or regions, e.g. US,GB-ENG,DE-BY");
      const regions = [...new Set(raw)].map((r) => {
        const country = parseCountry(r.slice(0, 2), "regions");
        return { id: r, country, subdivision: r.length > 2 ? parseSubdivision(r, country, "regions") : null };
      });
      const start = parseIsoDate(i.start, "start");
      const count = parseInt0(i.count, "count", 1, 10, 1);
      const basis = parseBasis(i.basis);
      const d0 = toDay(start), horizon = 366;
      const cals = await Promise.all(regions.map((r) => calendarFor(r.country, r.subdivision, basis, d0, d0 + horizon)));
      const weekend = [6, 0];
      const dates = [], skipped = [];
      for (let d = d0; d <= d0 + horizon && dates.length < count; d++) {
        const closedIn = [];
        regions.forEach((r, k) => { const c = regionClosed(cals[k], weekend, d); if (c) { const { date: _d, ...why } = closedOut(d, c); closedIn.push({ region: r.id, ...why }); } });
        if (!closedIn.length) dates.push(fromDay(d));
        else if (skipped.length < 60) skipped.push({ date: fromDay(d), closedIn });
      }
      return {
        regions: regions.map((r) => r.id), start, count, dates, skipped,
        basis, weekend: ["Sat", "Sun"],
        observance: Object.fromEntries(regions.map((r, k) => [r.id, ruleOut(cals[k].rule)])),
        ...staleMark(cals.some((c) => c.stale)),
      };
    },
  },
  {
    route: "GET /api/settlement-calendar", name: "Payment settlement calendar", slug: "settlement-calendar", category: "finance", price: "$0.002",
    description: "Expected settlement date for a payment sent on a given date over ACH, Fedwire, SEPA Credit Transfer, SEPA Instant or CHAPS, from each rail's published operating days and the bank holidays that close it, with the rule and its official source in the answer. ?rail=ach&date=2026-12-24",
    tags: ["settlement", "payments", "ach", "fedwire", "sepa", "chaps", "business-days", "finance"],
    discovery: {
      input: { rail: "ach", date: "2026-12-24" },
      inputSchema: {
        properties: {
          rail: { type: "string", enum: RAIL_IDS, description: "payment rail" },
          date: { type: "string", description: "send date, YYYY-MM-DD (the rail's local calendar)" },
        },
        required: ["rail", "date"],
      },
      output: { example: { rail: "ach", name: "ACH (FedACH)", sendDate: "2026-12-24", operatingDay: true, settlementDate: "2026-12-24", nextDaySettlementDate: "2026-12-28", closedDays: [{ date: "2026-12-25", reason: "holiday", name: "Christmas Day" }, { date: "2026-12-26", reason: "weekend" }, { date: "2026-12-27", reason: "weekend" }], sources: ["https://www.frbservices.org/about/holiday-schedules", "https://www.nacha.org/"] } },
    },
    handler: async (i) => {
      const key = RAIL_ALIASES[String(i.rail ?? "").trim().toLowerCase()];
      if (!key) throw bad(`rail must be one of ${RAIL_IDS.join(", ")}`);
      const rail = RAILS[key];
      const sendDate = parseIsoDate(i.date);
      const d0 = toDay(sendDate);
      const base = { rail: key, name: rail.name, sendDate };
      if (rail.always) return { ...base, operatingDay: true, settlementDate: sendDate, method: rail.method, sources: rail.sources };
      let closedAt, stale = false, observance = null;
      if (rail.t2) {
        closedAt = (d) => (weekdayOf(d) === 0 || weekdayOf(d) === 6 ? { reason: "weekend" } : t2Closed(d) ? { reason: "holiday", name: t2Closed(d) } : null);
      } else {
        const cal = await calendarFor(rail.region[0], rail.region[1], rail.basis, d0, d0 + 20);
        stale = cal.stale; observance = ruleOut(cal.rule);
        closedAt = (d) => regionClosed(cal, [6, 0], d);
      }
      const closedDays = [];
      let d = d0;
      while (closedAt(d) && d < d0 + 20) { closedDays.push(closedOut(d, closedAt(d))); d++; }
      const settle = d;
      let next = settle + 1;
      const after = [];
      while (closedAt(next) && next < settle + 20) { after.push(closedOut(next, closedAt(next))); next++; }
      const out = { ...base, operatingDay: settle === d0, settlementDate: fromDay(settle) };
      if (key === "ach") Object.assign(out, { nextDaySettlementDate: fromDay(next) });
      if (key === "sepa-sct") Object.assign(out, { latestCreditDate: fromDay(next) });
      out.closedDays = [...closedDays, ...((key === "ach" || key === "sepa-sct") ? after : [])];
      if (key === "chaps") Object.assign(out, { hours: { open: "06:00", close: "18:00", customerCutoff: "17:40", timezone: "Europe/London" } });
      return { ...out, ...(observance ? { observance } : {}), method: rail.method, sources: rail.sources, ...staleMark(stale) };
    },
  },
  {
    route: "GET /api/market-calendar", name: "Exchange trading calendar", slug: "market-calendar", category: "finance", price: "$0.001",
    description: "Is an exchange open at a given moment, and when does it next open and close: NYSE, London Stock Exchange, Xetra, JPX (Tokyo) or HKEX, from each exchange's own published holidays, early closes and session hours, with the day's sessions in local time and UTC and the closures in the next month. Calendar facts only, no market data. ?exchange=NYSE&at=2026-11-27T17:30:00Z",
    tags: ["market-hours", "trading-calendar", "exchange", "stock-market", "holidays", "finance"],
    discovery: {
      input: { exchange: "NYSE", at: "2026-11-27T17:30:00Z" },
      inputSchema: {
        properties: {
          exchange: { type: "string", enum: ["NYSE", "LSE", "XETRA", "JPX", "HKEX"], description: "exchange name or MIC (XNYS, XLON, XETR, XJPX, XHKG)" },
          at: { type: "string", description: "optional ISO 8601 instant (default now)" },
          date: { type: "string", description: "optional YYYY-MM-DD: that local day's schedule instead of an instant" },
        },
        required: ["exchange"],
      },
      output: { example: { exchange: "NYSE", at: "2026-11-27T17:30:00.000Z", localDate: "2026-11-27", localTime: "12:30", isOpen: true, today: { date: "2026-11-27", tradingDay: true, earlyClose: "13:00", sessions: [{ open: "09:30", close: "13:00", openUtc: "2026-11-27T14:30:00.000Z", closeUtc: "2026-11-27T18:00:00.000Z" }] }, nextOpen: "2026-11-30T14:30:00.000Z", nextClose: "2026-11-27T18:00:00.000Z" } },
    },
    handler: (i) => {
      const ex = parseExchange(i.exchange);
      if (i.date !== undefined && i.date !== null && i.date !== "") {
        const date = parseIsoDate(i.date);
        const day = daySchedule(ex, date);
        return { exchange: ex.id, name: ex.name, timezone: ex.timezone, ...day, ...(day.covered ? {} : { coverage: { from: ex.coverage[0], to: ex.coverage[1] } }), sources: ex.sources };
      }
      let t = Date.now();
      if (i.at !== undefined && i.at !== null && i.at !== "") {
        const s = String(i.at).trim();
        if (s.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) throw bad("at must be an ISO 8601 instant with a zone, e.g. 2026-11-27T17:30:00Z");
        t = Date.parse(s);
        if (!Number.isFinite(t)) throw bad("at is not a valid instant");
      }
      return exchangeStatus(ex, t);
    },
  },
];

for (const t of HOLIDAY_TOOLS) if (t.slug !== "market-calendar") attribute(t, "nager");

// Every upstream wait of these handlers is a safeFetch (holiday-source.js), which
// ends at a run's ceiling; market-calendar has none. A handler that gains
// another kind of wait leaves this list.
markEndsAtCeiling(HOLIDAY_TOOLS, ["bank-holidays", "school-holidays", "next-holidays", "long-weekends", "country-business-days", "business-day-planner", "settlement-calendar", "market-calendar"]);
