#!/usr/bin/env node
// No em dash in anything shipped or shown to a model.
//
// The published packages (their `files` allowlists and every README beside
// them), the Python adapter's module, and the text a workflow writes into a
// public issue are read by buyers, by models (tool descriptions, prompts,
// error strings) and by anyone on the issue tracker. House style is a colon,
// a comma or a period where an em dash would go; this reads the shipped files
// from each package.json rather than a folder list, so a new shipped module
// is covered the day it is listed.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EM_DASH = "—";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- packages: every file the allowlist ships, plus every README beside it ----
const PACKAGE_DIRS = ["mcp", "client", "openclaw", "tollbooth", "facilitator", ...readdirSync(join(ROOT, "adapters")).map((d) => `adapters/${d}`)]
  .filter((d) => existsSync(join(ROOT, d, "package.json")) || existsSync(join(ROOT, d, "pyproject.toml")));
ok(PACKAGE_DIRS.length >= 10, `found ${PACKAGE_DIRS.length} package trees`);

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
export function shippedFiles(pkgDir) {
  const abs = join(ROOT, pkgDir);
  const files = new Set();
  const pkgPath = join(abs, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    for (const f of pkg.files || []) {
      const p = join(abs, f);
      if (!existsSync(p)) continue;
      if (statSync(p).isDirectory()) walk(p).forEach((x) => files.add(x)); else files.add(p);
    }
  }
  // A Python package ships its module directory and its README.
  if (existsSync(join(abs, "pyproject.toml"))) {
    for (const e of readdirSync(abs, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") walk(join(abs, e.name)).filter((x) => x.endsWith(".py")).forEach((x) => files.add(x));
  }
  // Every README in the tree, including deploy guides, is read by a user.
  walk(abs).filter((x) => /README\.md$/i.test(x)).forEach((x) => files.add(x));
  return [...files].sort();
}

const hits = [];
let scanned = 0;
for (const d of PACKAGE_DIRS) {
  const files = shippedFiles(d);
  ok(files.length > 0, `${d}: ${files.length} shipped file(s) resolved from its package metadata`);
  for (const f of files) {
    scanned++;
    const text = readFileSync(f, "utf8");
    text.split("\n").forEach((line, i) => { if (line.includes(EM_DASH)) hits.push(`${relative(ROOT, f)}:${i + 1}`); });
  }
}
ok(scanned >= 40, `scanned ${scanned} shipped files`);
ok(hits.length === 0, `no shipped file carries an em dash${hits.length ? `:\n    ${hits.join("\n    ")}` : ""}`);

// --- workflow issue bodies ----------------------------------------------------
// The strings a workflow hands to `gh issue create/comment/close`, directly or
// through a BODY/HEAD variable. Each is public the moment it is posted.
export function issueBodyTexts(yml) {
  const out = [];
  const grab = (re) => { for (const m of yml.matchAll(re)) out.push(m[1]); };
  grab(/--(?:body|comment)\s+"((?:[^"\\]|\\.)*)"/gs);          // --body "..."
  grab(/--(?:body|comment)\s+"\$\(printf\s+'((?:[^'\\]|\\.)*)'/gs); // --body "$(printf '...' ...)"
  grab(/\b[A-Z_]*(?:BODY|HEAD)=\s*"((?:[^"\\]|\\.)*)"/gs);        // BODY="..."
  grab(/\b[A-Z_]*(?:BODY|HEAD)=\$\(printf\s+'((?:[^'\\]|\\.)*)'/gs); // BODY=$(printf '...')
  return out;
}
{
  const control = issueBodyTexts(`gh issue create --body "one ${EM_DASH} two"\nBODY="three\n${EM_DASH} four"\nX_BODY=$(printf 'five ${EM_DASH}' "$a")`);
  ok(control.length === 3 && control.every((t) => t.includes(EM_DASH)), "control: direct, variable and printf bodies are all read");
  const wfDir = join(ROOT, ".github", "workflows");
  const bad = [];
  let bodies = 0;
  for (const f of readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x))) {
    const texts = issueBodyTexts(readFileSync(join(wfDir, f), "utf8"));
    bodies += texts.length;
    for (const t of texts) if (t.includes(EM_DASH)) bad.push(`${f}: "${t.replace(/\s+/g, " ").slice(0, 70)}"`);
  }
  ok(bodies >= 20, `read ${bodies} issue bodies across the workflows`);
  ok(bad.length === 0, `no workflow issue body carries an em dash${bad.length ? `:\n    ${bad.join("\n    ")}` : ""}`);
}

console.log(`\ntest-no-em-dash-shipped: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
