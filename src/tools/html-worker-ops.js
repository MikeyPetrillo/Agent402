// The named operations the HTML worker runs (./html-worker.js), and the same
// dispatch runHtml() uses when it is already off the main thread. Every
// payload and result is plain data.
import { articleFromHtml, pageMetaFromHtml, pageContentFromHtml, markdownFromHtml } from "./html-parse-ops.js";
import { visibleTextFromHtml } from "./page-change-text.js";

let toolHandlers = null;

export async function runOp(op, p = {}) {
  switch (op) {
    case "article": return articleFromHtml(p.html, p.url);
    case "meta": return pageMetaFromHtml(p.html, p.url);
    case "pageContent": return pageContentFromHtml(p.html, p.url, p.format);
    case "markdown": return markdownFromHtml(p.text, p.mode);
    case "visibleText": return visibleTextFromHtml(p.html, p.url, p.selector);
    case "tool": {
      // The html-kit tools' own handlers (the catalog entries wrap them in runHtml).
      toolHandlers ||= (await import("./html-kit.js")).HTML_TOOL_HANDLERS;
      const handler = toolHandlers[p.slug];
      if (!handler) throw Object.assign(new Error(`unknown HTML tool ${p.slug}`), { statusCode: 500 });
      return handler(p.input || {});
    }
    default: throw Object.assign(new Error(`unknown HTML operation ${op}`), { statusCode: 500 });
  }
}
