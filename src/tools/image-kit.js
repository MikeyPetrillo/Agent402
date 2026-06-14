// Image kit — pure-CPU image transforms an agent's sandbox usually can't do:
// resize, format-convert, and thumbnail. No network, deterministic, via jimp
// (pure JS, no native deps). Base64 image in, transformed image bytes out
// (same binary contract as /api/qr and /api/screenshot). Covered by
// scripts/test-image.js.
import { Jimp, JimpMime } from "jimp";

function bad(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

const MAX_B64 = 12_000_000; // ~9 MB encoded
const MAX_SRC_PIXELS = 40_000_000; // ~6300x6300 source cap
const MAX_DIM = 4096; // output dimension cap
const MIME = { png: JimpMime.png, jpeg: JimpMime.jpeg, jpg: JimpMime.jpeg, bmp: JimpMime.bmp };

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

async function loadImage(field) {
  const buf = decodeB64(field);
  let img;
  try { img = await Jimp.read(buf); }
  catch (e) { throw bad(`could not decode image: ${e.message}`); }
  if (img.width * img.height > MAX_SRC_PIXELS) throw bad(`source image too large (${img.width}x${img.height})`);
  return img;
}

const posInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };

async function toBuffer(img, format, quality) {
  const fmt = String(format || "png").toLowerCase();
  const mime = MIME[fmt];
  if (!mime) throw bad('format must be "png", "jpeg", or "bmp"');
  const opts = mime === JimpMime.jpeg ? { quality: Math.min(Math.max(posInt(quality) || 80, 1), 100) } : undefined;
  const buffer = await img.getBuffer(mime, opts);
  return { __binary: buffer, contentType: mime };
}

export const IMAGE_TOOLS = [
  {
    route: "POST /api/image-resize", name: "Image resize", slug: "image-resize", category: "web", price: "$0.005",
    description:
      "Resize an image to given pixel dimensions. Send a base64 PNG/JPEG/BMP and width and/or height (give one to scale proportionally). Returns the resized image. Deterministic, no network.",
    tags: ["image", "resize", "scale", "thumbnail", "png", "jpeg"],
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
    handler: async (i) => {
      const img = await loadImage(i.image);
      let w = posInt(i.width), h = posInt(i.height);
      if (!w && !h) throw bad("provide width and/or height");
      if (w && w > MAX_DIM) w = MAX_DIM;
      if (h && h > MAX_DIM) h = MAX_DIM;
      // One dimension → scale proportionally from the source aspect ratio.
      if (w && !h) h = Math.max(1, Math.round(img.height * (w / img.width)));
      if (h && !w) w = Math.max(1, Math.round(img.width * (h / img.height)));
      img.resize({ w, h });
      return toBuffer(img, i.format, i.quality);
    },
  },
  {
    route: "POST /api/image-convert", name: "Image convert", slug: "image-convert", category: "web", price: "$0.005",
    description:
      "Convert an image between formats (PNG, JPEG, BMP). Send a base64 image and the target format; returns the converted image. Optional jpeg quality (1-100). Deterministic, no network.",
    tags: ["image", "convert", "format", "png", "jpeg", "bmp"],
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
      const img = await loadImage(i.image);
      return toBuffer(img, i.format, i.quality);
    },
  },
  {
    route: "POST /api/image-thumbnail", name: "Image thumbnail", slug: "image-thumbnail", category: "web", price: "$0.005",
    description:
      "Make a square thumbnail of an image — scales and center-crops to NxN (default 128). Send a base64 image and optional size. Returns the thumbnail. Deterministic, no network.",
    tags: ["image", "thumbnail", "crop", "square", "preview"],
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
    handler: async (i) => {
      const img = await loadImage(i.image);
      const size = Math.min(Math.max(posInt(i.size) || 128, 1), 1024);
      img.cover({ w: size, h: size });
      return toBuffer(img, i.format, i.quality);
    },
  },
];
