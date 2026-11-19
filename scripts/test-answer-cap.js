// The converter tools hold the size of what they answer with
// (src/tools/answer-cap.js): an input cap bounds what a tool reads, not what
// it writes.
//
//   1. the shared helper: the 413 names the limit; a file past its cap is
//      refused before a byte of it is read;
//   2. audio: an hour of silence in a megabyte of Opus is refused BEFORE the
//      encoder starts, with the limit named, and the process stays small
//      (measured in a child process); a file whose headers understate its
//      length is stopped by the encoder's own size limit and refused before
//      its output is read; a file whose encode fits converts to the same
//      bytes as the plain encode, and low-sample-rate audio the encoder
//      writes at a lower bitrate is not refused on a projection it would not
//      reach;
//   3. PDF: a transform whose saved file passes the cap answers 413 from the
//      worker, before the base64 copy;
//   4. images: an encoded file past the cap is a 413;
//   5. every tool that answers with converted bytes is in one of the two
//      tables, and every listed slug exists.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  MB, ANSWER_CAPS, ANSWER_CAPS_ELSEWHERE, AUDIO_ANSWER_MAX_BYTES, PDF_ANSWER_MAX_BYTES, IMAGE_ANSWER_MAX_BYTES,
  capText, answerTooLarge, assertAnswerBytes, readFileWithin, projectedAudioBytes, audioSecondsWithin, lengthText,
} from "../src/tools/answer-cap.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "a402-answer-cap-"));

try {
  // ---- 1. the helper ---------------------------------------------------------
  ok(capText(60 * MB) === "60 MB" && capText(1.5 * MB) === "1.5 MB", "capText writes whole and fractional megabytes");
  ok(lengthText(3600) === "1 h" && lengthText(2621) === "43 min 41 s" && lengthText(0) === "0 s", "lengthText writes hours, minutes and seconds");
  ok(projectedAudioBytes(3600, 192) === 86_400_000 && audioSecondsWithin(AUDIO_ANSWER_MAX_BYTES, 192) === 2621, "an hour at 192k projects 86.4 MB; the cap holds 2621 s at 192k");
  {
    const e = answerTooLarge("The MP3", 60 * MB, { bytes: 86_400_000, hint: "send a shorter file" });
    ok(e.statusCode === 413 && /60 MB answer limit/.test(e.message) && /send a shorter file/.test(e.message) && e.answerCapBytes === 60 * MB, `the refusal is a 413 that names the limit (${e.message})`);
    ok(assertAnswerBytes(10, 10, "x") === 10 && (await caught(() => assertAnswerBytes(11, 10, "x")))?.statusCode === 413 && (await caught(() => assertAnswerBytes(NaN, 10, "x")))?.statusCode === 413, "assertAnswerBytes passes a size at the cap and refuses one past it (or one that is not a number)");
  }
  {
    const small = join(dir, "small"), big = join(dir, "big");
    writeFileSync(small, randomBytes(4096));
    const got = await readFileWithin(small, 4096, "The file");
    ok(got.equals(readFileSync(small)), "readFileWithin returns a file at its cap, byte for byte");
    // A sparse 1 GB file: reading it would show in resident memory.
    writeFileSync(big, "");
    truncateSync(big, 1024 * MB);
    const before = process.memoryUsage().rss;
    const e = await caught(() => readFileWithin(big, 60 * MB, "The file"));
    const grew = process.memoryUsage().rss - before;
    ok(e?.statusCode === 413 && /60 MB answer limit/.test(e.message) && grew < 64 * MB, `a 1 GB file is refused on its size, unread (rss grew ${Math.round(grew / MB)} MB)`);
  }

  // ---- 2. audio ---------------------------------------------------------------
  let haveFfmpeg = true;
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { haveFfmpeg = false; }
  if (!haveFfmpeg) {
    if (process.env.CI) ok(false, "ffmpeg is installed on this CI runner (install it in the lane rather than skipping)");
    else console.log("SKIP - audio checks (ffmpeg not installed here; CI and production have it)");
  } else {
    const { toMp3, normalizeAudio, transcodePcm, mediaInputArgs, __setExecFileForTest } = await import("../src/tools/media-kit.js");
    const ff = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "inherit"] });
    const silence = (seconds, extra, out) => ff(["-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", String(seconds), ...extra, out]);
    const opus = ["-c:a", "libopus", "-b:a", "6k", "-compression_level", "0", "-frame_duration", "60"];
    const hourPath = join(dir, "hour.ogg"), shortPath = join(dir, "short.ogg"), liarPath = join(dir, "liar.ogg");
    silence(3600, opus, hourPath);
    silence(1, opus, shortPath);
    const hour = readFileSync(hourPath);
    // A chained Ogg file: the hour, then one second. The container's length
    // is read from its last page, so it declares about a second; a decoder
    // plays both links.
    writeFileSync(liarPath, Buffer.concat([hour, readFileSync(shortPath)]));
    ok(hour.length < 2 * MB, `an hour of silence is ${Math.round(hour.length / 1024)} KB of Opus (its 192k MP3 would be ${capText(projectedAudioBytes(3600, 192))})`);

    // 2a. in this process: which programs start, and what the refusal says.
    const started = [];
    __setExecFileForTest((bin, args, opts, cb) => { started.push({ bin, args }); return execFile(bin, args, opts, cb); });
    for (const [label, run, hint] of [
      ["audio-convert", () => toMp3(hour, { bitrate: "192k" }), /lower "bitrate"/],
      ["audio-normalize", () => normalizeAudio(hour), /send a shorter file$/],
    ]) {
      started.length = 0;
      const e = await caught(run);
      ok(e?.statusCode === 413 && /60 MB answer limit/.test(e.message) && /1 h long/.test(e.message) && /43 min 41 s/.test(e.message) && hint.test(e.message), `${label}: the hour is a 413 naming the limit, its length and what fits (${e?.message})`);
      ok(started.length === 1 && started[0].bin === "ffprobe", `${label}: refused before the encoder starts (${started.map((s) => s.bin).join(",")})`);
    }
    {
      // A request the encoder would write smaller is not refused: 8 kHz MP3
      // is held to 64k whatever bitrate is asked for.
      const lowPath = join(dir, "low.mp3");
      silence(3600, ["-c:a", "libmp3lame", "-b:a", "8k"], lowPath);
      started.length = 0;
      const out = await toMp3(readFileSync(lowPath), { bitrate: "192k" });
      ok(out.format === "mp3" && out.bytes > 20 * MB && out.bytes <= AUDIO_ANSWER_MAX_BYTES && Buffer.from(out.mp3Base64, "base64").length === out.bytes, `an hour of 8 kHz audio converts (${capText(out.bytes)}: the encoder holds that sample rate to 64k)`);
      const enc = started.find((s) => s.bin === "ffmpeg");
      const at = enc ? enc.args.indexOf("-fs") : -1;
      ok(at > 0 && enc.args[at + 1] === String(AUDIO_ANSWER_MAX_BYTES + 1), "the encoder is given the size limit (-fs, one byte past the cap)");
    }
    {
      // The headers say a second, so the probe passes it; the encoder stops
      // at its limit and the output is refused on its size, unread.
      started.length = 0;
      const liar = readFileSync(liarPath);
      const e = await caught(() => toMp3(liar, { bitrate: "192k" }));
      ok(started.length === 2 && started[1].bin === "ffmpeg", "a file that declares one second reaches the encoder");
      ok(e?.statusCode === 413 && /60 MB answer limit/.test(e.message), `its hour of audio is a 413 from the size of the output (${e?.message})`);
    }
    {
      // An ordinary file: the same bytes as the encode without the limit.
      const wavPath = join(dir, "tone.wav");
      ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=4", wavPath]);
      const wav = readFileSync(wavPath);
      const plain = (extra) => {
        const p = join(dir, "plain.mp3");
        execFileSync("ffmpeg", ["-y", ...mediaInputArgs(wav, wavPath), "-vn", "-map_metadata", "-1", ...extra, p], { stdio: "ignore" });
        return readFileSync(p);
      };
      const conv = await toMp3(wav, { bitrate: "128k" });
      ok(Buffer.from(conv.mp3Base64, "base64").equals(plain(["-b:a", "128k"])) && conv.bytes === Buffer.from(conv.mp3Base64, "base64").length, `a 4 s tone converts to the same ${conv.bytes} bytes as the plain encode`);
      const norm = await normalizeAudio(wav, { targetLufs: -16 });
      ok(Buffer.from(norm.mp3Base64, "base64").equals(plain(["-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-b:a", "192k"])), `and normalizes to the same ${norm.bytes} bytes`);
      // Ten minutes at 192k (14.4 MB) is well inside the cap.
      const tenPath = join(dir, "ten.ogg");
      ff(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "600", ...opus, tenPath]);
      const ten = await toMp3(readFileSync(tenPath), { bitrate: "192k" });
      ok(Math.abs(ten.bytes - projectedAudioBytes(600, 192)) < 64 * 1024, `ten minutes at 192k converts (${capText(ten.bytes)}, as projected)`);
      // Speech PCM: the encoded file is its samples and a header.
      const pcm = Buffer.alloc(48000);
      const speech = await transcodePcm(pcm, "wav");
      ok(speech.length === pcm.length + 78 || (speech.length > pcm.length && speech.length < pcm.length + 256), `speech PCM still encodes to WAV (${speech.length} bytes)`);
    }
    __setExecFileForTest(null);

    // 2b. in a child process: peak resident memory of the two refusals.
    const child = `
      import "./scripts/lib/offline-stores.js";
      import { readFileSync } from "node:fs";
      const { toMp3 } = await import("./src/tools/media-kit.js");
      const buf = readFileSync(process.argv[1]);
      let status = 0, message = "";
      try { await toMp3(buf, { bitrate: "192k" }); } catch (e) { status = e.statusCode; message = e.message; }
      console.log(JSON.stringify({ status, message, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }));
    `;
    const RSS_BOUND_MB = 256;
    for (const [label, path] of [["the hour of Opus (refused before the encode)", hourPath], ["the file that understates its length (refused after it)", liarPath]]) {
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", child, path], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
      let got = null;
      try { got = JSON.parse(String(r.stdout).trim().split("\n").pop()); } catch { /* reported below */ }
      ok(got?.status === 413 && got.maxRssMb < RSS_BOUND_MB, `${label}: 413, peak resident memory ${got?.maxRssMb} MB (bound ${RSS_BOUND_MB})${got ? "" : `: ${String(r.stderr).slice(0, 300)}`}`);
    }
  }

  // ---- 3. PDF -----------------------------------------------------------------
  {
    const { pdfBase64 } = await import("../src/tools/pdf-ops.js");
    const { runPdfOp } = await import("../src/tools/pdf-offthread.js");
    const { PDFDocument } = await import("pdf-lib");
    const bytes = new Uint8Array(randomBytes(3000));
    ok(pdfBase64(bytes) === Buffer.from(bytes).toString("base64"), "a PDF inside the cap is its base64");
    const e = await caught(() => pdfBase64(bytes, 2999));
    ok(e?.statusCode === 413 && /answer limit/.test(e.message), "pdfBase64 refuses a file one byte past its cap");
    // Through the worker: a document holding 41 MB of incompressible data
    // saves past the 40 MB cap.
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    await doc.attach(randomBytes(PDF_ANSWER_MAX_BYTES + MB), "blob.bin", { mimeType: "application/octet-stream" });
    const bigPdf = Buffer.from(await doc.save());
    const w = await caught(() => runPdfOp("rotate", [bigPdf], [90]));
    ok(bigPdf.length > PDF_ANSWER_MAX_BYTES && w?.statusCode === 413 && /40 MB answer limit/.test(w.message), `a rotate whose file is ${capText(bigPdf.length)} answers 413 naming the limit (${w?.statusCode}: ${w?.message})`);
    const small = await PDFDocument.create();
    small.addPage([300, 400]);
    const rotated = await runPdfOp("rotate", [Buffer.from(await small.save())], [90]);
    ok(rotated.pages === 1 && Buffer.from(rotated.pdfBase64, "base64").length === rotated.bytes, "an ordinary rotate answers as before");
  }

  // ---- 4. images --------------------------------------------------------------
  {
    const { toBuffer } = await import("../src/tools/image-ops.js");
    const stub = (n) => ({ bitmap: { width: 1, height: 1 }, getBuffer: async () => Buffer.alloc(n) });
    const fine = await toBuffer(stub(1024), "png");
    ok(fine.__binary.length === 1024 && fine.contentType === "image/png", "an encoded image inside the cap is answered");
    const e = await caught(() => toBuffer(stub(IMAGE_ANSWER_MAX_BYTES + 1), "bmp"));
    ok(e?.statusCode === 413 && /answer limit/.test(e.message), `an encoded image past ${capText(IMAGE_ANSWER_MAX_BYTES)} is a 413`);
  }

  // ---- 5. the tables ----------------------------------------------------------
  {
    const toolsDir = join(ROOT, "src/tools");
    const sources = Object.fromEntries(readdirSync(toolsDir).filter((f) => f.endsWith(".js")).map((f) => [f, readFileSync(join(toolsDir, f), "utf8")]));
    const all = Object.values(sources).join("\n");
    const listed = [...Object.keys(ANSWER_CAPS), ...Object.keys(ANSWER_CAPS_ELSEWHERE)];
    const missing = listed.filter((slug) => !all.includes(`slug: "${slug}"`));
    ok(listed.length === new Set(listed).size && missing.length === 0, `every listed slug is a tool, listed once${missing.length ? `: ${missing.join(", ")}` : ""}`);
    ok(Object.values(ANSWER_CAPS).every((n) => Number.isInteger(n) && n >= MB && n <= IMAGE_ANSWER_MAX_BYTES), "every cap is a whole number of bytes between 1 MB and the image bound");
    // A kit that answers with a converter's bytes sizes them first: the
    // media kit reads an encoder's file through readFileWithin, and the PDF
    // transforms make base64 only in pdfBase64.
    const media = sources["media-kit.js"];
    const answerReads = (fn) => { const at = media.indexOf(`export async function ${fn}(`); return media.slice(at, media.indexOf("\nexport ", at + 10)); };
    for (const fn of ["toMp3", "normalizeAudio", "transcodePcm"]) {
      const body = answerReads(fn);
      ok(!/\breadFile\(/.test(body) && /readMp3\(|readFileWithin\(/.test(body) && /-fs|MP3_SIZE_LIMIT_ARGS/.test(body), `${fn} gives the encoder a size limit and sizes its file before reading it`);
    }
    const pdf = sources["pdf-ops.js"];
    ok((pdf.match(/toString\("base64"\)/g) || []).length === 1 && pdf.indexOf('toString("base64")') > pdf.indexOf("export function pdfBase64") && pdf.indexOf("assertAnswerBytes(bytes.length") < pdf.indexOf('toString("base64")'), "pdf-ops makes base64 in one place, after the size check");
    // The cap is in each audio tool's description, derived from the constant.
    const { MEDIA_TOOLS } = await import("../src/tools/media-kit.js");
    for (const slug of ["audio-convert", "audio-normalize"]) {
      const t = MEDIA_TOOLS.find((x) => x.slug === slug);
      ok(t.description.includes(capText(ANSWER_CAPS[slug])) && t.description.includes("413"), `${slug}'s description names its ${capText(ANSWER_CAPS[slug])} answer cap`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
