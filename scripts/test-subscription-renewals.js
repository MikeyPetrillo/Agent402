#!/usr/bin/env node
// subscriptionRenewals on /api/gateway-status (src/mpp-subscriptions.js):
// unconfirmed while a wallet-billed monitor renewal has stayed unconfirmed
// (its send's landing undecided by the chain read, so nothing is signed
// again) for longer than MPP_SUB_UNCONFIRMED_ALERT_HOURS, ok otherwise, off
// with the alert disabled or no subscription engine. The word itself is
// proven in scripts/test-mpp-subscriptions.js against the engine; this file
// proves the surface and the paging: gateway-status carries the word (full
// only for the operator), the heartbeat step run as written (stub curl and
// gh) opens one issue, comments on an open one and closes it on ok or off,
// and the status Worker carries the same title and mapping. Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (e) { failures++; console.error(`FAIL - ${name}: ${e?.stack || e}`); }
}

const TITLE = "subscriptionRenewals: a monitor renewal has stayed unconfirmed for hours";

await check("gateway-status carries the word: the engine's read, full only for the operator, off without an engine", () => {
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.ok(/subscriptionRenewals: \(\(\) => \{ try \{ return _mppSubs \? _mppSubs\.renewalsStatus\(\{ full \}\) : \{ status: "off" \}; \} catch \{ return \{ status: "unknown" \}; \} \}\)\(\),/.test(server));
  const subs = readFileSync(new URL("../src/mpp-subscriptions.js", import.meta.url), "utf8");
  assert.ok(/function renewalsStatus\(\{ full = false, env = process\.env, at = now\(\) \} = \{\}\) \{\n\s*refreshMirror\(\);\n\s*return renewalsWord\(\[\.\.\.cache\.values\(\)\], \{ hours: renewalUnconfirmedAlertHours\(env\), at, full \}\);/.test(subs), "the engine reads its mirror with the env threshold");
});

const wf = yamlLoad(readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8"));
const step = Object.values(wf.jobs).flatMap((j) => j.steps || []).find((s) => String(s.name || "").startsWith("Tool, upstream and facilitator failure checks"));
const dir = mkdtempSync(join(tmpdir(), "hb-subrenewals-"));
writeFileSync(join(dir, "curl"), "#!/usr/bin/env bash\ncat \"$GS_FILE\"\n");
writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
if [ "$1 $2" = "issue list" ]; then
  for a in "$@"; do case "$a" in *"$OPEN_TITLE"*) [ -n "$OPEN_TITLE" ] && echo 41 && exit 0;; esac; done
  exit 0
fi
printf '%s\\x1f' "$@" >> "$GH_LOG"; printf '\\x1e' >> "$GH_LOG"
`);
chmodSync(join(dir, "curl"), 0o755); chmodSync(join(dir, "gh"), 0o755);
function hb(gateway, open = "") {
  const gs = join(dir, "gs.json"), log = join(dir, "gh.log");
  writeFileSync(gs, JSON.stringify(gateway)); writeFileSync(log, "");
  const r = spawnSync("bash", ["-e", "-c", step.run], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROD: "https://example.invalid", GITHUB_REPOSITORY: "o/r", GS_FILE: gs, GH_LOG: log, OPEN_TITLE: open }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(log, "utf8").split("\x1e").filter((l) => l.trim()).map((l) => l.split("\x1f").filter((x) => x !== ""));
}
const OK = { toolFailures: { status: "ok" }, upstreamHealth: { status: "ok" }, facilitatorFunds: { status: "ok" }, buyerRefusals: { status: "ok" }, robinhoodSettler: { status: "ok" }, directUpstream: { status: "ok" } };

await check("heartbeat: unconfirmed opens one issue (word and operator endpoint only), an open one gets a comment, ok and off close it, unknown and a missing word do neither", () => {
  assert.ok(step, "heartbeat.yml has the failure-words step");
  let calls = hb({ ...OK, subscriptionRenewals: { status: "unconfirmed" } });
  const made = calls.filter((c) => c[1] === "create");
  assert.equal(made.length, 1, JSON.stringify(calls));
  assert.equal(made[0][made[0].indexOf("--title") + 1], TITLE);
  const body = made[0][made[0].indexOf("--body") + 1];
  assert.match(body, /subscriptionRenewals\.status=unconfirmed\./);
  assert.match(body, /\/__operator\/monitors\.json/);
  assert.doesNotMatch(body, /0x[0-9a-f]{6}|mpp_sub|\d{4}-\d\d-\d\d/i);
  calls = hb({ ...OK, subscriptionRenewals: { status: "unconfirmed" } }, TITLE);
  assert.equal(calls.filter((c) => c[1] === "create").length, 0);
  assert.ok(calls.some((c) => c[1] === "comment" && c[2] === "41"));
  for (const w of ["ok", "off"]) {
    calls = hb({ ...OK, subscriptionRenewals: { status: w } }, TITLE);
    assert.equal(calls.filter((c) => c[1] === "close" && c[2] === "41").length, 1, w);
  }
  calls = hb({ ...OK, subscriptionRenewals: { status: "unknown" } }, TITLE);
  assert.equal(calls.filter((c) => c[1] === "close" || c[1] === "create").length, 0);
  calls = hb(OK, TITLE);
  assert.equal(calls.filter((c) => c[1] === "close" || c[1] === "create").length, 0, "a missing word does neither");
});

await check("status Worker: the same title; unconfirmed bad, ok and off good, anything else quiet; the body names the word only", async () => {
  const { ALARMS, judge } = await import("../workers/status-probe/src/index.js");
  const a = ALARMS.find((x) => x.title === TITLE);
  assert.ok(a, "the Worker carries the alarm");
  const j = (gw) => judge({ gateway: gw })[TITLE];
  assert.equal(j({ subscriptionRenewals: { status: "unconfirmed" } }), "bad");
  assert.equal(j({ subscriptionRenewals: { status: "ok" } }), "good");
  assert.equal(j({ subscriptionRenewals: { status: "off" } }), "good");
  for (const w of ["unknown", "<b>"]) assert.equal(j({ subscriptionRenewals: { status: w } }), "quiet", w);
  assert.equal(j({}), "quiet");
  const body = a.body({ gateway: { subscriptionRenewals: { status: "<b>" } } });
  assert.match(body, /subscriptionRenewals\.status=unconfirmed\./);
  assert.match(body, /\/__operator\/monitors\.json/);
  assert.match(body, /MPP_SUB_UNCONFIRMED_ALERT_HOURS/);
  assert.doesNotMatch(body, /<b>/);
});

rmSync(dir, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall subscriptionRenewals checks passed");
