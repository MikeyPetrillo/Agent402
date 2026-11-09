// scripts/clawhub-release.js against a fake `clawhub` executable: already
// published, not found then published, rate limited then ok, rate limited past
// the budget, and an unrelated error. Offline; time is scaled down.
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("./clawhub-release.js", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// plan: [exitCode, output] per call, in order (the last repeats); each call is
// logged to calls.txt as its first two arguments.
function scenario(plan, { scale = "0.02" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "clawhub-"));
  const bin = join(dir, "clawhub");
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"); const d = ${JSON.stringify(dir)};
const log = d + "/calls.txt"; const n = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length : 0;
fs.appendFileSync(log, process.argv.slice(2, 4).join(" ") + "\\n");
const plan = JSON.parse(fs.readFileSync(d + "/plan.json", "utf8"));
const [code, out] = plan[Math.min(n, plan.length - 1)];
(code ? process.stderr : process.stdout).write(out + "\\n"); process.exit(code);
`);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, CLAWHUB_CMD: bin, VERSION: "1.2.3", CLAWHUB_TIME_SCALE: scale, GITHUB_REPOSITORY: "o/r", GITHUB_SHA: "abc", GITHUB_REF_NAME: "main" },
  });
  const calls = existsSync(join(dir, "calls.txt")) ? readFileSync(join(dir, "calls.txt"), "utf8").split("\n").filter(Boolean) : [];
  return { code: r.status, out: r.stdout + r.stderr, calls };
}
const LIMIT = [1, "Too many writes in a short period of time (reset in 5s)"];
const NF = [1, "Error: Version not found (reset in 35s)"];
const INS = "package inspect", PUB = "package publish";

let r = scenario([[0, "ok"]]);
ok(r.code === 0 && r.calls.join("|") === INS && /already on ClawHub/.test(r.out), "already published: one inspect, no publish");

r = scenario([NF, [0, "done"]]);
ok(r.code === 0 && r.calls.join("|") === `${INS}|${PUB}`, "not found then published");

r = scenario([[1, "Package not found or not visible to this account. (reset in 33s)"], [0, "done"]]);
ok(r.code === 0 && r.calls[1] === PUB, "package not found also publishes");

r = scenario([LIMIT, NF, LIMIT, [0, "done"]]);
ok(r.code === 0 && r.calls.join("|") === `${INS}|${INS}|${PUB}|${PUB}`, "rate limited inspect and publish are each retried");

r = scenario([LIMIT, [0, "ok"]]);
ok(r.code === 0 && r.calls.join("|") === `${INS}|${INS}`, "rate limited inspect then ok never publishes");

r = scenario([LIMIT]);
ok(r.code === 1 && r.calls.length === 3 && r.calls.every((c) => c === INS), "inspect rate limited past the attempts fails without publishing");

r = scenario([NF, LIMIT]);
ok(r.code === 1 && r.calls.filter((c) => c === PUB).length === 3, "publish rate limited past the attempts fails");

const SLOW = [1, "Too many writes in a short period of time (reset in 55s)"];
// At 0.1 the budget is 6 s and each wait 2 s, so the fake CLI's own start-up
// time on a loaded host cannot decide which retry the budget stops.
r = scenario([SLOW, SLOW, NF, SLOW], { scale: "0.1" });
ok(r.code === 1 && r.calls.join("|") === `${INS}|${INS}|${INS}|${PUB}`, "waits are capped and the total budget stops further retries");

r = scenario([[1, "Error: network unreachable"]]);
ok(r.code === 1 && r.calls.join("|") === INS, "other inspect error fails and never publishes");

r = scenario([NF, [1, "Error: boom"]]);
ok(r.code === 1 && r.calls.length === 2, "other publish error fails");

r = scenario([NF, [1, "version 1.2.3 already exists"]]);
ok(r.code === 0, "publish 'already exists' is a no-op");

r = scenario([NF, [1, "is staged by failed publish attempt"]]);
ok(r.code === 0 && /::warning::/.test(r.out), "staged version warns and passes");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
