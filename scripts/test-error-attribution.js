// Whose failure an error names (src/upstream-deadline.js ATTRIBUTION / KIND):
// a third party is named as failing only on a definite answer from it, and
// the advice can work. Offline: stub catalogs, stubbed fetch, injected probes.
//   1. The free MCP path: our own 500 says it is ours, never a third party;
//      a URL the caller supplied that did not answer is told to check the URL
//      or retry; our own limit names the limit; an upstream status keeps the
//      third-party words; the caller's own 4xx keeps the schema echo.
//   2. The kits: the token-risk report (our throw, our limit), the contract
//      source fallback (our limit on the Sourcify read), judgment (our own
//      balance and key), transcription (our own key).
//   3. The router: a price leg our clamp cut is never "Seller unreachable",
//      and route-execute names a seller as failing only on its own answer.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
process.env.AGENT402_MCP_MAX_PER_MIN = "1000000";
process.env.AGENT402_MCP_MAX_PER_HOUR = "1000000";
process.env.AGENT402_MCP_REQ_PER_MIN = "1000000";
process.env.AGENT402_MCP_REQ_PER_HOUR = "1000000";
process.env.X402_INDEX_CRAWL = "off";
process.env.X402_SYNC_ON_START = "false";
process.env.TYPESAFE_API_KEY = "test-typesafe";
process.env.OPENAI_API_KEY = "sk-test-not-real";
process.env.OPENROUTER_API_KEY = "or-test-not-real";

import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "a402-attrib-"));
process.env.REFUND_DB_DIR = TMP;

const { mountMcp } = await import("../src/mcp-http.js");
const { upstreamDeadline, upstreamFetch } = await import("../src/upstream-deadline.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const THIRD_PARTY = /third party/i;
const realFetch = globalThis.fetch;

// ------------------------------------------------------------ 1. MCP free path
{
  const def = (slug, handler) => ({
    route: `GET /api/${slug}`, slug, name: slug, category: "test", price: "$0.001", description: `${slug} test tool`,
    tags: ["attrib"], discovery: { inputSchema: { properties: { q: { type: "string" } }, required: ["q"] }, input: { q: "x" } }, handler,
  });
  const CATALOG = {
    // Our own defect: a bare TypeError, which the binder answers as a 500.
    "GET /api/internal": def("internal", async () => { const o = null; return o.field; }),
    // The shape safeFetch throws for a caller URL that did not answer.
    "GET /api/caller-url": def("caller-url", async () => { throw Object.assign(new Error("Source URL did not respond within our 15 s limit; check that the URL is correct and publicly reachable, or retry"), { statusCode: 504, attribution: "unknown", hint: "source-timeout" }); }),
    // Our own read limit passing.
    "GET /api/our-limit": def("our-limit", async () => { throw upstreamDeadline("Price feed", "simple price", 8000); }),
    // A definite upstream answer.
    "GET /api/upstream": def("upstream", async () => { throw Object.assign(new Error("Price feed upstream error (HTTP 503)"), { statusCode: 502, upstreamStatus: 503 }); }),
    // The caller's own input.
    "GET /api/bad-input": def("bad-input", async () => { throw Object.assign(new Error("q is required"), { statusCode: 400 }); }),
  };
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  mountMcp(app, CATALOG, { baseUrl: "http://localhost", isComputePayable: () => true, taskStoreDir: join(TMP, "store") });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  let rpcId = 0;
  const call = async (slug) => {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: "catalog.call", arguments: { slug, params: { q: "x" } } } }),
    });
    const text = await res.text();
    const j = (res.headers.get("content-type") || "").includes("event-stream") ? JSON.parse(text.split("\n").find((l) => l.startsWith("data:")).slice(5).trim()) : JSON.parse(text);
    return { isError: j.result?.isError === true, body: JSON.parse(j.result?.content?.[0]?.text || "{}") };
  };
  try {
    const internal = await call("internal");
    ok(internal.isError && !THIRD_PARTY.test(internal.body.whoseFault || "") && /internal error on our side/.test(internal.body.whoseFault || "") && /nothing to charge/.test(internal.body.whoseFault || ""),
      `our own 500 on the free path says it is ours, never that a third party failed (${internal.body.whoseFault})`);
    ok(!/changing the input will not help/.test(internal.body.nextStep || "") && internal.body.expected === undefined, `...and its next step does not claim the input is beside the point (${internal.body.nextStep})`);

    const url = await call("caller-url");
    ok(url.isError && /check that the URL is correct and publicly reachable, or retry/.test(url.body.nextStep || "") && !THIRD_PARTY.test(url.body.whoseFault || "") && url.body.attribution === "unknown" && url.body.hint === "source-timeout",
      `a caller URL that timed out advises checking the URL or retrying (${url.body.nextStep})`);

    const lim = await call("our-limit");
    ok(lim.isError && /our own time limit/.test(lim.body.whoseFault || "") && !THIRD_PARTY.test(lim.body.whoseFault || "") && lim.body.attribution === "ours" && lim.body.hint === "our-deadline",
      `our own read limit passing names our limit, not a third party (${lim.body.whoseFault})`);

    const up = await call("upstream");
    ok(up.isError && THIRD_PARTY.test(up.body.whoseFault || "") && up.body.nextStep === "retry the SAME call later; changing the input will not help" && up.body.upstreamStatus === 503,
      "control: a definite upstream status keeps the third-party words and its next step");

    const bad = await call("bad-input");
    ok(bad.isError && bad.body.whoseFault === undefined && Array.isArray(bad.body.required) && bad.body.callWith,
      "control: the caller's own 4xx keeps the schema echo");
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

// A budget spent before any request left names no upstream as unresponsive.
{
  let sent = 0;
  const e = await upstreamFetch("https://x.test/", {}, { label: "Chain RPC", step: "eth_call", timeoutMs: 8000, budget: { remaining: () => 0, totalMs: 20_000 }, tag: null, fetchImpl: async () => { sent++; } }).catch((x) => x);
  ok(e?.statusCode === 503 && sent === 0 && e.hint === "budget-spent" && !/did not answer|unreachable/.test(e.message) && /^No Chain RPC eth_call read was sent: our 20 s limit/.test(e.message),
    `a budget spent before any request left names no upstream as unresponsive (${e?.message})`);
}

// ------------------------------------------------------------------ 2. kits
// token-risk: a throw of our own is an internal error; our limit names itself.
{
  const { makeTokenRiskHandler } = await import("../src/tools/token-risk-kit.js");
  const tool = () => async () => { throw Object.assign(new Error("not needed"), { statusCode: 404 }); };
  const chat = async () => { throw new Error("synthesis must not run"); };
  const input = { address: "0x4200000000000000000000000000000000000006", chain: "base" };
  const run = (probeGoPlus) => makeTokenRiskHandler("token-risk-pro", { tool, chat, probeGoPlus, probeDexPairs: async () => ({ totalPairs: 0, pairs: [] }) })(input).then(() => null, (e) => e);
  const ours = await run(async () => { const o = undefined; return o.result; });
  ok(ours && !/source is unavailable/i.test(ours.message) && /internal error on our side/.test(ours.message) && ours.attribution === "ours" && ours.hint === "internal",
    `token-risk: a throw of our own reads as our internal error, never "the token-security source is unavailable" (${ours?.message})`);
  const lim = await run(async () => { throw upstreamDeadline("Token-security source", "token security", 12_000); });
  ok(lim && /our 12 s limit/.test(lim.message) && !/source is unavailable/i.test(lim.message) && lim.attribution === "ours",
    `token-risk: our read limit passing names our limit (${lim?.message})`);
  const up = await run(async () => { throw Object.assign(new Error("upstream HTTP 500"), { statusCode: 502, upstreamStatus: 500, attribution: "upstream" }); });
  ok(up && /source answered with a failure \(upstream HTTP 500\)/.test(up.message) && up.statusCode === 502 && up.attribution === "upstream",
    `control: the source's own 5xx is named as the source's (${up?.message})`);
}

// contract-source: our limit on the Sourcify read is not "Sourcify is unreachable".
{
  const { CONTRACT_TOOLS } = await import("../src/tools/contract-kit.js");
  const src = CONTRACT_TOOLS.find((t) => t.slug === "contract-source");
  globalThis.fetch = async (url) => {
    const host = new URL(String(url)).host;
    if (host === "sourcify.dev") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    if (host === "base.blockscout.com") return new Response(JSON.stringify({ is_verified: false }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected fetch ${url}`);
  };
  let e = null;
  try { await src.handler({ address: "0x4200000000000000000000000000000000000006", network: "base" }); } catch (x) { e = x; } finally { globalThis.fetch = realFetch; }
  ok(e && !/Sourcify is unreachable/.test(e.message) && /within our \d+ s limit/.test(e.message) && e.attribution === "ours" && e.statusCode === 502,
    `contract-source: our Sourcify read limit passing names our limit, not "Sourcify is unreachable" (${e?.message})`);
}

// judgment: our own balance and our own key are ours.
{
  const { judge } = await import("../src/tools/judge-kit.js");
  const base = { state: "x", questions: { a: { type: "noul", instructions: "Is this a test?" } } };
  const answer = (status) => async () => new Response(JSON.stringify({ error: "x" }), { status, headers: { "content-type": "application/json" } });
  const bal = await judge(base, { fetchImpl: answer(402) }).then(() => null, (x) => x);
  ok(bal && bal.statusCode === 503 && !/upstream is unavailable/i.test(bal.message) && /this server's balance/.test(bal.message) && bal.attribution === "ours",
    `judgment: our own spent balance (402) names our side, not "Judgment upstream is unavailable" (${bal?.message})`);
  const key = await judge(base, { fetchImpl: answer(401) }).then(() => null, (x) => x);
  ok(key && key.statusCode === 503 && /refused this server's key/.test(key.message) && key.attribution === "ours" && key.hint === "our-key",
    `judgment: our own key refused names our key (${key?.message})`);
}

// transcription: our own key refused is ours.
{
  const { makeMultipartHandler } = await import("../src/tools/stt-kit.js");
  const wav = (() => {
    const sr = 8000, n = sr * 3, b = Buffer.alloc(44 + n);
    b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
    return b;
  })();
  const fd = new FormData();
  fd.append("file", new Blob([wav]), "clip.wav");
  const req = new Request("http://x/", { method: "POST", body: fd });
  const body = { headers: { "content-type": req.headers.get("content-type") }, body: Buffer.from(await req.arrayBuffer()) };
  globalThis.fetch = async (url, init) => (init?.body instanceof FormData
    ? new Response(JSON.stringify({ error: { message: "Incorrect API key provided", code: "invalid_api_key" } }), { status: 401, headers: { "content-type": "application/json" } })
    : realFetch(url, init));
  let e = null;
  try { await makeMultipartHandler("transcribe")({}, body); } catch (x) { e = x; } finally { globalThis.fetch = realFetch; }
  ok(e && !/OpenAI upstream auth failed/.test(e.message) && /refused this server's key/.test(e.message) && /on our side, not your input/.test(e.message) && (e.message.match(/charged/gi) || []).length <= 1 && e.attribution === "ours" && e.hint === "our-key",
    `transcription: our own key refused (401) names our key, not an upstream auth failure (${e?.statusCode} ${e?.message})`);
}

// ---------------------------------------------------------------- 3. router
{
  // The payer itself: a price leg whose cap the call's deadline shortened,
  // against a seller that never answers (the stubbed fetch ends at the
  // signal the payer passed, as undici does).
  process.env.OUTBOUND_LEDGER_FILE = join(TMP, "outbound-spend.ndjson");
  process.env.X402_UPSTREAM_BUYER_KEY = "0x" + "11".repeat(32);
  const buyer = await import("../src/x402-buyer.js");
  buyer.__setBuyerAddressGuardForTest(false);
  globalThis.fetch = (_u, init) => new Promise((_, reject) => {
    const sig = init?.signal;
    sig?.addEventListener("abort", () => reject(sig.reason ?? Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })), { once: true });
  });
  let leg = null;
  // The call's clock is held still, so the 300 ms deadline is what clamps the
  // price leg however long this process takes to reach it (a loaded machine
  // otherwise spends the budget first and answers "Too little ... budget").
  const heldAt = Date.now();
  try { await buyer.payX402("https://seller.example/x", { maxAtomic: 500000n, method: "POST", body: {}, deadlineMs: 300, minLegMs: 0, now: () => heldAt }); } catch (e) { leg = e; } finally { globalThis.fetch = realFetch; }
  ok(leg && leg.statusCode === 502 && !/unreachable/i.test(leg.message) && /our limit/.test(leg.message) && leg.attribution === "ours",
    `payX402: a price leg our call deadline cut short is never "Seller unreachable" (${leg?.message})`);

  const { bareLegFailure } = buyer;
  if (typeof bareLegFailure === "function") {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const clamped = bareLegFailure(timeout, { capMs: 4000, clamped: true });
    ok(!/unreachable/i.test(clamped.message) && /within the 4 s left of our limit for this call/.test(clamped.message) && clamped.attribution === "ours" && clamped.statusCode === 502,
      `a price leg our clamp cut is never "Seller unreachable" (${clamped.message})`);
    const own = bareLegFailure(timeout, { capMs: 20_000 });
    ok(/within our 20 s limit/.test(own.message) && own.hint === "our-deadline", `a price leg that used its whole cap names our limit (${own.message})`);
    for (const code of ["EAI_AGAIN", "ESERVFAIL", "ETIMEOUT", "EREFUSED"]) {
      const dns = bareLegFailure(Object.assign(new TypeError("fetch failed"), { cause: { code } }), { capMs: 20_000 });
      ok(/DNS lookup/.test(dns.message) && dns.attribution === "ours" && dns.hint === "our-egress", `our resolver failing (${code}) is ours (${dns.message})`);
    }
    for (const code of ["ENOTFOUND", "EAI_NONAME", "EAI_NODATA"]) {
      const nx = bareLegFailure(Object.assign(new TypeError("fetch failed"), { cause: { code } }), { capMs: 20_000 });
      ok(!/DNS lookup/.test(nx.message) && /host name does not resolve/.test(nx.message) && nx.attribution === "unknown" && nx.hint === "connect-failed",
        `a seller host whose name does not resolve (${code}) is not our resolver (${nx.message}, ${nx.attribution})`);
    }
  } else ok(false, "bareLegFailure: the price leg's failure is classified by whose side it is");

  const { buildRouteExecuteTool } = await import("../src/tools/route-execute.js");
  const A = { seller: "https://a.example", slug: "svc-a", url: "https://a.example/x", method: "POST", price: "$0.01", networks: ["eip155:8453"] };
  const run = async (thrown) => {
    const t = buildRouteExecuteTool({
      getCatalog: () => ({}), tier: { slug: "route-execute-max", execPriceUsd: 0.55, underlyingMaxUsd: 0.5 },
      resolveExternal: async () => [A], payExternal: async () => { throw thrown; }, externalEnabled: () => true,
    });
    try { await t.handler({ task: "t", include: "external" }, {}); return null; } catch (e) { return e; }
  };
  // The payer's own error from the clamped leg above, through route-execute.
  const cut = await run(leg);
  ok(cut && !/failed:/.test(cut.message) && !/unreachable/i.test(cut.message) && /The purchase from external seller "https:\/\/a\.example" did not complete: Seller did not answer the price request within the \d+ s left/.test(cut.message),
    `route-execute: a leg cut by our clamp is a purchase that did not complete, not a seller that failed (${cut?.message})`);
  const budget = await run(Object.assign(new Error("Too little of this call's time budget is left to pay a seller. Nothing was signed."), { statusCode: 504 }));
  ok(budget && !/External seller "https:\/\/a\.example" failed/.test(budget.message) && /did not complete/.test(budget.message), `route-execute: our own spend or time budget is not the seller failing (${budget?.message})`);
  const theirs = await run(Object.assign(new Error("Seller upstream error (HTTP 500)"), { statusCode: 502, attribution: "upstream" }));
  ok(theirs && /^External seller "https:\/\/a\.example" failed: Seller upstream error \(HTTP 500\)/.test(theirs.message), `control: the seller's own status keeps "failed" (${theirs?.message})`);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\ntest-error-attribution: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
