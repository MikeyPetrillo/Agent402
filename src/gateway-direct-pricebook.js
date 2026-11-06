// Cost guard for the direct upstream (src/gateway-direct-upstream.js): a call
// goes there ONLY when it is estimated to cost less there than on OpenRouter's
// cheapest routable endpoint for the same model. Everything here fails closed:
// a doubt of any kind sends the call to OpenRouter.
//
// Three parts:
//   1. A price book, refreshed in the background (never on a request): the
//      direct upstream's public model listing (`<DIRECT_UPSTREAM_URL>/models`,
//      no key) and OpenRouter's endpoint list for each mapped OpenRouter id.
//      Priority-tier endpoints ("*/fast", "*/ultrafast", "*/priority") are not
//      routable for a default call, the same rule the live-catalog guard
//      applies (scripts/test-gateway-model-ids.js imports PRIORITY_ENDPOINT_TAG
//      from here), and at call time an endpoint above the call's own
//      provider.max_price is dropped too.
//   2. A per-call comparison: input tokens (the kit's own estimate) at each
//      upstream's prompt price plus the clamped max_tokens at its completion
//      price. Direct must be below OpenRouter's cheapest routable endpoint by
//      the minimum saving share (below), or the call stays on OpenRouter.
//   3. A measured backstop: the reported cost per 1k tokens (prompt plus
//      completion) of recent answers on each upstream, per model. Once both
//      sides hold the minimum sample and direct does not measure below
//      OpenRouter, the model stays on OpenRouter until it does again.
//
// Fail closed (the call goes to OpenRouter): no book yet, a book older than
// three refresh intervals, a model missing from the direct listing, a prompt
// or completion price that is unparsable, zero or negative, a non-zero
// per-request fee (the comparison does not price it), no routable OpenRouter
// endpoint, an input or output estimate that is not a positive number.
//
// Env (all optional; the guard is active whenever the direct upstream is configured):
//   DIRECT_UPSTREAM_PRICE_REFRESH_MS   refresh interval (default one hour).
//   DIRECT_UPSTREAM_PRICE_TIMEOUT_MS   bound on each listing read (default 15 s).
//   DIRECT_UPSTREAM_MIN_SAVING_PCT     the share direct must undercut OpenRouter by,
//                                      0 to below 100. Unset: the private cost table's
//                                      vendor.direct.minSaving (a fraction); neither: 0,
//                                      so direct is taken only when strictly cheaper.
//   DIRECT_UPSTREAM_MEASURE_WINDOW     answers kept per model per upstream (default 200).
//   DIRECT_UPSTREAM_MEASURE_MIN        sample each side needs before the backstop acts (default 30).
//   DIRECT_UPSTREAM_OR_MODELS_URL      OpenRouter's models base, for a test stub.
//
// Logs carry state words only (cheaper, not_cheaper, unreadable), never a
// price, an estimate or a comparison figure. The figures are on the operator
// view (/__operator/direct-upstream.json) only; /api/gateway-status carries
// the word.

import { directUpstreamConfig } from "./gateway-direct-upstream.js";
import { vendorRate } from "./upstream-costs.js";

/** Endpoint tags of the priority service tier: never routed for a default call. */
export const PRIORITY_ENDPOINT_TAG = /\/(fast|ultrafast|priority)$/;
const OR_MODELS_URL = () => String(process.env.DIRECT_UPSTREAM_OR_MODELS_URL || "https://openrouter.ai/api/v1/models").replace(/\/+$/, "");
const intEnv = (name, dflt, min = 1) => {
  const n = parseInt(String(process.env[name] ?? "").trim(), 10);
  return Number.isFinite(n) && n >= min ? n : dflt;
};
export const priceRefreshMs = () => intEnv("DIRECT_UPSTREAM_PRICE_REFRESH_MS", 60 * 60_000, 1000);
const priceTimeoutMs = () => intEnv("DIRECT_UPSTREAM_PRICE_TIMEOUT_MS", 15_000, 100);
const measureWindow = () => intEnv("DIRECT_UPSTREAM_MEASURE_WINDOW", 200);
const measureMin = () => intEnv("DIRECT_UPSTREAM_MEASURE_MIN", 30);
const staleAfterMs = () => 3 * priceRefreshMs();

function parsePct(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\d{1,2}(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n < 100 ? n / 100 : null;
}
/** The fraction direct must undercut OpenRouter by: env, else the private
 *  table, else 0 (strictly cheaper). */
export function minSavingFraction(env = process.env) {
  const fromEnv = parsePct(env.DIRECT_UPSTREAM_MIN_SAVING_PCT);
  if (fromEnv !== null) return fromEnv;
  const t = vendorRate("direct", "minSaving");
  return typeof t === "number" && Number.isFinite(t) && t >= 0 && t < 1 ? t : 0;
}
/** Boot warnings (names only, never values). */
export function directPriceBookBootWarnings(env = process.env) {
  const raw = env.DIRECT_UPSTREAM_MIN_SAVING_PCT;
  if (raw !== undefined && String(raw).trim() !== "" && parsePct(raw) === null) return ["WARNING: DIRECT_UPSTREAM_MIN_SAVING_PCT is not a number from 0 to below 100; ignored (the cost table's value, else none, applies)"];
  return [];
}

// ---- parsing ---------------------------------------------------------------
const num = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) ? Number(v) : NaN;
/** A direct listing's pricing object as USD per 1M tokens, or { reason }. */
export function parseDirectPricing(pr) {
  if (!pr || typeof pr !== "object") return { reason: "bad_price" };
  const p = num(pr.prompt), c = num(pr.completion);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p <= 0 || c <= 0) return { reason: "bad_price" };
  const req = pr.request === undefined || pr.request === null || pr.request === "" ? 0 : num(pr.request);
  if (!Number.isFinite(req) || req < 0) return { reason: "bad_price" };
  if (req > 0) return { reason: "request_fee" };
  return { prompt: p * 1e6, completion: c * 1e6 };
}
/** OpenRouter's endpoint list as routable { tag, prompt, completion } (USD per
 *  1M tokens), priority-tier endpoints and unparsable prices dropped; null
 *  when the body is not an endpoint list. */
export function parseOrEndpoints(j) {
  const eps = j?.data?.endpoints;
  if (!Array.isArray(eps)) return null;
  const out = [];
  for (const e of eps) {
    const tag = String(e?.tag || "");
    if (PRIORITY_ENDPOINT_TAG.test(tag)) continue;
    const p = num(e?.pricing?.prompt), c = num(e?.pricing?.completion);
    if (!Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0) continue;
    out.push({ tag, prompt: p * 1e6, completion: c * 1e6 });
  }
  return out;
}

// ---- the book --------------------------------------------------------------
// direct: { at, prices: Map<orId, {prompt, completion} | {reason}> } from the
// last successful listing read; or: Map<orId, { at, endpoints }> per model.
let book = { direct: null, or: new Map(), refreshes: 0 };
let inflight = null;
let lastLoggedWord = null;
let nowFn = Date.now;
export function _setPriceBookNowForTest(fn) { nowFn = typeof fn === "function" ? fn : Date.now; }
export function _resetDirectPriceBookForTest() { book = { direct: null, or: new Map(), refreshes: 0 }; measures = new Map(); lastLoggedWord = null; nowFn = Date.now; }
/** Test seam: seed the book as if a refresh read these (USD per 1M tokens):
 *  { [orId]: { direct: {prompt, completion} | {reason}, endpoints: [{prompt, completion, tag?}] } }. */
export function _seedDirectPriceBookForTest(entries, at = nowFn()) {
  const prices = new Map();
  for (const [id, e] of Object.entries(entries || {})) {
    prices.set(id.toLowerCase(), e.direct);
    book.or.set(id.toLowerCase(), { at, endpoints: (e.endpoints || []).map((x) => ({ tag: x.tag || "", prompt: x.prompt, completion: x.completion })) });
  }
  book.direct = { at, prices };
  book.refreshes++;
}

async function readJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(priceTimeoutMs()) });
  if (!res.ok) { await res.text().catch(() => ""); throw new Error("http"); }
  return res.json();
}

/** One refresh of the book: the direct listing once, then each mapped model's
 *  OpenRouter endpoints. A read that fails keeps the previous entry (which
 *  goes stale after three intervals). Concurrent callers share one run. */
export function refreshDirectPriceBook({ fetchImpl } = {}) {
  const cfg = directUpstreamConfig();
  if (!cfg) return Promise.resolve("off");
  if (inflight) return inflight;
  const f = fetchImpl || globalThis.fetch;
  inflight = (async () => {
    try {
      const j = await readJson(cfg.modelsUrl, f);
      if (!Array.isArray(j?.data) || !j.data.length) throw new Error("shape");
      const byId = new Map(j.data.filter((m) => m && typeof m.id === "string").map((m) => [m.id, m]));
      const prices = new Map();
      for (const [orId, upId] of cfg.models) {
        const m = byId.get(upId);
        prices.set(orId, m ? parseDirectPricing(m.pricing) : { reason: "unlisted" });
      }
      book.direct = { at: nowFn(), prices };
    } catch { /* keep the previous read */ }
    for (const orId of cfg.models.keys()) {
      try {
        const eps = parseOrEndpoints(await readJson(`${OR_MODELS_URL()}/${orId}/endpoints`, f));
        if (eps) book.or.set(orId, { at: nowFn(), endpoints: eps });
      } catch { /* keep the previous read */ }
    }
    book.refreshes++;
    const word = directUpstreamWord();
    if (word !== lastLoggedWord) {
      lastLoggedWord = word;
      console.log(`[direct-upstream] price book: ${word === "ok" ? "cheaper" : word}`);
    }
    return word;
  })().finally(() => { inflight = null; });
  return inflight;
}

let timer = null;
/** Start the background refresh (one per process): now, then every interval. */
export function startDirectPriceBook() {
  if (timer) return;
  const tick = () => { refreshDirectPriceBook().catch(() => {}); };
  setTimeout(tick, 0).unref?.();
  timer = setInterval(tick, priceRefreshMs());
  timer.unref?.();
}

// ---- the static verdict per model ---------------------------------------------
const fresh = (at) => Number.isFinite(at) && nowFn() - at <= staleAfterMs();
/** The book's reading for one model: { direct, endpoints } or { reason } with
 *  reason one of unread, stale, unlisted, bad_price, request_fee, no_endpoint. */
function bookEntry(orId) {
  const id = String(orId || "").toLowerCase();
  const d = book.direct;
  const o = book.or.get(id);
  if (!d || !d.prices.has(id) || !o) return { reason: "unread" };
  if (!fresh(d.at) || !fresh(o.at)) return { reason: "stale" };
  const direct = d.prices.get(id);
  if (!direct || direct.reason) return { reason: direct?.reason || "bad_price" };
  if (!o.endpoints.length) return { reason: "no_endpoint" };
  return { direct, endpoints: o.endpoints };
}

const callCost = (row, inTok, outTok) => inTok * row.prompt + outTok * row.completion;
/** Listed comparison for one call shape: true when direct undercuts the
 *  cheapest of `endpoints` by the minimum saving share. */
export function listedCheaper(direct, endpoints, inTok, outTok, saving = minSavingFraction()) {
  if (!direct || !Array.isArray(endpoints) || !endpoints.length) return false;
  const or = Math.min(...endpoints.map((e) => callCost(e, inTok, outTok)));
  const d = callCost(direct, inTok, outTok);
  return Number.isFinite(or) && Number.isFinite(d) && d < or * (1 - saving);
}
/** Input-to-output shapes the model-level verdict (and the drift guard) reads. */
export const REFERENCE_SHAPES = Object.freeze([[4, 1], [1, 1], [1, 4]]);
/** A model whose listed prices undercut OpenRouter at none of the reference shapes. */
export function listedNotCheaperAnywhere(direct, endpoints, saving = minSavingFraction()) {
  return !REFERENCE_SHAPES.some(([i, o]) => listedCheaper(direct, endpoints, i, o, saving));
}

// ---- measured backstop -----------------------------------------------------------
let measures = new Map(); // orId -> { direct: [{usd, tokens}], openrouter: [...] }
/** Record one served answer's reported cost for a mapped model. */
export function noteDirectMeasure(orId, upstream, usage, usd) {
  const cfg = directUpstreamConfig();
  const id = String(orId || "").toLowerCase();
  if (!cfg || !cfg.models.has(id)) return;
  const tokens = Number(usage?.prompt_tokens || 0) + Number(usage?.completion_tokens || 0);
  if (!(typeof usd === "number" && Number.isFinite(usd) && usd >= 0) || !(Number.isFinite(tokens) && tokens > 0)) return;
  let m = measures.get(id);
  if (!m) measures.set(id, (m = { direct: [], openrouter: [] }));
  const list = m[upstream === "direct" ? "direct" : "openrouter"];
  list.push({ usd, tokens });
  const keep = measureWindow();
  if (list.length > keep) list.splice(0, list.length - keep);
}
const per1k = (list) => {
  const t = list.reduce((a, x) => a + x.tokens, 0);
  return t > 0 ? (list.reduce((a, x) => a + x.usd, 0) / t) * 1000 : null;
};
function measured(orId) {
  const m = measures.get(String(orId || "").toLowerCase()) || { direct: [], openrouter: [] };
  const min = measureMin();
  const direct = per1k(m.direct), openrouter = per1k(m.openrouter);
  const ready = m.direct.length >= min && m.openrouter.length >= min;
  return { samples: { direct: m.direct.length, openrouter: m.openrouter.length }, direct, openrouter, blocked: ready && !(direct < openrouter) };
}

// ---- per call ---------------------------------------------------------------
/** The decision before a direct attempt. `go` true only when every check
 *  passes; `skip` is the bucket recorded on the operator stats otherwise. */
export function directPriceDecision(orId, { inputTokens, outputTokens, maxPrice } = {}) {
  const e = bookEntry(orId);
  if (e.reason) return { go: false, skip: e.reason === "unread" || e.reason === "stale" ? "price_unreadable" : `price_${e.reason}` };
  if (!(Number.isFinite(inputTokens) && inputTokens > 0) || !(Number.isFinite(outputTokens) && outputTokens > 0)) return { go: false, skip: "price_estimate" };
  const cap = maxPrice && typeof maxPrice === "object" ? maxPrice : null;
  const routable = cap ? e.endpoints.filter((x) => !(x.prompt > Number(cap.prompt) + 1e-9) && !(x.completion > Number(cap.completion) + 1e-9)) : e.endpoints;
  if (!routable.length) return { go: false, skip: "price_no_endpoint" };
  if (!listedCheaper(e.direct, routable, inputTokens, outputTokens)) return { go: false, skip: "not_cheaper" };
  if (measured(orId).blocked) return { go: false, skip: "measured_not_cheaper" };
  return { go: true };
}

// ---- state word and operator view ----------------------------------------------
/** One model's state: ok, not_cheaper or unreadable. */
function modelState(orId) {
  const e = bookEntry(orId);
  if (e.reason === "unread" || e.reason === "stale") return "unreadable";
  if (e.reason) return "not_cheaper";
  if (measured(orId).blocked || listedNotCheaperAnywhere(e.direct, e.endpoints)) return "not_cheaper";
  return "ok";
}
/** The public word: off (unconfigured), starting (no refresh finished yet),
 *  unreadable (a mapped model's book is unread or stale), not_cheaper (a
 *  mapped model is kept on OpenRouter by its listed prices or its measure), ok. */
export function directUpstreamWord() {
  const cfg = directUpstreamConfig();
  if (!cfg) return "off";
  if (!book.refreshes) return "starting";
  const states = [...cfg.models.keys()].map(modelState);
  if (states.includes("unreadable")) return "unreadable";
  if (states.includes("not_cheaper")) return "not_cheaper";
  return "ok";
}
/** Operator-only detail: per model the state, the listed prices read, the
 *  cheapest routable endpoint per unit, ages and the measure. */
export function directPriceBookReport() {
  const cfg = directUpstreamConfig();
  const now = nowFn();
  const models = {};
  for (const orId of cfg ? cfg.models.keys() : []) {
    const d = book.direct?.prices.get(orId);
    const o = book.or.get(orId);
    const m = measured(orId);
    models[orId] = {
      state: modelState(orId),
      direct: d ? (d.reason ? { reason: d.reason } : { ...d }) : null,
      openrouter: o ? { endpoints: o.endpoints.length, cheapestPrompt: o.endpoints.length ? Math.min(...o.endpoints.map((x) => x.prompt)) : null, cheapestCompletion: o.endpoints.length ? Math.min(...o.endpoints.map((x) => x.completion)) : null, ageMs: now - o.at } : null,
      listedAgeMs: book.direct ? now - book.direct.at : null,
      measuredPer1k: { direct: m.direct, openrouter: m.openrouter, samples: m.samples, minSample: measureMin(), blocked: m.blocked },
    };
  }
  return { word: directUpstreamWord(), unit: "USD per 1M tokens (listed); USD per 1k tokens (measured)", refreshMs: priceRefreshMs(), staleAfterMs: staleAfterMs(), minSaving: minSavingFraction(), refreshes: book.refreshes, models };
}
