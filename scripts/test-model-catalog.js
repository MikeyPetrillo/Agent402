#!/usr/bin/env node
// The metered chat route refuses a model id the upstream's live list does not
// carry BEFORE any payment gate (src/model-catalog.js; server.js mounts the
// check ahead of the gates), and fails open with no fresh list.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePorts } from "./lib/free-port.js";
import { refreshModelCatalog, unknownModelRefusal, _setModelCatalogForTest, modelCatalogWanted } from "../src/model-catalog.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const LISTED = ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4", "deepseek/deepseek-chat-v3.1", "openai/gpt-4o-mini", "anthropic/claude-opus-5", "openai/gpt-3.5-turbo-0613", "openai/gpt-4"];
for (let i = 0; i < 120; i++) LISTED.push(`filler/model-${i}`);
const BAD = "deepseek/deepseek-v4-1-flash-1017-uncensored";

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

delete process.env.MODEL_CATALOG_URL;
// --- the route: refused before the payment gate -----------------------------
const [FAC_PORT, CAT_PORT, PORT] = await getFreePorts(3);
const fac = createServer((req, res) => {
  res.writeHead(req.url === "/supported" ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(req.url === "/supported" ? { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} } : {}));
});
let catalogReads = 0;
const cat = createServer((req, res) => { catalogReads++; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: LISTED.map((id) => ({ id })) })); });
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
  },
  stdio: ["ignore", "ignore", "pipe"],
});
const errTail = [];
proc.stderr.on("data", (c) => { errTail.push(String(c)); if (errTail.length > 40) errTail.shift(); });
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
  const post = (model) => fetch(`${B}/v1/metered/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 5 }) });
  const r1 = await post(BAD);
  const j1 = await r1.json().catch(() => ({}));
  ok(r1.status === 400 && !r1.headers.get("payment-required") && j1?.error?.code === "unknown_model" && /deepseek-v4-flash/.test(j1?.error?.message || ""),
    `an unlisted id is a 400 before the gate: no PAYMENT-REQUIRED offer, the error names listed ids (${r1.status} ${JSON.stringify(j1).slice(0, 200)})`);
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
