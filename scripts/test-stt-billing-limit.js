// transcribe: when the upstream refuses because this server's own account
// reached its spending or billing limit, the refusal names our side (a 503,
// not a rate limit to retry at once, not the buyer's request) and names no
// upstream. Ordinary rate limits and request errors keep their own answers.
// Offline: a synthetic WAV is uploaded through the multipart handler and
// fetch answers with bodies shaped like the transcription API's errors.
import { makeMultipartHandler } from "../src/tools/stt-kit.js";

process.env.OPENAI_API_KEY = "sk-test-not-real";
process.env.OPENROUTER_API_KEY = "or-test-not-real";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

function makeWav(seconds) {
  const sr = 8000, n = Math.round(sr * seconds), b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  return b;
}
async function multipart(fields) {
  const fd = new FormData();
  fd.append("file", new Blob([makeWav(3)]), "clip.wav");
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const req = new Request("http://x/", { method: "POST", body: fd });
  return { headers: { "content-type": req.headers.get("content-type") }, body: Buffer.from(await req.arrayBuffer()) };
}
let reply = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (init?.body instanceof FormData) return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  return realFetch(url, init);
};
const call = async (fields = {}) => { try { await makeMultipartHandler("transcribe")({}, await multipart(fields)); return null; } catch (e) { return e; } };
const UPSTREAM_NAMES = /openai|openrouter|elevenlabs/i;

for (const [label, r, fields] of [
  ["a 429 quota refusal", { status: 429, body: { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } } }, {}],
  ["a 400 billing hard limit", { status: 400, body: { error: { message: "Billing hard limit has been reached", type: "invalid_request_error", code: "billing_hard_limit_reached" } } }, {}],
  ["a 402 on the diarize path", { status: 402, body: { error: { message: "Insufficient credits", code: 402 } } }, { diarize: "true" }],
]) {
  reply = r;
  const e = await call(fields);
  ok(e && e.statusCode === 503, `${label} is a 503 (got ${e?.statusCode})`);
  ok(e && /our side/i.test(e.message) && /spending limit/i.test(e.message), `${label} says it is our own limit (${e?.message})`);
  ok(e && !UPSTREAM_NAMES.test(e.message), `${label} names no upstream`);
}

reply = { status: 429, body: { error: { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" } } };
const rl = await call();
ok(rl && rl.statusCode === 503 && !/our side/i.test(rl.message) && /retry/i.test(rl.message), "an ordinary rate limit keeps its retry answer");
reply = { status: 400, body: { error: { message: "Invalid language code", type: "invalid_request_error", code: "invalid_value" } } };
const br = await call();
ok(br && br.statusCode === 400, "a request error stays a 400");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
