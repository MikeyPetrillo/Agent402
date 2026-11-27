// The short summary and the jump list at the top of /privacy and /terms.
//
// Markup only: each page writes its own summary sentences in its own module,
// beside the full text they summarize, so the page's "last updated" guard
// (scripts/test-legal-dates.js) reads them with the rest of the text. The jump
// list is read from the page's own rendered body, so every link names a
// heading that is on the page (scripts/test-legal-summary.js).
import { esc } from "./ledger-chrome.js";

const stripTags = (s) => {
  let out = String(s);
  let prev;
  do { prev = out; out = out.replace(/<[^>]*>/g, ""); } while (out !== prev);
  return out.replace(/\s+/g, " ").trim();
};

/** Every `<h2 id="...">` in `html`, in order: [{ id, text }]. Escaped text is kept as written. */
export function sectionHeadings(html) {
  return [...String(html).matchAll(/<h2\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => ({ id: m[1], text: stripTags(m[2]) }));
}

/** The summary box: a heading and the sentences, one paragraph. */
export function legalSummaryBox(sentences) {
  const text = sentences.map((s) => String(s).trim()).filter(Boolean).join(" ");
  return `<aside class="lg-summary" aria-labelledby="lg-summary-h">
<h2 class="lg-summary-h" id="lg-summary-h">In short</h2>
<p>${text}</p>
</aside>`;
}

/** The jump list of the body's sections. */
export function legalJumpList(bodyHtml) {
  const items = sectionHeadings(bodyHtml).map((h) => `<li><a href="#${esc(h.id)}">${h.text}</a></li>`).join("");
  return `<nav class="lg-toc" aria-label="On this page">
<p class="lg-toc-h">On this page</p>
<ol>${items}</ol>
</nav>`;
}

export const LEGAL_SUMMARY_CSS = `
.lg-summary{border:1px solid var(--hairline);border-left:3px solid var(--accent);border-radius:var(--radius);background:var(--card);padding:18px 22px;margin:0 0 18px}
.lg-summary .lg-summary-h{font-family:var(--font-body);font-weight:700;font-size:var(--fs-lg);line-height:1.2;letter-spacing:0;margin:0 0 8px;color:var(--ink)}
.lg-summary p{font-size:var(--fs-prose);line-height:1.6;color:var(--ink);margin:0}
.lg-summary a{color:var(--accent)}
.lg-toc{margin:0 0 32px}
.lg-toc-h{font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin:0 0 8px}
.lg-toc ol{margin:0;padding:0 0 0 22px;columns:2;column-gap:28px}
.lg-toc li{font-size:var(--fs-md);line-height:1.5;margin:0 0 6px;break-inside:avoid;color:var(--muted)}
.lg-toc a{color:var(--accent);text-decoration:none}
.lg-toc a:hover{text-decoration:underline}
@media(max-width:600px){.lg-toc ol{columns:1}}
`;
