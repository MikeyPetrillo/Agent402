// Markdown to HTML, one function shared by the main thread and the HTML
// worker so both render with the same library and the same options.
//
// The renderer's inline pass is quadratic on long runs of unclosed emphasis,
// so the cost of a render is bounded two ways (see the markdown-to-html
// handler in ./kit.js): a short document renders in place, where its worst
// case is a few tens of milliseconds, and a longer one renders in the HTML
// worker under a deadline.
import { marked } from "marked";

/** Longest document rendered on the calling thread. */
export const MARKDOWN_INLINE_MAX_CHARS = 2_000;

export function renderMarkdown(text) {
  try {
    return { html: marked.parse(text, { async: false }) };
  } catch (e) {
    // Block nesting is read by recursion; a document nested past the stack is
    // the caller's input, not a fault here.
    if (e instanceof RangeError) throw Object.assign(new Error('"markdown" is nested too deeply to render'), { statusCode: 400 });
    throw e;
  }
}
