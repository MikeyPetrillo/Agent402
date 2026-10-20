// The heartbeat's 7-day MPP reconciliation window check
// (mppReconcile.window7d on /api/gateway-status). The daily alarm closes as
// soon as the next day reads ok, so a mismatch nobody resolved left no open
// issue while it still sat in the window. This step pages on that gap only:
// window mismatch while the latest day reads ok, confirmed by a second read.
//
// This runs the step's own shell (extracted from heartbeat.yml) with curl,
// gh and sleep stubbed. Offline; needs bash and jq.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

const TITLE = "MPP reconciliation 7-day window MISMATCH";
const yml = readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
const at = yml.indexOf("- name: MPP reconciliation 7-day window check");
ok(at > 0, "heartbeat.yml has the 7-day window step");
const step = yml.slice(at, yml.indexOf("\n      - name:", at + 10));
ok(step.includes(`TITLE="${TITLE}"`), "the step raises the title the status Worker uses");
ok(/if: always\(\)/.test(step) && /continue-on-error: true/.test(step), "the step never fails the heartbeat run");
const run = step.slice(step.indexOf("run: |") + "run: |".length).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");

const dir = join(tmpdir(), `hb-mpp-window-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const gs = (mppReconcile) => JSON.stringify({ status: "ok", mppReconcile });
const OPERATOR = JSON.stringify({ window: { mismatches: [
  { category: "paid_unrecorded", at: "2026-10-14T03:00:00.000Z" },
  { category: "charged_failed", at: "2026-10-15T03:00:00.000Z" },
] } });

// Each /api/gateway-status read returns the next body (the last repeats).
function runStep({ reads, open = "", opToken = "" }) {
  reads.forEach((b, i) => writeFileSync(join(dir, `gs${i}.json`), b));
  writeFileSync(join(dir, "n"), "0");
  writeFileSync(join(dir, "op.json"), OPERATOR);
  for (const f of ["gh.log", "sleep.log"]) rmSync(join(dir, f), { force: true });
  const last = reads.length - 1;
  writeFileSync(join(dir, "curl"), `#!/bin/bash
for a in "$@"; do case "$a" in
  *__operator/mpp-reconcile.json*) cat "${dir}/op.json"; exit 0;;
  *api/gateway-status*) n=$(cat "${dir}/n"); i=$n; [ "$i" -gt ${last} ] && i=${last}; echo $((n+1)) > "${dir}/n"; f="${dir}/gs$i.json"; [ -s "$f" ] && cat "$f"; exit 0;;
esac; done
exit 7
`);
  writeFileSync(join(dir, "gh"), `#!/bin/bash
printf '%s\\n' "gh $*" >> "${dir}/gh.log"
if [ "$1 $2" = "issue list" ]; then echo "${open}"; fi
`);
  writeFileSync(join(dir, "sleep"), `#!/bin/bash\necho "sleep $*" >> "${dir}/sleep.log"\n`);
  for (const f of ["curl", "gh", "sleep"]) chmodSync(join(dir, f), 0o755);
  const r = spawnSync("bash", ["-e", "-c", run], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROD: "https://prod.invalid", GH_TOKEN: "x", GITHUB_REPOSITORY: "o/r", OP_TOKEN: opToken },
    encoding: "utf8",
  });
  const gh = existsSync(join(dir, "gh.log")) ? readFileSync(join(dir, "gh.log"), "utf8") : "";
  const slept = existsSync(join(dir, "sleep.log"));
  return { ...r, gh, slept, created: /gh issue create/.test(gh), closedIssue: /gh issue close/.test(gh) };
}

const WIN_BAD = gs({ status: "ok", day: "2026-10-19", window7d: "mismatch", chargedFailedStatus: "ok" });
const WIN_OK = gs({ status: "ok", day: "2026-10-22", window7d: "ok", chargedFailedStatus: "ok" });

{
  const r = runStep({ reads: [WIN_BAD, WIN_BAD] });
  ok(r.status === 0, `confirmed window mismatch: exits 0 (${r.stderr})`);
  ok(r.slept, "confirmed window mismatch: re-reads before paging");
  ok(r.created && r.gh.includes(TITLE), "confirmed window mismatch while the day reads ok: opens the issue");
  ok(/latest day \(2026-10-19\) reads ok/.test(r.gh), "the body names the latest day");
  ok(/need the operator token/.test(r.gh), "without the operator token the body says what it could not read");
}
{
  const r = runStep({ reads: [WIN_BAD, WIN_BAD], opToken: "t" });
  ok(r.created && /- 2026-10-14 paid_unrecorded: 1/.test(r.gh), "with the operator token the body lists each item's day and category");
  ok(!/charged_failed/.test(r.gh), "charged_failed (the refund ledger's own alarm) is not listed as a mismatch");
}
{
  const r = runStep({ reads: [WIN_BAD, gs({ status: "unknown", window7d: "unknown" })] });
  ok(r.status === 0 && !r.created, "a first read the second does not confirm opens nothing");
}
{
  const r = runStep({ reads: [gs({ status: "mismatch", day: "2026-10-14", window7d: "mismatch" })] });
  ok(r.status === 0 && !r.created && !r.slept, "a mismatched latest day belongs to the daily alarm: no second issue");
}
{
  const r = runStep({ reads: [gs({ status: "unknown", window7d: "mismatch" })] });
  ok(r.status === 0 && !r.created && !r.closedIssue, "an unknown latest day neither opens nor closes");
}
{
  const r = runStep({ reads: [WIN_BAD, WIN_BAD], open: "41" });
  ok(r.status === 0 && !r.created && !r.closedIssue, "an open issue is not duplicated");
}
{
  const r = runStep({ reads: [WIN_OK], open: "41" });
  ok(r.status === 0 && /gh issue close 41/.test(r.gh), "window ok closes the open issue");
}
{
  const r = runStep({ reads: [""], open: "41" });
  ok(r.status === 0 && !r.created && !r.closedIssue, "an unreadable endpoint neither opens nor closes");
}
{
  const bad = gs({ status: "ok", day: "<b>x</b>", window7d: "mismatch" });
  const r = runStep({ reads: [bad, bad] });
  ok(r.created && /latest day \(the latest day\)/.test(r.gh) && !r.gh.includes("<b>"), "a day not in its own shape is never echoed");
}

rmSync(dir, { recursive: true, force: true });
console.log(`test-heartbeat-mpp-window: ${passed} checks passed`);
