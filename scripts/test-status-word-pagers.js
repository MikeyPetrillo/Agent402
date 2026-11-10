// Three words on /api/gateway-status and their two observers: gatewayBalance
// (withdraw), sharedLimits (degraded) and replayStore (pending).
//
// gatewayBalance=withdraw holds from the read that reaches the mark until an
// operator moves the balance, so it pages at once. The other two flicker in
// normal operation (one failed Redis command reads degraded for a minute; a
// missed consumed mark reads pending until the next retry pass), so the
// server publishes a second word, alert, that reads sustained only once the
// word has held ten minutes without a break, and the pagers read that.
//
// Checks: the second word on the server (injected clock, in-memory client);
// the status Worker's verdicts and its open and close against a stubbed
// GitHub; heartbeat.yml's three steps run as written against stubbed curl
// and gh; both observers carry the same title and body. Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
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
const MIN = 60_000;

// ---- replayStore.alert --------------------------------------------------------
{
  const { createReplayGuard, replayGuardStoreStatus, REPLAY_STORE_ALERT_AFTER_MS } = await import("../src/replay-guard.js");
  const { __setTestClient } = await import("../src/shared-limit.js");
  const kv = new Map();
  let down = false;
  const wrap = (f) => async (...a) => { if (down) throw new Error("simulated outage"); return f(...a); };
  const client = {
    get: wrap(async (k) => (kv.has(k) ? kv.get(k) : null)),
    set: wrap(async (k, v, o) => { if (o?.NX && kv.has(k)) return null; kv.set(k, v); return "OK"; }),
    del: wrap(async (k) => (kv.delete(k) ? 1 : 0)),
    expire: wrap(async () => 1),
  };
  __setTestClient(client);
  try {
    await check("replayStore: ok with nothing missed, and the second word reads ok", () => {
      assert.deepEqual(replayGuardStoreStatus(), { status: "ok", alert: "ok" });
      assert.equal(REPLAY_STORE_ALERT_AFTER_MS, 10 * MIN);
    });
    const g = createReplayGuard({ consumedRetryDelaysMs: [], pendingRetryMs: 15 });
    await g.begin("n:pager-a");
    down = true;
    const t0 = Date.now();
    await g.settle("n:pager-a");
    await check("replayStore: a missed mark reads pending; alert stays ok inside the grace period", () => {
      assert.deepEqual(replayGuardStoreStatus({ now: t0 }), { status: "pending", alert: "ok" });
      assert.equal(replayGuardStoreStatus({ now: t0 + 9 * MIN }).alert, "ok");
    });
    await check("replayStore: pending held past the grace period reads sustained; the operator view carries it", () => {
      assert.deepEqual(replayGuardStoreStatus({ now: t0 + 11 * MIN }), { status: "pending", alert: "sustained" });
      const full = replayGuardStoreStatus({ full: true, now: t0 + 11 * MIN });
      assert.equal(full.alert, "sustained");
      assert.equal(typeof full.pending, "number");
    });
    down = false;
    for (let i = 0; i < 300 && replayGuardStoreStatus().status !== "ok"; i++) await new Promise((r) => setTimeout(r, 10));
    await check("replayStore: once the store takes the mark both words read ok, whatever the clock", () => {
      assert.deepEqual(replayGuardStoreStatus({ now: t0 + 60 * MIN }), { status: "ok", alert: "ok" });
    });
    // A blip that cleared starts the clock again: a new miss is not sustained by the old one's age.
    await g.begin("n:pager-b");
    down = true;
    const t1 = Date.now();
    await g.settle("n:pager-b");
    // The miss is stamped inside settle, so it lies between t1 and t2.
    const t2 = Date.now();
    await check("replayStore: a new miss after a recovery starts its own grace period", () => {
      assert.ok(t1 - t0 >= 5, "the two misses are apart in time");
      assert.deepEqual(replayGuardStoreStatus({ now: t1 + 10 * MIN - 1 }), { status: "pending", alert: "ok" }, "counted from the new miss, not the first");
      assert.equal(replayGuardStoreStatus({ now: t2 + 10 * MIN }).alert, "sustained");
    });
    down = false;
    for (let i = 0; i < 300 && replayGuardStoreStatus().status !== "ok"; i++) await new Promise((r) => setTimeout(r, 10));
  } finally {
    __setTestClient(null);
  }
}

// ---- sharedLimits.alert -------------------------------------------------------
// The word needs the Redis mode, which is fixed at import: an address nothing
// listens on, and results recorded by hand (no command is sent).
{
  process.env.REDIS_URL = "redis://127.0.0.1:1";
  const SL = await import("../src/shared-limits.js");
  const HOLD = SL.DEGRADED_HOLD_MS();
  const T = 1_800_000_000_000;
  const failAt = (t) => SL._noteSharedLimitsResult({ ok: false, error: "timed out" }, t);
  const okAt = (t) => SL._noteSharedLimitsResult({ ok: true }, t);
  await check("sharedLimits: one failed command reads degraded for the hold and never sustained", () => {
    assert.equal(SL.sharedLimitsMode(), "redis");
    assert.equal(SL.SHARED_LIMITS_ALERT_AFTER_MS, 10 * MIN);
    SL._resetSharedLimitsState();
    okAt(T - 1);
    failAt(T);
    assert.deepEqual(SL.sharedLimitsStatus({ now: T + 1 }), { status: "degraded", alert: "ok" });
    assert.deepEqual(SL.sharedLimitsStatus({ now: T + HOLD + 1 }), { status: "on", alert: "ok" });
  });
  await check("sharedLimits: failures arriving inside each other's hold for ten minutes read sustained", () => {
    SL._resetSharedLimitsState();
    okAt(T - 1);
    for (let t = T; t <= T + 11 * MIN; t += HOLD / 2) failAt(t);
    assert.deepEqual(SL.sharedLimitsStatus({ now: T + 9 * MIN }).status, "degraded");
    assert.deepEqual(SL.sharedLimitsStatus({ now: T + 11 * MIN + 1 }), { status: "degraded", alert: "sustained" });
    assert.equal(SL.sharedLimitsStatus({ full: true, now: T + 11 * MIN + 1 }).alert, "sustained");
    // Successes between the failures do not end the spell: the word never left degraded.
    okAt(T + 11 * MIN + 2);
    assert.equal(SL.sharedLimitsStatus({ now: T + 11 * MIN + 3 }).alert, "sustained");
    // Recovery: the hold runs out and both words clear.
    assert.deepEqual(SL.sharedLimitsStatus({ now: T + 11 * MIN + HOLD + 5 }), { status: "on", alert: "ok" });
  });
  await check("sharedLimits: a break longer than the hold starts the grace period again", () => {
    SL._resetSharedLimitsState();
    okAt(T - 1);
    for (let t = T; t <= T + 8 * MIN; t += HOLD / 2) failAt(t);
    const resume = T + 8 * MIN + 2 * HOLD; // the word read on in between
    for (let t = resume; t <= resume + 5 * MIN; t += HOLD / 2) failAt(t);
    assert.deepEqual(SL.sharedLimitsStatus({ now: resume + 5 * MIN + 1 }), { status: "degraded", alert: "ok" }, "thirteen minutes of failures with a break is not ten in a row");
    for (let t = resume + 5 * MIN; t <= resume + 11 * MIN; t += HOLD / 2) failAt(t);
    assert.equal(SL.sharedLimitsStatus({ now: resume + 11 * MIN + 1 }).alert, "sustained");
  });
  SL._resetSharedLimitsState();
}

// ---- the status Worker ----------------------------------------------------------
const { judge, ALARMS, syncAlarms } = await import("../workers/status-probe/src/index.js");
const GB = "Gateway balance READY to withdraw";
const SLT = "Shared limits store DEGRADED (Redis)";
const RS = "Replay store marks PENDING (Redis)";
const j = (gateway) => judge({ gateway });

await check("Worker: gatewayBalance pages on withdraw at once, clears on ok and off", () => {
  assert.equal(j({ gatewayBalance: { status: "withdraw" } })[GB], "bad");
  for (const w of ["ok", "off"]) assert.equal(j({ gatewayBalance: { status: w } })[GB], "good", w);
  for (const w of ["unknown", "something-new"]) assert.equal(j({ gatewayBalance: { status: w } })[GB], "quiet", w);
  assert.equal(j({})[GB], "quiet", "a build without the word changes nothing");
});
await check("Worker: sharedLimits pages only on alert=sustained, clears on on and memory", () => {
  assert.equal(j({ sharedLimits: { status: "degraded", alert: "sustained" } })[SLT], "bad");
  assert.equal(j({ sharedLimits: { status: "degraded", alert: "ok" } })[SLT], "quiet", "degraded inside the grace period neither pages nor closes");
  assert.equal(j({ sharedLimits: { status: "degraded" } })[SLT], "quiet", "a build without the second word never pages on the flickering word");
  for (const w of ["on", "memory"]) assert.equal(j({ sharedLimits: { status: w, alert: "ok" } })[SLT], "good", w);
  assert.equal(j({ sharedLimits: { status: "unknown" } })[SLT], "quiet");
  assert.equal(j({})[SLT], "quiet");
});
await check("Worker: replayStore pages only on alert=sustained, clears on ok", () => {
  assert.equal(j({ replayStore: { status: "pending", alert: "sustained" } })[RS], "bad");
  assert.equal(j({ replayStore: { status: "pending", alert: "ok" } })[RS], "quiet");
  assert.equal(j({ replayStore: { status: "pending" } })[RS], "quiet");
  assert.equal(j({ replayStore: { status: "ok", alert: "ok" } })[RS], "good");
  assert.equal(j({ replayStore: { status: "unknown" } })[RS], "quiet");
  assert.equal(j({})[RS], "quiet");
});
await check("Worker: the three bodies are fixed text with no figure", () => {
  for (const T of [GB, SLT, RS]) {
    const a = ALARMS.find((x) => x.title === T);
    assert.ok(a, `the Worker has "${T}"`);
    const b = a.body({ gateway: { gatewayBalance: { status: "<x>", usd: 77 }, sharedLimits: { failures: 77 }, replayStore: { pending: 77 } } });
    assert.equal(b, a.body({ gateway: {} }), "the body does not read the response");
    assert.doesNotMatch(b, /[0-9]|<x>|`|"|\$/, `${T}: no figure, and nothing a shell would expand`);
  }
});

{
  const realFetch = globalThis.fetch;
  let created, closed;
  const mkGh = (open = []) => {
    created = []; closed = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url); const m = (init.method || "GET").toUpperCase();
      if (u === "https://api.github.com/user") return Response.json({ login: "probe-bot" });
      if (u.includes("/issues?state=open")) return Response.json(open.map((x) => ({ user: { login: "probe-bot" }, ...x })));
      if (m === "POST" && /\/issues$/.test(u)) { created.push(JSON.parse(init.body)); return new Response("{}", { status: 201 }); }
      if (m === "PATCH" && /\/issues\/\d+$/.test(u)) { closed.push(u); return new Response("{}", { status: 200 }); }
      return new Response("{}", { status: 200 });
    };
  };
  const ENV = { GITHUB_ISSUES_TOKEN: "t" };
  const run = (gateway) => syncAlarms(ENV, { sleep: async () => {}, confirmDelayMs: 0, fetchStatus: async () => ({ gateway, status: null }) });
  const CASES = [
    [GB, { gatewayBalance: { status: "withdraw" } }, { gatewayBalance: { status: "ok" } }, null],
    [SLT, { sharedLimits: { status: "degraded", alert: "sustained" } }, { sharedLimits: { status: "on", alert: "ok" } }, { sharedLimits: { status: "degraded", alert: "ok" } }],
    [RS, { replayStore: { status: "pending", alert: "sustained" } }, { replayStore: { status: "ok", alert: "ok" } }, { replayStore: { status: "pending", alert: "ok" } }],
  ];
  try {
    for (const [T, bad, good, flicker] of CASES) {
      await check(`Worker: "${T}" opens once on the alert, not on the healthy word, and closes on recovery`, async () => {
        mkGh();
        let r = await run(bad);
        assert.deepEqual(r.opened, [T]);
        assert.equal(created[0].title, T);
        mkGh([{ number: 5, title: T }]);
        r = await run(bad);
        assert.deepEqual([r.opened, r.closed, created.length], [[], [], 0], "an open issue is not duplicated");
        mkGh();
        r = await run(good);
        assert.deepEqual([r.opened, created.length], [[], 0], "the healthy word opens nothing");
        mkGh([{ number: 5, title: T }]);
        r = await run(good);
        assert.deepEqual(r.closed, [T]);
        if (flicker) {
          mkGh();
          r = await run(flicker);
          assert.deepEqual([r.opened, created.length], [[], 0], "the alert word inside its grace period opens nothing");
          mkGh([{ number: 5, title: T }]);
          r = await run(flicker);
          assert.deepEqual([r.closed, closed.length], [[], 0], "and does not close an open issue");
        }
      });
    }
  } finally { globalThis.fetch = realFetch; }
}

// ---- heartbeat.yml, run as written ---------------------------------------------
const src = await readFile(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
const steps = Object.values(yamlLoad(src).jobs).flatMap((x) => x.steps || []);
const dir = await mkdtemp(path.join(tmpdir(), "hb-words-"));
await writeFile(path.join(dir, "curl"), `#!/usr/bin/env bash
printf '%s' "$GS_BODY"
`);
await writeFile(path.join(dir, "gh"), `#!/usr/bin/env bash
if [ "$1 $2" = "issue list" ]; then
  jqx=""; prev=""; for a in "$@"; do [ "$prev" = "--jq" ] && jqx="$a"; prev="$a"; done
  printf '%s' "$ISSUES_JSON" | jq -r "$jqx"; exit 0
fi
printf '%s\\x1f' "$@" >> "$GH_LOG"; printf '\\x1e' >> "$GH_LOG"
`);
await chmod(path.join(dir, "curl"), 0o755);
await chmod(path.join(dir, "gh"), 0o755);
const runStep = async (step, gs, issues = []) => {
  const log = path.join(dir, "gh.log");
  await writeFile(log, "");
  const r = spawnSync("bash", ["-c", step.run], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROD: "https://example.invalid", GITHUB_REPOSITORY: "o/r", GS_BODY: gs === undefined ? "" : JSON.stringify(gs), ISSUES_JSON: JSON.stringify(issues), GH_LOG: log },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return (await readFile(log, "utf8")).split("\x1e").filter((l) => l.trim()).map((l) => l.split("\x1f").filter((x) => x !== ""));
};
const argOf = (call, flag) => call[call.indexOf(flag) + 1];
const HB = [
  // [step name prefix, title, field, alert reading, readings that neither open nor close, healthy readings]
  ["Gateway balance check", GB, "gatewayBalance", { status: "withdraw" }, [{ status: "unknown" }], [{ status: "ok" }, { status: "off" }]],
  ["Shared limits store check", SLT, "sharedLimits", { status: "degraded", alert: "sustained" }, [{ status: "degraded", alert: "ok" }, { status: "degraded" }, { status: "unknown" }], [{ status: "on", alert: "ok" }, { status: "memory", alert: "ok" }]],
  ["Replay store check", RS, "replayStore", { status: "pending", alert: "sustained" }, [{ status: "pending", alert: "ok" }, { status: "pending" }, { status: "unknown" }], [{ status: "ok", alert: "ok" }]],
];
for (const [prefix, T, field, alertRow, quietRows, goodRows] of HB) {
  const step = steps.find((s) => String(s.name || "").startsWith(prefix));
  await check(`heartbeat: "${T}" has a step with the Worker's title and body`, () => {
    assert.ok(step, `heartbeat.yml has a step named "${prefix}..."`);
    assert.ok(step.run.includes(`TITLE="${T}"`), "same title");
    assert.ok(step.run.includes(`.${field}.status`), "reads the word");
    assert.ok(step.run.includes(ALARMS.find((x) => x.title === T).body({})), "same body");
  });
  if (!step) continue;
  await check(`heartbeat: "${T}" opens once on the alert and never on a healthy, flickering or blind read`, async () => {
    const calls = await runStep(step, { [field]: alertRow });
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.deepEqual([calls[0][0], calls[0][1], argOf(calls[0], "--title")], ["issue", "create", T]);
    assert.equal(argOf(calls[0], "--body"), ALARMS.find((x) => x.title === T).body({}), "the body gh receives is the Worker's, unexpanded");
    assert.deepEqual(await runStep(step, { [field]: alertRow }, [{ number: 9, title: T }]), [], "an open issue is not duplicated or commented on");
    for (const row of [...quietRows, ...goodRows]) assert.deepEqual(await runStep(step, { [field]: row }), [], JSON.stringify(row));
    assert.deepEqual(await runStep(step, {}), [], "a build without the word");
    assert.deepEqual(await runStep(step, undefined), [], "an unreadable gateway-status");
  });
  await check(`heartbeat: "${T}" closes on the healthy word only, and only its own issue`, async () => {
    for (const row of goodRows) {
      const calls = await runStep(step, { [field]: row }, [{ number: 9, title: T }, { number: 4, title: `Other ${T}` }]);
      assert.ok(calls.length === 1 && calls[0][1] === "close" && calls[0][2] === "9", `${JSON.stringify(row)}: ${JSON.stringify(calls)}`);
    }
    for (const row of quietRows) assert.deepEqual(await runStep(step, { [field]: row }, [{ number: 9, title: T }]), [], JSON.stringify(row));
    assert.deepEqual(await runStep(step, undefined, [{ number: 9, title: T }]), [], "a blind read never closes");
  });
}

// The daily spend words (xDataSpend, exaSpend): over still serves and capped
// refuses, and the heartbeat pages on both under one issue per upstream. The
// steps are run as written, like the three above.
const SPEND = [
  // [step name, title, field]
  ["X data daily spend over its ceiling", "X data daily spend OVER its ceiling", "xDataSpend"],
  ["Exa daily spend over its ceiling", "Exa daily spend OVER its ceiling", "exaSpend"],
];
for (const [name, T, field] of SPEND) {
  const step = steps.find((s) => String(s.name || "") === name);
  await check(`heartbeat: "${T}" has a step that reads ${field}`, () => {
    assert.ok(step, `heartbeat.yml has a step named "${name}"`);
    assert.ok(step.run.includes(`TITLE="${T}"`), "the title");
    assert.ok(step.run.includes(`.${field}.status`), "reads the word");
  });
  if (!step) continue;
  await check(`heartbeat: "${T}" opens once on over and on capped, never on ok, off or a blind read`, async () => {
    for (const word of ["over", "capped"]) {
      const calls = await runStep(step, { [field]: { status: word } });
      assert.equal(calls.length, 1, `${word}: ${JSON.stringify(calls)}`);
      assert.deepEqual([calls[0][0], calls[0][1], argOf(calls[0], "--title")], ["issue", "create", T], word);
      assert.doesNotMatch(argOf(calls[0], "--body"), /\$[0-9]|[0-9]+\.[0-9]/, `${word}: the public body carries no figure`);
      assert.deepEqual(await runStep(step, { [field]: { status: word } }, [{ number: 9, title: T }]), [], `${word}: an open issue is not duplicated or commented on`);
    }
    for (const word of ["ok", "off", "unknown", "something-new"]) assert.deepEqual(await runStep(step, { [field]: { status: word } }), [], word);
    assert.deepEqual(await runStep(step, {}), [], "a build without the word");
    assert.deepEqual(await runStep(step, undefined), [], "an unreadable gateway-status");
    // The other upstream's word does not page this step.
    const other = SPEND.find((x) => x[2] !== field)[2];
    assert.deepEqual(await runStep(step, { [other]: { status: "over" } }), [], `${other}=over is the other step's`);
  });
  await check(`heartbeat: "${T}" closes on ok and off only, and only its own issue`, async () => {
    for (const word of ["ok", "off"]) {
      const calls = await runStep(step, { [field]: { status: word } }, [{ number: 9, title: T }, { number: 4, title: `Other ${T}` }]);
      assert.ok(calls.length === 1 && calls[0][1] === "close" && calls[0][2] === "9", `${word}: ${JSON.stringify(calls)}`);
    }
    for (const word of ["over", "capped", "unknown"]) assert.deepEqual(await runStep(step, { [field]: { status: word } }, [{ number: 9, title: T }]), [], word);
    assert.deepEqual(await runStep(step, undefined, [{ number: 9, title: T }]), [], "a blind read never closes");
  });
}
await rm(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
