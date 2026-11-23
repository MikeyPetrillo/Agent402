// FRED's Terms of Use, as the FRED tools hold to them (offline: fetch is
// stubbed, the key is a placeholder):
//   1. every answer that carries FRED data has a `terms` field that links the
//      Terms of Use and says users are bound by them, and so does each tool's
//      published example;
//   2. fred-series reads a series' notes before its observations and refuses
//      a series whose notes carry a copyright notice with a 400 naming the
//      owner and the reason (a 4xx is never charged), reading no observations.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { stubGuardResolver, offlineGuardAnswer } from "./lib/guard-resolver-stub.js";
import { MACRO_TOOLS, fredCopyrightOf, _resetFredScreenForTest } from "../src/tools/macro-kit.js";
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
ok(fredTools.length >= 5 && ["fred-series", "sahm-rule", "cpi-yoy", "unemployment-rate", "fed-funds"].every((s) => fredTools.some((t) => t.slug === s)), `every FRED tool is marked (${fredTools.length})`);
ok(FRED_TERMS.includes(FRED_TERMS_URL) && FRED_TERMS_URL === "https://fred.stlouisfed.org/docs/api/terms_of_use.html" && /bound by/.test(FRED_TERMS), "the terms line links the Terms of Use and says users are bound by them");
ok(fredTools.every((t) => t.discovery.output.example.terms === FRED_TERMS), `every FRED tool's published example carries the terms line (missing: ${fredTools.filter((t) => t.discovery.output.example.terms !== FRED_TERMS).map((t) => t.slug).join(", ") || "none"})`);
ok(MACRO_TOOLS.filter((t) => t.attribution !== "fred").every((t) => !("terms" in (t.discovery?.output?.example || {}))), "a tool on another source carries no FRED terms line");

ok(/carries a copyright notice in its FRED notes is refused/.test(tool("fred-series").description) && !/third party owns|owned by/.test(tool("fred-series").description) && /400/.test(tool("fred-series").description) && !/\bany of FRED/.test(tool("fred-series").description), "fred-series: the description says a third-party series is refused");

// --- stubbed FRED ----------------------------------------------------------------
const realFetch = globalThis.fetch;
const saved = { v1: process.env.FRED_API_KEY };
process.env.FRED_API_KEY = "fred-test-not-a-key";
const undoDns = stubGuardResolver(offlineGuardAnswer);
const NOTES = {
  UNRATE: "The unemployment rate represents the number of unemployed as a percentage of the labor force.",
  GDPC1: "BEA Account Code: A191RX",
  SP500: "The observations for the S&P 500 represent the daily index value at market close.\n\nCopyright © 2016, S&P Dow Jones Indices LLC. All rights reserved. Reproduction of S&P 500 in any form is prohibited except with the prior written permission of S&P Dow Jones Indices LLC.",
  BAMLH0A0HYM2: "Copyright, 2023, ICE Data Indices, LLC. Reproduction of this data in any form is prohibited.",
};
const calls = [];
let metaStatus = 200;
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
  return json(404, {});
};
const fresh = () => { calls.length = 0; _resetFredScreenForTest(); metaStatus = 200; };
const count = (path) => calls.filter((p) => p === path).length;
try {
  // fred-series: a government series is served, with the terms line.
  fresh();
  const a = await h("fred-series")({ seriesId: "UNRATE" });
  ok(a.seriesId === "UNRATE" && a.count === 1 && a.observations[0].value === 4.1, "fred-series: a series with no copyright notice is served");
  ok(a.terms === FRED_TERMS, "fred-series: the answer carries the terms line");
  ok(calls.join() === "/fred/series,/fred/series/observations", `fred-series: the notes are read before the observations (${calls.join()})`);
  await h("fred-series")({ seriesId: "UNRATE" });
  ok(count("/fred/series") === 1 && count("/fred/series/observations") === 2, "fred-series: a kept verdict costs no second metadata read");

  // fred-series: a third-party series is refused, uncharged, before its observations.
  fresh();
  const e1 = await caught(h("fred-series")({ seriesId: "sp500" }));
  ok(e1?.statusCode === 400, `fred-series: a series whose notes carry a copyright notice is a 400 (got ${e1?.statusCode})`);
  ok(/S&P Dow Jones Indices LLC/.test(e1?.message || "") && /copyright notice/.test(e1?.message || "") && /owner's permission/.test(e1?.message || "") && e1.message.includes(FRED_TERMS_URL), `fred-series: the refusal names the owner, the reason and the terms (${e1?.message})`);
  ok(e1?.thirdPartySeries === true && e1.owner === "S&P Dow Jones Indices LLC", "fred-series: the refusal is marked with the owner");
  // What is known is the notice in the notes, read by a text rule: the words
  // say the series carries a notice and quote its name, never who owns it.
  ok(e1.message.startsWith("FRED series SP500 carries a copyright notice (S&P Dow Jones Indices LLC) in its FRED notes and is not served here: ") && !/\bis owned by\b|\bowned by\b/.test(e1.message), `fred-series: the refusal says the series carries a copyright notice in its FRED notes, with the name the notice gives (${e1.message.slice(0, 120)})`);
  ok(count("/fred/series/observations") === 0, "fred-series: a refused series' observations are never read");
  const e1b = await caught(h("fred-series")({ seriesId: "SP500" }));
  ok(e1b?.statusCode === 400 && count("/fred/series") === 1, "fred-series: the refusal is kept, with no second read");
  const e2 = await caught(h("fred-series")({ seriesId: "BAMLH0A0HYM2" }));
  ok(e2?.statusCode === 400 && /ICE Data Indices, LLC/.test(e2.message), "fred-series: another owner is named from its own notice");
  for (const id of ["GDPC1", "UNRATE"]) ok((await h("fred-series")({ seriesId: id })).seriesId === id, `fred-series: ${id} is unaffected`);

  // fred-series: a series that cannot be screened is not served.
  fresh(); metaStatus = 500;
  const e3 = await caught(h("fred-series")({ seriesId: "UNRATE" }));
  ok(e3 && e3.statusCode >= 500 && count("/fred/series/observations") === 0, `fred-series: a failed notes read serves nothing (${e3?.statusCode})`);
  fresh();
  const e4 = await caught(h("fred-series")({ seriesId: "NOSUCH" }));
  ok(e4?.statusCode === 404, `fred-series: an unknown series is still a 404 (${e4?.statusCode})`);
} finally {
  globalThis.fetch = realFetch;
  undoDns();
  for (const [k, v] of [["FRED_API_KEY", saved.v1]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
