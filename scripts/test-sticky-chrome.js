#!/usr/bin/env node
// Sticky chrome, measured in Chromium: the top nav and the other position:
// sticky panels stay where their CSS puts them while the page scrolls.
//
// Why a measurement and not a grep: `position: sticky` anchors to the nearest
// scroll container. `overflow-x: hidden`, `auto` or `scroll` on html or body
// turns that element into one, and every sticky element inside then scrolls
// away with the page while its CSS still reads sticky. Both html and body use
// `overflow-x: clip` (src/ledger-chrome.js), which clips without creating a
// scroll container. This test reads the computed overflow of html and body on
// every page it visits, scrolls 1400 px, and asserts the nav sits at 0, the
// docs TOC at its own top offset, the playground result panel at its offset
// and the 101 page's bottom bar at the viewport's bottom edge; and that the
// document cannot be scrolled sideways.
//
//   node scripts/test-sticky-chrome.js                 (boots its own FREE_MODE server)
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-sticky-chrome.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { getFreePort } from "./lib/free-port.js";

const PAGES = ["/", "/docs", "/tools", "/pricing", "/sell", "/playground", "/101", "/leaderboard"];
const WIDTHS = [[1440, 900], [390, 844]];
const BAD_OVERFLOW = new Set(["hidden", "auto", "scroll"]);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

let srv = null;
let BASE = process.env.TARGET_URL;
async function boot() {
  const PORT = await getFreePort();
  srv = spawn(process.execPath, ["src/server.js"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0" },
  });
  let err = "";
  srv.stderr.on("data", (d) => { err += d; });
  BASE = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  throw new Error(`server did not boot: ${err.slice(-2000)}`);
}
const stop = () => { if (srv) { try { srv.kill("SIGTERM"); } catch {} srv = null; } };

// Everything measured on one page at one width, in the page.
async function measure(page) {
  return page.evaluate(async () => {
    const tick = () => new Promise((r) => setTimeout(r, 120));
    const ox = (el) => getComputedStyle(el).overflowX;
    const nav = document.querySelector("body > nav");
    const navPos = nav ? getComputedStyle(nav).position : null;
    const side = document.querySelector(".ml-docs-side");
    const sideTop = side ? parseFloat(getComputedStyle(side).top) : null;
    const sideShown = side ? getComputedStyle(side).display !== "none" : false;
    const result = document.querySelector(".pg-result");
    const resultTop = result ? parseFloat(getComputedStyle(result).top) : null;
    const bar = document.querySelector(".s101-bar");
    const tall = document.documentElement.scrollHeight > innerHeight + 1400;
    window.scrollTo(0, 1400); await tick();
    const scrolled = window.scrollY;
    const navTop = nav ? Math.round(nav.getBoundingClientRect().top) : null;
    const sideRect = side && sideShown ? Math.round(side.getBoundingClientRect().top) : null;
    const resultRect = result ? Math.round(result.getBoundingClientRect().top) : null;
    const barBottom = bar ? Math.round(bar.getBoundingClientRect().bottom) : null;
    window.scrollTo(600, 1400); await tick();
    const sideways = window.scrollX;
    return {
      htmlOx: ox(document.documentElement), bodyOx: ox(document.body),
      navPos, navTop, tall, scrolled,
      sideTop, sideRect, resultTop, resultRect, barBottom, innerHeight, sideways,
    };
  });
}

async function main() {
  if (!BASE) await boot();
  const browser = await chromium.launch();
  try {
    for (const [width, height] of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      for (const path of PAGES) {
        const r = await page.goto(`${BASE}${path}`, { waitUntil: "load" });
        ok(r && r.ok(), `${width}px ${path}: HTTP ${r && r.status()}`);
        if (!r || !r.ok()) continue;
        const m = await measure(page);
        ok(!BAD_OVERFLOW.has(m.htmlOx) && !BAD_OVERFLOW.has(m.bodyOx), `${width}px ${path}: html and body are not scroll containers (html ${m.htmlOx}, body ${m.bodyOx})`);
        ok(m.navPos === "sticky", `${width}px ${path}: the top nav is position: sticky (${m.navPos})`);
        if (m.tall) ok(m.navTop === 0, `${width}px ${path}: the nav stays at the top after a 1400 px scroll (top ${m.navTop}, scrolled ${m.scrolled})`);
        else ok(true, `${width}px ${path}: page shorter than the scroll probe, nav position not measured`);
        ok(m.sideways === 0, `${width}px ${path}: the document does not scroll sideways (scrollX ${m.sideways})`);
        if (m.sideRect != null) ok(m.sideRect === Math.round(m.sideTop), `${width}px ${path}: the docs TOC stays at its offset (${m.sideRect} vs ${m.sideTop})`);
        if (m.resultRect != null && m.tall) ok(m.resultRect === Math.round(m.resultTop), `${width}px ${path}: the playground result panel stays at its offset (${m.resultRect} vs ${m.resultTop})`);
        if (m.barBottom != null && m.tall) ok(m.barBottom === m.innerHeight, `${width}px ${path}: the 101 bottom bar sits on the viewport's bottom edge (${m.barBottom} vs ${m.innerHeight})`);
      }
      await ctx.close();
    }
    // The desktop bar fits on one row at every desktop width: each word (Decide
    // added when this server does not serve it, so the widest bar is measured),
    // the theme toggle and the primary action, inside the container, no word
    // wrapped, the link row clear of the toggle. Under 1101px the tap menu
    // takes over; its burger, toggle and action stay inside the viewport.
    for (const width of [1024, 1101, 1180, 1240, 1280, 1440]) {
      const ctx = await browser.newContext({ viewport: { width, height: 600 }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/pricing`, { waitUntil: "load" });
      const f = await page.evaluate(() => {
        const row = document.querySelector(".ml-nav-links");
        if (row && !row.querySelector('a[href="/decide"]')) row.insertAdjacentHTML("afterbegin", '<a class="ml-nav-link" href="/decide">Decide</a>');
        const inner = document.querySelector(".ml-nav-in");
        const pad = parseFloat(getComputedStyle(inner).paddingRight);
        const limit = inner.getBoundingClientRect().right - pad + 0.5;
        const shown = getComputedStyle(row).display !== "none";
        const links = shown ? [...row.querySelectorAll("a.ml-nav-link")] : [];
        const tops = new Set(links.map((a) => Math.round(a.getBoundingClientRect().top)));
        const wrapped = links.filter((a) => a.getClientRects().length > 1).map((a) => a.textContent.trim());
        const right = [...inner.children].filter((e) => getComputedStyle(e).display !== "none").map((e) => e.getBoundingClientRect().right);
        const toggle = document.querySelector(".ml-theme-toggle").getBoundingClientRect().left;
        const linksRight = links.length ? Math.max(...links.map((a) => a.getBoundingClientRect().right)) : 0;
        return { shown, n: links.length, rows: tops.size, wrapped, over: Math.max(...right) - limit, clear: links.length ? toggle - linksRight : null, live: links.some((a) => a.getAttribute("href") === "https://live.agent402.tools") };
      });
      if (width >= 1101) ok(f.shown && f.live && f.rows === 1 && f.wrapped.length === 0 && f.over <= 0 && f.clear >= 16, `${width}px: the desktop bar (Live and Decide in it) fits on one row inside the container (${JSON.stringify(f)})`);
      else ok(!f.shown && f.over <= 0, `${width}px: the tap menu takes the bar; its controls stay inside the container (${JSON.stringify(f)})`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    stop();
  }
  console.log(`\ntest-sticky-chrome: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(`FAIL - ${e?.stack || e}`); stop(); process.exit(1); });
