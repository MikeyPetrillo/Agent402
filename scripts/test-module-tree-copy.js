// A suite that edits a module in a copy of the tree makes that copy with
// scripts/lib/tree-copy.js, and the copy holds every path a module in src/
// reads by a relative URL. Before the helper, two suites copied src/, scripts/
// and package.json by hand, and both failed at import the day a module in
// src/ began to read a file under assets/.
//
// Checked here:
//   - every "../<path>" a module in src/ builds a URL from is under a path on
//     the helper's list (a new directory read from src/ is added there),
//   - no suite copies src/ on its own,
//   - a copy made by the helper imports the brand mark, and one with assets/
//     left out fails at import with an error that names the file,
//   - the helper refuses, by name, a tree that lacks a listed path.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { MODULE_TREE, copyModuleTree } from "./lib/tree-copy.js";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".js") || e.name.endsWith(".mjs") ? [join(d, e.name)] : []));
const listed = (rel) => MODULE_TREE.some((p) => rel === p || rel.startsWith(`${p}/`));

// ---- every path src/ reaches outside itself is on the list ---------------------
const outside = new Map();
for (const file of walk(join(ROOT, "src"))) {
  const depth = file.slice(join(ROOT, "src").length + 1).split("/").length; // 1 for src/x.js, 2 for src/tools/x.js
  const up = "../".repeat(depth);
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/new URL\(\s*(["'`])((?:\.\.\/)+)([^"'`$]*)/g)) {
    if (m[2] !== up) continue; // a path inside src/
    const rel = m[3].replace(/\/+$/, "");
    if (!rel || rel === "src" || rel.startsWith("src/")) continue;
    if (!outside.has(rel)) outside.set(rel, file.slice(ROOT.length + 1));
  }
}
const unlisted = [...outside].filter(([rel]) => !listed(rel)).map(([rel, file]) => `${rel} (${file})`);
// Not copied, each for its reason: read when a request asks for it, behind
// its own missing-file answer, never when the module is imported.
const ON_REQUEST = new Set([
  "wiki", "docs", // the /docs pages' source, read per render
  "tessdata",     // the OCR language data (tens of megabytes), a path handed to the OCR workers
]);
const notCopied = unlisted.filter((u) => !ON_REQUEST.has(u.split(" ")[0].split("/")[0]));
ok(outside.size >= 5 && [...outside.keys()].some((r) => r.startsWith("assets/brand/")), `src/ is read for the paths it reaches outside itself (${outside.size} found)`);
ok(notCopied.length === 0, `every path a module in src/ reads by a relative URL is under the copy's list, or listed here as read on request only (${notCopied.join("; ") || MODULE_TREE.join(", ")})`);

// ---- no suite copies src/ on its own -------------------------------------------
const own = [];
for (const file of walk(join(ROOT, "scripts"))) {
  const rel = file.slice(ROOT.length + 1);
  if (rel === "scripts/lib/tree-copy.js" || rel === "scripts/test-module-tree-copy.js") continue;
  const text = readFileSync(file, "utf8");
  if (/cpSync\(\s*(SRC\b|join\([^)]*["']src["']\s*\)|[^,]*["'`][^"'`]*\/src["'`])/.test(text) || /\bcp\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+\S*\bsrc\b/.test(text)) own.push(rel);
}
ok(own.length === 0, `no suite copies src/ by hand: the copy is made by scripts/lib/tree-copy.js (${own.join(", ") || "none"})`);

// ---- the copy imports what reads assets/; without assets/ the error names the file
const dir = mkdtempSync(join(tmpdir(), "a402-tree-copy-"));
try {
  const copy = copyModuleTree(ROOT, join(dir, "copy"));
  const probe = (root) => spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(join(root, "src", "brand-mark.js")).href)}); console.log(m.LOGO_SVG.startsWith("<svg") ? "mark" : "no mark");`], { encoding: "utf8", timeout: 60_000 });
  const whole = probe(copy);
  ok(whole.status === 0 && whole.stdout.trim() === "mark", `a copy made by the helper imports the brand mark (exit ${whole.status})`);
  // The copy the two suites used to make: src/, scripts/ and package.json only.
  const bare = join(dir, "bare");
  mkdirSync(bare);
  cpSync(join(copy, "src"), join(bare, "src"), { recursive: true }); // from the copy: the rule above reads the working tree's own suites
  writeFileSync(join(bare, "package.json"), readFileSync(join(ROOT, "package.json")));
  const without = probe(bare);
  ok(without.status !== 0 && /assets\/brand\/logo\.svg/.test(without.stderr) && /brand mark/.test(without.stderr), `with assets/ left out the import fails and the error names the file and what reads it (exit ${without.status}: ${(without.stderr.split("\n").find((l) => /brand mark/.test(l)) || without.stderr.split("\n")[0] || "").trim().slice(0, 160)})`);
  let refusal = "";
  try { copyModuleTree(bare, join(dir, "from-bare")); } catch (e) { refusal = String(e.message); }
  ok(/assets is missing/.test(refusal) || /scripts is missing/.test(refusal), `the helper refuses a tree that lacks a listed path, by name (${refusal.slice(0, 90)})`);
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
