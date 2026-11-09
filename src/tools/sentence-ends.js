// Sentence ends, found in one pass.
//
// A sentence ends at a run of . ! ? that is followed by whitespace or by the
// end of the text. The pattern /[.!?]+(\s|$)/ reads a run again from each of
// its characters when the run is followed by anything else, so its cost grows
// with the square of the run. This scanner reads each character once and
// returns the same matches.
//
// Pure module: no imports, no network.

const WHITESPACE = /\s/;
const isPunct = (c) => c === 46 || c === 33 || c === 63; // . ! ?

/**
 * The matches of /[.!?]+(\s|$)/g in `s` as [start, end) pairs.
 *  - consumeSpace false: the matches of /[.!?]+(?=\s|$)/g (the whitespace is not part of the match).
 *  - newline true: a "\n" is a match of its own, as in /[.!?]+(?=\s|$)|\n/g.
 */
export function sentenceEnds(s, { consumeSpace = true, newline = false } = {}) {
  const out = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (newline && c === 10) { out.push([i, i + 1]); i++; continue; }
    if (!isPunct(c)) { i++; continue; }
    let j = i + 1;
    while (j < n && isPunct(s.charCodeAt(j))) j++;
    if (j === n) { out.push([i, j]); break; }
    if (WHITESPACE.test(s[j])) {
      const end = consumeSpace ? j + 1 : j;
      out.push([i, end]);
      i = end;
    } else {
      i = j;
    }
  }
  return out;
}

/** How many matches /[.!?]+(\s|$)/g has in `s`. */
export function countSentenceEnds(s) {
  return sentenceEnds(s).length;
}

/** `s.split(/[.!?]+(?:\s|$)/)`. */
export function splitOnSentenceEnds(s) {
  const parts = [];
  let from = 0;
  for (const [start, end] of sentenceEnds(s)) { parts.push(s.slice(from, start)); from = end; }
  parts.push(s.slice(from));
  return parts;
}
