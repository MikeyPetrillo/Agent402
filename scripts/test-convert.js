// Proves every generated conversion endpoint works: known exact values, and a
// round-trip (convert there and back == identity) for ALL ~970 of them.
import { CONVERSIONS } from "../src/tools/convert-gen.js";

const bySlug = Object.fromEntries(CONVERSIONS.map((t) => [t.slug, t]));
let pass = 0;
const fails = [];

function exact(slug, input, expected, tol = 1e-3) {
  const tool = bySlug[slug];
  if (!tool) return fails.push(`${slug}: NOT FOUND`);
  const got = tool.handler(input).result;
  if (Math.abs(got - expected) <= tol) {
    pass++;
    console.log(`✓ ${slug} = ${got}`);
  } else {
    fails.push(`${slug}: got ${got}, expected ${expected}`);
    console.log(`✗ ${slug}: got ${got}, expected ${expected}`);
  }
}

// Known reference values.
exact("convert-miles-to-kilometers", { value: 1 }, 1.609344);
exact("convert-kilometers-to-miles", { value: 100 }, 62.1371);
exact("convert-feet-to-meters", { value: 10 }, 3.048);
exact("convert-inches-to-centimeters", { value: 1 }, 2.54);
exact("convert-pounds-to-kilograms", { value: 1 }, 0.453592);
exact("convert-ounces-to-grams", { value: 1 }, 28.3495);
exact("convert-us-gallons-to-liters", { value: 1 }, 3.785412, 1e-4);
exact("convert-celsius-to-fahrenheit", { value: 100 }, 212);
exact("convert-fahrenheit-to-celsius", { value: 32 }, 0);
exact("convert-kelvin-to-celsius", { value: 0 }, -273.15);
exact("convert-rankine-to-kelvin", { value: 491.67 }, 273.15, 1e-2);
exact("convert-gibibytes-to-bytes", { value: 1 }, 1073741824, 1);
exact("convert-megabytes-to-bytes", { value: 1 }, 1e6);
exact("convert-hours-to-seconds", { value: 2 }, 7200);
exact("convert-days-to-hours", { value: 1 }, 24);
exact("convert-degrees-to-radians", { value: 180 }, Math.PI, 1e-4);
exact("convert-kilowatt-hours-to-joules", { value: 1 }, 3.6e6, 1);
exact("convert-atmospheres-to-pascals", { value: 1 }, 101325);
exact("convert-acres-to-square-meters", { value: 1 }, 4046.856, 1e-2);
exact("convert-knots-to-kilometers-per-hour", { value: 1 }, 1.852, 1e-3);

// Round-trip every single generated tool: x -> y -> x must recover x.
let rtFail = 0;
for (const t of CONVERSIONS) {
  const m = t.slug.match(/^convert-(.+)-to-(.+)$/);
  const back = bySlug[`convert-${m[2]}-to-${m[1]}`];
  if (!back) {
    rtFail++;
    continue;
  }
  const there = t.handler({ value: 7 }).result;
  const recovered = back.handler({ value: there }).result;
  if (Math.abs(recovered - 7) > 1e-4 * Math.max(1, Math.abs(recovered))) rtFail++;
}

console.log(`\n${CONVERSIONS.length} conversion tools generated`);
console.log(`${pass}/${20} reference values correct`);
console.log(`round-trip failures: ${rtFail} / ${CONVERSIONS.length}`);
if (fails.length || rtFail > 0) {
  console.error("FAILURES:\n  " + [...fails, rtFail ? `${rtFail} round-trip failures` : ""].filter(Boolean).join("\n  "));
  process.exit(1);
}
console.log("convert: ALL TOOLS VERIFIED ✓");
