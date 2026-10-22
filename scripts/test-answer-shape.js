#!/usr/bin/env node
// Production answer classification (src/answer-shape.js), its counting in the
// failure monitor (src/tool-failure-monitor.js), the toolAnswers word, the
// identical-answer read over the sales ledger, and the alarm wiring
// (heartbeat.yml step, status Worker).
//
//   unit     every class; a partial answer, a found:false answer and an
//            emptyOk tool are not flagged; a documented error key is the
//            contract; a pure-CPU tool's empty answer is its input's; garbage
//            never throws; the observer leaves the 200 byte for byte as it was.
//   monitor  the word's rate, hour and day minimums, outside-only, the replica
//            merge, reasons kept as field names, public view words only.
//   ledger   answerDigestWindow over a scratch sales ledger: five external
//            sales of one live slug with one digest are flagged; internal rows,
//            pure-CPU slugs and two digests are not.
//   alarm    heartbeat.yml's step against stubbed curl and gh; the Worker maps
//            the same word under the same title.
//   booted   a paid-mode server (stub facilitator) counts a paid empty answer
//            and a paid ok answer by class on the operator endpoint.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import express from "express";
import { load as yamlLoad } from "js-yaml";
import { answerContractOf, classifyAnswer, observeJsonAnswer, identicalAnswerFlags, EMPTY_RESULT_OK, populatedArrayKeys } from "../src/answer-shape.js";
import { createToolFailureMonitor, BUCKET_MS } from "../src/tool-failure-monitor.js";
import { getFreePorts } from "./lib/free-port.js";

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.error(`FAIL - ${name}: ${e?.stack || e}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tool = (slug, example, extra = {}) => ({ slug, discovery: { output: { example }, ...extra } });
const classify = (def, body, opts) => classifyAnswer(answerContractOf(def, opts), body);
const SEARCH = tool("search", { query: "q", results: [{ url: "u" }], count: 1 });

// ---- unit: classes -------------------------------------------------------------
await check("ok: the documented arrays carry rows", () => {
  assert.deepEqual(classify(SEARCH, { query: "x", results: [{ url: "a" }], count: 1 }), { klass: "ok", reasons: [] });
});
await check("empty: the documented array is empty, reasons are the field names", () => {
  assert.deepEqual(classify(SEARCH, { query: "secret query text", results: [], count: 0 }), { klass: "empty", reasons: ["results"] });
});
await check("empty needs EVERY documented array empty; one empty secondary list is ok", () => {
  const whois = tool("whois", { domain: "d", nameservers: ["a"], status: ["active"] });
  assert.equal(classify(whois, { domain: "d", nameservers: ["a"], status: [] }).klass, "ok");
  assert.deepEqual(classify(whois, { domain: "d", nameservers: [], status: [] }), { klass: "empty", reasons: ["nameservers", "status"] });
});
await check("empty: a primary scalar the example shows set answers null or empty text", () => {
  const quote = tool("stock-quote", { symbol: "AAPL", price: 101.5, currency: "USD" });
  assert.deepEqual(classify(quote, { symbol: "AAPL", price: null, currency: "USD" }), { klass: "empty", reasons: ["price"] });
  const extract = tool("extract", { title: "t", markdown: "# body" });
  assert.deepEqual(classify(extract, { title: "t", markdown: "" }), { klass: "empty", reasons: ["markdown"] });
  assert.equal(classify(extract, { title: "t", markdown: "# real" }).klass, "ok");
});
await check("empty: a documented root array answered empty", () => {
  assert.deepEqual(classify(tool("list", [{ a: 1 }]), []), { klass: "empty", reasons: ["(root)"] });
  assert.equal(classify(tool("list", [{ a: 1 }]), [{ a: 2 }]).klass, "ok");
});
await check("error-shaped: error, errors, ok:false in a 200 where the example has no such key", () => {
  assert.deepEqual(classify(SEARCH, { error: "upstream said no", results: [{ url: "a" }] }), { klass: "error-shaped", reasons: ["error"] });
  assert.deepEqual(classify(SEARCH, { errors: [{ m: "x" }], results: [{ url: "a" }] }), { klass: "error-shaped", reasons: ["errors"] });
  assert.deepEqual(classify(SEARCH, { ok: false, results: [] }), { klass: "error-shaped", reasons: ["ok"] });
  assert.equal(classify(SEARCH, { error: null, errors: [], ok: true, results: [{ url: "a" }] }).klass, "ok", "an unset error, an empty errors list and ok:true are not errors");
});
await check("error-shaped: a skill pack whose every step failed", () => {
  const pack = tool("skill-x", { pack: "x", steps: [{ slug: "a", ok: true, result: {} }], summary: "1/1" });
  assert.deepEqual(classify(pack, { pack: "x", steps: [{ slug: "a", ok: false }, { slug: "b", ok: false }] }), { klass: "error-shaped", reasons: ["steps"] });
  assert.equal(classify(pack, { pack: "x", steps: [{ slug: "a", ok: false }, { slug: "b", ok: true }] }).klass, "ok", "one step answered");
});
await check("a documented error key is the tool's contract (validators, code-run)", () => {
  const validator = tool("json-validate", { valid: false, errors: [] });
  assert.equal(classify(validator, { valid: false, errors: [{ path: "/a" }] }).klass, "ok");
  const run = tool("code-run", { stdout: "", error: null });
  assert.equal(classify(run, { stdout: "", error: "Traceback" }).klass, "ok");
  const lint = tool("openapi-lint", { ok: true, issues: [] });
  assert.equal(classify(lint, { ok: false, issues: [{}] }).klass, "ok");
});
await check("unchecked: no example, not an object, too wide to read cheaply", () => {
  assert.equal(classify({ slug: "bare", discovery: {} }, { a: 1 }).klass, "unchecked");
  assert.equal(classify(SEARCH, "a string").klass, "unchecked");
  assert.equal(classify(SEARCH, 42).klass, "unchecked");
  assert.equal(classify(SEARCH, null).klass, "unchecked");
  const wide = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`k${i}`, i]));
  assert.deepEqual(classify(SEARCH, wide), { klass: "unchecked", reasons: ["too-wide"] });
});

// ---- unit: what is never flagged --------------------------------------------------
await check("a partial or self-declared empty answer is not flagged (src/partial-answer.js fields, found:false)", () => {
  for (const marker of [{ matched: 0, returned: 0, complete: true, truncated: false }, { truncated: true }, { complete: false }, { found: false }, { exists: false }]) {
    assert.equal(classify(SEARCH, { query: "x", results: [], ...marker }).klass, "ok", JSON.stringify(marker));
  }
  const quote = tool("barcode-lookup", { code: "1", found: true, text: "item" });
  assert.equal(classify(quote, { code: "1", found: false, text: null }).klass, "ok");
});
await check("an emptyOk tool is not flagged: the shared map, discovery.emptyOk true, and per-key", () => {
  assert.equal(EMPTY_RESULT_OK.get("weather-alerts"), true);
  assert.equal(classify(tool("weather-alerts", { area: "CA", alerts: [{ id: 1 }] }), { area: "CA", alerts: [] }).klass, "ok");
  assert.equal(classify(tool("own-flag", { rows: [1] }, { emptyOk: true }), { rows: [] }).klass, "ok");
  const perKey = tool("coin-profile", { id: "x", categories: ["a"], platforms: [{ p: 1 }] });
  assert.equal(classify(perKey, { id: "x", categories: ["a"], platforms: [] }).klass, "ok");
  assert.deepEqual(classify(perKey, { id: "x", categories: [], platforms: [] }), { klass: "empty", reasons: ["categories"] }, "the keys not excused are still checked");
  assert.equal(classify(tool("search", { results: [1] }, { emptyOk: false }), { results: [] }).klass, "empty", "an explicit false keeps the check");
});
await check("a pure-CPU tool's empty answer is its input's answer; its error shape is still read", () => {
  const links = tool("html-links", { links: [{ href: "a" }], count: 1 });
  assert.equal(classify(links, { links: [], count: 0 }, { deterministic: true }).klass, "ok");
  assert.equal(classify(links, { links: [], count: 0 }).klass, "empty", "control: the same answer from a live-data tool");
  assert.equal(classify(links, { error: "x", links: [] }, { deterministic: true }).klass, "error-shaped");
});

// ---- unit: never throws, never touches the answer ----------------------------------
await check("garbage never throws: throwing getters, proxies, cycles, odd contracts", () => {
  const hostile = {};
  Object.defineProperty(hostile, "results", { enumerable: true, get() { throw new Error("boom"); } });
  const proxy = new Proxy({}, { ownKeys() { throw new Error("no keys"); }, get() { throw new Error("no get"); }, has() { throw new Error("no has"); } });
  const cyc = { results: [] }; cyc.self = cyc;
  for (const [c, b] of [[answerContractOf(SEARCH), hostile], [answerContractOf(SEARCH), proxy], [answerContractOf(SEARCH), cyc], [null, { a: 1 }], [undefined, undefined], [{ checkable: true }, { a: 1 }], [answerContractOf(SEARCH), Object.create(null)]]) {
    const r = classifyAnswer(c, b);
    assert.ok(["ok", "empty", "error-shaped", "unchecked"].includes(r.klass), JSON.stringify(r));
  }
  for (const def of [null, undefined, {}, { discovery: { output: { example: "text" } } }, { slug: 5, discovery: { output: { example: null } } }]) assert.doesNotThrow(() => answerContractOf(def));
  assert.deepEqual(populatedArrayKeys(null), []);
});
await check("the observer leaves the 200 byte for byte as it was (body and headers)", async () => {
  const body = { b: [1, 2, { c: "é ✓ </script>" }], a: null, n: 1.5, s: "x".repeat(5000) };
  const seen = [];
  const app = express();
  app.set("etag", "strong");
  app.get("/plain", (req, res) => res.json(body));
  app.get("/observed", (req, res) => { const o = observeJsonAnswer(res); res.on("finish", () => seen.push(o.has() && o.body())); res.json(body); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const a = await fetch(`${base}/plain`), b = await fetch(`${base}/observed`);
    const ab = Buffer.from(await a.arrayBuffer()), bb = Buffer.from(await b.arrayBuffer());
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.ok(ab.equals(bb), "identical bytes");
    for (const h of ["content-type", "content-length", "etag"]) assert.equal(b.headers.get(h), a.headers.get(h), h);
    assert.equal(seen[0], body, "the observer holds the same object by reference (no copy)");
  } finally { server.close(); }
  const fake = { json() { return "ret"; } };
  const o = observeJsonAnswer(fake);
  assert.equal(fake.json({ x: 1 }), "ret", "the return value passes through");
  assert.equal(o.has(), true);
  fake.json("text");
  assert.equal(o.has(), false, "a non-object answer is not held");
  assert.equal(observeJsonAnswer({}).has(), false, "a response without json is left alone");
});

// ---- monitor: counting and the word -------------------------------------------------
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
await check("toolAnswers: degraded at the rate over the hour minimum, outside traffic only", async () => {
  let t = T0;
  const m = createToolFailureMonitor({ now: () => t, env: {} });
  for (let i = 0; i < 9; i++) m.noteAnswer("search", "empty", { reasons: ["results"] });
  for (let i = 0; i < 40; i++) m.noteAnswer("search", "empty", { synthetic: true, reasons: ["results"] });
  assert.equal((await m.status({ fresh: true })).toolAnswers.status, "ok", "9 outside empties are under the 10 minimum; synthetic ones never count");
  m.noteAnswer("search", "error-shaped", { reasons: ["error"] });
  assert.equal((await m.status({ fresh: true })).toolAnswers.status, "degraded", "10 of 10 checked");
  const m2 = createToolFailureMonitor({ now: () => t, env: {} });
  for (let i = 0; i < 4; i++) m2.noteAnswer("search", "empty");
  for (let i = 0; i < 6; i++) m2.noteAnswer("search", "ok");
  for (let i = 0; i < 50; i++) m2.noteAnswer("search", "unchecked");
  assert.equal((await m2.status({ fresh: true })).toolAnswers.status, "ok", "4 of 10 checked is under half; unchecked answers are not in the share");
  m2.noteAnswer("search", "empty"); m2.noteAnswer("search", "empty");
  assert.equal((await m2.status({ fresh: true })).toolAnswers.status, "degraded", "6 of 12 reaches half");
});
await check("toolAnswers: the day window catches a slow trickle the hour misses; thresholds are env-tunable", async () => {
  let t = T0;
  const m = createToolFailureMonitor({ now: () => t, env: {} });
  for (let h = 0; h < 10; h++) { for (let i = 0; i < 3; i++) m.noteAnswer("stock-quote", "empty", { at: t - h * 3_600_000 - 60_000, reasons: ["price"] }); }
  assert.equal((await m.status({ fresh: true })).toolAnswers.status, "degraded", "30 empties over ten hours (3 an hour) meet the day minimum");
  const lax = createToolFailureMonitor({ now: () => t, env: { TOOL_ANSWER_MIN_DAY: "100", TOOL_ANSWER_MIN_HOUR: "100" } });
  for (let i = 0; i < 30; i++) lax.noteAnswer("stock-quote", "empty", { at: t - i * 600_000 });
  assert.equal((await lax.status({ fresh: true })).toolAnswers.status, "ok", "raised minimums");
  const strict = createToolFailureMonitor({ now: () => t, env: { TOOL_ANSWER_BAD_RATE: "0.1", TOOL_ANSWER_MIN_HOUR: "5" } });
  for (let i = 0; i < 9; i++) strict.noteAnswer("stock-quote", "ok");
  strict.noteAnswer("stock-quote", "empty");
  assert.equal((await strict.status({ fresh: true })).toolAnswers.status, "degraded", "1 of 10 at a 10% rate");
  t += 25 * 3_600_000;
  assert.equal((await m.status({ fresh: true })).toolAnswers.status, "ok", "a day later the window is clear");
});
await check("operator detail: per-slug counts and the last reasons (field names only); public view the word only", async () => {
  let t = T0;
  const m = createToolFailureMonitor({ now: () => t, env: {} });
  for (let i = 0; i < 7; i++) m.noteAnswer("search", "empty", { reasons: ["results"] });
  m.noteAnswer("search", "error-shaped", { reasons: ["error"] });
  for (let i = 0; i < 3; i++) m.noteAnswer("search", "ok");
  m.noteAnswer("hash", "ok");
  const r = await m.report();
  const row = r.answers.find((x) => x.slug === "search");
  assert.equal(r.toolAnswers, "degraded");
  assert.deepEqual(row.hour.outside, { ok: 3, empty: 7, "error-shaped": 1, unchecked: 0 });
  assert.equal(row.last.length, 5, "the last five non-ok answers");
  assert.deepEqual(row.last.at(-1).reasons, ["error"]);
  assert.ok(!r.answers.some((x) => x.slug === "hash"), "a slug with nothing flagged has no row");
  assert.equal(r.answerTotals.hour.outside.ok, 4, "totals count every slug");
  assert.deepEqual(r.issueSummary.answers, ["search (degraded)"]);
  const pub = await m.status({ fresh: true });
  assert.deepEqual(Object.keys(pub.toolAnswers), ["status"]);
  const full = await m.status({ full: true, fresh: true });
  assert.deepEqual(full.toolAnswers.tools.map((x) => x.slug), ["search"]);
});
await check("replicas: answers merge across snapshots; an older replica without answers merges cleanly", async () => {
  let t = T0;
  const shared = new Map();
  const store = { async publish(id, json) { shared.set(id, json); return { ok: true }; }, async readAll() { return { ok: true, snapshots: [...shared].map(([id, v]) => ({ id, ...JSON.parse(v) })) }; } };
  const a = createToolFailureMonitor({ now: () => t, store, replicaId: "a", env: {} });
  const b = createToolFailureMonitor({ now: () => t, store, replicaId: "b", env: {} });
  for (let i = 0; i < 6; i++) a.noteAnswer("search", "empty", { reasons: ["results"] });
  for (let i = 0; i < 4; i++) b.noteAnswer("search", "empty", { reasons: ["results"] });
  shared.set("old", JSON.stringify({ at: t, tools: {}, upstreams: {}, lastToolError: {}, lastUpstream: {}, refusals: [] }));
  await a.publish(); await b.publish();
  assert.equal((await a.status({ fresh: true })).toolAnswers.status, "degraded", "6 + 4 across replicas");
  const rep = await b.report();
  assert.equal(rep.answers[0].hour.outside.empty, 10);
  assert.ok(rep.answers[0].last.length <= 5);
});

// ---- ledger: identical answers ------------------------------------------------------
await check("identicalAnswerFlags: at least the minimum sales and one digest, live-data slugs only", () => {
  const rows = [
    { slug: "stock-quote", sales: 5, distinctAnswers: 1, payers: 2 },
    { slug: "stock-quote-b", sales: 4, distinctAnswers: 1, payers: 1 },
    { slug: "fx-rate", sales: 9, distinctAnswers: 2, payers: 3 },
    { slug: "hash", sales: 20, distinctAnswers: 1, payers: 1 },
  ];
  const flags = identicalAnswerFlags(rows, { minSales: 5, isLive: (s) => s !== "hash" });
  assert.deepEqual(flags, [{ slug: "stock-quote", sales: 5, distinctAnswers: 1, payers: 2 }]);
  assert.deepEqual(identicalAnswerFlags("garbage"), []);
  assert.deepEqual(identicalAnswerFlags([{ slug: "x", sales: 9, distinctAnswers: 1 }], { isLive: () => { throw new Error("x"); } }), []);
});
await check("answerDigestWindow over a scratch ledger: external rows with a digest, grouped per slug; the monitor reports the flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "answer-digest-"));
  const script = `
    const { recordSale, answerDigestWindow, salesLedgerFlush } = await import(${JSON.stringify(new URL("../src/sales-ledger.js", import.meta.url).href)});
    const H = (c) => c.repeat(64);
    const p = (n) => "0x" + String(n).padStart(40, "0");
    for (let i = 0; i < 5; i++) recordSale({ slug: "stock-quote", priceUsd: 0.01, rail: "usdc", network: "eip155:8453", payer: p(i + 1), tx: "0x" + "a".repeat(63) + i, responseSha256: H("a") });
    for (let i = 0; i < 5; i++) recordSale({ slug: "fx-rate", priceUsd: 0.01, rail: "usdc", network: "eip155:8453", payer: p(1), tx: "0x" + "b".repeat(63) + i, responseSha256: H(i % 2 ? "b" : "c") });
    for (let i = 0; i < 5; i++) recordSale({ slug: "weather-forecast", priceUsd: 0.01, rail: "usdc", network: "eip155:8453", payer: p(1), tx: "0x" + "c".repeat(63) + i, responseSha256: H("d"), synthetic: true });
    recordSale({ slug: "stock-quote", priceUsd: 0.01, rail: "usdc", network: "eip155:8453", payer: p(9), tx: "0x" + "d".repeat(64), responseSha256: null });
    await salesLedgerFlush();
    console.log(JSON.stringify(answerDigestWindow(0, Date.now() + 1000)));
  `;
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, SALES_LEDGER_DB: join(dir, "sales.db"), STATE_DATABASE_URL: "" }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const rows = JSON.parse(r.stdout.trim().split("\n").at(-1));
    const by = Object.fromEntries(rows.map((x) => [x.slug, x]));
    assert.deepEqual(by["stock-quote"], { slug: "stock-quote", sales: 5, distinctAnswers: 1, payers: 5 }, "a row without a digest is not counted");
    assert.deepEqual(by["fx-rate"], { slug: "fx-rate", sales: 5, distinctAnswers: 2, payers: 1 });
    assert.equal(by["weather-forecast"], undefined, "our own traffic is not counted");
    const m = createToolFailureMonitor({ now: () => T0, env: {}, identicalAnswers: () => rows });
    const rep = await m.report();
    assert.deepEqual(rep.identicalAnswers.slugs.map((x) => x.slug), ["stock-quote"]);
    assert.equal(rep.identicalAnswers.read, true);
    assert.deepEqual(rep.issueSummary.identicalAnswers, ["stock-quote"]);
    assert.ok(!JSON.stringify(rep.identicalAnswers).match(/0x[0-9a-f]{40}|aaaaaaaa/), "no payer or digest leaves the read");
    const broken = createToolFailureMonitor({ now: () => T0, env: {}, identicalAnswers: () => { throw new Error("db gone"); } });
    const rb = await broken.report();
    assert.equal(rb.identicalAnswers.read, false);
    assert.equal((await broken.status({ fresh: true })).toolAnswers.status, "ok", "the identical read never feeds the public word");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- alarm: heartbeat.yml step and the status Worker ---------------------------------
const TITLE = "toolAnswers: a tool is answering empty or error-shaped 200s";
await check("heartbeat.yml: degraded opens one issue (word and operator endpoint only), open comments, ok closes, unknown does neither", async () => {
  const wf = yamlLoad(await readFile(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8"));
  const step = Object.values(wf.jobs).flatMap((j) => j.steps || []).find((s) => String(s.name || "").startsWith("Tool answer shape check"));
  assert.ok(step, "the step exists");
  assert.doesNotMatch(step.run, /curl[^\n]*\/__operator\//, "the step never reads the operator endpoint");
  const dir = await mkdtemp(path.join(tmpdir(), "hb-answers-"));
  try {
    await writeFile(path.join(dir, "curl"), `#!/usr/bin/env bash\ncat "$GS_FILE"\n`);
    await writeFile(path.join(dir, "gh"), `#!/usr/bin/env bash
if [ "$1 $2" = "issue list" ]; then
  for a in "$@"; do case "$a" in *"$OPEN_TITLE"*) [ -n "$OPEN_TITLE" ] && echo "41" && exit 0;; esac; done
  exit 0
fi
printf '%s\\x1f' "$@" >> "$GH_LOG"; printf '\\n' >> "$GH_LOG"
`);
    await chmod(path.join(dir, "curl"), 0o755); await chmod(path.join(dir, "gh"), 0o755);
    const run = async (word, open = "") => {
      const gs = path.join(dir, "gs.json"), log = path.join(dir, "gh.log");
      await writeFile(gs, JSON.stringify(word === null ? {} : { toolAnswers: { status: word } })); await writeFile(log, "");
      const r = spawnSync("bash", ["-e", "-c", step.run], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROD: "https://example.invalid", GITHUB_REPOSITORY: "o/r", GS_FILE: gs, GH_LOG: log, OPEN_TITLE: open }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return (await readFile(log, "utf8")).split("\n").filter(Boolean).map((l) => l.split("\x1f").filter((x) => x !== ""));
    };
    let calls = await run("degraded");
    const created = calls.filter((c) => c[1] === "create");
    assert.equal(created.length, 1);
    assert.equal(created[0][created[0].indexOf("--title") + 1], TITLE);
    const body = created[0][created[0].indexOf("--body") + 1];
    assert.match(body, /toolAnswers\.status=degraded\./);
    assert.match(body, /\/__operator\/tool-failures\.json/);
    calls = await run("degraded", TITLE);
    assert.ok(calls.some((c) => c[1] === "comment" && c[2] === "41") && !calls.some((c) => c[1] === "create"));
    calls = await run("ok", TITLE);
    assert.ok(calls.some((c) => c[1] === "close" && c[2] === "41"));
    for (const w of ["unknown", null]) { calls = await run(w, TITLE); assert.deepEqual(calls, [], `${w}: nothing`); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
await check("the status Worker maps toolAnswers under the same title", async () => {
  const { ALARMS, judge } = await import("../workers/status-probe/src/index.js");
  const a = ALARMS.find((x) => x.title === TITLE);
  assert.ok(a, "Worker alarm exists");
  const j = (gw) => judge({ gateway: gw })[TITLE];
  assert.equal(j({ toolAnswers: { status: "degraded" } }), "bad");
  assert.equal(j({ toolAnswers: { status: "ok" } }), "good");
  assert.equal(j({ toolAnswers: { status: "unknown" } }), "quiet");
  assert.equal(j({}), "quiet");
  const b = a.body({ gateway: { toolAnswers: { status: "<b>" } } });
  assert.match(b, /toolAnswers\.status=degraded\./);
  assert.doesNotMatch(b, /slug|search|stock/i);
});

// ---- booted: a paid-mode server classifies paid answers ------------------------------
await check("booted (paid mode, stub facilitator): a paid empty answer and a paid ok answer are counted by class", async () => {
  const { createServer } = await import("node:http");
  const [PORT, FAC_PORT] = await getFreePorts(2);
  const TMP = await mkdtemp(join(tmpdir(), "answer-shape-boot-"));
  const TOKEN = "answer-shape-test-operator-token-0123456789";
  const facilitator = createServer((req, res) => {
    let b = ""; req.on("data", (c) => { b += c; });
    req.on("end", () => {
      const reply = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url === "/supported") return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
      if (req.url === "/rpc") return reply({ jsonrpc: "2.0", id: 1, result: "0x" + (1_000_000_000).toString(16).padStart(64, "0") });
      let p = {}; try { p = JSON.parse(b || "{}"); } catch { /* ignore */ }
      const payer = p.paymentPayload?.payload?.authorization?.from;
      if (req.url === "/verify") return reply({ isValid: true, payer });
      if (req.url === "/settle") return reply({ success: true, transaction: "0x" + randomBytes(32).toString("hex"), network: "eip155:8453", payer });
      reply({});
    });
  });
  await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));
  const log = [];
  const proc = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
      FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
      CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "", TEMPO_API_KEY: "", STRIPE_SECRET_KEY: "", POSTHOG_API_KEY: "", REDIS_URL: "",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", STATE_DATABASE_URL: "",
      LEADERBOARD_FIRST_REFRESH_DELAY_MS: "600000", AGENT402_OPERATOR_TOKEN: TOKEN,
      AGENT402_TASK_DATA_DIR: join(TMP, "tasks"), REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, "sales.db"), HANGUP_FORGIVE_FILE: join(TMP, "hangup.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const s of [proc.stdout, proc.stderr]) s.on("data", (d) => { for (const l of String(d).split("\n")) if (l.trim()) log.push(l.slice(0, 300)); });
  const B = `http://127.0.0.1:${PORT}`;
  const wallet = (n) => `0x${n.toString(16).padStart(40, "0")}`;
  const paidPost = async (route, body, payer) => {
    let unpaid;
    for (let i = 0; i < 120; i++) {
      try { unpaid = await fetch(`${B}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (unpaid.status === 402) break; } catch { /* booting */ }
      await sleep(500);
    }
    assert.equal(unpaid?.status, 402, `${route} quotes`);
    const offer = JSON.parse(Buffer.from(unpaid.headers.get("payment-required") || "", "base64").toString("utf8") || "{}");
    const accepted = (offer.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
    const credential = Buffer.from(JSON.stringify({ x402Version: 2, resource: offer.resource, accepted,
      payload: { signature: "0x" + "11".repeat(65), authorization: { from: payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + randomBytes(32).toString("hex") } } })).toString("base64");
    return fetch(`${B}${route}`, { method: "POST", headers: { "Content-Type": "application/json", "Payment-Signature": credential }, body: JSON.stringify(body) });
  };
  const op = async () => (await fetch(`${B}/__operator/tool-failures.json`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  try {
    // A fresh sales ledger holds no external sale, so the bestsellers board
    // the example shows populated answers empty: a live-data empty 200.
    const r1 = await paidPost("/api/bestsellers", {}, wallet(0x5151));
    assert.equal(r1.status, 200, `bestsellers paid (${r1.status}) ${log.slice(-5).join(" | ")}`);
    const j1 = await r1.json();
    assert.ok(Array.isArray(j1.bestsellers) && j1.bestsellers.length === 0, "the board is empty on a fresh ledger");
    const r2 = await paidPost("/api/hash", { text: "hello world" }, wallet(0x5152));
    assert.equal(r2.status, 200);
    let rep = null;
    for (let i = 0; i < 40; i++) { rep = await op(); if ((rep.answerTotals?.hour?.outside?.ok || 0) >= 1 && rep.answers?.length) break; await sleep(100); }
    const row = rep.answers.find((x) => x.slug === "bestsellers");
    assert.ok(row, `bestsellers has a row (${JSON.stringify(rep.answers)})`);
    assert.equal(row.hour.outside.empty, 1);
    assert.deepEqual(row.last[0].reasons, ["bestsellers"]);
    assert.ok(rep.answerTotals.hour.outside.ok >= 1, "the paid hash answer counted ok");
    assert.equal(rep.toolAnswers, "ok", "one empty answer is under the minimum");
    const pub = await (await fetch(`${B}/api/gateway-status`)).json();
    assert.deepEqual(pub.toolAnswers, { status: "ok" });
  } finally {
    proc.kill("SIGTERM");
    facilitator.close();
    await rm(TMP, { recursive: true, force: true }).catch(() => {});
  }
});

console.log(`\ntest-answer-shape: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
