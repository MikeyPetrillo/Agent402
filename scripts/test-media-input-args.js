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

// The decode pool's queue is bounded: each waiting call holds its audio, so
// past MEASURE_QUEUE_PER_SLOT waiters a slot the call is answered at once
// (unavailable, busy: the caller's retryable 503), never queued.
{
  const { measureAudio, MEASURE_QUEUE_PER_SLOT, __measurePoolForTest } = await import("../src/tools/media-kit.js");
  const hadSlots = process.env.AUDIO_DECODE_SLOTS;
  process.env.AUDIO_DECODE_SLOTS = "1";
  const held = [];
  __setExecFileForTest((bin, args, opts, cb) => { held.push(cb); });
  const mp3 = Buffer.concat([Buffer.from("ID3\x04\0\0\0\0\0\0", "latin1"), Buffer.alloc(64)]);
  const keep = setInterval(() => {}, 1_000);
  try {
    const running = [measureAudio(mp3, { format: "mp3" })];
    for (let i = 0; i < MEASURE_QUEUE_PER_SLOT; i++) running.push(measureAudio(mp3, { format: "mp3" }));
    await new Promise((r) => setTimeout(r, 50));
    ok(MEASURE_QUEUE_PER_SLOT === 4 && __measurePoolForTest().active === 1 && __measurePoolForTest().waiting === MEASURE_QUEUE_PER_SLOT, `one decode runs and ${MEASURE_QUEUE_PER_SLOT} wait for the one slot (${JSON.stringify(__measurePoolForTest())})`);
    const t0 = Date.now();
    const over = await measureAudio(mp3, { format: "mp3" });
    ok(over?.busy === true && /queue for one is full/.test(over.unavailable || "") && Date.now() - t0 < 1_000 && __measurePoolForTest().waiting === MEASURE_QUEUE_PER_SLOT, `past the queue's bound a call is answered at once, unavailable (${JSON.stringify(over)}, ${Date.now() - t0} ms)`);
    // Free the stub's runs as they start, so every queued call drains.
    __setExecFileForTest((bin, args, opts, cb) => setImmediate(() => cb(Object.assign(new Error("stub"), { code: 1 }))));
    while (held.length) held.shift()(Object.assign(new Error("stub"), { code: 1 }));
    await Promise.all(running);
    ok(__measurePoolForTest().active === 0 && __measurePoolForTest().waiting === 0, "the pool drains once the slot frees");
  } finally {
    clearInterval(keep);
    if (hadSlots === undefined) delete process.env.AUDIO_DECODE_SLOTS; else process.env.AUDIO_DECODE_SLOTS = hadSlots;
  }
}

// The queue is bounded by the bytes its waiters hold too: past the bound a
// call is answered at once (busy: the caller's retryable 503) while the count
// bound still has room, and the bytes leave the queue with each waiter.
{
  const { measureAudio, measureQueueMaxBytes, MEASURE_QUEUE_PER_SLOT, MEASURE_QUEUE_BYTES_CAP, __measurePoolForTest, __setMeasureQueueMaxBytesForTest } = await import("../src/tools/media-kit.js");
  ok(measureQueueMaxBytes(2) === MEASURE_QUEUE_BYTES_CAP && measureQueueMaxBytes(8) === MEASURE_QUEUE_BYTES_CAP && MEASURE_QUEUE_BYTES_CAP === 200 * 1024 * 1024 && measureQueueMaxBytes(1) === MEASURE_QUEUE_PER_SLOT * 25 * 1024 * 1024, `the byte bound is ${MEASURE_QUEUE_PER_SLOT} x slots x 25 MB, held to 200 MB`);
  const hadSlots = process.env.AUDIO_DECODE_SLOTS;
  process.env.AUDIO_DECODE_SLOTS = "1";
  const held = [];
  __setExecFileForTest((bin, args, opts, cb) => { held.push(cb); });
  const mp3 = Buffer.concat([Buffer.from("ID3\x04\0\0\0\0\0\0", "latin1"), Buffer.alloc(64)]);
  __setMeasureQueueMaxBytesForTest(mp3.length * 2);
  const keep = setInterval(() => {}, 1_000);
  try {
    const running = [measureAudio(mp3, { format: "mp3" }), measureAudio(mp3, { format: "mp3" }), measureAudio(mp3, { format: "mp3" })];
    await new Promise((r) => setTimeout(r, 50));
    ok(__measurePoolForTest().waiting === 2 && __measurePoolForTest().queuedBytes === mp3.length * 2, `two waiters hold their bytes (${JSON.stringify(__measurePoolForTest())})`);
    const t0 = Date.now();
    const over = await measureAudio(mp3, { format: "mp3" });
    ok(2 < MEASURE_QUEUE_PER_SLOT && over?.busy === true && /queue for one is full/.test(over.unavailable || "") && Date.now() - t0 < 1_000, `past the byte bound a call is answered at once while the count bound has room (${JSON.stringify(over)})`);
    __setExecFileForTest((bin, args, opts, cb) => setImmediate(() => cb(Object.assign(new Error("stub"), { code: 1 }))));
    while (held.length) held.shift()(Object.assign(new Error("stub"), { code: 1 }));
    await Promise.all(running);
    ok(__measurePoolForTest().queuedBytes === 0 && __measurePoolForTest().waiting === 0, "the queued bytes leave with their waiters");
  } finally {
    clearInterval(keep);
    __setMeasureQueueMaxBytesForTest(null);
    if (hadSlots === undefined) delete process.env.AUDIO_DECODE_SLOTS; else process.env.AUDIO_DECODE_SLOTS = hadSlots;
  }
}

// Admission is per caller: one caller's run of files holding the slot and
// every queued place never refuses another caller's first file. The newcomer
// takes the first caller's newest queued place (that waiter is answered busy),
// the next slot that frees goes to the caller holding none, and a caller that
// already holds a place takes none from anyone.
{
  const { measureAudio, MEASURE_QUEUE_PER_SLOT, __measurePoolForTest } = await import("../src/tools/media-kit.js");
  const { runAsCallerOf } = await import("../src/dispatch-caller.js");
  const hadSlots = process.env.AUDIO_DECODE_SLOTS;
  process.env.AUDIO_DECODE_SLOTS = "1";
  const held = [];
  __setExecFileForTest((bin, args, opts, cb) => { held.push(cb); });
  const done = (cb) => cb(null, "out_time_us=1000000\n");
  const mp3 = Buffer.concat([Buffer.from("ID3\x04\0\0\0\0\0\0", "latin1"), Buffer.alloc(64)]);
  const A = "ip:198.51.100.5", B = "ip:198.51.100.7", C = "ip:203.0.113.9";
  const keep = setInterval(() => {}, 1_000);
  const tick = () => new Promise((r) => setTimeout(r, 30));
  try {
    const settled = new Map();
    const track = (name, p) => { p.then((v) => settled.set(name, v)); return p; };
    const aRuns = [];
    for (let i = 0; i <= MEASURE_QUEUE_PER_SLOT; i++) aRuns.push(track(`a${i}`, measureAudio(mp3, { format: "mp3", who: A })));
    await tick();
    ok(__measurePoolForTest().active === 1 && __measurePoolForTest().waiting === MEASURE_QUEUE_PER_SLOT, `one caller holds the slot and every queued place (setup, ${JSON.stringify(__measurePoolForTest())})`);
    const aMore = await measureAudio(mp3, { format: "mp3", who: A });
    ok(aMore?.busy === true, "a caller already holding places is refused when the queue is full");
    const aStep = await runAsCallerOf({ ip: A.slice(3), headers: {} }, () => measureAudio(mp3, { format: "mp3" }));
    ok(aStep?.busy === true && __measurePoolForTest().waiting === MEASURE_QUEUE_PER_SLOT && !settled.has(`a${MEASURE_QUEUE_PER_SLOT}`), "a step that caller dispatched is keyed on it, so it takes no place either");
    // A second caller's first file, dispatched as a step with no request.
    const bRun = track("b", runAsCallerOf({ ip: B.slice(3), headers: {} }, () => measureAudio(mp3, { format: "mp3" })));
    await tick();
    ok(!settled.has("b") && __measurePoolForTest().waiting === MEASURE_QUEUE_PER_SLOT, `a second caller's first file is queued, not refused (${JSON.stringify(settled.get("b"))})`);
    ok(settled.get(`a${MEASURE_QUEUE_PER_SLOT}`)?.busy === true, "the place it took was the first caller's newest queued one, answered busy");
    // A third caller with none also finds a place; B, holding one, takes none.
    const cRun = track("c", measureAudio(mp3, { format: "mp3", who: C }));
    await tick();
    ok(!settled.has("c") && settled.get(`a${MEASURE_QUEUE_PER_SLOT - 1}`)?.busy === true, "a third caller's first file takes the first caller's next queued place");
    const bMore = await runAsCallerOf({ ip: B.slice(3), headers: {} }, () => measureAudio(mp3, { format: "mp3" }));
    ok(bMore?.busy === true, "a step keyed on its dispatcher, which holds a place, takes none (keyed on the dispatcher, not the shared key)");
    // The slot that frees goes to a caller holding no slot, ahead of the first caller's queue.
    done(held.shift());
    await tick();
    done(held.shift());
    await tick();
    ok(settled.get("b")?.seconds === 1 && !settled.has("a1"), `the next freed slot decodes the second caller's file before the first caller's queue (${JSON.stringify([...settled.keys()])})`);
    __setExecFileForTest((bin, args, opts, cb) => setImmediate(() => done(cb)));
    while (held.length) done(held.shift());
    await Promise.all([...aRuns, bRun, cRun]);
    ok(settled.get("c")?.seconds === 1, "the third caller's file decodes too");
    ok(__measurePoolForTest().active === 0 && __measurePoolForTest().waiting === 0 && __measurePoolForTest().callers === 0 && __measurePoolForTest().queuedBytes === 0, `the pool and its per-caller counts drain (${JSON.stringify(__measurePoolForTest())})`);
  } finally {
    clearInterval(keep);
    if (hadSlots === undefined) delete process.env.AUDIO_DECODE_SLOTS; else process.env.AUDIO_DECODE_SLOTS = hadSlots;
  }
}

// The transcription routes hold their decode place for the request's caller:
// the identity payer (never a typed x-payment, which nothing verified in
// FREE_MODE), else the address with an IPv6 one folded to its /64; a step run
// with no request is keyed on the caller that dispatched it.
{
  const { prepareAudioWithinCap, __setMeasureForTest, __setTranscodeForTest } = await import("../src/tools/stt-kit.js");
  const { runAsCallerOf, IN_PROCESS_CALLER } = await import("../src/dispatch-caller.js");
  let seen = [];
  __setMeasureForTest(async (buf, opts) => { seen.push(opts?.who); return { unavailable: "stub" }; });
  __setTranscodeForTest(async (buf, opts) => { seen.push(opts?.who); return { unavailable: "stub" }; });
  const ogg = Buffer.concat([Buffer.from("OggS", "latin1"), Buffer.alloc(200)]);
  const whoFor = async (req, run = (fn) => fn()) => { seen = []; await run(() => prepareAudioWithinCap(ogg, "a.ogg", "transcribe", req)).catch(() => {}); return seen; };
  const forged = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { authorization: { from: "0x" + "ab".repeat(20) } } })).toString("base64");
  const withHeader = (ip) => ({ ip, headers: { "x-payment": forged }, header: (n) => (String(n).toLowerCase() === "x-payment" ? forged : undefined) });
  const had = process.env.FREE_MODE;
  try {
    process.env.FREE_MODE = "true";
    const plain = await whoFor({ ip: "198.51.100.40", headers: {} });
    const forgedSeen = await whoFor(withHeader("198.51.100.40"));
    ok(plain.length > 0 && plain.every((w) => w === "ip:198.51.100.40") && forgedSeen.length > 0 && forgedSeen.every((w) => w === "ip:198.51.100.40"), `a forged x-payment does not change the decode place's key (${plain} / ${forgedSeen})`);
    const v6 = await whoFor({ ip: "2001:db8:5:6::99", headers: {} });
    ok(v6.length > 0 && v6.every((w) => w === "ip:2001:db8:5:6::/64"), `an IPv6 caller's decode place is keyed on its /64 (${v6})`);
    const step = await whoFor(null, (fn) => runAsCallerOf({ ip: "203.0.113.9", headers: {} }, fn));
    ok(step.length > 0 && step.every((w) => w === "ip:203.0.113.9"), `a step inside runAsCallerOf is keyed on its dispatcher (${step})`);
    const none = await whoFor(null);
    ok(none.length > 0 && none.every((w) => w === IN_PROCESS_CALLER), `a call with no caller at all is held under the shared key (${none})`);
  } finally {
    if (had === undefined) delete process.env.FREE_MODE; else process.env.FREE_MODE = had;
    __setMeasureForTest(null); __setTranscodeForTest(null);
  }
}

__setExecFileForTest(null);
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
