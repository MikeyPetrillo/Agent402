// ffmpeg and ffprobe read a downloaded body as a local file of a named
// format: every input carries -protocol_whitelist file and an explicit -f
// demuxer chosen from the body's magic bytes, so a body cannot be probed as a
// playlist or concat list that names further inputs. A body whose container
// is not recognized is refused before any process starts. Offline: the
// process runner is replaced and only its arguments are read.
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
const table = [["fLaC", "flac"], ["ID3\x04", "mp3"], ["\xff\xfb\x90\x00", "mp3"], ["\x1a\x45\xdf\xa3", "matroska"], ["FORM\0\0\0\0AIFF", "aiff"], ["RIFF\0\0\0\0AVI ", "avi"], ["RIFF\0\0\0\0XXXX", null]];
for (const [head, fmt] of table) ok(inputFormatOf(pad(head)) === fmt, `magic ${JSON.stringify(head)} -> ${fmt}`);

__setExecFileForTest(null);
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
