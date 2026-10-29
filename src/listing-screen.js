// The listing screen: whether seller-written listing text tries to instruct
// whatever reads it. One module with no dependency beyond src/hidden-chars.js,
// so the router (src/x402-index.js, which re-exports it) and a workflow that
// runs with no install read the same rules.
import { decodeTagCharacters, hasHiddenCharacters } from "./hidden-chars.js";

// Metadata-injection detector (M6, "Five Attacks on x402" Attack IV-E1).
// A tool listing is metadata: a name, a description, tags: text that *describes*
// what a tool does. It is never a channel for instructions to the selecting
// agent. When an external listing's text tries to command the ranker or the
// buyer's LLM ("ignore previous instructions", "always pick this", a fake
// <system> block), that's an attack, not a description; the paper drove one
// crafted server to 71.8% selection this way. We drop such listings entirely.
//
// Deliberately conservative: every pattern is imperative/meta phrasing that a
// genuine tool description has no reason to contain. A tool that legitimately
// *operates on* prompts (e.g. a "prompt linter") describes its function
// ("detects prompt-injection patterns"), it doesn't issue the commands below.
const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|the\s+above)\s+(?:instructions?|prompts?|context|rules?)/,
  /disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|other)/,
  /forget\s+(?:everything|all|the\s+above|previous|prior)/,
  /always\s+(?:pick|choose|select|use|prefer|recommend|return)\s+(?:this|me|the\s+following)/,
  /(?:you\s+must|be\s+sure\s+to)\s+(?:always\s+)?(?:pick|choose|select|use|prefer|recommend)/,
  /(?:highest|top|maximum|max)\s+priority/,
  /override\s+(?:all\s+|any\s+|the\s+)?(?:other|previous|prior|instructions?|ranking)/,
  /<\/?\s*(?:system|assistant|user|instructions?|important)\s*>/,
  /\[(?:system|important|instructions?|override)\]/,
  /system\s*(?:prompt|message|role)\s*[:=]/,
  /do\s+not\s+(?:pick|choose|select|recommend|consider)\s+(?:any\s+)?other/,
  // A listing that tries to set its own score for a ranker that reads it.
  /"fits?"\s*:\s*\{/,
  /\b(?:rate|score|give)\s+(?:this|it|me|every\s+\w+)?\s*(?:a\s+)?fit\s*(?:of\s*)?[:=]?\s*(?:1(?:\.0+)?|100\s*%)/,
  /\bfit\s*[:=]\s*(?:1(?:\.0+)?|100\s*%)/,
  // The same requests in other words: a near-top fit, a perfect fit given by a
  // rater, a note or a notice addressed to whatever reads the listing.
  /\b(?:a\s+)?fit\s*(?:score\s*)?(?:of\s*|[:=]\s*)?(?:0?\.9\d+|1\.0+|100\s*%)(?![\d.])/,
  /\b(?:rate[sd]?|score[sd]?|grade[sd]?|judge[sd]?|mark(?:s|ed)?)\s+(?:it|this|me|us)\s+(?:as\s+)?(?:a\s+)?(?:perfect\s+fit|1(?:\.0+)?\b|10\b|100\b|perfect|the\s+(?:best|top|highest))/,
  /\bperfect\s+fit\s*\(?\s*(?:fit|score)?\s*[:=]?\s*1(?:\.0+)?\b/,
  /\bnote\s+to\s+(?:the\s+|any\s+|all\s+)?(?:ranking|ranker|judge|judging|model|llm|evaluator|grader|rater|scorer|selector)s?\b/,
  /\bsystem\s+(?:notice|note|override|directive|alert)\s*[:\]!-]/,
  /\bdisregard\s+(?:what|everything|anything|all)\b.{0,30}?\b(?:before|above|earlier|previously|prior)\b/,
  // The same instructions in the languages seen on the index.
  /ignora\s+(?:las?\s+|todas?\s+las?\s+)?(?:instrucciones|indicaciones)\s+(?:anteriores|previas)/,
  /ignor(?:e|ez)\s+(?:les\s+|toutes\s+les\s+)?(?:instructions|consignes)\s+(?:pr[eé]c[eé]dentes|ant[eé]rieures)/,
  /ignoriere\s+(?:alle\s+)?(?:vorherigen|bisherigen|obigen)\s+(?:anweisungen|instruktionen)/,
  /ignore\s+(?:as\s+|todas\s+as\s+)?instru[cç][oõ]es\s+anteriores/,
];
// Letters from other scripts that render like Latin ones ("Іgnоrе" spelled with
// Cyrillic І, о, е): one more reading of the text maps them back before the
// patterns run, so a lookalike spelling is read as the phrase it imitates.
const CONFUSABLES = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u04cf": "l", "\u0501": "d", "\u051b": "q", "\u051d": "w",
  "\u03b1": "a", "\u03bf": "o", "\u03c1": "p", "\u03b5": "e", "\u03b9": "i", "\u03ba": "k", "\u03bd": "v", "\u03c4": "t", "\u03c5": "u", "\u03c7": "x",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");
// The patterns are written lowercase; the text is brought to that form before
// matching, twice: as written (so a literal <system> tag is still seen) and
// with markup/entities/invisible characters turned to spaces (so
// "Ignore&lt;previous instructions" or a zero-width split cannot slip a phrase
// past the screen that a later cleaning step would reassemble). Text spelled
// in the TAG block (U+E0020..U+E007E, a copy of printable ASCII that renders
// as nothing) is read back as the ASCII it spells first, so the patterns see
// those words too (src/hidden-chars.js).
// Plain printable ASCII with no markup, entity or backtick characters: NFKC,
// entity decoding, invisible-character handling and the lookalike map are all
// identity on it, so the four forms below reduce to the lowercased text and its
// whitespace-collapsed copy. Nearly every listing is this, and the full path
// costs several times more per listing across an index of tens of thousands.
const PLAIN_LISTING = /^[\t\n\r\x20-\x7e]*$/;
const MARKUP_CHARS = /[&<>`*~|]/;
function injectionForms(text) {
  const raw = String(text || "");
  if (PLAIN_LISTING.test(raw) && !MARKUP_CHARS.test(raw)) {
    const lower = raw.toLowerCase();
    if (!/[\t\n\r]| {2}/.test(lower)) return [lower];
    return [lower, lower.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ")];
  }
  const decoded = decodeTagCharacters(raw).normalize("NFKC")
    .replace(/&(?:lt|gt|amp|quot|apos|nbsp|#\d{1,6}|#x[0-9a-f]{1,6});/gi, (m) => {
      const e = m.toLowerCase();
      return e === "&lt;" ? "<" : e === "&gt;" ? ">" : e === "&amp;" ? "&" : " ";
    })
    .toLowerCase();
  // Invisible characters are DELETED (a zero-width split inside a word must
  // rejoin it); markup punctuation becomes a space. Underscores are left as
  // they are: identifiers like max_priority_fee are honest listing text.
  // An invisible character may split a word (delete it) or two words (read it
  // as a space): both readings are checked.
  const INVIS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u00ad\u180e\ufe00-\ufe0f\ufff9-\ufffb]|[\u{e0100}-\u{e01ef}]/gu;
  const flatten = (x) => x.replace(/[\u0000-\u001f\u007f-\u009f<>`*~|]/g, " ").replace(/\s+/g, " ");
  const forms = [decoded.replace(INVIS, ""), flatten(decoded.replace(INVIS, "")), flatten(decoded.replace(INVIS, " "))];
  if (CONFUSABLE_RE.test(decoded)) { CONFUSABLE_RE.lastIndex = 0; forms.push(flatten(decoded.replace(INVIS, "").replace(CONFUSABLE_RE, (c) => CONFUSABLES[c]))); }
  CONFUSABLE_RE.lastIndex = 0;
  return forms;
}
// One alternation of every pattern: the same any-match answer as testing them
// in turn (none carries a flag or a lastIndex), in one pass over the text.
const INJECTION_ANY = new RegExp(INJECTION_PATTERNS.map((re) => `(?:${re.source})`).join("|"));
export function looksLikeListingInjection(text) {
  const t = String(text || "");
  if (t.length > 8000) return true; // no honest listing is a novel; oversized = padding an attack
  // A character that renders as nothing (TAG text, a zero-width or bidi
  // control, a run of variation selectors, a soft hyphen) is a carrier for
  // text the reader never sees: the listing is a finding whatever it spells.
  // Emoji joiners, keycaps and joining scripts are allowed (src/hidden-chars.js).
  if (hasHiddenCharacters(t)) return true;
  return matchesInjectionPhrase(t);
}
/** The phrase rules alone (no length or hidden-character rule), for a caller
 *  that screens one sentence and reports hidden characters on its own. */
export function matchesInjectionPhrase(text) {
  for (const form of injectionForms(String(text || ""))) if (INJECTION_ANY.test(form)) return true;
  return false;
}
/** Which rule of looksLikeListingInjection the text trips, by name, or null:
 *  the same three rules in the same order, so this is non-null exactly when
 *  that screen says true. */
export function listingInjectionFinding(text) {
  const t = String(text || "");
  if (t.length > 8000) return "oversized";
  if (hasHiddenCharacters(t)) return "hidden-characters";
  return matchesInjectionPhrase(t) ? "instruction-phrase" : null;
}
