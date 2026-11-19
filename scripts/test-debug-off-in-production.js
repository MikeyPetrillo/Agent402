// Debug and test switches are off on a production boot.
//   - src/test-seams.js returns nothing on a production boot (NODE_ENV or the
//     platform environment says production), whatever the variable holds;
//   - every read in src/ of a variable named *_TEST_*, *_FOR_TEST or *_DEBUG
//     goes through testSeam()/testSeamOn(), or sits behind a stricter gate on
//     the same statement (NODE_ENV === "test", FREE_MODE), or is one of the
//     listed reads whose own production check is pinned below;
//   - a planted ungated read is caught (control).
//
//   node scripts/test-debug-off-in-production.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { walk } from "./lib/env-reads.js";
import { testSeam, testSeamOn } from "../src/test-seams.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// 1. The helper.
ok(testSeamOn("X_DEBUG", { X_DEBUG: "1" }) && testSeam("X_TEST_V", { X_TEST_V: "5" }) === "5", "outside production a seam reads its value");
ok(!testSeamOn("X_DEBUG", { X_DEBUG: "1", NODE_ENV: "production" }), "NODE_ENV=production turns a seam off");
ok(testSeam("X_TEST_V", { X_TEST_V: "5", RAILWAY_ENVIRONMENT_NAME: "production" }) === "" && testSeam("X_TEST_V", { X_TEST_V: "5", RAILWAY_ENVIRONMENT: "production" }) === "", "the platform's production environment turns a seam off");
ok(!testSeamOn("X_DEBUG", { X_DEBUG: "true" }) && testSeam("UNSET", {}) === "", "testSeamOn takes exactly 1; an unset seam reads empty");

// 2. A real module on a production boot: the router worker's crash hook and the
// research debug field stay off with the variables set.
const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
  const { testSeamOn } = await import("./src/test-seams.js");
  const { isProductionEnv } = await import("./src/production-env.js");
  console.log(JSON.stringify({ prod: isProductionEnv(), debug: testSeamOn("RESEARCH_DEBUG"), hooks: testSeamOn("ROUTER_WORKER_TEST_HOOKS"), capture: testSeamOn("POSTHOG_TEST_CAPTURE") }));
`], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "production", RESEARCH_DEBUG: "1", ROUTER_WORKER_TEST_HOOKS: "1", POSTHOG_TEST_CAPTURE: "1" } });
let seen = null; try { seen = JSON.parse(child.stdout.trim().split("\n").pop()); } catch { /* checked below */ }
ok(seen && seen.prod === true && !seen.debug && !seen.hooks && !seen.capture, `a production process with every seam set reads none of them (${child.stdout.trim() || child.stderr.slice(0, 200)})`);

// 3. Every seam read in src/.
const SEAM = /(?:process\.env|\benv)(?:\.|\[\s*["'])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)/g;
const isSeamName = (n) => /(?:^|_)(?:TEST|DEBUG)(?:_|$)/.test(n);
const GATED = /NODE_ENV\s*===\s*["']test["']|FREE_MODE|testSeam/;
// Reads whose own production refusal is a few lines away, each pinned by text.
const OWN_GATE = {
  "src/mcp-loopback.js:MCP_LOOPBACK_TEST_SECRET": /const production = env\.NODE_ENV === "production" \|\| !!env\.RAILWAY_ENVIRONMENT_NAME;\s*\n\s*if \(given && !production/,
  "src/x402-hook-guard.js:X402_HOOK_FAULT_FOR_TEST": /const ENV_FAULTS = process\.env\.NODE_ENV === "test" && process\.env\.X402_HOOK_FAULT_FOR_TEST\s*\n\s*\? new Set\(String\(process\.env\.X402_HOOK_FAULT_FOR_TEST\)/,
  "src/rails.js:RAILS_TEST_GRADUATE": /if \(process\.env\.NODE_ENV === "test"\) \{\s*\n\s*const keys = String\(process\.env\.RAILS_TEST_GRADUATE/,
};
function ungatedSeamReads(file, text) {
  const out = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (/^\s*(?:\/\/|\*)/.test(line)) return;
    for (const m of line.matchAll(SEAM)) {
      if (!isSeamName(m[1])) continue;
      if (GATED.test(line)) continue;
      const key = `${file}:${m[1]}`;
      if (OWN_GATE[key] && OWN_GATE[key].test(text)) continue;
      out.push(`${key} (line ${i + 1})`);
    }
  });
  return out;
}
const offenders = [];
let reads = 0;
for (const f of walk(join(ROOT, "src"))) {
  const rel = relative(ROOT, f);
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(SEAM)) if (isSeamName(m[1])) reads++;
  offenders.push(...ungatedSeamReads(rel, text));
}
ok(reads >= 8, `the scan sees the seam reads in src/ (${reads})`);
ok(offenders.length === 0, `every *_TEST_* / *_DEBUG read in src/ is off in production (testSeam, NODE_ENV === "test", FREE_MODE, or a pinned own gate)${offenders.length ? `:\n  ${offenders.join("\n  ")}` : ""}`);
for (const [key, re] of Object.entries(OWN_GATE)) ok(re.test(readFileSync(join(ROOT, key.split(":")[0]), "utf8")), `${key}: its own production gate is still in place`);

// 4. Control: a planted ungated read is caught; a gated one is not.
ok(ungatedSeamReads("src/x.js", 'if (process.env.PLANTED_DEBUG === "1") out._debug = {};').length === 1, "control: a planted ungated debug read is caught");
ok(ungatedSeamReads("src/x.js", 'if (testSeamOn("PLANTED_DEBUG")) out._debug = {};').length === 0 && ungatedSeamReads("src/x.js", 'const t = process.env.NODE_ENV === "test" && process.env.PLANTED_TEST_X;').length === 0, "control: a read through the helper or a test-only gate passes");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
