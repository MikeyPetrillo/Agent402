// /changelog shows the most recent entries and /changelog/archive every older
// one, so no entry leaves the site:
//   - every served entry is on exactly one of the two pages, in order: the
//     first CHANGELOG_RECENT on /changelog, the rest on the archive;
//   - /changelog links the archive and says how many entries it holds;
//   - the archive groups by month, links back, answers 200 at its route and
//     is in the sitemap with a lastmod (src/page-dates.js reads its module);
//   - the linked paths /changelog, /docs/api and /docs/api/explorer answer 200.
//
//   node scripts/test-changelog-archive.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";
import { proseWords } from "./lib/page-prose.js";

const { CHANGELOG_ENTRIES, CHANGELOG_RECENT, changelogSplit, changelogPage, changelogArchivePage } = await import("../src/changelog.js");
const { PAGE_SOURCES } = await import("../src/page-dates.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const B = "https://example.test";

const { recent, older } = changelogSplit();
const shown = CHANGELOG_ENTRIES.filter((e) => typeof e.shownWhen !== "function" || e.shownWhen());
ok(recent.length === Math.min(CHANGELOG_RECENT, shown.length) && recent.length + older.length === shown.length, `the split holds every served entry (${recent.length} recent + ${older.length} older = ${shown.length})`);
ok(older.length > 0, "control: the changelog has entries older than the recent page");

const page = changelogPage(B);
const archive = changelogArchivePage(B);
const has = (html, e) => html.includes(`>${esc(e.title)}</h2>`) || html.includes(`>${esc(e.title)}</h3>`);
const firstItem = (e) => `<li>${esc(e.items[0])}</li>`;
const onPage = shown.filter((e) => has(page, e) && page.includes(firstItem(e)));
const onArchive = shown.filter((e) => has(archive, e) && archive.includes(firstItem(e)));
ok(recent.every((e) => page.includes(firstItem(e))) && older.every((e) => !page.includes(firstItem(e))), `/changelog shows the ${recent.length} most recent entries and no older one`);
ok(older.every((e) => archive.includes(firstItem(e))), `/changelog/archive shows every older entry (${older.length})`);
ok(shown.every((e) => onPage.includes(e) || onArchive.includes(e)), `every served entry is on /changelog or its archive (${shown.length})`);
ok(page.indexOf(firstItem(recent[0])) < page.indexOf(firstItem(recent[recent.length - 1])), "the recent page keeps the entries' order");
ok(page.includes('href="/changelog/archive"') && page.includes(`The ${older.length} older ones`), "/changelog links the archive and says how many entries it holds");
const months = [...new Set(older.map((e) => e.date.slice(0, 7)))];
ok(months.every((m) => archive.includes(`id="m-${m}"`) && archive.includes(`href="#m-${m}"`) === months.length > 1), `the archive has a section and a jump link per month (${months.length})`);
ok(archive.includes('href="/changelog"') && archive.includes(`<link rel="canonical" href="${B}/changelog/archive">`), "the archive links back to /changelog and is canonical to itself");
ok(Array.isArray(PAGE_SOURCES["/changelog/archive"]) && PAGE_SOURCES["/changelog/archive"].includes("src/changelog.js"), "the archive's lastmod is read from its module (src/page-dates.js)");
const words = (html) => proseWords(html.slice(html.indexOf("<main"), html.indexOf("</main>")));
console.log(`  prose words: /changelog ${words(page)}, /changelog/archive ${words(archive)}`);

const srv = await bootServer({ env: { FREE_MODE: "true", X402_SYNC_ON_START: "false" }, stores: "changelog-archive" });
try {
  const r = await fetch(`${srv.url}/changelog/archive`);
  const body = await r.text();
  ok(r.status === 200 && body.includes(firstItem(older[0])), `GET /changelog/archive answers 200 with the older entries (got ${r.status})`);
  const mainRes = await fetch(`${srv.url}/changelog`);
  const main = await mainRes.text();
  ok(mainRes.status === 200 && main.includes(firstItem(recent[0])) && main.includes('href="/changelog/archive"'), "GET /changelog stays the recent-entries page at its path and links the archive");
  // Release bodies, CHANGELOG.md and the wiki link these paths: each still answers 200.
  for (const [path, mark] of [["/docs/api", "API Reference"], ["/docs/api/explorer", "<h1"]]) {
    const res = await fetch(`${srv.url}${path}`);
    ok(res.status === 200 && (await res.text()).includes(mark), `GET ${path} answers 200 (got ${res.status})`);
  }
  const xml = await (await fetch(`${srv.url}/sitemap.xml`)).text();
  const m = /<loc>[^<]*\/changelog\/archive<\/loc>(?:<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>)?/.exec(xml);
  ok(m && m[1], `the sitemap lists /changelog/archive with a lastmod${m ? ` (${m[1] || "none"})` : ""}`);
} finally {
  await srv.stop();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
