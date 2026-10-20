// Hidden characters: code points that render as nothing (or as a glyph change
// nobody notices) and so can carry text a reader never sees. One scan, shared
// by the listing-injection screen (src/x402-index.js) and the repo check on
// the instruction files (scripts/test-hidden-chars.js), so the two never
// disagree about what counts as hidden.
//
// Kinds:
//   tag                 U+E0000..U+E007F, the TAG block. U+E0020..U+E007E is a
//                       hidden copy of printable ASCII; decodeTagCharacters()
//                       turns it back into the text it spells.
//   zero-width          U+200B..U+200D, U+2060..U+2064, U+FEFF, U+180E,
//                       U+FFF9..U+FFFB
//   bidi                U+202A..U+202E, U+2066..U+2069 (embedding, override and
//                       isolate controls; they reorder the text that follows)
//   variation-selector  U+FE00..U+FE0F, U+E0100..U+E01EF (256 selectors, enough
//                       to carry one byte each after a single visible base)
//   soft-hyphen         U+00AD
//
// What is allowed, because real text needs it:
//   - a zero-width joiner between two pictographs (family, flag and profession
//     emoji), looking through a presentation selector, skin tone or keycap mark;
//   - U+200C / U+200D between letters of a script that joins with them
//     (Arabic, the Indic scripts, Khmer, Tibetan, Mongolian, Myanmar);
//   - one presentation selector (U+FE0E / U+FE0F) right after an emoji base,
//     keycap digits included; one other selector right after a Han, Mongolian,
//     Myanmar or math base (ideographic and math variation sequences);
//   - a TAG run spelling a subdivision flag: the waving black flag followed by
//     up to six tag letters or digits and the cancel tag.
// A second selector on the same base, a joiner next to a Latin letter, any
// bidi control and any other TAG character are hidden text.

const QUICK = /[­᠎​-‍⁠-⁤‪-‮⁦-⁩︀-️﻿￹-￻]|[\u{e0000}-\u{e007f}]|[\u{e0100}-\u{e01ef}]/u;

const PICTOGRAPH = /^[\p{Extended_Pictographic}♀♂⚕⚖✈❤⬛⬜]$/u;
const EMOJI_BASE = /^[\p{Emoji}\p{Extended_Pictographic}]$/u;
const VARIANT_BASE = /^[\p{Script=Han}\p{Script=Mongolian}\p{Script=Myanmar}\p{Sm}]$/u;
const JOINER_SCRIPT = /^[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Myanmar}\p{Script=Khmer}\p{Script=Tibetan}\p{Script=Mongolian}]$/u;
// Marks that sit between a pictograph and the joiner that follows it.
const EMOJI_TRAILER = /^[︎️⃣\u{1f3fb}-\u{1f3ff}]$/u;

const BLACK_FLAG = 0x1f3f4;
const TAG_LO = 0xe0000, TAG_HI = 0xe007f, TAG_CANCEL = 0xe007f;
const isTag = (cp) => cp >= TAG_LO && cp <= TAG_HI;
const isTagAlnum = (cp) => (cp >= 0xe0061 && cp <= 0xe007a) || (cp >= 0xe0030 && cp <= 0xe0039);
const isVS = (cp) => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
const isPresentationVS = (cp) => cp === 0xfe0e || cp === 0xfe0f;

export const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

function kindOf(cp) {
  if (isTag(cp)) return "tag";
  if (cp === 0xad) return "soft-hyphen";
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return "bidi";
  if (isVS(cp)) return "variation-selector";
  if ((cp >= 0x200b && cp <= 0x200d) || (cp >= 0x2060 && cp <= 0x2064) || cp === 0xfeff || cp === 0x180e || (cp >= 0xfff9 && cp <= 0xfffb)) return "zero-width";
  return null;
}

/** The TAG block spells printable ASCII at U+E0020..U+E007E. This reads it back
 *  as that ASCII, and drops the other tag code points (language tag, cancel),
 *  so a text screen sees the words the tags hide. Everything else is unchanged. */
export function decodeTagCharacters(text) {
  const s = String(text || "");
  if (!/[\u{e0000}-\u{e007f}]/u.test(s)) return s;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (!isTag(cp)) { out += ch; continue; }
    if (cp >= 0xe0020 && cp <= 0xe007e) out += String.fromCodePoint(cp - TAG_LO);
  }
  return out;
}

/** Every hidden character in `text` that no allowance covers, in order:
 *  `{ index, cp, hex, kind }`, with `index` the UTF-16 offset into the string. */
export function hiddenCharacters(text) {
  const s = String(text || "");
  if (!QUICK.test(s)) return [];
  const chars = Array.from(s);
  const cps = chars.map((c) => c.codePointAt(0));
  const found = [];
  let index = 0;
  for (let i = 0; i < chars.length; i++, index += chars[i - 1].length) {
    const cp = cps[i];
    const kind = kindOf(cp);
    if (!kind) continue;
    if (kind === "tag") {
      // The subdivision-flag sequence: black flag, 1..6 tag letters/digits, cancel.
      if (i > 0 && cps[i - 1] === BLACK_FLAG && isTagAlnum(cp)) {
        let j = i;
        while (j < cps.length && isTagAlnum(cps[j]) && j - i < 6) j++;
        if (j < cps.length && cps[j] === TAG_CANCEL) {
          // Skip the whole run (the loop's own increment steps past the cancel).
          for (let k = i; k < j; k++) index += chars[k].length;
          i = j;
          continue;
        }
      }
      found.push({ index, cp, hex: hex(cp), kind });
      continue;
    }
    if (kind === "variation-selector") {
      const prev = i > 0 ? chars[i - 1] : "";
      const prevCp = i > 0 ? cps[i - 1] : -1;
      if (prev && !isVS(prevCp)) {
        if (isPresentationVS(cp) ? EMOJI_BASE.test(prev) : VARIANT_BASE.test(prev)) continue;
      }
      found.push({ index, cp, hex: hex(cp), kind });
      continue;
    }
    if (cp === 0x200d || cp === 0x200c) {
      const next = i + 1 < chars.length ? chars[i + 1] : "";
      if (cp === 0x200d) {
        let p = i - 1;
        while (p >= 0 && EMOJI_TRAILER.test(chars[p])) p--;
        if (p >= 0 && PICTOGRAPH.test(chars[p]) && PICTOGRAPH.test(next)) continue;
      }
      const prev = i > 0 ? chars[i - 1] : "";
      if (JOINER_SCRIPT.test(prev) && JOINER_SCRIPT.test(next)) continue;
    }
    found.push({ index, cp, hex: hex(cp), kind });
  }
  return found;
}

export const hasHiddenCharacters = (text) => hiddenCharacters(text).length > 0;
