// Every suite that reaches src/ (an import, or a booted src/server.js) runs on
// a stats store of its own, never the machine-wide agent402-stats.db in the
// system temp directory (scripts/lib/own-stats.js says why).
//
//   1. Static: a suite that reaches src/ has, as its FIRST import statement,
//      ./lib/offline-stores.js or ./lib/file-mode.js (both import
//      ./lib/own-stats.js) or ./lib/own-stats.js itself. A new suite without
//      one fails here. There is no baseline: every suite is on it.
//   2. A suite that boots src/server.js and spawns anything passes the
//      environment on (`...process.env`, bootServer or ownStoreEnv), so the
//      child reads the directory the pin chose.
//   3. Run: a child that imports each pin gets a fresh directory, src/stats.js
//      imported after it opens its file there, a directory the caller exported
//      is kept, and the fresh one is removed when the child exits.
//
//   node scripts/test-stats-store-hygiene.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childJson } from "./lib/child-json.js";
import { usesSrc, firstImport } from "./test-offline-stores-import.js";

const DIR = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// --- 1. the first import is a pin ------------------------------------------------
const PIN_RE = /^\s*import\s+["']\.\/lib\/(offline-stores|file-mode|own-stats)\.js["']/;
export const ownsStats = (text) => { const line = firstImport(text); return line != null && PIN_RE.test(line); };
// Static readers whose only "src/" text is the pattern they search for.
const STATIC_ONLY = new Set(["test-offline-stores-import.js"]);

ok(ownsStats(`// why\nimport "./lib/offline-stores.js";\nimport { a } from "../src/a.js";\n`), "control: the offline pin first counts");
ok(ownsStats(`import "./lib/own-stats.js"; // x\nimport { a } from "../src/a.js";\n`), "control: own-stats first counts");
ok(!ownsStats(`import { spawn } from "node:child_process";\nspawn(process.execPath, ["src/server.js"]);\n`), "control: a planted boot with no pin is seen");
ok(!ownsStats(`import { a } from "../src/stats.js";\nimport "./lib/own-stats.js";\n`), "control: a pin after a src/ import is seen");
ok(!ownsStats(`const m = await import("../src/stats.js");\n`), "control: a dynamic import with no pin is seen");

const files = readdirSync(DIR).filter((f) => /^test-.*\.(m?js)$/.test(f)).sort();
const texts = new Map(files.map((f) => [f, readFileSync(join(DIR, f), "utf8")]));
const reaching = files.filter((f) => usesSrc(texts.get(f)) && !STATIC_ONLY.has(f));
const shared = reaching.filter((f) => !ownsStats(texts.get(f)));
ok(reaching.length > 500, `read ${reaching.length} suites that reach src/ (the scan sees the fleet)`);
ok(shared.length === 0, `every suite that reaches src/ takes a stats store of its own with its first import (import "./lib/own-stats.js", or the offline pin)${shared.length ? `:\n  ${shared.join("\n  ")}` : ""}`);

// --- 2. a booting suite passes its environment on ---------------------------------
const BOOTS_SERVER = /["'`]src\/server\.js["'`]|["'`]src["'`]\s*,\s*["'`]server\.js["'`]/;
const SPAWNS = /\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(/;
const PASSES_ENV = /\.\.\.process\.env\b|\bbootServer\s*\(|\bownStoreEnv\s*\(/;
// A custom env on every spawn and none of them the server's.
const NO_SERVER_CHILD = new Set(["test-doc-snippets.js"]);
const booting = files.filter((f) => BOOTS_SERVER.test(texts.get(f)));
const dropping = booting.filter((f) => SPAWNS.test(texts.get(f)) && /\benv\s*:/.test(texts.get(f)) && !PASSES_ENV.test(texts.get(f)) && !NO_SERVER_CHILD.has(f));
ok(booting.length > 200, `read ${booting.length} suites that name src/server.js`);
ok(dropping.length === 0, `no suite that boots src/server.js builds a child environment without the caller's${dropping.length ? `:\n  ${dropping.join("\n  ")}` : ""}`);
ok(BOOTS_SERVER.test('spawn(process.execPath, [join(ROOT, "src", "server.js")])') && !PASSES_ENV.test("env: { PATH: process.env.PATH }"), "control: a boot with a bare environment would be seen");

// --- 3. the pins, run ------------------------------------------------------------
const TMP = tmpdir();
const probe = (pin, { preset, stats = false } = {}) => {
  const code = `
    await import(${JSON.stringify(new URL(`./lib/${pin}`, import.meta.url).href)});
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = process.env.STATS_DB_DIR || "";
    ${stats ? `await import(${JSON.stringify(new URL("../src/stats.js", import.meta.url).href)});` : ""}
    console.log(JSON.stringify({ dir, isDir: !!dir && existsSync(dir), file: !!dir && existsSync(join(dir, "agent402-stats.db")) }));
    process.exit(0);`;
  const env = { ...process.env, FREE_MODE: "true" };
  delete env.STATS_DB_DIR; // this suite's own pin set it; the child starts as a fresh shell would
  if (preset) env.STATS_DB_DIR = preset;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: join(DIR, ".."), env, encoding: "utf8", timeout: 120_000 });
  try { return childJson(r.stdout); } catch { return { error: `${r.status} ${String(r.stderr).slice(-400)}` }; }
};
for (const pin of ["own-stats.js", "offline-stores.js", "file-mode.js"]) {
  const a = probe(pin), b = probe(pin);
  ok(a.isDir && a.dir !== TMP && a.dir !== "/tmp" && a.dir !== "/data", `${pin}: the child reads a directory of its own (${a.error || "set"})`);
  ok(a.dir && b.dir && a.dir !== b.dir, `${pin}: two runs get two directories`);
  ok(a.dir && !existsSync(a.dir), `${pin}: the directory is removed when the process exits`);
}
{
  const s = probe("offline-stores.js", { stats: true });
  ok(s.file === true, `src/stats.js imported after the pin opens its file in that directory (${s.error || JSON.stringify(s)})`);
  const mine = mkdtempSync(join(TMP, "a402-stats-hygiene-"));
  const k = probe("own-stats.js", { preset: mine, stats: true });
  ok(k.dir === mine && k.file === true, "a directory the caller exported is kept and used");
  ok(existsSync(mine), "...and is not removed by the child that did not create it");
  rmSync(mine, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
