// Weather probability kit: forecast probabilities from ensemble members,
// deterministic code over Open-Meteo's ensemble API (CC BY 4.0).
//   weather-probability      P(a daily value meets a threshold or falls in a
//                            range) for one place and date
//   weather-market-brackets  the same for a ladder of brackets the CALLER
//                            sends, each beside the market price the caller sent
//   weather-market-board     one date, many cities: the ensemble spread and a
//                            bracket ladder per city
//
// A probability here is a count: the share of ensemble members (51 from the
// ECMWF IFS ensemble, 31 from NOAA's GEFS) whose daily value meets the
// condition. It is raw model output at the model grid point, not calibrated
// to any station, and every answer says so.
//
// Market prices: this kit reads NO market feed. A bracket's price is a number
// the caller passes in, echoed beside the forecast probability as two facts.
// No field compares them and no text rates one against the other.
import { markEndsAtCeiling } from "../run-ceiling.js";
import { OPEN_METEO_ATTRIBUTION } from "../data-attribution.js";
import { bad, openMeteoJson, resolveLocation, requireCoords, locationFields, tempUnitOf, LOCATION_PROPERTIES } from "./weather-kit.js";

export const ENSEMBLE_SOURCE = "computed from Open-Meteo ensemble data, ensemble-api.open-meteo.com (CC BY 4.0)";
export const ENSEMBLE_METHOD = "Each probability is the share of ensemble members whose value for the date meets the condition. Raw model output at the model grid point, not calibrated to a weather station.";
export const MARKET_PRICE_NOTE = "marketPrice is the number the caller sent for that bracket, shown beside forecastProbability. This tool reads no market feed and makes no comparison or recommendation.";

// The daily values this kit computes, each from one hourly ensemble variable.
const VARIABLES = Object.freeze({
  temperature_max: { hourly: "temperature_2m", agg: "max", kind: "temperature" },
  temperature_min: { hourly: "temperature_2m", agg: "min", kind: "temperature" },
  temperature_mean: { hourly: "temperature_2m", agg: "mean", kind: "temperature" },
  precipitation_sum: { hourly: "precipitation", agg: "sum", kind: "precipitation" },
  wind_speed_max: { hourly: "wind_speed_10m", agg: "max", kind: "wind" },
});
const VARIABLE_NAMES = Object.keys(VARIABLES);
const MODELS = "ecmwf_ifs025,gfs_seamless";
const modelLabel = (suffix) => (/^ecmwf/.test(suffix) ? "ECMWF IFS ensemble" : /^ncep|^gfs/.test(suffix) ? "NOAA GEFS ensemble" : suffix);
const HOURS_PER_DAY = 24;
export const FORECAST_DAYS_AHEAD = 15;
export const MAX_BRACKETS = 30;
export const MAX_BOARD_CITIES = 20;

const round = (v, dp = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);
const share = (n, total) => (total > 0 ? Math.round((n / total) * 10000) / 10000 : null);

function variableOf(raw) {
  const v = String(raw ?? "temperature_max").trim().toLowerCase();
  if (!Object.hasOwn(VARIABLES, v)) throw bad(`"variable" must be one of: ${VARIABLE_NAMES.join(", ")}`);
  return v;
}

function unitFor(kind, tempUnit) {
  if (kind === "temperature") return tempUnit === "fahrenheit" ? "°F" : "°C";
  if (kind === "wind") return tempUnit === "fahrenheit" ? "mph" : "km/h";
  return "mm";
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The target date: YYYY-MM-DD, from yesterday to FORECAST_DAYS_AHEAD days
 *  ahead (UTC); absent, tomorrow (UTC). */
export function targetDate(raw, now = Date.now()) {
  if (raw === undefined || raw === null || raw === "") return utcDay(now + 86400000);
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) throw bad('"date" must be YYYY-MM-DD');
  const date = raw.trim();
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t) || utcDay(t) !== date) throw bad('"date" is not a valid calendar date');
  const first = utcDay(now - 86400000), last = utcDay(now + FORECAST_DAYS_AHEAD * 86400000);
  if (date < first || date > last) throw bad(`"date" must be between ${first} and ${last}: the ensembles reach ${FORECAST_DAYS_AHEAD} days ahead`);
  return date;
}

function aggregate(values, agg) {
  let sum = 0, max = -Infinity, min = Infinity;
  for (const v of values) { sum += v; if (v > max) max = v; if (v < min) min = v; }
  return agg === "max" ? max : agg === "min" ? min : agg === "sum" ? sum : sum / values.length;
}

/** One location's ensemble answer -> [{ model, values: [daily value per
 *  member] }], plus the models left out because their day is incomplete. A
 *  member counts only with every hour of the date present. */
export function membersOf(body, variable) {
  const spec = VARIABLES[variable];
  const hourly = body?.hourly;
  if (!hourly || typeof hourly !== "object") return { models: [], excluded: [] };
  const re = new RegExp(`^${spec.hourly}(?:_member\\d+)?(?:_(.+))?$`);
  const byModel = new Map();
  for (const [key, series] of Object.entries(hourly)) {
    const m = re.exec(key);
    if (!m || !Array.isArray(series)) continue;
    const suffix = m[1] ?? "ensemble";
    const row = byModel.get(suffix) ?? { model: modelLabel(suffix), values: [], incomplete: 0 };
    byModel.set(suffix, row);
    let vals = series.filter((v) => typeof v === "number" && Number.isFinite(v));
    if (vals.length < HOURS_PER_DAY || vals.length !== series.length) { row.incomplete += 1; continue; }
    // An hour's precipitation is the difference of two accumulated model
    // fields and can come back a hair under zero; rain is never negative.
    if (spec.kind === "precipitation") vals = vals.map((v) => (v < 0 ? 0 : v));
    row.values.push(aggregate(vals, spec.agg));
  }
  const models = [], excluded = [];
  for (const row of byModel.values()) {
    if (row.values.length && !row.incomplete) models.push({ model: row.model, values: row.values });
    else excluded.push(row.model);
  }
  return { models, excluded };
}

// One location's members for a date, variable and unit are kept in this
// process for ten minutes (the models run a few times a day), keyed on the
// coordinates to four decimals. A board sent again, the same cities in another
// order, or one of its cities asked alone reads nothing upstream; a call reads
// only the locations it does not hold, in one upstream call. A failed read and
// a location with no complete model are never kept; the oldest entry leaves
// first once the set is full.
export const ENSEMBLE_CACHE_TTL_MS = 10 * 60_000;
export const ENSEMBLE_CACHE_MAX = 2000;
const ensembleCache = new Map(); // key -> { at, value }
export function _resetEnsembleCache() { ensembleCache.clear(); }
const coordKey = (l) => `${Number(l.lat).toFixed(4)},${Number(l.lon).toFixed(4)}`;

/** Both ensembles for one date at each location: kept answers first, then one
 *  upstream call for the locations not held. */
async function readEnsembles(locations, opts) {
  const prefix = `${opts.date}|${opts.variable}|${opts.tempUnit}|`;
  const now = Date.now();
  const held = (l) => { const e = ensembleCache.get(prefix + coordKey(l)); return e && now - e.at < ENSEMBLE_CACHE_TTL_MS ? e.value : null; };
  const firstOf = new Map();
  for (const l of locations) if (!held(l) && !firstOf.has(coordKey(l))) firstOf.set(coordKey(l), l);
  const missing = [...firstOf.values()];
  const fresh = new Map();
  if (missing.length) {
    const read = await fetchEnsembles(missing, opts);
    missing.forEach((l, k) => {
      const key = prefix + coordKey(l);
      fresh.set(key, read[k]);
      ensembleCache.delete(key);
      ensembleCache.set(key, { at: Date.now(), value: read[k] });
    });
    while (ensembleCache.size > ENSEMBLE_CACHE_MAX) ensembleCache.delete(ensembleCache.keys().next().value);
  }
  return locations.map((l) => fresh.get(prefix + coordKey(l)) ?? held(l));
}

/** Read both ensembles for one date at each location (one upstream call). */
async function fetchEnsembles(locations, { date, variable, tempUnit }) {
  const spec = VARIABLES[variable];
  const params = new URLSearchParams({
    latitude: locations.map((l) => l.lat).join(","),
    longitude: locations.map((l) => l.lon).join(","),
    hourly: spec.hourly,
    models: MODELS,
    start_date: date, end_date: date,
    temperature_unit: tempUnit,
    wind_speed_unit: tempUnit === "fahrenheit" ? "mph" : "kmh",
    timezone: "auto",
  });
  const data = await openMeteoJson("ensemble", "/v1/ensemble", params);
  const bodies = Array.isArray(data) ? data : [data];
  if (bodies.length !== locations.length) throw bad("Open-Meteo returned an unexpected number of locations", 502);
  return bodies.map((body) => {
    const { models, excluded } = membersOf(body, variable);
    if (!models.length) throw bad(`No ensemble has a complete forecast for ${date} at this location - try a nearer date`, 422);
    return { timezone: body?.timezone ?? null, models, excluded };
  });
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function distributionOf(values) {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length;
  return {
    min: round(s[0]), p10: round(quantile(s, 0.1)), p25: round(quantile(s, 0.25)), median: round(quantile(s, 0.5)),
    p75: round(quantile(s, 0.75)), p90: round(quantile(s, 0.9)), max: round(s[s.length - 1]),
    mean: round(mean), stdDev: round(Math.sqrt(variance), 2),
  };
}

const numberOf = (v, name) => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "number" && typeof v !== "string") throw bad(`"${name}" must be a number`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`"${name}" must be a number`);
  return n;
};

// Own keys only (no prototype): an operator is one of the four listed, never a
// name every object inherits.
const OPS = Object.freeze(Object.assign(Object.create(null), {
  ">=": (v, x) => v >= x, ">": (v, x) => v > x, "<=": (v, x) => v <= x, "<": (v, x) => v < x,
}));
const OP_ALIASES = Object.freeze(Object.assign(Object.create(null), { gte: ">=", gt: ">", lte: "<=", lt: "<", above: ">", below: "<", atleast: ">=", atmost: "<=" }));

/** The condition a probability is asked for: { op, value } or { min, max }
 *  (a range, both ends included; either end may be open). */
function conditionOf(i) {
  const min = numberOf(i.min, "min"), max = numberOf(i.max, "max");
  const value = numberOf(i.value ?? i.threshold, "value");
  if (min !== null || max !== null) {
    if (value !== null) throw bad('Give "op" and "value" for a threshold, or "min" and/or "max" for a range, not both');
    if (min !== null && max !== null && max < min) throw bad('"max" must be at least "min"');
    return { test: (v) => (min === null || v >= min) && (max === null || v <= max), echo: { min, max } };
  }
  if (value === null) throw bad('Give a threshold ("op" and "value", for example op=">=" value=90) or a range ("min" and/or "max")');
  const rawOp = String(i.op ?? ">=").trim().toLowerCase();
  const op = OPS[rawOp] ? rawOp : OP_ALIASES[rawOp.replace(/[\s_-]/g, "")];
  if (!op) throw bad('"op" must be one of: >=, >, <=, <');
  return { test: (v) => OPS[op](v, value), echo: { op, value } };
}

function roundingOf(raw) {
  const r = String(raw ?? "none").trim().toLowerCase();
  if (r === "none" || r === "") return "none";
  if (r === "integer" || r === "whole") return "integer";
  throw bad('"rounding" must be none or integer');
}
const applyRounding = (v, rounding) => (rounding === "integer" ? Math.round(v) : v);

/** The caller's brackets: [{ label?, min?, max?, price? }], both ends
 *  included, either end open. `price` is the caller's market price, 0 to 1. */
function bracketsOf(raw, { required }) {
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw bad('"brackets" is required: an array of { label, min, max, price }');
    return null;
  }
  let list = raw;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { throw bad('"brackets" must be a JSON array of { label, min, max, price }'); } }
  if (!Array.isArray(list) || !list.length) throw bad('"brackets" must be a non-empty array of { label, min, max, price }');
  if (list.length > MAX_BRACKETS) throw bad(`"brackets" takes at most ${MAX_BRACKETS} entries`);
  return list.map((b, idx) => {
    if (!b || typeof b !== "object" || Array.isArray(b)) throw bad(`brackets[${idx}] must be an object { label, min, max, price }`);
    const min = numberOf(b.min, `brackets[${idx}].min`), max = numberOf(b.max, `brackets[${idx}].max`);
    if (min === null && max === null) throw bad(`brackets[${idx}] needs "min", "max" or both`);
    if (min !== null && max !== null && max < min) throw bad(`brackets[${idx}].max must be at least its min`);
    const price = numberOf(b.price ?? b.marketPrice, `brackets[${idx}].price`);
    if (price !== null && (price < 0 || price > 1)) throw bad(`brackets[${idx}].price must be between 0 and 1 (the market price as a share of the payout, for example 0.42)`);
    if (b.label !== undefined && b.label !== null && typeof b.label !== "string" && typeof b.label !== "number") throw bad(`brackets[${idx}].label must be text`);
    const label = b.label === undefined || b.label === null || b.label === "" ? defaultLabel(min, max) : String(b.label).slice(0, 80);
    return { label, min, max, price };
  });
}
const defaultLabel = (min, max) => (min === null ? `${max} or below` : max === null ? `${min} or above` : `${min} to ${max}`);

/** A ladder of whole-unit brackets `width` wide covering every member value,
 *  open at both ends. Values are rounded to whole units first, so the ladder
 *  leaves no gap. */
export function ladderFor(values, width, { floorZero = false } = {}) {
  const s = values.map(Math.round).sort((a, b) => a - b);
  const lo = Math.floor(quantile(s, 0.05) / width) * width;
  const hi = Math.max(lo + width, Math.ceil((quantile(s, 0.95) + 1) / width) * width);
  // A value that cannot go below zero (rain, wind) gets no bracket under it.
  const out = floorZero && lo <= 0 ? [] : [{ label: `${lo - 1} or below`, min: null, max: lo - 1, price: null }];
  for (let a = lo; a < hi && out.length < MAX_BRACKETS - 1; a += width) out.push({ label: width === 1 ? `${a}` : `${a} to ${a + width - 1}`, min: a, max: a + width - 1, price: null });
  const top = out[out.length - 1].max + 1;
  out.push({ label: `${top} or above`, min: top, max: null, price: null });
  return out;
}

function widthOf(raw, kind) {
  const n = numberOf(raw, "width");
  if (n === null) return kind === "temperature" ? 2 : 5;
  if (!Number.isInteger(n) || n < 1 || n > 50) throw bad('"width" must be a whole number from 1 to 50');
  return n;
}

function bracketRows(brackets, models, rounding, withPrice) {
  const all = models.flatMap((m) => m.values).map((v) => applyRounding(v, rounding));
  const inBracket = (b, v) => (b.min === null || v >= b.min) && (b.max === null || v <= b.max);
  const rows = brackets.map((b) => {
    const membersIn = all.filter((v) => inBracket(b, v)).length;
    return {
      label: b.label, min: b.min, max: b.max,
      forecastProbability: share(membersIn, all.length), membersIn,
      ...(withPrice ? { marketPrice: b.price } : {}),
    };
  });
  const outside = all.filter((v) => !brackets.some((b) => inBracket(b, v))).length;
  return { rows, outside, total: all.length };
}

const membersSummary = (models, test) => {
  const total = models.reduce((n, m) => n + m.values.length, 0);
  const byModel = models.map((m) => {
    const meeting = test ? m.values.filter(test).length : undefined;
    return { model: m.model, members: m.values.length, ...(test ? { meeting, probability: share(meeting, m.values.length) } : {}) };
  });
  return { total, byModel };
};

const VARIABLE_PROPERTY = { type: "string", description: `Daily value: ${VARIABLE_NAMES.join(", ")} (default temperature_max)` };
const DATE_PROPERTY = { type: "string", description: `Local date at the place, YYYY-MM-DD, up to ${FORECAST_DAYS_AHEAD} days ahead (default tomorrow, UTC); all 82 members reach about 13 days, the 31 NOAA members the rest` };
const UNITS_PROPERTY = { type: "string", description: "celsius (default; wind in km/h) or fahrenheit (wind in mph); precipitation is always mm" };
const ROUNDING_PROPERTY = { type: "string", description: "none (default) or integer: round each member's value to a whole unit before counting, for brackets stated in whole degrees" };

export const WEATHER_PROBABILITY_TOOLS = [
  {
    route: "GET /api/weather-probability",
    name: "Weather probability (ensemble)",
    slug: "weather-probability",
    attribution: "open-meteo",
    category: "data",
    price: "$0.01",
    description:
      `Probability that a day's weather meets a condition, from up to 82 ensemble members (ECMWF IFS and NOAA GEFS): a high, low, rain total or wind past a threshold or inside a range. Returns the member share, per-model counts and the spread. Any place by coordinates or name, up to ${FORECAST_DAYS_AHEAD} days ahead (all 82 to about 13 days, then NOAA's 31). Raw model output, not station-calibrated. ?place=Chicago&variable=temperature_max&units=fahrenheit&op=gte&value=40. ${OPEN_METEO_ATTRIBUTION}`,
    tags: ["weather", "probability", "ensemble", "forecast", "temperature", "prediction-market"],
    discovery: {
      input: { lat: 41.8781, lon: -87.6298, variable: "temperature_max", units: "fahrenheit", op: ">=", value: 40 },
      inputSchema: {
        properties: {
          ...LOCATION_PROPERTIES,
          date: DATE_PROPERTY,
          variable: VARIABLE_PROPERTY,
          units: UNITS_PROPERTY,
          op: { type: "string", description: "Threshold comparison: >=, >, <= or < (or gte, gt, lte, lt; default >=), with value" },
          value: { type: "number", description: "Threshold in the variable's unit, with op" },
          min: { type: "number", description: "Range lower end (included), instead of op/value" },
          max: { type: "number", description: "Range upper end (included), instead of op/value" },
          rounding: ROUNDING_PROPERTY,
        },
        required: [],
      },
      output: {
        example: {
          lat: 41.8781, lon: -87.6298, date: "2026-11-18", timezone: "America/Chicago",
          variable: "temperature_max", unit: "°F", condition: { op: ">=", value: 40 }, rounding: "none",
          probability: 0.7195,
          members: {
            total: 82, meeting: 59,
            byModel: [
              { model: "ECMWF IFS ensemble", members: 51, meeting: 39, probability: 0.7647 },
              { model: "NOAA GEFS ensemble", members: 31, meeting: 20, probability: 0.6452 },
            ],
          },
          distribution: { min: 36.2, p10: 38.4, p25: 39.7, median: 41.3, p75: 42.8, p90: 44.1, max: 46.5, mean: 41.2, stdDev: 2.14 },
          method: ENSEMBLE_METHOD,
          source: ENSEMBLE_SOURCE,
        },
      },
    },
    handler: async (i) => {
      const variable = variableOf(i.variable);
      const tempUnit = tempUnitOf(i.units);
      const rounding = roundingOf(i.rounding);
      const cond = conditionOf(i);
      const date = targetDate(i.date);
      const loc = await resolveLocation(i);
      const [ens] = await readEnsembles([loc], { date, variable, tempUnit });
      const test = (v) => cond.test(applyRounding(v, rounding));
      const { total, byModel } = membersSummary(ens.models, test);
      const meeting = byModel.reduce((n, m) => n + m.meeting, 0);
      return {
        ...locationFields(loc), date, timezone: ens.timezone,
        variable, unit: unitFor(VARIABLES[variable].kind, tempUnit), condition: cond.echo, rounding,
        probability: share(meeting, total),
        members: { total, meeting, byModel },
        ...(ens.excluded.length ? { modelsExcluded: ens.excluded, modelsExcludedNote: "No complete forecast for the date from these models; the probability counts the others only." } : {}),
        distribution: distributionOf(ens.models.flatMap((m) => m.values)),
        method: ENSEMBLE_METHOD,
        source: ENSEMBLE_SOURCE,
      };
    },
  },
  {
    route: "POST /api/weather-market-brackets",
    name: "Weather market brackets (ensemble)",
    slug: "weather-market-brackets",
    attribution: "open-meteo",
    category: "data",
    price: "$0.02",
    description:
      `Forecast probability for every bracket of a weather market. Send the place, the date and your brackets (label, min, max and the market price you hold for each): each bracket comes back with the share of up to 82 members (ECMWF IFS and NOAA GEFS) that land in it, your price beside it as sent. You supply brackets and prices; this tool reads no market feed and gives facts only, no rating or recommendation. Raw model output, not station-calibrated. ${OPEN_METEO_ATTRIBUTION}`,
    tags: ["weather", "probability", "ensemble", "prediction-market", "brackets", "temperature"],
    discovery: {
      input: {
        place: "New York", units: "fahrenheit", variable: "temperature_max", rounding: "integer",
        brackets: [
          { label: "39 or below", max: 39, price: 0.1 },
          { label: "40 to 49", min: 40, max: 49, price: 0.35 },
          { label: "50 to 59", min: 50, max: 59, price: 0.4 },
          { label: "60 or above", min: 60, price: 0.15 },
        ],
      },
      inputSchema: {
        properties: {
          ...LOCATION_PROPERTIES,
          date: DATE_PROPERTY,
          variable: VARIABLE_PROPERTY,
          units: UNITS_PROPERTY,
          rounding: ROUNDING_PROPERTY,
          brackets: {
            type: "array",
            description: `Up to ${MAX_BRACKETS} brackets, both ends included; leave min or max out for an open end. price is the market price you hold for the bracket, 0 to 1 (optional)`,
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Your name for the bracket" },
                min: { type: "number", description: "Lower end, included" },
                max: { type: "number", description: "Upper end, included" },
                price: { type: "number", description: "Market price as a share of the payout, 0 to 1" },
              },
            },
          },
        },
        required: ["brackets"],
      },
      output: {
        example: {
          lat: 40.71427, lon: -74.00597,
          place: { query: "New York", name: "New York", country: "United States", countryCode: "US", region: "New York", timezone: "America/New_York", lat: 40.71427, lon: -74.00597, source: "geocoding-api.open-meteo.com (GeoNames, CC BY 4.0)", credit: "Place data from GeoNames (CC BY 4.0)." },
          date: "2026-11-18", timezone: "America/New_York", variable: "temperature_max", unit: "°F", rounding: "integer",
          brackets: [
            { label: "39 or below", min: null, max: 39, forecastProbability: 0.0244, membersIn: 2, marketPrice: 0.1 },
            { label: "40 to 49", min: 40, max: 49, forecastProbability: 0.8415, membersIn: 69, marketPrice: 0.35 },
            { label: "50 to 59", min: 50, max: 59, forecastProbability: 0.1341, membersIn: 11, marketPrice: 0.4 },
            { label: "60 or above", min: 60, max: null, forecastProbability: 0, membersIn: 0, marketPrice: 0.15 },
          ],
          membersOutsideBrackets: 0,
          members: { total: 82, byModel: [{ model: "ECMWF IFS ensemble", members: 51 }, { model: "NOAA GEFS ensemble", members: 31 }] },
          distribution: { min: 38.6, p10: 41.9, p25: 43.6, median: 45.8, p75: 47.9, p90: 50.3, max: 53.1, mean: 45.9, stdDev: 3.02 },
          marketPriceNote: MARKET_PRICE_NOTE,
          method: ENSEMBLE_METHOD,
          source: ENSEMBLE_SOURCE,
        },
      },
    },
    handler: async (i) => {
      const variable = variableOf(i.variable);
      const tempUnit = tempUnitOf(i.units);
      const rounding = roundingOf(i.rounding);
      const brackets = bracketsOf(i.brackets, { required: true });
      const date = targetDate(i.date);
      const loc = await resolveLocation(i);
      const [ens] = await readEnsembles([loc], { date, variable, tempUnit });
      const { rows, outside } = bracketRows(brackets, ens.models, rounding, true);
      return {
        ...locationFields(loc), date, timezone: ens.timezone,
        variable, unit: unitFor(VARIABLES[variable].kind, tempUnit), rounding,
        brackets: rows,
        membersOutsideBrackets: outside,
        members: membersSummary(ens.models),
        ...(ens.excluded.length ? { modelsExcluded: ens.excluded, modelsExcludedNote: "No complete forecast for the date from these models; the probabilities count the others only." } : {}),
        distribution: distributionOf(ens.models.flatMap((m) => m.values)),
        marketPriceNote: MARKET_PRICE_NOTE,
        method: ENSEMBLE_METHOD,
        source: ENSEMBLE_SOURCE,
      };
    },
  },
  {
    route: "POST /api/weather-market-board",
    name: "Weather market board (all cities)",
    slug: "weather-market-board",
    attribution: "open-meteo",
    category: "data",
    price: "$0.10",
    description:
      `One date, many cities: per city, the ensemble spread of a daily weather value (up to 82 members, ECMWF IFS and NOAA GEFS) and the forecast probability of each bracket on a ladder. Default: 13 large US cities, or send up to ${MAX_BOARD_CITIES} by name or lat/lon, with your own brackets and the market prices you hold, shown beside each probability. This tool reads no market feed and gives facts only, no rating or recommendation. Raw model output, not station-calibrated. ${OPEN_METEO_ATTRIBUTION}`,
    tags: ["weather", "probability", "ensemble", "prediction-market", "cities", "temperature", "board"],
    discovery: {
      // Three cities keep the published call light; with no `cities` the
      // board covers DEFAULT_BOARD_CITIES.
      input: {
        variable: "temperature_max", units: "fahrenheit",
        cities: [{ label: "New York", lat: 40.7128, lon: -74.006 }, { label: "Chicago", lat: 41.8781, lon: -87.6298 }, { label: "Miami", lat: 25.7617, lon: -80.1918 }],
      },
      inputSchema: {
        properties: {
          date: DATE_PROPERTY,
          variable: VARIABLE_PROPERTY,
          units: { type: "string", description: "fahrenheit (default here; wind in mph) or celsius (wind in km/h); precipitation is always mm" },
          width: { type: "number", description: "Width of each built ladder bracket in whole units, 1-50 (default 2 for temperature, 5 otherwise)" },
          rounding: { type: "string", description: "integer (default here: member values are rounded to whole units before counting) or none; with none, only brackets you send are counted exactly as given" },
          cities: {
            type: "array",
            description: `Up to ${MAX_BOARD_CITIES} cities (default: 13 large US cities). Each: { label, place } or { label, lat, lon }, and optionally brackets [{ label, min, max, price }] to use in place of the built ladder`,
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Your name for the city" },
                place: { type: "string", description: "City name, for example Chicago" },
                lat: { type: "number", description: "Latitude (with lon), for example a settlement station's" },
                lon: { type: "number", description: "Longitude (with lat)" },
                brackets: { type: "array", description: "Your brackets for this city, as in weather-market-brackets", items: { type: "object" } },
              },
            },
          },
        },
        required: [],
      },
      output: {
        example: {
          date: "2026-11-18", variable: "temperature_max", unit: "°F", rounding: "integer", count: 3,
          cities: [
            {
              label: "New York", lat: 40.7128, lon: -74.006, timezone: "America/New_York",
              members: { total: 82, byModel: [{ model: "ECMWF IFS ensemble", members: 51 }, { model: "NOAA GEFS ensemble", members: 31 }] },
              distribution: { min: 38.6, p10: 41.9, p25: 43.6, median: 45.8, p75: 47.9, p90: 50.3, max: 53.1, mean: 45.9, stdDev: 3.02 },
              brackets: [
                { label: "41 or below", min: null, max: 41, forecastProbability: 0.0732, membersIn: 6 },
                { label: "42 to 43", min: 42, max: 43, forecastProbability: 0.1707, membersIn: 14 },
                { label: "44 to 45", min: 44, max: 45, forecastProbability: 0.2317, membersIn: 19 },
                { label: "46 or above", min: 46, max: null, forecastProbability: 0.5244, membersIn: 43 },
              ],
              membersOutsideBrackets: 0,
            },
          ],
          citiesNote: "Default cities are read at a city-center point. A market that settles on one station's reading can differ: send that station's lat and lon in cities.",
          marketPriceNote: MARKET_PRICE_NOTE,
          method: ENSEMBLE_METHOD,
          source: ENSEMBLE_SOURCE,
        },
      },
    },
    handler: async (i) => {
      const variable = variableOf(i.variable);
      const kind = VARIABLES[variable].kind;
      const tempUnit = tempUnitOf(i.units ?? "fahrenheit");
      const rounding = roundingOf(i.rounding ?? "integer");
      const width = widthOf(i.width, kind);
      const date = targetDate(i.date);
      const cities = await boardCities(i.cities);
      const ens = await readEnsembles(cities, { date, variable, tempUnit });
      const rows = cities.map((c, idx) => {
        const e = ens[idx];
        const values = e.models.flatMap((m) => m.values);
        const brackets = c.brackets ?? ladderFor(values, width, { floorZero: kind !== "temperature" });
        // A built ladder is stated in whole units, so its members are rounded.
        const { rows: bracketList, outside } = bracketRows(brackets, e.models, c.brackets ? rounding : "integer", Boolean(c.brackets));
        return {
          label: c.label, lat: c.lat, lon: c.lon, ...(c.place ? { place: c.place } : {}), timezone: e.timezone,
          members: membersSummary(e.models),
          ...(e.excluded.length ? { modelsExcluded: e.excluded } : {}),
          distribution: distributionOf(values),
          brackets: bracketList,
          membersOutsideBrackets: outside,
        };
      });
      return {
        date, variable, unit: unitFor(kind, tempUnit), rounding, count: rows.length,
        cities: rows,
        citiesNote: "Default cities are read at a city-center point. A market that settles on one station's reading can differ: send that station's lat and lon in cities.",
        marketPriceNote: MARKET_PRICE_NOTE,
        method: ENSEMBLE_METHOD,
        source: ENSEMBLE_SOURCE,
      };
    },
  },
];

// The board's default cities: large US cities at a city-center point
// (geographic coordinates; no market's settlement station is implied).
export const DEFAULT_BOARD_CITIES = Object.freeze([
  { label: "New York", lat: 40.7128, lon: -74.006 },
  { label: "Los Angeles", lat: 34.0522, lon: -118.2437 },
  { label: "Chicago", lat: 41.8781, lon: -87.6298 },
  { label: "Houston", lat: 29.7604, lon: -95.3698 },
  { label: "Phoenix", lat: 33.4484, lon: -112.074 },
  { label: "Philadelphia", lat: 39.9526, lon: -75.1652 },
  { label: "Miami", lat: 25.7617, lon: -80.1918 },
  { label: "Austin", lat: 30.2672, lon: -97.7431 },
  { label: "Denver", lat: 39.7392, lon: -104.9903 },
  { label: "Boston", lat: 42.3601, lon: -71.0589 },
  { label: "Washington, DC", lat: 38.9072, lon: -77.0369 },
  { label: "Seattle", lat: 47.6062, lon: -122.3321 },
  { label: "Atlanta", lat: 33.749, lon: -84.388 },
]);

async function boardCities(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_BOARD_CITIES.map((c) => ({ ...c, brackets: null }));
  let list = raw;
  if (typeof list === "string") { try { list = JSON.parse(list); } catch { throw bad('"cities" must be a JSON array of { label, place } or { label, lat, lon }'); } }
  if (!Array.isArray(list) || !list.length) throw bad('"cities" must be a non-empty array of { label, place } or { label, lat, lon }');
  if (list.length > MAX_BOARD_CITIES) throw bad(`"cities" takes at most ${MAX_BOARD_CITIES} entries`);
  // Validate every entry before any upstream read, so a bad entry costs nothing.
  const parsed = list.map((c, idx) => {
    const entry = typeof c === "string" ? { place: c } : c;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw bad(`cities[${idx}] must be { label, place } or { label, lat, lon }`);
    const hasCoords = !(entry.lat === undefined || entry.lat === null || entry.lat === "") || !(entry.lon === undefined || entry.lon === null || entry.lon === "");
    let coords = null;
    try {
      if (hasCoords) coords = requireCoords(entry);
      else if (typeof entry.place !== "string" || !entry.place.trim()) throw bad('needs "place" or "lat" and "lon"');
    } catch (e) { throw bad(`cities[${idx}]: ${e.message}`); }
    if (entry.label !== undefined && entry.label !== null && typeof entry.label !== "string" && typeof entry.label !== "number") throw bad(`cities[${idx}].label must be text`);
    let brackets = null;
    try { brackets = bracketsOf(entry.brackets, { required: false }); } catch (e) { throw bad(`cities[${idx}]: ${e.message}`); }
    return { entry, coords, brackets };
  });
  // Names are resolved one after another and the first that matches nothing
  // ends the run, so a list with an unknown name never reads the names after
  // it; each name read is kept briefly (weather-kit.js), hit or miss.
  const out = [];
  for (const [idx, { entry, coords, brackets }] of parsed.entries()) {
    let loc = coords;
    if (!loc) {
      try { loc = await resolveLocation({ place: entry.place, country: entry.country }); } catch (e) {
        if (e?.statusCode === 404 || e?.statusCode === 400) throw bad(`cities[${idx}]: ${e.message}`, e.statusCode);
        throw e;
      }
    }
    const label = entry.label === undefined || entry.label === null || entry.label === "" ? (loc.place?.name ?? `${loc.lat},${loc.lon}`) : String(entry.label).slice(0, 80);
    out.push({ label, lat: loc.lat, lon: loc.lon, ...(loc.place ? { place: loc.place } : {}), brackets });
  }
  return out;
}

// Every upstream wait in these handlers is a safeFetch through the weather
// kit's read helper (the ensemble read, and the place lookups before it), so
// each ends at a run's ceiling (src/run-ceiling.js).
markEndsAtCeiling(WEATHER_PROBABILITY_TOOLS, ["weather-market-board", "weather-market-brackets", "weather-probability"]);
