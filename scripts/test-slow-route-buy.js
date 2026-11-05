#!/usr/bin/env node
// Offline: the repo's buy scripts honor the slow-route contract
// (scripts/lib/slow-route-buy.js). Against a stub server on port 0 that
// refuses a slow route's paid call without Prefer: respond-async (400
// respond_async_required, before payment) and answers 202 plus a job with it:
//   - a slow route's paid call carries Prefer: respond-async up front and its
//     job is followed to the route's final answer (status, receipt, body);
//   - a route that is not slow sends no Prefer header;
//   - a job that ends failed is a failed call (an error status, never 2xx);
//   - a 400 respond_async_required is sent once more with the header its body
//     names, once only, and no other answer earns that retry;
//   - scripts/catalog-buy.js buys through it (no Prefer: wait, a failed job is
//     never retried);
//   - base-list-sweep, cross-chain-matrix, decide-paid-e2e and
//     decide-prod-check, each run whole in a child with a throwaway key that
//     signs real x402 payloads for the stub (a preload sends the production
//     and Bazaar hosts to the stub and refuses every other host), pay a slow
//     route with the header up front and follow its job, and a route that is
//     not slow with no Prefer header.
// Never spends, never reaches the network beyond 127.0.0.1.
import "./lib/offline-stores.js";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { generatePrivateKey } from "viem/accounts";
import { asyncAdviceByPath, asyncRefusalPreferOf, slowPreferOf, paidCallHonoringSlowRoutes, RESPOND_ASYNC, redactJobLinks } from "./lib/slow-route-buy.js";
import { runCatalogBuy } from "./catalog-buy.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const ASYNC = { recommended: true, expectedSeconds: 90, maxSeconds: 180, prefer: "respond-async", accepted: 202, statusUrl: "/api/jobs/{id}", preferWait: "wait=180", withoutPrefer: 400 };
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

// Routes: `slow` refuses a paid call without respond-async; `ending` says how
// its job ends. `refuseAlways` refuses even with the header. `answer` is a
// synchronous route's answer.
const ROUTES = {
  "/api/fast":        { slug: "fast", usd: 0.001 },
  "/v1/report":       { slug: "report", usd: 0.5, slow: true, advice: ASYNC, ending: "succeeded" },
  "/v1/unmarked":     { slug: "unmarked", usd: 0.2, slow: true, ending: "succeeded" },
  "/v1/fails":        { slug: "fails", usd: 0.3, slow: true, advice: ASYNC, ending: "failed" },
  "/v1/odd-fail":     { slug: "odd-fail", usd: 0.3, slow: true, advice: ASYNC, ending: "failed-200" },
  "/v1/stubborn":     { slug: "stubborn", usd: 0.2, slow: true, refuseAlways: true },
  "/v1/stubborn-marked": { slug: "stubborn-marked", usd: 0.2, slow: true, advice: ASYNC, refuseAlways: true },
  "/api/bad-input":   { slug: "bad-input", usd: 0.001, answer: [400, { error: "invalid_input", prefer: "respond-async" }] },
  "/api/odd-refusal": { slug: "odd-refusal", usd: 0.001, answer: [400, { error: "respond_async_required", prefer: "wait=180" }] },
  "/api/broken":      { slug: "broken", usd: 0.001, answer: [500, { error: "boom" }] },
  // The child-run scripts' routes.
  "/v1/research":     { slug: "research", usd: 0.1, slow: true, advice: ASYNC, ending: "succeeded" },
  "/api/rsi":         { slug: "rsi", usd: 0.001 },
  "/api/memory/remember": { slug: "memory-remember", usd: 0.001 },
  "/api/decide":      { slug: "decide", usd: 0.01, body: { decisionId: "d1", plan: [{ step: 1, tool: { slug: "rsi", firstParty: true, inputSchema: { type: "object" }, exampleParams: {} } }], executionCredit: { token: "c1", amountUsd: 0.01 }, feedbackToken: "f1" } },
  "/api/decide/execute": { slug: "decide-execute", usd: 0.001, slow: true, advice: ASYNC, ending: "succeeded", jobBody: { status: "complete", budgetUsd: 0.001, creditAppliedUsd: 0, paidUsd: 0.001, spentUsd: 0, charges: {}, steps: [] } },
};
const pricing = { endpoints: Object.entries(ROUTES).map(([path, r]) => ({ method: "POST", path, slug: r.slug, price: `$${r.usd}`, ...(r.advice ? { async: r.advice } : {}) })) };
const spec = { paths: Object.fromEntries(Object.entries(ROUTES).map(([path, r]) => [path, { post: { tags: ["stub"], requestBody: { content: { "application/json": { example: { q: r.slug } } } }, responses: { 200: { content: { "application/json": { example: { ok: true } } } } } } }])) };

let seen = [];   // every request to a route: { path, paid, prefer }
let polls = [];  // every job poll: { id }
const jobs = new Map();
let jobN = 0, txN = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  for await (const _ of req) { /* drain */ }
  const json = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/pricing") return json(200, pricing);
  if (url.pathname === "/openapi.json") return json(200, spec);
  if (url.pathname === "/api/sales") return json(200, { topExternal: [{ slug: "research" }, { slug: "rsi" }] });
  if (url.pathname === "/api/decide/feedback") return json(200, { ok: true });
  // The Bazaar feed (base-list-sweep): every route on its list is listed but
  // one slow route and one that is not slow.
  if (url.pathname === "/platform/v2/x402/discovery/resources") return json(200, { items: SWEEP_LISTED.map((p) => ({ resource: `${T}${p}` })), pagination: { total: SWEEP_LISTED.length } });
  const jm = url.pathname.match(/^\/api\/jobs\/(\w+)$/);
  if (jm) {
    polls.push({ id: jm[1] });
    const j = jobs.get(jm[1]);
    if (!j) return json(404, { error: "job_not_found" });
    j.polls++;
    if (j.polls < 2) return json(200, { jobId: jm[1], status: "working", state: "running", pollIntervalSeconds: 1 }, { "retry-after": "1" });
    if (j.ending === "succeeded") return json(200, { jobId: jm[1], status: "completed", state: "succeeded", result: { httpStatus: 200, headers: { "payment-response": enc({ success: true, transaction: `tx-job-${j.slug}` }) }, body: j.body || { ok: true, via: "job" } } });
    if (j.ending === "failed-200") return json(200, { jobId: jm[1], status: "failed", state: "failed", message: "The call did not finish.", error: { httpStatus: 200, body: { partial: true } } });
    return json(200, { jobId: jm[1], status: "failed", state: "failed", message: "The call ended with HTTP 500 and nothing was charged.", error: { httpStatus: 500, body: { error: "upstream_failed" } } });
  }
  const route = ROUTES[url.pathname];
  if (!route) return json(404, { error: "no such route" });
  const paid = Boolean(req.headers["payment-signature"]);
  const prefer = req.headers.prefer ?? null;
  seen.push({ path: url.pathname, paid, prefer });
  if (!paid) {
    // A real v2 challenge (a stock client signs it), with the bazaar example
    // and, for a slow route, the async block in the body.
    const pr = { x402Version: 2, error: "Payment required", resource: { url: `${T}${url.pathname}`, description: route.slug, mimeType: "application/json" }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: String(Math.round(route.usd * 1e6)), asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }], extensions: { bazaar: { info: { input: { type: "http", method: "POST", bodyType: "json", body: { q: route.slug } } } } } };
    return json(402, { ...pr, ...(route.advice ? { async: route.advice } : {}) }, { "payment-required": enc(pr) });
  }
  if (route.slow) {
    if (route.refuseAlways || !/respond-async/.test(String(prefer || ""))) return json(400, { error: "respond_async_required", slug: route.slug, maxSeconds: 180, syncWindowSeconds: 20, prefer: "respond-async", preferWait: "wait=180", statusUrl: "/api/jobs/{id}" });
    const id = `job${++jobN}`;
    jobs.set(id, { slug: route.slug, ending: route.ending, body: route.jobBody, polls: 0 });
    return json(202, { jobId: id, status: "working", state: "queued", statusUrl: `/api/jobs/${id}`, pollIntervalSeconds: 1 }, { location: `/api/jobs/${id}`, "retry-after": "1" });
  }
  if (route.answer) return json(route.answer[0], route.answer[1]);
  return json(200, route.body || { ok: true, via: "sync" }, { "payment-response": enc({ success: true, transaction: `tx-${++txN}` }) });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const T = `http://127.0.0.1:${server.address().port}`;
const SWEEP_SRC = readFileSync(new URL("base-list-sweep.js", import.meta.url), "utf8");
const SWEEP_LISTED = [...SWEEP_SRC.matchAll(/"(?:GET|POST) (\/[^"\s]+)"/g)].map((m) => m[1]).filter((p) => p !== "/v1/research" && p !== "/api/rsi");
const reset = () => { seen = []; polls = []; };
const noSleep = async () => {};

// --- the helper's pure parts
ok(slowPreferOf(ASYNC) === RESPOND_ASYNC, "a recommended async block asks for respond-async");
ok(slowPreferOf({ recommended: false, withoutPrefer: 400 }) === RESPOND_ASYNC, "a block that says a paid call without the header is refused asks for respond-async");
ok(slowPreferOf({ recommended: false, prefer: "respond-async" }) === null, "an async-capable route that is not slow sends no Prefer");
ok(slowPreferOf(null) === null && slowPreferOf(ASYNC, { method: "GET" }) === null && slowPreferOf(ASYNC, { json: false }) === null, "no block, a GET, or a non-JSON body sends no Prefer (a job replays a JSON POST only)");
const byPath = asyncAdviceByPath(pricing);
ok(byPath.get("/v1/report")?.withoutPrefer === 400 && !byPath.has("/api/fast") && !byPath.has("/v1/unmarked"), "asyncAdviceByPath maps each pricing row that carries an async block");
ok(asyncRefusalPreferOf(400, JSON.stringify({ error: "respond_async_required", prefer: "respond-async" })) === RESPOND_ASYNC, "a 400 respond_async_required names respond-async");
ok(asyncRefusalPreferOf(400, JSON.stringify({ error: "invalid_input", prefer: "respond-async" })) === null && asyncRefusalPreferOf(504, JSON.stringify({ error: "respond_async_required", prefer: "respond-async" })) === null && asyncRefusalPreferOf(400, "not json") === null, "any other error, status or body names nothing");

// --- the helper against the stub
const sends = [];
const call = (path, prefer) => paidCallHonoringSlowRoutes(async (extra, attempt) => {
  sends.push({ path, extra, attempt });
  return fetch(`${T}${path}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": "sig", ...extra }, body: JSON.stringify({ q: 1 }) });
}, { prefer, baseUrl: T, fetchImpl: fetch, slug: path, sleep: noSleep });

{
  reset(); sends.length = 0;
  const r = await call("/v1/report", slowPreferOf(byPath.get("/v1/report")));
  const body = await r.res.json();
  ok(seen.length === 1 && seen[0].prefer === "respond-async", `a slow route's paid call carries Prefer: respond-async up front, one call (${seen.map((s) => s.prefer).join()})`);
  ok(r.res.status === 200 && body.via === "job" && JSON.parse(Buffer.from(r.res.headers.get("payment-response"), "base64").toString()).transaction === "tx-job-report", "the job is followed to the route's own answer: status, receipt and body");
  ok(polls.length === 2 && r.job?.state === "succeeded" && r.jobFailed === false && r.attempts === 1 && r.fallback === false && r.prefer === "respond-async", `the job link is polled to its terminal state (${polls.length} polls, ${JSON.stringify(r.job)})`);
}
// A job id is a bearer link to the paid answer: the helper hands back the
// job's state only, and a job still pending reaches the caller with its link
// redacted from the message and dropped from the error.
{
  const ID = "f".repeat(48);
  ok(redactJobLinks(`collect it from ${T}/api/jobs/${ID} (free)`) === `collect it from ${T}/api/jobs/<redacted> (free)` && redactJobLinks(`{"statusUrl":"/api/jobs/x-1.Z","jobId":"${ID}"}`) === `{"statusUrl":"/api/jobs/<redacted>","jobId":"<redacted>"}` && redactJobLinks(`%2Fapi%2Fjobs%2F${ID}&a=1`) === "%2Fapi%2Fjobs%2F<redacted>&a=1" && redactJobLinks(`{\\"jobId\\":\\"${ID}\\"}`) === `{\\"jobId\\":\\"<redacted>\\"}`, "redactJobLinks blanks a job link of any id shape, plain or percent-encoded, and a jobId value, escaped or not");
  ok(redactJobLinks("/api/jobs/{id}") === "/api/jobs/{id}" && redactJobLinks("HTTP 500 upstream_failed") === "HTTP 500 upstream_failed", "and leaves the documented link template and other text alone");
  reset();
  const seenJobs = [];
  const r = await paidCallHonoringSlowRoutes(async (extra) => fetch(`${T}/v1/report`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": "sig", ...extra }, body: "{}" }), { prefer: RESPOND_ASYNC, baseUrl: T, fetchImpl: fetch, slug: "report", sleep: noSleep, onJob: (j) => seenJobs.push(j) });
  ok(r.res.status === 200 && JSON.stringify(r.job) === JSON.stringify({ state: "succeeded" }) && seenJobs.length && seenJobs.every((j) => !("id" in j)), `the helper hands back and reports the job's state, never its id (${JSON.stringify(r.job)}, ${JSON.stringify(seenJobs)})`);
  // A 202 whose job the link no longer knows: pending to the buyer, may be charged.
  let thrown = null;
  try {
    await paidCallHonoringSlowRoutes(async () => new Response(JSON.stringify({ jobId: ID, state: "queued", statusUrl: `/api/jobs/${ID}` }), { status: 202, headers: { location: `/api/jobs/${ID}`, "retry-after": "1" } }), { prefer: RESPOND_ASYNC, baseUrl: T, fetchImpl: fetch, slug: "report", sleep: noSleep });
  } catch (e) { thrown = e; }
  ok(thrown?.name === "AsyncJobPendingError" && thrown.mayBeCharged === true && !String(thrown.message).includes(ID) && /\/api\/jobs\/<redacted>/.test(thrown.message) && thrown.jobUrl === null && JSON.stringify(thrown.job) === JSON.stringify({ state: "queued" }), `a pending job's error keeps its state and charge flag, never its id or link (${thrown?.message}; ${JSON.stringify({ jobUrl: thrown?.jobUrl, job: thrown?.job })})`);
}
{
  reset();
  const r = await call("/api/fast", slowPreferOf(byPath.get("/api/fast")));
  ok(r.res.status === 200 && seen.length === 1 && seen[0].prefer === null && r.prefer === null && r.job === null && polls.length === 0, "a route that is not slow sends no Prefer header and is answered synchronously");
}
{
  reset();
  const r = await call("/v1/fails", RESPOND_ASYNC);
  ok(r.jobFailed === true && r.res.status === 500 && r.job?.state === "failed" && seen.length === 1, `a job that ends failed is a failed call with the job's error status, never retried (${r.res.status}, ${seen.length} calls)`);
  reset();
  const o = await call("/v1/odd-fail", RESPOND_ASYNC);
  ok(o.jobFailed === true && o.res.status === 502, `a failed job whose error names a 2xx status still answers an error status (${o.res.status})`);
}
{
  reset(); sends.length = 0;
  const r = await call("/v1/unmarked", null);
  ok(r.res.status === 200 && seen.length === 2 && seen[0].prefer === null && seen[1].prefer === "respond-async" && r.fallback === true && r.attempts === 2 && r.job?.state === "succeeded", `a 400 respond_async_required is sent once more with Prefer: respond-async and its job followed (${seen.map((s) => s.prefer || "none").join()})`);
  ok(sends.map((s) => s.attempt).join() === "1,2", "the retry is the send's second attempt (a fresh signature for a signing caller)");
  reset();
  const s = await call("/v1/stubborn", null);
  ok(s.res.status === 400 && seen.length === 2 && s.fallback === true, `the fallback happens once: a refusal that repeats with the header is the answer (${seen.length} calls)`);
  reset();
  const m = await call("/v1/stubborn-marked", RESPOND_ASYNC);
  ok(m.res.status === 400 && seen.length === 1 && m.fallback === false, `a call that already sent the header gets no fallback retry (${seen.length} calls)`);
  for (const p of ["/api/bad-input", "/api/odd-refusal", "/api/broken"]) {
    reset();
    const x = await call(p, null);
    ok(seen.length === 1 && x.fallback === false && seen[0].prefer === null, `${p}: no fallback retry for any answer but a 400 respond_async_required naming respond-async (${x.res.status}, ${seen.length} calls)`);
  }
  reset();
  const b = await call("/api/bad-input", null);
  ok((await b.res.json()).error === "invalid_input", "an answer that earns no retry comes back unread");
}

// --- scripts/catalog-buy.js buys through it
{
  const quiet = { log() {}, warn() {}, error() {} };
  const payer = { address: "0x1111111111111111111111111111111111111111", parseChallenge: (_get, body) => body, pay: async () => ({ "PAYMENT-SIGNATURE": "stub-sig" }) };
  reset();
  const s = await runCatalogBuy({ target: T, payer, tier: "all", only: "fast,report,unmarked,fails,stubborn", capUsd: 100, paceMs: 0, retryBackoffMs: 0, log: quiet, capture: false, jobSleep: noSleep, now: new Date(Date.UTC(2026, 0, 7)) });
  const by = Object.fromEntries(s.results.map((r) => [r.slug, r]));
  const paidTo = (p) => seen.filter((x) => x.path === p && x.paid);
  ok(!seen.some((x) => /wait=/.test(String(x.prefer || ""))), "catalog-buy never sends Prefer: wait (the CDN refuses it for a long run budget)");
  ok(paidTo("/v1/report").length === 1 && paidTo("/v1/report")[0].prefer === "respond-async" && by.report?.pass === true && by.report.tx === "tx-job-report" && by.report.job?.state === "succeeded" && !("id" in by.report.job), `catalog-buy pays a slow route with respond-async and grades the job's answer (${JSON.stringify(by.report)})`);
  ok(paidTo("/api/fast").length === 1 && paidTo("/api/fast")[0].prefer === null && by.fast?.pass === true, "catalog-buy sends no Prefer for a route that is not slow");
  ok(paidTo("/v1/fails").length === 1 && by.fails?.pass === false && by.fails.grade === "http-500" && by.fails.attempts === 1, `catalog-buy grades a failed job as a failure and never retries it (${by.fails?.grade}, ${paidTo("/v1/fails").length} paid calls)`);
  ok(paidTo("/v1/unmarked").map((x) => x.prefer || "none").join() === "none,respond-async" && by.unmarked?.pass === true && by.unmarked.asyncFallback === true, "catalog-buy retries a 400 respond_async_required once with the named header");
  ok(paidTo("/v1/stubborn").length === 2 && by.stubborn?.pass === false && by.stubborn.grade === "http-400", "catalog-buy's fallback happens once");
  ok(Math.abs(s.spentUsd - (0.001 + 0.5 + 0.2)) < 1e-9, `only the settled buys stay charged against the cap ($${s.spentUsd})`);
}

// --- each other buy script makes its paid call through the helper
for (const f of ["base-list-sweep.js", "cross-chain-matrix.js", "decide-paid-e2e.mjs", "decide-prod-check.mjs", "catalog-buy.js"]) {
  const src = readFileSync(new URL(f, import.meta.url), "utf8");
  ok(/from "\.\/lib\/slow-route-buy\.js"/.test(src) && /paidCallHonoringSlowRoutes\(/.test(src) && /slowPreferOf\(/.test(src), `${f} makes its paid call through paidCallHonoringSlowRoutes with the route's slowPreferOf`);
  ok(!/Prefer["']?\s*:\s*["`']wait=/.test(src), `${f} sends no Prefer: wait`);
}

// --- each buy script run whole in a child against the stub
{
  const dir = mkdtempSync(join(tmpdir(), "slow-route-buy-"));
  const preload = join(dir, "loopback-fetch.mjs");
  // The production and Bazaar hosts go to the stub; every other host but the
  // loopback is refused, so a child can never reach the network.
  writeFileSync(preload, `
const origin = process.env.STUB_ORIGIN;
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const req = input instanceof Request ? input : null;
  const u = new URL(req ? req.url : String(input));
  if (u.hostname === "127.0.0.1") return real(input, init);
  if (u.hostname !== "agent402.tools" && u.hostname !== "api.cdp.coinbase.com") throw new Error("offline test: no fetch to " + u.host);
  const to = origin + u.pathname + u.search;
  if (!req) return real(to, init);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  return real(to, { method: req.method, headers: req.headers, body, ...(init || {}) });
};
`);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, STUB_ORIGIN: T, TARGET_URL: T, BURNER_KEY: generatePrivateKey(), POW_SECRET: "test-pow-secret", SWEEP_DELAY_MS: "0", MATRIX_TOP_N: "2" };
  const runChild = (script, args = [], extraEnv = {}) => new Promise((resolve) => {
    execFile(process.execPath, ["--import", pathToFileURL(preload).href, fileURLToPath(new URL(script, import.meta.url)), ...args], { env: { ...env, ...extraEnv }, timeout: 120_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout}${stderr}` }));
  });
  const paidTo = (p) => seen.filter((x) => x.path === p && x.paid);
  const tail = (r) => r.out.split("\n").slice(-8).join(" | ");

  reset();
  const sweepOut = join(dir, "sweep.json");
  const sw = await runChild("base-list-sweep.js", ["--out", sweepOut]);
  const rep = (() => { try { return JSON.parse(readFileSync(sweepOut, "utf8")); } catch { return null; } })();
  ok(sw.code === 0 && paidTo("/v1/research").length === 1 && paidTo("/v1/research")[0].prefer === "respond-async", `base-list-sweep pays a slow route with Prefer: respond-async up front (${paidTo("/v1/research").map((x) => x.prefer || "none").join()}; ${tail(sw)})`);
  ok(paidTo("/api/rsi").length === 1 && paidTo("/api/rsi")[0].prefer === null, "base-list-sweep sends no Prefer for a route that is not slow");
  ok(rep?.bought?.some((b) => b.entry === "POST /v1/research" && b.tx === "tx-job-research") && polls.length >= 2 && !rep.failed.length, `base-list-sweep follows the job and records its settlement tx (${JSON.stringify(rep?.bought)})`);

  reset();
  const mx = await runChild("cross-chain-matrix.js", ["2"]);
  ok(paidTo("/v1/research").length === 1 && paidTo("/v1/research")[0].prefer === "respond-async" && /✓[^\n]*research/.test(mx.out), `cross-chain-matrix pays a slow route with respond-async and its Base cell is green through the job (${tail(mx)})`);
  ok(paidTo("/api/rsi").length === 1 && paidTo("/api/rsi")[0].prefer === null, "cross-chain-matrix sends no Prefer for a route that is not slow");

  reset();
  const e2eOut = join(dir, "e2e.json");
  const e2e = await runChild("decide-paid-e2e.mjs", ["--skip-tempo", "--out", e2eOut]);
  const e2eDoc = (() => { try { return JSON.parse(readFileSync(e2eOut, "utf8")); } catch { return null; } })();
  ok(e2e.code === 0 && paidTo("/api/decide/execute").length === 1 && paidTo("/api/decide/execute")[0].prefer === "respond-async" && e2eDoc?.execute?.status === "complete" && e2eDoc?.executeReceipt?.transaction === "tx-job-decide-execute", `decide-paid-e2e pays decide-execute with respond-async and checks the job's answer and receipt (${tail(e2e)})`);
  ok(paidTo("/api/decide").length === 1 && paidTo("/api/decide")[0].prefer === null, "decide-paid-e2e sends no Prefer for the plan call");

  reset();
  const pcOut = join(dir, "prod-check.json");
  const pc = await runChild("decide-prod-check.mjs", [pcOut], { ONLY: "Convert this CSV" });
  const pcRows = (() => { try { return JSON.parse(readFileSync(pcOut, "utf8")); } catch { return null; } })();
  ok(pc.code === 0 && paidTo("/api/decide/execute").length === 1 && paidTo("/api/decide/execute")[0].prefer === "respond-async" && pcRows?.[0]?.run?.http === 200 && pcRows[0].run.status === "complete", `decide-prod-check pays decide-execute with respond-async and records the job's answer (${JSON.stringify(pcRows?.[0]?.run || null)}; ${tail(pc)})`);
  ok(paidTo("/api/decide").length === 1 && paidTo("/api/decide")[0].prefer === null, "decide-prod-check sends no Prefer for the plan call");
  rmSync(dir, { recursive: true, force: true });
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
