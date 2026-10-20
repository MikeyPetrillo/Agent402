#!/usr/bin/env node
// The sitemap lastmod table (src/generated/page-dates.json) matches git
// history, and src/page-dates.js reads it the way the sitemap does.
//
// Needs full history: in a shallow clone every file's newest commit is the
// clone's head, so the check is run only where `git log` can answer, and a
// shallow checkout fails here instead of passing on nothing (the lane that
// runs this checks out with fetch-depth 0).
//
//   node scripts/test-page-dates.js
import { readFileSync } from "node:fs";
import { buildTable, readTable, diffTables, isShallow, scanToolSources } from "./gen-page-dates.js";
import { pageLastmod, toolLastmod, legalLastmod, filesLastmod, dayOf, pageSourceFiles, PAGE_SOURCES, _setPageDatesTable } from "../src/page-dates.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const today = new Date().toISOString().slice(0, 10);

// --- the committed table against history ---------------------------------------
ok(!isShallow(), "the clone carries full history (a shallow clone cannot date a file)");
const stored = readTable();
ok(stored && stored.files && stored.toolSources, "src/generated/page-dates.json exists with files and toolSources");
if (!isShallow() && stored) {
  const { table, missing, ambiguous } = buildTable();
  ok(missing.length === 0, `every page source is on disk${missing.length ? `: missing ${missing.join(", ")}` : ""}`);
  const drift = diffTables(stored, table);
  ok(drift.length === 0, drift.length ? `table is stale, run: node scripts/gen-page-dates.js --write\n  ${drift.slice(0, 12).join("\n  ")}${drift.length > 12 ? `\n  ... ${drift.length - 12} more` : ""}` : "committed table matches git history");
  ok(Object.keys(table.toolSources).length >= 400, `tool slugs mapped to a defining kit (${Object.keys(table.toolSources).length}, ${ambiguous.length} ambiguous and undated)`);
  ok(Object.values(stored.files).every((d) => ISO.test(d) && d <= today), "every stored date is an ISO day no later than today");
  ok(new Set(Object.values(stored.files)).size >= 5, `the dates differ across files (${new Set(Object.values(stored.files)).size} distinct), not one stamp for all`);
  for (const f of pageSourceFiles()) ok(f in stored.files, `page source ${f} is dated`);
}

// --- the slug scan reads definitions, not references ----------------------------
{
  const { toolSources } = scanToolSources();
  ok(toolSources.hash === "src/tools/kit.js", `hash (named by a pack step too) maps to the kit that routes it (${toolSources.hash})`);
  ok(toolSources["crypto-price"] === "src/tools/crypto-kit.js", `crypto-price (named by attest and feedback) maps to its kit (${toolSources["crypto-price"]})`);
}

// --- the lookup the sitemap uses -------------------------------------------------
ok(ISO.test(pageLastmod("/") || ""), `/ is dated from ${PAGE_SOURCES["/"].join(",")} (${pageLastmod("/")})`);
ok(pageLastmod("/") === filesLastmod(PAGE_SOURCES["/"]), "a static page's lastmod is its module's date");
ok(pageLastmod("/base") === filesLastmod(["src/market-page.js"]), "a chain page is dated by the market page module");
ok(pageLastmod("/guides/agent-hosts") === filesLastmod(["src/guides.js"]), "a guide is dated by the guides module");
ok(ISO.test(toolLastmod("hash") || "") && pageLastmod("/tools/hash") === toolLastmod("hash"), `/tools/hash is dated by its kit (${toolLastmod("hash")})`);
ok(pageLastmod("/tools/no-such-tool-xyz") === null, "an unknown tool slug has no lastmod");
ok(pageLastmod("/tools/category/crypto") === null, "a category page has no lastmod");
ok(pageLastmod("/api/pricing") === null && pageLastmod("/.well-known/x402") === null, "a live machine surface has no lastmod");
ok(pageLastmod("/reports/insider/NVDA") === null, "a seeded entity page has no lastmod");
ok(pageLastmod("/api/find?q=search+the+web") === null, "a query string does not invent a date");
{
  const terms = (readFileSync(new URL("../src/terms.js", import.meta.url), "utf8").match(/last updated (\d{4}-\d{2}-\d{2})\./) || [])[1];
  const privacy = (readFileSync(new URL("../src/privacy.js", import.meta.url), "utf8").match(/last updated (\d{4}-\d{2}-\d{2})\./) || [])[1];
  ok(terms && pageLastmod("/terms") === terms && legalLastmod("/terms") === terms, `/terms is dated by the date the page prints (${terms})`);
  ok(privacy && pageLastmod("/privacy") === privacy, `/privacy is dated by the date the page prints (${privacy})`);
}
ok(dayOf("2026-10-02T14:03:00.000Z") === "2026-10-02" && dayOf(null) === null && dayOf("not a date") === null, "dayOf reduces a timestamp to a day and rejects junk");

// --- a partly dated source is undated, and a missing table dates nothing --------
{
  _setPageDatesTable({ files: { "src/ledger-home.js": "2026-01-02" }, toolSources: { x: "src/tools/nowhere.js" } });
  ok(pageLastmod("/") === "2026-01-02", "seam: the lookup reads the table it is given");
  ok(filesLastmod(["src/ledger-home.js", "src/missing.js"]) === null, "a page with an undated source is undated, never half-dated");
  ok(toolLastmod("x") === null, "a slug whose kit is undated has no lastmod");
  _setPageDatesTable({ files: { "src/a.js": "2026-03-01", "src/b.js": "2026-04-01" } });
  ok(filesLastmod(["src/a.js", "src/b.js"]) === "2026-04-01", "several sources: the newest date wins");
  _setPageDatesTable(null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
