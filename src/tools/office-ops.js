// Office file builders for xlsx-create, docx-create and pptx-create.
//
// Two halves, one module:
//  - validators (validateXlsx, validateDocx, validatePptx) run on the main
//    thread before a worker is taken. Each is one linear walk over an input the
//    body parser already bounded, and refuses with a 400 that names the cap.
//  - builders (buildXlsx, buildDocx, buildPptx) run in office-worker.js. Each
//    loads its library with a dynamic import, so the main thread never
//    evaluates one, and answers { base64, bytes }.
//
// No builder reaches the network or the file system: every input is text,
// numbers and booleans, nothing is passed to a library as a path or a URL
// (a markdown link is written as a hyperlink and an image as its alt text plus
// a hyperlink, never fetched), and the worker refuses every egress API before
// a library loads. scripts/test-office-create.js reads each file back.

export function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export const OFFICE_LIMITS = Object.freeze({
  totalChars: 100_000,        // every string in one call, summed
  outputBytes: 8 * 1024 * 1024, // the finished file
  // The request body these routes' parser takes (src/server.js mounts them on
  // the large-body gate): room for every cap below once JSON-escaped.
  requestBytes: 2 * 1024 * 1024,
  xlsx: Object.freeze({ sheets: 20, rowsPerSheet: 10_000, columns: 200, cells: 50_000, cellChars: 32_767 }),
  docx: Object.freeze({ markdownChars: 100_000, titleChars: 500, blocks: 5_000, tableRows: 200, tableColumns: 20, tableCells: 25_000, nesting: 8, inlineNesting: 16 }),
  pptx: Object.freeze({ slides: 100, bullets: 30, bulletChars: 1_000, titleChars: 300, tableRows: 20, tableColumns: 10, cellChars: 500, notesChars: 10_000 }),
});

export const OFFICE_TYPES = Object.freeze({
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
});

// Characters XML 1.0 cannot carry (a file holding one does not open), and
// lone surrogates, which toWellFormed() turns into U+FFFD.
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
export function cleanText(s) {
  return String(s).toWellFormed().replace(XML_INVALID, "");
}

/** Counts every string's characters against OFFICE_LIMITS.totalChars. */
function charBudget() {
  let used = 0;
  return (s) => {
    used += s.length;
    if (used > OFFICE_LIMITS.totalChars) throw bad(`Input holds more than ${OFFICE_LIMITS.totalChars} characters of text in total (cap totalChars ${OFFICE_LIMITS.totalChars})`);
    return s;
  };
}

function parseMaybeJson(value, label) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch (e) { throw bad(`"${label}" is not valid JSON: ${e.message}`); }
}

const FILENAME_OK = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,99}$/;
function fileNameOf(raw, ext, fallback) {
  if (raw === undefined || raw === null || raw === "") return `${fallback}.${ext}`;
  if (typeof raw !== "string") throw bad('"filename" must be a string');
  let name = raw.trim();
  if (!name.toLowerCase().endsWith(`.${ext}`)) name += `.${ext}`;
  if (!FILENAME_OK.test(name)) throw bad('"filename" may use letters, digits, spaces and . _ ( ) - (at most 100 characters, starting with a letter or digit)');
  return name;
}

const HEX = /^#?([0-9a-fA-F]{6})$/;
function colorOf(raw, label, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const m = typeof raw === "string" ? raw.match(HEX) : null;
  if (!m) throw bad(`"${label}" must be a hex color like "#D9E1F2"`);
  return `#${m[1].toUpperCase()}`;
}

// ---- xlsx ------------------------------------------------------------------

// A text cell that starts with one of these is what a spreadsheet would read
// as a formula if a person re-entered it. It is written as a text cell (never a
// formula element) with the Text number format, so editing it keeps it text.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
export const TEXT_FORMAT = "@";

function columnLetter(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const SHEET_NAME_BAD = /[[\]:*?/\\]/;
function sheetNameOf(raw, index, seen) {
  const name = raw === undefined || raw === null || raw === "" ? `Sheet${index + 1}` : raw;
  if (typeof name !== "string") throw bad(`sheets[${index}].name must be a string`);
  const clean = cleanText(name).trim();
  if (!clean || clean.length > 31) throw bad(`sheets[${index}].name must be 1 to 31 characters`);
  if (SHEET_NAME_BAD.test(clean)) throw bad(`sheets[${index}].name may not contain [ ] : * ? / \\`);
  if (/^'|'$/.test(clean)) throw bad(`sheets[${index}].name may not start or end with an apostrophe`);
  const key = clean.toLowerCase();
  if (key === "history") throw bad(`sheets[${index}].name "History" is reserved`);
  if (seen.has(key)) throw bad(`sheets[${index}].name "${clean}" is used twice`);
  seen.add(key);
  return clean;
}

function cellOf(v, where, take) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw bad(`${where} is not a finite number`);
    return v;
  }
  if (typeof v === "boolean") return v;
  // Nested values are written as their JSON text, so an API answer pastes in.
  const s = cleanText(typeof v === "string" ? v : JSON.stringify(v));
  if (s.length > OFFICE_LIMITS.xlsx.cellChars) throw bad(`${where} holds ${s.length} characters; a cell holds at most ${OFFICE_LIMITS.xlsx.cellChars} (cap cellChars)`);
  return take(s);
}

/** Per-column option: an array by column index, or an object keyed by column
 *  key, header text or column letter. Returns an array aligned to columns. */
function perColumn(raw, label, keys, check) {
  const out = new Array(keys.length).fill(undefined);
  if (raw === undefined || raw === null) return out;
  if (Array.isArray(raw)) {
    if (raw.length > keys.length) throw bad(`"${label}" names ${raw.length} columns; the sheet has ${keys.length}`);
    raw.forEach((v, i) => { if (v !== null && v !== undefined) out[i] = check(v, `${label}[${i}]`); });
    return out;
  }
  if (typeof raw !== "object") throw bad(`"${label}" must be an array by column or an object keyed by column`);
  for (const [k, v] of Object.entries(raw)) {
    let i = keys.indexOf(k);
    if (i < 0 && /^[A-Z]{1,3}$/.test(k)) i = keys.findIndex((_, j) => columnLetter(j) === k);
    if (i < 0) throw bad(`"${label}" names column "${k}", which the sheet does not have`);
    if (v !== null && v !== undefined) out[i] = check(v, `${label}.${k}`);
  }
  return out;
}

const checkWidth = (v, where) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 255) throw bad(`${where} must be a width from 1 to 255 characters`);
  return v;
};
// A format code is display text for numbers ("#,##0.00", "0.0%", "yyyy-mm-dd").
const checkFormat = (v, where) => {
  if (typeof v !== "string" || !v || v.length > 64 || cleanText(v) !== v) throw bad(`${where} must be a number format code of 1 to 64 characters, such as "#,##0.00"`);
  return v;
};

/** Validates and normalizes an xlsx-create input. Main thread; linear. */
export function validateXlsx(input) {
  const L = OFFICE_LIMITS.xlsx;
  const take = charBudget();
  let sheets = parseMaybeJson(input.sheets, "sheets");
  if (sheets === undefined && input.rows !== undefined) sheets = [{ name: input.name, rows: input.rows, columns: input.columns, header: input.header, headerStyle: input.headerStyle, columnWidths: input.columnWidths, numberFormats: input.numberFormats }];
  if (!Array.isArray(sheets) || !sheets.length) throw bad('Send "sheets": [{"name":"Data","rows":[["Name","Amount"],["Ada",12.5]]}] (or "rows" for one sheet)');
  if (sheets.length > L.sheets) throw bad(`"sheets" holds ${sheets.length} sheets; the cap is ${L.sheets} (cap sheets)`);
  const seen = new Set();
  let cells = 0;
  const out = sheets.map((sh, si) => {
    if (!sh || typeof sh !== "object" || Array.isArray(sh)) throw bad(`sheets[${si}] must be an object with "rows"`);
    const name = take(sheetNameOf(sh.name, si, seen));
    const rows = parseMaybeJson(sh.rows, `sheets[${si}].rows`);
    if (!Array.isArray(rows)) throw bad(`sheets[${si}].rows must be an array of rows (arrays) or of objects`);
    if (rows.length > L.rowsPerSheet) throw bad(`sheets[${si}].rows holds ${rows.length} rows; the cap is ${L.rowsPerSheet} per sheet (cap rowsPerSheet)`);
    const objectRows = rows.length > 0 && rows.every((r) => r && typeof r === "object" && !Array.isArray(r));
    if (!objectRows && rows.some((r) => !Array.isArray(r))) throw bad(`sheets[${si}].rows must be all arrays or all objects`);
    const header = sh.header === undefined ? true : sh.header;
    if (typeof header !== "boolean") throw bad(`sheets[${si}].header must be true or false`);
    let keys = null;
    let grid;
    if (objectRows) {
      if (sh.columns !== undefined) {
        const cols = parseMaybeJson(sh.columns, `sheets[${si}].columns`);
        if (!Array.isArray(cols) || !cols.length || cols.some((c) => typeof c !== "string")) throw bad(`sheets[${si}].columns must be an array of key names`);
        keys = cols;
      } else {
        const set = new Set();
        for (const r of rows) {
          for (const k of Object.keys(r)) {
            set.add(k);
            if (set.size > L.columns) throw bad(`sheets[${si}] rows carry more than ${L.columns} distinct keys; the cap is ${L.columns} columns (cap columns)`);
          }
        }
        keys = [...set];
      }
      if (keys.length > L.columns) throw bad(`sheets[${si}].columns names ${keys.length} columns; the cap is ${L.columns} (cap columns)`);
      // Counted from the row and key counts before the grid is allocated.
      cells += (rows.length + (header ? 1 : 0)) * keys.length;
      if (cells > L.cells) throw bad(`The workbook holds more than ${L.cells} cells; the cap is ${L.cells} (cap cells)`);
      grid = rows.map((r) => keys.map((k) => r[k]));
      if (header) grid.unshift(keys.slice());
    } else {
      grid = rows;
      for (const [ri, r] of rows.entries()) {
        if (r.length > L.columns) throw bad(`sheets[${si}].rows[${ri}] holds ${r.length} cells; the cap is ${L.columns} columns (cap columns)`);
        cells += r.length;
      }
      if (cells > L.cells) throw bad(`The workbook holds more than ${L.cells} cells; the cap is ${L.cells} (cap cells)`);
    }
    const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
    if (!keys) keys = header && grid.length ? Array.from({ length: width }, (_, i) => (typeof grid[0][i] === "string" ? grid[0][i] : columnLetter(i))) : Array.from({ length: width }, (_, i) => columnLetter(i));
    const data = grid.map((r, ri) => r.map((v, ci) => cellOf(v, `sheets[${si}] row ${ri + 1} column ${columnLetter(ci)}`, take)));
    const hs = sh.headerStyle && typeof sh.headerStyle === "object" ? sh.headerStyle : {};
    if (sh.headerStyle !== undefined && (typeof sh.headerStyle !== "object" || sh.headerStyle === null || Array.isArray(sh.headerStyle))) throw bad(`sheets[${si}].headerStyle must be an object`);
    if (hs.bold !== undefined && typeof hs.bold !== "boolean") throw bad(`sheets[${si}].headerStyle.bold must be true or false`);
    if (hs.freeze !== undefined && typeof hs.freeze !== "boolean") throw bad(`sheets[${si}].headerStyle.freeze must be true or false`);
    const headerStyle = {
      bold: hs.bold ?? true,
      fill: colorOf(hs.fill, `sheets[${si}].headerStyle.fill`, "#D9E1F2"),
      color: colorOf(hs.color, `sheets[${si}].headerStyle.color`, "#000000"),
      freeze: hs.freeze ?? true,
    };
    const columnWidths = perColumn(parseMaybeJson(sh.columnWidths, `sheets[${si}].columnWidths`), `sheets[${si}].columnWidths`, keys, checkWidth);
    const numberFormats = perColumn(parseMaybeJson(sh.numberFormats, `sheets[${si}].numberFormats`), `sheets[${si}].numberFormats`, keys, checkFormat);
    return { name, header: header && grid.length > 0, headerStyle, data, width, columnWidths, numberFormats };
  });
  return { sheets: out, filename: fileNameOf(input.filename, "xlsx", "workbook") };
}

function autoWidth(data, ci) {
  let w = 8;
  for (const r of data) {
    const v = r[ci];
    if (v === null || v === undefined) continue;
    const len = typeof v === "string" ? Math.max(...v.split("\n").map((l) => l.length)) : String(v).length;
    if (len + 2 > w) w = len + 2;
    if (w >= 60) return 60;
  }
  return w;
}

/** Cell objects for the writer. Every value is typed explicitly: a string is a
 *  text cell, never a formula. */
export function xlsxSheetData(sheet) {
  return sheet.data.map((r, ri) => {
    const isHeader = sheet.header && ri === 0;
    return r.map((v, ci) => {
      if (v === null || v === undefined) return null;
      const cell = typeof v === "number" ? { type: Number, value: v } : typeof v === "boolean" ? { type: Boolean, value: v } : { type: String, value: v };
      if (cell.type === String && FORMULA_LEAD.test(v)) cell.format = TEXT_FORMAT;
      if (cell.type === Number && !isHeader && sheet.numberFormats[ci]) cell.format = sheet.numberFormats[ci];
      if (cell.type === String && v.includes("\n")) cell.wrap = true;
      if (isHeader) {
        if (sheet.headerStyle.bold) cell.fontWeight = "bold";
        cell.backgroundColor = sheet.headerStyle.fill;
        cell.textColor = sheet.headerStyle.color;
      }
      return cell;
    });
  });
}

export async function buildXlsx(spec) {
  const { default: writeXlsxFile } = await import("write-excel-file/node");
  const sheets = spec.sheets.map((sh) => ({
    sheet: sh.name,
    data: sh.data.length ? xlsxSheetData(sh) : [[null]],
    columns: Array.from({ length: Math.max(sh.width, 1) }, (_, ci) => ({ width: sh.columnWidths[ci] ?? autoWidth(sh.data, ci) })),
    ...(sh.header && sh.headerStyle.freeze ? { stickyRowsCount: 1 } : {}),
  }));
  const buffer = await writeXlsxFile(sheets).toBuffer();
  return buffer;
}

// ---- docx ------------------------------------------------------------------

/** Main-thread checks for docx-create; the markdown is parsed in the worker. */
export function validateDocx(input) {
  const L = OFFICE_LIMITS.docx;
  const md = input.markdown ?? input.text ?? input.content;
  if (typeof md !== "string" || !md.trim()) throw bad('Send "markdown": "# Heading\\n\\nA paragraph with **bold** text."');
  if (md.length > L.markdownChars) throw bad(`"markdown" holds ${md.length} characters; the cap is ${L.markdownChars} (cap markdownChars)`);
  let title = input.title;
  if (title !== undefined && title !== null && title !== "") {
    if (typeof title !== "string") throw bad('"title" must be a string');
    title = cleanText(title).trim();
    if (title.length > L.titleChars) throw bad(`"title" holds ${title.length} characters; the cap is ${L.titleChars} (cap titleChars)`);
  } else title = "";
  if (title.length + md.length > OFFICE_LIMITS.totalChars) throw bad(`Input holds more than ${OFFICE_LIMITS.totalChars} characters of text in total (cap totalChars ${OFFICE_LIMITS.totalChars})`);
  return { title, markdown: cleanText(md), filename: fileNameOf(input.filename, "docx", "document") };
}

const LINK_OK = /^(https?:\/\/|mailto:)/i;
const MONO = "Consolas";

/** Builds the docx from markdown. Worker side: marked's lexer and the walk
 *  both run here. Throws a 400 naming the cap when the document is too large. */
export async function buildDocx(spec) {
  const L = OFFICE_LIMITS.docx;
  const [{ Lexer }, D] = await Promise.all([import("marked"), import("docx")]);
  let tokens;
  try {
    tokens = new Lexer({ gfm: true }).lex(spec.markdown);
  } catch (e) {
    if (e instanceof RangeError) throw bad(`"markdown" nests more than ${L.nesting} levels deep (cap nesting)`);
    throw e;
  }
  const cells = docxTableCells(tokens);
  if (cells > L.tableCells) throw bad(`The document's tables hold ${cells} cells (rows times columns, a short row counted at the header's width); the cap is ${L.tableCells} (cap tableCells)`);
  const blocks = [];
  let count = 0;
  let listInstance = 0;
  const push = (p) => {
    if (++count > L.blocks) throw bad(`The document holds more than ${L.blocks} paragraphs, list items and tables; the cap is ${L.blocks} (cap blocks)`);
    blocks.push(p);
  };

  // Inline tokens to runs. `fmt` carries bold/italics/strike/code down.
  const runsOf = (toks, fmt = {}, depth = 0) => {
    const out = [];
    if (!toks) return out;
    if (depth > L.inlineNesting) throw bad(`"markdown" nests inline formatting more than ${L.inlineNesting} levels deep (cap nesting)`);
    for (const t of toks) {
      switch (t.type) {
        case "strong": out.push(...runsOf(t.tokens, { ...fmt, bold: true }, depth + 1)); break;
        case "em": out.push(...runsOf(t.tokens, { ...fmt, italics: true }, depth + 1)); break;
        case "del": out.push(...runsOf(t.tokens, { ...fmt, strike: true }, depth + 1)); break;
        case "codespan": out.push(new D.TextRun({ text: unescape(t.text), ...fmt, font: MONO, shading: { type: D.ShadingType.CLEAR, color: "auto", fill: "F2F2F2" } })); break;
        case "br": out.push(new D.TextRun({ break: 1 })); break;
        case "link": {
          const children = runsOf(t.tokens, { ...fmt, style: "Hyperlink" }, depth + 1);
          if (LINK_OK.test(t.href)) out.push(new D.ExternalHyperlink({ link: t.href, children: children.length ? children : [new D.TextRun({ text: t.href, style: "Hyperlink" })] }));
          else out.push(...runsOf(t.tokens, fmt, depth + 1));
          break;
        }
        case "image": {
          // Written as its alt text and a hyperlink to the source; never fetched.
          const label = `[image: ${t.text || "untitled"}]`;
          if (LINK_OK.test(t.href)) out.push(new D.ExternalHyperlink({ link: t.href, children: [new D.TextRun({ text: label, ...fmt, style: "Hyperlink" })] }));
          else out.push(new D.TextRun({ text: label, ...fmt }));
          break;
        }
        case "text":
          if (t.tokens && t.tokens.length) out.push(...runsOf(t.tokens, fmt, depth + 1));
          else out.push(...textRuns(unescape(t.text), fmt));
          break;
        case "escape": out.push(new D.TextRun({ text: unescape(t.text), ...fmt })); break;
        default: out.push(...textRuns(t.raw ?? t.text ?? "", fmt)); // html and anything else: literal text
      }
    }
    return out;
  };
  const textRuns = (s, fmt) => {
    const lines = String(s).split("\n");
    return lines.map((line, i) => new D.TextRun({ text: line, ...fmt, ...(i > 0 ? { break: 1 } : {}) }));
  };

  const HEADINGS = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3, D.HeadingLevel.HEADING_4, D.HeadingLevel.HEADING_5, D.HeadingLevel.HEADING_6];
  let tables = 0, headings = 0, listItems = 0, codeBlocks = 0, links = 0;
  const countLinks = (toks) => { for (const t of toks || []) { if (t.type === "link" || t.type === "image") links++; if (t.tokens) countLinks(t.tokens); } };

  const blockOf = (t, ctx) => {
    if (ctx.depth > L.nesting) throw bad(`"markdown" nests more than ${L.nesting} levels deep (cap nesting)`);
    const quote = ctx.quote ? { indent: { left: 360 * ctx.quote }, border: { left: { style: D.BorderStyle.SINGLE, size: 12, color: "BFBFBF", space: 8 } } } : {};
    switch (t.type) {
      case "space": return;
      case "heading":
        headings++; countLinks(t.tokens);
        push(new D.Paragraph({ heading: HEADINGS[Math.min(t.depth, 6) - 1], children: runsOf(t.tokens), ...quote }));
        return;
      case "paragraph":
        countLinks(t.tokens);
        push(new D.Paragraph({ children: runsOf(t.tokens, ctx.quote ? { italics: true } : {}), ...quote }));
        return;
      case "text":
        countLinks(t.tokens);
        push(new D.Paragraph({ children: t.tokens ? runsOf(t.tokens) : textRuns(unescape(t.text), {}), ...quote }));
        return;
      case "code": {
        codeBlocks++;
        const lines = t.text.split("\n");
        push(new D.Paragraph({
          children: lines.map((line, i) => new D.TextRun({ text: line, font: MONO, size: 20, ...(i > 0 ? { break: 1 } : {}) })),
          shading: { type: D.ShadingType.CLEAR, color: "auto", fill: "F2F2F2" },
          border: { top: { style: D.BorderStyle.SINGLE, size: 4, color: "D9D9D9", space: 4 }, bottom: { style: D.BorderStyle.SINGLE, size: 4, color: "D9D9D9", space: 4 } },
          ...quote,
        }));
        return;
      }
      case "blockquote":
        for (const c of t.tokens || []) blockOf(c, { ...ctx, depth: ctx.depth + 1, quote: (ctx.quote || 0) + 1 });
        return;
      case "hr":
        push(new D.Paragraph({ children: [], border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: "BFBFBF", space: 1 } } }));
        return;
      case "list": {
        // ctx.depth (capped at L.nesting above) bounds the level below the
        // nine levels a numbering definition holds.
        const level = ctx.listLevel ?? 0;
        const instance = t.ordered ? ++listInstance : 0;
        for (const item of t.items) {
          listItems++;
          const inline = [];
          const nested = [];
          for (const c of item.tokens || []) (c.type === "text" || c.type === "paragraph" ? inline : nested).push(c);
          const runs = [];
          if (item.task) runs.push(new D.TextRun({ text: item.checked ? "\u2611 " : "\u2610 " }));
          inline.forEach((c, i) => { countLinks(c.tokens); if (i > 0) runs.push(new D.TextRun({ break: 1 })); runs.push(...(c.tokens ? runsOf(c.tokens) : textRuns(unescape(c.text), {}))); });
          push(new D.Paragraph({
            children: runs,
            ...(t.ordered ? { numbering: { reference: "ordered", level, instance } } : { bullet: { level } }),
          }));
          for (const c of nested) blockOf(c, { ...ctx, depth: ctx.depth + 1, listLevel: c.type === "list" ? level + 1 : level });
        }
        return;
      }
      case "table": {
        const cols = t.header.length;
        if (cols > L.tableColumns) throw bad(`A table holds ${cols} columns; the cap is ${L.tableColumns} (cap tableColumns)`);
        if (t.rows.length + 1 > L.tableRows) throw bad(`A table holds ${t.rows.length + 1} rows; the cap is ${L.tableRows} (cap tableRows)`);
        tables++;
        const align = (a) => (a === "center" ? D.AlignmentType.CENTER : a === "right" ? D.AlignmentType.RIGHT : D.AlignmentType.LEFT);
        const cell = (c, ci, head) => new D.TableCell({
          children: [new D.Paragraph({ alignment: align(t.align[ci]), children: runsOf(c.tokens, head ? { bold: true } : {}) })],
          ...(head ? { shading: { type: D.ShadingType.CLEAR, color: "auto", fill: "D9E1F2" } } : {}),
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
        });
        const rows = [
          new D.TableRow({ tableHeader: true, children: t.header.map((c, ci) => cell(c, ci, true)) }),
          ...t.rows.map((r) => new D.TableRow({ children: Array.from({ length: cols }, (_, ci) => cell(r[ci] ?? { tokens: [] }, ci, false)) })),
        ];
        if (++count > L.blocks) throw bad(`The document holds more than ${L.blocks} paragraphs, list items and tables; the cap is ${L.blocks} (cap blocks)`);
        blocks.push(new D.Table({ rows, width: { size: 100, type: D.WidthType.PERCENTAGE } }));
        blocks.push(new D.Paragraph({ children: [] }));
        return;
      }
      default:
        if (t.raw && t.raw.trim()) push(new D.Paragraph({ children: textRuns(t.raw.trim(), {}), ...quote }));
    }
  };

  if (spec.title) push(new D.Paragraph({ heading: D.HeadingLevel.TITLE, children: [new D.TextRun({ text: spec.title })] }));
  for (const t of tokens) blockOf(t, { depth: 0 });

  const levels = Array.from({ length: 9 }, (_, level) => ({
    level,
    format: [D.LevelFormat.DECIMAL, D.LevelFormat.LOWER_LETTER, D.LevelFormat.LOWER_ROMAN][level % 3],
    text: `%${level + 1}.`,
    alignment: D.AlignmentType.START,
    style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
  }));
  const doc = new D.Document({
    creator: "Agent402.Tools",
    title: spec.title || undefined,
    description: "Created by docx-create",
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    numbering: { config: [{ reference: "ordered", levels }] },
    sections: [{ children: blocks.length ? blocks : [new D.Paragraph({ children: [] })] }],
  });
  const buffer = await D.Packer.toBuffer(doc);
  return { buffer, stats: { blocks: count, headings, tables, listItems, codeBlocks, links } };
}

/** Table cells the document would build, summed over every table at any
 *  depth (quotes, lists): each row is padded to its header's width, so a table
 *  costs (rows + 1) x columns. Read from the token tree before any cell is
 *  built; an explicit stack, so a deep tree cannot overflow the call stack. */
export function docxTableCells(tokens) {
  let cells = 0;
  const stack = [tokens];
  while (stack.length) {
    for (const t of stack.pop() || []) {
      if (t.type === "table") cells += ((t.rows?.length || 0) + 1) * (t.header?.length || 0);
      else if (t.type === "blockquote") stack.push(t.tokens);
      else if (t.type === "list") for (const item of t.items || []) stack.push(item.tokens);
    }
  }
  return cells;
}

// marked keeps HTML entities escaped in token text; the document wants the characters.
function unescape(s) {
  return String(s).replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e]));
}

// ---- pptx ------------------------------------------------------------------

function textField(v, where, max, take, { required = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw bad(`${where} is required`);
    return "";
  }
  if (typeof v !== "string" && typeof v !== "number") throw bad(`${where} must be a string`);
  const s = cleanText(v);
  if (s.length > max) throw bad(`${where} holds ${s.length} characters; the cap is ${max}`);
  return take(s);
}

/** Validates and normalizes a pptx-create input. Main thread; linear. */
export function validatePptx(input) {
  const L = OFFICE_LIMITS.pptx;
  const take = charBudget();
  const slides = parseMaybeJson(input.slides, "slides");
  if (!Array.isArray(slides) || !slides.length) throw bad('Send "slides": [{"title":"Q3 results","bullets":["Revenue up 12%","Two new markets"]}]');
  const deckTitle = textField(input.title, '"title"', L.titleChars, take);
  const subtitle = textField(input.subtitle, '"subtitle"', L.titleChars, take);
  if (slides.length + (deckTitle ? 1 : 0) > L.slides) throw bad(`The deck holds ${slides.length + (deckTitle ? 1 : 0)} slides; the cap is ${L.slides} (cap slides)`);
  const out = slides.map((s, i) => {
    const at = `slides[${i}]`;
    if (!s || typeof s !== "object" || Array.isArray(s)) throw bad(`${at} must be an object with "title" and "bullets"`);
    const title = textField(s.title, `${at}.title`, L.titleChars, take);
    const rawBullets = parseMaybeJson(s.bullets ?? [], `${at}.bullets`);
    if (!Array.isArray(rawBullets)) throw bad(`${at}.bullets must be an array of strings or {"text","level"} objects`);
    if (rawBullets.length > L.bullets) throw bad(`${at}.bullets holds ${rawBullets.length} bullets; the cap is ${L.bullets} per slide (cap bullets)`);
    const bullets = rawBullets.map((b, bi) => {
      const obj = b && typeof b === "object" && !Array.isArray(b) ? b : { text: b };
      const level = obj.level ?? 0;
      if (!Number.isInteger(level) || level < 0 || level > 4) throw bad(`${at}.bullets[${bi}].level must be an integer from 0 to 4`);
      return { text: textField(obj.text, `${at}.bullets[${bi}]`, L.bulletChars, take, { required: true }), level };
    });
    if (s.numbered !== undefined && typeof s.numbered !== "boolean") throw bad(`${at}.numbered must be true or false`);
    let table = null;
    if (s.table !== undefined && s.table !== null) {
      const raw = parseMaybeJson(s.table, `${at}.table`);
      const t = Array.isArray(raw) ? { rows: raw } : raw;
      if (!t || typeof t !== "object" || !Array.isArray(t.rows)) throw bad(`${at}.table must be {"header":[...],"rows":[[...]]} or an array of rows`);
      const header = t.header === undefined || t.header === null ? null : t.header;
      if (header !== null && !Array.isArray(header)) throw bad(`${at}.table.header must be an array`);
      const all = header ? [header, ...t.rows] : t.rows;
      if (all.length > L.tableRows) throw bad(`${at}.table holds ${all.length} rows; the cap is ${L.tableRows} (cap tableRows)`);
      if (!all.length) throw bad(`${at}.table has no rows`);
      const cols = all.reduce((m, r) => {
        if (!Array.isArray(r)) throw bad(`${at}.table rows must be arrays`);
        return Math.max(m, r.length);
      }, 0);
      if (cols > L.tableColumns) throw bad(`${at}.table holds ${cols} columns; the cap is ${L.tableColumns} (cap tableColumns)`);
      if (!cols) throw bad(`${at}.table has no columns`);
      const cellText = (v, where) => (v === null || v === undefined ? "" : textField(typeof v === "object" ? JSON.stringify(v) : typeof v === "boolean" ? String(v) : v, where, L.cellChars, take));
      table = {
        header: !!header,
        rows: all.map((r, ri) => Array.from({ length: cols }, (_, ci) => cellText(r[ci], `${at}.table row ${ri + 1} cell ${ci + 1}`))),
      };
    }
    const notes = textField(s.notes, `${at}.notes`, L.notesChars, take);
    if (!title && !bullets.length && !table) throw bad(`${at} needs a "title", "bullets" or a "table"`);
    return { title, bullets, numbered: s.numbered === true, table, notes };
  });
  return { title: deckTitle, subtitle, slides: out, filename: fileNameOf(input.filename, "pptx", "presentation") };
}

const W = 13.333, PAD = 0.5;
export async function buildPptx(spec) {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE";
  pres.author = "Agent402.Tools";
  pres.company = "";
  if (spec.title) pres.title = spec.title;
  const ink = "1F2937", muted = "4B5563";
  if (spec.title) {
    const s = pres.addSlide();
    s.addText(spec.title, { x: PAD, y: 2.4, w: W - 2 * PAD, h: 1.4, fontFace: "Calibri", fontSize: 40, bold: true, color: ink, align: "center", valign: "middle", fit: "shrink" });
    if (spec.subtitle) s.addText(spec.subtitle, { x: PAD, y: 3.9, w: W - 2 * PAD, h: 0.8, fontFace: "Calibri", fontSize: 22, color: muted, align: "center", valign: "top", fit: "shrink" });
  }
  for (const sl of spec.slides) {
    const s = pres.addSlide();
    let top = PAD;
    if (sl.title) {
      s.addText(sl.title, { x: PAD, y: 0.35, w: W - 2 * PAD, h: 0.9, fontFace: "Calibri", fontSize: 30, bold: true, color: ink, valign: "middle", fit: "shrink" });
      top = 1.4;
    }
    const bottom = 7.5 - 0.4;
    const avail = bottom - top;
    const bulletH = sl.bullets.length ? (sl.table ? Math.min(avail * 0.4, 0.45 * sl.bullets.length + 0.2) : avail) : 0;
    if (sl.bullets.length) {
      const size = sl.bullets.length > 12 ? 14 : sl.bullets.length > 7 ? 18 : 22;
      s.addText(
        sl.bullets.map((b) => ({ text: b.text, options: { bullet: sl.numbered ? { type: "number" } : true, indentLevel: b.level, breakLine: true } })),
        { x: PAD, y: top, w: W - 2 * PAD, h: bulletH, fontFace: "Calibri", fontSize: size, color: ink, valign: "top", paraSpaceAfter: 6, fit: "shrink" },
      );
    }
    if (sl.table) {
      const y = top + bulletH + (sl.bullets.length ? 0.2 : 0);
      const rows = sl.table.rows.map((r, ri) => r.map((text) => ({
        text,
        options: sl.table.header && ri === 0 ? { bold: true, fill: { color: "D9E1F2" }, color: ink } : { color: ink },
      })));
      const fontSize = rows.length > 15 ? 10 : rows.length > 8 ? 12 : 14;
      s.addTable(rows, { x: PAD, y, w: W - 2 * PAD, fontFace: "Calibri", fontSize, border: { type: "solid", pt: 0.75, color: "BFBFBF" }, valign: "middle", autoPage: false });
    }
    if (sl.notes) s.addNotes(sl.notes);
  }
  // stream() is the writer's one Node buffer output that honors compression
  // (write() with an outputType stores every part uncompressed).
  const out = await pres.stream({ compression: true });
  return Buffer.from(out);
}

/** The worker's entry: one op name to one builder. Each answers
 *  { base64, bytes, stats? } and refuses an oversized file with a 422. */
export const OFFICE_OPS = {
  async xlsx(spec) { return finish(await buildXlsx(spec)); },
  async docx(spec) { const { buffer, stats } = await buildDocx(spec); return { ...finish(buffer), stats }; },
  async pptx(spec) { return finish(await buildPptx(spec)); },
};

/** The finished file as base64, or a 422 past the output cap. */
export function finish(buffer, cap = OFFICE_LIMITS.outputBytes) {
  if (buffer.length > cap) throw bad(`The file would be ${buffer.length} bytes; the cap is ${cap} (cap outputBytes)`, 422);
  return { base64: Buffer.from(buffer).toString("base64"), bytes: buffer.length };
}
