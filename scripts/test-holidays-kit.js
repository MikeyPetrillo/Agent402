#!/usr/bin/env node
// Holidays kit and the public-holidays migration, offline: the holiday source is
// replaced by fixture rows in the v4 shape (a few countries' 2026-2028 lists), so
// every assertion is on our own code. Covers the public-holidays contract (the
// v3 fields kept, the v4 fields added, filters, the source's refusals), the
// cache bounds (fresh window, 24 h ceiling on a stale copy, entry cap), the
// business-day math on published calendars (OPM, the Federal Reserve's holiday
// schedule, GOV.UK substitute days, JPX's 2026-2027 list), long weekends,
// the cross-border planner, the settlement rails and the exchange calendars.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { HOLIDAY_TOOLS, t2Closed } from "../src/tools/holidays-kit.js";
import { DATA_TOOLS } from "../src/tools/data-kit.js";
import { __setHolidayReadForTests, __setNowForTests, __caches, MAX_ENTRIES, FRESH_MS, MAX_AGE_MS, toDay, HOLIDAY_API, V3_API, observedDates } from "../src/tools/holiday-source.js";
import { EXCHANGES, daySchedule } from "../src/tools/exchange-calendars.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";
import { KIT2 } from "../src/tools/kit2.js";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { upstreamHostsForSlug, declaresUpstreamHosts, requestMatchesDefinition } from "./lib/upstream-outage.js";
import * as holidaySource from "../src/tools/holiday-source.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? "" : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`);

// [MM-DD, name, subdivisions ("" = nationwide), types]
const FIXTURE = {
  "US:2026": [
    ["01-01", "New Year's Day", "", "Public/Bank"],
    ["01-19", "Martin Luther King, Jr. Day", "", "Public/Bank"],
    ["02-12", "Lincoln's Birthday", "US-CA,US-CT,US-IL,US-IN,US-KY,US-MI,US-NY,US-MO,US-OH", "Observance"],
    ["02-16", "Presidents Day", "", "Public/Bank"],
    ["04-03", "Good Friday", "US-CT,US-DE,US-HI,US-IN,US-KY,US-LA,US-NC,US-ND,US-NJ,US-TN", "Public"],
    ["04-03", "Good Friday", "US-TX", "Optional"],
    ["05-08", "Truman Day", "US-MO", "School/Authorities"],
    ["05-25", "Memorial Day", "", "Public/Bank"],
    ["06-19", "Juneteenth National Independence Day", "", "Public/Bank"],
    ["07-04", "Independence Day", "", "Public/Bank"],
    ["09-07", "Labour Day", "", "Public/Bank"],
    ["10-12", "Columbus Day", "US-AL,US-AZ,US-CO,US-CT,US-GA,US-ID,US-IL,US-IN,US-IA,US-KS,US-KY,US-LA,US-ME,US-MD,US-MA,US-MS,US-MO,US-MT,US-NE,US-NH,US-NJ,US-NM,US-NY,US-NC,US-OH,US-OK,US-PA,US-RI,US-SC,US-TN,US-UT,US-VA,US-WV", "Public"],
    ["10-12", "Columbus Day", "", "Bank"],
    ["10-12", "Indigenous Peoples' Day", "US-AK,US-AL,US-CA,US-HI,US-IA,US-LA,US-ME,US-MI,US-MN,US-NC,US-NE,US-NM,US-OK,US-OR,US-SD,US-TX,US-VA,US-VT,US-WI", "Public"],
    ["11-11", "Veterans Day", "", "Public/Bank"],
    ["11-26", "Thanksgiving Day", "", "Public/Bank"],
    ["12-25", "Christmas Day", "", "Public/Bank"],
  ],
  "US:2027": [
    ["01-01", "New Year's Day", "", "Public/Bank"],
    ["01-18", "Martin Luther King, Jr. Day", "", "Public/Bank"],
    ["02-12", "Lincoln's Birthday", "US-CA,US-CT,US-IL,US-IN,US-KY,US-MI,US-NY,US-MO,US-OH", "Observance"],
    ["02-15", "Presidents Day", "", "Public/Bank"],
    ["03-26", "Good Friday", "US-CT,US-DE,US-HI,US-IN,US-KY,US-LA,US-NC,US-ND,US-NJ,US-TN", "Public"],
    ["03-26", "Good Friday", "US-TX", "Optional"],
    ["05-08", "Truman Day", "US-MO", "School/Authorities"],
    ["05-31", "Memorial Day", "", "Public/Bank"],
    ["06-19", "Juneteenth National Independence Day", "", "Public/Bank"],
    ["07-04", "Independence Day", "", "Public/Bank"],
    ["09-06", "Labour Day", "", "Public/Bank"],
    ["10-11", "Columbus Day", "US-AL,US-AZ,US-CO,US-CT,US-GA,US-ID,US-IL,US-IN,US-IA,US-KS,US-KY,US-LA,US-ME,US-MD,US-MA,US-MS,US-MO,US-MT,US-NE,US-NH,US-NJ,US-NM,US-NY,US-NC,US-OH,US-OK,US-PA,US-RI,US-SC,US-TN,US-UT,US-VA,US-WV", "Public"],
    ["10-11", "Columbus Day", "", "Bank"],
    ["10-11", "Indigenous Peoples' Day", "US-AK,US-AL,US-CA,US-HI,US-IA,US-LA,US-ME,US-MI,US-MN,US-NC,US-NE,US-NM,US-OK,US-OR,US-SD,US-TX,US-VA,US-VT,US-WI", "Public"],
    ["11-11", "Veterans Day", "", "Public/Bank"],
    ["11-25", "Thanksgiving Day", "", "Public/Bank"],
    ["12-25", "Christmas Day", "", "Public/Bank"],
  ],
  "US:2028": [
    ["01-01", "New Year's Day", "", "Public/Bank"],
    ["01-17", "Martin Luther King, Jr. Day", "", "Public/Bank"],
    ["02-12", "Lincoln's Birthday", "US-CA,US-CT,US-IL,US-IN,US-KY,US-MI,US-NY,US-MO,US-OH", "Observance"],
    ["02-21", "Presidents Day", "", "Public/Bank"],
    ["04-14", "Good Friday", "US-CT,US-DE,US-HI,US-IN,US-KY,US-LA,US-NC,US-ND,US-NJ,US-TN", "Public"],
    ["04-14", "Good Friday", "US-TX", "Optional"],
    ["05-08", "Truman Day", "US-MO", "School/Authorities"],
    ["05-29", "Memorial Day", "", "Public/Bank"],
    ["06-19", "Juneteenth National Independence Day", "", "Public/Bank"],
    ["07-04", "Independence Day", "", "Public/Bank"],
    ["09-04", "Labour Day", "", "Public/Bank"],
    ["10-09", "Columbus Day", "US-AL,US-AZ,US-CO,US-CT,US-GA,US-ID,US-IL,US-IN,US-IA,US-KS,US-KY,US-LA,US-ME,US-MD,US-MA,US-MS,US-MO,US-MT,US-NE,US-NH,US-NJ,US-NM,US-NY,US-NC,US-OH,US-OK,US-PA,US-RI,US-SC,US-TN,US-UT,US-VA,US-WV", "Public"],
    ["10-09", "Columbus Day", "", "Bank"],
    ["10-09", "Indigenous Peoples' Day", "US-AK,US-AL,US-CA,US-HI,US-IA,US-LA,US-ME,US-MI,US-MN,US-NC,US-NE,US-NM,US-OK,US-OR,US-SD,US-TX,US-VA,US-VT,US-WI", "Public"],
    ["11-11", "Veterans Day", "", "Public/Bank"],
    ["11-23", "Thanksgiving Day", "", "Public/Bank"],
    ["12-25", "Christmas Day", "", "Public/Bank"],
  ],
  "GB:2026": [
    ["01-01", "New Year's Day", "GB-ENG,GB-NIR,GB-SCT,GB-WLS", "Public"],
    ["01-02", "2 January", "GB-SCT", "Public"],
    ["03-17", "Saint Patrick's Day", "GB-NIR", "Public"],
    ["04-03", "Good Friday", "", "Public"],
    ["04-06", "Easter Monday", "GB-ENG,GB-WLS,GB-NIR", "Public"],
    ["05-04", "Early May Bank Holiday", "", "Public"],
    ["05-25", "Spring Bank Holiday", "", "Public"],
    ["06-15", "World Cup Bank Holiday", "GB-SCT", "Public"],
    ["07-12", "Battle of the Boyne", "GB-NIR", "Public"],
    ["08-03", "Summer Bank Holiday", "GB-SCT", "Public"],
    ["08-31", "Summer Bank Holiday", "GB-ENG,GB-WLS,GB-NIR", "Public"],
    ["11-30", "Saint Andrew's Day", "GB-SCT", "Public"],
    ["12-25", "Christmas Day", "", "Public"],
    ["12-26", "St. Stephen's Day", "", "Public"],
  ],
  "GB:2027": [
    ["01-01", "New Year's Day", "GB-ENG,GB-NIR,GB-SCT,GB-WLS", "Public"],
    ["01-02", "2 January", "GB-SCT", "Public"],
    ["03-17", "Saint Patrick's Day", "GB-NIR", "Public"],
    ["03-26", "Good Friday", "", "Public"],
    ["03-29", "Easter Monday", "GB-ENG,GB-WLS,GB-NIR", "Public"],
    ["05-03", "Early May Bank Holiday", "", "Public"],
    ["05-31", "Spring Bank Holiday", "", "Public"],
    ["07-12", "Battle of the Boyne", "GB-NIR", "Public"],
    ["08-02", "Summer Bank Holiday", "GB-SCT", "Public"],
    ["08-30", "Summer Bank Holiday", "GB-ENG,GB-WLS,GB-NIR", "Public"],
    ["11-30", "Saint Andrew's Day", "GB-SCT", "Public"],
    ["12-25", "Christmas Day", "", "Public"],
    ["12-26", "St. Stephen's Day", "", "Public"],
  ],
  "GB:2028": [
    ["01-01", "New Year's Day", "GB-ENG,GB-NIR,GB-SCT,GB-WLS", "Public"],
    ["01-02", "2 January", "GB-SCT", "Public"],
    ["03-17", "Saint Patrick's Day", "GB-NIR", "Public"],
    ["04-14", "Good Friday", "", "Public"],
    ["04-17", "Easter Monday", "GB-ENG,GB-WLS,GB-NIR", "Public"],
    ["05-01", "Early May Bank Holiday", "", "Public"],
    ["05-29", "Spring Bank Holiday", "", "Public"],
    ["07-12", "Battle of the Boyne", "GB-NIR", "Public"],
    ["08-07", "Summer Bank Holiday", "GB-SCT", "Public"],
    ["08-28", "Summer Bank Holiday", "GB-ENG,GB-WLS,GB-NIR", "Public"],
    ["11-30", "Saint Andrew's Day", "GB-SCT", "Public"],
    ["12-25", "Christmas Day", "", "Public"],
    ["12-26", "St. Stephen's Day", "", "Public"],
  ],
  "JP:2026": [
    ["01-01", "New Year's Day", "", "Public"],
    ["01-12", "Coming of Age Day", "", "Public"],
    ["02-11", "Foundation Day", "", "Public"],
    ["02-23", "The Emperor's Birthday", "", "Public"],
    ["03-20", "Vernal Equinox Day", "", "Public"],
    ["04-29", "Sh\u014dwa Day", "", "Public"],
    ["05-03", "Constitution Memorial Day", "", "Public"],
    ["05-04", "Greenery Day", "", "Public"],
    ["05-05", "Children's Day", "", "Public"],
    ["07-20", "Marine Day", "", "Public"],
    ["08-11", "Mountain Day", "", "Public"],
    ["09-21", "Respect for the Aged Day", "", "Public"],
    ["09-23", "Autumnal Equinox Day", "", "Public"],
    ["10-12", "Sports Day", "", "Public"],
    ["11-03", "Culture Day", "", "Public"],
    ["11-23", "Labour Thanksgiving Day", "", "Public"],
  ],
  "JP:2027": [
    ["01-01", "New Year's Day", "", "Public"],
    ["01-11", "Coming of Age Day", "", "Public"],
    ["02-11", "Foundation Day", "", "Public"],
    ["02-23", "The Emperor's Birthday", "", "Public"],
    ["03-21", "Vernal Equinox Day", "", "Public"],
    ["04-29", "Sh\u014dwa Day", "", "Public"],
    ["05-03", "Constitution Memorial Day", "", "Public"],
    ["05-04", "Greenery Day", "", "Public"],
    ["05-05", "Children's Day", "", "Public"],
    ["07-19", "Marine Day", "", "Public"],
    ["08-11", "Mountain Day", "", "Public"],
    ["09-20", "Respect for the Aged Day", "", "Public"],
    ["09-23", "Autumnal Equinox Day", "", "Public"],
    ["10-11", "Sports Day", "", "Public"],
    ["11-03", "Culture Day", "", "Public"],
    ["11-23", "Labour Thanksgiving Day", "", "Public"],
  ],
  "DE:2026": [
    ["01-01", "New Year's Day", "", "Public"],
    ["01-06", "Epiphany", "DE-BW,DE-BY,DE-ST", "Public"],
    ["03-08", "International Women's Day", "DE-BE,DE-MV", "Public"],
    ["04-03", "Good Friday", "", "Public"],
    ["04-05", "Easter Sunday", "DE-BB", "Public"],
    ["04-06", "Easter Monday", "", "Public"],
    ["05-01", "Labour Day", "", "Public"],
    ["05-14", "Ascension Day", "", "Public"],
    ["05-24", "Pentecost", "DE-BB", "Public"],
    ["05-25", "Whit Monday", "", "Public"],
    ["06-04", "Corpus Christi", "DE-BW,DE-BY,DE-HE,DE-NW,DE-RP,DE-SL", "Public"],
    ["08-15", "Assumption Day", "DE-SL", "Public"],
    ["09-20", "World Children's Day", "DE-TH", "Public"],
    ["10-03", "German Unity Day", "", "Public"],
    ["10-31", "Reformation Day", "DE-BB,DE-MV,DE-SN,DE-ST,DE-TH,DE-HB,DE-HH,DE-NI,DE-SH", "Public"],
    ["11-01", "All Saints' Day", "DE-BW,DE-BY,DE-NW,DE-RP,DE-SL", "Public"],
    ["11-18", "Repentance and Prayer Day", "DE-SN", "Public"],
    ["12-25", "Christmas Day", "", "Public"],
    ["12-26", "St. Stephen's Day", "", "Public"],
  ],
  "DE:2027": [
    ["01-01", "New Year's Day", "", "Public"],
    ["01-06", "Epiphany", "DE-BW,DE-BY,DE-ST", "Public"],
    ["03-08", "International Women's Day", "DE-BE,DE-MV", "Public"],
    ["03-26", "Good Friday", "", "Public"],
    ["03-28", "Easter Sunday", "DE-BB", "Public"],
    ["03-29", "Easter Monday", "", "Public"],
    ["05-01", "Labour Day", "", "Public"],
    ["05-06", "Ascension Day", "", "Public"],
    ["05-16", "Pentecost", "DE-BB", "Public"],
    ["05-17", "Whit Monday", "", "Public"],
    ["05-27", "Corpus Christi", "DE-BW,DE-BY,DE-HE,DE-NW,DE-RP,DE-SL", "Public"],
    ["08-15", "Assumption Day", "DE-SL", "Public"],
    ["09-20", "World Children's Day", "DE-TH", "Public"],
    ["10-03", "German Unity Day", "", "Public"],
    ["10-31", "Reformation Day", "DE-BB,DE-MV,DE-SN,DE-ST,DE-TH,DE-HB,DE-HH,DE-NI,DE-SH", "Public"],
    ["11-01", "All Saints' Day", "DE-BW,DE-BY,DE-NW,DE-RP,DE-SL", "Public"],
    ["11-17", "Repentance and Prayer Day", "DE-SN", "Public"],
    ["12-25", "Christmas Day", "", "Public"],
    ["12-26", "St. Stephen's Day", "", "Public"],
  ],
  "AT:2026": [
    ["03-19", "Saint Joseph's Day", "AT-2,AT-6,AT-7,AT-8", "School"],
    ["05-04", "Saint Florian's Day", "AT-4", "School"],
    ["09-24", "Saint Rupert's Day", "AT-5", "School"],
    ["11-11", "Saint Martin's Day", "AT-1", "School"],
    ["11-15", "Saint Leopold's Day", "AT-3,AT-9", "School"],
  ],
};
// v3 answers captured 2026-11-18 (date.nager.at/api/v3/PublicHolidays/<year>/<cc>):
// [date, localName, name, counties ("" = nationwide), types]
const V3_FIXTURE = {
  "US:2026": [
    ["2026-01-01", "New Year's Day", "New Year's Day", "", "Public/Bank"],
    ["2026-01-19", "Martin Luther King, Jr. Day", "Martin Luther King, Jr. Day", "", "Public/Bank"],
    ["2026-02-12", "Lincoln's Birthday", "Lincoln's Birthday", "US-CA,US-CT,US-IL,US-IN,US-KY,US-MI,US-NY,US-MO,US-OH", "Observance"],
    ["2026-02-16", "Washington's Birthday", "Presidents Day", "", "Public/Bank"],
    ["2026-04-03", "Good Friday", "Good Friday", "US-CT,US-DE,US-HI,US-IN,US-KY,US-LA,US-NC,US-ND,US-NJ,US-TN", "Public"],
    ["2026-04-03", "Good Friday", "Good Friday", "US-TX", "Optional"],
    ["2026-05-08", "Truman Day", "Truman Day", "US-MO", "School/Authorities"],
    ["2026-05-25", "Memorial Day", "Memorial Day", "", "Public/Bank"],
    ["2026-06-19", "Juneteenth National Independence Day", "Juneteenth National Independence Day", "", "Public/Bank"],
    ["2026-07-03", "Independence Day", "Independence Day", "", "Public/Bank"],
    ["2026-09-07", "Labor Day", "Labour Day", "", "Public/Bank"],
    ["2026-10-12", "Columbus Day", "Columbus Day", "US-AL,US-AZ,US-CO,US-CT,US-GA,US-ID,US-IL,US-IN,US-IA,US-KS,US-KY,US-LA,US-ME,US-MD,US-MA,US-MS,US-MO,US-MT,US-NE,US-NH,US-NJ,US-NM,US-NY,US-NC,US-OH,US-OK,US-PA,US-RI,US-SC,US-TN,US-UT,US-VA,US-WV", "Public"],
    ["2026-10-12", "Columbus Day", "Columbus Day", "", "Bank"],
    ["2026-10-12", "Indigenous Peoples' Day", "Indigenous Peoples' Day", "US-AK,US-AL,US-CA,US-HI,US-IA,US-LA,US-ME,US-MI,US-MN,US-NC,US-NE,US-NM,US-OK,US-OR,US-SD,US-TX,US-VA,US-VT,US-WI", "Public"],
    ["2026-11-11", "Veterans Day", "Veterans Day", "", "Public/Bank"],
    ["2026-11-26", "Thanksgiving Day", "Thanksgiving Day", "", "Public/Bank"],
    ["2026-12-25", "Christmas Day", "Christmas Day", "", "Public/Bank"],
  ],
  "US:2027": [
    ["2027-01-01", "New Year's Day", "New Year's Day", "", "Public/Bank"],
    ["2027-01-18", "Martin Luther King, Jr. Day", "Martin Luther King, Jr. Day", "", "Public/Bank"],
    ["2027-02-12", "Lincoln's Birthday", "Lincoln's Birthday", "US-CA,US-CT,US-IL,US-IN,US-KY,US-MI,US-NY,US-MO,US-OH", "Observance"],
    ["2027-02-15", "Washington's Birthday", "Presidents Day", "", "Public/Bank"],
    ["2027-03-26", "Good Friday", "Good Friday", "US-CT,US-DE,US-HI,US-IN,US-KY,US-LA,US-NC,US-ND,US-NJ,US-TN", "Public"],
    ["2027-03-26", "Good Friday", "Good Friday", "US-TX", "Optional"],
    ["2027-05-08", "Truman Day", "Truman Day", "US-MO", "School/Authorities"],
    ["2027-05-31", "Memorial Day", "Memorial Day", "", "Public/Bank"],
    ["2027-06-18", "Juneteenth National Independence Day", "Juneteenth National Independence Day", "", "Public/Bank"],
    ["2027-07-05", "Independence Day", "Independence Day", "", "Public/Bank"],
    ["2027-09-06", "Labor Day", "Labour Day", "", "Public/Bank"],
    ["2027-10-11", "Columbus Day", "Columbus Day", "US-AL,US-AZ,US-CO,US-CT,US-GA,US-ID,US-IL,US-IN,US-IA,US-KS,US-KY,US-LA,US-ME,US-MD,US-MA,US-MS,US-MO,US-MT,US-NE,US-NH,US-NJ,US-NM,US-NY,US-NC,US-OH,US-OK,US-PA,US-RI,US-SC,US-TN,US-UT,US-VA,US-WV", "Public"],
    ["2027-10-11", "Columbus Day", "Columbus Day", "", "Bank"],
    ["2027-10-11", "Indigenous Peoples' Day", "Indigenous Peoples' Day", "US-AK,US-AL,US-CA,US-HI,US-IA,US-LA,US-ME,US-MI,US-MN,US-NC,US-NE,US-NM,US-OK,US-OR,US-SD,US-TX,US-VA,US-VT,US-WI", "Public"],
    ["2027-11-11", "Veterans Day", "Veterans Day", "", "Public/Bank"],
    ["2027-11-25", "Thanksgiving Day", "Thanksgiving Day", "", "Public/Bank"],
    ["2027-12-24", "Christmas Day", "Christmas Day", "", "Public/Bank"],
  ],
  "US:2028": [
    ["2027-12-31", "New Year's Day", "New Year's Day", "", "Public/Bank"],
    ["2028-01-17", "Martin Luther King, Jr. Day", "Martin Luther King, Jr. Day", "", "Public/Bank"],
    ["2028-02-12", "Lincoln's Birthday", "Lincoln's Birthday", "US-CA,US-CT,US-IL,US-IN,US-KY,US-MI,US-NY,US-MO,US-OH", "Observance"],
    ["2028-02-21", "Washington's Birthday", "Presidents Day", "", "Public/Bank"],
    ["2028-04-14", "Good Friday", "Good Friday", "US-CT,US-DE,US-HI,US-IN,US-KY,US-LA,US-NC,US-ND,US-NJ,US-TN", "Public"],
    ["2028-04-14", "Good Friday", "Good Friday", "US-TX", "Optional"],
    ["2028-05-08", "Truman Day", "Truman Day", "US-MO", "School/Authorities"],
    ["2028-05-29", "Memorial Day", "Memorial Day", "", "Public/Bank"],
    ["2028-06-19", "Juneteenth National Independence Day", "Juneteenth National Independence Day", "", "Public/Bank"],
    ["2028-07-04", "Independence Day", "Independence Day", "", "Public/Bank"],
    ["2028-09-04", "Labor Day", "Labour Day", "", "Public/Bank"],
    ["2028-10-09", "Columbus Day", "Columbus Day", "US-AL,US-AZ,US-CO,US-CT,US-GA,US-ID,US-IL,US-IN,US-IA,US-KS,US-KY,US-LA,US-ME,US-MD,US-MA,US-MS,US-MO,US-MT,US-NE,US-NH,US-NJ,US-NM,US-NY,US-NC,US-OH,US-OK,US-PA,US-RI,US-SC,US-TN,US-UT,US-VA,US-WV", "Public"],
    ["2028-10-09", "Columbus Day", "Columbus Day", "", "Bank"],
    ["2028-10-09", "Indigenous Peoples' Day", "Indigenous Peoples' Day", "US-AK,US-AL,US-CA,US-HI,US-IA,US-LA,US-ME,US-MI,US-MN,US-NC,US-NE,US-NM,US-OK,US-OR,US-SD,US-TX,US-VA,US-VT,US-WI", "Public"],
    ["2028-11-10", "Veterans Day", "Veterans Day", "", "Public/Bank"],
    ["2028-11-23", "Thanksgiving Day", "Thanksgiving Day", "", "Public/Bank"],
    ["2028-12-25", "Christmas Day", "Christmas Day", "", "Public/Bank"],
  ],
  "GB:2026": [
    ["2026-01-01", "New Year's Day", "New Year's Day", "GB-ENG,GB-NIR,GB-SCT,GB-WLS", "Public"],
    ["2026-01-02", "2 January", "2 January", "GB-SCT", "Public"],
    ["2026-03-17", "Saint Patrick's Day", "Saint Patrick's Day", "GB-NIR", "Public"],
    ["2026-04-03", "Good Friday", "Good Friday", "", "Public"],
    ["2026-04-06", "Easter Monday", "Easter Monday", "GB-ENG,GB-WLS,GB-NIR", "Public"],
    ["2026-05-04", "Early May Bank Holiday", "Early May Bank Holiday", "", "Public"],
    ["2026-05-25", "Spring Bank Holiday", "Spring Bank Holiday", "", "Public"],
    ["2026-06-15", "World Cup Bank Holiday", "World Cup Bank Holiday", "GB-SCT", "Public"],
    ["2026-07-13", "Battle of the Boyne", "Battle of the Boyne", "GB-NIR", "Public"],
    ["2026-08-03", "Summer Bank Holiday", "Summer Bank Holiday", "GB-SCT", "Public"],
    ["2026-08-31", "Summer Bank Holiday", "Summer Bank Holiday", "GB-ENG,GB-WLS,GB-NIR", "Public"],
    ["2026-11-30", "Saint Andrew's Day", "Saint Andrew's Day", "GB-SCT", "Public"],
    ["2026-12-25", "Christmas Day", "Christmas Day", "", "Public"],
    ["2026-12-28", "Boxing Day", "St. Stephen's Day", "", "Public"],
  ],
  "GB:2027": [
    ["2027-01-01", "New Year's Day", "New Year's Day", "GB-ENG,GB-NIR,GB-SCT,GB-WLS", "Public"],
    ["2027-01-02", "2 January", "2 January", "GB-SCT", "Public"],
    ["2027-03-17", "Saint Patrick's Day", "Saint Patrick's Day", "GB-NIR", "Public"],
    ["2027-03-26", "Good Friday", "Good Friday", "", "Public"],
    ["2027-03-29", "Easter Monday", "Easter Monday", "GB-ENG,GB-WLS,GB-NIR", "Public"],
    ["2027-05-03", "Early May Bank Holiday", "Early May Bank Holiday", "", "Public"],
    ["2027-05-31", "Spring Bank Holiday", "Spring Bank Holiday", "", "Public"],
    ["2027-07-12", "Battle of the Boyne", "Battle of the Boyne", "GB-NIR", "Public"],
    ["2027-08-02", "Summer Bank Holiday", "Summer Bank Holiday", "GB-SCT", "Public"],
    ["2027-08-30", "Summer Bank Holiday", "Summer Bank Holiday", "GB-ENG,GB-WLS,GB-NIR", "Public"],
    ["2027-11-30", "Saint Andrew's Day", "Saint Andrew's Day", "GB-SCT", "Public"],
    ["2027-12-27", "Christmas Day", "Christmas Day", "", "Public"],
    ["2027-12-28", "Boxing Day", "St. Stephen's Day", "", "Public"],
  ],
  "GB:2028": [
    ["2028-01-03", "New Year's Day", "New Year's Day", "GB-ENG,GB-NIR,GB-SCT,GB-WLS", "Public"],
    ["2028-01-04", "2 January", "2 January", "GB-SCT", "Public"],
    ["2028-03-17", "Saint Patrick's Day", "Saint Patrick's Day", "GB-NIR", "Public"],
    ["2028-04-14", "Good Friday", "Good Friday", "", "Public"],
    ["2028-04-17", "Easter Monday", "Easter Monday", "GB-ENG,GB-WLS,GB-NIR", "Public"],
    ["2028-05-01", "Early May Bank Holiday", "Early May Bank Holiday", "", "Public"],
    ["2028-05-29", "Spring Bank Holiday", "Spring Bank Holiday", "", "Public"],
    ["2028-07-12", "Battle of the Boyne", "Battle of the Boyne", "GB-NIR", "Public"],
    ["2028-08-07", "Summer Bank Holiday", "Summer Bank Holiday", "GB-SCT", "Public"],
    ["2028-08-28", "Summer Bank Holiday", "Summer Bank Holiday", "GB-ENG,GB-WLS,GB-NIR", "Public"],
    ["2028-11-30", "Saint Andrew's Day", "Saint Andrew's Day", "GB-SCT", "Public"],
    ["2028-12-25", "Christmas Day", "Christmas Day", "", "Public"],
    ["2028-12-26", "Boxing Day", "St. Stephen's Day", "", "Public"],
  ],
  "JP:2026": [
    ["2026-01-01", "元日", "New Year's Day", "", "Public"],
    ["2026-01-12", "成人の日", "Coming of Age Day", "", "Public"],
    ["2026-02-11", "建国記念の日", "Foundation Day", "", "Public"],
    ["2026-02-23", "天皇誕生日", "The Emperor's Birthday", "", "Public"],
    ["2026-03-20", "春分の日", "Vernal Equinox Day", "", "Public"],
    ["2026-04-29", "昭和の日", "Shōwa Day", "", "Public"],
    ["2026-05-06", "憲法記念日", "Constitution Memorial Day", "", "Public"],
    ["2026-05-04", "みどりの日", "Greenery Day", "", "Public"],
    ["2026-05-05", "こどもの日", "Children's Day", "", "Public"],
    ["2026-07-20", "海の日", "Marine Day", "", "Public"],
    ["2026-08-11", "山の日", "Mountain Day", "", "Public"],
    ["2026-09-21", "敬老の日", "Respect for the Aged Day", "", "Public"],
    ["2026-09-23", "秋分の日", "Autumnal Equinox Day", "", "Public"],
    ["2026-10-12", "スポーツの日", "Sports Day", "", "Public"],
    ["2026-11-03", "文化の日", "Culture Day", "", "Public"],
    ["2026-11-23", "勤労感謝の日", "Labour Thanksgiving Day", "", "Public"],
  ],
  "JP:2027": [
    ["2027-01-01", "元日", "New Year's Day", "", "Public"],
    ["2027-01-11", "成人の日", "Coming of Age Day", "", "Public"],
    ["2027-02-11", "建国記念の日", "Foundation Day", "", "Public"],
    ["2027-02-23", "天皇誕生日", "The Emperor's Birthday", "", "Public"],
    ["2027-03-21", "春分の日", "Vernal Equinox Day", "", "Public"],
    ["2027-04-29", "昭和の日", "Shōwa Day", "", "Public"],
    ["2027-05-03", "憲法記念日", "Constitution Memorial Day", "", "Public"],
    ["2027-05-04", "みどりの日", "Greenery Day", "", "Public"],
    ["2027-05-05", "こどもの日", "Children's Day", "", "Public"],
    ["2027-07-19", "海の日", "Marine Day", "", "Public"],
    ["2027-08-11", "山の日", "Mountain Day", "", "Public"],
    ["2027-09-20", "敬老の日", "Respect for the Aged Day", "", "Public"],
    ["2027-09-23", "秋分の日", "Autumnal Equinox Day", "", "Public"],
    ["2027-10-11", "スポーツの日", "Sports Day", "", "Public"],
    ["2027-11-03", "文化の日", "Culture Day", "", "Public"],
    ["2027-11-23", "勤労感謝の日", "Labour Thanksgiving Day", "", "Public"],
  ],
  "US:2020": [
    ["2020-01-01", "New Year's Day", "New Year's Day", "", "Public/Bank"],
    ["2020-01-20", "Martin Luther King, Jr. Day", "Martin Luther King, Jr. Day", "", "Public/Bank"],
    ["2020-02-12", "Lincoln's Birthday", "Lincoln's Birthday", "US-CA,US-CT,US-IL,US-IN,US-KY,US-MI,US-NY,US-MO,US-OH", "Observance"],
    ["2020-02-17", "Washington's Birthday", "Presidents Day", "", "Public/Bank"],
    ["2020-04-10", "Good Friday", "Good Friday", "US-CT,US-DE,US-HI,US-IN,US-KY,US-LA,US-NC,US-ND,US-NJ,US-TN", "Public"],
    ["2020-04-10", "Good Friday", "Good Friday", "US-TX", "Optional"],
    ["2020-05-08", "Truman Day", "Truman Day", "US-MO", "School/Authorities"],
    ["2020-05-25", "Memorial Day", "Memorial Day", "", "Public/Bank"],
    ["2020-07-03", "Independence Day", "Independence Day", "", "Public/Bank"],
    ["2020-09-07", "Labor Day", "Labour Day", "", "Public/Bank"],
    ["2020-10-12", "Columbus Day", "Columbus Day", "US-AL,US-AZ,US-CO,US-CT,US-GA,US-ID,US-IL,US-IN,US-IA,US-KS,US-KY,US-LA,US-ME,US-MD,US-MA,US-MS,US-MO,US-MT,US-NE,US-NH,US-NJ,US-NM,US-NY,US-NC,US-OH,US-OK,US-PA,US-RI,US-SC,US-TN,US-UT,US-VA,US-WV", "Public"],
    ["2020-10-12", "Columbus Day", "Columbus Day", "", "Bank"],
    ["2020-10-12", "Indigenous Peoples' Day", "Indigenous Peoples' Day", "US-AK,US-AL,US-CA,US-HI,US-IA,US-LA,US-ME,US-MI,US-MN,US-NC,US-NE,US-NM,US-OK,US-SD,US-VA,US-VT,US-WI", "Public"],
    ["2020-11-11", "Veterans Day", "Veterans Day", "", "Public/Bank"],
    ["2020-11-26", "Thanksgiving Day", "Thanksgiving Day", "", "Public/Bank"],
    ["2020-12-25", "Christmas Day", "Christmas Day", "", "Public/Bank"],
  ],
};
const reads = [];
let failing = false, v3Down = false;
function fixtureRead(url) {
  reads.push(url);
  if (failing) throw Object.assign(new Error("Source URL's host returned HTTP 503"), { statusCode: 502, upstreamStatus: 503 });
  const v3m = /\/api\/v3\/PublicHolidays\/(\d{4})\/([A-Z]{2})$/.exec(url);
  if (v3m) {
    if (v3Down) throw Object.assign(new Error("Source URL's host returned HTTP 503"), { statusCode: 502, upstreamStatus: 503 });
    const rows = V3_FIXTURE[`${v3m[2]}:${v3m[1]}`];
    if (!rows) throw Object.assign(new Error("Source URL returned HTTP 404"), { statusCode: 422, upstreamStatus: 404 });
    return rows.map(([date, localName, name, counties, types]) => ({ date, localName, name, countryCode: v3m[2], global: !counties, counties: counties ? counties.split(",") : null, types: types.split("/") }));
  }
  const m = /\/Holidays\/([A-Z]{2})\/(\d{4}|Next)$/.exec(url);
  if (!m) throw new Error(`unexpected url ${url}`);
  const [, cc, y] = m;
  if (cc === "ZZ") throw Object.assign(new Error("Source URL returned HTTP 404"), { statusCode: 422, upstreamStatus: 404 });
  if (cc === "AQ") return null; // 204
  if (y === "Next") {
    const today = new Date().toISOString().slice(0, 10);
    return [2026, 2027].flatMap((yy) => (FIXTURE[`${cc}:${yy}`] || []).map((r) => row(cc, yy, r))).filter((h) => h.date >= today);
  }
  const rows = FIXTURE[`${cc}:${y}`];
  if (!rows) throw Object.assign(new Error("Source URL returned HTTP 400"), { statusCode: 422, upstreamStatus: 400 });
  return rows.map((r) => row(cc, +y, r));
}
const row = (cc, y, [md, name, subs, types]) => ({ date: `${y}-${md}`, name, countryCode: cc, nationalHoliday: !subs, subdivisionCodes: subs ? subs.split(",") : null, holidayTypes: types.split("/") });
__setHolidayReadForTests(fixtureRead);
// sha256 of JSON.stringify(public-holidays' answer to its published example)
// over the fixture rows before v3's end of life, recorded from main 50a3fb622.
const PUBLISHED_EXAMPLE_DIGEST = "edf41151512d5a86d9e5c0bcd65641c5a46c2dbbd66f30661c1a8703f82a7f30";
const BEFORE_EOL = Date.parse("2026-11-18T12:00:00Z"), AFTER_EOL = Date.parse("2027-02-01T00:00:00Z");
__setNowForTests(() => BEFORE_EOL);

const tool = (slug) => [...DATA_TOOLS, ...HOLIDAY_TOOLS].find((t) => t.slug === slug);
const call = (slug, input) => tool(slug).handler(input);
async function status(slug, input) { try { await call(slug, input); return 200; } catch (e) { return e.statusCode; } }

// ── public-holidays: the published contract, v4 underneath ───────────────────
{
  ok(reads.length === 0, "no read at import");
  const r = await call("public-holidays", { country: "us", year: "2026" });
  ok(reads.includes(`${HOLIDAY_API}/Holidays/US/2026`) && reads.includes(`${V3_API}/PublicHolidays/2026/US`), "before v3's end of life public-holidays reads the v4 route and the v3 route");
  ok(r.country === "US" && r.year === 2026 && r.count === r.holidays.length && r.count === 17, "country, year, count as before");
  const h = r.holidays[0];
  for (const k of ["date", "localName", "name", "global", "counties", "types"]) ok(k in h, `v3 field ${k} kept`);
  for (const k of ["calendarDate", "nationalHoliday", "subdivisionCodes", "holidayTypes"]) ok(k in h, `field ${k} added`);
  ok(h.date === "2026-01-01" && h.global === true && h.counties === null && h.types.join() === "Public,Bank" && h.localName === "New Year's Day", "v3 fields carry v3's values");
  const ind = r.holidays.find((x) => x.name === "Independence Day");
  ok(ind.date === "2026-07-03" && ind.calendarDate === "2026-07-04", "date keeps v3's observed weekday (2026-07-03); calendarDate carries the calendar date");
  const jp = await call("public-holidays", { country: "JP", year: 2026 });
  ok(jp.holidays[0].localName === "元日" && jp.holidays.find((x) => x.name === "Constitution Memorial Day").date === "2026-05-06", "localName and observed date come from v3 while it answers (JP)");
  const gf = r.holidays.find((x) => x.name === "Good Friday" && x.holidayTypes.includes("Public"));
  ok(gf && gf.global === false && gf.counties.includes("US-CT") && gf.subdivisionCodes.includes("US-CT"), "a regional row keeps its regions in counties and subdivisionCodes");
  const bank = await call("public-holidays", { country: "US", year: 2026, types: "bank" });
  ok(bank.count === 11 && bank.holidays.every((x) => x.holidayTypes.includes("Bank")) && bank.filterTypes.join() === "Bank", "types filter keeps only Bank rows");
  const by = await call("public-holidays", { country: "DE", year: 2026, subdivision: "de-by" });
  ok(by.subdivision === "DE-BY" && by.holidays.some((x) => x.name === "Epiphany") && !by.holidays.some((x) => x.name === "Reformation Day"), "subdivision filter keeps nationwide rows and that region's");
  const empty = await call("public-holidays", { country: "AQ", year: 2026 });
  ok(empty.count === 0 && empty.holidays.length === 0, "a 204 from the source is an empty year");
  for (const [input, label] of [
    [{ country: "USA", year: 2026 }, "a 3-letter country"], [{ country: "US", year: 1900 }, "a year before 1975"], [{ country: "US", year: "20x6" }, "a non-integer year"],
    [{ country: "ZZ", year: 2026 }, "an unknown country (source 404)"], [{ country: "US", year: 2040 }, "a year outside the source's window (source 400)"],
    [{ country: "US", year: 2026, subdivision: "DE-BY" }, "a subdivision of another country"], [{ country: "US", year: 2026, types: "Holiday" }, "an unknown type"],
  ]) ok(await status("public-holidays", input) === 400, `public-holidays answers 400 for ${label}`);
}

// ── cache bounds ─────────────────────────────────────────────────────────────
{
  let t = Date.parse("2026-11-18T00:00:00Z");
  __setNowForTests(() => t);
  __setHolidayReadForTests(fixtureRead);
  reads.length = 0;
  const v4reads = () => reads.filter((u) => u.startsWith(HOLIDAY_API)).length;
  await call("public-holidays", { country: "US", year: 2027 });
  await call("public-holidays", { country: "US", year: 2027 });
  ok(v4reads() === 1 && reads.length === 2, "a second call inside the fresh window reads nothing (one v4 and one v3 read in all)");
  t += FRESH_MS + 1000;
  await call("public-holidays", { country: "US", year: 2027 });
  ok(v4reads() === 2, "past the fresh window the next call refetches");
  failing = true;
  t += FRESH_MS + 1000; // older than the fresh window, younger than 24 h
  const stale = await call("public-holidays", { country: "US", year: 2027 });
  ok(stale.stale === true && stale.count > 0, "a failed refetch inside 24 h serves the cached copy marked stale");
  t += MAX_AGE_MS;
  ok(await status("public-holidays", { country: "US", year: 2027 }) === 502, "a copy 24 h old or more is never served: the failure surfaces");
  ok(!__caches.YEAR_CACHE.has("US:2027"), "the expired entry is dropped");
  failing = false;
  __caches.YEAR_CACHE.clear();
  __setHolidayReadForTests(() => []);
  const code = (k) => String.fromCharCode(65 + (Math.floor(k / 26) % 26)) + String.fromCharCode(65 + (k % 26));
  for (let k = 0; k < MAX_ENTRIES + 25; k++) { t += 1; await call("public-holidays", { country: code(k), year: 2026 }); }
  ok(__caches.YEAR_CACHE.size === MAX_ENTRIES, `the year cache holds at most ${MAX_ENTRIES} entries (${__caches.YEAR_CACHE.size})`);
  ok(!__caches.YEAR_CACHE.has(`${code(0)}:2026`) && __caches.YEAR_CACHE.has(`${code(MAX_ENTRIES + 24)}:2026`), "the oldest entry is evicted first");
  __setNowForTests(() => BEFORE_EOL);
  __setHolidayReadForTests(fixtureRead);
}

// ── v3 compatibility: observed dates, localName, years outside v4 ─────────────
{
  // The observance rules reproduce v3's dates on the captured samples, except
  // where v3 differs from the published calendar: Scotland's 2 January 2027
  // substitute (GOV.UK lists 2027-01-04) and Japan's 2027 Vernal Equinox
  // substitute (JPX lists 2027-03-22).
  const KNOWN_V3_GAPS = new Set(["GB:2027-01-04|2 January", "JP:2027-03-22|Vernal Equinox Day"]);
  let agree = 0, total = 0;
  const gaps = [];
  for (const key of Object.keys(V3_FIXTURE)) {
    if (!FIXTURE[key]) continue;
    const [cc, y] = key.split(":");
    const v4rows = FIXTURE[key].map((x) => row(cc, +y, x)).map((h) => ({ date: h.date, name: h.name, nationalHoliday: h.nationalHoliday, subdivisionCodes: h.subdivisionCodes, holidayTypes: h.holidayTypes }));
    const want = new Set(V3_FIXTURE[key].map(([d, , n]) => `${d}|${n}`));
    observedDates(cc, v4rows).forEach((d, i) => { total++; const k = `${d}|${v4rows[i].name}`; if (want.has(k)) agree++; else gaps.push(`${cc}:${k}`); });
  }
  ok(gaps.every((g) => KNOWN_V3_GAPS.has(g)) && agree === total - KNOWN_V3_GAPS.size, `observance rules reproduce v3's dates on US, GB, JP 2026-2028 samples (${agree}/${total}; differences only where v3 differs from the official calendar: ${gaps.join(", ")})`);
  const gb27 = await call("public-holidays", { country: "GB", year: 2027 });
  ok(gb27.holidays.find((x) => x.name === "2 January").date === "2027-01-02", "while v3 answers, date is exactly v3's, even where the rule would differ");
  // v3 down (or past its end of life): the rules give the observed date.
  v3Down = true; __caches.V3_CACHE.clear();
  const us27 = await call("public-holidays", { country: "US", year: 2027 });
  eq(["Juneteenth National Independence Day", "Independence Day", "Christmas Day"].map((n) => us27.holidays.find((x) => x.name === n).date), ["2027-06-18", "2027-07-05", "2027-12-24"], "without v3, US 2027 observed dates come from the federal rule (v3's own dates)");
  const gb28 = await call("public-holidays", { country: "GB", year: 2028 });
  eq([gb28.holidays.find((x) => x.name === "New Year's Day").date, gb28.holidays.find((x) => x.name === "2 January").date], ["2028-01-03", "2028-01-04"], "without v3, GB 2028 substitutes come from the GOV.UK rule (v3's own dates)");
  ok(gb28.holidays.every((x) => x.localName === null), "without v3, localName is null");
  v3Down = false;
  // A year outside v4's window: v3 until its end of life, then a 400 with the reason.
  const old = await call("public-holidays", { country: "US", year: 2020 });
  ok(old.count > 5 && old.holidays[0].calendarDate === null && old.holidays.some((x) => x.date === "2020-07-03" && x.name === "Independence Day"), "before 2027-02-01 a year outside v4's window is answered from v3");
  __setNowForTests(() => AFTER_EOL);
  __caches.V3_CACHE.clear(); __caches.YEAR_CACHE.clear();
  reads.length = 0;
  let msg = "";
  try { await call("public-holidays", { country: "US", year: 2020 }); } catch (e) { msg = `${e.statusCode} ${e.message}`; }
  ok(/^400 /.test(msg) && /2027-01-31/.test(msg), `from 2027-02-01 that year is a 400 naming the end date (${msg})`);
  const after = await call("public-holidays", { country: "US", year: 2027 });
  ok(!reads.some((u) => u.startsWith(V3_API)), "from 2027-02-01 no v3 read is made");
  ok(after.holidays.find((x) => x.name === "Independence Day").date === "2027-07-05" && after.holidays.every((x) => x.localName === null), "from 2027-02-01: observed dates by rule, localName null");
  __setNowForTests(() => BEFORE_EOL);
  __caches.V3_CACHE.clear(); __caches.YEAR_CACHE.clear();
}

// ── business days on published calendars ─────────────────────────────────────
const check = async (country, date, extra = {}) => (await call("country-business-days", { country, op: "check", date, ...extra })).isBusinessDay;
{
  // OPM: 2026-07-04 is a Saturday, observed Friday 2026-07-03; 2027-07-04 Sunday -> Monday 07-05;
  // 2027-12-25 Saturday -> Friday 12-24; 2028-01-01 Saturday -> Friday 2027-12-31.
  ok(!(await check("US", "2026-07-03")), "US federal: 2026-07-03 is the observed Independence Day");
  ok(!(await check("US", "2027-07-05")) && !(await check("US", "2027-12-24")), "US federal: 2027-07-05 and 2027-12-24 are observed holidays");
  ok(!(await check("US", "2027-12-31")), "US federal: New Year's Day 2028 (a Saturday) is observed 2027-12-31");
  ok(await check("US", "2026-07-02") && await check("US", "2026-12-24"), "US federal: ordinary weekdays are business days");
  // Federal Reserve schedule (frbservices.org): Saturday holidays leave the Friday open.
  ok(await check("US", "2026-07-03", { basis: "bank" }), "Fed: 2026-07-03 is open (holiday on Saturday)");
  ok(await check("US", "2027-06-18", { basis: "bank" }) && await check("US", "2027-12-24", { basis: "bank" }), "Fed: 2027-06-18 and 2027-12-24 are open");
  ok(!(await check("US", "2027-07-05", { basis: "bank" })), "Fed: 2027-07-05 is closed (Independence Day on Sunday)");
  ok(!(await check("US", "2026-10-12", { basis: "bank" })) && await check("US", "2026-10-12"), "Fed closes Columbus Day; the federal public basis without a region does not");
  ok(!(await check("US", "2026-04-03", { subdivision: "US-CT" })) && await check("US", "2026-04-03"), "a regional holiday closes its region only");
  // GOV.UK England and Wales: 2026 Boxing Day substitute 12-28; 2027 12-27 and 12-28; 2028 New Year substitute 01-03.
  ok(!(await check("GB", "2026-12-28", { subdivision: "GB-ENG" })), "GB-ENG: 2026-12-28 is the Boxing Day substitute");
  ok(!(await check("GB", "2027-12-27", { subdivision: "GB-ENG" })) && !(await check("GB", "2027-12-28", { subdivision: "GB-ENG" })) && await check("GB", "2027-12-29", { subdivision: "GB-ENG" }), "GB-ENG: 2027-12-27 and 12-28 are substitutes, 12-29 is open");
  ok(!(await check("GB", "2028-01-03", { subdivision: "GB-ENG" })), "GB-ENG: 2028-01-03 is the New Year substitute");
  ok(await check("GB", "2026-01-02", { subdivision: "GB-ENG" }) && !(await check("GB", "2026-01-02", { subdivision: "GB-SCT" })), "2 January closes Scotland, not England");
  const gbNote = await call("country-business-days", { country: "GB", op: "check", date: "2026-05-04" });
  ok(typeof gbNote.note === "string" && /subdivision/.test(gbNote.note), "a country with regional holidays and no subdivision says so");
  // JPX published calendar: 2026-05-06 (substitute), 2026-09-22 (between two holidays), 2027-03-22 (substitute).
  for (const d of ["2026-05-06", "2026-09-22", "2027-03-22"]) ok(!(await check("JP", d)), `JP: ${d} is a holiday as JPX lists`);
  const jpxWeekdays = Object.keys(EXCHANGES.JPX.closed).filter((d) => ![0, 6].includes(new Date(d + "T00:00:00Z").getUTCDay()) && !/-(01-0[23]|12-31)$/.test(d));
  let agree = 0;
  for (const d of jpxWeekdays) if (!(await check("JP", d))) agree++;
  ok(agree === jpxWeekdays.length, `JP national holidays match every JPX weekday holiday 2026-2027 (${agree}/${jpxWeekdays.length})`);
  // add / count
  const add = await call("country-business-days", { country: "US", op: "add", date: "2026-07-02", days: 1 });
  eq(add.result, "2026-07-06", "US: one business day after 2026-07-02 is 2026-07-06");
  const back = await call("country-business-days", { country: "DE", subdivision: "DE-BY", op: "add", date: "2027-01-07", days: -2 });
  eq(back.result, "2027-01-04", "DE-BY: two business days before 2027-01-07 skips Epiphany (01-06) and lands 2027-01-04");
  const cnt = await call("country-business-days", { country: "DE", op: "count", from: "2026-12-21", to: "2027-01-04" });
  eq([cnt.businessDays, cnt.calendarDays], [8, 14], "DE: 2026-12-21 to 2027-01-04 holds 8 business days (Christmas Day and New Year's Day off; St Stephen's on a Saturday)");
  const neg = await call("country-business-days", { country: "DE", op: "count", from: "2027-01-04", to: "2026-12-21" });
  ok(neg.businessDays === -8, "a reversed count is negative");
  const fs = await call("country-business-days", { country: "US", op: "check", date: "2026-11-20", weekend: "Fri,Sat" });
  ok(fs.isBusinessDay === false && fs.closed.reason === "weekend", "a caller weekend is honored");
  for (const [input, label] of [
    [{ country: "US", op: "add", date: "2026-07-02" }, "add without days"], [{ country: "US", op: "add", date: "2026-07-02", days: 5000 }, "days out of range"],
    [{ country: "US", op: "count", from: "2026-01-01", to: "2030-01-01" }, "a count longer than 3 years"], [{ country: "US", op: "go" }, "an unknown op"],
    [{ country: "US", op: "check", date: "2026-02-30" }, "a date that does not exist"], [{ country: "US", op: "check", date: "2026-07-02", weekend: "Mon,Tue,Wed,Thu" }, "a 4-day weekend"],
  ]) ok(await status("country-business-days", input) === 400, `country-business-days answers 400 for ${label}`);
}

// ── long weekends, planner ───────────────────────────────────────────────────
{
  const lw = await call("long-weekends", { country: "DE", year: 2026 });
  eq(lw.longWeekends.map((x) => [x.start, x.days]), [["2026-04-03", 4], ["2026-05-01", 3], ["2026-05-23", 3], ["2026-12-25", 3]], "DE 2026 long weekends");
  eq(lw.bridgeDays.map((x) => [x.bridgeDay, x.days]), [["2026-01-02", 4], ["2026-05-15", 4]], "DE 2026 bridge days (after New Year, after Ascension)");
  const us = await call("long-weekends", { country: "US", year: 2026 });
  ok(us.bridgeDays.some((x) => x.bridgeDay === "2026-11-27") && !us.bridgeDays.some((x) => x.bridgeDay.startsWith("2026-11-1") || x.bridgeDay.startsWith("2026-11-09")), "a bridge day is one working day: Thanksgiving Friday is one, a Wednesday holiday (Veterans Day) makes none");
  const by = await call("long-weekends", { country: "DE", year: 2026, subdivision: "DE-BY" });
  ok(by.bridgeDays.some((x) => x.bridgeDay === "2026-06-05"), "DE-BY adds the Corpus Christi bridge day 2026-06-05");
  const p = await call("business-day-planner", { regions: "US,GB-ENG,DE-BY", start: "2026-12-25", count: 2 });
  eq(p.dates, ["2026-12-29", "2026-12-30"], "first common business days of US, GB-ENG, DE-BY after Christmas 2026");
  ok(p.skipped.find((s) => s.date === "2026-12-28")?.closedIn.map((c) => c.region).join() === "GB-ENG", "2026-12-28 is skipped for England alone");
  ok(await status("business-day-planner", { regions: "US,GB,DE,FR,JP,AT,CH", start: "2026-12-25" }) === 400, "more than 6 regions is a 400");
}

// ── settlement rails ─────────────────────────────────────────────────────────
{
  const ach = await call("settlement-calendar", { rail: "ach", date: "2026-12-24" });
  eq([ach.settlementDate, ach.nextDaySettlementDate], ["2026-12-24", "2026-12-28"], "ACH sent 2026-12-24: same day, next-day 12-28");
  const achSat = await call("settlement-calendar", { rail: "ACH", date: "2026-07-04" });
  eq(achSat.settlementDate, "2026-07-06", "ACH sent on Saturday 2026-07-04 settles Monday 07-06");
  const fw = await call("settlement-calendar", { rail: "fedwire", date: "2027-07-05" });
  eq([fw.operatingDay, fw.settlementDate], [false, "2027-07-06"], "Fedwire 2027-07-05 (Fed holiday, Sunday rule) settles 07-06");
  const fwFri = await call("settlement-calendar", { rail: "fedwire", date: "2026-07-03" });
  ok(fwFri.operatingDay === true, "Fedwire is open 2026-07-03 (holiday on Saturday)");
  const sct = await call("settlement-calendar", { rail: "sepa-sct", date: "2026-04-03" });
  eq([sct.settlementDate, sct.latestCreditDate], ["2026-04-07", "2026-04-08"], "SEPA SCT on Good Friday 2026: T2 reopens 04-07, credited by 04-08");
  eq([t2Closed(toDay("2026-05-01")), t2Closed(toDay("2027-03-29")), t2Closed(toDay("2026-05-14"))], ["Labour Day", "Easter Monday", null], "T2 closing days follow the ECB list (Easter computed)");
  const inst = await call("settlement-calendar", { rail: "sepa-instant", date: "2026-12-25" });
  ok(inst.settlementDate === "2026-12-25" && inst.operatingDay, "SEPA Instant settles on Christmas Day");
  const chaps = await call("settlement-calendar", { rail: "chaps", date: "2026-12-25" });
  eq(chaps.settlementDate, "2026-12-29", "CHAPS sent 2026-12-25 settles 12-29 (Boxing Day substitute 12-28)");
  ok(await status("settlement-calendar", { rail: "bacs", date: "2026-12-25" }) === 400, "a rail without a sourced calendar is refused");
  for (const k of ["ach", "fedwire", "sepa-sct", "sepa-instant", "chaps"]) {
    const r = await call("settlement-calendar", { rail: k, date: "2026-11-18" });
    ok(Array.isArray(r.sources) && r.sources.every((u) => /^https:\/\//.test(u)) && r.method.length > 40, `${k} answers with its rule and official sources`);
    // Rules are cited to public sources whose terms allow reuse; the pages of
    // operators and associations that bar commercial reuse are not cited or quoted.
    ok(r.sources.every((u) => /^https:\/\/(www\.opm\.gov|www\.federalreserve\.gov|www\.ecb\.europa\.eu|eur-lex\.europa\.eu|www\.gov\.uk)\//.test(u)) && !/Nacha|Bank of England|EPC/.test(r.method), `${k}: sources are public ones only (${r.sources.join(" ")})`);
    ok(typeof r.credit === "string" && r.credit.length > 10, `${k}: the answer carries its sources' credit`);
  }
  ok((await call("settlement-calendar", { rail: "chaps", date: "2026-11-18" })).credit.includes("Open Government Licence v3.0") && !("hours" in chaps), "CHAPS: the OGL acknowledgement, and no operator hours");
  ok(/available free of charge at ecb\.europa\.eu/.test(sct.credit), "SEPA SCT: the ECB's free-availability notice rides the answer");
  const gbObs = await call("country-business-days", { country: "GB", subdivision: "GB-ENG", op: "check", date: "2026-12-28" });
  ok(gbObs.observance?.credit?.includes("Open Government Licence v3.0"), "the GOV.UK substitute rule carries the OGL acknowledgement wherever it is used");
}

// ── exchange calendars ───────────────────────────────────────────────────────
{
  const at = (exchange, iso) => call("market-calendar", { exchange, at: iso });
  const nyse = await at("NYSE", "2026-11-27T17:30:00Z");
  ok(nyse.isOpen && nyse.today.earlyClose === "13:00" && nyse.nextClose === "2026-11-27T18:00:00.000Z", "NYSE day after Thanksgiving closes 13:00 ET");
  const nyseAfter = await at("XNYS", "2026-11-27T18:30:00Z");
  ok(!nyseAfter.isOpen && nyseAfter.nextOpen === "2026-11-30T14:30:00.000Z", "after the early close the next open is Monday 09:30 ET");
  const nyseHol = await at("NYSE", "2027-07-05T15:00:00Z");
  ok(!nyseHol.isOpen && nyseHol.today.reason === "holiday", "NYSE closed 2027-07-05 (observed)");
  const nyseSummer = await at("NYSE", "2026-07-02T13:30:00Z");
  ok(nyseSummer.isOpen && nyseSummer.today.sessions[0].openUtc === "2026-07-02T13:30:00.000Z", "NYSE opens 13:30Z in daylight time");
  const jpxLunch = await at("JPX", "2026-11-18T02:45:00Z");
  ok(!jpxLunch.isOpen && jpxLunch.localTime === "11:45" && jpxLunch.nextOpen === "2026-11-18T03:30:00.000Z", "JPX lunch break: closed 11:45 JST, reopens 12:30");
  ok((await at("JPX", "2026-09-22T01:00:00Z")).today.reason === "holiday", "JPX closed 2026-09-22");
  const hk = await at("HKEX", "2026-02-16T04:30:00Z");
  ok(!hk.isOpen && hk.today.earlyClose === "12:00" && hk.localTime === "12:30", "HKEX Lunar New Year's Eve 2026 is a half day: closed at 12:30 HKT");
  const hkMorning = await at("HKEX", "2026-02-16T02:00:00Z");
  ok(hkMorning.isOpen && hkMorning.today.sessions.at(-1).close === "12:00", "HKEX half day trades 09:30 to 12:00");
  ok((await at("HKEX", "2027-04-05T03:00:00Z")).today.reason === "holiday", "HKEX closed on Ching Ming 2027-04-05 (gazetted date)");
  const lseBst = daySchedule(EXCHANGES.LSE, "2027-03-30");
  ok(lseBst.sessions[0].openUtc === "2027-03-30T07:00:00.000Z", "LSE opens 08:00 BST = 07:00Z after the clock change");
  ok(daySchedule(EXCHANGES.LSE, "2026-12-24").earlyClose === "12:30" && daySchedule(EXCHANGES.LSE, "2026-12-28").reason === "holiday", "LSE half day and substitute closure");
  ok(daySchedule(EXCHANGES.LSE, "2026-08-28").covered === false, "LSE before its published window is not answered");
  const x = daySchedule(EXCHANGES.XETRA, "2030-12-24");
  ok(x.reason === "holiday" && x.provisional === true, "Xetra later years are marked provisional");
  const beyond = await at("JPX", "2027-12-30T07:00:00Z"); // 16:00 JST, after the last covered session
  ok(beyond.nextOpen === null && typeof beyond.coverageNote === "string", "past the published coverage the next open is not guessed");
  ok(await status("market-calendar", { exchange: "NASDAQ" }) === 400 && await status("market-calendar", { exchange: "NYSE", at: "yesterday" }) === 400, "unknown exchange or instant is a 400");
  ok(FREE_TIER_SLUGS.has("market-calendar"), "market-calendar (pure CPU) is on the free tier");
  // Sources: public holiday lists and the Apache-2.0 exchange_calendars rules,
  // never an exchange's own pages; every answer credits them and disclaims.
  for (const ex of ["NYSE", "LSE", "XETRA", "JPX", "HKEX"]) {
    const a = await at(ex, "2026-11-18T12:00:00Z");
    const d = await call("market-calendar", { exchange: ex, date: "2026-11-18" });
    for (const r of [a, d]) {
      ok(r.sources.length >= 1 && r.credits.length >= 2 && r.sources.every((u) => !/nyse\.com|ice\.com|londonstockexchange|deutsche-boerse|jpx\.co\.jp|hkex\.com|gov\.hk\/en/.test(u)), `${ex}: no exchange page among the sources (${r.sources.join(" ")})`);
      ok(Array.isArray(r.credits) && r.credits.some((c) => /exchange_calendars \(Apache-2\.0/.test(c)) && /not exchange data, and not affiliated/.test(r.disclaimer), `${ex}: credits and the disclaimer ride every answer`);
    }
  }
  ok((await at("LSE", "2026-11-18T12:00:00Z")).credits.includes("Contains public sector information licensed under the Open Government Licence v3.0."), "LSE: the OGL acknowledgement");
  ok((await at("JPX", "2026-11-18T03:00:00Z")).credits.some((c) => c.includes("PDL1.0") && c.includes("内閣府")), "JPX: the Cabinet Office PDL 1.0 credit");
  ok((await at("HKEX", "2026-11-18T03:00:00Z")).credits.some((c) => /DATA\.GOV\.HK/.test(c)), "HKEX: the DATA.GOV.HK attribution");
  ok((await at("NYSE", "2026-11-27T17:30:00Z")).earlyCloseBasis === "rule", "NYSE early closes are marked as rule-based");
  const hkLunch = await at("HKEX", "2026-11-18T04:30:00Z"); // 12:30 HKT
  ok(!hkLunch.isOpen && hkLunch.nextOpen === "2026-11-18T05:00:00.000Z", "HKEX lunch break 12:00 to 13:00 (exchange_calendars XHKG)");
  // NYSE closures follow Rule 7.2 as computed: New Year's Day on a Saturday
  // (2028-01-01) closes nothing, a Saturday holiday closes the Friday before.
  ok(daySchedule(EXCHANGES.NYSE, "2027-12-31").tradingDay === true && daySchedule(EXCHANGES.NYSE, "2027-12-24").reason === "holiday", "NYSE Rule 7.2: 2027-12-31 open (New Year on a Saturday), 2027-12-24 closed (Christmas observed)");
  ok(daySchedule(EXCHANGES.XETRA, "2031-12-31").reason === "holiday" && daySchedule(EXCHANGES.XETRA, "2031-05-01").reason === "holiday" && daySchedule(EXCHANGES.XETRA, "2031-10-03").tradingDay === true, "Xetra: the fixed closure rule");
  ok(["bank-holidays", "next-holidays", "country-business-days", "business-day-planner", "settlement-calendar"].every((s) => !FREE_TIER_SLUGS.has(s)), "tools that read the holiday source stay wallet-only");
}

// ── gtin-validate (GS1 check digits; added with this kit) ─────────────────────
{
  const g = (code) => KIT2.find((t) => t.slug === "gtin-validate").handler({ code });
  ok(g("4006381333931").valid && g("036000291452").valid && g("96385074").valid && g("00012345600012").valid, "valid EAN-13, UPC-A, EAN-8 and GTIN-14 check digits pass");
  const wrong = g("4006381333932");
  ok(!wrong.valid && wrong.expectedCheckDigit === 1, "a wrong check digit fails and names the right one");
  ok(g("978-0-306-40615-7").prefix === "ISBN-13 (Bookland)" && g("036000291452").gtin14 === "00036000291452", "ISBN prefix and the 14-digit form");
  ok(g("12345").valid === false && FREE_TIER_SLUGS.has("gtin-validate"), "a wrong length is invalid; the tool is on the free tier");
}

// ── every published example answers (offline, fixture source) ──────────────────
for (const t of [tool("public-holidays"), ...HOLIDAY_TOOLS]) {
  try {
    const r = await t.handler(t.discovery.input);
    const keys = Object.keys(t.discovery.output.example);
    const missing = keys.filter((k) => !(k in r));
    ok(missing.length === 0, `${t.slug} answers its published example with every example field${missing.length ? ` (missing ${missing})` : ""}`);
  } catch (e) { ok(false, `${t.slug} example threw ${e.statusCode} ${e.message}`); }
  ok(/Holiday data by Nager\.Date\.$/.test(t.description) === (t.slug !== "market-calendar"), `${t.slug} carries the holiday-data credit exactly when it reads the holiday source`);
}

// ── the source's address: one module names it ─────────────────────────────────
{
  const { HOLIDAY_HOSTS } = holidaySource;
  const apiHosts = [HOLIDAY_API, V3_API].map((u) => new URL(u).hostname);
  ok(Array.isArray(HOLIDAY_HOSTS) && Object.isFrozen(HOLIDAY_HOSTS) && apiHosts.every((h) => HOLIDAY_HOSTS.includes(h)) && HOLIDAY_HOSTS.length === new Set(apiHosts).size,
    `HOLIDAY_HOSTS is exactly the hosts of HOLIDAY_API and V3_API (${HOLIDAY_HOSTS}; want ${apiHosts})`);
  ok(new URL(HOLIDAY_API).pathname === "/api/v4", `the holiday source is read on its v4 path (${HOLIDAY_API})`);
  // A move of the source edits holiday-source.js alone: no other tool module
  // names a holiday-source host in code (a comment may cite a page).
  const hostWords = (HOLIDAY_HOSTS || apiHosts).map((h) => h.toLowerCase());
  const elsewhere = [];
  for (const dir of ["src/tools"]) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".js") && x !== "holiday-source.js")) {
      const text = readFileSync(`${dir}/${f}`, "utf8").toLowerCase().split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      for (const h of hostWords) if (text.split(/[^a-z0-9.-]+/).some((w) => w === h || w.endsWith(`.${h}`))) elsewhere.push(`${dir}/${f}: ${h}`);
    }
  }
  ok(elsewhere.length === 0, `no module but holiday-source.js names a holiday-source host${elsewhere.length ? ` (${elsewhere.join("; ")})` : ""}`);
  // Every tool that reads the source declares its hosts, so an outage there is
  // read as the source's and a request it builds is recognized as its own.
  for (const t of [tool("public-holidays"), ...HOLIDAY_TOOLS.filter((x) => x.slug !== "market-calendar")]) {
    const hosts = [...upstreamHostsForSlug(t.slug)].sort();
    ok(declaresUpstreamHosts(t.slug) && hosts.join() === [...apiHosts].sort().join(), `${t.slug} declares the holiday source's hosts (${hosts})`);
    ok(requestMatchesDefinition(t.slug, `${HOLIDAY_API}/Holidays/US/2026`), `${t.slug}: a v4 read is the shape its definition builds`);
  }
  ok(requestMatchesDefinition("public-holidays", `${V3_API}/PublicHolidays/2026/US`), "public-holidays: a v3 read is the shape its definition builds");
}

// ── public-holidays' published example: today's answer, byte for byte ─────────
{
  __setNowForTests(() => BEFORE_EOL);
  __caches.V3_CACHE.clear(); __caches.YEAR_CACHE.clear();
  __setHolidayReadForTests(fixtureRead);
  const t = tool("public-holidays");
  const r = await t.handler(t.discovery.input);
  const ex = t.discovery.output.example;
  eq(Object.keys(r), Object.keys(ex), "public-holidays answers the published example's top-level fields in their published order");
  eq(Object.keys(r.holidays[0]), Object.keys(ex.holidays[0]), "each holiday row carries the published row fields in their published order");
  eq(r.holidays[0], ex.holidays[0], "the first row equals the published example row");
  // Digest of the whole answer to the published example over the fixture rows,
  // taken from the code before this change: the answer is unchanged byte for byte.
  const digest = createHash("sha256").update(JSON.stringify(r)).digest("hex");
  ok(digest === PUBLISHED_EXAMPLE_DIGEST, `the published example's answer is byte-identical to before (${digest})`);
  // Upstream failures keep their statuses: 404 and a window refusal are 400s,
  // a source failure with nothing cached is a 502, non-JSON and a wrong shape are 502s.
  const failWith = async (fn, input = t.discovery.input) => { __setHolidayReadForTests(fn); try { await t.handler(input); return 200; } catch (e) { return e.statusCode; } finally { __setHolidayReadForTests(fixtureRead); } };
  ok(await failWith(() => { throw Object.assign(new Error("Source URL returned HTTP 404"), { statusCode: 422, upstreamStatus: 404 }); }) === 400, "a source 404 is a 400");
  ok(await failWith((u) => { if (u.startsWith(V3_API)) return []; throw Object.assign(new Error("Source URL returned HTTP 400"), { statusCode: 422, upstreamStatus: 400 }); }) === 200, "a v4 window refusal is answered from v3 before its end of life");
  ok(await failWith(() => { throw Object.assign(new Error("Source URL's host returned HTTP 503"), { statusCode: 502, upstreamStatus: 503 }); }) === 502, "a source 5xx with nothing cached is a 502");
  ok(await failWith(() => ({ not: "a list" })) === 502, "an unexpected shape from the source is a 502");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
