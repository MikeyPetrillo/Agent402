// A changelog entry about something a switch sells reads that switch: the
// /changelog page and /changelog.xml show it only while the switch is on,
// and CHANGELOG.md scopes its text to a server that sets it.
//   - /api/transcribe-long (TRANSCRIBE_LONG=on, src/tools/stt-kit.js
//     sttLongEnabled) has an entry, and that entry carries the switch;
//   - with the switch unset (and with a junk value) neither surface names
//     the route; with it on, both do;
//   - every item that names a switched route sits in an entry that reads
//     the switch, so a later item cannot sell it unconditionally;
//   - the markdown item names the switch.
//
//   node scripts/test-changelog-switched.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

delete process.env.TRANSCRIBE_LONG;
const { CHANGELOG_ENTRIES, changelogPage, changelogRss } = await import("../src/changelog.js");
const { sttLongEnabled } = await import("../src/tools/stt-kit.js");

// Each switched route and the switch function that sells it.
const SWITCHED = [{ route: "/api/transcribe-long", env: "TRANSCRIBE_LONG", on: "on", fn: sttLongEnabled }];

for (const s of SWITCHED) {
  const entries = CHANGELOG_ENTRIES.filter((e) => e.items.some((i) => i.includes(s.route)));
  ok(entries.length > 0, `the changelog has an entry for ${s.route}`);
  ok(entries.every((e) => e.shownWhen === s.fn), `every entry that names ${s.route} is shown only while ${s.env} is on (shownWhen)`);
  ok(entries.every((e) => e.items.filter((i) => i.includes(s.route)).every((i) => i.includes(`${s.env}=${s.on}`))), `each item that names ${s.route} names the switch, so CHANGELOG.md reads true with it off`);

  const render = () => ({ page: changelogPage("https://example.test"), rss: changelogRss("https://example.test") });
  for (const v of [undefined, "", "off", "yes"]) {
    if (v === undefined) delete process.env[s.env]; else process.env[s.env] = v;
    const { page, rss } = render();
    ok(!page.includes(s.route) && !rss.includes(s.route), `${s.env}=${v === undefined ? "(unset)" : JSON.stringify(v)}: /changelog and /changelog.xml do not name ${s.route}`);
  }
  process.env[s.env] = s.on;
  const { page, rss } = render();
  ok(page.includes(s.route) && rss.includes(s.route), `${s.env}=${s.on}: /changelog and /changelog.xml name ${s.route}`);
  delete process.env[s.env];
}

// The markdown carries the same item, scoped to the switch.
const md = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
for (const s of SWITCHED) {
  const at = md.indexOf(s.route);
  ok(at >= 0, `CHANGELOG.md has the ${s.route} item`);
  const para = at >= 0 ? md.slice(md.lastIndexOf("\n- ", at), md.indexOf("\n- ", at + 1)) : "";
  ok(para.replace(/\s+/g, " ").includes(`${s.env}=${s.on}`), `the CHANGELOG.md item names ${s.env}=${s.on}`);
}

// Control: an entry with no switch is always shown.
ok(CHANGELOG_ENTRIES.some((e) => !e.shownWhen) && changelogPage("https://example.test").includes(CHANGELOG_ENTRIES.find((e) => !e.shownWhen).title.replace(/&/g, "&amp;").replace(/'/g, "&#39;").slice(0, 20)), "control: an entry without a switch renders");

console.log(`\ntest-changelog-switched: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
