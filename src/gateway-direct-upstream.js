// Direct inference upstream for the chat gateway (src/tools/llm-gateway-kit.js):
// an optional OpenAI-compatible endpoint tried FIRST for a short list of model
// ids, with OpenRouter as the fallback. Off unless every switch below is set;
// unset, the gateway's outbound traffic is unchanged.
//
//   DIRECT_UPSTREAM_URL      base URL ending in /v1 (https only; plain http only to a
//                            loopback host, for local stubs). /chat/completions is appended.
//   DIRECT_UPSTREAM_KEY      bearer key (never logged, never in a body).
//   DIRECT_UPSTREAM_MODELS   comma map "<openrouter id>=<upstream id>,..."; ONLY these
//                            exact ids are ever sent there.
//   DIRECT_UPSTREAM_SHARE    0-100, percent of eligible attempts sent there (the A/B);
//                            default 100 when the rest is set; invalid reads 0.
//   DIRECT_UPSTREAM_TIMEOUT_MS  per attempt (default 45000), capped by the payment window.
//                            A direct timeout does not count in LLM_MAX_TIMED_OUT_ATTEMPTS.
//   DIRECT_UPSTREAM_MAX_BYTES   bound on a non-stream answer body (default 4 MB, at least
//                            64 KB); a larger body is a failed (malformed) attempt.
//   DIRECT_UPSTREAM_BREAKER_FAILS    consecutive counted direct failures that open the
//                            breaker (default 3; a refusal of the request itself does not
//                            count, see the breaker section): while open no call goes direct.
//   DIRECT_UPSTREAM_BREAKER_OPEN_MS  how long it stays open (default 5 minutes); then the next
//                            eligible call is one trial: a success closes it, a counted
//                            failure opens it again.
//   DIRECT_UPSTREAM_SINCE    YYYY-MM-DD the privacy disclosure took effect; while the
//                            upstream is configured, /privacy prints the later of its own
//                            date and this one (once reached). Configured without a valid
//                            one, the date does not move (a boot warning says so).
//   DIRECT_UPSTREAM_NAME     the provider's display name on /privacy (printed escaped).
//   DIRECT_UPSTREAM_POLICY_URL  its privacy policy, linked only as a parsed https URL.
//
// Every outbound body carries provider: { zdr: true } (zero data retention: the
// upstream serves only from zero-retention workers or answers 503) and an
// explicit max_tokens (the gateway's clamped value). A request using a feature
// outside DIRECT_ALLOWED_PARAMS / text-only messages is not sent here at all.
// Any failure (connect, timeout, non-2xx, an error object in a 200 body, a
// malformed body, a missing cost) becomes a walkable 502/503/504 and the chain
// goes on to OpenRouter; the upstream bills only answered requests, and the
// buyer is metered once, from the answer that served.
//
// A direct attempt is also taken only when the per-call eligibility check in
// src/gateway-direct-pricebook.js passes (listed prices of both routes, a
// measured backstop, a private threshold; fails closed).

import { createUnansweredTracker } from "./unanswered-rule.js";
import { currentCallerKey } from "./request-timing.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const MODEL_ID = /^[a-z0-9][a-z0-9._:\/-]{0,127}$/i;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
export const DIRECT_DEFAULT_TIMEOUT_MS = 45_000;

/** Top-level request fields forwarded as is. Anything else on the attempt that
 *  is not an OpenRouter-only call-time field (DROPPED) keeps the request on
 *  OpenRouter: tools, tool_choice, response_format, logprobs, reasoning,
 *  service_tier, plugins and every unknown field. */
export const DIRECT_ALLOWED_PARAMS = Object.freeze(["temperature", "top_p", "stop", "seed", "presence_penalty", "frequency_penalty"]);
/** OpenRouter-only fields the gateway adds at call time; never forwarded. */
const DROPPED = new Set(["provider", "user", "session_id", "cache_control", "usage", "zdr", "transforms"]);
const MESSAGE_ROLES = new Set(["system", "user", "assistant"]);

function validUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.username || u.password || u.search || u.hash) return "";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) return "";
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch { return ""; }
}

function parseModels(raw) {
  const map = new Map();
  for (const pair of String(raw || "").split(",")) {
    const [left, right, extra] = pair.split("=").map((s) => (s || "").trim());
    if (!left && !right) continue;
    if (extra !== undefined || !MODEL_ID.test(left) || !MODEL_ID.test(right) || !left.includes("/")) return null;
    map.set(left.toLowerCase(), right);
  }
  return map;
}

function parseShare(raw) {
  if (raw === undefined || String(raw).trim() === "") return 100;
  const s = String(raw).trim();
  if (!/^\d{1,3}$/.test(s)) return 0;
  const n = Number(s);
  return n >= 0 && n <= 100 ? n : 0;
}

let memo = { sig: null, cfg: null };
/** The parsed configuration, or null when the upstream is off (any of URL,
 *  key or model map unset or invalid). Read at call time. */
export function directUpstreamConfig(env = process.env) {
  const sig = [env.DIRECT_UPSTREAM_URL, env.DIRECT_UPSTREAM_KEY, env.DIRECT_UPSTREAM_MODELS, env.DIRECT_UPSTREAM_SHARE, env.DIRECT_UPSTREAM_TIMEOUT_MS].join("\u0000");
  if (memo.sig === sig) return memo.cfg;
  const base = validUrl(env.DIRECT_UPSTREAM_URL);
  const key = String(env.DIRECT_UPSTREAM_KEY || "").trim();
  const models = parseModels(env.DIRECT_UPSTREAM_MODELS);
  const timeout = parseInt(env.DIRECT_UPSTREAM_TIMEOUT_MS || "", 10);
  const cfg = base && key && models && models.size
    ? { url: `${base}/chat/completions`, modelsUrl: `${base}/models`, key, models, share: parseShare(env.DIRECT_UPSTREAM_SHARE), timeoutMs: timeout > 0 ? timeout : DIRECT_DEFAULT_TIMEOUT_MS }
    : null;
  memo = { sig, cfg };
  return cfg;
}

export function directUpstreamConfigured(env = process.env) { return !!directUpstreamConfig(env); }

/** Boot warnings (names only, never values). */
export function directUpstreamBootWarnings(env = process.env) {
  const keys = ["DIRECT_UPSTREAM_URL", "DIRECT_UPSTREAM_KEY", "DIRECT_UPSTREAM_MODELS"];
  const set = (k) => String(env[k] || "").trim() !== "";
  if (!keys.some(set) && !set("DIRECT_UPSTREAM_SHARE")) return [];
  const out = [];
  if (set("DIRECT_UPSTREAM_URL") && !validUrl(env.DIRECT_UPSTREAM_URL)) out.push("WARNING: DIRECT_UPSTREAM_URL is not an https URL without credentials, query or fragment; the direct upstream is off");
  if (set("DIRECT_UPSTREAM_MODELS") && !parseModels(env.DIRECT_UPSTREAM_MODELS)) out.push("WARNING: DIRECT_UPSTREAM_MODELS is not a comma list of <openrouter id>=<upstream id>; the direct upstream is off");
  const missing = keys.filter((k) => !set(k));
  if (missing.length) out.push(`WARNING: the direct upstream is off: ${missing.join(", ")} unset`);
  if (set("DIRECT_UPSTREAM_SHARE") && parseShare(env.DIRECT_UPSTREAM_SHARE) === 0 && String(env.DIRECT_UPSTREAM_SHARE).trim() !== "0") out.push("WARNING: DIRECT_UPSTREAM_SHARE is not an integer 0-100; read as 0 (nothing is sent)");
  if (directUpstreamConfigured(env)) {
    if (!directUpstreamSince(env)) out.push("WARNING: the direct upstream is configured without a valid DIRECT_UPSTREAM_SINCE (YYYY-MM-DD); /privacy keeps its own date");
    else if (directUpstreamSince(env) > new Date().toISOString().slice(0, 10)) out.push("WARNING: DIRECT_UPSTREAM_SINCE is after today; /privacy keeps its own date until that day");
    if (set("DIRECT_UPSTREAM_POLICY_URL") && !directUpstreamPolicyUrl(env)) out.push("WARNING: DIRECT_UPSTREAM_POLICY_URL is not an https URL; it is not linked");
    if (!directUpstreamName(env)) out.push("WARNING: DIRECT_UPSTREAM_NAME is unset; /privacy names the provider only as a direct inference provider");
  }
  return out;
}

/** The upstream id for an OpenRouter model id, or null (unlisted, or off). */
export function directModelFor(model, cfg = directUpstreamConfig()) {
  if (!cfg || !model) return null;
  return cfg.models.get(String(model).toLowerCase()) || null;
}

let rng = Math.random;
export function _setDirectUpstreamRngForTest(fn) { rng = typeof fn === "function" ? fn : Math.random; }
/** One A/B draw: true when this attempt goes to the direct upstream. */
export function directShareDraw(cfg = directUpstreamConfig()) {
  if (!cfg || cfg.share <= 0) return false;
  if (cfg.share >= 100) return true;
  return rng() * 100 < cfg.share;
}

/** Insert one direct attempt before the first OpenRouter attempt of each
 *  listed model. Unchanged (same array) when the upstream is off. */
export function withDirectAttempts(attempts, cfg = directUpstreamConfig()) {
  if (!cfg) return attempts;
  const out = [];
  const seen = new Set();
  for (const a of attempts) {
    const target = directModelFor(a.model, cfg);
    if (target && !seen.has(a.model)) { seen.add(a.model); out.push({ model: a.model, flex: false, direct: target }); }
    out.push(a);
  }
  return out;
}

function textOnlyContent(c) {
  if (typeof c === "string") return true;
  if (!Array.isArray(c)) return false;
  return c.every((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string" && Object.keys(p).every((k) => k === "type" || k === "text"));
}

/** The body for the direct upstream built from a gateway attempt (the outbound
 *  OpenRouter body after the max_tokens clamp), or { reason } when the attempt uses
 *  a feature this upstream is not trusted with. */
export function directBodyFrom(attempt, target, { stream = false } = {}) {
  for (const [k, v] of Object.entries(attempt || {})) {
    if (v === undefined || k === "model" || k === "messages" || k === "max_tokens" || k === "stream" || DROPPED.has(k)) continue;
    if (k === "n" && (v === 1)) continue;
    if (k === "plugins" && Array.isArray(v) && v.length === 0) continue;
    if (!DIRECT_ALLOWED_PARAMS.includes(k)) return { reason: `param:${k}` };
  }
  const msgs = attempt?.messages;
  if (!Array.isArray(msgs) || !msgs.length) return { reason: "messages" };
  for (const m of msgs) {
    if (!m || typeof m !== "object" || !MESSAGE_ROLES.has(m.role) || Object.keys(m).some((k) => k !== "role" && k !== "content") || !textOnlyContent(m.content)) return { reason: "message_shape" };
  }
  const maxTokens = attempt.max_tokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) return { reason: "max_tokens" };
  const body = { model: target, messages: msgs, max_tokens: maxTokens };
  for (const k of DIRECT_ALLOWED_PARAMS) if (attempt[k] !== undefined) body[k] = attempt[k];
  if (stream) { body.stream = true; body.stream_options = { include_usage: true }; }
  body.provider = { zdr: true };
  return { body };
}

// ---- cost and vendor fields ------------------------------------------------
/** The upstream's own per-call cost in USD from a non-stream answer: an
 *  integer micro-USD `charged_micro` in a top-level `x_*` extension object,
 *  else the `x-*-charged-micro` response header, else usage.cost. null when
 *  none is a valid non-negative number. */
export function directCostUsd(data, headers) {
  for (const [k, v] of Object.entries(data || {})) {
    if (/^x_/.test(k) && v && typeof v === "object" && Number.isInteger(v.charged_micro) && v.charged_micro >= 0) return v.charged_micro / 1e6;
  }
  if (headers && typeof headers.forEach === "function") {
    let micro = null;
    headers.forEach((value, name) => { if (micro === null && /^x-[a-z0-9-]*charged-micro$/i.test(name) && /^\d+$/.test(String(value).trim())) micro = Number(String(value).trim()); });
    if (micro !== null) return micro / 1e6;
  }
  const c = data?.usage?.cost;
  return typeof c === "number" && Number.isFinite(c) && c >= 0 ? c : null;
}

/** Delete top-level vendor extension fields (`x_*`) in place; returns the
 *  micro-USD charge one of them carried, or null. */
export function stripVendorExtensions(obj) {
  if (!obj || typeof obj !== "object") return null;
  let micro = null;
  for (const k of Object.keys(obj)) {
    if (!/^x_/.test(k)) continue;
    const v = obj[k];
    if (micro === null && v && typeof v === "object" && Number.isInteger(v.charged_micro) && v.charged_micro >= 0) micro = v.charged_micro;
    delete obj[k];
  }
  return micro;
}

// ---- breaker (per process) ---------------------------------------------------
// A failing direct upstream would otherwise be tried first on every call of a
// mapped model. Only the upstream's own answer counts (DIRECT_BREAKER_COUNTED):
// auth (401/403), quota (402), capacity (429), 5xx, a missing endpoint, a
// malformed or oversized body, a late error in a 200, a missing cost, and a
// connection its host refused or reset (or a host name that does not
// resolve), and our own timeout on a light call (a prompt under
// HEAVY_INPUT_SHARE of the tier's input cap and an output cap under
// DIRECT_HEAVY_OUTPUT_TOKENS: nothing about the call explains it) that ran the
// full configured direct timeout. Our own timeout on a heavy call (it reads
// the unanswered rule instead), one cut short by the caller's own payment or
// connection window (it says nothing about the upstream), a lookup our
// resolver could not finish or a route our
// side lacks, a stream cut with no status, a refusal of the request
// itself (any other 4xx: a parameter out of range, a prompt over the context,
// which OpenRouter would refuse too), a client that went away and an empty
// answer prove nothing about the upstream and do not count. An answered
// attempt resets the count.
//
// States: closed; open (no call goes direct) while now < openUntil; half-open
// once that passes, when the next call that would go direct (it passed the
// price guard and the share draw) takes the one trial. A counted failure on
// the trial opens it again; a success closes it; an uncounted outcome hands
// the trial to the next call. Only open reads degraded.
const breakerEnv = (name, dflt, min) => {
  const n = parseInt(String(process.env[name] ?? "").trim(), 10);
  return Number.isFinite(n) && n >= min ? n : dflt;
};
const breakerFails = () => breakerEnv("DIRECT_UPSTREAM_BREAKER_FAILS", 3, 1);
const breakerOpenMs = () => breakerEnv("DIRECT_UPSTREAM_BREAKER_OPEN_MS", 5 * 60_000, 1000);
/** Failure buckets that are the upstream's own answer: only these count. */
export const DIRECT_BREAKER_COUNTED = Object.freeze(["auth", "quota", "rate_limited", "unavailable", "server_error", "not_found", "malformed", "late_error", "no_cost", "connect"]);
/** Failure buckets that say nothing proven about the upstream's health
 *  ("timeout" counts only on a light call that ran the full direct timeout;
 *  see noteDirectOutcome). */
export const DIRECT_BREAKER_NOT_COUNTED = Object.freeze(["client_gone", "aborted", "refused", "empty", "timeout", "egress", "stream", "other", "unconfigured"]);
const COUNTED = new Set(DIRECT_BREAKER_COUNTED);
const blankBreaker = () => ({ fails: 0, openUntil: 0, opens: 0, trialAt: 0, trialId: 0 });
let breaker = blankBreaker();
let breakerNow = Date.now;
export function _resetDirectBreakerForTest() { breaker = blankBreaker(); breakerNow = Date.now; directUnanswered.clear(); }
export function _setDirectBreakerNowForTest(fn) { breakerNow = typeof fn === "function" ? fn : Date.now; }
/** True when a direct attempt may be made now. Once the open period ends one
 *  caller takes the trial; a trial that never reports holds it for at most
 *  one open period. */
export function directBreakerAllows() { return directBreakerTake() !== null; }
/** The same decision as a grant: null when no direct attempt may be made,
 *  else { trial } (trial true when this caller took the half-open trial).
 *  A caller that exits before its direct attempt is sent hands the grant to
 *  directBreakerRelease, so an unsent trial never holds the breaker shut. */
let trialSeq = 0;
export function directBreakerTake() {
  if (!breaker.openUntil) return { trial: false, id: 0 };
  const now = breakerNow();
  if (now < breaker.openUntil) return null;
  if (breaker.trialAt && now - breaker.trialAt < breakerOpenMs()) return null;
  breaker.trialAt = now;
  breaker.trialId = ++trialSeq;
  return { trial: true, id: breaker.trialId };
}
/** Releases a trial that was granted and never sent; a no-op for a closed
 *  grant, a trial that already reported, or a later caller's trial. */
export function directBreakerRelease(grant) {
  if (!grant?.trial || breaker.trialId !== grant.id || !breaker.trialAt) return;
  breaker.trialAt = 0;
}
// Our own timeout on the direct link. On a light call that ran the full
// configured direct timeout it counts like the upstream's own failure (so one
// caller is moved to OpenRouter by the third). One whose attempt timeout the
// caller's own window cut short (clamped) never counts as that failure: a
// buyer who signs a short authorization would otherwise open the link for
// everyone. On a clamped call, and on a heavy call (a long prompt, or a large
// output cap, which may need more than the cap), only the
// pattern of src/unanswered-rule.js (many calls, several callers, one window,
// no answer between) opens the breaker so the next callers go to OpenRouter.
// Both are logged as "did not answer within our limit".
const directUnanswered = createUnansweredTracker();
/** A requested output cap (max_tokens, or its alias max_completion_tokens)
 *  at or past this many tokens is a long expected generation: a timeout on it
 *  is not the upstream's fault, as with a long prompt. */
export const DIRECT_HEAVY_OUTPUT_TOKENS = 2048;
export function directHeavyOutput(body) {
  const n = Number(body?.max_tokens ?? body?.max_completion_tokens);
  return Number.isFinite(n) && n >= DIRECT_HEAVY_OUTPUT_TOKENS;
}
/** The outcome of one direct attempt: ok, or the failure's bucket. `caller`
 *  is the request's caller key (src/request-timing.js; read only when the
 *  unanswered rule needs it); `heavy`
 *  says the prompt is at or past HEAVY_INPUT_SHARE of its cap or the output
 *  cap is at or past DIRECT_HEAVY_OUTPUT_TOKENS (a timeout on it then reads
 *  the unanswered rule instead of counting); `clamped` says the attempt's
 *  timeout was shorter than the configured direct timeout (the caller's own
 *  window cut it), and a timeout on it reads the unanswered rule too, never
 *  the single-caller count. */
export function noteDirectOutcome(ok, reason, caller = undefined, { heavy = false, clamped = false } = {}) {
  if (ok) { directUnanswered.clear(); breaker.fails = 0; breaker.openUntil = 0; breaker.trialAt = 0; return; }
  const timeout = String(reason) === "timeout";
  if (timeout && !heavy && !clamped) {
    breaker.fails++;
    if (breaker.fails >= breakerFails()) {
      const now = breakerNow();
      if (!breaker.openUntil || now >= breaker.openUntil) {
        breaker.opens++;
        console.warn("[direct-upstream] the direct link did not answer within our limit on a short prompt, the last of the counted failures in a row; the next calls go to OpenRouter for the open period");
      }
      breaker.openUntil = now + breakerOpenMs();
      breaker.trialAt = 0;
    }
    return;
  }
  // The caller key is read (hashed) only here, for a heavy or clamped
  // timeout: one caller alone never reaches the rule's caller count.
  if (timeout && directUnanswered.note(caller === undefined ? currentCallerKey() : caller)) {
    const st = directUnanswered.state();
    directUnanswered.clear();
    console.warn(`[direct-upstream] the direct link did not answer within our limit on ${st.deadlines} calls from ${st.callers} callers; the next calls go to OpenRouter for the open period`);
    const now = breakerNow();
    if (!breaker.openUntil || now >= breaker.openUntil) breaker.opens++;
    breaker.openUntil = now + breakerOpenMs();
    breaker.trialAt = 0;
    return;
  }
  if (!COUNTED.has(String(reason))) { breaker.trialAt = 0; return; }
  breaker.fails++;
  if (breaker.fails >= breakerFails()) {
    const now = breakerNow();
    if (!breaker.openUntil || now >= breaker.openUntil) breaker.opens++;
    breaker.openUntil = now + breakerOpenMs();
    breaker.trialAt = 0;
  }
}
/** { open, halfOpen, trialInFlight, fails, opens, threshold, openMs, reopensInMs }:
 *  counts only. open is true only before openUntil; after it the breaker is
 *  half-open (a trial is pending) and does not read degraded. */
export function directBreakerState() {
  const now = breakerNow();
  const open = !!breaker.openUntil && now < breaker.openUntil;
  const halfOpen = !!breaker.openUntil && !open;
  return { open, halfOpen, trialInFlight: halfOpen && !!breaker.trialAt && now - breaker.trialAt < breakerOpenMs(), fails: breaker.fails, opens: breaker.opens, threshold: breakerFails(), openMs: breakerOpenMs(), reopensInMs: open ? breaker.openUntil - now : null };
}

// ---- A/B telemetry (operator view only) ------------------------------------
const LAT_KEEP = 500;
const blank = () => ({ attempts: 0, ok: 0, failed: {}, latMs: [] });
const fresh = () => ({ direct: blank(), openrouter: blank(), skipped: {}, anomalies: {}, since: Date.now() });
let stats = fresh();
export function _resetDirectUpstreamStatsForTest() { stats = fresh(); }

/** A failure's bucketed reason (never a message). */
export function failureBucket(e) {
  if (e?.directReason) return e.directReason;
  if (e?.upstreamTimeout) return "timeout";
  const s = Number(e?.statusCode);
  if (s === 499) return "client_gone";
  if (s === 504) return "timeout";
  if (s === 503) return "unavailable";
  if (s === 502) return "upstream_error";
  return s >= 400 && s < 500 ? "refused" : "other";
}

/** Record one attempt for an A/B-listed model on either upstream. */
export function noteDirectAb(upstream, { ok, reason, ms } = {}) {
  const u = stats[upstream === "direct" ? "direct" : "openrouter"];
  u.attempts++;
  if (ok) {
    u.ok++;
    if (Number.isFinite(ms)) { u.latMs.push(Math.max(0, Math.round(ms))); if (u.latMs.length > LAT_KEEP) u.latMs.shift(); }
  } else {
    const r = String(reason || "other").slice(0, 40);
    u.failed[r] = (u.failed[r] || 0) + 1;
  }
}
/** A listed model's request kept off the direct upstream, by bucket. */
export function noteDirectSkip(reason) {
  const r = String(reason || "other").slice(0, 40);
  stats.skipped[r] = (stats.skipped[r] || 0) + 1;
}

/** A served direct answer that lacked something (a stream with no cost frame). */
export function noteDirectAnomaly(reason) {
  const r = String(reason || "other").slice(0, 40);
  stats.anomalies[r] = (stats.anomalies[r] || 0) + 1;
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
/** Aggregates for /__operator/direct-upstream.json: counts and p50/p90 latency
 *  per upstream. No URL, key, prompt or per-call detail. */
export function directUpstreamReport() {
  const cfg = directUpstreamConfig();
  const view = (u) => {
    const s = [...u.latMs].sort((a, b) => a - b);
    const failedTotal = Object.values(u.failed).reduce((a, b) => a + b, 0);
    return { attempts: u.attempts, ok: u.ok, failed: { ...u.failed }, failedTotal, rateLimited: u.failed.rate_limited || 0, latencyMs: { samples: s.length, p50: pct(s, 50), p90: pct(s, 90) } };
  };
  return {
    note: "attempts for the listed model ids only, on each upstream, since this process started; latency is the time to a served answer over the most recent successful attempts. In memory: a restart clears it.",
    configured: !!cfg,
    share: cfg ? cfg.share : null,
    models: cfg ? [...cfg.models.keys()] : [],
    since: new Date(stats.since).toISOString(),
    upstreams: { direct: view(stats.direct), openrouter: view(stats.openrouter) },
    skipped: { ...stats.skipped },
    breaker: directBreakerState(),
    anomalies: { ...stats.anomalies },
  };
}

// ---- privacy page date -----------------------------------------------------
export function directUpstreamSince(env = process.env) {
  const raw = String(env.DIRECT_UPSTREAM_SINCE || "").trim();
  const m = raw.match(ISO_DAY);
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === raw ? raw : "";
}
const DATE_LINE = /last updated (\d{4}-\d{2}-\d{2})\./;
/** A rendered page with its "last updated" date moved to DIRECT_UPSTREAM_SINCE
 *  while the upstream is configured, when that is later and not after today. */
export function withDirectUpstreamDate(html, env = process.env, today = new Date().toISOString().slice(0, 10)) {
  if (!directUpstreamConfigured(env)) return String(html);
  const since = directUpstreamSince(env);
  return String(html).replace(DATE_LINE, (m, own) => `last updated ${since && since > own && since <= today ? since : own}.`);
}
const NAME_MAX = 60;
const escHtml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** DIRECT_UPSTREAM_NAME with control and invisible characters removed,
 *  whitespace collapsed, at most NAME_MAX characters; "" when unset. Escape to print. */
export function directUpstreamName(env = process.env) {
  return String(env.DIRECT_UPSTREAM_NAME || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufe00-\ufe0f\ufeff]|[\u{e0000}-\u{e007f}]/gu, "")
    .replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim();
}
/** DIRECT_UPSTREAM_POLICY_URL as a parsed https href with no credentials; "" otherwise. */
export function directUpstreamPolicyUrl(env = process.env) {
  const raw = String(env.DIRECT_UPSTREAM_POLICY_URL || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || !/^[a-z0-9.-]+$/i.test(u.hostname)) return "";
    return u.href;
  } catch { return ""; }
}
/** The privacy page's sentence (AI gateway inputs) while the upstream is configured, else "". */
export function directUpstreamPrivacyText(env = process.env) {
  if (!directUpstreamConfigured(env)) return "";
  return " Some chat calls to listed models are served by a direct inference provider instead of OpenRouter (see Third parties). Zero data retention is requested on every such call.";
}
/** The privacy page's Third parties item (HTML, every env-supplied value
 *  escaped) while the upstream is configured, else "". */
export function directUpstreamThirdPartyText(env = process.env) {
  if (!directUpstreamConfigured(env)) return "";
  const name = directUpstreamName(env), policy = directUpstreamPolicyUrl(env);
  const link = policy ? `<a href="${escHtml(policy)}" rel="noopener">its privacy policy</a>` : "";
  const who = name ? `${escHtml(name)}${link ? ` (${link})` : ""}` : `a direct inference provider${link ? ` (${link})` : ""}`;
  return `Chat calls to the listed models on the <code>/v1</code> chat endpoints may be served by ${who} instead of OpenRouter. It receives the messages and the generation settings of the call, which it processes where it operates, and zero data retention is requested on every such call.`;
}
/** The location sentence's exception while the upstream is configured, else "". */
export function directUpstreamLocationText(env = process.env) {
  if (!directUpstreamConfigured(env)) return "";
  return ", except where a provider listed under Third parties operates elsewhere";
}
