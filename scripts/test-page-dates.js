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
import { buildTable, readTable, diffTables, isShallow, scanToolSources, presentModules } from "./gen-page-dates.js";
import { pageLastmod, toolLastmod, legalLastmod, filesLastmod, dayOf, pageSourceFiles, PAGE_SOURCES, PACK_PAGE_MODULES, _setPageDatesTable, entryDates, articleDates } from "../src/page-dates.js";
import { entrySpans } from "./gen-page-dates.js";

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
  ok(ISO.test(pageLastmod("/skills/market-brief") || "") && pageLastmod("/skills/market-brief") === [entryDates("/skills/market-brief")?.modified, ...presentModules().map((f) => filesLastmod([f]))].filter(Boolean).sort().pop(), `/skills/market-brief is dated by its own entry in the pack module, or a later change to a module every pack page renders (${pageLastmod("/skills/market-brief")})`);
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

// --- a family entry is dated by its own text -------------------------------------
// Every guide, pack, post, explainer and integration page used to share its
// module's newest commit date: one edit re-dated all of them.
{
  const text = 'const X = [\n  {\n    slug: "a",\n    title: "A",\n  },\n  {\n    slug: "b",\n    body: `  {\n    nested`,\n  },\n];\n';
  const spans = entrySpans(text);
  ok(spans.size === 2 && spans.get("a").includes('title: "A"') && !spans.get("a").includes('"b"') && spans.get("b").includes("nested"), "entrySpans cuts one span per entry, from its slug line to the next entry");
  _setPageDatesTable({ files: { "src/guides.js": "2026-06-01" }, entries: { "/guides/a": { published: "2026-01-01", modified: "2026-02-01" } }, filesFirst: { "src/what-is-x402.js": "2025-12-01" } });
  ok(pageLastmod("/guides/a") === "2026-02-01" && pageLastmod("/guides/b") === "2026-06-01", "seam: an entry's own date wins; an entry the table lacks falls back to its module");
  ok(articleDates("/guides/a").datePublished === "2026-01-01" && articleDates("/guides/a").dateModified === "2026-02-01", "seam: an article states the entry's published and modified dates");
  ok(articleDates("/blog/x", { published: "2026-03-01" }).datePublished === "2026-03-01", "seam: a printed publication date wins");
  _setPageDatesTable(null);
  const stored = readTable();
  const fams = {};
  for (const [p, d] of Object.entries(stored?.entries || {})) (fams[p.split("/")[1]] ||= new Set()).add(d.modified);
  // At least two dates per family: one edit that touches most entries of a
  // family (a package rename across every integration page) legitimately
  // re-dates those entries, and one entry dated apart still proves the dates
  // are per entry, not the module's.
  ok(["skills", "guides", "integrations"].every((f) => fams[f] && fams[f].size >= 2), `the committed table dates each family's entries apart (${Object.entries(fams).map(([f, s]) => `${f} ${s.size}`).join(", ")})`);
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
// A guide is dated one by one (the table's entries): its own last change, never
// later than the guides module, so an edit to another guide does not move it.
{
  const own = JSON.parse(readFileSync(new URL("../src/generated/page-dates.json", import.meta.url), "utf8")).entries?.["/guides/agent-hosts"]?.modified;
  const mod = filesLastmod(["src/guides.js"]);
  ok(ISO.test(own || "") && pageLastmod("/guides/agent-hosts") === own && own <= mod, `a guide is dated by its own entry, no later than the guides module (${own}, module ${mod})`);
}
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
// --- a module every pack page renders moves every pack page's date ----------
// A pack page is its own entry plus text shared by all of them
// (PACK_PAGE_MODULES). A later change to a listed module dates every pack
// page; an earlier one, or a listed module the table does not hold (not on
// disk in this tree), changes nothing. Nothing outside /skills/<slug> moves.
{
  const shared = PACK_PAGE_MODULES[0];
  ok(PACK_PAGE_MODULES.includes("src/skill-page-copy.js") && PACK_PAGE_MODULES.every((f) => /^src\/[a-z0-9-]+\.js$/.test(f)), `the pack pages list their shared modules (${PACK_PAGE_MODULES.join(", ")})`);
  const fixture = (extra) => ({
    files: { "src/skills.js": "2026-06-01", "src/packs.js": "2026-05-01", "src/guides.js": "2026-03-01", "src/tools/k.js": "2026-02-01", ...extra },
    entries: { "/skills/alpha": { published: "2026-01-10", modified: "2026-04-01" }, "/guides/alpha": { published: "2026-01-10", modified: "2026-03-01" } },
    toolSources: { beta: "src/tools/k.js" },
    packSources: { beta: "src/packs.js" },
  });
  _setPageDatesTable(fixture({}));
  ok(pageLastmod("/skills/alpha") === "2026-04-01" && pageLastmod("/skills/beta") === "2026-05-01" && pageLastmod("/skills/gamma") === "2026-06-01", "seam: with the shared module absent from the table, each pack page keeps its own date");
  _setPageDatesTable(fixture({ [shared]: "2026-07-15" }));
  ok(pageLastmod("/skills/alpha") === "2026-07-15" && pageLastmod("/skills/beta") === "2026-07-15" && pageLastmod("/skills/gamma") === "2026-07-15", `seam: a later change to the shared module dates every pack page (${pageLastmod("/skills/alpha")}, ${pageLastmod("/skills/beta")}, ${pageLastmod("/skills/gamma")})`);
  ok(articleDates("/skills/alpha").dateModified === "2026-07-15" && articleDates("/skills/alpha").datePublished === "2026-01-10", "seam: the pack page's stated modified date moves with it, its published date does not");
  ok(pageLastmod("/guides/alpha") === "2026-03-01" && pageLastmod("/tools/beta") === "2026-02-01" && pageLastmod("/skills") === "2026-06-01", "seam: a guide, a tool page and the pack index are not dated by the pack pages' shared module");
  _setPageDatesTable(fixture({ [shared]: "2026-03-15" }));
  ok(pageLastmod("/skills/alpha") === "2026-04-01" && pageLastmod("/skills/beta") === "2026-05-01", "seam: a shared module older than a pack's own change never moves its date back");
  _setPageDatesTable(fixture({ [shared]: "not-a-date" }));
  ok(pageLastmod("/skills/alpha") === "2026-04-01", "seam: an undated shared module is skipped, it never undates a pack page");
  _setPageDatesTable(null);
  // The generator dates a listed module that is on disk and skips one that is not.
  ok(JSON.stringify(presentModules(["src/skills.js", "src/no-such-module-for-this-test.js"])) === JSON.stringify(["src/skills.js"]), "the generator keeps a listed module that exists and skips a missing one");
  const { table, missing } = buildTable();
  ok(PACK_PAGE_MODULES.every((f) => !missing.includes(f)) && presentModules().every((f) => ISO.test(table.files[f] || "")) && PACK_PAGE_MODULES.filter((f) => !presentModules().includes(f)).every((f) => !(f in table.files)), `a listed module is dated when present and left out, without failing the build, when absent (present: ${presentModules().join(", ") || "none"})`);
}

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
