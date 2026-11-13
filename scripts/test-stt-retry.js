// Transcription: one more upstream attempt on a failure that passes on its own.
//
// An upstream 5xx, a rate limit naming a short wait, or a connection that
// failed used to be the buyer's 502/503/504 after a single attempt. The kit
// now makes ONE more attempt on the same model, inside the cap the path
// already had, and says so in `agent402_retried`. This suite pins the bounds:
// what is retried, what never is, that each attempt is counted by the egress
// meter and the daily ceiling, and that only a served attempt is recorded as
// spend. Offline: fetch is a stub; no vendor is called.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)

process.env.OPENAI_API_KEY = "sk-test-not-real";
process.env.OPENROUTER_API_KEY = "or-test-not-real";
delete process.env.HARDCAP_OPENAI_CALLS;

const U = await import("../src/upstream-costs.js");
const PH = await import("../src/posthog.js");
const { installEgressMeter, egressReport } = await import("../src/egress-meter.js");
const { hardCapStatus, _resetHardCaps } = await import("../src/upstream-hard-caps.js");
const { withPushExceptionText } = await import("../src/prepayment-refusal.js");
const { PUSH_EXCEPTION } = await import("../src/tempo-push-debts.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// ---- the upstream stub, installed UNDER the egress meter ----
const AUDIO_URL = "http://93.184.216.34/audio.wav"; // public literal: validated without DNS, served by the stub
function makeWav(seconds) {
  const sr = 8000, n = Math.round(sr * seconds), b = Buffer.alloc(44 + n, 0x80);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  return b;
}
const SHORT = makeWav(3);
const json = (status, body, headers = {}) => () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const served = (extra = {}) => json(200, { text: "hello there", language: "en", ...extra });
const reset = (code) => () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) }); };
const hang = () => (init) => new Promise((_, rej) => { init.signal.addEventListener("abort", () => rej(init.signal.reason)); });
const after = (ms, step) => async (init) => { await new Promise((r) => setTimeout(r, ms)); return step(init); };

let plan = [];        // one step per upstream attempt, in order
let upstream = [];    // hosts the transcription attempts reached
let audioWav = SHORT;
const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return ""; } };
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith(AUDIO_URL)) return new Response(audioWav, { status: 200, headers: { "content-type": "audio/wav" } });
  if (!(init?.body instanceof FormData)) throw new Error(`unexpected fetch in an offline suite: ${hostOf(url)}`);
  upstream.push(hostOf(url));
  const step = plan.shift();
  if (!step) throw new Error("the kit made more upstream attempts than the case planned");
  return step(init);
};
installEgressMeter(); // wraps the stub: every attempt below passes the meter and the ceiling

const { STT_TOOLS, STT_TIERS, STT_MARGIN, STT_RETRY_AFTER_MAX_MS, makeMultipartHandler, __setSttRetryForTest, __setMeasureForTest } = await import("../src/tools/stt-kit.js");
// The decode measurement reads the WAV's own length (8 kHz 8-bit mono): this
// suite is about the upstream attempts, and its lane has no ffmpeg.
__setMeasureForTest(async (b) => ({ seconds: (b.length - 44) / 8000 }));

// Rates derived from each tier's own price so one attempt at the cap sits
// exactly on the margin bound: two billed attempts fit only for audio of at
// most half the standard cap. No rate is typed here.
const atCap = STT_MARGIN * STT_TIERS.transcribe.priceUsd / STT_TIERS.transcribe.maxMinutes;
U.setUpstreamCostsForTest({ sttPerMinute: { [STT_TIERS.transcribe.model]: atCap, [STT_TIERS.transcribe.diarizeModel]: atCap } });
const metered = [];
PH.setMeterSpendSinkForTest((source, usd) => metered.push({ source, usd }));
const tick = () => new Promise((r) => setTimeout(r, 30));

// AbortSignal.timeout does not hold the event loop open; a case that waits on one needs this.
const keepAlive = setInterval(() => {}, 1000);
const CAP = 900, FLOOR = 300;
let slept = [];
const knobs = (capMs = CAP) => __setSttRetryForTest({ capMs, minLeftMs: FLOOR, pauseMs: () => 7, sleep: async (ms) => { slept.push(ms); } });
knobs();

async function multipartReq(fields = {}, wav = SHORT, extra = {}) {
  const fd = new FormData();
  fd.append("file", new Blob([wav]), "clip.wav");
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = new Request("http://x/", { method: "POST", body: fd });
  return { headers: { "content-type": r.headers.get("content-type") }, body: Buffer.from(await r.arrayBuffer()), ...extra };
}
const countOf = (host) => (egressReport({ top: 2000 }).hosts.find((h) => h.host === host)?.calls || 0);
const capUsed = () => hardCapStatus().upstreams.openai.usedToday;

/** Run one case: returns { out, err, calls, ms, meter, cap, spend }. */
async function run(steps, call) {
  plan = [...steps]; upstream = []; slept = []; metered.length = 0;
  const m0 = countOf("api.openai.com") + countOf("openrouter.ai"), c0 = capUsed(), t0 = Date.now();
  let out = null, err = null;
  try { out = await call(); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  await tick();
  return { out, err, calls: upstream.length, hosts: [...upstream], ms, meter: countOf("api.openai.com") + countOf("openrouter.ai") - m0, cap: capUsed() - c0, spend: metered.length, left: plan.length };
}
const viaWire = (slug, fields, wav, extra) => async () => makeMultipartHandler(slug)({}, await multipartReq(fields, wav, extra));
const viaUrl = (slug, input = {}, req = { headers: {} }) => () => STT_TOOLS.find((t) => t.slug === slug).handler({ url: AUDIO_URL, ...input }, req);

// ---- a first attempt that answers is untouched ----
{
  const r = await run([served()], viaWire("transcribe"));
  ok(r.out?.text === "hello there" && r.calls === 1 && !("agent402_retried" in r.out), "a first attempt that answers is served as before, with no disclosure field");
}

// ---- 5xx then 200: served once, disclosed, counted twice ----
for (const [label, call, host, status] of [
  ["/v1/audio/transcriptions (upload)", viaWire("transcribe"), "api.openai.com", 500],
  ["/api/transcribe (URL)", viaUrl("transcribe"), "api.openai.com", 502],
  ["/api/transcribe-pro (URL)", viaUrl("transcribe-pro"), "api.openai.com", 503],
  ["/v1/pro/audio/transcriptions (upload)", viaWire("transcribe-pro"), "api.openai.com", 500],
  ["the diarized path", viaWire("transcribe", { diarize: "true" }), "openrouter.ai", 502],
]) {
  const r = await run([json(status, { error: { message: "server had an error" } }), served()], call);
  ok(r.out?.text === "hello there" && r.calls === 2 && r.left === 0, `${label}: an upstream ${status} then a 200 answers the transcript after two attempts (calls ${r.calls}, error ${r.err?.message})`);
  const d = r.out?.agent402_retried;
  ok(d && d.attempts === 2 && d.reason === `the first upstream attempt failed (HTTP ${status}); a second attempt on the same model served this transcript`, `${label}: the answer says so in agent402_retried (${JSON.stringify(d)})`);
  ok(r.hosts.every((h) => h === host) && r.meter === 2, `${label}: both attempts went to the same upstream and the egress meter counted two calls (${r.meter})`);
  if (host === "api.openai.com") ok(r.cap === 2, `${label}: the daily ceiling counted two calls (${r.cap})`);
  ok(r.spend === 1, `${label}: spend is recorded once, for the attempt that served (${r.spend})`);
  ok(slept.length === 1 && slept[0] === 7, `${label}: one short pause before the second attempt (${JSON.stringify(slept)})`);
}

// ---- two failures: the error, after exactly two attempts, inside the cap ----
{
  const r = await run([json(500, {}), json(503, {})], viaWire("transcribe"));
  ok(r.err?.statusCode === 502 && r.calls === 2, `two upstream failures answer the upstream error after two attempts, never three (status ${r.err?.statusCode}, calls ${r.calls})`);
  ok(r.ms < CAP, `both attempts ended inside the path's cap (${r.ms} ms of ${CAP})`);
  ok(/\(2 attempts\)/.test(r.err.message) && /Nothing was charged\./.test(r.err.message) && /Retry in a minute/.test(r.err.message), `the error names the attempts, that nothing was charged and what to do (${r.err.message})`);
  // The route binder rewrites this exact sentence for a Tempo transfer sent before the call.
  ok(withPushExceptionText(r.err.message, true).includes(`Nothing was charged${PUSH_EXCEPTION}.`), "the charge sentence is the one the route binder extends for a Tempo push credential");
  ok(/diarize:true/.test(r.err.message), "the default path's error names the diarized path as the other way to a transcript");
  ok(r.spend === 0, "a call that served nothing records no spend");
  const d = await run([json(500, {}), json(500, {})], viaWire("transcribe", { diarize: "true" }));
  ok(d.err?.statusCode === 502 && d.calls === 2 && /without diarize/.test(d.err.message) && !/diarize:true/.test(d.err.message), `the diarized path's error names the default path instead (${d.err?.message})`);
  // A skill pack runs the handler with no request and answers 200 with the
  // step's error text, so the claim is made only on a route call.
  const p = await run([json(500, {}), json(500, {})], viaUrl("transcribe", {}, null));
  ok(p.err?.statusCode === 502 && p.calls === 2 && !/charged/i.test(p.err.message), `a handler run outside a route call makes no charge claim (${p.err?.message})`);
}

// ---- the request's own fault is never retried ----
{
  const r = await run([json(400, { error: { message: "Audio file might be corrupted or unsupported" } })], viaWire("transcribe"));
  ok(r.err?.statusCode === 400 && r.calls === 1 && slept.length === 0, `an upstream 400 about the audio is a 400 after one attempt (status ${r.err?.statusCode}, calls ${r.calls})`);
  const a = await run([json(401, { error: { message: "bad key" } })], viaWire("transcribe"));
  ok(a.err?.statusCode === 502 && a.calls === 1, "our key refused is not retried");
  const b = await run([json(429, { error: { code: "insufficient_quota" } }, { "retry-after": "1" })], viaWire("transcribe"));
  ok(b.err?.statusCode === 503 && b.calls === 1 && /our side/.test(b.err.message), "our own billing limit is not retried, even with a short Retry-After");
}

// ---- an answer the upstream delivered is never bought twice ----
for (const [label, step] of [["a 200 that is not JSON", json(200, "<html>oops</html>")], ["a 200 with no transcript field", json(200, { language: "en" })]]) {
  const r = await run([step], viaWire("transcribe"));
  ok(r.err?.statusCode === 502 && r.calls === 1 && slept.length === 0, `${label} (delivered, possibly billed, then discarded) is final after one attempt (calls ${r.calls})`);
  const d = await run([step], viaWire("transcribe", { diarize: "true" }));
  ok(d.err?.statusCode === 502 && d.calls === 1, `${label} on the diarized path is final after one attempt`);
}

// ---- time: a timeout spends the cap; a late failure leaves too little ----
{
  const r = await run([hang()], viaWire("transcribe"));
  ok(r.err?.statusCode === 504 && r.calls === 1 && slept.length === 0, `a timeout is final after one attempt (status ${r.err?.statusCode}, calls ${r.calls})`);
  ok(r.ms >= CAP - 50 && r.ms < CAP + 400, `the timeout fired at the path's cap (${r.ms} ms)`);
  const late = await run([after(CAP - FLOOR + 80, json(500, {}))], viaWire("transcribe"));
  ok(late.err?.statusCode === 502 && late.calls === 1 && /Nothing was charged\./.test(late.err.message) && !/attempts\)/.test(late.err.message), `a 5xx that leaves less than the floor is not retried (calls ${late.calls})`);
  // The second attempt gets only what is left of the cap.
  const two = await run([after(400, json(500, {})), hang()], viaWire("transcribe"));
  ok(two.err?.statusCode === 504 && two.calls === 2 && two.ms < CAP + 250, `a second attempt that hangs is cut off at the same cap, not a fresh one (${two.ms} ms, cap ${CAP})`);
  // The CDN answer window and the payment authorization bound it too.
  const cdn = await run([json(500, {})], viaWire("transcribe", {}, SHORT, { cdnSyncDeadlineMs: Date.now() + FLOOR - 100 }));
  ok(cdn.err?.statusCode === 502 && cdn.calls === 1, "with less than the floor left in the CDN answer window the failure is not retried");
  const roomy = await run([json(500, {}), served()], viaWire("transcribe", {}, SHORT, { cdnSyncDeadlineMs: Date.now() + 60_000 }));
  ok(roomy.out?.agent402_retried && roomy.calls === 2, "with room in the CDN answer window it is");
}

// ---- rate limits: only a short named wait ----
{
  knobs(5000); // room for a named wait; the stubbed sleep does not spend it
  const r = await run([json(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "1" }), served()], viaWire("transcribe"));
  ok(r.out?.agent402_retried?.reason.includes("HTTP 429") && r.calls === 2 && slept[0] === 1000, `a 429 naming a 1 s wait is retried after that wait (${JSON.stringify(slept)})`);
  const ms = await run([json(429, {}, { "retry-after-ms": "40" }), served()], viaWire("transcribe"));
  ok(ms.out && ms.calls === 2 && slept[0] === 40, "the millisecond header is read");
  const none = await run([json(429, { error: { code: "rate_limit_exceeded" } })], viaWire("transcribe"));
  ok(none.err?.statusCode === 503 && none.calls === 1, "a 429 naming no wait is not retried");
  const long = await run([json(429, {}, { "retry-after": String(STT_RETRY_AFTER_MAX_MS / 1000 + 1) })], viaWire("transcribe"));
  ok(long.err?.statusCode === 503 && long.calls === 1, "a 429 naming a longer wait is not retried");
  const noRoom = await run([json(429, {}, { "retry-after": "1" })], viaWire("transcribe", {}, SHORT, { cdnSyncDeadlineMs: Date.now() + FLOOR + 500 }));
  ok(noRoom.err?.statusCode === 503 && noRoom.calls === 1, "a named wait that would leave less than the floor is not retried");
  knobs();
}

// ---- connection failures: unbilled always; possibly billed only inside the margin ----
{
  const halfCapS = STT_TIERS.transcribe.maxMinutes * 60 / 2;
  const LONG = makeWav(halfCapS + 30), FITS = makeWav(halfCapS - 30);
  const r = await run([reset("ECONNRESET"), served()], viaWire("transcribe", {}, FITS));
  ok(r.out?.agent402_retried?.reason.includes("(connection)") && r.calls === 2, `a connection reset on audio whose two billed attempts fit the margin bound is retried (calls ${r.calls}, ${r.err?.message})`);
  const big = await run([reset("ECONNRESET")], viaWire("transcribe", {}, LONG));
  ok(big.err?.statusCode === 504 && big.calls === 1, `a connection reset on audio whose two billed attempts would pass the bound is not retried (calls ${big.calls})`);
  const never = await run([reset("ECONNREFUSED"), served()], viaWire("transcribe", {}, LONG));
  ok(never.out?.agent402_retried && never.calls === 2, "a connection that never opened (nothing generated) is retried at any length");
  U.setUpstreamCostsForTest({ sttPerMinute: {} });
  const noRate = await run([reset("ECONNRESET")], viaWire("transcribe", {}, FITS));
  ok(noRate.err?.statusCode === 504 && noRate.calls === 1, "with no rate row a possibly billed failure is not retried");
  U.setUpstreamCostsForTest({ sttPerMinute: { [STT_TIERS.transcribe.model]: atCap, [STT_TIERS.transcribe.diarizeModel]: atCap } });
}

// ---- the daily ceiling refuses the second attempt like any other call ----
{
  _resetHardCaps();
  process.env.HARDCAP_OPENAI_CALLS = "1";
  const r = await run([json(500, {})], viaWire("transcribe"));
  ok(r.err?.statusCode === 503 && r.err.hardCap === true && r.calls === 1, `at the ceiling the second attempt is refused before it leaves (status ${r.err?.statusCode}, upstream calls ${r.calls})`);
  const again = await run([], viaWire("transcribe"));
  ok(again.err?.statusCode === 503 && again.err.hardCap === true && again.calls === 0, "a first attempt past the ceiling answers the ceiling's own 503");
  delete process.env.HARDCAP_OPENAI_CALLS;
  _resetHardCaps();
}

__setSttRetryForTest();
clearInterval(keepAlive);
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
