// The unit-conversion table + engine. Formerly a generator of ~970 pairwise
// convert-* endpoints; those are retired — the single parametric `unit-convert`
// tool (src/tools/kit2.js) now serves every pair through convertAnyUnit(),
// with the exact same factor table and temperature math. Covered by
// scripts/test-convert.js.

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Each linear category: base unit + factor table (unit id -> how many base
// units one of it is). Ids are slug-safe and human-readable — they are the
// exact ids the retired convert-<from>-to-<to> endpoints used; never rename.
// Temperature is affine (offset, not factor) — its units are listed here for
// discovery/routing, converted via the celsius-pivot logic below.
export const UNIT_CATEGORIES = {
  length: { base: "meters", tags: ["length", "distance"], units: {
    meters: 1, kilometers: 1000, centimeters: 0.01, millimeters: 0.001, micrometers: 1e-6, nanometers: 1e-9,
    miles: 1609.344, yards: 0.9144, feet: 0.3048, inches: 0.0254, "nautical-miles": 1852,
    "light-years": 9.4607304725808e15, "astronomical-units": 1.495978707e11, furlongs: 201.168,
    // Imperial Russian measures (defined against the English foot from 1835).
    versts: 1066.8, sazhens: 2.1336, arshins: 0.7112, vershoks: 0.04445,
  } },
  mass: { base: "grams", tags: ["mass", "weight"], units: {
    grams: 1, kilograms: 1000, milligrams: 0.001, micrograms: 1e-6, tonnes: 1e6,
    pounds: 453.59237, ounces: 28.349523125, stones: 6350.29318, carats: 0.2, grains: 0.06479891,
    "us-tons": 907184.74, "uk-tons": 1016046.9088,
    // Imperial Russian: 1 funt = 409.51718 g, 1 pood = 40 funt, 1 zolotnik = 1/96 funt.
    poods: 16380.6872, funts: 409.51718, zolotniks: 4.265803958,
  } },
  volume: { base: "liters", tags: ["volume", "capacity"], units: {
    liters: 1, milliliters: 0.001, "cubic-meters": 1000, "cubic-centimeters": 0.001,
    "us-gallons": 3.785411784, "uk-gallons": 4.54609, quarts: 0.946352946, pints: 0.473176473,
    cups: 0.2365882365, "fluid-ounces": 0.0295735295625, tablespoons: 0.01478676478125,
    teaspoons: 0.00492892159375, barrels: 158.987294928,
  } },
  area: { base: "square-meters", tags: ["area"], units: {
    "square-meters": 1, "square-kilometers": 1e6, "square-centimeters": 1e-4, "square-millimeters": 1e-6,
    hectares: 1e4, acres: 4046.8564224, "square-miles": 2589988.110336, "square-feet": 0.09290304,
    "square-inches": 0.00064516, "square-yards": 0.83612736,
  } },
  speed: { base: "meters-per-second", tags: ["speed", "velocity"], units: {
    "meters-per-second": 1, "kilometers-per-hour": 0.2777777777777778, "miles-per-hour": 0.44704,
    knots: 0.5144444444444445, "feet-per-second": 0.3048, mach: 343,
  } },
  time: { base: "seconds", tags: ["time", "duration"], units: {
    seconds: 1, milliseconds: 0.001, microseconds: 1e-6, nanoseconds: 1e-9, minutes: 60, hours: 3600,
    days: 86400, weeks: 604800, months: 2629800, years: 31557600,
  } },
  data: { base: "bytes", tags: ["data", "storage", "digital"], units: {
    bytes: 1, bits: 0.125, kilobytes: 1000, megabytes: 1e6, gigabytes: 1e9, terabytes: 1e12, petabytes: 1e15,
    kibibytes: 1024, mebibytes: 1048576, gibibytes: 1073741824, tebibytes: 1099511627776,
  } },
  pressure: { base: "pascals", tags: ["pressure"], units: {
    pascals: 1, kilopascals: 1000, bars: 100000, psi: 6894.757293168, atmospheres: 101325,
    mmhg: 133.322387415, torr: 133.32236842105263,
  } },
  energy: { base: "joules", tags: ["energy"], units: {
    joules: 1, kilojoules: 1000, calories: 4.184, kilocalories: 4184, "watt-hours": 3600,
    "kilowatt-hours": 3.6e6, btus: 1055.05585262, electronvolts: 1.602176634e-19,
  } },
  power: { base: "watts", tags: ["power"], units: {
    watts: 1, kilowatts: 1000, megawatts: 1e6, horsepower: 745.6998715822702, "btus-per-hour": 0.2930710701722222,
  } },
  angle: { base: "degrees", tags: ["angle"], units: {
    degrees: 1, radians: 57.29577951308232, gradians: 0.9, arcminutes: 0.016666666666666666,
    arcseconds: 0.0002777777777777778, turns: 360,
  } },
  frequency: { base: "hertz", tags: ["frequency"], units: {
    hertz: 1, kilohertz: 1000, megahertz: 1e6, gigahertz: 1e9, rpm: 0.016666666666666666,
  } },
  temperature: { base: "celsius", tags: ["temperature"], affine: true, units: {
    celsius: 1, fahrenheit: 1, kelvin: 1, rankine: 1,
  } },
};

// Temperature is affine, not a simple factor — convert via celsius.
const TEMP = { celsius: "c", fahrenheit: "f", kelvin: "k", rankine: "r" };
function toCelsius(v, u) {
  return u === "c" ? v : u === "f" ? (v - 32) * 5 / 9 : u === "k" ? v - 273.15 : (v - 491.67) * 5 / 9;
}
function fromCelsius(c, u) {
  return u === "c" ? c : u === "f" ? c * 9 / 5 + 32 : u === "k" ? c + 273.15 : (c + 273.15) * 9 / 5;
}

// unit id -> category name, for O(1) lookup + cross-category error messages.
const UNIT_TO_CATEGORY = {};
for (const [name, { units }] of Object.entries(UNIT_CATEGORIES)) {
  for (const id of Object.keys(units)) UNIT_TO_CATEGORY[id] = name;
}

// Convert `value` from one unit id to another within the same category.
// Throws 400 on unknown units or cross-category pairs (naming both categories).
export function convertAnyUnit(value, from, to) {
  if (!Number.isFinite(value)) throw bad('"value" must be a number');
  const fromCat = UNIT_TO_CATEGORY[from];
  const toCat = UNIT_TO_CATEGORY[to];
  if (!fromCat) throw bad(`Unknown unit "${from}". Categories: ${Object.keys(UNIT_CATEGORIES).join(", ")}.`);
  if (!toCat) throw bad(`Unknown unit "${to}". Units in ${fromCat}: ${Object.keys(UNIT_CATEGORIES[fromCat].units).join(", ")}.`);
  if (fromCat !== toCat) throw bad(`"${from}" is ${fromCat} but "${to}" is ${toCat} - units must share a category`);
  if (fromCat === "temperature") return fromCelsius(toCelsius(value, TEMP[from]), TEMP[to]);
  const { units } = UNIT_CATEGORIES[fromCat];
  return (value * units[from]) / units[to];
}
