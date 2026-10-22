// A child process's JSON result is read with childJson (scripts/lib/child-json.js),
// never as "the last line": a module's own log line can land after the result,
// and a test reading the last line then fails or passes by timing.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { childJson } from "./lib/child-json.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

ok(childJson('{"uid":"0xa1","existing":true}\n')?.uid === "0xa1", "a lone result line is read");
ok(childJson('[shared-limit] redis CONNECTED\n{"uid":"0xa1"}\n[ledger-journal] redis persistence reads on\n')?.uid === "0xa1",
  "a log line after the result does not hide it (the CI failure of 2026-10-22)");
ok(childJson('{"step":1}\nnoise\n{"step":2}\n')?.step === 2, "the last JSON line wins over an earlier one");
ok(Array.isArray(childJson('[1,2]\n[shared-limit] x\n')), "an array result is read; a bracketed log line is skipped");
let threw = false; try { childJson("[pow] nothing here\n"); } catch { threw = true; }
ok(threw, "no JSON line at all throws instead of returning a guess");

// No script reads a child's JSON from its last line any more.
const fragile = /JSON\.parse\([^;]*\.split\("\\n"\)\.(pop\(\)|at\(-1\))\)/;
const offenders = readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".js") && f !== "test-child-json.js")
  .filter((f) => fragile.test(readFileSync(join(ROOT, "scripts", f), "utf8")));
ok(offenders.length === 0, `no script parses a child's last line as its JSON result (${offenders.join(", ") || "none"})`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
