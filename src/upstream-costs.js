// Upstream rates are private. They are read at boot from UPSTREAM_COSTS_JSON
// (raw JSON or base64; a Railway variable in production, an Actions secret in
// CI) or from the file named by UPSTREAM_COSTS_FILE, and are never committed.
//
// Shape:
//   { models: [[prefix, { prompt, completion }], ...],   USD per 1M tokens, longest prefix wins
//     speech: { modelId: usdPerChar },
//     fees: { webSearchPerUse, groundedPerCall },
//     embeddings: { model: usdPer1MInputTokens },
//     openai: { model: { prompt, cached, completion } },
//     sttPerMinute: { model: usdPerMinute },
//     media: { model: { worstCaseUsd, listedMaxUsd } },
//     meter: { markup } }
//
// Without the table every lookup answers null and callers take their safe
// path: flat tiers price at their own max_price bound, the metered tier
// refuses before any charge. Nothing here logs a value.

import { readFileSync } from "node:fs";

const EMPTY = Object.freeze({ models: [], speech: {}, fees: {}, embeddings: {}, openai: {}, sttPerMinute: {}, media: {}, meter: {} });
let table = null;
let loaded = false;
let warned = false;

function parse(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const j = JSON.parse(json);
  if (!j || !Array.isArray(j.models)) throw new Error("models must be an array");
  return j;
}

function normalize(j) {
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  const models = [];
  for (const row of j.models || []) {
    if (!Array.isArray(row) || typeof row[0] !== "string") continue;
    const p = num(row[1]?.prompt), c = num(row[1]?.completion);
    if (p == null || c == null) continue;
    models.push([row[0].toLowerCase(), Object.freeze({ prompt: p, completion: c })]);
  }
  const map = (o, f) => Object.freeze(Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, f(v)]).filter(([, v]) => v != null)));
  return Object.freeze({
    models: Object.freeze(models),
    speech: map(j.speech, num),
    fees: map(j.fees, num),
    embeddings: map(j.embeddings, num),
    openai: map(j.openai, (r) => {
      const p = num(r?.prompt), c = num(r?.completion);
      return p == null || c == null ? null : Object.freeze({ prompt: p, cached: num(r?.cached) ?? p, completion: c });
    }),
    sttPerMinute: map(j.sttPerMinute, num),
    meter: map(j.meter, num),
    media: map(j.media, (r) => {
      const w = num(r?.worstCaseUsd);
      return w == null ? null : Object.freeze({ worstCaseUsd: w, listedMaxUsd: num(r?.listedMaxUsd) });
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
export function upstreamCostsLoaded() { load(); return loaded; }

/** Tests only: install a table (or null to clear and re-read the environment). */
export function setUpstreamCostsForTest(j) {
  warned = false;
  if (j == null) { table = null; loaded = false; return; }
  table = normalize(j);
  loaded = table.models.length > 0;
}
