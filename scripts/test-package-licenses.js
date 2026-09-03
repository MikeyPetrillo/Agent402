#!/usr/bin/env node
// The licensing split is DELIBERATE and must stay legible: the server is
// AGPL-3.0, every published package is MIT with its own LICENSE in its
// directory. GitHub's repository-level license API reports the root (AGPL),
// so a registry reviewer comparing npm metadata (MIT) to "the repo" sees a
// discrepancy - one did, on elizaOS registry PR #29636 (2026-09-02). This
// pins that each package's three sources agree (package.json, LICENSE file,
// README) and that the root README names every package as MIT.
import { readFileSync, existsSync } from "node:fs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

const rootPkg = JSON.parse(read("package.json"));
ok(/^AGPL-3\.0/.test(rootPkg.license || ""), `root package.json is AGPL (${rootPkg.license})`);
ok(/GNU AFFERO GENERAL PUBLIC LICENSE/.test(read("LICENSE")), "root LICENSE is the AGPL text");

const PACKAGES = ["mcp", "client", "tollbooth", "openclaw", "facilitator", "adapters/agentkit", "adapters/eliza"];
const readme = read("README.md");
for (const dir of PACKAGES) {
  const pkg = JSON.parse(read(`${dir}/package.json`));
  ok(pkg.license === "MIT", `${dir}: package.json declares MIT (${pkg.license})`);
  ok(existsSync(new URL(`${dir}/LICENSE`, root)) && /^MIT License/.test(read(`${dir}/LICENSE`)), `${dir}: ships its own MIT LICENSE file`);
  if (pkg.repository && typeof pkg.repository === "object") ok(pkg.repository.directory === dir, `${dir}: repository.directory points at its own directory (${pkg.repository.directory}), so registries link the MIT subtree`);
  if (!pkg.private && pkg.name && dir !== "facilitator") ok(readme.includes("`" + pkg.name + "`"), `root README names ${pkg.name} as an MIT package`);
  if (existsSync(new URL(`${dir}/README.md`, root))) ok(/MIT/.test(read(`${dir}/README.md`)), `${dir}/README.md states MIT`);
}
ok(/every \*\*published npm package\*\* is MIT/.test(readme), "root README states the split in one sentence a reviewer can find");
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
