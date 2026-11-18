#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES.txt: the third-party npm packages each shipped
// artifact installs, with the license each declares, read from the committed
// lockfiles (no network, no node_modules), so the file is the same on every
// machine and changes only when a lockfile or a package manifest does.
//
//   node scripts/gen-third-party-notices.js --write   # regenerate
//   node scripts/gen-third-party-notices.js --check   # exit 1 when stale
//
// Artifacts:
//   - the server image (Dockerfile, Dockerfile.worker): `npm ci --omit=dev` of
//     the root package-lock.json, so every package not marked dev;
//   - the facilitator image: the same over facilitator/package-lock.json;
//   - agent402-mcp (npm and Dockerfile.mcp): the same over mcp/package-lock.json;
//   - every other published package: each tracked package.json not marked
//     private (git ls-files), with its declared dependencies and peer
//     dependencies, which the user's own install resolves; none bundles
//     third-party code. A private package.json with dependencies is either one
//     of the lockfile sections above or named in NOT_SHIPPED with a reason;
//   - the Python packages: each tracked pyproject.toml, its dependencies read
//     from the file.
// A package offered under a choice of licenses that includes a permissive one
// is used under the permissive one, and the file says which.
// licenseVerdict() is the policy scripts/test-third-party-notices.js applies to
// every shipped row: permissive, or listed in LICENSE_EXCEPTIONS with a reason.
// scripts/test-third-party-notices.js fails when the committed file is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = join(ROOT, "THIRD_PARTY_NOTICES.txt");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

// Licenses that carry a copyleft or source-offer condition, or none stated.
const COPYLEFT = /\b(A?GPL|LGPL|MPL|SSPL|EUPL|EPL|CDDL|OSL|CC-BY-SA)\b/i;
const PERMISSIVE = /^(MIT|MIT-0|ISC|Apache-2\.0|BSD-[23]-Clause|0BSD|Unlicense|CC0-1\.0|BlueOak-1\.0\.0|Zlib|WTFPL|PSF-2\.0)$/;

// A package whose manifest names no license, read from the license file it
// ships, keyed by exact version so a new version is read again.
const READ_FROM_LICENSE_FILE = { "exif-parser@0.1.12": "MIT" };

// A shipped package whose license is not permissive (or not stated), accepted
// by hand: "name@version": "the reason". Keyed by exact version, so a new
// version is judged again. Empty while every shipped package is permissive.
export const LICENSE_EXCEPTIONS = {};

// Private package.json files with dependencies that no shipped artifact
// installs: "directory prefix": "the reason".
export const NOT_SHIPPED = {
  ".railway": "the operator's infrastructure-as-code tooling, run locally",
  "examples/": "example projects; a user installs them from source",
  "scripts/agentkit-live": "a local proof script, not shipped in any image or package",
};

// The lockfile sections (directory of the package-lock.json).
const LOCK_DIRS = new Set(["", "facilitator", "mcp"]);

// The SPDX identifiers of a license expression, without operators.
export function licenseAtoms(lic) {
  return String(lic).replace(/[()]/g, " ").split(/\s+(?:OR|AND)\s+|\s+/).map((a) => a.trim()).filter((a) => a && !/^(OR|AND)$/.test(a));
}

// { ok, why } for one license expression. Permissive: every identifier is in
// PERMISSIVE (an exception after WITH aside), or an OR-only choice that offers
// a permissive identifier. Anything else (copyleft, source-available,
// "SEE LICENSE IN", UNLICENSED, none stated, an unknown identifier) is not.
export function licenseVerdict(lic) {
  const text = String(lic || "").trim();
  if (!text || /^(UNKNOWN|UNLICENSED)$/i.test(text) || /SEE LICENSE IN/i.test(text)) return { ok: false, why: `no usable license stated (${text || "none"})` };
  const body = text.replace(/\s+WITH\s+[A-Za-z0-9.+-]+/g, "");
  const atoms = licenseAtoms(body);
  if (atoms.length && atoms.every((a) => PERMISSIVE.test(a))) return { ok: true, why: "permissive" };
  const hasAnd = /\sAND\s/.test(body), hasOr = /\sOR\s/.test(body);
  if (hasOr && !hasAnd && atoms.some((a) => PERMISSIVE.test(a))) return { ok: true, why: "a choice that includes a permissive license" };
  return { ok: false, why: `not permissive (${text})` };
}

function licenseOf(p) {
  if (typeof p.license === "string" && p.license.trim()) return p.license.trim();
  if (p.license && typeof p.license === "object" && p.license.type) return String(p.license.type);
  return "UNKNOWN";
}

// "(MIT OR GPL-3.0-or-later)" -> "MIT" when one alternative is permissive.
function elected(lic) {
  const alts = lic.replace(/^\(|\)$/g, "").split(/\s+OR\s+/);
  if (alts.length < 2 || !COPYLEFT.test(lic)) return null;
  return alts.find((a) => PERMISSIVE.test(a.trim())) || null;
}

function lockRows(lockPath) {
  const pk = read(lockPath).packages || {};
  const rows = new Map();
  for (const [path, p] of Object.entries(pk)) {
    if (!path || p.link || p.dev) continue; // root entry, workspace links, dev-only
    const name = p.name || path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const key = `${name}@${p.version}`;
    const fromFile = READ_FROM_LICENSE_FILE[key];
    const own = licenseOf(p);
    const license = own === "UNKNOWN" && fromFile ? `${fromFile} (from its license file; the manifest names none)` : own;
    const effective = own === "UNKNOWN" && fromFile ? fromFile : own;
    if (!rows.has(key)) rows.set(key, { name, version: p.version, license, effective, optional: Boolean(p.optional || p.devOptional) });
  }
  return [...rows.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));
}

function rowLine(r, notes) {
  let lic = r.license;
  const e = elected(lic);
  if (e) { lic = `${lic}, used under ${e}`; notes.add(`${r.name}@${r.version} is offered under a choice of licenses and is used under ${e}.`); }
  if (r.license === "UNKNOWN") notes.add(`${r.name}@${r.version} declares no license in its manifest; read the license file inside the package.`);
  return `  ${r.name}@${r.version}  ${lic}${r.optional ? "  (optional, platform-specific)" : ""}`;
}

function summary(rows) {
  const n = new Map();
  for (const r of rows) n.set(r.license, (n.get(r.license) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join(", ");
}

function section(title, how, rows, notes) {
  return [
    title,
    "=".repeat(title.length),
    how,
    `Packages: ${rows.length}. Licenses: ${summary(rows)}.`,
    "",
    ...rows.map((r) => rowLine(r, notes)),
    "",
  ].join("\n");
}

// Tracked files matching a git pathspec, outside node_modules.
function tracked(spec) {
  return execFileSync("git", ["ls-files", "-z", "--", spec], { cwd: ROOT, encoding: "utf8" }).split("\0").filter((f) => f && !/(^|\/)node_modules\//.test(f)).sort();
}

// Sorts tracked package.json paths into the published packages (not private,
// outside the lockfile sections) and the private ones with dependencies that
// neither a lockfile section nor NOT_SHIPPED accounts for.
export function classifyPackages(files, readJson) {
  const published = [], unclassified = [];
  for (const f of files) {
    if (!/(^|\/)package\.json$/.test(f)) continue;
    const dir = f === "package.json" ? "" : f.slice(0, -"/package.json".length);
    if (LOCK_DIRS.has(dir)) continue;
    const p = readJson(f);
    if (p.private !== true) { published.push(dir); continue; }
    const deps = Object.keys(p.dependencies || {}).length + Object.keys(p.peerDependencies || {}).length;
    if (deps && !Object.keys(NOT_SHIPPED).some((k) => dir === k || dir.startsWith(k.endsWith("/") ? k : `${k}/`))) unclassified.push(dir);
  }
  return { published: published.sort(), unclassified: unclassified.sort() };
}

export function packageClassification() {
  return classifyPackages(tracked("*package.json"), read);
}

// Every shipped lockfile row, for the license policy.
export function shippedRows() {
  return ["package-lock.json", "facilitator/package-lock.json", "mcp/package-lock.json"].flatMap((l) => lockRows(l).map((r) => ({ ...r, lock: l })));
}

// The dependency lists of a pyproject.toml ([project] dependencies and
// optional-dependencies), read as quoted strings.
function pyDeps(file) {
  const t = readFileSync(join(ROOT, file), "utf8");
  const list = (src) => [...String(src || "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const name = (/^name\s*=\s*"([^"]+)"/m.exec(t) || [])[1] || file;
  const deps = list((/^dependencies\s*=\s*\[([^\]]*)\]/m.exec(t) || [])[1]);
  const optBlock = (/\[project\.optional-dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(t) || [])[1] || "";
  const opt = [...optBlock.matchAll(/^([A-Za-z0-9_-]+)\s*=\s*\[([^\]]*)\]/gm)].map((m) => `${m[1]}: ${list(m[2]).join(", ")}`);
  return `  ${name} (${file.replace(/\/pyproject\.toml$/, "/")})\n    dependencies: ${deps.join(", ") || "none"}\n    optional dependencies: ${opt.join("; ") || "none"}`;
}

function declared(dir) {
  const p = read(`${dir}/package.json`);
  const deps = Object.entries(p.dependencies || {}).map(([k, v]) => `${k} ${v}`);
  const peers = Object.entries(p.peerDependencies || {}).map(([k, v]) => `${k} ${v}`);
  return `  ${p.name} (${p.license})\n    dependencies: ${deps.join(", ") || "none"}\n    peer dependencies: ${peers.join(", ") || "none"}`;
}

export function buildNotices() {
  const notes = new Set();
  const parts = [
    "Agent402 third-party notices",
    "",
    "Generated by scripts/gen-third-party-notices.js from the committed lockfiles;",
    "do not edit by hand. Each package below is the work of its own authors and",
    "is used under the license it declares, shown beside it. The full license",
    "text of each ships inside the package as installed (its LICENSE file or",
    "package manifest). Copyright and licensing of Agent402 itself: see NOTICE.",
    "",
    section("Server image (Dockerfile, Dockerfile.worker)", "Installed by npm ci --omit=dev from package-lock.json.", lockRows("package-lock.json"), notes),
    section("Facilitator image (Dockerfile.facilitator)", "Installed by npm ci --omit=dev from facilitator/package-lock.json.", lockRows("facilitator/package-lock.json"), notes),
    section("agent402-mcp (npm package and Dockerfile.mcp)", "Installed by npm ci --omit=dev from mcp/package-lock.json; an npm install of the package resolves the same names within its declared ranges.", lockRows("mcp/package-lock.json"), notes),
  ];
  const { published, unclassified } = packageClassification();
  if (unclassified.length) throw new Error(`private package.json with dependencies that no section covers: ${unclassified.join(", ")} (add a lockfile section or a NOT_SHIPPED reason)`);
  const t = "Other published npm packages";
  parts.push(t, "=".repeat(t.length), "These bundle no third-party code. Their dependencies are installed by the user's own package manager under each dependency's own license.", "", ...published.map(declared), "");
  const py = "Published Python packages";
  parts.push(py, "=".repeat(py.length), "These bundle no third-party code. Their dependencies are installed by the user's pip under each dependency's own license.", "", ...tracked("*pyproject.toml").map(pyDeps), "");
  const o = "Outside npm";
  parts.push(o, "=".repeat(o.length),
    "  Fonts in assets/fonts/: SIL Open Font License 1.1; notices and texts in assets/fonts/licenses/.",
    "  Data in src/data/: see src/data/LICENSE.md (countries.json is ODbL 1.0).",
    "  OCR language data fetched at image build (scripts/fetch-tessdata.js): Apache-2.0.",
    "  The server image's base and system packages (the Debian-based Node.js image, the",
    "  Chromium build installed by Playwright, ffmpeg and gosu) are installed from their",
    "  distributions under their own licenses and run as separate programs; ffmpeg's",
    "  license is LGPL-2.1-or-later or GPL-2.0-or-later depending on its build options.",
    "");
  if (notes.size) parts.push("Notes", "=====", ...[...notes].sort().map((n) => `  ${n}`), "");
  return parts.join("\n");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const text = buildNotices();
  if (process.argv.includes("--write")) {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT}`);
  } else {
    let cur = "";
    try { cur = readFileSync(OUT, "utf8"); } catch {}
    if (cur !== text) { console.error("THIRD_PARTY_NOTICES.txt is stale: run node scripts/gen-third-party-notices.js --write"); process.exit(1); }
    console.log("THIRD_PARTY_NOTICES.txt is current");
  }
}
