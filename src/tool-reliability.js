// Per-tool reliability (GET /api/reliability/tools): for every route in the
// catalog, the share of calls answered without a fault on our side and the
// median and 95th percentile latency, over a stated window, each row marked
// "measured" or "not enough data".
//
// SOURCE. The tool-call rows the dispatcher already records
// (src/analytics-db.js getToolOutcomes): no new data is collected. Synthetic
// (heartbeat, canary), probe and pre-payment rows are left out, as the
// dashboard leaves them out.
//
// WHAT COUNTS. successRate = answered / (answered + failed on our side): an
// answer below 400 is a success, a 5xx is a failure, and a 4xx (the caller's
// own input, a payment refusal) is neither, so a buyer's bad input never
// moves a tool's rate. Latency is over the same calls, end to end inside the
// server, in milliseconds.
//
// HONEST WHEN THIN. Below MIN_SAMPLE calls in the window a row reads
// status "not enough data" and its figures are null: a rate over three calls
// is noise stated as a fact. With no
// analytics store configured, or a query that failed, the document says
// available:false and why, and every row is unmeasured: never a figure from
// another window or a guess.
//
// WHAT IS NOT PUBLISHED. Call counts in any form (no count, no band) and any
// ranking: per-tool volume stays operator-only (redactAnalytics). Rows come
// in catalog order by slug, every route listed whatever its traffic. The
// operator view (operatorView, X-Operator-Token) adds each row's exact
// `calls` and `serverErrors`.
//
// COST. One grouped query per TOOL_RELIABILITY_CACHE_MS (10 minutes) per
// process, single-flight, bounded by the analytics pool's statement timeout;
// every read in between is served from memory. TOOL_RELIABILITY_PUBLIC=off
// withdraws the table (the route answers available:false, reason off, and
// /api/pricing drops its pointer).
import { partialFields } from "./partial-answer.js";

export const TOOL_RELIABILITY_PATH = "/api/reliability/tools";
export const TOOL_RELIABILITY_WINDOW_HOURS = 168;
export const TOOL_RELIABILITY_MIN_SAMPLE = 20;
export const TOOL_RELIABILITY_CACHE_MS = 10 * 60_000;
const FAILED_RETRY_MS = 60_000;

export function toolReliabilityEnabled(env = process.env) {
  return String(env.TOOL_RELIABILITY_PUBLIC || "").trim().toLowerCase() !== "off";
}

export const STATUS_MEASURED = "measured";
export const STATUS_THIN = "not enough data";

/** A rate floored to three places, so a tool with any failure never reads 1. */
function floorRate(okCount, n) {
  if (!n) return null;
  return Math.floor((okCount / n) * 1000) / 1000;
}

/** One row of the table, from the outcome row for the slug (or none).
 *  `operator` adds the exact counts (the operator view only). */
export function reliabilityRow({ slug, route }, outcome, available, { operator = false } = {}) {
  const n = outcome ? Number(outcome.n) || 0 : 0;
  const measured = available && n >= TOOL_RELIABILITY_MIN_SAMPLE;
  return {
    slug,
    route,
    status: measured ? STATUS_MEASURED : STATUS_THIN,
    measured,
    successRate: measured ? floorRate(Number(outcome.ok) || 0, n) : null,
    p50Ms: measured && Number.isFinite(Number(outcome.p50)) ? Number(outcome.p50) : null,
    p95Ms: measured && Number.isFinite(Number(outcome.p95)) ? Number(outcome.p95) : null,
    ...(operator && available ? { calls: n, serverErrors: outcome ? Number(outcome.serverErrored) || 0 : 0 } : {}),
  };
}

/**
 * The document. `tools` is every catalog route as { slug, route }; `result`
 * is getToolOutcomes()'s answer (or null when switched off). `slug` narrows
 * to one row.
 */
export function toolReliabilityDocument({ baseUrl = "", tools = [], result = null, asOf = new Date().toISOString(), off = false, slug = null, operator = false } = {}) {
  const available = !off && !!result?.ok;
  const byslug = new Map((available ? result.rows : []).map((r) => [r.slug, r]));
  const all = [...tools].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const picked = slug ? all.filter((t) => t.slug === slug) : all;
  const rows = picked.map((t) => reliabilityRow(t, byslug.get(t.slug), available, { operator }));
  return {
    document: "agent402-tool-reliability",
    url: `${baseUrl}${TOOL_RELIABILITY_PATH}`,
    asOf,
    available,
    ...(available ? {} : { reason: off ? "off" : (result?.reason || "not-configured") }),
    window: { hours: TOOL_RELIABILITY_WINDOW_HOURS, endsAt: asOf },
    minSample: TOOL_RELIABILITY_MIN_SAMPLE,
    basis: {
      successRate: "answers below 400 over answers below 400 plus answers of 500 or above, in the window; a 4xx (the caller's input, a payment refusal) is not counted either way; floored to three places",
      latency: "milliseconds inside the server, from the request reaching the tool to its answer, over the same calls",
      status: `measured, or not enough data when the tool had fewer than minSample calls in the window (its figures are then null)`,
      excluded: "this server's own monitoring and test calls, empty-input probes and refusals answered before payment",
      order: "by slug; every catalog route is listed whatever its traffic",
    },
    ...partialFields(picked.length, rows.length),
    tools: rows,
  };
}

// ---- the cache -------------------------------------------------------------
let cached = null; // { at, result, ttl }
let inflight = null;

/** getToolOutcomes() through the cache. `load` is the query (injected by
 *  server.js; tests pass a stub). Never throws. */
export async function toolOutcomesCached(load, { now = Date.now() } = {}) {
  if (cached && now - cached.at >= 0 && now - cached.at < cached.ttl) return cached.result;
  if (!inflight) {
    inflight = (async () => {
      let result;
      try { result = await load({ windowHours: TOOL_RELIABILITY_WINDOW_HOURS }); } catch { result = { ok: false, reason: "query-failed" }; }
      if (!result || typeof result !== "object") result = { ok: false, reason: "query-failed" };
      cached = { at: Date.now(), result, ttl: result.ok ? TOOL_RELIABILITY_CACHE_MS : FAILED_RETRY_MS };
      return result;
    })().finally(() => { inflight = null; });
  }
  return inflight;
}

export function __resetToolReliabilityCacheForTests() { cached = null; inflight = null; }
