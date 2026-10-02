// Tool choice by a judgment model (TypeSafe System One) for route-execute, the
// outside-seller leg and /api/route. It chooses only among candidates it is
// given and may answer "none of these". No model writes the answer: the chosen
// tool runs unchanged. Fails open to the lexical order; ROUTE_JUDGE=off disables.
import { createHash } from "node:crypto";

const ENDPOINT = (process.env.TYPESAFE_API_URL || "https://api.typesafe.ai/v1/systemone").trim();
const MODEL = (process.env.TYPESAFE_MODEL || "jev-latest").trim();
const keyOf = () => (process.env.TYPESAFE_API_KEY || "").trim();

export const NONE = "none_of_these";
// Starting points, not a calibration (the discovery rerank uses the same bands).
export const PICK_CONFIDENCE = () => Number(process.env.ROUTE_JUDGE_CONFIDENCE || 0.85);
export const REFUSE_CONFIDENCE = () => Number(process.env.ROUTE_JUDGE_REFUSE_CONFIDENCE || 0.9);
const TIMEOUT_MS = () => Number(process.env.ROUTE_JUDGE_TIMEOUT_MS || 4000);
// Description window the judge reads, plus the curated tags.
const DESC_MAX = 300;

export const toolJudgeEnabled = () => !!keyOf() && String(process.env.ROUTE_JUDGE || "").toLowerCase() !== "off";

// ---------------------------------------------------------------------------
// Guards: every judgment is cached per question for a day and booked against a
// daily token ceiling (JEV_DAILY_MAX_TOKENS; 0 or "off" disables) before it is
// made. Past the ceiling, decisions fall back to the lexical order. Booked from
// request size (one token per byte) plus an output allowance.
const OUTPUT_ALLOWANCE_TOKENS = 300;
const jevDailyMaxTokens = () => {
  const raw = String(process.env.JEV_DAILY_MAX_TOKENS ?? "").trim().toLowerCase();
  if (raw === "off") return 0;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : 24_000_000;
};
// The free /api/route answer may use at most this share of the daily ceiling
// (ROUTE_JUDGE_FREE_SHARE, 0..1, default 0.5); the rest is held for the paid
// route-execute path, so unpaid search traffic cannot spend the whole day's
// budget and leave paying buyers on the lexical fallback.
const freeShare = () => {
  const n = Number(process.env.ROUTE_JUDGE_FREE_SHARE ?? 0.5);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.5;
};
const spend = { day: "", tokens: 0, freeTokens: 0, calls: 0, refused: 0, cacheHits: 0 };
const today = () => new Date().toISOString().slice(0, 10);
function rollDay() { const d = today(); if (spend.day !== d) { spend.day = d; spend.tokens = 0; spend.freeTokens = 0; spend.calls = 0; spend.refused = 0; spend.cacheHits = 0; } }
/** Counts only. */
export function jevSpendStatus() {
  rollDay();
  const cap = jevDailyMaxTokens();
  return { day: spend.day, tokens: spend.tokens, capTokens: cap, freeTokens: spend.freeTokens, freeCapTokens: Math.floor(cap * freeShare()), calls: spend.calls, cacheHits: spend.cacheHits, refusedToday: spend.refused, status: cap > 0 && spend.tokens >= cap ? "capped" : "ok" };
}
export function _jevReset() { spend.day = ""; rollDay(); cache.clear(); }

const cache = new Map(); // key -> { at, value }
const CACHE_TTL_MS = 24 * 3_600_000;
const CACHE_MAX = 5_000;
const cacheKey = (kind, parts) => `${kind}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
function cached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) { rollDay(); spend.cacheHits++; return { hit: true, value: hit.value }; }
  return { hit: false };
}
function remember(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
}

/** One Jev call under the ceiling, or null. Never throws. `pool: "free"`
 *  books the call against the free share of the ceiling as well. `outcome`
 *  (optional object) learns `skipped: "budget"` when a ceiling refused it. */
async function callJev(payload, fetchImpl, timeoutMs, { pool = "paid", outcome = null } = {}) {
  if (!keyOf()) return null;
  const cap = jevDailyMaxTokens();
  if (!(cap > 0)) return null;
  const body = JSON.stringify(payload);
  const est = Buffer.byteLength(body) + OUTPUT_ALLOWANCE_TOKENS;
  rollDay();
  const free = pool === "free";
  if (spend.tokens + est > cap || (free && spend.freeTokens + est > cap * freeShare())) {
    spend.refused++;
    if (outcome) outcome.skipped = "budget";
    return null;
  }
  spend.tokens += est; spend.calls++;
  if (free) spend.freeTokens += est;
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${keyOf()}`, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs || TIMEOUT_MS()),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function criteriaFor(candidates) {
  const criteria = {};
  for (const c of candidates) {
    if (!c?.slug) continue;
    const desc = String(c.description || "").replace(/\s+/g, " ").slice(0, DESC_MAX);
    const tags = Array.isArray(c.tags) ? c.tags.filter((t) => typeof t === "string").slice(0, 12).join(", ") : "";
    const base = desc ? `${c.name || c.slug}: ${desc}` : String(c.name || c.slug);
    criteria[c.slug] = tags ? `${base} [${tags}]` : base;
  }
  // Offered on purpose: without it the model cannot say the catalog lacks the job.
  criteria[NONE] = "None of the listed tools does this job.";
  return criteria;
}

/** { choice, confidence } or null. Never throws. Cached per question.
 *  `admit()` (optional) is consulted only when a model call would be made (a
 *  cache miss): false skips the call and sets `outcome.skipped = "rate"`. */
export async function judgeTool(task, candidates, { fetchImpl = fetch, timeoutMs, pool = "paid", admit = null, outcome = null } = {}) {
  if (!toolJudgeEnabled() || !Array.isArray(candidates) || !candidates.length) return null;
  // Keyed on the criteria text, not on slugs (orderByJudgment's are positional).
  const key = cacheKey("tool", [String(task).slice(0, 400).trim().toLowerCase(), criteriaFor(candidates)]);
  const c = cached(key);
  if (c.hit) return c.value;
  if (typeof admit === "function" && !admit()) { if (outcome) outcome.skipped = "rate"; return null; }
  const out = await callJev({
    state: `An AI agent asked a tool router to run this task: "${String(task).slice(0, 400)}"`,
    model: MODEL,
    questions: { best: { type: "choice", instructions: "Which listed tool actually performs the job the agent asked for?", criteria: criteriaFor(candidates) } },
  }, fetchImpl, timeoutMs, { pool, outcome });
  const a = out?.answers?.best;
  const choice = typeof a?.choice === "string" ? a.choice : null;
  const confidence = typeof a?.confidence === "number" ? a.confidence : null;
  let value = null;
  if (choice && confidence != null && (choice === NONE || candidates.some((x) => x.slug === choice))) {
    const probabilities = {};
    if (a.probabilities && typeof a.probabilities === "object") {
      for (const [k, v] of Object.entries(a.probabilities)) if (typeof v === "number" && (k === NONE || candidates.some((x) => x.slug === k))) probabilities[k] = v;
    }
    value = { choice, confidence, probabilities };
  }
  if (out) remember(key, value); // a failed call is not cached: the next one may succeed
  return value;
}

/**
 * The decision, pure: what route-execute should run given find's eligible
 * candidates (in find order) and the judgment (or null).
 *   { action: "run", def, selection }   or   { action: "refuse", selection }
 */
// Tie: options each >= TIE_MIN that together clear the pick band are equally
// fit; the lowest price wins, equal prices keep the lexical order.
const TIE_MIN = () => Number(process.env.ROUTE_JUDGE_TIE_MIN || 0.15);
const usdOf = (c) => {
  const v = c?.priceUsd ?? c?.price;
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : Infinity;
};

export function decide(eligible, judgment) {
  const lexical = { method: "lexical" };
  if (!eligible.length) return { action: "run", def: null, selection: lexical };
  if (!judgment) return { action: "run", def: eligible[0], selection: lexical };
  const { choice, confidence } = judgment;
  const conf = Number(confidence.toFixed(3));
  if (choice === NONE && confidence >= REFUSE_CONFIDENCE()) return { action: "refuse", selection: { method: "judged", choice: NONE, confidence: conf } };
  if (choice !== NONE && confidence >= PICK_CONFIDENCE()) {
    const def = eligible.find((c) => c.slug === choice);
    if (def) return { action: "run", def, selection: { method: "judged", confidence: conf, ...(def !== eligible[0] ? { overrode: eligible[0].slug } : {}) } };
  }
  const probs = judgment.probabilities || {};
  const fitSet = eligible.filter((c) => (probs[c.slug] || 0) >= TIE_MIN());
  const mass = fitSet.reduce((sum, c) => sum + probs[c.slug], 0);
  if (fitSet.length >= 2 && mass >= PICK_CONFIDENCE()) {
    let best = fitSet[0];
    for (const c of fitSet) if (usdOf(c) < usdOf(best)) best = c; // strict: equal prices keep lexical order
    return { action: "run", def: best, selection: { method: "judged-tie", confidence: Number(mass.toFixed(3)), tiedWith: fitSet.length, tieBrokenBy: "price", ...(best !== eligible[0] ? { overrode: eligible[0].slug } : {}) } };
  }
  return { action: "run", def: eligible[0], selection: { method: "lexical", judged: { choice, confidence: conf } } };
}

// ---------------------------------------------------------------------------
// Is a 200 the route working, or an error page served with 200? A structural
// check settles most bodies; an ambiguous JSON body is judged. Unsure is not free.
const ERROR_WORDS = /\b(missing|required|unauthori[sz]ed|forbidden|invalid|not allowed|denied|must (?:include|provide|supply)|api[_ -]?key|x-[a-z-]+ header|error)\b/i;

export function freeBodyByStructure(body, contentType = "") {
  const text = String(body || "").trim();
  if (!text) return "free";                                   // an empty 200 is a working no-content route
  if (/text\/html/i.test(contentType) || /^<!doctype html|^<html/i.test(text)) return "free"; // a page someone can read
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!json || typeof json !== "object") return ERROR_WORDS.test(text.slice(0, 300)) ? "unsure" : "free";
  const top = Array.isArray(json) ? null : json;
  if (top && (top.error || top.errors || top.ok === false || top.success === false)) return "error";
  if (top && typeof top.state === "string" && ERROR_WORDS.test(top.state + " " + String(top.message || ""))) return "error";
  const keys = top ? Object.keys(top) : [];
  // A small object that is only a message about the request is ambiguous.
  if (top && keys.length <= 4 && ERROR_WORDS.test(JSON.stringify(top).slice(0, 400))) return "unsure";
  return "free";
}

/** "free" | "error" | null (unsure or judge unavailable). Never throws. */
export async function judgeFreeResponse(body, contentType, { fetchImpl = fetch } = {}) {
  const structural = freeBodyByStructure(body, contentType);
  if (structural !== "unsure") return structural;
  const text = String(body).slice(0, 600);
  const key = cacheKey("free", [text]);
  const c = cached(key);
  if (c.hit) return c.value;
  const out = await callJev({
    state: `An unauthenticated GET request to a web API route returned HTTP 200 with this body (truncated): ${text}`,
    model: MODEL,
    questions: { kind: { type: "choice", instructions: "Is this body the route successfully serving its content, or a refusal / error about the request (missing input, missing credentials, not allowed)?", criteria: { serving: "The route worked and returned its content.", error: "The body reports an error or refusal about the request." } } },
  }, fetchImpl);
  const a = out?.answers?.kind;
  let value = null;
  if (typeof a?.confidence === "number" && a.confidence >= PICK_CONFIDENCE()) value = a.choice === "serving" ? "free" : a.choice === "error" ? "error" : null;
  if (out) remember(key, value);
  return value;
}

// ---------------------------------------------------------------------------
// Outside sellers: orders candidates that already passed the settlement gate,
// or stops the router on a confident "none of these". Never adds a seller.
export async function orderByJudgment(task, items, textOf, { fetchImpl = fetch, timeoutMs, pool = "paid", admit = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length < 1 || !toolJudgeEnabled()) return { items: list, refused: false, selection: null };
  const proxies = list.map((it, i) => ({ slug: `c${i}`, ...textOf(it), priceUsd: usdOf(it) }));
  const outcome = {};
  const decision = decide(proxies, await judgeTool(task, proxies, { fetchImpl, timeoutMs, pool, admit, outcome }));
  if (outcome.skipped) return { items: list, refused: false, selection: decision.selection, skipped: outcome.skipped };
  if (decision.action === "refuse") return { items: [], refused: true, selection: decision.selection };
  if (decision.selection.method !== "judged" && decision.selection.method !== "judged-tie") return { items: list, refused: false, selection: decision.selection };
  const idx = Number(decision.def.slug.slice(1));
  const chosen = list[idx];
  return { items: [chosen, ...list.filter((_, i) => i !== idx)], refused: false, selection: { ...decision.selection, overrode: undefined } };
}
