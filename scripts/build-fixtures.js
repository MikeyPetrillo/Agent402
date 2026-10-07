// Regenerates assets/fixtures/. Run: node scripts/build-fixtures.js
//
// Three skill packs take a user-supplied artifact (a PDF to read, an image to
// transform) and shipped with placeholder prose or a 404ing URL as their
// published example, so every step failed on the input we tell agents to
// copy. They now point at these files, served by /fixtures/:file.
//
// GENERATED, not vendored, on purpose: the repo carries no binary blob whose
// provenance we cannot state, and anyone can rebuild them byte-for-byte from
// this script. Each is deterministic, so a rebuild is a no-op in git unless
// this file changed.
//
// 2026-10-07: every published example that fetches a file now fetches one of
// ours. Examples that pointed at other sites (a paper on arxiv, an OCR sample,
// an EXIF sample on a code host, a public OpenAPI demo) failed whenever that
// site refused or throttled a CI runner, and buyers copying them depended on
// someone else's uptime. scripts/test-example-hosts.js keeps it that way.
// The text image uses jimp's bundled Open Sans bitmap font (Apache-2.0).
// sample-audio.wav predates this script: a 2 s 440 Hz sine, 8 kHz mono.
import { writeFileSync, mkdirSync } from "node:fs";
import { Jimp } from "jimp";
import { loadFont } from "jimp";
import { SANS_32_BLACK } from "jimp/fonts";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "fixtures");
mkdirSync(OUT, { recursive: true });

// --- a minimal single-page PDF carrying real extractable text --------------
function buildPdf() {
  const text = "Agent402 sample invoice. Invoice 402-0001. Total 12.34 USD.";
  const content = `BT /F1 14 Tf 60 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  return pdfFromObjects(objs);
}

// --- a three-page text PDF: something worth summarizing ---------------------
// Original prose, written for this fixture. Plain ASCII and no parentheses or
// backslashes, so each line drops into a PDF string literal as is.
const REPORT_PAGES = [
  ["Paying for Tools per Request", "",
    "An agent that needs one answer should be able to buy one answer.",
    "This sample report describes how a tool server can price each call,",
    "ask for payment in the HTTP 402 response, and serve the result once",
    "the payment is proven. No account is created and no key is shared.",
    "",
    "The buyer sends a request and receives a price. It signs a payment",
    "for that exact amount and sends the request again. The server checks",
    "the signature, runs the tool, and settles the payment only when the",
    "tool succeeded. A failed call is never charged."],
  ["How a Price Is Chosen", "",
    "Most tools are deterministic code with a fixed price per call.",
    "Model-backed tools are metered: the server quotes a ceiling first",
    "and charges the measured usage, never more than the quote.",
    "",
    "Prices are published in a machine-readable catalog so an agent can",
    "compare tools before it calls one. The same catalog lists which",
    "payment networks each tool accepts."],
  ["What the Buyer Keeps", "",
    "Every paid answer carries a receipt that names the payment, so a",
    "buyer can match its spending to the calls it made. A retry with",
    "the same idempotency key returns the first answer instead of paying",
    "twice. This page closes the sample report."],
];

function buildReportPdf() {
  const n = REPORT_PAGES.length;
  // 1 catalog, 2 pages, 3 font, then a page object and its content per page.
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R /Lang (en) >>",
    `<< /Type /Pages /Kids [${REPORT_PAGES.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${n} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  REPORT_PAGES.forEach(([title, ...lines], i) => {
    const ops = [`BT /F1 20 Tf 72 720 Td (${title}) Tj ET`];
    lines.forEach((line, k) => { if (line) ops.push(`BT /F1 12 Tf 72 ${690 - k * 18} Td (${line}) Tj ET`); });
    ops.push(`BT /F1 9 Tf 72 60 Td (Agent402 sample report, page ${i + 1} of ${n}) Tj ET`);
    const content = ops.join("\n");
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objs.push("<< /Title (Paying for Tools per Request) /Author (Agent402) >>");
  return pdfFromObjects(objs, `/Info ${objs.length} 0 R`);
}

function pdfFromObjects(objs, trailerExtra = "") {
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// --- a 64x64 truecolour PNG, hand-encoded (no image dependency) ------------
function buildPng() {
  const W = 64, H = 64;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const o = y * (1 + W * 3) + 1 + x * 3;
      raw[o] = (x * 4) & 255; raw[o + 1] = (y * 4) & 255; raw[o + 2] = 128;
    }
  }
  const table = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xFFFFFFFF;
    for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- a white PNG with two lines of printed text, for OCR ---------------------
async function buildTextPng() {
  const img = new Jimp({ width: 720, height: 140, color: 0xffffffff });
  const font = await loadFont(SANS_32_BLACK);
  img.print({ font, x: 24, y: 24, text: "Agent402 sample text for OCR." });
  img.print({ font, x: 24, y: 76, text: "Invoice 402-0001 total 12.34 USD." });
  return img.getBuffer("image/png");
}

// --- a JPEG carrying EXIF: camera, timestamps and a GPS fix ------------------
// Three colour bands (60/30/10) so a dominant-colour read has an answer. The
// GPS fix is the Royal Observatory, Greenwich: a public landmark, no one's home.
async function buildExifJpeg() {
  const W = 120, H = 80;
  const img = new Jimp({ width: W, height: H, color: 0xffffffff });
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    img.setPixelColor(x < 72 ? 0x1f7a8cff : x < 108 ? 0xe07a1fff : 0x22223bff, x, y);
  }
  const jpeg = await img.getBuffer("image/jpeg", { quality: 90 });
  const app1 = exifSegment({
    Make: "Agent402", Model: "Fixture Camera", DateTime: "2026:10:07 12:00:00",
    DateTimeOriginal: "2026:10:07 12:00:00", gps: { lat: [51, 28, 38], lon: [0, 0, 1.8] },
  });
  // After SOI, and after JFIF APP0 when the encoder wrote one.
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + jpeg.readUInt16BE(4);
  return Buffer.concat([jpeg.subarray(0, at), app1, jpeg.subarray(at)]);
}

// A little-endian TIFF block: IFD0 (Make, Model, Orientation, DateTime, the
// Exif and GPS pointers), an Exif IFD (DateTimeOriginal) and a GPS IFD.
function exifSegment({ Make, Model, DateTime, DateTimeOriginal, gps }) {
  const ASCII = 2, SHORT = 3, LONG = 4, RATIONAL = 5;
  const ascii = (v) => Buffer.from(`${v}\0`, "latin1");
  const rationals = (parts) => {
    const b = Buffer.alloc(parts.length * 8);
    parts.forEach((v, i) => { const den = Number.isInteger(v) ? 1 : 100; b.writeUInt32LE(Math.round(v * den), i * 8); b.writeUInt32LE(den, i * 8 + 4); });
    return b;
  };
  const ifds = [
    [[0x010f, ASCII, ascii(Make)], [0x0110, ASCII, ascii(Model)], [0x0112, SHORT, 1], [0x0132, ASCII, ascii(DateTime)], [0x8769, LONG, "exif"], [0x8825, LONG, "gps"]],
    [[0x9003, ASCII, ascii(DateTimeOriginal)]],
    [[0x0001, ASCII, ascii("N")], [0x0002, RATIONAL, rationals(gps.lat)], [0x0003, ASCII, ascii("W")], [0x0004, RATIONAL, rationals(gps.lon)]],
  ];
  // Lay out: header (8), then each IFD followed by its out-of-line values.
  const sizes = ifds.map((e) => 2 + e.length * 12 + 4 + e.reduce((n, [, , v]) => n + (Buffer.isBuffer(v) && v.length > 4 ? v.length + (v.length & 1) : 0), 0));
  const starts = [8, 8 + sizes[0], 8 + sizes[0] + sizes[1]];
  const ptr = { exif: starts[1], gps: starts[2] };
  const tiff = Buffer.alloc(8 + sizes.reduce((a, b) => a + b, 0));
  tiff.write("II", 0, "latin1"); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  ifds.forEach((entries, k) => {
    let o = starts[k];
    let data = o + 2 + entries.length * 12 + 4;
    tiff.writeUInt16LE(entries.length, o); o += 2;
    for (const [tag, type, v] of entries) {
      tiff.writeUInt16LE(tag, o); tiff.writeUInt16LE(type, o + 2);
      if (type === SHORT) { tiff.writeUInt32LE(1, o + 4); tiff.writeUInt16LE(v, o + 8); }
      else if (type === LONG) { tiff.writeUInt32LE(1, o + 4); tiff.writeUInt32LE(ptr[v], o + 8); }
      else {
        tiff.writeUInt32LE(type === RATIONAL ? v.length / 8 : v.length, o + 4);
        if (v.length <= 4) v.copy(tiff, o + 8);
        else { tiff.writeUInt32LE(data, o + 8); v.copy(tiff, data); data += v.length + (v.length & 1); }
      }
      o += 12;
    }
    tiff.writeUInt32LE(0, o); // no next IFD
  });
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

// --- a small OpenAPI 3.1 document -------------------------------------------
function buildOpenApi() {
  const spec = {
    openapi: "3.1.0",
    info: { title: "Agent402 sample API", version: "1.0.0", description: "A small API description served as a fixture for the OpenAPI tools." },
    servers: [{ url: "https://agent402.tools" }],
    paths: {
      "/api/notes": {
        get: {
          operationId: "listNotes", summary: "List notes",
          parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 50 } }],
          responses: { 200: { description: "A page of notes", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Note" } } } } } },
        },
        post: {
          operationId: "createNote", summary: "Create a note",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NewNote" }, example: { title: "Groceries", body: "Milk, eggs" } } } },
          responses: { 201: { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Note" } } } }, 400: { description: "Invalid note" } },
        },
      },
      "/api/notes/{id}": {
        get: {
          operationId: "getNote", summary: "Get one note",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "The note", content: { "application/json": { schema: { $ref: "#/components/schemas/Note" } } } }, 404: { description: "No such note" } },
        },
      },
    },
    components: {
      schemas: {
        NewNote: { type: "object", required: ["title"], properties: { title: { type: "string", maxLength: 120 }, body: { type: "string" } } },
        Note: { type: "object", required: ["id", "title"], properties: { id: { type: "string" }, title: { type: "string" }, body: { type: "string" }, createdAt: { type: "string", format: "date-time" } } },
      },
    },
  };
  return Buffer.from(`${JSON.stringify(spec, null, 2)}\n`);
}

for (const [name, buf] of [
  ["sample-invoice.pdf", buildPdf()],
  ["sample-image.png", buildPng()],
  ["sample-report.pdf", buildReportPdf()],
  ["sample-text.png", await buildTextPng()],
  ["sample-photo.jpg", await buildExifJpeg()],
  ["sample-openapi.json", buildOpenApi()],
]) {
  writeFileSync(join(OUT, name), buf);
  console.log(`${name}: ${buf.length} bytes`);
}
