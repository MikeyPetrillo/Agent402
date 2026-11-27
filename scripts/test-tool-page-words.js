#!/usr/bin/env node
// Word budget of every /tools/<slug> page, as served.
//
//   node scripts/test-tool-page-words.js     (boots its own FREE_MODE server on port 0)
//   node scripts/test-tool-page-words.js --report   (prints the counts, fails nothing)
//
// "Prose" is the visible text a reader reads as sentences inside the page's own
// column (the .tp-wrap block, the shared nav and footer left out), with these
// removed first: scripts and styles, every <pre> (the code blocks), every
// <code> span (routes, field names, commands), every <table> (parameters and
// response fields), the paid-call <figure> (a step diagram), the breadcrumb
// <nav> and the <h1> (the tool's name). A word is a whitespace-separated token
// holding a letter or a digit. The same definition counts every page.
//
// Three counts per page, each with its budget, and together every prose word
// of the column:
//   lead   the prose between the <h1> and the first <h2>: 45 words.
//   body   the prose from the first <h2> to the end of the column, headings
//          included, less the Details paragraph: 250 words.
//   about  the Details paragraph (.tp-about): the tool's pageSummary, or its
//          catalog description, less the sentence the page leads with. 130
//          words for a tool with a pageSummary; for every other tool the
//          ceiling its description is held to (MAX_WORDS in
//          scripts/lib/description-limits.js, checked on the description
//          itself by scripts/test-description-length.js).
// Not counted anywhere: code, tables, the figure, the breadcrumb and the h1
// (listed above). The server boots with MPP and a
// Tempo relay configured (placeholder keys, nothing is called), so each page
// carries every rail sentence production prints.
// The counting lives in scripts/lib/tool-page-prose.js.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";
import { LEAD_MAX, BODY_MAX, ABOUT_MAX_SUMMARY, ABOUT_MAX_DESCRIPTION, aboutMaxFor, proseWords, toolPageWords } from "./lib/tool-page-prose.js";
import { PAGE_SUMMARY } from "./lib/description-limits.js";
import { TOOL_LEAD_MAX_WORDS } from "../src/pages.js";

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.error(`FAIL - ${m}`); } };
const REPORT = process.argv.includes("--report");

// Controls, offline: the definition counts sentences and leaves code out.
{
  ok(TOOL_LEAD_MAX_WORDS === LEAD_MAX, `the template sizes its lead to the budget this test holds (${TOOL_LEAD_MAX_WORDS} = ${LEAD_MAX})`);
  ok(proseWords("<p>One two three.</p><pre>a b c d</pre><code>x y</code><table><tr><td>p q</td></tr></table>").length === 3, "control: code, pre and tables are not prose");
  ok(proseWords('<nav>Home / Tools</nav><h1>Hash</h1><figure>1 2 3</figure><p>A - b</p>').length === 2, "control: the breadcrumb, the name and the figure are not prose, a lone dash is not a word");
  const page = `<div class="tp-wrap"><h1>Name</h1><p>${"w ".repeat(46)}</p><h2>Parameters</h2><p>${"v ".repeat(249)}</p><p class="tp-sub tp-about">a b c</p></div><footer>f f f</footer>`;
  const c = toolPageWords(page);
  ok(c.lead === 46 && c.body === 250 && c.about === 3, `control: lead and body split at the first h2, the description apart, the footer left out (${JSON.stringify(c)})`);
  ok(aboutMaxFor(PAGE_SUMMARY[0]) === ABOUT_MAX_SUMMARY && aboutMaxFor("hash") === ABOUT_MAX_DESCRIPTION && ABOUT_MAX_SUMMARY === 130 && ABOUT_MAX_SUMMARY < ABOUT_MAX_DESCRIPTION, `control: a tool with a page summary gets the shorter Details budget (${ABOUT_MAX_SUMMARY} against ${ABOUT_MAX_DESCRIPTION})`);
  const long = toolPageWords(`<div class="tp-wrap"><h1>N</h1><p>lead</p><h2>Details</h2><p class="tp-sub tp-about">${"d ".repeat(ABOUT_MAX_SUMMARY + 1)}</p></div>`);
  ok(long.about === ABOUT_MAX_SUMMARY + 1 && long.about > aboutMaxFor(PAGE_SUMMARY[0]) && long.about <= aboutMaxFor("hash"), "control: a Details paragraph one word over the summary budget is over for a summarized tool only");
  ok(proseWords("<p>webhook&#39;s &lt;t&gt;.&lt;body&gt; &amp; more</p>").length === 3, "control: an entity reads as the character it shows");
}

const srv = await bootServer({
  stores: "tool-page-words",
  env: {
    FREE_MODE: "true", NODE_ENV: "test", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off",
    MPP_SECRET_KEY: "test-tool-page-words-secret", TEMPO_API_KEY: "test", TEMPO_RECIPIENT_ADDRESS: "0x000000000000000000000000000000000000dEaD",
  },
});
try {
  const pricing = await (await fetch(`${srv.url}/api/pricing`)).json();
  const list = (Array.isArray(pricing) ? pricing : pricing.tools || pricing.endpoints || []).filter((t) => t.slug);
  ok(list.length >= 400, `catalog listed (${list.length})`);
  const sample = await (await fetch(`${srv.url}/tools/fx-rate`)).text();
  ok(/over x402 or MPP/.test(sample) && /Tempo push credential/.test(sample), "control: the pages carry the MPP and Tempo sentences production prints");
  const counts = [];
  const over = [];
  const overAbout = [];
  for (const t of list) {
    const r = await fetch(`${srv.url}/tools/${t.slug}`);
    if (r.status !== 200) { ok(false, `/tools/${t.slug} answers 200 (got ${r.status})`); continue; }
    const c = toolPageWords(await r.text());
    if (!c) { ok(false, `/tools/${t.slug}: the tool column is found`); continue; }
    counts.push({ slug: t.slug, ...c, total: c.lead + c.body + c.about });
    if (c.lead > LEAD_MAX || c.body > BODY_MAX) over.push(`${t.slug} (lead ${c.lead}, body ${c.body})`);
    if (c.about > aboutMaxFor(t.slug)) overAbout.push(`${t.slug} (${c.about} of ${aboutMaxFor(t.slug)})`);
  }
  const totals = counts.map((c) => c.total).sort((a, b) => a - b);
  const median = totals.length ? totals[Math.floor(totals.length / 2)] : 0;
  const leads = counts.map((c) => c.lead).sort((a, b) => a - b);
  const bodies = counts.map((c) => c.body).sort((a, b) => a - b);
  console.log(`tool pages: ${counts.length}, median prose ${median} words in all (lead median ${leads[Math.floor(leads.length / 2)]}, max ${leads.at(-1)}; body median ${bodies[Math.floor(bodies.length / 2)]}, max ${bodies.at(-1)}; all max ${totals.at(-1)})`);
  const summarized = new Set(PAGE_SUMMARY);
  const aboutMax = (pick) => counts.filter(pick).sort((a, b) => b.about - a.about)[0];
  const aS = aboutMax((c) => summarized.has(c.slug)), aD = aboutMax((c) => !summarized.has(c.slug));
  console.log(`Details paragraph: longest with a page summary ${aS?.slug} ${aS?.about} (budget ${ABOUT_MAX_SUMMARY}); longest without ${aD?.slug} ${aD?.about} (budget ${ABOUT_MAX_DESCRIPTION})`);
  if (REPORT) {
    for (const s of (process.env.WORDS_SLUGS || "").split(",").filter(Boolean)) console.log(JSON.stringify(counts.find((c) => c.slug === s) || { slug: s, missing: true }));
  } else {
    // Some summarized tools belong to a switched family this boot does not list.
    const readSummarized = PAGE_SUMMARY.filter((s) => counts.some((c) => c.slug === s)).length;
    ok(readSummarized >= 10, `the pages of tools with a page summary were read (${readSummarized} of ${PAGE_SUMMARY.length})`);
    ok(overAbout.length === 0, `every tool page keeps its Details paragraph to its budget (${ABOUT_MAX_SUMMARY} words with a page summary, ${ABOUT_MAX_DESCRIPTION} without; ${overAbout.length} over${overAbout.length ? `: ${overAbout.slice(0, 12).join(", ")}` : ""})`);
    ok(over.length === 0, `every tool page keeps its lead to ${LEAD_MAX} prose words and its body to ${BODY_MAX} (${over.length} over${over.length ? `: ${over.slice(0, 12).join(", ")}${over.length > 12 ? ", ..." : ""}` : ""})`);
  }
} finally {
  await srv.stop();
}
console.log(`\ntest-tool-page-words: ${passed} passed, ${failed} failed`);
process.exit(failed && !REPORT ? 1 : 0);
