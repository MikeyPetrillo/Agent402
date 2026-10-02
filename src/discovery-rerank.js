// Split the wish board into "build this" and "fix the index".
//
// THE PROBLEM. /api/find scores string overlap (find.js:206-218) and its own
// comment at :202 says what a wrong top result costs: an agent that trusts it
// pays for the wrong tool and gets something useless on its first call. The
// score cannot tell us when that happened. Measured over eight real wish-board
// misses on 2026-09-21, find's score for a CORRECT answer and for nonsense was
// identical, 45 to 47 in every case:
//
//   "convert kilowatts to mechanical horsepower" -> unit-convert          46  right
//   "extract a web page into structured json"    -> pdf-extract-pages     46  wrong
//   "bureau of labor statistics cpi"             -> cpi-yoy               46  right
//   "mcp prompt injection protection"            -> skill-brand-protection 45 wrong
//
// No threshold on that number can gate anything, however the weights are tuned.
//
// WHAT THIS DOES. Every wish is a recorded MISS: someone searched and left
// unsatisfied. But two very different things produce one, and the board cannot
// tell them apart:
//
//   a catalog GAP    - we do not sell this. The wish is real demand. Build it.
//   an INDEX miss    - we DO sell it and find did not rank it. Nothing to build;
//                      add a curated alias, which is the documented fix for a
//                      mis-ranked tool in this codebase (never a score boost).
//
// A Choice over find's own candidates, with an explicit no-match option,
// separates them. Confidence decides whether we believe it.
//
// WHERE IT RUNS. Never on the serving path. /api/find is free and
// unauthenticated; a paid third-party call per query there is an unmetered
// upstream on a free route. This reads misses ALREADY RECORDED, on an operator
// surface, opt-in, bounded and cached - the same posture as wish-classify.js.
//
// It proposes. It writes no alias, changes no count, and cannot alter what
// /api/find returns to anyone.
import { logSafe } from "./log-safe.js";
import { looksLikeListingInjection } from "./x402-index.js";

const ENDPOINT = (process.env.TYPESAFE_API_URL || "https://api.typesafe.ai/v1/systemone").trim();
const MODEL = (process.env.TYPESAFE_MODEL || "jev-latest").trim();
const keyOf = () => (process.env.TYPESAFE_API_KEY || "").trim();
export const rerankEnabled = () => !!keyOf();

const MAX_ROWS = Number(process.env.RERANK_MAX_ROWS || 40);
const CANDIDATES = Number(process.env.RERANK_CANDIDATES || 5);
const CACHE_TTL_MS = Number(process.env.RERANK_CACHE_TTL_MS || 24 * 3_600_000);
const CACHE_MAX = 2_000;
const TIMEOUT_MS = 20_000;
const DESC_MAX = 170;

// Thresholds. STARTING POINTS from eight queries, not a calibration: the doc
// this came from says so and so does this comment. Raise before anything acts
// on them automatically. The bands are the docs' own three-path pattern.
export const ACT = Number(process.env.RERANK_ACT_CONFIDENCE || 0.85);
export const CONSIDER = Number(process.env.RERANK_CONSIDER_CONFIDENCE || 0.6);

export const NO_MATCH = "none_of_these";

const cache = new Map(); // query -> { at, result }

/** The candidate set IS find's own top-N, so this re-ranks what discovery
 *  already surfaces and never invents a tool it did not. A tool find never
 *  surfaced cannot be rescued here, which is a real ceiling and is stated in
 *  the report rather than hidden. */
export function buildCriteria(results, { descMax = DESC_MAX } = {}) {
  const criteria = {};
  for (const r of results) {
    if (!r?.slug) continue;
    const name = String(r.name || r.slug);
    const desc = String(r.description || "").replace(/\s+/g, " ").slice(0, descMax);
    criteria[r.slug] = desc ? `${name}: ${desc}` : name;
  }
  // Load-bearing. The docs are explicit that a no-match outcome must be offered
  // or the model cannot express one, and a genuine gap is the answer this board
  // exists to capture.
  criteria[NO_MATCH] = "None of the listed tools does this job. The catalog does not cover this request.";
  return criteria;
}

async function ask(query, criteria, fetchImpl) {
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${keyOf()}`, "content-type": "application/json" },
    body: JSON.stringify({
      state: `An AI agent searched a catalog of paid API tools for: "${String(query).slice(0, 400)}"`,
      model: MODEL,
      questions: { best: { type: "choice", instructions: "Which listed tool actually performs the job the agent asked for?", criteria } },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`typesafe HTTP ${res.status}`);
  const a = (await res.json())?.answers?.best;
  const choice = typeof a?.choice === "string" ? a.choice : null;
  const confidence = typeof a?.confidence === "number" ? a.confidence : null;
  if (!choice || confidence == null) throw new Error("unusable answer shape");
  return { choice, confidence };
}

/**
 * One row's verdict. Pure, so the banding is testable without a network.
 *
 * `topSlug` is what find ranks first today. The four outcomes are the whole
 * point of the exercise and each one implies a different action by a human.
 */
export function classify({ choice, confidence }, topSlug) {
  if (choice == null || confidence == null) return null;
  if (confidence < CONSIDER) return { kind: "unclear", confidence, note: "below the consider band; find's order stands" };
  const act = confidence >= ACT;
  if (choice === NO_MATCH) {
    return act
      ? { kind: "catalog-gap", confidence, note: "no catalog tool does this. Real demand; this is the build list." }
      : { kind: "unclear", confidence, note: "leans no-match but not confidently" };
  }
  if (choice === topSlug) {
    return { kind: "confirmed", confidence, slug: choice, note: "find's top result does the job; the wish is a gap only if the tool failed the caller" };
  }
  return act
    ? { kind: "index-miss", confidence, slug: choice, note: `we sell this: ${choice}. find ranked it below ${topSlug}. Alias candidate, not a build.` }
    : { kind: "consider", confidence, slug: choice, note: `${choice} may fit better than ${topSlug}; not confident enough to act` };
}

/**
 * Re-rank recorded misses. `rows` are wish-board clusters ({ text, ... }).
 * `resolve(query)` returns find's results for that query - injected so this
 * module never imports the catalog and stays testable offline.
 *
 * Annotates in place and returns a summary. Fails OPEN per row: an unreadable
 * answer, a refused key or a timeout leaves the row exactly as it arrived.
 */
export async function rerankMisses(rows, resolve, { fetchImpl = fetch, max = MAX_ROWS, candidates = CANDIDATES, now = Date.now() } = {}) {
  const summary = { considered: 0, judged: 0, cached: 0, skipped: 0, skippedAdverts: 0, skippedInjection: 0, failed: 0, byKind: {} };
  if (!rerankEnabled() || !Array.isArray(rows) || !rows.length) return summary;

  for (const row of rows) {
    const query = String(row?.text || "").trim();
    if (!query) continue;
    summary.considered++;

    // A SELLER ADVERTISING IS NOT DEMAND, so it must never reach a build list.
    // Found on the first live run: "buy my heat pulse $0.10 usdc base
    // https://..." came back catalog-gap at 0.86, which is correct in the narrow
    // sense - no catalog tool sells that person's endpoint - and exactly wrong
    // as a conclusion. The intent pass already identifies these; when it has
    // run, honour it. Skipping also means we do not pay to judge a row we have
    // already decided is spam.
    if (row?.intent?.kind === "advertisement") { summary.skippedAdverts++; continue; }

    // Text written to steer the judgment is marked, never sent. Same screen the
    // crawler already runs on seller listings.
    if (looksLikeListingInjection(query)) {
      row.rerank = { kind: "unscreened", confidence: null, note: "text matches the listing-injection screen; not sent to a model" };
      summary.skippedInjection++;
      continue;
    }

    const hit = cache.get(query);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      summary.cached++;
      if (hit.result) { row.rerank = hit.result; summary.byKind[hit.result.kind] = (summary.byKind[hit.result.kind] || 0) + 1; }
      continue;
    }
    if (summary.judged >= max) { summary.skipped++; continue; }

    let results = [];
    try { results = (resolve(query, candidates) || []).slice(0, candidates); } catch { results = []; }
    // Nothing to choose between. Not a gap either: find surfaced nothing, which
    // is a different statement from "the catalog does not cover this".
    if (!results.length) { summary.skipped++; continue; }

    summary.judged++;
    try {
      const answer = await ask(query, buildCriteria(results), fetchImpl);
      const verdict = classify(answer, results[0].slug);
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(query, { at: now, result: verdict });
      if (verdict) { row.rerank = verdict; summary.byKind[verdict.kind] = (summary.byKind[verdict.kind] || 0) + 1; }
    } catch (e) {
      summary.failed++;
      cache.set(query, { at: now, result: null }); // one failure per query per window, not per row
      logSafe("warn", `[discovery-rerank] ${String(e?.message || e).slice(0, 90)}`);
    }
  }
  return summary;
}

export function __resetCache() { cache.clear(); }
