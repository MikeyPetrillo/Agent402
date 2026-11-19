// Per-tool reliability (GET /api/reliability/tools, src/tool-reliability.js).
//
//   1. The document, from stub outcomes: every catalog route listed by slug
//      whatever its traffic; a row under the sample floor is unmeasured with
//      null figures and reads "not enough data"; no count or band reaches
//      the public answer (the operator view keeps exact counts); the rate is
//      floored (a tool with one failure never reads 1); no store, a failed
//      query and the off switch each say available:false and why, with no
//      figure; ?slug narrows to one row; the partial-answer fields.
//   2. The cache: one query per window, single-flight, a failed read retried
//      after a minute, a thrown load read as a failure.
//   3. Against a real Postgres (required under CI): getToolOutcomes counts a
//      2xx and a legacy clean row as answered, a 5xx as failed, leaves a 4xx,
//      synthetic, probe, pre-payment and out-of-window rows out, and its
//      p50/p95 are over the same rows.
//   4. server.js serves it under the path constant, and /api/pricing points
//      to it only while the switch is on.
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import pg from "pg";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { requireTestPg } from "./lib/test-pg.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const R = await import("../src/tool-reliability.js");
const TOOLS = [{ slug: "zeta", route: "POST /api/zeta" }, { slug: "alpha", route: "POST /api/alpha" }, { slug: "mid", route: "GET /api/mid" }, { slug: "quiet", route: "POST /api/quiet" }];
const MIN = R.TOOL_RELIABILITY_MIN_SAMPLE;

// ---- 1. the document ----
{
  const result = { ok: true, rows: [
    { slug: "alpha", n: 1234, ok: 1233, serverErrored: 1, p50: 42, p95: 380 },
    { slug: "zeta", n: MIN - 1, ok: MIN - 1, serverErrored: 0, p50: 10, p95: 20 },
    { slug: "mid", n: MIN, ok: MIN, serverErrored: 0, p50: 7, p95: 9 },
    { slug: "not-in-catalog", n: 500, ok: 500, p50: 1, p95: 1 },
  ] };
  const d = R.toolReliabilityDocument({ baseUrl: "https://x", tools: TOOLS, result, asOf: "2026-11-18T00:00:00.000Z" });
  ok(d.available === true && !("reason" in d) && d.window.hours === R.TOOL_RELIABILITY_WINDOW_HOURS && d.minSample === MIN, "a measured document states its window and sample floor");
  ok(JSON.stringify(d.tools.map((t) => t.slug)) === JSON.stringify(["alpha", "mid", "quiet", "zeta"]), `every catalog route, by slug, none from outside it (${d.tools.map((t) => t.slug).join(",")})`);
  const a = d.tools.find((t) => t.slug === "alpha");
  ok(a.measured && a.successRate === 0.999 && a.p50Ms === 42 && a.p95Ms === 380 && a.status === "measured", `a measured row (${JSON.stringify(a)})`);
  const one = R.toolReliabilityDocument({ tools: TOOLS, result: { ok: true, rows: [{ slug: "alpha", n: 5000, ok: 4999, p50: 1, p95: 2 }] } }).tools.find((t) => t.slug === "alpha");
  ok(one.successRate === 0.999 && one.successRate < 1, "one failure in 5000 is floored to 0.999, never rounded to 1");
  const z = d.tools.find((t) => t.slug === "zeta");
  ok(!z.measured && z.successRate === null && z.p50Ms === null && z.p95Ms === null && z.status === "not enough data", `under the floor: not enough data, no figure (${JSON.stringify(z)})`);
  const m = d.tools.find((t) => t.slug === "mid");
  ok(m.measured && m.successRate === 1 && m.status === "measured", "at the floor: measured");
  const q = d.tools.find((t) => t.slug === "quiet");
  ok(!q.measured && q.status === "not enough data" && q.successRate === null, "no calls: not enough data");
  const text = JSON.stringify(d);
  ok(!/"(n|ok|serverErrored|serverErrors|calls|sample|sampleSize|count)":/.test(text) && !text.includes("1234") && !text.includes("1233") && !/\d+-\d+"|\d\+"/.test(text), "the public answer carries no count and no band field (status only)");
  for (const row of d.tools) ok(JSON.stringify(Object.keys(row)) === JSON.stringify(["slug", "route", "status", "measured", "successRate", "p50Ms", "p95Ms"]), `${row.slug}: public row keys are exactly the status and figures`);
  const op = R.toolReliabilityDocument({ tools: TOOLS, result, operator: true });
  ok(op.tools.find((t) => t.slug === "alpha").calls === 1234 && op.tools.find((t) => t.slug === "alpha").serverErrors === 1 && op.tools.find((t) => t.slug === "quiet").calls === 0, "the operator view keeps the exact counts");
  ok(d.returned === 4 && d.matched === 4 && d.complete === true && d.truncated === false, "the partial-answer fields: the whole list");
  const s = R.toolReliabilityDocument({ tools: TOOLS, result, slug: "mid" });
  ok(s.tools.length === 1 && s.tools[0].slug === "mid" && s.matched === 1 && s.complete, "?slug narrows to one row");
  for (const [name, args, reason] of [["no store", { result: { ok: false, enabled: false, reason: "not-configured" } }, "not-configured"], ["a failed query", { result: { ok: false, enabled: true, reason: "query-failed" } }, "query-failed"], ["switched off", { result, off: true }, "off"], ["no result", { result: null }, "not-configured"]]) {
    const u = R.toolReliabilityDocument({ tools: TOOLS, ...args });
    ok(u.available === false && u.reason === reason && u.tools.length === 4 && u.tools.every((t) => t.measured === false && t.successRate === null && t.p50Ms === null && t.status === "not enough data" && !("calls" in t)), `${name}: available false, reason ${u.reason}, every row not enough data with no figure`);
  }
  ok(R.toolReliabilityEnabled({}) === true && R.toolReliabilityEnabled({ TOOL_RELIABILITY_PUBLIC: "off" }) === false && R.toolReliabilityEnabled({ TOOL_RELIABILITY_PUBLIC: " OFF " }) === false && ["0", "false", "no", " No "].every((v) => R.toolReliabilityEnabled({ TOOL_RELIABILITY_PUBLIC: v }) === false) && R.toolReliabilityEnabled({ TOOL_RELIABILITY_PUBLIC: "on" }) === true, "on by default; TOOL_RELIABILITY_PUBLIC=off (or 0, false, no) withdraws it");
}

// ---- 2. the cache ----
{
  R.__resetToolReliabilityCacheForTests();
  let calls = 0, release;
  const gate = new Promise((r) => { release = r; });
  const load = async ({ windowHours }) => { calls++; await gate; return { ok: true, rows: [], windowHours }; };
  const p1 = R.toolOutcomesCached(load), p2 = R.toolOutcomesCached(load);
  release();
  const [a, b] = await Promise.all([p1, p2]);
  ok(calls === 1 && a === b && a.windowHours === R.TOOL_RELIABILITY_WINDOW_HOURS, "two reads at once: one query, over the published window");
  await R.toolOutcomesCached(load);
  ok(calls === 1, "a read inside the window is served from memory");
  await R.toolOutcomesCached(load, { now: Date.now() + R.TOOL_RELIABILITY_CACHE_MS + 1 });
  ok(calls === 2, "past the window: queried again");
  R.__resetToolReliabilityCacheForTests();
  let n = 0;
  const failing = async () => { n++; return { ok: false, enabled: true, reason: "query-failed" }; };
  await R.toolOutcomesCached(failing);
  await R.toolOutcomesCached(failing, { now: Date.now() + 30_000 });
  ok(n === 1, "a failed read is kept for a minute (no query storm)");
  await R.toolOutcomesCached(failing, { now: Date.now() + 61_000 });
  ok(n === 2, "and retried after it");
  R.__resetToolReliabilityCacheForTests();
  const thrown = await R.toolOutcomesCached(async () => { throw new Error("boom"); });
  ok(thrown.ok === false && thrown.reason === "query-failed", "a load that throws reads as a failed query");
  R.__resetToolReliabilityCacheForTests();
}

// ---- 4. wiring (offline) ----
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/app\.get\(TOOL_RELIABILITY_PATH, async/.test(server) && /toolOutcomesCached\(getToolOutcomes\)/.test(server), "server.js serves the table under its path constant, through the cache");
  ok(/\.\.\.\(toolReliabilityEnabled\(\) \? \{ toolReliability: \{ url: `\$\{BASE_URL\}\$\{TOOL_RELIABILITY_PATH\}`/.test(server), "/api/pricing points to it only while the switch is on");
  ok(/status\(404\)\.json\(\{ error: `No tool with slug/.test(server), "an unknown ?slug is a 404 naming the list");
  ok(/const operator = operatorView\(req, res\);\n  if \(!operator\) res\.set\("Cache-Control", "public, max-age=300"\);/.test(server), "exact counts only on the operator view, which is never cached shared");
}

// ---- 3. the query, against a real Postgres ----
const { url } = requireTestPg({ label: "test-tool-reliability-pg" });
const dbName = `t_rel_${randomBytes(5).toString("hex")}`;
const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
const own = new URL(url);
own.pathname = `/${dbName}`;
process.env.ANALYTICS_DATABASE_URL = own.toString();
delete process.env.ANALYTICS_TEST_CAPTURE;
const adb = await import("../src/analytics-db.js");
const direct = new pg.Client({ connectionString: own.toString() });
try {
  const init = await adb.initAnalyticsDb();
  ok(init.ok, "the call log schema is created");
  await direct.connect();
  const ins = (slug, latency, status, { errored = status >= 400, synthetic = false, probe = false, pre = false, ageHours = 1 } = {}) =>
    direct.query("INSERT INTO tool_calls (ts, slug, latency_ms, cached, errored, status, synthetic, probe, pre_payment) VALUES (now() - make_interval(hours => $1::int), $2, $3, false, $4, $5, $6, $7, $8)", [ageHours, slug, latency, errored, status, synthetic, probe, pre]);
  // alpha: 8 answered (latency 10..80), 2 failed (latency 900, 1000), every excluded kind once.
  for (let i = 1; i <= 8; i++) await ins("alpha", i * 10, 200);
  await ins("alpha", 900, 502);
  await ins("alpha", 1000, 500);
  await ins("alpha", 5, 400);                      // the caller's input
  await ins("alpha", 5, 402);                      // a payment refusal
  await ins("alpha", 5, 0, { errored: true });     // legacy unclassified error: client
  await ins("alpha", 5, 200, { synthetic: true });
  await ins("alpha", 5, 500, { probe: true });
  await ins("alpha", 5, 500, { pre: true });
  await ins("alpha", 5, 500, { ageHours: R.TOOL_RELIABILITY_WINDOW_HOURS + 2 });
  await ins("legacy", 30, 0, { errored: false });  // legacy clean row: answered
  await ins("legacy", 40, 304);
  const r = await adb.getToolOutcomes({ windowHours: R.TOOL_RELIABILITY_WINDOW_HOURS });
  const a = r.rows.find((x) => x.slug === "alpha"), l = r.rows.find((x) => x.slug === "legacy");
  ok(r.ok && a && a.n === 10 && a.ok === 8 && a.serverErrored === 2, `alpha: 8 answered and 2 failed count; the 4xx, synthetic, probe, pre-payment and old rows do not (${JSON.stringify(a)})`);
  ok(a.p50 === 50 && a.p95 === 1000, `alpha: p50 and p95 over the same ten calls (${a.p50}, ${a.p95})`);
  ok(l && l.n === 2 && l.ok === 2, `a legacy clean row and a 304 count as answered (${JSON.stringify(l)})`);
  const d = R.toolReliabilityDocument({ tools: [{ slug: "alpha", route: "POST /api/alpha" }], result: r });
  ok(d.available && d.tools[0].status === "not enough data" && d.tools[0].measured === false, "ten calls stay under the floor: published not enough data");
  for (let i = 0; i < 10; i++) await ins("alpha", 20, 200);
  const d2 = R.toolReliabilityDocument({ tools: [{ slug: "alpha", route: "POST /api/alpha" }], result: await adb.getToolOutcomes({ windowHours: R.TOOL_RELIABILITY_WINDOW_HOURS }) });
  ok(d2.tools[0].measured && d2.tools[0].successRate === 0.9 && d2.tools[0].status === "measured", `twenty calls: measured, 18 of 20 answered (${JSON.stringify(d2.tools[0])})`);
} finally {
  await direct.end().catch(() => {});
  await adb.closeAnalyticsDb().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
  await admin.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
