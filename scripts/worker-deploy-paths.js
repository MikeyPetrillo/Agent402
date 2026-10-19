#!/usr/bin/env node
// Which changed files mean the render/media worker (agent402-worker) needs a
// new build: its image inputs (Dockerfile.worker, its Railway config, the
// entrypoint, the lockfile) and every file in worker/server.js's relative
// import closure, read from the source so a new import is covered without
// editing a list.
//
//   node scripts/worker-deploy-paths.js            prints the watched paths
//   <changed file names> | node scripts/worker-deploy-paths.js --check
//                                                  prints yes/no, exits 0
import { readFileSync, existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXED = ["Dockerfile.worker", "railway.worker.json", "docker-entrypoint.sh", "package.json", "package-lock.json"];
const DIRS = ["worker/"];

export function importClosure(entry, root = ROOT) {
  const seen = new Set(); const stack = [resolve(root, entry)];
  while (stack.length) {
    const f = stack.pop(); if (seen.has(f)) continue;
    seen.add(f);
    if (!existsSync(f)) continue;
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)["']((?:\.\.?\/)[^"']+)["']/g)) {
      stack.push(resolve(dirname(f), m[1]));
    }
    // A worker thread is started from a file path, not an import:
    // new Worker(fileURLToPath(new URL("./x-worker.js", import.meta.url))).
    // Those files run in the image too, so they are part of the closure.
    for (const m of src.matchAll(/new\s+URL\(\s*["']((?:\.\.?\/)[^"']+\.m?js)["']\s*,\s*import\.meta\.url\s*\)/g)) {
      stack.push(resolve(dirname(f), m[1]));
    }
  }
  return [...seen].map((f) => relative(root, f)).sort();
}

export function workerDeployPaths(root = ROOT) {
  return [...new Set([...FIXED, ...importClosure("worker/server.js", root)])].sort();
}

export function touchesWorker(changed, paths = workerDeployPaths()) {
  const set = new Set(paths);
  return changed.map((x) => String(x).trim()).filter(Boolean).some((f) => set.has(f) || DIRS.some((d) => f.startsWith(d)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const input = readFileSync(0, "utf8").split("\n");
    console.log(touchesWorker(input) ? "yes" : "no");
  } else {
    console.log(workerDeployPaths().join("\n"));
  }
}
