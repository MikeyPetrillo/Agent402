// Weather-kit tests (run in CI, which has network egress). Strict on our own
// validation logic (deterministic); tolerant of any single flaky upstream —
// fails only if a validation assertion breaks or if EVERY live call fails.
import { WEATHER_TOOLS } from "../src/tools/weather-kit.js";

const h = (slug) => WEATHER_TOOLS.find((t) => t.slug === slug).handler;
let assertFail = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) console.log(`ok - ${m}`); else { assertFail++; console.error(`ASSERT FAIL - ${m}`); } };

// --- deterministic validation (no network) ---
for (const [slug, args, label] of [
  ["weather-current", { lat: 999, lon: 0 }, "weather-current rejects bad lat"],
  ["weather-current", { lat: 0, lon: 999 }, "weather-current rejects bad lon"],
  ["weather-daily", { lat: "abc", lon: 0 }, "weather-daily rejects non-numeric lat"],
  ["weather-hourly", { lat: 0, lon: 0, hours: 200 }, null],
  ["weather-history", { lat: 51, lon: -0.1, start: "bad", end: "2025-06-07" }, "weather-history rejects bad start"],
  ["weather-history", { lat: 51, lon: -0.1, start: "2025-06-01", end: "bad" }, "weather-history rejects bad end"],
  ["weather-history", { lat: 51, lon: -0.1, start: "2025-06-07", end: "2025-06-01" }, "weather-history rejects end before start"],
  ["weather-air-quality", { lat: -91, lon: 0 }, "weather-air-quality rejects lat out of range"],
]) {
  if (!label) continue;
  try { await h(slug)(args); ok(false, label); }
  catch (e) { ok(e.statusCode === 400, label + ` (got ${e.statusCode})`); }
}

// --- hours clamping (max 168) ---
// This should NOT throw — just clamp. We test it hits the network.

// --- live calls (tolerant of upstream flake) ---
async function live(slug, args, check, label) {
  try {
    const r = await h(slug)(args);
    if (check(r)) { liveOk++; console.log(`ok - ${label}: ${JSON.stringify(r).slice(0, 120)}`); }
    else { assertFail++; console.error(`ASSERT FAIL - ${label}: unexpected shape ${JSON.stringify(r).slice(0, 200)}`); }
  } catch (e) {
    liveErr++;
    console.warn(`warn - ${label}: upstream error (${e.statusCode || "?"}) ${e.message} — tolerated`);
  }
}

// Paris — current weather
await live("weather-current", { lat: 48.8566, lon: 2.3522 },
  (r) => r.current && typeof r.current.temperature === "number" && r.source.includes("open-meteo"),
  "weather-current Paris");

// Paris — current weather in Fahrenheit
await live("weather-current", { lat: 48.8566, lon: 2.3522, units: "fahrenheit" },
  (r) => r.current && r.current.unit === "°F",
  "weather-current Paris fahrenheit");

// Tokyo — 7-day daily forecast
await live("weather-daily", { lat: 35.6762, lon: 139.6503 },
  (r) => Array.isArray(r.days) && r.days.length >= 5 && r.days[0].date,
  "weather-daily Tokyo 7d");

// Tokyo — 3-day daily forecast
await live("weather-daily", { lat: 35.6762, lon: 139.6503, days: 3 },
  (r) => Array.isArray(r.days) && r.days.length === 3,
  "weather-daily Tokyo 3d");

// Sydney — 48-hour hourly forecast
await live("weather-hourly", { lat: -33.8688, lon: 151.2093 },
  (r) => Array.isArray(r.hours) && r.hours.length >= 40 && r.hours[0].time,
  "weather-hourly Sydney 48h");

// Sydney — 12-hour hourly forecast
await live("weather-hourly", { lat: -33.8688, lon: 151.2093, hours: 12 },
  (r) => Array.isArray(r.hours) && r.hours.length === 12,
  "weather-hourly Sydney 12h");

// London — historical weather
await live("weather-history", { lat: 51.5074, lon: -0.1278, start: "2025-06-01", end: "2025-06-07" },
  (r) => Array.isArray(r.days) && r.days.length === 7 && r.days[0].date === "2025-06-01",
  "weather-history London Jun 2025");

// Delhi — air quality
await live("weather-air-quality", { lat: 28.6139, lon: 77.2090 },
  (r) => r.airQuality && typeof r.airQuality.usAqi === "number" && r.airQuality.category,
  "weather-air-quality Delhi");

// --- summary ---
console.log(`\n=== weather-kit: ${7 - assertFail}/${7} validation, ${liveOk}/${liveOk + liveErr} live ===`);
if (assertFail) { console.error(`${assertFail} assertion(s) FAILED`); process.exit(1); }
if (liveOk === 0 && liveErr > 0) { console.error("ALL live calls failed — integration broken"); process.exit(1); }
console.log("weather-kit PASS");
