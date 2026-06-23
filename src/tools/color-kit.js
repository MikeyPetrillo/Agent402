// Color kit — conversion (hex/rgb/hsl/oklch/named), WCAG contrast, color
// blindness simulation, palette generation, and nearest-named-color lookup.
// The pieces an agent reaches for constantly when generating UI: "is this
// pair accessible?", "what's the OKLCH for this hex?", "give me a palette
// for a button background of #1d4ed8".
//
// All pure CPU, no dependencies, no network → automatically proof-of-work
// eligible (free tier). Covered by scripts/test-color-kit.js.

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// ============================================================================
// CSS Color Module Level 4 — full 148-name table. Used both for named-color
// resolution and for nearest-named-color lookup. Values are [r, g, b] 0-255.
// Source: https://www.w3.org/TR/css-color-4/#named-colors (frozen list).
// ============================================================================
const NAMED = {
  aliceblue: [240, 248, 255], antiquewhite: [250, 235, 215], aqua: [0, 255, 255],
  aquamarine: [127, 255, 212], azure: [240, 255, 255], beige: [245, 245, 220],
  bisque: [255, 228, 196], black: [0, 0, 0], blanchedalmond: [255, 235, 205],
  blue: [0, 0, 255], blueviolet: [138, 43, 226], brown: [165, 42, 42],
  burlywood: [222, 184, 135], cadetblue: [95, 158, 160], chartreuse: [127, 255, 0],
  chocolate: [210, 105, 30], coral: [255, 127, 80], cornflowerblue: [100, 149, 237],
  cornsilk: [255, 248, 220], crimson: [220, 20, 60], cyan: [0, 255, 255],
  darkblue: [0, 0, 139], darkcyan: [0, 139, 139], darkgoldenrod: [184, 134, 11],
  darkgray: [169, 169, 169], darkgreen: [0, 100, 0], darkgrey: [169, 169, 169],
  darkkhaki: [189, 183, 107], darkmagenta: [139, 0, 139], darkolivegreen: [85, 107, 47],
  darkorange: [255, 140, 0], darkorchid: [153, 50, 204], darkred: [139, 0, 0],
  darksalmon: [233, 150, 122], darkseagreen: [143, 188, 143], darkslateblue: [72, 61, 139],
  darkslategray: [47, 79, 79], darkslategrey: [47, 79, 79], darkturquoise: [0, 206, 209],
  darkviolet: [148, 0, 211], deeppink: [255, 20, 147], deepskyblue: [0, 191, 255],
  dimgray: [105, 105, 105], dimgrey: [105, 105, 105], dodgerblue: [30, 144, 255],
  firebrick: [178, 34, 34], floralwhite: [255, 250, 240], forestgreen: [34, 139, 34],
  fuchsia: [255, 0, 255], gainsboro: [220, 220, 220], ghostwhite: [248, 248, 255],
  gold: [255, 215, 0], goldenrod: [218, 165, 32], gray: [128, 128, 128],
  green: [0, 128, 0], greenyellow: [173, 255, 47], grey: [128, 128, 128],
  honeydew: [240, 255, 240], hotpink: [255, 105, 180], indianred: [205, 92, 92],
  indigo: [75, 0, 130], ivory: [255, 255, 240], khaki: [240, 230, 140],
  lavender: [230, 230, 250], lavenderblush: [255, 240, 245], lawngreen: [124, 252, 0],
  lemonchiffon: [255, 250, 205], lightblue: [173, 216, 230], lightcoral: [240, 128, 128],
  lightcyan: [224, 255, 255], lightgoldenrodyellow: [250, 250, 210], lightgray: [211, 211, 211],
  lightgreen: [144, 238, 144], lightgrey: [211, 211, 211], lightpink: [255, 182, 193],
  lightsalmon: [255, 160, 122], lightseagreen: [32, 178, 170], lightskyblue: [135, 206, 250],
  lightslategray: [119, 136, 153], lightslategrey: [119, 136, 153], lightsteelblue: [176, 196, 222],
  lightyellow: [255, 255, 224], lime: [0, 255, 0], limegreen: [50, 205, 50],
  linen: [250, 240, 230], magenta: [255, 0, 255], maroon: [128, 0, 0],
  mediumaquamarine: [102, 205, 170], mediumblue: [0, 0, 205], mediumorchid: [186, 85, 211],
  mediumpurple: [147, 112, 219], mediumseagreen: [60, 179, 113], mediumslateblue: [123, 104, 238],
  mediumspringgreen: [0, 250, 154], mediumturquoise: [72, 209, 204], mediumvioletred: [199, 21, 133],
  midnightblue: [25, 25, 112], mintcream: [245, 255, 250], mistyrose: [255, 228, 225],
  moccasin: [255, 228, 181], navajowhite: [255, 222, 173], navy: [0, 0, 128],
  oldlace: [253, 245, 230], olive: [128, 128, 0], olivedrab: [107, 142, 35],
  orange: [255, 165, 0], orangered: [255, 69, 0], orchid: [218, 112, 214],
  palegoldenrod: [238, 232, 170], palegreen: [152, 251, 152], paleturquoise: [175, 238, 238],
  palevioletred: [219, 112, 147], papayawhip: [255, 239, 213], peachpuff: [255, 218, 185],
  peru: [205, 133, 63], pink: [255, 192, 203], plum: [221, 160, 221],
  powderblue: [176, 224, 230], purple: [128, 0, 128], rebeccapurple: [102, 51, 153],
  red: [255, 0, 0], rosybrown: [188, 143, 143], royalblue: [65, 105, 225],
  saddlebrown: [139, 69, 19], salmon: [250, 128, 114], sandybrown: [244, 164, 96],
  seagreen: [46, 139, 87], seashell: [255, 245, 238], sienna: [160, 82, 45],
  silver: [192, 192, 192], skyblue: [135, 206, 235], slateblue: [106, 90, 205],
  slategray: [112, 128, 144], slategrey: [112, 128, 144], snow: [255, 250, 250],
  springgreen: [0, 255, 127], steelblue: [70, 130, 180], tan: [210, 180, 140],
  teal: [0, 128, 128], thistle: [216, 191, 216], tomato: [255, 99, 71],
  transparent: [0, 0, 0], turquoise: [64, 224, 208], violet: [238, 130, 238],
  wheat: [245, 222, 179], white: [255, 255, 255], whitesmoke: [245, 245, 245],
  yellow: [255, 255, 0], yellowgreen: [154, 205, 50],
};

// ============================================================================
// Color-space math
// ============================================================================

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

// sRGB ↔ linear-RGB gamma transfer (IEC 61966-2-1).
function sRGBToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function linearTosRGB(v) {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return clamp(Math.round(c * 255), 0, 255);
}

// RGB (0-255) → HSL (h 0-360, s/l 0-100).
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: r2(l * 100) };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h: r2(h), s: r2(s * 100), l: r2(l * 100) };
}

// HSL → RGB (0-255). H in degrees, S/L in 0-100.
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 100) / 100;
  l = clamp(l, 0, 100) / 100;
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hueToRgb = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const hk = h / 360;
  return {
    r: Math.round(hueToRgb(hk + 1 / 3) * 255),
    g: Math.round(hueToRgb(hk) * 255),
    b: Math.round(hueToRgb(hk - 1 / 3) * 255),
  };
}

// sRGB → Oklab (Björn Ottosson, https://bottosson.github.io/posts/oklab/).
// Includes the sRGB gamma transfer + the published 3x3 LMS-to-Oklab matrices.
function rgbToOklab(r, g, b) {
  const lr = sRGBToLinear(r), lg = sRGBToLinear(g), lb = sRGBToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}
function oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return { r: linearTosRGB(lr), g: linearTosRGB(lg), b: linearTosRGB(lb) };
}

// Oklab ↔ OKLCH (polar form: chroma + hue).
function rgbToOklch(r, g, b) {
  const { L, a, b: bb } = rgbToOklab(r, g, b);
  const C = Math.sqrt(a * a + bb * bb);
  let H = (Math.atan2(bb, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L: r3(L), C: r3(C), H: r2(H) };
}
function oklchToRgb(L, C, H) {
  const rad = (H * Math.PI) / 180;
  return oklabToRgb(L, C * Math.cos(rad), C * Math.sin(rad));
}

// WCAG 2.x relative luminance + contrast ratio.
function relativeLuminance(r, g, b) {
  return 0.2126 * sRGBToLinear(r) + 0.7152 * sRGBToLinear(g) + 0.0722 * sRGBToLinear(b);
}
function contrastRatio(rgb1, rgb2) {
  const L1 = relativeLuminance(rgb1.r, rgb1.g, rgb1.b);
  const L2 = relativeLuminance(rgb2.r, rgb2.g, rgb2.b);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}

// ============================================================================
// Input parsing — accepts any of: hex, rgb(), hsl(), oklch(), CSS name.
// Returns canonical { r, g, b } 0-255.
// ============================================================================
function parseColor(input) {
  if (typeof input !== "string") throw bad(`color must be a string`);
  const s = input.trim().toLowerCase();

  // Named.
  if (Object.prototype.hasOwnProperty.call(NAMED, s)) {
    const [r, g, b] = NAMED[s];
    return { r, g, b };
  }

  // Hex: #rgb, #rrggbb, #rrggbbaa (alpha discarded for these tools).
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (![3, 4, 6, 8].includes(hex.length) || !/^[0-9a-f]+$/.test(hex)) {
      throw bad(`invalid hex color: ${input}`);
    }
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      };
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  // rgb()/rgba() — comma or space separated. Channel values: 0-255 or %.
  const rgbMatch = s.match(/^rgba?\(\s*([^)]+)\)$/);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    if (parts.length !== 3) throw bad(`rgb() needs 3 channels: ${input}`);
    const toCh = (p) => {
      if (p.endsWith("%")) return Math.round((parseFloat(p) / 100) * 255);
      return Math.round(parseFloat(p));
    };
    const [r, g, b] = parts.map(toCh);
    if ([r, g, b].some((n) => !Number.isFinite(n))) throw bad(`invalid rgb(): ${input}`);
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255) };
  }

  // hsl()/hsla() — h is deg, s/l are %. Permissive on separators.
  const hslMatch = s.match(/^hsla?\(\s*([^)]+)\)$/);
  if (hslMatch) {
    const parts = hslMatch[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    if (parts.length !== 3) throw bad(`hsl() needs 3 channels: ${input}`);
    const h = parseFloat(parts[0]);
    const sv = parseFloat(parts[1]);
    const lv = parseFloat(parts[2]);
    if ([h, sv, lv].some((n) => !Number.isFinite(n))) throw bad(`invalid hsl(): ${input}`);
    return hslToRgb(h, sv, lv);
  }

  // oklch() — L in 0-1 (or %), C in 0-0.4ish, H in deg.
  const oklchMatch = s.match(/^oklch\(\s*([^)]+)\)$/);
  if (oklchMatch) {
    const parts = oklchMatch[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    if (parts.length !== 3) throw bad(`oklch() needs 3 channels: ${input}`);
    const L = parts[0].endsWith("%") ? parseFloat(parts[0]) / 100 : parseFloat(parts[0]);
    const C = parseFloat(parts[1]);
    const H = parseFloat(parts[2]);
    if ([L, C, H].some((n) => !Number.isFinite(n))) throw bad(`invalid oklch(): ${input}`);
    return oklchToRgb(L, C, H);
  }

  throw bad(`unrecognized color: ${input} (expected hex, rgb(), hsl(), oklch(), or CSS name)`);
}

// Render canonical { r, g, b } in every supported notation.
function formatAll({ r, g, b }) {
  const hex = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
  const hsl = rgbToHsl(r, g, b);
  const oklch = rgbToOklch(r, g, b);
  return {
    hex,
    rgb: { r, g, b },
    rgbString: `rgb(${r}, ${g}, ${b})`,
    hsl,
    hslString: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
    oklch,
    oklchString: `oklch(${oklch.L} ${oklch.C} ${oklch.H})`,
  };
}

// Nearest CSS named color by RGB Euclidean distance. Not perceptually
// optimal (Oklab would be better) but predictable and matches what most
// callers picture when they say "closest named color".
function nearestNamed({ r, g, b }) {
  let bestName = null, bestDist = Infinity;
  for (const [name, [nr, ng, nb]] of Object.entries(NAMED)) {
    const d = (r - nr) ** 2 + (g - ng) ** 2 + (b - nb) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestName = name;
    }
  }
  return { name: bestName, distance: Math.round(Math.sqrt(bestDist)) };
}

// Color-blindness simulation matrices (Brettel/Vienot/Mollon approximation,
// applied directly in sRGB — the same approach the widely-used `color-blind`
// npm library takes). Less accurate than LMS-space simulation but matches
// what every "see how this looks to colorblind users" tool produces.
const CB_MATRICES = {
  protanopia: [[0.567, 0.433, 0], [0.558, 0.442, 0], [0, 0.242, 0.758]],
  deuteranopia: [[0.625, 0.375, 0], [0.7, 0.3, 0], [0, 0.3, 0.7]],
  tritanopia: [[0.95, 0.05, 0], [0, 0.433, 0.567], [0, 0.475, 0.525]],
};
function simulate(rgb, type) {
  const m = CB_MATRICES[type];
  if (!m) throw bad(`unknown simulation: ${type} (expected protanopia, deuteranopia, or tritanopia)`);
  const { r, g, b } = rgb;
  return {
    r: clamp(Math.round(m[0][0] * r + m[0][1] * g + m[0][2] * b), 0, 255),
    g: clamp(Math.round(m[1][0] * r + m[1][1] * g + m[1][2] * b), 0, 255),
    b: clamp(Math.round(m[2][0] * r + m[2][1] * g + m[2][2] * b), 0, 255),
  };
}

// Palette generation — hue rotation in HSL space. Intuitive for designers
// (matches Adobe Color, Coolors, etc.). We could use Oklab for perceptual
// uniformity, but agents asking for a "triadic palette" expect HSL behavior.
function generatePalette(rgb, scheme) {
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const rot = (deg) => formatAll(hslToRgb((h + deg) % 360, s, l));
  const shade = (delta) => formatAll(hslToRgb(h, s, clamp(l + delta, 0, 100)));
  switch (scheme) {
    case "complementary": return [formatAll(rgb), rot(180)];
    case "analogous":     return [rot(-30), formatAll(rgb), rot(30)];
    case "triadic":       return [formatAll(rgb), rot(120), rot(240)];
    case "tetradic":      return [formatAll(rgb), rot(90), rot(180), rot(270)];
    case "split-complementary": return [formatAll(rgb), rot(150), rot(210)];
    case "monochromatic": return [shade(-30), shade(-15), formatAll(rgb), shade(15), shade(30)];
    default: throw bad(`unknown scheme: ${scheme} (expected complementary, analogous, triadic, tetradic, split-complementary, or monochromatic)`);
  }
}

// ============================================================================
// Tool definitions
// ============================================================================
export const COLOR_TOOLS = [
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/color-convert", name: "Color convert", slug: "color-convert",
    category: "data", price: "$0.001",
    description:
      "Convert a color between every common notation (hex, rgb, hsl, oklch) at once, plus return the nearest CSS named color. Accepts input as hex (#fff or #ffffff), rgb()/rgba(), hsl()/hsla(), oklch(), or any of the 148 CSS named colors. Use this when an agent has a color in one format and the next step needs it in another — e.g. converting a designer's Figma hex into OKLCH for a modern Tailwind theme.",
    tags: ["color", "convert", "hex", "rgb", "hsl", "oklch", "css"],
    discovery: {
      bodyType: "json",
      input: { color: "#1d4ed8" },
      inputSchema: {
        properties: {
          color: { type: "string", description: "Color in any supported notation: hex, rgb(), hsl(), oklch(), or a CSS named color." },
        },
        required: ["color"],
      },
      output: {
        example: {
          input: "#1d4ed8",
          hex: "#1d4ed8",
          rgb: { r: 29, g: 78, b: 216 },
          rgbString: "rgb(29, 78, 216)",
          hsl: { h: 224.04, s: 76.42, l: 48.04 },
          hslString: "hsl(224.04, 76.42%, 48.04%)",
          oklch: { L: 0.488, C: 0.217, H: 264.39 },
          oklchString: "oklch(0.488 0.217 264.39)",
          nearestNamed: { name: "royalblue", distance: 51 },
        },
      },
    },
    handler: (i) => {
      if (typeof i.color !== "string") throw bad(`Missing or invalid "color"`);
      const rgb = parseColor(i.color);
      return {
        input: i.color,
        ...formatAll(rgb),
        nearestNamed: nearestNamed(rgb),
      };
    },
  },
  // ---------------------------------------------------------------------------
  // NOTE: WCAG contrast lives in util-kit as the hex-only `color-contrast` slug.
  // Agents needing any-notation contrast can chain color-convert → color-contrast.
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/color-blindness", name: "Color blindness simulation", slug: "color-blindness",
    category: "data", price: "$0.001",
    description:
      "Simulate how a color appears to viewers with protanopia (red-blind), deuteranopia (green-blind), or tritanopia (blue-blind) — the three dichromacy types covering ~8% of men and ~0.5% of women. Returns the simulated RGB plus the contrast ratio against a reference color so you can verify a UI is still legible under each condition. Uses the Brettel/Vienot/Mollon approximation in sRGB (the de-facto standard for web tools).",
    tags: ["color", "accessibility", "a11y", "colorblind", "protanopia", "deuteranopia", "tritanopia"],
    discovery: {
      bodyType: "json",
      input: { color: "#1d4ed8", compareTo: "#22c55e" },
      inputSchema: {
        properties: {
          color: { type: "string", description: "Color to simulate." },
          compareTo: { type: "string", description: "Optional second color — both are simulated and the contrast ratio between the simulated pair is included." },
        },
        required: ["color"],
      },
      output: {
        example: {
          input: "#1d4ed8", compareTo: "#22c55e",
          simulations: {
            protanopia: { hex: "#3f3fcb", originalContrast: 1.93, simulatedContrast: 5.42 },
            deuteranopia: { hex: "#494bcb", originalContrast: 1.93, simulatedContrast: 4.12 },
            tritanopia: { hex: "#2050a4", originalContrast: 1.93, simulatedContrast: 1.41 },
          },
        },
      },
    },
    handler: (i) => {
      if (typeof i.color !== "string") throw bad(`Missing or invalid "color"`);
      const rgb = parseColor(i.color);
      const compare = i.compareTo ? parseColor(i.compareTo) : null;
      const originalContrast = compare ? r2(contrastRatio(rgb, compare)) : null;
      const types = ["protanopia", "deuteranopia", "tritanopia"];
      const simulations = {};
      for (const t of types) {
        const sim = simulate(rgb, t);
        const entry = {
          hex: "#" + [sim.r, sim.g, sim.b].map((n) => n.toString(16).padStart(2, "0")).join(""),
          rgb: sim,
        };
        if (compare) {
          const simCompare = simulate(compare, t);
          entry.originalContrast = originalContrast;
          entry.simulatedContrast = r2(contrastRatio(sim, simCompare));
        }
        simulations[t] = entry;
      }
      return {
        input: i.color,
        ...(i.compareTo ? { compareTo: i.compareTo } : {}),
        simulations,
      };
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/color-palette", name: "Color palette generator", slug: "color-palette",
    category: "data", price: "$0.001",
    description:
      "Generate a coordinated palette from a base color using a named color-theory scheme: complementary (2 colors), analogous (3), triadic (3), tetradic (4), split-complementary (3), or monochromatic (5 lightness variants). Returns each color in hex, rgb, hsl, and oklch so the agent can drop them straight into any framework. Hue rotation happens in HSL — matches Adobe Color / Coolors expectations, not perceptual Oklab geometry.",
    tags: ["color", "palette", "scheme", "design", "complementary", "triadic", "analogous"],
    discovery: {
      bodyType: "json",
      input: { color: "#1d4ed8", scheme: "triadic" },
      inputSchema: {
        properties: {
          color: { type: "string", description: "Base color (any notation parseColor accepts)." },
          scheme: { type: "string", description: "One of: complementary, analogous, triadic, tetradic, split-complementary, monochromatic." },
        },
        required: ["color", "scheme"],
      },
      output: {
        example: {
          base: "#1d4ed8",
          scheme: "triadic",
          colors: [
            { hex: "#1d4ed8", hsl: { h: 224.04, s: 76.42, l: 48.04 } },
            { hex: "#d81d4e", hsl: { h: 344.04, s: 76.42, l: 48.04 } },
            { hex: "#4ed81d", hsl: { h: 104.04, s: 76.42, l: 48.04 } },
          ],
        },
      },
    },
    handler: (i) => {
      if (typeof i.color !== "string") throw bad(`Missing or invalid "color"`);
      if (typeof i.scheme !== "string") throw bad(`Missing or invalid "scheme"`);
      const rgb = parseColor(i.color);
      const colors = generatePalette(rgb, i.scheme);
      return {
        base: i.color,
        scheme: i.scheme,
        colors,
      };
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/color-name", name: "CSS named color lookup", slug: "color-name",
    category: "data", price: "$0.001",
    description:
      "Two-way CSS named color tool. Pass a name (e.g. \"rebeccapurple\") to get its canonical RGB/hex; pass a hex/rgb color to get the closest CSS named color and the distance (RGB Euclidean, 0 = exact match). Useful when an agent needs to convert designer-speak into code, or surface a human-friendly handle for an arbitrary color (e.g. \"that's basically dodgerblue\").",
    tags: ["color", "css", "named", "lookup", "rebeccapurple"],
    discovery: {
      bodyType: "json",
      input: { color: "#6a5acd" },
      inputSchema: {
        properties: {
          color: { type: "string", description: "A CSS color name OR any hex/rgb/hsl/oklch color to find the nearest name for." },
        },
        required: ["color"],
      },
      output: {
        example: {
          input: "#6a5acd",
          isNamed: true,
          name: "slateblue",
          distance: 0,
          hex: "#6a5acd",
          rgb: { r: 106, g: 90, b: 205 },
        },
      },
    },
    handler: (i) => {
      if (typeof i.color !== "string") throw bad(`Missing or invalid "color"`);
      const rgb = parseColor(i.color);
      const nearest = nearestNamed(rgb);
      const hex = "#" + [rgb.r, rgb.g, rgb.b].map((n) => n.toString(16).padStart(2, "0")).join("");
      return {
        input: i.color,
        isNamed: nearest.distance === 0,
        name: nearest.name,
        distance: nearest.distance,
        hex,
        rgb,
      };
    },
  },
];
