#!/usr/bin/env node
// Page weight, budgeted: what a first visit to each site page transfers.
//
// For every page below, a FREE_MODE boot serves the HTML; the guard adds every
// same-origin script, stylesheet, image and video the page names, gzips each
// text body the way a CDN would, and fails a page whose total passes its
// budget, or whose HTML alone passes the HTML cap. Every font face the shell
// declares, together, stays inside one site-wide font budget. Third-party frames (the
// live view) and analytics loaders that a page only names are left out.
//
// The committed media budget rides here too: no tracked file under assets/,
// docs/ or wiki/ is over 2 MB (large media is a release asset, never a commit),
// and a still or clip under assets/media/ or docs/media/ stays inside the
// budget its kind is given below.
//
//   node scripts/test-page-weight.js              (boots its own server)
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-page-weight.js
//   PAGE_WEIGHT_PRINT=1 ...                       (print each page's figures)
//   node scripts/test-page-weight.js --self-test  (proves the budget can fail)
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { gzipSync } from "node:zlib";
import { statSync } from "node:fs";
import { ownStoreEnv } from "./lib/own-stores.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; if (process.env.PAGE_WEIGHT_PRINT) console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KB = 1024;

// Budgets in KB of transfer (gzip for text, raw for media). Each sits above
// the page's measured weight with room for ordinary growth, so a page that
// gains a library, an unoptimized image or a doubled stylesheet fails here.
export const PAGE_BUDGETS = {
  "/": 80,
  "/101": 70,
  "/tools/uuid": 60,
  "/tools": 64,
  "/proof": 60,
  "/scorecard": 60,
  "/leaderboard": 64,
  "/docs": 72,
  "/pricing": 60,
  "/sell": 64,
  "/reports": 64,
  "/revenue": 72,
  "/faq": 60,
  "/status": 60,
};
export const FONT_BUDGET_KB = 240; // every face the shell declares, together
export const HTML_CAP_KB = 300; // raw HTML of any one page
export const FILE_CAP_BYTES = 2 * 1024 * 1024; // any tracked file under assets/, docs/, wiki/
export const MEDIA_BUDGETS = { // per file, by extension, under assets/media/ and docs/media/
  ".svg": 120 * KB, ".png": 400 * KB, ".jpg": 400 * KB, ".webp": 300 * KB, ".gif": 1800 * KB, ".mp4": 1800 * KB, ".webm": 1800 * KB, ".vtt": 16 * KB, ".srt": 16 * KB,
};
const TEXT = /^(text\/|application\/(javascript|json|xml)|image\/svg\+xml)/;

// Same-origin subresources a page names: script src, stylesheet href, img src,
// video/source src and poster. Data URIs are already counted inside the HTML.
export function subresources(html, base) {
  const out = new Set();
  const add = (u) => {
    if (!u || u.startsWith("data:") || u.startsWith("#")) return;
    try { const url = new URL(u.replace(/&amp;/g, "&"), base); if (url.origin === new URL(base).origin) out.add(url.pathname + url.search); } catch {}
  };
  for (const m of html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/g)) add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)) add(m[1]);
  for (const m of html.matchAll(/<(?:img|source|video)\b[^>]*\s(?:src|poster)="([^"]+)"/g)) add(m[1]);
  return [...out];
}
// The font files the shell's stylesheet declares. A browser fetches only the
// faces a page uses, so these are budgeted once for the site, not per page.
export function fontFiles(html) {
  const out = new Set();
  for (const s of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) for (const m of s[1].matchAll(/url\((['"]?)(\/fonts\/[^)'"]+)\1\)/g)) out.add(m[2]);
  return [...out];
}
export const transferBytes = (buf, type) => (TEXT.test(type || "") ? gzipSync(buf).length : buf.length);
export function overBudget(path, totalBytes, htmlRawBytes, budgets = PAGE_BUDGETS) {
  const out = [];
  if (totalBytes > budgets[path] * KB) out.push(`${path} transfers ${(totalBytes / KB).toFixed(1)} KB (budget ${budgets[path]} KB)`);
  if (htmlRawBytes > HTML_CAP_KB * KB) out.push(`${path} HTML is ${(htmlRawBytes / KB).toFixed(1)} KB raw (cap ${HTML_CAP_KB} KB)`);
  return out;
}
export function mediaProblems(files) {
  const out = [];
  for (const { path, bytes } of files) {
    if (bytes > FILE_CAP_BYTES) out.push(`${path} is ${(bytes / 1048576).toFixed(2)} MB (over 2 MB: publish it as a release asset)`);
    if (/^(assets|docs)\/media\//.test(path)) {
      const cap = MEDIA_BUDGETS[extname(path).toLowerCase()];
      if (cap == null) out.push(`${path}: ${extname(path)} has no media budget (add one or use a budgeted format)`);
      else if (bytes > cap) out.push(`${path} is ${(bytes / KB).toFixed(1)} KB (its kind's budget is ${cap / KB} KB)`);
    }
  }
  return out;
}

if (process.argv.includes("--self-test")) {
  ok(overBudget("/", (PAGE_BUDGETS["/"] + 1) * KB, 10 * KB).length === 1, "a page over its budget is caught");
  ok(overBudget("/", 40 * KB, (HTML_CAP_KB + 1) * KB).length === 1, "an HTML body over the cap is caught");
  ok(overBudget("/", 40 * KB, 100 * KB).length === 0, "a page inside its budget passes");
  ok(fontFiles(`<style>@font-face{src:url('/fonts/a.woff2')}@font-face{src:url(/fonts/b.woff2)}.x{background:url(/i.png)}</style>`).length === 2, "the shell's font files are found");
  ok(mediaProblems([{ path: "docs/media/film.mp4", bytes: 3 * 1048576 }]).length === 2, "a 3 MB clip is over the file cap and its kind's budget");
  ok(mediaProblems([{ path: "assets/media/x.tiff", bytes: 10 }]).length === 1, "an unbudgeted media kind is caught");
  ok(mediaProblems([{ path: "docs/media/hero.gif", bytes: 900 * KB }]).length === 0, "a GIF inside its budget passes");
  const subs = subresources(`<script src="/js/a.js?v=1"></script><img src="https://x.example/i.png"><img src="/media/b.svg"><video poster="/media/p.jpg"><source src="/media/c.mp4"></video><img src="data:image/png;base64,AA">`, "http://127.0.0.1:1");
  ok(subs.length === 4 && subs.includes("/js/a.js?v=1") && !subs.some((s) => s.includes("x.example")), "same-origin subresources are found and third-party ones left out");
  ok(transferBytes(Buffer.alloc(10000, 97), "text/html") < 200 && transferBytes(Buffer.alloc(100), "image/png") === 100, "text is counted gzipped, media raw");
  console.log(`${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ---- committed media (offline) ----
{
  const tracked = execFileSync("git", ["ls-files", "assets", "docs", "wiki"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  const files = tracked.map((p) => { try { return { path: p, bytes: statSync(join(ROOT, p)).size }; } catch { return null; } }).filter(Boolean);
  const problems = mediaProblems(files);
  ok(problems.length === 0, `committed media inside its budgets (${files.length} files)\n  ${problems.join("\n  ")}`);
}

// ---- pages (a booted server) ----
let proc = null;
let BASE = process.env.TARGET_URL || null;
if (!BASE) {
  proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: { ...process.env, ...ownStoreEnv("page-weight"), FREE_MODE: "true", PORT: "0", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  let log = "";
  proc.stdout.on("data", (d) => { if (!BASE) log = (log + d).slice(-20_000); });
  for (let i = 0; i < 180 && !BASE; i++) { const m = log.match(/listening on :(\d+)/); if (m) BASE = `http://127.0.0.1:${m[1]}`; else await sleep(500); }
  if (!BASE) { console.error(`FAIL - server never printed its port\n${log.slice(-600)}`); proc.kill("SIGKILL"); process.exit(1); }
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }
}

try {
  const seen = new Map();
  const fetchSub = async (p) => {
    if (seen.has(p)) return seen.get(p);
    const r = await fetch(BASE + p);
    const buf = Buffer.from(await r.arrayBuffer());
    const v = r.ok ? transferBytes(buf, r.headers.get("content-type")) : 0;
    seen.set(p, v);
    return v;
  };
  let fontsChecked = false;
  for (const path of Object.keys(PAGE_BUDGETS)) {
    let res = null;
    // /scorecard answers 503 until its first computation lands.
    for (let i = 0; i < 30; i++) { res = await fetch(BASE + path); if (res.status !== 503) break; await sleep(1000); }
    ok(res.status === 200, `${path} answers 200 (got ${res.status})`);
    if (res.status !== 200) continue;
    const html = Buffer.from(await res.arrayBuffer());
    let total = transferBytes(html, "text/html");
    const subs = subresources(html.toString("utf8"), BASE);
    if (!fontsChecked) {
      fontsChecked = true;
      const fonts = fontFiles(html.toString("utf8"));
      let fontBytes = 0;
      for (const f of fonts) fontBytes += await fetchSub(f);
      ok(fonts.length > 0 && fontBytes <= FONT_BUDGET_KB * KB, `the ${fonts.length} font files weigh ${(fontBytes / KB).toFixed(1)} KB (budget ${FONT_BUDGET_KB} KB)`);
    }
    for (const s of subs) total += await fetchSub(s);
    if (process.env.PAGE_WEIGHT_PRINT) console.log(`${path}: ${(total / KB).toFixed(1)} KB transfer, HTML ${(html.length / KB).toFixed(1)} KB raw, ${subs.length} subresources`);
    const problems = overBudget(path, total, html.length);
    ok(problems.length === 0, problems.join("; ") || `${path} inside its budget`);
  }
} finally {
  if (proc) proc.kill("SIGKILL");
}
console.log(`${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
