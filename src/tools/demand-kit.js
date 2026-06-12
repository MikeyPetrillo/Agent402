// Demand kit — tools built directly from the agent402.app Demand Intelligence
// board (top unmet queries with real signal counts):
//   pdf-to-markdown   (461 signals "pdf to markdown", + 611 "convert pdf")
//   xlsx-to-json/csv  (381 signals "convert excel to google sheets" — the
//                      agentable core of that need is getting data OUT of xlsx)
// All deterministic, no AI, inputs SSRF-guarded via safeFetch.
import * as XLSX from "xlsx";
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

/** Workbook buffer -> { sheets: [{name, rows, headers, data}] }. Exported for tests. */
export function workbookToJson(buffer, { sheet, limit = 5000 } = {}) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: "buffer" });
  } catch {
    throw bad("Not a readable spreadsheet (xlsx/xls/ods/csv)");
  }
  const names = sheet ? [sheet] : wb.SheetNames;
  if (sheet && !wb.SheetNames.includes(sheet)) throw bad(`Sheet "${sheet}" not found. Sheets: ${wb.SheetNames.join(", ")}`);
  const sheets = names.map((name) => {
    const data = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null }).slice(0, limit);
    return { name, rows: data.length, headers: data.length ? Object.keys(data[0]) : [], data };
  });
  return { sheetNames: wb.SheetNames, sheets };
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
  {
    route: "POST /api/xlsx-to-json", name: "Excel to JSON", slug: "xlsx-to-json", category: "conversion", price: "$0.005",
    description:
      "Parse an Excel/ODS/CSV workbook from a URL into JSON rows (header-keyed), per sheet. The agentable half of \"convert excel to google sheets\": get the data out, no Google account required. Body: {\"url\":\"https://…/file.xlsx\",\"sheet\":\"Sheet1\"?}.",
    tags: ["excel", "xlsx", "spreadsheet", "json", "convert"],
    discovery: {
      bodyType: "json",
      input: { url: "https://example.com/report.xlsx" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "Public URL of the workbook (xlsx, xls, ods, csv)" },
          sheet: { type: "string", description: "Optional: one sheet name (default: all sheets)" },
        },
        required: ["url"],
      },
      output: { example: { sheetNames: ["Sheet1"], sheets: [{ name: "Sheet1", rows: 2, headers: ["name", "qty"], data: [{ name: "widget", qty: 4 }] }] } },
    },
    handler: async (i) => {
      const { buffer } = await safeFetch(need(i, "url"), { binary: true, maxBytes: 10 * 1024 * 1024 });
      return workbookToJson(buffer, { sheet: i.sheet });
    },
  },
  {
    route: "POST /api/xlsx-to-csv", name: "Excel to CSV", slug: "xlsx-to-csv", category: "conversion", price: "$0.005",
    description:
      "Convert one sheet of an Excel/ODS workbook from a URL to CSV text. Body: {\"url\":\"https://…/file.xlsx\",\"sheet\":\"Sheet1\"?} (default: first sheet).",
    tags: ["excel", "xlsx", "spreadsheet", "csv", "convert"],
    discovery: {
      bodyType: "json",
      input: { url: "https://example.com/report.xlsx" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "Public URL of the workbook" },
          sheet: { type: "string", description: "Optional sheet name (default: first)" },
        },
        required: ["url"],
      },
      output: { example: { sheet: "Sheet1", rows: 3, csv: "name,qty\nwidget,4\n" } },
    },
    handler: async (i) => {
      const { buffer } = await safeFetch(need(i, "url"), { binary: true, maxBytes: 10 * 1024 * 1024 });
      let wb;
      try { wb = XLSX.read(buffer, { type: "buffer" }); } catch { throw bad("Not a readable spreadsheet"); }
      const name = i.sheet || wb.SheetNames[0];
      if (!wb.SheetNames.includes(name)) throw bad(`Sheet "${name}" not found. Sheets: ${wb.SheetNames.join(", ")}`);
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
      return { sheet: name, rows: csv.trim() ? csv.trim().split("\n").length : 0, csv };
    },
  },
];
