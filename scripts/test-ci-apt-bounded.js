// Every apt install in a workflow goes through scripts/ci-apt-install.sh.
// The runner's first apt mirror can stall with no output until the job's own
// timeout; the helper bounds each attempt, fails over to other mirrors and
// fails loudly after three. A step that calls apt-get, apt, or Playwright's
// `--with-deps` (which runs apt-get) directly has none of that.
// Offline: reads the workflow text only.
import { readFileSync, readdirSync } from "node:fs";
import { load } from "js-yaml";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const DIRECT = [
  /\bapt(-get)?\s+(-\S+\s+)*(install|update|upgrade)\b/,
  /\bplaywright\s+install\b[^\n]*--with-deps\b/,
];
const HELPER = /\bbash scripts\/ci-apt-install\.sh\b/;
const code = (run) => String(run).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

const dir = new URL("../.github/workflows/", import.meta.url);
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
let runSteps = 0, helperUses = 0;
const offenders = [];
for (const f of files) {
  const wf = load(readFileSync(new URL(f, dir), "utf8"));
  for (const [job, def] of Object.entries(wf?.jobs || {})) {
    for (const step of def?.steps || []) {
      if (typeof step?.run !== "string") continue;
      runSteps++;
      const body = code(step.run);
      if (HELPER.test(body)) helperUses++;
      if (DIRECT.some((re) => re.test(body))) offenders.push(`${f} ${job}: ${step.name || "(unnamed step)"}`);
    }
  }
}
ok(runSteps > 100, `the scan read the workflows' run steps (${runSteps} in ${files.length} files)`);
ok(helperUses >= 6, `the scan sees the helper's uses (${helperUses}: ffmpeg and Playwright installs)`);
ok(offenders.length === 0, `no workflow step installs apt packages outside scripts/ci-apt-install.sh${offenders.length ? `:\n    ${offenders.join("\n    ")}` : ""}`);

// Controls: the patterns catch what the helper itself runs, and a comment is not read.
const helper = readFileSync(new URL("./ci-apt-install.sh", import.meta.url), "utf8");
ok(DIRECT[0].test(helper) && DIRECT[1].test(helper), "the patterns match the helper's own apt-get and Playwright calls (control)");
ok(!DIRECT.some((re) => re.test(code("# npx playwright install --with-deps chromium\necho hi"))), "a commented-out install is not counted (control)");
ok(/timeout 170/.test(helper) && /for i in 1 2 3/.test(helper) && /--playwright-chromium/.test(helper), "the helper bounds each attempt, retries three times and serves the Playwright install");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
