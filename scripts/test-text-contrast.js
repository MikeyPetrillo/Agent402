#!/usr/bin/env node
// Every piece of visible text on the served pages must be readable against
// the background it actually sits on, in BOTH themes, at phone and desktop
// widths. Computed styles from real Chromium, not token arithmetic.
//
// Why (2026-09-10, outside feedback on /sell): the hero paragraph used
// --on-dark2 (a token for text on obsidian panels) on the light page body,
// 1.44:1 in light mode - invisible - and nothing caught it, because the
// existing guards check token VALUES (test-faint-contrast) or that tokens
// RESOLVE (test-css-tokens-resolve), never a rendered element against its
// real backdrop. A dark-surface token on a light surface is a class, not a
// line: this walks the DOM.
//
// Rules: WCAG AA - 4.5:1 for text under 24px (18.66px if bold), 3:1 at or
// above. Backdrop = the nearest ancestor with an opaque background-color;
// an ancestor painting a background-image (gradient) is unknowable here and
// the element is skipped, as are transparent, hidden, empty and off-DOM text.
//
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-text-contrast.js
import { chromium } from "playwright";
const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
const PAGES = (process.env.CONTRAST_PAGES || "/,/sell,/status,/reports,/monitors,/pricing,/credits,/docs,/marketplace").split(",").map((p) => p.trim()).filter(Boolean);
const THEMES = ["light", "dark"];
const WIDTHS = [390, 1280];
const MIN_NORMAL = 4.5, MIN_LARGE = 3;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const AUDIT = `(() => {
  const parse = (c) => { const m = String(c).match(/[\\d.]+/g); if (!m) return null; const [r, g, b, a = 1] = m.map(Number); return { r, g, b, a }; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
  // Backdrop: composite ancestor background-colors bottom-up until one is opaque; a gradient anywhere = unknown.
  const backdrop = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== "none") return null;
      const c = parse(s.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    if (!layers.length || layers[layers.length - 1].a < 1) { const b = parse(getComputedStyle(document.body).backgroundColor); if (!b || b.a < 1) return null; layers.push(b); }
    let out = layers[layers.length - 1];
    for (let i = layers.length - 2; i >= 0; i--) out = blend(layers[i], out);
    return out;
  };
  const visible = (el) => { const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.replace(/\\s+/g, " ").trim(); if (text.length < 2) continue;
    const el = n.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
    if (el.closest("script,style,noscript,template,[aria-hidden='true']")) continue;
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color); if (!fg || fg.a === 0) continue;
    if (s.webkitTextFillColor && parse(s.webkitTextFillColor)?.a === 0) continue;
    const bg = backdrop(el); if (!bg) continue;
    const fgc = fg.a < 1 ? blend(fg, bg) : fg;
    const size = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const r = ratio(fgc, bg);
    if (r < (large ? 3 : 4.5)) out.push({ text: text.slice(0, 50), tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 40), color: s.color, bg: \`rgb(\${Math.round(bg.r)}, \${Math.round(bg.g)}, \${Math.round(bg.b)})\`, size, ratio: Number(r.toFixed(2)), need: large ? 3 : 4.5 });
  }
  return out;
})()`;

const browser = await chromium.launch();
try {
  for (const theme of THEMES) for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem("a402-theme", t); } catch {} }, theme);
    const page = await ctx.newPage();
    for (const path of PAGES) {
      let res;
      try { res = await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 30000 }); } catch (e) { ok(false, `${path} did not load (${String(e.message).slice(0, 60)})`); continue; }
      if (!res || res.status() !== 200) { ok(false, `${path} answered ${res?.status()}`); continue; }
      const applied = await page.evaluate(() => document.documentElement.getAttribute("data-theme") || "default");
      const bad = await page.evaluate(AUDIT);
      if (process.env.CONTRAST_VERBOSE && bad.length) for (const b of bad) console.log(`   ${String(b.ratio).padStart(5)}:1  <${b.tag}${b.cls ? "." + b.cls.split(" ")[0] : ""}> "${b.text}"  ${b.color} on ${b.bg}  ${b.size}px${b.need === 3 ? " (large)" : ""}`);
      ok(bad.length === 0, `${path} [${theme} ${width}px, applied=${applied}]: every visible text meets WCAG AA against its backdrop${bad.length ? ` - ${bad.length} below: ` + bad.slice(0, 4).map((b) => `<${b.tag}${b.cls ? "." + b.cls.split(" ")[0] : ""}> "${b.text}" ${b.color} on ${b.bg} = ${b.ratio}:1 (needs ${b.need})`).join("; ") : ""}`);
    }
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
