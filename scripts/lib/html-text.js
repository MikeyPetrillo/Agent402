// Text extraction for tests that assert over rendered pages.
//
// Each strip repeats until the string stops changing, so markup that one pass
// would splice back together (`<scr<b></b>ipt>`) cannot survive it, and the
// script/style patterns match any letter case and a closing tag carrying
// whitespace or attributes (`</script >`). Entities decode `&amp;` last, so
// `&amp;lt;` reads as the literal `&lt;` the page shows, never as `<`.

/** Drop <script> and <style> elements with their contents. */
export function stripScripts(html, sep = " ") {
  let s = String(html ?? "");
  let prev;
  do {
    prev = s;
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, sep);
    s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, sep);
  } while (s !== prev);
  return s;
}

/** Drop every tag, keeping the text between them. */
export function stripTags(html, sep = " ") {
  let s = String(html ?? "");
  let prev;
  do {
    prev = s;
    s = s.replace(/<[^>]*>/g, sep);
  } while (s !== prev);
  return s;
}

/** Drop only the inline tags (code, a, b, i, em, strong, span), so the words
 *  they wrap stay joined to the text around them. */
export function stripInlineTags(html) {
  let s = String(html ?? "");
  let prev;
  do {
    prev = s;
    s = s.replace(/<\/?(?:code|a|b|i|em|strong|span)\b[^>]*>/gi, "");
  } while (s !== prev);
  return s;
}

/** Decode the entities the page renderers emit; `&amp;` goes last. */
export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#47;|&#x2f;/gi, "/")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** What a reader sees: no scripts or styles, no tags, entities decoded,
 *  whitespace collapsed. */
export function pageText(html) {
  return decodeEntities(stripTags(stripScripts(html))).replace(/\s+/g, " ");
}
