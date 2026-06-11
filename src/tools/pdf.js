import { PDFParse } from "pdf-parse";
import { safeFetch } from "./fetch-guard.js";

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
    const text = (textResult.text || "").trim();
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
    };
  } catch (e) {
    const err = new Error(`Could not parse PDF: ${e.message}`);
    err.statusCode = 422;
    throw err;
  } finally {
    await parser.destroy().catch(() => {});
  }
}
