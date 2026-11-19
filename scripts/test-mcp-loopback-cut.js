#!/usr/bin/env node
// A paid replay the hosted MCP connector stopped waiting for
// (src/mcp-loopback.js): the call id rides the marker, and the two ends meet.
//   - the call id is read only beside the genuine marker on a loopback
//     socket, and removed from the request either way;
//   - CHARGED, NOT RECEIVED: a route that wrote a settled 200 in full and a
//     connector that stopped waiting book the charge once, in either order;
//     an answer the connector received, a 200 that settled nothing, or a
//     response that closed before finishing books nothing;
//   - the event-loop stall: a real replay over the real loopback client
//     (createMcpMppLoopback) to a route that holds the loop past the
//     connector's deadline and then writes its settled 200 at once: the
//     connector's deadline fires after the answer was written, and the charge
//     is booked as owed (it was neither booked nor delivered before);
//   - ONE OUTCOME PER CALL: whichever end counts first, the other does not;
//   - cut off, then resent with the same Idempotency-Key: the stored answer
//     is restated as charged, so the replay voids the owed booking first;
//   - bounded: entries end when both ends spoke, the oldest go past the cap;
//   - the server and the connector are wired to it (source pins).
// Offline: two servers on 127.0.0.1, port 0.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import express from "express";
import { readFileSync } from "node:fs";
import {
  mcpLoopbackHeaders, stripMcpMarker, isMcpLoopback, openLoopbackCall, closeLoopbackCall, cutLoopbackCall,
  loopbackCallIdOf, loopbackCallCut, noteLoopbackCounted, watchLoopbackOutcome, _loopbackCallsForTest,
  LOOPBACK_CALLS_MAX, MCP_CALL_HEADER,
} from "../src/mcp-loopback.js";
import { createMcpMppLoopback } from "../src/mcp-mpp.js";
import { createIdempotency, noteChargedAfterServe } from "../src/idempotency.js";

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = _loopbackCallsForTest();

// ---- the call id rides only the genuine marker --------------------------------
{
  const id = openLoopbackCall();
  const h = mcpLoopbackHeaders({ callId: id });
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  const req = (headers, addr = "127.0.0.1") => ({ headers: { ...headers }, socket: { remoteAddress: addr } });
  const genuine = req(lower);
  ok(isMcpLoopback(genuine) && loopbackCallIdOf(genuine) === id && !(MCP_CALL_HEADER in genuine.headers), "a genuine replay carries its call id, and the header is removed");
  const remote = req(lower, "203.0.113.9");
  ok(!isMcpLoopback(remote) && loopbackCallIdOf(remote) === null && !(MCP_CALL_HEADER in remote.headers), "the same headers from another address carry no call id (and the header is removed)");
  const forged = req({ [MCP_CALL_HEADER]: id, "x-agent402-via": "mcp;k=" + "0".repeat(48) });
  ok(!isMcpLoopback(forged) && loopbackCallIdOf(forged) === null && !(MCP_CALL_HEADER in forged.headers), "a call id beside a wrong marker is not read");
  ok(!("X-Agent402-Via-Call" in mcpLoopbackHeaders()) && !("X-Agent402-Via-Call" in mcpLoopbackHeaders({ callId: "not-an-id" })), "no call id, or a malformed one, sends no call header");
  closeLoopbackCall(id);
}

// ---- the two ends, in every order (a stand-in request and response) ----------
function fakeEnds(id, { status = 200 } = {}) {
  const ls = { finish: [], close: [] };
  const res = { statusCode: status, once: (ev, fn) => ls[ev].push(fn) };
  const headers = { ...Object.fromEntries(Object.entries(mcpLoopbackHeaders({ callId: id })).map(([k, v]) => [k.toLowerCase(), v])) };
  const req = { headers, socket: { remoteAddress: "127.0.0.1" } };
  let booked = 0;
  watchLoopbackOutcome(req, res, { settled: (r) => r.statusCode === 200, onSettledCut: () => { booked++; } });
  return { req, finish: () => { for (const f of ls.finish) f(); for (const f of ls.close) f(); }, closeEarly: () => { for (const f of ls.close) f(); }, booked: () => booked };
}
{
  let id = openLoopbackCall(); let e = fakeEnds(id);
  cutLoopbackCall(id); e.finish();
  ok(e.booked() === 1 && !calls.has(id), "connector stops waiting, then the route writes its settled 200: booked once, entry ended");
  id = openLoopbackCall(); e = fakeEnds(id);
  e.finish(); cutLoopbackCall(id); cutLoopbackCall(id);
  ok(e.booked() === 1 && !calls.has(id), "the route writes its settled 200, then the connector stops waiting (the stall order): booked once");
  id = openLoopbackCall(); e = fakeEnds(id);
  e.finish(); closeLoopbackCall(id); cutLoopbackCall(id);
  ok(e.booked() === 0 && !calls.has(id), "the connector received the answer: nothing is owed");
  id = openLoopbackCall(); e = fakeEnds(id, { status: 422 });
  cutLoopbackCall(id); e.finish();
  ok(e.booked() === 0 && !calls.has(id), "an answer that settled nothing (a 4xx) books nothing");
  id = openLoopbackCall(); e = fakeEnds(id);
  e.closeEarly(); cutLoopbackCall(id);
  ok(e.booked() === 0 && !calls.has(id), "a response closed before it finished is the hang-up recorder's, not booked here");
}

// ---- one outcome per call ------------------------------------------------------
{
  const mk = (id) => { const req = { headers: Object.fromEntries(Object.entries(mcpLoopbackHeaders({ callId: id })).map(([k, v]) => [k.toLowerCase(), v])), socket: { remoteAddress: "127.0.0.1" } }; isMcpLoopback(req); return req; };
  let id = openLoopbackCall(); let req = mk(id);
  const first = cutLoopbackCall(id);
  ok(first.routeCounted === false && loopbackCallCut(req) === true, "the connector stops first: it counts, and the route reads the cut and does not");
  closeLoopbackCall(id);
  id = openLoopbackCall(); req = mk(id);
  ok(loopbackCallCut(req) === false, "before any cut the route counts its own outcome");
  noteLoopbackCounted(req);
  ok(cutLoopbackCall(id).routeCounted === true, "the route counted first: the connector's cut says so and is not counted again");
  closeLoopbackCall(id);
}

// ---- bounded -------------------------------------------------------------------
{
  const before = calls.size;
  const ids = Array.from({ length: LOOPBACK_CALLS_MAX + 50 }, () => openLoopbackCall());
  ok(calls.size <= LOOPBACK_CALLS_MAX, `open calls stay under the cap (${calls.size} of ${LOOPBACK_CALLS_MAX})`);
  ok(!calls.has(ids[0]) && calls.has(ids[ids.length - 1]), "the oldest go first");
  for (const id of ids) closeLoopbackCall(id);
  ok(calls.size <= before, "every closed call is gone");
}

// ---- the event-loop stall, over the real loopback client -----------------------
// The route holds the loop past the connector's deadline, then writes its
// settled 200 in the same turn: the answer is in the socket before the
// connector's timer runs, so the route sees an ordinary delivery while the
// connector reports a cut-off. The charge must be booked as owed.
{
  const app = express();
  app.use(stripMcpMarker);
  const booked = [];
  let routeOutcomes = 0;
  app.use((req, res, next) => {
    watchLoopbackOutcome(req, res, { settled: (r) => r.statusCode === 200 && !!r.getHeader("PAYMENT-RESPONSE"), onSettledCut: () => booked.push(req.path) });
    res.once("close", () => { if (!loopbackCallCut(req)) { routeOutcomes++; noteLoopbackCounted(req); } });
    next();
  });
  app.post("/api/stall", (req, res) => {
    const until = Date.now() + 400; while (Date.now() < until) { /* the loop is held, as a stalled process would hold it */ }
    res.setHeader("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453" })).toString("base64"));
    res.status(200).json({ ok: true });
  });
  app.post("/api/quick", (req, res) => {
    res.setHeader("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453" })).toString("base64"));
    res.status(200).json({ ok: true });
  });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const port = server.address().port;
  const pay = createMcpMppLoopback({ port });
  try {
    // The control: an answer the connector receives is never booked.
    let id = openLoopbackCall();
    const quick = await pay({ def: { route: "POST /api/quick" }, params: {}, timeoutMs: 5_000, callId: id });
    closeLoopbackCall(id);
    await sleep(50);
    ok(quick.status === 200 && booked.length === 0 && !calls.has(id), `control: a settled answer the connector received books nothing (${quick.status}, ${booked.length} booked)`);
    // The stall.
    id = openLoopbackCall();
    let cut = null, routeCounted = null;
    try { await pay({ def: { route: "POST /api/stall" }, params: {}, timeoutMs: 150, callId: id }); }
    catch (e) { cut = e?.name; ({ routeCounted } = cutLoopbackCall(id)); }
    await sleep(100);
    ok(cut === "TimeoutError" || cut === "AbortError", `the connector's deadline fired (${cut})`);
    ok(booked.length === 1 && booked[0] === "/api/stall", `the settled answer the connector never read is booked once (${JSON.stringify(booked)})`);
    ok(routeOutcomes === 2 && routeCounted === true, `one outcome for the stalled call: the route counted it, so the connector's cut is not counted again (route outcomes ${routeOutcomes}, routeCounted ${routeCounted})`);
    ok(!calls.has(id), "and its entry ended");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ---- cut off, then resent with the same Idempotency-Key -----------------------
// The stalled answer was stored as delivered (its 200 finished), and the cut
// booked it as owed afterwards. A resend of the same payment and key must not
// get both the stored answer and the debt: the stored answer is restated as
// charged, so the replay voids the debt before serving it. Both orders of the
// route's finish listeners (the store's commit first, or the booking first).
for (const bookFirst of [false, true]) {
  const app = express();
  app.use(express.json());
  app.use(stripMcpMarker);
  const debts = new Map(); // tx -> "owed" | "void"
  const replays = [];
  const watch = (req, res, next) => {
    watchLoopbackOutcome(req, res, {
      settled: (r) => r.statusCode === 200,
      onSettledCut: () => {
        const tx = "0x" + "ef".repeat(32);
        debts.set(tx, "owed");
        noteChargedAfterServe(req, { tx, network: "eip155:8453", wire: "x402" });
      },
    });
    next();
  };
  if (bookFirst) app.use(watch);
  app.use(createIdempotency({
    isCatalogRoute: () => true,
    freeMode: true,
    onReplay: async (_req, { charged }) => {
      replays.push(charged);
      if (charged?.tx && debts.get(charged.tx) === "owed") debts.set(charged.tx, "void");
    },
  }));
  if (!bookFirst) app.use(watch);
  let runs = 0;
  app.post("/api/stall-idem", (req, res) => {
    runs++;
    const until = Date.now() + 400; while (Date.now() < until) { /* held loop */ }
    res.status(200).json({ ok: true, run: runs });
  });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const pay = createMcpMppLoopback({ port: server.address().port });
  const label = bookFirst ? "booking listener first" : "store listener first";
  try {
    const call = { def: { route: "POST /api/stall-idem" }, params: { q: 1 }, paymentSignature: "sig-cut-resend", idempotencyKey: "cut-resend-1" };
    const id = openLoopbackCall();
    let cut = false;
    try { await pay({ ...call, timeoutMs: 150, callId: id }); } catch { cut = true; cutLoopbackCall(id); }
    await sleep(100);
    const tx = "0x" + "ef".repeat(32);
    ok(cut && debts.get(tx) === "owed", `${label}: the cut-off settled answer is booked as owed`);
    const id2 = openLoopbackCall();
    const again = await pay({ ...call, timeoutMs: 5_000, callId: id2 });
    closeLoopbackCall(id2);
    ok(again.status === 200 && runs === 1, `${label}: the resend is served from the stored answer, not run again (${again.status}, runs ${runs})`);
    ok(replays.length === 1 && replays[0]?.tx === tx, `${label}: the stored answer was restated as charged under the booked debt (${JSON.stringify(replays[0])})`);
    ok(debts.get(tx) === "void", `${label}: the debt is void once the stored answer is delivered, so the buyer is not both served and owed`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
{
  // The restatement is a no-op off a keyed request.
  ok(noteChargedAfterServe({}, { tx: "0x1" }) === false && noteChargedAfterServe(null, { tx: "0x1" }) === false, "no stored answer, nothing restated");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = server.slice(server.indexOf("function recordHangupDebt("), server.indexOf("function recordHangupOutcome("));
  ok(/req\.__a402HangupDebt = row;\s*(\/\/[^\n]*\n\s*)*noteChargedAfterServe\(req, row\);/.test(fn), "server: every booked hang-up debt restates an answer already stored as delivered");
}

// ---- the server and the connector are wired to it -----------------------------
{
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const http = readFileSync(new URL("../src/mcp-http.js", import.meta.url), "utf8");
  const fn = server.slice(server.indexOf("function noteToolOutcomeOnClose("), server.indexOf("function noteToolOutcomeOnClose(") + 4000);
  ok(/watchLoopbackOutcome\(req, res, \{\s*settled: \(r\) => r\.statusCode === 200,\s*onSettledCut: \(\) => \{ try \{ recordHangupDebt\(req, res, \{ reason: "connector stopped waiting" \}\);/.test(fn), "server: every catalog answer watches the connector's replay and books a settled answer it stopped waiting for (recordHangupDebt, on the receipt's proof)");
  ok(/if \(loopbackCallCut\(req\)\) \{ \/\* counted by the connector \*\/ \}\s*else \{\s*toolFailureMonitor\(\)\.noteTool\(/.test(fn) && /noteLoopbackCounted\(req\);/.test(fn), "server: a replay the connector cut is counted by the connector only; otherwise the route counts and says so");
  ok(/onPaidCutoff: \(slug, \{[^}]*routeCounted = false \} = \{\}\) => \{[\s\S]{0,400}if \(!routeCounted\) \{ try \{ toolFailureMonitor\(\)\.noteTool\(/.test(server), "server: the connector's cut-off is not counted when the route counted the call");
  const x402Leg = http.slice(http.indexOf("async function payOverX402("), http.indexOf("async function payOverX402(") + 4000);
  ok(/const callId = openLoopbackCall\(\);[\s\S]{0,200}x402Loopback\(\{[^}]*callId \}\);\s*closeLoopbackCall\(callId\);[\s\S]{0,400}const \{ routeCounted \} = cutLoopbackCall\(callId\);\s*onPaidCutoff\([^;]*routeCounted \}\);/.test(x402Leg), "connector: the x402 leg names its replay, closes it on an answer and cuts it on a cut-off");
  ok(/const callId = credentialHeader \? openLoopbackCall\(\) : null;[\s\S]{0,200}mppLoopback\(\{[^}]*callId \}\);\s*if \(callId\) closeLoopbackCall\(callId\);[\s\S]{0,600}cutLoopbackCall\(callId\)[\s\S]{0,200}onPaidCutoff\([^;]*routeCounted \}\);/.test(http), "connector: the MPP leg does the same for a call with a credential");
}

console.log(`\ntest-mcp-loopback-cut: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
