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
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
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
const RADIUS_RE = /border(?:-[a-z]+)*-radius\s*:\s*([^;"'`}!]+)/g;
const PRIMARY_CTX = /btn-primary|--btn-bg|ml-nav-cta|ml-mm-cta/;
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
    // Radius stance: surfaces and controls take var(--radius), the primary
    // (money) button alone takes var(--radius-pill), 50% draws a dot. Literal
    // regions may write the same values out: 0, 50%, 4px, 999px.
    for (const m of line.matchAll(RADIUS_RE)) {
      const v = m[1].trim();
      if (rule === "token") {
        const parts = v.split(/\s+/);
        if (!parts.every((p) => /^(0|0px|50%|var\(--radius\)|var\(--radius-pill\))$/.test(p))) problems.push(`${rel}:${i + 1}: border radius "${v}" (use var(--radius), var(--radius-pill) or 50%)`);
      } else if (!v.split(/\s+/).every((p) => /^(0|0px|50%|4px|999px)$/.test(p))) problems.push(`${rel}:${i + 1}: border radius "${v}" is off the DESIGN.md stance (0, 50%, 4px, 999px)`);
    }
    if (rule === "token" && line.includes("var(--radius-pill)") && !PRIMARY_CTX.test(line)) problems.push(`${rel}:${i + 1}: the pill radius belongs to the primary button only`);
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
  if (!EXEMPT_FILES[rel] && !LITERAL_FILES[rel] && rel !== TOKEN_FILE) problems.push(...scanHeadings(rel, stripComments(src)));
  return problems;
}

// Headings: one weight per level (h1 800, h2 700, h3 600), and the display
// serif only on h1, where it is set at 400 (Instrument Serif ships one weight;
// anything heavier is a synthesized fake bold). Read from inline <hN style>
// and from CSS rules whose selector names the level (h1, .x-h1, .x h2).
export const HEADING_WEIGHT = { h1: "800", h2: "700", h3: "600" };
export function scanHeadings(rel, src) {
  const out = [];
  const lineOf = (idx) => src.slice(0, idx).split("\n").length;
  const check = (level, decls, idx) => {
    const w = (decls.match(/font-weight\s*:\s*(\d+)/) || [])[1];
    const display = /var\(--font-display\)/.test(decls);
    if (display && level !== "h1") out.push(`${rel}:${lineOf(idx)}: the display serif is for h1 only (found on ${level})`);
    else if (display && w && w !== "400") out.push(`${rel}:${lineOf(idx)}: display h1 weight ${w} (the serif is set at 400)`);
    else if (!display && w && w !== HEADING_WEIGHT[level]) out.push(`${rel}:${lineOf(idx)}: ${level} weight ${w} (DESIGN.md: ${HEADING_WEIGHT[level]})`);
  };
  for (const m of src.matchAll(/<(h[1-6])\b[^>]*?\sstyle="([^"]*)"/g)) if (HEADING_WEIGHT[m[1]] || /--font-display/.test(m[2])) check(m[1], m[2], m.index);
  for (const m of src.matchAll(/([^{}\n`]*)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (!/^[\s.#a-zA-Z0-9_,>:\-\[\]="*()+~]+$/.test(sel) || /\b(return|const|let|if|function)\b|=>/.test(sel) || !/font-/.test(m[2]) || /[=`]/.test(m[2])) continue;
    const lv = sel.match(/(?:^|[\s,.>#-])(h[1-6])(?![\w])/);
    if (lv && HEADING_WEIGHT[lv[1]]) check(lv[1], m[2], m.index);
    else if (/var\(--font-display\)/.test(m[2])) out.push(`${rel}:${lineOf(m.index)}: the display serif is for h1 only (selector "${sel.slice(0, 40)}")`);
  }
  // A display face anywhere else (an inline style on a non-heading element).
  for (const m of src.matchAll(/<(?!h[1-6]\b)([a-z0-9]+)\b[^>]*?\sstyle="[^"]*var\(--font-display\)/g)) out.push(`${rel}:${lineOf(m.index)}: the display serif is for h1 only (found on <${m[1]}>)`);
  return out;
}

// ---- controls, focus, prose step, skip link and code blocks (DESIGN.md "Controls and focus") ----
// WCAG 1.4.11 asks 3:1 for the boundary of a control and for a focus
// indicator, against every ground it sits on. Computed from the token file in
// both themes, so a palette edit that drops one under 3:1 fails here.
const themeBlock = (re) => (tokenSrc.match(re) || [, ""])[1];
const LIGHT = themeBlock(/\n:root \{\n([\s\S]*?--fs-base[\s\S]*?)\n\}/);
const DARK = themeBlock(/:root\[data-theme="dark"\] \{\n([\s\S]*?)\n\}/);
const tokenIn = (block, name) => (block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`)) || [])[1] || null;
const lum = (hex) => { const f = (i) => { const v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(1) + 0.7152 * f(3) + 0.0722 * f(5); };
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const GROUNDS = ["paper", "card", "card-zebra", "footer-bg"];
const PANELS = ["panel"];
// A rule that styles a form field and bounds it with --hairline or --dash (1.2 to 1.7:1).
const CONTROL_SEL = /(^|[\s,>.#-])(input|select|textarea|field)\b|search|-sel\b/;
const CONTROL_BORDER_PENDING = {
  "src/operator.js": "the operator sign-in field sits on an obsidian panel and takes panel rules",
};
export function controlRuleProblems(rel, src) {
  if (CONTROL_BORDER_PENDING[rel] || EXEMPT_FILES[rel] || LITERAL_FILES[rel]) return [];
  const out = [];
  const code = stripComments(src);
  for (const m of code.matchAll(/([^{}\n`]*)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (!sel || /\b(return|const|let|if|function)\b|=>/.test(sel) || !CONTROL_SEL.test(sel) || /wrap\b|-tw\b|label|btn/.test(sel) && !/search-wrap/.test(sel)) continue;
    if (/border(-color)?\s*:[^;]*var\(--(hairline|dash)\)/.test(m[2])) out.push(`${rel}:${code.slice(0, m.index).split("\n").length}: "${sel.slice(0, 50)}" bounds a form control with --hairline or --dash (use var(--control))`);
  }
  return out;
}
function checkControlsAndFocus() {
  for (const [theme, block] of [["light", LIGHT], ["dark", DARK]]) {
    const control = tokenIn(block, "control");
    ok(!!control, `${theme}: the token file defines --control (got ${control})`);
    if (!control) continue;
    for (const g of GROUNDS) {
      const bg = tokenIn(block, g);
      const r = bg ? contrast(control, bg) : 0;
      ok(r >= 3, `${theme}: --control ${control} on --${g} ${bg} is ${r.toFixed(2)}:1 (WCAG 1.4.11 needs 3:1)`);
      const accent = tokenIn(block, "accent");
      const ra = bg && accent ? contrast(accent, bg) : 0;
      ok(ra >= 3, `${theme}: the focus ring (--accent ${accent}) on --${g} is ${ra.toFixed(2)}:1`);
    }
    for (const g of PANELS) {
      const bg = tokenIn(block, g), lit = tokenIn(block, "accent-lit") || tokenIn(LIGHT, "accent-lit");
      const r = bg && lit ? contrast(lit, bg) : 0;
      ok(r >= 3, `${theme}: the panel focus ring (--accent-lit ${lit}) on --${g} ${bg} is ${r.toFixed(2)}:1`);
      const pc = tokenIn(LIGHT, "on-panel-faint"), rp = bg && pc ? contrast(pc, bg) : 0;
      ok(rp >= 3, `${theme}: an outlined button on a panel (--on-panel-faint ${pc}) is ${rp.toFixed(2)}:1 on --${g}`);
    }
  }
  ok(/--fs-prose:\s*16px;/.test(LIGHT) && SCALE_PX.has(16), "the type scale has the 16px prose step (--fs-prose)");
  const css = tokenSrc;
  ok(/\n:focus-visible \{ outline: 2px solid var\(--accent\) !important; outline-offset: 2px; \}/.test(css), "one 2px --accent focus ring for every interactive element");
  ok(/\.on-panel :focus-visible[^{]*\.ml-code :focus-visible[^{]*\{ outline-color: var\(--accent-lit\) !important; \}/.test(css), "on a panel or a code block the ring is --accent-lit");
  ok(/\.btn-secondary \{[^}]*border-color:var\(--control\)/.test(css) && /\.mfb-sel,\.mfb-search\{[^}]*border:1px solid var\(--control\)/.test(css), "the outlined button and the shared filter fields are bounded by --control");
  ok(/:where\(input:not\([^)]*\), select, textarea\) \{ border-color: var\(--control\); \}/.test(css), "a field with no page rule is bounded by --control");
  ok(/<body[^>]*><!--email_off-->\n<a class="ml-skip" href="#main">Skip to content<\/a>\n\$\{nav\(activePath\)\}\n<main id="main" tabindex="-1">/.test(css), "the shell's first focusable element is the skip link to <main id=main>");
  ok(/\.ml-skip:focus \{ top: 12px; \}/.test(css), "the skip link shows when it has focus");
  ok(/\.ml-nav-link \{ display: inline-block; min-height: 24px;/.test(css) && /\.ml-foot-links > a \{[^}]*min-height: 24px; min-width: 24px;/.test(css), "nav and footer links are at least 24px targets");
  // Code blocks: the shared component, and no hand-made <pre> in the modules that moved to it.
  ok(/\.ml-code \{ position: relative;[^}]*background: var\(--panel\)/.test(css) && /\.ml-code-copy \{[^}]*min-height: 28px/.test(css), "the code block component and its copy button are styled from tokens in the token file");
  for (const rel of ["src/pages.js", "src/ledger-docs.js", "src/badges.js", "src/page-html.js"]) {
    const src = stripComments(readFileSync(new URL(rel, ROOT), "utf8"));
    ok(!/<pre[\s>]/.test(src) && /codeBlock\(/.test(src), `${rel}: every code block is codeBlock() (no hand-made <pre>)`);
  }
  // Modules that write a block literally (no codeBlock() call) open it with the
  // component's own wrapper; none styles its own <pre>.
  const CODE_MODULES = ["decide-page", "ledger-catalog", "what-is-x402", "what-is-mpp", "learn", "skills", "integration-pages", "ledger-integrations",
    "webhooks", "sell", "x402-test-page", "market-page", "credits-page", "markets", "revenue-live", "analytics-page", "quickstart", "contribute"];
  for (const name of CODE_MODULES) {
    const src = stripComments(readFileSync(new URL(`src/${name}.js`, ROOT), "utf8"));
    const bare = [...src.matchAll(/<pre[\s>]/g)].filter((m) => !/<div class="ml-code[^"<>]*"[^<>]*>$/.test(src.slice(Math.max(0, m.index - 200), m.index)));
    ok(bare.length === 0 && !/(^|[\s.}#])[\w.-]*\s+pre\s*\{|(^|\n)pre\s*\{|class="[^"]*-pre\b/.test(src), `src/${name}.js: every code block is the shared component (${bare.length} hand-made <pre>)`);
  }
  for (const rel of ["src/guides.js", "src/docs.js", "src/blog.js"]) {
    const src = readFileSync(new URL(rel, ROOT), "utf8");
    ok(/wrapCodeBlocks\(/.test(src) && !/(^|[\s.}])(gp-body|post-body|ml-docs-main) pre\s*\{/m.test(src), `${rel}: rendered markdown code goes through wrapCodeBlocks() and no page rule restyles it`);
  }
  // The stylesheet is inlined in every page's head: a tag name in its comments
  // (a main, pre, nav or footer tag) is read as markup by every HTML reader that slices a page.
  const cssText = (tokenSrc.match(/export const LEDGER_CSS = `([\s\S]*?)`;/) || [, ""])[1];
  ok(cssText.length > 1000 && !/<\/?(main|pre|nav|footer|script|style|body)\b/.test(cssText), "the shared stylesheet names no landmark or block tag as markup");
  const chromeJs = readFileSync(new URL("assets/js/site-chrome.js", ROOT), "utf8");
  ok(/window\.a402CodeBlocks=function/.test(chromeJs) && /setAttribute\('aria-live','polite'\)/.test(chromeJs) && /btn\.type='button'/.test(chromeJs), "site-chrome.js adds a real copy button and a polite live region to every code block");
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
  ok(scan("src/x.js", `.card{border-radius:12px}`).length === 1, "a literal radius is caught");
  ok(scan("src/x.js", `.chip{border-radius:var(--radius-pill)}`).length === 1, "a pill outside the primary button is caught");
  ok(scan("src/x.js", `.btn-primary{border-radius:var(--radius-pill)} .dot{border-radius:50%} .c{border-radius:var(--radius) var(--radius) 0 0}`).length === 0, "token radii, the primary pill and dots pass");
  ok(scan("src/x.js", `<h2 style="font-family:var(--font-display);font-weight:400">`).length === 1, "the serif on an h2 is caught");
  ok(scan("src/x.js", `<div style="font-family:var(--font-display)">`).length === 1, "the serif on a non-heading is caught");
  ok(scan("src/x.js", `<h1 style="font-family:var(--font-display);font-weight:800">`).length === 1, "a fake-bold serif h1 is caught");
  ok(scan("src/x.js", `<h1 style="font-family:var(--font-display);font-weight:400">`).length === 0, "a display h1 at 400 passes");
  ok(scan("src/x.js", `.x-h2{font-weight:800;font-size:var(--fs-xl)}`).length === 1, "an off-level heading weight is caught");
  ok(scan("src/x.js", `<h3 style="font-weight:600">`).length === 0, "the level weight passes");
  ok(controlRuleProblems("src/x.js", `.x-search input{padding:8px;border:1px solid var(--hairline);}`).length === 1, "a field bounded by the hairline is caught");
  ok(controlRuleProblems("src/x.js", `.x select{border:1px solid var(--control)} .x-card{border:1px solid var(--hairline)}`).length === 0, "a field on --control and a card on the hairline pass");
} else {
  const problems = [];
  for (const rel of pageModules()) problems.push(...scan(rel, readFileSync(new URL(rel, ROOT), "utf8")));
  for (const rel of pageModules()) problems.push(...controlRuleProblems(rel, readFileSync(new URL(rel, ROOT), "utf8")));
  checkControlsAndFocus();
  ok(SCALE_PX.size >= 8, `the token file defines a type scale (${SCALE_PX.size} steps)`);
  ok(PALETTE.size >= 20, `the token file defines a palette (${PALETTE.size} values)`);
  ok(problems.length === 0, `page modules stay on DESIGN.md tokens (${problems.length} problems)\n  ${problems.slice(0, Number(process.env.SHOW || 60)).join("\n  ")}${problems.length > Number(process.env.SHOW || 60) ? `\n  ... ${problems.length - Number(process.env.SHOW || 60)} more` : ""}`);
}

console.log(`${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
