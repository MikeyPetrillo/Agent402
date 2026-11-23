#!/usr/bin/env node
// Every speech answer names the model that produced it (src/speech-served.js).
//
// A FREE_MODE boot sends its OpenRouter calls to a local stub
// (scripts/lib/openrouter-stub-preload.js) and reads, over HTTP:
//   - POST /v1/audio/speech with no model: X-Agent402-Model is the chain link
//     that spoke, with no fallback header;
//   - a named model that serves: the header names it, no fallback header;
//   - a named model that fails and a chain link that serves: the header names
//     the link, and X-Agent402-Model-Fallback is 1;
//   - /api/tts, /api/tts-hd and /api/tts-lite: the header matches the answer's
//     `model` field;
//   - a refused call (past a model's own character cap) carries neither header
//     and reaches no upstream;
//   - one [speech-served] log line per served call, naming the route, the
//     model asked for and the model that served, and nothing else.
// The cost table is the example file with the named models' rows derived
// from the route's price (no rate is typed here).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "./lib/boot-server.js";

const A = await import("../src/speech-additions.js");
const G = await import("../src/tools/llm-gateway-kit.js");
const { SERVED_MODEL_HEADER, MODEL_FALLBACK_HEADER } = await import("../src/speech-served.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`FAIL - ${m}`); } };

const EL = "elevenlabs/eleven-v3-conversational", VOX = "mistralai/voxtral-mini-tts-3-0";
const CHAIN = G.SPEECH_MODELS.map((m) => m.id);
const SPEECH_PRICE = Number(G.LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-audio-speech").price.replace("$", ""));
const elCap = A.speechMaxCharsFor(A.speechAdditionNamed(EL), G.SPEECH_MAX_CHARS);

// ---- the upstream stub ---------------------------------------------------------------
const failing = new Set();
const speechCalls = [];
const upstream = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const path = new URL(req.url, "http://stub").pathname;
  if (req.method === "POST" && path === "/api/v1/audio/speech") {
    const body = JSON.parse(raw || "{}");
    speechCalls.push(body.model);
    if (failing.has(body.model)) { res.writeHead(500, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "stub outage" } })); }
    res.writeHead(200, { "content-type": body.response_format === "pcm" ? "audio/pcm;rate=24000" : "audio/mpeg" });
    return res.end(Buffer.from(`audio-from:${body.model}`));
  }
  if (path === "/api/v1/models") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [] })); }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not stubbed" } }));
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const STUB = `http://127.0.0.1:${upstream.address().port}`;

// ---- the cost table: the example, with the named rows inside each one's bound -----------
const dir = mkdtempSync(join(tmpdir(), "speech-served-"));
const example = JSON.parse(readFileSync(new URL("../docs/example-upstream-costs.json", import.meta.url), "utf8"));
const rowAt = (id, share) => share * A.ADDITION_MARGIN * SPEECH_PRICE / A.speechMaxCharsFor(A.speechAdditionNamed(id), G.SPEECH_MAX_CHARS);
const table = { ...example, speech: { ...example.speech, [EL]: rowAt(EL, 0.5), [VOX]: rowAt(VOX, 0.5) } };
const costsFile = join(dir, "costs.json");
writeFileSync(costsFile, JSON.stringify(table));

let srv;
try {
  srv = await bootServer({
    args: ["--import", "./scripts/lib/openrouter-stub-preload.js"],
    stores: "speech-served",
    env: {
      FREE_MODE: "true", OPENROUTER_STUB_URL: STUB, MODEL_CATALOG_URL: `${STUB}/api/v1/models`, OPENROUTER_API_KEY: "test-key-never-used",
      OPENROUTER_TTS_ENABLED: "true", NAMED_AUDIO_MODELS: "all", UPSTREAM_COSTS_FILE: costsFile, UPSTREAM_COSTS_JSON: "",
      BASE_URL: "http://agent402.test", SLOW_SYNC_WINDOW_SECONDS: "off", POSTHOG_TEST_CAPTURE: "1",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", STATS_ALLOW_EPHEMERAL: "true",
      DIRECT_UPSTREAM_URL: "", DIRECT_UPSTREAM_KEY: "", DIRECT_UPSTREAM_MODELS: "", TARGET_URL: "",
    },
  });
  const post = async (path, body) => {
    const r = await fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, model: r.headers.get(SERVED_MODEL_HEADER), fallback: r.headers.get(MODEL_FALLBACK_HEADER), buf };
  };
  const servedLines = () => srv.log().split("\n").filter((l) => l.startsWith("[speech-served] ")).map((l) => JSON.parse(l.slice("[speech-served] ".length)));

  // /v1/audio/speech, no model: the chain's first link.
  {
    const r = await post("/v1/audio/speech", { input: "hello" });
    ok(r.status === 200 && r.buf.toString() === `audio-from:${CHAIN[0]}`, `default: served by the chain's first link (${r.status})`);
    ok(r.model === CHAIN[0] && r.fallback === null, `default: ${SERVED_MODEL_HEADER} names ${CHAIN[0]}, no fallback header (${r.model}, ${r.fallback})`);
  }
  // A named model that serves.
  {
    const r = await post("/v1/audio/speech", { input: "hello", model: "voxtral-tts-3" });
    ok(r.status === 200 && r.buf.toString() === `audio-from:${VOX}`, `named: ${VOX} spoke (${r.status})`);
    ok(r.model === VOX && r.fallback === null, `named and served: the header names it, no fallback header (${r.model}, ${r.fallback})`);
  }
  // A named model that fails; the chain behind it serves.
  {
    failing.add(VOX);
    speechCalls.length = 0;
    const r = await post("/v1/audio/speech", { input: "hello", model: VOX });
    failing.delete(VOX);
    ok(r.status === 200 && speechCalls.join() === [VOX, CHAIN[0]].join(), `named, failed: the walk went on to ${CHAIN[0]} (${speechCalls.join(" > ")})`);
    ok(r.model === CHAIN[0] && r.fallback === "1", `named, failed: the header names the link that spoke and ${MODEL_FALLBACK_HEADER} is 1 (${r.model}, ${r.fallback})`);
  }
  // A named model held to its own cap: at it served, past it refused with no header and no upstream call.
  {
    const at = await post("/v1/audio/speech", { input: "x".repeat(elCap), model: EL });
    ok(at.status === 200 && at.model === EL && at.fallback === null, `${EL} at its cap (${elCap} chars) is served and named (${at.status}, ${at.model})`);
    speechCalls.length = 0;
    const r = await fetch(`${srv.url}/v1/audio/speech`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "x".repeat(elCap + 1), model: EL }) });
    const j = await r.json().catch(() => null);
    ok(r.status === 400 && String(j?.error || "").includes(`up to ${elCap} chars`) && String(j?.error || "").includes(EL), `one char past it is a 400 naming the model's cap (${r.status} ${String(j?.error || "").slice(0, 120)})`);
    ok(!r.headers.has(SERVED_MODEL_HEADER) && !r.headers.has(MODEL_FALLBACK_HEADER) && speechCalls.length === 0, "the refusal carries no served-model header and reached no upstream");
  }
  // /v1/models lists each named model's own cap.
  {
    const j = await (await fetch(`${srv.url}/v1/models`)).json();
    const row = (id) => j.data.find((m) => m.id === id && m.x402?.tier === "v1-audio-speech");
    ok(row(EL)?.x402.maxInputChars === elCap && row(VOX)?.x402.maxInputChars === G.SPEECH_MAX_CHARS, `/v1/models: ${EL} lists ${elCap} chars, ${VOX} the route's ${G.SPEECH_MAX_CHARS}`);
  }
  // The JSON speech tiers: the header matches the answer's model field.
  for (const [path, want] of [["/api/tts", "elevenlabs/eleven-v4-turbo"], ["/api/tts-hd", "elevenlabs/eleven-v4"], ["/api/tts-lite", "hexgrad/kokoro-82m"]]) {
    const r = await fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello", voice: "alloy", format: "mp3" }) });
    const j = await r.json().catch(() => null);
    ok(r.status === 200 && j?.model === want && r.headers.get(SERVED_MODEL_HEADER) === want && !r.headers.has(MODEL_FALLBACK_HEADER), `${path}: ${SERVED_MODEL_HEADER} matches the answer's model (${r.status}, ${j?.model}, ${r.headers.get(SERVED_MODEL_HEADER)})`);
  }
  {
    const r = await fetch(`${srv.url}/api/tts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "" }) });
    ok(r.status === 400 && !r.headers.has(SERVED_MODEL_HEADER), "/api/tts: a refused call carries no served-model header");
  }
  // The log: one line per served call, these fields only.
  {
    const lines = servedLines();
    ok(lines.length === 7, `one [speech-served] line per served call (${lines.length})`);
    ok(lines.every((l) => Object.keys(l).join() === "route,requested,served,fallback"), "each names the route, the model asked for, the model that served, and whether it fell back; nothing else");
    ok(lines.some((l) => l.route === "/v1/audio/speech" && l.requested === VOX && l.served === CHAIN[0] && l.fallback === true), "the fallback call is logged with both models");
    ok(lines.some((l) => l.route === "/v1/audio/speech" && l.requested === null && l.served === CHAIN[0] && l.fallback === false), "the default call is logged with no model asked for");
    ok(lines.some((l) => l.route === "/api/tts" && l.requested === null && l.served === "elevenlabs/eleven-v4-turbo"), "the JSON tiers are logged too");
  }
} finally {
  await srv?.stop();
  await new Promise((r) => upstream.close(r));
  rmSync(dir, { recursive: true, force: true });
}

// An idempotent replay of a served answer carries the same model header: the
// replay middleware (src/idempotency.js) keeps it with the answer.
{
  const { default: express } = await import("express");
  const { createIdempotency } = await import("../src/idempotency.js");
  const { createLocalIdempotencyStore } = await import("../src/idempotency-store.js");
  const app = express();
  app.use(express.json());
  app.use(createIdempotency({ isCatalogRoute: () => true, freeMode: true, store: createLocalIdempotencyStore() }));
  let runs = 0;
  app.post("/api/tts", (req, res) => { runs++; res.setHeader(SERVED_MODEL_HEADER, "elevenlabs/eleven-v4-turbo"); res.setHeader(MODEL_FALLBACK_HEADER, "1"); res.json({ model: "elevenlabs/eleven-v4-turbo", audio: "AAAA" }); });
  const server = await new Promise((r) => { const sv = app.listen(0, "127.0.0.1", () => r(sv)); });
  const url = `http://127.0.0.1:${server.address().port}/api/tts`;
  const send = () => fetch(url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "speech-replay-1", "x-payment": "replay-credential" }, body: JSON.stringify({ text: "hi" }) });
  const a = await send(); await a.text();
  const b = await send(); await b.text();
  server.close();
  ok(runs === 1 && b.headers.get("x-idempotent-replay") === "true", `the second call is a replay (${runs} run, ${b.headers.get("x-idempotent-replay")})`);
  ok(b.headers.get(SERVED_MODEL_HEADER) === "elevenlabs/eleven-v4-turbo" && b.headers.get(MODEL_FALLBACK_HEADER) === "1", `a replayed speech answer carries ${SERVED_MODEL_HEADER} and ${MODEL_FALLBACK_HEADER} (${b.headers.get(SERVED_MODEL_HEADER)}, ${b.headers.get(MODEL_FALLBACK_HEADER)})`);
}

if (fail) { console.error(`\nspeech served model: ${pass} passed, ${fail} failed`); process.exit(1); }
console.log(`speech served model: ${pass} passed`);
