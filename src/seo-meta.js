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

export function metaDescription(text, max = META_DESCRIPTION_MAX) {
  const s = clean(text);
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  // Last sentence end that fits (". " / "! " / "? " or a terminal ". ").
  let cut = -1;
  for (const m of head.matchAll(/[.!?](?=\s)/g)) cut = m.index + 1;
  if (cut >= Math.floor(max * 0.4)) return head.slice(0, cut).trim();
  // Else the last word boundary, dropping a dangling comma/colon/dash.
  const ws = head.lastIndexOf(" ");
  return (ws > 0 ? head.slice(0, ws) : head.slice(0, max)).replace(/[\s,;:\-·]+$/g, "").trim();
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

export function metaTitle(text, max = META_TITLE_MAX) {
  const s = clean(text);
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  let cut = -1;
  for (const sep of [" - ", ": ", " | ", " · "]) {
    const i = head.lastIndexOf(sep);
    if (i > cut) cut = i;
  }
  if (cut >= Math.floor(max * 0.4)) return head.slice(0, cut).trim();
  const ws = head.lastIndexOf(" ");
  return (ws > 0 ? head.slice(0, ws) : head.slice(0, max)).replace(/[\s,;:\-·]+$/g, "").trim();
}

/** For the few pages that hand-write their own <head> instead of using a
 *  shell: apply the same trims to a finished HTML string. Touches only the
 *  <title> and the description metas; everything else is byte-identical. */
export function applyMetaTrims(html) {
  return String(html)
    .replace(/<title>([\s\S]*?)<\/title>/i, (m, t) => `<title>${metaTitle(t)}</title>`)
    .replace(/(<meta (?:name="description"|property="og:description"|name="twitter:description") content=")([^"]*)(")/gi,
      (m, a, d, b) => `${a}${metaDescription(d.replace(/&quot;/g, '"')).replace(/"/g, "&quot;")}${b}`)
    .replace(/(<meta (?:property="og:title"|name="twitter:title") content=")([^"]*)(")/gi,
      (m, a, t, b) => `${a}${metaTitle(t.replace(/&quot;/g, '"')).replace(/"/g, "&quot;")}${b}`);
}
