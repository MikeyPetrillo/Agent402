#!/usr/bin/env node
// scripts/mutation-smoke.js counts a mutation as caught only when its suite
// exits with a number other than 0 AND names at least one failing check. A
// suite that timed out or was killed (no exit status) and one that crashed
// without a failing check are failures of their own, never a catch. Real
// child processes in a temp directory: a suite that fails a check, one that
// hangs past its timeout, one that crashes, one that passes (offline).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSuite, mutationVerdict } from "./mutation-smoke.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const dir = mkdtempSync(join(tmpdir(), "mutation-verdict-"));
try {
  mkdirSync(join(dir, "scripts"));
  const suite = (name, body) => writeFileSync(join(dir, "scripts", name), body);
  suite("fails-a-check.js", 'console.error("FAIL - a check"); process.exit(1);\n');
  suite("asserts.js", 'import assert from "node:assert/strict"; assert.equal(1, 2, "one is two");\n');
  suite("assert-fail-line.js", 'console.error("ASSERT FAIL - a check"); process.exit(1);\n');
  suite("hangs.js", "setInterval(() => {}, 1000);\n");
  suite("crashes.js", 'process.exit(3);\n');
  suite("passes.js", 'console.log("ok - fine");\n');

  const failed = runSuite("fails-a-check.js", { cwd: dir, timeoutMs: 20_000 });
  ok(failed.status === 1 && failed.fails === 1 && mutationVerdict(failed).caught, `a suite that fails a check catches the mutation (exit ${failed.status}, ${failed.fails} failing)`);
  const asserted = runSuite("asserts.js", { cwd: dir, timeoutMs: 20_000 });
  ok(asserted.status === 1 && asserted.fails > 0 && mutationVerdict(asserted).caught, `an uncaught assertion counts as a failing check (exit ${asserted.status}, ${asserted.fails} failing)`);
  const assertLine = runSuite("assert-fail-line.js", { cwd: dir, timeoutMs: 20_000 });
  ok(assertLine.fails === 1 && mutationVerdict(assertLine).caught, "an ASSERT FAIL line counts as a failing check");
  const hung = runSuite("hangs.js", { cwd: dir, timeoutMs: 800 });
  const hv = mutationVerdict(hung);
  ok(hung.status === null && hung.timedOut && !hv.caught && /timed out/.test(hv.why), `a suite that times out is not a catch (status ${hung.status}, ${hv.why})`);
  const crashed = runSuite("crashes.js", { cwd: dir, timeoutMs: 20_000 });
  const cv = mutationVerdict(crashed);
  ok(crashed.status === 3 && !cv.caught && /no failing check/.test(cv.why), `an exit with no failing check is not a catch (${cv.why})`);
  const passed = runSuite("passes.js", { cwd: dir, timeoutMs: 20_000 });
  ok(passed.status === 0 && !mutationVerdict(passed).caught, "a suite that passes misses the mutation");
  // A kill by a signal other than the timeout: no exit status, not a catch.
  const killed = mutationVerdict({ status: null, signal: "SIGKILL", timedOut: false, ms: 5, fails: 2 });
  ok(!killed.caught && /killed/.test(killed.why), `a killed suite is not a catch, whatever it printed (${killed.why})`);
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\ntest-mutation-smoke-verdict: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
