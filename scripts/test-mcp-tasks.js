// test-mcp-tasks - the MCP Tasks extension (io.modelcontextprotocol/tasks) on
// the hosted connector. Offline: a bare express app + mountMcp with an INJECTED
// loopback, so every assertion drives the real connector code (capability gate,
// gate window, task store, cancellation, boot sweep) without any network, any
// wallet, or any upstream spend.
//
// What this pins:
//  - a long composite returns a task HANDLE, not a blocking wait;
//  - polling reports working, then completed, and the completed result is
//    byte-identical to what the blocking call would have returned;
//  - a run that fails is expressed as a real outcome, never a silent empty
//    success - and the money story ("not charged") is on the wire;
//  - cancellation aborts the paid run (a non-200 CANCELS settlement);
//  - a task record survives a restart, and an orphaned RUN resolves to failed
//    rather than polling forever;
//  - the 600+ fast tools and paid non-composites are untouched;
//  - a task is never minted for a call that has not cleared the paywall.
const TASK_GATE_MS_TEST = 150;
process.env.AGENT402_MCP_TASK_GATE_MS = String(TASK_GATE_MS_TEST); // keep the gate window short
process.env.AGENT402_MCP_TASK_POLL_MS = "50";
process.env.AGENT402_MCP_MAX_PER_MIN = "1000000";
process.env.AGENT402_MCP_MAX_PER_HOUR = "1000000";
process.env.AGENT402_MCP_REQ_PER_MIN = "1000000";
process.env.AGENT402_MCP_REQ_PER_HOUR = "1000000";
process.env.X402_INDEX_CRAWL = "off";
process.env.X402_SYNC_ON_START = "false";
// Small enough that one test's result cannot be retained (every other result
// here is a few hundred bytes).
process.env.AGENT402_MCP_TASK_MAX_RESULT_BYTES = "4096";

import express from "express";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Receipt } from "mppx";

const TMP = mkdtempSync(join(tmpdir(), "a402-mcp-tasks-"));
process.env.REFUND_DB_DIR = TMP;

const { mountMcp, TASK_PROGRESS_META } = await import("../src/mcp-http.js");
const { PROGRESS_HEADER, progressMiddleware, reportProgress } = await import("../src/job-progress.js");
const {
  createTaskStore, clientDeclaresTasks, mcpTasksEnabled, detailedTask, createTaskResult,
  TASKS_EXTENSION, TASK_INVALID_PARAMS, TASK_MISSING_CAPABILITY, isTaskMethod, newTaskId,
} = await import("../src/mcp-tasks.js");
const { EXPENSIVE_COMPOSITE_SLUGS } = await import("../src/composite-spend-guard.js");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  FAIL ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fixtures

const CLIENT_CAPS = { "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS_EXTENSION]: {} } } };

const def = (slug, route, price, extra = {}) => ({
  route, slug, name: slug, category: "test", price, description: `${slug} test tool`,
  tags: [slug], discovery: { inputSchema: { properties: { q: { type: "string" } } }, example: { q: "x" } },
  handler: async () => ({ ok: true, slug }), ...extra,
});

// research + market-brief are real EXPENSIVE_COMPOSITE_SLUGS; whois is a paid
// NON-composite; uuid is free (compute-payable).
const CATALOG = {
  "POST /v1/research": def("research", "POST /v1/research", "$1.00"),
  "POST /v1/research/market-brief": def("market-brief", "POST /v1/research/market-brief", "$15.00"),
  "POST /api/whois": def("whois", "POST /api/whois", "$0.001"),
  // A slow paid route that is NOT a composite (src/slow-routes.js): it runs
  // as a task too, and reports its own stage.
  "POST /api/image-gen-premium": def("image-gen-premium", "POST /api/image-gen-premium", "$0.12", { asyncProfile: { slow: true, expectedSeconds: 40, maxSeconds: 75, basisSeconds: 40 } }),
  // A long-running slug (src/composite-spend-guard.js LONG_RUNNING_SLUGS, as
  // image-gen-premium is): its 402 never offers Tempo, so no Tempo transfer
  // can reach it.
  "POST /api/decide/execute": def("decide-execute", "POST /api/decide/execute", "$0.05", { asyncProfile: { slow: true, expectedSeconds: 60, maxSeconds: 240, basisSeconds: 60 } }),
  // A slow paid route that is NOT long-running: its 402 offers Tempo.
  "POST /api/slow-paid": def("slow-paid", "POST /api/slow-paid", "$0.10", { asyncProfile: { slow: true, expectedSeconds: 40, maxSeconds: 75, basisSeconds: 40 } }),
  // An identity-bound route (src/payments.js isIdentityBoundRoute): its 402
  // never offers Tempo, so no Tempo transfer can reach it.
  "GET /api/my-usage": def("my-usage", "GET /api/my-usage", "$0.001"),
  // uuid is free AND deliberately slow: the free path must stay blocking
  // regardless of how long it runs.
  "GET /api/uuid": def("uuid", "GET /api/uuid", "$0.001", { handler: async () => { await new Promise((r) => setTimeout(r, 600)); return { ok: true, slug: "uuid", slow: true }; } }),
};

// A real mppx challenge, so the 402 path exercises the actual codec rather than
// a string the parser would silently drop.
const CHALLENGE_HEADER = Challenge.serialize(Challenge.from({
  realm: "agent402.tools", method: "evm", intent: "charge",
  expires: new Date(Date.now() + 300_000),
  request: {
    amount: "1000000", currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    recipient: "0x0000000000000000000000000000000000000001",
    methodDetails: { chainId: 8453, credentialTypes: ["authorization"], decimals: 6 },
  },
  secretKey: "test-secret-key-for-offline-tasks",
}));

const jsonRes = (status, body, headers = {}) => ({
  status, headers: new Headers({ "content-type": "application/json", ...headers }),
  contentType: "application/json", json: body,
});

// Injected loopback. `plan[slug]` decides what the "paid route" does, and every
// call records the abort signal so cancellation can be observed.
const calls = [];
let plan = {};
async function stubLoopback({ def: d, params, signal, timeoutMs, progressKey, credentialHeader }) {
  const rec = { slug: d.slug, params, signal, timeoutMs, aborted: false, progressKey, credentialHeader };
  calls.push(rec);
  const p = plan[d.slug] || { delayMs: 0, res: jsonRes(200, { ok: true, slug: d.slug }) };
  // What the real paid route does with the progress key: the middleware finds
  // the task's sink and the handler reports its stages through it.
  if (p.progress) {
    setTimeout(() => {
      const fakeReq = { headers: { [PROGRESS_HEADER]: progressKey } };
      progressMiddleware()(fakeReq, {}, () => {});
      for (const patch of p.progress) reportProgress(patch, fakeReq);
    }, p.progressAtMs ?? 0);
  }
  if (p.delayMs) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, p.delayMs);
      signal?.addEventListener("abort", () => { clearTimeout(t); rec.aborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
    });
  }
  if (p.throw) throw p.throw;
  return p.res;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
const STORE_DIR = join(TMP, "store");
// What the connector books on its own: a paid loopback that returned no
// answer (server.js feeds this to the failure monitor).
const cutoffs = [];
mountMcp(app, CATALOG, {
  baseUrl: "http://localhost", isComputePayable: (d) => d.slug === "uuid",
  mppLoopback: stubLoopback, taskStoreDir: STORE_DIR,
  onPaidCutoff: (slug, info) => cutoffs.push({ slug, ...info }),
});
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  if ((res.headers.get("content-type") || "").includes("event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line.slice(5).trim());
  }
  return JSON.parse(text);
}
const callComposite = (slug, { withCaps = true, args = { q: "hello" } } = {}) =>
  rpc("tools/call", { name: "catalog.call", arguments: { slug, params: args }, ...(withCaps ? { _meta: CLIENT_CAPS } : {}) });

// ---------------------------------------------------------------- 1. wiring

ok(mcpTasksEnabled(), "tasks are armed by default (AGENT402_MCP_TASKS unset)");
ok(isTaskMethod("tasks/get") && isTaskMethod("tasks/update") && isTaskMethod("tasks/cancel"), "the three ext-tasks methods are recognised");
ok(!isTaskMethod("tasks/result") && !isTaskMethod("tasks/list"), "the older 2025-11-25 core methods are NOT claimed (different wire, not this extension)");
ok(clientDeclaresTasks({ _meta: CLIENT_CAPS }), "a client declaring the extension in per-request _meta is detected");
ok(!clientDeclaresTasks({ _meta: {} }) && !clientDeclaresTasks({}) && !clientDeclaresTasks(null), "a client that did not declare it is never treated as declaring");
ok(/^[0-9a-f]{48}$/.test(newTaskId()), "task ids are 24 random bytes of hex (the id is the bearer on an authless connector)");

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
ok(init.result?.capabilities?.extensions?.[TASKS_EXTENSION] !== undefined, "the server advertises io.modelcontextprotocol/tasks in its capabilities");
{
  // This mount takes payment (MPP): catalog.call can run any paid slug, so it
  // must not tell hosts it is read-only (hosts skip confirmation on that hint).
  const ann = ((await rpc("tools/list", {})).result?.tools || []).find((t) => t.name === "catalog.call")?.annotations || {};
  ok(ann.readOnlyHint === false && ann.destructiveHint === true && ann.idempotentHint === false && ann.openWorldHint === true,
    `catalog.call on a payable connector is annotated as a paid, writing, open-world call (got ${JSON.stringify(ann)})`);
}

// ---------------------------------------------------------- 2. handle + poll

plan = { research: { delayMs: 700, res: jsonRes(200, { report: "the goods" }, { "payment-receipt": "" }) } };
const created = await callComposite("research");
const handle = created.result;
ok(handle?.resultType === "task", "a long composite answers with resultType:\"task\" (CreateTaskResult), not a blocking result");
ok(typeof handle?.taskId === "string" && handle.taskId.length === 48, "the handle carries a durable taskId");
ok(handle?.status === "working", "a new task starts in the working status");
ok(typeof handle?.createdAt === "string" && typeof handle?.lastUpdatedAt === "string", "createdAt and lastUpdatedAt are present (ISO 8601)");
ok(Object.hasOwn(handle || {}, "ttlMs") && handle.ttlMs !== undefined, "ttlMs is present (ms-suffixed, the 2026-07-28 field name)");
ok(handle?.pollIntervalMs === 50, "pollIntervalMs is advertised so clients do not hammer us");
ok(handle?.task === undefined, "CreateTaskResult is FLAT - no nested `task` object (that is the older 2025-11-25 shape)");
ok(readdirSync(STORE_DIR).some((f) => f === `${handle.taskId}.json`), "the task is durably on disk BEFORE the handle is returned");

const working = await rpc("tasks/get", { taskId: handle.taskId, _meta: CLIENT_CAPS });
ok(working.result?.status === "working", "polling an in-flight task reports working");
ok(working.result?.resultType === "complete", "tasks/get carries resultType:\"complete\"");
ok(working.result?.result === undefined && working.result?.error === undefined, "a working task carries neither result nor error");

await sleep(900);
const done = await rpc("tasks/get", { taskId: handle.taskId, _meta: CLIENT_CAPS });
ok(done.result?.status === "completed", "polling after the run finishes reports completed");
ok(done.result?.result?.structuredContent?.result?.report === "the goods", "the completed task carries the real tool result");
ok(Array.isArray(done.result?.result?.content), "the stored result is a CallToolResult - exactly what the blocking call would have returned");
ok(calls.filter((c) => c.slug === "research").length === 1, "the work ran exactly once (the in-flight request BECOMES the task, never a second run)");
ok(calls.find((c) => c.slug === "research").timeoutMs > 60_000, "a task run gets a timeout longer than the default 60s loopback bound");

// ------------------------------------------------- 2b. slow route + progress

plan = { "image-gen-premium": { delayMs: 900, progressAtMs: 300, progress: [{ phase: "running" }, { stage: "rendering", done: 1, total: 2 }], res: jsonRes(200, { data: [{ b64_json: "AA" }] }) } };
const imgHandle = (await callComposite("image-gen-premium")).result;
ok(imgHandle?.resultType === "task", "a slow non-composite route (asyncProfile) answers with a task handle");
ok(typeof calls.at(-1).progressKey === "string" && calls.at(-1).progressKey.length >= 32, "the task's loopback carries an in-process progress key");
const early = await rpc("tasks/get", { taskId: imgHandle.taskId, _meta: CLIENT_CAPS });
ok(early.result?._meta?.[TASK_PROGRESS_META]?.state === "queued", `before the handler starts the task's progress says queued (${early.result?._meta?.[TASK_PROGRESS_META]?.state})`);
await sleep(450);
const mid = await rpc("tasks/get", { taskId: imgHandle.taskId, _meta: CLIENT_CAPS });
const midP = mid.result?._meta?.[TASK_PROGRESS_META];
ok(mid.result?.status === "working" && midP?.state === "running" && midP?.stage === "rendering" && midP?.progress === 0.5 && midP?.steps?.total === 2, `a running task carries the route's stage and steps (${JSON.stringify(midP)})`);
ok(/Running image-gen-premium: rendering \(1 of 2 steps done\)/.test(mid.result?.statusMessage || ""), `statusMessage names the stage (${mid.result?.statusMessage})`);
ok(mid.result?.pollIntervalMs >= 1000 && Number.isInteger(midP?.etaSeconds), "a running task's poll interval and ETA follow its progress");
await sleep(700);
const fin = await rpc("tasks/get", { taskId: imgHandle.taskId, _meta: CLIENT_CAPS });
ok(fin.result?.status === "completed" && fin.result?._meta?.[TASK_PROGRESS_META]?.state === "succeeded" && fin.result?._meta?.[TASK_PROGRESS_META]?.progress === 1, "the finished task says succeeded with progress 1");
ok(fin.result?.statusMessage !== mid.result?.statusMessage, "a late progress write never reopens or relabels the finished task");

// ------------------------------------------------------------- 3. failures

// (a) a tool-level failure: HTTP >=400 from the paid route.
plan = { research: { delayMs: 400, res: jsonRes(502, { error: "upstream exploded" }) } };
const failing = await callComposite("research");
await sleep(700);
const failed = await rpc("tasks/get", { taskId: failing.result.taskId, _meta: CLIENT_CAPS });
const failedBody = JSON.stringify(failed.result);
ok(failed.result?.status === "completed", "a >=400 from the tool is a COMPLETED task whose result reports the error (ext-tasks: `failed` is for JSON-RPC errors only)");
ok(failed.result?.result?.isError === true, "that result is flagged isError - never a silent empty success");
ok(/not charged/i.test(failedBody), "the failure says plainly that the buyer was not charged");
ok(/upstream exploded/.test(failedBody), "our OWN route's error detail is relayed unchanged (the blocking path already does this; it is our route, never a third party's body)");

// (b) a JSON-RPC-level failure: the run itself blows up.
plan = { research: { delayMs: 400, throw: new Error("socket hang up") } };
const broke = await callComposite("research");
await sleep(700);
const brokeGot = await rpc("tasks/get", { taskId: broke.result.taskId, _meta: CLIENT_CAPS });
ok(brokeGot.result?.status === "failed", "a run that throws is expressed as a FAILED task");
ok(brokeGot.result?.error && typeof brokeGot.result.error.code === "number", "a failed task carries a JSON-RPC error object");
ok(!/socket hang up/.test(JSON.stringify(brokeGot.result)), "the internal error body is NEVER relayed to the buyer");
ok(/may still have completed and been charged/.test(String(brokeGot.result?.statusMessage || "")) && /recorded as owed in our refund ledger and repaid after review/.test(String(brokeGot.result?.statusMessage || "")) && !/automatic/i.test(String(brokeGot.result?.statusMessage || "")) && !/not charged/i.test(String(brokeGot.result?.statusMessage || "")), "a run whose result never reached the connector says it may have been charged and that a charge is owed back after review (the paid request settles server-side)");

// (c) a 402 that arrives AFTER the gate window still fails loudly, with the ask.
plan = { research: { delayMs: 400, res: jsonRes(402, { type: "https://paymentauth.org/problems/verification-failed", detail: "nope" }, { "www-authenticate": CHALLENGE_HEADER }) } };
const late402 = await callComposite("research");
await sleep(700);
const late402Got = await rpc("tasks/get", { taskId: late402.result.taskId, _meta: CLIENT_CAPS });
ok(late402Got.result?.status === "failed", "a 402 decided after the gate window fails the task rather than completing it emptily");
ok(late402Got.result?.error?.code === -32042, "that failure carries the -32042 payment-required code");
ok(Array.isArray(late402Got.result?.error?.data?.challenges) && late402Got.result.error.data.challenges.length > 0, "the payment challenges ride along so the client can pay and call again");

// --------------------------------------------- 4. no task without payment

plan = { research: { delayMs: 0, res: jsonRes(402, { type: "https://paymentauth.org/problems/x", detail: "pay up" }, { "www-authenticate": CHALLENGE_HEADER }) } };
const before = readdirSync(STORE_DIR).length;
const unpaid = await callComposite("research");
ok(unpaid.error?.code === -32042, "an unpaid composite gets the normal -32042 payment ask, synchronously");
ok(Array.isArray(unpaid.error?.data?.challenges) && unpaid.error.data.challenges.length > 0, "that ask carries live challenges");
ok(readdirSync(STORE_DIR).length === before, "NO task is minted for a call that has not cleared the paywall");

// A PAID blocking call to a slow route from a client that did not declare the
// tasks extension is refused BEFORE the loopback: served blocking, the run
// would be cut after the gate passed and its charge owed. The refusal carries
// the HTTP route's own code and names both ways forward. Unpaid, the same call
// still reaches the loopback for its 402; a route without a run budget past
// the connector's wait is served blocking as before.
{
  plan = { "image-gen-premium": { delayMs: 0, res: jsonRes(200, { never: true }) } };
  const nCalls = calls.length;
  const paidMeta = { "org.paymentauth/credential": "Payment not-a-real-credential" };
  const refused = await rpc("tools/call", { name: "catalog.call", arguments: { slug: "image-gen-premium", params: { prompt: "x" } }, _meta: paidMeta });
  const text = String(refused.result?.content?.[0]?.text || "");
  ok(refused.result?.isError === true && /^respond_async_required:/.test(text) && /refused before any payment was taken/.test(text), `a paid blocking call to a slow route without the tasks extension is refused as respond_async_required (${text.slice(0, 80)})`);
  ok(calls.length === nCalls, "...before any loopback ran (nothing was verified, run or charged)");
  ok(text.includes(TASKS_EXTENSION) && /Prefer: respond-async/.test(text) && /POST \/api\/image-gen-premium/.test(text), "the refusal names the tasks extension, the HTTP header and the route");
  const unpaid = await rpc("tools/call", { name: "catalog.call", arguments: { slug: "image-gen-premium", params: { prompt: "x" } } });
  ok(calls.length === nCalls + 1 && !/respond_async_required/.test(JSON.stringify(unpaid)), "an unpaid blocking call to the same route still reaches the loopback (for its 402)");
  const quick = await rpc("tools/call", { name: "catalog.call", arguments: { slug: "whois", params: { domain: "example.com" } }, _meta: paidMeta });
  ok(calls.length === nCalls + 2 && !/respond_async_required/.test(JSON.stringify(quick)), "a paid blocking call to a route without a long run budget is served through the loopback as before");

  // The "no payment was taken" line names the Tempo push exception only
  // where the route's 402 offers Tempo at all (src/mpp-tempo.js
  // tempoOfferedFor): a long-running slug never does, so its refusal
  // mentions no Tempo transfer.
  const { PUSH_EXCEPTION } = await import("../src/mcp-http.js");
  const { isLongRunningSlug } = await import("../src/composite-spend-guard.js");
  ok(isLongRunningSlug("image-gen-premium") && isLongRunningSlug("decide-execute") && !isLongRunningSlug("slow-paid"), "image-gen-premium and decide-execute are long-running (no Tempo offer); slow-paid is not");
  ok(/refused before any payment was taken\.$/.test(text) && !/Tempo/.test(text), `the refusal for a long-running slug names no Tempo transfer (${text.slice(-80)})`);
  const lr = await rpc("tools/call", { name: "catalog.call", arguments: { slug: "decide-execute", params: { q: "x" } }, _meta: paidMeta });
  const lrText = String(lr.result?.content?.[0]?.text || "");
  ok(/^respond_async_required:/.test(lrText) && /refused before any payment was taken\.$/.test(lrText) && !/Tempo/.test(lrText), `decide-execute's refusal names no Tempo transfer either (${lrText.slice(-80)})`);
  const offered = await rpc("tools/call", { name: "catalog.call", arguments: { slug: "slow-paid", params: { q: "x" } }, _meta: paidMeta });
  const offeredText = String(offered.result?.content?.[0]?.text || "");
  ok(/^respond_async_required:/.test(offeredText) && offeredText.endsWith(`refused before any payment was taken${PUSH_EXCEPTION}.`), `the refusal for a slow route whose 402 offers Tempo carries the push exception (${offeredText.slice(-120)})`);
  ok(calls.length === nCalls + 2, "...and both were refused before any loopback ran");

  // A Tempo PUSH credential names a transfer that is already final on chain.
  // Refused here it would stay unclaimed and unbooked, so it is let through
  // to the loopback, where the gate claims it (and an answer the connector
  // stops waiting for is booked as owed by the route).
  plan = { "slow-paid": { delayMs: 0, res: jsonRes(200, { data: [{ b64_json: "AA" }] }) } };
  const pushChallenge = JSON.parse(JSON.stringify(Challenge.from({
    realm: "agent402.tools", method: "tempo", intent: "charge", expires: new Date(Date.now() + 300_000),
    request: { amount: "120000", currency: "0x20C000000000000000000000b9537d11c60E8b50", decimals: 6, recipient: "0x0000000000000000000000000000000000000001", methodDetails: { chainId: 4217, credentialTypes: ["hash"] } },
    secretKey: "test-secret-key-for-offline-tasks",
  })));
  const pushMeta = { "org.paymentauth/credential": { challenge: pushChallenge, payload: { type: "hash", hash: `0x${"ab".repeat(32)}` } } };
  const pushed = await rpc("tools/call", { name: "catalog.call", arguments: { slug: "slow-paid", params: { prompt: "x" } }, _meta: pushMeta });
  ok(calls.length === nCalls + 3 && calls[calls.length - 1].slug === "slow-paid" && !/respond_async_required/.test(JSON.stringify(pushed)), "a blocking call carrying a Tempo push credential to a slow route is NOT refused: the loopback runs so the gate claims the transfer");
  ok(pushed.result?.isError !== true && pushed.result?.structuredContent?.result?.data?.[0]?.b64_json === "AA", "...and its answer comes back as the ordinary tool result");
  const { pushHashOf } = await import("../src/mpp-tempo.js");
  ok(pushHashOf(calls[calls.length - 1].credentialHeader) === `0x${"ab".repeat(32)}`, "the loopback received the push credential itself: a paid call let through, not an unpaid one reaching its 402");

  // The "not charged" line of an HTTP >= 400 answer names the Tempo push
  // exception only where the route's 402 offers Tempo: a slow route that does
  // carries it (a push transfer can reach it), as does any Tempo-offered
  // route's 5xx; an identity-bound route never does.
  plan = { "slow-paid": { delayMs: 0, res: jsonRes(400, { error: "bad input" }) }, "my-usage": { delayMs: 0, res: jsonRes(400, { error: "bad input" }) }, whois: { delayMs: 0, res: jsonRes(503, { error: "upstream" }) } };
  const pushedBad = await rpc("tools/call", { name: "catalog.call", arguments: { slug: "slow-paid", params: { prompt: "x" } }, _meta: pushMeta });
  const pushedBadText = String(pushedBad.result?.content?.[0]?.text || "");
  ok(pushedBad.result?.isError === true && /HTTP 400 - not charged/.test(pushedBadText) && pushedBadText.includes(PUSH_EXCEPTION), `a 4xx from a slow route whose 402 offers Tempo carries the push exception (${pushedBadText.slice(0, 160)})`);
  const whoisBad = await rpc("tools/call", { name: "catalog.call", arguments: { slug: "whois", params: { domain: "example.com" } }, _meta: paidMeta });
  const whoisBadText = String(whoisBad.result?.content?.[0]?.text || "");
  ok(whoisBad.result?.isError === true && /HTTP 503 - not charged \(settlement runs only after a successful handler\)/.test(whoisBadText) && whoisBadText.includes(PUSH_EXCEPTION), `a 5xx from a route whose 402 offers Tempo carries it too (${whoisBadText.slice(0, 160)})`);
  const usageBad = await rpc("tools/call", { name: "catalog.call", arguments: { slug: "my-usage", params: {} }, _meta: paidMeta });
  const usageBadText = String(usageBad.result?.content?.[0]?.text || "");
  ok(usageBad.result?.isError === true && /HTTP 400 - not charged: /.test(usageBadText) && !usageBadText.includes(PUSH_EXCEPTION) && !/Tempo/.test(usageBadText), `a 4xx from an identity-bound route names no Tempo transfer (${usageBadText.slice(0, 160)})`);
}

// The outcomes no route books, because the loopback returned no answer, are
// booked by the connector once each: a blocking loopback that timed out, and
// a task run the connector stopped waiting on. Every answered call, and a
// cancel the buyer asked for, books nothing here.
{
  const paidMeta = { "org.paymentauth/credential": "Payment not-a-real-credential" };
  cutoffs.length = 0;
  plan = { whois: { delayMs: 0, throw: Object.assign(new Error("the loopback timed out"), { name: "TimeoutError" }) } };
  const timedOut = await rpc("tools/call", { name: "catalog.call", arguments: { slug: "whois", params: { domain: "example.com" } }, _meta: paidMeta });
  ok(timedOut.result?.isError === true && /did not finish within \d+s/.test(String(timedOut.result?.content?.[0]?.text || "")), "a blocking paid loopback that timed out is told so");
  ok(cutoffs.length === 1 && cutoffs[0].slug === "whois" && cutoffs[0].statusCode === 504 && cutoffs[0].errorMessage === "paid loopback timed out", `...and is booked once as a connector timeout (${JSON.stringify(cutoffs)})`);
  cutoffs.length = 0;
  plan = { whois: { delayMs: 0, res: jsonRes(200, { who: true }) } };
  await rpc("tools/call", { name: "catalog.call", arguments: { slug: "whois", params: { domain: "example.com" } }, _meta: paidMeta });
  plan = { whois: { delayMs: 0, res: jsonRes(400, { error: "bad input" }) } };
  await rpc("tools/call", { name: "catalog.call", arguments: { slug: "whois", params: { domain: "example.com" } }, _meta: paidMeta });
  ok(cutoffs.length === 0, "an answered paid call (200 or 4xx) is booked by the route it reached, never here");
  // A task run the connector stopped waiting on (not a cancel): aborted
  // after the gate window, with no answer.
  plan = { research: { delayMs: TASK_GATE_MS_TEST * 2, throw: Object.assign(new Error("run cut"), { name: "AbortError" }) } };
  const cut = await callComposite("research");
  ok(cut.result?.resultType === "task", "a run that the connector will stop waiting on is handed back as a task first");
  await sleep(TASK_GATE_MS_TEST * 2 + 200);
  const cutRec = await rpc("tasks/get", { taskId: cut.result.taskId, _meta: CLIENT_CAPS });
  ok(cutRec.result?.status === "failed", "the aborted run ends the task failed");
  ok(cutoffs.length === 1 && cutoffs[0].slug === "research" && cutoffs[0].statusCode === 504 && cutoffs[0].errorMessage === "task run aborted", `...and is booked once as an aborted task run (${JSON.stringify(cutoffs)})`);
  cutoffs.length = 0;
}

// A throw inside the completion path itself (after the run answered: reading
// its headers, booking it, writing the record) ends the task FAILED with a
// short reason, never a handle that polls "working" until its TTL, and the
// fault stays out of the buyer-visible text.
{
  let reads = 0;
  const brokenHeaders = { get: () => { if (++reads > 1) throw new Error("header store broke: internal detail"); return null; } };
  plan = { research: { delayMs: TASK_GATE_MS_TEST * 2, res: { status: 200, headers: brokenHeaders, contentType: "application/json", json: { report: "fine" } } } };
  cutoffs.length = 0;
  const broke = await callComposite("research");
  ok(broke.result?.resultType === "task", "the run that will break the completion path is handed back as a task first");
  await sleep(TASK_GATE_MS_TEST * 2 + 300);
  const brokeRec = await rpc("tasks/get", { taskId: broke.result.taskId, _meta: CLIENT_CAPS });
  ok(reads > 1, "the completion path threw after the answer was translated (test harness sanity)");
  ok(brokeRec.result?.status === "failed", `a throw inside the completion path ends the task failed, not working (${brokeRec.result?.status})`);
  const brokeMsg = String(brokeRec.result?.statusMessage || "");
  ok(/could not be recorded/.test(brokeMsg) && /may still have completed and been charged/.test(brokeMsg) && !/header store broke|internal detail/.test(brokeMsg), `the reason is short and carries the money story, never the fault's own text (${brokeMsg.slice(0, 100)})`);
  ok(cutoffs.length === 0, "the run answered, so it is not booked as a connector cut-off");
  await sleep(200);
  ok((await rpc("tasks/get", { taskId: broke.result.taskId, _meta: CLIENT_CAPS })).result?.status === "failed", "...and the record stays failed");
}

// A fast success inside the gate window is answered synchronously, unchanged.
plan = { research: { delayMs: 0, res: jsonRes(200, { quick: true }) } };
const beforeFast = readdirSync(STORE_DIR).length;
const fast = await callComposite("research");
ok(fast.result?.resultType === undefined, "a composite that finishes inside the gate window answers synchronously (no handle to poll)");
ok(fast.result?.structuredContent?.result?.quick === true, "that synchronous answer is the ordinary tool result");
ok(readdirSync(STORE_DIR).length === beforeFast, "no task record is created for a call that already finished");

// ---------------------------------------------------------- 5. cancellation

plan = { research: { delayMs: 5_000, res: jsonRes(200, { never: true }) } };
const toCancel = await callComposite("research");
const cancelCall = calls[calls.length - 1];
const cancelAck = await rpc("tasks/cancel", { taskId: toCancel.result.taskId, _meta: CLIENT_CAPS });
ok(cancelAck.result?.resultType === "complete", "tasks/cancel acknowledges with resultType:\"complete\"");
ok(Object.keys(cancelAck.result).length === 1, "the cancel ack is empty apart from the discriminator");
await sleep(120);
ok(cancelCall.aborted === true, "cancelling stops the connector waiting on the paid run");
const cancelled = await rpc("tasks/get", { taskId: toCancel.result.taskId, _meta: CLIENT_CAPS });
ok(cancelled.result?.status === "cancelled", "the cancelled task reports the cancelled status");
ok(/may still have completed and been charged/.test(String(cancelled.result?.statusMessage || "")) && !/not charged/i.test(String(cancelled.result?.statusMessage || "")), "the cancelled task says the run may still have been charged (the paid request settles server-side), never \"not charged\"");
ok(/recorded as owed in our refund ledger and repaid after review/.test(String(cancelled.result?.statusMessage || "")) && !/automatic/i.test(String(cancelled.result?.statusMessage || "")), "...and that such a charge is repaid after review, never promised as automatic");
await sleep(300);
const stillCancelled = await rpc("tasks/get", { taskId: toCancel.result.taskId, _meta: CLIENT_CAPS });
ok(stillCancelled.result?.status === "cancelled", "a terminal task never transitions again, even if the run reports back late");
ok(cutoffs.length === 0, "a cancel the buyer asked for is not a connector cut-off: nothing is booked for it");

// ------------------------------------------- 5b. a lost result's debt
// A task whose settled 200 cannot be retained books the debt with the x402
// settle receipt the loopback's 200 carries (proof of charge, chain, payer),
// at what the credential signed on that chain (the quote its 402 minted,
// premium and floor included), never the list price.
{
  const { listRefunds, refundLedgerFlush } = await import("../src/refund-ledger.js");
  const payer = `0x${"ab".repeat(20)}`;
  const tx = `0x${"cd".repeat(32)}`;
  const challenge = JSON.parse(JSON.stringify(Challenge.from({
    realm: "agent402.tools", method: "evm", intent: "charge", expires: new Date(Date.now() + 300_000),
    request: { amount: "1001000", currency: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", recipient: "0x0000000000000000000000000000000000000001", methodDetails: { chainId: 10, credentialTypes: ["authorization"], decimals: 6 } },
    secretKey: "test-secret-key-for-offline-tasks",
  })));
  const credential = { challenge, payload: { from: payer, to: "0x0000000000000000000000000000000000000001", value: "1001000", validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: `0x${"77".repeat(32)}`, signature: `0x${"11".repeat(65)}`, type: "authorization" } };
  const settle = Buffer.from(JSON.stringify({ success: true, transaction: tx, network: "eip155:10", payer })).toString("base64");
  const mppReceipt = Receipt.serialize({ method: "evm", status: "success", reference: tx, timestamp: new Date().toISOString() });
  plan = { research: { delayMs: 700, res: jsonRes(200, { report: "x".repeat(5_000) }, { "payment-response": settle, "payment-receipt": mppReceipt }) } };
  const lost = await rpc("tools/call", { name: "catalog.call", arguments: { slug: "research", params: { q: "hello" } }, _meta: { ...CLIENT_CAPS, "org.paymentauth/credential": credential } });
  ok(lost.result?.resultType === "task", "the paid run is handed back as a task");
  await sleep(900);
  const got = await rpc("tasks/get", { taskId: lost.result.taskId, _meta: CLIENT_CAPS });
  ok(got.result?.status === "failed", "its result could not be retained, so the task is failed");
  await refundLedgerFlush();
  const row = listRefunds({ status: "owed", limit: 50 }).find((r) => r.slug === "research");
  ok(row && row.priceUsd === 1.001 && row.network === "eip155:10" && row.payer === payer,
    `the debt is booked at the chain-priced amount the credential signed, on its chain and to its payer (${JSON.stringify(row && { priceUsd: row.priceUsd, network: row.network, payer: row.payer })})`);

  // A Tempo-paid run carries no x402 settle receipt: the proof is built from
  // the Tempo receipt (src/mcp-mpp.js tempoSettleProof), at the challenge
  // amount the credential paid. A push credential proves no sender, so the
  // row names the transfer and nobody (a refund reads the payer off it).
  const tempoTx = `0x${"ef".repeat(32)}`;
  const tempoChallenge = JSON.parse(JSON.stringify(Challenge.from({
    realm: "agent402.tools", method: "tempo", intent: "charge", expires: new Date(Date.now() + 300_000),
    request: { amount: "15000000", currency: "0x20C000000000000000000000b9537d11c60E8b50", decimals: 6, recipient: "0x0000000000000000000000000000000000000001", methodDetails: { chainId: 4217, credentialTypes: ["hash"] } },
    secretKey: "test-secret-key-for-offline-tasks",
  })));
  const tempoCredential = { challenge: tempoChallenge, payload: { type: "hash", hash: tempoTx } };
  const tempoReceipt = Receipt.serialize({ method: "tempo", status: "success", reference: tempoTx, timestamp: new Date().toISOString() });
  plan = { "market-brief": { delayMs: 700, res: jsonRes(200, { report: "x".repeat(5_000) }, { "payment-receipt": tempoReceipt }) } };
  const lostTempo = await rpc("tools/call", { name: "catalog.call", arguments: { slug: "market-brief", params: { q: "hello" } }, _meta: { ...CLIENT_CAPS, "org.paymentauth/credential": tempoCredential } });
  ok(lostTempo.result?.resultType === "task", "the Tempo-paid run is handed back as a task");
  await sleep(900);
  const gotTempo = await rpc("tasks/get", { taskId: lostTempo.result.taskId, _meta: CLIENT_CAPS });
  ok(gotTempo.result?.status === "failed", "its result could not be retained, so the task is failed");
  await refundLedgerFlush();
  const tempoRow = listRefunds({ status: "owed", limit: 50 }).find((r) => r.slug === "market-brief");
  ok(tempoRow && tempoRow.priceUsd === 15 && tempoRow.network === "tempo" && tempoRow.evidence === tempoTx && tempoRow.payer === null,
    `a Tempo-paid lost result books its debt on tempo, keyed on the transfer, at the challenge amount (${JSON.stringify(tempoRow && { priceUsd: tempoRow.priceUsd, network: tempoRow.network, evidence: tempoRow.evidence, payer: tempoRow.payer })})`);
  const { tempoSettleProof } = await import("../src/mcp-mpp.js");
  ok(tempoSettleProof({ method: "evm", status: "success", reference: tempoTx }) === null && tempoSettleProof({ method: "tempo", status: "failed", reference: tempoTx }) === null && tempoSettleProof({ method: "tempo", status: "success", reference: "abc" }) === null && tempoSettleProof(null) === null,
    "an evm receipt, a failed Tempo receipt or one without a transfer hash proves nothing");
}

// ------------------------------------------------------- 6. protocol errors

const noCaps = await rpc("tasks/get", { taskId: handle.taskId });
ok(noCaps.error?.code === TASK_MISSING_CAPABILITY, "tasks/get from a client that did not declare the extension is -32021");
ok(noCaps.error?.data?.requiredCapabilities?.extensions?.[TASKS_EXTENSION] !== undefined, "that error names the required extension");
const unknown = await rpc("tasks/get", { taskId: newTaskId(), _meta: CLIENT_CAPS });
ok(unknown.error?.code === TASK_INVALID_PARAMS, "an unknown taskId is -32602 (Invalid params)");
ok(/not found/i.test(unknown.error?.message || ""), "the unknown-task error says so informatively");
const badId = await rpc("tasks/get", { taskId: "../../etc/passwd", _meta: CLIENT_CAPS });
ok(badId.error?.code === TASK_INVALID_PARAMS, "a traversal-shaped taskId is refused, never resolved to a path");
const upd = await rpc("tasks/update", { taskId: handle.taskId, inputResponses: {}, _meta: CLIENT_CAPS });
ok(upd.result?.resultType === "complete", "tasks/update acknowledges (this connector never elicits, so responses are for unknown keys and are ignored)");

// ------------------------------------------- 7. the fast tools are untouched

// These MUST outrun the gate window, or the assertion proves only that the call
// was fast - not that the eligibility gate held. (A first draft used delayMs:0
// here and two deliberate mutations - dropping the capability check, and
// dropping the composite check - both passed a green run.)
const SLOW = TASK_GATE_MS_TEST * 4;

plan = {};
const free = await rpc("tools/call", { name: "catalog.call", arguments: { slug: "uuid", params: {} }, _meta: CLIENT_CAPS });
ok(free.result?.resultType === undefined, "a FREE tool never becomes a task, even when the client declares the extension");
ok(free.result?.structuredContent?.result?.slow === true, "the free tool executed normally - and it ran LONGER than the gate window, so this is the gate holding, not a fast call");

plan = { whois: { delayMs: SLOW, res: jsonRes(200, { who: true }) } };
const paidCheap = await rpc("tools/call", { name: "catalog.call", arguments: { slug: "whois", params: {} }, _meta: CLIENT_CAPS });
ok(paidCheap.result?.resultType === undefined, "a paid NON-composite never becomes a task even when it runs past the gate window (only EXPENSIVE_COMPOSITE_SLUGS do)");
ok(paidCheap.result?.structuredContent?.result?.who === true, "and it still returns its ordinary blocking result");
ok(!EXPENSIVE_COMPOSITE_SLUGS.has("whois") && !EXPENSIVE_COMPOSITE_SLUGS.has("uuid"), "the guard set really does exclude those two");
ok(EXPENSIVE_COMPOSITE_SLUGS.has("research") && EXPENSIVE_COMPOSITE_SLUGS.has("market-brief"), "the composites under test are in the guard set");

// A composite from a client that did NOT declare the extension must block, even
// when it runs long enough that we would otherwise hand back a handle.
plan = { "market-brief": { delayMs: SLOW, res: jsonRes(200, { brief: true }) } };
const noExt = await callComposite("market-brief", { withCaps: false });
ok(noExt.result?.resultType === undefined, "a composite running past the gate window is STILL never returned as a task to a client that did not declare the extension (spec MUST)");
ok(noExt.result?.structuredContent?.result?.brief === true, "that client waits and gets the ordinary blocking result");

// -------------------------------------------------- 8. durability / restart

// A task whose run died with its process must resolve to a truthful terminal
// state on the next boot, not poll forever.
plan = { research: { delayMs: 30_000, res: jsonRes(200, {}) } };
const orphan = await callComposite("research");
const orphanId = orphan.result.taskId;
ok(JSON.parse(readFileSync(join(STORE_DIR, `${orphanId}.json`), "utf8")).status === "working", "the orphan-to-be is on disk as working");

// Simulated restart: a NEW store over the SAME directory is a new boot.
const rebooted = createTaskStore({ dir: STORE_DIR, bootId: "a-different-process", log: () => {} });
const swept = rebooted.get(orphanId);
ok(swept && swept.status === "failed", "after a restart, a run orphaned by the old process is resolved as FAILED (never a handle that polls forever)");
ok(/restart/i.test(swept.statusMessage || ""), "the record says plainly that a restart interrupted it");
ok(/not charged/i.test(swept.statusMessage || ""), "and that the buyer was not charged (the run never delivered a 200, so settlement was cancelled)");
const doneRec = rebooted.get(handle.taskId);
ok(doneRec && doneRec.status === "completed" && doneRec.result, "a COMPLETED task and its result survive the restart intact");

// The store fails closed when it cannot persist.
const unwritable = createTaskStore({ dir: join(TMP, "nope", "deeper"), log: () => {} });
unwritable.dir && rmSync(join(TMP, "nope"), { recursive: true, force: true });
ok(unwritable.create({ slug: "research" }) === null, "create() returns null rather than handing out a handle it cannot durably record");

// ------------------------------------------------ 9. payment / refund wiring

// The ONLY charged-but-undelivered case this path can produce: a settled 200
// whose result we cannot retain. It must record a debt, and only on proof.
const charged = [];
const capped = createTaskStore({ dir: join(TMP, "capped"), log: () => {}, onChargedFailure: (i) => charged.push(i) });
process.env.AGENT402_MCP_TASK_MAX_RESULT_BYTES = "200";
const tiny = createTaskStore({ dir: join(TMP, "tiny"), log: () => {}, onChargedFailure: (i) => charged.push(i) });
delete process.env.AGENT402_MCP_TASK_MAX_RESULT_BYTES;
const big = tiny.create({ slug: "research" });
tiny.complete(big.taskId, { content: [{ type: "text", text: "x".repeat(5_000) }] }, { receipt: { success: true }, priceUsd: 1 });
ok(tiny.get(big.taskId).status === "failed", "a result too large to retain fails the task rather than pretending to have delivered it");
ok(charged.length === 1 && charged[0].slug === "research", "that case reports a charged failure for refund review");
ok(charged[0].receipt?.success === true, "the settle receipt is handed to the refund wiring as the proof of charge");

const okRec = capped.create({ slug: "research" });
capped.complete(okRec.taskId, { content: [{ type: "text", text: "small" }] }, { receipt: { success: true } });
ok(charged.length === 1, "an ordinary delivered result records NO debt");

const { receiptProvesCharge } = await import("../src/refund-ledger.js");
ok(receiptProvesCharge({ success: true }) === true, "the ledger's proof bar accepts an explicit success:true");
ok(receiptProvesCharge({}) === false && receiptProvesCharge(null) === false && receiptProvesCharge({ success: "true" }) === false,
  "and refuses an absent/ambiguous receipt - a debt is money, so ambiguity must never mint one");

// A cancelled or failed task must never be reported as a charge.
const c2 = capped.create({ slug: "research" });
capped.cancel(c2.taskId);
capped.complete(c2.taskId, { content: [] }, { receipt: { success: true } });
ok(capped.get(c2.taskId).status === "cancelled", "a late result cannot resurrect a cancelled task");
ok(charged.length === 1, "and cannot record a charge against it");

// --------------------------------------------------------- 10. shape helpers

const rec = { taskId: "a".repeat(48), status: "completed", createdAt: "t", lastUpdatedAt: "t", ttlMs: 1, result: { a: 1 }, slug: "s", owner: "o" };
const dt = detailedTask(rec);
ok(dt.resultType === "complete" && dt.result?.a === 1, "detailedTask inlines the result on a completed task, flat");
ok(dt.slug === undefined && dt.owner === undefined, "internal bookkeeping (slug, owner) never crosses the wire");
const ct = createTaskResult(rec);
ok(ct.resultType === "task" && ct.result === undefined, "CreateTaskResult carries the handle only, never the result");

// ---------------------------------------------------------------- teardown

server.close();
rmSync(TMP, { recursive: true, force: true });
// --- a task path is only ever built from a real task id ----------------------
//
// CodeQL flagged the record path as built from a user-provided value. Every
// caller did validate first, so it was not exploitable - but the guard lived at
// the callers, which is an invariant kept by hand, and the next caller is the
// one that forgets. It now lives at path construction.
//
// THIS PLANTS A REAL, READABLE RECORD OUTSIDE THE STORE and asks for it by a
// traversing id. A test that only asserts `null` proves nothing here, because
// readJson swallows a failed read and returns null anyway - so an unguarded
// version passes it while genuinely walking out of the directory. The first
// version of this test did exactly that and survived the mutation.
{
  const outer = mkdtempSync(join(tmpdir(), "a402-taskpath-"));
  const dir = join(outer, "store");
  mkdirSync(dir, { recursive: true });
  const planted = { taskId: "f".repeat(48), status: "completed", result: { secret: "should never be readable" }, createdAtMs: Date.now() };
  writeFileSync(join(outer, "planted.json"), JSON.stringify(planted));
  const store = createTaskStore({ dir, log: () => {} });

  // Sanity: the file really is there and really is readable, so a null below
  // means the guard worked and not that the fixture was wrong.
  ok(JSON.parse(readFileSync(join(outer, "planted.json"), "utf8")).taskId === planted.taskId,
    "the planted record outside the store is readable, so the traversal case is real");

  let threw = null, got;
  try { got = store.get("../planted"); } catch (e) { threw = e; }
  ok(threw === null && got === null,
    "a traversing id reads NOTHING - not the planted record, and not an exception either");

  for (const bad of ["../../etc/passwd", "abc/../../../root", "", "/absolute/path", "not-hex-" + "0".repeat(40)]) {
    let t2 = null, g2;
    try { g2 = store.get(bad); } catch (e) { t2 = e; }
    ok(t2 === null && g2 === null, `get(${JSON.stringify(bad.slice(0, 22))}) is a clean null`);
  }
  rmSync(outer, { recursive: true, force: true });
}

console.log(`\ntest-mcp-tasks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
