// The regex tool's 750 ms budget measures the regex run, not the thread start:
//   - under a worker that takes longer than the budget to start (a busy
//     runner), the published example still answers its documented matches;
//   - a catastrophic pattern still ends as a 400 (an error answer is never
//     charged) within the budget of its own run, on a normal and a slow start;
//   - a worker that never starts ends as a 503, not a hang.
//
//   node scripts/test-regex-budget.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

process.env.SLOW_REGEX_WORKER_START_MS = "1500";
const { KIT, setRegexWorkerForTest, runRegexSafely } = await import("../src/tools/kit.js");
const tool = KIT.find((t) => t.slug === "regex");
const SLOW = fileURLToPath(new URL("./fixtures/slow-start-regex-worker.js", import.meta.url));
const example = tool.discovery.input;
const want = tool.discovery.output.example;

const run = async (input) => {
  const t0 = Date.now();
  try { return { ok: true, value: await tool.handler({ ...input }), ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, err: e, ms: Date.now() - t0 }; }
};
const HOSTILE = { pattern: "(a+)+$", text: "a".repeat(9000) + "!", flags: "" };

// Normal start.
{
  const r = await run(example);
  ok(r.ok && JSON.stringify(r.value) === JSON.stringify(want), `published example answers its documented matches (${r.ms} ms)`);
  const h = await run(HOSTILE);
  ok(!h.ok && h.err.statusCode === 400 && /timed out/.test(h.err.message), `a catastrophic pattern ends as a 400 timeout (${h.ms} ms)`);
}

// A worker that starts after the regex budget has passed.
setRegexWorkerForTest(SLOW);
{
  const r = await run(example);
  ok(r.ok && JSON.stringify(r.value) === JSON.stringify(want), `slow worker start (1500 ms): published example still answers 200 with its matches (${r.ok ? "ok" : r.err.message}, ${r.ms} ms)`);
  const h = await run(HOSTILE);
  ok(!h.ok && h.err.statusCode === 400 && /timed out/.test(h.err.message), `slow worker start: a catastrophic pattern still ends as a 400 timeout (${h.ms} ms)`);
  ok(h.ms < 1500 + 750 + 3000, `slow worker start: the timeout follows the run's own budget, not an open-ended wait (${h.ms} ms)`);
}

// A worker that never reaches the regex: bounded by the start limit, answered 503.
process.env.SLOW_REGEX_WORKER_START_MS = "60000";
{
  const t0 = Date.now();
  let err = null;
  try { await runRegexSafely({ pattern: "a", flags: "g", text: "a", maxMatches: 1 }, { startTimeoutMs: 400 }); } catch (e) { err = e; }
  ok(err && err.statusCode === 503, `a worker that does not start within its start limit answers 503 (${err ? `${err.statusCode} ${err.message}` : "resolved"}, ${Date.now() - t0} ms)`);
}
setRegexWorkerForTest(null);

console.log(`\ntest-regex-budget: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
