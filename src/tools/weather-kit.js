// Weather kit — global weather data, keyless and deterministic.
// Wraps Open-Meteo (open-source weather API, no key, global coverage):
//   weather-current     current conditions for any lat/lon on Earth
//   weather-daily       7-day daily forecast (highs, lows, precip, wind, UV)
//   weather-hourly      48-hour hourly forecast (temp, precip, wind, clouds)
//   weather-history     historical daily weather for a date range (up to 1 year)
//   weather-air-quality current air quality index + pollutant breakdown
// Complements the US-only NWS tools (weather-forecast, weather-alerts) in
// data-kit and gov-kit by covering every location worldwide.
// Source: api.open-meteo.com (CC BY 4.0).
import { safeFetch } from "./fetch-guard.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function getJson(url) {
  const { html } = await safeFetch(url, { maxBytes: 2 * 1024 * 1024 });
  try {
    return JSON.parse(html);
  } catch {
    throw bad("Upstream returned non-JSON", 502);
  }
}

function requireCoords(i) {
  const lat = Number(i.lat);
  const lon = Number(i.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw bad('"lat" must be a number between -90 and 90');
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw bad('"lon" must be a number between -180 and 180');
  return { lat, lon };
}

// WMO weather interpretation codes → human-readable condition string.
const WMO_CODES = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snowfall", 73: "Moderate snowfall", 75: "Heavy snowfall",
  77: "Snow grains",
  80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};

function weatherCondition(code) {
  return WMO_CODES[code] ?? `Unknown (${code})`;
}

export const WEATHER_TOOLS = [
  {
    route: "GET /api/weather-current",
    name: "Current weather (global)",
    slug: "weather-current",
    category: "data",
    price: "$0.003",
    description:
      "Current weather conditions for any location on Earth: temperature, feels-like, humidity, wind speed/direction/gusts, precipitation, cloud cover, pressure, and human-readable condition. Open-Meteo, no key, global. ?lat=48.86&lon=2.35.",
    tags: ["weather", "current", "temperature", "wind", "global", "open-meteo"],
    discovery: {
      input: { lat: 48.8566, lon: 2.3522 },
      inputSchema: {
        properties: {
          lat: { type: "number", description: "Latitude, -90 to 90" },
          lon: { type: "number", description: "Longitude, -180 to 180" },
          units: { type: "string", description: "Temperature unit: celsius (default) or fahrenheit" },
        },
        required: ["lat", "lon"],
      },
      output: {
        example: {
          lat: 48.8566, lon: 2.3522,
          current: {
            time: "2026-06-23T14:00",
            temperature: 22.4, feelsLike: 21.8, unit: "°C",
            humidity: 55, precipitation: 0,
            condition: "Partly cloudy", weatherCode: 2,
            cloudCover: 40,
            windSpeed: 12.5, windDirection: 220, windGusts: 18.3, windUnit: "km/h",
            pressure: 1015.2,
            isDay: true,
          },
          source: "api.open-meteo.com (CC BY 4.0)",
        },
      },
    },
    handler: async (i) => {
      const { lat, lon } = requireCoords(i);
      const tempUnit = String(i.units ?? "").toLowerCase() === "fahrenheit" ? "fahrenheit" : "celsius";
      const params = new URLSearchParams({
        latitude: lat, longitude: lon,
        current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
        temperature_unit: tempUnit,
        wind_speed_unit: "kmh",
        timezone: "auto",
      });
      const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`);
      if (!data?.current) throw bad("Open-Meteo returned no current data", 502);
      const c = data.current;
      return {
        lat, lon,
        current: {
          time: c.time ?? null,
          temperature: c.temperature_2m ?? null,
          feelsLike: c.apparent_temperature ?? null,
          unit: tempUnit === "fahrenheit" ? "°F" : "°C",
          humidity: c.relative_humidity_2m ?? null,
          precipitation: c.precipitation ?? 0,
          condition: weatherCondition(c.weather_code),
          weatherCode: c.weather_code ?? null,
          cloudCover: c.cloud_cover ?? null,
          windSpeed: c.wind_speed_10m ?? null,
          windDirection: c.wind_direction_10m ?? null,
          windGusts: c.wind_gusts_10m ?? null,
          windUnit: "km/h",
          pressure: c.pressure_msl ?? null,
          isDay: c.is_day === 1,
        },
        source: "api.open-meteo.com (CC BY 4.0)",
      };
    },
  },
  {
    route: "GET /api/weather-daily",
    name: "Daily forecast (global)",
    slug: "weather-daily",
    category: "data",
    price: "$0.003",
    description:
      "7-day daily weather forecast for any location: high/low temp, precipitation sum and probability, max wind, UV index, sunrise/sunset. Open-Meteo, no key, global. ?lat=35.68&lon=139.69.",
    tags: ["weather", "forecast", "daily", "global", "open-meteo"],
    discovery: {
      input: { lat: 35.6762, lon: 139.6503 },
      inputSchema: {
        properties: {
          lat: { type: "number", description: "Latitude, -90 to 90" },
          lon: { type: "number", description: "Longitude, -180 to 180" },
          days: { type: "number", description: "Forecast days, 1-16 (default 7)" },
          units: { type: "string", description: "Temperature unit: celsius (default) or fahrenheit" },
        },
        required: ["lat", "lon"],
      },
      output: {
        example: {
          lat: 35.6762, lon: 139.6503,
          days: [
            {
              date: "2026-06-23", condition: "Slight rain", weatherCode: 61,
              tempMax: 28.1, tempMin: 21.3, unit: "°C",
              precipSum: 2.4, precipProbability: 65,
              windMax: 15.2, windGusts: 22.1, windUnit: "km/h",
              uvIndex: 7.5, sunrise: "04:25", sunset: "19:01",
            },
          ],
          source: "api.open-meteo.com (CC BY 4.0)",
        },
      },
    },
    handler: async (i) => {
      const { lat, lon } = requireCoords(i);
      const days = Math.min(Math.max(parseInt(i.days, 10) || 7, 1), 16);
      const tempUnit = String(i.units ?? "").toLowerCase() === "fahrenheit" ? "fahrenheit" : "celsius";
      const params = new URLSearchParams({
        latitude: lat, longitude: lon,
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset",
        temperature_unit: tempUnit,
        wind_speed_unit: "kmh",
        timezone: "auto",
        forecast_days: days,
      });
      const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`);
      const d = data?.daily;
      if (!d?.time?.length) throw bad("Open-Meteo returned no daily data", 502);
      const result = d.time.map((date, idx) => ({
        date,
        condition: weatherCondition(d.weather_code?.[idx]),
        weatherCode: d.weather_code?.[idx] ?? null,
        tempMax: d.temperature_2m_max?.[idx] ?? null,
        tempMin: d.temperature_2m_min?.[idx] ?? null,
        unit: tempUnit === "fahrenheit" ? "°F" : "°C",
        precipSum: d.precipitation_sum?.[idx] ?? 0,
        precipProbability: d.precipitation_probability_max?.[idx] ?? null,
        windMax: d.wind_speed_10m_max?.[idx] ?? null,
        windGusts: d.wind_gusts_10m_max?.[idx] ?? null,
        windUnit: "km/h",
        uvIndex: d.uv_index_max?.[idx] ?? null,
        sunrise: d.sunrise?.[idx]?.split("T")[1] ?? null,
        sunset: d.sunset?.[idx]?.split("T")[1] ?? null,
      }));
      return { lat, lon, days: result, source: "api.open-meteo.com (CC BY 4.0)" };
    },
  },
  {
    route: "GET /api/weather-hourly",
    name: "Hourly forecast (global)",
    slug: "weather-hourly",
    category: "data",
    price: "$0.003",
    description:
      "48-hour hourly weather forecast for any location: temperature, precipitation probability and amount, wind, cloud cover, humidity. Open-Meteo, no key, global. ?lat=-33.87&lon=151.21.",
    tags: ["weather", "forecast", "hourly", "global", "open-meteo"],
    discovery: {
      input: { lat: -33.8688, lon: 151.2093 },
      inputSchema: {
        properties: {
          lat: { type: "number", description: "Latitude, -90 to 90" },
          lon: { type: "number", description: "Longitude, -180 to 180" },
          hours: { type: "number", description: "Forecast hours, 1-168 (default 48)" },
          units: { type: "string", description: "Temperature unit: celsius (default) or fahrenheit" },
        },
        required: ["lat", "lon"],
      },
      output: {
        example: {
          lat: -33.8688, lon: 151.2093,
          hours: [
            {
              time: "2026-06-23T14:00", temperature: 18.2, unit: "°C",
              humidity: 62, precipProbability: 10, precipitation: 0,
              condition: "Mainly clear", weatherCode: 1,
              cloudCover: 25, windSpeed: 14.8, windDirection: 195, windUnit: "km/h",
            },
          ],
          source: "api.open-meteo.com (CC BY 4.0)",
        },
      },
    },
    handler: async (i) => {
      const { lat, lon } = requireCoords(i);
      const hours = Math.min(Math.max(parseInt(i.hours, 10) || 48, 1), 168);
      const tempUnit = String(i.units ?? "").toLowerCase() === "fahrenheit" ? "fahrenheit" : "celsius";
      const params = new URLSearchParams({
        latitude: lat, longitude: lon,
        hourly: "temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m",
        temperature_unit: tempUnit,
        wind_speed_unit: "kmh",
        timezone: "auto",
        forecast_hours: hours,
      });
      const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`);
      const h = data?.hourly;
      if (!h?.time?.length) throw bad("Open-Meteo returned no hourly data", 502);
      const result = h.time.map((time, idx) => ({
        time,
        temperature: h.temperature_2m?.[idx] ?? null,
        unit: tempUnit === "fahrenheit" ? "°F" : "°C",
        humidity: h.relative_humidity_2m?.[idx] ?? null,
        precipProbability: h.precipitation_probability?.[idx] ?? null,
        precipitation: h.precipitation?.[idx] ?? 0,
        condition: weatherCondition(h.weather_code?.[idx]),
        weatherCode: h.weather_code?.[idx] ?? null,
        cloudCover: h.cloud_cover?.[idx] ?? null,
        windSpeed: h.wind_speed_10m?.[idx] ?? null,
        windDirection: h.wind_direction_10m?.[idx] ?? null,
        windUnit: "km/h",
      }));
      return { lat, lon, hours: result, source: "api.open-meteo.com (CC BY 4.0)" };
    },
  },
  {
    route: "GET /api/weather-history",
    name: "Historical weather (global)",
    slug: "weather-history",
    category: "data",
    price: "$0.005",
    description:
      "Historical daily weather for any location and date range (up to 1 year): high/low temp, precipitation, wind, conditions. Open-Meteo archive, no key, global. Data from 1940 to 5 days ago. ?lat=51.51&lon=-0.13&start=2025-06-01&end=2025-06-07.",
    tags: ["weather", "historical", "archive", "climate", "global", "open-meteo"],
    discovery: {
      input: { lat: 51.5074, lon: -0.1278, start: "2025-06-01", end: "2025-06-07" },
      inputSchema: {
        properties: {
          lat: { type: "number", description: "Latitude, -90 to 90" },
          lon: { type: "number", description: "Longitude, -180 to 180" },
          start: { type: "string", description: "Start date, YYYY-MM-DD" },
          end: { type: "string", description: "End date, YYYY-MM-DD (max 1 year from start)" },
          units: { type: "string", description: "Temperature unit: celsius (default) or fahrenheit" },
        },
        required: ["lat", "lon", "start", "end"],
      },
      output: {
        example: {
          lat: 51.5074, lon: -0.1278,
          days: [
            {
              date: "2025-06-01", condition: "Slight rain", weatherCode: 61,
              tempMax: 19.8, tempMin: 12.1, unit: "°C",
              precipSum: 3.2, windMax: 18.4, windUnit: "km/h",
            },
          ],
          source: "api.open-meteo.com (CC BY 4.0)",
        },
      },
    },
    handler: async (i) => {
      const { lat, lon } = requireCoords(i);
      const start = String(i.start ?? "").trim();
      const end = String(i.end ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw bad('"start" must be YYYY-MM-DD');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw bad('"end" must be YYYY-MM-DD');
      const startDate = new Date(start);
      const endDate = new Date(end);
      if (isNaN(startDate.getTime())) throw bad('"start" is not a valid date');
      if (isNaN(endDate.getTime())) throw bad('"end" is not a valid date');
      if (endDate < startDate) throw bad('"end" must be on or after "start"');
      if ((endDate - startDate) / 86400000 > 366) throw bad("Date range must be 1 year or less");
      const tempUnit = String(i.units ?? "").toLowerCase() === "fahrenheit" ? "fahrenheit" : "celsius";
      const params = new URLSearchParams({
        latitude: lat, longitude: lon,
        start_date: start, end_date: end,
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
        temperature_unit: tempUnit,
        wind_speed_unit: "kmh",
        timezone: "auto",
      });
      const data = await getJson(`https://archive-api.open-meteo.com/v1/archive?${params}`);
      const d = data?.daily;
      if (!d?.time?.length) throw bad("Open-Meteo returned no historical data", 502);
      const result = d.time.map((date, idx) => ({
        date,
        condition: weatherCondition(d.weather_code?.[idx]),
        weatherCode: d.weather_code?.[idx] ?? null,
        tempMax: d.temperature_2m_max?.[idx] ?? null,
        tempMin: d.temperature_2m_min?.[idx] ?? null,
        unit: tempUnit === "fahrenheit" ? "°F" : "°C",
        precipSum: d.precipitation_sum?.[idx] ?? 0,
        windMax: d.wind_speed_10m_max?.[idx] ?? null,
        windUnit: "km/h",
      }));
      return { lat, lon, days: result, source: "api.open-meteo.com (CC BY 4.0)" };
    },
  },
  {
    route: "GET /api/weather-air-quality",
    name: "Air quality (global)",
    slug: "weather-air-quality",
    category: "data",
    price: "$0.003",
    description:
      "Current air quality index and pollutant concentrations for any location: US AQI, PM2.5, PM10, ozone, NO2, SO2, CO. Open-Meteo air quality API, no key, global. ?lat=28.61&lon=77.23.",
    tags: ["weather", "air-quality", "aqi", "pollution", "pm25", "global", "open-meteo"],
    discovery: {
      input: { lat: 28.6139, lon: 77.2090 },
      inputSchema: {
        properties: {
          lat: { type: "number", description: "Latitude, -90 to 90" },
          lon: { type: "number", description: "Longitude, -180 to 180" },
        },
        required: ["lat", "lon"],
      },
      output: {
        example: {
          lat: 28.6139, lon: 77.2090,
          airQuality: {
            time: "2026-06-23T14:00",
            usAqi: 142,
            category: "Unhealthy for Sensitive Groups",
            pm25: 52.3, pm10: 88.1,
            ozone: 45.2, nitrogenDioxide: 28.7,
            sulphurDioxide: 12.4, carbonMonoxide: 420,
            units: { pm: "μg/m³", gases: "μg/m³" },
          },
          source: "air-quality-api.open-meteo.com (CC BY 4.0)",
        },
      },
    },
    handler: async (i) => {
      const { lat, lon } = requireCoords(i);
      const params = new URLSearchParams({
        latitude: lat, longitude: lon,
        current: "us_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone",
      });
      const data = await getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`);
      if (!data?.current) throw bad("Open-Meteo returned no air quality data", 502);
      const c = data.current;
      const aqi = c.us_aqi ?? null;
      let category = "Unknown";
      if (aqi !== null) {
        if (aqi <= 50) category = "Good";
        else if (aqi <= 100) category = "Moderate";
        else if (aqi <= 150) category = "Unhealthy for Sensitive Groups";
        else if (aqi <= 200) category = "Unhealthy";
        else if (aqi <= 300) category = "Very Unhealthy";
        else category = "Hazardous";
      }
      return {
        lat, lon,
        airQuality: {
          time: c.time ?? null,
          usAqi: aqi,
          category,
          pm25: c.pm2_5 ?? null,
          pm10: c.pm10 ?? null,
          ozone: c.ozone ?? null,
          nitrogenDioxide: c.nitrogen_dioxide ?? null,
          sulphurDioxide: c.sulphur_dioxide ?? null,
          carbonMonoxide: c.carbon_monoxide ?? null,
          units: { pm: "μg/m³", gases: "μg/m³" },
        },
        source: "air-quality-api.open-meteo.com (CC BY 4.0)",
      };
    },
  },
];
