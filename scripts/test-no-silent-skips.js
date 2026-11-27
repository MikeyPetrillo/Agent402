// A skipped suite is not coverage. A suite that prints a whole-suite skip and
// exits 0 because a table, key, binary or service is missing must FAIL under
// CI instead: the same lines that skip locally sit behind a CI check.
//
// Three parts:
//   1. A scan of scripts/test-*.js and scripts/lib/: every whole-suite skip
//      (a printed skip followed by a zero exit) has a CI check beside it. The
//      ones that do not are named in EXCEPTIONS with the reason; that list may
//      only shrink.
//   2. The two shared helpers a suite calls for its dependency
//      (requireUpstreamCosts, requireTestPg), run under CI without it: exit 1.
//   3. A split suite (scripts/test-images-fast-kit.js) without the table: its
//      rate-free checks run, and under CI the missing rate checks fail it.
//
//   node scripts/test-no-silent-skips.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// A printed line whose message opens with a skip word, or says "skipped (".
const SKIP_PRINT = /(?:console\.(?:log|error|warn)|process\.stdout\.write)\(\s*[`'"](?:\\n)?\s*\(?(?:SKIP|SKIPPED|Skipped|skip|skipped)\b|(?:console\.(?:log|error|warn))\([^\n]*: skipped \(/;
const ZERO_EXIT = /process\.exit\(\s*0?\s*\)/;
// What counts as the CI check beside it: the variable itself, or the shared
// rule for the private table (scripts/lib/require-upstream-costs.js).
const CI_CHECK = /process\.env\.CI\b|upstreamCostsRequired\(\)/;
const EXIT_WITHIN = 3;   // lines after the print in which the zero exit sits
const CHECK_WITHIN = 8;  // lines before the print in which the CI check sits

/** The whole-suite skips of one source text: [{ line, text, gated }]. */
export function wholeSuiteSkips(src) {
  const L = String(src).split("\n");
  const out = [];
  for (let i = 0; i < L.length; i++) {
    if (!SKIP_PRINT.test(L[i])) continue;
    if (!ZERO_EXIT.test(L.slice(i, i + 1 + EXIT_WITHIN).join("\n"))) continue;
    out.push({ line: i + 1, text: L[i].trim().slice(0, 120), gated: CI_CHECK.test(L.slice(Math.max(0, i - CHECK_WITHIN), i + 1).join("\n")) });
  }
  return out;
}

// Suites whose whole-suite skip is NOT a failure under CI, each with why.
// This list may only shrink: a suite leaves it by failing under CI when its
// dependency is missing. Nothing is added; a new suite gates its skip.
const EXCEPTIONS = new Map([
  ["test-cdp-live.js", "a live check of an outside API, run by its own workflow step that hands it the keys when the repository holds them"],
  ["test-client-paid-live.js", "a live paid call against production; its workflow step checks for the signer key before it runs the suite"],
  ["test-treasury-paid-live.js", "a live paid call against production; its workflow step checks for the signer key before it runs the suite"],
  ["test-challenge-size.js", "skips only against a local server with no paywall; against any other target a run that measured nothing already fails"],
]);
const EXCEPTIONS_MAX = 4;

const files = [
  ...readdirSync(DIR).filter((f) => /^test-.*\.m?js$/.test(f) && f !== "test-no-silent-skips.js").map((f) => [f, join(DIR, f)]),
  ...readdirSync(join(DIR, "lib")).filter((f) => /\.m?js$/.test(f)).map((f) => [`lib/${f}`, join(DIR, "lib", f)]),
];
const sites = [];
for (const [name, path] of files) for (const s of wholeSuiteSkips(readFileSync(path, "utf8"))) sites.push({ name, ...s });
ok(files.length > 1000 && sites.length >= 20, `the scan reads the suites and their libraries and finds the whole-suite skips (${sites.length} in ${files.length} files)`);
const ungated = sites.filter((s) => !s.gated && !EXCEPTIONS.has(s.name));
ok(ungated.length === 0, `every whole-suite skip fails under CI when its dependency is missing${ungated.length ? `; put a CI check beside:\n  ${ungated.map((s) => `${s.name}:${s.line} ${s.text}`).join("\n  ")}` : ""}`);
const stale = [...EXCEPTIONS.keys()].filter((f) => !sites.some((s) => s.name === f && !s.gated));
ok(stale.length === 0, `every named exception still skips without a CI check (delete the ones that no longer do)${stale.length ? `: ${stale.join(", ")}` : ""}`);
ok(EXCEPTIONS.size <= EXCEPTIONS_MAX && [...EXCEPTIONS.values()].every((why) => why.length > 30), `the exception list never grows past its frozen size and each entry says why (${EXCEPTIONS.size} of ${EXCEPTIONS_MAX})`);

// Controls: the scan sees a planted ungated skip, accepts a gated one, and
// does not read a part skip (no zero exit beside it) as a whole-suite skip.
{
  const planted = wholeSuiteSkips('if (!key) {\n  console.log("SKIP - no key");\n  process.exit(0);\n}');
  ok(planted.length === 1 && planted[0].gated === false, "control: a planted skip-and-exit with no CI check is caught");
  const gated = wholeSuiteSkips('if (!url) {\n  if (process.env.CI) { console.error("FAIL - no url"); process.exit(1); }\n  console.log(`SKIP - ${msg}`); process.exit(0);\n}');
  ok(gated.length === 1 && gated[0].gated === true, "control: the same skip behind a CI check passes");
  ok(wholeSuiteSkips('if (!url) {\n  console.log("SKIP - shared half: no REDIS_URL");\n} else {\n  run();\n}\n\n\nprocess.exit(fail ? 1 : 0);').length === 0, "control: a part skip that leaves the exit code to the checks that ran is not a whole-suite skip");
  ok(wholeSuiteSkips('console.log("CDP live check: skipped (no key)");\nprocess.exit(0);').length === 1 && wholeSuiteSkips('console.log("note: 3 rows skipped");\nprocess.exit(0);').length === 0, "control: `skipped (` after a label is read as a skip, a count of skipped rows is not");
}

// ---- 2. the shared helpers, without their dependency ---------------------------
const CLEAN = { ...process.env };
for (const k of ["CI", "UPSTREAM_COSTS_JSON", "UPSTREAM_COSTS_FILE", "UPSTREAM_COSTS_OPTIONAL", "STATE_DATABASE_URL"]) delete CLEAN[k];
const run = (args, env) => { const r = spawnSync(process.execPath, args, { cwd: ROOT, env: { ...CLEAN, ...env }, encoding: "utf8", timeout: 240_000 }); return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` }; };
const helper = (body, env) => run(["--input-type=module", "-e", `import "./scripts/lib/offline-stores.js";\n${body}\nconsole.log("RAN PAST");`], env);
{
  const call = 'const { requireUpstreamCosts } = await import("./scripts/lib/require-upstream-costs.js"); requireUpstreamCosts("probe");';
  const ci = helper(call, { CI: "true" });
  ok(ci.code === 1 && /^FAIL - probe: /m.test(ci.out) && !/RAN PAST/.test(ci.out), `requireUpstreamCosts fails under CI without the table (exit ${ci.code})`);
  const local = helper(call, {});
  ok(local.code === 0 && /^SKIP - probe: /m.test(local.out) && !/RAN PAST/.test(local.out), `...and skips outside CI (exit ${local.code})`);
  const fork = helper(call, { CI: "true", UPSTREAM_COSTS_OPTIONAL: "1" });
  ok(fork.code === 0 && /^SKIP - probe: /m.test(fork.out), `...and skips under CI only where the workflow says the run cannot hold the table (exit ${fork.code})`);
  const pg = 'const { requireTestPg } = await import("./scripts/lib/test-pg.js"); requireTestPg({ label: "probe" });';
  const pgCi = helper(pg, { CI: "true" });
  ok(pgCi.code === 1 && /^FAIL - probe: /m.test(pgCi.out) && !/RAN PAST/.test(pgCi.out), `requireTestPg fails under CI without a database (exit ${pgCi.code})`);
  ok(helper(pg, {}).code === 0, "...and skips outside CI");
}

// ---- 3. a split suite without the table ------------------------------------------
{
  const count = (out) => (out.match(/^ok - /gm) || []).length;
  const ci = run(["scripts/test-images-fast-kit.js"], { CI: "true" });
  ok(ci.code === 1 && /^FAIL - test-images-fast-kit \(rate checks\): /m.test(ci.out), `test-images-fast-kit fails under CI without the table (exit ${ci.code})`);
  ok(count(ci.out) > 200 && /content_filtered/.test(ci.out) && (ci.out.match(/^FAIL - /gm) || []).length === 1, `...after running its rate-free checks: the 422 content_filtered answers, the outage answers, the price constants (${count(ci.out)} passed, the one failure is the missing table)`);
  const local = run(["scripts/test-images-fast-kit.js"], {});
  ok(local.code === 0 && count(local.out) === count(ci.out) && /^SKIP - test-images-fast-kit \(rate checks only/m.test(local.out), `...and outside CI the same checks pass with the rate checks alone skipped (exit ${local.code}, ${count(local.out)} passed)`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
