// A small shell word scanner for the guards that read a workflow's `gh` calls:
// double quotes (with $(...) inside), single quotes, command substitution and
// line continuations. Enough to find the word after a flag; not a shell parser.
function skipDouble(s, i) {
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === '"') return i + 1;
    if (c === "$" && s[i + 1] === "(") { i = skipSub(s, i + 1); continue; }
    i++;
  }
  throw new Error("unterminated double quote");
}
function skipSingle(s, i) {
  const j = s.indexOf("'", i + 1);
  if (j < 0) throw new Error("unterminated single quote");
  return j + 1;
}
function skipSub(s, i) {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === '"') { i = skipDouble(s, i); continue; }
    if (c === "'") { i = skipSingle(s, i); continue; }
    if (c === "(") depth++;
    if (c === ")") { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  throw new Error("unterminated command substitution");
}
/** The index just past the shell word that starts at i. */
export function wordEnd(s, i) {
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "\n") break;
    if (c === "\\") { i += 2; continue; }
    if (c === '"') { i = skipDouble(s, i); continue; }
    if (c === "'") { i = skipSingle(s, i); continue; }
    if (c === "$" && s[i + 1] === "(") { i = skipSub(s, i + 1); continue; }
    if (c === "$" && s[i + 1] === "{") { const j = s.indexOf("}", i); if (j < 0) throw new Error("unterminated ${"); i = j + 1; continue; }
    if (/[\s;|&)]/.test(c)) break;
    i++;
  }
  return i;
}
const skipBlank = (s, i) => { for (;;) { if (s[i] === " " || s[i] === "\t") i++; else if (s[i] === "\\" && s[i + 1] === "\n") i += 2; else return i; } };

/** The words of the simple command that starts at i (to the end of the
 *  command: a newline, `;`, `|`, `&` or `)` outside quotes). */
export function commandWords(s, i) {
  const words = [];
  for (;;) {
    i = skipBlank(s, i);
    if (i >= s.length || /[\n;|&)]/.test(s[i])) break;
    const e = wordEnd(s, i);
    if (e === i) break;
    words.push(s.slice(i, e));
    i = e;
  }
  return words;
}

/** Every `gh issue <verb>` call in a text: { verb, words, index }. */
export function ghIssueCalls(text, verbs = ["create", "comment", "close", "edit"]) {
  const out = [];
  const re = new RegExp(`gh issue (${verbs.join("|")})\\b`, "g");
  let m;
  while ((m = re.exec(text))) out.push({ verb: m[1], index: m.index, words: commandWords(text, m.index + m[0].length) });
  return out;
}

/** A double-quoted word's text (the quotes removed), or null for another shape. */
export function unquoted(word) {
  return typeof word === "string" && word.length >= 2 && word[0] === '"' && word.at(-1) === '"' ? word.slice(1, -1) : null;
}
