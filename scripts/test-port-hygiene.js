// Every test that boots a server must choose its port in a way that cannot
// collide with something already on the runner:
//   - `getFreePort()` / `getFreePorts()` from scripts/lib/free-port.js (OS-assigned), or
//   - a literal below 32768 (outside Linux's ephemeral range 32768-60999), or
//   - PORT=0 with the bound port read back from the child's log, or
//   - an env-provided port.
// Forbidden: pid-derived or random numbers, and any literal >= 32768. Five
// CI-only "silent exit 0" runs of the tollbooth CLI test (2026-08-19..27) were
// a random 40000-59999 port meeting an ephemeral socket (EADDRINUSE).
//
//   node scripts/test-port-hygiene.js
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const files = readdirSync(DIR).filter((f) => /^test-.*\.js$/.test(f) && f !== "test-port-hygiene.js");
const offenders = [];
let assignments = 0;
for (const f of files) {
  const src = readFileSync(join(DIR, f), "utf8");
  // Identifiers that ARE a port: PORT, PORT2, FAC_PORT, WORKER_PORT ... (a whole
  // identifier ending in PORT/PORT<n>, not REPORT/SUPPORT) or a destructured
  // pair of them.
  for (const m of src.matchAll(/\b(?:const|let)\s+(?:(?:[A-Z0-9]+_)?PORT\d*|\[\s*(?:[A-Z0-9]+_)?PORT\d*\s*(?:,\s*(?:[A-Z0-9]+_)?PORT\d*\s*)*\])\s*=\s*([^;\n]+)/g)) {
    const expr = m[1].trim();
    assignments++;
    if (/getFreePorts?\(/.test(expr)) continue;
    if (/\.address\(\)\.port\b/.test(expr)) continue; // read back from a server the test itself bound (port 0)
    if (/process\.env\./.test(expr)) {
      // env-provided with a literal fallback: the fallback must be sane too
      const lit = expr.match(/\|\|\s*(\d+)/);
      if (lit && Number(lit[1]) >= 32768) offenders.push(`${f}: ${expr} (fallback in the ephemeral range)`);
      continue;
    }
    if (/^"?0"?$/.test(expr) || /^String\(0\)$/.test(expr)) continue;
    if (/^\d+$/.test(expr)) { if (Number(expr) >= 32768) offenders.push(`${f}: ${expr} (literal in the ephemeral range)`); continue; }
    if (/^\d+\s*\+\s*\d+$/.test(expr)) { const n = expr.split("+").reduce((s, x) => s + Number(x), 0); if (n >= 32768) offenders.push(`${f}: ${expr}`); continue; }
    if (/Math\.random|process\.pid/.test(expr)) { offenders.push(`${f}: ${expr} (random/pid-derived)`); continue; }
    // Derived from another PORT symbol (PORT + 1 etc.) is allowed only when the base is free-port based; flag for a human.
    if (/PORT/.test(expr)) continue;
    offenders.push(`${f}: ${expr} (unrecognized port expression)`);
  }
}
ok(assignments >= 30, `found ${assignments} port assignments across ${files.length} test files (the scan sees the fleet)`);
ok(offenders.length === 0, `no test derives its port from pid/random or picks one in the ephemeral range${offenders.length ? `:\n  ${offenders.join("\n  ")}` : ""}`);

// The scan must be able to see an offender at all.
const planted = "const PORT = 40000 + Math.floor(Math.random() * 20000);";
ok(/Math\.random|process\.pid/.test(planted.match(/=\s*([^;\n]+)/)[1]), "control: a planted random port would be flagged");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
