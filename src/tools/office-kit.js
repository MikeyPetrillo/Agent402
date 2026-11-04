// Office file kit: structured data in, a real .xlsx, .docx or .pptx out, in
// one call. Pure code with no model and no network: the input is validated on
// the main thread (office-ops.js, each cap refused with a 400 that names it),
// then the file is built in a worker thread (office-pool.js). The answer has
// the same shape as the PDF tools: the file as base64 plus its size, so an
// agent can save it or pass it to the next call. Covered by
// scripts/test-office-create.js.
import { OFFICE_LIMITS, OFFICE_TYPES, validateXlsx, validateDocx, validatePptx } from "./office-ops.js";
import { runOfficeOp } from "./office-pool.js";

const X = OFFICE_LIMITS.xlsx, D = OFFICE_LIMITS.docx, P = OFFICE_LIMITS.pptx;
const TOTAL = OFFICE_LIMITS.totalChars.toLocaleString("en-US");

export const OFFICE_TOOLS = [
  {
    route: "POST /api/xlsx-create", name: "Create Excel spreadsheet (.xlsx)", slug: "xlsx-create", category: "conversion", price: "$0.003",
    description:
      `Turn rows of data into a real Excel workbook (.xlsx) in one call. Send "sheets": each a "name" plus "rows" as an array of arrays or an array of objects (an optional "columns" list sets the order). The first row is a bold, filled, frozen header by default; "headerStyle", "columnWidths" (auto-sized otherwise) and "numberFormats" (such as "#,##0.00") are optional. Every cell is written as a literal value, never a formula: text that starts with = + - or @ stays text. Up to ${X.sheets} sheets, ${X.rowsPerSheet.toLocaleString("en-US")} rows per sheet, ${X.columns} columns and ${X.cells.toLocaleString("en-US")} cells, ${TOTAL} characters in all. Returns the file as base64 with its size, content type and filename.`,
    tags: ["excel", "xlsx", "spreadsheet", "create-excel", "workbook", "office", "export", "json-to-xlsx", "csv-to-excel", "documents"],
    discovery: {
      bodyType: "json",
      input: {
        sheets: [{
          name: "Sales",
          rows: [{ region: "North", units: 1200, revenue: 18450.5 }, { region: "South", units: 860, revenue: 12990 }, { region: "West", units: 540, revenue: 8120.25 }],
          columns: ["region", "units", "revenue"],
          numberFormats: { revenue: "#,##0.00" },
        }],
        filename: "sales.xlsx",
      },
      inputSchema: {
        properties: {
          sheets: {
            type: "array",
            description: `1 to ${X.sheets} sheets: {"name","rows","columns"?,"header"?,"headerStyle"?,"columnWidths"?,"numberFormats"?}. rows: arrays of cells, or objects (keys become the header row). header (default true) styles and freezes the first row. headerStyle: {"bold"?,"fill"?:"#D9E1F2","color"?,"freeze"?}. columnWidths and numberFormats: an array by column, or an object keyed by column key, header text or letter.`,
            items: { type: "object" },
          },
          rows: { type: "array", description: 'Shorthand for one sheet: the rows, with "name", "columns" and the other sheet options at the top level.' },
          filename: { type: "string", description: 'File name for the answer (default "workbook.xlsx")' },
        },
      },
      output: { example: { xlsxBase64: "UEsDBBQACAAIAG...", bytes: 3191, contentType: OFFICE_TYPES.xlsx, filename: "sales.xlsx", sheets: [{ name: "Sales", rows: 4, columns: 3 }] } },
    },
    handler: async (input) => {
      const spec = validateXlsx(input);
      const { base64, bytes } = await runOfficeOp("xlsx", spec);
      return {
        xlsxBase64: base64, bytes, contentType: OFFICE_TYPES.xlsx, filename: spec.filename,
        sheets: spec.sheets.map((s) => ({ name: s.name, rows: s.data.length, columns: s.width })),
      };
    },
  },
  {
    route: "POST /api/docx-create", name: "Create Word document (.docx)", slug: "docx-create", category: "conversion", price: "$0.003",
    description:
      `Turn markdown into a real Word document (.docx) in one call. Send "markdown" and an optional "title": headings, paragraphs, bold, italic, strikethrough, inline code, bullet and numbered lists (nested), task lists, tables, code blocks, block quotes, horizontal rules and links come out as native Word formatting. A link is written as a hyperlink; an image is written as its alt text linked to its address and is never fetched. Up to ${D.markdownChars.toLocaleString("en-US")} characters, ${D.blocks.toLocaleString("en-US")} blocks, tables of ${D.tableRows} rows by ${D.tableColumns} columns, nesting ${D.nesting} levels. Returns the file as base64 with its size, content type and filename.`,
    tags: ["word", "docx", "document", "create-word", "markdown-to-docx", "office", "export", "report", "documents"],
    discovery: {
      bodyType: "json",
      input: {
        title: "Quarterly update",
        markdown: "## Highlights\n\nRevenue grew **12%** and churn fell to *2.1%*.\n\n- Two new regions\n- Support hours extended\n\n1. Hire two engineers\n2. Ship the billing export\n\n| Region | Units |\n|---|---:|\n| North | 1200 |\n| South | 860 |\n\n```\nnpm run report\n```\n\nDetails at [the status page](https://agent402.tools/status).",
        filename: "update.docx",
      },
      inputSchema: {
        properties: {
          markdown: { type: "string", description: `Document body as markdown (GitHub flavor), up to ${D.markdownChars.toLocaleString("en-US")} characters` },
          title: { type: "string", description: `Optional title, written as the document's Title paragraph and its title property (up to ${D.titleChars} characters)` },
          filename: { type: "string", description: 'File name for the answer (default "document.docx")' },
        },
        required: ["markdown"],
      },
      output: { example: { docxBase64: "UEsDBAoAAAAAAG...", bytes: 10520, contentType: OFFICE_TYPES.docx, filename: "update.docx", blocks: 10, headings: 1, tables: 1, listItems: 4, codeBlocks: 1, links: 1 } },
    },
    handler: async (input) => {
      const spec = validateDocx(input);
      const { base64, bytes, stats } = await runOfficeOp("docx", spec);
      return { docxBase64: base64, bytes, contentType: OFFICE_TYPES.docx, filename: spec.filename, ...stats };
    },
  },
  {
    route: "POST /api/pptx-create", name: "Create PowerPoint deck (.pptx)", slug: "pptx-create", category: "conversion", price: "$0.003",
    description:
      `Turn slide outlines into a real PowerPoint deck (.pptx, 16:9) in one call. Send "slides": each with a "title", "bullets" (strings, or {"text","level"} for indent levels 0 to 4), an optional "table" ({"header","rows"} or an array of rows), optional speaker "notes" and "numbered" for a numbered list. An optional deck "title" and "subtitle" add a title slide first. Text sizes shrink to fit. Up to ${P.slides} slides, ${P.bullets} bullets per slide, tables of ${P.tableRows} rows by ${P.tableColumns} columns, ${TOTAL} characters in all. Returns the file as base64 with its size, content type and filename.`,
    tags: ["powerpoint", "pptx", "slides", "presentation", "deck", "create-powerpoint", "office", "export", "documents"],
    discovery: {
      bodyType: "json",
      input: {
        title: "Quarterly update",
        subtitle: "Operations review",
        slides: [
          { title: "Highlights", bullets: ["Revenue grew 12%", { text: "North led with 1,200 units", level: 1 }, "Churn fell to 2.1%"], notes: "Open with the revenue number." },
          { title: "Units by region", table: { header: ["Region", "Units"], rows: [["North", 1200], ["South", 860]] } },
        ],
        filename: "update.pptx",
      },
      inputSchema: {
        properties: {
          slides: {
            type: "array",
            description: `1 to ${P.slides} slides: {"title"?,"bullets"?,"numbered"?,"table"?,"notes"?}; each needs a title, bullets or a table. bullets: strings or {"text","level":0-4}. table: {"header"?:[...],"rows":[[...]]} or an array of rows.`,
            items: { type: "object" },
          },
          title: { type: "string", description: "Optional deck title: adds a title slide first and sets the file's title" },
          subtitle: { type: "string", description: "Optional subtitle on the title slide" },
          filename: { type: "string", description: 'File name for the answer (default "presentation.pptx")' },
        },
        required: ["slides"],
      },
      output: { example: { pptxBase64: "UEsDBAoAAAAAAG...", bytes: 19928, contentType: OFFICE_TYPES.pptx, filename: "update.pptx", slides: 3 } },
    },
    handler: async (input) => {
      const spec = validatePptx(input);
      const { base64, bytes } = await runOfficeOp("pptx", spec);
      return { pptxBase64: base64, bytes, contentType: OFFICE_TYPES.pptx, filename: spec.filename, slides: spec.slides.length + (spec.title ? 1 : 0) };
    },
  },
];
