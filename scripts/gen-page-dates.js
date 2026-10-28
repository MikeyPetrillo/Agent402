#!/usr/bin/env node
// Generates src/generated/page-dates.json, the table src/page-dates.js reads
// to stamp a truthful lastmod on every sitemap URL.
//
//   node scripts/gen-page-dates.js            print the table, report drift
//   node scripts/gen-page-dates.js --write    write src/generated/page-dates.json
//   node scripts/gen-page-dates.js --check    exit 1 when the committed table
//                                             disagrees with git history
//
// Two maps:
//   files        module path -> the date of the newest commit touching it
//                (a file with uncommitted changes dates today, since the
//                commit that carries it lands today)
//   toolSources  tool slug -> the kit file that defines it, from the literal
//                `slug: "..."` in src/tools/*.js and src/skills.js; a slug
//                built from a template, or defined in two files, is left out
//                and its page carries no lastmod
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
import { pageSourceFiles } from "../src/page-dates.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "generated", "page-dates.json");
const SLUG_RE = /\bslug:\s*(?:"([a-z0-9][a-z0-9-]*)"|'([a-z0-9][a-z0-9-]*)'|`([a-z0-9][a-z0-9-]*)`)/g;

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

function toolFiles() {
  const kits = readdirSync(join(ROOT, "src", "tools")).filter((f) => f.endsWith(".js")).map((f) => `src/tools/${f}`);
  return [...kits, "src/skills.js"].sort();
}

/** slug -> file for every literal slug defined in one kit file. A slug named
 *  in several files (a pack step, a feedback or attest reference) belongs to
 *  the one that also names its route, `/api/<slug>`; still ambiguous, it is
 *  left out. */
export function scanToolSources(files = toolFiles()) {
  const owners = new Map();
  const texts = new Map();
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    texts.set(file, text);
    for (const m of text.matchAll(SLUG_RE)) {
      const slug = m[1] || m[2] || m[3];
      if (!owners.has(slug)) owners.set(slug, new Set());
      owners.get(slug).add(file);
    }
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
  return { toolSources: out, ambiguous };
}

export function buildTable() {
  const files = {};
  const dirty = dirtyFiles();
  const all = [...new Set([...pageSourceFiles(), ...toolFiles()])].sort();
  const missing = [];
  for (const file of all) {
    if (!existsSync(join(ROOT, file))) { missing.push(file); continue; }
    if (dirty.has(file)) { files[file] = today(); continue; }
    let date = "";
    try { date = git("log", "-1", "--no-merges", "--format=%cs", "--", file); } catch { date = ""; }
    files[file] = date || today();
  }
  const { toolSources, ambiguous } = scanToolSources();
  return { table: { files, toolSources }, missing, ambiguous };
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
  for (const slug of Object.keys(st)) if (!(slug in ft)) out.push(`toolSources: ${slug} no longer defined by a literal slug`);
  return out;
}

function serialize(table) {
  return JSON.stringify({
    note: "Generated by scripts/gen-page-dates.js; src/page-dates.js reads it for sitemap lastmod. Regenerate with --write after editing a page module or a tool kit.",
    files: table.files,
    toolSources: table.toolSources,
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
  if (ambiguous.length) console.log(`slugs defined in more than one file (no lastmod): ${ambiguous.join("; ")}`);
  console.log(`${Object.keys(table.files).length} files dated, ${Object.keys(table.toolSources).length} tool slugs mapped`);
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
