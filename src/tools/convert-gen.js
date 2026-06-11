// Generated unit-conversion tools. One real, individually-discoverable endpoint
// per ordered unit pair (e.g. GET /api/convert/miles-to-kilometers?value=5),
// backed by a single verified conversion engine and covered by exact-output +
// round-trip tests in scripts/test-convert.js. This is how we scale the catalog
// past 1000 without filler: every endpoint is a genuine, working operation.

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Each category: base unit factor table. id is slug-safe and human-readable so
// the generated slug reads like "convert-miles-to-kilometers".
const CATEGORIES = {
  length: { base: "meters", tags: ["length", "distance"], units: {
    meters: 1, kilometers: 1000, centimeters: 0.01, millimeters: 0.001, micrometers: 1e-6, nanometers: 1e-9,
    miles: 1609.344, yards: 0.9144, feet: 0.3048, inches: 0.0254, "nautical-miles": 1852,
    "light-years": 9.4607304725808e15, "astronomical-units": 1.495978707e11, furlongs: 201.168,
  } },
  mass: { base: "grams", tags: ["mass", "weight"], units: {
    grams: 1, kilograms: 1000, milligrams: 0.001, micrograms: 1e-6, tonnes: 1e6,
    pounds: 453.59237, ounces: 28.349523125, stones: 6350.29318, carats: 0.2, grains: 0.06479891,
    "us-tons": 907184.74, "uk-tons": 1016046.9088,
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
};

const pretty = (id) => id.replace(/-/g, " ");

function makeFactorTool(category, fromId, toId, fromFactor, toFactor, tags) {
  const slug = `convert-${fromId}-to-${toId}`;
  return {
    route: `GET /api/convert/${fromId}-to-${toId}`,
    name: `${pretty(fromId)} → ${pretty(toId)}`,
    slug,
    category: "convert",
    price: "$0.001",
    bazaar: false, // payable + on our own surfaces, but not individually pushed to the Bazaar (keeps boot light)
    description: `Convert ${pretty(fromId)} to ${pretty(toId)} (${category}). Pass ?value=N.`,
    tags: ["convert", "units", category, ...tags],
    discovery: {
      input: { value: "1" },
      inputSchema: { properties: { value: { type: "string", description: "Numeric value to convert" } }, required: ["value"] },
      output: { example: { value: 1, from: fromId, to: toId, result: +(fromFactor / toFactor).toFixed(6) } },
    },
    handler: (i) => {
      const v = Number(i.value);
      if (!Number.isFinite(v)) throw bad('"value" must be a number');
      return { value: v, from: fromId, to: toId, result: +((v * fromFactor) / toFactor).toPrecision(12) };
    },
  };
}

// Temperature is affine, not a simple factor — handle separately.
const TEMP = { celsius: "c", fahrenheit: "f", kelvin: "k", rankine: "r" };
function toCelsius(v, u) {
  return u === "c" ? v : u === "f" ? (v - 32) * 5 / 9 : u === "k" ? v - 273.15 : (v - 491.67) * 5 / 9;
}
function fromCelsius(c, u) {
  return u === "c" ? c : u === "f" ? c * 9 / 5 + 32 : u === "k" ? c + 273.15 : (c + 273.15) * 9 / 5;
}
function makeTempTool(fromId, toId) {
  return {
    route: `GET /api/convert/${fromId}-to-${toId}`,
    name: `${pretty(fromId)} → ${pretty(toId)}`,
    slug: `convert-${fromId}-to-${toId}`,
    category: "convert",
    price: "$0.001",
    bazaar: false,
    description: `Convert temperature from ${fromId} to ${toId}. Pass ?value=N.`,
    tags: ["convert", "units", "temperature", fromId, toId],
    discovery: {
      input: { value: "100" },
      inputSchema: { properties: { value: { type: "string", description: "Temperature value" } }, required: ["value"] },
      output: { example: { value: 100, from: fromId, to: toId, result: +fromCelsius(toCelsius(100, TEMP[fromId]), TEMP[toId]).toFixed(4) } },
    },
    handler: (i) => {
      const v = Number(i.value);
      if (!Number.isFinite(v)) throw bad('"value" must be a number');
      return { value: v, from: fromId, to: toId, result: +fromCelsius(toCelsius(v, TEMP[fromId]), TEMP[toId]).toPrecision(12) };
    },
  };
}

function generate() {
  const tools = [];
  for (const [category, { units, tags }] of Object.entries(CATEGORIES)) {
    const ids = Object.keys(units);
    for (const a of ids) for (const b of ids) {
      if (a !== b) tools.push(makeFactorTool(category, a, b, units[a], units[b], tags));
    }
  }
  const tIds = Object.keys(TEMP);
  for (const a of tIds) for (const b of tIds) if (a !== b) tools.push(makeTempTool(a, b));
  return tools;
}

export const CONVERSIONS = generate();
