// A copy of the module tree, for a suite that edits a module in a copy and
// imports it from there (a mutation control never touches the working tree).
//
// A module in src/ reads files beside the tree when it is imported: the brand
// mark (src/brand-mark.js reads assets/brand/logo.svg), the fonts, the scripts
// the revenue readers import, package.json. A copy that leaves one of those
// directories out cannot import the module that reads it, so every copy is
// made here, from one list: MODULE_TREE names each top-level path a src/
// module reaches by a relative URL. scripts/test-module-tree-copy.js reads
// src/ for such paths and fails when one is not on the list, and fails a
// suite that copies src/ on its own.
import { cpSync, existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/** Top-level paths a module in src/ reads by a relative URL, besides src/ itself. */
export const MODULE_TREE = Object.freeze(["src", "scripts", "assets", "mcp/package.json", "package.json"]);

/**
 * Copy the module tree under `root` into `dest` (created when absent) and
 * link `root`'s node_modules beside it. A path on the list that the working
 * tree does not hold is an error that names it: the copy could not import
 * the module that reads it, and the failure would read as that module's.
 */
export function copyModuleTree(root, dest) {
  mkdirSync(dest, { recursive: true });
  for (const rel of MODULE_TREE) {
    const from = join(root, rel);
    if (!existsSync(from)) throw new Error(`copyModuleTree: ${rel} is missing from ${root}; a module in src/ reads it when imported, so the copy cannot be made`);
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    cpSync(from, join(dest, rel), { recursive: true });
  }
  symlinkSync(realpathSync(join(root, "node_modules")), join(dest, "node_modules"));
  return dest;
}
