// FRED's Terms of Use, as the FRED tools hold to them (offline: fetch is
// stubbed, the key is a placeholder):
//   1. every answer that carries FRED data has a `terms` field that links the
//      Terms of Use and says users are bound by them, and so does each tool's
//      published example;
//   2. fred-series is not a FRED tool: it reads the publishing agencies
//      (scripts/test-fred-series-sources.js);
//   3. fred-release-observations holds such series back and names them, holds
//      back what it could not screen inside one call, and refuses a page that
//      is all third-party series.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { stubGuardResolver, offlineGuardAnswer } from "./lib/guard-resolver-stub.js";
import { MACRO_TOOLS, fredCopyrightOf, _resetFredScreenForTest, _setFredScreenBudgetForTest, FRED_SCREEN_READS_PER_CALL, FRED_SCREEN_BUDGET_MS } from "../src/tools/macro-kit.js";
import { FRED_TERMS, FRED_TERMS_URL } from "../src/data-attribution.js";

let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
const tool = (slug) => MACRO_TOOLS.find((t) => t.slug === slug);
const h = (slug) => tool(slug).handler;
const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };

// --- the notice reader -------------------------------------------------------
ok(fredCopyrightOf("Seasonally adjusted. Source: U.S. Bureau of Labor Statistics.") === null && fredCopyrightOf("") === null && fredCopyrightOf(undefined) === null, "notes with no copyright notice are not third-party");
ok(fredCopyrightOf("This series is in the public domain and is not subject to copyright.") === null && fredCopyrightOf("There are no copyright restrictions on these data. Citation requested.") === null, "a statement that a series is free of copyright is not a notice");
ok(fredCopyrightOf("Not seasonally adjusted. Copyright, 2020, Some Owner LLC.")?.owner === "Some Owner LLC", "a negation in an earlier sentence does not hide a notice");
const OWNERS = [
  ["Copyright, 2016, ICE Data Indices, LLC. Reproduction of this data is prohibited.", "ICE Data Indices, LLC"],
  ["The observations are daily.\n\nCopyright © 2016, S&P Dow Jones Indices LLC. All rights reserved. Reproduction in any form is prohibited.", "S&P Dow Jones Indices LLC"],
  ["© 2024 Example Index Provider Inc. All rights reserved.", "Example Index Provider Inc"],
  ["Copyright 2019-2024 by Example Data Co; used with permission", "Example Data Co"],
  ["COPYRIGHT (c) 2020 Some Owner", "Some Owner"],
];
for (const [notes, owner] of OWNERS) ok(fredCopyrightOf(notes)?.owner === owner, `the notice names its owner: ${owner} (got ${JSON.stringify(fredCopyrightOf(notes))})`);
ok(fredCopyrightOf("Copyright.")?.owner === null && fredCopyrightOf("see the copyright 2020")?.owner === null, "a notice that names no owner still reads as third-party, owner null");
{
  const t0 = Date.now();
  fredCopyrightOf(`Copyright ${"2020 ".repeat(200_000)}`); fredCopyrightOf("copyright".repeat(200_000)); fredCopyrightOf(`©${" ,".repeat(300_000)}`);
  ok(Date.now() - t0 < 500, `a hostile notes text is read in bounded time (${Date.now() - t0} ms)`);
}

// --- every FRED tool carries the terms line -----------------------------------
const fredTools = MACRO_TOOLS.filter((t) => t.attribution === "fred");
ok(fredTools.length >= 8 && !fredTools.some((t) => t.slug === "fred-series") && ["fred-search", "fred-series-info", "fred-release-calendar", "fred-release-observations", "sahm-rule", "cpi-yoy", "unemployment-rate", "fed-funds"].every((s) => fredTools.some((t) => t.slug === s)), `every FRED tool is marked (${fredTools.length})`);
ok(FRED_TERMS.includes(FRED_TERMS_URL) && FRED_TERMS_URL === "https://fred.stlouisfed.org/docs/api/terms_of_use.html" && /bound by/.test(FRED_TERMS), "the terms line links the Terms of Use and says users are bound by them");
ok(fredTools.every((t) => t.discovery.output.example.terms === FRED_TERMS), `every FRED tool's published example carries the terms line (missing: ${fredTools.filter((t) => t.discovery.output.example.terms !== FRED_TERMS).map((t) => t.slug).join(", ") || "none"})`);
ok(MACRO_TOOLS.filter((t) => t.attribution !== "fred").every((t) => (t.discovery?.output?.example || {}).terms !== FRED_TERMS), "a tool on another source carries no FRED terms line");

ok(!/FRED\(R\) API|St\. Louis/.test(tool("fred-series").description) && tool("fred-series").attribution === "us-agencies", "fred-series: the description makes no FRED API claim and credits the agencies");
ok(/withheld/.test(tool("fred-release-observations").description) && /carry a copyright notice in their FRED notes/.test(tool("fred-release-observations").description) && !/third party owns|owned by/.test(tool("fred-release-observations").description), "fred-release-observations: the description says third-party series are held back");

// --- stubbed FRED ----------------------------------------------------------------
const realFetch = globalThis.fetch;
const saved = { v1: process.env.FRED_API_KEY, v2: process.env.FRED_API_KEY_V2 };
process.env.FRED_API_KEY = "fred-test-not-a-key";
process.env.FRED_API_KEY_V2 = "fred-test-not-a-key-v2";
const undoDns = stubGuardResolver(offlineGuardAnswer);
const NOTES = {
  UNRATE: "The unemployment rate represents the number of unemployed as a percentage of the labor force.",
  GDPC1: "BEA Account Code: A191RX",
  SP500: "The observations for the S&P 500 represent the daily index value at market close.\n\nCopyright © 2016, S&P Dow Jones Indices LLC. All rights reserved. Reproduction of S&P 500 in any form is prohibited except with the prior written permission of S&P Dow Jones Indices LLC.",
  BAMLH0A0HYM2: "Copyright, 2023, ICE Data Indices, LLC. Reproduction of this data in any form is prohibited.",
};
const calls = [];
let releaseBody = null, metaStatus = 200;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  calls.push(u.pathname);
  if (u.pathname === "/fred/series") {
    if (metaStatus !== 200) return json(metaStatus, { error_code: metaStatus, error_message: "Internal Server Error" });
    const id = u.searchParams.get("series_id");
    const notes = Object.hasOwn(NOTES, id) ? NOTES[id] : id.startsWith("GOV") ? "A government series." : null;
    if (notes === null) return json(400, { error_code: 400, error_message: "Bad Request.  The series does not exist." });
    return json(200, { seriess: [{ id, title: id, notes }] });
  }
  if (u.pathname === "/fred/series/observations") return json(200, { observations: [{ date: "2026-01-01", value: "4.1" }, { date: "2026-02-01", value: "." }] });
  if (u.pathname === "/fred/v2/release/observations") return json(200, releaseBody);
  if (u.pathname === "/fred/series/search") return json(200, { seriess: [{ id: "UNRATE", title: "Unemployment Rate" }] });
  return json(404, {});
};
const fresh = () => { calls.length = 0; _resetFredScreenForTest(); metaStatus = 200; };
const count = (path) => calls.filter((p) => p === path).length;
try {
  // fred-series reads no FRED data (scripts/test-fred-series-sources.js).
  fresh();
  ok((await h("fred-search")({ q: "unemployment" })).terms === FRED_TERMS, "fred-search: the answer carries the terms line");

  // fred-release-observations: third-party series are held back and named.
  const obs = [{ date: "2026-06-17", value: "4.49" }];
  fresh();
  releaseBody = { release: { release_id: 18, name: "H.15" }, has_more: false, series: [
    { series_id: "UNRATE", title: "U", observations: obs },
    { series_id: "SP500", title: "S", observations: obs },
    { series_id: "INLINE1", title: "inline notes", notes: "Copyright, 2020, Inline Owner Ltd. All rights reserved.", observations: obs },
    { series_id: "INLINE2", title: "inline clean", notes: "A government series.", observations: obs },
    { series_id: "FLAGGED", title: "flagged", copyright_id: 7, observations: obs },
  ] };
  const r = await h("fred-release-observations")({ releaseId: 18 });
  ok(r.series.map((s) => s.seriesId).join() === "UNRATE,INLINE2" && r.count === 2, `release: only series with no copyright notice are served (${r.series.map((s) => s.seriesId).join()})`);
  ok(r.withheld.length === 3 && r.withheld.find((w) => w.seriesId === "SP500").owner === "S&P Dow Jones Indices LLC" && r.withheld.find((w) => w.seriesId === "INLINE1").owner === "Inline Owner Ltd" && r.withheld.find((w) => w.seriesId === "FLAGGED").owner === null && r.withheld.filter((w) => w.seriesId !== "FLAGGED").every((w) => w.reason === "carries a copyright notice in its FRED notes") && r.withheld.find((w) => w.seriesId === "FLAGGED").reason === "carries FRED's copyright mark", `release: each held-back series is named with its owner and the reason (${JSON.stringify(r.withheld)})`);
  ok(r.matched === 5 && r.returned === 2 && r.complete === false && r.truncated === true && !("unscreened" in r), "release: the answer says in fields that it is not the whole page");
  ok(count("/fred/series") === 2, `release: notes the release answer carries cost no metadata read (${count("/fred/series")} reads)`);
  ok(r.terms === FRED_TERMS, "release: the answer carries the terms line");
  ok(!JSON.stringify(r).includes("4.49") || r.series.every((s) => ["UNRATE", "INLINE2"].includes(s.seriesId)), "release: no held-back series' observations ride along");

  // A page with nothing held back says nothing about holding back.
  fresh();
  releaseBody = { release: { release_id: 18, name: "H.15" }, series: [{ series_id: "UNRATE", observations: obs }, { series_id: "GDPC1", observations: obs }] };
  const clean = await h("fred-release-observations")({ releaseId: 18 });
  ok(clean.count === 2 && !("withheld" in clean) && !("matched" in clean) && !("unscreened" in clean), "release: a page of government series is served whole, with no partial fields");

  // A page that is all third-party series is refused, naming the owners.
  fresh();
  releaseBody = { release: { release_id: 999, name: "X" }, series: [{ series_id: "SP500", observations: obs }, { series_id: "BAMLH0A0HYM2", observations: obs }] };
  const e5 = await caught(h("fred-release-observations")({ releaseId: 999 }));
  ok(/^Every series on this page of FRED release 999 carries a copyright notice \(.*\) in its FRED notes and is not served here: /.test(e5?.message || "") && !/owned by/.test(e5.message), `release: the page refusal says each series carries a copyright notice in its FRED notes (${String(e5?.message).slice(0, 110)})`);
  ok(e5?.statusCode === 400 && /S&P Dow Jones Indices LLC/.test(e5.message) && /ICE Data Indices, LLC/.test(e5.message) && e5.message.includes(FRED_TERMS_URL), `release: a page of third-party series only is a 400 naming the owners (${e5?.statusCode} ${e5?.message})`);

  // One call screens a bounded number of series; the rest are held back and counted, and the next call goes on.
  fresh();
  const many = FRED_SCREEN_READS_PER_CALL + 15;
  releaseBody = { release: { release_id: 10, name: "CPI" }, series: Array.from({ length: many }, (_, k) => ({ series_id: `GOV${k}`, observations: obs })) };
  const big = await h("fred-release-observations")({ releaseId: 10 });
  ok(count("/fred/series") === FRED_SCREEN_READS_PER_CALL && big.count === FRED_SCREEN_READS_PER_CALL && big.unscreened === 15 && big.matched === many && big.truncated === true && typeof big.unscreenedNote === "string", `release: one call makes at most ${FRED_SCREEN_READS_PER_CALL} screening reads and counts what it held back (${count("/fred/series")} reads, ${big.count} served, ${big.unscreened} unscreened)`);
  const again = await h("fred-release-observations")({ releaseId: 10 });
  ok(again.count === many && !("unscreened" in again) && count("/fred/series") === many, "release: the next call screens the rest from the kept verdicts");

  // The screening of one call is bounded in time as well: with the time used
  // up no further read starts, and what was not read is counted, not served.
  fresh();
  _setFredScreenBudgetForTest(0);
  releaseBody = { release: { release_id: 11, name: "PPI" }, series: [{ series_id: "UNRATE", notes: "Source: U.S. Bureau of Labor Statistics.", observations: obs }, ...Array.from({ length: 12 }, (_, k) => ({ series_id: `GOVLATE${k}`, observations: obs }))] };
  const timed = await h("fred-release-observations")({ releaseId: 11 });
  ok(count("/fred/series") === 0 && timed.count === 1 && timed.unscreened === 12 && timed.matched === 13 && timed.complete === false && timed.series.every((x) => x.seriesId === "UNRATE"), `release: once the screening time is used no read starts, and the 12 series not screened are counted and held back (${count("/fred/series")} reads, unscreened ${timed.unscreened})`);
  _setFredScreenBudgetForTest();
  const timedNext = await h("fred-release-observations")({ releaseId: 11 });
  ok(timedNext.count === 13 && !("unscreened" in timedNext) && count("/fred/series") === 12 && FRED_SCREEN_BUDGET_MS >= 1000, "release: the next call reads them");

  // Nothing screened at all is the upstream's fault: a 503, never unscreened data.
  fresh(); metaStatus = 500;
  releaseBody = { release: { release_id: 10, name: "CPI" }, series: [{ series_id: "GOV1", observations: obs }] };
  const e6 = await caught(h("fred-release-observations")({ releaseId: 10 }));
  ok(e6?.statusCode === 503 && e6.retryAfter > 0, `release: a page it could not screen at all is a 503 with a retry hint (${e6?.statusCode})`);
} finally {
  globalThis.fetch = realFetch;
  undoDns();
  for (const [k, v] of [["FRED_API_KEY", saved.v1], ["FRED_API_KEY_V2", saved.v2]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
