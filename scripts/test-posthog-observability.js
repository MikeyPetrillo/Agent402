// PostHog LLM analytics and error tracking (src/posthog-observability.js):
// every event carries only its allowlisted fields, and no prompt, answer,
// request body, header value, payer address or secret reaches a payload;
// sampling, hourly ceilings, the fingerprint window and the bounded queue
// hold; each off switch and an absent key send nothing; the gateway usage
// hook and the exception hooks in server.js are wired (offline).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A configured secret the scrubber must take out of any message.
const SECRET = "sk-or-v1-" + "a1b2c3d4e5f6a7b8c9d0".repeat(3);
process.env.OPENROUTER_API_KEY = SECRET;
process.env.POSTHOG_TEST_CAPTURE = "1";

const obs = await import("../src/posthog-observability.js");
const posthog = await import("../src/posthog.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };

const PAYER = "0x" + "ab12".repeat(10);
const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const PROMPT = "please summarize my secret diary entry about lunch";
const ANSWER = "The diary says lunch was a sandwich";
const EMAIL = "someone@example.com";
const URL_Q = "https://upstream.example.test/v1/chat?api_key=zzz&user=bob";
const FORBIDDEN = [SECRET, PAYER, PAYER.slice(2), SOL, PROMPT, ANSWER, EMAIL, "upstream.example.test", "api_key", "diary", "/Users/", "/home/"];
const leaks = (o) => { const s = JSON.stringify(o); return FORBIDDEN.filter((f) => s.includes(f)); };
const keysOnlyFrom = (o, allowed) => Object.keys(o).every((k) => allowed.includes(k) || k === "$process_person_profile");

// --- builders: allowlist and scrubbing ------------------------------------------
{
  const ev = obs.aiGenerationEventOf({ tier: "v1-chat-nano", model: `openai/gpt-x ${PROMPT}`, promptTokens: 12.7, completionTokens: -4, latencyMs: 1500, servedBy: "openrouter", prompt: PROMPT, answer: ANSWER, payer: PAYER, body: { messages: [PROMPT] } });
  ok(keysOnlyFrom(ev, obs.AI_GENERATION_FIELDS), `$ai_generation keys are the allowlist only (${Object.keys(ev).join(",")})`);
  ok(!("$ai_input" in ev) && !("$ai_output_choices" in ev) && !("$ai_total_cost_usd" in ev), "no $ai_input, $ai_output_choices or cost field");
  ok(ev.$ai_input_tokens === 12 && ev.$ai_output_tokens === 0 && ev.$ai_latency === 1.5 && ev.$ai_provider === "openrouter" && ev.$ai_is_error === false, "tokens floored and clamped, latency in seconds, provider bucketed");
  ok(!/\s/.test(ev.$ai_model) && ev.$ai_model.length <= 120, "model id is a label (no spaces), bounded");
  ok(leaks({ ...ev, $ai_model: "" }).length === 0, "no prompt, answer, payer or body value in the model event");
  const err = obs.aiGenerationEventOf({ tier: "v1-chat", httpStatus: 502 });
  ok(err.$ai_is_error === true && err.$ai_http_status === 502, "a 5xx generation reads as an error");
}
{
  const e = new TypeError(`Upstream rejected key ${SECRET} for ${PAYER} at ${URL_Q} from ${EMAIL}: "${PROMPT}" {"messages":["${ANSWER}","more padding here to pass forty chars"]} nonce 12345678 ${SOL}`);
  const ev = obs.exceptionEventOf(e, { source: "tool", slug: "v1-chat", status: 502 });
  ok(keysOnlyFrom(ev, obs.EXCEPTION_FIELDS), "$exception keys are the allowlist only");
  const entry = ev.$exception_list[0];
  ok(Object.keys(entry).every((k) => obs.EXCEPTION_ENTRY_FIELDS.includes(k)), "exception entry keys are the allowlist only");
  ok(entry.stacktrace.frames.length > 0 && entry.stacktrace.frames.every((f) => Object.keys(f).every((k) => obs.FRAME_FIELDS.includes(k))), "frames carry only file, function, line, column, in_app, platform");
  ok(entry.stacktrace.frames.some((f) => f.filename === "scripts/test-posthog-observability.js"), "an app frame is relative to the repo root");
  ok(entry.type === "TypeError" && entry.value.length <= 200, `type kept, message bounded (${JSON.stringify(entry.value)})`);
  ok(leaks(ev).length === 0, `no secret, address, URL, email, quoted input or body in the exception (${leaks(ev).join(", ")})`);
  ok(!/12345678/.test(entry.value), "long numbers replaced");
  const nonErr = obs.exceptionEventOf({ prompt: PROMPT, payer: PAYER });
  ok(nonErr.$exception_list[0].type === "NonError" && leaks(nonErr).length === 0, "a rejection that is not an Error sends a fixed text, never the value");
  const str = obs.exceptionEventOf(`raw ${PROMPT}`);
  ok(leaks(str).length === 0, "a string rejection is not sent");
  const outside = new Error("x");
  outside.stack = "Error: x\n    at secretFn (/Users/someone/private/thing.js:1:2)\n    at /home/u/app/node_modules/pkg/index.js:3:4";
  const fr = obs.exceptionEventOf(outside).$exception_list[0].stacktrace.frames;
  ok(fr.length === 2 && fr.some((f) => f.filename === "thing.js") && fr.some((f) => f.filename === "node_modules/pkg/index.js" && f.in_app === false), "a file outside the app keeps its base name; a package keeps node_modules/<pkg>/...");
  ok(leaks(fr).length === 0, "no home or user directory in a frame");
  const hostile = new Error("y");
  hostile.stack = "Error\n" + `    at ${"(".repeat(5000)} (/a.js:1:1)\n`.repeat(200);
  const t0 = performance.now(); obs.exceptionEventOf(hostile); const ms = performance.now() - t0;
  ok(ms < 200, `a hostile stack parses in bounded time (${ms.toFixed(1)} ms)`);
  const t1 = performance.now(); obs.scrubErrorMessage("@".repeat(1_000_000) + "a".repeat(100_000)); const ms2 = performance.now() - t1;
  ok(ms2 < 200, `a hostile message scrubs in bounded time (${ms2.toFixed(1)} ms)`);
}

// --- capture path: sink, switches, sampling, ceilings, queue -----------------------
{
  const sent = [];
  obs._setSinkForTest((event, props) => sent.push({ event, props }));
  obs._resetObservabilityForTest({ env: {} });
  ok(obs.captureAiGeneration({ tier: "v1-chat", model: "m" }) === true, "a model call queues with the key present");
  ok(obs.flushObservability() === 1 && sent.length === 1 && sent[0].event === "$ai_generation", "the flush sends it through the sink");

  obs._resetObservabilityForTest({ env: { POSTHOG_AI_EVENTS: "off", POSTHOG_EXCEPTIONS: "OFF" } });
  ok(obs.captureAiGeneration({ tier: "v1-chat" }) === false && obs.captureServerException(new Error("z")) === false && obs._queueForTest().length === 0, "each off switch sends nothing");

  obs._setSinkForTest((event, props) => sent.push({ event, props }), () => false);
  obs._resetObservabilityForTest({ env: {} });
  ok(obs.captureAiGeneration({ tier: "v1-chat" }) === false && obs.captureServerException(new Error("z")) === false && obs.noteWebBotAuth({ agent: "a", verified: true }) === false, "without the key (inactive sink) nothing queues");
  obs._setSinkForTest((event, props) => sent.push({ event, props }));

  obs._resetObservabilityForTest({ env: { POSTHOG_AI_SAMPLE: "0.5" }, random: () => 0.9 });
  ok(obs.captureAiGeneration({ tier: "v1-chat" }) === false, "a sampled-out call is not queued");
  obs._resetObservabilityForTest({ env: { POSTHOG_AI_SAMPLE: "0.5" }, random: () => 0.1 });
  ok(obs.captureAiGeneration({ tier: "v1-chat" }) === true, "a sampled-in call is queued");
  obs._resetObservabilityForTest({ env: { POSTHOG_AI_SAMPLE: "0" } });
  ok(obs.captureAiGeneration({ tier: "v1-chat" }) === false, "sample 0 sends nothing");

  obs._resetObservabilityForTest({ env: { POSTHOG_AI_HOURLY_MAX: "3" } });
  let n = 0; for (let i = 0; i < 10; i++) if (obs.captureAiGeneration({ tier: "v1-chat" })) n++;
  ok(n === 3, `the hourly ceiling holds (${n} of 10)`);

  obs._resetObservabilityForTest({ env: { POSTHOG_AI_HOURLY_MAX: "100000" } });
  for (let i = 0; i < 1000; i++) obs.captureAiGeneration({ tier: "v1-chat" });
  const st = obs.observabilityStats();
  ok(st.queued === obs.OBS_QUEUE_MAX && st.dropped === 1000 - obs.OBS_QUEUE_MAX, `the queue is bounded at ${obs.OBS_QUEUE_MAX} and counts what it drops (${st.dropped})`);

  obs._resetObservabilityForTest({ env: {} });
  const mk = () => { try { null.x; } catch (e) { return e; } };
  ok(obs.captureServerException(mk()) === true && obs.captureServerException(mk()) === false, "one fingerprint is sent once per window");
  obs._resetObservabilityForTest({ env: { POSTHOG_EXCEPTION_HOURLY_MAX: "2" } });
  const distinct = [() => { throw new RangeError("a"); }, () => { throw new SyntaxError("b"); }, () => { throw new EvalError("c"); }].map((f) => { try { f(); } catch (e) { return e; } });
  ok(distinct.filter((e) => obs.captureServerException(e)).length === 2, "the exception hourly ceiling holds");

  obs._resetObservabilityForTest({ env: {} });
  sent.length = 0;
  obs.noteWebBotAuth({ agent: "https://agent.example.test/.well-known/http-message-signatures-directory", verified: true, reason: "ok" });
  obs.noteWebBotAuth({ agent: "https://agent.example.test/.well-known/http-message-signatures-directory", verified: true, reason: "ok" });
  obs.noteWebBotAuth({ agent: "https://evil.example.test", verified: false, reason: "bad-signature" });
  obs.flushWebBotAuthRollup(); obs.flushObservability();
  const wba = sent.filter((e) => e.event === "web_bot_auth");
  ok(wba.length === 2 && wba.every((e) => keysOnlyFrom(e.props, obs.WEB_BOT_AUTH_FIELDS)) && wba.find((e) => e.props.verified).props.count === 2, "the verified-agent rollup counts per agent with allowlisted fields");
  ok(!JSON.stringify(wba).includes("evil.example.test"), "an unverified claim never names its claimed agent");
  obs._setSinkForTest(null);
}

// --- the real hooks: posthog.js test sink and server.js wiring ------------------
{
  obs._resetObservabilityForTest({ env: {} });
  // Re-register posthog.js's own capture (the test above replaced the sink).
  const reg = readFileSync(new URL("../src/posthog.js", import.meta.url), "utf8");
  ok(/registerObservabilitySink\(/.test(reg) && /captureAiGeneration\(\{ tier, routeTier, model, promptTokens, completionTokens, servedBy, source: src, serviceTier, defaulted \}\)/.test(reg), "posthog.js registers its capture and the gateway usage hook passes counts and labels only");
  ok(/flushObservability\(\)/.test(reg.slice(reg.indexOf("export async function shutdownPostHog"))), "shutdown drains the queue");
}
{
  // A fresh import graph with the test sink: the gateway usage event yields a
  // $ai_generation beside gateway_usage, carrying no prompt or answer.
  const { spawnSync } = await import("node:child_process");
  const code = `
    import "./scripts/lib/offline-stores.js";
    const ph = await import("./src/posthog.js");
    const obs = await import("./src/posthog-observability.js");
    ph.capturePostHogGatewayUsage({ tier: "v1-chat-nano", model: "openai/gpt-test", priceUsd: 0.001, promptTokens: 10, completionTokens: 5, servedBy: "openrouter", prompt: ${JSON.stringify(PROMPT)}, messages: [${JSON.stringify(ANSWER)}], payer: ${JSON.stringify(PAYER)} });
    obs.captureServerException(new Error("boom ${PAYER}"), { source: "tool", slug: "v1-chat", status: 502 });
    obs.flushObservability();
    const evs = ph._testEventsForTest().filter((e) => e.event.startsWith("$"));
    process.stdout.write(JSON.stringify(evs));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, POSTHOG_TEST_CAPTURE: "1", POSTHOG_API_KEY: "" }, encoding: "utf8", timeout: 60_000 });
  let evs = [];
  try { evs = JSON.parse(r.stdout.split("\n").filter((l) => l.startsWith("[")).pop() || "[]"); } catch { evs = []; }
  const ai = evs.find((e) => e.event === "$ai_generation"), ex = evs.find((e) => e.event === "$exception");
  ok(ai && ai.properties.$ai_model === "openai/gpt-test" && ai.properties.$ai_input_tokens === 10 && ai.properties.$process_person_profile === false, `the gateway usage hook emits $ai_generation through posthog.js (${r.status} ${String(r.stderr).slice(0, 200)})`);
  ok(ex && ex.properties.slug === "v1-chat", "an exception goes out through posthog.js");
  ok(leaks(evs).length === 0, `nothing forbidden in what posthog.js would send (${leaks(evs).join(", ")})`);
  ok(evs.every((e) => keysOnlyFrom(e.properties, e.event === "$ai_generation" ? obs.AI_GENERATION_FIELDS : obs.EXCEPTION_FIELDS)), "every emitted event carries only its allowlist plus the anonymous flag");
}
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/process\.on\("unhandledRejection"[\s\S]{0,300}captureServerException\(reason, \{ source: "unhandledRejection" \}\)/.test(src), "an unhandled rejection is captured");
  ok(/process\.on\("uncaughtException"[\s\S]{0,300}captureServerException\(err, \{ source: "uncaughtException", handled: false, level: "fatal" \}\)/.test(src), "an uncaught exception is captured as fatal before the drain");
  ok(/if \(status >= 500\) captureServerException\(err, \{ source: "tool", slug: tool\.slug, status \}\)/.test(src), "a tool 5xx is captured with its slug and status");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
