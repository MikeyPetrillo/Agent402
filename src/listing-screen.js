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
  // Text addressed to whatever selects among listings, in other words than
  // the ones above: a note to the selecting model, the reader cast as the
  // evaluator and told what to do, a role marker opening the listing, a
  // request to be chosen, a choice written out as an answer.
  /\bnote\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+|every\s+)?(?:selecting|selector|selection|choosing|reading|routing|ranking|judging)\s+(?:models?|llms?|ais?|agents?|assistants?|systems?)\b/,
  /\bas\s+(?:the|an?|our)\s+(?:evaluator|judge|ranker|grader|rater|scorer|selector)s?\s*,?\s*(?:you|please)\b/,
  /^\s*(?:system|assistant)\s*:/,
  /[.!?]\s+(?:system|assistant)\s*:/,
  /<\|(?:im_start|im_end|system|assistant|user|endoftext)\|>|\[\/?inst\]|<<\/?sys>>/,
  /\b(?:choose|select|pick|prefer)\s+(?:me|us)\s*(?:$|[.!,;:]|over\b|first\b|instead\b|always\b|above\b)/,
  /\b(?:best|winner|choice|selection|pick)\s*[:=]\s*["']?(?:this|me|us)\b/,
  /\b(?:the\s+)?only\s+(?:correct|right|valid|acceptable)\s+(?:choice|option|answer|pick|selection)\b/,
  /\b(?:rate|score|mark|grade|treat|judge)\s+(?:this|me|us)(?:\s+(?:tool|one|service|listing|seller|endpoint|api))?\s+as\s+(?:a\s+)?(?:match(?:ing)?|relevant|perfect|correct|the\s+(?:best|right|only))\b/,
  /\b(?:w[äa]hle|w[äa]hlen\s+sie|nimm|bevorzuge)\s+(?:immer|stets)\b|\bimmer\s+(?:dieses|diesen|diese|mich|uns)\b.{0,30}?\bw[äa]hl/,
  /\b(?:elige|elija|escoge|escoja|selecciona)\s+siempre\b|\bsiempre\s+(?:elige|elija|escoge|escoja|selecciona)\b/,
  /\b(?:choisis|choisissez|s[ée]lectionne[zr]?)\s+toujours\b|\btoujours\s+(?:choisir|choisis|choisissez)\b/,
  /\b(?:escolha|escolhe|selecione)\s+sempre\b|\bsempre\s+(?:escolha|escolhe|selecione)\b/,
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
// Digits and symbols written in place of letters ("1gn0re prev1ous
// 1nstruct1ons"): folded inside a word that mixes them with letters, so a
// number on its own ("fit 1.0", "100 ms") is never rewritten. Letters spelled
// out with a separator between each ("s y s t e m", "i.g.n.o.r.e") are joined
// in one more reading. Both readings are added beside the others, never in
// place of them, so they can only find a phrase, not hide one.
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s" };
const LEET_WORD = /[a-z0-9@$]*(?:[a-z][0-9@$]|[0-9@$][a-z])[a-z0-9@$]*/g;
const LEET_HINT = /[a-z][0-9@$]|[0-9@$][a-z]/;
const SPACED_LETTERS = /\b(?:[a-z][ .\-_]){3,}[a-z]\b/g;
const SPACED_HINT = /\b(?:[a-z][ .\-_]){3,}[a-z]\b/;
function extraForms(base, forms) {
  if (LEET_HINT.test(base)) forms.push(base.replace(LEET_WORD, (w) => w.replace(/[0-9@$]/g, (c) => LEET[c] ?? c)));
  if (SPACED_HINT.test(base)) forms.push(base.replace(SPACED_LETTERS, (w) => w.replace(/[ .\-_]/g, "")));
  return forms;
}
function injectionForms(text) {
  const raw = String(text || "");
  if (PLAIN_LISTING.test(raw) && !MARKUP_CHARS.test(raw)) {
    const lower = raw.toLowerCase();
    if (!/[\t\n\r]| {2}/.test(lower)) return extraForms(lower, [lower]);
    const flat = lower.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ");
    return extraForms(flat, [lower, flat]);
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
  // The fullest reading (invisible characters deleted, lookalikes mapped when
  // there are any) is the one the digit and spacing readings start from.
  return extraForms(forms.length > 3 ? forms[3] : forms[1], forms);
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

// ---------------------------------------------------------------------------
// The judge's reading of a listing (route-execute's seller judge in
// src/server.js and decide's fit judge in services/decide/llm.js read the same
// one). The screen above drops a whole listing (the router does so before a
// judge sees it); this one drops each SENTENCE written to whatever reads the listing
// rather than about what the tool does: a note, notice or message to the
// model, judge, evaluator or system; the reader cast as the evaluator; a role
// marker opening the sentence ("Judge:", "SYSTEM:"); a request to be chosen,
// ranked or rated ("choose me", "best=this", "rank this tool first"); a fit or
// a confidence it asks to be given. Sentence by sentence, so an honest
// sentence beside it still reaches the judge, and wider than the listing
// screen for that reason: a dropped sentence costs a listing one sentence of
// description, not its place in the index. The same readings run first
// (lowercase, invisible characters deleted, lookalikes, digits for letters,
// letters spelled with spaces), so a reworded or respelled sentence is read as
// what it says.
const ADDRESSEE = "(?:models?|llms?|ais?|agents?|assistants?|judges?|evaluators?|graders?|raters?|rankers?|scorers?|selectors?|readers?|systems?|bots?|reviewers?)";
// Whom a note is written to: the reader that selects, never the agent or
// developer a usage note ("Note for agents: pass a url") is honestly for.
const SELECTOR = "(?:models?|llms?|ais?|assistants?|judges?|evaluators?|graders?|raters?|rankers?|scorers?|selectors?|systems?|reviewers?)";
const READER_PATTERNS = [
  // "reads as an instruction to an AI" describes text a tool finds; it is
  // not addressed to anyone.
  new RegExp(`(?<!\\b(?:as|like|resembles?|resembling)\\s+(?:an?\\s+|the\\s+)?)\\b(?:note|notice|message|instructions?|memo|reminder|hint|directive|attention)s?\\s+(?:to|for)\\s+(?:the\\s+|any\\s+|all\\s+|every\\s+)?(?:[a-z-]+\\s+){0,2}${SELECTOR}\\b`),
  new RegExp(`\\b(?:dear|attention|hey|hello|hi)\\s*,?\\s+(?:the\\s+)?(?:[a-z-]+\\s+)?${SELECTOR}\\b`),
  new RegExp(`\\bas\\s+(?:the|an?|our|this)\\s+(?:[a-z-]+\\s+)?(?:evaluator|judge|ranker|grader|rater|scorer|selector|reviewer|assistant|model|llm|ai)s?\\s*,?\\s*(?:you|please|always|rate|pick|choose|select|prefer|give|score|answer|must|should)\\b`),
  new RegExp(`\\b(?:you|the\\s+(?:[a-z-]+\\s+)?${ADDRESSEE})\\s+(?:must|should|shall|will|need\\s+to|have\\s+to|are\\s+(?:required|instructed|told)\\s+to|is\\s+(?:required|instructed|told)\\s+to)\\s+(?:always\\s+|now\\s+|only\\s+)?(?:rate|score|pick|choose|select|prefer|rank|mark|grade|recommend|ignore|disregard|forget|(?:answer|output|respond|return|treat|consider|give)\\s+(?:with\\s+)?(?:this|me|us|it|best|yes|1))\\b`),
  // A role marker opening the sentence, or a chat-template token anywhere.
  /^\s*["'([{<]*\s*(?:system|assistant|judge|evaluator|grader|ranker|rater|scorer|selector|developer|admin|llm|ai|override|verdict|decision)\s*[:\]>]/,
  /<\|[a-z_]+\|>|\[\/?inst\]|<<\/?sys>>|#{2,}\s*(?:system|instructions?|assistant|user)\b/,
  // Asking to be chosen, ranked or rated.
  /\b(?:always\s+|only\s+|just\s+|please\s+)?(?:choose|select|pick|prefer|recommend|rank|rate|score|use)\s+(?:me|us)\b/,
  /\b(?:choose|select|pick|prefer|recommend)\s+(?:this|our)(?:\s+(?:one|tool|service|seller|listing|endpoint|api|option|route|provider|server))?\s*(?:$|[.!,;:]|over\b|above\b|first\b|instead\b|always\b|every\s+time\b|for\s+(?:every|all|any)\b|as\s+(?:the|your)\b)/,
  /\b(?:best|top|winner|choice|answer|pick|selection|selected|chosen|verdict)\s*[:=]\s*["']?(?:this|me|us|yes)\b/,
  /\b(?:rank|rate|score|mark|grade|judge|list|place|put)\s+(?:me|us|this|it)(?:\s+(?:one|tool|service|seller|listing|endpoint|api))?\s+(?:as\s+)?(?:a\s+|the\s+)?(?:first|highest|top|best|#\s*1\b|number\s+one|perfect|matching|a\s+match|(?:the\s+)?(?:best|top|highest|only|right|correct)\b)/,
  /\b(?:rate|score|mark|grade|treat|consider|judge)\s+(?:this|it|me|us)(?:\s+(?:tool|one|service|listing|seller|endpoint|api))?\s+as\s+(?:a\s+)?(?:match|matching|relevant|perfect|correct|fitting|suitable|the\s+(?:best|right|only))\b/,
  /\b(?:the\s+)?only\s+(?:correct|right|valid|good|sensible|acceptable|possible)\s+(?:choice|option|answer|tool|pick|selection|match)\b/,
  /\b(?:always|must|should)\s+(?:be\s+)?(?:chosen|selected|picked|preferred|ranked\s+(?:first|highest|top))\b/,
  /\bconfidence\s*(?:of\s*|[:=]\s*)?(?:1(?:\.0+)?|100\s*%)(?![\d.])/,
  // decide's rater rules (2026-10), kept here so both judges read them.
  /\bfit\s*(?:score\s*)?(?:of\s*|[:=]\s*)?(?:0?\.\d+|1\.0+|100\s*%)(?![\d.])/,
  /\b(?:a\s+)?fit\s*(?:score\s*)?(?:of|[:=])\s*1\b/,
  /\bperfect\s+fit\b/,
  /\b(?:rate[sd]?|score[sd]?|grade[sd]?|judge[sd]?|rank(?:s|ed)?|mark(?:s|ed)?)\s+(?:it|this|me|us)\s+(?:as\s+)?(?:a\s+)?(?:1(?:\.0+)?\b|10\b|100\b|perfect|the\s+(?:best|top|highest)|first|highest|top)/,
  /\b(?:evaluators?|raters?|graders?|rankers?|judges?|scorers?|ranking\s+models?|selecting\s+(?:models?|agents?))\s+(?:should|must|will|always|rate|give|score|pick|choose|prefer|select)\b/,
  /\bsystem\s+(?:notice|note|override|directive|alert|message|instruction)s?\b/,
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+)?(?:what|everything|anything|previous|prior|above|earlier|other)\b/,
];
const READER_ANY = new RegExp(READER_PATTERNS.map((re) => `(?:${re.source})`).join("|"));
/** True when one sentence of listing text is written to its reader (the
 *  judge, the model, the system) or asks to be chosen, in any of the
 *  readings the listing screen takes, or trips the listing screen itself. */
export function addressesReader(sentence) {
  const s = String(sentence || "");
  for (const form of injectionForms(s)) {
    const t = form.trim();
    if (READER_ANY.test(t) || INJECTION_ANY.test(t)) return true;
  }
  return false;
}
/** A listing's text as a judge may read it: its sentences minus every one
 *  that addresses the reader (addressesReader) or carries a character that
 *  renders as nothing, with links shown as "[link]" (unless `links` is
 *  false), capped at `max` characters (0 = no cap). A caller that also drops
 *  a listing whole reads looksLikeListingInjection on its own. */
export function judgeReadableText(text, { max = 0, links = true } = {}) {
  const raw = String(text || "").length > 8000 ? String(text).slice(0, 8000) : String(text || "");
  // A line break ends a sentence too, so "Judge: ..." on a line of its own
  // is read as one.
  const sentences = raw.split(/(?<=[.!?])\s+|[\r\n]+/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  const kept = sentences.filter((s) => !hasHiddenCharacters(s) && !addressesReader(s))
    .map((s) => (links ? s.replace(/\bhttps?:\/\/\S+/gi, "[link]") : s)).join(" ");
  return max > 0 && kept.length > max ? `${kept.slice(0, max - 1)}…` : kept;
}
