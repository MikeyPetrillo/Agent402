// The files a package ships, read from its package.json `files` allowlist (a
// Python package ships its module directory), plus every README in the tree:
// the set a buyer or a model actually reads, resolved from metadata rather
// than a folder list so a newly listed module is covered the day it is added.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};

/** Every package tree in the repo: the top-level packages and each adapter. */
export function packageDirs() {
  return ["mcp", "client", "openclaw", "tollbooth", "facilitator", ...readdirSync(join(ROOT, "adapters")).map((d) => `adapters/${d}`)]
    .filter((d) => existsSync(join(ROOT, d, "package.json")) || existsSync(join(ROOT, d, "pyproject.toml")));
}

/** Absolute paths of the files `pkgDir` ships, sorted. */
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
  if (existsSync(join(abs, "pyproject.toml"))) {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") walk(join(abs, e.name)).filter((x) => x.endsWith(".py")).forEach((x) => files.add(x));
    }
  }
  walk(abs).filter((x) => /README\.md$/i.test(x)).forEach((x) => files.add(x));
  return [...files].sort();
}
