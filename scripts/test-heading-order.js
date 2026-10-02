// Heading LEVEL is structure, not size. A screen reader announces it, so h1
// straight to h3 tells a listener there is a section title they have missed and
// sends them looking for something that is not there.
//
// Three pages skipped a level, and in every case the reason was the same: a
// section with no heading at all. The fix was to name the section, which is a
// content improvement a sighted reader never sees. This pins that the fix holds
// and that a new page cannot quietly reintroduce the gap.
//
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-heading-order.js
const BASE = (process.env.TARGET_URL || "http://localhost:3000").replace(/\/$/, "");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Every page a human lands on from the nav or a link in copy.
const PAGES = ["/", "/reports", "/monitors", "/quickstart", "/pricing", "/docs", "/marketplace",
  "/leaderboard", "/revenue", "/sell", "/tools", "/why", "/proof", "/company", "/security",
  "/transparency", "/privacy", "/terms", "/faq", "/credits", "/markets", "/skills"];

// Ranges of raw-text elements, found by SCANNING rather than by pattern.
//
// Two earlier attempts here stripped script and style with a regex and CodeQL
// flagged both, correctly: `<\/script>` does not match `</script >`, which is
// legal HTML, and a strip that misses one leaves markup the extractor then
// reads as a heading. Widening the pattern did not clear it either, and that is
// the signal to stop - a regex that filters tags is the wrong instrument, and
// the same lesson landed on another test in this repo a fortnight ago.
//
// indexOf cannot be fooled by whitespace inside a closing tag, so this finds
// where those elements START and END and the extractor simply ignores headings
// that fall inside one. Nothing is rewritten, so nothing can be rewritten
// wrongly.
function rawTextRanges(html) {
  const ranges = [];
  const lower = html.toLowerCase();
  for (const tag of ["script", "style"]) {
    let from = 0;
    for (;;) {
      const open = lower.indexOf("<" + tag, from);
      if (open === -1) break;
      const openEnd = lower.indexOf(">", open);
      if (openEnd === -1) { ranges.push([open, html.length]); break; }
      const close = lower.indexOf("</" + tag, openEnd);
      // An unclosed raw-text element runs to the end of the document, which is
      // what a browser does with it too.
      const end = close === -1 ? html.length : lower.indexOf(">", close) + 1 || html.length;
      ranges.push([open, end]);
      from = end;
    }
  }
  return ranges;
}

// Visible text of a heading, by the same scanning rule as above.
//
// `replace(/<[^>]+>/g, "")` is the third regex in this file CodeQL objected to,
// and it is right that the pattern is not a tag parser. It is also the last
// place this file needs one: the result is only ever compared, measured for
// emptiness, and sliced into a failure message, never put back into a page. So
// rather than argue the exploitability, walk the string and keep what is
// outside angle brackets.
//
// It is NOT an HTML parser, and saying so matters more than the line it saves:
// a ">" inside an attribute value confuses the depth count exactly as it
// confused the regex. That does not occur in a heading on this site, and if it
// ever did the consequence is a slightly wrong excerpt in a failure message
// rather than a wrong verdict, because the LEVEL comes from the match and not
// from here.
function visibleText(fragment) {
  let out = "", depth = 0;
  for (const ch of fragment) {
    if (ch === "<") depth++;
    else if (ch === ">") { if (depth > 0) depth--; }
    else if (depth === 0) out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

const headings = (html) => {
  const ranges = rawTextRanges(html);
  const inside = (i) => ranges.some(([a2, b2]) => i >= a2 && i < b2);
  return [...html.matchAll(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi)]
    .filter((m) => !inside(m.index))
    .map((m) => ({ level: Number(m[1][1]), text: visibleText(m[2]) }));
};

// CONTROL. A sweep that has never seen a skip cannot tell "clean" from "blind",
// and this one parses HTML, which is the part most likely to be silently wrong.
{
  const planted = headings(`<h1>A</h1><p>x</p><h3>B</h3>`);
  ok(planted.length === 2 && planted[0].level === 1 && planted[1].level === 3,
    "control: the extractor reads levels out of real markup");
  let skips = 0, prev = 0;
  for (const { level } of planted) { if (prev && level > prev + 1) skips++; prev = level; }
  ok(skips === 1, "control: and the rule flags a planted h1 to h3 skip");
}

for (const path of PAGES) {
  let html;
  try { const r = await fetch(BASE + path); if (!r.ok) { ok(false, `${path} -> HTTP ${r.status}`); continue; } html = await r.text(); }
  catch (e) { ok(false, `${path} -> ${e.message}`); continue; }

  const hs = headings(html);
  ok(hs.length > 0, `${path}: has headings at all (${hs.length})`);
  const h1s = hs.filter((h) => h.level === 1);
  ok(h1s.length === 1, `${path}: exactly one h1 (${h1s.length}) - the page's own title, once`);

  const skips = [];
  let prev = 0;
  for (const { level, text } of hs) {
    if (prev && level > prev + 1) skips.push(`h${prev} -> h${level} at "${text.slice(0, 40)}"`);
    prev = level;
  }
  ok(skips.length === 0, `${path}: no skipped heading level${skips.length ? ` (${skips.join(", ")})` : ""}`);

  // A heading with no text is worse than no heading: it announces a section
  // and names nothing.
  const empty = hs.filter((h) => !h.text);
  ok(empty.length === 0, `${path}: no empty headings${empty.length ? ` (${empty.length})` : ""}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
