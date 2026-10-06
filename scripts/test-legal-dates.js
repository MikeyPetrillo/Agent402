// /terms and /privacy each say "last updated <date>" and that the date marks
// the current version. /terms changed three times after its date (truth audit
// 2026-10-02) because nothing tied the date to the text. This pins a hash of
// each page's source with the date line removed: edit the text, and this test
// fails until the date is bumped AND the pin below is updated with it.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const PINS = {
  "src/terms.js": { date: "2026-10-06", sha: "077c696e48b1c48b" },
  "src/privacy.js": { date: "2026-10-06", sha: "0a33b73cfcff8af9" },
};
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const DATE_LINE = /last updated (\d{4}-\d{2}-\d{2})\./;
export function bodyHash(src) { return createHash("sha256").update(src.replace(DATE_LINE, "last updated <date>.")).digest("hex").slice(0, 16); }

ok(bodyHash("x last updated 2026-01-01. y") === bodyHash("x last updated 2026-02-02. y") && bodyHash("x last updated 2026-01-01. y") !== bodyHash("x last updated 2026-01-01. z"),
  "control: the hash ignores the date and sees a text change");
for (const [file, pin] of Object.entries(PINS)) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const date = (src.match(DATE_LINE) || [])[1];
  ok(date === pin.date, `${file}: the page says last updated ${date}, pinned ${pin.date}`);
  const h = bodyHash(src);
  ok(h === pin.sha, `${file}: text unchanged since ${pin.date} (hash ${h}; if you changed the text, bump the date in the page and set date + sha here)`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
