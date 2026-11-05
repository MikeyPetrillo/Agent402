// CHANGELOG.md and the /changelog page (src/changelog.js) tell one story:
//   - no item appears twice in src/changelog.js (anywhere in the file);
//   - from PARITY_FROM on, every dated group is in both files: the same dates,
//     the same number of groups per date, and each group (in file order within
//     its date) carries the same number of items. Wording may differ (the page
//     is one line per item, the markdown wraps and backquotes); an item in one
//     file and not the other changes a count.
// Groups dated before PARITY_FROM predate this check and are not compared.
//
//   node scripts/test-changelog-parity.js [CHANGELOG.md] [src/changelog.js]
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const PARITY_FROM = "2026-11-05";
const mdPath = resolve(process.argv[2] || `${ROOT}/CHANGELOG.md`);
const jsPath = resolve(process.argv[3] || `${ROOT}/src/changelog.js`);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// CHANGELOG.md: a group is a "### YYYY-MM-DD ..." heading; its items are the
// lines that start with "- " until the next heading.
function mdGroups(text) {
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const h = /^### (\d{4}-\d{2}-\d{2})\b/.exec(line);
    if (h) { cur = { date: h[1], items: [], head: line.slice(4) }; out.push(cur); continue; }
    if (/^#{1,3} /.test(line)) { cur = null; continue; }
    if (cur && /^- /.test(line)) cur.items.push(line.slice(2));
    else if (cur && /^\s+\S/.test(line) && cur.items.length) cur.items[cur.items.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

const md = mdGroups(readFileSync(mdPath, "utf8"));
const { CHANGELOG_ENTRIES: js } = await import(pathToFileURL(jsPath).href);
ok(Array.isArray(js) && js.length > 0 && md.length > 0, `both files parse (${md.length} markdown groups, ${js?.length} page entries)`);

// 1. No duplicated item on the page.
const seen = new Map();
const dups = [];
for (const e of js) for (const item of e.items || []) {
  const k = String(item).trim();
  if (seen.has(k)) dups.push(`${e.date}: "${k.slice(0, 80)}" (also ${seen.get(k)})`);
  else seen.set(k, e.date);
}
ok(dups.length === 0, `no item appears twice in src/changelog.js${dups.length ? `: ${dups.join("; ")}` : ""}`);
const mdDups = [];
for (const g of md) {
  const s = new Set();
  for (const i of g.items) { if (s.has(i)) mdDups.push(`${g.date}: "${i.slice(0, 80)}"`); s.add(i); }
}
ok(mdDups.length === 0, `no item appears twice in one CHANGELOG.md group${mdDups.length ? `: ${mdDups.join("; ")}` : ""}`);

// 2. Dated groups from PARITY_FROM on pair up, with equal item counts.
const byDate = (groups, itemsOf) => {
  const m = new Map();
  for (const g of groups) {
    if (!(g.date >= PARITY_FROM)) continue;
    if (!m.has(g.date)) m.set(g.date, []);
    m.get(g.date).push(itemsOf(g).length);
  }
  return m;
};
const mdBy = byDate(md, (g) => g.items);
const jsBy = byDate(js, (e) => e.items || []);
ok(mdBy.size > 0 && jsBy.size > 0, `groups dated ${PARITY_FROM} or later exist in both files (${mdBy.size} and ${jsBy.size} dates)`);
for (const date of [...new Set([...mdBy.keys(), ...jsBy.keys()])].sort().reverse()) {
  const a = mdBy.get(date), b = jsBy.get(date);
  if (!a || !b) { ok(false, `${date}: a dated group is in ${a ? "CHANGELOG.md" : "src/changelog.js"} only`); continue; }
  ok(a.length === b.length, `${date}: ${a.length} group(s) in CHANGELOG.md, ${b.length} in src/changelog.js`);
  ok(JSON.stringify(a) === JSON.stringify(b), `${date}: item counts per group match (CHANGELOG.md ${a.join(",")}; src/changelog.js ${b.join(",")})`);
}

console.log(`\ntest-changelog-parity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
