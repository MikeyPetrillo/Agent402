#!/usr/bin/env node
// CycloneDX SBOMs for the server and every published npm package, built by
// scripts/sbom.js (offline, from a lockfile, no new dependency). The deploy
// workflow's `sbom` job runs this on every push to main and uploads the
// directory as a workflow artifact; nothing it writes is committed.
//
// The server's SBOM reads the committed package-lock.json with development
// packages left out: the tree the Docker image installs (`npm ci --omit=dev`).
// A package with its own lockfile is read the same way. A package without one
// is resolved in a scratch copy of its package.json (`npm install
// --package-lock-only --ignore-scripts`: a lockfile is written, nothing is
// downloaded into node_modules and no package code runs), which is the tree a
// fresh install of that version resolves to today.
//
//   node scripts/sbom-release.js --out sbom
//   node scripts/sbom-release.js --out sbom --only server,mcp
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSbom } from "./sbom.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The directories the publish job releases from. scripts/test-sbom-ci.js
// holds this list equal to that job's `cd <dir>` lines.
export const PACKAGE_DIRS = [
  "mcp", "tollbooth", "client", "openclaw",
  "adapters/openai-tools", "adapters/anthropic-tools", "adapters/ai-sdk", "adapters/langchain",
  "adapters/openai-agents", "adapters/llamaindex", "adapters/strands", "adapters/agentkit",
  "adapters/eliza", "adapters/google-adk",
];

/** The file an SBOM is written under: the package name, a scope folded in. */
export function sbomFileName(pkgName) {
  return `${String(pkgName).replace(/^@/, "").replace(/\//g, "__")}.cdx.json`;
}

/** The lockfile text for the package at `dir` (repo-relative; "." is the server). */
export function lockTextFor(dir, { npmBin = process.platform === "win32" ? "npm.cmd" : "npm" } = {}) {
  const abs = resolve(ROOT, dir);
  for (const f of ["npm-shrinkwrap.json", "package-lock.json"]) if (existsSync(join(abs, f))) return readFileSync(join(abs, f), "utf8");
  const scratch = mkdtempSync(join(tmpdir(), "a402-sbom-"));
  try {
    copyFileSync(join(abs, "package.json"), join(scratch, "package.json"));
    const r = spawnSync(npmBin, ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--workspaces=false"], { cwd: scratch, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`npm could not resolve ${dir} (exit ${r.status}): ${(r.stderr || "").slice(-800)}`);
    return readFileSync(join(scratch, "package-lock.json"), "utf8");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const out = resolve(arg("--out") || "sbom");
  const only = arg("--only") ? new Set(arg("--only").split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const dirs = [".", ...PACKAGE_DIRS].filter((d) => !only || only.has(d === "." ? "server" : d));
  mkdirSync(out, { recursive: true });
  let failed = 0;
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
    try {
      const bom = buildSbom(lockTextFor(dir), { omitDev: true });
      if (bom.metadata.component.name !== pkg.name) throw new Error(`the lockfile names ${bom.metadata.component.name}, not ${pkg.name}`);
      const file = sbomFileName(pkg.name);
      writeFileSync(join(out, file), JSON.stringify(bom, null, 2) + "\n");
      console.log(`${pkg.name}@${pkg.version}: ${bom.components.length} components -> ${file}`);
    } catch (e) {
      failed++;
      console.error(`${pkg.name}: ${e.message}`);
    }
  }
  if (failed) { console.error(`${failed} SBOM(s) failed`); process.exit(1); }
}
