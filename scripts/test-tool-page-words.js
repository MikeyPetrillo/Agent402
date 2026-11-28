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
// How a lead ends is held too (leadFaults in the same library): no lead stops
// inside an open parenthesis, bracket or quote or on "e.g."; a lead the
// template cut never stops on a number, a price or a connecting word (a closed
// list of articles, prepositions and conjunctions), and one that ends "..."
// stops where its sentence has a clause boundary. A sentence with no such
// boundary inside the budget gets a `pageSummary` whose first sentence fits.
// The run prints how many leads end "...".
// Not counted anywhere: code, tables, the figure, the breadcrumb and the h1
// (listed above). The server boots with MPP and a
// Tempo relay configured (placeholder keys, nothing is called), so each page
// carries every rail sentence production prints.
// The counting lives in scripts/lib/page-words.js (its "tool" mode).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";
import { TOOL_LEAD_MAX as LEAD_MAX, TOOL_BODY_MAX as BODY_MAX, TOOL_ABOUT_MAX_SUMMARY as ABOUT_MAX_SUMMARY, TOOL_ABOUT_MAX_DESCRIPTION as ABOUT_MAX_DESCRIPTION, aboutMaxFor, toolProseWordList as proseWords, toolPageWords } from "./lib/page-words.js";
import { leadFaults, toolPageLead, LEAD_END_WORDS } from "./lib/tool-page-lead.js";
import { PAGE_SUMMARY } from "./lib/description-limits.js";
import { TOOL_LEAD_MAX_WORDS, firstSentence } from "../src/pages.js";

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
// Controls, offline: how a lead may end.
{
  const full = 'Runs the best tool in the same call - flat $0.01 covering any tool listed at $0.005 or less, from this catalog (the top 60 pools, or more with a field) and "one more" thing; then the rest. Second sentence.';
  const f = (lead, about = full) => leadFaults(lead, about).join("|");
  ok(f("Runs the best tool in the same call - flat $0.01 covering any tool listed at $0.005...") === "number|mid-clause", `control: a lead cut on a price is a fault (${f("Runs the best tool in the same call - flat $0.01 covering any tool listed at $0.005...")})`);
  ok(f("Runs the best tool in the same call - flat $0.01 covering any tool listed at...") === "word:at|mid-clause" && f("Runs the best tool in the...") === "word:the|mid-clause", "control: a lead cut on a preposition or an article is a fault");
  ok(f("Runs the best tool in the same call - flat $0.01 covering any tool listed at $0.005 or less, from this catalog (the top 60 pools...") === "open parenthesis", "control: a lead cut inside a parenthesis is a fault");
  ok(f('Runs the best tool in the same call - flat $0.01 covering any tool listed at $0.005 or less, from this catalog (the top 60 pools, or more with a field) and "one...') === "open quote|mid-clause", "control: a lead cut inside a quote is a fault");
  ok(f("Runs the best tool in the same call - flat $0.01 covering any tool...") === "mid-clause", "control: a lead cut where its sentence has no boundary is a fault");
  ok(f("Resolve a ticker (e.g.", "to its number.") === "open parenthesis|abbreviation" && f("Reads a path, e.g.", "") === "abbreviation", "control: a lead that stops on e.g. is a fault");
  ok(f("Runs the best tool in the same call...") === "" && f("Runs the best tool in the same call - flat $0.01 covering any tool listed at $0.005 or less...") === ""
    && f("Runs the best tool in the same call - flat $0.01 covering any tool listed at $0.005 or less, from this catalog...") === ""
    && f("Runs the best tool in the same call - flat $0.01 covering any tool listed at $0.005 or less, from this catalog (the top 60 pools, or more with a field)...") === ""
    && f('Runs the best tool in the same call - flat $0.01 covering any tool listed at $0.005 or less, from this catalog (the top 60 pools, or more with a field) and "one more" thing.') === "",
  "control: a lead cut before a dash, at a comma, before or after a parenthesis, or closed at a semicolon is clean");
  {
    const wire = "Chat over x402: point the SDK (or the Agent SDK) at base_url https://example.test/v1 and pay per call, with a list (one, two) and more.";
    ok(f("Chat over x402: point the SDK (or the Agent SDK)...", wire) === "mid-clause" && f("Chat over x402: point the SDK (or the Agent SDK) at base_url https://example.test/v1 and pay per call, with a list (one, two)...", wire) === "",
      "control: a lead cut after a closing bracket where the text goes on with a preposition is a fault; one where it goes on with a conjunction is clean");
  }
  ok(f("Full-text search across every filing since 2001.", "") === "" && f("Returns the rate at which NPV = 0.", "More detail follows here.") === "", "control: a whole first sentence may end on a number");
  ok(f("Returns the rate at 0.", "Returns the rate at 0; then more.") === "number", "control: a lead closed with a period where its sentence went on is held as a cut one");
  ok(LEAD_END_WORDS.length <= 45 && new Set(LEAD_END_WORDS).size === LEAD_END_WORDS.length, `the connecting words are a small closed list (${LEAD_END_WORDS.length})`);
  ok(firstSentence("Resolve a US ticker (e.g. AAPL) to its CIK. Next.") === "Resolve a US ticker (e.g. AAPL) to its CIK." && firstSentence('Extract by path, e.g. "items[2].name". Next.') === 'Extract by path, e.g. "items[2].name".'
    && firstSentence("Reads window.renderAt(t). The tool renders it.") === "Reads window.renderAt(t)." && firstSentence("One (two. Three") === "One (two. Three.", "a first sentence does not end inside a parenthesis or on e.g.");
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
  const badEnds = [];
  let ellipsis = 0;
  for (const t of list) {
    const r = await fetch(`${srv.url}/tools/${t.slug}`);
    if (r.status !== 200) { ok(false, `/tools/${t.slug} answers 200 (got ${r.status})`); continue; }
    const html = await r.text();
    const c = toolPageWords(html);
    const { lead, about } = toolPageLead(html);
    if (!lead) ok(false, `/tools/${t.slug}: the lead is found`);
    if (lead.endsWith("...")) ellipsis++;
    const faults = leadFaults(lead, about);
    if (faults.length) badEnds.push(`${t.slug} (${faults.join(", ")}: "${lead.slice(-48)}")`);
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
  console.log(`leads ending "...": ${ellipsis} of ${counts.length}; leads with a bad ending: ${badEnds.length}`);
  if (REPORT) {
    for (const b of badEnds) console.log(`bad lead ending: ${b}`);
    for (const s of (process.env.WORDS_SLUGS || "").split(",").filter(Boolean)) console.log(JSON.stringify(counts.find((c) => c.slug === s) || { slug: s, missing: true }));
  } else {
    // Some summarized tools belong to a switched family this boot does not list.
    const readSummarized = PAGE_SUMMARY.filter((s) => counts.some((c) => c.slug === s)).length;
    ok(readSummarized >= 10, `the pages of tools with a page summary were read (${readSummarized} of ${PAGE_SUMMARY.length})`);
    ok(overAbout.length === 0, `every tool page keeps its Details paragraph to its budget (${ABOUT_MAX_SUMMARY} words with a page summary, ${ABOUT_MAX_DESCRIPTION} without; ${overAbout.length} over${overAbout.length ? `: ${overAbout.slice(0, 12).join(", ")}` : ""})`);
    ok(badEnds.length === 0, `no lead stops inside a parenthesis, bracket or quote, on e.g., or (when cut) on a number, a price, a connecting word or mid-clause (${badEnds.length}${badEnds.length ? `: ${badEnds.slice(0, 12).join("; ")}${badEnds.length > 12 ? "; ..." : ""}` : ""})`);
    ok(over.length === 0, `every tool page keeps its lead to ${LEAD_MAX} prose words and its body to ${BODY_MAX} (${over.length} over${over.length ? `: ${over.slice(0, 12).join(", ")}${over.length > 12 ? ", ..." : ""}` : ""})`);
  }
} finally {
  await srv.stop();
}
console.log(`\ntest-tool-page-words: ${passed} passed, ${failed} failed`);
process.exit(failed && !REPORT ? 1 : 0);
