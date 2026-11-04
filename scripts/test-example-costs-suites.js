#!/usr/bin/env node
// The gateway suites pass on the placeholder cost table
// (docs/example-upstream-costs.json), not only on the private one.
//
// Why: a contributor, a fork PR and a developer without the private table load
// the placeholder file. Ten checks of test-llm-messages.js and
// test-llm-responses.js, one of test-paytime-bounds.js and one of
// test-messages-sdk-alias.js need rows the placeholder lacked (a dear model
// that reaches the metered cap, a premium model the margin clamp binds on, a
// video row, two models that quote apart), so they failed there while CI, which
// holds the private table, stayed green. The placeholder now carries those rows
// with placeholder numbers; this runs each suite on it and requires exit 0 and
// no skip. It prints exit codes and counts only, never a figure from a table.
//
//   node scripts/test-example-costs-suites.js
// EXAMPLE_COSTS_FILE points it at another table (the mutation check uses it).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TABLE = process.env.EXAMPLE_COSTS_FILE || fileURLToPath(new URL("../docs/example-upstream-costs.json", import.meta.url));
const SUITES = ["test-llm-messages.js", "test-llm-responses.js", "test-messages-sdk-alias.js", "test-paytime-bounds.js"];
let failed = 0;

function run(suite) {
  return new Promise((resolve) => {
    const env = { ...process.env, UPSTREAM_COSTS_FILE: TABLE, UPSTREAM_COSTS_OPTIONAL: "" };
    delete env.UPSTREAM_COSTS_JSON;
    const c = spawn(process.execPath, [fileURLToPath(new URL(`./${suite}`, import.meta.url))], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    const kill = setTimeout(() => c.kill("SIGKILL"), 300_000);
    c.on("close", (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
}

const results = await Promise.all(SUITES.map(async (s) => [s, await run(s)]));
for (const [s, { code, out }] of results) {
  const fails = out.split("\n").filter((l) => /^\s*FAIL\b/.test(l)).length;
  const skipped = /^SKIP\b/m.test(out);
  const good = code === 0 && fails === 0 && !skipped;
  if (!good) failed++;
  console.log(`${good ? "ok" : "FAIL"} - ${s} on the placeholder table: exit ${code}, ${fails} failing check(s)${skipped ? ", SKIPPED" : ""}`);
}
if (failed) { console.error(`\n${failed} suite(s) need a row the placeholder table lacks`); process.exit(1); }
console.log("\nall gateway suites pass on the placeholder cost table");
