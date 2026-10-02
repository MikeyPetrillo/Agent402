// PDF summarize — the one AI-powered PDF tool in the catalog (everything in
// pdf-kit.js is deliberately deterministic/no-AI; this is the exception, and
// lives in its own file rather than there so that invariant stays true and
// greppable).
//
// Fetches + extracts text via pdf.js's pdfToText, then summarizes it by
// calling the LLM gateway's OWN v1-chat ($0.02) tier handler IN-PROCESS —
// same composition pattern research-kit.js used before it was retired (import the kit array, look up
// by slug, call the handler directly). This reuses that tier's existing
// margin clamp, model fallback chain, and pricing safety instead of
// re-implementing upstream LLM calling from scratch: the inner handler's own
// clampToMargin bounds worst-case upstream spend against ITS own price
// regardless of what this tool charges, which is what actually keeps this
// tool's own price safe, not anything reimplemented here. No second payment
// happens - the inner call is pure code reuse, not a nested paywall; only
// this tool's own catalog price is ever charged to the buyer.
import { pdfToText } from "./pdf.js";
import { LLM_GATEWAY_TOOLS } from "./llm-gateway-kit.js";

// The Unicode replacement character (U+FFFD) that Buffer#toString("utf8")
// silently emits when a byte-boundary truncation splits a multi-byte
// character - built from a numeric code point rather than typed literally,
// so the source file never carries a raw invisible/non-ASCII byte sequence.
const REPLACEMENT_CHAR_TAIL_RE = new RegExp(String.fromCharCode(0xfffd) + "+$");

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
function need(input, field) {
  const v = input[field];
  if (v === undefined || v === null || v === "") throw bad(`Missing or invalid "${field}"`);
  return v;
}

const chatHandler = LLM_GATEWAY_TOOLS.find((t) => t.slug === "v1-chat")?.handler;
if (!chatHandler) throw new Error("pdf-summarize-kit: v1-chat tool missing from LLM_GATEWAY_TOOLS - was it renamed?");

// The v1-chat tier itself caps input at 32k chars and would 400 past that;
// slicing here first gives an explicit, honest contract (truncatedInput in
// the response) instead of a surprise 400 bubbling up from the inner call.
const MAX_SUMMARY_INPUT_BYTES = 28_000;

export const PDF_SUMMARIZE_TOOLS = [
  {
    route: "POST /api/pdf-summarize",
    name: "Summarize a PDF",
    slug: "pdf-summarize",
    category: "web",
    price: "$0.030",
    description:
      "Fetch a PDF from a URL, extract its text, and return a concise AI-generated summary - factual, no information added beyond what's in the document. Body: {\"url\":\"https://…/file.pdf\",\"maxWords\":200?}. Uses the same OpenAI-compatible gateway as /v1/chat/completions internally; the model that actually served is disclosed in the response.",
    tags: ["pdf", "summarize", "summary", "documents", "ai", "text-extraction"],
    discovery: {
      bodyType: "json",
      // Same real, stable whitepaper URL the deterministic "pdf" tool uses.
      input: { url: "https://bitcoin.org/bitcoin.pdf", maxWords: 150 },
      inputSchema: {
        properties: {
          url: { type: "string", description: "Public http(s) URL of a PDF" },
          maxWords: { type: "number", description: "Target summary length in words, 50-500 (default 200)" },
        },
        required: ["url"],
      },
      output: {
        example: {
          url: "https://bitcoin.org/bitcoin.pdf",
          pages: 9,
          wordCount: 3604,
          summary: "The paper proposes a peer-to-peer electronic cash system that lets online payments move directly between parties without a financial institution, using a proof-of-work chain as a timestamp server to prevent double-spending…",
          summaryWordCount: 148,
          model: "openai/gpt-4o-mini",
          truncatedInput: false,
        },
      },
    },
    handler: async (i) => {
      const url = need(i, "url");
      const { text, pages, wordCount, truncated: extractTruncated } = await pdfToText(url);
      if (!text || !text.trim()) {
        throw bad('PDF has no extractable text - it may be a scanned image; try an OCR tool first', 422);
      }
      // Found live (2026-08-12): `parseInt(i.maxWords,10) || 200` treats an
      // explicit maxWords:0 as "not provided" (0 is falsy) and jumps to the
      // 200-word default instead of clamping to the 50-word floor like every
      // other out-of-range value. Distinguish "not provided" from "provided
      // as 0" explicitly instead of relying on truthiness.
      const parsedMaxWords = parseInt(i.maxWords, 10);
      const maxWords = Math.min(Math.max(Number.isFinite(parsedMaxWords) ? parsedMaxWords : 200, 50), 500);
      const overCap = Buffer.byteLength(text, "utf8") > MAX_SUMMARY_INPUT_BYTES;
      // Buffer.subarray truncates on a raw byte boundary, which can split a
      // multi-byte UTF-8 character (accented Latin, CJK, emoji) in half;
      // toString("utf8") doesn't throw, it silently emits a trailing U+FFFD
      // replacement character. Strip that rather than send corrupted text
      // to the model - found live (2026-08-12) on a non-English PDF.
      const clipped = overCap
        ? Buffer.from(text, "utf8").subarray(0, MAX_SUMMARY_INPUT_BYTES).toString("utf8").replace(REPLACEMENT_CHAR_TAIL_RE, "")
        : text;
      const completion = await chatHandler({
        model: "openai/gpt-4o-mini",
        messages: [{
          role: "user",
          content: `Summarize the following document in about ${maxWords} words. Be factual and concise - do not add information that isn't in the text.\n\n${clipped}`,
        }],
      });
      const summary = completion?.choices?.[0]?.message?.content?.trim();
      if (!summary) throw bad("Summarization produced no output", 502);
      return {
        url,
        pages,
        wordCount,
        summary,
        summaryWordCount: summary.split(/\s+/).filter(Boolean).length,
        model: completion.model,
        truncatedInput: extractTruncated || overCap,
      };
    },
  },
];
