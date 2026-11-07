#!/usr/bin/env node
// The metered chat route refuses a model id the upstream's live list does not
// carry BEFORE any payment gate (src/model-catalog.js; server.js mounts the
// check ahead of the gates), and fails open with no fresh list.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePorts } from "./lib/free-port.js";
import { refreshModelCatalog, unknownModelRefusal, isListedModel, contextTokensOf, _setModelCatalogForTest, modelCatalogWanted } from "../src/model-catalog.js";
import { createPrePaymentRefusalRecorder } from "../src/prepayment-refusal.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const LISTED = ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4", "deepseek/deepseek-chat-v3.1", "openai/gpt-4o-mini", "anthropic/claude-opus-5", "openai/gpt-3.5-turbo-0613", "openai/gpt-4"];
for (let i = 0; i < 120; i++) LISTED.push(`filler/model-${i}`);
const BAD = "deepseek/deepseek-v4-1-flash-1017-uncensored";
const DOTTED = "deepseek/deepseek-v4.1-flash-1017";
// Context windows (tokens) the stub list states for a few ids.
const CTX = { [DOTTED]: 1_048_576, "deepseek/deepseek-v4-flash": 1_048_576, "openai/gpt-4o-mini": 128_000, "deepseek/deepseek-chat-v3.1": 163_840 };

// --- unit -------------------------------------------------------------------
// Offline: a miss-triggered read goes to a closed local port unless stubbed.
process.env.MODEL_CATALOG_URL = "http://127.0.0.1:9/api/v1/models";
{
  _setModelCatalogForTest(null);
  ok(unknownModelRefusal(BAD) === null, "no list read yet: nothing is refused (fail open)");
  _setModelCatalogForTest(LISTED, Date.now() - 31 * 60_000);
  ok(unknownModelRefusal(BAD) === null, "a list older than 30 minutes judges nothing (fail open)");
  _setModelCatalogForTest(LISTED, Date.now() - 29 * 60_000);
  ok(unknownModelRefusal(BAD, { refreshOnMiss: false }) !== null, "a list 29 minutes old still judges");
  _setModelCatalogForTest(LISTED);
  const r = unknownModelRefusal(BAD);
  ok(typeof r === "string" && r.includes(BAD) && /Nothing was charged/.test(r), "an unlisted id is refused, naming it and that nothing was charged");
  ok(/deepseek\/deepseek-v4-flash/.test(r) && !/filler/.test(r), `the refusal names listed ids from the same vendor only (${r})`);
  ok(unknownModelRefusal("deepseek/deepseek-v4-flash") === null, "a listed id passes");
  ok(unknownModelRefusal("openai/gpt-4o-mini:nitro") === null, "a routing variant is judged by its base id");
  ok(unknownModelRefusal("OpenAI/GPT-4o-mini") === null, "ids compare without case");
  ok(!/deepseek-chat-v3\.1/.test(unknownModelRefusal(BAD, { suggest: (x) => x !== "deepseek/deepseek-chat-v3.1" })), "suggestions keep only ids the route serves");
  ok(/include: deepseek\/deepseek-v4-flash/.test(unknownModelRefusal(BAD)), `the closest id is named first (${unknownModelRefusal(BAD)})`);
  // A miss starts a fresh read (at most once a minute), so a just-listed model is served soon.
  {
    let reads = 0;
    await sleep(100); // any earlier miss-triggered read (to the closed port) has ended
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { reads++; return new Response(JSON.stringify({ data: [...LISTED, "deepseek/deepseek-v5"].map((id) => ({ id })) }), { status: 200 }); };
    try {
      _setModelCatalogForTest(LISTED);
      ok(unknownModelRefusal("deepseek/deepseek-v5") !== null, "a model newer than the last read is refused once");
      await new Promise((r) => setTimeout(r, 50));
      ok(reads === 1 && unknownModelRefusal("deepseek/deepseek-v5") === null, `the miss started a read and the new model passes after it (reads ${reads})`);
      unknownModelRefusal("deepseek/never-listed"); unknownModelRefusal("deepseek/never-listed-2");
      await new Promise((r) => setTimeout(r, 50));
      ok(reads === 1, `two more misses inside the minute start no read (reads ${reads})`);
    } finally { globalThis.fetch = realFetch; _setModelCatalogForTest(LISTED); }
  }
  process.env.OPENROUTER_API_KEY ||= "test-key-never-used";
  const { validateRequest, meteredModelRefusal, RETIRING_MODELS } = await import("../src/tools/llm-gateway-kit.js");
  ok(meteredModelRefusal("auto") === null && meteredModelRefusal("default") === null, "ids with no vendor keep their own answers");
  const retiring = Object.keys(RETIRING_MODELS || {})[0];
  ok(!retiring || meteredModelRefusal(retiring) === null, `a retiring id is left to its own fallback even when unlisted (${retiring})`);
  const sug = meteredModelRefusal("openai/gpt-not-a-model-xyz") || "";
  ok(!/gpt-3\.5|gpt-4,|gpt-4\./.test(sug), `suggestions are ids the metered route serves (${sug.slice(0, 200)})`);
  const body = (model) => ({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
  let e = null; try { validateRequest(body(BAD), "v1-chat-metered", { clamp: false }); } catch (x) { e = x; }
  ok(e?.statusCode === 400 && e?.code === "unknown_model", "the metered handler's own validation refuses the unlisted id too (a request past the gate, e.g. a Tempo push)");
  e = null; try { validateRequest(body("deepseek/deepseek-v4-flash"), "v1-chat-metered", { clamp: false }); } catch (x) { e = x; }
  ok(e?.code !== "unknown_model", `a listed id passes the handler's validation (${e?.message || "ok"})`);
  const small = await refreshModelCatalog({ fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "a/b" }] }), { status: 200 }) });
  ok(small === false && unknownModelRefusal(BAD) !== null, "an implausibly small list is a failed read and keeps the last good one");
  const down = await refreshModelCatalog({ fetchImpl: async () => { throw new Error("egress down"); } });
  ok(down === false && unknownModelRefusal(BAD) !== null, "an unreadable list keeps the last good one while it is fresh");

  // An id with a same-family successor is left to its fallback even when unlisted.
  const { AVAILABILITY_SUCCESSORS } = await import("../src/tools/llm-gateway-kit.js");
  const withSuccessor = Object.keys(AVAILABILITY_SUCCESSORS || {})[0];
  ok(!!withSuccessor && unknownModelRefusal(withSuccessor, { refreshOnMiss: false }) !== null && meteredModelRefusal(withSuccessor) === null, `an id with a successor is not refused before payment though unlisted (${withSuccessor})`);
  // Closest suggestion first; wording; the echoed id is bounded.
  _setModelCatalogForTest([...LISTED, "anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"]);
  ok(/include: anthropic\/claude-sonnet-5,/.test(unknownModelRefusal("anthropic/claude-sonet-5", { refreshOnMiss: false })), `the nearest id is named first (${unknownModelRefusal("anthropic/claude-sonet-5", { refreshOnMiss: false })})`);
  ok(/not a chat model id/.test(unknownModelRefusal(BAD, { refreshOnMiss: false })), "the refusal says chat model (an embedding or speech id is served elsewhere)");
  ok(unknownModelRefusal("x/" + "a".repeat(100_000), { refreshOnMiss: false }).length < 600, "a huge model id is not echoed back whole");
  // After a failed read, a miss starts no read until the refresh interval passes.
  {
    let reads = 0;
    await sleep(100);
    _setModelCatalogForTest(LISTED);
    await refreshModelCatalog({ fetchImpl: async () => { throw new Error("down"); } });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { reads++; return new Response("{}", { status: 503 }); };
    try {
      unknownModelRefusal("deepseek/miss-after-failure");
      await sleep(50);
      ok(reads === 0, `a miss right after a failed read starts no read (reads ${reads})`);
    } finally { globalThis.fetch = realFetch; _setModelCatalogForTest(LISTED); }
  }
  // Read in production only (or against a stub).
  ok(modelCatalogWanted({}) === false && modelCatalogWanted({ OPENROUTER_API_KEY: "k" }) === false && modelCatalogWanted({ OPENROUTER_API_KEY: "k", NODE_ENV: "production" }) === true
    && modelCatalogWanted({ OPENROUTER_API_KEY: "k", RAILWAY_ENVIRONMENT_NAME: "production", X402_SYNC_ON_START: "false" }) === false && modelCatalogWanted({ MODEL_CATALOG_URL: "http://x" }) === true,
    "the list is read only in production with a key, or from a stub");
  // The read is not counted in the upstream health lane.
  {
    const { createToolFailureMonitor } = await import("../src/tool-failure-monitor.js");
    const m = createToolFailureMonitor({ env: {} });
    const seen = [];
    m.observeFetch("openrouter.ai", { then: (f) => { seen.push("then"); } }, { [Symbol.for("agent402.noOutcome")]: true }, "background");
    m.observeFetch("openrouter.ai", { then: (f) => { seen.push("then"); } }, {}, "background");
    await sleep(10);
    ok(seen.length === 1, `a model-list read is skipped by the upstream monitor; a chat call is counted (${seen.length})`);
  }
}

// --- model id help: hyphenated versions, suggestions, input size -------------
{
  const k = await import("../src/tools/llm-gateway-kit.js");
  const { canonicalModel, meteredModelVerdict, validateRequest, maxInputCharsFor, meteredInputSizeRefusal, TIERS, METERED_MAX_INPUT_CHARS_CEILING } = k;
  _setModelCatalogForTest([...LISTED, DOTTED, "deepseek/deepseek-v4.1-flash"], Date.now(), CTX);
  ok(canonicalModel("deepseek/deepseek-v4-1-flash-1017") === DOTTED, `a hyphenated version serves its dotted id when that id is listed (${canonicalModel("deepseek/deepseek-v4-1-flash-1017")})`);
  ok(canonicalModel("deepseek-v4-1-flash-1017") === DOTTED && canonicalModel("deepseek/deepseek-v4-1-flash-1017:nitro") === `${DOTTED}:nitro`, "a bare vendor id and a routing variant map the same way");
  ok(canonicalModel(BAD) === BAD, `an id with an unlisted suffix is left as sent, never mapped to a different model (${canonicalModel(BAD)})`);
  ok(canonicalModel("openai/gpt-4o-2024-11-20") === "openai/gpt-4o-2024-11-20", "a dated id whose dotted form is not listed is unchanged");
  ok(canonicalModel("deepseek/deepseek-v4-flash") === "deepseek/deepseek-v4-flash", "a listed id is never rewritten");
  let e = null; try { validateRequest({ model: "deepseek/deepseek-v4-1-flash-1017", messages: [{ role: "user", content: "hi" }], max_tokens: 5 }, "v1-chat-metered", { clamp: false }); } catch (x) { e = x; }
  ok(e?.code !== "unknown_model", `the hyphenated id passes the metered validation (${e?.message || "ok"})`);
  const v = meteredModelVerdict(canonicalModel(BAD));
  ok(v && v.suggestions[0] === DOTTED && v.suggestions.length <= 3, `the unlisted suffix is refused with ${DOTTED} first (${JSON.stringify(v?.suggestions)})`);
  e = null; try { validateRequest({ model: BAD, messages: [{ role: "user", content: "hi" }], max_tokens: 5 }, "v1-chat-metered", { clamp: false }); } catch (x) { e = x; }
  ok(e?.code === "unknown_model" && e?.suggestions?.[0] === DOTTED, "the handler's own refusal carries the same suggestions");
  const u = meteredModelVerdict("openai/gpt-4o-mni");
  ok(u && u.suggestions[0] === "openai/gpt-4o-mini" && u.suggestions.every((x) => x.startsWith("openai/")), `an unrelated typo gets same-vendor suggestions, closest first (${JSON.stringify(u?.suggestions)})`);
  _setModelCatalogForTest(null);
  ok(canonicalModel("deepseek/deepseek-v4-1-flash-1017") === "deepseek/deepseek-v4-1-flash-1017", "with no fresh list nothing is mapped");
  ok(maxInputCharsFor("v1-chat-metered", DOTTED) === TIERS["v1-chat-metered"].maxInputChars, "with no fresh list every model keeps the floor cap");
  _setModelCatalogForTest([...LISTED, DOTTED], Date.now(), CTX);
  const floor = TIERS["v1-chat-metered"].maxInputChars;
  ok(maxInputCharsFor("v1-chat-metered", DOTTED) === METERED_MAX_INPUT_CHARS_CEILING && maxInputCharsFor("v1-chat-metered", "openai/gpt-4o-mini") === 384_000 && maxInputCharsFor("v1-chat-metered", "qwen/unknown") === floor,
    "a larger window raises the model's cap (3 chars per token, to the 1 MB body bound); an unknown window keeps the floor");
  ok(maxInputCharsFor("v1-chat", DOTTED) === TIERS["v1-chat"].maxInputChars, "a flat tier's cap does not move");
  const body = (model, n) => ({ model, messages: [{ role: "user", content: "x".repeat(n) }], max_tokens: 5 });
  ok(meteredInputSizeRefusal(body(DOTTED, 350_000)) === null, "a 350k-char input to a 1M-token model is accepted");
  e = null; try { validateRequest(body(DOTTED, 350_000), "v1-chat-metered", { clamp: false }); } catch (x) { e = x; }
  ok(!e || !/too large/i.test(e.message), `the handler accepts it too (${e?.message || "ok"})`);
  const big = meteredInputSizeRefusal(body("openai/gpt-4o-mini", 400_000));
  ok(big && big.maxInputChars === 384_000 && big.inputChars === 400_000 && big.hint === "trim-input" && /Trim older turns/.test(big.message) && /Nothing was charged/.test(big.message),
    `an input over the model's cap names the cap, the size read and a hint (${big?.message})`);
  ok(big?.suggestions?.length >= 1 && big.suggestions.every((x) => (contextTokensOf(x) || 0) * 3 >= 400_000), `its suggestions are models whose window takes the input (${JSON.stringify(big?.suggestions)})`);
  e = null; try { validateRequest(body("openai/gpt-4o-mini", 400_000), "v1-chat-metered", { clamp: false }); } catch (x) { e = x; }
  ok(e?.statusCode === 400 && e?.maxInputChars === 384_000 && e?.inputChars === 400_000, "the handler's own size refusal carries the same fields");
  ok(meteredInputSizeRefusal(body("openai/gpt-4o-mini", 300_000)) === null, "under the model's own cap is accepted");
  const huge = meteredInputSizeRefusal(body(DOTTED, METERED_MAX_INPUT_CHARS_CEILING + 1));
  ok(huge && !huge.suggestions && huge.maxInputChars === METERED_MAX_INPUT_CHARS_CEILING, "past the ceiling no model is suggested");
  ok(isListedModel(DOTTED) && !isListedModel(BAD), "isListedModel reads the fresh list");
  // The recorder: one log line, one tool_calls row, one PostHog call, all marked pre-payment.
  const calls = { log: [], row: [], ph: [] };
  const rec = createPrePaymentRefusalRecorder({
    logToolError: (...a) => calls.log.push(a), recordToolCall: async (r) => { calls.row.push(r); }, captureToolCall: (r) => calls.ph.push(r),
    isSynthetic: () => false, requestShape: () => ["b:model", "b:messages"], refusalReason: () => "unknown_model",
  });
  rec({}, "v1-chat-metered", 400, "Model x refused");
  ok(calls.log.length === 1 && calls.log[0][6]?.prePayment === true && calls.log[0][0] === "v1-chat-metered" && calls.log[0][1] === 400, "the recorder writes the [tool-error] line marked pre-payment");
  ok(calls.row.length === 1 && calls.row[0].prePayment === true && calls.row[0].errored === true && calls.row[0].status === 400, "the recorder writes the tool_calls row marked pre-payment");
  ok(calls.ph.length === 1 && calls.ph[0].prePayment === true && calls.ph[0].refusalReason === "unknown_model", "the recorder sends the PostHog tool_call marked pre-payment with its class");
  const boom = createPrePaymentRefusalRecorder({ logToolError: () => { throw new Error("x"); }, recordToolCall: async () => {}, captureToolCall: () => {}, isSynthetic: () => false, requestShape: () => [] });
  let threw = false; try { boom({}, "s", 400, "m"); } catch { threw = true; }
  ok(!threw, "a failing log never breaks the response");
  _setModelCatalogForTest(LISTED);
}

delete process.env.MODEL_CATALOG_URL;
// --- the route: refused before the payment gate -----------------------------
const [FAC_PORT, CAT_PORT, PORT] = await getFreePorts(3);
const fac = createServer((req, res) => {
  res.writeHead(req.url === "/supported" ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(req.url === "/supported" ? { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} } : {}));
});
let catalogReads = 0;
const cat = createServer((req, res) => { catalogReads++; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [...LISTED, DOTTED].map((id) => ({ id, ...(CTX[id] ? { context_length: CTX[id] } : {}) })) })); });
await new Promise((r) => fac.listen(FAC_PORT, "127.0.0.1", r));
await new Promise((r) => cat.listen(CAT_PORT, "127.0.0.1", r));
const TMP = mkdtempSync(join(tmpdir(), "model-catalog-"));
const proc = spawn(process.execPath, ["src/server.js"], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "", TARGET_URL: "", BASE_URL: "http://agent402.test",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "",
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "test-key-never-used",
    MODEL_CATALOG_URL: `http://127.0.0.1:${CAT_PORT}/api/v1/models`,
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    STATS_ALLOW_EPHEMERAL: "true", DECIDE_LEDGER_DB: join(TMP, "decide.db"),
    AGENT402_TASK_DATA_DIR: join(TMP, "tasks"), REFUND_DB_DIR: TMP, SALES_LEDGER_DB: join(TMP, "sales.db"), HANGUP_FORGIVE_FILE: join(TMP, "hangup.json"),
    POSTHOG_TEST_CAPTURE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const errTail = [];
let logAll = "";
proc.stderr.on("data", (c) => { logAll += String(c); errTail.push(String(c)); if (errTail.length > 40) errTail.shift(); });
proc.stdout.on("data", (c) => { logAll += String(c); });
const PROMPT_MARK = "PROMPT-TEXT-MUST-NOT-BE-LOGGED";
const B = `http://127.0.0.1:${PORT}`;
try {
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch {} if (!up) await sleep(500); }
  if (!up) throw new Error(`server did not boot: ${errTail.join("").slice(-800)}`);
  // The x402 gate answers 402s once it has read the facilitator's /supported.
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) { ready = (await fetch(`${B}/api/search?q=x`)).status === 402; if (!ready) await sleep(250); }
  if (!ready) throw new Error("the x402 gate never answered a 402");
  for (let i = 0; i < 40 && !catalogReads; i++) await sleep(100);
  await sleep(200);
  ok(catalogReads >= 1, "the server read the live list at boot");
  const post = (model, content = `hi ${PROMPT_MARK}`) => fetch(`${B}/v1/metered/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: 5 }) });
  const logBefore = logAll.length;
  const r1 = await post(BAD);
  const j1 = await r1.json().catch(() => ({}));
  ok(r1.status === 400 && !r1.headers.get("payment-required") && j1?.error?.code === "unknown_model" && /deepseek-v4-flash/.test(j1?.error?.message || ""),
    `an unlisted id is a 400 before the gate: no PAYMENT-REQUIRED offer, the error names listed ids (${r1.status} ${JSON.stringify(j1).slice(0, 200)})`);
  ok(j1?.suggestions?.[0] === DOTTED && j1?.error?.suggestions?.[0] === DOTTED && j1.suggestions.length <= 3, `the refusal carries machine-readable suggestions, closest first (${JSON.stringify(j1?.suggestions)})`);
  ok(j1?.howToCall?.method === "POST" && /\/v1\/metered\/chat\/completions$/.test(j1?.howToCall?.url || "") && j1?.howToCall?.body?.model === DOTTED, `its howToCall retries with the first suggestion (${JSON.stringify(j1?.howToCall)})`);
  await sleep(150);
  const seen1 = logAll.slice(logBefore);
  ok(/\[tool-error\] 4xx slug=v1-chat-metered status=400 shape=\[b:model,b:messages,b:max_tokens\] prepay=true msg=Model "deepseek\/deepseek-v4-1-flash-1017-uncensored" is not a chat model id/.test(seen1), "the pre-payment refusal writes the [tool-error] line marked prepay=true");
  ok(/\[posthog-test\] .*"event":"tool_error".*"slug":"v1-chat-metered".*"prePayment":true/.test(seen1) && /\[posthog-test\] .*"event":"tool_call".*"status":400.*"refusalReason":"unknown_model".*"prePayment":true/.test(seen1),
    "the pre-payment refusal sends the PostHog tool_error and tool_call events marked pre-payment");
  ok(!seen1.includes(PROMPT_MARK), "no prompt text reaches the log or the events");
  const r5 = await post("deepseek/deepseek-v4-1-flash-1017");
  ok(r5.status === 402 && !!r5.headers.get("payment-required"), `the hyphenated version gets its 402 offer for the dotted id (${r5.status})`);
  const logBefore2 = logAll.length;
  const r6 = await post("openai/gpt-4o-mini", `${PROMPT_MARK} ${"x".repeat(400_000)}`);
  const j6 = await r6.json().catch(() => ({}));
  ok(r6.status === 400 && !r6.headers.get("payment-required") && j6?.error?.code === "input_too_large" && j6?.maxInputChars === 384_000 && j6?.inputChars > 400_000 && j6?.hint === "trim-input" && Array.isArray(j6?.suggestions) && j6.suggestions.length >= 1,
    `an input over the model's cap is a 400 before the gate with the cap, the size and suggestions (${r6.status} ${JSON.stringify({ ...j6, error: undefined }).slice(0, 300)})`);
  await sleep(150);
  const seen2 = logAll.slice(logBefore2);
  ok(/\[tool-error\] 4xx slug=v1-chat-metered status=400 .*prepay=true msg=Input too large/.test(seen2) && !seen2.includes(PROMPT_MARK), "the size refusal is logged pre-payment, with no prompt text");
  const r7 = await post(DOTTED, "x".repeat(350_000));
  ok(r7.status === 402 && !!r7.headers.get("payment-required"), `a 350k-char input to a 1M-token model gets its 402 quote (${r7.status})`);
  const r2 = await post("deepseek/deepseek-v4-flash");
  ok(r2.status === 402 && !!r2.headers.get("payment-required"), `a listed id still gets its 402 offer (${r2.status} ${(await r2.text()).slice(0, 300)})`);
  const r3 = await fetch(`${B}/v1/metered/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { model: BAD, messages: [{ role: "user", content: "hi" }] } }) });
  ok(r3.status === 400, `an id inside an {input:{...}} envelope is read the same way (${r3.status})`);
  const r4 = await fetch(`${B}/V1/metered/chat/completions/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: BAD, messages: [{ role: "user", content: "hi" }] }) });
  ok(r4.status === 400 && !r4.headers.get("payment-required"), `a case or trailing-slash variant of the path is checked the same way (${r4.status})`);
} catch (e) {
  fail++; console.log(`FAIL - ${e.message}`);
} finally {
  if (fail) console.log(errTail.join("").slice(-3000));
  proc.kill("SIGKILL"); fac.close(); cat.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
