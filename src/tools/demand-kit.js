// Demand kit — tools built directly from the agent402.app Demand Intelligence
// board (top unmet queries with real signal counts):
//   pdf-to-markdown   (461 signals "pdf to markdown", + 611 "convert pdf")
// All deterministic, no AI, inputs SSRF-guarded via safeFetch.
import { pdfToText } from "./pdf.js";
import { safeFetch } from "./fetch-guard.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
function need(input, field) {
  const v = input[field];
  if (v === undefined || v === null || v === "") throw bad(`Missing or invalid "${field}"`);
  return v;
}

/** Plain extracted PDF text -> readable markdown. Deterministic heuristics:
 *  blank-line paragraphs, short un-punctuated Title-Case/CAPS lines become
 *  headings, obvious bullets normalize to "-". Exported for unit tests. */
export function textToMarkdown(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(para.join(" ").replace(/\s+/g, " ").trim());
    para = [];
  };
  const isHeading = (s) => {
    const t = s.trim();
    if (t.length < 3 || t.length > 80) return false;
    if (/[.;:,]$/.test(t)) return false;
    if (/^\d+(\.\d+)*\s+\S/.test(t)) return true; // numbered section "2.1 Title"
    if (t === t.toUpperCase() && /[A-Z]{3}/.test(t)) return true; // ALL CAPS
    const words = t.split(/\s+/);
    return words.length <= 8 && words.every((w) => /^[A-Z0-9(]/.test(w) || w.length <= 3);
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (/^[•◦▪‣·*]\s*/.test(line)) { flush(); out.push("- " + line.replace(/^[•◦▪‣·*]\s*/, "")); continue; }
    if (isHeading(line) && para.length === 0) { out.push("## " + line); continue; }
    para.push(line);
  }
  flush();
  return out.join("\n\n");
}


export const DEMAND_TOOLS = [
  {
    route: "POST /api/pdf-to-markdown", name: "PDF to Markdown", slug: "pdf-to-markdown", category: "web", price: "$0.01",
    description:
      "Convert a PDF to clean markdown: headings, paragraphs, and bullets reconstructed from the text layer — ready to drop into a model's context. Body: {\"url\":\"https://…/file.pdf\"}.",
    tags: ["pdf", "markdown", "convert-pdf", "pdf-to-markdown", "documents"],
    discovery: {
      bodyType: "json",
      input: { url: "https://arxiv.org/pdf/1706.03762" },
      inputSchema: { properties: { url: { type: "string", description: "Public URL of the PDF" } }, required: ["url"] },
      output: { example: { pages: 15, wordCount: 4500, markdown: "## Attention Is All You Need\n\nThe dominant sequence…" } },
    },
    handler: async (i) => {
      const r = await pdfToText(need(i, "url"));
      return { url: r.url, pages: r.pages, title: r.info?.title ?? null, wordCount: r.wordCount, markdown: textToMarkdown(r.text) };
    },
  },
];
