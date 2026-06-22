// scripts/test-color-kit.js
// Direct handler tests for src/tools/color-kit.js. No server needed.
// Covers: every notation parses, round-trip stability where applicable,
// WCAG ratios against the W3C-published test pairs, palette geometry,
// error contracts, and the "answers its own example" invariant.
import { COLOR_TOOLS } from "../src/tools/color-kit.js";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    console.log("ok -", msg);
    passed++;
  } else {
    console.error("FAIL -", msg);
    failed++;
  }
}
function throws(fn, statusCode, msg) {
  try {
    fn();
    console.error("FAIL -", msg, "(expected throw, got none)");
    failed++;
  } catch (e) {
    if (statusCode && e.statusCode !== statusCode) {
      console.error("FAIL -", msg, `(expected statusCode=${statusCode}, got ${e.statusCode})`);
      failed++;
    } else {
      console.log("ok -", msg);
      passed++;
    }
  }
}
const approx = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

const bySlug = Object.fromEntries(COLOR_TOOLS.map((t) => [t.slug, t]));

// ============================================================================
// color-convert — every input notation should resolve to the same RGB.
// ============================================================================
const convert = bySlug["color-convert"];

const hex = convert.handler({ color: "#ff0000" });
ok(hex.rgb.r === 255 && hex.rgb.g === 0 && hex.rgb.b === 0, "convert: #ff0000 → rgb(255,0,0)");
ok(hex.hex === "#ff0000", "convert: hex echoes canonical hex");
ok(approx(hex.hsl.h, 0), "convert: red → hue 0");
ok(approx(hex.hsl.s, 100), "convert: red → saturation 100");
ok(approx(hex.hsl.l, 50), "convert: red → lightness 50");

const short = convert.handler({ color: "#f00" });
ok(short.rgb.r === 255 && short.rgb.g === 0 && short.rgb.b === 0, "convert: short hex #f00 → rgb(255,0,0)");

const named = convert.handler({ color: "red" });
ok(named.hex === "#ff0000", "convert: named 'red' → #ff0000");

const rebecca = convert.handler({ color: "rebeccapurple" });
ok(rebecca.hex === "#663399", "convert: named 'rebeccapurple' → #663399 (CSS Color 4)");

const rgbStr = convert.handler({ color: "rgb(255, 0, 0)" });
ok(rgbStr.hex === "#ff0000", "convert: rgb(255, 0, 0) → #ff0000");

const rgbSpace = convert.handler({ color: "rgb(255 0 0)" });
ok(rgbSpace.hex === "#ff0000", "convert: space-separated rgb() also parses");

const hslStr = convert.handler({ color: "hsl(0, 100%, 50%)" });
ok(hslStr.hex === "#ff0000", "convert: hsl(0, 100%, 50%) → #ff0000");

const oklchStr = convert.handler({ color: "oklch(0.628 0.258 29.23)" });
ok(approx(oklchStr.rgb.r, 255, 3) && oklchStr.rgb.g < 30 && oklchStr.rgb.b < 30,
   "convert: oklch(0.628 0.258 29.23) → ~red");

// Round trip via OKLCH preserves color within rounding tolerance.
const blueIn = convert.handler({ color: "#1d4ed8" });
const oklchEcho = convert.handler({ color: blueIn.oklchString });
ok(approx(oklchEcho.rgb.r, 29, 3) && approx(oklchEcho.rgb.g, 78, 3) && approx(oklchEcho.rgb.b, 216, 3),
   "convert: hex → oklch → hex round-trip within ±3");

// Black and white are exact identities.
const black = convert.handler({ color: "#000000" });
ok(black.hex === "#000000" && black.hsl.l === 0, "convert: #000 → l=0");
const white = convert.handler({ color: "#ffffff" });
ok(white.hex === "#ffffff" && white.hsl.l === 100, "convert: #fff → l=100");

// ============================================================================
// color-contrast — verify against published WCAG examples.
// ============================================================================
const contrast = bySlug["color-contrast"];

// Black on white = 21 (the maximum possible WCAG ratio).
const max = contrast.handler({ foreground: "#000000", background: "#ffffff" });
ok(max.ratio === 21, "contrast: black on white = exactly 21");
ok(max.passes.aaNormal && max.passes.aaaNormal, "contrast: black/white passes every level");

// White on same = 1 (no contrast).
const same = contrast.handler({ foreground: "#ffffff", background: "#ffffff" });
ok(same.ratio === 1, "contrast: identical colors = 1");
ok(!same.passes.aaNormal && !same.passes.aaLarge, "contrast: identical fails every level");

// White on #1d4ed8 (Tailwind blue-700) — a real-world checkpoint.
const tailwind = contrast.handler({ foreground: "#ffffff", background: "#1d4ed8" });
ok(tailwind.ratio > 6 && tailwind.ratio < 8, "contrast: white on blue-700 in [6, 8] range");
ok(tailwind.passes.aaNormal && tailwind.passes.aaLarge, "contrast: white on blue-700 passes AA both sizes");

// Order shouldn't matter — contrast is symmetric.
const reversed = contrast.handler({ foreground: "#1d4ed8", background: "#ffffff" });
ok(reversed.ratio === tailwind.ratio, "contrast: ratio is symmetric");

// ============================================================================
// color-blindness — verify the three simulations all produce valid RGB
// and that contrast against a comparison color is computed.
// ============================================================================
const cb = bySlug["color-blindness"];

const cbRes = cb.handler({ color: "#ff0000", compareTo: "#00ff00" });
ok(cbRes.simulations.protanopia && cbRes.simulations.deuteranopia && cbRes.simulations.tritanopia,
   "color-blindness: all three types present");
for (const t of ["protanopia", "deuteranopia", "tritanopia"]) {
  const sim = cbRes.simulations[t];
  ok(/^#[0-9a-f]{6}$/.test(sim.hex), `color-blindness: ${t} returns valid hex`);
  ok(typeof sim.simulatedContrast === "number" && sim.simulatedContrast >= 1, `color-blindness: ${t} contrast ≥ 1`);
}

// Red vs green under protanopia should be visually closer than the original
// pair (the whole point of the simulation): originalContrast > simulatedContrast.
ok(cbRes.simulations.protanopia.originalContrast >= cbRes.simulations.protanopia.simulatedContrast,
   "color-blindness: red/green protanopia simulation reduces contrast");

// Without compareTo, no contrast fields appear.
const cbSolo = cb.handler({ color: "#ff0000" });
ok(cbSolo.simulations.protanopia.simulatedContrast === undefined,
   "color-blindness: omits contrast when no compareTo provided");

// ============================================================================
// color-palette — verify each scheme returns the right cardinality and that
// the hue rotations land where expected.
// ============================================================================
const pal = bySlug["color-palette"];

const cardinalities = {
  complementary: 2, analogous: 3, triadic: 3, tetradic: 4,
  "split-complementary": 3, monochromatic: 5,
};
for (const [scheme, n] of Object.entries(cardinalities)) {
  const r = pal.handler({ color: "#1d4ed8", scheme });
  ok(r.colors.length === n, `palette: ${scheme} returns ${n} colors`);
  for (const c of r.colors) {
    ok(/^#[0-9a-f]{6}$/.test(c.hex), `palette: ${scheme} color has valid hex`);
    ok(c.hsl && typeof c.hsl.h === "number", `palette: ${scheme} color has hsl`);
    ok(c.oklch && typeof c.oklch.L === "number", `palette: ${scheme} color has oklch`);
  }
}

// Complementary's second color sits 180° around the wheel from the first.
const comp = pal.handler({ color: "hsl(120, 60%, 50%)", scheme: "complementary" });
const hueDiff = Math.abs(comp.colors[0].hsl.h - comp.colors[1].hsl.h);
ok(approx(hueDiff, 180, 1) || approx(hueDiff, 180, 1.5),
   `palette: complementary hue gap ~180° (got ${hueDiff})`);

// ============================================================================
// color-name — exact match and nearest-match both work.
// ============================================================================
const name = bySlug["color-name"];

const exact = name.handler({ color: "rebeccapurple" });
ok(exact.isNamed === true && exact.distance === 0 && exact.name === "rebeccapurple",
   "name: exact lookup of 'rebeccapurple' → distance 0");

const near = name.handler({ color: "#6b3a99" }); // close to rebeccapurple #663399
ok(near.distance < 20 && near.name === "rebeccapurple",
   "name: near-rebeccapurple hex finds 'rebeccapurple'");

const farFromNamed = name.handler({ color: "#abcdef" });
ok(typeof farFromNamed.name === "string" && farFromNamed.distance > 0,
   "name: arbitrary hex finds *some* nearest name with distance > 0");

// ============================================================================
// Error contracts — every failure mode returns statusCode=400, never 500.
// ============================================================================
throws(() => convert.handler({}), 400, "convert: missing color → 400");
throws(() => convert.handler({ color: 42 }), 400, "convert: non-string color → 400");
throws(() => convert.handler({ color: "#zzz" }), 400, "convert: invalid hex → 400");
throws(() => convert.handler({ color: "rgb(1, 2)" }), 400, "convert: rgb with too few channels → 400");
throws(() => convert.handler({ color: "not-a-color" }), 400, "convert: unknown notation → 400");

throws(() => contrast.handler({ foreground: "#fff" }), 400, "contrast: missing background → 400");
throws(() => contrast.handler({ background: "#000" }), 400, "contrast: missing foreground → 400");
throws(() => contrast.handler({ foreground: "garbage", background: "#000" }), 400, "contrast: invalid foreground → 400");

throws(() => cb.handler({}), 400, "color-blindness: missing color → 400");

throws(() => pal.handler({ color: "#fff" }), 400, "palette: missing scheme → 400");
throws(() => pal.handler({ color: "#fff", scheme: "rainbow" }), 400, "palette: unknown scheme → 400");

throws(() => name.handler({}), 400, "name: missing color → 400");
throws(() => name.handler({ color: 99 }), 400, "name: non-string color → 400");

// ============================================================================
// "Answers its own example" invariant — same check CI runs across the full
// catalog. Each tool's discovery.input must succeed.
// ============================================================================
for (const tool of COLOR_TOOLS) {
  try {
    const result = tool.handler(tool.discovery.input);
    ok(result && typeof result === "object", `${tool.slug}: example input returns an object`);
  } catch (e) {
    ok(false, `${tool.slug}: example input throws (${e.message})`);
  }
}

// ============================================================================
// Pricing + category consistency.
// ============================================================================
for (const tool of COLOR_TOOLS) {
  ok(tool.price === "$0.001", `${tool.slug}: priced at $0.001`);
  ok(tool.category === "data", `${tool.slug}: category=data`);
  ok(tool.route.startsWith("POST /api/"), `${tool.slug}: POST route`);
  ok(tool.discovery?.input && tool.discovery?.inputSchema && tool.discovery?.output?.example,
     `${tool.slug}: full discovery envelope present`);
}

// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
