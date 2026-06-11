import { PDFParse } from "pdf-parse";
import { safeFetch } from "./fetch-guard.js";

/**
 * Fetch a PDF and extract its text content.
 */
export async function pdfToText(rawUrl) {
  const { finalUrl, buffer } = await safeFetch(rawUrl, { binary: true, maxBytes: 20 * 1024 * 1024 });
  const parser = new PDFParse({ data: buffer });
  try {
    const [textResult, infoResult] = await Promise.all([parser.getText(), parser.getInfo()]);
    const text = (textResult.text || "").trim();
    const info = infoResult?.info ?? {};
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
