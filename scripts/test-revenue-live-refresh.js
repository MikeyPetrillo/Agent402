#!/usr/bin/env node
// Offline test: the open /revenue page keeps itself current.
//
//   * every minute while the tab is visible, the page reads its own URL again
//     and swaps in the sections marked data-rv-live, then reloads the series
//     for the same window
//   * a hidden tab reads nothing; a failed read keeps what is shown (the chart
//     is not blanked); a page with no live sections (the warm-up answer)
//     changes nothing
//   * a section holding focus is left alone until the next minute
//   * a preset range rolls over when the server's day moves on
//
// The page is rendered from the same helpers the route calls and driven in
// jsdom with the interval captured, so no server or chain is read.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { revenuePageRange } from "../src/revenue-range.js";
import { revenuePage } from "../src/revenue-live.js";

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.log(`FAIL - ${name}\n       ${e.message}`); }
};

const FIRST = "2026-06-15";
const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-10-10T12:00:00Z");
const pageAt = (now, query, extCount) => revenuePage("https://example.test", {
  asOf: new Date(now).toISOString(),
  rails: [],
  allTime: { allTimeInboundCount: 10 + extCount, allTimeExternalCount: extCount, allTimeExternalUsd: extCount / 100 },
  mpp: {},
  standing: {},
  range: revenuePageRange(query, { firstDay: FIRST, now }),
});
const CHART_JS = readFileSync(new URL("../assets/js/revenue-chart.js", import.meta.url), "utf8");
const inline = (html) => html.replace('<script src="/js/revenue-chart.js"></script>', `<script>${CHART_JS}</script>`);
const settle = () => new Promise((r) => setTimeout(r, 40));

async function boot(query = { range: "7d" }) {
  const env = { page: null, pageStatus: 200, pageFails: false, seriesFails: false, fetched: [], ticks: [] };
  const search = Object.keys(query).length ? "?" + new URLSearchParams(query) : "";
  const dom = new JSDOM(inline(pageAt(NOW, query, 4)), {
    url: `https://example.test/revenue${search}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.setInterval = (fn, ms) => { env.ticks.push({ fn, ms }); return env.ticks.length; };
      w.fetch = (url, init) => {
        const u = new URL(String(url), "https://example.test");
        env.fetched.push(u.pathname + u.search);
        if (u.pathname === "/revenue") {
          if (env.pageFails) return Promise.reject(new Error("offline"));
          return Promise.resolve({ ok: env.pageStatus === 200, text: () => Promise.resolve(env.page), init });
        }
        if (env.seriesFails) return Promise.reject(new Error("offline"));
        return Promise.resolve({ json: () => Promise.resolve({ days: [{ day: "2026-10-09", extUsd: 0.01, ext: 1, tx: 1, chains: {} }], recordingSince: null }) });
      };
    },
  });
  await settle();
  const w = dom.window;
  const tick = async () => { for (const t of env.ticks) t.fn(); await settle(); };
  const text = (sel) => w.document.querySelector(sel).textContent;
  return { w, env, tick, text };
}

{
  const { w, env, tick, text } = await boot();
  await check("one live timer, once a minute", () => {
    assert.equal(env.ticks.length, 1);
    assert.equal(env.ticks[0].ms, 60_000);
  });
  await check("the server-rendered figures are marked for refresh", () => {
    const names = [...w.document.querySelectorAll("[data-rv-live]")].map((e) => e.getAttribute("data-rv-live"));
    assert.deepEqual(names, ["head", "rails", "mpp", "decide"]);
    assert.equal(w.document.querySelector("[data-rv-live] #rvz"), null, "the chart and its range control are never swapped");
  });
  await check("a tick swaps in new figures and reloads the series for the same window", async () => {
    assert.match(text('[data-rv-live="head"]'), /\b4\b external payments/);
    env.page = pageAt(NOW + 60_000, { range: "7d" }, 9);
    env.fetched.length = 0;
    await tick();
    assert.match(text('[data-rv-live="head"]'), /\b9\b external payments/);
    assert.equal(env.fetched[0], "/revenue?range=7d", "reads its own URL, range kept");
    const series = env.fetched.slice(1);
    assert.equal(series.length, 3);
    for (const u of series) assert.ok(u.endsWith("?from=2026-10-04&to=2026-10-10"), u);
  });
  await check("the page read asks for a fresh copy", async () => {
    let init = null;
    const f = w.fetch;
    w.fetch = (url, i) => { if (String(url).startsWith("/revenue")) init = i; return f(url, i); };
    await tick();
    w.fetch = f;
    assert.equal(init?.cache, "no-store");
  });
  await check("a hidden tab reads nothing", async () => {
    Object.defineProperty(w.document, "visibilityState", { configurable: true, get: () => "hidden" });
    env.fetched.length = 0;
    await tick();
    assert.equal(env.fetched.length, 0);
    delete w.document.visibilityState;
  });
  await check("a failed page read keeps the figures; a failed series read keeps the chart", async () => {
    const before = text('[data-rv-live="head"]');
    const svg = w.document.getElementById("rvzSvg").outerHTML;
    env.pageFails = true; env.seriesFails = true;
    await tick();
    assert.equal(text('[data-rv-live="head"]'), before);
    assert.ok(w.document.getElementById("rvzSvg"), "the chart is still there");
    assert.equal(w.document.getElementById("rvzSvg").outerHTML, svg);
    assert.equal(w.document.querySelector(".rvz-empty"), null, "no 'series unavailable' on a background read");
    env.pageFails = false; env.seriesFails = false;
  });
  await check("a non-200 answer and the warm-up page change nothing", async () => {
    const before = text('[data-rv-live="head"]');
    env.pageStatus = 429; env.page = pageAt(NOW, { range: "7d" }, 50);
    await tick();
    assert.equal(text('[data-rv-live="head"]'), before);
    env.pageStatus = 200; env.page = '<!doctype html><meta http-equiv="refresh" content="6"><title>Transactions</title><body><h2>Warming up</h2></body>';
    await tick();
    assert.equal(text('[data-rv-live="head"]'), before);
  });
  await check("a section holding focus waits; the others refresh", async () => {
    const link = w.document.querySelector('[data-rv-live="head"] a');
    link.focus();
    assert.equal(w.document.activeElement, link);
    const head = text('[data-rv-live="head"]');
    env.page = pageAt(NOW, { range: "7d" }, 12);
    await tick();
    assert.equal(text('[data-rv-live="head"]'), head, "focused section untouched");
    link.blur();
    await tick();
    assert.match(text('[data-rv-live="head"]'), /\b12\b external payments/);
  });
  await check("a section with text selected in it waits", async () => {
    const head = w.document.querySelector('[data-rv-live="head"]');
    const sel = w.getSelection();
    sel.selectAllChildren(head.querySelector("h1"));
    assert.equal(sel.isCollapsed, false);
    const before = head.textContent;
    env.page = pageAt(NOW, { range: "7d" }, 15);
    await tick();
    assert.equal(head.textContent, before, "selected section untouched");
    sel.removeAllRanges();
    await tick();
    assert.match(head.textContent, /\b15\b external payments/);
  });
  await check("a preset range rolls over when the server's day moves on", async () => {
    env.page = pageAt(NOW + DAY_MS, { range: "7d" }, 12);
    env.fetched.length = 0;
    await tick();
    assert.equal(w.document.getElementById("rvzWindowText").textContent, "2026-10-05 to 2026-10-11 (7 days, UTC)");
    for (const u of env.fetched.slice(1)) assert.ok(u.endsWith("?from=2026-10-05&to=2026-10-11"), u);
  });
}
{
  const { w, env, tick } = await boot({ from: "2026-09-10", to: "2026-09-20" });
  await check("a custom range stays put across a day change", async () => {
    env.page = pageAt(NOW + DAY_MS, { from: "2026-09-10", to: "2026-09-20" }, 5);
    env.fetched.length = 0;
    await tick();
    assert.equal(env.fetched[0], "/revenue?from=2026-09-10&to=2026-09-20");
    for (const u of env.fetched.slice(1)) assert.ok(u.endsWith("?from=2026-09-10&to=2026-09-20"), u);
    assert.match(w.document.getElementById("rvzWindowText").textContent, /^2026-09-10 to 2026-09-20/);
  });
}

console.log(`\ntest-revenue-live-refresh: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
