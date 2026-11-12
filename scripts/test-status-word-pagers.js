// Words on /api/gateway-status and their two observers: gatewayBalance
// (withdraw), topBuyerFailures (alert), onchainSqlBusy (alert), sharedLimits (degraded) and
// replayStore (pending). Also the spend words (xDataSpend, exaSpend,
// routerSpendWindow: over and capped), and upstreamHealth and facilitatorFunds
// driven end to end from the monitor (our own timeouts, DNS failures and
// unread balances page nothing), and upstreamHealth=unanswered (a hung
// upstream for several callers pages under its own neutral title; one caller,
// or our side for every upstream, does not).
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
const RSW = "Router spend per minute OVER its ceiling";
const TBF = "topBuyerFailures: a top paying buyer is getting failed answers";
const OSB = "onchainSqlBusy: a top paying buyer was told the query service is busy";
// The six words wired in batch 2026-11-12b: [title, field, alert words, healthy words, words that do neither].
const NEW_WORDS = [
  ["Route judgment token ceiling CAPPED for the day", "jevSpend", ["capped"], ["ok"], ["unknown"]],
  ["External spend global ceiling REFUSING", "externalSpendGlobal", ["refusing"], ["ok", "off"], ["near", "unknown"]],
  ["Solana history reads FAILING on every lane", "solanaHistory", ["failing"], ["publics", "fallback"], ["idle", "unknown"]],
  ["EVM log reads FAILING on every lane", "evmLogs", ["failing"], ["publics", "fallback"], ["idle", "unknown"]],
  ["Speech upstream breaker COOLING (backup voices serving)", "speechUpstream", ["cooling"], ["ok"], ["probing", "unknown"]],
  ["First-call allowance UNAVAILABLE (shared store)", "firstCallAllowance", ["unavailable"], ["on", "spent"], ["off", "unknown"]],
];
const j = (gateway) => judge({ gateway });

await check("Worker: routerSpendWindow pages on over and capped, clears on ok and off", () => {
  for (const w of ["over", "capped"]) assert.equal(j({ routerSpendWindow: { status: w } })[RSW], "bad", w);
  for (const w of ["ok", "off"]) assert.equal(j({ routerSpendWindow: { status: w } })[RSW], "good", w);
  for (const w of ["unknown", "something-new"]) assert.equal(j({ routerSpendWindow: { status: w } })[RSW], "quiet", w);
  assert.equal(j({})[RSW], "quiet", "a build without the word changes nothing");
  const a = ALARMS.find((x) => x.title === RSW);
  const b = a.body({ gateway: { routerSpendWindow: { status: "<x>", alarmAtomic: "77", hardAtomic: "77" } } });
  assert.equal(b, a.body({ gateway: {} }), "the body does not read the response");
  assert.doesNotMatch(b, /[0-9]|<x>|`|"|\$/, "no figure, and nothing a shell would expand");
});

await check("Worker: topBuyerFailures pages on alert, clears on ok; unknown, off and absent do neither", () => {
  assert.equal(j({ topBuyerFailures: { status: "alert" } })[TBF], "bad");
  assert.equal(j({ topBuyerFailures: { status: "ok" } })[TBF], "good");
  for (const w of ["unknown", "off", "something-new"]) assert.equal(j({ topBuyerFailures: { status: w } })[TBF], "quiet", w);
  assert.equal(j({})[TBF], "quiet", "a build without the word changes nothing");
  const a = ALARMS.find((x) => x.title === TBF);
  const b = a.body({ gateway: { topBuyerFailures: { status: "alert", alerting: [{ payer: "7xKX", rank: 1, failures: [{ slug: "onchain-sql", status: 502, error: "<x>" }] }] } } });
  assert.equal(b, a.body({ gateway: {} }), "the body does not read the response");
  assert.doesNotMatch(b, /[0-9]|<x>|7xKX|onchain-sql|`|"|\$/, "no payer, no tool, no figure, and nothing a shell would expand");
  assert.match(b, /operator view of \/api\/gateway-status \(topBuyerFailures/, "it points at the operator view");
});

await check("Worker: onchainSqlBusy pages on alert, clears on ok; unknown, off and absent do neither", () => {
  assert.equal(j({ onchainSqlBusy: { status: "alert" } })[OSB], "bad");
  assert.equal(j({ onchainSqlBusy: { status: "ok" } })[OSB], "good");
  for (const w of ["unknown", "off", "something-new"]) assert.equal(j({ onchainSqlBusy: { status: w } })[OSB], "quiet", w);
  assert.equal(j({})[OSB], "quiet", "a build without the word changes nothing");
  assert.equal(j({ topBuyerFailures: { status: "alert" } })[OSB], "quiet", "a top payer's other failures do not raise it");
  const a = ALARMS.find((x) => x.title === OSB);
  const b = a.body({ gateway: { onchainSqlBusy: { status: "alert", alerting: [{ payer: "7xKX", rank: 1, refusals: [{ at: "2026-11-11T00:00:00.000Z", slug: "onchain-sql", status: 429 }] }] } } });
  assert.equal(b, a.body({ gateway: {} }), "the body does not read the response");
  assert.doesNotMatch(b, /[0-9]|7xKX|onchain-sql|`|"|\$/, "no payer, no slug, no figure, and nothing a shell would expand");
  assert.match(b, /operator view of \/api\/gateway-status \(onchainSqlBusy/, "it points at the operator view");
});

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
for (const [T, field, bad, good, neither] of NEW_WORDS) {
  await check(`Worker: ${field} pages on ${bad.join(" and ")}, clears on ${good.join(" and ")}; ${neither.join(", ")} and absent do neither`, () => {
    for (const w of bad) assert.equal(j({ [field]: { status: w } })[T], "bad", w);
    for (const w of good) assert.equal(j({ [field]: { status: w } })[T], "good", w);
    for (const w of [...neither, "something-new"]) assert.equal(j({ [field]: { status: w } })[T], "quiet", w);
    assert.equal(j({})[T], "quiet", "a build without the word changes nothing");
    const others = NEW_WORDS.filter((x) => x[1] !== field);
    for (const [, f, ob] of others) assert.equal(j({ [f]: { status: ob[0] } })[T], "quiet", `${f}=${ob[0]} is another alarm's`);
    const a = ALARMS.find((x) => x.title === T);
    const b = a.body({ gateway: { [field]: { status: "<x>", tokens: 77, capTokens: 77 } } });
    assert.equal(b, a.body({ gateway: {} }), "the body does not read the response");
    assert.doesNotMatch(b, /[0-9]|<x>|`|"|\$/, "no figure, and nothing a shell would expand");
  });
}

await check("Worker: the three bodies are fixed text with no figure", () => {
  for (const T of [GB, SLT, RS, TBF]) {
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
    [RSW, { routerSpendWindow: { status: "over" } }, { routerSpendWindow: { status: "ok" } }, null],
    [TBF, { topBuyerFailures: { status: "alert" } }, { topBuyerFailures: { status: "ok" } }, { topBuyerFailures: { status: "unknown" } }],
    [OSB, { onchainSqlBusy: { status: "alert" } }, { onchainSqlBusy: { status: "ok" } }, { onchainSqlBusy: { status: "unknown" } }],
    [RSW, { routerSpendWindow: { status: "capped" } }, { routerSpendWindow: { status: "off" } }, null],
    [SLT, { sharedLimits: { status: "degraded", alert: "sustained" } }, { sharedLimits: { status: "on", alert: "ok" } }, { sharedLimits: { status: "degraded", alert: "ok" } }],
    [RS, { replayStore: { status: "pending", alert: "sustained" } }, { replayStore: { status: "ok", alert: "ok" } }, { replayStore: { status: "pending", alert: "ok" } }],
    ...NEW_WORDS.map(([T, field, bad, good, neither]) => [T, { [field]: { status: bad[0] } }, { [field]: { status: good[0] } }, { [field]: { status: neither[0] } }]),
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
  ["Top buyer failures check", TBF, "topBuyerFailures", { status: "alert" }, [{ status: "unknown" }, { status: "off" }], [{ status: "ok" }]],
  ["Onchain SQL busy check", OSB, "onchainSqlBusy", { status: "alert" }, [{ status: "unknown" }, { status: "off" }], [{ status: "ok" }]],
  ["Shared limits store check", SLT, "sharedLimits", { status: "degraded", alert: "sustained" }, [{ status: "degraded", alert: "ok" }, { status: "degraded" }, { status: "unknown" }], [{ status: "on", alert: "ok" }, { status: "memory", alert: "ok" }]],
  ["Replay store check", RS, "replayStore", { status: "pending", alert: "sustained" }, [{ status: "pending", alert: "ok" }, { status: "pending" }, { status: "unknown" }], [{ status: "ok", alert: "ok" }]],
  ["Route judgment ceiling check", NEW_WORDS[0][0], "jevSpend", { status: "capped" }, [{ status: "unknown" }], [{ status: "ok" }]],
  ["External spend global ceiling check", NEW_WORDS[1][0], "externalSpendGlobal", { status: "refusing" }, [{ status: "near" }, { status: "unknown" }], [{ status: "ok" }, { status: "off" }]],
  ["Solana history reads check", NEW_WORDS[2][0], "solanaHistory", { status: "failing" }, [{ status: "idle" }, { status: "unknown" }], [{ status: "publics" }, { status: "fallback" }]],
  ["EVM log reads check", NEW_WORDS[3][0], "evmLogs", { status: "failing" }, [{ status: "idle" }, { status: "unknown" }], [{ status: "publics" }, { status: "fallback" }]],
  ["Speech upstream check", NEW_WORDS[4][0], "speechUpstream", { status: "cooling" }, [{ status: "probing" }, { status: "unknown" }], [{ status: "ok" }]],
  ["First-call allowance check", NEW_WORDS[5][0], "firstCallAllowance", { status: "unavailable" }, [{ status: "off" }, { status: "unknown" }], [{ status: "on" }, { status: "spent" }]],
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
// routerSpendWindow (src/router-spend-window.js) carries the same two words for
// the router's per-minute holds; its body is the Worker's, word for word.
const SPEND = [
  // [step name, title, field, the body is the Worker's]
  ["X data daily spend over its ceiling", "X data daily spend OVER its ceiling", "xDataSpend"],
  ["Exa daily spend over its ceiling", "Exa daily spend OVER its ceiling", "exaSpend"],
  ["Router spend per minute over its ceiling", RSW, "routerSpendWindow", true],
];
for (const [name, T, field, sameBody] of SPEND) {
  const step = steps.find((s) => String(s.name || "") === name);
  await check(`heartbeat: "${T}" has a step that reads ${field}`, () => {
    assert.ok(step, `heartbeat.yml has a step named "${name}"`);
    assert.ok(step.run.includes(`TITLE="${T}"`), "the title");
    assert.ok(step.run.includes(`.${field}.status`), "reads the word");
    if (sameBody) assert.ok(step.run.includes(ALARMS.find((x) => x.title === T).body({})), "the Worker's body");
  });
  if (!step) continue;
  await check(`heartbeat: "${T}" opens once on over and on capped, never on ok, off or a blind read`, async () => {
    for (const word of ["over", "capped"]) {
      const calls = await runStep(step, { [field]: { status: word } });
      assert.equal(calls.length, 1, `${word}: ${JSON.stringify(calls)}`);
      assert.deepEqual([calls[0][0], calls[0][1], argOf(calls[0], "--title")], ["issue", "create", T], word);
      assert.doesNotMatch(argOf(calls[0], "--body"), /\$[0-9]|[0-9]+\.[0-9]/, `${word}: the public body carries no figure`);
      if (sameBody) assert.equal(argOf(calls[0], "--body"), ALARMS.find((x) => x.title === T).body({}), `${word}: the body gh receives is the Worker's, unexpanded`);
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
// ---- upstreamHealth and facilitatorFunds, end to end -----------------------------
// The words come from a real monitor fed the outcomes the server sees: our own
// AbortSignal.timeout and DNS failures through the egress observer, then the
// upstream's own 5xx answers; the gas checker's unread rows, then a real low
// reading. Each reading is judged by the Worker and run through heartbeat.yml's
// step as written: our own failures page nothing, the upstream's own failure
// pages once, and recovery closes it.
{
  const { createToolFailureMonitor } = await import("../src/tool-failure-monitor.js");
  const UH = "upstreamHealth: an upstream is timing out or failing";
  const FG = "facilitatorFunds: a facilitator's settlement gas is running low";
  const step = steps.find((s) => String(s.name || "").startsWith("Tool, upstream and facilitator failure checks"));
  let t = Date.parse("2026-11-10T12:00:00Z");
  const m = createToolFailureMonitor({ now: () => t, env: {} });
  const words = async () => {
    const st = await m.status({ fresh: true, t });
    return { upstreamHealth: st.upstreamHealth, facilitatorFunds: st.facilitatorFunds };
  };
  const created = (calls, T) => calls.filter((c) => c[1] === "create" && argOf(c, "--title") === T).length;
  const closedNum = (calls) => calls.filter((c) => c[1] === "close").map((c) => c[2]);
  const ourTimeout = () => { const ac = new AbortController(); ac.abort(new DOMException("t", "TimeoutError")); const p = Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")); p.catch(() => {}); return [p, { signal: ac.signal }]; };
  const ourDns = () => { const p = Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } })); p.catch(() => {}); return [p, {}]; };
  for (let i = 0; i < 40; i++) { const [p, init] = i % 2 ? ourTimeout() : ourDns(); m.observeFetch("hist.databento.com", p, init, "outside"); }
  await new Promise((r) => setTimeout(r, 0));
  let gw = await words();
  await check("upstreamHealth: forty of our own timeouts and DNS failures read ok; the Worker and the heartbeat page nothing", async () => {
    assert.equal(gw.upstreamHealth.status, "ok");
    assert.notEqual(judge({ gateway: gw })[UH], "bad");
    assert.equal(created(await runStep(step, gw), UH), 0);
  });
  for (let i = 0; i < 6; i++) m.observeFetch("hist.databento.com", Promise.resolve(new Response("x", { status: 502 })), {}, "outside");
  await new Promise((r) => setTimeout(r, 0));
  gw = await words();
  await check("upstreamHealth: the upstream's own 502s page once under the title, and an open issue is not duplicated", async () => {
    assert.ok(["degraded", "failing"].includes(gw.upstreamHealth.status), gw.upstreamHealth.status);
    assert.equal(judge({ gateway: gw })[UH], "bad");
    assert.equal(created(await runStep(step, gw), UH), 1);
    assert.equal(created(await runStep(step, gw, [{ number: 7, title: UH }]), UH), 0);
  });
  t += 2 * 3_600_000; // the hour the word reads has passed
  gw = await words();
  await check("upstreamHealth: once the failures age out the word reads ok and the issue closes", async () => {
    assert.equal(gw.upstreamHealth.status, "ok");
    assert.equal(judge({ gateway: gw })[UH], "good");
    assert.deepEqual(closedNum(await runStep(step, gw, [{ number: 7, title: UH }])), ["7"]);
  });
  // Gas: our failed balance reads are not a low balance.
  const NET = "eip155:4663";
  const row = (status, extra = {}) => ({ network: NET, facilitator: "listed", signer: "0x" + "1".repeat(40), status, runway: status === "low" ? 10 : status === "ok" ? 5000 : null, at: t, ...extra });
  m.noteRelayerGas([row("unread", { failures: 3 })]);
  gw = await words();
  await check("facilitatorFunds: a signer our checker could not read reads unknown, and neither pages nor closes", async () => {
    assert.equal(gw.facilitatorFunds.status, "unknown");
    assert.equal(judge({ gateway: gw })[FG], "quiet");
    assert.equal(created(await runStep(step, gw), FG), 0);
    assert.deepEqual(closedNum(await runStep(step, gw, [{ number: 8, title: FG }])), []);
  });
  m.noteRelayerGas([row("low"), row("unread", { signer: "0x" + "2".repeat(40) })]);
  gw = await words();
  await check("facilitatorFunds: a real low balance still pages once, unread rows beside it or not", async () => {
    assert.equal(gw.facilitatorFunds.status, "low");
    assert.equal(judge({ gateway: gw })[FG], "bad");
    assert.equal(created(await runStep(step, gw), FG), 1);
  });
  m.noteRelayerGas([row("ok")]);
  gw = await words();
  await check("facilitatorFunds: a funded signer reads ok and closes the issue", async () => {
    assert.equal(gw.facilitatorFunds.status, "ok");
    assert.equal(judge({ gateway: gw })[FG], "good");
    assert.deepEqual(closedNum(await runStep(step, gw, [{ number: 8, title: FG }])), ["8"]);
  });
  // The issue opened under the title before its rename: both pagers close it
  // when the word reads ok, low or unknown (the new titles take over those
  // states, so it never stays open beside them), and neither ever opens it,
  // on any word.
  const OLD = "facilitatorFunds: a facilitator's settlement gas is running low or could not be read";
  await check("facilitatorFunds: the issue under the old title closes on ok, low or unknown and is never opened", async () => {
    for (const w of ["ok", "low", "unknown"]) {
      const g = { facilitatorFunds: { status: w } };
      assert.equal(judge({ gateway: g })[OLD], "good", `Worker: ${w}`);
      assert.deepEqual(closedNum(await runStep(step, g, [{ number: 11, title: OLD }, { number: 4, title: `Other ${OLD}` }])), ["11"], `heartbeat: ${w} closes the old issue`);
      assert.equal(created(await runStep(step, g), OLD), 0, `heartbeat: ${w} opens nothing under the old title`);
    }
    for (const w of ["refused", "demoted", "", "something-new"]) {
      const g = { facilitatorFunds: { status: w } };
      assert.equal(judge({ gateway: g })[OLD], "quiet", `Worker: ${w || "(empty)"}`);
      const calls = await runStep(step, g, [{ number: 11, title: OLD }]);
      assert.equal(calls.filter((c) => argOf(c, "--title") === OLD || c[2] === "11").length, 0, `heartbeat: ${w || "(empty)"}: ${JSON.stringify(calls)}`);
      assert.equal(created(await runStep(step, g), OLD), 0, `heartbeat: ${w || "(empty)"} opens nothing under the old title`);
    }
    assert.deepEqual(closedNum(await runStep(step, undefined, [{ number: 11, title: OLD }])), [], "a blind read never closes it");
    // The Worker's own sync: ok closes the open issue; low opens only the new title.
    const realFetch = globalThis.fetch;
    let made = [], shut = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url); const meth = (init.method || "GET").toUpperCase();
      if (u === "https://api.github.com/user") return Response.json({ login: "probe-bot" });
      if (u.includes("/issues?state=open")) return Response.json([{ number: 11, title: OLD, user: { login: "probe-bot" } }]);
      if (meth === "POST" && /\/issues$/.test(u)) { made.push(JSON.parse(init.body).title); return new Response("{}", { status: 201 }); }
      if (meth === "PATCH" && /\/issues\/\d+$/.test(u)) { shut.push(u); return new Response("{}", { status: 200 }); }
      return new Response("{}", { status: 200 });
    };
    try {
      const sync = (g) => syncAlarms({ GITHUB_ISSUES_TOKEN: "t" }, { sleep: async () => {}, confirmDelayMs: 0, fetchStatus: async () => ({ gateway: g, status: null }) });
      let r = await sync({ facilitatorFunds: { status: "refused" } });
      assert.ok(!r.opened.includes(OLD) && !r.closed.includes(OLD) && !made.includes(OLD), `Worker: refused leaves the old issue alone (${JSON.stringify(r)})`);
      for (const w of ["low", "unknown", "ok"]) {
        made = []; shut = [];
        r = await sync({ facilitatorFunds: { status: w } });
        assert.ok(r.closed.includes(OLD) && shut.some((u) => /\/issues\/11$/.test(u)) && !made.includes(OLD), `Worker: ${w} closes the old issue and never reopens it (${JSON.stringify(r)})`);
      }
    } finally { globalThis.fetch = realFetch; }
  });
  // An unread signer held for hours: a real monitor fed a fresh unread
  // reading every ten minutes reads unknown with alert ok for the first six
  // hours (nothing pages), then alert sustained, which pages once under its
  // own title in both pagers; the balance read again (ok) closes it.
  {
    const UR = "facilitatorFunds: a settlement signer's balance could not be read for hours";
    let tu = Date.parse("2026-11-10T00:00:00Z");
    const mu = createToolFailureMonitor({ now: () => tu, env: {} });
    const unreadRow = () => ({ network: NET, facilitator: "listed", signer: "0x" + "3".repeat(40), status: "unread", failures: 3, runway: null, at: tu });
    const read = async () => { const st = await mu.status({ fresh: true, t: tu }); return { facilitatorFunds: st.facilitatorFunds }; };
    const t0 = tu;
    let g;
    await check("facilitatorFunds: unknown for under six hours pages nothing; the alert word reads ok", async () => {
      for (; tu < t0 + 6 * 3_600_000 - 10 * 60_000; tu += 10 * 60_000) mu.noteRelayerGas([unreadRow()]);
      g = await read();
      assert.deepEqual([g.facilitatorFunds.status, g.facilitatorFunds.alert], ["unknown", "ok"]);
      assert.equal(judge({ gateway: g })[UR], "quiet");
      assert.equal(created(await runStep(step, g), UR), 0);
      const full = await mu.status({ fresh: true, t: tu, full: true });
      assert.equal(full.facilitatorFunds.unreadSince, new Date(t0).toISOString(), "the operator view carries when the signer first read unread");
    });
    await check("facilitatorFunds: unknown held past six hours reads alert sustained and pages once in both pagers", async () => {
      tu += 20 * 60_000; mu.noteRelayerGas([unreadRow()]);
      g = await read();
      assert.deepEqual([g.facilitatorFunds.status, g.facilitatorFunds.alert], ["unknown", "sustained"]);
      assert.equal(judge({ gateway: g })[UR], "bad");
      assert.equal(judge({ gateway: g })[FG], "quiet", "the low title stays quiet");
      const calls = await runStep(step, g);
      assert.equal(created(calls, UR), 1);
      assert.equal(calls.filter((c) => c[1] === "create").length, 1, `only the unread title opens (${JSON.stringify(calls)})`);
      assert.equal(created(await runStep(step, g, [{ number: 12, title: UR }]), UR), 0, "an open issue is not duplicated");
    });
    await check("facilitatorFunds: a sustained alert under a word that is not unknown pages nothing; a blind read neither opens nor closes", async () => {
      for (const st of ["ok", "refused", "low"]) assert.notEqual(judge({ gateway: { facilitatorFunds: { status: st, alert: "sustained" } } })[UR], "bad", st);
      assert.equal(created(await runStep(step, { facilitatorFunds: { status: "refused", alert: "sustained" } }), UR), 0);
      assert.deepEqual(closedNum(await runStep(step, undefined, [{ number: 12, title: UR }])), []);
    });
    await check("facilitatorFunds: the balance read again closes the unread issue", async () => {
      tu += 10 * 60_000; mu.noteRelayerGas([{ ...unreadRow(), status: "ok", runway: 5000 }]);
      g = await read();
      assert.deepEqual([g.facilitatorFunds.status, g.facilitatorFunds.alert], ["ok", "ok"]);
      assert.equal(judge({ gateway: g })[UR], "good");
      assert.deepEqual(closedNum(await runStep(step, g, [{ number: 12, title: UR }])), ["12"]);
      tu += 10 * 60_000; mu.noteRelayerGas([unreadRow()]);
      g = await read();
      assert.deepEqual([g.facilitatorFunds.status, g.facilitatorFunds.alert], ["unknown", "ok"], "a new unread spell starts its own clock");
    });
  }
}
// ---- upstreamHealth=unanswered, end to end -----------------------------------------
// A hung stub upstream: our AbortSignal.timeout fires on every call to it, for
// five callers, while another upstream answers. The monitor reads unanswered;
// the Worker and heartbeat.yml page once under the neutral title (not the
// "timing out or failing" one) with a body that names no upstream, and close
// it once the window passes. One caller's long inputs, and our egress or our
// deadline on every upstream at once, page nothing.
{
  const { createToolFailureMonitor } = await import("../src/tool-failure-monitor.js");
  const UN = "upstreamHealth: an upstream did not answer within our limit";
  const UH = "upstreamHealth: an upstream is timing out or failing";
  const step = steps.find((s) => String(s.name || "").startsWith("Tool, upstream and facilitator failure checks"));
  const start = Date.parse("2026-11-10T15:00:00Z");
  const created = (calls, T) => calls.filter((c) => c[1] === "create" && argOf(c, "--title") === T);
  const closedNum = (calls) => calls.filter((c) => c[1] === "close").map((c) => c[2]);
  const hungCall = (m, host, caller, { heavy = false } = {}) => {
    const signal = AbortSignal.abort(new DOMException("t", "TimeoutError"));
    signal[Symbol.for("agent402.upstreamLimitMs")] = 25_000;
    if (heavy) signal[Symbol.for("agent402.upstreamHeavyInput")] = true;
    const p = Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")); p.catch(() => {});
    m.observeFetch(host, p, { signal }, "outside", null, () => caller);
  };
  const dnsCall = (m, host) => { const p = Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } })); p.catch(() => {}); m.observeFetch(host, p, {}, "outside", null, () => "x"); };
  const answered = (m, host, n) => { for (let i = 0; i < n; i++) m.observeFetch(host, Promise.resolve(new Response("x")), {}, "outside"); };
  const read = async (m, t) => ({ upstreamHealth: (await m.status({ fresh: true, t })).upstreamHealth });
  let t = start;
  const m = createToolFailureMonitor({ now: () => t, env: {} });
  for (let i = 0; i < 6; i++) hungCall(m, "hist.databento.com", `caller-${i % 5}`);
  answered(m, "api.exa.ai", 8);
  await new Promise((r) => setTimeout(r, 0));
  let gw = await read(m, t);
  await check("unanswered: a hung upstream for five callers pages once under the neutral title, with a body that names no upstream", async () => {
    assert.deepEqual(gw.upstreamHealth, { status: "unanswered" });
    const v = judge({ gateway: gw });
    assert.equal(v[UN], "bad");
    assert.notEqual(v[UH], "bad", "not the timing-out-or-failing page");
    const worker = ALARMS.find((x) => x.title === UN);
    assert.ok(worker, "the Worker has the alarm");
    assert.doesNotMatch(worker.body({ gateway: gw }), /databento|failing|failed|outage|is down/i);
    const calls = await runStep(step, gw);
    assert.equal(created(calls, UN).length, 1, JSON.stringify(calls));
    assert.equal(created(calls, UH).length, 0);
    assert.equal(argOf(created(calls, UN)[0], "--body"), worker.body({ gateway: gw }), "the heartbeat's body is the Worker's");
    assert.equal(created(await runStep(step, gw, [{ number: 11, title: UN }]), UN).length, 0, "an open issue is not duplicated");
    const full = await m.status({ full: true, fresh: true, t });
    assert.equal(full.upstreamHealth.upstreams[0].unanswered, "databento did not answer within our 25 s limit on 6 of 6 calls from 5 callers in 15 min", "the operator detail");
  });
  t += 20 * 60_000;
  gw = await read(m, t);
  await check("unanswered: once the window passes the word reads ok and the issue closes", async () => {
    assert.equal(gw.upstreamHealth.status, "ok");
    assert.equal(judge({ gateway: gw })[UN], "good");
    assert.deepEqual(closedNum(await runStep(step, gw, [{ number: 11, title: UN }])), ["11"]);
  });
  const quiet = async (label, feed) => {
    const q = createToolFailureMonitor({ now: () => start, env: {} });
    feed(q);
    await new Promise((r) => setTimeout(r, 0));
    const g = await read(q, start);
    await check(`unanswered: ${label} pages nothing`, async () => {
      assert.equal(g.upstreamHealth.status, "ok", JSON.stringify(g));
      const v = judge({ gateway: g });
      assert.notEqual(v[UN], "bad"); assert.notEqual(v[UH], "bad");
      const calls = await runStep(step, g);
      assert.equal(created(calls, UN).length + created(calls, UH).length, 0, JSON.stringify(calls));
    });
  };
  await quiet("one caller's long inputs held past our limit twenty times", (q) => { for (let i = 0; i < 20; i++) hungCall(q, "hist.databento.com", "caller-long", { heavy: true }); answered(q, "api.exa.ai", 8); });
  await quiet("one slow call", (q) => { hungCall(q, "hist.databento.com", "caller-1"); answered(q, "api.exa.ai", 8); });
  const ALL = ["hist.databento.com", "api.exa.ai", "openrouter.ai", "api.stlouisfed.org"];
  await quiet("our egress failing for every upstream", (q) => { for (const h of ALL) for (let i = 0; i < 10; i++) dnsCall(q, h); });
  await quiet("our deadline on every upstream at once, for many callers", (q) => { for (const h of ALL) for (let i = 0; i < 8; i++) hungCall(q, h, `caller-${i}`); });
}
// ---- the rail check: a dropped Circle Gateway batched option ---------------------
// /api/rails carries gatewayBatched.dropped (each network with its reason word)
// while the option is switched on; the heartbeat's rail check counts it beside
// degraded rails, opens one "Settlement rail DEGRADED" issue naming it, and
// closes it once nothing is dropped.
{
  const RT = "Settlement rail DEGRADED";
  const step = steps.find((s) => String(s.name || "").startsWith("Rail check"));
  const rails = (dropped, degraded = 0) => ({ configured: 2, offered: 2 - degraded, degraded, rails: [{ network: "base", caip2: "eip155:8453", offered: true, reason: null }, ...(degraded ? [{ network: "celo", caip2: "eip155:42220", offered: false, reason: "not offered - x (probe-timeout)", reasonWord: "probe-timeout" }] : [])], ...(dropped === undefined ? {} : { gatewayBatched: { networks: [], status: dropped.length ? "dropped" : "offered", dropped } }) });
  const runRail = async (body, issues = []) => {
    const calls = await runStep(step, body, issues);
    let file = "";
    try { file = await readFile("/tmp/rail-body.md", "utf8"); } catch { /* not written */ }
    return { calls, file };
  };
  await check("rail check: a batched option dropped on probe-timeout opens one issue naming it; the plain rails all offered", async () => {
    assert.ok(step, "heartbeat.yml has the rail check");
    const { calls, file } = await runRail(rails([{ network: "eip155:8453", reason: "probe-timeout" }]));
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.deepEqual([calls[0][0], calls[0][1], argOf(calls[0], "--title")], ["issue", "create", RT]);
    assert.match(file, /Circle Gateway batched option on eip155:8453\*\* - not offered \(probe-timeout\)/);
    assert.deepEqual((await runRail(rails([{ network: "eip155:8453", reason: "probe-timeout" }]), [{ number: 3, title: RT }])).calls, [], "an open issue is not duplicated");
  });
  await check("rail check: nothing dropped closes the issue; no batched field and an unreadable read do nothing", async () => {
    const { calls } = await runRail(rails([]), [{ number: 3, title: RT }]);
    assert.ok(calls.length === 1 && calls[0][1] === "close" && calls[0][2] === "3", JSON.stringify(calls));
    assert.deepEqual((await runRail(rails(undefined))).calls, [], "the option off: no issue");
    assert.deepEqual((await runRail(undefined, [{ number: 3, title: RT }])).calls, [], "a blind read never closes");
  });
  await check("rail check: not-in-offer and probe-skipped are configuration facts: they never open the issue, and alone they close it", async () => {
    for (const reason of ["not-in-offer", "probe-skipped"]) {
      assert.deepEqual((await runRail(rails([{ network: "arc", reason }]))).calls, [], `${reason}: no issue`);
      const { calls } = await runRail(rails([{ network: "arc", reason }]), [{ number: 3, title: RT }]);
      assert.ok(calls.length === 1 && calls[0][1] === "close" && calls[0][2] === "3", `${reason}: closes (${JSON.stringify(calls)})`);
    }
    for (const reason of ["probe-timeout", "read-failed", "not-advertised"]) {
      const { calls, file } = await runRail(rails([{ network: "arc", reason: "not-in-offer" }, { network: "eip155:8453", reason }]));
      assert.equal(calls.filter((c) => c[1] === "create").length, 1, `${reason} beside not-in-offer pages once`);
      assert.match(file, new RegExp(`batched option on eip155:8453\\*\\* - not offered \\(${reason}\\)`));
      assert.doesNotMatch(file, /not-in-offer/, `${reason}: the body lists only the failure`);
    }
  });
  await check("rail check: a degraded plain rail still pages as before", async () => {
    const { calls, file } = await runRail(rails(undefined, 1));
    assert.equal(calls.filter((c) => c[1] === "create").length, 1);
    assert.match(file, /\*\*celo\*\* - not offered - x \(probe-timeout\)/);
  });
}
await rm(dir, { recursive: true, force: true });

// ---- every status word has a pager ---------------------------------------------
// A word on /api/gateway-status that no alarm reads pages nobody however it
// reads. The words are read from a real boot (FREE_MODE, the first-call
// allowance switched on so its conditional word is there), and each must be
// read by a status Worker alarm's verdict. No word is excused. sanctionsScreen
// appears only while Tempo direct mode is mounted, so it is named here.
// loopLag ({watching}) and mppEvmDomainFallback ({enabled}) publish a flag,
// not a status word: their figures stay on the operator view on purpose
// (scripts/test-gateway-status-privacy.js), so there is nothing to page on.
{
  const { bootServer } = await import("./lib/boot-server.js");
  let srv = null;
  try {
    srv = await bootServer({ stores: "status-word-pagers", env: { FREE_MODE: "true", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", FIRST_CALL_ALLOWANCE: "on", REDIS_URL: "", SOR_EVM_CHAINS: "" } });
    const body = await (await fetch(`${srv.url}/api/gateway-status`)).json();
    const hasWord = (v) => v && typeof v === "object" && (typeof v.status === "string" || Object.values(v).some((x) => x && typeof x === "object" && typeof x.status === "string"));
    const words = [...new Set([...Object.keys(body).filter((k) => hasWord(body[k])), "sanctionsScreen"])];
    const readers = ALARMS.map((a) => String(a.verdict));
    const unread = words.filter((k) => !readers.some((src) => new RegExp(`\\bb\\??\\.${k}\\b`).test(src)));
    await check(`every status word on /api/gateway-status is read by a status Worker alarm (${words.length} words)`, () => {
      assert.ok(words.length >= 50, `the boot published its words (${words.length})`);
      for (const k of ["firstCallAllowance", "jevSpend", "externalSpendGlobal", "solanaHistory", "evmLogs", "speechUpstream"]) assert.ok(words.includes(k), `${k} is among them`);
      assert.deepEqual(unread, [], `words no alarm reads: ${unread.join(", ")}`);
    });
    await check("loopLag and mppEvmDomainFallback publish a flag, not a status word", () => {
      assert.deepEqual(Object.keys(body.loopLag || {}), ["watching"]);
      assert.deepEqual(Object.keys(body.mppEvmDomainFallback || {}), ["enabled"]);
    });
  } finally { await srv?.stop(); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
