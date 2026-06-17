import { PDFParse } from "pdf-parse";
import { safeFetch } from "./fetch-guard.js";

// Cap on extracted text bytes — a small (within fetch budget) PDF can still
// expand into hundreds of MB of text via heavy compression. Truncate so we
// neither OOM nor return an unsendable response.
const MAX_EXTRACTED_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * Fetch a PDF and extract its text content.
 */
export async function pdfToText(rawUrl) {
  const { finalUrl, buffer } = await safeFetch(rawUrl, { binary: true, maxBytes: 20 * 1024 * 1024 });
  const parser = new PDFParse({ data: buffer });
  try {
    // The parser's worker cannot handle concurrent calls — keep these sequential.
    const textResult = await parser.getText();
    let info = {};
    try {
      info = (await parser.getInfo())?.info ?? {};
    } catch {
      // Document info is best-effort; some PDFs have metadata the worker can't clone.
    }
    let text = (textResult.text || "").trim();
    let truncated = false;
    if (Buffer.byteLength(text, "utf8") > MAX_EXTRACTED_TEXT_BYTES) {
      // Byte-truncate (don't slice by chars — multibyte). Drop the last char if
      // it landed mid-codepoint by re-decoding.
      text = Buffer.from(text, "utf8").subarray(0, MAX_EXTRACTED_TEXT_BYTES).toString("utf8");
      truncated = true;
    }
    return {
      url: finalUrl,
      pages: textResult.total ?? textResult.pages?.length ?? null,
      info: {
        title: info.Title || null,
        author: info.Author || null,
        creationDate: info.CreationDate || null,
      },
      wordCount: text.split(/\s+/).filter(Boolean).length,
      text,
      truncated,
    };
  } catch (e) {
    const err = new Error(`Could not parse PDF: ${e.message}`);
    err.statusCode = 422;
    throw err;
  } finally {
    await parser.destroy().catch(() => {});
  }
}
