// /terms and /privacy each say "last updated <date>" and that the date marks
// the current version. /terms changed three times after its date (truth audit
// 2026-10-02) because nothing tied the date to the text. This pins a hash of
// each page's source with the date line removed: edit the text, and this test
// fails until the date is bumped AND the pin below is updated with it.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { stripScripts, stripTags } from "./lib/html-text.js";
import { createHash } from "node:crypto";

// The date follows the text a reader sees with every optional switch off: a
// paragraph shown only while a switch is on (the Circle Gateway batched
// option, the public settlement index, the direct inference upstream's
// sentence, Third parties item and location exception) moves the sha, not
// the date, until that switch ships on. The prepaid credits sales text
// (CREDITS_SALES) carries its own date instead, CREDITS_SALES_TERMS_DATE in
// src/credits-sales.js, which both pages print while sales are on and a
// checkout records: move it with any change to that text. While the public settlement index disclosure renders,
// each page prints the later of this date and FACILITATOR_PUBLIC_INDEX_SINCE
// (scripts/test-public-index-copy.js).
const PINS = {
  // The refund sentences /terms prints live in src/refund-terms.js (the
  // conformance document reads them too), so that file is hashed with it.
  // Both print the credits figures (src/credits-figures.js), so it is hashed with them.
  "src/terms.js": { date: "2026-11-23", sha: "6f7a81e4566dba1e", with: ["src/refund-terms.js", "src/credits-figures.js"] },
  "src/privacy.js": { date: "2026-11-23", sha: "5eed0ca22dfdf1a5", with: ["src/credits-figures.js"] },
};
let pass = 0, fail = 0;
const TODAY = new Date().toISOString().slice(0, 10);
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const DATE_LINE = /last updated (\d{4}-\d{2}-\d{2})\./;
export function bodyHash(src) { return createHash("sha256").update(src.replace(DATE_LINE, "last updated <date>.")).digest("hex").slice(0, 16); }

ok("2026-11-03" > "2026-11-02" && "2026-12-01" > "2026-11-30", "control: ISO dates compare as strings");
ok(bodyHash("x last updated 2026-01-01. y") === bodyHash("x last updated 2026-02-02. y") && bodyHash("x last updated 2026-01-01. y") !== bodyHash("x last updated 2026-01-01. z"),
  "control: the hash ignores the date and sees a text change");
for (const [file, pin] of Object.entries(PINS)) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const date = (src.match(DATE_LINE) || [])[1];
  ok(date === pin.date, `${file}: the page says last updated ${date}, pinned ${pin.date}`);
  // A page dated ahead of its ship day tells readers (and the sitemap's
  // lastmod) a version exists that does not: never later than today, UTC.
  ok(Boolean(date) && date <= TODAY, `${file}: last updated ${date} is not after today (${TODAY} UTC)`);
  const h = bodyHash([src, ...(pin.with || []).map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8"))].join("\n"));
  ok(h === pin.sha, `${file}: text unchanged since ${pin.date} (hash ${h}; if you changed the text, bump the date in the page and set date + sha here)`);
}
// The rendered pages, with every optional switch off and with the switches
// that add text on (credit sales, the connector sign-in, signed agent
// requests): each render's text (its date set aside) is pinned to the date it
// prints. A text change, in any variant, needs a new date: the history below
// is append-only (a new [date, hash] row with a later date), and where the
// main branch is at hand the test also reads main's history and fails when a
// row main already has was rewritten (a changed hash under an old date).
const RENDERED = {
  terms: { off: [["2026-11-23", "64501aaaf746cb55"]], on: [["2026-11-23", "446606dbdb90e38a"]] },
  privacy: { off: [["2026-11-23", "8eb5da157cfca4c9"]], on: [["2026-11-23", "3554b6aa8e5e5916"]] },
};
{
  const { termsPage } = await import("../src/terms.js");
  const { privacyPage } = await import("../src/privacy.js");
  const SWITCHES = ["CREDITS_SALES", "MCP_OAUTH", "WEB_BOT_AUTH"];
  const keep = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]));
  // The text a reader sees in the page's main content: scripts, styles, tags
  // and the shared site chrome (header, nav, footer) set aside.
  const mainText = (html) => {
    const m = /<main[\s\S]*?<\/main>/.exec(String(html));
    return stripTags(stripScripts(m ? m[0] : String(html))).replace(/\s+/g, " ").trim();
  };
  const renderHash = (html) => createHash("sha256").update(mainText(html).replace(DATE_LINE, "last updated <date>.")).digest("hex").slice(0, 16);
  for (const variant of ["off", "on"]) {
    for (const k of SWITCHES) { if (variant === "on") process.env[k] = "on"; else delete process.env[k]; }
    for (const [page, fn] of [["terms", termsPage], ["privacy", privacyPage]]) {
      const html = fn("https://agent402.tools");
      const printed = (html.match(DATE_LINE) || [])[1];
      const rows = RENDERED[page][variant];
      const last = rows.at(-1);
      const h = renderHash(html);
      ok(rows.every((r, i) => i === 0 || r[0] > rows[i - 1][0]), `${page} (${variant}): the history's dates only move forward`);
      ok(last[0] === printed && last[1] === h, `${page} (${variant}): the rendered text is the one pinned to the date it prints (prints ${printed}, hash ${h}; pinned ${last[0]} ${last[1]}). A changed text needs a new date and a new row, never a new hash under an old date`);
    }
  }
  for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  // Main's history, where git and main are at hand: every row main holds is here unchanged.
  const { execFileSync } = await import("node:child_process");
  let mainSrc = null;
  try { mainSrc = execFileSync("git", ["show", "origin/main:scripts/test-legal-dates.js"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { /* no history in this checkout */ }
  const mainRows = mainSrc && /const RENDERED = (\{[\s\S]*?\n\});/.exec(mainSrc);
  if (mainRows) {
    const main = Function(`return (${mainRows[1]});`)();
    const rewritten = [];
    for (const [page, vs] of Object.entries(main)) for (const [v, rows] of Object.entries(vs)) for (const [d, h] of rows) {
      const here = (RENDERED[page]?.[v] || []).find((r) => r[0] === d);
      if (!here || here[1] !== h) rewritten.push(`${page} ${v} ${d}`);
    }
    ok(rewritten.length === 0, `no row of main's history was rewritten or dropped${rewritten.length ? `: ${rewritten.join(", ")}` : ""}`);
  } else {
    console.log("note - main's history is not in this checkout; the append-only rows above still hold the date to the text");
  }
}
{
  const { CREDITS_SALES_TERMS_DATE } = await import("../src/credits-sales.js");
  ok(/^\d{4}-\d{2}-\d{2}$/.test(CREDITS_SALES_TERMS_DATE) && CREDITS_SALES_TERMS_DATE <= TODAY, `the credits sales text date ${CREDITS_SALES_TERMS_DATE} is a day not after today`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
