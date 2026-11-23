// SEO meta trims, applied in ONE place (the page shells) so no page author has
// to count characters.
//
// Why (reader pass, 2026-09-08): 66 of 96 served pages carried a meta
// description past Google's cut (~155-165 chars; several past 300) and nine
// carried a title past 70, so what a search result actually showed was a
// sentence cut mid-clause. The copy in the page source is often a fine
// paragraph; the snippet is a different artifact and is derived here.
//
// Rules: a description is cut at the last sentence end that fits, else the
// last word boundary, never mid-word and never with an ellipsis (Google adds
// its own). A title is cut at the last separator (" - ", ": ", " | ", " · ")
// that fits, else a word boundary. Text already within the limit is returned
// byte-identical, so every page under the bar is untouched.

export const META_DESCRIPTION_MAX = 155;
export const META_TITLE_MAX = 70;

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Descriptions the shell could not cut at a sentence end since boot,
 *  source -> served. Like clampedTitles, a safety net and not an author: the
 *  operator surface lists them and scripts/test-title-clamp.js fails when any
 *  served page needs one. The fix is a description written to fit. */
export const cutDescriptions = new Map();
const CUT_DESCRIPTIONS_MAX = 500;
const TERMINAL = /[.!?]["'\u201d)]?$/;
// Words a clause cut must not end on ("..., and." reads as a cut).
const DANGLING = /(\s+(and|or|the|of|to|for|a|an|on|with|from|by|at|in|via|plus|its|their|each|every|that|which|as))+$/i;

/** The longest run of whole sentences from the start of `text` that fits
 *  `max`, or "" when the first sentence alone is longer. */
export function sentenceFit(text, max = META_DESCRIPTION_MAX) {
  const s = clean(text);
  if (s.length <= max && TERMINAL.test(s)) return s;
  const head = s.slice(0, max + 1);
  let cut = -1;
  for (const m of head.matchAll(/[.!?](?=\s)/g)) cut = m.index + 1;
  return cut > 0 ? head.slice(0, cut).trim() : "";
}

/** The first candidate that reads as whole sentences within `max` (each is
 *  passed through sentenceFit), else "". */
export function firstFit(candidates, max = META_DESCRIPTION_MAX) {
  for (const c of (Array.isArray(candidates) ? candidates : [candidates])) {
    const f = c ? sentenceFit(c, max) : "";
    if (f) return f;
  }
  return "";
}

export function metaDescription(text, max = META_DESCRIPTION_MAX) {
  const s = clean(text);
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  // Last sentence end that fits (". " / "! " / "? " or a terminal ". ").
  let cut = -1;
  for (const m of head.matchAll(/[.!?](?=\s)/g)) cut = m.index + 1;
  // A whole first sentence, however short, beats a cut one.
  if (cut >= Math.min(40, Math.floor(max * 0.4))) return head.slice(0, cut).trim();
  // No sentence end fits: the safety net. Cut at the last clause boundary
  // (", " "; " ": " " - " " (") that keeps a useful length, drop a dangling
  // joiner and close the sentence, so a result never ends on a cut word; the
  // source is recorded so the page gets a description written to fit.
  let clause = -1;
  for (const m of head.slice(0, max).matchAll(/(?:,|;|:| -| \()\s/g)) clause = m.index;
  const ws = head.lastIndexOf(" ");
  let out = clause >= Math.floor(max * 0.4) ? head.slice(0, clause) : (ws > 0 ? head.slice(0, ws) : head.slice(0, max - 1));
  out = out.replace(/[\s,;:\-·(]+$/g, "").replace(DANGLING, "").replace(/[\s,;:\-·(]+$/g, "").trim();
  if (!TERMINAL.test(out)) out = `${out.slice(0, max - 1)}.`;
  if (cutDescriptions.size < CUT_DESCRIPTIONS_MAX && !cutDescriptions.has(s)) cutDescriptions.set(s, out);
  return out;
}

/** Title for a search result: the first candidate that fits `max`, else the
 *  last one trimmed at a word boundary (dangling short words dropped). */
export const SERP_TITLE_MAX = 60;
export function fitTitle(candidates, max = SERP_TITLE_MAX) {
  const list = (Array.isArray(candidates) ? candidates : [candidates]).map(clean).filter(Boolean);
  const hit = list.find((c) => c.length <= max);
  if (hit) return hit;
  return trimWords(list[list.length - 1] || "", max);
}
export function trimWords(text, max) {
  const s = clean(text);
  if (s.length <= max) return s;
  let out = s.slice(0, max + 1);
  const ws = out.lastIndexOf(" ");
  out = ws > 0 ? out.slice(0, ws) : out.slice(0, max);
  return out.replace(/(\s+(in|the|of|and|to|for|a|an|on|with|or|from|by|at))+$/i, "").replace(/[\s,;:\-·]+$/g, "").trim();
}

/** Titles the clamp shortened since boot, source -> served. A clamp is a
 *  safety net, not an author: a title written past the bar reads cut
 *  mid-sentence in a search result, so the operator surface lists them and
 *  scripts/test-title-clamp.js fails when any served page needs one. */
export const clampedTitles = new Map();
const CLAMPED_TITLES_MAX = 500;

export function metaTitle(text, max = META_TITLE_MAX) {
  const s = clean(text);
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  let cut = -1;
  for (const sep of [" - ", ": ", " | ", " · "]) {
    const i = head.lastIndexOf(sep);
    if (i > cut) cut = i;
  }
  const ws = head.lastIndexOf(" ");
  const out = cut >= Math.floor(max * 0.4)
    ? head.slice(0, cut).trim()
    : (ws > 0 ? head.slice(0, ws) : head.slice(0, max)).replace(/[\s,;:\-·]+$/g, "").trim();
  if (clampedTitles.size < CLAMPED_TITLES_MAX && !clampedTitles.has(s)) clampedTitles.set(s, out);
  return out;
}
