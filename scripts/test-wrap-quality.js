#!/usr/bin/env node
// Wrap quality, measured: every visible text block on the public pages is laid
// out in real Chromium at desktop (1440) and phone (400, 390 and 360) widths, its line boxes
// are read back with Range.getClientRects(), and these shapes fail:
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
//  break   a code token inside prose or a table cell breaks between two
//          letters or digits (a parameter name split mid-word); a code token
//          may break at its punctuation or a camelCase seam, and a hash or address (an unbroken
//          run of more than 24 letters and digits) may break anywhere
//
// Eyeballing a page missed these more than once; counting line boxes does not.
// DESIGN.md "Wrap" states the rules this enforces.
//
// Pages: every HTML page in the local /sitemap.xml plus /docs/<every wiki page>.
// Hand-written pages run in full. Each generated family (tool pages, tool
// categories, skill packs, fund / insider / dossier reports, report samples)
// runs a deterministic sample of WRAP_SAMPLE pages (default 25): the longest
// h1s and the longest code tokens first, then a fixed hash order. WRAP_ALL=1
// runs every page of every family.
//
//   node scripts/test-wrap-quality.js                 (boots its own FREE_MODE server)
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-wrap-quality.js
//   WRAP_ALL=1 ...                                    (every generated page too)
//   WRAP_PAGES=/,/sell WRAP_WIDTHS=1440 ...           (narrow a run while fixing)
//   WRAP_FAMILY=tools,skills ...                      (some families; "pages" = hand-written)
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { getFreePort } from "./lib/free-port.js";
import { stripTags } from "./lib/html-text.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 360 is the narrowest common phone, 390 the most common one; 400 keeps the
// width the table-cell exclusion below is pinned to.
const WIDTHS = (process.env.WRAP_WIDTHS || "1440,400,390,360").split(",").map(Number);
const WRAP_ALL = process.env.WRAP_ALL === "1";
const SAMPLE = Number(process.env.WRAP_SAMPLE || 25);
const CONCURRENCY = Math.max(1, Number(process.env.WRAP_CONCURRENCY || 4));
const ONLY_FAMILIES = (process.env.WRAP_FAMILY || "").split(",").map((s) => s.trim()).filter(Boolean);

// Generated families: one template, many pages. Anything else is hand-written ("pages").
const FAMILIES = [
  ["tool-categories", /^\/tools\/category\/[^/]+$/],
  ["tools", /^\/tools\/[^/]+$/],
  ["skills", /^\/skills\/[^/]+$/],
  ["reports-fund", /^\/reports\/fund\/[^/]+$/],
  ["reports-insider", /^\/reports\/insider\/[^/]+$/],
  ["reports-dossier", /^\/reports\/dossier\/[^/]+$/],
  ["reports-samples", /^\/reports\/sample\/[^/]+$/],
];
const familyOf = (path) => (FAMILIES.find(([, re]) => re.test(path.split("?")[0])) || ["pages"])[0];
// Sitemap entries that are data, not pages.
const NOT_A_PAGE = /^\/(api\/|\.well-known\/)|\.(txt|md|json|xml)$/i;

// Explicit exclusions, each with its reason. Matched with Element.closest().
const EXCLUDE = [
  // Code is literal: a long route or command wraps where the viewport ends.
  // The code-token break rule still reads code inside prose and table cells.
  ["pre, code, kbd, samp", "code is literal text; its breaks are not prose (a code token in prose still breaks only at punctuation)", undefined, "shape"],
  // Data tables scroll inside their own wrapper; a long cell at phone width is data, not copy.
  ["table td, table th", "400 only: a data table's cells wrap to the column, not to a measure", 400, "shape"],
  // Form controls lay out their own text.
  ["input, textarea, select, option", "form controls lay out their own text"],
  // Screen-reader-only text has no visual line.
  [".sr-only, .visually-hidden, [aria-hidden='true']", "not visible"],
];

// Carve-outs inside the rules (not whole elements), each with its reason.
const CARVE_OUTS = [
  "rag: punctuation alone (the period after a link, an arrow) is not a word; it rides with the token before it",
  "rag: a block that is one code literal and nothing else (an example value in a cell) wraps where the literal allows",
  "split: one unbroken token longer than 24 characters (a CAIP-2 id, a hash, an address) may break; it has no word boundary",
  "split: a link inside a sentence (a <p> in a page's <header> hero) is prose, not a nav label",
  "lone: a paragraph of prose with links in it is not a row; a row holds items and separators only",
  "break: a camelCase seam is a word boundary; a run of more than 24 letters and digits may break anywhere",
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
  // forBreak: the code-token break rule, which "shape" exclusions do not cover.
  const excluded = (el, forBreak) => {
    for (const [sel, , w, scope] of exclude) if ((w === undefined || w === null || w === width) && !(forBreak && scope === "shape") && el.closest(sel)) return true;
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
            // Punctuation alone (the period after a link) is not a word: it rides with the token before it.
            const punct = !/[\p{L}\p{N}]/u.test(m[0]);
            const code = !!c.parentElement.closest("code, kbd, samp");
            rects.forEach((x, i) => boxes.push({ top: x.top, bottom: x.bottom, left: x.left, right: x.right, words: punct ? 0 : 1, frag: punct || (i > 0 && m[0].length > 24), code }));
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
    const wb = wordBoxes(el);
    // A block that is one code literal and nothing else (an example value in a
    // table cell) wraps where the literal allows: its shape is data, not wording.
    if (wb.length && wb.every((b) => b.code)) continue;
    const lines = linesOf(wb);
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
    // A link inside a sentence (a <p> in a page's <header> hero) is prose, not a nav label.
    if (el.matches("button, .btn, [class*='chip'], [class*='pill'], [class*='badge'], [class*='kicker'], [class*='eyebrow'], .ml-meta > span, .ml-items > *, nav a, header a:not(p a), [role='tab']")) return true;
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
    // One unbroken token longer than 24 characters (a CAIP-2 id, a hash, an
    // address) has no word boundary to keep; it may break where it must.
    if (lines.length > 1 && /^\S{25,}$/.test(el.textContent.trim())) continue;
    if (lines.length > 1) { seen.add(el); out.push({ rule: "split: label on more than one line", path: pathOf(el), text: snippet(el), lines: lines.map((l) => `${l.w}px/${l.words}w`).join(" ") }); }
  }

  // 3. Lone items in link/chip rows.
  const ITEM = "a, button, .btn, [class*='chip'], [class*='pill'], [class*='badge'], [class*='tag']";
  for (const el of document.body.querySelectorAll("*")) {
    const kids = [...el.children].filter((c) => !c.matches("script, style, template, br"));
    if (kids.length < 4) continue;
    // A row holds items and separators only: a paragraph of prose with links in it is not a row.
    const bare = [...el.childNodes].every((n) => n.nodeType !== 3 || /^[\s·|/•,→-]*$/.test(n.nodeValue));
    const isRow = el.matches(".ml-items") || (bare && kids.every((c) => c.matches(ITEM)) && el.tagName !== "NAV" && !el.matches("ul, ol, table, tbody, tr"));
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
  // 5. A code token inside prose or a table cell breaks only at its own
  // punctuation (an underscore, dot, slash, hyphen): a break between two
  // letters or digits splits a name mid-word. A run of more than 24 letters
  // and digits (a hash, an address) has no other break point and may split.
  const ALNUM = /[A-Za-z0-9]/;
  for (const el of document.body.querySelectorAll("code, kbd, samp")) {
    if (el.closest("pre") || excluded(el, true) || !visible(el)) continue;
    let bad = null;
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n && !bad; n = tw.nextNode()) {
      const t = n.nodeValue; const re = /\S+/g; let m;
      while (!bad && (m = re.exec(t))) {
        const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
        if ([...r.getClientRects()].filter((x) => x.width > 0 && x.height > 0).length < 2) continue;
        let prev = null;
        for (let i = 0; i < m[0].length; i++) {
          const c = document.createRange(); c.setStart(n, m.index + i); c.setEnd(n, m.index + i + 1);
          const x = [...c.getClientRects()].find((q) => q.height > 0);
          if (!x) continue;
          if (prev && (x.top + x.bottom) / 2 > prev.bottom) {
            const at = m.index + i;
            // A camelCase seam ("sort|Keys") is a word boundary, not mid-word.
            const camel = /[a-z0-9]/.test(t[at - 1] || "") && /[A-Z]/.test(t[at]) && /[a-z]/.test(t[at + 1] || "");
            if (ALNUM.test(t[at - 1] || "") && ALNUM.test(t[at]) && !camel) {
              let a0 = at - 1; while (a0 > 0 && ALNUM.test(t[a0 - 1])) a0--;
              let b0 = at; while (b0 + 1 < t.length && ALNUM.test(t[b0 + 1])) b0++;
              if (b0 - a0 + 1 <= 24) { bad = `${t.slice(a0, at)}|${t.slice(at, b0 + 1)}`; break; }
            }
          }
          prev = x;
        }
      }
    }
    if (bad) out.push({ rule: "break: code token split mid-word", path: pathOf(el), text: snippet(el), lines: bad });
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

// The page list: WRAP_PAGES, or the sitemap plus every wiki page, with each
// generated family cut to its sample unless WRAP_ALL=1.
const hashOrder = (p) => createHash("sha256").update(p).digest("hex");
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
async function pageList() {
  if (process.env.WRAP_PAGES) return process.env.WRAP_PAGES.split(",").map((p) => p.trim()).filter(Boolean);
  const xml = await (await fetch(`${BASE}/sitemap.xml`)).text();
  const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => { const u = new URL(m[1].replace(/&amp;/g, "&")); return u.pathname + u.search; });
  // Every wiki page renders at /docs/<slug> (Home is /docs, Adapters is /docs/adapters).
  let wiki = [];
  try { wiki = readdirSync(join(ROOT, "wiki")).filter((f) => f.endsWith(".md") && !f.startsWith("_")).map((f) => f.slice(0, -3)); } catch {}
  for (const slug of wiki) paths.push(slug === "Home" ? "/docs" : slug === "Adapters" ? "/docs/adapters" : `/docs/${slug}`);
  const all = [...new Set(paths)].filter((p) => !NOT_A_PAGE.test(p.split("?")[0]));
  const byFamily = new Map();
  for (const p of all) { const f = familyOf(p); if (!byFamily.has(f)) byFamily.set(f, []); byFamily.get(f).push(p); }
  const chosen = [];
  for (const [fam, list] of byFamily) {
    if (ONLY_FAMILIES.length && !ONLY_FAMILIES.includes(fam)) continue;
    if (fam === "pages" || WRAP_ALL || list.length <= SAMPLE) { chosen.push(...list); continue; }
    // The sample leads with the pages most likely to wrap badly: the longest
    // h1, then the longest code token (a parameter name), then a fixed hash order.
    const scored = await mapLimit(list, 16, async (p) => {
      let h1 = 0, code = 0;
      try {
        const html = await (await fetch(`${BASE}${p}`)).text();
        const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i); if (m) h1 = stripTags(m[1], "").trim().length;
        for (const c of html.matchAll(/<code[^>]*>([^<]{1,200})<\/code>/gi)) code = Math.max(code, ...c[1].split(/\s+/).map((w) => w.length));
      } catch {}
      return { p, h1, code };
    });
    const pick = new Set();
    const take = (arr, n) => { for (const x of arr) { if (pick.size >= SAMPLE || n <= 0) break; if (!pick.has(x.p)) { pick.add(x.p); n--; } } };
    const third = Math.ceil(SAMPLE / 3);
    take(scored.slice().sort((a, b) => b.h1 - a.h1 || (a.p < b.p ? -1 : 1)), third);
    take(scored.slice().sort((a, b) => b.code - a.code || (a.p < b.p ? -1 : 1)), third);
    take(scored.slice().sort((a, b) => (hashOrder(a.p) < hashOrder(b.p) ? -1 : 1)), SAMPLE);
    chosen.push(...list.filter((p) => pick.has(p)));
  }
  return chosen;
}

let failures = 0;
const counts = {};
const famTotals = {};
const t0 = Date.now();
let PAGES = [];
try {
  if (!BASE) await boot();
  PAGES = await pageList();
  const browser = await chromium.launch();
  try {
    // Self-test: with the thresholds the sweep uses, the audit flags a block
    // whose last line is one (wide) word and passes a one-line block.
    {
      const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
      await page.setContent(`<!doctype html><body style="margin:0;font:16px/1.4 monospace"><p style="width:300px">aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll qqqqqqqqqqqqq</p><p style="width:300px">one short line</p></body>`);
      const found = await page.evaluate(audit, { exclude: EXCLUDE, width: 600, ragFrac: RAG_MIN_FRACTION, ragWords: RAG_MIN_WORDS });
      await page.close();
      const caught = found.some((f) => /^rag/.test(f.rule) && f.text.includes("qqqq"));
      const clean = !found.some((f) => f.text.includes("one short line"));
      console.log(`${caught && clean ? "ok" : "FAIL"} - self-test: a one-word last line is flagged (${caught}) and a one-line block is not (${clean})`);
      if (!caught || !clean) failures++;
    }
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width, height: width >= 900 ? 900 : 860 }, reducedMotion: "reduce", colorScheme: "light" });
      await ctx.addInitScript(() => { try { localStorage.setItem("a402-theme", "light"); } catch {} });
      const pool = await Promise.all(Array.from({ length: Math.min(CONCURRENCY, PAGES.length) }, () => ctx.newPage()));
      const free = pool.slice();
      const lines = await mapLimit(PAGES, pool.length, async (path) => {
        const page = free.pop();
        const key = `${path} @${width}`;
        const fam = familyOf(path);
        const log = [];
        try {
          let res;
          try { res = await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 45000 }); } catch (e) { log.push(`FAIL - ${key} did not load (${String(e.message).slice(0, 80)})`); failures++; counts[key] = "load"; return log; }
          if (!res || res.status() !== 200) { log.push(`FAIL - ${key} answered ${res?.status()}`); failures++; counts[key] = "status"; return log; }
          if (!/html/i.test(res.headers()["content-type"] || "")) { log.push(`skip - ${key} is not HTML`); return log; }
          await settle(page);
          const found = await page.evaluate(audit, { exclude: EXCLUDE, width, ragFrac: RAG_MIN_FRACTION, ragWords: RAG_MIN_WORDS });
          counts[key] = found.length;
          famTotals[`${fam} @${width}`] = (famTotals[`${fam} @${width}`] || 0) + found.length;
          failures += found.length;
          for (const f of found) log.push(`FAIL - ${key} | ${f.rule} | ${f.path} | "${f.text}" | lines ${f.lines}`);
          if (!found.length) log.push(`ok - ${key} wraps cleanly`);
          return log;
        } finally { free.push(page); }
      });
      for (const l of lines) for (const x of l) console.log(x);
      await ctx.close();
    }
  } finally { await browser.close(); }
} catch (e) {
  console.log(`FAIL - ${e?.stack || e}`); failures++;
} finally { stop(); }

console.log("\nfindings per page:");
for (const [k, v] of Object.entries(counts)) if (v) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log("\nfindings per family:");
const famPages = {};
for (const p of PAGES) famPages[familyOf(p)] = (famPages[familyOf(p)] || 0) + 1;
for (const fam of Object.keys(famPages)) console.log(`  ${fam.padEnd(16)} ${String(famPages[fam]).padStart(4)} pages  ${WIDTHS.map((w) => `@${w}: ${famTotals[`${fam} @${w}`] || 0}`).join("  ")}`);
console.log("\nexclusions:");
for (const [sel, why, w] of EXCLUDE) console.log(`  ${sel}${w ? ` (at ${w}px)` : ""}: ${why}`);
console.log("\ncarve-outs:");
for (const c of CARVE_OUTS) console.log(`  ${c}`);
console.log(`\n${PAGES.length} pages x ${WIDTHS.length} widths in ${Math.round((Date.now() - t0) / 1000)} s${WRAP_ALL ? " (WRAP_ALL)" : ` (generated families sampled at ${SAMPLE})`}`);
if (failures) { console.log(`\nFAIL - ${failures} wrap findings`); process.exit(1); }
console.log(`\nPASS - ${PAGES.length} pages x ${WIDTHS.length} widths wrap cleanly`);
process.exit(0);
