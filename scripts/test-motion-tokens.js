#!/usr/bin/env node
// Motion guard: every transition and animation on the site speaks in the
// DESIGN.md motion tokens, and the tokens keep the rules DESIGN.md states.
//
//   1. The token file (src/ledger-chrome.js) declares every motion token that
//      DESIGN.md's front matter lists, with the same value.
//   2. UI durations sit in 200 to 400 ms; each exit is 65 to 75% of its
//      entrance; a staggered group (the .ml-stagger rules) starts its last
//      member inside 500 ms; a loop (spin, pulse, beat) runs at 600 ms or slower.
//   3. Under prefers-reduced-motion every duration token is 0ms, and smooth
//      scrolling is off.
//   4. No page module or browser script writes a literal time in a transition
//      or animation declaration (var(--dur-*) and var(--stagger) only; 0s is fine).
//   5. A browser script that animates (a requestAnimationFrame loop, a smooth
//      scroll, element.animate) reads prefers-reduced-motion.
//
// Run: node scripts/test-motion-tokens.js             (repo tree)
//      node scripts/test-motion-tokens.js --self-test (proves it can fail)
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const TOKEN_FILE = "src/ledger-chrome.js";
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`FAIL - ${m}`); } };

// Rasterized SVG has no CSS engine; email has no motion. Same exemptions as
// test-design-tokens.js, plus "design-tokens: off-start" regions.
const EXEMPT_FILES = new Set(["src/og-cards.js", "src/aifi-card.js", "src/email.js", "src/followups.js", "src/free-alerts.js"]);
// A requestAnimationFrame that only batches a repaint (no motion of its own).
const RAF_PAINT_ONLY = {
  "assets/js/market-terminal.js": "rAF coalesces a scroll-driven repaint of the order book; nothing moves on its own",
};

export const UI = ["fast", "base", "slow"];
export const LOOPS = ["spin", "pulse", "beat"];
export const msOf = (v) => {
  const m = String(v || "").trim().match(/^(\d*\.?\d+)(ms|s)$/);
  return m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : NaN;
};

export function tokensIn(css) {
  const root = (css.match(/\n:root \{\n([\s\S]*?--fs-base[\s\S]*?)\n\}/) || [, ""])[1];
  const out = {};
  for (const m of root.matchAll(/--((?:dur|ease)-[a-z-]+|stagger):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

export function tokenRuleProblems(t, staggerMembers) {
  const out = [];
  for (const k of UI) {
    const v = msOf(t[`dur-${k}`]);
    if (!(v >= 200 && v <= 400)) out.push(`--dur-${k} is ${t[`dur-${k}`]} (UI motion is 200 to 400 ms)`);
    const x = msOf(t[`dur-${k}-exit`]);
    if (!(x >= v * 0.65 - 1e-9 && x <= v * 0.75 + 1e-9)) out.push(`--dur-${k}-exit is ${t[`dur-${k}-exit`]} (an exit is 65 to 75% of its entrance, ${v * 0.65} to ${v * 0.75} ms)`);
  }
  const s = msOf(t.stagger);
  if (!(s > 0) || s * (staggerMembers - 1) >= 500) out.push(`--stagger ${t.stagger} over ${staggerMembers} members starts the last at ${s * (staggerMembers - 1)} ms (under 500 ms)`);
  for (const k of LOOPS) if (!(msOf(t[`dur-${k}`]) >= 600)) out.push(`--dur-${k} is ${t[`dur-${k}`]} (a loop runs at 600 ms or slower)`);
  for (const k of ["ease-out", "ease-in", "ease-in-out"]) if (!/^cubic-bezier\(/.test(t[k] || "")) out.push(`--${k} is not a cubic-bezier curve`);
  return out;
}

// The reduced-motion block: every duration token at 0ms, smooth scroll off.
export function reducedProblems(css, t) {
  const block = (css.match(/@media \(prefers-reduced-motion: reduce\) \{\n  :root \{([^}]*)\}\n  html \{ scroll-behavior: auto !important; \}\n\}/) || [, null])[1];
  if (block == null) return ["the token file has no reduced-motion block that sets the motion tokens on :root and turns smooth scrolling off"];
  const out = [];
  for (const k of Object.keys(t).filter((n) => n.startsWith("dur-") || n === "stagger")) {
    if (!new RegExp(`--${k}:\\s*0ms;`).test(block)) out.push(`under reduced motion --${k} is not 0ms`);
  }
  return out;
}

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .split("\n").map((l) => l.replace(/(^|[\s;,{}()])\/\/(?!\/).*$/, (m, p) => p)).join("\n");

// A motion declaration: CSS (transition: / animation-delay: ...) or a script
// assignment (el.style.transition = "...", transitionDuration = ...).
const DECL_RE = /(?<![\w-])(transition|animation)(-duration|-delay|Duration|Delay)?\s*(?::|=)\s*(["'`]?)([^;"'`}\n]*)/g;
const TIME_RE = /(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g;
export function scanLiterals(rel, src) {
  if (EXEMPT_FILES.has(rel)) return [];
  const raw = src.split("\n");
  const lines = stripComments(src).split("\n");
  const out = [];
  let off = false;
  lines.forEach((line, i) => {
    if (/design-tokens:\s*off-start/.test(raw[i])) off = true;
    if (/design-tokens:\s*off-end/.test(raw[i])) { off = false; return; }
    if (off) return;
    if (rel === TOKEN_FILE && /^\s*--(dur|ease)-|^\s*--stagger:|^\s*:root \{ --dur-/.test(line)) return;
    for (const m of line.matchAll(DECL_RE)) {
      const value = m[4].replace(/var\([^()]*\)/g, "");
      for (const t of value.matchAll(TIME_RE)) {
        if (Number(t[1]) === 0) continue;
        out.push(`${rel}:${i + 1}: literal time ${t[0]} in "${m[0].trim().slice(0, 60)}" (use var(--dur-*) or var(--stagger))`);
      }
    }
  });
  return out;
}

export function scriptMotionProblems(rel, src) {
  const code = stripComments(src);
  const animates = (/requestAnimationFrame\s*\(/.test(code) && !RAF_PAINT_ONLY[rel]) || /behavior\s*:\s*["']smooth["']/.test(code) || /\.animate\s*\(/.test(code);
  if (!animates) return [];
  return /prefers-reduced-motion/.test(code) ? [] : [`${rel}: animates (rAF loop, smooth scroll or element.animate) without reading prefers-reduced-motion`];
}

function modules() {
  const out = [];
  for (const f of readdirSync(new URL("src/", ROOT))) if (f.endsWith(".js")) out.push(`src/${f}`);
  for (const f of readdirSync(new URL("assets/js/", ROOT))) if (f.endsWith(".js")) out.push(`assets/js/${f}`);
  for (const f of readdirSync(new URL("assets/credits/", ROOT))) if (f.endsWith(".js")) out.push(`assets/credits/${f}`);
  return out.sort();
}

// DESIGN.md front matter: a "motion:" map of token: value.
export function designMotion(md) {
  const fm = (md.match(/^---\n([\s\S]*?)\n---/) || [, ""])[1];
  const block = (fm.match(/\nmotion:[^\n]*\n((?:  [^\n]*\n)+)/) || [, ""])[1];
  const out = {};
  for (const m of block.matchAll(/^ {2}(?: {2})?([a-z-]+):\s*("?)([^"#\n]+?)\2\s*(?:#.*)?$/gm)) if (/^(dur-|ease-|stagger$)/.test(m[1])) out[m[1]] = m[3].trim();
  return out;
}

if (process.argv.includes("--self-test")) {
  ok(scanLiterals("src/x.js", `.a{transition:opacity .3s ease}`).length === 1, "a literal transition time is caught");
  ok(scanLiterals("src/x.js", `.a{animation:spin 600ms linear infinite}`).length === 1, "a literal animation time is caught");
  ok(scanLiterals("src/x.js", `.a{animation-delay:.42s}`).length === 1, "a literal delay is caught");
  ok(scanLiterals("assets/js/x.js", `el.style.transition = 'transform .2s';`).length === 1, "a script's literal transition is caught");
  ok(scanLiterals("src/x.js", `.a{transition:opacity var(--dur-fast) var(--ease-out);animation-delay:calc(var(--stagger) * 2)}`).length === 0, "tokens pass");
  ok(scanLiterals("src/x.js", `.a{transition:none;animation-delay:0s}`).length === 0, "none and 0s pass");
  ok(scanLiterals("src/x.js", `// design-tokens: off-start (svg)\n.a{transition:opacity .3s}\n// design-tokens: off-end`).length === 0, "an off region is exempt");
  ok(scriptMotionProblems("assets/js/x.js", `function f(){requestAnimationFrame(f)}`).length === 1, "an rAF loop without a reduced-motion read is caught");
  ok(scriptMotionProblems("assets/js/x.js", `el.scrollIntoView({behavior:'smooth'})`).length === 1, "a smooth scroll without a reduced-motion read is caught");
  ok(scriptMotionProblems("assets/js/x.js", `var r=matchMedia('(prefers-reduced-motion: reduce)');function f(){requestAnimationFrame(f)}`).length === 0, "a loop that reads reduced motion passes");
  const good = { "dur-fast": "200ms", "dur-base": "300ms", "dur-slow": "400ms", "dur-fast-exit": "140ms", "dur-base-exit": "210ms", "dur-slow-exit": "280ms", stagger: "60ms", "dur-spin": "800ms", "dur-pulse": "1800ms", "dur-beat": "1000ms", "ease-out": "cubic-bezier(.22,.61,.36,1)", "ease-in": "cubic-bezier(.55,0,1,.45)", "ease-in-out": "cubic-bezier(.65,0,.35,1)" };
  ok(tokenRuleProblems(good, 6).length === 0, "the documented tokens pass their rules");
  ok(tokenRuleProblems({ ...good, "dur-slow": "750ms" }, 6).length >= 1, "a 750 ms UI duration is caught");
  ok(tokenRuleProblems({ ...good, "dur-base-exit": "300ms" }, 6).length === 1, "an exit as long as its entrance is caught");
  ok(tokenRuleProblems({ ...good, stagger: "120ms" }, 6).length === 1, "a stagger whose last member starts at 600 ms is caught");
  ok(tokenRuleProblems({ ...good, "dur-pulse": "300ms" }, 6).length === 1, "a loop faster than 600 ms is caught");
  const css = `\n:root {\n  --fs-base: 15px;\n  --dur-fast: 200ms;\n  --stagger: 60ms;\n}\n@media (prefers-reduced-motion: reduce) {\n  :root { --dur-fast: 0ms; }\n  html { scroll-behavior: auto !important; }\n}`;
  ok(reducedProblems(css, tokensIn(css)).length === 1, "a token left moving under reduced motion is caught");
  ok(msOf("1.2s") === 1200 && msOf("140ms") === 140 && Number.isNaN(msOf("fast")), "durations parse");
} else {
  const css = read(TOKEN_FILE);
  const t = tokensIn(css);
  const staggerMembers = 1 + [...css.matchAll(/\.ml-stagger > \*:nth-child\([^)]*\) \{ animation-delay: calc\(var\(--stagger\) \* (\d+)\); \}/g)].reduce((a, m) => Math.max(a, Number(m[1])), 0);
  ok(Object.keys(t).length >= 13, `the token file declares the motion tokens (${Object.keys(t).length})`);
  for (const p of tokenRuleProblems(t, staggerMembers)) ok(false, p);
  for (const p of reducedProblems(css, t)) ok(false, p);
  const md = designMotion(read("DESIGN.md"));
  ok(Object.keys(md).length === Object.keys(t).length, `DESIGN.md lists every motion token (${Object.keys(md).length} of ${Object.keys(t).length})`);
  for (const [k, v] of Object.entries(t)) ok(md[k] === v, `DESIGN.md --${k} is ${md[k]}, the token file says ${v}`);
  ok(/\n## Motion\n/.test(read("DESIGN.md")), "DESIGN.md has a Motion section");
  const problems = [];
  for (const rel of modules()) {
    const src = read(rel);
    problems.push(...scanLiterals(rel, src));
    if (rel.startsWith("assets/")) problems.push(...scriptMotionProblems(rel, src));
  }
  ok(problems.length === 0, `motion stays on the DESIGN.md tokens (${problems.length} problems)\n  ${problems.join("\n  ")}`);
}

console.log(`${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
