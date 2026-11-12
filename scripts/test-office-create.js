// scripts/test-office-create.js
// Tests for src/tools/office-kit.js (xlsx-create, docx-create, pptx-create),
// office-ops.js, office-pool.js and office-worker.js. Offline: nothing listens
// and nothing is fetched.
//   - Each file is opened with this script's own zip reader (central directory
//     plus node:zlib, nothing shared with the writers) and its XML parts are
//     checked for the content that was sent.
//   - xlsx: every cell is a literal; text that starts with = + - @ is a text
//     cell with the Text format and no formula element anywhere.
//   - Every cap answers a 400 that names it; the output cap answers a 422; the
//     input depth guard applies; a job past its deadline answers 422 and the
//     pool keeps serving.
//   - No egress: fetch, http(s), net, tls and dns are stubbed and counted
//     while every builder runs in this thread on inputs full of URLs.
//   - Timing: the largest input each cap allows is validated and built, and
//     the event loop is sampled while the worker builds it.
//   - docx table cells are capped across the whole document before any cell is
//     built; xlsx cells are counted before the grid is allocated; a job that
//     waits in the queue past its deadline answers the busy 503 unbuilt.
//   - The caller path: a FREE_MODE boot on port 0 serves inputs near each
//     published cap over HTTP (bodies past the global 100 KB parser).
//
//   node scripts/test-office-create.js
import "./lib/offline-stores.js";
import { oursMs } from "./lib/ours-clock.js";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ownStoreEnv } from "./lib/own-stores.js";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import { inflateRawSync } from "node:zlib";
import { syncBuiltinESMExports } from "node:module";
import { OFFICE_TOOLS } from "../src/tools/office-kit.js";
import { OFFICE_LIMITS, OFFICE_OPS, OFFICE_TYPES, validateXlsx, validateDocx, validatePptx, finish, docxTableCells } from "../src/tools/office-ops.js";
import { runOfficeOp, officePoolState, OFFICE_POOL_MAX } from "../src/tools/office-pool.js";
import { handlerInputOf } from "../src/handler-input.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";
import { TYPICAL_PRICE_RANGE } from "../src/typical-price-range.js";

let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`ASSERT FAIL - ${m}`); } };
async function refuses(fn, status, pattern, label) {
  try { await fn(); fail++; console.error(`ASSERT FAIL - ${label} (did not throw)`); }
  catch (e) {
    if (e.statusCode === status && pattern.test(e.message)) { pass++; console.log(`ok - ${label} -> ${status}`); }
    else { fail++; console.error(`ASSERT FAIL - ${label}: expected ${status} ${pattern}, got ${e.statusCode} (${e.message})`); }
  }
}
const tool = (slug) => OFFICE_TOOLS.find((t) => t.slug === slug);

// ---- an independent zip reader ---------------------------------------------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip: no end of central directory");
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    files.set(name, (method === 0 ? raw : inflateRawSync(raw)).toString("utf8"));
    p += 46 + nlen + xlen + clen;
  }
  return files;
}
const decodeXml = (s) => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (_, e, d, h) => (d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }[e]));
const texts = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g"))].map((m) => decodeXml(m[1]));
const fileOf = (answer) => Buffer.from(answer[Object.keys(answer).find((k) => k.endsWith("Base64"))], "base64");

/** The cells of one xlsx sheet: { A1: { type, value, numFmt, bold, fill } }. */
function readXlsx(buf) {
  const f = unzip(buf);
  const shared = (f.get("xl/sharedStrings.xml") || "").split("</si>").slice(0, -1).map((si) => texts(si, "t").join(""));
  const styles = f.get("xl/styles.xml") || "";
  const numFmts = new Map([...styles.matchAll(/<numFmt [^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].map((m) => [m[1], decodeXml(m[2])]));
  const fonts = (styles.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/)?.[1] || "").split("</font>").slice(0, -1);
  const fills = (styles.match(/<fills[^>]*>([\s\S]*?)<\/fills>/)?.[1] || "").split("</fill>").slice(0, -1);
  const xfs = [...(styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || "").matchAll(/<xf\b([^>]*)>/g)].map((m) => m[1]);
  const attr = (s, a) => s.match(new RegExp(`\\b${a}="([^"]*)"`))?.[1];
  const workbook = f.get("xl/workbook.xml");
  const names = [...workbook.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]));
  const sheets = {};
  names.forEach((name, i) => {
    const xml = f.get(`xl/worksheets/sheet${i + 1}.xml`);
    const cells = {};
    for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = m[1], body = m[2] || "";
      const t = attr(a, "t") || "n", s = attr(a, "s");
      const v = body.match(/<v>([^<]*)<\/v>/)?.[1];
      const xf = s !== undefined ? xfs[+s] || "" : "";
      const fmtId = attr(xf, "numFmtId");
      const font = fonts[+(attr(xf, "fontId") || 0)] || "";
      const fill = fills[+(attr(xf, "fillId") || 0)] || "";
      cells[attr(a, "r")] = {
        type: t, formula: /<f[\s>]/.test(body),
        value: t === "s" ? shared[+v] : t === "inlineStr" ? texts(body, "t").join("") : t === "b" ? v === "1" : v === undefined ? null : Number(v),
        numFmt: fmtId === "49" ? "@" : numFmts.get(fmtId) ?? (fmtId ? `builtin:${fmtId}` : "General"),
        bold: /<b\/>|<b\s/.test(font), fill: fill.match(/<fgColor rgb="([0-9A-F]+)"/)?.[1] || null,
      };
    }
    sheets[name] = { xml, cells, frozen: /state="frozen"/.test(xml), widths: [...xml.matchAll(/<col\b[^>]*width="([\d.]+)"/g)].map((m) => +m[1]) };
  });
  return { files: f, names, sheets, anyFormula: [...f.entries()].some(([k, x]) => k.startsWith("xl/worksheets/") && /<f[\s>]/.test(x)) };
}

// ---- egress stubs ------------------------------------------------------------
const egress = [];
const real = { fetch: globalThis.fetch, hr: http.request, hg: http.get, sr: https.request, sg: https.get, nc: net.connect, ncc: net.createConnection, tc: tls.connect, dl: dns.lookup, dpl: dns.promises.lookup, r4: dns.promises.Resolver.prototype.resolve4, r6: dns.promises.Resolver.prototype.resolve6 };
function stubEgress() {
  const rec = (what) => (...args) => { egress.push({ what, target: String(args[0]?.href ?? args[0]?.host ?? args[0]) }); throw new Error(`egress refused in test: ${what}`); };
  globalThis.fetch = async (...a) => rec("fetch")(...a);
  http.request = rec("http.request"); http.get = rec("http.get");
  https.request = rec("https.request"); https.get = rec("https.get");
  net.connect = rec("net.connect"); net.createConnection = rec("net.createConnection");
  tls.connect = rec("tls.connect"); dns.lookup = rec("dns.lookup"); dns.promises.lookup = async (...a) => rec("dns.promises.lookup")(...a);
  dns.promises.Resolver.prototype.resolve4 = async (...a) => rec("resolve4")(...a); dns.promises.Resolver.prototype.resolve6 = async (...a) => rec("resolve6")(...a);
  syncBuiltinESMExports();
}
function restoreEgress() {
  globalThis.fetch = real.fetch; http.request = real.hr; http.get = real.hg; https.request = real.sr; https.get = real.sg;
  net.connect = real.nc; net.createConnection = real.ncc; tls.connect = real.tc; dns.lookup = real.dl; dns.promises.lookup = real.dpl;
  dns.promises.Resolver.prototype.resolve4 = real.r4; dns.promises.Resolver.prototype.resolve6 = real.r6;
  syncBuiltinESMExports();
}
/** Validate and build in THIS thread (where the stubs apply). */
async function buildHere(op, input) {
  const spec = { xlsx: validateXlsx, docx: validateDocx, pptx: validatePptx }[op](input);
  const out = await OFFICE_OPS[op](spec);
  return { spec, buf: Buffer.from(out.base64, "base64"), out };
}

// ----------------------------------------------------------------------------
// Catalog envelope
// ----------------------------------------------------------------------------
ok(OFFICE_TOOLS.length === 3 && ["xlsx-create", "docx-create", "pptx-create"].every((s) => tool(s)), "three tools: xlsx-create, docx-create, pptx-create");
for (const t of OFFICE_TOOLS) {
  const usd = Number(t.price.replace("$", ""));
  ok(usd >= TYPICAL_PRICE_RANGE.minUsd && usd <= TYPICAL_PRICE_RANGE.maxUsd, `${t.slug} price ${t.price} sits inside ${TYPICAL_PRICE_RANGE.text}`);
  ok(!FREE_TIER_SLUGS.has(t.slug), `${t.slug} is wallet-only (not on the free-tier allowlist)`);
  ok(t.route === `POST /api/${t.slug}` && t.category && t.description && t.tags.length && t.discovery?.inputSchema && t.discovery?.input && t.discovery?.output?.example, `${t.slug} carries the full tool def`);
  ok(!/\u2014/.test(t.description) && !/\bdeterministic\b/i.test(t.description), `${t.slug} description: no em dash, no unscoped absolute`);
  ok(t.description.includes(`up to ${OFFICE_LIMITS.requestBytes / (1024 * 1024)} MB`), `${t.slug} description states the request body cap`);
}
// pptxgenjs's "shrink" applies only once PowerPoint edits the text, so the copy
// says what the builder does: the font size steps by bullet and row count.
ok(!/shrink/i.test(tool("pptx-create").description) && /font size steps down/.test(tool("pptx-create").description), "pptx-create description claims no shrink-to-fit; it names the font-size steps");
ok(tool("docx-create").description.includes(`${OFFICE_LIMITS.docx.tableCells.toLocaleString("en-US")} table cells`), "docx-create description publishes the tableCells cap");
void WALLET_ONLY_SLUGS;

// ----------------------------------------------------------------------------
// Published examples through the handlers (pool + worker)
// ----------------------------------------------------------------------------
for (const t of OFFICE_TOOLS) {
  const out = await t.handler(structuredClone(t.discovery.input));
  const ex = t.discovery.output.example;
  ok(Object.keys(ex).every((k) => k in out), `${t.slug} example answers every documented key (${Object.keys(ex).join(", ")})`);
  const buf = fileOf(out);
  ok(buf.length === out.bytes && buf.subarray(0, 2).toString() === "PK", `${t.slug} example returns a zip of the stated size (${out.bytes} bytes)`);
  ok(out.contentType === OFFICE_TYPES[t.slug.slice(0, 4)], `${t.slug} content type ${out.contentType}`);
  ok(unzip(buf).has("[Content_Types].xml"), `${t.slug} example opens with an independent zip reader`);
}

// ----------------------------------------------------------------------------
// xlsx: content, styling and the literal-value rule
// ----------------------------------------------------------------------------
{
  const input = {
    sheets: [
      {
        name: "Data",
        rows: [
          ["Name", "Amount", "Flag", "Note"],
          ["=1+1", 1234.5, true, "+cmd|' /C calc'!A0"],
          ["-2+3", -7, false, "@SUM(A1:A2)"],
          ["\tTab lead", 0.25, null, "plain"],
          ["Ada", 42, true, { nested: [1, 2] }],
          ["Line one\nLine two", 1e6, false, "https://example.com/x.png"],
        ],
        numberFormats: { Amount: "#,##0.00", C: "0%" },
        columnWidths: [30],
        headerStyle: { fill: "#FFEEAA", color: "#112233" },
      },
      { name: "People", rows: [{ id: 2, name: "Lin", extra: "x" }, { id: 1, name: "=HYPERLINK(\"http://example.com\")" }], columns: ["name", "id"] },
      { name: "Raw", rows: [["a", "b"], ["c", "d"]], header: false },
    ],
    filename: "report",
  };
  egress.length = 0; stubEgress();
  const { buf, spec } = await buildHere("xlsx", input);
  restoreEgress();
  ok(egress.length === 0, `xlsx build made no network call (${egress.length})`);
  ok(spec.filename === "report.xlsx", "filename gets its extension");
  const x = readXlsx(buf);
  ok(x.names.join("|") === "Data|People|Raw", "three sheets in order with their names");
  ok(!x.anyFormula, "no worksheet holds a formula element");
  const d = x.sheets.Data.cells;
  ok(d.A1.value === "Name" && d.A1.bold && d.A1.fill === "FFFFEEAA", "header row is bold with the requested fill");
  ok(x.sheets.Data.frozen && !x.sheets.Raw.frozen, "header row is frozen; a sheet without a header is not");
  for (const ref of ["A2", "A3", "A4", "D2", "D3"]) {
    ok(d[ref].type === "s" && !d[ref].formula && d[ref].numFmt === "@", `${ref} ${JSON.stringify(d[ref].value)} is a text cell with the Text format, not a formula`);
  }
  ok(d.A2.value === "=1+1" && d.A3.value === "-2+3" && d.D3.value === "@SUM(A1:A2)" && d.A4.value === "\tTab lead", "formula-looking text reads back literally");
  ok(d.B2.type === "n" && d.B2.value === 1234.5 && d.B2.numFmt === "#,##0.00", "number keeps its value and column format (by header text)");
  ok(d.B3.value === -7 && d.C4 === undefined || d.C4?.value === null, "negative number literal; null leaves the cell empty");
  ok(d.C2.type === "b" && d.C2.value === true && d.C3.value === false, "booleans are boolean cells");
  ok(d.B4.value === 0.25 && d.A5.type === "s" && d.A5.numFmt === "General", "plain text keeps the General format");
  ok(d.D5.value === '{"nested":[1,2]}', "a nested value is written as its JSON text");
  ok(d.A6.value === "Line one\nLine two", "multi-line text survives");
  ok(x.sheets.Data.widths[0] === 30 && x.sheets.Data.widths.length === 4 && x.sheets.Data.widths.slice(1).every((w) => w >= 8 && w <= 60), "column widths: given width kept, the rest auto-sized");
  const p = x.sheets.People.cells;
  ok(p.A1.value === "name" && p.B1.value === "id" && p.C1 === undefined, "object rows follow the columns order; unlisted keys are left out");
  ok(p.A3.value === '=HYPERLINK("http://example.com")' && p.A3.type === "s" && p.A3.numFmt === "@", "a formula string in object rows stays text");
  ok(x.sheets.Raw.cells.A1.value === "a" && !x.sheets.Raw.cells.A1.bold, "header false: first row is plain data");
  ok(![...x.files.values()].some((xml) => /TargetMode="External"/.test(xml)), "no external relationship is written for a URL in a cell");

  // Control characters an XML part cannot carry, and lone surrogates, never reach a part.
  const ctl = readXlsx((await buildHere("xlsx", { rows: [["a\u0001b\u0008c", "x\uD800y"]], header: false })).buf);
  ok(ctl.sheets.Sheet1.cells.A1.value === "abc" && /^x\uFFFD?y$/.test(ctl.sheets.Sheet1.cells.B1.value), "control characters and a lone surrogate never reach the XML");
}

// ----------------------------------------------------------------------------
// docx: markdown structures
// ----------------------------------------------------------------------------
{
  const md = [
    "# Top heading", "", "## Second", "", "A paragraph with **bold**, *italic*, ~~gone~~ and `code` plus a [link](https://agent402.tools/status).",
    "", "![diagram](https://example.com/diagram.png)", "", "- one", "- two", "  - nested", "", "1. first", "2. second", "",
    "- [x] done", "- [ ] todo", "", "| H1 | H2 |", "|:--|--:|", "| a | 1 |", "| b | 2 |", "", "```js", "const x = 1;", "console.log(x);", "```",
    "", "> quoted text", "", "---", "", "[local](javascript:alert(1)) and <b>raw html</b> & ampersand",
  ].join("\n");
  egress.length = 0; stubEgress();
  const { buf, out } = await buildHere("docx", { title: "Doc title", markdown: md });
  restoreEgress();
  ok(egress.length === 0, `docx build made no network call (${egress.length}); the image was not fetched`);
  const f = unzip(buf);
  const doc = f.get("word/document.xml");
  const rels = f.get("word/_rels/document.xml.rels");
  const all = texts(doc, "w:t").join("");
  ok(/w:val="Title"/.test(doc) && all.startsWith("Doc title"), "title paragraph uses the Title style");
  ok(/w:val="Heading1"/.test(doc) && /w:val="Heading2"/.test(doc), "headings map to Heading1 and Heading2");
  ok(/<w:b\/>/.test(doc) && /<w:i\/>/.test(doc) && /<w:strike\/>/.test(doc), "bold, italic and strikethrough runs");
  ok(/w:ascii="Consolas"/.test(doc) && all.includes("const x = 1;") && all.includes("console.log(x);"), "code block in a monospace font, lines kept");
  ok((doc.match(/<w:numPr>/g) || []).length >= 7, "list items carry numbering properties");
  ok(/<w:tbl>/.test(doc) && all.includes("H1") && all.includes("H2") && /<w:tblHeader\/>/.test(doc), "table with a repeated header row");
  ok(/<w:hyperlink [^>]*r:id="[^"]+"/.test(doc) && /Target="https:\/\/agent402\.tools\/status" TargetMode="External"/.test(rels), "link is an external hyperlink");
  ok(all.includes("[image: diagram]") && /Target="https:\/\/example\.com\/diagram\.png" TargetMode="External"/.test(rels), "image written as alt text linked to its address");
  ok(![...f.keys()].some((k) => k.startsWith("word/media/") && !k.endsWith("/")), "no media part: nothing was embedded");
  ok(!/javascript:/.test(rels) && all.includes("local"), "a javascript: link is written as plain text");
  ok(all.includes("<b>raw html</b>") && all.includes("& ampersand"), "inline HTML is literal text; entities decoded once");
  ok(all.includes("\u2611") && all.includes("\u2610"), "task list items show their boxes");
  ok(/<w:pBdr>/.test(doc), "rule and quote borders written");
  ok(out.stats.tables === 1 && out.stats.headings === 2 && out.stats.links === 3 && out.stats.codeBlocks === 1 && out.stats.listItems === 7, `stats count what was written (${JSON.stringify(out.stats)})`);
  ok(/<dc:title>Doc title<\/dc:title>/.test(f.get("docProps/core.xml") || ""), "title in the document properties");
}

// ----------------------------------------------------------------------------
// pptx: slides, bullets, tables and notes
// ----------------------------------------------------------------------------
{
  const input = {
    title: "Deck", subtitle: "Sub",
    slides: [
      { title: "One", bullets: ["alpha https://example.com/a.png", { text: "beta", level: 1 }, { text: "gamma", level: 2 }], notes: "Say alpha first." },
      { title: "Two", numbered: true, bullets: ["first", "second"], table: { header: ["Col A", "Col B"], rows: [["r1", 1], ["r2", true]] } },
      { table: [["x", "y"], ["=1+1", null]] },
    ],
  };
  egress.length = 0; stubEgress();
  const { buf } = await buildHere("pptx", input);
  restoreEgress();
  ok(egress.length === 0, `pptx build made no network call (${egress.length})`);
  const f = unzip(buf);
  const slides = [...f.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
  ok(slides.length === 4, `title slide plus three slides (${slides.length})`);
  const s = slides.map((k) => texts(f.get(k), "a:t").join("|"));
  ok(s[0] === "Deck|Sub", "title slide carries title and subtitle");
  ok(s[1].startsWith("One|alpha https://example.com/a.png|beta|gamma"), "bullets in order");
  ok(/lvl="1"/.test(f.get(slides[1])) && /lvl="2"/.test(f.get(slides[1])), "bullet levels written");
  ok(/<a:buAutoNum /.test(f.get(slides[2])), "numbered slide uses auto numbering");
  ok(/<a:tbl>/.test(f.get(slides[2])) && s[2].includes("Col A") && s[2].includes("r2") && s[2].includes("true"), "table cells written");
  ok(/<a:tbl>/.test(f.get(slides[3])) && s[3].includes("=1+1"), "table-only slide; formula-looking text is plain text");
  const notes = [...f.keys()].filter((k) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(k)).map((k) => texts(f.get(k), "a:t").join(""));
  ok(notes.some((n) => n.includes("Say alpha first.")), "speaker notes written");
  ok(![...f.keys()].some((k) => k.startsWith("ppt/media/") && !k.endsWith("/")), "no media part: nothing was embedded");
  ok(/<dc:title>Deck<\/dc:title>/.test(f.get("docProps/core.xml") || ""), "deck title in the document properties");
}

// ----------------------------------------------------------------------------
// Layout as the file opens: what a reader sees before editing anything
// ----------------------------------------------------------------------------
const P_TITLE_MAX = OFFICE_LIMITS.pptx.titleChars;
{
  // A formatted number is sized at its shown width: a column narrower than
  // "$98,000.00" opens as ##### in Excel.
  const { buf } = await buildHere("xlsx", { rows: [["amount"], [98000], [1234.5], [-42.1]], numberFormats: ["$#,##0.00"] });
  const sheet = unzip(buf).get("xl/worksheets/sheet1.xml");
  const width = Number(/<col [^>]*min="1"[^>]*width="([\d.]+)"/.exec(sheet)?.[1]);
  ok(width >= "$98,000.00".length + 1, `a currency-formatted column is as wide as its shown value (width ${width} for "$98,000.00")`);
  // Quoted text, a negatives section in parentheses and scientific notation print too.
  for (const [v, fmt, shown] of [[123456, '0" units"', "123456 units"], [98000, '"Total: "#,##0', "Total: 98,000"], [-1234.5, "#,##0.00;(#,##0.00)", "(1,234.50)"], [12345.678, "0.00E+00", "1.23E+04"]]) {
    const { buf: b } = await buildHere("xlsx", { rows: [["v"], [v]], numberFormats: [fmt], header: true });
    const w = Number(/<col [^>]*min="1"[^>]*width="([\d.]+)"/.exec(unzip(b).get("xl/worksheets/sheet1.xml"))?.[1]);
    ok(w >= shown.length + 1, `format ${fmt} is sized for "${shown}" (width ${w})`);
  }
}
{
  // A task item writes its box once: the list token's checkbox is not a block of its own.
  const { buf } = await buildHere("docx", { markdown: "- [x] done\n- [ ] todo" });
  const paras = (unzip(buf).get("word/document.xml").match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).map((p) => texts(p, "w:t").join("")).filter(Boolean);
  ok(paras.length === 2 && paras[0] === "☑ done" && paras[1] === "☐ todo", `task items are one paragraph each, with no stray marker (${JSON.stringify(paras)})`);
}
{
  // PowerPoint shrinks text only after it is edited, so the deck chooses its
  // sizes: 30 bullets fit their box as opened, and a two-line title fits its own.
  const longTitle = "A very long slide title that keeps going to see how the layout handles wrapping across the top";
  const { buf } = await buildHere("pptx", { slides: [{ title: "Many", bullets: Array.from({ length: 30 }, (_, i) => `Point number ${i + 1} with a little supporting text`) }, { title: longTitle, bullets: ["Short"] }] });
  const f = unzip(buf);
  const shapes = (k) => (f.get(k).match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []).map((x) => ({ cy: Number(/<a:ext cx="\d+" cy="(\d+)"/.exec(x)?.[1]) / 12700, sz: Number(/ sz="(\d+)"/.exec(x)?.[1]) / 100, paras: (x.match(/<a:p>/g) || []).length }));
  const [title1, body1] = shapes("ppt/slides/slide1.xml");
  const needPt = body1.paras * body1.sz * 1.45;
  ok(body1.paras === 30 && needPt <= body1.cy, `30 bullets fit their box as opened (${body1.sz} pt: about ${Math.round(needPt)} pt of lines in a ${Math.round(body1.cy)} pt box)`);
  {
    // Every numbered paragraph names its own place in its level's count, so a
    // viewer that reads startAt as a restart still numbers 1, 2, 3.
    const { buf: nb } = await buildHere("pptx", { slides: [{ title: "Plan", numbered: true, bullets: ["Ship", { text: "Export", level: 1 }, { text: "Status", level: 1 }, "Hire", { text: "Two", level: 1 }, "Review"] }] });
    const starts = [...unzip(nb).get("ppt/slides/slide1.xml").matchAll(/<a:buAutoNum [^>]*startAt="(\d+)"/g)].map((m) => Number(m[1]));
    ok(JSON.stringify(starts) === "[1,1,2,2,1,3]", `numbered bullets carry their place per level (startAt ${JSON.stringify(starts)})`);
  }
  {
    // The longest title the cap allows still fits its box.
    const { buf: tb } = await buildHere("pptx", { slides: [{ title: "Long title words ".repeat(18).slice(0, P_TITLE_MAX), bullets: ["x"] }] });
    const [t] = (unzip(tb).get("ppt/slides/slide1.xml").match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []).map((x) => ({ cy: Number(/<a:ext cx="\d+" cy="(\d+)"/.exec(x)?.[1]) / 12700, sz: Number(/ sz="(\d+)"/.exec(x)?.[1]) / 100 }));
    const perLine = Math.floor(((13.333 - 1 - 0.4) * 72) / (t.sz * 0.5)), lines = Math.ceil(P_TITLE_MAX / perLine);
    ok(lines * t.sz * 1.2 <= t.cy, `a ${P_TITLE_MAX}-character title fits its box (${t.sz} pt, ${lines} lines in ${Math.round(t.cy)} pt)`);
  }
  const [title2] = shapes("ppt/slides/slide2.xml");
  ok(title1.sz === 30 && title2.sz < 30 && 2 * title2.sz * 1.2 <= title2.cy, `a title that wraps to two lines steps down to fit its box (${title2.sz} pt in ${Math.round(title2.cy)} pt; a short title stays ${title1.sz} pt)`);
}

// ----------------------------------------------------------------------------
// Caps: each refused with a 400 that names it
// ----------------------------------------------------------------------------
const X = OFFICE_LIMITS.xlsx, D = OFFICE_LIMITS.docx, P = OFFICE_LIMITS.pptx;
const xh = tool("xlsx-create").handler, dh = tool("docx-create").handler, ph = tool("pptx-create").handler;
await refuses(() => xh({ sheets: Array.from({ length: X.sheets + 1 }, (_, i) => ({ name: `S${i}`, rows: [[1]] })) }), 400, /cap sheets/, `xlsx: ${X.sheets + 1} sheets`);
await refuses(() => xh({ rows: Array.from({ length: X.rowsPerSheet + 1 }, () => [1]) }), 400, /cap rowsPerSheet/, `xlsx: ${X.rowsPerSheet + 1} rows`);
await refuses(() => xh({ rows: [Array.from({ length: X.columns + 1 }, () => 1)] }), 400, /cap columns/, `xlsx: ${X.columns + 1} columns`);
await refuses(() => xh({ rows: [Object.fromEntries(Array.from({ length: X.columns + 1 }, (_, i) => [`k${i}`, 1]))] }), 400, /cap columns/, `xlsx: ${X.columns + 1} object keys`);
await refuses(() => xh({ sheets: Array.from({ length: 6 }, (_, i) => ({ name: `S${i}`, rows: Array.from({ length: 10_000 }, () => [1]) })) }), 400, /cap cells/, `xlsx: more than ${X.cells} cells`);
await refuses(() => xh({ rows: [["x".repeat(X.cellChars + 1)]] }), 400, /cap cellChars/, "xlsx: one cell past 32,767 characters");
await refuses(() => xh({ rows: Array.from({ length: 4 }, () => ["x".repeat(30_000)]) }), 400, /cap totalChars/, "xlsx: more than 100,000 characters in all");
await refuses(() => xh({ rows: [[1]], name: "a/b" }), 400, /may not contain/, "xlsx: an illegal sheet name");
await refuses(() => xh({ sheets: [{ name: "A", rows: [[1]] }, { name: "a", rows: [[1]] }] }), 400, /used twice/, "xlsx: a duplicate sheet name");
await refuses(() => xh({ rows: [[1]], numberFormats: { Z: "0" } }), 400, /does not have/, "xlsx: a format for a missing column");
await refuses(() => xh({ rows: [[1]], columnWidths: [999] }), 400, /width from 1 to 255/, "xlsx: a width out of range");
await refuses(() => xh({}), 400, /Send "sheets"/, "xlsx: no sheets");
await refuses(() => dh({ markdown: "x".repeat(D.markdownChars + 1) }), 400, /cap markdownChars/, "docx: markdown past the cap");
await refuses(() => dh({ markdown: "x", title: "t".repeat(D.titleChars + 1) }), 400, /cap titleChars/, "docx: title past the cap");
await refuses(() => dh({ markdown: Array.from({ length: D.blocks + 1 }, (_, i) => `p${i}`).join("\n\n") }), 400, /cap blocks/, `docx: ${D.blocks + 1} paragraphs`);
await refuses(() => dh({ markdown: `| a |\n|---|\n${Array.from({ length: D.tableRows }, () => "| x |").join("\n")}` }), 400, /cap tableRows/, `docx: a table of ${D.tableRows + 1} rows`);
await refuses(() => dh({ markdown: `|${" a |".repeat(D.tableColumns + 1)}\n|${"---|".repeat(D.tableColumns + 1)}` }), 400, /cap tableColumns/, `docx: a table of ${D.tableColumns + 1} columns`);
await refuses(() => dh({ markdown: `${">".repeat(D.nesting + 2)} deep` }), 400, /cap nesting/, "docx: quotes nested past the cap");
await refuses(() => dh({ markdown: Array.from({ length: D.nesting + 2 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n") }), 400, /cap nesting/, "docx: lists nested past the cap");
await refuses(() => dh({ markdown: `${">".repeat(20_000)} deep` }), 400, /nest/, "docx: 20,000 nested quotes answer a 400, not a crash");
await refuses(() => dh({}), 400, /Send "markdown"/, "docx: no markdown");
await refuses(() => ph({ slides: Array.from({ length: P.slides + 1 }, () => ({ title: "s" })) }), 400, /cap slides/, `pptx: ${P.slides + 1} slides`);
await refuses(() => ph({ title: "deck", slides: Array.from({ length: P.slides }, () => ({ title: "s" })) }), 400, /cap slides/, "pptx: the title slide counts toward the cap");
await refuses(() => ph({ slides: [{ bullets: Array.from({ length: P.bullets + 1 }, () => "b") }] }), 400, /cap bullets/, `pptx: ${P.bullets + 1} bullets`);
await refuses(() => ph({ slides: [{ bullets: ["b".repeat(P.bulletChars + 1)] }] }), 400, /cap is 1000/, "pptx: a bullet past its cap");
await refuses(() => ph({ slides: [{ table: Array.from({ length: P.tableRows + 1 }, () => ["x"]) }] }), 400, /cap tableRows/, `pptx: a table of ${P.tableRows + 1} rows`);
await refuses(() => ph({ slides: [{ table: [Array.from({ length: P.tableColumns + 1 }, () => "x")] }] }), 400, /cap tableColumns/, `pptx: a table of ${P.tableColumns + 1} columns`);
await refuses(() => ph({ slides: [{ title: "n", notes: "n".repeat(P.notesChars + 1) }] }), 400, /cap is 10000/, "pptx: notes past the cap");
await refuses(() => ph({ slides: Array.from({ length: 4 }, () => ({ bullets: Array.from({ length: 30 }, () => "b".repeat(900)) })) }), 400, /cap totalChars/, "pptx: more than 100,000 characters in all");
await refuses(() => ph({ slides: [{ bullets: [{ text: "x", level: 5 }] }] }), 400, /level must be/, "pptx: a bullet level past 4");
await refuses(() => ph({ slides: [{}] }), 400, /needs a "title"/, "pptx: an empty slide");
await refuses(() => ph({}), 400, /Send "slides"/, "pptx: no slides");
await refuses(() => finish(Buffer.alloc(11), 10), 422, /cap outputBytes/, "output past the output cap answers 422");

// docx: table cells are summed over the document, short rows at the header's
// width, before a cell is built. 30 tables of 200 rows by 20 columns written
// as bare "|" rows fit in about 20 KB of JSON and once drove the worker to
// its heap limit (a 503 after seconds); they answer the 400 at once.
{
  const hdr = `|${Array.from({ length: D.tableColumns }, () => "h").join("|")}|\n|${Array.from({ length: D.tableColumns }, () => "-").join("|")}|\n`;
  const padded = (hdr + "|\n".repeat(D.tableRows - 1) + "\n").repeat(30);
  const bodyBytes = JSON.stringify({ markdown: padded }).length;
  ok(bodyBytes < 25_000, `30 padded tables are a small body (${bodyBytes} bytes)`);
  const t0 = performance.now();
  await refuses(() => dh({ markdown: padded }), 400, /cap tableCells/, `docx: 30 padded tables (${30 * D.tableRows * D.tableColumns} cells) past the ${D.tableCells} table-cell cap`);
  const ms = performance.now() - t0;
  ok(ms < 2_000, `...refused in ${ms.toFixed(0)} ms, before any cell is built`);
  const { Lexer } = await import("marked");
  const one = `${hdr}| a |`;
  const lexed = new Lexer({ gfm: true }).lex(`${one}\n\n> ${one.split("\n").join("\n> ")}\n\n- item\n\n  ${one.split("\n").join("\n  ")}\n`);
  ok(docxTableCells(lexed) === 3 * 2 * D.tableColumns, `table cells are counted inside quotes and lists too (${docxTableCells(lexed)})`);
}

// xlsx: the cell cap is read from row and key counts before the grid is built,
// so no cell value is read from an input past it.
{
  let reads = 0;
  const keys = Array.from({ length: X.columns }, (_, i) => `k${i}`);
  const row = {};
  for (const k of keys) Object.defineProperty(row, k, { enumerable: true, get() { reads++; return 1; } });
  await refuses(() => xh({ rows: Array.from({ length: X.rowsPerSheet }, () => row), columns: keys }), 400, /cap cells/, `xlsx: ${X.rowsPerSheet} object rows by ${X.columns} columns past the cell cap`);
  ok(reads === 0, `...refused before a cell value is read (${reads} reads)`);
  reads = 0;
  const arr = new Proxy(Array.from({ length: X.columns }, () => 1), { get(t, k, r) { if (typeof k === "string" && /^\d+$/.test(k)) reads++; return Reflect.get(t, k, r); } });
  await refuses(() => xh({ rows: Array.from({ length: X.rowsPerSheet }, () => arr) }), 400, /cap cells/, `xlsx: ${X.rowsPerSheet} array rows by ${X.columns} cells past the cell cap`);
  ok(reads === 0, `...refused before a cell value is read (${reads} reads)`);
}

// docx: inline formatting nested past its cap is refused with a 400 naming it
// (the guard in runsOf), well before the call stack would run out.
{
  const nest = (n) => { let md = "x"; for (let i = 0; i < n; i++) { const m = i % 2 ? "*" : "**"; md = `${m}a ${md} b${m}`; } return md; };
  await refuses(() => dh({ markdown: nest(40) }), 400, /inline formatting more than \d+ levels deep \(cap inlineNesting\)/, "docx: inline emphasis nested 40 levels answers the inlineNesting 400");
  ok((await dh({ markdown: nest(6) })).bytes > 0, "docx: emphasis nested 6 levels builds");
}

// The input depth guard runs before any handler (src/handler-input.js).
{
  let deep = [1];
  for (let i = 0; i < 70; i++) deep = [deep];
  await refuses(() => handlerInputOf({ body: { rows: deep }, query: {} }, tool("xlsx-create")), 400, /nested more than 64/, "an input nested past MAX_INPUT_DEPTH is refused before the handler");
  await refuses(() => handlerInputOf({ body: { slides: JSON.stringify(deep) }, query: {} }, tool("pptx-create")), 400, /nested more than 64/, "a JSON-text field nested past the bound is refused too");
}

// ----------------------------------------------------------------------------
// Timing: the largest inputs the caps allow
// ----------------------------------------------------------------------------
// The repo's stall bound (scripts/test-redos-free-tier.js REDOS_BOUND_MS).
const STALL_BOUND_MS = Number(process.env.REDOS_BOUND_MS) || 250;
// A gap is read on the ours clock: the smaller of its wall length and the
// time the thread had a core inside it (scripts/lib/ours-clock.js).
function lagMonitor() {
  let max = 0, last = performance.now(), lastOurs = oursMs();
  const t = setInterval(() => { const now = performance.now(), c = oursMs(); max = Math.max(max, Math.min(now - last - 5, c - lastOurs)); last = now; lastOurs = c; }, 5);
  return () => { clearInterval(t); return max; };
}
const largest = {
  "xlsx-create (50,000 number cells)": [xh, { rows: Array.from({ length: X.rowsPerSheet }, (_, r) => Array.from({ length: 5 }, (_, c) => r * 5 + c + 0.5)), numberFormats: ["#,##0.00"] }],
  "xlsx-create (49,975 text cells, formula-looking)": [xh, { sheets: Array.from({ length: 5 }, (_, s) => ({ name: `S${s}`, rows: Array.from({ length: 1_999 }, () => Array.from({ length: 5 }, () => "=x")) })) }],
  "docx-create (5,000 blocks, 100,000 characters)": [dh, { title: "Large", markdown: Array.from({ length: 4_000 }, (_, i) => (i % 400 === 0 ? `## Section ${i}` : i % 7 === 0 ? `- **item** ${i} with *emphasis* and \`code\`` : `Paragraph ${i} with a [link](https://example.com/${i}).`)).join("\n\n").slice(0, D.markdownChars - 5) }],
  "docx-create (tables at their cap)": [dh, { markdown: Array.from({ length: 6 }, () => `|${" h |".repeat(D.tableColumns)}\n|${"---|".repeat(D.tableColumns)}\n${Array.from({ length: D.tableRows - 1 }, () => `|${" c |".repeat(D.tableColumns)}`).join("\n")}`).join("\n\n").slice(0, D.markdownChars) }],
  "pptx-create (100 slides, 30 bullets each)": [ph, { slides: Array.from({ length: P.slides }, (_, i) => ({ title: `Slide ${i}`, bullets: Array.from({ length: P.bullets }, (_, b) => `Bullet ${b} on ${i}`), notes: `Notes ${i}` })) }],
  "pptx-create (100 slides with full tables)": [ph, { slides: Array.from({ length: P.slides }, (_, i) => ({ title: `T${i}`, table: Array.from({ length: P.tableRows }, () => Array.from({ length: P.tableColumns }, () => "v")) })) }],
};
for (const [label, [handler, input]] of Object.entries(largest)) {
  const stop = lagMonitor();
  const t0 = performance.now();
  const out = await handler(input);
  const ms = performance.now() - t0;
  const lag = stop();
  ok(out.bytes > 0 && out.bytes <= OFFICE_LIMITS.outputBytes, `${label}: ${out.bytes} bytes, inside the output cap`);
  ok(ms < 10_000, `${label}: built in ${ms.toFixed(0)} ms (under 10 s; the job deadline is 15 s)`);
  ok(lag < STALL_BOUND_MS, `${label}: event loop held at most ${lag.toFixed(0)} ms (bound ${STALL_BOUND_MS} ms)`);
}

// A job past its deadline answers 422 and the pool keeps serving.
{
  const spec = validatePptx(largest["pptx-create (100 slides, 30 bullets each)"][1]);
  await refuses(() => runOfficeOp("pptx", spec, { timeoutMs: 1 }), 422, /longer than/, "a job past its deadline answers 422");
  const again = await tool("xlsx-create").handler({ rows: [["ok"]] });
  ok(again.bytes > 0, "the pool serves the next call after a deadline kill");
  const st = officePoolState();
  ok(st.busy === 0 && st.waiting === 0, `pool idle afterwards (${JSON.stringify(st)})`);
}

// A job that waits in the queue longer than its deadline is refused with the
// full queue's 503 and Retry-After, before any build, instead of building
// minutes later for a caller that may have left.
{
  const slow = validatePptx(largest["pptx-create (100 slides with full tables)"][1]);
  const blockers = Array.from({ length: OFFICE_POOL_MAX }, () => runOfficeOp("pptx", slow));
  const t0 = performance.now();
  let got = null;
  try { await runOfficeOp("xlsx", validateXlsx({ rows: [["queued"]] }), { timeoutMs: 20 }); got = { statusCode: 200 }; }
  catch (e) { got = e; }
  const waited = performance.now() - t0;
  const settled = await Promise.allSettled(blockers);
  ok(got.statusCode === 503 && got.shed === true && got.retryAfter === 5 && /busy/.test(got.message), `a job queued past its deadline answers the busy 503 with Retry-After (got ${got.statusCode} ${got.message || ""})`);
  ok(waited < 1_000, `...within its deadline of the wait, not after the builders free up (${waited.toFixed(0)} ms)`);
  ok(settled.every((r) => r.status === "fulfilled"), "the builds it waited behind still finish");
  const st = officePoolState();
  ok(st.busy === 0 && st.waiting === 0, `queue empty afterwards (${JSON.stringify(st)})`);
}

// ----------------------------------------------------------------------------
// The caller path: inputs near the published caps over HTTP. These routes
// take bodies past the global 100 KB parser (the large-body gate in
// src/server.js), so a legal input never meets a 413.
// ----------------------------------------------------------------------------
{
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const srv = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, ...ownStoreEnv("office-http"), PORT: "0", FREE_MODE: "true",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", UNPAID_QUOTE_BUDGET_PER_HOUR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  srv.stdout.on("data", (d) => { log += d; });
  srv.stderr.on("data", (d) => { log += d; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let B = null;
    for (let i = 0; i < 240 && !B; i++) { const m = log.match(/listening on :(\d+)/); if (m) B = `http://127.0.0.1:${m[1]}`; else await sleep(500); }
    if (!B) throw new Error(`server never came up:\n${log.slice(-600)}`);
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* not yet */ } await sleep(500); }
    const post = async (slug, body) => {
      const r = await fetch(`${B}/api/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body });
      let json = null; try { json = await r.json(); } catch { /* not JSON */ }
      return { status: r.status, json };
    };
    const cases = [
      ["docx-create", { markdown: Array.from({ length: 2_400 }, (_, i) => `Line ${i} says "quoted" text and more.`).join("\n\n").slice(0, D.markdownChars - 10) }, (j) => j.blocks > 2_000],
      ["xlsx-create", { rows: Array.from({ length: X.rowsPerSheet }, (_, r) => Array.from({ length: X.cells / X.rowsPerSheet }, (_, c) => r * 5 + c + 0.125)) }, (j) => j.sheets[0].rows === X.rowsPerSheet],
      ["pptx-create", { slides: Array.from({ length: P.slides - 1 }, (_, i) => ({ title: `S${i}`, bullets: ['a"'.repeat(Math.floor(P.bulletChars / 2) - 5)] })) }, (j) => j.slides === P.slides - 1],
    ];
    for (const [slug, input, check] of cases) {
      const body = JSON.stringify(input);
      const r = await post(slug, body);
      ok(body.length > 100 * 1024 && r.status === 200 && r.json && check(r.json), `HTTP ${slug}: a ${(body.length / 1024).toFixed(0)} KB body near the published caps answers 200 (got ${r.status}${r.json?.error ? ` ${r.json.error}` : ""})`);
    }
    const over = await post("docx-create", JSON.stringify({ markdown: "x".repeat(OFFICE_LIMITS.requestBytes + 1) }));
    ok(over.status === 413, `HTTP docx-create: a body past ${OFFICE_LIMITS.requestBytes} bytes meets the route's parser limit (got ${over.status})`);
  } catch (e) {
    fail++; console.error(`ASSERT FAIL - HTTP caller path: ${e.message}`);
  } finally {
    srv.kill("SIGTERM");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
