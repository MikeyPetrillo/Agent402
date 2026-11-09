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
// the rest of its block, so a block's cost is bounded by its length times its
// marker runs. A document whose blocks stay under MARKDOWN_ORDINARY_COST
// renders in tens of milliseconds; one over it, or one that opens dozens of
// quote levels on a line, may take seconds. The estimate only chooses which
// worker lane a render waits in (./markdown-pool.js); it refuses nothing.
export const MARKDOWN_ORDINARY_COST = 2_000_000;
const QUOTE_DEPTH_ORDINARY = 32;

/** One pass over `text`: true when its estimated render cost is past the ordinary bound. */
export function markdownLooksCostly(text) {
  let cost = 0, blockStart = 0, runs = 0, inRun = false, lineStart = true, quotes = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    const marker = c === 42 || c === 95 || c === 126 || c === 96; // * _ ~ `
    if (marker && !inRun) runs++;
    inRun = marker;
    if (c === 10) {
      // A blank line ends the block.
      let j = i + 1;
      while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 13)) j++;
      if (j >= n || text.charCodeAt(j) === 10) {
        cost += (i - blockStart) * runs;
        if (cost > MARKDOWN_ORDINARY_COST) return true;
        blockStart = j; runs = 0;
      }
      lineStart = true; quotes = 0;
    } else if (lineStart) {
      if (c === 62) { if (++quotes > QUOTE_DEPTH_ORDINARY) return true; } // >
      else if (c !== 32 && c !== 9) lineStart = false;
    }
  }
  return cost + (n - blockStart) * runs > MARKDOWN_ORDINARY_COST;
}
