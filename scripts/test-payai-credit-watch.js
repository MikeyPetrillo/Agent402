// The heartbeat's PayAI credit watch weighs each settlement by what PayAI
// charges for that rail. PayAI republishes those weights (daily, from gas), so
// a typed-in pair goes stale: the watch carried the 09-21 figures after PayAI
// had moved them, under-counting the allowance it exists to protect. The step
// now reads PayAI's live table and falls back to one named constant.
//
// This runs the step's own shell (extracted from heartbeat.yml) with curl and
// gh stubbed: live table readable, live table unreadable, and prod unreadable.
// Offline; needs bash and jq.
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

const yml = readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
const at = yml.indexOf("- name: PayAI credit watch");
ok(at > 0, "heartbeat.yml has the PayAI credit watch step");
const step = yml.slice(at, yml.indexOf("\n      - name:", at + 10));
ok(/PAYAI_FALLBACK_WEIGHTS: \$\{\{ vars\.PAYAI_FALLBACK_WEIGHTS \}\}/.test(step), "the fallback weights come from a repo variable");
ok(!/PAYAI_FALLBACK_WEIGHTS: '\{/.test(step) && !/"sei":\s*\d/.test(step), "no vendor rate is committed in the workflow");
// A test value, not PayAI's published rates.
const fallback = JSON.stringify({ avalanche: 0.5, sei: 2 });
const run = step.slice(step.indexOf("run: |") + "run: |".length).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
ok(/facilitator\.payai\.network\/pricing/.test(run), "the step reads PayAI's live pricing table");
ok(!/then 0\.09 else 0\.43/.test(run), "the stale inline weights are gone");

const dir = join(tmpdir(), `payai-watch-${process.pid}`);
mkdirSync(dir, { recursive: true });
const DAYS = JSON.stringify({ days: [
  { day: "2026-09-22", chain: "sei", extTx: 10, intTx: 0 },
  { day: "2026-09-23", chain: "avalanche", extTx: 0, intTx: 100 },
  { day: "2026-09-20", chain: "sei", extTx: 999, intTx: 0 }, // before the cut
  { day: "2026-09-22", chain: "base", extTx: 50, intTx: 0 }, // not a PayAI-first rail
] });
const LIVE = JSON.stringify({ rates: [
  { network: "eip155:43114", scheme: "exact", transferMethod: "eip3009", credits: "0.20" },
  { network: "eip155:1329", scheme: "exact", transferMethod: "eip3009", credits: "1.00" },
  { network: "eip155:1329", scheme: "exact", transferMethod: "permit2", credits: "9.00" },
] });

function runStep({ pricing, daily, fb = fallback }) {
  writeFileSync(join(dir, "pricing.json"), pricing);
  writeFileSync(join(dir, "daily.json"), daily);
  writeFileSync(join(dir, "curl"), `#!/bin/bash\nfor a in "$@"; do case "$a" in *payai.network/pricing*) cat "${dir}/pricing.json"; exit 0;; *revenue/daily*) cat "${dir}/daily.json"; exit 0;; esac; done\nexit 7\n`);
  writeFileSync(join(dir, "gh"), `#!/bin/bash\necho "gh $*" >> "${dir}/gh.log"\n`);
  chmodSync(join(dir, "curl"), 0o755); chmodSync(join(dir, "gh"), 0o755);
  const r = spawnSync("bash", ["-eo", "pipefail", "-c", run], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROD: "https://prod.invalid", THRESH: "800", GH_TOKEN: "x", GITHUB_REPOSITORY: "o/r", PAYAI_FALLBACK_WEIGHTS: fb },
    encoding: "utf8",
  });
  return r;
}
const credits = (out) => Number((out.match(/weighted credits since \S+: ([\d.]+)/) || [])[1]);

{
  const r = runStep({ pricing: LIVE, daily: DAYS });
  ok(r.status === 0, `live table: step exits 0 (${r.stderr})`);
  ok(/weights \(live\)/.test(r.stdout), "live table: the live weights are used");
  ok(credits(r.stdout) === 30, `live table: 10 Sei x 1.00 + 100 Avalanche x 0.20 = 30 (got ${credits(r.stdout)})`);
}
{
  const r = runStep({ pricing: "<html>down</html>", daily: DAYS });
  ok(r.status === 0, `unreadable table: step still exits 0 (${r.stderr})`);
  ok(/weights \(fallback\)/.test(r.stdout) && /::warning::PayAI live pricing table unreadable/.test(r.stdout), "unreadable table: says it fell back to the repo variable, loudly");
  const w = JSON.parse(fallback);
  const want = Math.round((10 * w.sei + 100 * w.avalanche) * 100) / 100;
  ok(credits(r.stdout) === want, `unreadable table: the fallback constant weighs the count (${want})`);
}
{
  const r = runStep({ pricing: JSON.stringify({ rates: [{ network: "eip155:43114", scheme: "exact", credits: "0.2" }] }), daily: DAYS });
  ok(/weights \(fallback\)/.test(r.stdout), "a table missing one of the two rails is not half-used: fallback");
}
{
  const r = runStep({ pricing: LIVE, daily: "not json" });
  ok(r.status === 0 && /credit watch UNREADABLE/.test(r.stdout), "prod unreadable: loud warning, never a silent pass");
}
{
  const r = runStep({ pricing: "<html>down</html>", daily: DAYS, fb: "" });
  ok(r.status === 0 && /credit watch skipped/.test(r.stdout) && !/weighted credits since/.test(r.stdout), "unreadable table and no repo variable: warns and skips, never guesses a rate");
}
{
  const r = runStep({ pricing: "<html>down</html>", daily: DAYS, fb: "{\"sei\":1}" });
  ok(/credit watch skipped/.test(r.stdout), "a repo variable missing a rail is not half-used: skipped");
}
console.log(`test-payai-credit-watch: ${passed} passed`);
