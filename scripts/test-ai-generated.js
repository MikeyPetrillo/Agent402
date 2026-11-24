// The machine-readable AI-generated mark (src/ai-generated.js; EU AI Act
// Art. 50(2)): every model-backed tool's answer carries it.
//   - unit: a JSON answer gets `aiGenerated: true`, a byte answer the
//     `X-AI-Generated: true` header beside its own, a generated PNG, JPEG,
//     WebP or MP3 the IPTC source type inside the file (src/ai-media-mark.js), a /v1
//     wire answer and a stream writer keep their body; marking twice adds once;
//   - the class, on a booted server: every catalog row marked modelBacked is
//     marked aiGenerated (its handler wrapped, its JSON example carrying the
//     field), and no deterministic tool is;
//   - the send path: server.js sets the header on every success form (cache
//     hit, bytes, stream, JSON) through markAiAnswer, as an answer header.
// The header and field on a real paid answer are read in
// scripts/test-settlement-event.js (a paid image-gen-premium call).
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const G = await import("../src/ai-generated.js");
{
  // Served reports: a model-written card or monitor report carries the header and the field.
  const { CODE_WRITTEN_REPORT_KINDS } = await import("../src/report-disclosure.js");
  const hdrs = {}; const res = { setHeader: (k, v) => { hdrs[k] = v; } };
  const out = G.withReportAiMark(res, { status: "done", kind: "dossier", report: "text" });
  ok(out.aiGenerated === true && hdrs["X-AI-Generated"] === "true", "a model-written report served at /api/r or /api/m carries aiGenerated and X-AI-Generated");
  const h2 = {}; const pending = { status: "pending" };
  ok(G.withReportAiMark({ setHeader: (k, v) => { h2[k] = v; } }, pending) === pending && !h2["X-AI-Generated"], "a pending report is answered as it is");
  const codeKind = (CODE_WRITTEN_REPORT_KINDS || [])[0];
  if (codeKind) { const h3 = {}; const c = { status: "done", kind: codeKind, report: "x" }; ok(G.withReportAiMark({ setHeader: (k, v) => { h3[k] = v; } }, c) === c && !h3["X-AI-Generated"], `a report our code wrote (${codeKind}) is not marked`); }
  const server = (await import("node:fs")).readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/json\(withReportAiMark\(res, await _humanCheckout\.fulfill\(/.test(server) && /res\.json\(v \? withReportAiMark\(res, v\)/.test(server), "both report routes send their body through withReportAiMark");
}
const { AI_VOICE_HEADER } = await import("../src/ai-voice.js");
ok(G.AI_GENERATED_HEADER === AI_VOICE_HEADER && G.AI_GENERATED_HEADER === "X-AI-Generated", "one header name for every model-backed answer, the one speech already sends");
{
  ok(G.withAiGenerated({ text: "x" }).aiGenerated === true, "a JSON answer gets aiGenerated: true");
  const bytes = Buffer.from([1, 2, 3, 4]);
  const b = G.withAiGenerated({ __binary: bytes, contentType: "image/png", headers: { "X-Other": "1" } });
  ok(b.headers["X-AI-Generated"] === "true" && b.headers["X-Other"] === "1" && b.__binary === bytes && !("aiGenerated" in b), "a byte answer gets the header beside its own, the same bytes untouched");
  // The mark inside the file (src/ai-media-mark.js): a real PNG, JPEG, WebP
  // and MP3 come back with the IPTC source type written in and still decode;
  // a file with content credentials or XMP of its own is passed through.
  {
    const M = await import("../src/ai-media-mark.js");
    const { Jimp } = await import("jimp");
    const img = new Jimp({ width: 4, height: 3, color: 0x3366ccff });
    const png = await img.getBuffer("image/png");
    const jpg = await img.getBuffer("image/jpeg");
    const has = (buf) => buf.includes(Buffer.from(M.DIGITAL_SOURCE_TYPE, "latin1"));
    const pb = G.withAiGenerated({ __binary: png, contentType: "image/png" }).__binary;
    ok(has(pb) && pb.length > png.length && (await Jimp.read(pb)).bitmap.width === 4, "a generated PNG carries the IPTC source type in an XMP chunk and still decodes");
    ok(M.markMediaBytes(pb) === pb, "a PNG already marked (its own XMP) is not marked twice");
    const jb = G.withAiGenerated({ __binary: jpg, contentType: "image/jpeg" }).__binary;
    ok(has(jb) && (await Jimp.read(jb)).bitmap.height === 3 && M.markMediaBytes(jb) === jb, "a generated JPEG carries it in an APP1 XMP segment, still decodes, and is marked once");
    const webp = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
    const wb = M.markMediaBytes(webp);
    ok(has(wb) && wb.toString("latin1", 12, 16) === "VP8X" && (wb[20] & 0x04) && wb.readUInt32LE(4) === wb.length - 8 && wb.includes(Buffer.from("VP8L")), "a simple WebP gets a VP8X header with the XMP flag, its frame kept, and a consistent RIFF size");
    const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);
    const mb = M.markMediaBytes(mp3, { contentType: "audio/mpeg" });
    ok(mb.toString("latin1", 0, 3) === "ID3" && mb.includes(Buffer.from("TXXX")) && has(mb) && mb.subarray(mb.length - mp3.length).equals(mp3), "an MP3 with no tag gets an ID3 tag naming the source type, the audio untouched");
    ok(M.markMediaBytes(mb, { contentType: "audio/mpeg" }) === mb, "an MP3 with a tag of its own is left as it is");
    // Raw PCM (the speech wire's response_format pcm) can start 0xFF 0xFx: never tagged.
    const pcm = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xfb]), Buffer.alloc(400, 7)]);
    for (const ct of ["audio/pcm", "audio/L16", "application/octet-stream", "", "audio/wav"]) ok(M.markMediaBytes(pcm, { contentType: ct }) === pcm, `PCM starting FF FF under ${ct || "no type"} is returned byte-identical`);
    ok(M.markMediaBytes(mp3, { contentType: "audio/pcm" }) === mp3 && M.markMediaBytes(mp3) === mp3, "MPEG-looking bytes declared audio/pcm, or with no declared type, are never tagged");
    ok(M.markMediaBytes(pcm, { contentType: "audio/mpeg" }) === pcm, "bytes declared audio/mpeg that are no valid MPEG frame are left as they are");
    const pcmAnswer = G.withAiGenerated({ __binary: pcm, contentType: "audio/pcm" });
    ok(pcmAnswer.__binary === pcm && pcmAnswer.headers["X-AI-Generated"] === "true", "a PCM byte answer keeps its bytes and still gets the header");
    const c2pa = Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, 0xeb, 0x00, 0x06, 0x4a, 0x50, 0x00, 0x00]), jpg.subarray(2)]);
    ok(M.markMediaBytes(c2pa) === c2pa, "a JPEG with content credentials (APP11 JUMBF) is passed through untouched");
    const b64 = png.toString("base64");
    const wire = G.withAiGenerated({ created: 1, data: [{ b64_json: b64 }] }, { wire: true });
    ok(has(Buffer.from(wire.data[0].b64_json, "base64")) && !("aiGenerated" in wire), "an image on the images wire (data[].b64_json) carries the mark in the file; the wire body keeps its shape");
    const tool = G.withAiGenerated({ image: b64, model: "m" });
    ok(has(Buffer.from(tool.image, "base64")) && tool.aiGenerated === true, "an image tool's base64 image carries the mark in the file");
    ok(M.markMediaBytes(Buffer.from("not media at all")).toString() === "not media at all" && M.markMediaBase64("short") === "short", "anything else is returned as it is");
  }
  const chat = { id: "c", object: "chat.completion", choices: [] };
  ok(G.withAiGenerated(chat, { wire: true }) === chat, "a /v1 wire answer keeps the provider's body as it is (header only)");
  const sse = { __sse: () => {} };
  ok(G.withAiGenerated(sse) === sse && G.withAiGenerated(null) === null && Array.isArray(G.withAiGenerated([1])), "a stream writer, null and a list pass through");
  ok(G.isWireRoute("POST /v1/chat/completions") && !G.isWireRoute("POST /api/answer"), "wire routes are the /v1 ones");
  const def = { slug: "zz", route: "POST /api/zz", modelBacked: true, handler: async () => ({ a: 1 }), discovery: { output: { example: { a: 1 } } } };
  def.handler.__budget = 5;
  G.markAiGenerated([def]);
  ok((await def.handler({})).aiGenerated === true && def.discovery.output.example.aiGenerated === true && def.handler.__budget === 5, "a marked handler's answers and example carry it; the handler keeps its own marks");
  const h = def.handler; G.markAiGenerated([def]);
  ok(def.handler === h, "marking twice wraps once");
  const plain = { slug: "pp", route: "POST /api/pp", handler: async () => ({ a: 1 }) };
  G.markAiGenerated([plain]);
  ok(!("aiGenerated" in (await plain.handler({}))), "a deterministic tool is not marked");
}
{
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const packs = src.indexOf("for (const slug of modelBackedPackSlugs(");
  const mark = src.indexOf("markAiGenerated(ALL_KIT);");
  ok(packs > 0 && mark > packs, "server.js marks the catalog after the model-backed packs are known");
  ok(/function markAiAnswer\(req, res, tool\) \{\n  if \(tool\?\.modelBacked === true\) setAnswerHeader\(req, res, AI_GENERATED_HEADER, "true"\);/.test(src), "the header is an answer header (a refused payment sends none of it)");
  const hit = src.indexOf('res.setHeader("X-Cache", "hit");\n          markAiAnswer(req, res, tool);');
  const send = src.indexOf("markAiAnswer(req, res, tool);\n      if (result && result.__binary) {");
  ok(hit > 0 && send > 0, "every success form of the route binder sets it: a cache hit, and before bytes, a stream and JSON");
}
{
  const srv = await bootServer({ stores: "ai-generated", env: { FREE_MODE: "true", NODE_ENV: "test", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", TEMPO_API_KEY: "", MPP_SECRET_KEY: "", OPENROUTER_API_KEY: "sk-or-test-never-used", OPENAI_API_KEY: "sk-test-never-used" } });
  try {
    const pricing = await (await fetch(`${srv.url}/api/pricing`)).json();
    const rows = (pricing.tools || pricing.endpoints || []).filter((r) => r && typeof r === "object");
    const mb = rows.filter((r) => r.modelBacked === true);
    ok(mb.length >= 20, `the catalog lists model-backed tools (${mb.length})`);
    const unmarked = mb.filter((r) => r.aiGenerated !== true).map((r) => r.slug);
    ok(unmarked.length === 0, `every model-backed row is marked aiGenerated (unmarked: ${unmarked.slice(0, 12).join(", ") || "none"})`);
    const stray = rows.filter((r) => r.modelBacked !== true && r.aiGenerated === true).map((r) => r.slug);
    ok(stray.length === 0, `no deterministic tool is marked (${stray.join(", ") || "none"})`);
  } finally { await srv.stop(); }
}

console.log(`\ntest-ai-generated: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
