// The one word counter behind every page-length budget (scripts/lib/page-words.js),
// pinned mode by mode on fixed HTML: what each mode counts and leaves out
// (hidden blocks, closed and open details, code, nav, tables, entities), so a
// change to the counter shows here before it moves a budget.
//
//   node scripts/test-page-words.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import {
  MODES, mainOf, proseText, countWords, mainProseWords, wordsBeforeFirstH2,
  visiblePageWords, countVisibleWords,
  toolPageWords, toolProseWordList, TOOL_LEAD_MAX, TOOL_BODY_MAX, TOOL_ABOUT_MAX_SUMMARY, TOOL_ABOUT_MAX_DESCRIPTION, aboutMaxFor,
  fragmentProseWords, packPageProse,
} from "./lib/page-words.js";
import { MAX_WORDS, PAGE_SUMMARY } from "./lib/description-limits.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const is = (got, want, m) => ok(JSON.stringify(got) === JSON.stringify(want), `${m} (${JSON.stringify(got)})`);

ok(Object.keys(MODES).join(",") === "main,visible,tool,fragment" && Object.values(MODES).every((d) => typeof d === "string" && d.length > 20), "the module names four modes and says what each counts");

// One page, read by the two whole-page modes. Above the first h2: an h1 (2
// words), a lead (4 words and one figure), a button (2), a table (2 cells).
const PAGE = `<html><body><nav>Site nav words</nav><main id="main">
<nav class="crumb">Home / Docs</nav>
<h1>Page title</h1>
<p>Lead with 500 words here.</p>
<a class="btn">Start now</a>
<table><tr><th>fee</th><td>$0</td></tr></table>
<h2>Section one</h2>
<p>Body <code>inline code</code> text &amp; more&nbsp;words &middot; done.</p>
<pre>pre block words</pre>
<p style="display:none">styled away entirely</p>
<p aria-hidden="true">decorative only</p>
<span class="sr-only">reader only</span>
<div hidden><span>shown by script</span></div>
<aside>side note</aside>
<svg><text>chart label</text></svg>
<script>var skipped = "script words";</script>
<details><summary>More rules</summary><p>closed body words</p></details>
<details open><summary>Open one</summary><p>open body</p></details>
</main><footer>footer words here</footer></body></html>`;

// ── main: prose with optional detail closed; a word holds a letter ──────────
is(wordsBeforeFirstH2(PAGE), 8, "main: above the first h2 it counts the h1, the lead and the button, never the crumb nav, the table or the bare figure");
is(mainProseWords(PAGE), 30, "main: the body adds headings and prose, a closed details' summary, an open one whole, and text hidden by attribute or class (it reads style display:none on a paragraph only)");
ok(!/inline code|pre block|styled away|chart label|script words|closed body|fee/.test(proseText(mainOf(PAGE))), "main: code, pre, a display:none paragraph, svg, script, a closed details' body and table cells are not prose");
ok(/More rules/.test(proseText(mainOf(PAGE))) && /Open one open body/.test(proseText(mainOf(PAGE))), "main: a closed details keeps its summary and an open one is read whole");
ok(/text & more/.test(proseText(mainOf(PAGE))), "main: the entities the renderers emit are decoded before counting (&amp; here)");
// A no-break space separates words; an entity standing alone, a separator dot
// or any other token of punctuation alone is a mark, not a word; an entity
// inside a word stays part of that one word.
is(countWords(proseText("<p>a&nbsp;b</p>")), 2, "main: a no-break space separates two words");
is(countWords(proseText("<p>a&#160;b c\u00a0d</p>")), 4, "main: a numeric or literal no-break space separates words too");
is(countWords(proseText("<p>a &middot; b</p>")), 2, "main: a named mark standing alone is not a word");
is(countWords(proseText("<p>&middot; &rarr; - \u00b7 &amp; 12</p>")), 0, "main: marks, a separator dot, an ampersand and a bare figure alone make no word");
is(countWords(proseText("<p>caf&eacute; bar &#39;d&#39;</p>")), 3, "main: an entity inside a word stays part of that word");
is([countWords("100% of 299 probes"), countWords("a -> b"), countWords("x402 v2")], [2, 2, 2], "main: a word holds a letter, so a bare figure or an arrow is not one");
is(mainOf("<p>no main here</p>"), "<p>no main here</p>", "main: a page without <main> is read whole");
is(mainProseWords("<main><details><summary>Outer</summary><details open><summary>Inner</summary><p>deep words</p></details></details></main>"), 1, "main: a details nested in a closed one stays closed with it");

// ── visible: every word a reader is shown; a word holds a letter or a digit ──
{
  const v = visiblePageWords(PAGE);
  is(v.topWords, 11, "visible: above the first h2 it counts the h1, the lead with its figure, the button and both table cells");
  is(v.bodyWords, 27, "visible: the body adds headings, prose, a script-shown hidden block, a closed details' summary and an open one whole");
  ok(!/Home|Docs|Site nav/.test(v.topText) && /fee \$0/.test(v.topText.replace(/\s+/g, " ")), "visible: nav is left out and table cells are read");
  const all = visiblePageWords(PAGE.replace("<h2>Section one</h2>", "")).topText;
  ok(!/inline code|pre block|styled away|decorative|reader only|side note|chart label|script words|closed body|footer/.test(all), "visible: code, pre, display:none, aria-hidden, screen-reader-only, aside, svg, script, a closed details' body and the footer are not shown words");
  ok(/shown by script/.test(all) && /More rules/.test(all) && /Open one\s+open body/.test(all), "visible: a block served hidden for a script to show, a closed details' summary and an open details are counted");
  is([countVisibleWords("a -> b · c 500+ $0.01"), countVisibleWords("&middot; -")], [5, 1], "visible: a word holds a letter or a digit; text is counted as given");
  is(visiblePageWords("<p>no main</p>"), { topWords: 0, bodyWords: 0, topText: "" }, "visible: a page without <main> has no counted region");
  is(visiblePageWords('<main><p title="attr words">one</p><input placeholder="more attr words"><img alt="alt words"></main>').bodyWords, 1, "visible: attribute text is not on the page as words");
  is(visiblePageWords("<main><p>a &amp; b &nbsp; c &rarr; d</p></main>").bodyWords, 4, "visible: an ampersand entity is a mark, a no-break space a space, any other entity a gap");
}

// ── tool: a served tool page as lead, body and Details paragraph ────────────
{
  const TOOL = `<body><nav>Home / Tools</nav><div class="tp-wrap"><nav>Tools / Hash</nav><h1>Hash a string</h1>
<p>Lead sentence of five words.</p><figure>1 2 3 figure</figure>
<h2>Details</h2><p class="tp-sub tp-about">The tool&#39;s own &lt;text&gt; &amp; more.</p>
<p>Template body <code>code here</code> words.</p><pre>curl example</pre><table><tr><td>cell words</td></tr></table>
</div><footer>footer words</footer></body>`;
  is(toolPageWords(TOOL), { lead: 5, body: 4, about: 5 }, "tool: the lead stops at the first h2, the Details paragraph is counted apart, and nav, h1, figure, code, pre, tables and the footer are left out");
  is(toolPageWords("<main><p>not a tool page</p></main>"), null, "tool: a page without the tool column has no counts");
  is(toolProseWordList("<p>webhook&#39;s &lt;t&gt;.&lt;body&gt; &amp; more &middot; &#8212; x</p>"), ["webhook's", "<t>.<body>", "more", "x"], "tool: an entity reads as the character it shows, and a mark alone is not a word");
  is([TOOL_LEAD_MAX, TOOL_BODY_MAX, TOOL_ABOUT_MAX_SUMMARY, TOOL_ABOUT_MAX_DESCRIPTION], [45, 250, 130, MAX_WORDS], "tool: the budgets are the ones the tool page test holds");
  is([aboutMaxFor(PAGE_SUMMARY[0]), aboutMaxFor("no-such-tool")], [TOOL_ABOUT_MAX_SUMMARY, TOOL_ABOUT_MAX_DESCRIPTION], "tool: a tool with a page summary gets the shorter Details budget");
}

// ── fragment: prose of a fragment; pack pages as lead, body, attribution ────
{
  is(fragmentProseWords("<p>One two <code>three four</code> five.</p><pre>six seven</pre><table><tr><td>eight</td></tr></table><p>- &middot; nine &amp; 10</p><script>x y</script>"), 5, "fragment: code, pre, tables and scripts are dropped, an entity left over is a mark, a figure is a word");
  is(fragmentProseWords("<nav>nav words</nav><details><summary>sum</summary><p>closed body</p></details>"), 5, "fragment: it reads a fragment as given, nav and a closed details included");
  const PACK = `<h1>Pack name</h1><p class="lead">Lead of four words.</p><div class="sk-buy-route">POST /api/skill/x</div><p>Body text <code>slug</code> here.</p><p class="sk-attr">Data from a source.</p><a>All skill packs</a>`;
  is(packPageProse(PACK), { lead: 4, body: 3, attribution: 4 }, "fragment: a pack page splits into its lead, its body less the bought route and code, and the attribution counted apart");
  is(packPageProse("<h1>No back link</h1><p>x</p>"), null, "fragment: a page without the pack shape has no counts");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
