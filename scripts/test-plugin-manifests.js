#!/usr/bin/env node
// The plugin manifests registries read (.codex-plugin, .cursor-plugin) carry
// the SERVER's release version, the one the repository's release tags use.
// They carried agent402-mcp's npm version (0.13.4) beside v2.4.0 releases, so
// a registry comparing the listed version with the release history found no
// match. package.json's version is the single source; cut a release by moving
// it, and the manifests must follow in the same commit.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));

const root = read("package.json").version;
const lock = read("package-lock.json");
ok(/^\d+\.\d+\.\d+$/.test(root), `package.json carries a release version (${root})`);
ok(lock.version === root && lock.packages?.[""]?.version === root, "package-lock.json agrees with package.json");
for (const p of [".codex-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
  ok(read(p).version === root, `${p} version ${read(p).version} equals the release version ${root}`);
}
// When the checkout has tags, the newest release tag must not be AHEAD of
// package.json (a release cut without moving the version). A shallow CI
// checkout has none; the manifest checks above still hold there.
let tags = [];
try { tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).split("\n").filter(Boolean); } catch { /* not a git checkout */ }
if (tags.length) {
  const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  const newest = tags.map((t) => t.slice(1)).filter((t) => /^\d+\.\d+\.\d+$/.test(t)).sort(cmp).pop();
  ok(!newest || cmp(root, newest) >= 0, `package.json ${root} is not behind the newest release tag v${newest}`);
} else {
  console.log("note - no release tags in this checkout; tag comparison not run");
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
