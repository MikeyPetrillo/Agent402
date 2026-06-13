// Barcode / QR decode — read the data out of a barcode image. The ecosystem
// gap scan found zero x402 suppliers for this, and it's one of the few gaps
// that's honestly serveable: fully deterministic, pure-CPU (proof-of-work
// eligible), no network, no LLM. Accepts a base64 PNG or JPEG and returns the
// decoded payload + format. zxing MultiFormatReader covers QR, DataMatrix, and
// 1D symbologies (EAN/UPC/Code39/Code128/ITF/Codabar); jsQR is a QR fallback.
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import jsQR from "jsqr";
import {
  RGBLuminanceSource, BinaryBitmap, HybridBinarizer, MultiFormatReader, BarcodeFormat, DecodeHintType,
} from "@zxing/library";

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

const MAX_B64 = 12_000_000; // ~9 MB decoded; bounds CPU/memory per call
const MAX_PIXELS = 4096 * 4096;

// Decode a base64 PNG/JPEG (optionally a data: URL) to { data: RGBA, width, height }.
function toRgba(imageField) {
  if (typeof imageField !== "string" || !imageField.trim()) throw bad('Missing "image" (base64 PNG or JPEG, optionally a data: URL)');
  let b64 = imageField.trim();
  const m = b64.match(/^data:image\/(png|jpe?g);base64,(.*)$/is);
  if (m) b64 = m[2];
  b64 = b64.replace(/\s+/g, "");
  if (b64.length > MAX_B64) throw bad(`image too large (${b64.length} base64 chars; max ${MAX_B64})`);
  let buf;
  try { buf = Buffer.from(b64, "base64"); } catch { throw bad("image is not valid base64"); }
  if (buf.length < 8) throw bad("image data too small to be a PNG or JPEG");

  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!isPng && !isJpg) throw bad("unsupported image format — provide a PNG or JPEG");
  let img;
  try {
    if (isPng) {
      const png = PNG.sync.read(buf);
      img = { data: png.data, width: png.width, height: png.height };
    } else {
      const j = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 64 });
      img = { data: j.data, width: j.width, height: j.height };
    }
  } catch (e) {
    throw bad(`could not decode ${isPng ? "PNG" : "JPEG"} image: ${e.message}`);
  }
  if (img.width * img.height > MAX_PIXELS) throw bad(`image too large (${img.width}x${img.height}; max ${MAX_PIXELS} px)`);
  return img;
}

function luminance(rgba, width, height) {
  const len = width * height;
  const lum = new Uint8ClampedArray(len);
  for (let i = 0; i < len; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    lum[i] = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
  }
  return lum;
}

function decodeBarcode({ data, width, height }) {
  // Primary: zxing multi-format.
  try {
    const src = new RGBLuminanceSource(luminance(data, width, height), width, height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(src));
    const reader = new MultiFormatReader();
    const hints = new Map();
    hints.set(DecodeHintType.TRY_HARDER, true);
    reader.setHints(hints);
    const res = reader.decode(bitmap);
    return { found: true, format: BarcodeFormat[res.getBarcodeFormat()], text: res.getText(), decoder: "zxing" };
  } catch {
    /* fall through to QR-specific fallback */
  }
  // Fallback: jsQR (robust on noisy/low-contrast QR).
  const code = jsQR(new Uint8ClampedArray(data), width, height);
  if (code && code.data) return { found: true, format: "QR_CODE", text: code.data, decoder: "jsqr" };
  return { found: false, format: null, text: null };
}

export const BARCODE_TOOLS = [
  {
    route: "POST /api/barcode-decode", name: "Barcode / QR decode", slug: "barcode-decode", category: "data", price: "$0.003",
    description:
      "Decode a barcode or QR code from an image. Send a base64 PNG or JPEG (or a data: URL); returns the decoded text and the symbology. Reads QR, DataMatrix, and 1D barcodes (EAN/UPC/Code39/Code128/ITF/Codabar). Deterministic, no network, no model.",
    tags: ["barcode", "qr", "qr-code", "decode", "scanner", "ean", "upc", "datamatrix"],
    discovery: {
      bodyType: "json",
      // A real, decodable QR ("AGENT402") so the tool's own example works end to end.
      input: { image: "iVBORw0KGgoAAAANSUhEUgAAAGwAAABsCAYAAACPZlfNAAAAAklEQVR4AewaftIAAALNSURBVO3BW2rgUAwFwT7C+99yTz4vImDjvNCgqviBNUaxRinWKMUapVijXHwiCX9N5bskoVO5k4S/pnIq1ijFGqVYoxRrlIuHVH5KEp5IwknlrSScVJ5Q+SlJuFOsUYo1SrFGKdYoF1+QhDdU3lC5k4TflIQ3VN4o1ijFGqVYo1wMloRO5YkkTFSsUYo1SrFGKdYoF4Mk4aTyRBL+F8UapVijFGuUYo1y8QUqv0nlThKeUPkOKr+pWKMUa5RijXLxUBL+WhJOKk+odEk4qTyRhL9UrFGKNUqxRinWKPED/5EkdCr/i2KNUqxRijVKsUa5+EQSOpUuCSeVLgmdyikJncqdJLyVhJPKG0noVO4koVO5U6xRijVKsUaJH3gpCXdU/loSOpVTEjqVLgknlTeS8ITKqVijFGuUYo1SrFEuPpGEJ1S+QxI6lS4JJ5UuCd8lCW8k4Y5Kl4Q7xRqlWKMUa5RijRI/0CThCZVTEjqVLgknlTeS8JNUuiS8ofIdijVKsUYp1ijFGiV+oElCp9Il4aTSJeENlS4JJ5UnktCpnJLwhkqXhDdU7hRrlGKNUqxR4geGSMIbKm8k4Y5Kl4Q7Km8Ua5RijVKsUYo1ysUnkvDXVDqVUxLeSsJJpVO5k4QnVO4koVM5FWuUYo1SrFGKNcrFQyo/JQlvqHRJeELlThLuqLyRhE7lTrFGKdYoxRrl4guS8IbKG0k4qXQqTyThpPKEyikJnUqXhDtJ6FROxRqlWKMUa5RijXIxiMopCZ1Kl4RO5ZSETuWOyhMqpyR0KneKNUqxRinWKMUa5WKQJJxUflISOpVTEp5QOal0SehUTsUapVijFGuUiy9Q+U0qpyR0Kk8k4Y5Kl4STyhtJeKNYoxRrlGKNUqxRLh5Kwl9LwndROSWhS0KnckpCp9Il4aTSJeFOsUYp1ijFGqVYo8QPrDGKNUqxRinWKP8AIFwq4iXMWtcAAAAASUVORK5CYII=" },
      inputSchema: {
        properties: {
          image: { type: "string", description: "base64-encoded PNG or JPEG, optionally a data: URL" },
        },
        required: ["image"],
      },
      output: { example: { found: true, format: "QR_CODE", text: "AGENT402", decoder: "zxing" } },
    },
    handler: (i) => decodeBarcode(toRgba(i.image)),
  },
];
