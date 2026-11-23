// FRED's Terms of Use, as the FRED tools hold to them (offline: fetch is
// stubbed, the key is a placeholder):
//   1. every answer that carries FRED data has a `terms` field that links the
//      Terms of Use and says users are bound by them, and so does each tool's
//      published example;
//   2. fred-series is not a FRED tool: it reads the publishing agencies
//      (scripts/test-fred-series-sources.js); the notice reader is held here.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { stubGuardResolver, offlineGuardAnswer } from "./lib/guard-resolver-stub.js";
import { MACRO_TOOLS, fredCopyrightOf } from "../src/tools/macro-kit.js";
import { FRED_TERMS, FRED_TERMS_URL } from "../src/data-attribution.js";

let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
const tool = (slug) => MACRO_TOOLS.find((t) => t.slug === slug);
const h = (slug) => tool(slug).handler;

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
ok(fredTools.length >= 4 && !fredTools.some((t) => t.slug === "fred-series") && ["sahm-rule", "cpi-yoy", "unemployment-rate", "fed-funds"].every((s) => fredTools.some((t) => t.slug === s)), `every FRED tool is marked (${fredTools.length})`);
ok(FRED_TERMS.includes(FRED_TERMS_URL) && FRED_TERMS_URL === "https://fred.stlouisfed.org/docs/api/terms_of_use.html" && /bound by/.test(FRED_TERMS), "the terms line links the Terms of Use and says users are bound by them");
ok(fredTools.every((t) => t.discovery.output.example.terms === FRED_TERMS), `every FRED tool's published example carries the terms line (missing: ${fredTools.filter((t) => t.discovery.output.example.terms !== FRED_TERMS).map((t) => t.slug).join(", ") || "none"})`);
ok(MACRO_TOOLS.filter((t) => t.attribution !== "fred").every((t) => (t.discovery?.output?.example || {}).terms !== FRED_TERMS), "a tool on another source carries no FRED terms line");

ok(!/FRED\(R\) API|St\. Louis/.test(tool("fred-series").description) && tool("fred-series").attribution === "us-agencies", "fred-series: the description makes no FRED API claim and credits the agencies");

// --- stubbed FRED ----------------------------------------------------------------
// A FRED tool reads its fixed series' observations only, never a series' notes.
const realFetch = globalThis.fetch;
const saved = { v1: process.env.FRED_API_KEY };
process.env.FRED_API_KEY = "fred-test-not-a-key";
const undoDns = stubGuardResolver(offlineGuardAnswer);
const calls = [];
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  calls.push(u.pathname);
  if (u.pathname === "/fred/series/observations") return json(200, { observations: [{ date: "2026-02-01", value: "." }, { date: "2026-01-01", value: "4.1" }] });
  return json(404, {});
};
try {
  // fred-series reads no FRED data (scripts/test-fred-series-sources.js).
  const u = await h("unemployment-rate")({ months: 2 });
  ok(u.current === 4.1 && u.terms === FRED_TERMS, `unemployment-rate: the answer carries the terms line (${JSON.stringify(u).slice(0, 120)})`);
  ok(calls.length >= 1 && calls.every((p) => p === "/fred/series/observations"), `a FRED tool reads observations only (${calls.join()})`);
} finally {
  globalThis.fetch = realFetch;
  undoDns();
  for (const [k, v] of [["FRED_API_KEY", saved.v1]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
