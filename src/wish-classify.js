// What a wish IS, judged rather than pattern-matched.
//
// WHY THIS IS NOT A CLUSTER MERGER. The obvious use of a judgment model on the
// wish board is to merge semantically equal clusters, and it is the wrong one.
// Measured on the live board (400 rows, 2026-09-21): 227 clusters hold 2,636 of
// the 2,962 hits, every one of them has ZERO distinct callers, and all but 18
// were first seen before 2026-08-27 - the day per-caller fingerprinting shipped.
// That mass is one or more machines looping in August, which is exactly what
// QUALIFY_MIN_CALLERS exists to keep off the board. Merging it would gather 93
// hits of "mcp server risk" into one confident-looking row and promote a bot's
// single-day sweep to the board's top signal. The board manufactured its own
// demand once already; a smarter clusterer would do it again, faster.
//
// The judgment that IS useful is a different one. 57 of those 400 rows are
// sellers advertising their own endpoints - prices, payTo addresses, live URLs -
// filed through the same door as real requests. They are not demand, no lexical
// rule separates them (plenty of genuine wishes cite a URL too), and they sit at
// the top of the operator's view. Asking "is this asking for a capability, or
// offering one?" is one narrow judgment over text we already hold.
//
// WHERE IT RUNS. Operator surface only, never the write path. Recording a wish
// stays deterministic, free and synchronous: a paid third-party call on every
// find-miss would put an unmetered upstream on a free route, which is the one
// thing this codebase does not do. This reads the board that already exists.
//
// It changes NO counts and NO qualification. `clusterQualifies` is untouched, so
// a misjudgment cannot promote, demote or hide a cluster - it annotates a row
// the operator reads. That is deliberate: the model is new here and unproven on
// this data, and the docs are explicit that typed output guarantees the
// interface, not the truth.
import { logSafe } from "./log-safe.js";
import { looksLikeListingInjection } from "./x402-index.js";

const ENDPOINT = (process.env.TYPESAFE_API_URL || "https://api.typesafe.ai/v1/systemone").trim();
const MODEL = (process.env.TYPESAFE_MODEL || "jev-latest").trim();
const keyOf = () => (process.env.TYPESAFE_API_KEY || "").trim();

/** Unset key = the whole feature is absent, exactly like every other metered
 *  upstream in this tree. Nothing 503s and no row changes shape. */
export const wishClassifyEnabled = () => !!keyOf();

// Bounds, because this spends money per row and runs against a board that grows.
const MAX_ROWS = Number(process.env.TYPESAFE_MAX_ROWS || 60);
const CACHE_TTL_MS = Number(process.env.TYPESAFE_CACHE_TTL_MS || 12 * 3_600_000);
const CACHE_MAX = 2_000;
const TIMEOUT_MS = 8_000;
// Below this the answer is not acted on by any caller; recorded, never asserted.
// MEASURED on 16 hand-labelled live board rows, 2026-09-21: eight adverts
// scored 0.84 to 0.95, eight plain wishes scored 0.03 to 0.53. 0.75 sits in the
// empty band between them with room on both sides. Re-measure before moving it,
// and note that instruction wording moved one row from 0.44 to 0.87, so a
// reworded question invalidates this calibration.
export const CONFIDENT = Number(process.env.TYPESAFE_MIN_PROBABILITY || 0.75);

const cache = new Map(); // text -> { at, verdict }

/** One narrow judgment per question, and both directions asked separately.
 *  A wish can be neither (a bug report), so "not an advert" does not imply
 *  "is a request" and the two are not derived from each other. */
function questionsFor() {
  return {
    advertises: {
      type: "noul",
      instructions:
        "The text was submitted to a board where AI agents record capabilities they "
        + "looked for and could not find. Is this text ADVERTISING or promoting a service "
        + "the author already operates, rather than asking for one? Signs of advertising "
        + "include quoting a price the author is charging, naming a payment address they "
        + "receive at, or linking an endpoint they are inviting others to call.",
    },
  };
}

async function judge(text, fetchImpl = fetch) {
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${keyOf()}`, "content-type": "application/json" },
    body: JSON.stringify({ state: String(text).slice(0, 1_000), model: MODEL, questions: questionsFor() }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`typesafe HTTP ${res.status}`);
  const body = await res.json();
  // The wire puts a noul probability under a key NAMED FOR THE TYPE:
  //   {"answers":{"advertises":{"type":"noul","noul":0.44}}}
  // The first cut of this guessed `probability`/`value`, which parses to null
  // on every real answer - so every row would have come back unannotated while
  // all 27 stubbed assertions passed, because the fixture encoded the same
  // guess. Read from the live wire, keep the other spellings as a belt, and
  // never accept a non-number.
  const p = (id) => {
    const ans = body?.answers?.[id];
    const v = ans?.noul ?? ans?.probability ?? ans?.value ?? ans;
    return typeof v === "number" && v >= 0 && v <= 1 ? v : null;
  };
  return { advertises: p("advertises") };
}

/** A verdict the operator board can render. Never a number the reader has to
 *  interpret: the probability rides along, but the WORD is what is shown, and
 *  an unconfident judgment says so rather than rounding to a side. */
export function verdictOf({ advertises }) {
  if (advertises == null) return null;
  if (advertises >= CONFIDENT) return { kind: "advertisement", p: advertises };
  // Deliberately NOT "request". Not-advertising is all this judgment supports,
  // and calling it a request would assert something never measured.
  if (advertises <= 1 - CONFIDENT) return { kind: "not-advertising", p: 1 - advertises };
  return { kind: "unclear", p: advertises };
}

/**
 * Annotate rows in place with `intent`. Returns the rows.
 *
 * Fails OPEN and silently per row: an unreadable answer, a refused key or a
 * timeout leaves the row exactly as it arrived. The board is a working surface,
 * and it degrading to its own unannotated self is the correct outcome when a
 * third party is down.
 */
export async function classifyWishes(rows, { fetchImpl = fetch, max = MAX_ROWS, now = Date.now() } = {}) {
  if (!wishClassifyEnabled() || !Array.isArray(rows) || !rows.length) return rows;
  let spent = 0;
  for (const row of rows) {
    const text = String(row?.text || "");
    if (!text) continue;
    // See the note in discovery-rerank: attacker-controlled text is screened
    // with the crawler's own detector before we pay to judge it.
    if (looksLikeListingInjection(text)) { row.intent = { kind: "unscreened", p: null }; continue; }
    const hit = cache.get(text);
    if (hit && now - hit.at < CACHE_TTL_MS) { if (hit.verdict) row.intent = hit.verdict; continue; }
    if (spent >= max) continue;              // bound the spend, leave the rest bare
    spent++;
    try {
      const verdict = verdictOf(await judge(text, fetchImpl));
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(text, { at: now, verdict });
      if (verdict) row.intent = verdict;
    } catch (e) {
      logSafe("warn", `[wish-classify] ${String(e?.message || e).slice(0, 90)}`);
      cache.set(text, { at: now, verdict: null }); // do not retry a failing row all tick
    }
  }
  return rows;
}

export function __resetCache() { cache.clear(); }
