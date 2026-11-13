// ffmpeg and ffprobe read a downloaded body as a local file of a named
// format: every input carries -protocol_whitelist file and an explicit -f
// demuxer chosen from the body's magic bytes, so a body cannot be probed as a
// playlist or concat list that names further inputs. A body whose container
// is not recognized is refused before any process starts. Offline: the
// process runner is replaced and only its arguments are read.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { probeMedia, toMp3, normalizeAudio, transcodePcm, inputFormatOf, __setExecFileForTest } from "../src/tools/media-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const calls = [];
__setExecFileForTest((bin, args, opts, cb) => { calls.push({ bin, args }); cb(Object.assign(new Error("stub"), { code: 1 }), "", ""); });
const settle = async (p) => { try { await p; } catch { /* the stub runner always fails */ } };

const pad = (head) => Buffer.concat([Buffer.from(head, "latin1"), Buffer.alloc(64)]);
const wav = Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVE", "latin1"), Buffer.alloc(64)]);
const mp4 = Buffer.concat([Buffer.from("\0\0\0\x20ftypisom", "latin1"), Buffer.alloc(64)]);

function inputOf(args) {
  const i = args.indexOf("-i");
  return { i, before: args.slice(0, i), path: args[i + 1] };
}
function checkInput(call, fmt, label) {
  const { i, before } = inputOf(call.args);
  const w = before.indexOf("-protocol_whitelist");
  ok(i > 0 && w >= 0 && before[w + 1] === "file", `${label}: -protocol_whitelist file before -i (args ${call.args.join(" ")})`);
  const f = before.lastIndexOf("-f");
  ok(f >= 0 && before[f + 1] === fmt, `${label}: -f ${fmt} names the input demuxer`);
  ok(call.args.filter((a) => a === "-i").length === 1, `${label}: exactly one input`);
}

calls.length = 0; await settle(probeMedia(wav));
ok(calls.length === 1 && calls[0].bin === "ffprobe", "probeMedia runs ffprobe once");
if (calls[0]) checkInput(calls[0], "wav", "ffprobe on a WAV");

calls.length = 0; await settle(toMp3(mp4, { bitrate: "128k" }));
if (calls[0]) checkInput(calls[0], "mov", "mp3 conversion of an MP4");

calls.length = 0; await settle(normalizeAudio(pad("OggS"), { targetLufs: -16 }));
if (calls[0]) checkInput(calls[0], "ogg", "loudness normalize of an Ogg file");

calls.length = 0; await settle(transcodePcm(Buffer.alloc(4800), "wav"));
if (calls[0]) checkInput(calls[0], "s16le", "speech PCM transcode");

// Bodies that name other inputs are refused before a process starts.
for (const [label, body] of [["an HLS playlist", "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/hosts\n#EXT-X-ENDLIST\n"], ["a concat list", "ffconcat version 1.0\nfile /etc/hosts\n"], ["an SDP description", "v=0\no=- 0 0 IN IP4 127.0.0.1\n"]]) {
  calls.length = 0;
  let err = null;
  try { await probeMedia(Buffer.from(body)); } catch (e) { err = e; }
  ok(err && err.statusCode === 422 && calls.length === 0, `${label} is refused with 422 and no process starts (calls ${calls.length})`);
}

// Magic-byte table.
const table = [["fLaC", "flac"], ["ID3\x04", "mp3"], ["\xff\xfb\x90\x00", "mp3"], ["\x1a\x45\xdf\xa3", "matroska"], ["FORM\0\0\0\0AIFF", "aiff"], ["RIFF\0\0\0\0AVI ", "avi"], ["RIFF\0\0\0\0XXXX", null],
  // Recorder containers: ASF (WMA), raw ADTS AAC (MPEG-4 and MPEG-2 sync words), AMR narrow and wide band, CAF.
  ["\x30\x26\xb2\x75\x8e\x66\xcf\x11\xa6\xd9\x00\xaa\x00\x62\xce\x6c", "asf"], ["\x30\x26\xb2\x75\x8e\x66\xcf\x11\xa6\xd9\x00\xaa\x00\x62\xce\x6d", null],
  ["\xff\xf1\x50\x80", "aac"], ["\xff\xf9\x50\x80", "aac"], ["#!AMR\n", "amr"], ["#!AMR-WB\n", "amr"], ["#!AMRX", null], ["caff\0\x01\0\0", "caf"]];
for (const [head, fmt] of table) ok(inputFormatOf(pad(head)) === fmt, `magic ${JSON.stringify(head)} -> ${fmt}`);

// An ID3v2 tag is skipped by its declared size and what follows is named; a
// body whose start names nothing is scanned for two consecutive MP3 frames.
{
  const id3 = (body, n) => { const h = Buffer.alloc(10 + n); h.write("ID3", 0); h[3] = 4; h[6] = (n >> 21) & 127; h[7] = (n >> 14) & 127; h[8] = (n >> 7) & 127; h[9] = n & 127; return Buffer.concat([h, body]); };
  // A 128 kbps 44.1 kHz layer III frame header; its frame is 417 bytes long.
  const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)]);
  const frames = Buffer.concat([frame, frame, frame]);
  const adts = Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80]), Buffer.alloc(40)]);
  const cases = [
    ["ADTS AAC behind a 2000-byte ID3 tag", id3(adts, 2000), "aac"],
    ["FLAC behind an ID3 tag", id3(pad("fLaC"), 300), "flac"],
    ["MP3 frames behind an ID3 tag", id3(frames, 300), "mp3"],
    ["an ID3 tag over nothing it names", id3(Buffer.alloc(64), 300), "mp3"],
    ["MP3 frames behind 3000 zero bytes", Buffer.concat([Buffer.alloc(3000), frames]), "mp3"],
    ["one lone frame header in other bytes", Buffer.concat([Buffer.alloc(3000, 0x41), Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(100, 0x41)]), null],
    ["MP3 frames past the scan's reach", Buffer.concat([Buffer.alloc(70 * 1024), frames]), null],
  ];
  for (const [label, body, fmt] of cases) ok(inputFormatOf(body) === fmt, `${label} -> ${fmt} (${inputFormatOf(body)})`);
}

// A recorder container's input names its own demuxer.
calls.length = 0; await settle(probeMedia(pad("\x30\x26\xb2\x75\x8e\x66\xcf\x11\xa6\xd9\x00\xaa\x00\x62\xce\x6c")));
if (calls[0]) checkInput(calls[0], "asf", "ffprobe on an ASF (WMA) file");

__setExecFileForTest(null);
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
