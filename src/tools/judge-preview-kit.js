// Jev preview features on the paid surface (2026-10-15): typed questions about
// images, finding things in an image, and judging long documents.
//
// TypeSafe ships all three as experimental, opt-in features of its System One
// endpoint, each behind its own request header. They are sold here as their
// own routes, labeled preview, so /v1/judge keeps exactly the behavior it has.
//
// MONEY BOUND. Every route has one flat price, and the upstream bills input
// tokens. Images are billed as input tokens with no published per-image count,
// so the count was measured (2026-10-15: about one token per 365 pixels plus a
// small fixed part, the same on jev-1.13.0 and jev-1.14.0). Each request's
// worst case is computed BEFORE the call from the image sizes we parse and the
// bytes we send, using a deliberately higher estimate, and a request whose
// worst case would cost more than the table's share of the price is refused
// with nothing charged. Without the private rate (vendor.decisions.jev) the
// routes refuse with a 503: a call we cannot price is never sent.
//
// Images go into `state` once, under the buyer's own names, and questions
// refer to them as `name` in backticks. An image named inside a question's
// instructions would be billed again for every question, so names are only
// ever placed in state.
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { upstreamCosts } from "../upstream-costs.js";
import { buildQuestions, post, upstreamJevModel, LIMITS } from "./judge-kit.js";

const ENDPOINT = (process.env.TYPESAFE_API_URL || "https://api.typesafe.ai/v1/systemone").trim();
const keyOf = () => (process.env.TYPESAFE_API_KEY || "").trim();
export const judgePreviewEnabled = () => !!keyOf();

export const VISION_PRICE_USD = 0.003;
export const LOCATE_PRICE_USD = 0.002;
export const LONG_PRICE_USD = 0.02;

export const PREVIEW_LIMITS = {
  images: 4,
  imageBytes: 4 * 1024 * 1024,           // decoded, each; the upstream allows 16 MiB
  minSide: 256, maxSide: 1568,           // the upstream's own bounds; images are refused, never resized
  minPixels: 78_400, maxPixels: 2_458_624,
  targets: 4,                            // locate: things to find in one image
  longStateBytes: 900_000,               // under the upstream's 262k-token long-context window at one token per 3.4 bytes
  longContextTokens: 262_144,
};

// Measured near one token per 365 pixels; 300 plus a fixed 120 bounds it from above.
export const imageTokenBound = (w, h) => Math.ceil((w * h) / 300) + 120;

const bad = (msg, status = 400) => { const e = new Error(msg); e.statusCode = status; return e; };

/** Width and height of a PNG or JPEG, or null. An animated PNG reads as null. */
export function imageSize(buf, format) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (format === "png") {
    if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
    // An acTL chunk before the first IDAT marks an animated PNG.
    for (let off = 8; off + 8 <= buf.length;) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString("latin1", off + 4, off + 8);
      if (type === "acTL") return null;
      if (type === "IDAT") break;
      off += 12 + len;
    }
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (format === "jpeg") {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    for (let off = 2; off + 9 < buf.length;) {
      if (buf[off] !== 0xff) return null;
      const marker = buf[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + len;
    }
  }
  return null;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** The buyer's images, checked: { name: { format, data_base64 } } in, the
 *  upstream assets plus each image's token bound out. */
export function buildImages(images, { max = PREVIEW_LIMITS.images } = {}) {
  if (!images || typeof images !== "object" || Array.isArray(images)) {
    throw bad('"images" must be a map of your own names to { "format": "png" | "jpeg", "data_base64": "..." }.');
  }
  const names = Object.keys(images);
  if (!names.length) throw bad('"images" is empty. Send at least one image.');
  if (names.length > max) throw bad(`At most ${max} images per call; got ${names.length}.`);
  const assets = {}, refs = {};
  let tokens = 0;
  for (const name of names) {
    if (!NAME_RE.test(name)) throw bad(`Image name "${String(name).slice(0, 40)}" must start with a letter and use only letters, digits and underscores (32 at most).`);
    const im = images[name];
    if (!im || typeof im !== "object") throw bad(`Image "${name}" must be an object with "format" and "data_base64".`);
    const fmt = String(im.format || "").toLowerCase();
    const format = fmt === "jpg" ? "jpeg" : fmt;
    if (format !== "png" && format !== "jpeg") throw bad(`Image "${name}" has format ${JSON.stringify(im.format)}; send "png" or "jpeg".`);
    const b64 = String(im.data_base64 || "");
    if (!b64 || b64.length % 4 !== 0 || !B64_RE.test(b64)) throw bad(`Image "${name}" needs "data_base64": standard base64 with padding, no data: prefix and no line breaks.`);
    const buf = Buffer.from(b64, "base64");
    if (buf.length > PREVIEW_LIMITS.imageBytes) throw bad(`Image "${name}" is ${buf.length} bytes; the limit is ${PREVIEW_LIMITS.imageBytes}.`, 413);
    const size = imageSize(buf, format);
    if (!size) throw bad(`Image "${name}" is not a readable still ${format === "png" ? "PNG" : "JPEG"}.`);
    const { width, height } = size;
    const px = width * height;
    if (width < PREVIEW_LIMITS.minSide || height < PREVIEW_LIMITS.minSide || width > PREVIEW_LIMITS.maxSide || height > PREVIEW_LIMITS.maxSide
      || px < PREVIEW_LIMITS.minPixels || px > PREVIEW_LIMITS.maxPixels) {
      throw bad(`Image "${name}" is ${width}x${height}. Each side must be ${PREVIEW_LIMITS.minSide} to ${PREVIEW_LIMITS.maxSide} pixels and the image ${PREVIEW_LIMITS.minPixels} to ${PREVIEW_LIMITS.maxPixels} pixels in all; images are not resized.`);
    }
    const ref = `img-${randomUUID()}`;
    assets[ref] = { type: "image", format: format === "jpeg" ? "jpeg" : "png", data_base64: b64 };
    refs[name] = ref;
    tokens += imageTokenBound(width, height);
  }
  return { assets, refs, tokens };
}

/** Upstream rate and share from the private table, or a 503 that charges nothing. */
function priceGuard(worstTokens, priceUsd) {
  const d = upstreamCosts().vendor?.decisions || {};
  const rate = d.jev, share = d.maxShare;
  if (rate == null || share == null) throw bad("This preview route is not priced on this host yet; nothing was charged.", 503);
  if ((worstTokens * rate) / 1e6 > share * priceUsd) {
    throw bad("This request is larger than one call of this route covers. Send fewer or smaller images, or a shorter text.", 413);
  }
}

function textState(state, maxChars = LIMITS.stateChars) {
  if (state == null || state === "") return null;
  const s = typeof state === "string" ? state : JSON.stringify(state);
  if (s.length > maxChars) throw bad(`"state" is ${s.length} characters; this route accepts ${maxChars}.`);
  return s;
}

// Answer checks: the shapes the upstream documents, so a changed preview
// answer is a 502 that charges nothing instead of a paid malformed result.
const prob = (x) => typeof x === "number" && x >= 0 && x <= 1;
function checkAnswers(answers, questions) {
  if (!answers || typeof answers !== "object") throw bad("Judgment upstream returned no answers.", 502);
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    if (!a || a.type !== q.type) throw bad(`Judgment upstream returned no "${q.type}" answer for "${id}".`, 502);
    if (q.type === "noul" && !prob(a.noul)) throw bad(`Judgment upstream returned a malformed noul for "${id}".`, 502);
    if (q.type === "box") {
      const b = a.box || {};
      if (![b.top, b.bottom, b.left, b.right].every(prob) || !(b.left < b.right && b.top < b.bottom) || !prob(a.confidence)) {
        throw bad(`Judgment upstream returned a malformed box for "${id}".`, 502);
      }
    }
    if ((q.type === "choice" || q.type === "score") && !prob(a.confidence)) throw bad(`Judgment upstream returned a malformed ${q.type} for "${id}".`, 502);
  }
  return answers;
}

const IMAGES_HEADER = { "TypeSafe-Danger-Zone-Images": "true" };
const LONG_HEADER = { "TypeSafe-Danger-Zone-Long-Context": "true" };
const hasAnswers = (j) => j?.answers && typeof j.answers === "object";

/** POST /v1/judge/vision: typed questions about up to four images. */
export function validateVisionRequest(input = {}) {
  const model = String(input.model || "jev-latest");
  if (model !== "jev-latest" && model !== "jev-preview") throw bad('"model" must be "jev-latest" or "jev-preview".');
  const questions = buildQuestions(input.questions, { allowBox: true });
  const hasBox = Object.values(questions).some((q) => q.type === "box");
  const { assets, refs, tokens } = buildImages(input.images);
  const context = textState(input.state);
  const state = { ...(context ? { context } : {}), ...refs };
  // Every question must name one of the images; a question that names none
  // would be answered about nothing the buyer sent.
  for (const [id, q] of Object.entries(questions)) {
    const text = `${q.instructions} ${q.criteria ? JSON.stringify(q.criteria) : ""}`;
    if (!Object.keys(refs).some((n) => text.includes(`\`${n}\``))) {
      throw bad(`Question "${id}" names no image. Refer to one as \`name\` in its instructions (your names: ${Object.keys(refs).join(", ")}).`);
    }
  }
  // Box answers exist only on the newer release.
  const upstreamModel = hasBox ? "jev-preview" : upstreamJevModel(model);
  const body = { model: upstreamModel, state, assets, questions };
  const textBytes = Buffer.byteLength(JSON.stringify({ ...body, assets: {} }));
  return { body, worstTokens: tokens + textBytes, hasBox };
}

export async function judgeVision(input, { fetchImpl = fetch } = {}) {
  const { body, worstTokens, hasBox } = validateVisionRequest(input);
  priceGuard(worstTokens, VISION_PRICE_USD);
  const j = await post(ENDPOINT, keyOf(), body, fetchImpl, hasAnswers, IMAGES_HEADER);
  return {
    model: j.model || body.model,
    preview: true,
    answers: checkAnswers(j.answers, body.questions),
    usage: j.usage,
    ...(hasBox ? { note: "A box answer always returns a box, even when the thing is not in the image; pair it with a noul that asks whether it is there." } : {}),
  };
}

/** POST /v1/judge/locate: where each target is in one image, and whether it is there at all. */
export function validateLocateRequest(input = {}) {
  const targets = Array.isArray(input.targets) ? input.targets : typeof input.target === "string" ? [input.target] : null;
  if (!targets || !targets.length) throw bad('"targets" must be a list of the things to find, for example ["the coffee mug"].');
  if (targets.length > PREVIEW_LIMITS.targets) throw bad(`At most ${PREVIEW_LIMITS.targets} targets per call; got ${targets.length}.`);
  const clean = targets.map((t, i) => {
    const s = String(t ?? "").trim();
    if (!s) throw bad(`Target ${i + 1} is empty.`);
    if (s.length > 200) throw bad(`Target ${i + 1} is ${s.length} characters; the limit is 200.`);
    return s.replace(/`/g, "'");
  });
  const im = input.image;
  if (!im || typeof im !== "object") throw bad('"image" must be { "format": "png" | "jpeg", "data_base64": "..." }.');
  const { assets, refs, tokens } = buildImages({ image: im }, { max: 1 });
  const questions = {};
  clean.forEach((t, i) => {
    questions[`t${i}_box`] = { type: "box", instructions: `${t} in \`image\`` };
    questions[`t${i}_present`] = { type: "noul", instructions: `Is ${t} visible in \`image\`?` };
  });
  const body = { model: "jev-preview", state: refs, assets, questions };
  const textBytes = Buffer.byteLength(JSON.stringify({ ...body, assets: {} }));
  return { body, worstTokens: tokens + textBytes, targets: clean };
}

export async function locate(input, { fetchImpl = fetch } = {}) {
  const { body, worstTokens, targets } = validateLocateRequest(input);
  priceGuard(worstTokens, LOCATE_PRICE_USD);
  const j = await post(ENDPOINT, keyOf(), body, fetchImpl, hasAnswers, IMAGES_HEADER);
  const a = checkAnswers(j.answers, body.questions);
  return {
    model: j.model || body.model,
    preview: true,
    results: targets.map((target, i) => {
      const box = a[`t${i}_box`], present = a[`t${i}_present`].noul;
      return { target, present, found: present >= 0.5, box: box.box, boxConfidence: box.confidence };
    }),
    usage: j.usage,
    note: "box edges are fractions of the image (top and bottom of its height, left and right of its width). found is present >= 0.5; when it is false the box is the model's best guess and should not be used.",
  };
}

/** POST /v1/judge/long: /v1/judge's questions over a document up to about 262k tokens. */
export function validateLongRequest(input = {}) {
  const model = String(input.model || "jev-latest");
  if (model !== "jev-latest" && model !== "jev-preview") throw bad('"model" must be "jev-latest" or "jev-preview".');
  const s = textState(input.state, PREVIEW_LIMITS.longStateBytes);
  if (!s || !s.trim()) throw bad('"state" is required: the document to judge, as a string or an object.');
  if (Buffer.byteLength(s) > PREVIEW_LIMITS.longStateBytes) throw bad(`"state" is ${Buffer.byteLength(s)} bytes; this route accepts ${PREVIEW_LIMITS.longStateBytes}.`, 413);
  const questions = buildQuestions(input.questions);
  const body = { model: upstreamJevModel(model), state: s, questions };
  // One token per byte is the upstream's ceiling here only up to its window;
  // a request past the window is refused upstream (400) and not billed.
  const worstTokens = Math.min(Buffer.byteLength(JSON.stringify(body)), PREVIEW_LIMITS.longContextTokens);
  return { body, worstTokens };
}

export async function judgeLong(input, { fetchImpl = fetch } = {}) {
  const { body, worstTokens } = validateLongRequest(input);
  priceGuard(worstTokens, LONG_PRICE_USD);
  const j = await post(ENDPOINT, keyOf(), body, fetchImpl, hasAnswers, LONG_HEADER);
  return { model: j.model || body.model, preview: true, answers: checkAnswers(j.answers, body.questions), usage: j.usage };
}

// The published examples carry a real image: a 300x300 white PNG with a red
// square in its lower right, built here from pixels so no binary lives in the
// source. Every example answers against it (test-all calls each example).
function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function examplePngBase64() {
  const W = 300, H = 300;
  const raw = Buffer.alloc((W * 3 + 1) * H, 255);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      if (x >= 180 && x < 270 && y >= 170 && y < 250) { const o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = 220; raw[o + 1] = 40; raw[o + 2] = 40; }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw, { level: 9 })), pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
const EXAMPLE_PNG = examplePngBase64();

const PREVIEW_NOTE = "Preview: built on Jev features its maker labels experimental. Answers come from a model, not deterministic code.";

export const JUDGE_PREVIEW_TOOLS = [{
  route: "POST /v1/judge/vision",
  name: "Judge images (preview)",
  slug: "judge-vision",
  category: "ai",
  price: `$${VISION_PRICE_USD}`,
  description: `Ask typed questions about up to ${PREVIEW_LIMITS.images} images (PNG or JPEG) and get answers your code can branch on: noul (yes/no probability), choice, score, and box (where something is, as edges from 0 to 1). Name each image, then refer to it as \`name\` in a question. ${PREVIEW_NOTE}`,
  tags: ["ai", "vision", "image", "judgment", "classify", "preview"],
  aliases: ["image-question", "image-classify", "screenshot-check"],
  discovery: {
    bodyType: "json",
    inputSchema: {
      type: "object",
      required: ["images", "questions"],
      properties: {
        images: { type: "object", description: `Your own names mapped to { format: "png" | "jpeg", data_base64 }. Up to ${PREVIEW_LIMITS.images}; each side ${PREVIEW_LIMITS.minSide} to ${PREVIEW_LIMITS.maxSide} px, ${PREVIEW_LIMITS.imageBytes / 1048576} MiB each. Images are not resized.` },
        questions: { type: "object", description: "Your own ids mapped to { type: noul | choice | score | box, instructions, criteria }. Refer to an image as `name` in backticks." },
        state: { type: ["string", "object"], description: `Optional text context, up to ${LIMITS.stateChars} characters.` },
        model: { type: "string", enum: ["jev-latest", "jev-preview"], description: "jev-latest is the tested Jev version; a box question always runs on jev-preview." },
      },
    },
    input: {
      images: { picture: { format: "png", data_base64: EXAMPLE_PNG } },
      questions: { has_red: { type: "noul", instructions: "Does `picture` contain a red shape?" } },
    },
    example: { model: "jev-1.13.0", preview: true, answers: { has_red: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 520, output_tokens: 20 } },
  },
  validateInput: (input) => { validateVisionRequest(input); },
  handler: (input) => judgeVision(input),
}, {
  route: "POST /v1/judge/locate",
  name: "Locate in image (preview)",
  slug: "judge-locate",
  category: "ai",
  price: `$${LOCATE_PRICE_USD}`,
  description: `Find up to ${PREVIEW_LIMITS.targets} things in one image: each comes back with whether it is there (a probability) and its box, as edges from 0 to 1. ${PREVIEW_NOTE}`,
  tags: ["ai", "vision", "image", "locate", "bounding-box", "preview"],
  aliases: ["bounding-box", "object-locate", "find-in-image"],
  discovery: {
    bodyType: "json",
    inputSchema: {
      type: "object",
      required: ["image", "targets"],
      properties: {
        image: { type: "object", description: `{ format: "png" | "jpeg", data_base64 }; each side ${PREVIEW_LIMITS.minSide} to ${PREVIEW_LIMITS.maxSide} px.` },
        targets: { type: "array", items: { type: "string" }, description: `What to find, up to ${PREVIEW_LIMITS.targets}, for example "the coffee mug".` },
      },
    },
    input: { image: { format: "png", data_base64: EXAMPLE_PNG }, targets: ["the red square"] },
    example: { model: "jev-1.14.0", preview: true, results: [{ target: "the red square", present: 0.99, found: true, box: { top: 0.57, bottom: 0.83, left: 0.6, right: 0.9 }, boxConfidence: 0.95 }] },
  },
  validateInput: (input) => { validateLocateRequest(input); },
  handler: (input) => locate(input),
}, {
  route: "POST /v1/judge/long",
  name: "Judge long documents (preview)",
  slug: "judge-long",
  category: "ai",
  price: `$${LONG_PRICE_USD}`,
  description: `The typed questions of /v1/judge over a document of up to ${Math.round(PREVIEW_LIMITS.longStateBytes / 1000)} KB (about 262k tokens), in one call. ${PREVIEW_NOTE}`,
  tags: ["ai", "judgment", "long-context", "document", "classify", "preview"],
  discovery: {
    bodyType: "json",
    inputSchema: {
      type: "object",
      required: ["state", "questions"],
      properties: {
        state: { type: ["string", "object"], description: `The document, up to ${PREVIEW_LIMITS.longStateBytes} bytes.` },
        questions: { type: "object", description: "Your own ids mapped to { type: noul | choice | score, instructions, criteria }, as on /v1/judge." },
        model: { type: "string", enum: ["jev-latest", "jev-preview"] },
      },
    },
    input: {
      state: "Section 1. The tenant pays rent on the first of each month. Section 2. Either party may end this lease with 60 days written notice.",
      questions: { has_notice: { type: "noul", instructions: "Does the document set a notice period for ending the agreement?" } },
    },
    example: { model: "jev-1.13.0", preview: true, answers: { has_notice: { type: "noul", noul: 0.98 } }, usage: { input_tokens: 64, output_tokens: 20 } },
  },
  validateInput: (input) => { validateLongRequest(input); },
  handler: (input) => judgeLong(input),
}];
