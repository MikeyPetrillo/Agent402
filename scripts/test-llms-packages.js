// /llms.txt (and /llms-full.txt) names every published npm package of this
// repository an agent framework installs: each adapter under adapters/ with a
// package.json that is not private, and the OpenClaw plugin. An adapter
// published to npm and missing from the index is one an agent never finds.
//
//   node scripts/test-llms-packages.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { llmsTxt } from "../src/seo.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const pkgs = [];
for (const d of readdirSync(join(ROOT, "adapters"))) {
  const f = join(ROOT, "adapters", d, "package.json");
  if (!existsSync(f)) continue;
  const p = JSON.parse(readFileSync(f, "utf8"));
  if (!p.private) pkgs.push(p.name);
}
const oc = JSON.parse(readFileSync(join(ROOT, "openclaw", "package.json"), "utf8"));
if (!oc.private) pkgs.push(oc.name);
ok(pkgs.length >= 10, `published framework packages read (${pkgs.length})`);

const text = llmsTxt("https://agent402.tools", {});
const missing = pkgs.filter((n) => !text.includes(`(https://www.npmjs.com/package/${n})`));
ok(missing.length === 0, `/llms.txt links every published framework package on npm${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
ok(text.length < 16_000, `/llms.txt stays a short index (${text.length} chars)`);

console.log(`\ntest-llms-packages: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
