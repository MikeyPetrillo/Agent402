// heartbeat.yml's tool, upstream and facilitator failure step, run as
// written against stubbed curl and gh (nothing reaches production or GitHub).
//
// Each word must page on its bad words, close on ok and do nothing on
// unknown; the toolFailures issue lists the failing slugs read with the
// operator token and never a count or an upstream name; without the token it
// points at the operator endpoint instead. The status Worker carries the same
// three titles with the same mapping.
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.error(`FAIL - ${name}: ${e?.stack || e}`); }
}

const wf = yamlLoad(await readFile(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8"));
const steps = Object.values(wf.jobs).flatMap((j) => j.steps || []);
const step = steps.find((s) => String(s.name || "").startsWith("Tool, upstream and facilitator failure checks"));
const TITLES = {
  toolFailures: "toolFailures: a tool is answering 5xx to buyers",
  upstreamHealth: "upstreamHealth: an upstream is timing out or failing",
  facilitatorFunds: "facilitatorFunds: a facilitator refused settlement for funds",
};

const dir = await mkdtemp(path.join(tmpdir(), "hb-fail-"));
await writeFile(path.join(dir, "curl"), `#!/usr/bin/env bash
url=""; for a in "$@"; do case "$a" in http*) url="$a";; esac; done
case "$url" in
  */api/gateway-status) cat "$GS_FILE";;
  */__operator/tool-failures.json) cat "$OP_FILE";;
esac
`);
await writeFile(path.join(dir, "gh"), `#!/usr/bin/env bash
if [ "$1 $2" = "issue list" ]; then
  for a in "$@"; do case "$a" in *"$OPEN_TITLE"*) [ -n "$OPEN_TITLE" ] && echo "$OPEN_NUM" && exit 0;; esac; done
  exit 0
fi
printf '%s\\x1f' "$@" >> "$GH_LOG"; printf '\\n' >> "$GH_LOG"
`);
await chmod(path.join(dir, "curl"), 0o755);
await chmod(path.join(dir, "gh"), 0o755);

async function run({ gateway, op = null, token = "t", open = null }) {
  const gs = path.join(dir, "gs.json"), opf = path.join(dir, "op.json"), log = path.join(dir, "gh.log");
  await writeFile(gs, JSON.stringify(gateway));
  await writeFile(opf, JSON.stringify(op || {}));
  await writeFile(log, "");
  const r = spawnSync("bash", ["-e", "-c", step.run], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROD: "https://example.invalid", GITHUB_REPOSITORY: "o/r",
      OP_TOKEN: token || "", GS_FILE: gs, OP_FILE: opf, GH_LOG: log, OPEN_TITLE: open || "", OPEN_NUM: "41" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const calls = (await readFile(log, "utf8")).split("\n").filter(Boolean).map((l) => l.split("\x1f").filter((x) => x !== ""));
  return { calls, out: r.stdout };
}
const created = (calls) => calls.filter((c) => c[0] === "issue" && c[1] === "create").map((c) => ({ title: c[c.indexOf("--title") + 1], body: c[c.indexOf("--body") + 1] }));
const closed = (calls) => calls.filter((c) => c[0] === "issue" && c[1] === "close");

try {
  await check("the step exists, reads the public words and the operator endpoint with the token", () => {
    assert.ok(step, "heartbeat.yml has the step");
    assert.match(step.run, /\/api\/gateway-status/);
    assert.match(step.run, /\/__operator\/tool-failures\.json/);
    assert.equal(step.env?.OP_TOKEN, "${{ secrets.AGENT402_OPERATOR_TOKEN }}");
  });

  const OK = { toolFailures: { status: "ok" }, upstreamHealth: { status: "ok" }, facilitatorFunds: { status: "ok" } };
  await check("all ok: nothing opened", async () => {
    const { calls } = await run({ gateway: OK });
    assert.deepEqual(created(calls), []);
  });

  await check("toolFailures degraded: one issue titled for the word, listing the slugs and no count or upstream", async () => {
    const op = { issueSummary: { tools: ["stock-quote (failing)", "render (degraded)", "bad slug; rm -rf (failing)"], upstreams: ["databento (degraded)"] }, tools: [{ slug: "stock-quote", hour: { outside5xx: 7 } }] };
    const { calls } = await run({ gateway: { ...OK, toolFailures: { status: "degraded" } }, op });
    const c = created(calls);
    assert.equal(c.length, 1);
    assert.equal(c[0].title, TITLES.toolFailures);
    assert.match(c[0].body, /toolFailures\.status=degraded/);
    assert.match(c[0].body, /Failing slugs: stock-quote \(failing\), render \(degraded\)\./);
    assert.doesNotMatch(c[0].body, /rm -rf/, "a value that is not slug-shaped is dropped");
    assert.doesNotMatch(c[0].body, /databento/, "upstream names stay on the operator endpoint");
    assert.doesNotMatch(c[0].body, /\b7\b/, "no count");
  });

  await check("without the operator token the issue points at the operator endpoint", async () => {
    const { calls } = await run({ gateway: { ...OK, toolFailures: { status: "failing" } }, token: "" });
    const c = created(calls);
    assert.equal(c.length, 1);
    assert.match(c[0].body, /Read \/__operator\/tool-failures\.json/);
  });

  await check("upstreamHealth failing and facilitatorFunds refused / demoted page under their own titles", async () => {
    for (const [gw, title] of [[{ upstreamHealth: { status: "failing" } }, TITLES.upstreamHealth], [{ upstreamHealth: { status: "degraded" } }, TITLES.upstreamHealth], [{ facilitatorFunds: { status: "refused" } }, TITLES.facilitatorFunds], [{ facilitatorFunds: { status: "demoted" } }, TITLES.facilitatorFunds]]) {
      const { calls } = await run({ gateway: { ...OK, ...gw } });
      assert.deepEqual(created(calls).map((c) => c.title), [title], JSON.stringify(gw));
    }
  });

  await check("an open issue gets a comment, not a second issue; ok closes it; unknown does neither", async () => {
    let r = await run({ gateway: { ...OK, upstreamHealth: { status: "degraded" } }, open: TITLES.upstreamHealth });
    assert.deepEqual(created(r.calls), []);
    assert.ok(r.calls.some((c) => c[0] === "issue" && c[1] === "comment" && c[2] === "41"));
    r = await run({ gateway: OK, open: TITLES.upstreamHealth });
    assert.equal(closed(r.calls).length, 1);
    assert.equal(closed(r.calls)[0][2], "41");
    r = await run({ gateway: { toolFailures: { status: "unknown" } }, open: TITLES.toolFailures });
    assert.equal(closed(r.calls).length, 0);
    assert.deepEqual(created(r.calls), []);
  });

  await check("the status Worker maps the same three words under the same titles", async () => {
    const { ALARMS, judge } = await import("../workers/status-probe/src/index.js");
    for (const t of Object.values(TITLES)) assert.ok(ALARMS.some((a) => a.title === t), `Worker has "${t}"`);
    const j = (gw) => judge({ gateway: gw });
    for (const w of ["degraded", "failing"]) {
      assert.equal(j({ toolFailures: { status: w } })[TITLES.toolFailures], "bad");
      assert.equal(j({ upstreamHealth: { status: w } })[TITLES.upstreamHealth], "bad");
    }
    for (const w of ["refused", "demoted"]) assert.equal(j({ facilitatorFunds: { status: w } })[TITLES.facilitatorFunds], "bad");
    for (const t of Object.keys(TITLES)) {
      assert.equal(j({ [t]: { status: "ok" } })[TITLES[t]], "good");
      assert.equal(j({ [t]: { status: "unknown" } })[TITLES[t]], "quiet");
      assert.equal(j({})[TITLES[t]], "quiet");
    }
    const body = ALARMS.find((a) => a.title === TITLES.toolFailures).body({ gateway: { toolFailures: { status: "<b>" } } });
    assert.match(body, /toolFailures\.status=degraded/, "the body echoes only a known word");
    assert.match(body, /\/__operator\/tool-failures\.json/);
  });
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\ntest-heartbeat-failure-words: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
