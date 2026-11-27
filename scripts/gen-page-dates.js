#!/usr/bin/env node
// Generates src/generated/page-dates.json, the table src/page-dates.js reads
// to stamp a truthful lastmod on every sitemap URL.
//
//   node scripts/gen-page-dates.js            print the table, report drift
//   node scripts/gen-page-dates.js --write    write src/generated/page-dates.json
//   node scripts/gen-page-dates.js --check    exit 1 when the committed table
//                                             disagrees with git history
//
// Three maps:
//   files        module path -> the date of the newest commit touching it
//                (a file with uncommitted changes dates today, since the
//                commit that carries it lands today)
//   toolSources  tool slug -> the file that defines it: a literal
//                `slug: "..."` in src/tools/*.js, a `slug: NAME` whose NAME is
//                a constant holding one literal, or a catalog entry written
//                inline in src/server.js (`"GET /api/x": { ... slug: "x" }`,
//                read only for slugs no kit defines); a slug defined in two
//                kits is left out and its page carries no lastmod
//   toolPatterns template slug -> the kit that builds it, for a
//                `slug: \`${tier}-gemini\`` (stored as "*-gemini"); a page
//                whose slug no exact entry names is dated by the one pattern
//                it matches
//   packSources  skill pack slug -> the pack module (src/skills.js), from the
//                literal `slug: "..."` there
// A tool's page is /tools/<slug> and a pack's is /skills/<slug>, so the two
// are scanned apart: a pack that shares a tool's name is another page, and
// never makes the tool's slug ambiguous.
//
// The production image carries no git history, so this runs where history
// exists (a checkout) and the result is committed. scripts/test-page-dates.js
// runs --check in CI with full history. A stored date one day either side of
// the history date passes the check: a table written before midnight UTC for
// a commit made after it is one day old, not wrong.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pageSourceFiles, articleSourceFiles, PACK_PAGE_MODULES } from "../src/page-dates.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "generated", "page-dates.json");
const SLUG_RE = /\bslug:\s*(?:"([a-z0-9][a-z0-9-]*)"|'([a-z0-9][a-z0-9-]*)'|`([a-z0-9][a-z0-9-]*)`)/g;
// `slug: NAME` where NAME is an upper-case constant (resolved through CONST_RE).
const SLUG_CONST_RE = /\bslug:\s*([A-Z][A-Z0-9_]*)\s*[,}\n]/g;
// A constant holding one literal slug, in any module under src/.
const CONST_RE = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:"([a-z0-9][a-z0-9-]*)"|'([a-z0-9][a-z0-9-]*)')\s*;/g;
// `slug: \`prefix-${x}-suffix\`` with one placeholder: a slug built from a template.
const SLUG_TEMPLATE_RE = /\bslug:\s*`([a-z0-9-]*)\$\{[^}`]+\}([a-z0-9-]*)`/g;
// An inline catalog entry in the server module: the route key, then the
// entry's own fields up to its slug with no nested object between them.
const INLINE_ENTRY_RE = /"(?:GET|POST|PUT|PATCH|DELETE) \/[^"\n]+":\s*\{[^{}]*?\bslug:\s*"([a-z0-9][a-z0-9-]*)"/g;
/** The module whose inline catalog entries define tools no kit defines. */
export const CATALOG_FILE = "src/server.js";

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const today = () => new Date().toISOString().slice(0, 10);

export function isShallow() {
  try { return git("rev-parse", "--is-shallow-repository") === "true"; } catch { return false; }
}

/** Files git sees as changed or untracked (they date today, not their last commit). */
function dirtyFiles() {
  const out = new Set();
  let text = "";
  try { text = git("status", "--porcelain", "--untracked-files=all"); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const path = line.slice(3).split(" -> ").pop().trim();
    out.add(path);
  }
  return out;
}

/** The module that defines every skill pack. */
export const PACK_FILE = "src/skills.js";

function kitFiles() {
  return readdirSync(join(ROOT, "src", "tools")).filter((f) => f.endsWith(".js")).map((f) => `src/tools/${f}`).sort();
}
/** Every file a tool or pack page is dated by. */
function toolFiles() {
  return [...kitFiles(), PACK_FILE, CATALOG_FILE].sort();
}

/** NAME -> literal for every upper-case constant under src/ that holds one
 *  slug-shaped literal; a name given two different values is left out. */
function slugConstants() {
  const seen = new Map();
  const dirs = ["src", "src/tools"];
  for (const dir of dirs) {
    for (const f of readdirSync(join(ROOT, dir)).filter((n) => n.endsWith(".js"))) {
      const text = readFileSync(join(ROOT, dir, f), "utf8");
      for (const m of text.matchAll(CONST_RE)) {
        const v = m[2] || m[3];
        if (!seen.has(m[1])) seen.set(m[1], new Set());
        seen.get(m[1]).add(v);
      }
    }
  }
  return new Map([...seen].filter(([, vals]) => vals.size === 1).map(([k, vals]) => [k, [...vals][0]]));
}

/** The literal slugs a file's text defines or names. */
function literalSlugs(text) {
  return [...text.matchAll(SLUG_RE)].map((m) => m[1] || m[2] || m[3]);
}

/** toolSources: slug -> kit for every literal slug defined in one kit file. A
 *  slug named in several kits (a bundle step, a feedback or attest reference)
 *  belongs to the one that also names its route, `/api/<slug>`; still
 *  ambiguous, it is left out. packSources: slug -> the pack module, for every
 *  literal slug there. The pack module is not a kit, so a pack's name is never
 *  a candidate for a tool's slug. */
export function scanToolSources(files = kitFiles(), packFile = PACK_FILE, catalogFile = CATALOG_FILE) {
  const owners = new Map();
  const texts = new Map();
  const constants = slugConstants();
  const patternOwners = new Map();
  for (const file of files) {
    if (file === packFile || file === catalogFile) continue;
    const text = readFileSync(join(ROOT, file), "utf8");
    texts.set(file, text);
    const named = [...literalSlugs(text), ...[...text.matchAll(SLUG_CONST_RE)].map((m) => constants.get(m[1])).filter(Boolean)];
    for (const slug of named) {
      if (!owners.has(slug)) owners.set(slug, new Set());
      owners.get(slug).add(file);
    }
    for (const m of text.matchAll(SLUG_TEMPLATE_RE)) {
      if (!m[1] && !m[2]) continue; // a bare `${x}` says nothing about the slug
      const pattern = `${m[1]}*${m[2]}`;
      if (!patternOwners.has(pattern)) patternOwners.set(pattern, new Set());
      patternOwners.get(pattern).add(file);
    }
  }
  // Inline entries in the catalog module, for the slugs no kit defines.
  const inline = new Set();
  if (catalogFile && existsSync(join(ROOT, catalogFile))) {
    for (const m of readFileSync(join(ROOT, catalogFile), "utf8").matchAll(INLINE_ENTRY_RE)) inline.add(m[1]);
  }
  for (const slug of inline) if (!owners.has(slug)) owners.set(slug, new Set([catalogFile]));
  const toolPatterns = {};
  for (const [pattern, set] of [...patternOwners].sort(([a], [b]) => a.localeCompare(b))) if (set.size === 1) toolPatterns[pattern] = [...set][0];
  const packSources = {};
  if (packFile && existsSync(join(ROOT, packFile))) {
    for (const slug of [...new Set(literalSlugs(readFileSync(join(ROOT, packFile), "utf8")))].sort()) packSources[slug] = packFile;
  }
  const out = {};
  const ambiguous = [];
  for (const [slug, set] of [...owners].sort(([a], [b]) => a.localeCompare(b))) {
    let candidates = [...set];
    if (candidates.length > 1) {
      // Slugs match [a-z0-9-], so nothing in them needs escaping.
      const routed = candidates.filter((f) => new RegExp(`/api/${slug}(?:["'\`/?]|$)`).test(texts.get(f)));
      if (routed.length) candidates = routed;
    }
    if (candidates.length === 1) out[slug] = candidates[0];
    else ambiguous.push(`${slug} (${candidates.join(", ")})`);
  }
  return { toolSources: out, packSources, toolPatterns, ambiguous };
}

// --- per-entry dates -----------------------------------------------------------
// A family module (every guide in src/guides.js, every pack in src/skills.js)
// used to date all of its pages by the module's newest commit, so one edit to
// one guide re-dated all of them. Each entry is now dated by its own text: the
// span from its `  {\n    slug: "<slug>",` line to the next entry or the end of
// the array. `modified` is the date of the newest commit that changed that span
// (today when the working tree differs from HEAD), `published` the date of the
// oldest commit that has it. A span read from history that does not match is a
// change, so a reformat dates every entry it touched, never fewer.
export const ENTRY_FAMILIES = [
  { prefix: "/blog/", file: "src/blog.js" },
  { prefix: "/guides/", file: "src/guides.js" },
  { prefix: "/learn/", file: "src/learn.js" },
  { prefix: "/integrations/", file: "src/integration-pages.js" },
  { prefix: "/skills/", file: "src/skills.js" },
];
const ENTRY_HEAD = '\n  {\n    slug: "';
/** slug -> its entry's source text, for every entry in a family module. */
export function entrySpans(text) {
  const out = new Map();
  const t = String(text || "");
  let at = t.indexOf(ENTRY_HEAD);
  while (at >= 0) {
    const slugStart = at + ENTRY_HEAD.length;
    const slugEnd = t.indexOf('"', slugStart);
    if (slugEnd < 0) break;
    const slug = t.slice(slugStart, slugEnd);
    const next = t.indexOf(ENTRY_HEAD, slugEnd);
    const arrEnd = t.indexOf("\n];", slugEnd);
    const end = [next, arrEnd].filter((i) => i >= 0).reduce((a, b) => Math.min(a, b), t.length);
    if (/^[a-z0-9][a-z0-9-]*$/.test(slug) && !out.has(slug)) out.set(slug, t.slice(at, end));
    at = next;
  }
  return out;
}
/** { "<prefix><slug>": { published, modified } } for every entry of every
 *  family, read from the file's history (newest commit first). */
export function scanEntryDates(families = ENTRY_FAMILIES, dirty = dirtyFiles()) {
  const out = {};
  for (const { prefix, file } of families) {
    if (!existsSync(join(ROOT, file))) continue;
    const current = entrySpans(readFileSync(join(ROOT, file), "utf8"));
    let log = "";
    try { log = git("log", "--no-merges", "--format=%H %cs", "--", file); } catch { log = ""; }
    const commits = log.split("\n").filter(Boolean).map((l) => { const [hash, day] = l.split(" "); return { hash, day }; });
    const versions = commits.map((c) => { try { return entrySpans(git("show", `${c.hash}:${file}`)); } catch { return new Map(); } });
    for (const [slug, span] of current) {
      let modified = null, published = null;
      // Newest first: the run of commits whose span equals today's text ends at
      // the commit that wrote it.
      if (dirty.has(file) && versions[0]?.get(slug) !== span) modified = today();
      else {
        for (let i = 0; i < commits.length && versions[i].get(slug) === span; i++) modified = commits[i].day;
      }
      for (let i = commits.length - 1; i >= 0; i--) if (versions[i].has(slug)) { published = commits[i].day; break; }
      if (!modified) modified = today();
      if (!published || published > modified) published = modified;
      out[`${prefix}${slug}`] = { published, modified };
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
/** file -> the date of the oldest commit that has it (an article's published
 *  date for a page one module renders). */
function firstDates(files) {
  const out = {};
  for (const file of files) {
    let d = "";
    try { d = git("log", "--no-merges", "--follow", "--diff-filter=A", "--format=%cs", "--", file).split("\n").filter(Boolean).pop() || ""; } catch { d = ""; }
    out[file] = d || today();
  }
  return out;
}

/** The listed modules that are on disk: a module every pack page renders is
 *  dated when it exists and skipped when it does not (PACK_PAGE_MODULES). */
export function presentModules(list = PACK_PAGE_MODULES, root = ROOT) {
  return list.filter((f) => existsSync(join(root, f)));
}

export function buildTable() {
  const files = {};
  const dirty = dirtyFiles();
  const all = [...new Set([...pageSourceFiles(), ...toolFiles(), ...presentModules()])].sort();
  const missing = [];
  for (const file of all) {
    if (!existsSync(join(ROOT, file))) { missing.push(file); continue; }
    if (dirty.has(file)) { files[file] = today(); continue; }
    let date = "";
    try { date = git("log", "-1", "--no-merges", "--format=%cs", "--", file); } catch { date = ""; }
    files[file] = date || today();
  }
  const { toolSources, packSources, toolPatterns, ambiguous } = scanToolSources();
  const entries = scanEntryDates(ENTRY_FAMILIES, dirty);
  const filesFirst = firstDates(articleSourceFiles().filter((f) => existsSync(join(ROOT, f))));
  return { table: { files, filesFirst, entries, toolSources, toolPatterns, packSources }, missing, ambiguous };
}

export function readTable() {
  try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return null; }
}

const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

/** Differences between the committed table and a fresh one. */
export function diffTables(stored, fresh) {
  const out = [];
  const sf = (stored && stored.files) || {}, ff = fresh.files;
  for (const [file, date] of Object.entries(ff)) {
    const have = sf[file];
    if (!have) { out.push(`files: ${file} missing (now ${date})`); continue; }
    if (Math.abs(dayNum(have) - dayNum(date)) > 1) out.push(`files: ${file} is ${have}, history says ${date}`);
  }
  for (const file of Object.keys(sf)) if (!(file in ff)) out.push(`files: ${file} no longer a page source`);
  const st = (stored && stored.toolSources) || {}, ft = fresh.toolSources;
  for (const [slug, file] of Object.entries(ft)) if (st[slug] !== file) out.push(`toolSources: ${slug} -> ${file} (stored ${st[slug] || "nothing"})`);
  for (const slug of Object.keys(st)) if (!(slug in ft)) out.push(`toolSources: ${slug} no longer defined by a literal slug in a kit`);
  const sq = (stored && stored.toolPatterns) || {}, fq = fresh.toolPatterns || {};
  for (const [pattern, file] of Object.entries(fq)) if (sq[pattern] !== file) out.push(`toolPatterns: ${pattern} -> ${file} (stored ${sq[pattern] || "nothing"})`);
  for (const pattern of Object.keys(sq)) if (!(pattern in fq)) out.push(`toolPatterns: ${pattern} no longer built from a template in a kit`);
  const sp = (stored && stored.packSources) || {}, fp = fresh.packSources || {};
  for (const [slug, file] of Object.entries(fp)) if (sp[slug] !== file) out.push(`packSources: ${slug} -> ${file} (stored ${sp[slug] || "nothing"})`);
  for (const slug of Object.keys(sp)) if (!(slug in fp)) out.push(`packSources: ${slug} no longer defined by a literal slug in the pack module`);
  const near = (a, b) => a && b && Math.abs(dayNum(a) - dayNum(b)) <= 1;
  const se = (stored && stored.entries) || {}, fe = fresh.entries || {};
  for (const [path, d] of Object.entries(fe)) {
    const have = se[path];
    if (!have) { out.push(`entries: ${path} missing (now ${d.modified})`); continue; }
    if (!near(have.modified, d.modified)) out.push(`entries: ${path} modified ${have.modified}, history says ${d.modified}`);
    if (!near(have.published, d.published)) out.push(`entries: ${path} published ${have.published}, history says ${d.published}`);
  }
  for (const path of Object.keys(se)) if (!(path in fe)) out.push(`entries: ${path} no longer an entry`);
  const sff = (stored && stored.filesFirst) || {}, fff = fresh.filesFirst || {};
  for (const [file, d] of Object.entries(fff)) if (!near(sff[file], d)) out.push(`filesFirst: ${file} is ${sff[file] || "missing"}, history says ${d}`);
  for (const file of Object.keys(sff)) if (!(file in fff)) out.push(`filesFirst: ${file} no longer an article source`);
  return out;
}

function serialize(table) {
  return JSON.stringify({
    note: "Generated by scripts/gen-page-dates.js; src/page-dates.js reads it for sitemap lastmod. Regenerate with --write after editing a page module or a tool kit.",
    files: table.files,
    filesFirst: table.filesFirst,
    entries: table.entries,
    toolSources: table.toolSources,
    toolPatterns: table.toolPatterns,
    packSources: table.packSources,
  }, null, 2) + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const write = process.argv.includes("--write");
  const check = process.argv.includes("--check");
  if (isShallow()) {
    console.error("gen-page-dates: this clone is shallow, so file dates would all read as the clone's head commit; fetch full history first (git fetch --unshallow)");
    process.exit(1);
  }
  const { table, missing, ambiguous } = buildTable();
  if (missing.length) { console.error(`gen-page-dates: page sources not on disk: ${missing.join(", ")}`); process.exit(1); }
  if (ambiguous.length) console.log(`tool slugs defined in more than one kit (no lastmod): ${ambiguous.join("; ")}`);
  console.log(`${Object.keys(table.files).length} files dated, ${Object.keys(table.toolSources).length} tool slugs, ${Object.keys(table.toolPatterns).length} slug patterns and ${Object.keys(table.packSources).length} pack slugs mapped`);
  if (write) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, serialize(table));
    console.log(`wrote ${OUT}`);
    process.exit(0);
  }
  const stored = readTable();
  const drift = diffTables(stored, table);
  if (!stored) console.log("no committed table yet (run with --write)");
  for (const d of drift) console.log(`  ${d}`);
  if (check && (!stored || drift.length)) {
    console.error(`gen-page-dates: src/generated/page-dates.json is stale (${drift.length} difference${drift.length === 1 ? "" : "s"}); run: node scripts/gen-page-dates.js --write`);
    process.exit(1);
  }
  console.log(drift.length ? `${drift.length} difference(s); run with --write to update` : "committed table matches history");
}
