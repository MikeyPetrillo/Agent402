// Markdown to HTML: the one renderer configuration in the codebase. The
// markdown-to-html tool (on the serving thread and in its worker), the guide
// pages (src/guides.js) and the docs pages (src/docs.js) all import `marked`
// from here, so a document renders to the same bytes wherever it is rendered.
//
// Headings carry ids (GitHub-style slugs) so shortlinks and readers can
// deep-link a section. The id is computed from the heading's PLAIN TEXT (the
// tokens' text, never the rendered html), so no markup is ever part of the id.
//
// Pure module: nothing here reaches the network.
import { marked } from "marked";

export const headingId = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
const tokenText = (tokens) => (tokens || []).map((t) => (t.tokens ? tokenText(t.tokens) : (t.text ?? ""))).join("");
marked.use({ renderer: { heading({ tokens, depth }) { const html = this.parser.parseInline(tokens); return `<h${depth} id="${headingId(tokenText(tokens))}">${html}</h${depth}>\n`; } } });

export { marked };

/** Longest document rendered on the serving thread: the costliest shape of
 *  this length (unclosed emphasis markers end to end) renders in about 40 ms. */
export const MARKDOWN_INLINE_MAX_CHARS = 2_500;

export function renderMarkdown(text) {
  try {
    return { html: marked.parse(text, { async: false }) };
  } catch (e) {
    // Block nesting is read by recursion; a document nested past the stack is
    // the caller's input, not a fault here.
    if (e instanceof RangeError) throw Object.assign(new Error('"markdown" is nested too deeply to render; flatten the deepest quotes or lists'), { statusCode: 400 });
    throw e;
  }
}

// The renderer looks for the closer of each emphasis or code marker across
// the rest of its block, so a marker run costs about the distance to its
// closer, and the whole block when it has none. markdownCost() adds that up
// in one pass: for each run of * _ ~ or ` that can open, the distance to the
// next run of the same character and length that can close, else the rest of
// the block. Opening and closing follow CommonMark's flanking rules (a run
// opens before a word and closes after one; an underscore inside a word does
// neither; a code marker always can). Blocks end at a blank line. Ordinary writing
// and source code score low because their markers pair up nearby; a block
// dense with markers that never close scores with the square of its length.
// The estimate only chooses which worker lane a render waits in
// (./markdown-pool.js); it refuses nothing.
//
// MARKDOWN_ORDINARY_COST is about a third of a second of rendering on an idle
// host (a scanned character costs 10 to 65 ns in the slow shapes).
export const MARKDOWN_ORDINARY_COST = 5_000_000;
const QUOTE_DEPTH_ORDINARY = 32;
const isSpaceCode = (c) => c === 32 || c === 9 || c === 10 || c === 13 || Number.isNaN(c);
const isPunctCode = (c) => (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);

/** Estimated render cost of `text`, in characters scanned; Infinity past `limit` or for dozens of quote levels on one line. */
export function markdownCost(text, limit = Infinity) {
  const n = text.length;
  let cost = 0, blockStart = 0, lineStart = true, quotes = 0;
  let runs = []; // [position, character, length, canOpen, canClose] of the current block
  const closeBlock = (end) => {
    const nearest = new Map(); // "character:length" -> position of the nearest closer to the right
    for (let k = runs.length - 1; k >= 0; k--) {
      const [pos, ch, len, canOpen, canClose] = runs[k];
      const key = ch * 64 + Math.min(len, 63);
      if (canOpen) cost += (nearest.get(key) ?? end) - pos;
      if (canClose) nearest.set(key, pos);
    }
    runs = [];
  };
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 92) { i++; lineStart = false; continue; } // a backslash escapes the next character
    if (c === 42 || c === 95 || c === 126 || c === 96) { // * _ ~ `
      let j = i + 1;
      while (j < n && text.charCodeAt(j) === c) j++;
      const prev = i > blockStart ? text.charCodeAt(i - 1) : NaN, next = text.charCodeAt(j);
      const left = !isSpaceCode(next) && (!isPunctCode(next) || isSpaceCode(prev) || isPunctCode(prev));
      const right = !isSpaceCode(prev) && (!isPunctCode(prev) || isSpaceCode(next) || isPunctCode(next));
      const code = c === 96, under = c === 95;
      runs.push([i, c, j - i, code || (under ? left && (!right || isPunctCode(prev)) : left), code || (under ? right && (!left || isPunctCode(next)) : right)]);
      i = j - 1;
      lineStart = false;
      continue;
    }
    if (c === 10) {
      // A blank line ends the block.
      let j = i + 1;
      while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 13)) j++;
      if (j >= n || text.charCodeAt(j) === 10) {
        closeBlock(i);
        if (cost > limit) return Infinity;
        blockStart = j;
      }
      lineStart = true; quotes = 0;
    } else if (lineStart) {
      if (c === 62) { if (++quotes > QUOTE_DEPTH_ORDINARY) return Infinity; } // >
      else if (c !== 32 && c !== 9) lineStart = false;
    }
  }
  closeBlock(n);
  return cost > limit ? Infinity : cost;
}

/** True when the estimated render cost of `text` is past the ordinary bound. */
export function markdownLooksCostly(text) {
  return markdownCost(text, MARKDOWN_ORDINARY_COST) > MARKDOWN_ORDINARY_COST;
}
