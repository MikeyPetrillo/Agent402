// Image kit — image transforms an agent's sandbox usually can't do: resize,
// format-convert, thumbnail, crop/rotate/flip, EXIF extraction, and dominant
// colors. Deterministic, via jimp (pure JS, no native deps) plus a minimal
// inline EXIF (TIFF IFD) parser. Base64 image in — or, for the newer tools, a
// public image URL fetched through safeFetch (SSRF-guarded; those slugs are
// WALLET_ONLY in pow.js). Binary outputs use the same contract as /api/qr and
// /api/screenshot. Covered by scripts/test-image.js.
//
// The three compute-payable tools (resize/convert/thumbnail) run their whole
// decode/transform/encode pipeline in a worker thread via image-pool.js. Jimp is
// pure JS and synchronous, and those slugs are free on the authless MCP connector
// and free via proof-of-work, so on the main thread an unauthenticated caller
// could occupy the single Node thread and stall paid traffic and the paywall with
// it. The remaining tools here take a URL, so they are wallet-only and stay
// inline. Shared primitives live in image-ops.js so both sides run one
// implementation.
import { Jimp } from "jimp";
import { safeFetch } from "./fetch-guard.js";
import {
  bad, MAX_DIM, declaredDimensions, posInt, readImage, sniffFormat, toBuffer, MIME,
} from "./image-ops.js";
import { runImageOffThread } from "./image-pool.js";

// The content types resize/convert/thumbnail answer with (raw bytes through
// the route binder's __binary sentinel, chosen by `format`). Declared on each
// def as `binaryTypes` so the tool page and /openapi.json describe bytes, not
// a JSON object.
const IMAGE_OUT_TYPES = [...new Set(Object.values(MIME))];

// Re-exported for scripts/test-image.js, which imports the parser surface from
// this module.
export { declaredDimensions, sniffFormat };

const MAX_B64 = 12_000_000; // ~9 MB encoded

function decodeB64(field) {
  if (typeof field !== "string" || !field.trim()) throw bad('Missing "image" (base64 PNG/JPEG/BMP, optionally a data: URL)');
  let b64 = field.trim();
  const m = b64.match(/^data:image\/[a-z+]+;base64,(.*)$/is);
  if (m) b64 = m[1];
  b64 = b64.replace(/\s+/g, "");
  if (b64.length > MAX_B64) throw bad(`image too large (${b64.length} base64 chars; max ${MAX_B64})`);
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 8) throw bad("image data too small");
  return buf;
}

// The base64-only path for the three compute-payable tools. The bytes are decoded
// here (native base64, cheap) and everything expensive happens in the worker; the
// pool applies FREE_MAX_SRC_PIXELS and re-runs the header pre-check before a
// worker is even handed the job.
function transformOffThread(op, image, params) {
  return runImageOffThread({ op, buffer: decodeB64(image), params });
}

// Newer tools accept EITHER a public image URL (fetched via safeFetch — SSRF
// guard, 5MB cap, 15s timeout) OR the same base64 "image" field as the
// original tools. URL capability = egress, so these slugs are wallet-only.
async function inputBuffer(i) {
  if (typeof i.url === "string" && i.url.trim()) {
    const { buffer } = await safeFetch(i.url.trim(), { binary: true });
    if (buffer.length < 8) throw bad("fetched resource is too small to be an image");
    return buffer;
  }
  if (typeof i.image !== "string" || !i.image.trim()) {
    throw bad('Provide "url" (public image URL) or "image" (base64 PNG/JPEG/BMP)');
  }
  return decodeB64(i.image);
}

// --- minimal EXIF (TIFF IFD) parser -----------------------------------------
// No new dependency: EXIF is a TIFF structure embedded in a JPEG APP1 segment
// (or a PNG eXIf chunk, or the file itself for TIFF). We parse the common,
// useful subset of IFD0 + the Exif and GPS sub-IFDs. Stripped images yield an
// empty result, not an error. Exported for scripts/test-image.js. Pure byte
// reads, so this stays on the main thread even though it serves paid tools.

/** Locate the raw TIFF/EXIF payload inside a container. Returns a Buffer or null. */
export function extractExifBuffer(buf) {
  const format = sniffFormat(buf);
  if (format === "tiff") return buf;
  if (format === "jpeg") {
    let i = 2;
    while (i + 4 <= buf.length && buf[i] === 0xff) {
      const marker = buf[i + 1];
      if (marker === 0xda || marker === 0xd9) break; // start-of-scan / EOI — no EXIF past here
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      if (marker === 0xe1 && i + 10 <= buf.length && buf.toString("ascii", i + 4, i + 10) === "Exif\0\0") {
        return buf.subarray(i + 10, Math.min(i + 2 + len, buf.length));
      }
      i += 2 + len;
    }
    return null;
  }
  if (format === "png") {
    let i = 8;
    while (i + 8 <= buf.length) {
      const len = buf.readUInt32BE(i);
      const type = buf.toString("ascii", i + 4, i + 8);
      if (type === "eXIf") return buf.subarray(i + 8, Math.min(i + 8 + len, buf.length));
      if (type === "IEND") break;
      i += 12 + len; // len + type + data + crc
    }
    return null;
  }
  return null;
}

// Common, useful tag subset (IFD0 + Exif sub-IFD). Unknown tags are skipped.
const EXIF_TAGS = {
  0x010e: "ImageDescription", 0x010f: "Make", 0x0110: "Model", 0x0112: "Orientation",
  0x011a: "XResolution", 0x011b: "YResolution", 0x0128: "ResolutionUnit",
  0x0131: "Software", 0x0132: "DateTime", 0x013b: "Artist", 0x8298: "Copyright",
  0x829a: "ExposureTime", 0x829d: "FNumber", 0x8822: "ExposureProgram", 0x8827: "ISO",
  0x9003: "DateTimeOriginal", 0x9004: "DateTimeDigitized",
  0x9201: "ShutterSpeedValue", 0x9202: "ApertureValue", 0x9204: "ExposureBias",
  0x9205: "MaxApertureValue", 0x9206: "SubjectDistance", 0x9207: "MeteringMode",
  0x9208: "LightSource", 0x9209: "Flash", 0x920a: "FocalLength",
  0xa001: "ColorSpace", 0xa002: "PixelXDimension", 0xa003: "PixelYDimension",
  0xa402: "ExposureMode", 0xa403: "WhiteBalance", 0xa404: "DigitalZoomRatio",
  0xa405: "FocalLengthIn35mm", 0xa406: "SceneCaptureType",
  0xa430: "CameraOwnerName", 0xa431: "BodySerialNumber",
  0xa433: "LensMake", 0xa434: "LensModel",
};
const GPS_TAGS = {
  0x0001: "GPSLatitudeRef", 0x0002: "GPSLatitude", 0x0003: "GPSLongitudeRef", 0x0004: "GPSLongitude",
  0x0005: "GPSAltitudeRef", 0x0006: "GPSAltitude", 0x0007: "GPSTimeStamp", 0x001d: "GPSDateStamp",
};
const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/** Parse a raw TIFF buffer into { exif, gps } tag maps. Returns null when not TIFF. */
export function parseTiff(buf) {
  if (buf.length < 8) return null;
  const bom = buf.toString("ascii", 0, 2);
  const le = bom === "II";
  if (!le && bom !== "MM") return null;
  const u16 = (o) => (o >= 0 && o + 2 <= buf.length ? (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)) : 0);
  const u32 = (o) => (o >= 0 && o + 4 <= buf.length ? (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)) : 0);
  const i32 = (o) => (o >= 0 && o + 4 <= buf.length ? (le ? buf.readInt32LE(o) : buf.readInt32BE(o)) : 0);
  if (u16(2) !== 42) return null;
  const rational = (o, signed) => {
    const num = signed ? i32(o) : u32(o);
    const den = signed ? i32(o + 4) : u32(o + 4);
    return den ? Math.round((num / den) * 1e6) / 1e6 : num === 0 ? 0 : null;
  };
  const readValue = (type, count, off) => {
    const one = (k) => {
      const p = off + k * TYPE_SIZES[type];
      if (type === 1 || type === 7) return buf[p];
      if (type === 3) return u16(p);
      if (type === 4) return u32(p);
      if (type === 9) return i32(p);
      if (type === 5) return rational(p, false);
      if (type === 10) return rational(p, true);
      return null;
    };
    if (type === 2) return buf.toString("utf8", off, off + count).replace(/\0+$/, "").trim();
    if (type === 7) {
      // UNDEFINED: printable ASCII (e.g. version fields) reads as text; else summarize.
      const bytes = buf.subarray(off, off + count);
      const printable = count > 0 && count <= 64 && [...bytes].every((b) => b >= 0x20 && b < 0x7f);
      return printable ? bytes.toString("ascii") : `<${count} bytes>`;
    }
    if (count === 1) return one(0);
    return Array.from({ length: Math.min(count, 64) }, (_, k) => one(k));
  };
  const readIfd = (offset, tags, out) => {
    const pointers = {};
    const n = Math.min(u16(offset), 256);
    for (let k = 0; k < n; k++) {
      const e = offset + 2 + k * 12;
      if (e + 12 > buf.length) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      if (tag === 0x8769 || tag === 0x8825) { pointers[tag] = u32(e + 8); continue; }
      const unit = TYPE_SIZES[type];
      if (!unit || count === 0 || count > 65536) continue;
      const size = unit * count;
      const valOff = size <= 4 ? e + 8 : u32(e + 8);
      if (valOff + size > buf.length) continue;
      const name = tags[tag];
      if (!name) continue;
      const value = readValue(type, count, valOff);
      if (value !== null && value !== "" && out[name] === undefined) out[name] = value;
    }
    return pointers;
  };
  const exif = {};
  const gps = {};
  const pointers = readIfd(u32(4), EXIF_TAGS, exif);
  if (pointers[0x8769] && pointers[0x8769] < buf.length) readIfd(pointers[0x8769], EXIF_TAGS, exif);
  if (pointers[0x8825] && pointers[0x8825] < buf.length) readIfd(pointers[0x8825], GPS_TAGS, gps);
  return { exif, gps };
}

function gpsDecimal(gps) {
  const dms = (v, ref, neg) => {
    if (!Array.isArray(v) || v.length !== 3 || v.some((x) => typeof x !== "number")) return null;
    const dec = v[0] + v[1] / 60 + v[2] / 3600;
    return Math.round(dec * (ref === neg ? -1 : 1) * 1e6) / 1e6;
  };
  const latitude = dms(gps.GPSLatitude, gps.GPSLatitudeRef, "S");
  const longitude = dms(gps.GPSLongitude, gps.GPSLongitudeRef, "W");
  if (latitude === null || longitude === null) return null;
  const out = { latitude, longitude };
  if (typeof gps.GPSAltitude === "number") out.altitude = gps.GPSAltitudeRef === 1 ? -gps.GPSAltitude : gps.GPSAltitude;
  return out;
}

const EXAMPLE_IMAGE_URL = "https://raw.githubusercontent.com/ianare/exif-samples/master/jpg/Canon_40D.jpg";

export const IMAGE_TOOLS = [
  {
    route: "POST /api/image-resize", name: "Image resize", slug: "image-resize", category: "web", price: "$0.001",
    description:
      "Resize an image to given pixel dimensions. Send a base64 PNG/JPEG/BMP and width and/or height (give one to scale proportionally). Returns the resized image. Deterministic, no network.",
    tags: ["image", "resize", "scale", "thumbnail", "png", "jpeg"],
    binaryTypes: IMAGE_OUT_TYPES,
    discovery: {
      bodyType: "json",
      input: { image: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR4AYXBAQEAIAyAMKSSnUxrJ99AtrXPfXxIkCBBggQJEgZ5JwJ01a+JcwAAAABJRU5ErkJggg==", width: 256 },
      inputSchema: {
        properties: {
          image: { type: "string", description: "base64 image (PNG/JPEG/BMP), optionally a data: URL" },
          width: { type: "number", description: "target width in px (1-4096)" },
          height: { type: "number", description: "target height in px (1-4096)" },
          format: { type: "string", description: "output format: png (default), jpeg, bmp" },
        },
        required: ["image"],
      },
      output: { example: { __note: "returns the resized image as binary (Content-Type set accordingly)" } },
    },
    handler: async (i) =>
      transformOffThread("resize", i.image, { width: i.width, height: i.height, format: i.format, quality: i.quality }),
  },
  {
    route: "POST /api/image-convert", name: "Image convert", slug: "image-convert", category: "web", price: "$0.005",
    description:
      "Convert an image between formats (PNG, JPEG, BMP). Send a base64 image and the target format; returns the converted image. Optional jpeg quality (1-100). Deterministic, no network.",
    tags: ["image", "convert", "format", "png", "jpeg", "bmp"],
    binaryTypes: IMAGE_OUT_TYPES,
    discovery: {
      bodyType: "json",
      input: { image: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR4AYXBAQEAIAyAMKSSnUxrJ99AtrXPfXxIkCBBggQJEgZ5JwJ01a+JcwAAAABJRU5ErkJggg==", format: "jpeg", quality: 80 },
      inputSchema: {
        properties: {
          image: { type: "string", description: "base64 image, optionally a data: URL" },
          format: { type: "string", description: "png | jpeg | bmp" },
          quality: { type: "number", description: "jpeg quality 1-100 (default 80)" },
        },
        required: ["image", "format"],
      },
      output: { example: { __note: "returns the converted image as binary" } },
    },
    handler: async (i) => {
      if (!i.format) throw bad('Missing "format" (png, jpeg, or bmp)');
      return transformOffThread("convert", i.image, { format: i.format, quality: i.quality });
    },
  },
  {
    route: "POST /api/image-thumbnail", name: "Image thumbnail", slug: "image-thumbnail", category: "web", price: "$0.001",
    description:
      "Make a square thumbnail of an image - scales and center-crops to NxN (default 128). Send a base64 image and optional size. Returns the thumbnail. Deterministic, no network.",
    tags: ["image", "thumbnail", "crop", "square", "preview"],
    binaryTypes: IMAGE_OUT_TYPES,
    discovery: {
      bodyType: "json",
      input: { image: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR4AYXBAQEAIAyAMKSSnUxrJ99AtrXPfXxIkCBBggQJEgZ5JwJ01a+JcwAAAABJRU5ErkJggg==", size: 128 },
      inputSchema: {
        properties: {
          image: { type: "string", description: "base64 image, optionally a data: URL" },
          size: { type: "number", description: "square edge in px, 1-1024 (default 128)" },
          format: { type: "string", description: "output format: png (default), jpeg, bmp" },
        },
        required: ["image"],
      },
      output: { example: { __note: "returns the square thumbnail as binary" } },
    },
    handler: async (i) =>
      transformOffThread("thumbnail", i.image, { size: i.size, format: i.format, quality: i.quality }),
  },
  {
    route: "POST /api/image-exif", name: "Image EXIF", slug: "image-exif", category: "web", price: "$0.003",
    description:
      "Extract EXIF metadata from an image (camera make/model, timestamps, exposure, orientation, GPS). Send a public image URL or a base64 image; JPEG, PNG (eXIf chunk), and TIFF carry EXIF. Stripped images return an empty exif object, not an error.",
    tags: ["image", "exif", "metadata", "camera", "gps", "jpeg"],
    discovery: {
      bodyType: "json",
      input: { url: EXAMPLE_IMAGE_URL },
      inputSchema: {
        properties: {
          url: { type: "string", description: "public http(s) image URL (fetched server-side, 5MB cap)" },
          image: { type: "string", description: "alternative: base64 image, optionally a data: URL" },
        },
      },
      output: { example: { format: "jpeg", width: 100, height: 68, bytes: 7958, hasExif: true, exif: { Make: "Canon", Model: "Canon EOS 40D", Orientation: 1, DateTimeOriginal: "2008:05:30 15:56:01" }, gps: null } },
    },
    handler: async (i) => {
      const buf = await inputBuffer(i);
      const format = sniffFormat(buf);
      let width = null, height = null;
      try { const img = await Jimp.read(buf); width = img.width; height = img.height; } catch { /* dims stay null for undecodable containers */ }
      const tiff = extractExifBuffer(buf);
      const parsed = tiff ? parseTiff(tiff) : null;
      const exif = parsed ? parsed.exif : {};
      const gps = parsed && Object.keys(parsed.gps).length ? gpsDecimal(parsed.gps) : null;
      return { format, width, height, bytes: buf.length, hasExif: Object.keys(exif).length > 0, exif, gps };
    },
  },
  {
    route: "POST /api/image-dominant-color", name: "Image dominant color", slug: "image-dominant-color", category: "web", price: "$0.003",
    description:
      "Extract the dominant colors of an image as a palette of hex values with pixel ratios. Send a public image URL or a base64 image, and optionally how many colors (1-10, default 5). Deterministic bucketed quantization; transparent pixels are ignored.",
    tags: ["image", "color", "palette", "dominant", "hex"],
    discovery: {
      bodyType: "json",
      input: { url: EXAMPLE_IMAGE_URL, colors: 3 },
      inputSchema: {
        properties: {
          url: { type: "string", description: "public http(s) image URL (fetched server-side, 5MB cap)" },
          image: { type: "string", description: "alternative: base64 image, optionally a data: URL" },
          colors: { type: "number", description: "palette size, 1-10 (default 5)" },
        },
      },
      output: { example: { width: 100, height: 68, sampled: 6240, colors: [{ hex: "#181708", rgb: [24, 23, 8], ratio: 0.078 }] } },
    },
    handler: async (i) => {
      const img = await readImage(await inputBuffer(i));
      const { width, height } = img;
      const n = Math.min(Math.max(posInt(i.colors) || 5, 1), 10);
      // Bound the work: sample from a ≤96px-wide copy (deterministic resize).
      if (img.width > 96) img.resize({ w: 96 });
      const data = img.bitmap.data;
      const buckets = new Map();
      let sampled = 0;
      for (let p = 0; p < data.length; p += 4) {
        if (data[p + 3] < 128) continue; // skip transparent
        sampled++;
        const key = ((data[p] >> 4) << 8) | ((data[p + 1] >> 4) << 4) | (data[p + 2] >> 4);
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
        b.n++; b.r += data[p]; b.g += data[p + 1]; b.b += data[p + 2];
      }
      if (!sampled) throw bad("image has no opaque pixels");
      const colors = [...buckets.entries()]
        .sort((a, b) => b[1].n - a[1].n || a[0] - b[0])
        .slice(0, n)
        .map(([, v]) => {
          const rgb = [Math.round(v.r / v.n), Math.round(v.g / v.n), Math.round(v.b / v.n)];
          const hex = "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
          return { hex, rgb, ratio: Math.round((v.n / sampled) * 1e4) / 1e4 };
        });
      return { width, height, sampled, colors };
    },
  },
  {
    route: "POST /api/image-crop", name: "Image crop", slug: "image-crop", category: "web", price: "$0.002",
    description:
      "Crop an image to a pixel box, and/or rotate (90/180/270) and flip it - applied in that order. Send a public image URL or a base64 image. Returns the result as binary, or as a JSON data URI with dataUri:true. Deterministic.",
    tags: ["image", "crop", "rotate", "flip", "transform"],
    discovery: {
      bodyType: "json",
      input: { url: EXAMPLE_IMAGE_URL, left: 10, top: 10, width: 60, height: 40, dataUri: true },
      inputSchema: {
        properties: {
          url: { type: "string", description: "public http(s) image URL (fetched server-side, 5MB cap)" },
          image: { type: "string", description: "alternative: base64 image, optionally a data: URL" },
          left: { type: "number", description: "crop box left edge in px (default 0)" },
          top: { type: "number", description: "crop box top edge in px (default 0)" },
          width: { type: "number", description: "crop box width in px (required with height for a crop)" },
          height: { type: "number", description: "crop box height in px" },
          rotate: { type: "number", description: "rotate by 90, 180, or 270 degrees" },
          flip: { type: "string", description: "horizontal | vertical | both" },
          format: { type: "string", description: "output format: png (default), jpeg, bmp" },
          quality: { type: "number", description: "jpeg quality 1-100 (default 80)" },
          dataUri: { type: "boolean", description: "return JSON {dataUri, width, height, bytes} instead of binary" },
        },
      },
      output: { example: { dataUri: "data:image/png;base64,iVBORw0KG…", width: 60, height: 40, bytes: 4242 } },
    },
    handler: async (i) => {
      const img = await readImage(await inputBuffer(i));
      const w = posInt(i.width), h = posInt(i.height);
      const x = Math.max(0, Math.trunc(Number(i.left ?? i.x ?? 0)) || 0);
      const y = Math.max(0, Math.trunc(Number(i.top ?? i.y ?? 0)) || 0);
      const rotate = i.rotate === undefined ? 0 : Number(i.rotate);
      const flip = i.flip === undefined ? "" : String(i.flip).toLowerCase();
      if (rotate && ![90, 180, 270].includes(rotate)) throw bad("rotate must be 90, 180, or 270");
      if (flip && !["horizontal", "vertical", "both"].includes(flip)) throw bad('flip must be "horizontal", "vertical", or "both"');
      if ((w && !h) || (!w && h)) throw bad("provide both width and height for the crop box");
      if (!w && !h && !rotate && !flip) throw bad("provide a crop box (left, top, width, height) and/or rotate/flip");
      if (w && h) {
        if (w > MAX_DIM || h > MAX_DIM) throw bad(`crop box exceeds ${MAX_DIM}px`);
        if (x + w > img.width || y + h > img.height) {
          throw bad(`crop box (${x},${y} ${w}x${h}) exceeds image bounds (${img.width}x${img.height})`);
        }
        img.crop({ x, y, w, h });
      }
      if (rotate) img.rotate(rotate);
      if (flip) img.flip({ horizontal: flip === "horizontal" || flip === "both", vertical: flip === "vertical" || flip === "both" });
      const out = await toBuffer(img, i.format, i.quality);
      if (!i.dataUri) return out;
      const b64 = out.__binary.toString("base64");
      if (b64.length > MAX_B64) throw Object.assign(new Error("result too large for a data URI - request binary output"), { statusCode: 413 });
      return { dataUri: `data:${out.contentType};base64,${b64}`, width: img.width, height: img.height, bytes: out.__binary.length };
    },
  },
];
