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
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
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

// --- a tool and a skill pack that share a name are two pages, each with its date --
// market-brief is a tool (src/tools/research-deep-kit.js, served under /v1) and
// a skill pack (src/skills.js). The tool's page is dated by its kit and the
// pack's page by the pack module; neither makes the other undated.
{
  const { toolSources, packSources, ambiguous } = scanToolSources();
  ok(toolSources["market-brief"] === "src/tools/research-deep-kit.js", `the tool market-brief maps to its kit (${toolSources["market-brief"]})`);
  ok(packSources && packSources["market-brief"] === "src/skills.js", `the pack market-brief maps to the pack module (${packSources?.["market-brief"]})`);
  ok(!ambiguous.some((a) => a.startsWith("market-brief ")), "a pack of the same name does not make the tool's slug ambiguous");
  ok(Object.values(toolSources).every((f) => f.startsWith("src/tools/") || f === "src/server.js"), "every tool slug maps to a kit under src/tools/ or the server module, never to the pack module");
  ok(packSources && Object.keys(packSources).length >= 50 && Object.values(packSources).every((f) => f === "src/skills.js"), `pack slugs map to the pack module (${Object.keys(packSources || {}).length})`);
  const shared = Object.keys(packSources || {}).filter((s) => s in toolSources);
  ok(shared.includes("market-brief") && shared.every((s) => toolSources[s] !== packSources[s]), `every name a tool and a pack share keeps both sources (${shared.join(", ")})`);
  ok(ISO.test(pageLastmod("/tools/market-brief") || "") && pageLastmod("/tools/market-brief") === filesLastmod(["src/tools/research-deep-kit.js"]), `/tools/market-brief is dated by its kit (${pageLastmod("/tools/market-brief")})`);
  ok(ISO.test(pageLastmod("/skills/market-brief") || "") && pageLastmod("/skills/market-brief") === filesLastmod(["src/skills.js"]), `/skills/market-brief is dated by the pack module (${pageLastmod("/skills/market-brief")})`);
  // The lookup reads the two maps apart: one name, two dates.
  _setPageDatesTable({
    files: { "src/tools/k.js": "2026-02-01", "src/packs.js": "2026-05-01", "src/skills.js": "2026-06-01" },
    toolSources: { same: "src/tools/k.js" },
    packSources: { same: "src/packs.js" },
  });
  ok(pageLastmod("/tools/same") === "2026-02-01" && pageLastmod("/skills/same") === "2026-05-01", `seam: one name, the tool page dated by its kit and the pack page by its module (${pageLastmod("/tools/same")}, ${pageLastmod("/skills/same")})`);
  ok(pageLastmod("/skills/unlisted") === "2026-06-01", "seam: a pack page the table does not list is dated by the module that renders every pack page");
  ok(pageLastmod("/tools/unlisted") === null, "seam: a pack's name alone never dates a tool page");
  _setPageDatesTable(null);
}

// --- every way a tool is defined dates its page ----------------------------------
// A tool page carries the date of the file that defines it, however the slug
// is written there: an entry inline in the server module (screenshot, pdf, the
// memory family), a template that builds the slug per tier (the Messages,
// Gemini and Responses wires), or a constant that holds the literal.
{
  const { toolSources, toolPatterns } = scanToolSources();
  for (const slug of ["screenshot", "pdf", "memory-write", "memory-read", "memory-log", "memory-forget"]) {
    ok(toolSources[slug] === "src/server.js" && ISO.test(pageLastmod(`/tools/${slug}`) || ""), `/tools/${slug} is dated by the server module that defines it inline (${toolSources[slug]}, ${pageLastmod(`/tools/${slug}`)})`);
  }
  ok(toolSources["price-webhook"] === "src/tools/price-webhook-kit.js", `price-webhook (slug: PRICE_WEBHOOK_SLUG) maps to its kit (${toolSources["price-webhook"]})`);
  ok(toolSources["audit-report"] === "src/tools/audit-report-kit.js", `audit-report (slug: AUDIT_SLUG) maps to its kit (${toolSources["audit-report"]})`);
  // A retired tool's kit is gone, and its slug dates no page.
  ok(!("market-tick" in toolSources), `a retired tool keeps no source (${toolSources["market-tick"]})`);
  ok(toolPatterns["*-messages"] === "src/tools/llm-messages-kit.js" && toolPatterns["*-gemini"] === "src/tools/llm-gemini-kit.js" && toolPatterns["*-responses"] === "src/tools/llm-responses-kit.js", "the per-tier wire slugs are built by their kits' templates");
  for (const [slug, kit] of [["v1-chat-nano-messages", "llm-messages-kit.js"], ["v1-chat-metered-gemini", "llm-gemini-kit.js"], ["v1-chat-pro-responses", "llm-responses-kit.js"]]) {
    ok(toolLastmod(slug) === filesLastmod([`src/tools/${kit}`]) && ISO.test(toolLastmod(slug) || ""), `/tools/${slug} is dated by ${kit} (${toolLastmod(slug)})`);
  }
  ok(toolSources.hash === "src/tools/kit.js", "a slug a kit defines keeps its kit, never the server module that also names it");
  // The kits listed only with a key or switch are not in a keyless boot's
  // sitemap (scripts/test-sitemap-coverage.js reads that one); their pages
  // are dated all the same.
  const { envGatedTools } = await import("./published-slugs.js");
  const { skillPackOfToolSlug } = await import("../src/skills.js");
  const undated = (await envGatedTools()).filter((t) => !skillPackOfToolSlug(t.slug)).map((t) => t.slug).filter((slug) => !toolLastmod(slug));
  ok(undated.length === 0, `every key-gated tool page carries a lastmod${undated.length ? `; undated: ${undated.join(", ")}` : ""}`);
  // The seam: an exact entry wins over a pattern, two patterns that match one
  // slug date nothing, and a pattern needs a non-empty middle.
  _setPageDatesTable({
    files: { "src/tools/a.js": "2026-01-01", "src/tools/b.js": "2026-02-01", "src/tools/c.js": "2026-03-01" },
    toolSources: { "x-wire": "src/tools/c.js" },
    toolPatterns: { "*-wire": "src/tools/a.js", "y-*": "src/tools/b.js" },
  });
  ok(toolLastmod("x-wire") === "2026-03-01", "seam: an exact slug entry wins over a pattern");
  ok(toolLastmod("z-wire") === "2026-01-01", "seam: a slug no entry names is dated by the one pattern it matches");
  ok(toolLastmod("y-wire") === null, "seam: a slug two patterns match is not dated");
  ok(toolLastmod("-wire") === null, "seam: a pattern's placeholder is never empty");
  _setPageDatesTable(null);
}

// --- the lookup the sitemap uses -------------------------------------------------
ok(ISO.test(pageLastmod("/") || ""),`/ is dated from ${PAGE_SOURCES["/"].join(",")} (${pageLastmod("/")})`);
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
{
  // /transparency prints the date its sitemap entry carries, never a typed one.
  const { transparencyPage } = await import("../src/transparency.js");
  const printed = (String(transparencyPage("https://agent402.tools")).match(/last updated (\d{4}-\d{2}-\d{2})\./) || [])[1];
  ok(printed && printed === pageLastmod("/transparency"), `/transparency prints the module's date (${printed}, sitemap ${pageLastmod("/transparency")})`);
  ok(!/last updated \d{4}-/.test(readFileSync(new URL("../src/transparency.js", import.meta.url), "utf8")), "src/transparency.js types no date of its own");
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
