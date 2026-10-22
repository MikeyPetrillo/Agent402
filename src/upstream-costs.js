// Upstream rates are private. They are read at boot from UPSTREAM_COSTS_JSON
// (raw JSON or base64; a Railway variable in production, an Actions secret in
// CI) or from the file named by UPSTREAM_COSTS_FILE, and are never committed.
//
// Shape:
//   { models: [[prefix, { prompt, completion, tiers? }], ...],   USD per 1M tokens, longest prefix wins
//       tiers (optional): [{ aboveTokens, prompt, completion }, ...], the long-context
//       prices a model bills once a prompt reaches aboveTokens prompt tokens
//       (inclusive, the upstream's min_prompt_tokens). Strictly ascending by
//       aboveTokens, every rate positive and never below the base row or the
//       tier before it; a row whose tiers break any of that is dropped (a gap),
//       because keeping its base rate would underprice a long prompt.
//     speech: { modelId: usdPerChar },                       the speech wire models and the direct speech fallbacks
//     fees: { webSearchPerUse, groundedPerCall, rerankPerUnit },
//     embeddings: { model: usdPer1MInputTokens },
//     openai: { model: { prompt, cached, completion } },     USD per 1M tokens; the image model's completion rate is per image token
//     sttPerMinute: { model: usdPerMinute },
//     media: { model: { worstCaseUsd, listedMaxUsd } },
//     meter: { markup },
//     vendor: { exa: { search, instant, answer, content }, x: { postRead, userRead },
//               decisions: { luna, decisionOne, jev, maxShare } } }   luna, decisionOne, jev: USD per 1M input tokens; maxShare: largest share of the price a call may cost
//
// docs/example-upstream-costs.json shows the format with placeholder numbers.
//
// Without the table every lookup answers null and callers take their safe
// path: flat tiers price at their own max_price bound, the metered tier
// refuses before any charge. A table that loads but lacks a section, or has a
// model row that did not parse, reads "partial" (upstreamCostsGaps) so the
// heartbeat pages. Nothing here logs a value.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const EMPTY = Object.freeze({ models: [], speech: {}, fees: {}, embeddings: {}, openai: {}, sttPerMinute: {}, media: {}, meter: {}, vendor: {} });
let table = null;
let loaded = false;
let warned = false;
let dropped = [];

// Every key a serving path reads. A missing one makes that path refuse (503),
// and a dropped model row lets a model fall back to a shorter, cheaper prefix,
// so both count as gaps.
const REQUIRED = [
  ["fees", "webSearchPerUse"], ["fees", "groundedPerCall"], ["fees", "rerankPerUnit"], ["meter", "markup"],
  ["vendor", "exa", "search"], ["vendor", "exa", "instant"], ["vendor", "exa", "answer"], ["vendor", "exa", "content"],
  ["vendor", "x", "postRead"], ["vendor", "x", "userRead"], ["vendor", "decisions", "luna"], ["vendor", "decisions", "maxShare"],
  ["vendor", "decisions", "decisionOne"], ["vendor", "decisions", "jev"],
  // The direct image model (USD per 1M tokens: prompt for text input,
  // completion for image output), which the spend meter prices from this row.
  ["openai", "gpt-image-2"],
  // The image edit route's only link (llm-images-fast-kit.js).
  ["media", "black-forest-labs/flux-3-image-klein"],
];
const NONEMPTY = ["speech", "embeddings", "openai", "sttPerMinute", "media"];

function parse(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const j = JSON.parse(json);
  if (!j || !Array.isArray(j.models)) throw new Error("models must be an array");
  return j;
}

// A row's long-context tiers, validated, or null when any entry is malformed.
// Each tier needs a positive whole aboveTokens, strictly above the previous
// one, and positive rates at or above both the base row and the tier before
// it: upstream long-context prices only rise with the prompt, and a tier
// cheaper than the one below it would make a longer prompt quote less.
function normalizeTiers(raw, baseP, baseC, pos) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  let prev = { aboveTokens: 0, prompt: baseP, completion: baseC };
  for (const t of raw) {
    const above = t?.aboveTokens, p = pos(t?.prompt), c = pos(t?.completion);
    if (!Number.isSafeInteger(above) || above <= prev.aboveTokens || p == null || c == null) return null;
    if (p < prev.prompt || c < prev.completion) return null;
    prev = Object.freeze({ aboveTokens: above, prompt: p, completion: c });
    out.push(prev);
  }
  return Object.freeze(out);
}

/** The rate a row bills for a prompt of `promptTokens` tokens: the last tier
 *  whose aboveTokens it reaches, else the base row itself (the same object,
 *  so a caller comparing rows by identity sees the row). A missing or
 *  non-finite size reads as the base row. */
export function rowRateAt(row, promptTokens) {
  if (!row || !Array.isArray(row.tiers) || !row.tiers.length) return row;
  const n = Number(promptTokens);
  if (!Number.isFinite(n)) return row;
  let hit = row;
  for (const t of row.tiers) if (n >= t.aboveTokens) hit = t;
  return hit;
}

function normalize(j) {
  // Only a real positive number is a rate. null, "", false and [] coerce to 0
  // under Number(), and a zero rate turns a margin clamp off or prices a fee
  // at nothing, so anything else drops the entry. A dropped fee or vendor rate
  // makes its caller refuse; a dropped model row is recorded as a gap, because
  // the longest-prefix lookup would fall back to a shorter row.
  const pos = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  // A model row may be exactly 0/0 only for a stealth listing that is free.
  const rate = (v, prefix) => (prefix.startsWith("stealth/") && v === 0 ? 0 : pos(v));
  const models = [];
  dropped = [];
  for (const row of j.models || []) {
    if (!Array.isArray(row) || typeof row[0] !== "string" || !row[0]) { dropped.push("(unnamed)"); continue; }
    const prefix = row[0].toLowerCase();
    const p = rate(row[1]?.prompt, prefix), c = rate(row[1]?.completion, prefix);
    if (p == null || c == null) { dropped.push(prefix); continue; }
    if (row[1].tiers === undefined) { models.push([prefix, Object.freeze({ prompt: p, completion: c })]); continue; }
    const tiers = normalizeTiers(row[1].tiers, p, c, pos);
    if (!tiers) { dropped.push(prefix); continue; }
    models.push([prefix, Object.freeze({ prompt: p, completion: c, tiers })]);
  }
  const map = (o, f) => Object.freeze(Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).map(([k, v]) => [k, f(v)]).filter(([, v]) => v != null)));
  return Object.freeze({
    models: Object.freeze(models),
    speech: map(j.speech, pos),
    fees: map(j.fees, pos),
    embeddings: map(j.embeddings, pos),
    openai: map(j.openai, (r) => {
      const p = pos(r?.prompt), c = pos(r?.completion);
      return p == null || c == null ? null : Object.freeze({ prompt: p, cached: pos(r?.cached) ?? p, completion: c });
    }),
    sttPerMinute: map(j.sttPerMinute, pos),
    meter: map(j.meter, pos),
    vendor: map(j.vendor, (v) => map(v, pos)),
    media: map(j.media, (r) => {
      const w = pos(r?.worstCaseUsd);
      return w == null ? null : Object.freeze({ worstCaseUsd: w, listedMaxUsd: pos(r?.listedMaxUsd) });
    }),
  });
}

function load() {
  if (table) return table;
  let j = null;
  try {
    if (process.env.UPSTREAM_COSTS_JSON) j = parse(process.env.UPSTREAM_COSTS_JSON);
    else if (process.env.UPSTREAM_COSTS_FILE) j = parse(readFileSync(process.env.UPSTREAM_COSTS_FILE, "utf8"));
  } catch (e) {
    if (!warned) { warned = true; console.warn(`[upstream-costs] unreadable (${String(e?.name || "error")}); running without the private table`); }
    j = null;
  }
  table = j ? normalize(j) : EMPTY;
  loaded = !!j && table.models.length > 0;
  return table;
}

export function upstreamCosts() { return load(); }
/** Row count and a short fingerprint of the parsed table: lets production's
 *  copy be compared with CI's without printing a value. */
export function upstreamCostsSummary() {
  const t = load();
  return { models: t.models.length, fingerprint: loaded ? createHash("sha256").update(JSON.stringify(t)).digest("hex").slice(0, 12) : null };
}
export function upstreamCostsLoaded() { load(); return loaded; }

/** Names (never values) of what a loaded table lacks: required keys, empty
 *  sections, and model rows that did not parse. Empty when complete. */
export function upstreamCostsGaps() {
  const t = load();
  if (!loaded) return [];
  const gaps = [];
  for (const path of REQUIRED) if (path.reduce((o, k) => (o == null ? o : o[k]), t) == null) gaps.push(path.join("."));
  for (const k of NONEMPTY) if (!Object.keys(t[k]).length) gaps.push(k);
  for (const p of dropped) gaps.push(`models[${p}]`);
  return gaps;
}

/** "ok" | "partial" | "missing": one word for /api/gateway-status. */
export function upstreamCostsStatus() {
  return !upstreamCostsLoaded() ? "missing" : upstreamCostsGaps().length ? "partial" : "ok";
}

/** Tests only: install a table (or null to clear and re-read the environment). */
export function setUpstreamCostsForTest(j) {
  warned = false;
  dropped = [];
  if (j == null) { table = null; loaded = false; return; }
  table = normalize(j);
  loaded = table.models.length > 0;
}
