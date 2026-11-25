// FRED's Terms of Use, as this catalog holds to them (offline, no network):
//   1. the notice reader a tool serving a caller-chosen FRED series applies;
//   2. no macro tool serves FRED data: us-macro-series and the computed tools read
//      the publishing agencies, so none carries FRED's terms line or claim.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { MACRO_TOOLS, fredCopyrightOf } from "../src/tools/macro-kit.js";
import * as DA from "../src/data-attribution.js";

let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
const tool = (slug) => MACRO_TOOLS.find((t) => t.slug === slug);

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

// --- no tool serves FRED data ------------------------------------------------------
// us-macro-series and the computed tools (sahm-rule, cpi-yoy, unemployment-rate,
// fed-funds) read the publishing agencies (scripts/test-fred-series-sources.js,
// scripts/test-macro-computed-sources.js): none is marked as a FRED tool,
// carries FRED's terms line or makes a FRED API claim.
ok(!("FRED_NOTICE" in DA) && !("FRED_TERMS" in DA) && !("FRED_TERMS_URL" in DA) && !("fred" in DA.ATTRIBUTIONS), "no FRED notice, terms line or attribution key is kept (no tool serves FRED data)");
ok(!MACRO_TOOLS.some((t) => t.attribution === "fred"), `no macro tool is marked as serving FRED data (${MACRO_TOOLS.filter((t) => t.attribution === "fred").map((t) => t.slug).join(", ") || "none"})`);
ok(MACRO_TOOLS.every((t) => !/stlouisfed/.test(String((t.discovery?.output?.example || {}).terms || ""))), "no macro tool's example carries FRED's terms line");
for (const slug of ["us-macro-series", "sahm-rule", "cpi-yoy", "unemployment-rate", "fed-funds"]) {
  ok(tool(slug) && !/FRED\(R\) API|St\. Louis/.test(tool(slug).description), `${slug}: the description makes no FRED API claim`);
}
ok(!/stlouisfed\.org/.test(MACRO_TOOLS.map((t) => String(t.handler)).join("\n")), "no macro handler names a FRED host");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
