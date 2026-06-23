// Calendar kit — ISO week numbers, leap-year checks, Easter computation,
// epoch conversion, day-of-year. Pure-CPU date utilities that complement
// date-time-kit (which covers formatting, diffs, cron, business days).
// All deterministic, no dependencies, no network.

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Parse a YYYY-MM-DD (or any ISO 8601) string into a validated Date.
function parseDate(val, field = "date") {
  if (!val || typeof val !== "string") throw bad(`"${field}" is required (ISO 8601 string)`);
  const d = new Date(val.trim());
  if (isNaN(d.getTime())) throw bad(`Cannot parse "${field}": "${val}"`);
  return d;
}

// True when a Gregorian year is a leap year.
function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
}

// Day-of-year (1-based) for a UTC Date.
function dayOfYear(d) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / 86400000) + 1;
}

// Total days in a given year.
function daysInYear(y) {
  return isLeap(y) ? 366 : 365;
}

// Pad a number to n digits.
function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

// ============================================================================
// ISO 8601 week calculation
// Week 1 is the week containing the first Thursday of January.
// ============================================================================
function isoWeekData(d) {
  // Work in UTC to avoid timezone shifts.
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const date = d.getUTCDate();
  const dow = d.getUTCDay(); // 0=Sun ... 6=Sat

  // ISO day of week: 1=Mon ... 7=Sun
  const isoDow = dow === 0 ? 7 : dow;

  // Find the Thursday of the current week (ISO weeks are Mon-Sun).
  const thu = new Date(Date.UTC(year, month, date + (4 - isoDow)));
  const thuYear = thu.getUTCFullYear();

  // January 4 is always in ISO week 1.
  const jan4 = new Date(Date.UTC(thuYear, 0, 4));
  const jan4Dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const isoYearStart = new Date(Date.UTC(thuYear, 0, 4 - (jan4Dow - 1)));

  const weekNum = Math.floor((thu.getTime() - isoYearStart.getTime()) / (7 * 86400000)) + 1;

  return { isoYear: thuYear, isoWeek: weekNum, isoDayOfWeek: isoDow };
}

// ============================================================================
// Easter — Anonymous Gregorian algorithm (Meeus/Jones/Butcher)
// Valid for years 1583-9999 (Gregorian calendar).
// ============================================================================
function computeEaster(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);   // 3=March, 4=April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function formatUTCDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

export const CALENDAR_TOOLS = [
  // ---------------------------------------------------------------------------
  // 1. iso-week
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/iso-week", name: "ISO week number", slug: "iso-week",
    category: "date-time", price: "$0.001",
    description:
      "Get the ISO 8601 week number, ISO day-of-week, quarter, and day-of-year for any date. Useful for fiscal/reporting calendars, weekly aggregations, and sprint planning.",
    tags: ["date", "iso-week", "week-number", "day-of-week", "calendar", "quarter"],
    discovery: {
      bodyType: "json",
      input: { date: "2026-06-23" },
      inputSchema: {
        properties: {
          date: { type: "string", description: "ISO 8601 date string (e.g. \"2026-06-23\")" },
        },
        required: ["date"],
      },
      output: {
        example: {
          date: "2026-06-23",
          isoYear: 2026, isoWeek: 26, isoDayOfWeek: 2,
          isoNotation: "2026-W26-2",
          dayOfYear: 174, daysInYear: 365, quarter: 2,
        },
      },
    },
    handler: (input) => {
      const d = parseDate(input.date, "date");
      const { isoYear, isoWeek, isoDayOfWeek } = isoWeekData(d);
      const doy = dayOfYear(d);
      const y = d.getUTCFullYear();
      const month = d.getUTCMonth(); // 0-based
      const quarter = Math.floor(month / 3) + 1;

      return {
        date: formatUTCDate(d),
        isoYear,
        isoWeek,
        isoDayOfWeek,
        isoNotation: `${isoYear}-W${pad(isoWeek)}-${isoDayOfWeek}`,
        dayOfYear: doy,
        daysInYear: daysInYear(y),
        quarter,
      };
    },
  },

  // ---------------------------------------------------------------------------
  // 2. leap-year
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/leap-year", name: "Leap year check", slug: "leap-year",
    category: "date-time", price: "$0.001",
    description:
      "Check whether a year is a leap year and get related info: days in that year, the next and previous leap years, and the Gregorian leap-year rule.",
    tags: ["date", "leap-year", "calendar", "gregorian"],
    discovery: {
      bodyType: "json",
      input: { year: 2024 },
      inputSchema: {
        properties: {
          year: { type: "integer", description: "Year to check (1-9999)" },
        },
        required: ["year"],
      },
      output: {
        example: {
          year: 2024, isLeap: true, daysInYear: 366,
          nextLeap: 2028, prevLeap: 2020,
          leapRule: "Divisible by 4, except centuries unless also divisible by 400",
        },
      },
    },
    handler: (input) => {
      const y = Number(input.year);
      if (!Number.isInteger(y) || y < 1 || y > 9999) throw bad('"year" must be an integer between 1 and 9999');

      // Find next leap year after y.
      let nextLeap = y + 1;
      while (!isLeap(nextLeap) && nextLeap <= 9999) nextLeap++;
      if (nextLeap > 9999) nextLeap = null;

      // Find previous leap year before y.
      let prevLeap = y - 1;
      while (!isLeap(prevLeap) && prevLeap >= 1) prevLeap--;
      if (prevLeap < 1) prevLeap = null;

      return {
        year: y,
        isLeap: isLeap(y),
        daysInYear: daysInYear(y),
        nextLeap,
        prevLeap,
        leapRule: "Divisible by 4, except centuries unless also divisible by 400",
      };
    },
  },

  // ---------------------------------------------------------------------------
  // 3. easter-date
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/easter-date", name: "Easter date calculator", slug: "easter-date",
    category: "date-time", price: "$0.001",
    description:
      "Compute the date of Easter Sunday for a given year using the Anonymous Gregorian algorithm (Meeus/Jones/Butcher). Also returns Good Friday, Ash Wednesday, Palm Sunday, Pentecost, and the day-of-year for Easter.",
    tags: ["date", "easter", "holiday", "calendar", "christian", "liturgical"],
    discovery: {
      bodyType: "json",
      input: { year: 2026 },
      inputSchema: {
        properties: {
          year: { type: "integer", description: "Year (1583-9999, Gregorian calendar)" },
        },
        required: ["year"],
      },
      output: {
        example: {
          year: 2026, easter: "2026-04-05",
          goodFriday: "2026-04-03", ashWednesday: "2026-02-18",
          palmSunday: "2026-03-29", pentecost: "2026-05-24",
          dayOfYear: 95,
        },
      },
    },
    handler: (input) => {
      const y = Number(input.year);
      if (!Number.isInteger(y) || y < 1583 || y > 9999)
        throw bad('"year" must be an integer between 1583 and 9999 (Gregorian calendar)');

      const easter = computeEaster(y);

      return {
        year: y,
        easter: formatUTCDate(easter),
        goodFriday: formatUTCDate(addDays(easter, -2)),
        ashWednesday: formatUTCDate(addDays(easter, -46)),
        palmSunday: formatUTCDate(addDays(easter, -7)),
        pentecost: formatUTCDate(addDays(easter, 49)),
        dayOfYear: dayOfYear(easter),
      };
    },
  },

  // ---------------------------------------------------------------------------
  // 4. epoch-convert
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/epoch-convert", name: "Epoch / ISO converter", slug: "epoch-convert",
    category: "date-time", price: "$0.001",
    description:
      "Convert between Unix epoch timestamps and ISO 8601 date strings in both directions. Provide either an epoch (seconds or milliseconds) or an ISO date string. Returns both representations plus UTC and date components.",
    tags: ["date", "epoch", "unix-timestamp", "iso", "utc", "convert"],
    discovery: {
      bodyType: "json",
      input: { epoch: 1782000000 },
      inputSchema: {
        properties: {
          epoch: { type: "number", description: "Unix epoch timestamp (seconds or milliseconds)" },
          date: { type: "string", description: "ISO 8601 date string (alternative to epoch)" },
          unit: { type: "string", description: "\"seconds\" (default) or \"milliseconds\" — interpretation of the epoch value" },
        },
        required: [],
      },
      output: {
        example: {
          epoch: { seconds: 1782000000, milliseconds: 1782000000000 },
          iso: "2026-06-21T00:00:00.000Z",
          utc: "Sun, 21 Jun 2026 00:00:00 GMT",
          components: { year: 2026, month: 6, day: 21, hour: 0, minute: 0, second: 0 },
        },
      },
    },
    handler: (input) => {
      let d;
      if (input.epoch !== undefined && input.epoch !== null) {
        const ep = Number(input.epoch);
        if (!Number.isFinite(ep)) throw bad('"epoch" must be a finite number');
        const unit = (input.unit || "seconds").toLowerCase();
        if (unit !== "seconds" && unit !== "milliseconds")
          throw bad('"unit" must be "seconds" or "milliseconds"');
        const ms = unit === "milliseconds" ? ep : ep * 1000;
        d = new Date(ms);
      } else if (input.date) {
        d = parseDate(input.date, "date");
      } else {
        throw bad('Provide either "epoch" or "date"');
      }

      if (isNaN(d.getTime())) throw bad("Resulting date is invalid");

      const epochMs = d.getTime();
      const epochSec = Math.floor(epochMs / 1000);

      return {
        epoch: { seconds: epochSec, milliseconds: epochMs },
        iso: d.toISOString(),
        utc: d.toUTCString(),
        components: {
          year: d.getUTCFullYear(),
          month: d.getUTCMonth() + 1,
          day: d.getUTCDate(),
          hour: d.getUTCHours(),
          minute: d.getUTCMinutes(),
          second: d.getUTCSeconds(),
        },
      };
    },
  },

  // ---------------------------------------------------------------------------
  // 5. day-of-year
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/day-of-year", name: "Day of year", slug: "day-of-year",
    category: "date-time", price: "$0.001",
    description:
      "Get the day number within the year (1-366) for any date, plus days remaining, leap-year status, percent of year complete, and a simple (Sunday-start) week number.",
    tags: ["date", "day-of-year", "calendar", "progress", "week-number"],
    discovery: {
      bodyType: "json",
      input: { date: "2026-06-23" },
      inputSchema: {
        properties: {
          date: { type: "string", description: "ISO 8601 date string (e.g. \"2026-06-23\")" },
        },
        required: ["date"],
      },
      output: {
        example: {
          date: "2026-06-23",
          dayOfYear: 174, daysRemaining: 191, daysInYear: 365,
          isLeapYear: false,
          percentComplete: 47.7, weekNumber: 26,
        },
      },
    },
    handler: (input) => {
      const d = parseDate(input.date, "date");
      const y = d.getUTCFullYear();
      const doy = dayOfYear(d);
      const total = daysInYear(y);
      const remaining = total - doy;
      const pct = Math.round((doy / total) * 1000) / 10; // 1 decimal

      // Simple Sunday-start week number: week 1 starts on Jan 1.
      // Count the number of Sundays that have occurred on or before this date,
      // then add 1 for the partial first week.
      const jan1 = new Date(Date.UTC(y, 0, 1));
      const jan1Dow = jan1.getUTCDay(); // 0=Sun
      // Days since the first Sunday on or before Jan 1.
      const daysSinceFirstSunday = (doy - 1) + jan1Dow;
      const weekNumber = Math.floor(daysSinceFirstSunday / 7) + 1;

      return {
        date: formatUTCDate(d),
        dayOfYear: doy,
        daysRemaining: remaining,
        daysInYear: total,
        isLeapYear: isLeap(y),
        percentComplete: pct,
        weekNumber,
      };
    },
  },
];
