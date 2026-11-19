// Per-tool reliability (GET /api/reliability/tools): for every route in the
// catalog, the share of calls answered without a fault on our side and the
// median and 95th percentile latency, over a stated window, with the sample
// the figures stand on.
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
// HONEST WHEN THIN. Below MIN_SAMPLE calls in the window a row says
// measured:false and its figures are null: a rate over three calls is noise
// stated as a fact. A row with no calls at all says sample "0". With no
// analytics store configured, or a query that failed, the document says
// available:false and why, and every row is unmeasured: never a figure from
// another window or a guess.
//
// WHAT IS NOT PUBLISHED. Exact call counts and any ranking: the per-tool
// volume table stays operator-only (redactAnalytics). Rows come in catalog
// order by slug, every route listed whatever its traffic, and the sample is
// a band ("1-19", "20-99", "100-999", "1000+").
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

/** The sample band for a call count. */
export function sampleBand(n) {
  const c = Math.max(0, Number(n) || 0);
  if (c === 0) return "0";
  if (c < TOOL_RELIABILITY_MIN_SAMPLE) return `1-${TOOL_RELIABILITY_MIN_SAMPLE - 1}`;
  if (c < 100) return `${TOOL_RELIABILITY_MIN_SAMPLE}-99`;
  if (c < 1000) return "100-999";
  return "1000+";
}

/** A rate floored to three places, so a tool with any failure never reads 1. */
function floorRate(okCount, n) {
  if (!n) return null;
  return Math.floor((okCount / n) * 1000) / 1000;
}

/** One row of the table, from the outcome row for the slug (or none). */
export function reliabilityRow({ slug, route }, outcome, available) {
  const n = outcome ? Number(outcome.n) || 0 : 0;
  const measured = available && n >= TOOL_RELIABILITY_MIN_SAMPLE;
  return {
    slug,
    route,
    sample: available ? sampleBand(n) : null,
    measured,
    successRate: measured ? floorRate(Number(outcome.ok) || 0, n) : null,
    p50Ms: measured && Number.isFinite(Number(outcome.p50)) ? Number(outcome.p50) : null,
    p95Ms: measured && Number.isFinite(Number(outcome.p95)) ? Number(outcome.p95) : null,
  };
}

/**
 * The document. `tools` is every catalog route as { slug, route }; `result`
 * is getToolOutcomes()'s answer (or null when switched off). `slug` narrows
 * to one row.
 */
export function toolReliabilityDocument({ baseUrl = "", tools = [], result = null, asOf = new Date().toISOString(), off = false, slug = null } = {}) {
  const available = !off && !!result?.ok;
  const byslug = new Map((available ? result.rows : []).map((r) => [r.slug, r]));
  const all = [...tools].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const picked = slug ? all.filter((t) => t.slug === slug) : all;
  const rows = picked.map((t) => reliabilityRow(t, byslug.get(t.slug), available));
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
      sample: "the calls the figures stand on, as a band; below minSample a row is measured:false and its figures are null",
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
