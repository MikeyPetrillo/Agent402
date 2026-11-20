// Every package the server declares is one its code imports.
//   - each runtime dependency (dependencies, optionalDependencies) in
//     package.json is named by an import, a dynamic import or a require in
//     src/ or services/;
//   - each development dependency is named the same way in scripts/, src/,
//     services/, mcp/ or client/.
// An unimported package is installed into the image and audited for nothing;
// remove it (or import it) in the same change. Controls prove the reader sees
// each import shape.
//
//   node scripts/test-unused-deps.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+|\bresolve\s*\(\s*)["'`]([^"'`\s]+)["'`]/g;
const packageOf = (s) => (s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]);

/** Package names a source text imports. */
function importedPackages(text) {
  const out = new Set();
  for (const m of text.matchAll(SPEC)) {
    const s = m[1];
    if (s.startsWith(".") || s.startsWith("/") || s.startsWith("node:")) continue;
    out.add(packageOf(s));
  }
  return out;
}

function treeImports(dirs) {
  const out = new Set();
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      if (f === "node_modules" || f.startsWith(".")) continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(?:c|m)?js$/.test(f)) for (const n of importedPackages(readFileSync(p, "utf8"))) out.add(n);
    }
  };
  for (const d of dirs) if (existsSync(join(ROOT, d))) walk(join(ROOT, d));
  return out;
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const runtime = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})];
const dev = Object.keys(pkg.devDependencies || {});
const runtimeUsed = treeImports(["src", "services"]);
const anyUsed = treeImports(["src", "services", "scripts", "mcp", "client"]);

ok(runtime.length >= 20 && runtimeUsed.size >= 20, `the reader sees the server's imports (${runtime.length} declared, ${runtimeUsed.size} packages imported)`);
const unusedRuntime = runtime.filter((d) => !runtimeUsed.has(d));
ok(unusedRuntime.length === 0, `every runtime dependency is imported by src/ or services/${unusedRuntime.length ? `: ${unusedRuntime.join(", ")}` : ""}`);
const unusedDev = dev.filter((d) => !anyUsed.has(d));
ok(unusedDev.length === 0, `every development dependency is imported somewhere in the repository${unusedDev.length ? `: ${unusedDev.join(", ")}` : ""}`);

// Controls.
const planted = importedPackages([
  'import a from "pkg-a";',
  'import { b } from "@scope/pkg-b/sub/path.js";',
  'const c = await import("pkg-c");',
  'const d = require("pkg-d");',
  'import "pkg-e/side-effect.js";',
  'import x from "./local.js"; import y from "node:fs";',
].join("\n"));
ok(["pkg-a", "@scope/pkg-b", "pkg-c", "pkg-d", "pkg-e"].every((n) => planted.has(n)) && planted.size === 5, `control: every import shape is read, relative and node: specifiers are not packages (${[...planted].join(", ")})`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
