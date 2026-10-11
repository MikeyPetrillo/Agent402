#!/usr/bin/env node
// Design-token guard: page modules speak in DESIGN.md tokens, not literals.
//
// The site drifted to 159 distinct hex colors and 78 distinct font sizes
// because every page re-picked its own values, and a renamed accent left
// failure states rendering in the brand green. This keeps the drift from
// coming back. Scope: every top-level page module in src/ and every browser
// script in assets/js/.
//
// Two rules:
//   TOKEN rule (the default). No raw hex color in a style context and no
//     literal font-size: colors come from var(--token), sizes from
//     var(--fs-*) (or inherit / a clamp() over var(--fs-*) bounds).
//   LITERAL rule (email and other places a stylesheet cannot reach). Literals
//     are allowed, but a hex must be a DESIGN.md palette value (any value the
//     token file defines, in either theme) and a font-size must be a step of
//     the type scale in px.
//
// Where the LITERAL rule applies, and why (each entry is the documented
// allowlist this guard was asked for):
//   - LITERAL_FILES below: whole modules that only build email HTML.
//   - a line ending in a "design-tokens: literal" comment: one inline email
//     body inside a mixed module.
//   - a region between "design-tokens: literal-start (reason)" and
//     "design-tokens: literal-end": print CSS, a standalone HTML fallback page,
//     the public SVG badge.
// Fully exempt (no rule):
//   - token declarations (--name: value) in the token file, src/ledger-chrome.js.
//   - EXEMPT_FILES below.
//   - a region between "design-tokens: off-start (reason)" and
//     "design-tokens: off-end": SVG rasterized to PNG (no CSS engine at all)
//     and a data-viz categorical palette.
// SVG presentation attributes (font-size="30") are user units, not CSS, and
// are not checked.
//
// Run: node scripts/test-design-tokens.js            (repo tree)
//      node scripts/test-design-tokens.js --self-test (proves it can fail)
import { readFileSync, readdirSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const TOKEN_FILE = "src/ledger-chrome.js";

const EXEMPT_FILES = {
  "src/og-cards.js": "social cards are SVG rasterized to PNG by resvg, which has no CSS custom properties",
  "src/aifi-card.js": "SVG rasterized to PNG, same reason as og-cards",
};
const LITERAL_FILES = {
  "src/email.js": "transactional email HTML: mail clients strip <style> and custom properties",
  "src/followups.js": "follow-up email HTML",
  "src/free-alerts.js": "alert email HTML",
  "src/wallet-digest.js": "weekly digest email HTML",
};

// ---- palette and scale, read from the token file ------------------------------
const tokenSrc = readFileSync(new URL(TOKEN_FILE, ROOT), "utf8");
const norm = (h) => {
  let x = h.slice(1).toLowerCase();
  if (x.length === 3 || x.length === 4) x = [...x].map((c) => c + c).join("");
  return "#" + x;
};
// Palette = every hex value inside a token declaration (--name: ...;) in the
// token file, both themes. Gradients count: their stops are palette values.
const PALETTE = new Set();
for (const m of tokenSrc.matchAll(/--[a-z0-9-]+:\s*([^;]+);/g)) {
  for (const h of m[1].matchAll(/#[0-9a-fA-F]{3,8}\b/g)) PALETTE.add(norm(h[0]));
}
const SCALE_PX = new Set();
for (const m of tokenSrc.matchAll(/--fs-[a-z0-9-]+:\s*([\d.]+)px;/g)) SCALE_PX.add(Number(m[1]));

// ---- source scanning ------------------------------------------------------------
// Comments carry issue numbers (#645) and history; strip them, keeping line
// breaks so line numbers stay true. A // only starts a comment when it is not
// part of a URL (preceded by ":") or a string that contains one.
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.split("\n").map((l) => l.replace(/(^|[\s;,{}()])\/\/(?!\/).*$/, (m, p) => p)).join("\n");
  return out;
}
// A hex color in a style context: after ":" (CSS), "=" or a quote (attribute,
// JS string), "(" or "," (functions, fallbacks), or whitespace (border shorthand).
const HEX_RE = /(?<=[:=\s(,"'`])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/g;
// A token that is all decimal digits is almost always an issue or PR number
// (#645, #402) rather than a color; the only digit-only colors in use are
// repeated-digit grays (#000, #555, #999999).
// A short all-letter token is a CSS id or anchor (#add, #faq) unless it is a
// repeated-letter gray (#fff, #eee).
const looksLikeColor = (body) => {
  if (/^[a-fA-F]{3,4}$/.test(body)) return /^(.)\1+$/i.test(body);
  return /[a-fA-F]/.test(body) || /^(\d)\1+$/.test(body);
};
const FS_RE = /font-size\s*:\s*([^;"'`}]+)/g;
const FONT_SHORT_RE = /(?<![-\w])font\s*:\s*([^;"'`}]+)/g;

function classify(rel, lines) {
  // Returns a per-line rule: "token" | "literal" | "off".
  const fileRule = EXEMPT_FILES[rel] ? "off" : LITERAL_FILES[rel] ? "literal" : "token";
  const rules = [];
  let region = null;
  for (const line of lines) {
    if (/design-tokens:\s*(literal|off)-end/.test(line)) { rules.push(region || fileRule); region = null; continue; }
    const start = line.match(/design-tokens:\s*(literal|off)-start/);
    if (start) { region = start[1]; rules.push(region); continue; }
    if (region) { rules.push(region); continue; }
    if (/design-tokens:\s*literal\b(?!-)/.test(line)) { rules.push("literal"); continue; }
    rules.push(fileRule);
  }
  return rules;
}

export function scan(rel, src) {
  const rawLines = src.split("\n");
  const rules = classify(rel, rawLines);
  const lines = stripComments(src).split("\n");
  const problems = [];
  lines.forEach((line, i) => {
    const rule = rules[i];
    if (rule === "off") return;
    // A custom-property declaration is a token definition: legal only in the
    // token file, a violation anywhere else (a page minting its own palette).
    if (/^\s*--[a-z0-9-]+\s*:/.test(line)) {
      if (rel !== TOKEN_FILE && HEX_RE.test(line)) problems.push(`${rel}:${i + 1}: a page module defines its own color token (define it in ${TOKEN_FILE})`);
      HEX_RE.lastIndex = 0;
      return;
    }
    for (const m of line.matchAll(HEX_RE)) {
      if (!looksLikeColor(m[1])) continue;
      if (line[m.index - 1] === "&") continue; // &#160; entity
      const hex = "#" + m[1];
      if (rule === "token") problems.push(`${rel}:${i + 1}: raw color ${hex} (use a var(--token) from DESIGN.md)`);
      else if (!PALETTE.has(norm(hex))) problems.push(`${rel}:${i + 1}: ${hex} is not a DESIGN.md palette value`);
    }
    const sizes = [...line.matchAll(FS_RE)].map((m) => m[1]);
    for (const m of line.matchAll(FONT_SHORT_RE)) sizes.push(m[1]);
    for (const raw of sizes) {
      const v = raw.trim();
      const lits = [...v.replace(/var\([^)]*\)/g, "").matchAll(/(\d*\.?\d+)(px|rem|em|pt)\b/g)];
      if (!lits.length) continue;
      if (rule === "token") { problems.push(`${rel}:${i + 1}: literal font size "${v.slice(0, 40)}" (use var(--fs-*))`); continue; }
      for (const l of lits) {
        if (l[2] !== "px" || !SCALE_PX.has(Number(l[1]))) problems.push(`${rel}:${i + 1}: font size ${l[0]} is off the DESIGN.md scale (${[...SCALE_PX].join(", ")}px)`);
      }
    }
  });
  return problems;
}

function pageModules() {
  const out = [];
  for (const f of readdirSync(new URL("src/", ROOT))) if (f.endsWith(".js")) out.push(`src/${f}`);
  for (const f of readdirSync(new URL("assets/js/", ROOT))) if (f.endsWith(".js")) out.push(`assets/js/${f}`);
  return out.sort();
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`FAIL - ${m}`); } };

if (process.argv.includes("--self-test")) {
  // The guard has to be able to fail: each of these must be caught.
  ok(scan("src/x.js", `const css = ".a{color:#4ade80}";`).length === 1, "a stray hex in a page module is caught");
  ok(scan("src/x.js", `<div style="font-size:13px">`).length === 1, "a literal font size is caught");
  ok(scan("src/x.js", `.a{font:14px/1.4 system-ui}`).length === 1, "a font shorthand size is caught");
  ok(scan("src/x.js", `// see #645 and #402\nconst s = "PR #985";`).length === 0, "issue numbers are not colors");
  ok(scan("src/x.js", `<a href="/docs#add">`).length === 0, "anchors are not colors");
  ok(scan("src/x.js", `#quickstart, #how, #add { scroll-margin-top:80px }`).length === 0, "id selectors are not colors");
  ok(scan("src/x.js", `.a{color:#fff}`).length === 1, "a short repeated-letter gray is still a color");
  ok(scan("src/x.js", `.a{font-size:var(--fs-sm);color:var(--ink)}`).length === 0, "tokens pass");
  ok(scan("src/email.js", `<p style="color:#0F5E43;font-size:13px">`).length === 0, "email: palette hex and scale size pass");
  ok(scan("src/email.js", `<p style="color:#8a948c;font-size:12.5px">`).length === 2, "email: off-palette hex and off-scale size fail");
  ok(scan("src/x.js", `x // design-tokens: off-start (svg)\nfill="#123456"\n// design-tokens: off-end`).length === 0, "an off region is exempt");
  ok(scan("src/x.js", `html: \`<p style="color:#0F5E43">\`, // design-tokens: literal`).length === 0, "a literal-pragma line takes palette values");
  ok(PALETTE.has("#0f5e43") && PALETTE.has("#34a877") && SCALE_PX.has(13), "palette and scale are read from the token file");
  ok(!PALETTE.has("#4ade80"), "the retired Tailwind green is not in the palette");
} else {
  const problems = [];
  for (const rel of pageModules()) problems.push(...scan(rel, readFileSync(new URL(rel, ROOT), "utf8")));
  ok(SCALE_PX.size >= 8, `the token file defines a type scale (${SCALE_PX.size} steps)`);
  ok(PALETTE.size >= 20, `the token file defines a palette (${PALETTE.size} values)`);
  ok(problems.length === 0, `page modules stay on DESIGN.md tokens (${problems.length} problems)\n  ${problems.slice(0, Number(process.env.SHOW || 60)).join("\n  ")}${problems.length > Number(process.env.SHOW || 60) ? `\n  ... ${problems.length - Number(process.env.SHOW || 60)} more` : ""}`);
}

console.log(`${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
