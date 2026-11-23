#!/usr/bin/env node
// Every browser script the site serves from assets/ parses. A script that
// does not parse runs none of its page: /credits/thanks carried a spliced
// line for weeks and would have shown no key after a paid purchase. Offline,
// no server: each file is handed to `node --check`.
//
//   node scripts/test-browser-scripts-parse.js
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

function walk(dir) {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.m?js$/.test(n) ? [p] : []; });
}
const files = walk(join(ROOT, "assets"));
ok(files.length >= 20, `found the served browser scripts (${files.length})`);
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  ok(r.status === 0, `${relative(ROOT, f)} parses${r.status === 0 ? "" : `: ${String(r.stderr).split("\n").find((l) => /Error/.test(l)) || r.stderr}`}`);
}
// Control: the check can fail. A spliced string is refused.
{
  const r = spawnSync(process.execPath, ["--check", "-"], { input: "(function(){ var a = 'x' b = 'y'; })();", encoding: "utf8" });
  const r2 = spawnSync(process.execPath, ["--input-type=commonjs", "--check"], { input: "(function(){ var a = 'x' b = 'y'; })();", encoding: "utf8" });
  ok(r.status !== 0 || r2.status !== 0, "control: a script with a spliced string is refused");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
