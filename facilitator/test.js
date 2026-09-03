// End-to-end test of the facilitator: spawns the real server as a child
// process, drives it through REAL signed Stellar testnet payments (no
// mocks), and independently confirms via Horizon that transactions actually
// landed on-chain - the step that proves the whole point of this package
// (a facilitator whose reported success is independently verifiable,
// closing the gap the OpenZeppelin channel-service race leaves open in
// production).
//
// Also regression-tests a real bug found by live-probing this exact
// facilitator: two concurrent /settle calls raced on the single signer's
// Stellar sequence number and one was rejected before it ever reached a
// ledger (confirmed via both Horizon and the Soroban RPC returning
// NOT_FOUND for the losing transaction). Fixed by serializing settlement
// through queue.js - see step 9 below for the regression test.
//
// Step 17 regression-tests a second real bug, found live in PRODUCTION
// (2026-08-14, this facilitator's first full day on mainnet): a /settle
// call hung for exactly 300s with no timeout anywhere, until the calling
// side gave up and closed the connection - Railway logged it as a 499,
// which surfaced upstream as an opaque 502. Neither the buyer's account nor
// this facilitator's own signer showed any transaction from that window, so
// the underlying RPC call stalled before ever submitting anything. Fixed
// with a bounded timeout on both /verify and /settle (timeout.js), plus
// best-effort payer recovery on a settle timeout/dispatch error - without
// that second part, src/stellar-confirm.js's "ask the chain before
// believing a failure" safety net in the main app reads an undefined payer
// from our own facilitator's error responses and silently never fires.
//
// A third real bug, found live in PRODUCTION (2026-08-15, the day after the
// timeout fix shipped): a genuine, fast (1.4s, not a hang) settle rejection
// with no diagnostic value at all - @x402/stellar reduces any
// sendTransaction() rejection to one bucket, errorReason "settle_exact_
// stellar_transaction_submission_failed", discarding the RPC's actual
// response (status, errorResultXdr - the real reason: bad sequence,
// insufficient fee, a specific operation-level failure). Fixed with
// rpc-diagnostics.js, a diagnostics-only patch on the Stellar SDK's
// rpc.Server.prototype (the vendor scheme constructs its own RPC client
// internally per-call, so this is the only interception point available)
// that logs the decoded rejection reason without altering what the caller
// sees. Step "0c" below unit-tests the XDR decoder against real,
// self-encoded xdr.TransactionResult objects (not hand-authored base64).
//
//   node test.js          (run from facilitator/, after `npm install`)
//
// One real manual setup step is required and CANNOT be automated: Circle's
// testnet USDC faucet is CAPTCHA-gated in the browser, so this test cannot
// mint itself fresh testnet USDC on every run. Instead it uses a persistent
// payer account you fund ONCE - see README.md "Running the tests" for the
// three-step recipe (Stellar Laboratory account + trustline, then Circle
// Faucet). The facilitator's own signer, by contrast, only ever needs XLM
// (native, friendbot-fundable, zero manual steps), so those accounts are
// generated fresh and funded automatically on every run.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Keypair, Asset, Operation, TransactionBuilder, BASE_FEE, Networks, xdr,
} from "@stellar/stellar-sdk";
import {
  createEd25519Signer, ExactStellarScheme, USDC_TESTNET_ADDRESS, getHorizonClient,
} from "@x402/stellar";
import { invalidVerify, invalidSettle, normalizeVerify, normalizeSettle } from "./shape.js";
import { withTimeout, TimeoutError } from "./timeout.js";
import { decodeErrorResultXdr, describeRpcRejection } from "./rpc-diagnostics.js";
import { ensureRpcTimeout, installRpcRequestTimeout, RpcRequestTimeoutError } from "./rpc-timeout.js";
import { installRpcFailover, isTransportFailure, resolveFallbackUrls, DEFAULT_FALLBACKS } from "./rpc-failover.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const NETWORK = "stellar:testnet";
const PORT = 4099;
const AUTH_PORT = 4100;
const BASE_URL = `http://localhost:${PORT}`;
const AUTH_BASE_URL = `http://localhost:${AUTH_PORT}`;
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"; // Circle testnet USDC
const USDC_ASSET = new Asset("USDC", USDC_ISSUER);
const AMOUNT = "10000"; // 0.001 USDC at 7 decimals

const fail = (msg) => { console.error("FAIL:", msg); process.exitCode = 1; throw new Error(msg); };
let passed = 0;
const ok = (cond, msg) => { if (!cond) fail(msg); else { passed++; console.log("ok -", msg); } };

const horizon = getHorizonClient(NETWORK);

// 0) Offline unit tests for shape.js - fast, deterministic, no network.
{
  ok(invalidVerify("x").isValid === false, "invalidVerify: isValid false");
  ok(invalidVerify("bad_reason").invalidReason === "bad_reason", "invalidVerify: carries reason");
  ok(invalidSettle("x").success === false, "invalidSettle: success false");
  ok(invalidSettle("x").transaction === "", "invalidSettle: transaction is empty string placeholder");
  ok(invalidSettle("x").network === "unknown", "invalidSettle: network falls back to 'unknown'");
  ok(invalidSettle("x", "stellar:testnet").network === "stellar:testnet", "invalidSettle: network passthrough");
  ok(normalizeVerify(undefined).isValid === false, "normalizeVerify: undefined result -> invalid");
  ok(normalizeVerify({ isValid: true, payer: "G..." }).payer === "G...", "normalizeVerify: preserves extra fields");
  ok(normalizeVerify({ isValid: "yes" }).isValid === false, "normalizeVerify: coerces non-boolean isValid to false");
  ok(normalizeSettle(undefined, "stellar:testnet").network === "stellar:testnet", "normalizeSettle: undefined result uses fallback network");
  ok(normalizeSettle({ success: true, transaction: "abc", network: "stellar:testnet" }).transaction === "abc", "normalizeSettle: preserves real transaction");
  ok(normalizeSettle({ success: false }, "stellar:testnet").transaction === "", "normalizeSettle: missing transaction -> empty string");
  console.log("shape.js unit tests ✓");
}

// 0b) Offline unit tests for timeout.js - fast, deterministic, no network.
// Added after a real production incident (2026-08-14): a /settle call hung
// for 300s with no timeout at all, eventually killed by the CALLER giving
// up, which surfaced as an opaque 502. These lock the mechanism that fixes
// it directly, independent of ever reproducing a real RPC stall.
{
  const wt = await withTimeout(Promise.resolve("fast"), 200, "quick");
  ok(wt === "fast", "withTimeout: resolves normally when the promise wins the race");

  let timedOut = false;
  try {
    await withTimeout(new Promise(() => {}), 20, "never-resolves");
  } catch (e) {
    timedOut = e instanceof TimeoutError && e.code === "FACILITATOR_TIMEOUT";
  }
  ok(timedOut, "withTimeout: a promise that never settles rejects with TimeoutError once the timer fires");

  let rejectedFast = false;
  try {
    await withTimeout(Promise.reject(new Error("boom")), 200, "quick-reject");
  } catch (e) {
    rejectedFast = e.message === "boom"; // the ORIGINAL rejection, not a timeout
  }
  ok(rejectedFast, "withTimeout: a promise that rejects before the timer still surfaces its own error, not a timeout");

  // The loser of a lost race must never produce an unhandled rejection -
  // this is what actually crashes/warns a Node process, not just a log line.
  // Constructed so the WRAPPED promise rejects LATE (after the timeout has
  // already won and the caller has already moved on) - the exact shape of
  // an abandoned, still-running /settle call that eventually fails.
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on("unhandledRejection", onUnhandled);
  const slowRejecter = new Promise((_, reject) => setTimeout(() => reject(new Error("late failure")), 40));
  await withTimeout(slowRejecter, 10, "abandoned").catch(() => {});
  await new Promise((r) => setTimeout(r, 80)); // outlive slowRejecter's own 40ms rejection
  process.off("unhandledRejection", onUnhandled);
  ok(!unhandled, "withTimeout: a lost race's eventual rejection never surfaces as an unhandled rejection");

  console.log("timeout.js unit tests ✓");
}


// 0c) Offline unit tests for rpc-diagnostics.js's XDR decoder - fast,
// deterministic, no network. Found live in production (2026-08-15): a real
// canary settlement rejection surfaced only as errorReason:
// "settle_exact_stellar_transaction_submission_failed", with @x402/stellar
// discarding the actual RPC response. These construct REAL
// xdr.TransactionResult objects with the Stellar SDK's own encoder (not
// hand-authored base64) and round-trip them through the decoder, so a
// mistaken assumption about the SDK's own union/getter shape fails loudly
// here instead of silently mis-decoding a real production incident later.
{
  const encodeResult = (resultResult) =>
    new xdr.TransactionResult({
      feeCharged: new xdr.Int64(0),
      result: resultResult,
      ext: xdr.TransactionResultExt.fromXDR("00000000", "hex"),
    }).toXDR("base64");

  const raw = describeRpcRejection({ status: "ERROR", hash: "b5ff", latestLedger: 123, diagnosticEventsXdr: ["AAAA"], weird: 1, secretish: "x".repeat(5000) });
  ok(/"status":"ERROR"/.test(raw) && /"hash":"b5ff"/.test(raw) && /otherKeys/.test(raw) && raw.length <= 800, `describeRpcRejection: bounded, keeps status/hash/ledger and names unknown keys (${raw.length} chars)`);
  ok(typeof describeRpcRejection(null) === "string" && typeof describeRpcRejection("str") === "string", "describeRpcRejection never throws on a non-object");
  const badSeq = decodeErrorResultXdr(encodeResult(xdr.TransactionResultResult.txBadSeq()));
  ok(badSeq.code === "txBadSeq", `decodeErrorResultXdr: simple top-level code round-trips (got ${JSON.stringify(badSeq)})`);

  // txFailed with one invokeHostFunction op that hit a resource limit -
  // exercises the three-level unwrap (outer switch -> .tr() -> per-op-type
  // getter) that a bad assumption about the SDK's shape would silently
  // mis-decode rather than throw on.
  const invokeOp = xdr.OperationResult.opInner(
    xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionResourceLimitExceeded()),
  );
  const failed = decodeErrorResultXdr(encodeResult(xdr.TransactionResultResult.txFailed([invokeOp])));
  ok(failed.code === "txFailed" && failed.opCodes[0] === "invokeHostFunction:invokeHostFunctionResourceLimitExceeded",
    `decodeErrorResultXdr: per-operation reason unwraps through opInner+tr()+getter (got ${JSON.stringify(failed)})`);

  // A direct op-level error (the operation never ran at all) needs NO
  // further unwrapping - its own top-level switch name IS the reason.
  const badAuthOp = xdr.OperationResult.opBadAuth();
  const badAuth = decodeErrorResultXdr(encodeResult(xdr.TransactionResultResult.txFailed([badAuthOp])));
  ok(badAuth.opCodes[0] === "opBadAuth", `decodeErrorResultXdr: a direct op-level error skips the tr() unwrap (got ${JSON.stringify(badAuth)})`);

  const garbage = decodeErrorResultXdr("not-valid-base64-xdr!!!");
  ok(typeof garbage?.decodeError === "string", `decodeErrorResultXdr: malformed input never throws, falls back to decodeError (got ${JSON.stringify(garbage)})`);

  ok(decodeErrorResultXdr(undefined) === null, "decodeErrorResultXdr: no errorResultXdr at all -> null, not a crash");

  // stellar-sdk >= 13 hands the parsed xdr.TransactionResult as `errorResult`
  // (no string): the 2026-08-27 production line "(no errorResultXdr in
  // response) ... otherKeys:[errorResult]" was this decoder reading the old field.
  const { decodeErrorResult } = await import("./rpc-diagnostics.js");
  const parsed = xdr.TransactionResult.fromXDR(encodeResult(xdr.TransactionResultResult.txFailed([badAuthOp])), "base64");
  ok(decodeErrorResult({ status: "ERROR", errorResult: parsed })?.opCodes?.[0] === "opBadAuth", "decodeErrorResult: the SDK's parsed errorResult object decodes like the XDR string did");
  ok(decodeErrorResult({ status: "ERROR", errorResultXdr: encodeResult(xdr.TransactionResultResult.txFailed([badAuthOp])) })?.opCodes?.[0] === "opBadAuth", "decodeErrorResult: the legacy errorResultXdr string still decodes");
  ok(decodeErrorResult({ status: "ERROR" }) === null, "decodeErrorResult: neither field -> null");

  console.log("rpc-diagnostics.js unit tests ✓");
}

// 0d) Offline tests for rpc-timeout.js - the per-request RPC bound. Local
// servers stand in for a stalled provider (2026-08-14 and 2026-08-19 both:
// /verify fine, /settle stalled inside one RPC round-trip). NB the prototype
// patch is PROCESS-WIDE and this test process later signs real testnet
// payments through the same SDK, so the installed default is the production
// value (10s) and the tight bounds below are set per INSTANCE - the first
// version installed 300ms here and broke every later RPC call in this file.
{
  ok(ensureRpcTimeout({ defaults: {} }, 500) === true, "ensureRpcTimeout: sets a missing default");
  const pre = { defaults: { timeout: 30_000 } };
  ok(ensureRpcTimeout(pre, 500) === true && pre.defaults.timeout === 30_000, "ensureRpcTimeout: an explicitly configured positive timeout is respected");
  ok(ensureRpcTimeout(pre, 500) === false, "ensureRpcTimeout: idempotent per client");
  ok(ensureRpcTimeout(null, 500) === false && ensureRpcTimeout({}, 500) === false, "ensureRpcTimeout: tolerates a missing client");
  // The body-less "200" the adapter resolves with when the bound cuts a
  // response mid-body (measured live against testnet RPC) must become a
  // self-explaining timeout rejection, never the SDK's TypeError.
  {
    let handler = null;
    const fake = { defaults: {}, interceptors: { response: { use: (ok) => { handler = ok; } } } };
    ensureRpcTimeout(fake, 700);
    let thrown = null;
    try { handler({ status: 200, headers: {}, data: undefined }); } catch (e) { thrown = e; }
    ok(thrown instanceof RpcRequestTimeoutError && thrown.code === "RPC_REQUEST_TIMEOUT" && /700ms/.test(thrown.message), `ensureRpcTimeout: a body-less response rejects as RpcRequestTimeoutError (${thrown?.message})`);
    ok(handler({ status: 200, data: { result: 1 } }).data.result === 1, "ensureRpcTimeout: a real response passes through untouched");
  }

  const { createServer } = await import("node:http");
  const { rpc } = await import("@stellar/stellar-sdk");
  installRpcRequestTimeout(10_000); // production default, process-wide (see note above)

  // (a) pre-header stall: the provider accepts the connection and never answers.
  const blackhole = createServer(() => { /* never respond */ });
  await new Promise((r) => blackhole.listen(0, "127.0.0.1", r));
  const stalled = new rpc.Server(`http://127.0.0.1:${blackhole.address().port}`, { allowHttp: true });
  stalled.httpClient.defaults.timeout = 300; // tighter per-instance bound, respected by the patch
  let t0 = Date.now(), err = null;
  try { await stalled.getLatestLedger(); } catch (e) { err = e; }
  let took = Date.now() - t0;
  ok(err && /timeout of 300 ?ms/i.test(String(err.message || err)) && took < 5_000, `rpc-timeout: a pre-header stall rejects at the bound (${took}ms: ${String(err?.message || err).slice(0, 60)})`);
  blackhole.closeAllConnections(); blackhole.close();

  // (b) mid-body stall: headers arrive, the body never does. The adapter
  // RESOLVES with no data here (measured), which the SDK turned into an
  // opaque TypeError - must surface as the self-explaining timeout instead.
  const headersOnly = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json", "content-length": "1000" }); /* never write the body */ });
  await new Promise((r) => headersOnly.listen(0, "127.0.0.1", r));
  const cut = new rpc.Server(`http://127.0.0.1:${headersOnly.address().port}`, { allowHttp: true });
  cut.httpClient.defaults.timeout = 300;
  t0 = Date.now(); err = null;
  try { await cut.getLatestLedger(); } catch (e) { err = e; }
  took = Date.now() - t0;
  ok(err && !(err instanceof TypeError) && /timeout/i.test(String(err.message || err)) && took < 5_000, `rpc-timeout: a mid-body stall rejects with a timeout error, never the SDK's TypeError (${took}ms: ${String(err?.message || err).slice(0, 80)})`);
  headersOnly.closeAllConnections(); headersOnly.close();

  // (c) the patch reaches an instance it never saw being built (the way
  // @x402/stellar constructs one internally) and applies the installed default.
  const fresh = new rpc.Server("http://127.0.0.1:9", { allowHttp: true });
  fresh.getLatestLedger().catch(() => {}); // connection refused; we only care that the default was applied on the way out
  ok(fresh.httpClient.defaults.timeout === 10_000, `rpc-timeout: a fresh rpc.Server gets the installed default on first use (${fresh.httpClient.defaults.timeout})`);
  console.log("rpc-timeout.js unit tests ✓");
}

// ---------------------------------------------------------------------------
// rpc-failover.js: a stalled primary RPC costs one bounded hop, not the settle.
// Real rpc.Server instances against local servers; the prototype patch is
// process-wide (installed AFTER the timeout patch, as index.js does).
// ---------------------------------------------------------------------------
{
  // classification: node failures fail over, transaction answers do not
  ok(isTransportFailure(Object.assign(new Error("timeout of 300ms exceeded"), { code: "ECONNABORTED" })) && isTransportFailure({ code: "ECONNREFUSED" }) && isTransportFailure({ response: { status: 502 } }) && isTransportFailure({ response: { status: 429 } }) && isTransportFailure(new RpcRequestTimeoutError(10)), "isTransportFailure: timeouts, connection errors, 5xx/429 and the body-less response are node failures");
  ok(!isTransportFailure({ code: -32602, message: "invalid params" }) && !isTransportFailure(new Error("simulation failed: HostError")) && !isTransportFailure({ response: { status: 400 } }) && !isTransportFailure(null), "isTransportFailure: a JSON-RPC error, a simulation failure, a 4xx are ANSWERS, never failed over");
  // config
  ok(resolveFallbackUrls("stellar:pubnet", undefined).join(",") === DEFAULT_FALLBACKS["stellar:pubnet"].join(",") && resolveFallbackUrls("stellar:testnet", "").length === 1, "resolveFallbackUrls: network defaults when the env is unset");
  ok(resolveFallbackUrls("stellar:pubnet", " https://a.example/ , https://b.example, junk, https://a.example ").join(",") === "https://a.example,https://b.example", "resolveFallbackUrls: env CSV wins, trimmed, deduped, junk dropped");
  ok(resolveFallbackUrls("stellar:pubnet", "off").length === 0 && resolveFallbackUrls("stellar:pubnet", "none").length === 0, "resolveFallbackUrls: off/none disables");

  const { createServer } = await import("node:http");
  const { rpc } = await import("@stellar/stellar-sdk");
  const jsonRpc = (handler) => createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { let j = {}; try { j = JSON.parse(b); } catch { /* ignore */ } const out = handler(j); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id ?? 1, ...out })); }); });
  let goodHits = 0, fb2Hits = 0;
  // getHealth is the one RPC method whose result the SDK returns unparsed.
  const good = jsonRpc((j) => { goodHits++; return { result: { status: "good", latestLedger: 424242, oldestLedger: 1, ledgerRetentionWindow: 1 } }; });
  const fb2 = jsonRpc(() => { fb2Hits++; return { result: { status: "fb2", latestLedger: 1, oldestLedger: 1, ledgerRetentionWindow: 1 } }; });
  const rpcErr = jsonRpc((j) => ({ error: { code: -32602, message: "invalid params from primary" } }));
  const blackhole = createServer(() => { /* never respond */ });
  for (const s of [good, fb2, rpcErr, blackhole]) await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const url = (s) => `http://127.0.0.1:${s.address().port}`;
  const logs = [];
  const patched = installRpcFailover([url(good), url(fb2)], { log: (m) => logs.push(m), allowHttp: true });
  ok(patched > 30, `installRpcFailover patched the rpc.Server prototype (${patched} methods)`);

  // (a) primary stalls -> served by the first fallback, within the bound
  const stalled = new rpc.Server(url(blackhole), { allowHttp: true });
  stalled.httpClient.defaults.timeout = 300;
  let t0 = Date.now();
  const led = await stalled.getHealth();
  let took = Date.now() - t0;
  ok(led.status === "good" && goodHits === 1 && fb2Hits === 0 && took < 5_000, `failover: a stalled primary is served by the first fallback (${took}ms, status ${led.status})`);
  ok(logs.some((m) => /failed \(ECONNABORTED|failed \(timeout/i.test(m) && /trying 127\.0\.0\.1/.test(m)) && logs.some((m) => /served by 127\.0\.0\.1/.test(m)), "failover: the hop is logged with the reason and the node that served");

  // (b) a JSON-RPC error from the primary is an answer: no failover
  const answered = new rpc.Server(url(rpcErr), { allowHttp: true });
  let err = null; goodHits = 0;
  try { await answered.getHealth(); } catch (e) { err = e; }
  ok(err && /invalid params from primary/.test(String(err?.message || JSON.stringify(err))) && goodHits === 0, `failover: a JSON-RPC error is thrown as-is, the fallback is not asked (${String(err?.message || err).slice(0, 50)})`);

  // (c) a fallback instance never fails over again (no recursion), and the
  //     second fallback is reached when the first is down
  const fbDown = createServer(() => { /* stall */ }); await new Promise((r) => fbDown.listen(0, "127.0.0.1", r));
  logs.length = 0; fb2Hits = 0;
  const { _resetForTest } = await import("./rpc-failover.js");
  _resetForTest(); // allow a second install with a different list for this case
  installRpcFailover([url(fbDown), url(fb2)], { log: (m) => logs.push(m), allowHttp: true, requestTimeoutMs: 300 });
  const stalled2 = new rpc.Server(url(blackhole), { allowHttp: true });
  stalled2.httpClient.defaults.timeout = 300;
  const led2 = await stalled2.getHealth();
  ok(led2.status === "fb2" && fb2Hits === 1, `failover: first fallback down (bounded), second serves (status ${led2.status})`);
  ok(logs.filter((m) => /trying/.test(m)).length === 2, "failover: each fallback is tried once, in order, no recursion");

  // (d) everything down: the PRIMARY's error is what the caller sees, with the fallback errors attached
  _resetForTest();
  installRpcFailover([url(fbDown)], { log: () => {}, allowHttp: true, requestTimeoutMs: 300 });
  const stalled3 = new rpc.Server(url(blackhole), { allowHttp: true });
  stalled3.httpClient.defaults.timeout = 200;
  err = null; t0 = Date.now();
  try { await stalled3.getHealth(); } catch (e) { err = e; }
  took = Date.now() - t0;
  ok(err && /timeout/i.test(String(err.message)) && Array.isArray(err.fallbackErrors) && err.fallbackErrors.length === 1 && took < 8_000, `failover: all nodes down -> the primary's timeout error, fallbackErrors attached (${took}ms)`);
  for (const s of [good, fb2, rpcErr, blackhole, fbDown]) { s.closeAllConnections?.(); s.close(); }
  console.log("rpc-failover.js unit tests ✓");
}

// ---------------------------------------------------------------------------
// Hedged reads (rpc-failover.js hedgeMs): a slow-but-answering primary no
// longer costs the settle. Same process-wide prototype, new install list.
// ---------------------------------------------------------------------------
{
  const { createServer } = await import("node:http");
  const { rpc } = await import("@stellar/stellar-sdk");
  const { installRpcFailover, shouldHedge, _resetForTest } = await import("./rpc-failover.js");
  const jsonRpc = (handler, delayMs = 0) => createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { let j = {}; try { j = JSON.parse(b); } catch { /* ignore */ } const send = () => { const out = handler(j); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id ?? 1, ...out })); }; delayMs ? setTimeout(send, delayMs) : send(); }); });
  let slowHits = 0, fbHits = 0, quickHits = 0;
  const slow = jsonRpc(() => { slowHits++; return { result: { status: "slow", latestLedger: 1, oldestLedger: 1, ledgerRetentionWindow: 1 } }; }, 1_500);
  const fb = jsonRpc(() => { fbHits++; return { result: { status: "fb", latestLedger: 1, oldestLedger: 1, ledgerRetentionWindow: 1 } }; });
  const quick = jsonRpc(() => { quickHits++; return { result: { status: "quick", latestLedger: 1, oldestLedger: 1, ledgerRetentionWindow: 1 } }; }, 50);
  const rpcErr = jsonRpc(() => ({ error: { code: -32602, message: "invalid params from slow primary" } }), 100);
  for (const s of [slow, fb, quick, rpcErr]) await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const url = (s) => `http://127.0.0.1:${s.address().port}`;
  const logs = [];
  _resetForTest();
  installRpcFailover([url(fb)], { log: (m) => logs.push(m), allowHttp: true, hedgeMs: 200 });
  ok(logs.some((m) => /reads hedged .* after 200ms/.test(m)), "hedge: the startup line names the hedge delay and node");

  // (a) primary silent past the hedge delay -> the fallback's answer wins, well before the primary would have answered
  const s1 = new rpc.Server(url(slow), { allowHttp: true });
  let t0 = Date.now();
  const h1 = await s1.getHealth();
  let took = Date.now() - t0;
  ok(h1.status === "fb" && fbHits === 1 && took < 1_200, `hedge: a slow primary is out-raced by the fallback (${took}ms, status ${h1.status})`);
  ok(logs.some((m) => /\[rpc-hedge\] getHealth: .*silent for 200ms -> also asking/.test(m)) && logs.some((m) => /\[rpc-hedge\] getHealth: served by/.test(m)), "hedge: both the hedge and the winner are logged");

  // (b) a primary that answers inside the delay is never hedged
  fbHits = 0; logs.length = 0;
  const s2 = new rpc.Server(url(quick), { allowHttp: true });
  const h2 = await s2.getHealth();
  ok(h2.status === "quick" && quickHits === 1 && fbHits === 0 && !logs.some((m) => /rpc-hedge/.test(m)), "hedge: a prompt primary answers alone (no fallback traffic)");

  // (c) a JSON-RPC error from the primary is an answer even when it arrives slowly - no hedge result replaces it
  fbHits = 0;
  const s3 = new rpc.Server(url(rpcErr), { allowHttp: true });
  let err = null;
  try { await s3.getHealth(); } catch (e) { err = e; }
  ok(err && /invalid params from slow primary/.test(String(err?.message || JSON.stringify(err))), "hedge: a JSON-RPC error from the primary stands (it is an answer)");

  // (d) the rule: sendTransaction is never hedged, a fallback instance is never hedged
  ok(shouldHedge("getTransaction", s1) === true && shouldHedge("sendTransaction", s1) === false, "hedge: reads are hedged, sendTransaction never");
  const fbInstance = new rpc.Server(url(fb), { allowHttp: true });
  ok(shouldHedge("getHealth", fbInstance) === false, "hedge: a call already on a fallback url is not hedged again");
  for (const s of [slow, fb, quick, rpcErr]) { s.closeAllConnections?.(); s.close(); }
  console.log("rpc-hedge unit tests ✓");
}

// ---------------------------------------------------------------------------
// settle-poll.js: the post-submit poll is capped, observable, and hands the
// tx hash out (so a timed-out /settle can still name what it submitted).
// ---------------------------------------------------------------------------
{
  const { installPollClamp } = await import("./settle-poll.js");
  const seen = [];
  const proto = { async pollForTransaction(server, hash, max, delay) { seen.push({ hash, max, delay }); return { success: max === 5 }; } };
  const logs = [], hashes = [];
  ok(installPollClamp(proto, { maxAttempts: 8, log: (m) => logs.push(m), onHash: (h) => hashes.push(h) }) === true, "poll clamp: installs on a scheme prototype with pollForTransaction");
  const r1 = await proto.pollForTransaction(null, "abc123def456xyz", 300, 1000);
  ok(seen[0].max === 8 && seen[0].delay === 1000 && r1.success === false, `poll clamp: the caller's 300 attempts (maxTimeoutSeconds) become 8 (got ${seen[0].max})`);
  ok(hashes[0] === "abc123def456xyz" && logs.some((m) => /submitted abc123def456.* polling up to 8 attempt\(s\) \(caller asked 300\)/.test(m)) && logs.some((m) => /not confirmed after \d+ms/.test(m)), "poll clamp: hash handed out, attempts and elapsed logged");
  const r2 = await proto.pollForTransaction(null, "h2", 5, 1000);
  ok(seen[1].max === 5 && r2.success === true && logs.some((m) => /h2\.\.\. SUCCESS after/.test(m)), "poll clamp: a request under the cap passes through unchanged");
  ok(installPollClamp({}, {}) === false, "poll clamp: refuses a prototype without pollForTransaction");
  console.log("settle-poll.js unit tests ✓");
}

// ---------------------------------------------------------------------------
// fee-bid.js: the settlement transaction goes out bidding ABOVE the vendor's
// hardcoded network minimum, because bidding the minimum lost Stellar's fee
// auction on busy ledgers (measured 2026-08-31: 37.5% of Stellar rail legs
// failed over 30 days, in two shapes that both reduce to this bid). The
// assertions that matter are the ones that would let the defect back in: a
// build() that does not actually carry the raised bid, and a malformed env
// value quietly restoring the minimum.
// ---------------------------------------------------------------------------
{
  const { installFeeBid, resolveBidStroops, assertFeeBumpUnpatched, DEFAULT_BID_STROOPS, VENDOR_BID_STROOPS } =
    await import("./fee-bid.js");
  const { Account, Asset, Networks, Operation, TransactionBuilder: TB, BASE_FEE } =
    await import("@stellar/stellar-sdk");

  ok(VENDOR_BID_STROOPS === Number(BASE_FEE), `fee bid: the vendor default we raise from is the SDK's BASE_FEE (got ${VENDOR_BID_STROOPS})`);

  // The patch mutates ONE TransactionBuilder class, and it only reaches the
  // vendor because both resolve to the same physical @stellar/stellar-sdk.
  // A transitive dependency pinning a second copy would shadow it and leave
  // the fix installed, logged at startup, and completely inert - the silent-
  // dead-fix class this repo has been burned by before. Pin the invariant.
  {
    const { readdirSync, existsSync } = await import("node:fs");
    const nested = readdirSync(new URL("./node_modules/@x402/", import.meta.url), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => existsSync(new URL(`./node_modules/@x402/${d.name}/node_modules/@stellar/stellar-sdk`, import.meta.url)));
    ok(nested.length === 0, `fee bid: no nested @stellar/stellar-sdk copy shadows the one this patch mutates (found: ${nested.map((d) => d.name).join(", ") || "none"})`);
  }

  // Env parsing. A typo must fall back to the DEFAULT, never to disabled -
  // disabled is the old broken behaviour, and a typo must not select it.
  ok(resolveBidStroops(undefined) === DEFAULT_BID_STROOPS, "fee bid: unset env uses the default bid");
  ok(resolveBidStroops("") === DEFAULT_BID_STROOPS, "fee bid: empty env uses the default bid");
  ok(resolveBidStroops("12345") === 12345, "fee bid: an explicit whole-stroop value is honoured");
  ok(resolveBidStroops("off") === 0 && resolveBidStroops("0") === 0, "fee bid: off/0 disables the patch");
  {
    const warned = [];
    ok(resolveBidStroops("50_000!", { log: (m) => warned.push(m) }) === DEFAULT_BID_STROOPS,
      "fee bid: a malformed value falls back to the default, never silently to the network minimum");
    ok(resolveBidStroops("-5", { log: (m) => warned.push(m) }) === DEFAULT_BID_STROOPS, "fee bid: a negative value falls back to the default");
    ok(resolveBidStroops("1.5", { log: (m) => warned.push(m) }) === DEFAULT_BID_STROOPS, "fee bid: a fractional stroop falls back to the default");
    ok(warned.length === 3, `fee bid: every fallback says so out loud (got ${warned.length})`);
  }

  // The patch itself, against a private subclass so the real SDK class is not
  // mutated for the rest of this suite.
  class IsolatedBuilder extends TB {}
  const logs = [];
  ok(installFeeBid({ bidStroops: 50_000, builder: IsolatedBuilder, log: (m) => logs.push(m) }) === true, "fee bid: installs on the builder prototype");
  ok(logs.some((m) => /inclusion-fee bid installed: 50000 stroops/.test(m)), "fee bid: startup line names the bid actually installed");
  ok(installFeeBid({ bidStroops: 50_000, builder: IsolatedBuilder, log: () => {} }) === false, "fee bid: refuses to double-patch");

  const src = "GBA2DDJ4KQXQCGNB7RUU5I2BK5SXROJFUNZV7EZ4XUS7RXFOXEPNY6O4";
  const payment = () => Operation.payment({ destination: src, asset: Asset.native(), amount: "1" });
  const built = (Builder, fee) => new Builder(new Account(src, "1"), { fee, networkPassphrase: Networks.PUBLIC })
    .setTimeout(30).addOperation(payment()).build();

  // The assertion the whole module exists for: a builder handed the vendor's
  // BASE_FEE must produce a transaction bidding the raised fee. Reading
  // this.baseFee would pass even if build() ignored it.
  ok(Number(built(IsolatedBuilder, BASE_FEE).fee) === 50_000,
    `fee bid: a transaction built at the vendor's BASE_FEE goes out at the raised bid (got ${built(IsolatedBuilder, BASE_FEE).fee})`);
  ok(Number(built(IsolatedBuilder, "500000").fee) === 500_000,
    "fee bid: a caller already bidding above the minimum is left alone, never lowered");
  ok(Number(built(TB, BASE_FEE).fee) === Number(BASE_FEE),
    "fee bid: an unpatched builder is untouched (the patch is scoped, not global-by-accident)");

  class DisabledBuilder extends TB {}
  ok(installFeeBid({ bidStroops: 0, builder: DisabledBuilder, log: () => {} }) === false, "fee bid: a disabled bid installs nothing");
  ok(Number(built(DisabledBuilder, BASE_FEE).fee) === Number(BASE_FEE), "fee bid: disabled leaves the vendor minimum in place");
  class NoRaiseBuilder extends TB {}
  ok(installFeeBid({ bidStroops: VENDOR_BID_STROOPS, builder: NoRaiseBuilder, log: () => {} }) === false,
    "fee bid: a bid equal to the minimum is a no-op rather than a patch that changes nothing");

  // The fee-bump path carries its own hardcoded BASE_FEE that build() never
  // sees. We configure no feeBumpSigner today; if that changes, this must be
  // a loud startup line and not a silent return to the minimum bid.
  ok(assertFeeBumpUnpatched({}, { log: () => {} }) === true, "fee bid: no feeBumpSigner configured is the expected state");
  {
    const warned = [];
    ok(assertFeeBumpUnpatched({ feeBumpSigner: { address: src } }, { log: (m) => warned.push(m) }) === false
      && warned.some((m) => /fee bump is built with the vendor's hardcoded BASE_FEE/.test(m)),
      "fee bid: a configured feeBumpSigner warns that the bid does not reach the submitted transaction");
  }
  console.log("fee-bid.js unit tests ✓");
}

// Everything above is offline and deterministic; everything below needs
// Stellar testnet plus a persistent funded payer. CI runs the offline half
// on every push (FACILITATOR_TEST_OFFLINE_ONLY=1) - before this gate the
// facilitator had no CI coverage at all, and a module missing from
// package.json's files allowlist or a broken import shipped unseen.
if (process.env.FACILITATOR_TEST_OFFLINE_ONLY === "1") {
  console.log(`\nfacilitator offline tests: ${passed} passed (any failure throws above)`);
  process.exit(0);
}

async function friendbotFund(publicKey) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) {
    // 400 with "createAccountAlreadyExist" is fine - the account just already
    // exists. Any OTHER 400 (friendbot's own failure) used to be swallowed here
    // and the very next loadAccount() then threw Horizon NotFound - which is
    // exactly what happened on the third fresh account of CI run 32171902738
    // (2026-08-18). Read the body and only accept the one benign case.
    const body = await res.text().catch(() => "");
    // Friendbot's wording for an existing account: "createAccountAlreadyExist"
    // (result code) or "account already funded to starting balance" (its
    // detail string - what it says for the persistent payer, measured in CI
    // run 32172397126). Both mean the account exists; nothing else does.
    if (!(res.status === 400 && /createAccountAlreadyExist|already funded/i.test(body))) {
      throw new Error(`friendbot funding failed for ${publicKey}: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
  }
  // Friendbot answers when its transaction is SUBMITTED; Horizon serves the
  // account only once that transaction is ingested. Wait for it, bounded, so
  // the caller's loadAccount() cannot race the ledger.
  for (let i = 0; i < 30; i++) {
    try { await horizon.loadAccount(publicKey); return; } catch (e) {
      if (e?.response?.status !== 404 && !/Not Found/i.test(String(e?.message || e))) throw e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`friendbot funded ${publicKey} but Horizon still does not serve the account after 30s`);
}

async function ensureTrustline(keypair) {
  const account = await horizon.loadAccount(keypair.publicKey());
  const hasLine = account.balances.some(
    (b) => b.asset_type !== "native" && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER,
  );
  if (hasLine) return;
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: USDC_ASSET, limit: "1000000" }))
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  const res = await horizon.submitTransaction(tx);
  if (!res.successful) throw new Error(`trustline tx failed for ${keypair.publicKey()}: ${JSON.stringify(res)}`);
}

async function usdcBalance(publicKey) {
  const account = await horizon.loadAccount(publicKey);
  const line = account.balances.find(
    (b) => b.asset_type !== "native" && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER,
  );
  return line ? Number(line.balance) : 0;
}

function buildRequirements(payTo, amount) {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: USDC_TESTNET_ADDRESS,
    amount,
    payTo,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };
}

async function signPayment(payerSigner, requirements) {
  const clientScheme = new ExactStellarScheme(payerSigner);
  const created = await clientScheme.createPaymentPayload(2, requirements);
  return { x402Version: created.x402Version, accepted: requirements, payload: created.payload };
}

async function post(baseUrl, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitForHealthy(baseUrl, path = "/supported") {
  for (let i = 0; i < 20; i++) {
    const up = await fetch(`${baseUrl}${path}`).then((r) => r.ok || r.status === 401).catch(() => false);
    if (up) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// 1) Facilitator signer - fresh every run, XLM only, fully automatable.
const facilitatorKp = Keypair.random();
await friendbotFund(facilitatorKp.publicKey());
console.log(`facilitator signer funded: ${facilitatorKp.publicKey()}`);

// 2) Seller (payTo) - fresh every run. Needs to exist on-ledger and hold a
// trustline to receive the SAC transfer (a brand-new G-account can't hold
// any balance, including a wrapped classic asset, until it exists).
const sellerKp = Keypair.random();
await friendbotFund(sellerKp.publicKey());
await ensureTrustline(sellerKp);
console.log(`seller (payTo) funded + trustline: ${sellerKp.publicKey()}`);

// A second, separately-funded+trustlined seller used ONLY as the
// "disallowed" payTo target in the allowlist test (step 16) - it has to be a
// real, receive-capable account (funded, trustlined) or the CLIENT-side
// Soroban simulation rejects it before the payload even exists, which would
// test the SDK's own trustline check instead of our facilitator's allowlist.
const otherSellerKp = Keypair.random();
await friendbotFund(otherSellerKp.publicKey());
await ensureTrustline(otherSellerKp);
console.log(`other seller (not on allowlist) funded + trustline: ${otherSellerKp.publicKey()}`);

// 3) Payer - PERSISTENT, human-funded once via Circle's faucet (see header
// comment). We only automate the trustline (idempotent, no CAPTCHA) and
// check the balance is real.
const payerSecret = (process.env.TEST_PAYER_STELLAR_SECRET || "").trim();
if (!payerSecret) {
  fail(
    "TEST_PAYER_STELLAR_SECRET is not set. This test needs a persistent testnet " +
    "account that actually holds USDC - Circle's faucet is CAPTCHA-gated and can't " +
    "be scripted. See README.md \"Running the tests\" for the one-time setup.",
  );
}
const payerKp = Keypair.fromSecret(payerSecret);
await friendbotFund(payerKp.publicKey()); // no-op if it already exists
await ensureTrustline(payerKp);
const payerBalance = await usdcBalance(payerKp.publicKey());
if (payerBalance <= 0) {
  fail(
    `Payer account ${payerKp.publicKey()} has a 0 USDC balance. Fund it once via ` +
    "https://faucet.circle.com/ (select Stellar testnet) - see README.md.",
  );
}
console.log(`payer ready: ${payerKp.publicKey()} (USDC balance: ${payerBalance})`);
const payerSigner = createEd25519Signer(payerKp.secret(), NETWORK);

// 4) Spawn the real facilitator server (permissive: no auth, no payTo allowlist).
const proc = spawn(process.execPath, [join(ROOT, "index.js")], {
  cwd: ROOT,
  env: { ...process.env, FACILITATOR_STELLAR_SECRET: facilitatorKp.secret(), PORT: String(PORT) },
  stdio: ["ignore", "inherit", "inherit"],
});
process.on("exit", () => { try { proc.kill("SIGKILL"); } catch { /* already dead */ } });
if (!(await waitForHealthy(BASE_URL))) fail("facilitator did not become healthy");

// 5) GET /supported
{
  const supported = await fetch(`${BASE_URL}/supported`).then((r) => r.json());
  ok(Array.isArray(supported.kinds), "/supported: kinds is an array");
  const kind = supported.kinds.find((k) => k.network === NETWORK && k.scheme === "exact");
  ok(!!kind, "/supported: advertises exact scheme on stellar:testnet");
  ok(!!supported.signers && typeof supported.signers === "object", "/supported: signers is an object");
}

// 6) Build payment requirements + a real signed payload from the payer.
const requirements = buildRequirements(sellerKp.publicKey(), AMOUNT);
const paymentPayload = await signPayment(payerSigner, requirements);

// 7) POST /verify
{
  const { status, body } = await post(BASE_URL, "/verify", { x402Version: 2, paymentPayload, paymentRequirements: requirements });
  ok(status === 200, `/verify: HTTP 200 (got ${status})`);
  ok(body.isValid === true, `/verify: isValid true (got ${JSON.stringify(body)})`);
  ok(body.payer === payerKp.publicKey(), "/verify: payer matches");
}

// 8) POST /settle
let settledTx = "";
{
  const { status, body } = await post(BASE_URL, "/settle", { x402Version: 2, paymentPayload, paymentRequirements: requirements });
  ok(status === 200, `/settle: HTTP 200 (got ${status})`);
  ok(body.success === true, `/settle: success true (got ${JSON.stringify(body)})`);
  ok(/^[0-9a-f]{64}$/i.test(body.transaction || ""), "/settle: transaction looks like a real tx hash");
  ok(body.network === NETWORK, "/settle: network echoed back");
  settledTx = body.transaction;
}

// 9) Independently confirm on Horizon - the step that actually proves the
// founding motivation: our facilitator's reported success corresponds to a
// REAL, independently-verifiable on-chain confirmation.
// The facilitator reports success off Soroban RPC's getTransaction; Horizon
// is a SEPARATE ingestion pipeline and can lag it by seconds (CI run
// 32265874173: /settle 200, Horizon 404 eight milliseconds later). Poll
// briefly - a confirmed tx appears within a couple of ledgers; one that
// never appears is still a hard failure.
{
  let tx = null, lastErr = null;
  for (let i = 0; i < 30 && !tx; i++) {
    try { tx = await horizon.transactions().transaction(settledTx).call(); }
    catch (e) { lastErr = e; if (e?.constructor?.name !== "NotFoundError" && e?.response?.status !== 404) throw e; await new Promise((r) => setTimeout(r, 1000)); }
  }
  ok(tx?.successful === true, `Horizon independently confirms the settled transaction succeeded${tx ? "" : ` (never appeared on Horizon within 30s: ${lastErr?.message})`}`);
}

// 10) Concurrency regression test - the actual bug this hardening pass
// fixes. Two DISTINCT real signed payments, fired at /settle via
// Promise.all. Before the queue.js fix, one of these reliably failed with
// NOT_FOUND on both Horizon and the Soroban RPC (never reached a ledger) -
// a sequence-number race on the single facilitator signer.
{
  const reqA = buildRequirements(sellerKp.publicKey(), "5000");
  const reqB = buildRequirements(sellerKp.publicKey(), "7000");
  const [payloadA, payloadB] = await Promise.all([
    signPayment(payerSigner, reqA),
    signPayment(payerSigner, reqB),
  ]);
  const [resA, resB] = await Promise.all([
    post(BASE_URL, "/settle", { x402Version: 2, paymentPayload: payloadA, paymentRequirements: reqA }),
    post(BASE_URL, "/settle", { x402Version: 2, paymentPayload: payloadB, paymentRequirements: reqB }),
  ]);
  ok(resA.status === 200 && resB.status === 200, "concurrency: both /settle calls returned HTTP 200");
  ok(resA.body.success === true, `concurrency: settlement A succeeded (got ${JSON.stringify(resA.body)})`);
  ok(resB.body.success === true, `concurrency: settlement B succeeded (got ${JSON.stringify(resB.body)})`);
  ok(resA.body.transaction !== resB.body.transaction, "concurrency: two distinct transaction hashes");
}

// 11) Negative test - corrupted payload must still return HTTP 200, never 4xx.
{
  const corrupted = { ...paymentPayload, payload: { ...paymentPayload.payload, transaction: "not-a-real-transaction" } };
  const { status, body } = await post(BASE_URL, "/verify", { x402Version: 2, paymentPayload: corrupted, paymentRequirements: requirements });
  ok(status === 200, `/verify (corrupted): HTTP 200, not an error status (got ${status})`);
  ok(body.isValid === false, "/verify (corrupted): isValid false");
  ok(typeof body.invalidReason === "string" && body.invalidReason.length > 0, "/verify (corrupted): carries a reason");
}
{
  const corrupted = { ...paymentPayload, payload: { ...paymentPayload.payload, transaction: "not-a-real-transaction" } };
  const { status, body } = await post(BASE_URL, "/settle", { x402Version: 2, paymentPayload: corrupted, paymentRequirements: requirements });
  ok(status === 200, `/settle (corrupted): HTTP 200, not an error status (got ${status})`);
  ok(body.success === false, "/settle (corrupted): success false");
  ok(body.transaction === "", "/settle (corrupted): transaction is the empty-string placeholder");
  ok(body.network === NETWORK, "/settle (corrupted): network still a valid string");
}

// 12) Malformed body at the transport layer.
{
  const res = await fetch(`${BASE_URL}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  const body = await res.json();
  ok(res.status === 200, `/settle (malformed JSON): HTTP 200 (got ${res.status})`);
  ok(body.success === false, "/settle (malformed JSON): success false");
}

// 13) GET /health - unauthenticated by design, no secret exposed.
{
  const health = await fetch(`${BASE_URL}/health`).then((r) => r.json());
  ok(health.signerAddress === facilitatorKp.publicKey(), "/health: signerAddress matches");
  ok(typeof health.xlmBalance === "number" && health.xlmBalance > 0, "/health: xlmBalance is a positive number");
  ok(health.low === false, "/health: not low right after friendbot funding");
}

proc.kill("SIGKILL");

// 14) A SECOND facilitator instance, this time with auth + a payTo allowlist
// configured, to test both are actually enforced (the permissive instance
// above deliberately leaves both off, matching its "self-hostable, no
// signup" default).
const hardenedFacilitatorKp = Keypair.random();
await friendbotFund(hardenedFacilitatorKp.publicKey());
const AUTH_TOKEN = "test-secret-token-do-not-use-in-prod";
const authProc = spawn(process.execPath, [join(ROOT, "index.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    FACILITATOR_STELLAR_SECRET: hardenedFacilitatorKp.secret(),
    FACILITATOR_AUTH_TOKEN: AUTH_TOKEN,
    FACILITATOR_ALLOWED_PAYTO: sellerKp.publicKey(),
    PORT: String(AUTH_PORT),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
process.on("exit", () => { try { authProc.kill("SIGKILL"); } catch { /* already dead */ } });
if (!(await waitForHealthy(AUTH_BASE_URL))) fail("hardened facilitator did not become healthy");

// 15) Auth enforcement.
{
  const noAuth = await fetch(`${AUTH_BASE_URL}/supported`);
  ok(noAuth.status === 401, `auth: /supported with no token -> 401 (got ${noAuth.status})`);
  const wrongAuth = await fetch(`${AUTH_BASE_URL}/supported`, { headers: { Authorization: "Bearer wrong-token" } });
  ok(wrongAuth.status === 401, `auth: /supported with wrong token -> 401 (got ${wrongAuth.status})`);
  const rightAuth = await fetch(`${AUTH_BASE_URL}/supported`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
  ok(rightAuth.status === 200, `auth: /supported with correct token -> 200 (got ${rightAuth.status})`);
}
{
  // /health stays unauthenticated even on the hardened instance - by design.
  const health = await fetch(`${AUTH_BASE_URL}/health`);
  ok(health.status === 200, `auth: /health has no auth requirement (got ${health.status})`);
}

// 16) payTo allowlist enforcement (allowlist = [sellerKp.publicKey()] only).
{
  const allowedReq = buildRequirements(sellerKp.publicKey(), AMOUNT);
  const allowedPayload = await signPayment(payerSigner, allowedReq);
  const { status, body } = await post(AUTH_BASE_URL, "/verify",
    { x402Version: 2, paymentPayload: allowedPayload, paymentRequirements: allowedReq }, AUTH_TOKEN);
  ok(status === 200, `payto allowlist: allowed payTo -> HTTP 200 (got ${status})`);
  ok(body.invalidReason !== "payto_not_allowed", "payto allowlist: allowed payTo is not rejected for that reason");

  const disallowedReq = buildRequirements(otherSellerKp.publicKey(), AMOUNT);
  const disallowedPayload = await signPayment(payerSigner, disallowedReq);
  const rejected = await post(AUTH_BASE_URL, "/verify",
    { x402Version: 2, paymentPayload: disallowedPayload, paymentRequirements: disallowedReq }, AUTH_TOKEN);
  ok(rejected.status === 200, `payto allowlist: disallowed payTo still HTTP 200 (got ${rejected.status})`);
  ok(rejected.body.isValid === false, "payto allowlist: disallowed payTo is invalid");
  ok(rejected.body.invalidReason === "payto_not_allowed", `payto allowlist: disallowed payTo carries the right reason (got ${JSON.stringify(rejected.body)})`);
}

authProc.kill("SIGKILL");

// 17) Settle/verify timeout - regression test for the real production
// incident (2026-08-14): a /settle call hung for 300s with nothing bounding
// it, until the CALLING side gave up and closed the connection, which
// Railway logged as a 499 and which surfaced upstream as an opaque 502. A
// deliberately absurd timeout (1ms) guarantees a REAL, valid settle call
// cannot possibly finish in time - no fault injection or mocked hang
// needed, since a real Stellar round-trip is always slower than 1ms.
const IMPATIENT_PORT = 4101;
const IMPATIENT_BASE_URL = `http://localhost:${IMPATIENT_PORT}`;
const impatientKp = Keypair.random();
await friendbotFund(impatientKp.publicKey());
const impatientProc = spawn(process.execPath, [join(ROOT, "index.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    FACILITATOR_STELLAR_SECRET: impatientKp.secret(),
    FACILITATOR_SETTLE_TIMEOUT_MS: "1",
    FACILITATOR_VERIFY_TIMEOUT_MS: "1",
    PORT: String(IMPATIENT_PORT),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
process.on("exit", () => { try { impatientProc.kill("SIGKILL"); } catch { /* already dead */ } });
if (!(await waitForHealthy(IMPATIENT_BASE_URL))) fail("impatient facilitator did not become healthy");

{
  const req = buildRequirements(sellerKp.publicKey(), "3000");
  const payload = await signPayment(payerSigner, req);

  const v = await post(IMPATIENT_BASE_URL, "/verify", { x402Version: 2, paymentPayload: payload, paymentRequirements: req });
  ok(v.status === 200, `timeout: /verify HTTP 200 even on timeout (got ${v.status})`);
  ok(v.body.isValid === false, "timeout: /verify isValid false");
  ok(v.body.invalidReason === "verify_timed_out", `timeout: /verify carries its own reason, not a generic one (got ${JSON.stringify(v.body)})`);

  const s = await post(IMPATIENT_BASE_URL, "/settle", { x402Version: 2, paymentPayload: payload, paymentRequirements: req });
  ok(s.status === 200, `timeout: /settle HTTP 200 even on timeout (got ${s.status})`);
  ok(s.body.success === false, "timeout: /settle success false");
  ok(s.body.transaction === "", "timeout: /settle transaction is the empty-string placeholder, never a guess");
  ok(s.body.errorReason === "settle_timed_out", `timeout: /settle carries its own reason, not a generic one (got ${JSON.stringify(s.body)})`);
  // The actual point of this whole test: without payer recovery,
  // src/stellar-confirm.js's settlePayerOf(res) would read undefined here
  // and its "ask the chain before believing a failure" check would never
  // fire for our own facilitator's errors - silently inert, not merely
  // untested.
  ok(s.body.payer === payerKp.publicKey(), `timeout: /settle recovers the real payer despite never getting a vendor result (got ${s.body.payer})`);
}

impatientProc.kill("SIGKILL");
console.log(`\n${passed} assertions passed.`);
