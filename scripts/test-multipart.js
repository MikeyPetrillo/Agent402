// The multipart parser behind OpenAI's transcription wire (src/multipart.js).
//
// Why it exists and why it is hand-written is in that file's header. What this
// pins is the part that would fail SILENTLY and expensively: a parser that is
// almost byte-exact returns audio that still decodes, so the transcript comes
// back subtly wrong rather than erroring. Every case here uses a body built
// the way an SDK builds one, with binary that CONTAINS the sequences the
// parser splits on.
//
//   node scripts/test-multipart.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { leastOurs } from "./lib/ours-clock.js";
const { parseMultipartFile, boundaryOf } = await import("../src/multipart.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const throws = (fn, frag, m) => { let e = null; try { fn(); } catch (x) { e = x; } ok(e && String(e.message).includes(frag) && e.statusCode === 400, `${m} (${e ? e.message.slice(0, 70) : "no throw"})`); };

const B = "----formdata-agent402-9x7";
const CT = `multipart/form-data; boundary=${B}`;
const p = (s) => Buffer.from(s, "utf8");
const build = (parts) => Buffer.concat([...parts, p(`--${B}--\r\n`)]);
const field = (n, v) => p(`--${B}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`);
const filePart = (n, fn, buf, type = "audio/mpeg") => Buffer.concat([p(`--${B}\r\nContent-Disposition: form-data; name="${n}"; filename="${fn}"\r\nContent-Type: ${type}\r\n\r\n`), buf, p("\r\n")]);

// Binary that contains CRLF, a "--" run and the literal word the boundary
// starts with - the bytes a naive string split mangles.
const AUDIO = Buffer.concat([
  Buffer.from([0xff, 0xfb, 0x90, 0x00]),
  p("\r\n--formdata\r\n"),
  Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x1a]),
]);

ok(boundaryOf(CT) === B, "the boundary is read from the Content-Type");
ok(boundaryOf(`multipart/form-data; charset=utf-8; boundary="${B}"`) === B, "a quoted boundary after another parameter is read too");
ok(boundaryOf("application/json") === null && boundaryOf("") === null, "a non-multipart type has no boundary");
ok(boundaryOf(`multipart/form-data; boundary=${"x".repeat(71)}`) === null, "a boundary over RFC 2046's 70 characters is refused rather than trusted");

{
  const { fields, file } = parseMultipartFile(build([field("model", "gpt-transcribe"), filePart("file", "clip.mp3", AUDIO), field("language", "en")]), CT);
  ok(fields.model === "gpt-transcribe" && fields.language === "en", "text fields either side of the file are read");
  ok(file.filename === "clip.mp3" && file.field === "file", "the file part carries its name and field");
  ok(file.buf.equals(AUDIO), "the file bytes are BYTE-IDENTICAL, including the CRLF and boundary-like text inside them");
}
{
  // The trailing CRLF belongs to the delimiter, not the content: off by two
  // bytes here and every transcript is of very slightly the wrong audio.
  const one = Buffer.from([0x41]);
  const { file } = parseMultipartFile(build([filePart("file", "a.wav", one, "audio/wav")]), CT);
  ok(file.buf.length === 1 && file.buf[0] === 0x41, "a one-byte file is one byte, so the delimiter's CRLF is not counted as content");
}
{
  const { file, fields } = parseMultipartFile(build([field("model", "m")]), CT);
  ok(file === null && fields.model === "m", "a body with no file part reports no file rather than throwing");
}
throws(() => parseMultipartFile(build([filePart("file", "a.mp3", AUDIO), filePart("file2", "b.mp3", AUDIO)]), CT), "exactly one file", "a second file part is refused, never silently dropped");
throws(() => parseMultipartFile(build([field("x", "y")]), "application/json"), "multipart/form-data", "a non-multipart content type is refused");
throws(() => parseMultipartFile(p("no boundary here at all"), CT), "no boundary marker", "a body missing the boundary marker is refused");
throws(() => parseMultipartFile(build(Array.from({ length: 20 }, (_, i) => field(`f${i}`, "v"))), CT), "more than", "a body with too many parts is refused");
throws(() => parseMultipartFile(build([field("big", "x".repeat(5000))]), CT), "too large", "an oversized text field is refused");

// The wire's own refusals, without a key or an upstream.
{
  const { makeMultipartHandler } = await import("../src/tools/stt-kit.js");
  const h = makeMultipartHandler("transcribe");
  let e = null;
  try { await h({}, { headers: { "content-type": "application/json" }, body: Buffer.from("{}") }); } catch (x) { e = x; }
  ok(e && /multipart\/form-data/.test(e.message) && /\/api\/transcribe/.test(e.message), "a JSON body on the wire route is told what this route takes AND where the URL route is");
  e = null;
  try { await h({}, { headers: { "content-type": CT }, body: build([field("model", "m")]) }); } catch (x) { e = x; }
  ok(e && /no "file" part/.test(e.message), "a multipart body with no file names the missing part");
}

// handlerInputOf spread the RAW BODY one property per BYTE, because a Buffer
// is an object and is not an Array. 3 MB became 3,145,728 keys in 500 ms of
// blocked event loop, on every paid request, and it arrived with this route -
// the first to mount express.raw. Asserted in TIME as well as shape: a
// correctness-only check passes against the old condition too.
{
  const { handlerInputOf } = await import("../src/handler-input.js");
  const big = Buffer.alloc(3 * 1024 * 1024);
  // Synchronous, so read as the time the thread had a core, least of three.
  const { value: got, ms } = leastOurs(() => handlerInputOf({ query: { a: "1" }, headers: {}, body: big }), { giveUp: 1000 });
  ok(Object.keys(got).length === 1, `a raw body is not expanded into parameters (got ${Object.keys(got).length} keys)`);
  ok(got.a === "1", "the query string still becomes parameters beside a raw body");
  ok(ms < 100, `a 3 MB raw body costs no measurable time (${ms.toFixed(1)}ms)`);
  const json = handlerInputOf({ query: {}, headers: {}, body: { text: "x" } });
  ok(json.text === "x", "a JSON body is still spread into parameters, unchanged");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
