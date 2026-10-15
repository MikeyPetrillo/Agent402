// Jev preview routes (/v1/judge/vision, /v1/judge/locate, /v1/judge/long):
// every refusal happens before the upstream call, the price guard reads the
// private rate, and each route sends its preview header and answers in shape.
//   node scripts/test-judge-preview.js
import { deflateSync } from "node:zlib";
process.env.TYPESAFE_API_KEY = "test-key";
const K = await import("../src/tools/judge-preview-kit.js");
const { setUpstreamCostsForTest } = await import("../src/upstream-costs.js");
// Placeholders, the same as docs/example-upstream-costs.json: rates never live in tests.
const table = (decisions) => ({ models: [["fake/model", { prompt: 1, completion: 1 }]], vendor: { decisions } });
setUpstreamCostsForTest(table({ jev: 1, maxShare: 1 }));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const refuses = async (fn, status, re, label) => {
  let e = null; try { await fn(); } catch (x) { e = x; }
  ok(e && e.statusCode === status && re.test(e.message), `${label} -> ${e?.statusCode} ${String(e?.message || "").slice(0, 90)}`);
};

// A PNG of any size, built the same way the example is.
const png = (W, H) => {
  const crc32 = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, "latin1"), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
  const raw = Buffer.alloc((W * 3 + 1) * H, 200); for (let y = 0; y < H; y++) raw[y * (W * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
};
const IMG = { format: "png", data_base64: png(400, 300) };
const Q = { q: { type: "noul", instructions: "Is `pic` grey?" } };

// --- sizes and shapes -------------------------------------------------------
ok(JSON.stringify(K.imageSize(Buffer.from(png(400, 300), "base64"), "png")) === '{"width":400,"height":300}', "PNG width and height are read from the header");
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0x2c, 0x01, 0x90, 3, 0, 0, 0, 0]), Buffer.alloc(16)]);
ok(JSON.stringify(K.imageSize(jpeg, "jpeg")) === '{"height":300,"width":400}', "JPEG width and height are read from the frame header");
ok(K.imageSize(Buffer.from("not an image at all, just text bytes"), "png") === null, "a non-image reads as no size");
const ex = Buffer.from(K.examplePngBase64(), "base64");
ok(JSON.stringify(K.imageSize(ex, "png")) === '{"width":300,"height":300}', "the published example image is a valid 300x300 PNG");
// Measured 2026-10-15: the call's input tokens minus the same call with no image.
const MEASURED = { "1568x980": 4205 - 280, "1280x800": 2953 - 280, "640x400": 975 - 280 };
ok(Object.entries(MEASURED).every(([k, n]) => { const [w, h] = k.split("x").map(Number); return K.imageTokenBound(w, h) > n; }), "the token bound sits above every measured image count (1568x980, 1280x800, 640x400)");

// --- refusals before any call -------------------------------------------------
await refuses(() => K.validateVisionRequest({ images: { pic: { format: "png", data_base64: png(200, 200) } }, questions: Q }), 400, /200x200/, "an image under the upstream's minimum is refused, not resized");
await refuses(() => K.validateVisionRequest({ images: { pic: { format: "gif", data_base64: "R0lG" } }, questions: Q }), 400, /png.*jpeg/, "a GIF is refused");
await refuses(() => K.validateVisionRequest({ images: { pic: { format: "png", data_base64: "data:image/png;base64,AAAA" } }, questions: Q }), 400, /no data: prefix/, "a data: URL is refused");
await refuses(() => K.validateVisionRequest({ images: { pic: IMG }, questions: { q: { type: "noul", instructions: "Is it grey?" } } }), 400, /names no image/, "a question that names no image is refused");
await refuses(() => K.validateVisionRequest({ images: { a: IMG, b: IMG, c: IMG, d: IMG, e: IMG }, questions: Q }), 400, /At most 4 images/, "a fifth image is refused");
await refuses(() => K.validateVisionRequest({ images: { "bad name": IMG }, questions: Q }), 400, /must start with a letter/, "an image name with a space is refused");
await refuses(() => K.validateVisionRequest({ images: { pic: IMG }, questions: Q, model: "gpt-x" }), 400, /jev-latest/, "an unknown model is refused");
await refuses(() => K.validateLocateRequest({ image: IMG, targets: [] }), 400, /targets/, "locate with no target is refused");
await refuses(() => K.validateLocateRequest({ image: IMG, targets: ["a", "b", "c", "d", "e"] }), 400, /At most 4 targets/, "a fifth target is refused");
await refuses(() => K.validateLongRequest({ state: "x".repeat(K.PREVIEW_LIMITS.longStateBytes + 1), questions: { q: { type: "noul", instructions: "?" } } }), 400, /accepts/, "a document past the cap is refused");
await refuses(() => K.validateLongRequest({ state: "doc", questions: { q: { type: "box", instructions: "the box" } } }), 400, /must be/, "a box question is refused on the long route (no image)");

// --- the request each route sends ----------------------------------------------
{
  const v = K.validateVisionRequest({ images: { pic: IMG }, questions: Q, state: "context text" });
  const ref = v.body.state.pic;
  ok(/^img-[0-9a-f-]{36}$/.test(ref) && v.body.assets[ref]?.data_base64 === IMG.data_base64, "the image goes into state once, under a fresh reference, with its asset beside it");
  ok(v.body.state.context === "context text" && v.body.questions.q.instructions === "Is `pic` grey?", "the buyer's text is context and the question still names the image by the buyer's name");
  ok(v.body.model === "jev-1.13.0" && !v.hasBox, "a vision request without a box runs on the pinned version");
  const b = K.validateVisionRequest({ images: { pic: IMG }, questions: { where: { type: "box", instructions: "the corner of `pic`" } } });
  ok(b.body.model === "jev-preview" && b.hasBox, "a box question always runs on jev-preview");
  const l = K.validateLocateRequest({ image: IMG, targets: ["the `mug`"] });
  ok(l.body.model === "jev-preview" && l.body.questions.t0_box.type === "box" && l.body.questions.t0_present.type === "noul", "locate pairs every box with an is-it-there noul");
  ok(!/`mug`/.test(l.body.questions.t0_box.instructions), "a backtick in a target cannot turn into an image reference");
}

// --- the price guard and the upstream call ------------------------------------
const calls = [];
const stub = (answers, model = "jev-1.13.0", status = 200) => async (url, init) => {
  calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ model, answers, usage: { input_tokens: 600, output_tokens: 20 } }), { status, headers: { "content-type": "application/json" } });
};
{
  const r = await K.judgeVision({ images: { pic: IMG }, questions: Q }, { fetchImpl: stub({ q: { type: "noul", noul: 0.9 } }) });
  ok(r.preview === true && r.answers.q.noul === 0.9 && r.model === "jev-1.13.0", "vision answers in shape and says it is a preview");
  ok(calls.at(-1).headers["TypeSafe-Danger-Zone-Images"] === "true", "vision sends the images header");
  const L = await K.locate({ image: IMG, targets: ["the thing"] }, { fetchImpl: stub({ t0_box: { type: "box", box: { top: 0.1, bottom: 0.5, left: 0.2, right: 0.6 }, confidence: 0.8 }, t0_present: { type: "noul", noul: 0.2 } }, "jev-1.14.0") });
  ok(L.results[0].found === false && L.results[0].present === 0.2 && L.results[0].box.left === 0.2, "locate reports found:false when the noul says the target is absent, with the guessed box beside it");
  const g = await K.judgeLong({ state: "a long document", questions: { q: { type: "noul", instructions: "Is it long?" } } }, { fetchImpl: stub({ q: { type: "noul", noul: 0.1 } }) });
  ok(g.answers.q.noul === 0.1 && calls.at(-1).headers["TypeSafe-Danger-Zone-Long-Context"] === "true", "long sends the long-context header");
  const err499 = async () => new Response(JSON.stringify({ detail: { message: "An unexpected error occurred", error_type: "internal_server_error" } }), { status: 499, headers: { "content-type": "application/json" } });
  await refuses(() => K.judgeVision({ images: { pic: IMG }, questions: Q }, { fetchImpl: err499 }), 503, /internal error/, "the upstream's 499 internal error is a 503 to retry, not a 400 to fix");
  await refuses(() => K.locate({ image: IMG, targets: ["x"] }, { fetchImpl: stub({ t0_box: { type: "box", box: { top: 0.5, bottom: 0.1, left: 0, right: 1 }, confidence: 0.5 }, t0_present: { type: "noul", noul: 0.9 } }) }), 502, /malformed box/, "an inverted box from upstream is a 502, not a paid malformed answer");
}
{
  // No rate in the table: the route refuses before the call and charges nothing.
  setUpstreamCostsForTest(table({ maxShare: 1 }));
  const before = calls.length;
  await refuses(() => K.judgeVision({ images: { pic: IMG }, questions: Q }, { fetchImpl: stub({}) }), 503, /not priced/, "with no Jev rate in the table the route refuses with nothing charged");
  // A share so small that any request's worst case exceeds it.
  setUpstreamCostsForTest(table({ jev: 1, maxShare: 1e-12 }));
  await refuses(() => K.judgeLong({ state: "doc", questions: { q: { type: "noul", instructions: "?" } } }, { fetchImpl: stub({}) }), 413, /larger than one call/, "a worst case over the table's share of the price is refused before the call");
  ok(calls.length === before, "neither refusal reached the upstream");
  setUpstreamCostsForTest(table({ jev: 1, maxShare: 1 }));
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
