// Offline test for src/gateway-settle-breaker.js and its wiring into every
// LLM gateway handler.
//
// The hole: @x402/express settles AFTER the handler, so a payment that verifies
// and then fails to settle costs us the upstream call with nothing charged. The
// breaker refuses a wallet (429) or every tier (503) BEFORE any upstream call
// once settle failures pile up, and a >= 400 cancels settlement, so nobody pays
// for the refusal. Nothing here touches the network: every fetch is a stub, and
// the stub that must NOT be reached fails the run if it is.
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";

// Thresholds are set before the module loads (it reads env at import, like
// the composite guard). Short window so expiry is testable in-process.
process.env.GATEWAY_SETTLE_BREAKER_MAX = "3";
process.env.GATEWAY_SETTLE_BREAKER_WINDOW_MS = "900";
process.env.GATEWAY_SETTLE_BREAKER_GLOBAL_MAX = "6";
process.env.POSTHOG_TEST_CAPTURE = "1";

const b = await import("../src/gateway-settle-breaker.js");
const { LLM_GATEWAY_TOOLS } = await import("../src/tools/llm-gateway-kit.js");
const { LLM_MESSAGES_TOOLS } = await import("../src/tools/llm-messages-kit.js");
const { LLM_RESPONSES_TOOLS } = await import("../src/tools/llm-responses-kit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ADDR = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
const paymentHeader = (from) => Buffer.from(JSON.stringify({ payload: { authorization: { from } } })).toString("base64");
function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res._headers = {};
  res.getHeader = (n) => res._headers[String(n).toLowerCase()];
  res.setHeader = (n, v) => { res._headers[String(n).toLowerCase()] = v; };
  return res;
}
function fakeReq({ from = null, tempo = null, ip = "203.0.113.7", withRes = true } = {}) {
  const hdr = from ? paymentHeader(from) : null;
  const req = {
    header: (n) => (String(n).toLowerCase() === "payment-signature" ? hdr || undefined : undefined),
    headers: {}, ip,
  };
  if (tempo) req.mppTempoSender = tempo;
  if (withRes) req.res = fakeRes();
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
  b._gatewaySettleBreakerReset();
  const K = "0xkey1";
  b.recordGatewaySettleFailure(K); b.recordGatewaySettleFailure(K);
  ok(!b.gatewaySettleBreakerBlocked(K).blocked, "two settle failures inside the window do not block");
  b.recordGatewaySettleFailure(K);
  const s = b.gatewaySettleBreakerBlocked(K);
  ok(s.blocked && s.fails === 3 && s.until > Date.now(), `the third blocks, with a lift time in the future (got ${JSON.stringify(s)})`);
  b.recordGatewaySettleSuccess(K);
  ok(!b.gatewaySettleBreakerBlocked(K).blocked, "a settled 200 clears the key at once");
  b.recordGatewaySettleFailure(null);
  ok(!b.gatewaySettleBreakerBlocked(null).blocked, "a null key is never blocked per key (it still counts globally)");
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
  b._gatewaySettleBreakerReset();
  fetchCalls = 0;
  const req = fakeReq({ from: ADDR });
  const out = await nano.handler(chatBody, req);
  ok(out?.choices?.[0]?.message?.content === "OK" && fetchCalls === 1, "control: an unblocked wallet is served and the stubbed upstream is reached exactly once");
  ok(req.__gatewaySettleBreakerArmed === true, "the consult armed the finish listener on req.res");
}
{
  // Below the threshold: two failures, still served.
  b._gatewaySettleBreakerReset();
  const key = ADDR.toLowerCase();
  b.recordGatewaySettleFailure(key); b.recordGatewaySettleFailure(key);
  fetchCalls = 0;
  const out = await nano.handler(chatBody, fakeReq({ from: ADDR }));
  ok(out?.choices?.[0]?.message?.content === "OK" && fetchCalls === 1, "below the threshold the wallet is still served");
}
{
  // At the threshold: refused 429 before fetch. The stub here FAILS THE TEST if reached.
  b._gatewaySettleBreakerReset();
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
  b._gatewaySettleBreakerReset();
  const key = ADDR.toLowerCase();
  for (let i = 0; i < 3; i++) b.recordGatewaySettleFailure(key);
  ok(b.gatewaySettleBreakerBlocked(key).blocked, "blocked right after the third failure");
  await sleep(950);
  ok(!b.gatewaySettleBreakerBlocked(key).blocked, "the block lifts once the failures age out of the window");
  fetchCalls = 0;
  const out = await nano.handler(chatBody, fakeReq({ from: ADDR }));
  ok(out?.choices?.[0]?.message?.content === "OK" && fetchCalls === 1, "and the wallet is served again");
}

// --- the global breaker --------------------------------------------------------
{
  b._gatewaySettleBreakerReset();
  for (let i = 0; i < 5; i++) b.recordGatewaySettleFailure(`0xrotating${i}`);
  ok(!b.gatewaySettleBreakerGlobalPaused().paused, "five failures across five keys: below the global threshold of six");
  b.recordGatewaySettleFailure(null);
  ok(b.gatewaySettleBreakerGlobalPaused().paused, "the sixth (any key, even unkeyed) trips the global pause");
  globalThis.fetch = async () => { ok(false, "upstream was called during the global pause"); throw new Error("must not be called"); };
  let err = null;
  const req = fakeReq({ from: "0x2222222222222222222222222222222222222222" });
  try { await nano.handler(chatBody, req); } catch (e) { err = e; }
  ok(err?.statusCode === 503 && /paused/i.test(err?.message || "") && /Nothing was charged/.test(err?.message || ""), `a fresh wallet is refused 503 during the global pause (got ${err?.statusCode}: ${String(err?.message).slice(0, 80)})`);
  let e3 = null;
  try { await nano.handler(chatBody); } catch (e) { e3 = e; }
  ok(e3?.statusCode === 503, "an in-process caller with no request is covered by the global pause too");
  const st = b.gatewaySettleBreakerStatus();
  ok(st.globalPaused === true && st.globalTrips === 1 && typeof st.globalPausedUntil === "string", `status reports the pause (got ${JSON.stringify(st)})`);
  ok(!/0x|203\.0\.113|tempo:/.test(JSON.stringify(st)), "status carries counts only - never a key, address or IP");
  await sleep(950);
  ok(!b.gatewaySettleBreakerGlobalPaused().paused, "the global pause lifts after the window");
  globalThis.fetch = async (url, init) => { fetchCalls++; return okChat(init); };
  fetchCalls = 0;
  const out = await nano.handler(chatBody, fakeReq({ from: ADDR }));
  ok(out?.choices?.[0]?.message?.content === "OK" && fetchCalls === 1, "tiers serve again after the pause");
}

// --- the finish listener reads the FINAL outcome -------------------------------
{
  b._gatewaySettleBreakerReset();
  const key = ADDR.toLowerCase();
  // Three served requests whose FINAL status is 402 (the settlement-failure
  // rewrite): each one counts, the third blocks.
  for (let i = 0; i < 3; i++) {
    const req = fakeReq({ from: ADDR });
    await nano.handler(chatBody, req);
    req.res.statusCode = 402;
    req.res.emit("finish");
  }
  ok(b.gatewaySettleBreakerBlocked(key).blocked, "three served-then-402 responses (settle failed after the handler) block the wallet");
  b._gatewaySettleBreakerReset();
  // A settle receipt saying success:false counts whatever the status says.
  {
    const req = fakeReq({ from: ADDR });
    await nano.handler(chatBody, req);
    req.res.statusCode = 200;
    req.res.setHeader("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: false, errorReason: "insufficient_funds" })).toString("base64"));
    req.res.emit("finish");
    ok(b.gatewaySettleBreakerBlocked(key).fails === 1, "a settle receipt with success:false counts as a failure");
  }
  // A settled 200 clears.
  {
    const req = fakeReq({ from: ADDR });
    await nano.handler(chatBody, req);
    req.res.statusCode = 200;
    req.res.emit("finish");
    ok(b.gatewaySettleBreakerBlocked(key).fails === 0, "a settled 200 clears the wallet's count");
  }
  // A FACILITATOR refusing on a billing quota of OURS. Only the one refusal
  // the offer gate WITHDRAWS (an Algorand sub-cent settle refused
  // subcent_quota_exceeded, gate installed and armed, the payTo paid paused,
  // and the route's next 402 really dropping that accept - so the loop is
  // closed) is kept off the wallet's count (2026-09-28: one buyer refused 325
  // calls for it, told their wallet was the problem), and even that still
  // feeds the /v1 global pause. Every other billing refusal has nothing
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

    // No gate on the resource server: nothing withdraws the offer, so it counts.
    s._resetAvmSponsorshipForTest({ logger: () => {}, installed: false });
    b._gatewaySettleBreakerReset();
    pause();
    await finishWith("subcent_quota_exceeded");
    ok(walletFails() === 1 && globalFails() === 1, `with no offer gate installed a subcent_quota_exceeded refusal counts like any failed settle (wallet ${walletFails()}, global ${globalFails()})`);

    // Gate installed and the payTo paused: off the WALLET, still global.
    s._resetAvmSponsorshipForTest({ logger: () => {}, installed: true });
    b._gatewaySettleBreakerReset();
    pause();
    for (let i = 0; i < 5; i++) await finishWith("subcent_quota_exceeded");
    ok(walletFails() === 0 && !b.gatewaySettleBreakerBlocked(avmKey).blocked, "five withdrawn subcent_quota_exceeded refusals leave the wallet uncounted and unblocked");
    ok(globalFails() === 5, `...and every one still feeds the /v1 global pause (got ${globalFails()})`);
    await finishWith("subcent_quota_exceeded", {}, { global: false });
    ok(walletFails() === 0 && globalFails() === 5, "on the catalog consult (global:false) it records nothing at all");
    const warned = [], warn0 = console.warn;
    console.warn = (...a) => { warned.push(a.join(" ")); };
    try { await finishWith("subcent_quota_exceeded"); } finally { console.warn = warn0; }
    ok(b.gatewaySettleBreakerGlobalPaused().paused, "the sixth trips the global pause (GLOBAL_MAX 6): the backstop for requests already in flight");
    const pauseLine = warned.find((l) => /pausing every \/v1 tier/.test(l)) || "";
    ok(/from 0 buyer\(s\), 6 withdrawn sub-cent refusal\(s\) inside/.test(pauseLine) && !/different buyers/.test(pauseLine), `the pause line says what it counted - withdrawn refusals, not six buyers (${pauseLine.slice(0, 90)})`);
    // The global pause counts distinct buyers; a withdrawn refusal is recorded
    // with no key, so each one still counts on its own - also in the real
    // arming order (the catalog consult first, then the /v1 handler's own,
    // which upgrades the listener) and from ONE buyer's requests.
    b._gatewaySettleBreakerReset();
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
    ok(walletFails() === 0 && globalFails() === 3, `one buyer's three withdrawn refusals, catalog consult first: off the wallet, and each still counts toward the /v1 global pause (wallet ${walletFails()}, global ${globalFails()})`);
    b._gatewaySettleBreakerReset();
    b.recordGatewaySettleFailure(avmKey);
    await finishWith("subcent_quota_exceeded");
    ok(walletFails() === 1, "a withdrawn refusal does not CLEAR a real earlier failure either");

    // Paused, but the refusal is NOT one this gate withdraws: each counts.
    // (a) a payment verdict whose message merely names the allowance;
    b._gatewaySettleBreakerReset();
    await finishWith("transaction_failed", { errorMessage: "simulate failed: subcent_quota_exceeded" });
    await finishWith("insufficient_funds", { errorMessage: "subcent_quota_exceeded" });
    ok(walletFails() === 2, `a payment verdict (transaction_failed, insufficient_funds) naming subcent_quota_exceeded in its message counts against the wallet (got ${walletFails()})`);
    // (b) a requirement the gate never withdraws: one cent, or a payTo not paused;
    b._gatewaySettleBreakerReset();
    await finishWith("subcent_quota_exceeded", {}, { paid: CENT });
    await finishWith("subcent_quota_exceeded", {}, { paid: { ...SUB, payTo: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" } });
    ok(walletFails() === 2, `a one-cent requirement, and a sub-cent one paid to a payTo that is not paused, each count (got ${walletFails()})`);
    // (c) a route whose ONLY accept is the paused one: the never-empty rule
    // keeps it in the next 402, so nothing closes the loop - bounded per buyer.
    b._gatewaySettleBreakerReset();
    for (let i = 0; i < 3; i++) await finishWith("subcent_quota_exceeded", {}, { offered: [SUB] });
    let err = await nextCall();
    ok(walletFails() === 3 && err?.statusCode === 429, `an Algorand-only route: its refusals are not exempt (nothing was withdrawn), so three count and the fourth call is refused 429 (got ${err?.statusCode})`);
    ok(/billing limit on this server's own account/.test(err?.message || ""), "...and that 429 names the facilitator's billing limit");

    // Installed, but no payTo paused right now (the refusal hook never flipped
    // it, or the evidence went stale): the offer is still out, so it counts.
    s._resetAvmSponsorshipForTest({ logger: () => {}, installed: true });
    b._gatewaySettleBreakerReset();
    await finishWith("subcent_quota_exceeded");
    ok(walletFails() === 1, "installed but nothing paused: the refusal counts against the wallet");

    // AVM_SUBCENT_GATE=off: the escape hatch withdraws nothing, so nothing is exempt.
    b._gatewaySettleBreakerReset();
    s.noteSponsorshipStatus(PAYTO, { chain: "algorand", usedMonth: 1013, quota: 1000, suBalance: 0 });
    process.env.AVM_SUBCENT_GATE = "off";
    for (let i = 0; i < 3; i++) await finishWith("subcent_quota_exceeded");
    err = await nextCall();
    ok(walletFails() === 3 && err?.statusCode === 429, `AVM_SUBCENT_GATE=off: three refusals count and the fourth call is refused 429, never served free without bound (got ${err?.statusCode})`);
    ok(/billing limit on this server's own account/.test(err?.message || "") && /not because of the wallet/.test(err?.message || "") && !/USDC balance/.test(err?.message || ""), `...and the 429 names the facilitator's billing limit, not the wallet's balance (got: ${String(err?.message).slice(0, 120)})`);
    delete process.env.AVM_SUBCENT_GATE;

    // Paused, but a subcent refusal on ANOTHER network is not withdrawn by this gate.
    b._gatewaySettleBreakerReset();
    pause();
    await finishWith("subcent_quota_exceeded", { network: "eip155:43114" });
    ok(walletFails() === 1, "the same reason on a non-Algorand network counts");

    // Every other billing shape counts per wallet AND globally, as before.
    b._gatewaySettleBreakerReset();
    await finishWith("free_tier_exhausted", { network: "eip155:43114" });
    await finishWith("unexpected_settle_error", { network: "eip155:1329", errorMessage: "Facilitator settle failed (403): payment required: buy more credits" });
    ok(walletFails() === 2 && globalFails() === 1, `free_tier_exhausted and a credits wall named only in errorMessage count per wallet and globally (wallet ${walletFails()}; global ${globalFails()}: one buyer, counted once)`);
    await finishWith("transaction_failed", { network: "eip155:43114", errorMessage: "rpc quota exceeded" });
    err = await nextCall();
    ok(err?.statusCode === 429 && /2 of them were a facilitator billing refusal/.test(err?.message || "") && /USDC balance/.test(err?.message || ""), `a mixed window names the billing share and still points at the wallet for the rest - transaction_failed is a payment verdict, whatever its message says (got: ${String(err?.message).slice(0, 160)})`);

    // Control: a buyer-side reason on the same 402 shape counts, and three trip the 429 as before.
    b._gatewaySettleBreakerReset();
    for (let i = 0; i < 3; i++) await finishWith("insufficient_funds");
    err = await nextCall();
    ok(err?.statusCode === 429 && /failed to settle/.test(err?.message || "") && /USDC balance/.test(err?.message || "") && !/billing/.test(err?.message || ""), `three genuine failures (insufficient_funds) trip the 429 exactly as before (got ${err?.statusCode})`);
    b._gatewaySettleBreakerReset();
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
    return after[0] === "gatewaySettleBreakerCheck(req);";
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
  b._gatewaySettleBreakerReset();
  const failOnce = (consults) => {
    const req = fakeReq({ from: ADDR });
    for (const g of consults) b.armGatewaySettleBreaker(req, "0xscope", { global: g });
    req.res.statusCode = 402;
    req.res.emit("finish");
  };
  failOnce([false]);
  ok(b.gatewaySettleBreakerStatus().globalFailsInWindow === 0, "a catalog-only consult (global:false) feeds nothing global");
  failOnce([false, true]);
  ok(b.gatewaySettleBreakerStatus().globalFailsInWindow === 1, "catalog consult first, /v1 consult second: the failure reaches the global count");
  ok(b.gatewaySettleBreakerBlocked("0xscope").fails === 2, "one listener per request: two requests, two wallet failures, none double-counted");
  b._gatewaySettleBreakerReset();
  const req = fakeReq({ from: ADDR });
  b.armGatewaySettleBreaker(req, "0xscope2", { global: true });
  b.armGatewaySettleBreaker(req, "0xscope2", { global: false });
  req.res.statusCode = 402;
  req.res.emit("finish");
  ok(b.gatewaySettleBreakerStatus().globalFailsInWindow === 1, "a later global:false consult never downgrades an armed global listener");
  b._gatewaySettleBreakerReset();
}

// --- the global pause counts BUYERS, not failures --------------------------------
// The per-key check runs before any of a burst's failures lands, so one wallet
// firing concurrent calls could otherwise supply the whole global count alone
// and pause every /v1 buyer. (The HTTP twin, a real concurrent burst through a
// booted paid server, is in scripts/test-paid-settle-breaker.js.)
{
  b._gatewaySettleBreakerReset();
  for (let i = 0; i < 20; i++) b.recordGatewaySettleFailure("0xoneburstwallet");
  const st = b.gatewaySettleBreakerStatus();
  ok(!st.globalPaused && st.globalFailsInWindow === 1, `twenty failures from ONE buyer count once toward the global pause and never trip it (distinct ${st.globalFailsInWindow}, GLOBAL_MAX 6)`);
  ok(b.gatewaySettleBreakerBlocked("0xoneburstwallet").blocked, "...that buyer is the per-key bound's job, and it is blocked");
  for (let i = 1; i <= 4; i++) b.recordGatewaySettleFailure(`0xotherbuyer${i}`);
  ok(!b.gatewaySettleBreakerGlobalPaused().paused && b.gatewaySettleBreakerStatus().globalFailsInWindow === 5, "five different buyers: still below the threshold of six");
  b.recordGatewaySettleFailure("0xotherbuyer5");
  ok(b.gatewaySettleBreakerGlobalPaused().paused, "the sixth DIFFERENT buyer trips the pause (wallet rotation is what the pause is for)");
  b._gatewaySettleBreakerReset();
  b.recordGatewaySettleFailure(null); b.recordGatewaySettleFailure(null);
  ok(b.gatewaySettleBreakerStatus().globalFailsInWindow === 2, "a failure with no key to count it under counts as its own buyer (never merged into one)");
  b._gatewaySettleBreakerReset();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
