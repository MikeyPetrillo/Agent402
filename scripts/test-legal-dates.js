// /terms and /privacy each say "last updated <date>" and that the date marks
// the current version. /terms changed three times after its date (truth audit
// 2026-10-02) because nothing tied the date to the text. This pins a hash of
// each page's source with the date line removed: edit the text, and this test
// fails until the date is bumped AND the pin below is updated with it.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// The date follows the text a reader sees with every optional switch off: a
// paragraph shown only while a switch is on (the Circle Gateway batched
// option, the public settlement index, the direct inference upstream's
// sentence, Third parties item and location exception) moves the sha, not
// the date, until that switch ships on. While the public settlement index disclosure renders,
// each page prints the later of this date and FACILITATOR_PUBLIC_INDEX_SINCE
// (scripts/test-public-index-copy.js).
const PINS = {
  "src/terms.js": { date: "2026-11-11", sha: "363c7b60ba990941" },
  "src/privacy.js": { date: "2026-11-11", sha: "4f049d23aecd97ff" },
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
  const h = bodyHash(src);
  ok(h === pin.sha, `${file}: text unchanged since ${pin.date} (hash ${h}; if you changed the text, bump the date in the page and set date + sha here)`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
