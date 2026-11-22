// Resale terms of a tool's data source, as the referral copies (/ref, src/referral-gate.js)
// read them. A copy under /ref is sold through a third party's marketplace, so a tool
// that passes a source's data through as it came is left out at boot when that
// source's terms bar resale or syndication through a third party.
//
// A tool declares it beside its handler, slug by slug, in its own kit:
//   resale: "barred"    its answer is the source's data as it came, and the
//                       source's terms bar resale through a third party;
//                       `resaleReason` says why, in a few words, and the boot
//                       refusal quotes it.
//   resale: "computed"  it reads such a source and its answer is computed here
//                       (a screen, a ranking, a deviation, a brief), so it is not
//                       a pass-through.
// Every tool that serves the market-data source (attribution "coingecko",
// src/data-attribution.js) declares one of the two (scripts/test-referral-gate.js),
// so a new tool on that source cannot reach /ref undecided.
//
// Dependency-free: the tool kits and the referral gate import it.

export const RESALE_BARRED = "barred";
export const RESALE_COMPUTED = "computed";

/** The market-data source's terms (cited in src/tools/coingecko-rate.js) bar
 *  resale or syndication of its data through a third party. */
export const MARKET_DATA_RESALE_REASON = "raw pass-through of a data source whose terms bar resale or syndication through a third party";
/** The holiday source's terms (cited in src/tools/holiday-source.js) forbid
 *  operating a holiday portal or republishing its dataset. */
export const HOLIDAY_PORTAL_RESALE_REASON = "a whole-year holiday list from a source whose terms bar a holiday portal";

function mark(tools, slugs, fields) {
  const bySlug = new Map((tools || []).map((t) => [t?.slug, t]));
  for (const slug of slugs) {
    const tool = bySlug.get(slug);
    if (!tool) throw new Error(`resale terms: no tool "${slug}" in this kit`);
    Object.assign(tool, fields);
  }
  return tools;
}

/** Mark `slugs` of `tools` as raw pass-throughs of a source that bars resale, with the reason. */
export function markResaleBarred(tools, slugs, reason) {
  const why = String(reason || "").trim();
  if (!why) throw new Error("resale terms: a barred tool needs a reason");
  return mark(tools, slugs, { resale: RESALE_BARRED, resaleReason: why });
}

/** Mark `slugs` of `tools` as computing their answer from such a source. */
export function markResaleComputed(tools, slugs) {
  return mark(tools, slugs, { resale: RESALE_COMPUTED });
}

/** The reason a definition may not be resold through a third party, or null. */
export function resaleBarredReason(def) {
  if (!def || typeof def !== "object" || def.resale !== RESALE_BARRED) return null;
  const why = typeof def.resaleReason === "string" && def.resaleReason.trim() ? def.resaleReason.trim() : "its data source's terms bar resale through a third party";
  return why.slice(0, 200);
}

/** Declare, beside a tool's handler, what its answer becomes on a /ref copy:
 *  `transform(answer)` returns the answer the referral gate serves (a new
 *  value; it never changes the one it is given). The public route serves the
 *  handler's own answer, untouched. */
export function markRefAnswer(tools, slugs, transform) {
  if (typeof transform !== "function") throw new Error("resale terms: a /ref answer transform must be a function");
  return mark(tools, slugs, { refAnswer: transform });
}

/** The answer a /ref copy serves for `def`: its declared transform applied
 *  (src/referral-gate.js is the one caller), or the answer as it came. */
export function refAnswerOf(def, answer) {
  return def && typeof def.refAnswer === "function" ? def.refAnswer(answer) : answer;
}
