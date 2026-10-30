#!/usr/bin/env node
// Which changed files mean the decide service (agent402-decide) needs a new
// build: its image inputs (the shared Dockerfile, entrypoint, start.js and
// lockfile), every file in services/decide/server.js's relative import
// closure, and the two sides of its contract with the main app: the export's
// row format (src/decide/, index-export.js among it) and the kit that calls
// it. Read from the source, so a new import is covered without editing a
// list. Tools reach it as data through the export at runtime, so a catalog
// or index change needs no decide build; only the row format does.
//
//   node scripts/decide-deploy-paths.js            prints the watched paths
//   <changed file names> | node scripts/decide-deploy-paths.js --check
//                                                  prints yes/no, exits 0
//   <gh run list JSON> | node scripts/decide-deploy-paths.js --base <run id>
//                                                  prints the diff base sha, or nothing
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importClosure, lastDeployedBase } from "./worker-deploy-paths.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXED = ["Dockerfile", ".dockerignore", "docker-entrypoint.sh", "start.js", "package.json", "package-lock.json", "src/tools/decide-kit.js"];
const DIRS = ["services/decide/", "src/decide/"];

export function decideDeployPaths(root = ROOT) {
  return [...new Set([
    ...FIXED,
    ...importClosure("services/decide/server.js", root),
  ])].sort();
}

export function touchesDecide(changed, paths = decideDeployPaths()) {
  const set = new Set(paths);
  return changed.map((x) => String(x).trim()).filter(Boolean).some((f) => set.has(f) || DIRS.some((d) => f.startsWith(d)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseAt = process.argv.indexOf("--base");
  if (baseAt >= 0) {
    let runs = null;
    try { runs = JSON.parse(readFileSync(0, "utf8")); } catch { runs = null; }
    console.log(lastDeployedBase(runs, process.argv[baseAt + 1] || ""));
  } else if (process.argv.includes("--check")) {
    const input = readFileSync(0, "utf8").split("\n");
    console.log(touchesDecide(input) ? "yes" : "no");
  } else {
    console.log(decideDeployPaths().join("\n"));
  }
}
