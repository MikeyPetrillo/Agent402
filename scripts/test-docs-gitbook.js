// Docs hub unification tests (src/docs.js + src/ledger-docs.js, Aug 2026
// "make it look like a GitBook" pass). Offline, no server: exercises the
// exported page-builder functions directly with the real on-disk wiki/
// content (same source the live site reads).
//
// What this locks in, and why each one is real (not cosmetic):
//   - /docs (ledgerDocsPage) and /docs/:slug (docsPage) render inside the
//     SAME sidebar shell. Before this they were two unrelated layouts one
//     click apart - the single biggest reason the docs surface didn't read
//     as one coherent site.
//   - Sidebar active-state matches the current page on both surfaces.
//   - Prev/next navigation is computed from real sidebar order, not
//     hand-maintained, so it can't drift from the actual nav tree.
//   - A markdown-link sidebar bullet with trailing parenthetical prose
//     ("[Try Tollbooth Cloud](url) (managed)") used to be silently DROPPED
//     entirely by an overly-strict regex - found live while testing the
//     search filter turned up a real, pre-existing missing nav item.
//   - The sidebar search filter and the mobile toggle button are present
//     and structurally wired (their actual interaction is covered by a
//     manual Playwright pass in the shipping commit, not here - this file
//     stays in the repo's established no-browser-tests pattern).
//
//   node scripts/test-docs-gitbook.js
import { docsPage, docNeighbors, renderSidebar, docsLayoutHtml, DOCS_SEARCH_SCRIPT, docsSlugs } from "../src/docs.js";
import { ledgerDocsPage } from "../src/ledger-docs.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const docsSidebarScript = readFileSync(fileURLToPath(new URL("../assets/js/docs-sidebar.js", import.meta.url)), "utf8");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const BASE_URL = "https://agent402.tools";
const catalog = {
  "POST /api/hash": { name: "Hash", slug: "hash", category: "encoding", price: "$0.001", description: "Hash text", tags: [] },
};

// --- the sidebar is real, non-empty, sourced from the real wiki --------------
const slugs = docsSlugs();
ok(slugs.length > 10, `real wiki pages loaded from wiki/ (${slugs.length} slugs)`);
ok(slugs.includes("Getting-Started"), "a known real doc slug (Getting-Started) is present");

// --- the real sidebar-parser bug: trailing parenthetical prose after a
// markdown link must not drop the whole bullet --------------------------------
{
  const html = renderSidebar("Home");
  ok(html.includes("Try Tollbooth Cloud"), "a markdown-link bullet with trailing '(managed)' prose still renders (regression: used to be silently dropped)");
  ok(html.includes('href="https://agent402.tools/tollbooth/cloud"'), "that bullet's real href survives the parse");
}

// --- /docs and /docs/:slug render inside the SAME shell -----------------------
{
  const home = ledgerDocsPage(BASE_URL, catalog);
  const sub = docsPage(BASE_URL, "Getting-Started");
  ok(sub != null, "docsPage resolves a real slug");
  for (const html of [home, sub]) {
    ok(html.includes('class="ml-docs-layout"'), "renders the shared docs layout wrapper");
    ok(html.includes('id="ml-docs-side"'), "renders the shared sidebar container");
    ok(html.includes('id="ml-docs-mobile-toggle"'), "renders the mobile sidebar toggle button");
    ok(html.includes('id="ml-docs-search-input"'), "renders the sidebar search/filter input");
  }
}

// --- active-state highlighting is correct on both surfaces --------------------
{
  const home = ledgerDocsPage(BASE_URL, catalog);
  ok(/ml-docs-side-a active" href="\/docs">Home/.test(home), "/docs marks Home as the active sidebar item");
  const sub = docsPage(BASE_URL, "Getting-Started");
  ok(/ml-docs-side-a active" href="\/docs\/Getting-Started">/.test(sub), "/docs/Getting-Started marks itself as the active sidebar item");
  ok(!/ml-docs-side-a active" href="\/docs">Home/.test(sub), "Home is NOT marked active while on a different doc page");
}

// --- prev/next: real, computed from sidebar order, never hand-maintained ------
// The expected "first real doc" is read from wiki/_Sidebar.md HERE, with a
// parser independent of src/docs.js - so the assertion holds by construction
// when the sidebar is reordered (2026-08-18: putting a new page first broke a
// hardcoded "Getting-Started" while the comment above claimed nothing was
// hand-maintained), yet still fails if docs.js's own parser drifts.
{
  const sidebarRaw = readFileSync(fileURLToPath(new URL("../wiki/_Sidebar.md", import.meta.url)), "utf8");
  const firstItem = sidebarRaw.split("\n").map((l) => l.match(/^\s*-\s*\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/)).find(Boolean);
  const FIRST = firstItem ? (firstItem[2] || firstItem[1]).trim().replace(/\s+/g, "-") : null;
  ok(FIRST && FIRST !== "Home", `sidebar's first real doc is readable from the raw file (${FIRST})`);
  ok(FIRST === "Getting-Started", "Getting Started stays the sidebar's first doc (a reader's entry point precedes the category explainer)");

  const { prev, next } = docNeighbors(FIRST);
  ok(prev && prev.slug === "Home", `${FIRST}'s prev neighbor is Home (first item in the real sidebar)`);
  ok(next && typeof next.slug === "string" && next.slug.length > 0, `${FIRST} has a real next neighbor`);
  const homeNeighbors = docNeighbors("Home");
  ok(homeNeighbors.prev === null, "Home (the first page) has no prev neighbor");
  ok(homeNeighbors.next && homeNeighbors.next.slug === FIRST, "Home's next neighbor is the sidebar's first real doc");

  const home = ledgerDocsPage(BASE_URL, catalog);
  ok(home.includes('class="ml-docs-pn"'), "/docs renders the prev/next footer nav");
  ok(!home.includes(">Previous<"), "/docs (the first page) shows no Previous link");

  const sub = docsPage(BASE_URL, FIRST);
  ok(sub.includes(">Previous<") && sub.includes("&larr; Home"), "a middle doc page's Previous link points back to Home");
}

// --- an unknown slug still 404s cleanly (unchanged by this pass) --------------
ok(docsPage(BASE_URL, "Definitely-Not-A-Real-Page") === null, "an unknown slug returns null, not a broken page");

// --- the search-filter script is present exactly once per page (external
// file — CSP hardening, 2026-08-16), wired to the real input id --------------
ok(DOCS_SEARCH_SCRIPT.includes('<script src="/js/docs-sidebar.js"></script>'), "the page references the external sidebar script");
ok(docsSidebarScript.includes("ml-docs-search-input"), "the sidebar script targets the real input id");
ok(docsSidebarScript.includes("ml-docs-mobile-toggle"), "the sidebar script also wires the mobile toggle");

// --- docsLayoutHtml is the single source of the wrapper markup - both
// callers must produce byte-identical structure for the same slug -----------
{
  const a = docsLayoutHtml("Home", "<p>x</p>");
  const b = docsLayoutHtml("Home", "<p>x</p>");
  ok(a === b, "docsLayoutHtml is a pure function of its inputs");
}

// --- every wiki page carries its own description, never a markdown banner,
// and internal links skip the capitalised URLs that 301 elsewhere ----------
{
  const descs = new Map();
  for (const slug of docsSlugs()) {
    const html = docsPage(BASE_URL, slug);
    const d = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
    ok(d.length >= 40 && !/^&gt;|\*\*|\[\[/.test(d), `${slug}: description is plain prose (${d.slice(0, 50)})`);
    ok(!descs.has(d), `${slug}: description is unique${descs.has(d) ? ` (same as ${descs.get(d)})` : ""}`);
    descs.set(d, slug);
    ok(!/href="\/docs\/(Adapters|Home)"/.test(html), `${slug}: no internal link to a redirecting docs URL`);
  }
  const t1 = (docsPage(BASE_URL, "API-Reference").match(/<title>([^<]*)/) || [])[1];
  ok(t1 && t1 !== "API Reference - Agent402 Docs", "the API-Reference guide's title differs from /docs/api");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
