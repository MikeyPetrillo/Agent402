// Offline test for src/gateway-settle-breaker.js and its wiring into every
// LLM gateway handler.
//
// The hole: @x402/express settles AFTER the handler, so a payment that verifies
// and then fails to settle costs us the upstream call with nothing charged. The
// breaker refuses a wallet (429, for an EVM payer on the network its payment
// named only) BEFORE any upstream call once its settle failures pile up, and a
// >= 400 cancels settlement, so nobody pays for the refusal. Distinct buyers
// failing at once raise an alarm (the settleFailures word) and refuse nobody. Nothing here touches the network: every fetch is a stub, and
// the stub that must NOT be reached fails the run if it is.
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";

// Thresholds are set before the module loads (it reads env at import, like
// the composite guard). Short window so expiry is testable in-process.
process.env.GATEWAY_SETTLE_BREAKER_MAX = "3";
process.env.GATEWAY_SETTLE_BREAKER_WINDOW_MS = "900";
process.env.GATEWAY_SETTLE_BREAKER_GLOBAL_MAX = "6";
process.env.POSTHOG_TEST_CAPTURE = "1";
// A sales ledger of this run's own (THE SERVICE-WIDE BOUND reads whether a
// wallet has ever paid from it).
{
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "gwb-sales-"));
  process.env.SALES_LEDGER_DB = join(dir, "sales.db");
  process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
}
// With a REDIS_URL the breaker writes through to the shared store, whose
// windows and alarm flag outlive this process: a run keys them under its own
// prefix so no other run (or a concurrent one on the same Redis) reads them.
if (!process.env.SHARED_LIMITS_PREFIX) process.env.SHARED_LIMITS_PREFIX = `gwb-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

const b = await import("../src/gateway-settle-breaker.js");
const { LLM_GATEWAY_TOOLS } = await import("../src/tools/llm-gateway-kit.js");
const { LLM_MESSAGES_TOOLS } = await import("../src/tools/llm-messages-kit.js");
const { LLM_RESPONSES_TOOLS } = await import("../src/tools/llm-responses-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ADDR = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
// `network` names the payment's network the way the wire does: v2 under
// accepted.network (the default here), v1 at the top level.
const paymentHeader = (from, network = null, v1 = false) => Buffer.from(JSON.stringify({ ...(network && v1 ? { x402Version: 1, scheme: "exact", network } : {}), ...(network && !v1 ? { x402Version: 2, accepted: { scheme: "exact", network } } : {}), payload: { authorization: { from } } })).toString("base64");
function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res._headers = {};
  res.getHeader = (n) => res._headers[String(n).toLowerCase()];
  res.setHeader = (n, v) => { res._headers[String(n).toLowerCase()] = v; };
  return res;
}
// A settle receipt as the vendor writes it on a failed settle (the buyer-facing
// form: a code-shaped reason). `failWith` sets the final 402 and the receipt.
// `message` is the facilitator's own words (the guard below cuts them from
// what the buyer reads and keeps them on the request, as in the server).
const receiptOf = (errorReason, extra = {}) => Buffer.from(JSON.stringify({ success: false, errorReason, errorMessage: errorReason, transaction: "", ...extra })).toString("base64");
const failWith = (req, errorReason = "insufficient_funds", message = null, extra = {}) => { req.res.statusCode = 402; if (errorReason) req.res.setHeader("PAYMENT-RESPONSE", receiptOf(errorReason, { ...(message ? { errorMessage: message } : {}), ...extra })); req.res.emit("finish"); };
const { settleReceiptHeaderGuard } = await import("../src/facilitator-diagnostics.js");
function fakeReq({ from = null, tempo = null, ip = "203.0.113.7", withRes = true, network = null, v1 = false } = {}) {
  const hdr = from ? paymentHeader(from, network, v1) : null;
  const req = {
    header: (n) => (String(n).toLowerCase() === "payment-signature" ? hdr || undefined : undefined),
    headers: {}, ip,
  };
  if (tempo) req.mppTempoSender = tempo;
  if (withRes) { req.res = fakeRes(); req.method = "POST"; req.path = "/v1/chat"; settleReceiptHeaderGuard({ log: () => {} })(req, req.res, () => {}); }
  return req;
}

// --- key derivation: the composite guard's rule ------------------------------
ok(b.gatewaySettleBreakerKey(fakeReq({ from: ADDR })) === ADDR.toLowerCase(), "signed EVM payer is the key, lowercased");
ok(b.gatewaySettleBreakerKey(fakeReq({ tempo: "0xTempoPayer" })) === "tempo:0xTempoPayer", "a Tempo buyer keys on the sender recovered from its signed transaction");
ok(b.gatewaySettleBreakerKey(Object.assign(fakeReq(), { mppTempoPayer: "0xclientsupplied" })) === "ip:203.0.113.7", "the credential's client-supplied source hint is never a key (a caller could name a fresh one per request): the IP is");
ok(b.gatewaySettleBreakerKey(Object.assign(fakeReq(), { creditsKeyId: "ck_123" })) === "credits:ck_123", "a credits buyer keys on the credits key id, before the IP fallback");
ok(b.gatewaySettleBreakerKey(fakeReq()) === "ip:203.0.113.7", "otherwise the client IP - nobody is unkeyed");
ok(b.gatewaySettleBreakerKey(undefined) === null && b.gatewaySettleBreakerKey({}) === null, "no request (in-process caller) -> null key");

// --- per-key counting ----------------------------------------------------------
{
  await b._gatewaySettleBreakerReset();
  const K = "0xkey1";
  b.recordGatewaySettleFailure(K); b.recordGatewaySettleFailure(K);
  ok(!b.gatewaySettleBreakerBlocked(K).blocked, "two settle failures inside the window do not block");
  b.recordGatewaySettleFailure(K);
  const s = b.gatewaySettleBreakerBlocked(K);
  ok(s.blocked && s.fails === 3 && s.until > Date.now(), `the third blocks, with a lift time in the future (got ${JSON.stringify(s)})`);
  b.recordGatewaySettleSuccess(K);
  ok(b.gatewaySettleBreakerBlocked(K).blocked, "one settled call against three failures does not lift the block (3 of 4 outcomes failed)");
  b.recordGatewaySettleSuccess(K); b.recordGatewaySettleSuccess(K);
  ok(!b.gatewaySettleBreakerBlocked(K).blocked, "three settled calls do: failures are no longer more than half the outcomes");
  b.recordGatewaySettleFailure(null);
  ok(!b.gatewaySettleBreakerBlocked(null).blocked, "a null key is never blocked per key (it still counts globally)");
}

// --- the rate: a paying buyer's replays never cut it off ------------------------
{
  // A buyer settling hundreds of calls whose client re-sends requests: each
  // copy's authorization is already used, so it reverts fast, while the
  // originals settle slowly. Five such reverts in a row, with the window
  // holding two hundred settled calls, never refuse the buyer (2026-10-23).
  await b._gatewaySettleBreakerReset();
  const K = "0xbusybuyer";
  // Stamps sit inside the test's short window; order is what varies.
  const t0 = Date.now() - 200;
  for (let i = 0; i < 200; i++) b.recordGatewaySettleSuccess(K, t0 + i * 0.5);
  for (let i = 0; i < 5; i++) b.recordGatewaySettleFailure(K, t0 + 60 + i * 2);
  const s = b.gatewaySettleBreakerBlocked(K);
  ok(!s.blocked && s.fails === 5 && s.oks === 200, `five straight fast failures against two hundred settled calls do not block (got ${JSON.stringify(s)})`);
  // The same five, arriving BEFORE the successes of the same window, still do not.
  await b._gatewaySettleBreakerReset();
  for (let i = 0; i < 5; i++) b.recordGatewaySettleFailure(K, t0 + i * 0.5);
  for (let i = 0; i < 200; i++) b.recordGatewaySettleSuccess(K, t0 + 10 + i * 0.5);
  ok(!b.gatewaySettleBreakerBlocked(K).blocked, "order inside the window does not matter: fast failures before slow settlements still do not block");
  // A key whose payments mostly fail is still stopped: one settled, then five failures.
  await b._gatewaySettleBreakerReset();
  b.recordGatewaySettleSuccess(K, t0);
  for (let i = 0; i < 5; i++) b.recordGatewaySettleFailure(K, t0 + 10 + i * 2);
  const s2 = b.gatewaySettleBreakerBlocked(K);
  ok(s2.blocked && s2.fails === 5 && s2.oks === 1, `one settled call then five failures blocks (got ${JSON.stringify(s2)})`);
  // Alternating one settled, MAX_FAILS failed, repeated: a settled call no
  // longer erases the failures, so the pattern is refused.
  await b._gatewaySettleBreakerReset();
  for (let r = 0; r < 3; r++) { b.recordGatewaySettleSuccess(K, t0 + r * 20); for (let i = 0; i < 3; i++) b.recordGatewaySettleFailure(K, t0 + r * 20 + 5 + i * 2); }
  ok(b.gatewaySettleBreakerBlocked(K).blocked, "one settled call between every three failures does not keep a key served (9 of 12 outcomes failed)");
  // Exactly at the share is not over it: three failures, three settled.
  await b._gatewaySettleBreakerReset();
  for (let i = 0; i < 3; i++) { b.recordGatewaySettleFailure(K, t0 + i * 10); b.recordGatewaySettleSuccess(K, t0 + 5 + i * 10); }
  ok(!b.gatewaySettleBreakerBlocked(K).blocked, "failures must be MORE than the share: three against three is served");
  ok(b.gatewaySettleBreakerStatus().minFailShare === 0.5 && b.gatewaySettleBreakerStatus().hardMaxFails === 40, "the share and the hard ceiling are reported in the status (defaults 0.5 and 40)");
  // The ceiling: a key that settles plenty still cannot run up failures without
  // bound. 39 failures against 1000 settled calls pass the share; the 40th refuses.
  await b._gatewaySettleBreakerReset();
  for (let i = 0; i < 1000; i++) b.recordGatewaySettleSuccess(K, t0 + i * 0.1);
  for (let i = 0; i < 39; i++) b.recordGatewaySettleFailure(K, t0 + 100 + i * 0.5);
  ok(!b.gatewaySettleBreakerBlocked(K).blocked, "39 failures against a thousand settled calls: served (under the ceiling, under the share)");
  b.recordGatewaySettleFailure(K, t0 + 150);
  const s3 = b.gatewaySettleBreakerBlocked(K);
  ok(s3.blocked && s3.fails === 40 && s3.oks === 1000, `the 40th failure refuses the key whatever it settled (got ${JSON.stringify(s3)})`);
  // Shared replicas: the settled calls are written to and read from their own
  // shared window, and each count is the larger of the store's and this
  // process's, so a settled call on one replica weighs on every replica's verdict.
  const src = (await import("node:fs")).readFileSync(new URL("../src/gateway-settle-breaker.js", import.meta.url), "utf8");
  ok(/shared\.windowAdd\("gwb-ok", sharedKey\(key\)/.test(src) && /\{ name: "gwb-ok", key: sharedKey\(key\), windowMs: WINDOW_MS \}/.test(src) && /Math\.max\(o\.count, local\.oks\)/.test(src) && /Math\.max\(f\.count, local\.fails\)/.test(src), "settled calls ride a shared window (gwb-ok) and the shared verdict takes the larger of each count");
  ok(!/windowClear\("gwb-fail", sharedKey\(key\)\)\);\s*void sharedWrite\(CONTROL, shared\.windowClear\("gwb-bill"/.test(src.replace(/function sharedClearKey[\s\S]*?\n\}/, "")), "a settled call no longer clears the shared failure windows");
}

// --- the handler refuses BEFORE any upstream call ------------------------------
process.env.OPENROUTER_API_KEY = "test-key";
process.env.OPENAI_API_KEY = "test-key";
const realFetch = globalThis.fetch;
let fetchCalls = 0;
const okChat = (init) => {
  const body = JSON.parse(init.body);
  return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gen-1", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }), headers: { get: () => "application/json" } };
};
globalThis.fetch = async (url, init) => { fetchCalls++; return okChat(init); };
const nano = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-nano");
const chatBody = { model: "mistralai/ministral-8b-2512", messages: [{ role: "user", content: "hi" }], max_tokens: 5 };

{
  // CONTROL FIRST: with the breaker open the same stub IS reached. This is what
  // turns the refusal cases below into a mutation check - if the consult line
  // were removed from the handler, the tripped case would call fetch and fail.
  await b._gatewaySettleBreakerReset();
  fetchCalls = 0;
  const req = fakeReq({ from: ADDR });
  const out = await nano.handler(chatBody, req);
  ok(out?.choices?.[0]?.message?.content === "OK" && fetchCalls === 1, "control: an unblocked wallet is served and the stubbed upstream is reached exactly once");
  ok(req.__gatewaySettleBreakerArmed === true, "the consult armed the finish listener on req.res");
}
{
  // Below the threshold: two failures, still served.
  await b._gatewaySettleBreakerReset();
  const key = ADDR.toLowerCase();
  b.recordGatewaySettleFailure(key); b.recordGatewaySettleFailure(key);
  fetchCalls = 0;
  const out = await nano.handler(chatBody, fakeReq({ from: ADDR }));
  ok(out?.choices?.[0]?.message?.content === "OK" && fetchCalls === 1, "below the threshold the wallet is still served");
}
{
  // At the threshold: refused 429 before fetch. The stub here FAILS THE TEST if reached.
  await b._gatewaySettleBreakerReset();
  const key = ADDR.toLowerCase();
  for (let i = 0; i < 3; i++) b.recordGatewaySettleFailure(key);
  globalThis.fetch = async () => { ok(false, "upstream was called for a blocked wallet - the breaker did not fire before spend"); throw new Error("must not be called"); };
  let err = null;
  const req = fakeReq({ from: ADDR });
  try { await nano.handler(chatBody, req); } catch (e) { err = e; }
  ok(err?.statusCode === 429, `at the threshold the chat handler refuses 429 before any upstream call (got ${err?.statusCode})`);
  ok(/failed to settle/i.test(err?.message || "") && /retry/i.test(err?.message || "") && /Nothing was charged/.test(err?.message || ""), `the refusal explains itself (got: ${String(err?.message).slice(0, 120)})`);
  ok(String(req.res.getHeader("Retry-After") || "").match(/^\d+$/), "a Retry-After header rides the refusal");
  ok(req.__gatewaySettleBreakerArmed !== true, "a refused request arms no listener (nothing to record)");

  // Every other gateway wire refuses the same wallet the same way, before fetch.
  const others = [
    ["messages", LLM_MESSAGES_TOOLS.find((t) => t.slug === "v1-chat-nano-messages"), { model: "anthropic/claude-haiku-4.5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }],
    ["responses", LLM_RESPONSES_TOOLS.find((t) => t.slug === "v1-chat-nano-responses"), { model: "openai/gpt-5-nano", input: "hi", max_output_tokens: 5 }],
    ["embeddings", LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-embeddings"), { model: "text-embedding-3-small", input: "hi" }],
    ["rerank", LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-rerank"), { query: "q", documents: ["a", "b"] }],
    ["images", LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-images"), { prompt: "a cat" }],
    ["speech", LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-audio-speech"), { input: "hello", voice: "alloy" }],
    ["metered chat", LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat-metered"), { model: "anthropic/claude-haiku-4.5", messages: [{ role: "user", content: "hi" }], max_tokens: 5 }],
  ];
  for (const [name, tool, body] of others) {
    ok(!!tool, `${name} tool is registered`);
    if (!tool) continue;
    let e2 = null;
    try { await tool.handler(body, fakeReq({ from: ADDR })); } catch (e) { e2 = e; }
    ok(e2?.statusCode === 429 && /failed to settle/i.test(e2?.message || ""), `${name} handler refuses the blocked wallet 429 before any upstream call (got ${e2?.statusCode}: ${String(e2?.message).slice(0, 60)})`);
  }

  // A different wallet is unaffected by one wallet's block.
  globalThis.fetch = async (url, init) => { fetchCalls++; return okChat(init); };
  fetchCalls = 0;
  const out = await nano.handler(chatBody, fakeReq({ from: "0x1111111111111111111111111111111111111111" }));
  ok(out?.choices?.[0]?.message?.content === "OK" && fetchCalls === 1, "another wallet is served while the first is blocked");
}
{
  // Window expiry re-admits.
  await b._gatewaySettleBreakerReset();
  const key = ADDR.toLowerCase();
  for (let i = 0; i < 3; i++) b.recordGatewaySettleFailure(key);
  ok(b.gatewaySettleBreakerBlocked(key).blocked, "blocked right after the third failure");
  await sleep(950);
  ok(!b.gatewaySettleBreakerBlocked(key).blocked, "the block lifts once the failures age out of the window");
  fetchCalls = 0;
  const out = await nano.handler(chatBody, fakeReq({ from: ADDR }));
  ok(out?.choices?.[0]?.message?.content === "OK" && fetchCalls === 1, "and the wallet is served again");
}

// --- the burst alarm: counted and reported, never a refusal ---------------------
{
  await b._gatewaySettleBreakerReset();
  const word = async () => (await b.gatewaySettleFailuresStatus()).status;
  for (let i = 0; i < 5; i++) b.recordGatewaySettleFailure(`0xrotating${i}`);
  ok(!b.gatewaySettleBreakerGlobalAlarm().alarm && (await word()) === "ok", "five failures across five keys: below the threshold of six, the word reads ok");
  b.recordGatewaySettleFailure(null);
  ok(b.gatewaySettleBreakerGlobalAlarm().alarm && (await word()) === "burst", "the sixth (any key, even unkeyed) trips the alarm: settleFailures reads burst");
  // The next buyer is SERVED while the alarm reads burst: the stub is reached.
  globalThis.fetch = async (url, init) => { fetchCalls++; return okChat(init); };
  fetchCalls = 0;
  let err = null, out = null;
  const req = fakeReq({ from: "0x2222222222222222222222222222222222222222" });
  try { out = await nano.handler(chatBody, req); } catch (e) { err = e; }
  ok(err === null && out?.choices?.[0]?.message?.content === "OK" && fetchCalls === 1 && (await word()) === "burst", `a fresh wallet is served while the alarm reads burst (${err ? `${err.statusCode}: ${String(err.message).slice(0, 60)}` : "served"})`);
  ok(req.__gatewaySettleBreakerArmed === true, "and its outcome listener is armed like any served call's");
  let e3 = null; fetchCalls = 0;
  try { await nano.handler(chatBody); } catch (e) { e3 = e; }
  ok(e3 === null && fetchCalls === 1, "an in-process caller with no request is served during the alarm too");
  // The per-wallet rule is untouched by the alarm (the control beside the
  // served call): a wallet with its own three failures is still refused 429.
  for (let i = 0; i < 3; i++) b.recordGatewaySettleFailure(ADDR.toLowerCase(), Date.now(), { global: false });
  let e4 = null;
  try { await nano.handler(chatBody, fakeReq({ from: ADDR })); } catch (e) { e4 = e; }
  ok(e4?.statusCode === 429, `control: during the alarm a wallet's own failures still refuse it 429 (got ${e4?.statusCode})`);
  const st = b.gatewaySettleBreakerStatus();
  ok(st.globalAlarm === true && st.globalTrips === 1 && typeof st.globalAlarmUntil === "string" && !("globalPaused" in st), `status reports the alarm (got ${JSON.stringify(st)})`);
  ok(!/0x|203\.0\.113|tempo:/.test(JSON.stringify(st)), "status carries counts only - never a key, address or IP");
  const pub = await b.gatewaySettleFailuresStatus(), op = await b.gatewaySettleFailuresStatus({ full: true });
  ok(JSON.stringify(pub) === JSON.stringify({ status: "burst" }), `publicly the word only (${JSON.stringify(pub)})`);
  ok(op.status === "burst" && op.threshold === 6 && op.trips === 1 && typeof op.until === "string" && typeof op.buyersInWindow === "number" && !/0x|203\.0\.113/.test(JSON.stringify(op)), `the operator read adds the counts, never a key (${JSON.stringify(op)})`);
  await sleep(950);
  ok(!b.gatewaySettleBreakerGlobalAlarm().alarm && (await word()) === "ok", "the word returns to ok after the window");
  const src = (await import("node:fs")).readFileSync(new URL("../src/gateway-settle-breaker.js", import.meta.url), "utf8");
  ok(!/statusCode = 503/.test(src) && !/briefly paused/.test(src) && !/flag(Set|Get)\("gwb-pause"/.test(src), "the module holds no 503, no pause message and neither writes nor reads the earlier build's pause flag");
  const consult = src.slice(src.indexOf("export function gatewaySettleBreakerCheck"), src.indexOf("/** Counts only"));
  ok(!/gwb-alarm|GlobalAlarm/.test(consult) && /sharedWideUntil|wideBoundUntil/.test(consult), "the consult reads no alarm flag (the alarm is off the serving path); it reads the service-wide bound only");
}

// --- the finish listener reads the FINAL outcome -------------------------------
{
  await b._gatewaySettleBreakerReset();
  const key = ADDR.toLowerCase();
  // Three served requests whose FINAL status is 402 (the settlement-failure
  // rewrite) with a verdict on the buyer's payment: each one counts, the third blocks.
  for (let i = 0; i < 3; i++) {
    const req = fakeReq({ from: ADDR });
    await nano.handler(chatBody, req);
    failWith(req, "insufficient_funds");
  }
  ok(b.gatewaySettleBreakerBlocked(key).blocked, "three served-then-402 responses refused for the buyer's balance block the wallet");
  await b._gatewaySettleBreakerReset();
  // A 402 with no receipt names no verdict: it is not counted against the wallet.
  for (let i = 0; i < 3; i++) {
    const req = fakeReq({ from: ADDR });
    await nano.handler(chatBody, req);
    failWith(req, null);
  }
  ok(b.gatewaySettleBreakerBlocked(key).fails === 0 && b.gatewaySettleBreakerUnproven(key).fails === 3, "three served-then-402 responses with no receipt are unproven: off the wallet's count");
  await b._gatewaySettleBreakerReset();
  // A settle receipt saying success:false counts whatever the status says.
  {
    const req = fakeReq({ from: ADDR });
    await nano.handler(chatBody, req);
    req.res.statusCode = 200;
    req.res.setHeader("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: false, errorReason: "insufficient_funds" })).toString("base64"));
    req.res.emit("finish");
    ok(b.gatewaySettleBreakerBlocked(key).fails === 1, "a settle receipt with success:false counts as a failure");
  }
  // A settled 200 is recorded as an outcome beside the failure.
  {
    const req = fakeReq({ from: ADDR });
    await nano.handler(chatBody, req);
    req.res.statusCode = 200;
    req.res.emit("finish");
    const st = b.gatewaySettleBreakerBlocked(key);
    ok(st.fails === 1 && st.oks === 1 && !st.blocked, `a settled 200 counts as a settled outcome beside the failure (got ${JSON.stringify(st)})`);
  }
  // A FACILITATOR refusing on a billing quota of OURS. Only the one refusal
  // the offer gate WITHDRAWS (an Algorand sub-cent settle refused
  // subcent_quota_exceeded, gate installed and armed, the payTo paid paused,
  // and the route's next 402 really dropping that accept - so the loop is
  // closed) is kept off the wallet's count (2026-09-28: one buyer refused 325
  // calls for it, told their wallet was the problem), and even that still
  // feeds the /v1 burst alarm. Every other billing refusal has nothing
  // closing its loop, so it counts exactly as before - per wallet and
  // globally - and the 429 names it instead of the wallet. Driven on the exact
  // final shape the vendor writes: 402 + PAYMENT-RESPONSE {success:false,
  // errorReason}, on a request carrying an Algorand payment (keyed, like every
  // Algorand buyer, by client IP) whose route offer the patched build recorded.
  {
    const s = await import("../src/avm-sponsorship.js");
    const ALGO = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
    const PAYTO = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
    const SUB = { scheme: "exact", network: ALGO, asset: "31566704", amount: "1000", payTo: PAYTO, maxTimeoutSeconds: 300, extra: {} };
    const CENT = { ...SUB, amount: "10000" };
    const BASE = { scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000", payTo: "0xdead", extra: {} };
    const avmKey = "ip:203.0.113.7";
    const avmReq = (paid = SUB, offered = [BASE, paid]) => {
      const hdr = Buffer.from(JSON.stringify({ x402Version: 2, accepted: paid, payload: { paymentGroup: ["x"], paymentIndex: 0 } })).toString("base64");
      const req = { header: (n) => (String(n).toLowerCase() === "payment-signature" ? hdr : undefined), headers: {}, ip: "203.0.113.7", res: fakeRes() };
      s.rememberOfferedRequirements(req, offered);
      return req;
    };
    const receipt = (errorReason, extra = {}) => Buffer.from(JSON.stringify({ success: false, errorReason, errorMessage: errorReason, network: ALGO, transaction: "", ...extra })).toString("base64");
    const finishWith = async (errorReason, extra, { global = true, paid, offered } = {}) => {
      const req = avmReq(paid, offered);
      if (global) await nano.handler(chatBody, req);
      else b.armGatewaySettleBreaker(req, avmKey, { global: false }); // the wallet-only catalog consult
      req.res.statusCode = 402;
      req.res.setHeader("PAYMENT-RESPONSE", receipt(errorReason, extra));
      req.res.emit("finish");
    };
    const walletFails = () => b.gatewaySettleBreakerBlocked(avmKey).fails;
    const globalFails = () => b.gatewaySettleBreakerStatus().globalFailsInWindow;
    const nextCall = async () => { try { await nano.handler(chatBody, fakeReq()); return null; } catch (e) { return e; } };
    const pause = () => s.noteAvmSettleRefusal({ network: ALGO, payTo: PAYTO, reason: "subcent_quota_exceeded" });
    ok(b.gatewaySettleBreakerKey(avmReq()) === avmKey, "an Algorand buyer is keyed by client IP (its payload signs no EVM authorization)");

    // No gate on the resource server: a billing refusal on our account is
    // still not the wallet's, so it is unproven (off the wallet, in the alarm).
    s._resetAvmSponsorshipForTest({ logger: () => {}, installed: false });
    await b._gatewaySettleBreakerReset();
    pause();
    await finishWith("subcent_quota_exceeded");
    ok(walletFails() === 0 && globalFails() === 1 && b.gatewaySettleBreakerUnproven(avmKey).fails === 1, `with no offer gate installed a subcent_quota_exceeded refusal is unproven: off the wallet, in the burst alarm (wallet ${walletFails()}, global ${globalFails()})`);

    // Gate installed and the payTo paused: off the WALLET, still global.
    s._resetAvmSponsorshipForTest({ logger: () => {}, installed: true });
    await b._gatewaySettleBreakerReset();
    pause();
    for (let i = 0; i < 5; i++) await finishWith("subcent_quota_exceeded");
    ok(walletFails() === 0 && !b.gatewaySettleBreakerBlocked(avmKey).blocked, "five withdrawn subcent_quota_exceeded refusals leave the wallet uncounted and unblocked");
    ok(globalFails() === 5, `...and every one still feeds the /v1 burst alarm (got ${globalFails()})`);
    await finishWith("subcent_quota_exceeded", {}, { global: false });
    ok(walletFails() === 0 && globalFails() === 5, "on the catalog consult (global:false) it records nothing at all");
    const warned = [], warn0 = console.warn;
    console.warn = (...a) => { warned.push(a.join(" ")); };
    try { await finishWith("subcent_quota_exceeded"); } finally { console.warn = warn0; }
    ok(b.gatewaySettleBreakerGlobalAlarm().alarm, "the sixth trips the burst alarm (GLOBAL_MAX 6): requests already in flight are reported");
    const pauseLine = warned.find((l) => /settleFailures reads burst/.test(l)) || "";
    ok(/from 0 buyer\(s\), 6 withdrawn sub-cent refusal\(s\) inside/.test(pauseLine) && /no request is refused/.test(pauseLine) && !/different buyers/.test(pauseLine), `the alarm line says what it counted - withdrawn refusals, not six buyers (${pauseLine.slice(0, 90)})`);
    // The burst alarm counts distinct buyers; a withdrawn refusal is recorded
    // with no key, so each one still counts on its own - also in the real
    // arming order (the catalog consult first, then the /v1 handler's own,
    // which upgrades the listener) and from ONE buyer's requests.
    await b._gatewaySettleBreakerReset();
    pause();
    const finishUpgraded = async () => {
      const req = avmReq();
      b.armGatewaySettleBreaker(req, avmKey, { global: false });
      await nano.handler(chatBody, req);
      req.res.statusCode = 402;
      req.res.setHeader("PAYMENT-RESPONSE", receipt("subcent_quota_exceeded"));
      req.res.emit("finish");
    };
    for (let i = 0; i < 3; i++) await finishUpgraded();
    ok(walletFails() === 0 && globalFails() === 3, `one buyer's three withdrawn refusals, catalog consult first: off the wallet, and each still counts toward the /v1 burst alarm (wallet ${walletFails()}, global ${globalFails()})`);
    await b._gatewaySettleBreakerReset();
    b.recordGatewaySettleFailure(avmKey);
    await finishWith("subcent_quota_exceeded");
    ok(walletFails() === 1, "a withdrawn refusal does not CLEAR a real earlier failure either");

    // A payment verdict whose message merely names the allowance counts:
    // the reason is read, never the message. A reverted transfer
    // (transaction_failed) is not a verdict on the wallet (the settler's own
    // gas can revert it): unproven.
    await b._gatewaySettleBreakerReset();
    await finishWith("insufficient_funds", { errorMessage: "subcent_quota_exceeded" });
    await finishWith("transaction_failed", { errorMessage: "simulate failed: subcent_quota_exceeded" });
    ok(walletFails() === 1 && b.gatewaySettleBreakerUnproven(avmKey).fails === 1, `insufficient_funds naming subcent_quota_exceeded in its message counts against the wallet; transaction_failed does not (wallet ${walletFails()})`);

    // A route whose ONLY accept is the paused one, and AVM_SUBCENT_GATE=off:
    // nothing withdraws the offer, and the refusal is still on our account,
    // so the buyer is never refused for it: the call is served, and the run
    // raises the burst alarm instead (one key, at the refusing count).
    await b._gatewaySettleBreakerReset();
    for (let i = 0; i < 3; i++) await finishWith("subcent_quota_exceeded", {}, { offered: [SUB] });
    let err = await nextCall();
    ok(walletFails() === 0 && err === null, `an Algorand-only route: three billing refusals refuse nothing; the fourth call is served (got ${err?.statusCode || "served"})`);
    ok(b.gatewaySettleBreakerGlobalAlarm().alarm && b.gatewaySettleBreakerStatus().unprovenTrips === 1, "...and one key's run of unproven failures raises the burst alarm instead");
    s._resetAvmSponsorshipForTest({ logger: () => {}, installed: true });
    await b._gatewaySettleBreakerReset();
    s.noteSponsorshipStatus(PAYTO, { chain: "algorand", usedMonth: 1013, quota: 1000, suBalance: 0 });
    process.env.AVM_SUBCENT_GATE = "off";
    for (let i = 0; i < 3; i++) await finishWith("subcent_quota_exceeded");
    err = await nextCall();
    ok(walletFails() === 0 && err === null && b.gatewaySettleBreakerStatus().unprovenTrips === 1, `AVM_SUBCENT_GATE=off: three refusals refuse nothing and page instead (got ${err?.statusCode || "served"})`);
    delete process.env.AVM_SUBCENT_GATE;

    // Every other billing shape: off the wallet, in the alarm.
    await b._gatewaySettleBreakerReset();
    await finishWith("free_tier_exhausted", { network: "eip155:43114" });
    await finishWith("unexpected_settle_error", { network: "eip155:1329", errorMessage: "Facilitator settle failed (403): payment required: buy more credits" });
    ok(walletFails() === 0 && globalFails() === 1, `free_tier_exhausted and a credits wall named only in errorMessage are off the wallet and in the alarm (wallet ${walletFails()}; global ${globalFails()}: one buyer, counted once)`);

    // Control: a buyer-side reason on the same 402 shape counts, and three trip the 429 as before.
    await b._gatewaySettleBreakerReset();
    for (let i = 0; i < 3; i++) await finishWith("insufficient_funds");
    err = await nextCall();
    ok(err?.statusCode === 429 && /failed to settle/.test(err?.message || "") && /USDC balance/.test(err?.message || "") && !/billing/.test(err?.message || ""), `three genuine failures (insufficient_funds) trip the 429 exactly as before (got ${err?.statusCode})`);
    await b._gatewaySettleBreakerReset();
    s._resetAvmSponsorshipForTest({ logger: () => {}, installed: false });
  }
  // A handler-side 502 (never settled, not the wallet's doing) neither counts nor clears.
  {
    b.recordGatewaySettleFailure(key);
    const req = fakeReq({ from: ADDR });
    await nano.handler(chatBody, req);
    req.res.statusCode = 502;
    req.res.emit("finish");
    ok(b.gatewaySettleBreakerBlocked(key).fails === 1, "a 5xx the handler threw is neither a failure nor a success for the breaker");
  }
  // One listener per request; no res = nothing armed, no throw.
  {
    const req = fakeReq({ from: ADDR });
    ok(b.armGatewaySettleBreaker(req, key) === true && b.armGatewaySettleBreaker(req, key) === false, "a request is armed once");
    ok(b.armGatewaySettleBreaker(fakeReq({ withRes: false }), key) === false, "a request without a response object arms nothing and does not throw");
    ok(req.res.listenerCount("finish") === 1, "exactly one finish listener per request");
  }
}

// --- who a failed settle is counted against: one row per reason class -------
// Every reason that can reach the listener on a failed settle, with what it
// proves (src/settle-fault.js). A verdict on the buyer's payment counts at
// MAX (3); a failure of unknown cause counts at UNKNOWN_MAX (9) and is
// refused in words that blame no one; ours or a third party's never counts.
// Each row drives the real listener through the real receipt guard.
{
  const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", BASE = "eip155:8453", XLM = "stellar:pubnet", ALGO = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
  ok(b.UNKNOWN_MAX_FAILS === 9, `unknown failures refuse at three times the verdict count (${b.UNKNOWN_MAX_FAILS})`);
  const ROWS = [
    // [errorReason, facilitator's message, network, proves, fault]
    ["insufficient_funds", null, BASE, "buyer: balance", "buyer"],
    ["insufficient_balance", null, BASE, "buyer: balance (Gateway deposit)", "buyer"],
    ["invalid_exact_evm_insufficient_balance", null, BASE, "buyer: balance", "buyer"],
    ["invalid_exact_evm_payload_signature", null, BASE, "buyer: signature", "buyer"],
    ["invalid_exact_evm_payload_authorization_valid_before", null, BASE, "buyer: window closed", "buyer"],
    ["invalid_payload", null, BASE, "buyer: payload", "buyer"],
    ["nonce_already_used", null, BASE, "buyer: authorization used", "buyer"],
    ["duplicate_authorization", null, BASE, "buyer: same authorization resent", "buyer"],
    ["transaction_served_elsewhere", null, BASE, "buyer: same transfer resent", "buyer"],
    // The chain's own words that the wallet came up short, per rail (the shapes in our logs and tests).
    ["invalid_exact_evm_transaction_failed", "execution reverted: ERC20: transfer amount exceeds balance", BASE, "buyer: EVM token revert, balance", "buyer"],
    ["invalid_exact_evm_transaction_failed", "execution reverted: ERC20InsufficientBalance(0x0, 10, 5000)", BASE, "buyer: EVM token revert, balance (OZ v5)", "buyer"],
    ["transaction_simulation_failed", "transaction_simulation_failed: InstructionError:[2 map[Custom:1]]", SOL, "buyer: SPL token insufficient funds", "buyer"],
    ["transaction_simulation_failed", "InstructionError:[2 InvalidAccountData]", SOL, "buyer: no USDC token account", "buyer"],
    ["invalid_exact_stellar_payload_simulation_failed", "HostError: Error(Contract, #10) balance is not sufficient to spend", XLM, "buyer: Stellar asset balance", "buyer"],
    ["transaction_failed", "op_underfunded", XLM, "buyer: Stellar payment underfunded", "buyer"],
    ["invalid_exact_avm_simulation_failed", "transaction X: underflow on subtracting 5000 from sender amount 100", ALGO, "buyer: Algorand asset underflow", "buyer"],
    // The same families without a balance proof: unknown.
    ["invalid_exact_evm_transaction_failed", "execution reverted", BASE, "unknown: revert, no balance named (the settler's gas can cause it)", "unknown"],
    ["invalid_exact_evm_transaction_failed", "insufficient funds for gas * price + value", BASE, "unknown: the settler's own gas", "unknown"],
    ["transaction_simulation_failed", "InstructionError:[2 map[Custom:1]]", BASE, "unknown: a Solana error shape on an EVM network", "unknown"],
    ["transaction_simulation_failed", "InstructionError:[0 map[Custom:1]]", SOL, "unknown: not the transfer instruction", "unknown"],
    ["invalid_exact_avm_simulation_failed", "overspend (account FEEPAYER, data {...})", ALGO, "unknown: ALGO overspend may be the fee payer's", "unknown"],
    ["transaction_failed", null, BASE, "unknown: revert", "unknown"],
    ["invalid_exact_stellar_payload_simulation_failed", "fee payer balance is not sufficient for the fee", XLM, "unknown: the settler's fee payer, not the buyer", "unknown"],
    ["settlement_failed", null, BASE, "unknown: no words at all", "unknown"],
    ["settlement_pending", null, BASE, "unknown: still settling", "unknown"],
    ["wallet_blocked", null, BASE, "buyer: our blocklist's verdict on the paying wallet", "buyer"],
    // Ours or a third party's, proven: never counted.
    ["settlement_failed", "fetch failed [ECONNRESET syscall=read]", BASE, "ours: connection reset", "not-buyer"],
    ["settlement_failed", "Facilitator settle failed (503): upstream unavailable", BASE, "facilitator: HTTP 503", "not-buyer"],
    ["settlement_failed", "Facilitator settle failed (401): unauthorized", BASE, "ours: our credentials", "not-buyer"],
    ["settlement_failed", 'Facilitator settle failed (400): {"error":"request timeout while waiting for receipt; nonce used"}', BASE, "unknown: a definite 400 whose body holds transport words", "unknown"],
    ["settlement_failed", "Facilitator settle failed (409): aborted, fetch failed", BASE, "unknown: a definite 409 whose body holds transport words", "unknown"],
    ["settlement_failed", "Facilitator settle failed (408): request timeout", BASE, "facilitator: HTTP 408", "not-buyer"],
    ["wallet_check_failed", null, BASE, "ours: blocklist store unreadable", "not-buyer"],
    ["contract_wallet_check_failed", null, BASE, "ours: contract-wallet gate could not run", "not-buyer"],
    ["settle_mark_failed", null, BASE, "ours: settle-sent mark store failed", "not-buyer"],
    ["before_settle_hook_error", null, BASE, "ours: a settle hook threw", "not-buyer"],
    ["contract_signature_unverifiable", null, BASE, "ours: on-chain signature check did not finish", "not-buyer"],
    ["timeout", null, BASE, "ours: our time limit", "not-buyer"],
    ["network_error", null, BASE, "ours: connection or DNS", "not-buyer"],
    ["circle_http_503", null, BASE, "facilitator: HTTP 503", "not-buyer"],
    ["gateway_http_502", null, BASE, "facilitator: HTTP 502", "not-buyer"],
    ["circle_http_429", null, BASE, "facilitator: HTTP 429", "not-buyer"],
    ["gateway_http_401", null, BASE, "ours: our credentials at the facilitator", "not-buyer"],
    ["gateway_http_400", null, BASE, "unknown: a bare 400 may be a verdict the body did not name", "unknown"],
    ["circle_http_409", null, BASE, "unknown: a bare 409 may be a verdict the body did not name", "unknown"],
    ["non_json_response", null, BASE, "facilitator: unreadable answer", "not-buyer"],
    ["free_tier_exhausted", null, BASE, "facilitator billing on our account", "not-buyer"],
    ["insufficient_credits", null, BASE, "facilitator billing on our account", "not-buyer"],
    ["own_relayer_refused", null, BASE, "ours: our relayer", "not-buyer"],
    ["relayer_error", null, BASE, "ours: our relayer", "not-buyer"],
    ["invalid_network", null, BASE, "ours: requirements", "not-buyer"],
    ["invalid_payment_requirements", null, BASE, "ours: requirements", "not-buyer"],
    ["client_disconnected", null, BASE, "buyer left (forgiven, never sent)", "not-buyer"],
  ];
  const W = "0x" + "c".repeat(40);
  const runRow = async (reason, message, net, n) => {
    let refusedEarly = 0;
    for (let i = 0; i < n; i++) {
      const req = fakeReq({ from: W, network: net });
      try { await b.gatewaySettleBreakerCheck(req); } catch { refusedEarly++; continue; }
      failWith(req, reason, message, { network: net });
    }
    let err = null;
    try { await b.gatewaySettleBreakerCheck(fakeReq({ from: W, network: net })); } catch (e) { err = e; }
    return { err, refusedEarly };
  };
  for (const [reason, message, net, proves, fault] of ROWS) {
    const label = `${reason}${message ? ` "${message.slice(0, 40)}"` : ""} on ${net.split(":")[0]} (${proves})`;
    // The count key as the consult derives it: payer@network for a signed
    // EVM payer, the client address for a rail whose payload signs none.
    const k = b.gatewaySettleBreakerCountKey(fakeReq({ from: W, network: net }));
    await b._gatewaySettleBreakerReset();
    if (fault === "buyer" && reason === "wallet_blocked") {
      // Our blocklist's verdict: refused at the verdict count, in words that
      // claim no balance or signature problem and name no reason beyond the
      // receipt's own code.
      const { err } = await runRow(reason, message, net, 3);
      ok(err?.statusCode === 429 && b.gatewaySettleBreakerBlocked(k).fails === 3 && b.gatewaySettleBreakerBlocked(k).blocklisted === true && /settlement did not proceed for this wallet/.test(err.message) && !/balance|signature|authorization|refused the payment itself|terms|block/i.test(err.message) && /Nothing was charged for this request/.test(err.message), `${label}: three refuse the wallet in neutral words (${err?.statusCode}: ${String(err?.message).slice(0, 120)})`);
    } else if (fault === "buyer") {
      const { err } = await runRow(reason, message, net, 3);
      ok(err?.statusCode === 429 && b.gatewaySettleBreakerBlocked(k).fails === 3 && /refused the payment itself/.test(err.message) && /check the wallet's (?:USDC )?balance/i.test(err.message), `${label}: a verdict, three refuse the wallet with the verdict words (${err?.statusCode})`);
    } else if (fault === "unknown") {
      const r8 = await runRow(reason, message, net, 8);
      ok(r8.err === null && r8.refusedEarly === 0 && b.gatewaySettleBreakerBlocked(k).fails === 0 && b.gatewaySettleBreakerBlocked(k).unknownFails === 8, `${label}: unknown, eight are served (${r8.err ? r8.err.statusCode : "served"})`);
      await b._gatewaySettleBreakerReset();
      const { err } = await runRow(reason, message, net, 9);
      ok(err?.statusCode === 429 && /did not complete/.test(err.message) && !/balance|signature|refused the payment|failed to settle/.test(err.message) && /Nothing was charged for this request/.test(err.message), `${label}: unknown, nine refuse the wallet in words that blame no one (${err?.statusCode}: ${String(err?.message).slice(0, 90)})`);
    } else {
      const { err, refusedEarly } = await runRow(reason, message, net, 12);
      ok(err === null && refusedEarly === 0 && b.gatewaySettleBreakerBlocked(k).fails === 0 && b.gatewaySettleBreakerBlocked(k).unknownFails === 0, `${label}: ours or a third party's, twelve refuse nothing (${err ? `${err.statusCode} ${err.message.slice(0, 60)}` : "served"})`);
      ok(b.gatewaySettleBreakerStatus().unprovenTrips === 1 && (await b.gatewaySettleFailuresStatus()).status === "burst", `${label}: the run raises the burst alarm instead`);
    }
  }
  // circle_http_NNN / gateway_http_NNN (a status whose body named no
  // reason): only 5xx, 401, 403, 408 and 429 prove the fault is not the
  // buyer's; any other 4xx reads unknown.
  {
    const { settleFailureFault } = await import("../src/settle-fault.js");
    const wrong = [];
    for (const prefix of ["circle", "gateway"]) {
      for (const st of [400, 402, 404, 409, 410, 422]) if (settleFailureFault({ receipt: { errorReason: `${prefix}_http_${st}`, network: BASE } }) !== "unknown") wrong.push(`${prefix}_${st}`);
      for (const st of [401, 403, 408, 429, 500, 502, 503, 504]) if (settleFailureFault({ receipt: { errorReason: `${prefix}_http_${st}`, network: BASE } }) !== "not-buyer") wrong.push(`${prefix}_${st}`);
      for (const st of [400, 409, 422]) if (settleFailureFault({ receipt: { errorReason: "settlement_failed", network: BASE }, raw: { errorReason: `${prefix}_http_${st}` } }) !== "unknown") wrong.push(`raw ${prefix}_${st}`);
      for (const st of [401, 503]) if (settleFailureFault({ receipt: { errorReason: "settlement_failed", network: BASE }, raw: { errorReason: `${prefix}_http_${st}` } }) !== "not-buyer") wrong.push(`raw ${prefix}_${st}`);
    }
    ok(wrong.length === 0, `facilitator HTTP codes: 400/402/404/409/410/422 unknown, 401/403/408/429/5xx not-buyer, on both prefixes (${wrong.join(", ")})`);
  }
  // A wallet whose counted verdicts include our blocklist's, beside balance
  // verdicts, gets the neutral words too: the refusal never tells a story
  // one of its strikes does not.
  await b._gatewaySettleBreakerReset();
  {
    for (const r of ["insufficient_funds", "wallet_blocked", "insufficient_funds"]) { const req = fakeReq({ from: W, network: BASE }); await b.gatewaySettleBreakerCheck(req); failWith(req, r, null, { network: BASE }); }
    let err = null;
    try { await b.gatewaySettleBreakerCheck(fakeReq({ from: W, network: BASE })); } catch (e) { err = e; }
    ok(err?.statusCode === 429 && /settlement did not proceed for this wallet/.test(err.message) && !/balance|signature/i.test(err.message), `strikes that include wallet_blocked: neutral refusal words (${String(err?.message).slice(0, 100)})`);
    await b._gatewaySettleBreakerReset();
    for (let i = 0; i < 3; i++) { const req = fakeReq({ from: W, network: BASE }); await b.gatewaySettleBreakerCheck(req); failWith(req, "insufficient_funds", null, { network: BASE }); }
    err = null;
    try { await b.gatewaySettleBreakerCheck(fakeReq({ from: W, network: BASE })); } catch (e) { err = e; }
    ok(err?.statusCode === 429 && /refused the payment itself/.test(err.message) && b.gatewaySettleBreakerBlocked(b.gatewaySettleBreakerCountKey(fakeReq({ from: W, network: BASE }))).blocklisted === false, "control: balance verdicts alone keep the verdict words");
  }
  // The unknown count keeps the share rule: a wallet settling most of its
  // calls is not refused for nine unknown failures beside them.
  await b._gatewaySettleBreakerReset();
  for (let i = 0; i < 20; i++) b.recordGatewaySettleSuccess(`${W}@${BASE}`);
  const busy = await runRow("transaction_failed", null, BASE, 9);
  ok(busy.err === null, `nine unknown failures beside twenty settled calls refuse nothing (${busy.err?.statusCode || "served"})`);
  // The Tempo gate carries no x402 receipt: its own fault mark decides, and no mark is unknown.
  const { SETTLE_FAULT } = await import("../src/settle-fault.js");
  for (const [mark, n, refused] of [["buyer", 3, true], ["not-buyer", 12, false], [undefined, 8, false], [undefined, 9, true], ["unknown", 9, true]]) {
    await b._gatewaySettleBreakerReset();
    for (let i = 0; i < n; i++) { const req = fakeReq({ tempo: "0xtempopayer" }); await b.gatewaySettleBreakerCheck(req); if (mark !== undefined) req[SETTLE_FAULT] = mark; failWith(req, null); }
    let err = null;
    try { await b.gatewaySettleBreakerCheck(fakeReq({ tempo: "0xtempopayer" })); } catch (e) { err = e; }
    ok(refused ? err?.statusCode === 429 : err === null, `Tempo 402 marked ${mark}, ${n} of them: ${refused ? "refused" : "served"} (${err?.statusCode || "served"})`);
  }
  await b._gatewaySettleBreakerReset();
}

// --- our store failing never refuses a funded wallet ----------------------------
// While the shared store or Redis is down, every settle of a served call fails
// on our side (the blocklist read: wallet_check_failed; the settle-sent mark:
// settle_mark_failed; a hook throwing: before_settle_hook_error). Fifty such
// failures inside the window, from a wallet with settled calls and from a
// brand-new one, refuse neither: the next call reaches the upstream.
{
  await b._gatewaySettleBreakerReset();
  const FUNDED = "0x" + "d".repeat(40), NEW = "0x" + "e".repeat(40);
  for (let i = 0; i < 3; i++) b.recordGatewaySettleSuccess(FUNDED.toLowerCase());
  const OURS = [["wallet_check_failed"], ["settle_mark_failed"], ["before_settle_hook_error"], ["timeout"], ["settlement_failed", "fetch failed [ETIMEDOUT]"], ["settlement_failed", "Facilitator settle failed (502): bad gateway"]];
  let refusedDuring = 0;
  for (let i = 0; i < 50; i++) {
    for (const who of [FUNDED, NEW]) {
      const req = fakeReq({ from: who });
      try { await b.gatewaySettleBreakerCheck(req); } catch { refusedDuring++; continue; }
      failWith(req, ...OURS[i % OURS.length]);
    }
  }
  ok(refusedDuring === 0, `no call of the hundred is refused while our side fails (refused ${refusedDuring})`);
  globalThis.fetch = async (url, init) => { fetchCalls++; return okChat(init); };
  fetchCalls = 0;
  let e1 = null, e2 = null;
  try { await nano.handler(chatBody, fakeReq({ from: FUNDED })); } catch (e) { e1 = e; }
  try { await nano.handler(chatBody, fakeReq({ from: NEW })); } catch (e) { e2 = e; }
  ok(e1 === null && e2 === null && fetchCalls === 2, `fifty store-failure settles each refuse neither a funded wallet nor a new one: both reach the upstream (${e1?.statusCode || "served"}, ${e2?.statusCode || "served"}, upstream ${fetchCalls})`);
  ok(b.gatewaySettleBreakerStatus().unprovenTrips === 2 && (await b.gatewaySettleFailuresStatus()).status === "burst", "...and the run is paged on: the burst alarm, once per key");
  // Control beside it: three verdicts on the same funded wallet's balance do refuse it.
  for (let i = 0; i < 6; i++) { const req = fakeReq({ from: FUNDED }); try { await b.gatewaySettleBreakerCheck(req); } catch { /* refused */ } if (req.__gatewaySettleBreakerArmed) failWith(req, "insufficient_funds"); }
  let e3 = null;
  try { await nano.handler(chatBody, fakeReq({ from: FUNDED })); } catch (e) { e3 = e; }
  ok(e3?.statusCode === 429, `control: balance verdicts on the same wallet still refuse it (${e3?.statusCode})`);
  await b._gatewaySettleBreakerReset();
}

globalThis.fetch = realFetch;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;

// --- source pins ---------------------------------------------------------------
// The runtime checks above prove the wiring for the handlers they drive; these
// pin the PLACEMENT (first statement, before validation and any fetch) and the
// invariant the finish listener rests on: no gateway handler throws a 402 of
// its own, so a post-arm 402 is always a settlement that failed.
{
  const kit = await readFile(new URL("../src/tools/llm-gateway-kit.js", import.meta.url), "utf8");
  const msg = await readFile(new URL("../src/tools/llm-messages-kit.js", import.meta.url), "utf8");
  const rsp = await readFile(new URL("../src/tools/llm-responses-kit.js", import.meta.url), "utf8");
  const firstStatementIs = (src, sigRe) => {
    const m = src.match(sigRe);
    if (!m) return false;
    const after = src.slice(m.index + m[0].length).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
    return after[0] === "await gatewaySettleBreakerCheck(req);";
  };
  ok(firstStatementIs(kit, /function makeHandler\((?:tierSlug|routeTier)\) \{\n\s*return async \(input, req\) => \{/), "chat tiers: the consult is the handler's first statement");
  ok(firstStatementIs(kit, /async function embeddingsHandler\(input, req\) \{/), "embeddings: consult first");
  ok(firstStatementIs(kit, /async function rerankHandler\(input, req\) \{/), "rerank: consult first");
  ok(firstStatementIs(kit, /async function imagesHandler\(input, req\) \{/), "images: consult first");
  ok(firstStatementIs(kit, /async function speechHandler\(input, req\) \{/), "speech: consult first (the handler now takes the request the binder already passes)");
  ok(firstStatementIs(msg, /return async function messagesHandler\(input, req\) \{/), "Messages wire: consult first");
  ok(firstStatementIs(rsp, /return async function responsesHandler\(input, req\) \{/), "Responses wire: consult first");
  const throws402 = (src) => /bad\([^;]*,\s*402\s*\)/.test(src) || /statusCode\s*=\s*402\b/.test(src);
  ok(!throws402(kit) && !throws402(msg) && !throws402(rsp), "no gateway kit throws a 402 of its own - a post-arm 402 is a settlement failure, which the finish listener relies on");
}

// --- the listener's scope: a later global consult upgrades, never downgrades ----
// (The HTTP twin, through a booted paid server's /v1 route, is in
// scripts/test-paid-settle-breaker.js.) The dispatcher arms with global:false
// for every wallet-only slug, and every /v1 slug is one, so the /v1 handler's
// own global:true consult arrives SECOND on the same request.
{
  await b._gatewaySettleBreakerReset();
  const failOnce = (consults) => {
    const req = fakeReq({ from: ADDR });
    for (const g of consults) b.armGatewaySettleBreaker(req, "0xscope", { global: g });
    failWith(req);
  };
  failOnce([false]);
  ok(b.gatewaySettleBreakerStatus().globalFailsInWindow === 0, "a catalog-only consult (global:false) feeds nothing global");
  failOnce([false, true]);
  ok(b.gatewaySettleBreakerStatus().globalFailsInWindow === 1, "catalog consult first, /v1 consult second: the failure reaches the global count");
  ok(b.gatewaySettleBreakerBlocked("0xscope").fails === 2, "one listener per request: two requests, two wallet failures, none double-counted");
  await b._gatewaySettleBreakerReset();
  const req = fakeReq({ from: ADDR });
  b.armGatewaySettleBreaker(req, "0xscope2", { global: true });
  b.armGatewaySettleBreaker(req, "0xscope2", { global: false });
  failWith(req);
  ok(b.gatewaySettleBreakerStatus().globalFailsInWindow === 1, "a later global:false consult never downgrades an armed global listener");
  await b._gatewaySettleBreakerReset();
}

// --- the burst alarm counts BUYERS, not failures --------------------------------
// The per-key check runs before any of a burst's failures lands, so one wallet
// firing concurrent calls could otherwise supply the whole global count alone
// (one buyer is the per-key rule's job). (The HTTP twin, a real concurrent burst through a
// booted paid server, is in scripts/test-paid-settle-breaker.js.)
{
  await b._gatewaySettleBreakerReset();
  for (let i = 0; i < 20; i++) b.recordGatewaySettleFailure("0xoneburstwallet");
  const st = b.gatewaySettleBreakerStatus();
  ok(!st.globalAlarm && st.globalFailsInWindow === 1, `twenty failures from ONE buyer count once toward the burst alarm and never trip it (distinct ${st.globalFailsInWindow}, GLOBAL_MAX 6)`);
  ok(b.gatewaySettleBreakerBlocked("0xoneburstwallet").blocked, "...that buyer is the per-key bound's job, and it is blocked");
  for (let i = 1; i <= 4; i++) b.recordGatewaySettleFailure(`0xotherbuyer${i}`);
  ok(!b.gatewaySettleBreakerGlobalAlarm().alarm && b.gatewaySettleBreakerStatus().globalFailsInWindow === 5, "five different buyers: still below the threshold of six");
  b.recordGatewaySettleFailure("0xotherbuyer5");
  ok(b.gatewaySettleBreakerGlobalAlarm().alarm, "the sixth DIFFERENT buyer trips the alarm (many buyers failing at once is what it reports)");
  await b._gatewaySettleBreakerReset();
  b.recordGatewaySettleFailure(null); b.recordGatewaySettleFailure(null);
  ok(b.gatewaySettleBreakerStatus().globalFailsInWindow === 2, "a failure with no key to count it under counts as its own buyer (never merged into one)");
  await b._gatewaySettleBreakerReset();
}

// A Circle Gateway batched payment Gateway is still settling: the buyer was
// told to resend the SAME payment (src/gateway-wire.js), so the pending
// answer is never counted against the wallet, three in a row block nothing,
// and it still counts once toward the /v1 burst alarm as that buyer. The
// control: Gateway refusing the same wallet's payment (insufficient_balance)
// counts exactly as before.
{
  await b._gatewaySettleBreakerReset();
  const key = ADDR.toLowerCase();
  const pendingReceipt = Buffer.from(JSON.stringify({ success: false, errorReason: "settlement_pending", transaction: "", network: "eip155:8453" })).toString("base64");
  // The paywall reads the batched kind from the payment header's accepted.extra.name.
  const batchedHdr = Buffer.from(JSON.stringify({ accepted: { scheme: "exact", network: "eip155:8453", extra: { name: "GatewayWalletBatched" } }, payload: { authorization: { from: ADDR } } })).toString("base64");
  const batchedReq = () => Object.assign(fakeReq({ from: ADDR }), { header: (n) => (String(n).toLowerCase() === "payment-signature" ? batchedHdr : undefined) });
  for (let i = 0; i < 3; i++) {
    const req = batchedReq();
    b.armGatewaySettleBreaker(req, key);
    req.res.statusCode = 402;
    req.res.setHeader("PAYMENT-RESPONSE", pendingReceipt);
    req.res.emit("finish");
  }
  const st = b.gatewaySettleBreakerBlocked(key);
  ok(st.fails === 0 && !st.blocked, `three settlement_pending answers count nothing against the wallet (got ${JSON.stringify(st)})`);
  ok(b.gatewaySettleBreakerStatus().globalFailsInWindow === 1, "...and count once toward the /v1 burst alarm, as that one buyer");
  // The same word on a PLAIN payment (Circle's Arc facilitator) is no
  // verdict on the wallet either: unproven, off the wallet's count.
  const plainReq = fakeReq({ from: ADDR });
  b.armGatewaySettleBreaker(plainReq, key);
  plainReq.res.statusCode = 402;
  plainReq.res.setHeader("PAYMENT-RESPONSE", pendingReceipt);
  plainReq.res.emit("finish");
  ok(b.gatewaySettleBreakerBlocked(key).fails === 0 && b.gatewaySettleBreakerUnproven(key).fails === 1, "settlement_pending on a plain payment is unproven: off the wallet's count");
  await b._gatewaySettleBreakerReset();
  const req = batchedReq();
  b.armGatewaySettleBreaker(req, key);
  req.res.statusCode = 402;
  req.res.setHeader("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: false, errorReason: "insufficient_balance", transaction: "", network: "eip155:8453" })).toString("base64"));
  req.res.emit("finish");
  ok(b.gatewaySettleBreakerBlocked(key).fails === 1, "control: Gateway refusing the same wallet (insufficient_balance) still counts against it");
  await b._gatewaySettleBreakerReset();
  // From a wallet-only consult (global:false) a pending answer feeds nothing:
  // not the wallet, and not the /v1 burst alarm it takes no part in.
  const wo = batchedReq();
  b.armGatewaySettleBreaker(wo, key, { global: false });
  wo.res.statusCode = 402;
  wo.res.setHeader("PAYMENT-RESPONSE", pendingReceipt);
  wo.res.emit("finish");
  ok(b.gatewaySettleBreakerStatus().globalFailsInWindow === 0 && b.gatewaySettleBreakerBlocked(key).fails === 0, "a wallet-only consult's pending answer counts toward neither the wallet nor the burst alarm");
  await b._gatewaySettleBreakerReset();
}

// The lift time with more failures than the threshold: when the
// (len - MAX + 1)th newest failure ages out, not the oldest.
{
  await b._gatewaySettleBreakerReset();
  const key = "ip:198.51.100.77";
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) b.recordGatewaySettleFailure(key, t0 + i * 10, { global: false });
  const st = b.gatewaySettleBreakerBlocked(key, t0 + 50);
  ok(st.blocked && st.until === t0 + 20 + 900, `five failures, threshold three: lifts when the third newest ages out (until ${st.until - t0} ms after the first)`);
  await b._gatewaySettleBreakerReset();
}

// --- per network: a wallet refused on one network is served on another ---------
// An EVM payer's count key is payer@network. Network X's failures refuse a
// payment that names X and nothing else; the same wallet naming Y is served
// in the same instant (the control and the refusal run back to back, one
// stub, one clock).
{
  await b._gatewaySettleBreakerReset();
  const X = "eip155:8453", Y = "eip155:137", P = ADDR.toLowerCase();
  ok(b.gatewaySettleBreakerNetwork(fakeReq({ from: ADDR, network: X })) === X && b.gatewaySettleBreakerNetwork(fakeReq({ from: ADDR, network: X, v1: true })) === X, "the network is read from the payment header: v2 accepted.network and v1 network");
  ok(b.gatewaySettleBreakerNetwork(fakeReq({ from: ADDR })) === null && b.gatewaySettleBreakerNetwork(fakeReq({ from: ADDR, network: "not a network" })) === null, "a header naming no network, or one that is not a CAIP-2 id, reads as none");
  ok(b.gatewaySettleBreakerCountKey(fakeReq({ from: ADDR, network: X })) === `${P}@${X}` && b.gatewaySettleBreakerCountKey(fakeReq({ from: ADDR, network: Y, v1: true })) === `${P}@${Y}`, "an EVM payer is counted per network: payer@network");
  ok(b.gatewaySettleBreakerKey(fakeReq({ from: ADDR, network: X })) === P, "the buyer (what the burst alarm counts) stays the payer alone");
  ok(b.gatewaySettleBreakerCountKey(fakeReq({ from: ADDR })) === P, "an EVM payment naming no network keeps the payer-only key");
  ok(b.gatewaySettleBreakerCountKey(Object.assign(fakeReq({ network: X }), { mppTempoSender: "0xtempo" })) === "tempo:0xtempo"
    && b.gatewaySettleBreakerCountKey(Object.assign(fakeReq(), { creditsKeyId: "ck_1" })) === "credits:ck_1"
    && b.gatewaySettleBreakerCountKey(fakeReq()) === "ip:203.0.113.7", "a Tempo sender, a credits key and the IP fallback keep one key (no network to split on)");

  // Three settle failures on X, each through the real listener of a request that named X.
  for (let i = 0; i < 3; i++) {
    const req = fakeReq({ from: ADDR, network: X });
    await b.gatewaySettleBreakerCheck(req, { global: false });
    failWith(req); req.res.emit("close");
  }
  ok(b.gatewaySettleBreakerBlocked(`${P}@${X}`).blocked && b.gatewaySettleBreakerBlocked(`${P}@${Y}`).fails === 0 && b.gatewaySettleBreakerBlocked(P).fails === 0, "three failed settles on X are counted under payer@X only");
  const keyWas = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  globalThis.fetch = async (url, init) => { fetchCalls++; return okChat(init); };
  fetchCalls = 0;
  let errX = null, outY = null, errY = null;
  const reqX = fakeReq({ from: ADDR, network: X }), reqY = fakeReq({ from: ADDR, network: Y });
  try { await nano.handler(chatBody, reqX); } catch (e) { errX = e; }
  try { outY = await nano.handler(chatBody, reqY); } catch (e) { errY = e; }
  ok(errX?.statusCode === 429 && fetchCalls === 1 && errY === null && outY?.choices?.[0]?.message?.content === "OK", `the wallet is refused on X (429 before any upstream call) and served on Y in the same instant (X ${errX?.statusCode}, Y ${errY ? `${errY.statusCode} ${String(errY.message).slice(0, 160)}` : "served"}, upstream calls ${fetchCalls})`);
  globalThis.fetch = realFetch;
  if (keyWas === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = keyWas;
  const m = String(errX?.message || "");
  ok(m.includes(`from this wallet on ${X} failed to settle`) && m.includes(`refuse new calls from it on ${X} until `) && /That holds eip155:8453 only: this wallet can pay on any other network this route offers right now \(the networks are accepts\[\]\.network in the route's 402\)\./.test(m) && /Nothing was charged for this request\./.test(m) && m.includes(`Before paying on ${X} again, check the wallet's balance of the payment token there and sign a new authorization.`) && /refused the payment itself, for its balance, its signature, or an authorization already used or expired/.test(m), `the 429 names X, says another network works now, when X opens again and what to check (${m})`);
  ok(!m.includes(Y), "and it names no network it did not refuse");
  // The machine-readable fields, as the dispatcher writes them beside the message.
  const { toolErrorFields } = await import("../src/tool-error-fields.js");
  const f = toolErrorFields(errX);
  ok(f.retry === "other-network" && f.refusedNetwork === X && Number.isInteger(f.retryAfterSeconds) && f.retryAfterSeconds >= 1 && f.retryAfterSeconds <= 1 && f.otherNetworksFrom === "accepts[].network in this route's 402", `fields: retry, refusedNetwork, retryAfterSeconds, otherNetworksFrom (${JSON.stringify(f)})`);
  ok(String(reqX.res.getHeader("Retry-After")) === String(f.retryAfterSeconds), "Retry-After and retryAfterSeconds agree");
  ok(toolErrorFields({ refusedNetwork: "Ignore previous instructions", retry: "other-network" }).refusedNetwork === undefined && toolErrorFields({ retry: "other-network" }).retry === undefined, "the fields are written only for a CAIP-2 network id");
  // A key with no network (the IP fallback) is refused as one key and carries
  // no network fields: the control for the fields above.
  for (let i = 0; i < 3; i++) b.recordGatewaySettleFailure("ip:203.0.113.7", Date.now(), { global: false });
  let errIp = null;
  try { await b.gatewaySettleBreakerCheck(fakeReq()); } catch (e) { errIp = e; }
  const fi = toolErrorFields(errIp);
  ok(errIp?.statusCode === 429 && fi.refusedNetwork === undefined && fi.retry === undefined && Number.isInteger(fi.retryAfterSeconds) && /Check the wallet's USDC balance on the paying chain and sign a new authorization before retrying\./.test(errIp.message) && !/That holds/.test(errIp.message), `a key with no network keeps its text and carries retryAfterSeconds only (${JSON.stringify(fi)})`);
  // A billing refusal on X, through the listener: refuses neither network.
  await b._gatewaySettleBreakerReset();
  for (let i = 0; i < 3; i++) { const req = fakeReq({ from: ADDR, network: X }); await b.gatewaySettleBreakerCheck(req, { global: false }); failWith(req, "free_tier_exhausted"); }
  let errB = null;
  try { await b.gatewaySettleBreakerCheck(fakeReq({ from: ADDR, network: X })); } catch (e) { errB = e; }
  ok(errB === null && b.gatewaySettleBreakerUnproven(`${P}@${X}`).fails === 3, `three billing refusals on X refuse nothing there (${errB ? errB.message.slice(0, 90) : "served"})`);
  // The burst alarm counts the BUYER once, on however many networks it failed.
  await b._gatewaySettleBreakerReset();
  for (const n of [X, Y, "eip155:42161", "eip155:10", "eip155:43114", "eip155:56", "eip155:100"]) b.recordGatewaySettleFailure(`${P}@${n}`);
  ok(b.gatewaySettleBreakerStatus().globalFailsInWindow === 1 && !b.gatewaySettleBreakerGlobalAlarm().alarm, "one wallet failing on seven networks is one buyer toward the alarm (GLOBAL_MAX 6) and does not trip it");
  await b._gatewaySettleBreakerReset();
}

// --- legacy keys: an earlier build's payer-only counts refuse no network -------
// Before the per-network key a wallet's failures were counted under the payer
// alone. Those counts name no network, so a payment that names one is not
// refused by them; the payer-only key itself still behaves as it did.
{
  await b._gatewaySettleBreakerReset();
  const P = ADDR.toLowerCase();
  for (let i = 0; i < 3; i++) b.recordGatewaySettleFailure(P, Date.now(), { global: false });
  let legacyErr = null, namedErr = null;
  try { await b.gatewaySettleBreakerCheck(fakeReq({ from: ADDR })); } catch (e) { legacyErr = e; }
  try { await b.gatewaySettleBreakerCheck(fakeReq({ from: ADDR, network: "eip155:8453" })); } catch (e) { namedErr = e; }
  ok(legacyErr?.statusCode === 429, `control: three failures under the payer-only key still refuse a payment that names no network (got ${legacyErr?.statusCode})`);
  ok(namedErr === null, `the same counts refuse no payment that names a network (${namedErr ? namedErr.message.slice(0, 80) : "served"})`);
  await b._gatewaySettleBreakerReset();
}

// --- THE SERVICE-WIDE BOUND: rotating wallets are held after one unsettled run ---
// The per-key counts start at zero for every new wallet. Once GLOBAL_MAX
// distinct buyers' /v1 failures are read against them inside the window, a
// /v1 consult reads a wallet's own verdict and unknown counts at
// BURST_MAX_FAILS (1). The share rule is unchanged: a wallet whose payments
// settle, a fresh wallet, a wallet failing only for our reasons and the
// catalog consult are served as before.
{
  const { toolErrorFields } = await import("../src/tool-error-fields.js");
  ok(b.BURST_MAX_FAILS === 1 && b.AUTH_MAX_FAILS === 3, `the burst count reads 1 and the authorization count MAX_FAILS by default (${b.BURST_MAX_FAILS}, ${b.AUTH_MAX_FAILS})`);
  await b._gatewaySettleBreakerReset();
  // Rotation through the real consult and finish listener: each wallet is
  // served until refused. Five wallets reach the per-key limit (3 each); the
  // sixth distinct buyer raises the bound, and from then on every new wallet
  // is held after its first unsettled run.
  const rot = (i) => "0x" + "5".repeat(36) + i.toString(16).padStart(4, "0");
  let served = 0;
  const perWallet = [];
  for (let i = 0; i < 12; i++) {
    let n = 0;
    for (let j = 0; j < 5; j++) {
      const req = fakeReq({ from: rot(i) });
      try { await b.gatewaySettleBreakerCheck(req); } catch (e) { if (e.statusCode !== 429) throw e; break; }
      n++; failWith(req, "insufficient_funds");
    }
    perWallet.push(n); served += n;
  }
  ok(served === 5 * 3 + 7 && perWallet.slice(5).every((n) => n === 1), `twelve rotated wallets are served ${served} unpaid runs, not ${12 * 3}: the five before the bound three each, every wallet after it one (${perWallet.join(",")})`);
  const st = b.gatewaySettleBreakerStatus();
  ok(st.wideBound === true && st.wideTrips === 1, `the bound reads up on the operator counts (${st.wideBound}, ${st.wideTrips})`);
  const W = "0x" + "6".repeat(40);
  b.recordGatewaySettleFailure(W);
  let err = null;
  try { await b.gatewaySettleBreakerCheck(fakeReq({ from: W })); } catch (e) { err = e; }
  ok(err?.statusCode === 429 && /failed to settle \(1 in the last/.test(err.message) && /Nothing was charged/.test(err.message), `while the bound is up a wallet with one failure of its own and nothing settled is refused before the handler (${err?.statusCode}: ${String(err?.message).slice(0, 70)})`);
  ok(err && err.retryAfterMs <= 900 + 5, `the refusal lasts no longer than the bound (${err?.retryAfterMs} ms)`);
  const U = "0x" + "7".repeat(39) + "1";
  b.recordGatewaySettleFailure(U, Date.now(), { fault: "unknown" });
  err = null; try { await b.gatewaySettleBreakerCheck(fakeReq({ from: U })); } catch (e) { err = e; }
  ok(err?.statusCode === 429 && /did not complete/.test(err.message), `one failure of unknown cause is read at the burst count too (${err?.statusCode})`);
  // Never refused: a wallet whose payments settle, a fresh one, one failing
  // for our reasons only, and the catalog consult.
  const P = "0x" + "8".repeat(40);
  b.recordGatewaySettleSuccess(P); b.recordGatewaySettleSuccess(P); b.recordGatewaySettleFailure(P);
  const N = "0x" + "9".repeat(39) + "1";
  for (let i = 0; i < 2; i++) b.recordGatewaySettleFailure(N, Date.now(), { fault: "not-buyer" });
  const served2 = [];
  for (const [label, who, opts] of [["a wallet that settled two calls beside one failure", P, {}], ["a fresh wallet", "0x" + "a".repeat(40), {}], ["a wallet failing only for our reasons", N, {}], ["the catalog consult for the held wallet", W, { global: false }]]) {
    let e = null; try { await b.gatewaySettleBreakerCheck(fakeReq({ from: who }), opts); } catch (x) { e = x; }
    served2.push(`${label}: ${e ? e.statusCode : "served"}`);
  }
  ok(served2.every((x) => x.endsWith("served")), `while the bound is up these are served as before (${served2.join("; ")})`);
  // Only a wallet that has never settled gets the lower count. A long-time
  // payer whose settled calls are all older than the window (fifty of them)
  // and whose sales are on the books is served after one failure; the same
  // history with no sale on the books (the control) is held.
  {
    const { recordSale } = await import("../src/sales-ledger.js");
    const LOYAL = "0x" + "f".repeat(39) + "5", STRANGER = "0x" + "f".repeat(39) + "6";
    for (let i = 0; i < 50; i++) { b.recordGatewaySettleSuccess(LOYAL, Date.now() - 2000); b.recordGatewaySettleSuccess(STRANGER, Date.now() - 2000); }
    for (let i = 0; i < 50; i++) recordSale({ slug: "llm-chat", priceUsd: 0.01, rail: "usdc", network: "eip155:8453", payer: LOYAL, tx: "0x" + i.toString(16).padStart(64, "0") });
    b.recordGatewaySettleFailure(LOYAL); b.recordGatewaySettleFailure(STRANGER);
    const tryIt = async (who) => { try { await b.gatewaySettleBreakerCheck(fakeReq({ from: who })); return "served"; } catch (e) { return e.statusCode; } };
    const loyal = await tryIt(LOYAL), stranger = await tryIt(STRANGER);
    ok(b.gatewaySettleBreakerStatus().wideBound === true && loyal === "served" && stranger === 429, `while the bound is up a wallet with fifty paid sales (settled before the window) and one failure is served; one with no sale on the books is held (paid ${loyal}, never paid ${stranger})`);
    // A ledger that cannot answer never puts a buyer under the lower count.
    const ODD = "0x" + "f".repeat(39) + "7";
    b.recordGatewaySettleFailure(ODD);
    b.setGatewaySettleBreakerPaidSaleReaderForTest(() => { throw new Error("ledger down"); });
    const odd = await tryIt(ODD);
    b.setGatewaySettleBreakerPaidSaleReaderForTest(null);
    ok(odd === "served" && (await tryIt(ODD)) === 429, `a paid-sale read that throws serves the wallet (${odd}); the real read holds it`);
    // A ledger whose first load has not landed reads "never paid" for every
    // wallet (its mirror is empty): the wallet is served until it lands.
    const EARLY = "0x" + "f".repeat(39) + "9";
    b.recordGatewaySettleFailure(EARLY);
    b.setGatewaySettleBreakerPaidSaleReaderForTest(null, { loaded: () => false });
    const early = await tryIt(EARLY);
    b.setGatewaySettleBreakerPaidSaleReaderForTest(null);
    ok(early === "served" && (await tryIt(EARLY)) === 429, `a sales ledger not loaded yet serves the wallet (${early}); the loaded ledger holds it`);
    // The same through the real ledger in database mode, its first load not
    // landed (the database refuses the connection): it reports itself not
    // loaded, its read says "never paid", and the wallet is served.
    {
      const { execFileSync } = await import("node:child_process");
      const { childJson } = await import("./lib/child-json.js");
      const { createServer } = await import("node:net");
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const probe = createServer(); await new Promise((r) => probe.listen(0, "127.0.0.1", r));
      const dead = probe.address().port; await new Promise((r) => probe.close(r));
      const dir = mkdtempSync(join(tmpdir(), "gwb-unloaded-"));
      const src = `
        const b = await import(${JSON.stringify(new URL("../src/gateway-settle-breaker.js", import.meta.url).href)});
        const sl = await import(${JSON.stringify(new URL("../src/sales-ledger.js", import.meta.url).href)});
        for (let i = 0; i < 12; i++) b.recordGatewaySettleFailure("0x" + "e".repeat(35) + "2" + i.toString(16).padStart(4, "0"), Date.now(), { fault: "buyer" });
        const W = "0x" + "e".repeat(39) + "7";
        b.recordGatewaySettleFailure(W);
        const hdr = Buffer.from(JSON.stringify({ payload: { authorization: { from: W } } })).toString("base64");
        const req = { header: (n) => (String(n).toLowerCase() === "payment-signature" ? hdr : undefined), headers: {}, ip: "203.0.113.9" };
        let verdict = "served"; try { await b.gatewaySettleBreakerCheck(req); } catch (e) { verdict = e.statusCode; }
        console.log(JSON.stringify({ backend: sl.salesLedgerBackend, loaded: sl.salesLedgerLoaded(), paid: sl.payerHasPaidSale(W), wide: b.gatewaySettleBreakerStatus().wideBound, verdict }));
        process.exit(0);`;
      let out = null;
      try {
        const env = { ...process.env, STATE_DATABASE_URL: `postgres://u:p@127.0.0.1:${dead}/none?sslmode=disable`, STATE_STORE_RETRY_MS: "600000", SALES_LEDGER_DB: join(dir, "sales.db"), SHARED_LIMITS_PREFIX: `${process.env.SHARED_LIMITS_PREFIX}-unloaded` };
        delete env.REDIS_URL; delete env.LEDGER_JOURNAL_REDIS;
        out = childJson(execFileSync(process.execPath, ["--input-type=module", "-e", src], { env, encoding: "utf8", timeout: 60_000 }));
      } catch (e) { out = { error: String(e?.message || e).slice(0, 300) }; }
      finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
      ok(out?.backend === "pg" && out.loaded === false && out.paid === false && out.wide === true && out.verdict === "served", `database mode before the first load: the ledger reads not loaded and "never paid", and the wallet is served while the bound is up (${JSON.stringify(out)})`);
    }
    // A wallet with one settled call and two verdicts inside the window is
    // read under the share rule at the usual count, as with the bound down.
    const MIXED = "0x" + "f".repeat(39) + "8";
    b.recordGatewaySettleSuccess(MIXED); b.recordGatewaySettleFailure(MIXED); b.recordGatewaySettleFailure(MIXED);
    const mixed = await tryIt(MIXED);
    ok(mixed === "served", `while the bound is up a wallet with one settled call and two buyer-fault failures is served as with the bound down (${mixed})`);
  }
  // The trigger counts only failures read against a buyer.
  await b._gatewaySettleBreakerReset();
  for (let i = 0; i < 8; i++) b.recordGatewaySettleFailure(`0x${"b".repeat(36)}${i.toString(16).padStart(4, "0")}`, Date.now(), { fault: "not-buyer" });
  for (let i = 0; i < 8; i++) b.recordGatewaySettleFailure(null, Date.now(), { withdrawn: true });
  for (let i = 0; i < 8; i++) b.recordGatewaySettleFailure(`0x${"c".repeat(36)}${i.toString(16).padStart(4, "0")}`, Date.now(), { walletCount: false });
  for (let i = 0; i < 8; i++) b.recordGatewaySettleFailure(`0x${"d".repeat(36)}${i.toString(16).padStart(4, "0")}`, Date.now(), { global: false });
  ok(b.gatewaySettleBreakerStatus().wideBound === false, "failures of ours, withdrawn sub-cent refusals, pending payments and catalog failures never raise the bound");
  // Failures of unknown cause (a facilitator's bare 4xx, a bare
  // settlement_failed, a 402 with no receipt) never raise it either; twelve
  // distinct buyers' buyer verdicts do, and a never-paid wallet is then held
  // after one.
  for (let i = 0; i < 12; i++) b.recordGatewaySettleFailure(`0x${"e".repeat(36)}${i.toString(16).padStart(4, "0")}`, Date.now(), { fault: "unknown" });
  ok(b.gatewaySettleBreakerStatus().wideBound === false, "twelve distinct buyers' failures of unknown cause do not raise the bound");
  {
    let reqs = 0;
    for (const [i, reason] of [[0, "circle_http_400"], [1, ""], [2, "settlement_failed"]]) {
      const req = fakeReq({ from: `0x${"e".repeat(36)}${(0x100 + i).toString(16).padStart(4, "0")}` });
      try { await b.gatewaySettleBreakerCheck(req); reqs++; } catch { /* counted below */ }
      failWith(req, reason || null);
    }
    ok(reqs === 3 && b.gatewaySettleBreakerStatus().wideBound === false, "unclassified settle answers through the real finish listener do not raise the bound either");
  }
  for (let i = 0; i < 12; i++) b.recordGatewaySettleFailure(`0x${"e".repeat(35)}1${i.toString(16).padStart(4, "0")}`, Date.now(), { fault: "buyer" });
  {
    const NP = "0x" + "e".repeat(39) + "9";
    b.recordGatewaySettleFailure(NP);
    let e1 = null; try { await b.gatewaySettleBreakerCheck(fakeReq({ from: NP })); } catch (e) { e1 = e; }
    ok(b.gatewaySettleBreakerStatus().wideBound === true && e1?.statusCode === 429, `twelve buyer-fault failures raise the bound, and a never-paid wallet with one failure is then held (${e1?.statusCode || "served"})`);
  }
  await b._gatewaySettleBreakerReset();
  const V = "0x" + "e".repeat(39) + "2";
  b.recordGatewaySettleFailure(V);
  err = null; try { await b.gatewaySettleBreakerCheck(fakeReq({ from: V })); } catch (e) { err = e; }
  ok(err === null, `control: with the bound down one failure refuses nothing (${err?.statusCode || "served"})`);
  // The bound lifts with its window.
  await b._gatewaySettleBreakerReset();
  for (let i = 0; i < 6; i++) b.recordGatewaySettleFailure(rot(100 + i));
  b.recordGatewaySettleFailure(W);
  err = null; try { await b.gatewaySettleBreakerCheck(fakeReq({ from: W })); } catch (e) { err = e; }
  ok(err?.statusCode === 429, "control: the bound is up again after six more buyers");
  // A failure recorded late in the bound's window is held only to the bound's end.
  const raisedAt = Date.now();
  await sleep(450);
  const L = "0x" + "1".repeat(39) + "4";
  b.recordGatewaySettleFailure(L);
  err = null; try { await b.gatewaySettleBreakerCheck(fakeReq({ from: L })); } catch (e) { err = e; }
  ok(err?.statusCode === 429 && err.retryAfterMs <= raisedAt + 900 - Date.now() + 20, `a failure late in the bound's window is held only until the bound ends (${err?.retryAfterMs} ms, bound ends in about ${raisedAt + 900 - Date.now()} ms)`);
  await sleep(500);
  ok(b.gatewaySettleBreakerStatus().wideBound === false, "the bound lifts once its window ends");

  // --- ONE AUTHORIZATION RE-PRESENTED -------------------------------------
  // Counted per authorization only when the settle failed for the buyer's
  // reason (the wallet's own classification). A failure of ours or of unknown
  // cause never counts, so the same authorization re-presented after them is
  // served every time; AUTH_MAX_FAILS buyer verdicts refuse that authorization
  // alone, and a new authorization from the same wallet is served at once.
  await b._gatewaySettleBreakerReset();
  const A = "0x" + "f".repeat(39) + "3", NET = "eip155:8453";
  const authHeader = (from, nonce) => Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: NET }, payload: { signature: "0x" + "11".repeat(65), authorization: { from, to: "0x" + "0".repeat(40), value: "1000", validAfter: "0", validBefore: "9999999999", nonce } } })).toString("base64");
  const authReq = (from, nonce) => { const req = fakeReq({ from, network: NET }); const h = authHeader(from, nonce); req.header = (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined); return req; };
  const NONCE = "0x" + "ab".repeat(32);
  const reRun = async (nonce, reason, n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const req = authReq(A, nonce);
      try { await b.gatewaySettleBreakerCheck(req); } catch (e) { out.push(e.statusCode); continue; }
      out.push("served"); failWith(req, reason);
    }
    return out.join(",");
  };
  const ours = await reRun("0x" + "a1".repeat(32), "timeout", 6);
  ok(ours === "served,served,served,served,served,served", `one authorization re-presented after settles that failed for our reasons is served every time (${ours})`);
  const unk = await reRun("0x" + "a2".repeat(32), "settlement_failed", 4);
  ok(unk === "served,served,served,served", `one authorization re-presented after settles of unknown cause is served every time (${unk})`);
  // The wallet has settled calls, so its own share rule does not refuse it and
  // the refusal below is the authorization's alone.
  const kA = b.gatewaySettleBreakerCountKey(authReq(A, NONCE));
  await b._gatewaySettleBreakerReset();
  for (let i = 0; i < 10; i++) b.recordGatewaySettleSuccess(kA);
  const statuses = (await reRun(NONCE, "insufficient_funds", 5)).split(",");
  ok(statuses.join(",") === "served,served,served,429,429", `one authorization re-presented after buyer verdicts is served three times, then refused (${statuses.join(",")})`);
  ok(typeof b.gatewaySettleBreakerAuthKey === "function" && b.gatewaySettleBreakerAuthKey(authReq(A, NONCE)) === b.gatewaySettleBreakerAuthKey(authReq(A, "0x00" + "ab".repeat(32))) && b.gatewaySettleBreakerAuthKey(authReq(A, NONCE)) !== b.gatewaySettleBreakerAuthKey(authReq(A, "0x" + "cd".repeat(32))) && b.gatewaySettleBreakerAuthKey(fakeReq({ tempo: "0xtempopayer" })) === null, "the authorization key reads the canonical nonce, and only for a signed EVM payment");
  err = null; try { await b.gatewaySettleBreakerCheck(authReq(A, NONCE)); } catch (e) { err = e; }
  const f = err ? toolErrorFields(err) : {};
  ok(/This payment authorization on eip155:8453 was served 3 times/.test(err?.message || "") && /Sign a new authorization \(a new nonce\)/.test(err?.message || "") && /Nothing was charged/.test(err?.message || "") && f.hint === "sign-new-authorization" && !f.refusedNetwork && Number.isInteger(f.retryAfterSeconds), `the 429 says to sign a new authorization, in words and a field (${err?.message?.slice(0, 80)}; ${JSON.stringify(f)})`);
  const k = b.gatewaySettleBreakerCountKey(authReq(A, NONCE));
  ok(b.gatewaySettleBreakerBlocked(k).blocked === false && b.gatewaySettleBreakerBlocked(k).fails === 3, "the wallet itself, with settled calls, is not refused");
  err = null; try { await b.gatewaySettleBreakerCheck(authReq(A, "0x" + "cd".repeat(32))); } catch (e) { err = e; }
  ok(err === null, `the same wallet with a new authorization is served at once (${err?.statusCode || "served"})`);
  // A buyer signing a new authorization per call is never refused, whatever fails on our side.
  await b._gatewaySettleBreakerReset();
  let refused = 0;
  for (let i = 0; i < 30; i++) {
    const req = authReq(A, "0x" + (1000 + i).toString(16).padStart(64, "0"));
    try { await b.gatewaySettleBreakerCheck(req); } catch { refused++; continue; }
    failWith(req, "timeout");
  }
  ok(refused === 0, `thirty fresh authorizations whose settles fail for our reasons: none refused (${refused})`);
  // A payment still settling is not counted against its authorization.
  for (let i = 0; i < 5; i++) b.recordGatewaySettleFailure(k, Date.now(), { walletCount: false, authKey: b.gatewaySettleBreakerAuthKey(authReq(A, "0x" + "ee".repeat(32))) });
  ok(b.gatewaySettleBreakerBlocked(k, Date.now(), { authKey: b.gatewaySettleBreakerAuthKey(authReq(A, "0x" + "ee".repeat(32))) }).authFails === 0, "a payment still settling is not counted against its authorization");
  await b._gatewaySettleBreakerReset();
}

// The shared half (only with a REDIS_URL): a trip's alarm flag is written by
// a window add's reply, after the call that tripped it returned. The test
// reset waits for every write already sent before it clears the flag.
if (process.env.REDIS_URL) {
  const { shared } = await import("../src/shared-limits.js");
  ok(b._gatewaySettleBreakerShared === true, "with a REDIS_URL the breaker writes through to the shared store");
  await b._gatewaySettleBreakerReset();
  for (let i = 0; i < 6; i++) b.recordGatewaySettleFailure(`0xtrip${i}`);
  ok(b.gatewaySettleBreakerGlobalAlarm().alarm, "six distinct buyers trip the burst alarm (GLOBAL_MAX 6)");
  let err = null;
  try { await b.gatewaySettleBreakerCheck(fakeReq({ from: "0x" + "9".repeat(40) })); } catch (e) { err = e; }
  ok(err === null, `a fresh wallet is served while the shared alarm is up (${err ? err.message.slice(0, 80) : "no refusal"})`);
  await b._gatewaySettleBreakerReset();
  ok((await b.gatewaySettleFailuresStatus()).status === "ok", "after the reset no alarm flag written by the trip survives in the shared store");
  // The alarm flag set by ANOTHER replica reads burst here (this process's own latch is clear).
  await shared.flagSet("gwb-alarm", "all", Date.now() + 5000);
  ok(!b.gatewaySettleBreakerGlobalAlarm().alarm && (await b.gatewaySettleFailuresStatus()).status === "burst", "another replica's alarm flag reads burst through the shared store");
  await b._gatewaySettleBreakerReset();
  // DEPLOY OVERLAP, new build reading the earlier build's keys. The earlier
  // build wrote a pause flag and payer-only windows: neither refuses here.
  const legacy = "0x" + "7".repeat(40), X = "eip155:8453";
  await shared.flagSet("gwb-pause", "all", Date.now() + 5000);
  for (let i = 0; i < 3; i++) await shared.windowAdd("gwb-fail", legacy, { windowMs: 900, member: `old:${i}`, now: Date.now() });
  let e1 = null, e2 = null;
  try { await b.gatewaySettleBreakerCheck(fakeReq({ from: legacy, network: X })); } catch (e) { e1 = e; }
  ok(e1 === null && (await b.gatewaySettleFailuresStatus()).status === "ok", `the earlier build's pause flag and payer-only failure window refuse no payment that names a network, and raise no alarm (${e1 ? `${e1.statusCode}: ${e1.message.slice(0, 60)}` : "served"})`);
  // Control: the same shared window DOES refuse the key it is named for, so
  // the served call above was served for the key's shape, not an empty store.
  try { await b.gatewaySettleBreakerCheck(fakeReq({ from: legacy })); } catch (e) { e2 = e; }
  ok(e2?.statusCode === 429, `control: that payer-only shared window refuses a payment naming no network (got ${e2?.statusCode})`);
  // And this build's per-network failures land in windows the earlier build
  // never reads (its key is the payer alone), under names it can parse.
  for (let i = 0; i < 3; i++) b.recordGatewaySettleFailure(`${legacy}@${X}`, Date.now(), { global: false });
  await b._gatewaySettleBreakerReset();
  await shared.flagSet("gwb-pause", "all", 0);
  await shared.windowClear("gwb-fail", legacy);
  // Another replica's strikes for a wallet, one of them our blocklist's
  // verdict, written to the shared windows that replica writes (gwb-fail,
  // gwb-blk); this process holds none of them. Its refusal reads the shared
  // blocklist count and uses the neutral words; the same strikes without the
  // gwb-blk entry keep the verdict words (the control). One fixed clock for
  // the writes and the read (the consult takes `now`), and a key life of a
  // minute, so no wall-clock delay between them can age the strikes out.
  const KEY_LIFE_MS = 60_000;
  for (const [label, withBlk] of [["blocklisted", true], ["control: balance only", false]]) {
    await b._gatewaySettleBreakerReset();
    const W2 = "0x" + (withBlk ? "5" : "6").repeat(40);
    const k2 = b.gatewaySettleBreakerCountKey(fakeReq({ from: W2, network: X }));
    const now = Date.now();
    for (let i = 0; i < 3; i++) await shared.windowAdd("gwb-fail", k2, { windowMs: KEY_LIFE_MS, member: `other:${i}`, now });
    if (withBlk) await shared.windowAdd("gwb-blk", k2, { windowMs: KEY_LIFE_MS, member: "other:0", now });
    const localBefore = b.gatewaySettleBreakerBlocked(k2, now);
    let err = null;
    try { await b.gatewaySettleBreakerCheck(fakeReq({ from: W2, network: X }), { now }); } catch (e) { err = e; }
    ok(localBefore.fails === 0 && !localBefore.blocklisted, `${label}: this process holds none of the strikes (fails ${localBefore.fails})`);
    ok(withBlk
      ? err?.statusCode === 429 && /settlement did not proceed for this wallet/.test(err.message) && !/balance|signature|refused the payment itself/i.test(err.message)
      : err?.statusCode === 429 && /refused the payment itself/.test(err.message),
    `${label}: another replica's shared strikes refuse here in the ${withBlk ? "neutral blocklist" : "verdict"} words (${err?.statusCode}: ${String(err?.message).slice(0, 90)})`);
    await shared.windowClear("gwb-fail", k2);
    await shared.windowClear("gwb-blk", k2);
  }
  // THE SERVICE-WIDE BOUND raised on another replica (gwb-wide) holds here a
  // wallet with one failure of its own; the alarm flag alone (gwb-alarm) does
  // not (the control), and neither does the bound for a wallet with none.
  {
    await b._gatewaySettleBreakerReset();
    const W3 = "0x" + "4".repeat(40);
    const k3 = b.gatewaySettleBreakerCountKey(fakeReq({ from: W3, network: X }));
    b.recordGatewaySettleFailure(k3);
    const tryW = async (who = W3) => { try { await b.gatewaySettleBreakerCheck(fakeReq({ from: who, network: X })); return "served"; } catch (e) { return e.statusCode; } };
    await shared.flagSet("gwb-alarm", "all", Date.now() + 5000);
    const withAlarm = await tryW();
    await shared.flagSet("gwb-wide", "all", Date.now() + 5000);
    const withWide = await tryW(), fresh = await tryW("0x" + "3".repeat(40));
    ok(withAlarm === "served" && withWide === 429 && fresh === "served" && !b.gatewaySettleBreakerStatus().wideBound, `another replica's service-wide bound holds a wallet with one failure here; the alarm flag alone does not, nor a fresh wallet (alarm ${withAlarm}, bound ${withWide}, fresh ${fresh})`);
    // Another replica's runs under one authorization (gwb-auth) refuse it here.
    await b._gatewaySettleBreakerReset();
    const W4 = "0x" + "2".repeat(40);
    const h = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: X }, payload: { authorization: { from: W4, nonce: "0x" + "77".repeat(32) } } })).toString("base64");
    const authReq = () => { const req = fakeReq({ from: W4, network: X }); req.header = (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined); return req; };
    const ak = b.gatewaySettleBreakerAuthKey(authReq());
    const now = Date.now();
    for (let i = 0; i < 3; i++) await shared.windowAdd("gwb-auth", ak, { windowMs: KEY_LIFE_MS, member: `other:${i}`, now });
    let err = null;
    try { await b.gatewaySettleBreakerCheck(authReq(), { now }); } catch (e) { err = e; }
    ok(err?.statusCode === 429 && /This payment authorization/.test(err.message), `another replica's runs under one authorization refuse it here (${err?.statusCode}: ${String(err?.message).slice(0, 60)})`);
    await shared.windowClear("gwb-auth", ak);
  }
  await b._gatewaySettleBreakerReset();
}

// --- one payer at the limit on several networks raises the same alarm ----------
// The count is per network, so one wallet can reach the refusing count on
// every network a route offers. It is one buyer, so the distinct-buyer count
// never sees it; the alarm also trips when one payer's /v1 failures read
// refusing on three networks (MULTI_NETWORK_MIN) inside the window. Nobody is
// refused for it.
{
  await b._gatewaySettleBreakerReset();
  const word = async () => (await b.gatewaySettleFailuresStatus()).status;
  const P = "0x" + "5".repeat(40), Q = "0x" + "6".repeat(40);
  const NETS = ["eip155:8453", "eip155:137", "eip155:42161", "eip155:42220", "eip155:57073"];
  const failOn = (payer, net, n = 3, opts = {}) => { for (let i = 0; i < n; i++) b.recordGatewaySettleFailure(`${payer}@${net}`, Date.now(), opts); };
  ok(b.MULTI_NETWORK_MIN === 3, `the default: three networks (${b.MULTI_NETWORK_MIN})`);

  // One network, however many failures there: the per-key bound's job, no alarm.
  failOn(P, NETS[0], 10);
  ok((await word()) === "ok" && b.gatewaySettleBreakerStatus().multiNetworkTrips === 0, "ten failures from one payer on ONE network raise no alarm");
  // Two networks at the limit, and a third below it: still ok.
  failOn(P, NETS[1], 3);
  failOn(P, NETS[2], 2);
  ok((await word()) === "ok" && b.gatewaySettleBreakerStatus().payersWithNetworkAtLimit === 1, "two networks at the limit and a third below it: ok");
  // The third network reaches the limit: burst, from one buyer.
  failOn(P, NETS[2], 1);
  const st = b.gatewaySettleBreakerStatus();
  ok((await word()) === "burst" && st.multiNetworkTrips === 1 && st.globalFailsInWindow === 1, `the third network at the limit trips settleFailures: burst, with one buyer in the window (${JSON.stringify({ trips: st.multiNetworkTrips, buyers: st.globalFailsInWindow })})`);
  const op = await b.gatewaySettleFailuresStatus({ full: true });
  ok(op.status === "burst" && op.multiNetworkThreshold === 3 && op.multiNetworkTrips === 1 && !/0x|eip155/.test(JSON.stringify(op)) && JSON.stringify(await b.gatewaySettleFailuresStatus()) === JSON.stringify({ status: "burst" }), `the operator read counts the trip and names no payer or network; publicly the word only (${JSON.stringify(op)})`);
  // Serving is unchanged: the payer is refused on the networks at the limit
  // (as before) and served on a fourth; another buyer is served everywhere.
  let eHeld = null, eFree = null, eOther = null;
  try { await b.gatewaySettleBreakerCheck(fakeReq({ from: P, network: NETS[0] })); } catch (e) { eHeld = e; }
  try { await b.gatewaySettleBreakerCheck(fakeReq({ from: P, network: NETS[3] })); } catch (e) { eFree = e; }
  try { await b.gatewaySettleBreakerCheck(fakeReq({ from: Q, network: NETS[0] })); } catch (e) { eOther = e; }
  ok(eHeld?.statusCode === 429 && eHeld.refusedNetwork === NETS[0] && eFree === null && eOther === null, `no new refusal: the payer is held on its failing networks only, served on a fourth, and another buyer is served (${eHeld?.statusCode}, ${eFree?.statusCode || "served"}, ${eOther?.statusCode || "served"})`);
  if (b._gatewaySettleBreakerShared) {
    const { shared } = await import("../src/shared-limits.js");
    let until = 0;
    for (let i = 0; i < 40 && !(until > Date.now()); i++) { until = (await shared.flagGet("gwb-alarm", "all")).until || 0; if (!(until > Date.now())) await sleep(25); }
    ok(until > Date.now(), "the shared alarm flag is set, so every replica's word reads burst");
  }
  // It clears the way the alarm clears: one window later.
  await sleep(950);
  ok((await word()) === "ok" && !b.gatewaySettleBreakerGlobalAlarm().alarm, "the word returns to ok after the window");

  // Networks at the limit in different windows never add up.
  await b._gatewaySettleBreakerReset();
  failOn(P, NETS[0]); failOn(P, NETS[1]);
  await sleep(950);
  failOn(P, NETS[2]);
  ok((await word()) === "ok", "two networks at the limit, then a third one window later: ok");

  // A payer settling most of its calls is not at the limit on a network (the
  // share rule), so its scattered failures on three networks raise nothing.
  await b._gatewaySettleBreakerReset();
  for (const net of NETS.slice(0, 3)) { for (let i = 0; i < 10; i++) b.recordGatewaySettleSuccess(`${P}@${net}`); failOn(P, net); }
  if (b._gatewaySettleBreakerShared) await sleep(150);
  ok((await word()) === "ok" && b.gatewaySettleBreakerStatus().multiNetworkTrips === 0, "three failures beside ten settled calls on each of three networks: no network is at the limit, ok");

  // The catalog consult's failures (global:false) count against the wallet
  // only, here as in the rest of the alarm.
  await b._gatewaySettleBreakerReset();
  for (const net of NETS.slice(0, 3)) failOn(P, net, 3, { global: false });
  if (b._gatewaySettleBreakerShared) await sleep(150);
  ok((await word()) === "ok" && b.gatewaySettleBreakerBlocked(`${P}@${NETS[0]}`).blocked, "wallet-only catalog failures on three networks hold the wallet there and raise no /v1 alarm");

  // Two payers, the limit on three networks between them: neither alone.
  await b._gatewaySettleBreakerReset();
  failOn(P, NETS[0]); failOn(P, NETS[1]); failOn(Q, NETS[2]); failOn(Q, NETS[3]);
  if (b._gatewaySettleBreakerShared) await sleep(150);
  ok((await word()) === "ok", "two payers with two networks each at the limit: ok (the rule is one payer)");

  // The payer is the module's own key text. A signed EVM payer arrives
  // lowercased from the payment header whatever case the header used, so the
  // same wallet written three ways is one payer...
  await b._gatewaySettleBreakerReset();
  const MIXED = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
  const spellings = [MIXED, MIXED.toLowerCase(), "0x" + MIXED.slice(2).toUpperCase()];
  for (let n = 0; n < 3; n++) {
    for (let i = 0; i < 3; i++) {
      const req = fakeReq({ from: spellings[n], network: NETS[n] });
      await b.gatewaySettleBreakerCheck(req);
      failWith(req);
    }
  }
  ok((await word()) === "burst" && b.gatewaySettleBreakerStatus().multiNetworkTrips === 1, "through the consult: one EVM wallet whose header spells it in three cases, at the limit on three networks, is one payer: burst");
  // ...and a key that is not a lowercase EVM payer is never re-cased or
  // split: two base58-style keys differing only in case stay two keys (two
  // failures each refuse neither), and a key with no network is one key
  // however many failures it holds.
  await b._gatewaySettleBreakerReset();
  const B58 = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  for (let i = 0; i < 2; i++) { b.recordGatewaySettleFailure(B58, Date.now(), { global: false }); b.recordGatewaySettleFailure(B58.toLowerCase(), Date.now(), { global: false }); }
  ok(!b.gatewaySettleBreakerBlocked(B58).blocked && !b.gatewaySettleBreakerBlocked(B58.toLowerCase()).blocked && b.gatewaySettleBreakerBlocked(B58).fails === 2, "keys that differ only in case are two keys: never folded together");
  // (Five keys in all, under the distinct-buyer count of six: each such key is its own buyer.)
  for (const net of NETS.slice(0, 3)) failOn(B58, net);
  for (const net of NETS.slice(0, 2)) failOn("0x" + "A".repeat(40), net);
  if (b._gatewaySettleBreakerShared) await sleep(150);
  ok((await word()) === "ok" && b.gatewaySettleBreakerStatus().multiNetworkTrips === 0 && b.gatewaySettleBreakerStatus().payersWithNetworkAtLimit === 0, "a key that is not a signed lowercase EVM payer is read whole, as one key, and is never counted per network");
  await b._gatewaySettleBreakerReset();
}

// --- non-EVM payers: keyed by the signer, never by a shared IP --------------------
// Two wallets paying on one rail from one client address: one failing at
// settle reaches the refusing count and is refused; the other is never
// refused. The key is the signer read from the signed payment, case kept.
{
  const kit = await import("@solana/kit");
  const { default: algosdk } = await import("algosdk");
  const sdk = await import("@stellar/stellar-sdk");
  const SHARED_IP = "198.51.100.23";
  const reqFor = (payload) => {
    const hdr = Buffer.from(JSON.stringify(payload)).toString("base64");
    const req = { header: (n) => (String(n).toLowerCase() === "payment-signature" ? hdr : undefined), headers: {}, ip: SHARED_IP, res: fakeRes(), method: "POST", path: "/v1/chat" };
    settleReceiptHeaderGuard({ log: () => {} })(req, req.res, () => {});
    return req;
  };
  const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const feePayer = await kit.generateKeyPairSigner();
  const solPayload = async () => {
    const buyer = await kit.generateKeyPairSigner();
    const msg = kit.pipe(
      kit.createTransactionMessage({ version: 0 }),
      (m) => kit.setTransactionMessageFeePayer(feePayer.address, m),
      (m) => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n }, m),
      (m) => kit.appendTransactionMessageInstruction({ programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [{ address: buyer.address, role: kit.AccountRole.READONLY_SIGNER, signer: buyer }], data: new TextEncoder().encode("t") }, m),
    );
    const tx = kit.getBase64EncodedWireTransaction(await kit.partiallySignTransactionMessageWithSigners(msg));
    return { key: `svm:${buyer.address}`, payload: { x402Version: 2, accepted: { scheme: "exact", network: SOL, extra: { feePayer: feePayer.address } }, payload: { transaction: tx } } };
  };
  const ALGO = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
  const algoPayload = async () => {
    const buyer = algosdk.generateAccount(), payTo = algosdk.generateAccount();
    const params = { fee: 1000, minFee: 1000, firstValid: 1, lastValid: 1000, genesisID: "mainnet-v1.0", genesisHash: Buffer.from("wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "base64"), flatFee: true };
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: buyer.addr, receiver: payTo.addr, amount: 1000, assetIndex: 31566704, suggestedParams: params });
    return { key: `avm:${buyer.addr.toString()}`, payload: { x402Version: 2, accepted: { scheme: "exact", network: ALGO }, payload: { paymentGroup: [Buffer.from(txn.signTxn(buyer.sk)).toString("base64")], paymentIndex: 0 } } };
  };
  const stellarPayload = async () => {
    const buyer = sdk.Keypair.random(), payTo = sdk.Keypair.random(), source = sdk.Keypair.random();
    const op = sdk.Operation.invokeContractFunction({ contract: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", function: "transfer", args: [new sdk.Address(buyer.publicKey()).toScVal(), new sdk.Address(payTo.publicKey()).toScVal(), sdk.nativeToScVal(1000n, { type: "i128" })] });
    const tx = new sdk.TransactionBuilder(new sdk.Account(source.publicKey(), "1"), { fee: "100", networkPassphrase: sdk.Networks.PUBLIC }).addOperation(op).setTimeout(300).build();
    return { key: `stellar:${buyer.publicKey()}`, payload: { x402Version: 2, accepted: { scheme: "exact", network: "stellar:pubnet" }, payload: { transaction: tx.toXDR() } } };
  };
  const refusedFor = async (payload) => { try { await b.gatewaySettleBreakerCheck(reqFor(payload)); return null; } catch (e) { return e; } };
  for (const [rail, make] of [["Solana", solPayload], ["Algorand", algoPayload], ["Stellar", stellarPayload]]) {
    await b._gatewaySettleBreakerReset();
    const A = await make(), B = await make();
    const reqA = reqFor(A.payload);
    await b.gatewaySettleBreakerCheck(reqA); // the consult reads the signer
    ok(b.gatewaySettleBreakerKey(reqA) === A.key && A.key !== B.key, `${rail}: the breaker key is the signer read from the signed payment (${b.gatewaySettleBreakerKey(reqA)})`);
    ok(b.gatewaySettleBreakerKey(reqA) !== b.gatewaySettleBreakerKey(reqA).toLowerCase() || rail === "Algorand", `${rail}: the signer key keeps its case`);
    // Wallet A fails at settle three times (a verdict on its payment).
    for (let i = 0; i < 3; i++) { const req = reqFor(A.payload); await b.gatewaySettleBreakerCheck(req); failWith(req, "insufficient_funds"); }
    if (b._gatewaySettleBreakerShared) await sleep(150);
    const eA = await refusedFor(A.payload);
    ok(eA?.statusCode === 429, `${rail}: the failing wallet is still refused at the existing count (got ${eA?.statusCode})`);
    const eB = await refusedFor(B.payload);
    ok(eB === null, `${rail}: another wallet behind the same IP is never refused for it (got ${eB?.statusCode})`);
    ok(!b.gatewaySettleBreakerBlocked(`ip:${SHARED_IP}`).blocked && b.gatewaySettleBreakerBlocked(`ip:${SHARED_IP}`).fails === 0, `${rail}: nothing was counted under the shared IP`);
  }
  // A payload whose signer cannot be read keeps the IP fallback; nobody is unkeyed.
  await b._gatewaySettleBreakerReset();
  const unreadable = reqFor({ x402Version: 2, accepted: { scheme: "exact", network: SOL }, payload: { transaction: "bm90IGEgdHg=" } });
  await b.gatewaySettleBreakerCheck(unreadable);
  ok(b.gatewaySettleBreakerKey(unreadable) === `ip:${SHARED_IP}`, "an unreadable non-EVM payment falls back to the client IP");
  // EVM is unchanged: the signed payer, per network.
  const evm = fakeReq({ from: ADDR, network: "eip155:8453", ip: SHARED_IP });
  await b.gatewaySettleBreakerCheck(evm);
  ok(b.gatewaySettleBreakerCountKey(evm) === `${ADDR.toLowerCase()}@eip155:8453` && !Object.hasOwn(evm, "__a402BreakerNonEvmSigner"), "an EVM payment keeps its signed payer key and reads no non-EVM signer");
  await b._gatewaySettleBreakerReset();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
