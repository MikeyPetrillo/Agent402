// Weather tools pass a missing precipitation value through as null: a gap in
// the upstream's arrays is "no reading", never a measured 0 mm. Offline:
// DNS and fetch are answered locally with bodies shaped like the forecast and
// archive APIs.
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
dnsPromises.lookup = async () => ({ address: "1.1.1.1", family: 4 });
syncBuiltinESMExports();
const { WEATHER_TOOLS } = await import("../src/tools/weather-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const h = (slug) => WEATHER_TOOLS.find((t) => t.slug === slug).handler;

const bodies = {
  current: { current: { time: "2026-10-19T12:00", temperature_2m: 14.2, relative_humidity_2m: 70, apparent_temperature: 13.1, is_day: 1, precipitation: null, weather_code: 3, cloud_cover: 90, pressure_msl: 1012, wind_speed_10m: 10, wind_direction_10m: 200, wind_gusts_10m: 20 } },
  daily: { daily: { time: ["2026-10-19", "2026-10-20"], weather_code: [3, 61], temperature_2m_max: [16, 15], temperature_2m_min: [9, 8], precipitation_sum: [null, 2.4], precipitation_probability_max: [null, 65], wind_speed_10m_max: [12, 14], wind_gusts_10m_max: [25, 30], uv_index_max: [2, 1], sunrise: ["2026-10-19T07:30", "2026-10-20T07:31"], sunset: ["2026-10-19T18:20", "2026-10-20T18:18"] } },
  hourly: { hourly: { time: ["2026-10-19T12:00", "2026-10-19T13:00"], temperature_2m: [14, 15], relative_humidity_2m: [70, 68], precipitation_probability: [10, null], precipitation: [null, 0.4], weather_code: [3, 61], cloud_cover: [90, 95], wind_speed_10m: [10, 11], wind_direction_10m: [200, 210] } },
  archive: { daily: { time: ["2025-06-01", "2025-06-02"], weather_code: [1, 61], temperature_2m_max: [20, 18], temperature_2m_min: [11, 10], precipitation_sum: [null, 3.2], wind_speed_10m_max: [15, 18] } },
};
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const p = u.searchParams;
  const body = u.hostname.startsWith("archive") ? bodies.archive : p.has("current") ? bodies.current : p.has("hourly") ? bodies.hourly : bodies.daily;
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

const cur = await h("weather-current")({ lat: 48.86, lon: 2.35 });
ok(cur.current.precipitation === null, `weather-current: missing precipitation is null (got ${cur.current.precipitation})`);
const daily = await h("weather-daily")({ lat: 35.68, lon: 139.69 });
const d0 = (daily.days || daily.forecast || [])[0];
ok(d0 && d0.precipSum === null, `weather-daily: missing precipitation sum is null (got ${d0?.precipSum})`);
const d1 = (daily.days || daily.forecast || [])[1];
ok(d1 && d1.precipSum === 2.4, "weather-daily: a reported sum is kept");
const hourly = await h("weather-hourly")({ lat: -33.87, lon: 151.21 });
const h0 = (hourly.hours || hourly.forecast || [])[0];
ok(h0 && h0.precipitation === null, `weather-hourly: missing precipitation is null (got ${h0?.precipitation})`);
const hist = await h("weather-history")({ lat: 51.51, lon: -0.13, start: "2025-06-01", end: "2025-06-02" });
ok(hist.days[0].precipSum === null && hist.days[1].precipSum === 3.2, `weather-history: missing sum is null, a reported one kept (got ${hist.days[0].precipSum}, ${hist.days[1].precipSum})`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
