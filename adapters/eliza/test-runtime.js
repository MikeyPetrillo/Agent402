// elizaos-plugin-agent402 against a REAL elizaOS runtime (the registry review
// of 2026-09-14 asked for exactly this, and it is right that a stub runtime
// proves nothing about the host):
//
//   npm pack (THIS package, the artifact npm installs) + @elizaos/core,
//   @elizaos/plugin-sql (PGlite) and @elizaos/plugin-bootstrap at the versions
//   the registry's runtime resolves to -> a real AgentRuntime, initialized,
//   migrations run -> runtime.processActions() is the dispatcher, exactly as
//   the message pipeline calls it after the planner picks an action.
//
// What is stubbed, and why: the MODEL (CI has no LLM, so the runtime's
// OBJECT_SMALL/TEXT_SMALL handlers are a fixed function that reads the
// extraction prompt and answers in the shape the real model would) and the
// SELLER (a local HTTP stub answering the Agent402 wire: /api/pricing,
// /api/find, a free tool, a $0.003 wallet-only tool paid by credits key, a tool
// that fails with a long error, a tool with a 60 KB answer). Controlled
// transport, no network past the npm install, no wallet, nothing paid.
// Everything between the planner's decision and the tool's answer is the real
// runtime.
//
// Evidence produced (each is an assertion below):
//   1. the ACTIONS provider LISTS AGENT402_CALL for a plain user message - the
//      planner can pick it (validate no longer demands content.slug);
//   2. a normal planner->AGENT402_CALL invocation with NO slug in the message:
//      the handler searches the catalog, asks the runtime's model to pick the
//      tool and shape the input, pays the free tier with proof-of-work, and the
//      sha256 digest comes back;
//   3. the COMPLETE result reaches the model-facing text (the ACTION_STATE
//      provider renders result.text, never result.data) - proven by rendering
//      that provider on the runtime's own action results;
//   4. spend ceilings hold ACROSS calls in one runtime, sequential AND
//      concurrent: a $0.003 tool under a $0.005 daily limit settles once and
//      every later call is refused before any request leaves the process (the
//      stub counts one paid call); four fired at once also settle exactly one;
//      the per-call ceiling refuses with zero requests; ceilings are RUNTIME-
//      SCOPED (two runtimes in one process each enforce their own);
//   5. an upstream error's detail reaches the model whole, and a 60 KB result
//      reaches it whole - no truncation anywhere; with the opt-in bound set, a
//      result over it is an explicit failure carrying the whole result in
//      data.result, never a partial text;
//   6. failures are TYPED and happen before dispatch: malformed params, an
//      unreadable catalog, no match (data.errorCode), with no request sent;
//   7. the v2 parameter path (options.parameters from the runtime's extractor)
//      is honoured ahead of message content.
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const CORE = process.env.ELIZA_CORE_VERSION || "latest";
const sh = (cmd, opts = {}) => String(execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts }) || "").trim();

// ---- 1. the artifact npm would install, into a scratch host --------------------
const work = process.env.ELIZA_RUNTIME_DIR || join(tmpdir(), `a402-eliza-runtime-${CORE}`);
mkdirSync(work, { recursive: true });
if (!existsSync(join(HERE, "node_modules", "agent402-client"))) sh("npm install ../../client --no-save --silent --ignore-scripts", { cwd: HERE });
const tgz = join(work, sh("npm pack --silent", { cwd: HERE }).split("\n").pop());
sh(`mv ${JSON.stringify(join(HERE, tgz.split("/").pop()))} ${JSON.stringify(tgz)}`);
if (!existsSync(join(work, "package.json"))) writeFileSync(join(work, "package.json"), JSON.stringify({ name: "a402-eliza-host", private: true, type: "module" }));
const want = `@elizaos/core@${CORE} @elizaos/plugin-sql@${CORE} @elizaos/plugin-bootstrap@${CORE}`;
// Decide on the same evidence the reconcile below writes: a work dir left by an
// earlier session can carry node_modules without the elizaOS packages declared
// in its package.json, and the later `npm i` then prunes them (measured
// 2026-09-22: ENOENT on @elizaos/core/package.json after a stale tmpdir).
const declared = (() => { try { return JSON.parse(readFileSync(join(work, "package.json"), "utf8")).dependencies || {}; } catch { return {}; } })();
if (!declared["@elizaos/core"] || !existsSync(join(work, "node_modules", "@elizaos", "plugin-bootstrap"))) {
  console.log(`installing ${want} into ${work} (once; set ELIZA_RUNTIME_DIR to reuse)`);
  sh(`npm i --no-audit --no-fund --ignore-scripts --silent ${want}`, { cwd: work, stdio: ["ignore", "pipe", "inherit"] });
}
// The tgz depends on a published agent402-client range, which is what a user's
// install resolves; CI tests the TREE, so the local client is installed on top
// (the failure-detail case below needs client >= 0.8.4).
sh(`npm i --no-audit --no-fund --ignore-scripts --silent ${JSON.stringify(tgz)} ${JSON.stringify(join(ROOT, "client"))}`, { cwd: work, stdio: ["ignore", "pipe", "inherit"] });
const imp = (m) => import(pathToFileURL(join(work, "node_modules", m, JSON.parse(readFileSync(join(work, "node_modules", m, "package.json"), "utf8")).main || "index.js")).href);
const core = await imp("@elizaos/core");
const sqlMod = await imp("@elizaos/plugin-sql");
const bootstrapMod = await imp("@elizaos/plugin-bootstrap");
const pluginMod = await imp("elizaos-plugin-agent402");
const plugin = pluginMod.default;
const coreVersion = JSON.parse(readFileSync(join(work, "node_modules", "@elizaos", "core", "package.json"), "utf8")).version;
console.log(`@elizaos/core ${coreVersion}; plugin ${pkg.name}@${pkg.version} from ${tgz.split("/").pop()}`);

// ---- 2. the seller: a stub speaking the Agent402 wire (controlled transport) ----
const seen = [];
// Over 2,000 characters ON PURPOSE: agent402-client 0.8.4/0.8.5 cut a seller's
// error detail at 2,000, and this fixture was 706, so "arrives whole" passed
// against a client that cut (elizaOS registry review, 2026-09-16). The tail
// marker is asserted through ACTION_STATE below - what the model reads.
const LONG_ERROR = `The input "q" must name a listed market; none of ${Array.from({ length: 240 }, (_, i) => `market-${i}`).join(", ")} matched. END-OF-SELLER-ERROR`;
if (LONG_ERROR.length <= 2_000) throw new Error(`LONG_ERROR fixture must exceed the former 2,000-char client cap (is ${LONG_ERROR.length})`);
const BIG = { rows: Array.from({ length: 1500 }, (_, i) => ({ i, name: `row-${i}`, note: "x".repeat(24) })) }; // ~60 KB of JSON
const stub = createServer((req, res) => {
  let raw = ""; req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    seen.push({ url: req.url, auth: req.headers.authorization || null });
    const j = (code, body, h = {}) => { res.writeHead(code, { "content-type": "application/json", ...h }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith("/api/pricing")) return j(200, { endpoints: [
      { slug: "hash", method: "POST", path: "/api/hash", price: "$0.001", computePayable: true },
      { slug: "search", method: "POST", path: "/api/search", price: "$0.003", computePayable: false },
      { slug: "broken", method: "POST", path: "/api/broken", price: "$0.002", computePayable: false },
      { slug: "big", method: "POST", path: "/api/big", price: "$0.002", computePayable: false },
    ] });
    if (req.url.startsWith("/api/find")) {
      const q = decodeURIComponent((/[?&]q=([^&]*)/.exec(req.url) || [])[1] || "");
      if (/hash|sha256/i.test(q)) return j(200, { results: [{ slug: "hash", name: "hash", price: "$0.001", route: "POST /api/hash", walletOnly: false, description: "sha256/md5 of a string", example: { text: "hello", algo: "sha256" } }] });
      return j(200, { results: [] });
    }
    // A free (compute-payable) tool answers plainly, as a FREE_MODE Agent402 does.
    if (req.url.startsWith("/api/hash")) { let b = {}; try { b = JSON.parse(raw); } catch {} return j(200, { algo: b.algo || "sha256", hex: createHash(b.algo || "sha256").update(String(b.text ?? "")).digest("hex") }); }
    if (!req.headers.authorization) return j(402, { error: "Payment required", reason: "missing" });
    if (req.url.startsWith("/api/search")) return j(200, { results: [{ title: "x402", url: "https://x402.org" }] }, { "x-credits-balance": "19.997" });
    if (req.url.startsWith("/api/broken")) return j(400, { error: LONG_ERROR });
    if (req.url.startsWith("/api/big")) return j(200, BIG, { "x-credits-balance": "19.998" });
    j(404, { error: "no such tool" });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const STUB = `http://127.0.0.1:${stub.address().port}`;
const BASE = STUB;
const DEAD = "http://127.0.0.1:1"; // nothing listens: the catalog is unreachable
let proc = null;

// ---- 3. a real runtime ------------------------------------------------------------
let pass = 0;
const ok = (c, m) => { if (!c) throw new Error(`FAIL: ${m}`); pass++; console.log(`ok - ${m}`); };
const KEY = "a402_" + "k".repeat(40);
async function bootRuntime(settings) {
  const dataDir = join(work, `pglite-${Math.random().toString(36).slice(2)}`);
  const character = { name: "Probe", bio: ["an agent that buys tools from Agent402"], settings: { PGLITE_DATA_DIR: dataDir, ...settings } };
  const runtime = new core.AgentRuntime({ character, plugins: [sqlMod.default, bootstrapMod.default, plugin] });
  // Core tables come from plugin-sql's migrations, which initialize() runs
  // AFTER ensureAgentExists; the CLI runs them first, and so does this.
  const adapter = sqlMod.createDatabaseAdapter({ dataDir }, runtime.agentId);
  await adapter.init();
  await adapter.runPluginMigrations([{ name: "@elizaos/plugin-sql", schema: sqlMod.default.schema }], { verbose: false, force: false, dryRun: false });
  runtime.registerDatabaseAdapter(adapter);
  // THE STUB MODEL: reads the extraction prompt the plugin sends and answers as
  // the real model would - picks the first offered candidate and shapes the
  // input from the request text. Deterministic so CI can assert on it.
  const prompts = [];
  const extract = async (_rt, params) => {
    const prompt = String(params?.prompt || "");
    prompts.push(prompt);
    const req = /User request: ("(?:[^"\\]|\\.)*")/.exec(prompt);
    const menu = /Candidate tools[^\n]*\n([\s\S]*?)\nRespond with ONLY/.exec(prompt);
    if (!req || !menu) return { slug: null, reason: "stub model: prompt shape not recognised" };
    const text = JSON.parse(req[1]);
    const cands = JSON.parse(menu[1]);
    const quoted = /'([^']+)'/.exec(text)?.[1];
    const pick = cands[0];
    if (pick.slug === "hash") return { slug: "hash", params: { text: quoted, algo: "sha256" } };
    return { slug: pick.slug, params: pick.example || {} };
  };
  for (const t of ["OBJECT_SMALL", "OBJECT_LARGE", "TEXT_SMALL", "TEXT_LARGE"]) runtime.registerModel(t, extract, "test-stub-model", 1000);
  runtime.registerModel("TEXT_EMBEDDING", async () => new Array(384).fill(0), "test-stub-model", 1000);
  await runtime.initialize();
  return { runtime, prompts };
}
const ids = (n) => core.stringToUuid(`a402-runtime-test-${n}`);
async function seed(runtime, roomTag) {
  const roomId = ids(`room-${roomTag}`), userId = ids(`user-${roomTag}`), worldId = ids(`world-${roomTag}`);
  await runtime.ensureConnection({ entityId: userId, roomId, worldId, userName: "mike", name: "Mike", source: "test", channelId: `c-${roomTag}`, serverId: "s", type: "DM" });
  return { roomId, userId, worldId };
}
const userMessage = (runtime, ctx, content, tag) => ({ id: ids(`msg-${tag}`), entityId: ctx.userId, agentId: runtime.agentId, roomId: ctx.roomId, worldId: ctx.worldId, content: { source: "test", ...content }, createdAt: Date.now() });
const plannerPicks = (runtime, ctx, actions, text = "On it.") => [{ id: ids(`plan-${actions.join("-")}-${Math.random()}`), entityId: runtime.agentId, agentId: runtime.agentId, roomId: ctx.roomId, content: { text, actions, thought: `use ${actions.join(",")}` }, createdAt: Date.now() }];
const actionStateText = async (runtime, message, actionResults) => {
  const provider = runtime.providers.find((p) => p.name === "ACTION_STATE");
  const out = await provider.get(runtime, message, { values: {}, data: { actionResults }, text: "" });
  return String(out?.text || "");
};

try {
  // ---- (1)+(2)+(3): the planner path on the real seller ---------------------------
  const { runtime, prompts } = await bootRuntime({ AGENT402_BASE_URL: BASE });
  ok(runtime.actions.map((a) => a.name).includes("AGENT402_CALL") && runtime.plugins.some((p) => p.name === "agent402"), `the packed artifact loaded into @elizaos/core ${coreVersion}: plugin registered, actions present`);
  const ctx = await seed(runtime, "a");
  const plain = userMessage(runtime, ctx, { text: "give me the sha256 hash of 'hello world'" }, "plain");
  await runtime.createMemory(plain, "messages");
  const listed = await runtime.composeState(plain, ["ACTIONS"]);
  ok(/AGENT402_CALL/.test(listed.text) && /AGENT402_FIND/.test(listed.text), "the ACTIONS provider lists AGENT402_CALL for a plain user message with no slug field - the planner is able to pick it (1)");
  if (typeof runtime.processActions !== "function") {
    // A 2.x runtime: the planner emits a TOOL CALL {name, arguments}; the
    // executor (executePlannedToolCall, not exported) validates the arguments
    // against the action's declared `parameters` with core's own
    // validateActionParams (exported), hands the result to validate() and
    // handler() as options.parameters. This mirrors that path with the same
    // validator, and says so.
    const { callAction, findAction } = pluginMod;
    const v = core.validateActionParams(callAction, { slug: "hash", params: { text: "hello world", algo: "sha256" } });
    ok(v.valid === true && v.params?.slug === "hash" && v.params?.params?.algo === "sha256", "core's validateActionParams accepts a planner tool call against AGENT402_CALL's declared parameters");
    const missing = core.validateActionParams(findAction, {});
    ok(missing.valid === false && /task/.test(missing.errors.join(" ")), "and reports AGENT402_FIND's required `task` when the planner omits it");
    const opts = { parameters: v.params, parameterErrors: undefined };
    ok((await callAction.validate(runtime, plain, listed, opts)) === true, "validate(runtime, message, state, options) admits the call (v2 passes options to validate)");
    const want = createHash("sha256").update("hello world").digest("hex");
    const r0 = await callAction.handler(runtime, plain, listed, opts, async () => []);
    ok(r0.success === true && r0.data.resolvedVia === "parameters" && r0.text.includes(want) && /complete JSON/.test(r0.text), "the handler ran on the validated parameters, paid the free tier with proof-of-work, and the complete digest is in the model-facing text (2)(3)");
    const paidCalls = () => seen.filter((s) => s.url.startsWith("/api/search") && s.auth).length;
    const bootPaid = (extra) => bootRuntime({ AGENT402_BASE_URL: STUB, AGENT402_CREDITS_KEY: KEY, AGENT402_MAX_PER_CALL_USD: "0.004", AGENT402_DAILY_LIMIT_USD: "0.005", ...extra });
    const callOn = (rt, params) => callAction.handler(rt, plain, listed, { parameters: core.validateActionParams(callAction, params).params }, async () => []);
    const { runtime: rt2 } = await bootPaid();
    let r = await callOn(rt2, { slug: "search", params: { q: "x402" } });
    ok(r.success === true && paidCalls() === 1, "call 1: a $0.003 wallet-only tool settles by credits key (the stub saw one paid request)");
    r = await callOn(rt2, { slug: "search", params: { q: "mpp" } });
    ok(r.success === false && r.data?.errorCode === "spend_limit" && paidCalls() === 1, "call 2: refused by the DAILY ceiling (errorCode spend_limit) before any request left the process - the ledger survived across calls (4)");
    const { runtime: rt2c } = await bootPaid();
    const b1 = paidCalls();
    const burst = await Promise.all([1, 2, 3, 4].map((i) => callOn(rt2c, { slug: "search", params: { q: `q${i}` } })));
    ok(burst.filter((x) => x.success).length === 1 && paidCalls() - b1 === 1, "four CONCURRENT calls under the ceiling: exactly one settled, one request seen");
    const { runtime: rt2w } = await bootPaid({ AGENT402_DAILY_LIMIT_USD: "0.010" });
    const b2 = paidCalls(); const three = [];
    for (let i = 0; i < 4; i++) three.push(await callOn(rt2w, { slug: "search", params: { q: `w${i}` } }));
    ok(three.filter((x) => x.success).length === 3 && paidCalls() - b2 === 3, "a second runtime with a $0.010 ceiling settles three and refuses the fourth: ceilings are runtime-scoped");
    const { runtime: rt4 } = await bootPaid({ AGENT402_MAX_PER_CALL_USD: "1", AGENT402_DAILY_LIMIT_USD: "100" });
    r = await callAction.handler(rt4, plain, listed, { parameters: { slug: "broken", params: { q: "nothing" } } }, async () => []);
    ok(r.success === false && r.data?.errorCode === "upstream_error" && r.text.includes(LONG_ERROR) && r.text.includes("END-OF-SELLER-ERROR"), `an upstream failure's ${LONG_ERROR.length}-character detail reaches the result whole, past the former 2,000-char client cap (5)`);
    r = await callAction.handler(rt4, plain, listed, { parameters: { slug: "big", params: {} } }, async () => []);
    ok(r.success === true && r.text.endsWith(JSON.stringify(BIG)), "a 60 KB result reaches the text complete");
    const b6 = seen.length;
    r = await callAction.handler(rt4, plain, listed, { parameters: { slug: "search", params: "{not json" } }, async () => []);
    ok(r.success === false && r.data?.errorCode === "invalid_parameters" && seen.length === b6, "malformed params: errorCode invalid_parameters, nothing sent (6)");
    console.log(`\n${pass} passed against @elizaos/core ${coreVersion} (2.x executor path mirrored with core's own validator)`);
    process.exitCode = 0;
    throw Object.assign(new Error("done"), { done: true });
  }
  const callbacks = [];
  await runtime.processActions(plain, plannerPicks(runtime, ctx, ["AGENT402_CALL"]), listed, async (c) => { callbacks.push(c); return []; });
  const results = runtime.getActionResults(plain.id);
  const want = createHash("sha256").update("hello world").digest("hex");
  ok(results.length === 1 && results[0].success === true, `runtime.processActions ran AGENT402_CALL to completion (got ${JSON.stringify(results[0]?.text || results).slice(0, 160)})`);
  ok(results[0].data?.slug === "hash" && results[0].data?.resolvedVia === "model" && prompts.length === 1, "with no slug anywhere, the handler searched the catalog and the runtime's model chose the tool and shaped its input (2)");
  ok(results[0].text.includes(want) && /complete JSON/.test(results[0].text), "the free-tier call answered and the sha256 digest is in the result text");
  const rendered = await actionStateText(runtime, plain, results);
  ok(rendered.includes(want) && /AGENT402_CALL/.test(rendered), "the ACTION_STATE provider - what the model reads next turn - carries the complete digest, not a preview (3)");
  ok(callbacks.length === 1 && callbacks[0].text.includes(want), "the callback delivered the same complete text");

  // ---- (4): spend ceilings across calls in ONE runtime: sequential, concurrent, scoped
  const bootPaid = (extra) => bootRuntime({ AGENT402_BASE_URL: STUB, AGENT402_CREDITS_KEY: KEY, AGENT402_MAX_PER_CALL_USD: "0.004", AGENT402_DAILY_LIMIT_USD: "0.005", ...extra });
  const paidCalls = () => seen.filter((s) => s.url.startsWith("/api/search") && s.auth).length;
  const runOn = async (rt, ctxN, tag, content) => {
    const m = userMessage(rt, ctxN, content, tag);
    await rt.createMemory(m, "messages");
    await rt.processActions(m, plannerPicks(rt, ctxN, ["AGENT402_CALL"]), await rt.composeState(m, ["ACTIONS"]), async () => []);
    return rt.getActionResults(m.id)[0];
  };
  const { runtime: rt2 } = await bootPaid();
  const ctx2 = await seed(rt2, "b");
  let r = await runOn(rt2, ctx2, "s1", { text: "search the web for x402", slug: "search", params: { q: "x402" } });
  ok(r.success === true && paidCalls() === 1 && r.data?.result?.results?.[0]?.url === "https://x402.org", "call 1: a $0.003 wallet-only tool settles by credits key (the stub saw one paid request)");
  ok(pluginMod.spendingSummaryFor(rt2)?.dailyUsd === 0.003 && pluginMod.spendingSummaryFor(rt2)?.calls === 1, "the runtime's client booked $0.003 against the rolling 24h ledger");
  r = await runOn(rt2, ctx2, "s2", { text: "search the web for mpp", slug: "search", params: { q: "mpp" } });
  ok(r.success === false && r.data?.errorCode === "spend_limit" && /dailyLimitUsd|24h spend/.test(r.text) && paidCalls() === 1, "call 2: refused by the DAILY ceiling (errorCode spend_limit) before any request left the process - the ledger survived across calls (4)");
  ok(!JSON.stringify(r).includes(KEY), "the credits key never appears in an action result");
  // CONCURRENT: four calls fired at once on a fresh runtime under the same ceiling.
  const { runtime: rt2c } = await bootPaid();
  const ctx2c = await seed(rt2c, "bc");
  const before = paidCalls();
  const burst = await Promise.all([1, 2, 3, 4].map((i) => runOn(rt2c, ctx2c, `c${i}`, { text: "search", slug: "search", params: { q: `q${i}` } })));
  ok(burst.filter((x) => x.success).length === 1 && burst.filter((x) => x.data?.errorCode === "spend_limit").length === 3 && paidCalls() - before === 1, "four CONCURRENT calls under a $0.005 daily ceiling: exactly one settled, three refused, the stub saw one request (the client reserves before it awaits)");
  // RUNTIME-SCOPED: a second runtime in the same process with a wider ceiling
  // enforces its own, and the first runtime's ledger does not bleed into it.
  const { runtime: rt2w } = await bootPaid({ AGENT402_DAILY_LIMIT_USD: "0.010" });
  const ctx2w = await seed(rt2w, "bw");
  const b2 = paidCalls();
  const three = [];
  for (let i = 0; i < 4; i++) three.push(await runOn(rt2w, ctx2w, `w${i}`, { text: "search", slug: "search", params: { q: `w${i}` } }));
  ok(three.filter((x) => x.success).length === 3 && three[3].data?.errorCode === "spend_limit" && paidCalls() - b2 === 3, "a runtime with a $0.010 ceiling settles three $0.003 calls and refuses the fourth: ceilings are runtime-scoped, not process-wide");
  const { runtime: rt3 } = await bootPaid({ AGENT402_MAX_PER_CALL_USD: "0.001", AGENT402_DAILY_LIMIT_USD: "100" });
  const ctx3 = await seed(rt3, "c");
  const b3 = paidCalls();
  r = await runOn(rt3, ctx3, "s3", { text: "search", slug: "search", params: { q: "x" } });
  ok(r.success === false && r.data?.errorCode === "spend_limit" && /maxPerCallUsd/.test(r.text) && paidCalls() === b3, "a per-call ceiling under the tool's price refuses with zero requests sent");

  // ---- (5): nothing is truncated; the opt-in bound rejects, never trims -------
  const { runtime: rt4 } = await bootPaid({ AGENT402_MAX_PER_CALL_USD: "1", AGENT402_DAILY_LIMIT_USD: "100" });
  const ctx4 = await seed(rt4, "d");
  r = await runOn(rt4, ctx4, "e1", { text: "run broken", slug: "broken", params: { q: "nothing" } });
  ok(r.success === false && r.data?.errorCode === "upstream_error" && r.text.includes("END-OF-SELLER-ERROR") && r.error.includes("market-0") && r.text.includes(LONG_ERROR) && !/more characters not shown/.test(r.text), `an upstream failure's ${LONG_ERROR.length}-character detail reaches the result WHOLE, past the former 2,000-char client cap (text and error carry the seller's full message) (5)`);
  ok((await actionStateText(rt4, userMessage(rt4, ctx4, { text: "x" }, "e1s"), [r])).includes("END-OF-SELLER-ERROR"), "ACTION_STATE renders the END of that error - the model sees the seller's whole message, not its beginning");
  r = await runOn(rt4, ctx4, "big1", { text: "big", slug: "big", params: {} });
  const bigJson = JSON.stringify(BIG);
  ok(r.success === true && r.text.endsWith(bigJson) && r.text.length > 60_000, `a ${bigJson.length}-character result reaches the model-facing text complete and byte-identical (rendered via ACTION_STATE below)`);
  ok((await actionStateText(rt4, userMessage(rt4, ctx4, { text: "x" }, "big1s"), [r])).includes("row-1499"), "ACTION_STATE renders the last row of that result - the model sees all of it");
  process.env.AGENT402_MAX_RESULT_CHARS = "10000";
  try {
    r = await runOn(rt4, ctx4, "big2", { text: "big", slug: "big", params: {} });
    ok(r.success === false && r.data?.errorCode === "result_too_large" && r.data?.result?.rows?.length === 1500 && !r.text.includes("row-1"), "with AGENT402_MAX_RESULT_CHARS set, an over-bound result is an explicit FAILURE that carries the whole result in data.result and puts NO partial payload in the text");
  } finally { delete process.env.AGENT402_MAX_RESULT_CHARS; }

  // ---- (6): typed failures before any dispatch -----------------------------------
  const b6 = seen.length;
  r = await runOn(rt4, ctx4, "bad1", { text: "search", slug: "search", params: "{not json" });
  ok(r.success === false && r.data?.errorCode === "invalid_parameters" && seen.length === b6, "malformed JSON params: errorCode invalid_parameters, nothing sent (never {})");
  r = await runOn(rt4, ctx4, "bad2", { text: "search", slug: "search", params: ["a"] });
  ok(r.success === false && r.data?.errorCode === "invalid_parameters" && seen.length === b6, "array params: errorCode invalid_parameters, nothing sent");
  const { runtime: rtDead } = await bootRuntime({ AGENT402_BASE_URL: DEAD });
  const ctxDead = await seed(rtDead, "dead");
  r = await runOn(rtDead, ctxDead, "dead1", { text: "give me the sha256 hash of 'hello world'" });
  ok(r.success === false && r.data?.errorCode === "catalog_unavailable", `an unreachable catalog on the planner path is errorCode catalog_unavailable, not "no match" (got ${r.data?.errorCode})`);
  r = await runOn(runtime, ctx, "nomatch", { text: "fold my laundry" });
  ok(r.success === false && r.data?.errorCode === "no_match" && prompts.length === 1, "a task the catalog has nothing for is errorCode no_match, and the model is not consulted");

  // ---- (7): the v2 parameter path -----------------------------------------------------
  const { callAction } = pluginMod;
  ok(Array.isArray(callAction.parameters) && callAction.parameters.every((p) => p.name && p.schema && "required" in p), "AGENT402_CALL declares parameters in the v2 shape ({name, description, required, schema})");
  const v2 = await callAction.handler(runtime, userMessage(runtime, ctx, { text: "hash it" }, "v2"), undefined, { parameters: { slug: "hash", params: { text: "abc", algo: "sha256" } } });
  ok(v2.success === true && v2.data.resolvedVia === "parameters" && v2.text.includes(createHash("sha256").update("abc").digest("hex")), "options.parameters from the runtime's extractor is honoured ahead of the message text (7)");
  const v2bad = await callAction.handler(runtime, userMessage(runtime, ctx, { text: "hash it", slug: "uuid" }, "v2b"), undefined, { parameters: { slug: "hash", params: { text: "abc", algo: "sha256" } } });
  ok(v2bad.data.slug === "hash", "and wins over a conflicting content.slug");

  console.log(`\n${pass} passed against @elizaos/core ${coreVersion}`);
} catch (e) {
  if (!e?.done) { console.error(e?.stack || e); process.exitCode = 1; }
} finally {
  stub.close();
  if (proc) proc.kill("SIGKILL");
  process.exit(process.exitCode || 0);
}
