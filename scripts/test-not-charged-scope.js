// The charge sentence is printed where it is true (src/not-charged.js).
//
// A handler answering its caller directly says "Nothing was charged." on a
// refusal; the same handler run as a step of another answer (a route-execute
// dispatch, a skill-pack or decide step) prints no claim. Part one reads the
// async-context marks directly; part two boots a FREE_MODE server on port 0
// and reads one refusal through the HTTP route binder and again through the
// router's in-process dispatch.
//
//   node scripts/test-not-charged-scope.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ownStoreEnv } from "./lib/own-stores.js";
import { NOT_CHARGED, notChargedOn, notChargedHere, isRouteCall, runAsRouteCall, runAsStep, claimLater, claimNow } from "../src/not-charged.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

// ---- 1. the marks ----
{
  const req = { headers: {}, ip: "203.0.113.4" };
  const said = ` ${NOT_CHARGED}`;
  ok(notChargedHere() === "" && notChargedOn(req) === said && notChargedOn(undefined) === "", "no mark: the request-less reading is silent, a request still reads as a route call");
  ok(await runAsRouteCall(async () => { await null; return notChargedHere(); }) === said, "inside a route call the request-less reading prints the sentence, across an await");
  const nested = await runAsRouteCall(() => runAsStep(async () => { await new Promise((r) => setTimeout(r, 5)); return [notChargedHere(), notChargedOn(req), isRouteCall(req)]; }));
  ok(nested[0] === "" && nested[1] === "" && nested[2] === false, "a step inside a route call prints nothing, with or without the paying request in hand");
  ok(await runAsStep(() => runAsRouteCall(() => notChargedHere())) === said, "a dispatcher entered again under a step is its own route call (its answer is its own)");
  ok(await runAsRouteCall(async () => { await runAsStep(async () => {}); return notChargedHere(); }) === said, "after the step returns, the route call's own refusal prints the sentence");
  // An error built outside the caller's context is finished in the caller's.
  const late = (tail) => new Promise((_, reject) => setImmediate(() => reject(claimLater(new Error("The worker stopped."), tail))));
  const p = late(" Retry shortly.");
  const routed = await runAsRouteCall(async () => { try { await p; } catch (e) { return claimNow(e).message; } });
  ok(routed === `The worker stopped.${said} Retry shortly.`, `a pool's late error takes the sentence at the entry point (${routed})`);
  const p2 = late(" Retry shortly.");
  const stepped = await runAsStep(async () => { try { await p2; } catch (e) { return claimNow(e).message; } });
  ok(stepped === "The worker stopped. Retry shortly.", `...and none when the entry point is a step (${stepped})`);
  ok(claimNow(new Error("plain")).message === "plain", "an unmarked error is left as it is");
}

// ---- 1a. a delivered answer never carries the sentence ----
// A composite catches a leg's error and returns its text inside an answer
// that is delivered (and charged), or throws it as the whole call's refusal.
{
  const { withoutChargeSentence, chargeSentenceRemovals } = await import("../src/not-charged.js");
  const said = ` ${NOT_CHARGED}`;
  const leg = async (fail) => { await null; if (fail) throw Object.assign(new Error(`The source is unreachable from here.${notChargedHere()} Retry shortly.`), { statusCode: 503 }); return { ok: true }; };
  const composite = async (fails) => {
    const settled = await Promise.allSettled(fails.map(leg));
    if (settled.every((r) => r.status === "rejected")) throw settled[0].reason;
    return { legs: settled.map((r) => (r.status === "fulfilled" ? r.value : { error: r.reason.message })), nested: { list: [{ note: `leg failed: ${settled.find((r) => r.status === "rejected")?.reason?.message}` }] } };
  };
  const before = chargeSentenceRemovals();
  const partial = await runAsRouteCall(() => composite([false, true]));
  ok(!JSON.stringify(partial).includes("charged") && partial.legs[1].error === "The source is unreachable from here. Retry shortly." && /leg failed: The source is unreachable from here\. Retry shortly\.$/.test(partial.nested.list[0].note),
     `a delivered answer that embeds a failed leg's text carries no charge sentence, at any depth (${JSON.stringify(partial.legs[1])})`);
  ok(chargeSentenceRemovals() === before + 1, "...and the removal is counted");
  let all = null; try { await runAsRouteCall(() => composite([true, true])); } catch (e) { all = e; }
  ok(all?.statusCode === 503 && all.message === `The source is unreachable from here.${said} Retry shortly.`, `the same leg error thrown as the whole call's refusal keeps the sentence (${all?.message})`);
  const clean = { a: ["x", { b: "y" }], c: 1 };
  ok(await runAsRouteCall(async () => clean) === clean && chargeSentenceRemovals() === before + 1, "an answer from a call that printed no sentence is returned as the same object, unread");
  const natural = { results: [{ description: "Nothing was charged. A review." }] };
  ok(await runAsRouteCall(async () => natural) === natural, "...including one whose own content holds those words");
  const frozen = Object.freeze({ error: `Busy.${said}`, keep: Object.freeze(["same"]) });
  const r = withoutChargeSentence(frozen);
  ok(r.removed === 1 && r.value.error === "Busy." && r.value !== frozen && r.value.keep === frozen.keep && frozen.error === `Busy.${said}`, "the answer is copied along the changed path only, never changed in place");
  ok(withoutChargeSentence("text").value === "text" && withoutChargeSentence(new Error(`x.${said}`)).removed === 0, "only the strings of a plain object or array are read");

  // The real one: multi-search with one of two queries failing.
  process.env.BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY = "stub-not-real";
  const realFetch = globalThis.fetch;
  let failAll = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (!/brave/.test(u)) return realFetch(url);
    if (failAll || /q=second/.test(u)) { const e = new TypeError("fetch failed"); e.cause = { code: "ECONNRESET" }; throw e; }
    return new Response(JSON.stringify({ web: { results: [{ title: "t", url: "https://example.com", description: "d" }] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const warn = console.warn; console.warn = () => {};
  try {
    const mod = await import("../src/tools/search.js");
    const multi = Object.values(mod).find((v) => Array.isArray(v) && v.some((t) => t?.slug === "multi-search")).find((t) => t.slug === "multi-search");
    const out = await runAsRouteCall(() => multi.handler({ queries: ["first", "second"] }, { headers: {}, query: {}, body: {} }));
    const failedLeg = (out.searches || []).find((x) => x.error);
    ok(failedLeg && /unreachable/.test(failedLeg.error) && !/charged/i.test(JSON.stringify(out)), `multi-search with one query failing delivers no charge sentence (${failedLeg?.error})`);
    failAll = true;
    let e = null; try { await runAsRouteCall(() => multi.handler({ queries: ["first", "second"] }, { headers: {}, query: {}, body: {} })); } catch (x) { e = x; }
    ok(e?.statusCode >= 500 && / Nothing was charged\./.test(e.message), `...and with every query failing refuses with it (${e?.statusCode} ${e?.message})`);
  } finally { globalThis.fetch = realFetch; console.warn = warn; }
}

// ---- 1c. one shared rejection, read in each waiter's own scope ----
{
  // A single-flight read started by a route call rejects a step that joined it.
  let shared = null;
  const read = () => (shared ??= (async () => { await new Promise((r) => setTimeout(r, 10)); throw Object.assign(new Error(`The upstream did not answer.${notChargedHere()} Retry shortly.`), { statusCode: 503, hint: "our-deadline" }); })());
  const first = runAsRouteCall(() => read()).catch((e) => e);
  const joined = runAsRouteCall(() => runAsStep(() => read())).catch((e) => e);
  const [a, b] = await Promise.all([first, joined]);
  ok(/ Nothing was charged\. Retry shortly\.$/.test(a.message), "the route call that started a shared read gets its refusal as written");
  ok(b.message === "The upstream did not answer. Retry shortly." && b.statusCode === 503 && b.hint === "our-deadline" && b !== a && / Nothing was charged\./.test(a.message), `a step that joined it gets a copy without the sentence, its fields kept, the shared error untouched (${b.message})`);
  // A route call's composite that joined another route call's shared read,
  // caught its rejection and delivered the leg's text: the answer is charged,
  // so it carries no sentence, though this call never printed one itself.
  let shared2 = null;
  const read2 = () => (shared2 ??= (async () => { await new Promise((r) => setTimeout(r, 10)); throw Object.assign(new Error(`The publisher did not answer.${notChargedHere()} Retry shortly.`), { statusCode: 503 }); })());
  const starter = runAsRouteCall(() => read2()).catch((e) => e);
  const composite = runAsRouteCall(async () => { await null; try { await read2(); return { legs: [] }; } catch (e) { return { legs: [{ series: "a", value: 1 }, { series: "b", error: e.message }] }; } });
  const [s1, delivered] = await Promise.all([starter, composite]);
  ok(/ Nothing was charged\./.test(s1.message), "the call that started the shared read refuses with the sentence");
  ok(delivered.legs[1].error === "The publisher did not answer. Retry shortly." && !JSON.stringify(delivered).includes(NOT_CHARGED), `a composite that delivers a joined leg's error carries no sentence (${delivered.legs[1].error})`);
}

// ---- 1d. a worker pool's late error: the office pool's job timer ----
{
  const { runOfficeOp } = await import("../src/tools/office-pool.js");
  const spec = { sheets: [{ name: "s", rows: [["a", 1]] }] };
  const late = (wrap) => wrap(() => runOfficeOp("xlsx", spec, { timeoutMs: 1 })).then(() => null, (e) => e);
  const routed = await late(runAsRouteCall);
  const stepped = await late((fn) => runAsRouteCall(() => runAsStep(fn)));
  const bare = await late((fn) => fn());
  ok(routed?.statusCode === 422 && /took longer than 0\.001s\. Nothing was charged\.$/.test(routed.message) && !("chargeClaimTail" in routed), `the pool's timer error, built outside the caller's context, takes the sentence where the route call awaits it (${routed?.message})`);
  ok(/took longer than 0\.001s\.$/.test(stepped?.message || "") && /took longer than 0\.001s\.$/.test(bare?.message || ""), `...and none as a step or with no caller marked (${stepped?.message})`);
}

// ---- 1e. a failed job's summary agrees with the answer it carries ----
{
  const { failedRunSummary } = await import("../src/async-jobs.js");
  const { pushRefusalBody, PUSH_FAILURE_NOTE } = await import("../src/push-refusal-body.js");
  const { withPushExceptionText } = await import("../src/prepayment-refusal.js");
  const plain = failedRunSummary(502, { error: "Upstream failed. Nothing was charged." });
  ok(plain === "The call ended with HTTP 502. Nothing was charged." && failedRunSummary(402, { error: "payment required" }) === "The payment was not accepted, so the call did not run. Nothing was charged. The 402 is in error.body.", `a failed run on any other payment says nothing was charged, in the shared sentence (${plain})`);
  const pushBody = JSON.parse(pushRefusalBody(JSON.stringify({ error: "Upstream failed. Nothing was charged." })));
  const push = failedRunSummary(502, pushBody);
  ok(pushBody.charged === true && push.includes(PUSH_FAILURE_NOTE) && !/Nothing was charged|not charged/i.test(push), `a body the Tempo push gate rewrote (charged, refund owed) gets a summary that says the same (${push.slice(0, 90)})`);
  ok(/except a Tempo transfer/.test(withPushExceptionText(plain, true)), "...and the plain summary is the sentence the push exception attaches to");
}

// ---- 1b. a skill pack runs its steps marked ----
{
  const { buildSkillTools } = await import("../src/tools/skill-runner.js");
  let mode = "mixed", n = 0;
  const stepHandler = async () => { n++; if (mode === "mixed" && n === 1) return { ok: true }; throw Object.assign(new Error(`The source is busy.${notChargedHere()}`), { statusCode: 503 }); };
  const packs = buildSkillTools({ getCatalog: () => ({}), inlineHandlers: new Proxy({}, { get: () => stepHandler }) });
  // The first pack whose example drives at least two steps here.
  let shown = null;
  for (const pack of packs) {
    const example = pack.discovery?.input ?? pack.discovery?.example ?? {};
    mode = "mixed"; n = 0;
    let out = null;
    try { out = await runAsRouteCall(() => pack.handler(example, { headers: {}, ip: "203.0.113.4" })); } catch { continue; }
    const failed = (out?.steps || []).filter((x) => x.ok === false && typeof x.error === "string");
    if (!failed.length) continue;
    mode = "none"; n = 0;
    let all = null;
    try { await runAsRouteCall(() => pack.handler(example, { headers: {}, ip: "203.0.113.4" })); } catch (e) { all = e; }
    shown = { slug: pack.slug, failed, all };
    break;
  }
  ok(shown && shown.failed.every((x) => /The source is busy\.$/.test(x.error)), `a failed step inside a delivered pack makes no charge claim (${shown?.slug}: ${shown?.failed?.[0]?.error})`);
  ok(shown?.all && /nothing to return\. Nothing was charged\. /.test(shown.all.message) && (shown.all.message.match(/charged/g) || []).length === 1, `a pack with no step delivered refuses with the sentence once, as its own answer (${String(shown?.all?.message).slice(0, 120)})`);
}

// ---- 2. through the binder and through the router's dispatch ----
// With a key and no cost table the X data tools refuse before any outbound
// call (src/tools/x-data-kit.js xRate).
const proc = spawn(process.execPath, ["src/server.js"], {
  cwd: ROOT,
  env: { ...process.env, ...ownStoreEnv("not-charged-scope"), PORT: "0", FREE_MODE: "true", X_BEARER_TOKEN: "test-key-not-real", UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_FILE: "", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
let base = null;
const portFrom = (s) => { const m = /listening[^\n]*?(?:port\s*|:)(\d{2,5})/i.exec(s); if (m && !base) base = `http://127.0.0.1:${m[1]}`; };
proc.stdout.on("data", (d) => portFrom(String(d)));
proc.stderr.on("data", (d) => portFrom(String(d)));
const stop = () => { try { proc.kill("SIGTERM"); } catch { /* gone */ } };
try {
  for (let i = 0; i < 240 && !base; i++) await new Promise((r) => setTimeout(r, 250));
  if (!base) throw new Error("server did not report its port");
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* booting */ } await new Promise((r) => setTimeout(r, 500)); }
  const post = async (path, body) => { const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json().catch(() => null) }; };
  const direct = await post("/api/x-user", { username: "agent402" });
  ok(direct.status === 503 && /X data tools are temporarily unavailable\. Nothing was charged\.$/.test(direct.j?.error || ""), `the route binder's call prints the sentence (${direct.status} ${direct.j?.error})`);
  const routed = await post("/api/route/execute-plus", { slug: "x-user", params: { username: "agent402" } });
  ok(routed.status === 503 && /Routed tool "x-user" failed: X data tools are temporarily unavailable\.$/.test(routed.j?.error || "") && !/charged/i.test(routed.j?.error || ""), `the same refusal as the router's step prints no claim (${routed.status} ${routed.j?.error})`);
} catch (e) {
  ok(false, `the boot half ran (${e?.message || e})`);
} finally { stop(); }

console.log(`test-not-charged-scope: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
