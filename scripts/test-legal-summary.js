// /privacy and /terms open with a short summary box and a jump list of their
// sections (src/legal-summary.js). The box is at most 150 words; the jump
// list names every section heading of the page, and each of its links lands
// on an id the page holds. Rendered with the optional switches off and on,
// since a switch adds a section (AWS Marketplace on /terms) or a sentence.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { countWords, proseText, mainOf } from "./lib/page-words.js";

const SUMMARY_MAX = 150;
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
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
