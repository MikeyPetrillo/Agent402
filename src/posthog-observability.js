// PostHog LLM analytics ($ai_generation) and error tracking ($exception) for
// the server, plus the verified-agent rollup of Web Bot Auth.
//
// On with the PostHog key (src/posthog.js registers its capture here at
// import; without POSTHOG_API_KEY nothing is captured and nothing queues).
// Each stream has its own off switch: POSTHOG_AI_EVENTS=off,
// POSTHOG_EXCEPTIONS=off.
//
// What an event may carry is an allowlist per event (the *_FIELDS below,
// enforced by `pickAllowed` on every event built here, and pinned by
// scripts/test-posthog-observability.js). Never sent: a prompt, an answer,
// a request body, a header value, a payer address, a secret. A model event
// carries the model id, the tier, token counts, status and latency; an
// exception carries its type, a scrubbed message (redactSecrets first, then
// every quoted string, address, URL, long token, email and long number
// replaced) and stack frames as file:line:column with the function name,
// never source lines or local values.
//
// Bounded: events wait in one queue of at most OBS_QUEUE_MAX entries (a full
// queue drops the newest and counts it), drained by an unref'd timer and on
// shutdown; each stream has a sample rate (POSTHOG_AI_SAMPLE,
// POSTHOG_EXCEPTION_SAMPLE, 0..1, default 1) and an hourly ceiling
// (POSTHOG_AI_HOURLY_MAX default 3000, POSTHOG_EXCEPTION_HOURLY_MAX default
// 120); an exception with the same fingerprint is sent once per 10 minutes.
import { createHash, randomUUID } from "node:crypto";
import { redactSecrets } from "./tools/redact.js";

export const AI_GENERATION_FIELDS = Object.freeze([
  "$ai_trace_id", "$ai_span_name", "$ai_model", "$ai_provider", "$ai_input_tokens", "$ai_output_tokens",
  "$ai_latency", "$ai_http_status", "$ai_is_error", "tier", "routeTier", "source", "serviceTier", "defaulted",
]);
export const EXCEPTION_FIELDS = Object.freeze(["$exception_list", "$exception_fingerprint", "$exception_level", "source", "slug", "status"]);
export const EXCEPTION_ENTRY_FIELDS = Object.freeze(["type", "value", "mechanism", "stacktrace"]);
export const FRAME_FIELDS = Object.freeze(["filename", "function", "lineno", "colno", "in_app", "platform"]);
export const WEB_BOT_AUTH_FIELDS = Object.freeze(["agent", "verified", "reason", "count"]);

export const OBS_QUEUE_MAX = 256;
const FLUSH_MS = 2_000;
const MAX_FRAMES = 40;

const num01 = (v, d) => { const n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? d : Math.min(1, Math.max(0, n)); };
const posInt = (v, d) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : d; };
function config(env = process.env) {
  return {
    aiOn: String(env.POSTHOG_AI_EVENTS || "").toLowerCase() !== "off",
    excOn: String(env.POSTHOG_EXCEPTIONS || "").toLowerCase() !== "off",
    aiSample: num01(env.POSTHOG_AI_SAMPLE, 1),
    excSample: num01(env.POSTHOG_EXCEPTION_SAMPLE, 1),
    aiHourly: posInt(env.POSTHOG_AI_HOURLY_MAX, 3000),
    excHourly: posInt(env.POSTHOG_EXCEPTION_HOURLY_MAX, 120),
  };
}
let cfg = config();

// --- the sink -----------------------------------------------------------------
let sink = null; // { capture(event, props), active() }
/** src/posthog.js hands over its capture and its "is PostHog on" check. */
export function registerObservabilitySink(capture, active) {
  if (typeof capture === "function" && typeof active === "function") sink = { capture, active };
}
const sinkActive = () => { try { return !!(sink && sink.active()); } catch { return false; } };

const queue = [];
let dropped = 0;
let timer = null;
function enqueue(event, props) {
  if (queue.length >= OBS_QUEUE_MAX) { dropped++; return false; }
  queue.push({ event, props });
  if (!timer) {
    timer = setTimeout(() => { timer = null; flushObservability(); }, FLUSH_MS);
    timer.unref?.();
  }
  return true;
}
/** Send everything queued (called by the timer and by shutdownPostHog). */
export function flushObservability() {
  if (timer) { clearTimeout(timer); timer = null; }
  const items = queue.splice(0, queue.length);
  if (!sink) return items.length;
  for (const { event, props } of items) { try { sink.capture(event, props); } catch { /* telemetry never throws */ } }
  return items.length;
}
export function observabilityStats() { return { queued: queue.length, dropped, max: OBS_QUEUE_MAX }; }

// Hourly windows per stream.
const windows = { ai: { start: 0, n: 0 }, exc: { start: 0, n: 0 } };
function underHourly(kind, max, now = Date.now()) {
  const w = windows[kind];
  if (now - w.start >= 3_600_000) { w.start = now; w.n = 0; }
  if (w.n >= max) return false;
  w.n++;
  return true;
}
let rand = Math.random;
const sampled = (rate) => rate >= 1 || (rate > 0 && rand() < rate);

/** Keep only the listed keys (and drop undefined values). */
export function pickAllowed(obj, allowed) {
  const out = {};
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// --- text scrubbing -------------------------------------------------------------
const label = (v, max = 80) => String(v ?? "").replace(/[^A-Za-z0-9._:/@+-]/g, "").slice(0, max);
/** An error message reduced to its wording: secrets, quoted text, addresses,
 *  URLs, emails, long tokens and long numbers replaced. At most 200 chars. */
export function scrubErrorMessage(message) {
  let s = String(message ?? "").slice(0, 2_000);
  try { s = redactSecrets(s); } catch { s = ""; }
  s = s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/"[^"]{0,2000}"|'[^']{0,2000}'|`[^`]{0,2000}`/g, "<str>")
    .replace(/\b[a-z][a-z0-9+.-]{1,20}:\/\/\S+/gi, "<url>")
    .replace(/[^\s@<>]{1,64}@[^\s@<>]{1,255}\.[a-z]{2,}/gi, "<email>")
    .replace(/0x[0-9a-fA-F]{6,}/g, "<hex>")
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, "<token>")
    .replace(/\d{6,}/g, "<n>")
    // Anything left inside braces or brackets past a short span is data.
    .replace(/[{[][^\]}]{40,}[\]}]/g, "<data>");
  return s.replace(/\s+/g, " ").trim().slice(0, 200);
}

const CWD = (() => { try { return process.cwd().replace(/\\/g, "/").replace(/\/+$/, "") + "/"; } catch { return ""; } })();
function frameFile(raw) {
  let f = String(raw || "").replace(/^file:\/\//, "").replace(/\\/g, "/");
  const nm = f.lastIndexOf("node_modules/");
  if (nm >= 0) return f.slice(nm).slice(0, 160);
  if (f.startsWith("node:")) return f.slice(0, 80);
  if (CWD && f.startsWith(CWD)) return f.slice(CWD.length).slice(0, 160);
  // Outside the app: the base name only (no home or temp directory names).
  return f.split("/").pop().slice(0, 80);
}
/** Stack frames of an error (never its first line, which carries the message). */
export function framesOf(stack) {
  const frames = [];
  const lines = String(stack || "").split("\n");
  for (const line of lines) {
    if (frames.length >= MAX_FRAMES) break;
    const m = /^\s*at (?:(.{1,300}?) \()?((?:file:\/\/|node:|\/|[A-Za-z]:)[^()\s]{0,500}?):(\d{1,7}):(\d{1,7})\)?\s*$/.exec(line.slice(0, 900));
    if (!m) continue;
    const filename = frameFile(m[2]);
    const fn = m[1] ? m[1].replace(/[^A-Za-z0-9_$.<>\[\] -]/g, "").replace(/^async /, "").slice(0, 120) : "<anonymous>";
    frames.push({
      filename, function: fn || "<anonymous>", lineno: Number(m[3]), colno: Number(m[4]),
      in_app: !filename.startsWith("node_modules/") && !filename.startsWith("node:"), platform: "node:javascript",
    });
  }
  // PostHog reads frames oldest call first.
  return frames.reverse();
}

// --- events ---------------------------------------------------------------------
/** The $ai_generation event for one model call: counts and labels only. */
export function aiGenerationEventOf({ tier, routeTier, model, promptTokens, completionTokens, latencyMs, httpStatus = 200, isError = false, servedBy, source, serviceTier, defaulted } = {}) {
  const status = Number(httpStatus) || 200;
  const props = {
    $ai_trace_id: randomUUID(),
    $ai_span_name: label(tier || "unknown", 60),
    $ai_model: label(model, 120),
    $ai_provider: servedBy === "direct" ? "direct" : servedBy ? "openrouter" : label(source || "gateway", 30),
    $ai_input_tokens: Math.max(0, Math.floor(Number(promptTokens) || 0)),
    $ai_output_tokens: Math.max(0, Math.floor(Number(completionTokens) || 0)),
    $ai_latency: latencyMs != null && Number.isFinite(Number(latencyMs)) ? Math.max(0, Number(latencyMs)) / 1000 : undefined,
    $ai_http_status: status,
    $ai_is_error: !!isError || status >= 400,
    tier: label(tier || "unknown", 60),
    routeTier: label(routeTier || tier || "unknown", 60),
    source: label(source || "gateway", 30),
    serviceTier: serviceTier ? label(serviceTier, 20) : undefined,
    defaulted: defaulted == null ? undefined : !!defaulted,
  };
  return pickAllowed(props, AI_GENERATION_FIELDS);
}

/** The $exception event for an error: type, scrubbed message, frames. */
export function exceptionEventOf(err, { source = "server", slug, status, handled = true, level = "error" } = {}) {
  const isErr = err instanceof Error || (err && typeof err === "object" && typeof err.stack === "string");
  let type = "NonError", value = "(a value that is not an Error)", frames = [];
  if (isErr) {
    try { type = label(err.name || err.constructor?.name || "Error", 60) || "Error"; } catch { type = "Error"; }
    try { value = scrubErrorMessage(err.message); } catch { value = ""; }
    try { frames = framesOf(err.stack); } catch { frames = []; }
  }
  const entry = pickAllowed({
    type,
    value,
    mechanism: { type: label(source, 40) || "server", handled: !!handled, synthetic: !isErr },
    stacktrace: { type: "raw", frames: frames.map((f) => pickAllowed(f, FRAME_FIELDS)) },
  }, EXCEPTION_ENTRY_FIELDS);
  const top = frames.slice(-5).map((f) => `${f.filename}:${f.function}`).join("|");
  const props = {
    $exception_list: [entry],
    $exception_fingerprint: createHash("sha256").update(`${type}|${top}`).digest("hex").slice(0, 16),
    $exception_level: level === "fatal" ? "fatal" : "error",
    source: label(source, 40) || "server",
    slug: slug ? label(slug, 80) : undefined,
    status: status != null && Number.isFinite(Number(status)) ? Number(status) : undefined,
  };
  return pickAllowed(props, EXCEPTION_FIELDS);
}

/** Capture one model call (fire-and-forget, never throws). */
export function captureAiGeneration(args) {
  try {
    if (!cfg.aiOn || !sinkActive() || !sampled(cfg.aiSample) || !underHourly("ai", cfg.aiHourly)) return false;
    return enqueue("$ai_generation", aiGenerationEventOf(args));
  } catch { return false; }
}

const seenFingerprints = new Map(); // fingerprint -> last sent ms
const FINGERPRINT_TTL_MS = 600_000;
const FINGERPRINT_MAX = 500;
/** Capture one server exception (fire-and-forget, never throws). A fatal one
 *  is flushed at once, since the process is about to end. */
export function captureServerException(err, opts = {}) {
  try {
    if (!cfg.excOn || !sinkActive() || !sampled(cfg.excSample)) return false;
    const props = exceptionEventOf(err, opts);
    const now = Date.now();
    const fp = props.$exception_fingerprint;
    const last = seenFingerprints.get(fp);
    if (last != null && now - last < FINGERPRINT_TTL_MS) return false;
    if (!underHourly("exc", cfg.excHourly, now)) return false;
    seenFingerprints.delete(fp);
    seenFingerprints.set(fp, now);
    if (seenFingerprints.size > FINGERPRINT_MAX) seenFingerprints.delete(seenFingerprints.keys().next().value);
    const queued = enqueue("$exception", props);
    if (opts.level === "fatal") flushObservability();
    return queued;
  } catch { return false; }
}

// Web Bot Auth: one rollup event per (agent, verified, reason) per flush window.
const wbaCounts = new Map();
const WBA_MAX_KEYS = 200;
let wbaTimer = null;
const WBA_FLUSH_MS = 300_000;
export function noteWebBotAuth({ agent, verified, reason }) {
  try {
    if (!sinkActive()) return false;
    const a = verified ? label(agent, 120) : "(unverified)";
    const r = label(reason || (verified ? "ok" : "unknown"), 40);
    const key = `${a}|${verified ? 1 : 0}|${r}`;
    if (!wbaCounts.has(key) && wbaCounts.size >= WBA_MAX_KEYS) return false;
    wbaCounts.set(key, (wbaCounts.get(key) || 0) + 1);
    if (!wbaTimer) { wbaTimer = setTimeout(() => { wbaTimer = null; flushWebBotAuthRollup(); }, WBA_FLUSH_MS); wbaTimer.unref?.(); }
    return true;
  } catch { return false; }
}
export function flushWebBotAuthRollup() {
  if (wbaTimer) { clearTimeout(wbaTimer); wbaTimer = null; }
  for (const [key, count] of wbaCounts) {
    const [agent, v, reason] = key.split("|");
    enqueue("web_bot_auth", pickAllowed({ agent, verified: v === "1", reason, count }, WEB_BOT_AUTH_FIELDS));
  }
  wbaCounts.clear();
}

/** Tests only. */
export function _resetObservabilityForTest({ env, random } = {}) {
  cfg = config(env || process.env);
  rand = typeof random === "function" ? random : Math.random;
  queue.length = 0; dropped = 0;
  if (timer) { clearTimeout(timer); timer = null; }
  windows.ai = { start: 0, n: 0 }; windows.exc = { start: 0, n: 0 };
  seenFingerprints.clear(); wbaCounts.clear();
  if (wbaTimer) { clearTimeout(wbaTimer); wbaTimer = null; }
}
export function _setSinkForTest(capture, active = () => true) { sink = capture ? { capture, active } : null; }
export function _queueForTest() { return queue; }
