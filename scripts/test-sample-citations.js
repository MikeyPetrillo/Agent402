// The sample reports' citations were checked (assets/samples/_citations.json,
// applied by src/sample-reports.js):
//   - every fixture under assets/samples has a check date, on or after the day
//     it was generated, and every served sample carries it;
//   - every listed source is cited by its fixture, and an archived copy is a
//     web.archive.org address of that same source;
//   - on the served sample, a source that no longer answers is never a link:
//     it reads as an archived copy or as "source no longer available";
//   - controls: applyCitationCheck rewrites a source line and an inline link,
//     and never rewrites the original address inside its own archived copy.
// A fixture added or regenerated is checked again (re-fetch its cited URLs,
// record what no longer answers, set the date) before it ships.
//
//   node scripts/test-sample-citations.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SAMPLES, CITATIONS, applyCitationCheck } from "../src/sample-reports.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const DIR = join(ROOT, "assets", "samples");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const fixtures = Object.fromEntries(readdirSync(DIR).filter((f) => f.endsWith(".json") && !f.startsWith("_")).map((f) => [f.slice(0, -5), JSON.parse(readFileSync(join(DIR, f), "utf8"))]));
ok(Object.keys(fixtures).length >= 8, `fixtures read (${Object.keys(fixtures).length})`);

// --- every fixture was checked, after it was generated ---
for (const [product, j] of Object.entries(fixtures)) {
  const d = CITATIONS.checked?.[product];
  const at = String(j.at || j.generatedAt || "").slice(0, 10);
  ok(/^\d{4}-\d{2}-\d{2}$/.test(d || "") && (!at || d >= at), `${product}: citations checked ${d || "never"}${at ? ` (generated ${at})` : ""}`);
}
const stale = Object.keys(CITATIONS.checked || {}).filter((p) => !fixtures[p]);
ok(stale.length === 0, `every check date names a fixture that exists${stale.length ? ` (${stale.join(", ")})` : ""}`);
for (const [product, s] of Object.entries(SAMPLES)) ok(s.citationsChecked === CITATIONS.checked[product], `${product}: the served sample carries its check date`);

// --- listed sources are real, archived copies are of the same source ---
const STATUSES = new Set(["gone", "archived", "no-records"]);
for (const [product, entries] of Object.entries(CITATIONS.sources || {})) {
  const raw = fixtures[product];
  ok(!!raw, `${product}: listed sources belong to a fixture`);
  if (!raw) continue;
  const cited = `${raw.report}\n${JSON.stringify(raw.sources || [])}`;
  for (const e of entries) {
    ok(STATUSES.has(e.status) && cited.includes(e.url), `${product}: ${e.status} source is cited by the fixture (${e.url.slice(0, 60)})`);
    if (e.status === "archived") ok(/^https:\/\/web\.archive\.org\/web\/\d{14}\//.test(e.archived) && e.archived.endsWith(e.url), `${product}: the archived copy is web.archive.org's copy of that source`);
    if (e.status === "no-records") ok(typeof e.note === "string" && e.note.length > 10, `${product}: a no-records source carries its note`);
  }
}

// --- the served pages never link a source that no longer answers ---
for (const [product, s] of Object.entries(SAMPLES)) {
  for (const e of CITATIONS.sources?.[product] || []) {
    const bare = new RegExp(`(?<!web\\.archive\\.org/web/\\d+/)${e.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    if (e.status === "gone") {
      ok(!bare.test(s.report) && s.report.includes("source no longer available (checked "), `${product}: a gone source is plain text marked no longer available`);
      ok(!s.sources.some((x) => x.url === e.url), `${product}: the gone source is not a linkable source`);
    }
    if (e.status === "archived") {
      ok(!bare.test(s.report) && new RegExp(`${e.archived.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)? \\(archived copy`).test(s.report), `${product}: the source line links the archived copy and says so`);
      ok(s.sources.some((x) => x.url === e.archived && x.originalUrl === e.url), `${product}: the source list carries the archived copy and the original address`);
    }
    if (e.status === "no-records") ok(s.report.includes(`(${e.note}, checked `), `${product}: the no-records note is beside the source`);
  }
}

// --- controls ---
const A = "https://dead.example/a";
const W = `https://web.archive.org/web/20260101000000/${A}`;
const t1 = applyCitationCheck(`Body cites [the guide](${A}).\n\n[1] Guide - ${A}`, [{ n: 1, url: A }], [{ url: A, status: "archived", archived: W }], "2026-11-23");
ok(t1.report === `Body cites [the guide](${W}).\n\n[1] Guide - ${W} (archived copy: the original address no longer answers, checked 2026-11-23)`, "control: an archived source rewrites the inline link and the source line once");
ok(t1.sources[0].url === W && t1.sources[0].originalUrl === A, "control: the source list takes the archived copy");
const t2 = applyCitationCheck(`See [the guide](${A}).\n[1] Guide - ${A}`, [{ n: 1, url: A }], [{ url: A, status: "gone" }], "2026-11-23");
ok(t2.report === "See the guide (source no longer available (checked 2026-11-23; it was at dead.example/a)).\n[1] Guide - source no longer available (checked 2026-11-23; it was at dead.example/a)" && t2.sources[0].url === null, "control: a gone source becomes plain text, inline and on its source line");
const t4 = applyCitationCheck(`## Sources\n1. [Guide](${A})\n2. [Other](https://other.example/b)`, [], [{ url: A, status: "archived", archived: W }], "2026-11-23");
ok(t4.report === `## Sources\n1. [Guide](${W}) (archived copy: the original address no longer answers, checked 2026-11-23)\n2. [Other](https://other.example/b)`, "control: a numbered markdown source list is annotated after its link");
const t3 = applyCitationCheck("[1] X - https://other.example/b", [], [{ url: A, status: "gone" }], "2026-11-23");
ok(t3.report === "[1] X - https://other.example/b", "control: a source that is not cited leaves the text as it is");

console.log(`\ntest-sample-citations: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
