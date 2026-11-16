// The direct upstream's daily spend and balance words
// (src/direct-upstream-spend.js), driven through the chat wire
// (src/tools/llm-gateway-kit.js) against two stubs on 127.0.0.1 (port 0): the
// direct upstream and OpenRouter. Pins:
//   - the threshold variable: default, off, 0 and malformed;
//   - every answer the direct upstream bills books the day once, at its own
//     reported charge, plain and streamed; one without a charge is estimated
//     from its tokens at the cost table's row; an unknown model is unpriced;
//     an OpenRouter answer books nothing;
//   - the word reads ok under the threshold, high at it, off unconfigured or
//     with the alarm off, and publishes the word alone; and high never refuses,
//     caps or reroutes a call: the next calls still go direct and are served;
//   - a new process reads directUpstreamBalance starting (neither outcome
//     seen; a failure of another kind does not decide it), so a deploy never
//     closes an open balance issue;
//   - a prepaid balance that ran out (402 from the direct stub): every call is
//     served by OpenRouter, directUpstreamBalance reads exhausted, three in a
//     row open the breaker (directUpstream degraded) and the next calls go to
//     OpenRouter at once; a served direct answer clears both;
//   - the status Worker and heartbeat.yml page each word under one title with
//     a body that carries no figure, close on ok and off, and do neither on
//     unknown or starting.
// The cost table is the format example's placeholder rows; every figure is
// derived from a stub's own charge or a placeholder row, never typed.
// Offline: no network, no real keys, no spend.
//
//   node scripts/test-direct-upstream-spend.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";

delete process.env.UPSTREAM_COSTS_JSON;
delete process.env.UPSTREAM_COSTS_FILE;
for (const k of Object.keys(process.env)) if (k.startsWith("DIRECT_UPSTREAM_")) delete process.env[k];
process.env.OPENROUTER_API_KEY = "test-key";
process.env.GATEWAY_METERED_BILLING = "on";

const U = await import("../src/upstream-costs.js");
const K = await import("../src/tools/llm-gateway-kit.js");
const D = await import("../src/gateway-direct-upstream.js");
const PB = await import("../src/gateway-direct-pricebook.js");
const S = await import("../src/direct-upstream-spend.js");

const example = JSON.parse(readFileSync(new URL("../docs/example-upstream-costs.json", import.meta.url), "utf8"));
const placeholder = example.models.find(([p]) => p === "openai/")[1];
U.setUpstreamCostsForTest({ ...example, models: [...example.models, ["deepseek/", placeholder]] });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };

// ---- stubs -------------------------------------------------------------------
function stub() {
  const s = { hits: [], plan: null };
  s.server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* recorded as null */ }
      s.hits.push({ url: req.url, body });
      try { await s.plan(req, res, body); } catch { try { res.destroy(); } catch { /* gone */ } }
    });
  });
  return s;
}
const json = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const sse = (res, frames) => { res.writeHead(200, { "content-type": "text/event-stream" }); for (const f of frames) res.write(`data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`); res.end(); };
const USAGE = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
const answer = (model, extra = {}) => ({ id: "c", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { ...USAGE }, ...extra });
const DIRECT_MICRO = 123;
const OR_COST = 0.000321;
const directOk = (req, res, body) => json(res, 200, answer(body.model, { x_vendor: { charged_micro: DIRECT_MICRO } }));
const directNoCharge = (req, res, body) => json(res, 200, answer(body.model, { usage: { ...USAGE } }));
const directBroke = (req, res) => json(res, 402, { error: { message: "insufficient balance", type: "insufficient_quota", code: "insufficient_quota" } });
const orOk = (req, res, body) => json(res, 200, answer(body?.model, { usage: { ...USAGE, cost: OR_COST } }));

const direct = stub(), or = stub();
await new Promise((r) => direct.server.listen(0, "127.0.0.1", r));
await new Promise((r) => or.server.listen(0, "127.0.0.1", r));
const DIRECT_PORT = direct.server.address().port, OR_PORT = or.server.address().port;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://openrouter.ai/api/v1/chat/completions")) return realFetch(`http://127.0.0.1:${OR_PORT}/api/v1/chat/completions`, init);
  if (u.startsWith(`http://127.0.0.1:${DIRECT_PORT}/`)) return realFetch(url, init);
  throw new Error(`test: unexpected outbound fetch to ${u.slice(0, 60)}`);
};

const MODEL = "deepseek/deepseek-v4.1-flash-1017";
const ON = { DIRECT_UPSTREAM_URL: `http://127.0.0.1:${DIRECT_PORT}/v1`, DIRECT_UPSTREAM_KEY: "direct-test-key", DIRECT_UPSTREAM_MODELS: `${MODEL}=deepseek-v4.1-flash`, DIRECT_UPSTREAM_TIMEOUT_MS: "2000" };
const setEnv = (vars) => {
  for (const k of Object.keys(process.env)) if (k.startsWith("DIRECT_UPSTREAM_")) delete process.env[k];
  Object.assign(process.env, vars || {});
};
const base = K.LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat");
const msgs = [{ role: "user", content: "hi" }];
const cap = K.TIERS["v1-chat"].maxPrice;
const endpoint = Object.fromEntries(["prompt", "completion"].map((k) => [k, Math.min(cap[k], placeholder[k]) / 2]));
const cheapDirect = Object.fromEntries(["prompt", "completion"].map((k) => [k, endpoint[k] / 10]));
const reset = () => {
  direct.hits.length = 0; or.hits.length = 0; direct.plan = directOk; or.plan = orOk;
  D._resetDirectUpstreamStatsForTest(); D._resetDirectBreakerForTest(); S._resetDirectSpendForTest();
  PB._resetDirectPriceBookForTest(); PB._seedDirectPriceBookForTest({ [MODEL]: { direct: cheapDirect, endpoints: [endpoint] } });
};
const spent = () => S.directUpstreamSpendStatus({ full: true });
const call = () => base.handler({ model: MODEL, messages: msgs, max_tokens: 16 });
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ---- the threshold variable ---------------------------------------------------
{
  const d = S.DIRECT_SPEND_DEFAULT_ALERT_USD;
  ok(S.directSpendAlertUsd({}) === d && S.directSpendAlertUsd({ DIRECT_UPSTREAM_DAILY_ALERT_USD: "" }) === d, "threshold: unset or blank reads the default");
  ok(S.directSpendAlertUsd({ DIRECT_UPSTREAM_DAILY_ALERT_USD: "abc" }) === d && S.directSpendAlertUsd({ DIRECT_UPSTREAM_DAILY_ALERT_USD: "-3" }) === d, "threshold: a malformed or negative value reads the default, never off");
  ok(S.directSpendAlertUsd({ DIRECT_UPSTREAM_DAILY_ALERT_USD: "0" }) === null && S.directSpendAlertUsd({ DIRECT_UPSTREAM_DAILY_ALERT_USD: "OFF" }) === null, "threshold: 0 and off turn the alarm off");
  ok(S.directSpendAlertUsd({ DIRECT_UPSTREAM_DAILY_ALERT_USD: String(d * 3) }) === d * 3, "threshold: a set value is read");
}

// ---- booking -------------------------------------------------------------------
setEnv(ON);
reset();
await call();
ok(direct.hits.length === 1 && or.hits.length === 0 && near(spent().spentUsd, DIRECT_MICRO / 1e6) && spent().reported === 1, `a served direct answer books its reported charge once (${JSON.stringify(spent())})`);
direct.plan = (req, res, body) => sse(res, [
  { id: "s", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: "stop" }] },
  { id: "s", object: "chat.completion.chunk", model: body.model, choices: [], usage: { ...USAGE }, x_vendor: { charged_micro: DIRECT_MICRO } },
  "[DONE]",
]);
{
  const out = await base.handler({ model: MODEL, messages: msgs, max_tokens: 16, stream: true });
  const res = { headersSent: false, chunks: [], writeHead(s) { res.headersSent = true; res.status = s; }, flushHeaders() {}, write(c) { res.chunks.push(String(c)); return true; }, end() {}, on() {}, once() {}, off() {} };
  await out.__sse(res);
  ok(res.status === 200 && res.chunks.join("").includes("hello") && near(spent().spentUsd, 2 * DIRECT_MICRO / 1e6) && spent().reported === 2, `a streamed direct answer books its charge once (${JSON.stringify(spent())})`);
}
reset();
direct.plan = directNoCharge;
await call();
{
  const est = (USAGE.prompt_tokens * placeholder.prompt + USAGE.completion_tokens * placeholder.completion) / 1e6;
  ok(direct.hits.length === 1 && or.hits.length === 1 && near(spent().spentUsd, est) && spent().estimated === 1, `an answer the upstream sent without a charge (walked to OpenRouter) is booked at its tokens times the table's row (${JSON.stringify(spent())})`);
}
reset();
direct.plan = (req, res, body) => json(res, 200, { id: "e", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" }], usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 }, x_vendor: { charged_micro: DIRECT_MICRO } });
await call();
ok(or.hits.length === 1 && near(spent().spentUsd, DIRECT_MICRO / 1e6), "an empty direct answer the upstream billed is booked, and the buyer is served by OpenRouter");
reset();
S.noteDirectSpend("nobody/unknown-model", USAGE, null);
ok(spent().unpriced === 1 && spent().spentUsd === 0, "an answer neither the upstream nor the table prices is counted unpriced, booking nothing");
reset();
setEnv({ ...ON, DIRECT_UPSTREAM_SHARE: "0" });
await call(); await call();
ok(direct.hits.length === 0 && or.hits.length === 2 && spent().answers === 0, "OpenRouter answers book nothing");

// ---- the word: ok, high, off; never a refusal ------------------------------------
setEnv({ ...ON, DIRECT_UPSTREAM_DAILY_ALERT_USD: String((2.5 * DIRECT_MICRO) / 1e6) });
reset();
await call(); await call();
ok(S.directUpstreamSpendStatus().status === "ok", "two answers under the threshold read ok");
await call();
const pub = S.directUpstreamSpendStatus();
ok(pub.status === "high" && Object.keys(pub).join() === "status", `the third crosses it: high, and the public read is the word alone (${JSON.stringify(pub)})`);
for (let i = 0; i < 3; i++) await call();
ok(direct.hits.length === 6 && or.hits.length === 0 && S.directUpstreamSpendStatus().status === "high", "past the threshold every call still goes direct and is served: the alarm never refuses, caps or reroutes");
ok(S.directUpstreamSpendStatus({ env: { ...ON, DIRECT_UPSTREAM_DAILY_ALERT_USD: "off" } }).status === "off" && S.directUpstreamSpendStatus({ env: {} }).status === "off", "off with the alarm off or the upstream unconfigured");
{
  const full = S.directUpstreamSpendStatus({ full: true });
  ok(typeof full.spentUsd === "number" && typeof full.alertUsd === "number" && full.answers === 6, "the operator read carries the figures");
}
ok(S.directUpstreamSpendStatus({ now: Date.now() + 86_400_000 }).status === "ok", "the next UTC day starts at zero");

// ---- a prepaid balance that ran out -----------------------------------------------
setEnv(ON);
reset();
let clock = Date.now();
D._setDirectBreakerNowForTest(() => clock);
direct.plan = directBroke;
const bal = () => S.directUpstreamBalanceStatus().status;
ok(bal() === "starting" && PB.directUpstreamStatus().status === "ok", "before any outcome: balance starting (neither pages nor closes), directUpstream ok");
D.noteDirectOutcome(false, "upstream_5xx");
ok(bal() === "starting", "a failure that is not a balance refusal leaves it starting");
D._resetDirectBreakerForTest(); D._setDirectBreakerNowForTest(() => clock);
const served = [];
for (let i = 0; i < 3; i++) { const r = await call(); served.push(r?.choices?.[0]?.message?.content); }
ok(served.every((c) => c === "hello") && direct.hits.length === 3 && or.hits.length === 3, `three 402 balance refusals: each buyer is served by OpenRouter (${served.join(",")})`);
ok(bal() === "exhausted" && Object.keys(S.directUpstreamBalanceStatus()).join() === "status", "directUpstreamBalance reads exhausted, the word alone publicly");
ok(PB.directUpstreamStatus().status === "degraded" && PB.directUpstreamStatus({ full: true }).reason === "breaker_open", "the third opens the breaker: directUpstream reads degraded (breaker_open)");
{
  const r = await call();
  ok(r?.choices?.[0]?.message?.content === "hello" && direct.hits.length === 3 && or.hits.length === 4, "while open the next call goes straight to OpenRouter and is served");
}
ok(S.directUpstreamSpendStatus({ full: true }).spentUsd === 0, "a refused call books no spend");
ok(S.directUpstreamBalanceStatus({ env: { ...ON, DIRECT_UPSTREAM_SHARE: "0" } }).status === "off" && S.directUpstreamBalanceStatus({ env: {} }).status === "off", "balance reads off with a share of 0 or the upstream unconfigured");
// Topped up: the half-open trial is served direct and both words clear.
direct.plan = directOk;
clock += 6 * 60_000;
{
  const r = await call();
  ok(r?.choices?.[0]?.message?.content === "hello" && direct.hits.length === 4, "after the open period the trial goes direct and is served");
}
ok(bal() === "ok" && PB.directUpstreamStatus().status === "ok", "a served direct answer clears both words");
D._setDirectBreakerNowForTest(null);

// ---- pagers -------------------------------------------------------------------
const WORDS = [
  ["directUpstreamSpend: the direct upstream's daily spend is high", "directUpstreamSpend", "high", "/__operator/direct-upstream.json"],
  ["directUpstreamBalance: the direct upstream's prepaid balance is exhausted", "directUpstreamBalance", "exhausted", "/__operator/direct-upstream.json"],
];
const { ALARMS, judge } = await import("../workers/status-probe/src/index.js");
for (const [T, field, bad, endpointPath] of WORDS) {
  const a = ALARMS.find((x) => x.title === T);
  ok(!!a, `the Worker carries "${T}"`);
  if (!a) continue;
  const j = (gw) => judge({ gateway: gw })[T];
  ok(j({ [field]: { status: bad } }) === "bad" && j({ [field]: { status: "ok" } }) === "good" && j({ [field]: { status: "off" } }) === "good", `${field}: ${bad} pages, ok and off clear`);
  ok(["unknown", "starting", "<b>"].every((w) => j({ [field]: { status: w } }) === "quiet") && j({}) === "quiet", `${field}: unknown, starting, anything new and absent do neither`);
  const body = a.body({ gateway: { [field]: { status: "<b>", spentUsd: 7.5, alertUsd: 5 } } });
  ok(body === `/api/gateway-status reports ${field}.status=${bad}. The detail is on the operator endpoint, ${endpointPath} (operator token). Auto-closes when the word is ok.` && !/\d/.test(body.replace(/\.status=/, "")), `${field}: the body names the word and the operator endpoint, no figure`);
}
{
  const wf = yamlLoad(readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8"));
  const step = Object.values(wf.jobs).flatMap((x) => x.steps || []).find((s) => String(s.name || "").startsWith("Tool, upstream and facilitator failure checks"));
  const dir = mkdtempSync(join(tmpdir(), "hb-direct-spend-"));
  writeFileSync(join(dir, "curl"), "#!/usr/bin/env bash\ncat \"$GS_FILE\"\n");
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
if [ "$1 $2" = "issue list" ]; then
  for a in "$@"; do case "$a" in *"$OPEN_TITLE"*) [ -n "$OPEN_TITLE" ] && echo 41 && exit 0;; esac; done
  exit 0
fi
printf '%s\\x1f' "$@" >> "$GH_LOG"; printf '\\x1e' >> "$GH_LOG"
`);
  chmodSync(join(dir, "curl"), 0o755); chmodSync(join(dir, "gh"), 0o755);
  const hb = (gateway, open = "") => {
    const gs = join(dir, "gs.json"), log = join(dir, "gh.log");
    writeFileSync(gs, JSON.stringify(gateway)); writeFileSync(log, "");
    const r = spawnSync("bash", ["-e", "-c", step.run], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROD: "https://example.invalid", GITHUB_REPOSITORY: "o/r", GS_FILE: gs, GH_LOG: log, OPEN_TITLE: open }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(log, "utf8").split("\x1e").filter((l) => l.trim()).map((l) => l.split("\x1f").filter((x) => x !== ""));
  };
  const arg = (c, f) => c[c.indexOf(f) + 1];
  for (const [T, field, bad] of WORDS) {
    let calls = hb({ [field]: { status: bad, spentUsd: 7.5 } });
    const made = calls.filter((c) => c[1] === "create" && arg(c, "--title") === T);
    ok(made.length === 1 && arg(made[0], "--body") === ALARMS.find((x) => x.title === T).body({}), `heartbeat: ${field}=${bad} opens one issue under the Worker's title and body`);
    calls = hb({ [field]: { status: bad } }, T);
    ok(!calls.some((c) => c[1] === "create") && calls.some((c) => c[1] === "comment" && c[2] === "41"), `heartbeat: ${field}: an open issue is not duplicated`);
    for (const w of ["ok", "off"]) {
      calls = hb({ [field]: { status: w } }, T);
      ok(calls.filter((c) => c[1] === "close" && c[2] === "41").length === 1, `heartbeat: ${field}=${w} closes it`);
    }
    for (const g of [{ [field]: { status: "unknown" } }, { [field]: { status: "starting" } }, {}]) {
      calls = hb(g, T);
      ok(!calls.some((c) => c[1] === "close" || c[1] === "create"), `heartbeat: ${field} ${JSON.stringify(g[field] || "absent")} does neither`);
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

// ---- the caller path: /api/gateway-status reads the module ----------------------
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/directUpstreamSpend: \(\(\) => \{ try \{ return directUpstreamSpendStatus\(\{ full \}\); \} catch \{ return \{ status: "unknown" \}; \} \}\)\(\),/.test(server) && /directUpstreamBalance: \(\(\) => \{ try \{ return directUpstreamBalanceStatus\(\{ full \}\); \} catch \{ return \{ status: "unknown" \}; \} \}\)\(\),/.test(server), "gateway-status publishes both words, full only for the operator");
  ok(/refreshDirectSpendShared\(\)\]\);/.test(server), "gateway-status reads the shared day before the word");
}

direct.server.close(); or.server.close();
globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
