// Exchange trading calendars: each exchange's own published holiday list and
// session hours, typed in from the page cited beside it (public facts, no
// market data). Pure CPU: no egress. A date outside an exchange's published
// coverage is answered as not covered, never guessed from a rule.
//
// Sources (read 2026-11-18):
//   NYSE  https://www.nyse.com/markets/hours-calendars (holidays 2026-2028,
//         1:00 p.m. ET early closes; core trading 9:30 a.m. to 4:00 p.m. ET)
//   LSE   https://www.londonstockexchange.com/equities-trading/business-days
//         (non-trading and half days from 2026-08-31; "closing process
//         commences from 12:30"), hours from the Millennium Exchange business
//         parameters linked there (SETS: continuous trading 08:00 to the 16:30
//         closing auction call, uncrossing 16:35)
//   Xetra https://www.cashmarket.deutsche-boerse.com/cash-en/trading/trading-calendar-and-trading-hours
//         (closing days 2026-2032, "for information purposes only. Changes for
//         future years are not excluded"; trading 9:00 to 17:30 CET)
//   JPX   https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html
//         (market holidays 2026-2027) and
//         https://www.jpx.co.jp/english/equities/trading/domestic/01.html
//         (morning 9:00-11:30, afternoon 12:30-15:30)
//   HKEX  https://www.hkex.com.hk/Services/Trading-hours-and-Severe-Weather-Arrangements/Trading-Hours/Securities-Market?sc_lang=en
//         ("Monday to Friday (excluding public holidays)"; full day 9:30 a.m.
//         to 4:00 p.m. through the extended morning session; half day 9:30 a.m.
//         to 12:00 noon on "the eves of Christmas, New Year and Lunar New
//         Year"), with Hong Kong's gazetted general holidays from
//         https://www.gov.hk/en/about/abouthk/holiday/2026.htm and /2027.htm
import { bad } from "./holiday-source.js";

const DAY_MS = 86400000;

const NYSE_CLOSED = {
  "2026-01-01": "New Year's Day", "2026-01-19": "Martin Luther King, Jr. Day", "2026-02-16": "Washington's Birthday",
  "2026-04-03": "Good Friday", "2026-05-25": "Memorial Day", "2026-06-19": "Juneteenth National Independence Day",
  "2026-07-03": "Independence Day (observed)", "2026-09-07": "Labor Day", "2026-11-26": "Thanksgiving Day", "2026-12-25": "Christmas Day",
  "2027-01-01": "New Year's Day", "2027-01-18": "Martin Luther King, Jr. Day", "2027-02-15": "Washington's Birthday",
  "2027-03-26": "Good Friday", "2027-05-31": "Memorial Day", "2027-06-18": "Juneteenth National Independence Day (observed)",
  "2027-07-05": "Independence Day (observed)", "2027-09-06": "Labor Day", "2027-11-25": "Thanksgiving Day", "2027-12-24": "Christmas Day (observed)",
  "2028-01-17": "Martin Luther King, Jr. Day", "2028-02-21": "Washington's Birthday", "2028-04-14": "Good Friday",
  "2028-05-29": "Memorial Day", "2028-06-19": "Juneteenth National Independence Day", "2028-07-04": "Independence Day",
  "2028-09-04": "Labor Day", "2028-11-23": "Thanksgiving Day", "2028-12-25": "Christmas Day",
};
const NYSE_EARLY = Object.fromEntries(["2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24"].map((d) => [d, "13:00"]));

const LSE_CLOSED = {
  "2026-08-31": "Summer Bank Holiday", "2026-12-25": "Christmas Day", "2026-12-28": "Boxing Day (substitute)",
  "2027-01-01": "New Year's Day", "2027-03-26": "Good Friday", "2027-03-29": "Easter Monday", "2027-05-03": "Early May Bank Holiday",
  "2027-05-31": "Spring Bank Holiday", "2027-08-30": "Summer Bank Holiday", "2027-12-27": "Christmas Day (substitute)", "2027-12-28": "Boxing Day (substitute)",
  "2028-01-03": "New Year's Day (substitute)", "2028-04-14": "Good Friday", "2028-04-17": "Easter Monday", "2028-05-01": "Early May Bank Holiday",
  "2028-05-29": "Spring Bank Holiday", "2028-08-28": "Summer Bank Holiday", "2028-12-25": "Christmas Day",
  "2028-12-26": "Boxing Day (listed by the exchange as to be confirmed)",
};
const LSE_EARLY = Object.fromEntries(["2026-12-24", "2026-12-31", "2027-12-24", "2027-12-31", "2028-12-22", "2028-12-29"].map((d) => [d, "12:30"]));

const XETRA_CLOSED = {};
for (const [d, n] of [
  ["2026-01-01", "New Year's Day"], ["2026-04-03", "Good Friday"], ["2026-04-06", "Easter Monday"], ["2026-05-01", "Labor Day"],
  ["2026-12-24", "Christmas Eve"], ["2026-12-25", "Christmas Day"], ["2026-12-31", "New Year's Eve"],
  ["2027-01-01", "New Year's Day"], ["2027-03-26", "Good Friday"], ["2027-03-29", "Easter Monday"], ["2027-12-24", "Christmas Eve"], ["2027-12-31", "New Year's Eve"],
  ["2028-04-14", "Good Friday"], ["2028-04-17", "Easter Monday"], ["2028-05-01", "Labor Day"], ["2028-12-25", "Christmas Day"], ["2028-12-26", "Boxing Day"],
  ["2029-01-01", "New Year's Day"], ["2029-03-30", "Good Friday"], ["2029-04-02", "Easter Monday"], ["2029-05-01", "Labor Day"],
  ["2029-12-24", "Christmas Eve"], ["2029-12-25", "Christmas Day"], ["2029-12-26", "Boxing Day"], ["2029-12-31", "New Year's Eve"],
  ["2030-01-01", "New Year's Day"], ["2030-04-19", "Good Friday"], ["2030-04-22", "Easter Monday"], ["2030-05-01", "Labor Day"],
  ["2030-12-24", "Christmas Eve"], ["2030-12-25", "Christmas Day"], ["2030-12-26", "Boxing Day"], ["2030-12-31", "New Year's Eve"],
  ["2031-01-01", "New Year's Day"], ["2031-04-11", "Good Friday"], ["2031-04-14", "Easter Monday"], ["2031-05-01", "Labor Day"],
  ["2031-12-24", "Christmas Eve"], ["2031-12-25", "Christmas Day"], ["2031-12-26", "Boxing Day"], ["2031-12-31", "New Year's Eve"],
  ["2032-01-01", "New Year's Day"], ["2032-03-26", "Good Friday"], ["2032-03-29", "Easter Monday"], ["2032-12-24", "Christmas Eve"], ["2032-12-31", "New Year's Eve"],
]) XETRA_CLOSED[d] = n;

const JPX_CLOSED = {
  "2026-01-01": "New Year's Day", "2026-01-02": "Market Holiday", "2026-01-12": "Coming of Age Day", "2026-02-11": "National Foundation Day",
  "2026-02-23": "Emperor's Birthday", "2026-03-20": "Vernal Equinox", "2026-04-29": "Showa Day", "2026-05-04": "Greenery Day",
  "2026-05-05": "Children's Day", "2026-05-06": "Constitution Memorial Day (May 3) observed", "2026-07-20": "Marine Day",
  "2026-08-11": "Mountain Day", "2026-09-21": "Respect for the Aged Day", "2026-09-22": "Holiday (Act on National Holidays, Article 3, paragraph 3)",
  "2026-09-23": "Autumnal Equinox", "2026-10-12": "Sports Day", "2026-11-03": "Culture Day", "2026-11-23": "Labor Thanksgiving Day", "2026-12-31": "Market Holiday",
  "2027-01-01": "New Year's Day", "2027-01-11": "Coming of Age Day", "2027-02-11": "National Foundation Day", "2027-02-23": "Emperor's Birthday",
  "2027-03-22": "Vernal Equinox (Mar. 21) observed", "2027-04-29": "Showa Day", "2027-05-03": "Constitution Memorial Day", "2027-05-04": "Greenery Day",
  "2027-05-05": "Children's Day", "2027-07-19": "Marine Day", "2027-08-11": "Mountain Day", "2027-09-20": "Respect for the Aged Day",
  "2027-09-23": "Autumnal Equinox", "2027-10-11": "Sports Day", "2027-11-03": "Culture Day", "2027-11-23": "Labor Thanksgiving Day", "2027-12-31": "Market Holiday",
};

const HKEX_CLOSED = {
  "2026-01-01": "The first day of January", "2026-02-17": "Lunar New Year's Day", "2026-02-18": "The second day of Lunar New Year",
  "2026-02-19": "The third day of Lunar New Year", "2026-04-03": "Good Friday", "2026-04-06": "The day following Ching Ming Festival",
  "2026-04-07": "The day following Easter Monday", "2026-05-01": "Labour Day", "2026-05-25": "The day following the Birthday of the Buddha",
  "2026-06-19": "Tuen Ng Festival", "2026-07-01": "Hong Kong Special Administrative Region Establishment Day", "2026-10-01": "National Day",
  "2026-10-19": "The day following Chung Yeung Festival", "2026-12-25": "Christmas Day",
  "2027-01-01": "The first day of January", "2027-02-08": "The third day of Lunar New Year", "2027-02-09": "The fourth day of Lunar New Year",
  "2027-03-26": "Good Friday", "2027-03-29": "Easter Monday", "2027-04-05": "Ching Ming Festival", "2027-05-13": "The Birthday of the Buddha",
  "2027-06-09": "Tuen Ng Festival", "2027-07-01": "Hong Kong Special Administrative Region Establishment Day",
  "2027-09-16": "The day following the Chinese Mid-Autumn Festival", "2027-10-01": "National Day", "2027-10-08": "Chung Yeung Festival",
  "2027-12-27": "The first weekday after Christmas Day",
};
// Eves of Christmas, New Year and Lunar New Year that are trading days
// (Lunar New Year's Day: 2026-02-17, 2027-02-06).
const HKEX_EARLY = Object.fromEntries(["2026-02-16", "2026-12-24", "2026-12-31", "2027-02-05", "2027-12-24", "2027-12-31"].map((d) => [d, "12:00"]));

export const EXCHANGES = Object.freeze({
  NYSE: {
    id: "NYSE", name: "New York Stock Exchange", mic: "XNYS", timezone: "America/New_York",
    coverage: ["2026-01-01", "2028-12-31"], sessions: [["09:30", "16:00"]], closed: NYSE_CLOSED, early: NYSE_EARLY,
    sources: ["https://www.nyse.com/markets/hours-calendars"],
    notes: "Core trading session; early closes at 1:00 p.m. ET as published.",
  },
  LSE: {
    id: "LSE", name: "London Stock Exchange", mic: "XLON", timezone: "Europe/London",
    coverage: ["2026-08-31", "2028-12-31"], sessions: [["08:00", "16:30"]], closed: LSE_CLOSED, early: LSE_EARLY,
    sources: ["https://www.londonstockexchange.com/equities-trading/business-days"],
    notes: "SETS continuous trading; the closing auction call runs 16:30 to 16:35. On a half day the closing process starts at 12:30.",
  },
  XETRA: {
    id: "XETRA", name: "Deutsche Boerse Xetra", mic: "XETR", timezone: "Europe/Berlin",
    coverage: ["2026-01-01", "2032-12-31"], sessions: [["09:00", "17:30"]], closed: XETRA_CLOSED, early: {}, provisionalAfter: "2027-12-31",
    sources: ["https://www.cashmarket.deutsche-boerse.com/cash-en/trading/trading-calendar-and-trading-hours"],
    notes: "The exchange publishes its later years for information only; the last trading day of a year can have deviating hours announced by circular.",
  },
  JPX: {
    id: "JPX", name: "Japan Exchange Group (Tokyo Stock Exchange)", mic: "XJPX", timezone: "Asia/Tokyo",
    coverage: ["2026-01-01", "2027-12-31"], sessions: [["09:00", "11:30"], ["12:30", "15:30"]], closed: JPX_CLOSED, early: {},
    sources: ["https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html", "https://www.jpx.co.jp/english/equities/trading/domestic/01.html"],
    notes: "Cash equity auction sessions with a lunch break.",
  },
  HKEX: {
    id: "HKEX", name: "Hong Kong Exchanges and Clearing (securities market)", mic: "XHKG", timezone: "Asia/Hong_Kong",
    coverage: ["2026-01-01", "2027-12-31"], sessions: [["09:30", "16:00"]], closed: HKEX_CLOSED, early: HKEX_EARLY,
    sources: ["https://www.hkex.com.hk/Services/Trading-hours-and-Severe-Weather-Arrangements/Trading-Hours/Securities-Market?sc_lang=en", "https://www.gov.hk/en/about/abouthk/holiday/2026.htm", "https://www.gov.hk/en/about/abouthk/holiday/2027.htm"],
    notes: "Continuous trading through the extended morning session; half days end at 12:00 noon. Severe weather arrangements can change a day; they are not predicted here.",
  },
});
const ALIASES = { NYSE: "NYSE", XNYS: "NYSE", LSE: "LSE", XLON: "LSE", LONDON: "LSE", XETRA: "XETRA", XETR: "XETRA", FWB: "XETRA", JPX: "JPX", TSE: "JPX", XJPX: "JPX", XTKS: "JPX", TOKYO: "JPX", HKEX: "HKEX", XHKG: "HKEX", SEHK: "HKEX" };

export function parseExchange(v) {
  const k = String(v ?? "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  const id = ALIASES[k];
  if (!id) throw bad(`exchange must be one of ${Object.keys(EXCHANGES).join(", ")} (or its MIC)`);
  return EXCHANGES[id];
}

// ── time zones ───────────────────────────────────────────────────────────────
const FORMATTERS = new Map();
function partsAt(tz, t) {
  let f = FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    FORMATTERS.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).filter((x) => x.type !== "literal").map((x) => [x.type, +x.value]));
  return p;
}
const offsetAt = (tz, t) => { const p = partsAt(tz, t); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000; };
/** The instant of wall-clock `hhmm` on `iso` in `tz`. */
export function zonedInstant(iso, hhmm, tz) {
  const guess = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), +hhmm.slice(0, 2), +hhmm.slice(3, 5));
  const t1 = guess - offsetAt(tz, guess);
  return guess - offsetAt(tz, t1);
}
/** Local date (YYYY-MM-DD) and time (HH:MM) of instant `t` in `tz`. */
export function localOf(t, tz) {
  const p = partsAt(tz, t);
  const pad = (n) => String(n).padStart(2, "0");
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}
const addDays = (iso, n) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) + n * DAY_MS).toISOString().slice(0, 10);

/** One local day's schedule at exchange `ex`. */
export function daySchedule(ex, iso) {
  if (iso < ex.coverage[0] || iso > ex.coverage[1]) return { date: iso, covered: false };
  const wd = new Date(iso + "T00:00:00Z").getUTCDay();
  const base = { date: iso, covered: true, ...(ex.provisionalAfter && iso > ex.provisionalAfter ? { provisional: true } : {}) };
  if (wd === 0 || wd === 6) return { ...base, tradingDay: false, reason: "weekend", sessions: [] };
  if (ex.closed[iso]) return { ...base, tradingDay: false, reason: "holiday", holiday: ex.closed[iso], sessions: [] };
  const early = ex.early[iso] || null;
  const sessions = [];
  for (const [a, b] of ex.sessions) {
    if (early && a >= early) break;
    sessions.push([a, early && b > early ? early : b]);
  }
  return { ...base, tradingDay: true, earlyClose: early, sessions: sessions.map(([open, close]) => ({ open, close, openUtc: new Date(zonedInstant(iso, open, ex.timezone)).toISOString(), closeUtc: new Date(zonedInstant(iso, close, ex.timezone)).toISOString() })) };
}

/** Status of `ex` at instant `t`: open now, today's schedule, next open and close, closures ahead. */
export function exchangeStatus(ex, t) {
  const local = localOf(t, ex.timezone);
  const today = daySchedule(ex, local.date);
  let isOpen = false, nextOpen = null, nextClose = null, current = null;
  let coveredAhead = true;
  for (let i = 0; i <= 20 && (!nextOpen || !nextClose); i++) {
    const day = daySchedule(ex, addDays(local.date, i));
    if (!day.covered) { coveredAhead = false; break; }
    for (const s of day.sessions || []) {
      const o = Date.parse(s.openUtc), c = Date.parse(s.closeUtc);
      if (o <= t && t < c) { isOpen = true; current = s; }
      if (!nextOpen && o > t) nextOpen = s.openUtc;
      if (!nextClose && c > t) nextClose = s.closeUtc;
    }
  }
  const upcoming = [];
  for (let i = 1; i <= 31 && upcoming.length < 10; i++) {
    const day = daySchedule(ex, addDays(local.date, i));
    if (!day.covered) break;
    if (day.reason === "holiday") upcoming.push({ date: day.date, closed: true, holiday: day.holiday });
    else if (day.earlyClose) upcoming.push({ date: day.date, closed: false, earlyClose: day.earlyClose });
  }
  return {
    exchange: ex.id, name: ex.name, mic: ex.mic, timezone: ex.timezone,
    at: new Date(t).toISOString(), localDate: local.date, localTime: local.time,
    covered: today.covered, isOpen, ...(current ? { currentSession: current } : {}),
    today, nextOpen, nextClose,
    ...(coveredAhead ? {} : { coverageNote: `the exchange's published calendar used here runs ${ex.coverage[0]} to ${ex.coverage[1]}; dates past it are not answered` }),
    upcoming, coverage: { from: ex.coverage[0], to: ex.coverage[1] },
    method: `${ex.notes} Holidays and hours from the exchange's own published calendar; times in ${ex.timezone}.`,
    sources: ex.sources,
  };
}
