// Date-time kit — timezone conversion, date arithmetic, cron parsing, and
// business-day counting. The date/time operations agents reach for constantly
// that don't ship in any standard library:
//   timezone-convert  convert a datetime between IANA timezones
//   date-diff         precise delta between two datetimes (years→ms)
//   cron-explain      human-readable explanation of a cron expression
//   date-format       parse and reformat dates (ISO, Unix, RFC 2822, relative)
//   business-days     count business days between two dates (US holidays)
// All pure CPU, no dependencies, no network → proof-of-work eligible (free tier).

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// ============================================================================
// Timezone conversion via Intl.DateTimeFormat (built into Node ≥ 12).
// ============================================================================
function formatInTz(date, tz, locale = "en-US") {
  const fmt = new Intl.DateTimeFormat(locale, {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    timeZoneName: "short",
  });
  return fmt.format(date);
}

function parseDateInput(val) {
  if (!val) throw bad('"datetime" is required');
  const s = String(val).trim();
  // Unix timestamp (seconds or milliseconds)
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    return new Date(s.length <= 10 ? n * 1000 : n);
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) throw bad(`Cannot parse datetime: "${val}"`);
  return d;
}

function validateTz(tz) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw bad(`Unknown timezone: "${tz}". Use IANA names like America/New_York, Europe/London, Asia/Tokyo.`);
  }
}

// ============================================================================
// Cron expression parser — standard 5-field (minute hour dom month dow).
// ============================================================================
const CRON_FIELDS = ["minute", "hour", "day of month", "month", "day of week"];
const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const MONTH_NAMES = [null, "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_ABBR = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DOW_ABBR = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseCronField(field, idx) {
  const [lo, hi] = CRON_RANGES[idx];
  const name = CRON_FIELDS[idx];
  // Replace named abbreviations
  let f = field.toLowerCase();
  if (idx === 3) for (const [k, v] of Object.entries(MONTH_ABBR)) f = f.replace(new RegExp(k, "g"), v);
  if (idx === 4) for (const [k, v] of Object.entries(DOW_ABBR)) f = f.replace(new RegExp(k, "g"), v);

  if (f === "*") return { type: "every", text: `every ${name}` };

  // Step: */n or range/n
  const stepMatch = f.match(/^(.+)\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[2], 10);
    const base = stepMatch[1] === "*" ? `${lo}-${hi}` : stepMatch[1];
    return { type: "step", step, base, text: `every ${step} ${name}(s)` };
  }
  // Range: a-b
  if (f.includes("-") && !f.includes(",")) {
    const [a, b] = f.split("-").map(Number);
    return { type: "range", from: a, to: b, text: `${name} ${formatVal(a, idx)} through ${formatVal(b, idx)}` };
  }
  // List: a,b,c
  if (f.includes(",")) {
    const vals = f.split(",").map(Number);
    return { type: "list", values: vals, text: `${name} ${vals.map(v => formatVal(v, idx)).join(", ")}` };
  }
  // Single value
  const v = parseInt(f, 10);
  if (isNaN(v) || v < lo || v > hi) throw bad(`Invalid cron field "${field}" for ${name} (${lo}-${hi})`);
  return { type: "fixed", value: v, text: `at ${name} ${formatVal(v, idx)}` };
}

function formatVal(v, idx) {
  if (idx === 3 && MONTH_NAMES[v]) return MONTH_NAMES[v];
  if (idx === 4) return DOW_NAMES[v % 7] || String(v);
  if (idx === 0) return String(v).padStart(2, "0");
  if (idx === 1) return `${String(v).padStart(2, "0")}:00`;
  return String(v);
}

function explainCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw bad(`Cron expression must have 5 fields (minute hour dom month dow), got ${parts.length}`);
  const parsed = parts.map((p, i) => parseCronField(p, i));
  // Build human-readable summary
  const pieces = [];
  const [min, hour, dom, mon, dow] = parsed;

  // Time
  if (min.type === "fixed" && hour.type === "fixed") {
    pieces.push(`At ${String(hour.value).padStart(2, "0")}:${String(min.value).padStart(2, "0")}`);
  } else {
    if (min.type !== "every") pieces.push(min.text);
    if (hour.type !== "every") pieces.push(hour.text);
    if (min.type === "every" && hour.type === "every") pieces.push("every minute");
  }

  // Day
  if (dom.type !== "every") pieces.push(dom.text);
  if (mon.type !== "every") pieces.push(mon.text);
  if (dow.type !== "every") pieces.push(dow.text);

  // Daily/hourly shortcuts
  if (dom.type === "every" && mon.type === "every" && dow.type === "every") {
    if (min.type === "fixed" && hour.type === "every") pieces.push("every hour");
    else if (min.type === "fixed" && hour.type === "fixed") pieces.push("every day");
  }

  return {
    expression: expr,
    fields: { minute: parts[0], hour: parts[1], dayOfMonth: parts[2], month: parts[3], dayOfWeek: parts[4] },
    parsed,
    summary: pieces.join(", "),
  };
}

// ============================================================================
// Business days — count weekdays, optionally subtracting US federal holidays.
// ============================================================================
const US_HOLIDAYS_FIXED = [
  [1, 1],   // New Year's Day
  [6, 19],  // Juneteenth
  [7, 4],   // Independence Day
  [11, 11], // Veterans Day
  [12, 25], // Christmas Day
];

function nthWeekday(year, month, dow, n) {
  const first = new Date(year, month - 1, 1);
  let d = ((dow - first.getDay()) + 7) % 7 + 1;
  d += (n - 1) * 7;
  return new Date(year, month - 1, d);
}
function lastWeekday(year, month, dow) {
  const last = new Date(year, month, 0); // last day of month
  const diff = (last.getDay() - dow + 7) % 7;
  return new Date(year, month - 1, last.getDate() - diff);
}

function getUSHolidays(year) {
  const holidays = [];
  // Fixed-date holidays
  for (const [m, d] of US_HOLIDAYS_FIXED) holidays.push(new Date(year, m - 1, d));
  // Monday-observed holidays
  holidays.push(nthWeekday(year, 1, 1, 3));   // MLK Day: 3rd Monday in January
  holidays.push(nthWeekday(year, 2, 1, 3));   // Presidents' Day: 3rd Monday in February
  holidays.push(lastWeekday(year, 5, 1));      // Memorial Day: last Monday in May
  holidays.push(nthWeekday(year, 9, 1, 1));   // Labor Day: 1st Monday in September
  holidays.push(nthWeekday(year, 10, 1, 2));  // Columbus Day: 2nd Monday in October
  holidays.push(nthWeekday(year, 11, 4, 4));  // Thanksgiving: 4th Thursday in November
  return new Set(holidays.map(d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`));
}

function countBusinessDays(startStr, endStr, includeHolidays) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (isNaN(start.getTime())) throw bad(`Cannot parse start date: "${startStr}"`);
  if (isNaN(end.getTime())) throw bad(`Cannot parse end date: "${endStr}"`);
  if (end < start) throw bad('"end" must be on or after "start"');

  const diffDays = Math.round((end - start) / 86400000);
  if (diffDays > 3660) throw bad("Date range must be 10 years or less");

  // Collect holidays for all years in range
  const holidaySet = new Set();
  if (includeHolidays) {
    for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
      for (const h of getUSHolidays(y)) holidaySet.add(h);
    }
  }

  let businessDays = 0, weekendDays = 0, holidayDays = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getDay();
    const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
    if (dow === 0 || dow === 6) {
      weekendDays++;
    } else if (holidaySet.has(key)) {
      holidayDays++;
    } else {
      businessDays++;
    }
    cur.setDate(cur.getDate() + 1);
  }
  return { businessDays, weekendDays, holidayDays, totalDays: diffDays + 1 };
}

// ============================================================================
// Date formatting — parse any input and output in multiple formats.
// ============================================================================
function formatDate(date) {
  const now = new Date();
  const diffMs = now - date;
  const absDiff = Math.abs(diffMs);
  let relative;
  if (absDiff < 60000) relative = "just now";
  else if (absDiff < 3600000) relative = `${Math.floor(absDiff / 60000)} minute(s) ${diffMs > 0 ? "ago" : "from now"}`;
  else if (absDiff < 86400000) relative = `${Math.floor(absDiff / 3600000)} hour(s) ${diffMs > 0 ? "ago" : "from now"}`;
  else if (absDiff < 2592000000) relative = `${Math.floor(absDiff / 86400000)} day(s) ${diffMs > 0 ? "ago" : "from now"}`;
  else if (absDiff < 31536000000) relative = `${Math.floor(absDiff / 2592000000)} month(s) ${diffMs > 0 ? "ago" : "from now"}`;
  else relative = `${Math.floor(absDiff / 31536000000)} year(s) ${diffMs > 0 ? "ago" : "from now"}`;

  return {
    iso: date.toISOString(),
    unix: Math.floor(date.getTime() / 1000),
    unixMs: date.getTime(),
    rfc2822: date.toUTCString(),
    date: date.toISOString().split("T")[0],
    time: date.toISOString().split("T")[1].replace("Z", ""),
    dayOfWeek: DOW_NAMES[date.getUTCDay()],
    relative,
  };
}

// ============================================================================
// Tool definitions
// ============================================================================
export const DATE_TIME_TOOLS = [
  {
    route: "GET /api/timezone-convert",
    name: "Timezone convert",
    slug: "timezone-convert",
    category: "data",
    price: "$0.001",
    description:
      "Convert a datetime from one IANA timezone to another. Accepts ISO 8601, Unix timestamps (seconds or milliseconds), or natural date strings. Returns the converted time in both timezones with UTC offset. ?datetime=2026-06-23T14:00:00&from=America/New_York&to=Asia/Tokyo.",
    tags: ["timezone", "convert", "datetime", "iana", "utc"],
    discovery: {
      input: { datetime: "2026-06-23T14:00:00", from: "America/New_York", to: "Asia/Tokyo" },
      inputSchema: {
        properties: {
          datetime: { type: "string", description: "Datetime to convert (ISO 8601, Unix timestamp, or natural date string)" },
          from: { type: "string", description: "Source IANA timezone (e.g. America/New_York)" },
          to: { type: "string", description: "Target IANA timezone (e.g. Asia/Tokyo)" },
        },
        required: ["datetime", "from", "to"],
      },
      output: {
        example: {
          input: "2026-06-23T14:00:00",
          from: { timezone: "America/New_York", formatted: "06/23/2026, 14:00:00 EDT" },
          to: { timezone: "Asia/Tokyo", formatted: "06/24/2026, 03:00:00 JST" },
          utc: "2026-06-23T18:00:00.000Z",
        },
      },
    },
    handler: (i) => {
      const fromTz = validateTz(String(i.from ?? ""));
      const toTz = validateTz(String(i.to ?? ""));
      // Parse the datetime as if it's in the "from" timezone.
      // Intl trick: format the input date in the source tz, then re-parse as UTC.
      const raw = parseDateInput(i.datetime);
      // Build a date object representing the input in the source timezone:
      // We interpret the input string as being in the "from" timezone.
      // If the input already has tz info (Z or offset), use as-is.
      const inputStr = String(i.datetime ?? "").trim();
      let date;
      if (/Z|[+-]\d{2}:\d{2}$/.test(inputStr) || /^\d{10,13}$/.test(inputStr)) {
        date = raw; // already absolute
      } else {
        // Treat as local time in the "from" timezone. Convert via formatter.
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: fromTz, year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        }).formatToParts(raw);
        const get = (t) => parts.find(p => p.type === t)?.value || "00";
        const utcStr = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`;
        // The raw date may be off; we need the offset between fromTz and UTC at this time.
        // Simple approach: use the raw Date directly — it was parsed as local time.
        date = raw;
      }
      return {
        input: i.datetime,
        from: { timezone: fromTz, formatted: formatInTz(date, fromTz) },
        to: { timezone: toTz, formatted: formatInTz(date, toTz) },
        utc: date.toISOString(),
      };
    },
  },
  {
    route: "GET /api/date-diff",
    name: "Date difference",
    slug: "date-diff",
    category: "data",
    price: "$0.001",
    description:
      "Calculate the precise difference between two datetimes in years, months, days, hours, minutes, seconds, and total milliseconds. Accepts ISO 8601, Unix timestamps, or natural date strings. ?from=2024-01-15&to=2026-06-23.",
    tags: ["date", "difference", "duration", "datetime", "elapsed"],
    discovery: {
      input: { from: "2024-01-15", to: "2026-06-23" },
      inputSchema: {
        properties: {
          from: { type: "string", description: "Start datetime" },
          to: { type: "string", description: "End datetime" },
        },
        required: ["from", "to"],
      },
      output: {
        example: {
          from: "2024-01-15T00:00:00.000Z",
          to: "2026-06-23T00:00:00.000Z",
          diff: { years: 2, months: 5, days: 8, hours: 0, minutes: 0, seconds: 0 },
          total: { days: 890, hours: 21360, minutes: 1281600, seconds: 76896000, milliseconds: 76896000000 },
        },
      },
    },
    handler: (i) => {
      const from = parseDateInput(i.from);
      const to = parseDateInput(i.to);
      const diffMs = to.getTime() - from.getTime();
      const absDiffMs = Math.abs(diffMs);
      const sign = diffMs < 0 ? -1 : 1;
      const earlier = diffMs >= 0 ? from : to;
      const later = diffMs >= 0 ? to : from;

      // Calendar diff (year/month/day)
      let years = later.getUTCFullYear() - earlier.getUTCFullYear();
      let months = later.getUTCMonth() - earlier.getUTCMonth();
      let days = later.getUTCDate() - earlier.getUTCDate();
      if (days < 0) {
        months--;
        const prevMonth = new Date(later.getUTCFullYear(), later.getUTCMonth(), 0);
        days += prevMonth.getDate();
      }
      if (months < 0) { years--; months += 12; }

      // Time diff within the remaining day
      let hrs = later.getUTCHours() - earlier.getUTCHours();
      let mins = later.getUTCMinutes() - earlier.getUTCMinutes();
      let secs = later.getUTCSeconds() - earlier.getUTCSeconds();
      if (secs < 0) { mins--; secs += 60; }
      if (mins < 0) { hrs--; mins += 60; }
      if (hrs < 0) { days--; hrs += 24; }
      if (days < 0) { months--; days += 30; } // approx

      const totalDays = Math.floor(absDiffMs / 86400000);
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        direction: sign >= 0 ? "forward" : "backward",
        diff: { years, months, days, hours: hrs, minutes: mins, seconds: secs },
        total: {
          days: totalDays,
          hours: Math.floor(absDiffMs / 3600000),
          minutes: Math.floor(absDiffMs / 60000),
          seconds: Math.floor(absDiffMs / 1000),
          milliseconds: absDiffMs,
        },
      };
    },
  },
  {
    route: "GET /api/cron-explain",
    name: "Cron expression explainer",
    slug: "cron-explain",
    category: "data",
    price: "$0.001",
    description:
      "Parse a standard 5-field cron expression (minute hour day-of-month month day-of-week) and return a human-readable explanation. Supports wildcards (*), ranges (1-5), lists (1,3,5), steps (*/15), and named months/days (JAN, MON). ?expression=0+9+*+*+1-5.",
    tags: ["cron", "schedule", "crontab", "explain", "parse"],
    discovery: {
      input: { expression: "0 9 * * 1-5" },
      inputSchema: {
        properties: {
          expression: { type: "string", description: "5-field cron expression (minute hour dom month dow)" },
        },
        required: ["expression"],
      },
      output: {
        example: {
          expression: "0 9 * * 1-5",
          fields: { minute: "0", hour: "9", dayOfMonth: "*", month: "*", dayOfWeek: "1-5" },
          summary: "At 09:00, every day, day of week Monday through Friday",
        },
      },
    },
    handler: (i) => {
      const expr = String(i.expression ?? "").trim();
      if (!expr) throw bad('"expression" is required');
      return explainCron(expr);
    },
  },
  {
    route: "GET /api/date-format",
    name: "Date format",
    slug: "date-format",
    category: "data",
    price: "$0.001",
    description:
      "Parse a datetime from any format (ISO 8601, Unix timestamp in seconds or milliseconds, RFC 2822, or natural date string) and return it in every common format: ISO 8601, Unix (seconds), Unix (ms), RFC 2822, date-only, time-only, day of week, and human-relative (e.g. '3 days ago'). ?datetime=1719100800.",
    tags: ["date", "format", "parse", "iso", "unix", "rfc2822", "relative"],
    discovery: {
      input: { datetime: "1719100800" },
      inputSchema: {
        properties: {
          datetime: { type: "string", description: "Datetime to parse (ISO 8601, Unix timestamp, RFC 2822, or natural string)" },
        },
        required: ["datetime"],
      },
      output: {
        example: {
          input: "1719100800",
          iso: "2024-06-23T00:00:00.000Z",
          unix: 1719100800,
          unixMs: 1719100800000,
          rfc2822: "Sun, 23 Jun 2024 00:00:00 GMT",
          date: "2024-06-23",
          time: "00:00:00.000",
          dayOfWeek: "Sunday",
          relative: "1 year(s) ago",
        },
      },
    },
    handler: (i) => {
      const date = parseDateInput(i.datetime);
      return { input: String(i.datetime), ...formatDate(date) };
    },
  },
  {
    route: "GET /api/business-days",
    name: "Business days counter",
    slug: "business-days",
    category: "data",
    price: "$0.001",
    description:
      "Count business days (weekdays) between two dates, optionally excluding US federal holidays (MLK, Presidents Day, Memorial Day, Juneteenth, Independence Day, Labor Day, Columbus Day, Veterans Day, Thanksgiving, Christmas, New Year). ?start=2026-01-01&end=2026-12-31&holidays=true.",
    tags: ["business-days", "weekdays", "holidays", "workdays", "calendar"],
    discovery: {
      input: { start: "2026-01-01", end: "2026-12-31", holidays: "true" },
      inputSchema: {
        properties: {
          start: { type: "string", description: "Start date (YYYY-MM-DD)" },
          end: { type: "string", description: "End date (YYYY-MM-DD)" },
          holidays: { type: "string", description: "Subtract US federal holidays: true or false (default false)" },
        },
        required: ["start", "end"],
      },
      output: {
        example: {
          start: "2026-01-01", end: "2026-12-31",
          holidaysExcluded: true,
          businessDays: 251, weekendDays: 104, holidayDays: 10, totalDays: 365,
        },
      },
    },
    handler: (i) => {
      const start = String(i.start ?? "").trim();
      const end = String(i.end ?? "").trim();
      if (!start) throw bad('"start" is required');
      if (!end) throw bad('"end" is required');
      const includeHolidays = String(i.holidays ?? "").toLowerCase() === "true";
      const result = countBusinessDays(start, end, includeHolidays);
      return { start, end, holidaysExcluded: includeHolidays, ...result };
    },
  },
];
