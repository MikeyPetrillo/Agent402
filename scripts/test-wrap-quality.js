#!/usr/bin/env node
// Wrap quality, measured: every visible text block on the public pages is laid
// out in real Chromium at desktop (1440) and phone (400) widths, its line boxes
// are read back with Range.getClientRects(), and three shapes fail:
//
//  rag     a block of 2+ lines whose last line is shorter than 30% of its
//          widest line, or holds fewer than 3 words (a 2-word tail is allowed
//          only on a block of 5 words or fewer) (p, li, h1-h4, figcaption,
//          td, th, dd, dt, label, blockquote, and any class naming lede/intro/meta)
//  split   a label that must sit on one line renders on 2+: small mono text,
//          uppercase letter-spaced labels, .ml-meta tags, chips, buttons, nav
//          links, kickers, and each link of a link row
//  lone    a row of links or chips (.ml-items, or any container whose children
//          are all links/chips) whose last visual row holds one item while the
//          row above holds 3+
//  overflow the page scrolls sideways (a whole label wider than its column)
//
// Eyeballing a page missed these more than once; counting line boxes does not.
// DESIGN.md "Wrap" states the rules this enforces.
//
//   node scripts/test-wrap-quality.js                 (boots its own FREE_MODE server)
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-wrap-quality.js
//   WRAP_PAGES=/,/sell WRAP_WIDTHS=1440 ...           (narrow a run while fixing)
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { getFreePort } from "./lib/free-port.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = (process.env.WRAP_PAGES || [
  "/", "/reports", "/monitors", "/tools", "/pricing", "/docs", "/sell", "/marketplace", "/revenue",
  "/tollbooth", "/leaderboard", "/status", "/integrations", "/faq", "/privacy", "/terms",
  "/transparency", "/x402-test", "/playground", "/skills", "/tools/json-format", "/reports/sample/dossier",
].join(",")).split(",").map((p) => p.trim()).filter(Boolean);
const WIDTHS = (process.env.WRAP_WIDTHS || "1440,400").split(",").map(Number);

// Explicit exclusions, each with its reason. Matched with Element.closest().
const EXCLUDE = [
  // Code is literal: a long route or command wraps where the viewport ends.
  ["pre, code, kbd, samp", "code is literal text; its breaks are not prose"],
  // Data tables scroll inside their own wrapper; a long cell at phone width is data, not copy.
  ["table td, table th", "400 only: a data table's cells wrap to the column, not to a measure", 400],
  // Form controls lay out their own text.
  ["input, textarea, select, option", "form controls lay out their own text"],
  // Screen-reader-only text has no visual line.
  [".sr-only, .visually-hidden, [aria-hidden='true']", "not visible"],
];

const RAG_MIN_FRACTION = 0.3;
const RAG_MIN_WORDS = 3;

let srv = null;
let BASE = process.env.TARGET_URL;
async function boot() {
  const PORT = await getFreePort();
  srv = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0" },
    stdio: "ignore",
  });
  BASE = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  throw new Error("server did not boot");
}
const stop = () => { if (srv) { try { srv.kill("SIGTERM"); } catch {} srv = null; } };
process.on("exit", stop);

// Runs in the page. Returns findings for one layout.
function audit({ exclude, width, ragFrac, ragWords }) {
  const BLOCKISH = new Set(["block", "list-item", "flex", "grid", "table", "table-cell", "table-row", "table-caption", "flow-root", "inline-grid", "inline-flex", "inline-block", "inline-table"]);
  const ATOMIC = new Set(["inline-block", "inline-flex", "inline-grid", "inline-table"]);
  const excluded = (el) => {
    for (const [sel, , w] of exclude) if ((w === undefined || w === width) && el.closest(sel)) return true;
    return false;
  };
  const visible = (el) => {
    if (el.closest("details:not([open]) > :not(summary)")) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const pathOf = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) { p += `#${e.id}`; parts.unshift(p); break; }
      const cls = String(e.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) p += `.${cls.join(".")}`;
      parts.unshift(p);
    }
    return parts.join(" > ");
  };
  // Word boxes whose nearest block ancestor is `el` (atomic inline children count as one word).
  const wordBoxes = (el) => {
    const boxes = [];
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) {
          const t = c.nodeValue; const re = /\S+/g; let m;
          while ((m = re.exec(t))) {
            const r = document.createRange(); r.setStart(c, m.index); r.setEnd(c, m.index + m[0].length);
            const rects = [...r.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
            // A word broken across lines (at a hyphen) reads as a word on each line it touches.
            // A token broken mid-word with no hyphen (a URL, a hash) leaves continuation fragments.
            rects.forEach((x, i) => boxes.push({ top: x.top, bottom: x.bottom, left: x.left, right: x.right, words: 1, frag: i > 0 && m[0].length > 24 }));
          }
        } else if (c.nodeType === 1) {
          const s = getComputedStyle(c);
          if (s.display === "none" || s.position === "absolute" || s.position === "fixed") continue;
          if (c.matches("br, script, style, template, svg")) continue;
          if (ATOMIC.has(s.display)) { const x = c.getBoundingClientRect(); if (x.width > 0 && x.height > 0 && c.textContent.trim()) boxes.push({ top: x.top, bottom: x.bottom, left: x.left, right: x.right, words: 1 }); continue; }
          if (BLOCKISH.has(s.display)) continue; // its own block, measured on its own
          walk(c);
        }
      }
    };
    walk(el);
    return boxes;
  };
  const linesOf = (boxes) => {
    const sorted = boxes.slice().sort((a, b) => (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2);
    const lines = [];
    for (const b of sorted) {
      const mid = (b.top + b.bottom) / 2;
      const ln = lines.find((l) => mid >= l.top && mid <= l.bottom);
      if (ln) { ln.left = Math.min(ln.left, b.left); ln.right = Math.max(ln.right, b.right); ln.words += b.words; ln.top = Math.min(ln.top, b.top); ln.bottom = Math.max(ln.bottom, b.bottom); ln.frag = ln.frag && !!b.frag; }
      else lines.push({ top: b.top, bottom: b.bottom, left: b.left, right: b.right, words: b.words, frag: !!b.frag });
    }
    lines.sort((a, b) => a.top - b.top);
    return lines.map((l) => ({ w: Math.round(l.right - l.left), words: l.words, frag: l.frag }));
  };
  const snippet = (el) => el.textContent.replace(/\s+/g, " ").trim().slice(0, 90);
  const out = [];
  const seen = new Set();

  // 1. Rags.
  const ragSel = "p, li, h1, h2, h3, h4, figcaption, td, th, dd, dt, label, blockquote, [class*='lede'], [class*='intro'], [class*='meta']";
  for (const el of document.body.querySelectorAll(ragSel)) {
    if (excluded(el) || !visible(el)) continue;
    const lines = linesOf(wordBoxes(el));
    if (lines.length < 2) continue;
    const widest = Math.max(...lines.map((l) => l.w));
    const last = lines[lines.length - 1];
    const short = last.w < ragFrac * widest;
    // Under 3 words on the last line is a rag, with one carve-out: a block of
    // 5 words or fewer that splits 2 + 2 or 3 + 2 is a balanced short heading,
    // not a tail. One word alone on a last line always fails.
    const total = lines.reduce((n, l) => n + l.words, 0);
    const few = last.words < ragWords && !(last.words === 2 && total <= 5);
    // A last line holding 60%+ of the widest line has the mass of a line, not a
    // tail (a long URL or figure alone on it); and a line that is only the
    // continuation of one token broken mid-word (a URL or hash longer than the
    // column) is a literal, not wording.
    const massive = last.w >= 0.6 * widest;
    if (last.frag) continue;
    if (short || (few && !massive)) {
      seen.add(el);
      out.push({ rule: short ? (few ? "rag: last line short and under 3 words" : "rag: last line under 30% of widest") : "rag: last line under 3 words", path: pathOf(el), text: snippet(el), lines: lines.map((l) => `${l.w}px/${l.words}w`).join(" ") });
    }
  }

  // 2. Split labels.
  const isLabel = (el, s) => {
    if (el.matches("button, .btn, [class*='chip'], [class*='pill'], [class*='badge'], [class*='kicker'], [class*='eyebrow'], .ml-meta > span, .ml-items > *, nav a, header a, [role='tab']")) return true;
    // A link in a row of links (the parent holds links and separators, no wording of its own).
    if (el.matches("a") && el.parentElement && el.parentElement.children.length >= 2 && [...el.parentElement.children].every((c) => c.matches("a, span")) && [...el.parentElement.childNodes].every((n) => n.nodeType !== 3 || /^[\s·|/•,→-]*$/.test(n.nodeValue))) return true;
    const fs = parseFloat(s.fontSize);
    const txt = el.textContent.trim();
    if (/mono/i.test(s.fontFamily) && fs <= 13 && txt.length <= 80) return true;
    if (s.textTransform === "uppercase" && parseFloat(s.letterSpacing) > 0 && txt.length <= 80) return true;
    return false;
  };
  for (const el of document.body.querySelectorAll("*")) {
    if (seen.has(el) || el.matches("script, style, template, svg, svg *, br, html, body, main, section, header, footer, nav, table, tbody, thead, tr, ul, ol")) continue;
    if (!el.textContent.trim() || excluded(el) || !visible(el)) continue;
    const s = getComputedStyle(el);
    if (!isLabel(el, s)) continue;
    // A label's lines: every word box under it (children included).
    const boxes = [];
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (n.parentElement.closest("pre, code") && !el.closest("pre, code")) continue;
      const pe = n.parentElement; const ps = getComputedStyle(pe);
      if (ps.display === "none" || ps.position === "absolute") continue;
      const t = n.nodeValue; const re = /\S+/g; let m;
      while ((m = re.exec(t))) { const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length); for (const x of r.getClientRects()) if (x.width > 0 && x.height > 0) boxes.push({ top: x.top, bottom: x.bottom, left: x.left, right: x.right, words: 1 }); }
    }
    // Skip containers of block children (a card with a mono font): only leaf-ish labels.
    if ([...el.children].some((c) => BLOCKISH.has(getComputedStyle(c).display) && !ATOMIC.has(getComputedStyle(c).display))) continue;
    const lines = linesOf(boxes);
    if (lines.length > 1) { seen.add(el); out.push({ rule: "split: label on more than one line", path: pathOf(el), text: snippet(el), lines: lines.map((l) => `${l.w}px/${l.words}w`).join(" ") }); }
  }

  // 3. Lone items in link/chip rows.
  const ITEM = "a, button, .btn, [class*='chip'], [class*='pill'], [class*='badge'], [class*='tag']";
  for (const el of document.body.querySelectorAll("*")) {
    const kids = [...el.children].filter((c) => !c.matches("script, style, template, br"));
    if (kids.length < 4) continue;
    const isRow = el.matches(".ml-items") || (kids.every((c) => c.matches(ITEM)) && el.tagName !== "NAV" && !el.matches("ul, ol, table, tbody, tr"));
    if (!isRow || excluded(el) || !visible(el)) continue;
    const vis = kids.filter(visible);
    const rows = [];
    for (const c of vis) {
      const r = c.getBoundingClientRect(); const mid = (r.top + r.bottom) / 2;
      const row = rows.find((x) => mid >= x.top && mid <= x.bottom);
      if (row) { row.n++; row.top = Math.min(row.top, r.top); row.bottom = Math.max(row.bottom, r.bottom); }
      else rows.push({ top: r.top, bottom: r.bottom, n: 1 });
    }
    rows.sort((a, b) => a.top - b.top);
    if (rows.length >= 2 && rows[rows.length - 1].n === 1 && rows[rows.length - 2].n >= 3) {
      out.push({ rule: "lone: last row of a link/chip row holds one item", path: pathOf(el), text: snippet(el), lines: rows.map((r) => `${r.n} items`).join(" / ") });
    }
  }
  // 4. A label kept whole must not run past the viewport (the body clips
  // sideways overflow, so this reads boxes, not scrollWidth). Content inside
  // its own horizontal scroller is reachable and passes.
  const scrolls = (el) => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { const x = getComputedStyle(e).overflowX; if (x === "auto" || x === "scroll") return true; } return false; };
  for (const el of document.body.querySelectorAll("main *, footer *, header *")) {
    if (el.children.length || !el.textContent.trim() || excluded(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > innerWidth + 1 && visible(el) && !scrolls(el)) { out.push({ rule: "overflow: text runs past the viewport", path: pathOf(el), text: snippet(el), lines: `${Math.round(r.right - innerWidth)}px past` }); }
  }
  return out;
}

async function settle(page) {
  // Scroll the whole page so scroll-reveal sections render, then return to the top.
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
    scrollTo(0, document.documentElement.scrollHeight); await new Promise((r) => setTimeout(r, 150));
    scrollTo(0, 0); await new Promise((r) => setTimeout(r, 100));
    await document.fonts.ready;
  });
}

let failures = 0;
const counts = {};
try {
  if (!BASE) await boot();
  const browser = await chromium.launch();
  try {
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width, height: width >= 900 ? 900 : 860 }, reducedMotion: "reduce", colorScheme: "light" });
      await ctx.addInitScript(() => { try { localStorage.setItem("a402-theme", "light"); } catch {} });
      const page = await ctx.newPage();
      for (const path of PAGES) {
        const key = `${path} @${width}`;
        let res;
        try { res = await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 45000 }); } catch (e) { console.log(`FAIL - ${key} did not load (${String(e.message).slice(0, 80)})`); failures++; counts[key] = "load"; continue; }
        if (!res || res.status() !== 200) { console.log(`FAIL - ${key} answered ${res?.status()}`); failures++; counts[key] = "status"; continue; }
        await settle(page);
        const found = await page.evaluate(audit, { exclude: EXCLUDE, width, ragFrac: RAG_MIN_FRACTION, ragWords: RAG_MIN_WORDS });
        counts[key] = found.length;
        failures += found.length;
        for (const f of found) console.log(`FAIL - ${key} | ${f.rule} | ${f.path} | "${f.text}" | lines ${f.lines}`);
        if (!found.length) console.log(`ok - ${key} wraps cleanly`);
      }
      await ctx.close();
    }
  } finally { await browser.close(); }
} catch (e) {
  console.log(`FAIL - ${e?.stack || e}`); failures++;
} finally { stop(); }

console.log("\nfindings per page:");
for (const [k, v] of Object.entries(counts)) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log("\nexclusions:");
for (const [sel, why, w] of EXCLUDE) console.log(`  ${sel}${w ? ` (at ${w}px)` : ""}: ${why}`);
if (failures) { console.log(`\nFAIL - ${failures} wrap findings`); process.exit(1); }
console.log(`\nPASS - ${PAGES.length} pages x ${WIDTHS.length} widths wrap cleanly`);
process.exit(0);
