#!/usr/bin/env node
// Offline test: date ranges on /revenue and its daily series.
//
//   * the parser: presets, custom from/to, days=N, clamping to the data's
//     first day and today, and garbage refused (400 on the APIs)
//   * the three daily APIs: a ranged answer is bounded to its window and
//     names it; an answer with no range query is the full series, unchanged
//   * the page renders the chosen window on first paint (data attributes,
//     window label, window totals, selected chip, form values)
//   * the URL round trip: every link and form value the page renders parses
//     back to the window it names, and the chart script keeps the URL, the
//     fetches and the label in step when the range changes in place
//
// The APIs are driven on a booted FREE_MODE server (port from the kernel)
// against a fixture ledger in a temp directory; the page is rendered from
// the same pure helpers the route calls, so no chain is read.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { JSDOM } from "jsdom";
import { getFreePort } from "./lib/free-port.js";
import {
  parseRevenueRange, revenuePageRange, rangedRevenueDaily, revenueWindowTotals, rangeQueryString,
  addDays, spanDays, utcToday, REVENUE_DEFAULT_RANGE, REVENUE_RANGE_MAX_SPAN_DAYS,
} from "../src/revenue-range.js";
import { revenuePage, revenueChartSection } from "../src/revenue-live.js";

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.log(`FAIL - ${name}\n       ${e.message}`); }
};

const NOW = Date.parse("2026-10-10T12:00:00Z");
const FIRST = "2026-06-15";
const P = (q) => parseRevenueRange(q, { firstDay: FIRST, now: NOW });

console.log("revenue range: parser");
await check("presets end today and span their days", () => {
  assert.deepEqual(P({ range: "7d" }).window, { from: "2026-10-04", to: "2026-10-10", days: 7, preset: "7d" });
  assert.deepEqual(P({ range: "30d" }).window, { from: "2026-09-11", to: "2026-10-10", days: 30, preset: "30d" });
  assert.equal(P({ range: "90d" }).window.from, "2026-07-13");
});
await check("1y and All clamp up to the data's first day", () => {
  assert.deepEqual(P({ range: "1y" }).window, { from: FIRST, to: "2026-10-10", days: spanDays(FIRST, "2026-10-10"), preset: "1y" });
  assert.deepEqual(P({ range: "all" }).window, P({ range: "1y" }).window && { ...P({ range: "1y" }).window, preset: "all" });
});
await check("custom from/to is inclusive, UTC days", () => {
  assert.deepEqual(P({ from: "2026-09-01", to: "2026-09-30" }).window, { from: "2026-09-01", to: "2026-09-30", days: 30, preset: null });
  assert.deepEqual(P({ from: "2026-09-05", to: "2026-09-05" }).window.days, 1);
});
await check("clamping: a start before the data and an end after today", () => {
  assert.deepEqual(P({ from: "2026-01-01", to: "2026-12-31" }).window, { from: FIRST, to: "2026-10-10", days: spanDays(FIRST, "2026-10-10"), preset: null });
  assert.equal(P({ from: "2026-10-01" }).window.to, "2026-10-10", "a missing end is today");
  assert.equal(P({ to: "2026-07-01" }).window.from, FIRST, "a missing start is the first day");
});
await check("a window wholly before the data stays as asked (it reads empty, not shifted)", () => {
  assert.deepEqual(P({ from: "2026-01-01", to: "2026-01-31" }).window.from, "2026-01-01");
});
await check("days=N is the last N days", () => {
  assert.deepEqual(P({ days: "14" }).window, { from: "2026-09-27", to: "2026-10-10", days: 14, preset: null });
});
await check("garbage is refused, never guessed", () => {
  const bad = [
    { range: "2w" }, { range: "" }, { from: "2026-9-1" }, { from: "2026-02-31" }, { to: "tomorrow" },
    { from: "2026-10-01", to: "2026-09-01" }, { from: "2026-11-01" }, { from: "1900-01-01", to: "2026-10-01" },
    { days: "0" }, { days: "-3" }, { days: "1e3" }, { days: String(REVENUE_RANGE_MAX_SPAN_DAYS + 1) },
    { range: "7d", from: "2026-09-01" }, { range: "7d", days: "3" }, { from: ["2026-09-01", "2026-09-02"] },
  ];
  for (const q of bad) assert.ok(P(q).error, `accepted ${JSON.stringify(q)}`);
});
await check("no range query: no window, unless the page's default applies", () => {
  assert.deepEqual(P({}), { window: null });
  assert.equal(parseRevenueRange({}, { firstDay: FIRST, now: NOW, fallback: REVENUE_DEFAULT_RANGE }).window.preset, REVENUE_DEFAULT_RANGE);
});
await check("the page falls back to the default on a refused range and says why", () => {
  const r = revenuePageRange({ from: "nope" }, { firstDay: FIRST, now: NOW });
  assert.equal(r.window.preset, REVENUE_DEFAULT_RANGE);
  assert.match(r.notice, /YYYY-MM-DD/);
});

// ---------------------------------------------------------------------------
// Fixture series: one base row per day from FIRST to NOW (day i: i+1 external
// payments at $0.01, one internal), buyers every other day.
const allDays = [];
for (let d = FIRST; d <= utcToday(NOW); d = addDays(d, 1)) allDays.push(d);
const ROWS = allDays.map((day, i) => ({ day, chain: "base", extUsd: +((i + 1) * 0.01).toFixed(6), extTx: i + 1, intUsd: 0.001, intTx: 1, extMppUsd: 0, extMppTx: 0, intMppUsd: 0, intMppTx: 0, extSorUsd: 0, extSorTx: 0, intSorUsd: 0, intSorTx: 0 }));
const BUYERS = allDays.filter((_, i) => i % 2 === 0).map((day, i) => ({ day, buyers: 1, newBuyers: 1, returningBuyers: 0, cumulative: i + 1, unattributed: 0 }));
const BODY = { asOf: "2026-10-10T12:00:00.000Z", days: ROWS, daysScope: { seriesStart: FIRST }, buyers: BUYERS, buyersWeekly: [
  { week: "2026-09-07", weekEnd: "2026-09-13", buyers: 3 }, { week: "2026-09-14", weekEnd: "2026-09-20", buyers: 4 }, { week: "2026-10-05", weekEnd: "2026-10-11", buyers: 2, partial: true },
], buyersMonthly: [{ month: "2026-08-01", monthEnd: "2026-08-31", buyers: 9 }, { month: "2026-09-01", monthEnd: "2026-09-30", buyers: 7 }], concentration: { buyers: 99 }, retention: { buyers: 99 }, repeat7: { eligible: 5 } };
const TEMPO = { days: [{ day: "2026-09-20", extUsd: 0.5, extTx: 2, intUsd: 0, intTx: 1 }, { day: "2026-08-01", extUsd: 9, extTx: 9, intUsd: 0, intTx: 0 }] };

console.log("revenue range: ranged body");
await check("every series is cut to the window; unions reaching past an edge are marked", () => {
  const w = P({ from: "2026-09-10", to: "2026-09-20" }).window;
  const out = rangedRevenueDaily(BODY, w, { tempo: TEMPO, concentration: { buyers: 4 } });
  assert.equal(out.days.length, 11);
  assert.ok(out.days.every((r) => r.day >= w.from && r.day <= w.to));
  assert.ok(out.buyers.every((r) => r.day >= w.from && r.day <= w.to));
  assert.deepEqual(out.buyersWeekly.map((r) => [r.week, !!r.extendsPastWindow]), [["2026-09-07", true], ["2026-09-14", false]]);
  assert.deepEqual(out.buyersMonthly.map((r) => r.month), ["2026-09-01"]);
  assert.equal(out.buyersMonthly[0].extendsPastWindow, true);
  assert.equal(out.buyersCumulativeAtStart, BUYERS.filter((r) => r.day < w.from).at(-1).cumulative);
  assert.deepEqual(out.retention, BODY.retention, "retention stays all-time");
  assert.deepEqual(out.window, w);
});
await check("window totals are the charted rows plus the Tempo lane, nothing else", () => {
  const w = P({ from: "2026-09-10", to: "2026-09-20" }).window;
  const t = revenueWindowTotals(BODY, TEMPO, w, { buyers: 4 });
  const inW = ROWS.filter((r) => r.day >= w.from && r.day <= w.to);
  assert.equal(t.externalPayments, inW.reduce((s, r) => s + r.extTx, 0) + 2);
  assert.equal(t.settlements, inW.reduce((s, r) => s + r.extTx + r.intTx, 0) + 3);
  assert.equal(t.externalUsd, +(inW.reduce((s, r) => s + r.extUsd, 0) + 0.5).toFixed(6));
  assert.equal(t.buyers, 4);
});

// ---------------------------------------------------------------------------
console.log("revenue range: page first paint and URL round trip");
const SNAP = { asOf: "2026-10-10T12:00:00.000Z", rails: [], allTime: { allTimeInboundCount: 10, allTimeExternalCount: 4, allTimeExternalUsd: 1 }, mpp: {}, standing: {} };
const pageFor = (query) => {
  const range = revenuePageRange(query, { firstDay: FIRST, now: NOW, totalsFor: (w) => revenueWindowTotals(BODY, TEMPO, w, { buyers: 4 }) });
  return { range, html: revenuePage("https://example.test", { ...SNAP, range }) };
};
const doc = (html) => new JSDOM(html).window.document;
await check("the default page renders the default window, not all-time", () => {
  const { range, html } = pageFor({});
  const d = doc(html);
  const rvz = d.getElementById("rvz");
  assert.equal(rvz.dataset.from, range.window.from);
  assert.equal(rvz.dataset.to, "2026-10-10");
  assert.equal(rvz.dataset.preset, REVENUE_DEFAULT_RANGE);
  assert.equal(d.querySelector('.rvr-chip[aria-current="true"]').dataset.range, REVENUE_DEFAULT_RANGE);
  assert.match(d.getElementById("rvzWindow").textContent, new RegExp(`${range.window.from} to 2026-10-10 \\(30 days, UTC\\)`));
  assert.match(d.getElementById("rvzRaw").getAttribute("href"), new RegExp(`from=${range.window.from}&to=2026-10-10`));
});
await check("a custom window renders its label, its totals and its form values", () => {
  const { range, html } = pageFor({ from: "2026-09-10", to: "2026-09-20" });
  const d = doc(html);
  assert.match(d.getElementById("rvzWindow").textContent, /2026-09-10 to 2026-09-20 \(11 days, UTC\)/);
  assert.equal(d.querySelector('.rvr-chip[aria-current="true"]'), null, "a custom window selects no preset");
  const f = d.getElementById("rvzRangeForm");
  assert.equal(f.getAttribute("method"), "get");
  assert.equal(f.querySelector('input[name="from"]').value, "2026-09-10");
  assert.equal(f.querySelector('input[name="to"]').value, "2026-09-20");
  assert.equal(f.querySelector('input[name="from"]').getAttribute("min"), FIRST);
  const totals = d.getElementById("rvzTotals").textContent;
  assert.ok(totals.includes(range.totals.externalPayments.toLocaleString("en-US")), totals);
  assert.ok(totals.includes(`$${range.totals.externalUsd.toFixed(2)}`), totals);
  assert.ok(/all-time/.test(d.getElementById("rvzWindow").textContent), "the label says the headline and tables stay all-time");
});
await check("the headline keeps its all-time figures and says so", () => {
  const d = doc(pageFor({ range: "7d" }).html);
  assert.ok(/settled transactions, all-time/.test(d.body.textContent));
  assert.ok(/revenue, settled on-chain \(x402 rails \+ Tempo MPP\), all-time/.test(d.body.textContent));
});
await check("a refused range opens the default and names the reason", () => {
  const d = doc(pageFor({ range: "forever" }).html);
  assert.equal(d.getElementById("rvz").dataset.preset, REVENUE_DEFAULT_RANGE);
  assert.match(d.getElementById("rvzRangeNotice").textContent, /could not be read/);
});
await check("every chip link parses back to the window its label names", () => {
  const d = doc(pageFor({}).html);
  for (const a of d.querySelectorAll(".rvr-chip")) {
    const u = new URL(a.getAttribute("href"), "https://example.test");
    assert.equal(u.pathname, "/revenue");
    const back = P(Object.fromEntries(u.searchParams));
    assert.equal(back.window.preset, a.dataset.range);
    assert.equal(rangeQueryString(back.window), u.search.slice(1));
  }
});
await check("the custom form's values parse back to the window rendered", () => {
  const { range, html } = pageFor({ from: "2026-08-02", to: "2026-08-30" });
  const f = doc(html).getElementById("rvzRangeForm");
  const q = Object.fromEntries([...f.querySelectorAll("input")].map((i) => [i.name, i.value]));
  assert.deepEqual(P(q).window, range.window);
});
await check("with no range the chart section is what it always was", () => {
  const html = revenueChartSection();
  assert.ok(!html.includes("data-from"), "no window attributes");
  assert.ok(!html.includes("rvzRange"), "no range control");
  assert.ok(html.includes('href="/api/revenue/daily"'), "raw link is the full series");
});

// ---------------------------------------------------------------------------
console.log("revenue range: chart script in place");
const CHART_JS = readFileSync(new URL("../assets/js/revenue-chart.js", import.meta.url), "utf8");
async function bootChart(query) {
  const { html } = pageFor(query);
  const page = html.replace('<script src="/js/revenue-chart.js"></script>', `<script>${CHART_JS}</script>`);
  const fetched = [];
  const dom = new JSDOM(page, {
    url: `https://example.test/revenue${Object.keys(query).length ? "?" + new URLSearchParams(query) : ""}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (url) => {
        fetched.push(String(url));
        const u = new URL(String(url), "https://example.test");
        const win = P(Object.fromEntries(u.searchParams)).window;
        if (u.pathname === "/api/revenue/daily") return Promise.resolve({ json: () => Promise.resolve(win ? rangedRevenueDaily(BODY, win, { tempo: TEMPO, concentration: { buyers: 4 } }) : BODY) });
        if (u.pathname === "/api/revenue/tempo-daily") return Promise.resolve({ json: () => Promise.resolve({ days: TEMPO.days.filter((r) => !win || (r.day >= win.from && r.day <= win.to)) }) });
        return Promise.resolve({ json: () => Promise.resolve({ days: [], recordingSince: null }) });
      };
    },
  });
  await new Promise((r) => setTimeout(r, 80));
  return { w: dom.window, fetched };
}
const tableRows = (w) => [...w.document.querySelectorAll("#rvzTable tr")].slice(1).map((tr) => tr.querySelector("td").textContent);
const clickSeg = (w, id, v) => w.document.querySelector(`#${id} button[data-v="${v}"]`).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
{
  const { w, fetched } = await bootChart({ from: "2026-09-10", to: "2026-09-20" });
  await check("first load fetches only the rendered window", () => {
    assert.equal(fetched.length, 3);
    for (const u of fetched) assert.ok(u.endsWith("?from=2026-09-10&to=2026-09-20"), u);
  });
  await check("the axis is the window: one bar per day, first to last", () => {
    clickSeg(w, "rvzMode", "daily");
    const rows = tableRows(w);
    assert.equal(rows.length, 11);
    assert.equal(rows[0], "2026-09-10");
    assert.equal(rows.at(-1), "2026-09-20");
  });
  await check("cumulative starts from zero on the window's first day", () => {
    clickSeg(w, "rvzMode", "cum");
    const first = w.document.querySelectorAll("#rvzTable tr")[1];
    const cells = [...first.querySelectorAll("td")].map((c) => c.textContent);
    const day0 = ROWS.find((r) => r.day === "2026-09-10");
    assert.equal(cells.at(-1), `$${day0.extUsd.toFixed(4)}`, cells.join(" | "));
  });
  await check("cumulative buyers carry the all-time union across quiet days", () => {
    clickSeg(w, "rvzMetric", "buyers");
    const rows = [...w.document.querySelectorAll("#rvzTable tr")].slice(1).map((tr) => [...tr.querySelectorAll("td")].map((c) => c.textContent));
    assert.equal(rows.length, 11);
    for (let i = 1; i < rows.length; i++) assert.ok(Number(rows[i].at(-1)) >= Number(rows[i - 1].at(-1)), "a union never shrinks");
    assert.ok(Number(rows[0].at(-1)) > 0, "the line starts at the union before the window, not zero");
    clickSeg(w, "rvzMetric", "usd");
  });
  await check("a preset chip switches in place: URL, fetches, label and selection in step", async () => {
    fetched.length = 0;
    const chip = w.document.querySelector('.rvr-chip[data-range="7d"]');
    chip.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.location.pathname + w.location.search, "/revenue?range=7d");
    assert.equal(fetched.length, 3);
    for (const u of fetched) assert.ok(u.endsWith("?from=2026-10-04&to=2026-10-10"), u);
    assert.equal(w.document.getElementById("rvzWindowText").textContent, "2026-10-04 to 2026-10-10 (7 days, UTC)");
    assert.equal(w.document.querySelector('.rvr-chip[aria-current="true"]').dataset.range, "7d");
    assert.equal(w.document.getElementById("rvzRangeForm").elements.from.value, "2026-10-04");
    assert.ok(w.document.getElementById("rvzTotals").textContent.startsWith("In this range:"));
    const back = P(Object.fromEntries(new URLSearchParams(w.location.search))).window;
    assert.deepEqual([back.from, back.to], ["2026-10-04", "2026-10-10"], "the URL reloads to the same window");
  });
  await check("the custom form switches in place and writes from/to to the URL", async () => {
    fetched.length = 0;
    const f = w.document.getElementById("rvzRangeForm");
    f.elements.from.value = "2026-08-01"; f.elements.to.value = "2026-08-31";
    f.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.location.search, "?from=2026-08-01&to=2026-08-31");
    for (const u of fetched) assert.ok(u.endsWith("?from=2026-08-01&to=2026-08-31"), u);
    assert.equal(w.document.querySelector('.rvr-chip[aria-current="true"]'), null);
    clickSeg(w, "rvzMode", "daily");
    assert.equal(tableRows(w).length, 31);
  });
  await check("an end before the start is refused in the form, nothing fetched", async () => {
    fetched.length = 0;
    const f = w.document.getElementById("rvzRangeForm");
    f.elements.from.value = "2026-09-30"; f.elements.to.value = "2026-09-01";
    f.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fetched.length, 0);
    assert.equal(w.location.search, "?from=2026-08-01&to=2026-08-31");
  });
  await check("Back restores the previous window", async () => {
    fetched.length = 0;
    w.history.back();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(w.location.search, "?range=7d");
    assert.equal(w.document.getElementById("rvzWindowText").textContent, "2026-10-04 to 2026-10-10 (7 days, UTC)");
    assert.ok(fetched.some((u) => u.endsWith("?from=2026-10-04&to=2026-10-10")));
  });
}

// ---------------------------------------------------------------------------
console.log("revenue range: the daily APIs on a booted server");
const dir = mkdtempSync(join(tmpdir(), "a402-range-"));
const WALLET = "0x00000000000000000000000000000000000a0402";
// The fixture's own canary: listed as ours, so its rows stay internal.
const OURS = "0x" + "e".repeat(40);
const today = utcToday();
const seedFirst = addDays(today, -59);
{
  const db = new Database(join(dir, "revenue.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS transfers (chain TEXT NOT NULL, wallet TEXT NOT NULL, txid TEXT NOT NULL, tx_hash TEXT NOT NULL, block INTEGER, when_ts INTEGER, payer TEXT, usd REAL NOT NULL, asset TEXT NOT NULL, external INTEGER NOT NULL, PRIMARY KEY (chain, wallet, txid))`);
  const ins = db.prepare("INSERT INTO transfers VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 60; i++) {
    const day = addDays(seedFirst, i);
    const ts = Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000);
    const payer = `0x${String((i % 7) + 1).padStart(40, "b")}`;
    const h = `0x${String(i).padStart(64, "c")}`;
    ins.run("base", WALLET, `${h}:0`, h, 1000 + i, ts, payer, 0.01, "USDC", 1);
    const h2 = `0x${String(i).padStart(64, "d")}`;
    ins.run("base", WALLET, `${h2}:0`, h2, 2000 + i, ts, OURS, 0.005, "USDC", 0);
  }
  db.close();
}
const PORT = await getFreePort();
const B = `http://127.0.0.1:${PORT}`;
const proc = spawn("node", ["src/server.js"], {
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "true", WALLET_ADDRESS: WALLET,
    REVENUE_LEDGER_DB: join(dir, "revenue.db"), SALES_LEDGER_DB: join(dir, "sales.db"), STATS_DB_DIR: dir,
    STATE_DATABASE_URL: "", OUR_WALLETS: OURS, REVENUE_DAILY_START: seedFirst, X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off",
    X402_SYNC_ON_START: "false", FREE_ALERTS: "off", MPP_SECRET_KEY: "",
  },
  stdio: "ignore",
});
const stop = () => { try { proc.kill("SIGKILL"); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} };
process.on("exit", stop);
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try { up = (await fetch(`${B}/health`)).ok; } catch {}
  if (!up) await new Promise((r) => setTimeout(r, 500));
}
const get = async (path) => { const r = await fetch(B + path); return { status: r.status, body: await r.json(), cc: r.headers.get("cache-control") }; };
if (!up) { fail++; console.log("FAIL - server did not come up"); }
else {
  const full = await get("/api/revenue/daily");
  await check("no range query: the full series, the same fields as before", () => {
    assert.equal(full.status, 200);
    assert.deepEqual(Object.keys(full.body), ["asOf", "days", "daysScope", "buyers", "buyersWeekly", "buyersMonthly", "concentration", "retention", "repeat7"]);
    assert.equal(full.body.days.length, 60, "every seeded day");
    assert.ok(!("window" in full.body) && !("totals" in full.body));
  });
  await check("range=7d: bounded to the last 7 days, window named, totals for the window", async () => {
    const r = await get("/api/revenue/daily?range=7d");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.window, { from: addDays(today, -6), to: today, days: 7, preset: "7d" });
    assert.equal(r.body.days.length, 7);
    assert.ok(r.body.days.every((x) => x.day >= r.body.window.from && x.day <= today));
    assert.ok(r.body.buyers.every((x) => x.day >= r.body.window.from));
    assert.equal(r.body.totals.externalPayments, 7);
    assert.equal(r.body.totals.settlements, 14, "ours included");
    assert.equal(r.body.totals.externalUsd, 0.07);
    assert.equal(r.body.concentration.payments, 7, "concentration is over the window");
    assert.equal(r.body.concentration.scope.since, addDays(today, -6));
    assert.ok(r.body.concentration.buyers <= 7);
    assert.match(r.cc, /max-age=300/);
  });
  await check("from/to before the data and after today clamp to the data", async () => {
    const r = await get(`/api/revenue/daily?from=2020-01-01&to=${addDays(today, 30)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.window.from, seedFirst);
    assert.equal(r.body.window.to, today);
    assert.equal(r.body.days.length, 60);
  });
  await check("garbage answers 400 on every daily API, with what is accepted", async () => {
    for (const p of ["/api/revenue/daily", "/api/calls/daily", "/api/revenue/tempo-daily"]) {
      for (const q of ["from=2026-13-01", "from=2026-10-02&to=2026-10-01", "range=forever", "days=abc", "range=7d&from=2026-10-01", "from=2026-10-01&from=2026-10-02", `from=${addDays(today, 2)}`]) {
        const r = await get(`${p}?${q}`);
        assert.equal(r.status, 400, `${p}?${q} answered ${r.status}`);
        assert.equal(r.body.error, "invalid range");
        assert.match(r.body.accepted, /YYYY-MM-DD/);
      }
    }
  });
  await check("calls/daily and tempo-daily: ranged answers name the window; defaults keep their fields", async () => {
    const c = await get("/api/calls/daily");
    assert.deepEqual(Object.keys(c.body), ["asOf", "recordingSince", "days"]);
    const cr = await get("/api/calls/daily?days=3");
    assert.equal(cr.status, 200);
    assert.ok(cr.body.window && cr.body.days.every((x) => x.day >= cr.body.window.from && x.day <= cr.body.window.to));
    const t = await get("/api/revenue/tempo-daily");
    assert.deepEqual(Object.keys(t.body), ["asOf", "recordingSince", "days"]);
    const tr = await get("/api/revenue/tempo-daily?range=30d");
    assert.equal(tr.status, 200);
    assert.equal(tr.body.window.preset, "30d");
    assert.ok(Array.isArray(tr.body.days));
  });
}
stop();
console.log(`\ntest-revenue-range: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
