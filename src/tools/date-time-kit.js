// Date-time kit — timezone conversion and date formatting:
//   timezone-convert  convert a datetime between IANA timezones
//   date-format       parse and reformat dates (ISO, Unix, RFC 2822, relative)
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

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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
        // Naive datetime: interpret its wall-clock digits as local time in `fromTz`
        // and resolve to the correct absolute instant. Treat the digits as UTC, see
        // what wall-clock that instant shows in fromTz, and correct by the resulting
        // offset. (Previously it discarded this and used the server-local parse, so
        // the input was read in whatever zone the host ran in — wrong on prod/UTC.)
        const asUtc = new Date(`${inputStr.replace(" ", "T")}Z`);
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: fromTz, year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        }).formatToParts(asUtc);
        const get = (t) => parts.find((p) => p.type === t)?.value || "00";
        const tzWall = Date.UTC(+get("year"), +get("month") - 1, +get("day"), +get("hour") % 24, +get("minute"), +get("second"));
        const offset = tzWall - asUtc.getTime();
        date = new Date(asUtc.getTime() - offset);
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
  
];
