// ONE vocabulary for "this list is not the whole list".
//
// The defect this closes, three times over: a public response that is capped,
// sliced, sampled or filtered, shaped so a consumer can reasonably read it as
// complete. The data was right every time; the CONTRACT was quiet.
//
//   * GET /api/index returned 250 sellers of 4,473. A seller's checker fetched
//     the default page, searched it, did not find them and reported them
//     "missing from the index". They were on page 15 of 18.
//   * GET /api/index?seller=<host> cut the tool list at 500 with no flag, on
//     the one surface we tell a seller to use to audit what we hold for them.
//     toolCount beside it was correct, which is what made the silence
//     convincing.
//   * Retired routes answered a generic 404 and an outside census graded us a
//     broken seller, until they became 410 Gone naming the replacement.
//
// Each was fixed where it was found. This module exists because fixing the
// instance is what let the second and third happen: the sweep of 2026-09-22
// found the same shape on /api/find, /api/route's `sellers`, both
// leaderboards, /api/stats and the MCP catalog tools, and three separate
// half-vocabularies (`topMax`/`truncated`, `topRequested`/`truncatedReason`,
// `truncatedList`) that a consumer had to learn one at a time.
//
// THE RULE: a list answer states, in fields a machine reads, how many rows it
// HOLDS and how many MATCHED. Prose in a `note` does not count - that is what
// failed twice. Surfaces keep their existing per-surface names (renaming a
// live field is a second, worse break); these four ride alongside so one
// vocabulary reads every list on the service.

/**
 * The four fields that mean the same thing on every list we serve.
 *
 * @param {number} matched  rows that met the caller's filter, BEFORE any cap.
 *                          Not the corpus size - "how many answers exist for
 *                          what you asked", which is the number a consumer
 *                          concluding "there are none" needs.
 * @param {number} returned rows in THIS answer.
 * @returns {{returned:number, matched:number, complete:boolean, truncated:boolean}}
 */
export function partialFields(matched, returned) {
  const m = Math.max(Number(matched) || 0, 0);
  const r = Math.max(Number(returned) || 0, 0);
  // `complete` is a property of THIS ANSWER, not of the collection: an
  // out-of-range page holding zero rows of a non-empty result set is not
  // complete, which is the same lie in miniature (the /api/index paging fix
  // learned this one the hard way - see pagingEnvelope).
  const complete = r >= m;
  return { returned: r, matched: m, complete, truncated: !complete };
}

/**
 * The caller asked for more rows than this endpoint will ever give.
 *
 * Silently clamping is its own version of the defect: `?k=100` answering 25
 * rows with nothing said reads as "there are only 25", and the caller has no
 * way to tell that from "you may not have 100". Returns {} when nothing was
 * clamped, so the field only ever appears when it is true.
 *
 * @param {*} requested  the raw caller-supplied value (unparsed is fine).
 * @param {number} ceiling the hard maximum.
 * @param {string} param  the query parameter's name, so the message is actionable.
 */
export function clampFields(requested, ceiling, param = "limit") {
  const want = parseInt(requested, 10);
  if (!Number.isFinite(want) || want <= ceiling) return {};
  return {
    requestedExceededMax: true,
    requestedMax: want,
    maxNote: `?${param}=${want} was clamped to ${ceiling}, this endpoint's maximum.`,
  };
}

/**
 * A cap applied to the SCAN rather than to the answer - the shape where rows
 * are missing because we never looked, not because we cut the list.
 *
 * It needs its own field because `complete: true` would otherwise be honest
 * about the page and wrong about the world: the Solana board ranks the payTos
 * it scanned, and a seller beyond the scan cap reads as having no settlement
 * evidence rather than as unscanned. Absence of evidence, published as
 * evidence of absence, is the worst version of this class.
 *
 * @param {number} known   candidates that existed to be scanned.
 * @param {number} scanned candidates actually read this cycle.
 * @param {number} cap     the per-cycle ceiling.
 * @param {string} what    plural noun for the message.
 */
export function scanCoverage(known, scanned, cap, what = "candidates") {
  const k = Math.max(Number(known) || 0, 0);
  const s = Math.max(Number(scanned) || 0, 0);
  const coversAll = s >= k;
  return {
    scanned: s,
    scanCandidates: k,
    scanCap: cap,
    scanCoversAll: coversAll,
    ...(coversAll ? {} : {
      scanNote: `${s} of ${k} ${what} were read this cycle (cap ${cap}). A row absent here may be unscanned rather than inactive - absence is not evidence of absence.`,
    }),
  };
}
