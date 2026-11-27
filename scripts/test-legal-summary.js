// /privacy and /terms open with a short summary box and a jump list of their
// sections (src/legal-summary.js). The box is at most 170 words (150 until the
// box gained its closing sentence and the terms box the limits its full
// clauses state), closes by saying the full text governs, and states no
// figure (an age, a period, an amount) the full text does not; the jump
// list names every section heading of the page, and each of its links lands
// on an id the page holds. Rendered with the optional switches off and on,
// since a switch adds a section (AWS Marketplace on /terms) or a sentence.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { countWords, proseText, mainOf } from "./lib/page-words.js";

const SUMMARY_MAX = 170;
const GOVERNS = "This summary does not replace the full text below, which governs.";
// A figure a summary states: a number, alone or with its unit, or a counted
// unit in words ("one month", "one U.S. dollar"). A route name (/v1) and a
// protocol name (x402) hold a digit inside a word and are not figures.
const FIGURE = /(?<![\w/.-])\d+(?:[.,]\d+)*(?:\s+(?:days?|weeks?|months?|years?|hours?))?(?![\w-])|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(?:U\.S\.\s+dollars?|dollars?|days?|weeks?|months?|years?|hours?)\b/gi;
const norm = (t) => t.replace(/\s+/g, " ").toLowerCase();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };

const ids = (html) => new Set([...String(html).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
function legalTopFindings(html) {
  const main = mainOf(html);
  const box = /<aside class="lg-summary"[\s\S]*?<\/aside>/.exec(main)?.[0] || "";
  const nav = /<nav class="lg-toc"[\s\S]*?<\/nav>/.exec(main)?.[0] || "";
  const links = [...nav.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  const have = ids(main);
  const sections = [...main.matchAll(/<h2\b([^>]*)>/g)].map((m) => /\bid="([^"]+)"/.exec(m[1])?.[1] || null).filter((id) => id !== "lg-summary-h");
  return {
    box, nav, links,
    words: countWords(proseText(box)),
    governs: proseText(box).replace(/\s+/g, " ").trim().endsWith(GOVERNS),
    figures: [...new Set((proseText(box).match(FIGURE) || []).map(norm))],
    // A figure the summary states and the text under it does not.
    unbacked: [...new Set((proseText(box).match(FIGURE) || []).map(norm))].filter((fig) => !norm(proseText(main.replace(box, ""))).includes(fig)),
    missing: links.filter((id) => !have.has(id)),
    unlisted: sections.filter((id) => !id || !links.includes(id)),
    boxFirst: box && main.indexOf(box) < main.search(/<h2\b(?![^>]*lg-summary-h)/),
  };
}

const { privacyPage } = await import("../src/privacy.js");
const { termsPage } = await import("../src/terms.js");
const SWITCHES = ["CREDITS_SALES", "MCP_OAUTH", "WEB_BOT_AUTH", "UPSTREAM_KEY"];
const keep = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]));
for (const variant of ["off", "on"]) {
  for (const k of SWITCHES) { if (variant === "on") process.env[k] = "on"; else delete process.env[k]; }
  for (const [page, fn] of [["privacy", privacyPage], ["terms", termsPage]]) {
    const f = legalTopFindings(fn("https://agent402.tools"));
    ok(Boolean(f.box), `${page} (${variant}): the page has a summary box`);
    ok(f.boxFirst, `${page} (${variant}): the summary comes before the first section`);
    ok(f.words > 40 && f.words <= SUMMARY_MAX, `${page} (${variant}): the summary is ${f.words} words (at most ${SUMMARY_MAX})`);
    ok(f.governs, `${page} (${variant}): the summary closes by saying the full text governs`);
    ok(f.figures.length >= 2 && f.unbacked.length === 0, `${page} (${variant}): every figure in the summary is in the full text (${f.figures.join(", ")})${f.unbacked.length ? ` (not in the text: ${f.unbacked.join(", ")})` : ""}`);
    ok(!/<a [^>]*>[^<]*\([^<]*<\/a>/.test(f.nav), `${page} (${variant}): no jump-list label carries a parenthetical (a label keeps to one line on a phone)`);
    ok(f.links.length >= 8, `${page} (${variant}): the jump list has ${f.links.length} links`);
    ok(f.missing.length === 0, `${page} (${variant}): every jump-list link lands on an id on the page${f.missing.length ? ` (missing: ${f.missing.join(", ")})` : ""}`);
    ok(f.unlisted.length === 0, `${page} (${variant}): every section heading has an id and is in the jump list${f.unlisted.length ? ` (${f.unlisted.join(", ")})` : ""}`);
  }
}
for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

// Controls: a page whose anchor is gone, or whose summary runs long, is caught.
{
  const html = privacyPage("https://agent402.tools");
  const noAnchor = html.replace('<h2 id="retention">', "<h2>");
  const f = legalTopFindings(noAnchor);
  ok(f.missing.includes("retention") && f.unlisted.length === 1, "control: a section heading without its id is caught");
  const long = html.replace(/(<aside class="lg-summary"[\s\S]*?<p>)/, `$1${"word ".repeat(140)}`);
  ok(legalTopFindings(long).words > SUMMARY_MAX, "control: a summary past the bound is caught");
  const inBox = (h, a, b) => h.replace(/<aside class="lg-summary"[\s\S]*?<\/aside>/, (box) => { if (!box.includes(a)) throw new Error(`control: the summary no longer says "${a}"`); return box.replace(a, b); });
  const terms = termsPage("https://agent402.tools");
  const want = { terms: ["18", "30 days", "one u.s. dollar", "one year"], privacy: ["18", "one month"] };
  for (const [name, h] of [["terms", terms], ["privacy", html]]) {
    const figs = legalTopFindings(h).figures;
    ok(want[name].every((w) => figs.includes(w)), `control: the ${name} summary's figures are read (${figs.join(", ")})`);
  }
  ok(legalTopFindings(inBox(terms, "within one year", "within one week")).unbacked.includes("one week"), "control: a terms summary saying one week where the text says one year is caught");
  ok(legalTopFindings(inBox(html, "within one month", "within one week")).unbacked.includes("one week"), "control: a privacy summary saying one week where the text says one month is caught");
  ok(legalTopFindings(inBox(terms, "18 or older", "16 or older")).unbacked.includes("16"), "control: an age the text does not state is caught");
  ok(!legalTopFindings(inBox(terms, GOVERNS, "")).governs, "control: a summary without the governing sentence is caught");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
