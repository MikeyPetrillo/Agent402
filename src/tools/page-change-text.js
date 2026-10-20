// Text side of page-change (./page-change-kit.js): a fetched document becomes
// one normalized text, the text becomes a fingerprint, and two texts become a
// compact line diff. Everything here is plain data in and plain data out, so
// the HTML half runs inside the HTML worker (./html-worker-ops.js) and the
// pure half is unit-tested without a socket.
//
// Why the ignore patterns run under a vm timeout: a caller pattern is applied
// to up to MAX_TEXT_CHARS of page text with replace(), and the shape guard in
// safe-regex.js only refuses the exponential families. The timeout is the
// actual bound; it holds inside the worker exactly as on the main thread, and
// a pattern that overruns is the caller's 400, never a stall.
import vm from "node:vm";
import { createHash } from "node:crypto";
import { loadJsdom } from "./lazy-deps.js";
import { scrubHidden } from "./hidden-content.js";
import { compileUserRegex, escapeRegex } from "./safe-regex.js";

/** Normalized text is capped here, BEFORE the ignore patterns and the
 *  fingerprint, so the fingerprint, the returned text and a stored baseline
 *  all describe the same string. */
export const MAX_TEXT_CHARS = 200_000;
export const MAX_IGNORE = 20;
export const MAX_IGNORE_CHARS = 200;
const IGNORE_TIMEOUT_MS = 100;
const IGNORE_TOTAL_MS = 300;

function bad(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/** Caller `ignore` entries: "/pattern/" or "/pattern/i" is a regex (shape
 *  guarded by compileUserRegex), anything else a literal substring. Every
 *  entry becomes one global RegExp. Throws 400 on a bad entry. */
export function parseIgnore(ignore) {
  if (ignore === undefined || ignore === null) return [];
  if (!Array.isArray(ignore)) throw bad('"ignore" must be an array of strings');
  if (ignore.length > MAX_IGNORE) throw bad(`"ignore" is capped at ${MAX_IGNORE} entries`);
  return ignore.map((raw, i) => {
    if (typeof raw !== "string" || !raw.length) throw bad(`"ignore"[${i}] must be a non-empty string`);
    if (raw.length > MAX_IGNORE_CHARS + 3) throw bad(`"ignore"[${i}] is capped at ${MAX_IGNORE_CHARS} characters`);
    const m = raw.match(/^\/(.+)\/(i?)$/s);
    if (m) {
      try { return compileUserRegex(m[1], "g" + m[2]); }
      catch (e) { throw bad(`"ignore"[${i}]: ${e.message}`); }
    }
    return new RegExp(escapeRegex(raw), "g");
  });
}

/** Apply the ignore patterns under a hard time bound. Returns the text and
 *  how many matches were removed. */
// The patterns run on the request's own thread, so beside the per-pattern
// timeout the whole set is bounded per text: twenty patterns that each stop
// just short of the limit would otherwise hold the loop for seconds.
let ignoreTotalMs = IGNORE_TOTAL_MS;
export function __setIgnoreTotalMsForTests(ms) { ignoreTotalMs = ms == null ? IGNORE_TOTAL_MS : ms; }
function applyIgnore(text, patterns) {
  let s = text;
  let removed = 0;
  const started = performance.now();
  for (const re of patterns) {
    re.lastIndex = 0;
    try {
      const out = vm.runInNewContext(
        "let n = 0; const r = s.replace(re, () => { n++; return ''; }); ({ r, n })",
        { re, s },
        { timeout: IGNORE_TIMEOUT_MS },
      );
      s = out.r;
      removed += out.n;
    } catch (e) {
      if (e?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") throw bad(`an "ignore" pattern took longer than ${IGNORE_TIMEOUT_MS} ms on this page - simplify it`);
      throw e;
    }
    if (performance.now() - started > ignoreTotalMs) throw bad(`the "ignore" patterns took longer than ${ignoreTotalMs} ms together on this page - use fewer or simpler patterns`);
  }
  return { text: s, removed };
}

/**
 * Raw text -> the one normalized form everything else is computed on:
 * capped, ignore patterns removed, whitespace runs collapsed, lines trimmed,
 * empty lines dropped. Idempotent, so a stored baseline passes unchanged.
 */
export function normalizeText(raw, patterns = []) {
  let s = String(raw ?? "").replace(/\r/g, "").replace(/ /g, " ");
  const truncated = s.length > MAX_TEXT_CHARS;
  if (truncated) s = s.slice(0, MAX_TEXT_CHARS);
  const { text, removed } = applyIgnore(s, patterns);
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  return { text: lines.join("\n"), lines: lines.length, truncated, ignored: removed };
}

export function fingerprintOf(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

/**
 * Line diff as a multiset: which lines appear in the new text and not the old
 * (added) and the reverse (removed), in order of appearance, with counts for
 * repeated lines. Linear in the line count, so a 200k-character page diffs
 * in milliseconds. Similarity is the share of lines both texts hold.
 */
export function lineDiff(oldText, newText, { maxLines = 50, maxLineChars = 500 } = {}) {
  const a = oldText ? String(oldText).split("\n") : [];
  const b = newText ? String(newText).split("\n") : [];
  const count = (xs) => { const m = new Map(); for (const x of xs) m.set(x, (m.get(x) || 0) + 1); return m; };
  const remainingInB = count(b);
  const remainingInA = count(a);
  const removed = [];
  for (const l of a) {
    const n = remainingInB.get(l) || 0;
    if (n > 0) remainingInB.set(l, n - 1);
    else removed.push(l);
  }
  const added = [];
  for (const l of b) {
    const n = remainingInA.get(l) || 0;
    if (n > 0) remainingInA.set(l, n - 1);
    else added.push(l);
  }
  const common = a.length - removed.length;
  const total = a.length + b.length;
  const clip = (l) => (l.length > maxLineChars ? l.slice(0, maxLineChars) : l);
  return {
    added: added.slice(0, maxLines).map(clip),
    removed: removed.slice(0, maxLines).map(clip),
    addedTotal: added.length,
    removedTotal: removed.length,
    similarity: total ? Number((2 * common / total).toFixed(4)) : 1,
  };
}

// Elements whose boundaries are line breaks in the text, so a diff reads in
// paragraphs, headings and rows rather than one run. Same set html-strip uses.
const BLOCK = "ARTICLE,SECTION,HEADER,FOOTER,NAV,ASIDE,MAIN,DIV,P,H1,H2,H3,H4,H5,H6,UL,OL,LI,BLOCKQUOTE,PRE,HR,TR,BR,TABLE,FIGURE,FIGCAPTION,DT,DD,DETAILS,SUMMARY,ADDRESS,FORM,FIELDSET";
const NEVER_TEXT = "script,style,noscript,template,iframe,svg,canvas,object,embed";

/**
 * HTML -> { title, text, matches }: the text a reader sees. Hidden content
 * (comments, display:none, white-on-white, zero-width characters) is dropped,
 * scripts and styles never count, and a CSS selector narrows the text to the
 * elements it matches (joined in document order). Runs in the HTML worker.
 */
export async function visibleTextFromHtml(html, url, selector = null) {
  const JSDOM = await loadJsdom();
  const dom = new JSDOM(html, { url, contentType: "text/html" });
  const doc = dom.window.document;
  const title = doc.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim().slice(0, 300) || null;
  scrubHidden(doc, { mode: "drop" });
  for (const el of doc.querySelectorAll(NEVER_TEXT)) el.remove();
  let roots;
  let matches = null;
  if (selector) {
    try { roots = Array.from(doc.querySelectorAll(selector)); }
    catch (e) { throw bad(`invalid CSS selector "${selector}": ${e.message}`); }
    matches = roots.length;
  } else {
    roots = [doc.body || doc.documentElement];
  }
  const parts = [];
  for (const root of roots) {
    if (!root) continue;
    for (const el of root.querySelectorAll(BLOCK)) el.appendChild(doc.createTextNode("\n"));
    if (root.matches?.(BLOCK)) root.appendChild(doc.createTextNode("\n"));
    parts.push(root.textContent || "");
  }
  return { title, text: parts.join("\n"), matches };
}
