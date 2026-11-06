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
//   DIRECT_UPSTREAM_SINCE    YYYY-MM-DD the privacy disclosure took effect; while the
//                            upstream is configured, /privacy prints the later of its own
//                            date and this one (once reached).
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
// A direct attempt is also taken only when src/gateway-direct-pricebook.js
// reads the call as cheaper there than on OpenRouter (fails closed).

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
 *  OpenRouter body after the margin clamp), or { reason } when the attempt uses
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
/** The privacy page's sentence while the upstream is configured, else "". */
export function directUpstreamPrivacyText(env = process.env) {
  if (!directUpstreamConfigured(env)) return "";
  return " Some calls to open-weight models are served by a direct inference provider instead of OpenRouter. Zero data retention is requested on every such call, so it is served only by workers that keep no prompts or outputs, and the provider's gateway stores no prompts or outputs, only usage metadata such as token counts and cost.";
}
