// The direct upstream's cost guard (src/gateway-direct-pricebook.js) on the
// chat wire (src/tools/llm-gateway-kit.js). Two stubs on 127.0.0.1 (port 0):
// the direct upstream (its public GET /v1/models listing and its chat route)
// and OpenRouter (GET /api/v1/models/<id>/endpoints and its chat route).
// Pins:
//   - a call cheaper per call on the direct upstream's listed prices goes direct;
//   - a call cheaper there on input only but dearer per call stays on OpenRouter;
//   - priority-tier endpoints and endpoints above the call's max_price are not
//     "the cheapest routable endpoint";
//   - the minimum saving share is respected, from env and from the cost table;
//   - an unread, unreadable, stale, unlisted, zero, negative or per-request-fee
//     listing, or no routable endpoint, keeps the call on OpenRouter;
//   - the measured backstop sends a model to OpenRouter once both sides hold the
//     minimum sample and direct does not measure below OpenRouter, and back when it does;
//   - nothing is fetched on the request path;
//   - the refresh logs words only; /api/gateway-status carries the word only;
//     the figures are on the operator view alone.
// Every price below is synthetic: a multiple of a unit derived from the tier
// cap (no rate typed). Offline: no network, no real keys, no spend.
//
//   node scripts/test-direct-upstream-cost-guard.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { ownStoreEnv } from "./lib/own-stores.js";
import { getFreePort } from "./lib/free-port.js";

delete process.env.UPSTREAM_COSTS_JSON;
delete process.env.UPSTREAM_COSTS_FILE;
for (const k of Object.keys(process.env)) if (k.startsWith("DIRECT_UPSTREAM_")) delete process.env[k];
process.env.OPENROUTER_API_KEY = "test-key";

const U = await import("../src/upstream-costs.js");
const K = await import("../src/tools/llm-gateway-kit.js");
const D = await import("../src/gateway-direct-upstream.js");
const PB = await import("../src/gateway-direct-pricebook.js");

const example = JSON.parse(readFileSync(new URL("../docs/example-upstream-costs.json", import.meta.url), "utf8"));
const placeholder = example.models.find(([p]) => p === "openai/")[1];
const tableWith = (minSaving) => ({ ...example, models: [...example.models, ["deepseek/", placeholder]], vendor: { ...example.vendor, direct: minSaving === undefined ? {} : { minSaving } } });
U.setUpstreamCostsForTest(tableWith(undefined));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };

// ---- synthetic prices --------------------------------------------------------
// One unit (USD per 1M tokens) a tenth of the base tier's smallest cap, so every
// stub price below (at most ten units) sits inside provider.max_price.
const CAP = K.TIERS["v1-chat"].maxPrice;
const UNIT = Math.min(CAP.prompt, CAP.completion) / 10;
const perToken = (units) => String((units * UNIT) / 1e6); // the listings' per-token strings
const listed = (p, c, extra = {}) => ({ prompt: perToken(p), completion: perToken(c), ...extra });

// ---- stubs ---------------------------------------------------------------------
function stub() {
  const s = { hits: [], plan: null, gets: [] };
  s.server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      if (req.method === "GET") { s.gets.push(req.url); try { await s.get(req, res); } catch { try { res.destroy(); } catch { /* gone */ } } return; }
      let body = null;
      try { body = JSON.parse(raw); } catch { /* recorded as null */ }
      s.hits.push({ url: req.url, body });
      try { await s.plan(req, res, body); } catch { try { res.destroy(); } catch { /* gone */ } }
    });
  });
  return s;
}
const answer = (model, usage, extra = {}) => ({ id: "cmpl-1", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage, ...extra });
const json = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
const sse = (res, frames) => { res.writeHead(200, { "content-type": "text/event-stream" }); for (const f of frames) res.write(`data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`); res.end(); };

const direct = stub(), or = stub();
await new Promise((r) => direct.server.listen(0, "127.0.0.1", r));
await new Promise((r) => or.server.listen(0, "127.0.0.1", r));
const DIRECT_PORT = direct.server.address().port;
const OR_PORT = or.server.address().port;

// Micro-USD the stubs report per answer (synthetic).
let directMicro = 10, orMicro = 20;
const TOK = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
direct.plan = (req, res, body) => json(res, 200, answer(body.model, { ...TOK }, { x_vendor: { charged_micro: directMicro } }));
or.plan = (req, res, body) => json(res, 200, answer(body?.model, { ...TOK, cost: orMicro / 1e6 }));

// An allowlisted model on the base tier; its upstream id is made up.
const MODEL = "deepseek/deepseek-chat";
const MAPPED = "stub-chat";
// The direct listing and OpenRouter endpoint list the stubs serve.
let listing = { status: 200, body: null };
let endpoints = { status: 200, body: null };
const setListing = (pricing, { status = 200, id = MAPPED, raw } = {}) => { listing = { status, body: raw !== undefined ? raw : { data: [{ id, pricing, context_length: 1000 }, { id: "other", pricing: listed(1, 1) }] } }; };
const setEndpoints = (list, { status = 200, raw } = {}) => { endpoints = { status, body: raw !== undefined ? raw : { data: { id: MODEL, endpoints: list.map(([p, c, tag = "prov"]) => ({ tag, pricing: listed(p, c) })) } } }; };
direct.get = (req, res) => (req.url === "/v1/models" ? json(res, listing.status, listing.body) : json(res, 404, {}));
or.get = (req, res) => (req.url === `/api/v1/models/${MODEL}/endpoints` ? json(res, endpoints.status, endpoints.body) : json(res, 404, {}));

const realFetch = globalThis.fetch;
const fetchLog = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  fetchLog.push(u);
  if (u.startsWith("https://openrouter.ai/api/v1/chat/completions")) return realFetch(`http://127.0.0.1:${OR_PORT}/api/v1/chat/completions`, init);
  if (u.startsWith(`http://127.0.0.1:${DIRECT_PORT}/`) || u.startsWith(`http://127.0.0.1:${OR_PORT}/`)) return realFetch(url, init);
  throw new Error(`test: unexpected outbound fetch to ${u.slice(0, 60)}`);
};

const ON = {
  DIRECT_UPSTREAM_URL: `http://127.0.0.1:${DIRECT_PORT}/v1`, DIRECT_UPSTREAM_KEY: "direct-test-key",
  DIRECT_UPSTREAM_MODELS: `${MODEL}=${MAPPED}`, DIRECT_UPSTREAM_TIMEOUT_MS: "400",
  DIRECT_UPSTREAM_OR_MODELS_URL: `http://127.0.0.1:${OR_PORT}/api/v1/models`,
  DIRECT_UPSTREAM_MIN_SAVING_PCT: "0",
};
const setEnv = (vars) => {
  for (const k of Object.keys(process.env)) if (k.startsWith("DIRECT_UPSTREAM_")) delete process.env[k];
  Object.assign(process.env, vars || {});
};
const base = K.LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat");
ok(!!base, "base chat tool found");
const msgs = [{ role: "user", content: "hi" }];
const reset = () => { direct.hits.length = 0; or.hits.length = 0; D._resetDirectUpstreamStatsForTest(); };
const call = (extra = {}) => base.handler({ model: MODEL, messages: msgs, max_tokens: 500, ...extra });
const served = async (extra) => { reset(); await call(extra); return direct.hits.length === 1 && or.hits.length === 0 ? "direct" : direct.hits.length === 0 && or.hits.length === 1 ? "openrouter" : `mixed(${direct.hits.length}/${or.hits.length})`; };
const skipped = () => D.directUpstreamReport().skipped;
const quietRefresh = async () => { const log = console.log; const lines = []; console.log = (...a) => lines.push(a.join(" ")); try { return { word: await PB.refreshDirectPriceBook(), lines }; } finally { console.log = log; } };

// ---- unconfigured -----------------------------------------------------------------
setEnv({});
PB._resetDirectPriceBookForTest();
ok(PB.directUpstreamWord() === "off", "unconfigured: the word is off");
ok(await PB.refreshDirectPriceBook() === "off" && direct.gets.length === 0 && or.gets.length === 0, "unconfigured: a refresh reads nothing");

// ---- before the first refresh: fail closed ---------------------------------------
setEnv(ON);
PB._resetDirectPriceBookForTest();
ok(PB.directUpstreamWord() === "starting", "configured, no refresh yet: the word is starting");
ok(await served() === "openrouter" && skipped().price_unreadable === 1, "no price book yet: the call goes to OpenRouter (a price_unreadable skip)");
ok(direct.gets.length === 0 && or.gets.length === 0, "the request path fetched no listing");

// ---- direct cheaper per call --------------------------------------------------------
setListing(listed(2, 4));
setEndpoints([[4, 8]]);
{
  const r = await quietRefresh();
  ok(direct.gets.length === 1 && or.gets.length === 1, "one refresh reads the direct listing once and the model's endpoints once");
  ok(r.word === "ok" && PB.directUpstreamWord() === "ok", "the word reads ok");
  ok(r.lines.length === 1 && /^\[direct-upstream\] price book: cheaper$/.test(r.lines[0]), `the refresh logs a word only (${r.lines.join(" | ")})`);
}
{
  const gets = direct.gets.length + or.gets.length;
  const mark = fetchLog.length;
  ok(await served() === "direct", "direct cheaper on both units: the call goes direct");
  ok(await served({ stream: false, max_tokens: 50 }) === "direct", "and at another output size");
  ok(direct.gets.length + or.gets.length === gets && fetchLog.length - mark === 2 && !fetchLog.slice(mark).some((u) => /\/models/.test(u)), "no listing is fetched on the request path (two calls, two chat fetches)");
}
// A priority endpoint far cheaper than direct is not routable for a default call.
setEndpoints([[4, 8], [1, 1, "prov/fast"], [1, 1, "prov/priority"], [1, 1, "prov/ultrafast"]]);
await quietRefresh();
ok(await served() === "direct", "priority-tier endpoints are not the cheapest routable endpoint");

// ---- cheaper on input only, dearer per call ---------------------------------------------
setListing(listed(1, 10));
setEndpoints([[5, 5]]);
{
  const r = await quietRefresh();
  ok(await served() === "openrouter" && skipped().not_cheaper === 1, "direct cheaper on input only but dearer per call: OpenRouter (a not_cheaper skip)");
  ok(r.word === "ok" && await served({ max_tokens: 1 }) === "direct", "the same prices still win an input-heavy call, so the model-level word stays ok");
}
setListing(listed(1, 30));
{
  const r = await quietRefresh();
  ok(await served() === "openrouter" && await served({ max_tokens: 50 }) === "openrouter", "dearer at the reference shapes: OpenRouter");
  ok(r.word === "not_cheaper" && PB.directUpstreamWord() === "not_cheaper" && /^\[direct-upstream\] price book: not_cheaper$/.test(r.lines[0] || ""), "no reference shape undercuts: the word and the log read not_cheaper");
}
// Per-call, not per-price: an endpoint cheapest on input but dear on output does not make direct dearer.
setListing(listed(3, 3));
setEndpoints([[1, 9], [6, 6]]);
await quietRefresh();
ok(await served() === "direct", "direct dearer than the cheapest-input endpoint on prompt, still cheaper per call: direct");

// ---- max_price filter (decision unit) ---------------------------------------------------
PB._resetDirectPriceBookForTest();
PB._seedDirectPriceBookForTest({ [MODEL]: { direct: { prompt: 4 * UNIT, completion: 4 * UNIT }, endpoints: [{ prompt: UNIT, completion: 20 * UNIT }, { prompt: 5 * UNIT, completion: 5 * UNIT }] } });
{
  const shape = { inputTokens: 1000, outputTokens: 10 };
  ok(!PB.directPriceDecision(MODEL, shape).go, "input-heavy call: the input-cheap endpoint wins, direct is not cheaper");
  ok(PB.directPriceDecision(MODEL, { ...shape, maxPrice: { prompt: 10 * UNIT, completion: 10 * UNIT } }).go, "the same call under a max_price that refuses that endpoint: direct");
  ok(PB.directPriceDecision(MODEL, { ...shape, maxPrice: { prompt: UNIT / 2, completion: UNIT / 2 } }).skip === "price_no_endpoint", "a max_price that refuses every endpoint: OpenRouter (price_no_endpoint)");
  ok(PB.directPriceDecision(MODEL, { inputTokens: 0, outputTokens: 10 }).skip === "price_estimate" && PB.directPriceDecision(MODEL, { inputTokens: 10, outputTokens: NaN }).skip === "price_estimate", "a missing or zero estimate: OpenRouter");
}

// ---- the minimum saving share -------------------------------------------------------------
setListing(listed(2, 4));
setEndpoints([[4, 8]]); // direct costs half of OpenRouter at every shape
await quietRefresh();
setEnv({ ...ON, DIRECT_UPSTREAM_MIN_SAVING_PCT: "40" });
ok(await served() === "direct", "saving share 40% (env): half the cost clears it, direct");
setEnv({ ...ON, DIRECT_UPSTREAM_MIN_SAVING_PCT: "60" });
ok(await served() === "openrouter" && skipped().not_cheaper === 1, "saving share 60% (env): half the cost does not clear it, OpenRouter");
const { DIRECT_UPSTREAM_MIN_SAVING_PCT: _drop, ...ON_NO_PCT } = ON;
setEnv(ON_NO_PCT);
U.setUpstreamCostsForTest(tableWith(0.6));
ok(await served() === "openrouter", "saving share from the cost table (no env): above the saving, OpenRouter");
U.setUpstreamCostsForTest(tableWith(0.4));
ok(await served() === "direct", "saving share from the cost table: under it, direct");
U.setUpstreamCostsForTest(tableWith(undefined));
ok(PB.minSavingFraction() === 0 && await served() === "direct", "neither env nor table: strictly cheaper is enough");
ok(PB.minSavingFraction({ DIRECT_UPSTREAM_MIN_SAVING_PCT: "abc" }) === 0 && PB.directPriceBookBootWarnings({ DIRECT_UPSTREAM_MIN_SAVING_PCT: "abc" }).length === 1 && PB.directPriceBookBootWarnings({}).length === 0, "an invalid env share is ignored with a boot warning");
setEnv(ON);

// ---- fail closed ---------------------------------------------------------------------------
const failClosed = async (label, prep, word, skip) => {
  PB._resetDirectPriceBookForTest();
  setListing(listed(2, 4)); setEndpoints([[4, 8]]);
  await prep();
  const r = await quietRefresh();
  const where = await served();
  ok(where === "openrouter" && skipped()[skip] === 1, `${label}: OpenRouter (${skip}; served by ${where}, skipped ${JSON.stringify(skipped())})`);
  ok(PB.directUpstreamWord() === word && !/\d/.test(r.lines.join("")), `${label}: the word reads ${word}, the log carries no figure`);
};
await failClosed("listing answers 500", () => setListing(null, { status: 500, raw: { error: "x" } }), "unreadable", "price_unreadable");
await failClosed("listing is not JSON", () => setListing(null, { raw: "<html>" }), "unreadable", "price_unreadable");
await failClosed("listing is empty", () => setListing(null, { raw: { data: [] } }), "unreadable", "price_unreadable");
await failClosed("endpoints answer 500", () => setEndpoints([], { status: 500, raw: {} }), "unreadable", "price_unreadable");
await failClosed("model missing from the listing", () => setListing(listed(2, 4), { id: "someone-else" }), "not_cheaper", "price_unlisted");
await failClosed("zero prompt price", () => setListing({ prompt: "0", completion: perToken(4) }), "not_cheaper", "price_bad_price");
await failClosed("negative completion price", () => setListing({ prompt: perToken(2), completion: `-${perToken(4)}` }), "not_cheaper", "price_bad_price");
await failClosed("unparsable price", () => setListing({ prompt: "cheap", completion: perToken(4) }), "not_cheaper", "price_bad_price");
await failClosed("a per-request fee", () => setListing(listed(2, 4, { request: perToken(1) })), "not_cheaper", "price_request_fee");
await failClosed("only priority endpoints", () => setEndpoints([[4, 8, "p/fast"]]), "not_cheaper", "price_no_endpoint");
{
  // A zero request fee, as a string, is no fee.
  PB._resetDirectPriceBookForTest();
  setListing(listed(2, 4, { request: "0" })); setEndpoints([[4, 8]]);
  await quietRefresh();
  ok(await served() === "direct", "a request fee of \"0\" is no fee: direct");
  // A later failed read keeps the last good one while it is fresh ...
  setListing(null, { status: 500, raw: {} });
  await quietRefresh();
  ok(await served() === "direct" && PB.directUpstreamWord() === "ok", "a failed refresh keeps the previous read while it is fresh");
  // ... and the book goes stale after three refresh intervals.
  const interval = PB.priceRefreshMs();
  PB._setPriceBookNowForTest(() => Date.now() + 3 * interval - 60_000);
  ok(await served() === "direct", "inside three intervals: still served from the book");
  PB._setPriceBookNowForTest(() => Date.now() + 3 * interval + 60_000);
  ok(await served() === "openrouter" && skipped().price_unreadable === 1 && PB.directUpstreamWord() === "unreadable", "older than three intervals: stale, OpenRouter, word unreadable");
  PB._setPriceBookNowForTest(null);
}
// Concurrent refreshes share one run.
{
  PB._resetDirectPriceBookForTest();
  setListing(listed(2, 4)); setEndpoints([[4, 8]]);
  const before = direct.gets.length;
  const log = console.log; console.log = () => {};
  await Promise.all([PB.refreshDirectPriceBook(), PB.refreshDirectPriceBook(), PB.refreshDirectPriceBook()]);
  console.log = log;
  ok(direct.gets.length - before === 1, "three concurrent refreshes read the listing once");
}

// ---- streams follow the same rule ------------------------------------------------------------
{
  const fakeRes = () => { const r = { headersSent: false, chunks: [], writeHead(s) { r.headersSent = true; r.status = s; }, flushHeaders() {}, write(c) { r.chunks.push(String(c)); return true; }, end() {}, on() {}, once() {}, off() {} }; return r; };
  const orStream = (req, res, body) => sse(res, [{ id: "g1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] }, { id: "g1", object: "chat.completion.chunk", model: body.model, choices: [], usage: { ...TOK, cost: orMicro / 1e6 } }, "[DONE]"]);
  const dStream = (req, res, body) => sse(res, [{ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] }, { id: "c1", object: "chat.completion.chunk", model: body.model, choices: [], usage: { ...TOK }, x_vendor: { charged_micro: directMicro } }, "[DONE]"]);
  const prevD = direct.plan, prevO = or.plan;
  direct.plan = dStream; or.plan = orStream;
  setListing(listed(2, 4)); setEndpoints([[4, 8]]);
  await quietRefresh();
  reset();
  await (await call({ stream: true })).__sse(fakeRes());
  ok(direct.hits.length === 1 && or.hits.length === 0, "stream, cheaper: direct");
  setListing(listed(1, 10)); setEndpoints([[5, 5]]);
  await quietRefresh();
  reset();
  await (await call({ stream: true })).__sse(fakeRes());
  ok(direct.hits.length === 0 && or.hits.length === 1 && skipped().not_cheaper === 1, "stream, dearer per call: OpenRouter");
  direct.plan = prevD; or.plan = prevO;
}

// ---- measured backstop, through the handler ----------------------------------------------------
setEnv({ ...ON, DIRECT_UPSTREAM_MEASURE_MIN: "30", DIRECT_UPSTREAM_MEASURE_WINDOW: "40" });
PB._resetDirectPriceBookForTest();
setListing(listed(2, 4)); setEndpoints([[4, 8]]);
await quietRefresh();
{
  directMicro = 90; orMicro = 10; // direct measures dearer than OpenRouter (synthetic)
  let directServed = 0;
  for (let i = 0; i < 30; i++) if (await served() === "direct") directServed++;
  ok(directServed === 30, "listed cheaper, OpenRouter not yet sampled: 30 calls go direct");
  setEnv({ ...ON, DIRECT_UPSTREAM_MEASURE_MIN: "30", DIRECT_UPSTREAM_MEASURE_WINDOW: "40", DIRECT_UPSTREAM_SHARE: "0" });
  for (let i = 0; i < 29; i++) await served();
  setEnv({ ...ON, DIRECT_UPSTREAM_MEASURE_MIN: "30", DIRECT_UPSTREAM_MEASURE_WINDOW: "40" });
  ok(await served() === "direct", "29 OpenRouter samples (under the minimum): the measure does not act yet");
  setEnv({ ...ON, DIRECT_UPSTREAM_MEASURE_MIN: "30", DIRECT_UPSTREAM_MEASURE_WINDOW: "40", DIRECT_UPSTREAM_SHARE: "0" });
  await served();
  setEnv({ ...ON, DIRECT_UPSTREAM_MEASURE_MIN: "30", DIRECT_UPSTREAM_MEASURE_WINDOW: "40" });
  const m = PB.directPriceBookReport().models[MODEL].measuredPer1k;
  ok(m.samples.direct >= 30 && m.samples.openrouter >= 30 && m.blocked === true, "both sides at the minimum, direct measured dearer: blocked");
  ok(await served() === "openrouter" && skipped().measured_not_cheaper === 1, "blocked: the call goes to OpenRouter (a measured_not_cheaper skip)");
  ok(PB.directUpstreamWord() === "not_cheaper", "blocked: the word reads not_cheaper");
  // OpenRouter now measures dearer: its window refills and the model goes back.
  orMicro = 900;
  let back = -1;
  for (let i = 0; i < 40 && back < 0; i++) if (await served() === "direct") back = i;
  ok(back > 0, `once OpenRouter measures above direct, the model returns to direct (after ${back} OpenRouter answers)`);
  ok(PB.directUpstreamWord() === "ok" && PB.directPriceBookReport().models[MODEL].measuredPer1k.blocked === false, "unblocked: the word reads ok");
  // An equal measure is not below: blocked.
  PB._resetDirectPriceBookForTest();
  for (let i = 0; i < 30; i++) { PB.noteDirectMeasure(MODEL, "direct", TOK, 5e-6); PB.noteDirectMeasure(MODEL, "openrouter", TOK, 5e-6); }
  ok(PB.directPriceBookReport().models[MODEL].measuredPer1k.blocked === true, "an equal measure is not below: blocked");
  PB.noteDirectMeasure("fake/unmapped", "direct", TOK, 1);
  ok(!PB.directPriceBookReport().models["fake/unmapped"], "an unmapped model is never measured");
  directMicro = 10; orMicro = 20;
}

// ---- booted: the word publicly, the figures for the operator ----------------------------------
setEnv({});
{
  setListing(listed(2, 4)); setEndpoints([[4, 8]]);
  const PORT = await getFreePort();
  const TOKEN = "cost-guard-test-operator-token-0123456789";
  const log = [];
  const child = spawn(process.execPath, ["--import", "./scripts/lib/loopback-only-preload.js", "src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, ...ownStoreEnv("direct-cost-guard"), PORT: String(PORT), FREE_MODE: "true", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", AGENT402_OPERATOR_TOKEN: TOKEN, ...ON },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  const url = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    try { up = (await realFetch(`${url}/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  try {
    ok(up, "server booted with the direct upstream configured");
    let pub = null;
    for (let i = 0; i < 40; i++) {
      pub = await (await realFetch(`${url}/api/gateway-status`)).json().catch(() => null);
      if (pub?.directUpstream?.status === "ok") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    ok(pub?.directUpstream?.status === "ok" && Object.keys(pub.directUpstream).join(",") === "status", `the background refresh ran at boot; gateway-status carries the word only (${JSON.stringify(pub?.directUpstream)})`);
    const op = await (await realFetch(`${url}/api/gateway-status`, { headers: { "X-Operator-Token": TOKEN } })).json().catch(() => null);
    ok(op?.directUpstream?.status === "ok" && Object.keys(op.directUpstream).join(",") === "status", "the operator read of gateway-status carries the word only too");
    const anon = await realFetch(`${url}/__operator/direct-upstream.json`);
    ok(anon.status === 404, "the operator view answers 404 without the token");
    const r = await realFetch(`${url}/__operator/direct-upstream.json`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const j = await r.json().catch(() => ({}));
    const row = j.priceBook?.models?.[MODEL];
    ok(r.status === 200 && j.priceBook?.word === "ok" && row?.state === "ok" && Math.abs(row.direct.prompt - 2 * UNIT) < 1e-9 && Math.abs(row.openrouter.cheapestCompletion - 8 * UNIT) < 1e-9, "the operator view carries the listed figures");
    ok(typeof row?.measuredPer1k?.minSample === "number" && typeof j.priceBook.minSaving === "number", "and the measure and the saving share");
    ok(!JSON.stringify(pub).includes(perToken(2)) && !/[0-9]\.[0-9]{3,}/.test(JSON.stringify(pub.directUpstream)), "the public view carries no figure");
    const all = log.join("");
    ok(/\[direct-upstream\] price book: cheaper/.test(all) && ![2, 4, 8].some((u) => all.includes(perToken(u))), "the boot log names the word and no price");
    ok(direct.gets.length > 0 && or.gets.some((u) => u.includes("/endpoints")), "the booted server read both stubs (no other host is reachable under the preload)");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => { child.once("exit", r); setTimeout(r, 5000); });
  }
}

// ---- paging: the heartbeat step run as written (stub curl and gh), and the Worker ----
{
  const { load: yamlLoad } = await import("js-yaml");
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const TITLE = "directUpstream: a direct-upstream model is not cheaper, or its price book is unreadable";
  const wf = yamlLoad(readFileSync(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8"));
  const step = Object.values(wf.jobs).flatMap((j) => j.steps || []).find((st) => String(st.name || "").startsWith("Tool, upstream and facilitator failure checks"));
  ok(!!step, "heartbeat.yml has the failure-words step");
  const dir = mkdtempSync(join(tmpdir(), "hb-direct-"));
  writeFileSync(join(dir, "curl"), "#!/usr/bin/env bash\ncat \"$GS_FILE\"\n");
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
if [ "$1 $2" = "issue list" ]; then
  for a in "$@"; do case "$a" in *"$OPEN_TITLE"*) [ -n "$OPEN_TITLE" ] && echo 41 && exit 0;; esac; done
  exit 0
fi
printf '%s\\x1f' "$@" >> "$GH_LOG"; printf '\\x1e' >> "$GH_LOG"
`);
  chmodSync(join(dir, "curl"), 0o755); chmodSync(join(dir, "gh"), 0o755);
  const OKW = { toolFailures: { status: "ok" }, upstreamHealth: { status: "ok" }, facilitatorFunds: { status: "ok" }, buyerRefusals: { status: "ok" }, robinhoodSettler: { status: "ok" } };
  const hb = (gateway, open = "") => {
    const gs = join(dir, "gs.json"), log = join(dir, "gh.log");
    writeFileSync(gs, JSON.stringify(gateway)); writeFileSync(log, "");
    const r = spawnSync("bash", ["-e", "-c", step.run], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROD: "https://example.invalid", GITHUB_REPOSITORY: "o/r", GS_FILE: gs, GH_LOG: log, OPEN_TITLE: open }, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return readFileSync(log, "utf8").split("\x1e").filter((l) => l.trim()).map((l) => l.split("\x1f").filter((x) => x !== ""));
  };
  for (const w of ["not_cheaper", "unreadable"]) {
    const made = hb({ ...OKW, directUpstream: { status: w } }).filter((c) => c[1] === "create");
    const body = made[0]?.[made[0].indexOf("--body") + 1] || "";
    ok(made.length === 1 && made[0][made[0].indexOf("--title") + 1] === TITLE, `heartbeat: ${w} opens one issue under the title`);
    ok(new RegExp(`directUpstream\\.status=${w}\\.`).test(body) && body.includes("/__operator/direct-upstream.json") && !/\d\.\d|\$/.test(body), `heartbeat: the ${w} body names the word and the operator endpoint, no figure`);
    ok(hb({ ...OKW, directUpstream: { status: w } }, TITLE).some((c) => c[1] === "comment" && c[2] === "41"), `heartbeat: ${w} with an open issue comments`);
  }
  for (const w of ["ok", "off"]) ok(hb({ ...OKW, directUpstream: { status: w } }, TITLE).filter((c) => c[1] === "close" && c[2] === "41").length === 1, `heartbeat: ${w} closes the issue`);
  for (const w of ["starting", "unknown"]) ok(hb({ ...OKW, directUpstream: { status: w } }, TITLE).filter((c) => c[1] === "close" || c[1] === "create").length === 0, `heartbeat: ${w} does neither`);
  ok(hb({ ...OKW, toolFailures: { status: "failing" } }).some((c) => c[1] === "create" && c[c.indexOf("--body") + 1].includes("/__operator/tool-failures.json")), "heartbeat: the other words keep their operator endpoint");
  rmSync(dir, { recursive: true, force: true });
  const { ALARMS, judge } = await import("../workers/status-probe/src/index.js");
  const a = ALARMS.find((x) => x.title === TITLE);
  ok(!!a, "the status Worker carries the same title");
  const j = (gw) => judge({ gateway: gw })[TITLE];
  ok(j({ directUpstream: { status: "not_cheaper" } }) === "bad" && j({ directUpstream: { status: "unreadable" } }) === "bad" && j({ directUpstream: { status: "ok" } }) === "good" && j({ directUpstream: { status: "off" } }) === "good" && j({ directUpstream: { status: "starting" } }) === "quiet" && j({}) === "quiet", "Worker: not_cheaper and unreadable page, ok and off clear, starting and absent do neither");
  const wb = a.body({ gateway: { directUpstream: { status: "<b>" } } });
  ok(/directUpstream\.status=not_cheaper\./.test(wb) && !wb.includes("<b>") && wb.includes("/__operator/direct-upstream.json"), "Worker: the body echoes only a known word and names the operator endpoint");
}

// ---- source pins ------------------------------------------------------------------------------
{
  const kit = readFileSync(new URL("../src/tools/llm-gateway-kit.js", import.meta.url), "utf8");
  ok(/const price = directPriceDecision\(outbound\.model, \{ inputTokens: estimateInputTokens\(plan\.body, 0\), outputTokens: plan\.body\.max_tokens, maxPrice: outbound\.provider\?\.max_price \}\);\s*if \(!price\.go\) \{ noteDirectSkip\(price\.skip\); return false; \}/.test(kit), "the kit asks the guard before every direct attempt, with the call's own estimate and max_price");
  ok(!/refreshDirectPriceBook/.test(kit), "the kit never refreshes the book (no fetch on the request path)");
  const guard = readFileSync(new URL("../src/gateway-direct-pricebook.js", import.meta.url), "utf8");
  const logs = guard.match(/console\.(log|warn|error)\([^;]*;/g) || [];
  ok(logs.length === 1 && /price book: \$\{word === "ok" \? "cheaper" : word\}/.test(logs[0]), "the guard's only log line prints a word");
}

direct.server.close(); or.server.close();
globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
