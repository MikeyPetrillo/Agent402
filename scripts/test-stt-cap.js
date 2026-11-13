// Margin-cap tests for the STT kit. The per-tier duration cap is what keeps
// transcribe/transcribe-pro profitable (OpenAI bills per audio minute, the
// tool charges per call) - these tests prove the cap is enforced locally,
// before any upstream spend, and that the cap itself is sized to the model's
// live per-minute rate (2026-09-18: the standard tier moved off
// gpt-4o-mini-transcribe, which OpenAI retires 2027-02-26, onto gpt-transcribe,
// and its cap dropped 5 -> 4 minutes to stay inside the margin rule). Offline: synthetic WAV buffers, no network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { probeDurationSeconds, assertWithinDurationCap, prepareAudioWithinCap, makeMultipartHandler, STT_TIERS, upstreamUsdPerMinute, STT_MARGIN, STT_TOOLS, byteFloorSeconds, __setMeasureForTest, __setTranscodeForTest, sttUnmeasuredSinceBoot } from "../src/tools/stt-kit.js";
import { measureAudioSeconds, __setExecFileForTest } from "../src/tools/media-kit.js";
import { execFile as realExecFile } from "node:child_process";
import * as sttKit from "../src/tools/stt-kit.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireUpstreamCosts } from "./lib/require-upstream-costs.js";
requireUpstreamCosts("test-stt-cap");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// ---- the cap is a margin bound, derived from the model's rate ----
for (const [slug, tier] of Object.entries(STT_TIERS)) {
  const rate = upstreamUsdPerMinute(tier.model);
  ok(Number.isFinite(rate) && rate > 0, `${slug}: the model it sends (${tier.model}) has a known per-minute rate`);
  const worst = tier.maxMinutes * rate;
  ok(worst <= STT_MARGIN * tier.priceUsd + 1e-12, `${slug}: worst case at the ${tier.maxMinutes}-min cap is under ${STT_MARGIN * 100}% of $${tier.priceUsd}`);
  const tool = STT_TOOLS.find((t) => t.slug === slug);
  ok(Math.abs(Number(tool.price.replace("$", "")) - tier.priceUsd) < 1e-9, `${slug}: the catalog price string matches the tier price the margin is computed on`);
  ok(new RegExp(`Max ${tier.maxMinutes} minutes`).test(tool.description) && tool.description.includes(tier.model) && tool.discovery.output.example.model === tier.model, `${slug}: description states the ${tier.maxMinutes}-minute cap and the model; the example names the model actually sent`);
}
// A cut file is disclosed: both tiers' descriptions say so, and every
// transcription route's output schema (openapi, the 402's listing, the tool
// page) carries the two fields an answer cut at the cap adds, never required.
{
  const { responseSchemaFor, boundedResponseSchemaFor } = await import("../src/openapi-schema.js");
  const { BAZAAR_SCHEMA_MAX_BYTES } = await import("../src/payments.js");
  for (const t of STT_TOOLS) {
    const opt = t.discovery?.output?.optional || {};
    ok(opt.trimmedToCapSeconds?.type === "number" && opt.durationUnconfirmed?.type === "boolean", `${t.slug}: the output declares trimmedToCapSeconds (number) and durationUnconfirmed (boolean)`);
    const path = t.route.split(" ")[1];
    const full = responseSchemaFor(path, t.discovery.output.example, opt);
    const bounded = boundedResponseSchemaFor(path, t.discovery.output.example, BAZAAR_SCHEMA_MAX_BYTES, opt);
    ok(full.properties?.trimmedToCapSeconds && full.properties?.durationUnconfirmed && !(full.required || []).some((k) => /trimmed|Unconfirmed/.test(k)), `${t.slug}: the openapi schema lists both, neither required`);
    ok(bounded?.properties?.trimmedToCapSeconds?.type === "number" && bounded?.properties?.durationUnconfirmed?.type === "boolean" && JSON.stringify(bounded).length <= BAZAAR_SCHEMA_MAX_BYTES, `${t.slug}: the 402 listing's schema lists both inside its ${BAZAAR_SCHEMA_MAX_BYTES}-byte budget (${JSON.stringify(bounded).length})`);
  }
  for (const slug of ["transcribe", "transcribe-pro"]) {
    ok(/A file whose length cannot be confirmed is transcribed up to the cap, and the answer says so/.test(STT_TOOLS.find((t) => t.slug === slug).description), `${slug}: the description says a file of unconfirmed length is transcribed up to the cap and the answer says so`);
  }
}
// The retiring models are gone from every tier (OpenAI shutdown 2027-02-26).
ok(!Object.values(STT_TIERS).some((t) => /gpt-4o(-mini)?-transcribe|whisper-1/.test(t.model)), "no tier sends gpt-4o-mini-transcribe, gpt-4o-transcribe or whisper-1");
ok(STT_TIERS.transcribe.model === "gpt-transcribe" && STT_TIERS["transcribe-pro"].model === "gpt-transcribe", "both tiers send gpt-transcribe (they differ in cap and price only, and the pro copy says so)");
ok(!/[Hh]igher accuracy/.test(STT_TOOLS.find((t) => t.slug === "transcribe-pro").description), "the pro tier no longer claims higher accuracy than a tier on the same model");

// Minimal valid PCM WAV of the given length: 8 kHz, mono, 8-bit.
function makeWav(seconds) {
  const sr = 8000;
  const dataLen = Math.round(sr * seconds);
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataLen, 40);
  return buf;
}

const short = makeWav(10);          // 10 s - fine on both tiers
const justOver = makeWav(4.5 * 60); // 4.5 min - over the 4-min standard cap (the old 5-min cap let it through), under the pro cap
const mid = makeWav(6.5 * 60);      // 6.5 min - over the standard cap, under the 10-min pro cap
const long = makeWav(11 * 60);      // 11 min - over both caps
const junk = Buffer.from("definitely not an audio container ".repeat(200));

const d = await probeDurationSeconds(short, "audio.wav");
ok(d !== null && Math.abs(d - 10) < 0.5, `probe reads WAV duration from the header (got ${d}s)`);
ok((await probeDurationSeconds(junk, "audio.mp3")) === null, "unreadable bytes probe to null, never throw");

// The header cap first, on a measurement that reads each WAV's own length (the
// real decode is tested below, where ffmpeg is present).
__setMeasureForTest(async (b) => probeDurationSeconds(b, "audio.wav"));
ok((await assertWithinDurationCap(short, "audio.wav", "transcribe")) > 0, "short clip passes the standard tier");
ok((await assertWithinDurationCap(justOver, "audio.wav", "transcribe-pro")) > 0, "4.5-min clip passes the pro tier");
ok((await assertWithinDurationCap(mid, "audio.wav", "transcribe-pro")) > 0, "6.5-min clip passes the pro tier");

await assertWithinDurationCap(justOver, "audio.wav", "transcribe").then(
  () => ok(false, "4.5-min clip must be rejected by the 4-min standard cap (worst case would be 68% of the price and rising with the clip)"),
  (e) => ok(e.statusCode === 422 && /up to 4 minutes/.test(e.message), `4.5-min clip rejected 422 by the standard cap, message states 4 minutes (${e.message})`)
);

await assertWithinDurationCap(mid, "audio.wav", "transcribe").then(
  () => ok(false, "6.5-min clip must be rejected by the standard cap"),
  (e) => {
    ok(e.statusCode === 422, `standard cap rejects with 422 (got ${e.statusCode})`);
    ok(/transcribe-pro/.test(e.message), "standard-tier rejection points at the pro tier");
  }
);

await assertWithinDurationCap(long, "audio.wav", "transcribe-pro").then(
  () => ok(false, "11-min clip must be rejected by the 10-min pro cap"),
  (e) => ok(e.statusCode === 422 && /10 minutes/.test(e.message), "pro cap rejects with 422 and states its limit")
);

await assertWithinDurationCap(junk, "audio.mp3", "transcribe").then(
  () => ok(false, "unreadable duration must be rejected (unbounded upstream bill otherwise)"),
  (e) => ok(e.statusCode === 422 && /duration/i.test(e.message), "unreadable container -> self-explaining 422")
);

__setMeasureForTest(null);

// ---- the cap holds the audio a file plays, not the length it declares ----
// An MP3 of `seconds` at 128 kbps (MPEG-1 Layer III, 44.1 kHz: 417-byte
// frames of silence). `declaredFrames` writes a Xing header into the first
// frame that claims that many frames (and their bytes), whatever the file holds.
function makeMp3(seconds, declaredFrames = null) {
  const FRAME = 417, PER_SEC = 44100 / 1152;
  const n = Math.round(seconds * PER_SEC);
  const buf = Buffer.alloc(n * FRAME);
  for (let i = 0; i < n; i++) buf.writeUInt32BE(0xfffb9000, i * FRAME);
  if (declaredFrames !== null) { buf.write("Xing", 36, "latin1"); buf.writeUInt32BE(3, 40); buf.writeUInt32BE(declaredFrames, 44); buf.writeUInt32BE(declaredFrames * FRAME, 48); }
  return buf;
}
const reject = (p) => p.then(() => null, (e) => e);
{
  const honest = makeMp3(180);
  const lying = makeMp3(330, 100);          // plays 5.5 minutes, declares about 2.6 seconds
  const declared = await probeDurationSeconds(lying, "audio.mp3");
  ok(declared !== null && declared < 10, `the lying MP3's header declares a few seconds (${declared}s)`);

  // The measurement is the longer of the two readings.
  let calls = 0;
  __setMeasureForTest(async () => { calls++; return 330; });
  let e = await reject(assertWithinDurationCap(lying, "audio.mp3", "transcribe"));
  ok(e?.statusCode === 422 && /5\.5 minutes/.test(e.message) && /up to 4 minutes/.test(e.message), `a file that plays 5.5 minutes and declares seconds is refused by the 4-minute cap on what it plays (${e?.message ?? "passed"})`);
  ok(Math.abs((await assertWithinDurationCap(lying, "audio.mp3", "transcribe-pro")) - 330) < 0.01, "the same file passes the 10-minute tier, and the duration returned is the measured one (the margin math reads it)");
  __setMeasureForTest(async () => 1200);
  e = await reject(assertWithinDurationCap(lying, "audio.mp3", "transcribe-pro"));
  ok(e?.statusCode === 422 && /10 minutes/.test(e.message), "a file that plays 20 minutes is refused by the 10-minute tier whatever its header declares");
  __setMeasureForTest(async () => 5);
  ok(Math.abs((await assertWithinDurationCap(makeMp3(10), "audio.mp3", "transcribe")) - 10) < 0.5, "a measurement shorter than the declared length never shortens it");
  calls = 0;
  __setMeasureForTest(async () => { calls++; return 1; });
  await reject(assertWithinDurationCap(long, "audio.wav", "transcribe-pro"));
  ok(calls === 0, "a file its own header puts over the cap is refused without a decode");

  // Unmeasured (no free decoder slot, its deadline, a stand-in that gave no
  // length): the declared length is not taken on trust; the file is cut at the
  // cap, and a cut that wrote less than the cap read the whole file, which is
  // then its measured length and the file goes as it came.
  // A 10-second MP3: compressed, so its bytes bound nothing and every path below decodes it.
  const tiny = makeMp3(10);
  let cuts = [];
  const cutStub = (lenOf) => async (b, { maxSeconds }) => { cuts.push(maxSeconds); return { audio: Buffer.from("fLaC stand-in"), seconds: Math.min(maxSeconds, lenOf(b)) }; };
  __setTranscodeForTest(cutStub((b) => (b === tiny ? 10 : 180)));
  for (const [label, impl] of [["null", async () => null], ["a throw", async () => { throw new Error("spawn failed"); }], ["zero", async () => 0], ["NaN", async () => NaN]]) {
    __setMeasureForTest(impl);
    const before = sttUnmeasuredSinceBoot();
    cuts = [];
    const a = await prepareAudioWithinCap(tiny, "audio.mp3", "transcribe"), b = await prepareAudioWithinCap(honest, "audio.mp3", "transcribe");
    ok(Math.abs(a.durationSec - 10) < 0.5 && b.durationSec > 170 && a.buf === tiny && b.buf === honest && !a.trimmedToCapSeconds && !b.trimmedToCapSeconds, `an unmeasured file inside the cap passes once the cut reads all of it, sent as it came (measure gave ${label})`);
    ok(cuts.length === 2 && cuts.every((c) => c === 240), `and the cut is made at the 4-minute cap (${cuts.join(",")})`);
    ok(sttUnmeasuredSinceBoot() === before + 2, "and each unmeasured file is counted");
  }
  __setTranscodeForTest(null);
  // A file the decoder here cannot read at all cannot be cut either: a 400
  // that names the format, before any upstream call. A decoder that could not
  // run is our side: a retryable 503, no upstream call.
  {
    const was = { measure: 0, cut: 0 };
    __setTranscodeForTest(async () => { was.cut++; return { audio: Buffer.from("x"), seconds: 1 }; });
    __setMeasureForTest(async () => ({ undecodable: "the decoder could not read its audio" }));
    let e = await reject(assertWithinDurationCap(tiny, "audio.mp3", "transcribe"));
    ok(e?.statusCode === 400 && e.hint === "format-unreadable" && /audio format could not be read/.test(e.message) && /the decoder could not read its audio/.test(e.message), `a file the decoder cannot read is a 400 that says its format could not be read (${e?.message ?? "passed"})`);
    // The charge sentence is a route call's only: a skill-pack step runs inside a charged answer.
    ok(!/not charged/i.test(e.message), `off a route (a skill-pack step) the 400 makes no charge claim (${e?.message})`);
    const onRoute = await reject(prepareAudioWithinCap(tiny, "audio.mp3", "transcribe", { headers: {} }));
    ok(onRoute?.statusCode === 400 && /You were not charged\./.test(onRoute.message), `on a route call the 400 says the caller was not charged (${onRoute?.message})`);
    ok(was.cut === 0, "and no cut is tried on it");
    __setMeasureForTest(async () => ({ unavailable: "no decoder slot came free in time" }));
    __setTranscodeForTest(async () => ({ unavailable: "no decoder slot came free in time" }));
    e = await reject(prepareAudioWithinCap(tiny, "audio.mp3", "transcribe"));
    ok(e?.statusCode === 503 && e.retryAfter === 30 && e.attribution === "ours" && /could not be trimmed/.test(e.message) && /no decoder slot came free in time/.test(e.message) && !/charged/.test(e.message), `no slot for the measurement or the cut: a retryable 503 on our side, no charge claim off a route call (${e?.message ?? "passed"})`);
    e = await reject(prepareAudioWithinCap(tiny, "audio.mp3", "transcribe", { headers: {} }));
    ok(e?.statusCode === 503 && /Nothing was charged\./.test(e.message), "on a route call it says nothing was charged");
    __setTranscodeForTest(async () => ({ undecodable: "the decoder could not read its audio" }));
    e = await reject(prepareAudioWithinCap(tiny, "audio.mp3", "transcribe"));
    ok(e?.statusCode === 400 && /audio format could not be read/.test(e.message), "a cut that finds the audio unreadable is the same 400");
    __setTranscodeForTest(cutStub(() => 10));
    const kept = await prepareAudioWithinCap(tiny, "audio.mp3", "transcribe");
    ok(kept.buf === tiny && kept.filename === "audio.mp3" && Math.abs(kept.durationSec - 10) < 0.5 && !("trimmedToCapSeconds" in kept), "unmeasured, a cut that read the whole file sends the original bytes");
    __setTranscodeForTest(cutStub(() => 400));
    const cut = await prepareAudioWithinCap(tiny, "audio.mp3", "transcribe");
    ok(cut.filename === "audio.flac" && cut.buf.toString() === "fLaC stand-in" && cut.durationSec === 240 && cut.trimmedToCapSeconds === 240 && cut.durationUnconfirmed === true, `unmeasured, a cut that reached the cap sends the cut and says so (${JSON.stringify({ ...cut, buf: undefined })})`);
    __setMeasureForTest(async () => ({ seconds: 30 }));
    ok(Math.abs((await assertWithinDurationCap(tiny, "audio.mp3", "transcribe")) - 30) < 0.01, "a measurement in the object shape is read as seconds");
    __setMeasureForTest(async () => ({ undecodable: "x" }));
    e = await reject(assertWithinDurationCap(long, "audio.wav", "transcribe-pro"));
    ok(e?.statusCode === 422 && /up to 10 minutes/.test(e.message), "a file its header puts over the cap is still the over-cap 422");
    // Bytes the sniffed demuxer (mp3, on the upstream's list) did not read and
    // a fallback demuxer (ogg, also on the list) did: what goes upstream is
    // the FLAC cut at the cap, never the original bytes.
    const sent = [];
    __setMeasureForTest(async () => ({ seconds: 10, format: "ogg" }));
    __setTranscodeForTest(async (b, o) => { sent.push(o); return { audio: Buffer.from("fLaC capped"), seconds: 10, format: o.format }; });
    const fb = await prepareAudioWithinCap(tiny, "audio.mp3", "transcribe");
    ok(fb.buf !== tiny && fb.filename === "audio.flac" && fb.buf.toString() === "fLaC capped" && sent.length === 1 && sent[0].maxSeconds === 242 && sent[0].format === "ogg", `bytes only a fallback demuxer read are sent as the FLAC cut at the cap, not as they came (${fb.filename}, ${JSON.stringify(sent)})`);
    __setTranscodeForTest(null);
  }
  // Unmeasured and lossy: held to the shortest its bytes can play.
  __setMeasureForTest(async () => null);
  const heavy = makeMp3(1300, 100);         // about 20.8 MB declaring seconds
  e = await reject(assertWithinDurationCap(heavy, "audio.mp3", "transcribe"));
  ok(e?.statusCode === 422 && /up to 4 minutes/.test(e.message), `unmeasured, a lossy file too large to play under the cap is refused (${e?.message ?? "passed"})`);
  ok(Math.abs(byteFloorSeconds(640_000 / 8 * 100 + 256 * 1024) - 100) < 1e-9 && byteFloorSeconds(1000) === 0 && byteFloorSeconds(10_000_000, 9_900_000) === 0, "the byte floor is bytes over the highest lossy bitrate, less embedded pictures and an allowance");
  // A lossless file is never held to the lossy floor: 96 kHz 24-bit stereo
  // PCM plays one minute in 34 MB, far above any lossy bitrate.
  const hi = (() => { const sr = 96000, bps = 3, ch = 2, secs = 30, dataLen = sr * bps * ch * secs; const b = Buffer.alloc(44 + dataLen); b.write("RIFF", 0); b.writeUInt32LE(36 + dataLen, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * bps * ch, 28); b.writeUInt16LE(bps * ch, 32); b.writeUInt16LE(24, 34); b.write("data", 36); b.writeUInt32LE(dataLen, 40); return b; })();
  __setTranscodeForTest(cutStub(() => 30));
  ok(Math.abs((await assertWithinDurationCap(hi, "audio.wav", "transcribe")) - 30) < 0.5, `unmeasured, a 30-second lossless file of ${(hi.length / 1e6).toFixed(0)} MB passes (the floor is for lossy audio only)`);
  // The floor is for audio-only lossy files in one or two channels: a video
  // track's bytes are not audio, and more channels can carry more bits a
  // second than the floor's rate. Either one keeps the declared length.
  const applies = sttKit.byteFloorApplies;
  ok(typeof applies === "function", "the kit says which containers the byte floor bounds");
  if (typeof applies === "function") {
    ok(applies({ lossy: true, hasVideo: false, channels: 2, sampleRate: 48000 }) && applies({ lossy: true, hasVideo: false, channels: 1, sampleRate: 44100 }), "an audio-only lossy file in one or two channels at up to 48 kHz is held to the floor");
    ok(!applies({ lossy: true, hasVideo: true, channels: 2, sampleRate: 44100 }), "a file with a video track is not held to the floor (its video bytes are not audio)");
    ok(!applies({ lossy: true, hasVideo: undefined, channels: 2, sampleRate: 44100 }), "a container that does not say whether it holds video is not held to the floor");
    ok(!applies({ lossy: true, hasVideo: false, channels: 6, sampleRate: 44100 }) && !applies({ lossy: true, hasVideo: false, channels: null, sampleRate: 44100 }), "a lossy file of more channels, or of an unread channel count, is not held to the floor");
    ok(!applies({ lossy: false, hasVideo: false, channels: 2, sampleRate: 44100 }) && !applies(null), "a lossless file is not held to the floor");
    ok(!applies({ lossy: true, hasVideo: false, channels: 2, sampleRate: 192000 }) && !applies({ lossy: true, hasVideo: false, channels: 2, sampleRate: 96000 }), "a lossy file above 48 kHz is not held to the floor (192 kHz Vorbis carries more bits a second than the floor's rate)");
    ok(!applies({ lossy: true, hasVideo: false, channels: 2, sampleRate: null }) && !applies({ lossy: true, hasVideo: false, channels: 2 }), "a lossy file without a reported sample rate is not held to the floor");
  }
  __setMeasureForTest(null);
  __setTranscodeForTest(null);

  // The decode's own bounds and readings, on a stubbed ffmpeg (no process, no
  // clock): each run has a time and an output-size bound, at most two run at
  // once and a third waits for a slot, and only a decode that succeeded and
  // reported how far it got is a measurement.
  {
    // Each call decodes a file of its own length, so the stub knows which
    // call a run belongs to whatever order the temp-file writes finish in.
    const held = [];
    // A run under any demuxer but the sniffed one (mp3) is a failed decode at
    // once: those are the fallbacks a failed decode is retried under.
    const fallbacks = [];
    // Two slots, whatever this machine's CPU count (the pool's size is tested below).
    const hadSlots = process.env.AUDIO_DECODE_SLOTS;
    process.env.AUDIO_DECODE_SLOTS = "2";
    __setExecFileForTest((bin, args, opts, cb) => {
      const fmt = args[args.indexOf("-i") - 1];
      if (fmt !== "mp3") { fallbacks.push(fmt); setImmediate(() => cb(Object.assign(new Error("exit 1"), { code: 1 }))); return; }
      let bytes = -1;
      try { bytes = readFileSync(args[args.indexOf("-i") + 1]).length; } catch { /* asserted below */ }
      held.push({ bin, args, opts, cb, bytes });
    });
    try {
      const mp3s = [makeMp3(5), makeMp3(6), makeMp3(7)];
      const calls = mp3s.map((b) => measureAudioSeconds(b));
      // Waits for an outcome, up to a deadline (a slow machine waits longer, never fails sooner).
      const until = async (cond, ms = 30_000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5)); return cond(); };
      ok(await until(() => held.length === 2), `two decodes start at once (${held.length})`);
      // A third would have started by now had it not waited (its file is written like the others').
      await until(() => held.length > 2, 500);
      ok(held.length === 2, `a third waits for a slot while two run (${held.length} started)`);
      const o = held[0].opts || {};
      ok(held[0].bin === "ffmpeg" && o.timeout === 10_000, `each decode has a 10 s time bound (${o.timeout})`);
      ok(Number.isFinite(o.maxBuffer) && o.maxBuffer > 0 && o.maxBuffer <= 8 * 1024 * 1024, `each decode's output is bounded (${o.maxBuffer} bytes)`);
      ok(held[0].args.includes("0:a:0") && held[0].args.includes("-vn"), "the decode reads the first audio stream only");
      // Answer the two running decodes: one finished, one failed after printing progress.
      const [ran, failed] = held.slice(0, 2);
      const idx = (h) => mp3s.findIndex((b) => b.length === h.bytes);
      ran.cb(null, "out_time_us=1000000\nprogress=continue\nout_time_us=5000000\nprogress=end\n");
      failed.cb(Object.assign(new Error("exit 1"), { code: 1 }), "out_time_us=4000000\n");
      ok((await calls[idx(ran)]) === 5, "a decode that finished reports its last out_time in seconds");
      ok((await calls[idx(failed)]) === null, "a decode that failed is no measurement, whatever it printed before failing");
      ok(fallbacks.length === 11 && new Set(fallbacks).size === 11 && !fallbacks.includes("mp3"), `a failed decode is retried once under each other whitelisted demuxer, never autodetected (${fallbacks.join(",")})`);
      ok(await until(() => held.length === 3), "the waiting decode starts when a slot frees");
      const last = held[2];
      last.cb(null, "progress=end\n");
      ok((await calls[idx(last)]) === null, "a decode that never reported how far it got is no measurement (null, never a guess)");
      ok(new Set(held.map(idx)).size === 3 && held.every((h) => idx(h) >= 0), "each call ran its own decode once");
    } finally {
      __setExecFileForTest(null);
      if (hadSlots === undefined) delete process.env.AUDIO_DECODE_SLOTS; else process.env.AUDIO_DECODE_SLOTS = hadSlots;
    }
  }

  // A busy pool queues inside the call's budget instead of refusing: on a
  // stubbed ffmpeg that holds each decode until the test answers it.
  {
    const mediaKit = await import("../src/tools/media-kit.js");
    const { withBudget } = await import("../src/upstream-deadline.js");
    const { availableParallelism } = await import("node:os");
    const MIN_DECODE = mediaKit.MEASURE_MIN_DECODE_MS ?? 10_000;
    const UP = sttKit.STT_UPSTREAM_CAP_MS ?? { default: 60_000, diarize: 120_000 };
    const until = async (cond, ms = 30_000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5)); return cond(); };
    const settle = (p) => { const s = { done: false, value: null, err: null }; p.then((v) => { s.done = true; s.value = v; }, (e) => { s.done = true; s.err = e; }); return s; };
    const hadSlots = process.env.AUDIO_DECODE_SLOTS;
    const held = [];
    __setMeasureForTest(null); __setTranscodeForTest(null);
    __setExecFileForTest((bin, args, opts, cb) => {
      let bytes = -1;
      try { bytes = readFileSync(args[args.indexOf("-i") + 1]).length; } catch { /* the run is still held */ }
      held.push({ args, opts, cb, bytes, cut: args.includes("-t") });
    });
    const answer = (h, seconds) => h.cb(null, `out_time_us=${Math.round(seconds * 1e6)}\nprogress=end\n`);
    const route = { headers: {} };
    // The pool's wait timer is unref'd (it never holds a server open); this keeps the test's process up.
    const keep = setInterval(() => {}, 1_000);
    try {
      // The pool's size: the env override, else the CPUs this process may use (2 to 8).
      const size = mediaKit.measurePoolSize;
      ok(typeof size === "function", "the decode pool's size is read from one function");
      if (typeof size === "function") {
        const cpus = availableParallelism();
        ok(size({ AUDIO_DECODE_SLOTS: "3" }) === 3 && size({ AUDIO_DECODE_SLOTS: "12" }) === 12, "AUDIO_DECODE_SLOTS sets the pool's size");
        ok(size({}) === Math.max(2, Math.min(8, cpus)) && size({ AUDIO_DECODE_SLOTS: "0" }) === size({}) && size({ AUDIO_DECODE_SLOTS: "many" }) === size({}), `unset or unreadable, the size follows the CPU count, held to 2..8 (${size({})} for ${cpus})`);
      }
      process.env.AUDIO_DECODE_SLOTS = "3";
      const three = [makeMp3(5), makeMp3(6), makeMp3(7)];
      const runs3 = three.map((b) => settle(prepareAudioWithinCap(b, "audio.mp3", "transcribe", route)));
      ok(await until(() => held.length === 3), `with AUDIO_DECODE_SLOTS=3, three decodes run at once (${held.length})`);
      for (const h of held.splice(0)) answer(h, three.findIndex((b) => b.length === h.bytes) + 5);
      ok(await until(() => runs3.every((r) => r.done)) && runs3.every((r, i) => r.value?.buf === three[i]), "and each is served");

      // Two slots, three calls: the third waits past the old five-second
      // refusal and is measured (never cut) when a slot frees.
      process.env.AUDIO_DECODE_SLOTS = "2";
      const mp3s = [makeMp3(5), makeMp3(6), makeMp3(7)];
      const idx = (h) => mp3s.findIndex((b) => b.length === h.bytes);
      const calls = mp3s.map((b) => settle(prepareAudioWithinCap(b, "audio.mp3", "transcribe", route)));
      ok(await until(() => held.length === 2), `two decodes start (${held.length})`);
      ok(held.every((h) => h.opts?.timeout > MIN_DECODE && h.opts.timeout <= 60_000), `a decode with budget to spare may run past ${MIN_DECODE} ms (${held.map((h) => h.opts?.timeout).join(",")})`);
      await new Promise((r) => setTimeout(r, 5_600));
      const third = calls[[0, 1, 2].find((i) => !held.some((h) => idx(h) === i))];
      ok(held.length === 2 && !third.done, `after 5.6 s the third call still waits for a slot, not refused (${third.err?.statusCode ?? "pending"})`);
      const first = held.shift();
      answer(first, idx(first) + 5);
      ok(await until(() => held.length === 2), "a freed slot goes to the waiting call");
      const next = held[1];
      ok(!next.cut && idx(next) >= 0 && next !== held[0], `the waiting call's run is its measurement, not a cut at the cap (${next.cut ? "cut" : "measure"})`);
      answer(next, idx(next) + 5);
      ok(await until(() => third.done) && third.value?.buf === mp3s[idx(next)] && Math.abs(third.value.durationSec - (idx(next) + 5)) < 0.01 && !third.value.trimmedToCapSeconds, `and it is served, measured, as it came (${third.err?.message ?? third.value?.durationSec})`);

      // One slot still held by the second call; hold the other too.
      const blocker = settle(prepareAudioWithinCap(makeMp3(8), "audio.mp3", "transcribe", route));
      ok(await until(() => held.length === 2), "both slots held again");
      // A PCM WAV whose bytes alone play under the cap goes as it came, at once, with no decode.
      const wav = makeWav(10);
      ok(typeof sttKit.pcmWavMaxSeconds === "function" && Math.abs(sttKit.pcmWavMaxSeconds(wav) - wav.length / 8000) < 1e-9, "a PCM WAV is bounded by its bytes at 8,000 bytes a second");
      const t0 = Date.now();
      const quick = await Promise.race([prepareAudioWithinCap(wav, "audio.wav", "transcribe", route).catch((e) => e), new Promise((r) => setTimeout(() => r("waited"), 1_500))]);
      ok(quick?.buf === wav && Math.abs(quick.durationSec - 10) < 0.5 && held.length === 2, `with the pool full, a byte-bounded WAV is sent as it came in ${Date.now() - t0} ms, no decode (${quick === "waited" ? "waited" : quick?.message ?? quick?.filename})`);
      // Bytes that do not bound it (the 4.5-minute WAV, a compressed codec) still wait for a decode.
      ok(sttKit.pcmWavMaxSeconds?.(justOver) > 242 && sttKit.pcmWavMaxSeconds?.(makeMp3(5)) === null, "a WAV too large to bound, and an MP3, are not byte-bounded");
      if (typeof sttKit.pcmWavMaxSeconds === "function") {
        const adpcm = Buffer.from(wav); adpcm.writeUInt16LE(2, 20);
        const twoFmt = Buffer.concat([wav.subarray(0, 36), wav.subarray(12, 36), wav.subarray(36)]); twoFmt.writeUInt32LE(twoFmt.length - 8, 4);
        const slow = Buffer.from(wav); slow.writeUInt32LE(4000, 24); slow.writeUInt32LE(4000, 28);
        const lying = Buffer.from(wav); lying.writeUInt32LE(16000, 28);
        ok([adpcm, twoFmt, slow, lying].every((b) => sttKit.pcmWavMaxSeconds(b) === null), "a compressed WAV codec, a second fmt chunk, a rate under 8 kHz and fields that disagree are not byte-bounded");
      }

      // The 503 comes only when the budget cannot hold the wait plus the upstream call.
      const short503 = Date.now();
      let e = await reject(withBudget(() => prepareAudioWithinCap(makeMp3(9), "audio.mp3", "transcribe", route), UP.default + MIN_DECODE - 2_000));
      const tShort = Date.now() - short503;
      ok(e?.statusCode === 503 && e.retryAfter === 30 && /Nothing was charged\./.test(e.message) && tShort < 1_000 && held.length === 2, `a budget with no room past the upstream's ${UP.default} ms and a decode answers the retryable 503 at once (${tShort} ms, ${e?.message ?? "passed"})`);
      const waitStart = Date.now();
      e = await reject(withBudget(() => prepareAudioWithinCap(makeMp3(9), "audio.mp3", "transcribe", route), UP.default + MIN_DECODE + 1_500));
      const tWait = Date.now() - waitStart;
      ok(e?.statusCode === 503 && tWait >= 1_200 && tWait < 4_000, `a budget with 1.5 s to spare waits that long for a slot, then the 503 (${tWait} ms)`);
      let tD = Date.now();
      e = await reject(withBudget(() => prepareAudioWithinCap(makeMp3(9), "audio.mp3", "transcribe", route, { diarize: true }), UP.default + MIN_DECODE + 30_000));
      tD = Date.now() - tD;
      ok(e?.statusCode === 503 && tD < 1_000, `the diarized path keeps its longer upstream cap (${UP.diarize} ms) out of the wait: no room, the 503 at once (${tD} ms)`);
      // The route handler passes diarize through (the OpenAI wire's multipart field).
      const fd = new FormData(); fd.append("file", new Blob([makeMp3(9)]), "a.mp3"); fd.append("diarize", "true");
      const rq = new Request("http://x/", { method: "POST", body: fd });
      const mreq = { headers: { "content-type": rq.headers.get("content-type") }, body: Buffer.from(await rq.arrayBuffer()) };
      tD = Date.now();
      e = await reject(withBudget(() => makeMultipartHandler("transcribe")({}, mreq), UP.default + MIN_DECODE + 30_000));
      tD = Date.now() - tD;
      ok(e?.statusCode === 503 && tD < 1_000, `a diarized upload reaches the decode with its longer upstream cap (${tD} ms, ${e?.statusCode ?? "passed"})`);
      for (const h of held.splice(0)) answer(h, 8);
      ok(await until(() => blocker.done) && calls.every((c) => c.done), "the held calls finish once answered");
    } finally {
      for (const h of held.splice(0)) answer(h, 1);
      clearInterval(keep);
      __setExecFileForTest(null);
      if (hadSlots === undefined) delete process.env.AUDIO_DECODE_SLOTS; else process.env.AUDIO_DECODE_SLOTS = hadSlots;
    }
  }

  // The real decode. Under CI a missing ffmpeg fails the suite: the lane installs it.
  let ffmpeg = true;
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { ffmpeg = false; }
  if (!ffmpeg) {
    if (process.env.CI) ok(false, "ffmpeg is not installed on this CI runner: the decode measurement cannot be tested (install it in the lane)");
    else console.log("SKIP: ffmpeg not installed here; the decode measurement ran on stubs only");
  } else {
    const m = await measureAudioSeconds(lying);
    ok(Number.isFinite(m) && Math.abs(m - 330) < 3, `the decode measures what the lying MP3 plays (${m}s of 330)`);
    e = await reject(assertWithinDurationCap(lying, "audio.mp3", "transcribe"));
    ok(e?.statusCode === 422 && /up to 4 minutes/.test(e.message), `end to end: the lying MP3 is refused by the 4-minute cap (${e?.message ?? "passed"})`);
    ok((await assertWithinDurationCap(lying, "audio.mp3", "transcribe-pro")) > 320, "end to end: and passes the 10-minute tier at its measured length");
    // No new refusal inside the cap: honest files of each kind, up to the cap's edge.
    ok(Math.abs((await assertWithinDurationCap(short, "audio.wav", "transcribe")) - 10) < 0.5, "end to end: a 10-second WAV passes");
    ok((await assertWithinDurationCap(makeWav(4 * 60), "audio.wav", "transcribe")) > 239, "end to end: a WAV exactly at the 4-minute cap passes");
    ok((await assertWithinDurationCap(makeMp3(239), "audio.mp3", "transcribe")) > 238, "end to end: an honest MP3 just under the cap passes");
    ok((await assertWithinDurationCap(makeMp3(599), "audio.mp3", "transcribe-pro")) > 598, "end to end: an honest MP3 just under the 10-minute cap passes the pro tier");
    ok((await measureAudioSeconds(junk)) === null, "bytes that are no container measure to null, never a throw");

    // A clip with a video track: 10 seconds whose video bytes alone would be
    // minutes of audio at the floor's rate. Inside the cap it passes measured
    // and unmeasured alike (a busy decode pool, a slow decode).
    const dir = mkdtempSync(join(tmpdir(), "a402-stt-cap-"));
    try {
      const clip = join(dir, "clip.mp4");
      execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=320x240:r=25,geq=random(1)*255:128:128", "-f", "lavfi", "-i", "sine=f=440", "-t", "10", "-c:v", "mpeg4", "-q:v", "1", "-c:a", "aac", "-b:a", "96k", "-shortest", clip], { stdio: "ignore" });
      const video = readFileSync(clip);
      ok(byteFloorSeconds(video.length) > 4 * 60 + 2, `the clip's bytes would read as ${Math.round(byteFloorSeconds(video.length))} s of lossy audio (${(video.length / 1e6).toFixed(1)} MB)`);
      const m = await measureAudioSeconds(video);
      ok(Number.isFinite(m) && Math.abs(m - 10) < 1, `the decode measures the clip's audio, not its video (${m}s of 10)`);
      const measured = await reject(assertWithinDurationCap(video, "clip.mp4", "transcribe"));
      ok(measured === null, `end to end: a 10-second clip with a video track passes measured (${measured?.message ?? "passed"})`);
      ok(Math.abs((await assertWithinDurationCap(video, "clip.mp4", "transcribe")) - 10) < 1, "and the duration returned is its 10 seconds");
      __setMeasureForTest(async () => null);
      const unmeasuredClip = await reject(assertWithinDurationCap(video, "clip.mp4", "transcribe"));
      ok(unmeasuredClip === null, `unmeasured, a 10-second clip with a video track passes on its declared length (${unmeasuredClip?.message ?? "passed"})`);
      ok(Math.abs((await assertWithinDurationCap(video, "clip.mp4", "transcribe")) - 10) < 1, "and the duration returned is its declared 10 seconds");
      __setMeasureForTest(null);

      // 150 seconds of 192 kHz stereo Vorbis: about 24 MB, more bits a second
      // than the floor's rate. Inside the cap it passes unmeasured too.
      const hiRate = join(dir, "hi.ogg");
      execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=r=192000:a=0.9:d=150", "-ac", "2", "-c:a", "vorbis", "-strict", "-2", "-q:a", "10", hiRate], { stdio: "ignore" });
      const vorbis = readFileSync(hiRate);
      ok(byteFloorSeconds(vorbis.length) > 4 * 60 + 2, `the Vorbis file's bytes would read as ${Math.round(byteFloorSeconds(vorbis.length))} s at the floor's rate (${(vorbis.length / 1e6).toFixed(1)} MB)`);
      __setMeasureForTest(async () => null);
      const unmeasuredVorbis = await reject(assertWithinDurationCap(vorbis, "audio.ogg", "transcribe"));
      ok(unmeasuredVorbis === null, `unmeasured, 150 seconds of 192 kHz stereo Vorbis passes the 4-minute cap on its declared length (${unmeasuredVorbis?.message ?? "passed"})`);
      ok(Math.abs((await assertWithinDurationCap(vorbis, "audio.ogg", "transcribe")) - 150) < 1, "and the duration returned is its declared 150 seconds");
      __setMeasureForTest(null);

      // A WMA (ASF) file is measured, and sent upstream as FLAC: ASF is not on
      // the upstream's input list.
      const wmaPath = join(dir, "t.wma");
      execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=5", "-c:a", "wmav2", "-b:a", "64k", wmaPath], { stdio: "ignore" });
      const wma = readFileSync(wmaPath);
      const wmaLen = await measureAudioSeconds(wma);
      ok(Number.isFinite(wmaLen) && Math.abs(wmaLen - 5) < 0.2, `the decoder measures a real WMA file (${wmaLen}s of 5)`);
      const wmaPrep = await reject(prepareAudioWithinCap(wma, "audio.wma", "transcribe")) ?? await prepareAudioWithinCap(wma, "audio.wma", "transcribe");
      ok(wmaPrep?.filename === "audio.flac" && wmaPrep.buf?.subarray(0, 4).toString("latin1") === "fLaC" && Math.abs(wmaPrep.durationSec - 5) < 0.2 && !("trimmedToCapSeconds" in wmaPrep), `a WMA file inside the cap is served, converted to FLAC, nothing cut (${wmaPrep?.message ?? wmaPrep?.filename})`);
      if (wmaPrep?.buf) ok(Math.abs((await measureAudioSeconds(wmaPrep.buf)) - 5) < 0.2, "and the FLAC holds all five seconds");

      // A file that declares 60 seconds and plays 330: with the measurement
      // unavailable (its deadline), it is cut at the cap and sent as the cut.
      const sixty = makeMp3(330, Math.round(60 * 44100 / 1152));
      ok(Math.abs((await probeDurationSeconds(sixty, "audio.mp3")) - 60) < 0.5, "the MP3 declares 60 seconds");
      __setMeasureForTest(async () => ({ unavailable: "the decode outlasted its deadline" }));
      const cutPrep = await reject(prepareAudioWithinCap(sixty, "audio.mp3", "transcribe")) ?? await prepareAudioWithinCap(sixty, "audio.mp3", "transcribe");
      const cutLen = cutPrep?.buf ? await measureAudioSeconds(cutPrep.buf) : null;
      ok(cutPrep?.trimmedToCapSeconds === 240 && cutPrep.durationUnconfirmed === true && cutPrep.filename === "audio.flac" && Math.abs(cutLen - 240) < 0.5 && Math.abs(cutPrep.durationSec - 240) < 0.5, `a file declaring 60 s that plays 330 s is cut to the 4-minute cap (${cutLen}s sent; ${cutPrep?.message ?? ""})`);
      const proPrep = await prepareAudioWithinCap(sixty, "audio.mp3", "transcribe-pro");
      ok(proPrep.buf === sixty && Math.abs(proPrep.durationSec - 330) < 3 && !("trimmedToCapSeconds" in proPrep), `on the 10-minute tier the cut reads all of it: its measured 330 s, the bytes sent as they came (${proPrep.durationSec}s)`);
      __setMeasureForTest(null);

      // A file the decoder cannot read at all (an ASF header with no audio in
      // it) cannot be cut: the 400.
      const guid = (str) => { const b = Buffer.from(str.replace(/-/g, ""), "hex"); return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(), Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8)]); };
      const fp = Buffer.alloc(104); guid("8CABDCA1-A947-11CF-8EE4-00C00C205365").copy(fp, 0); fp.writeBigUInt64LE(104n, 16); fp.writeBigUInt64LE(60n * 10_000_000n, 64); fp.writeUInt32LE(2, 88);
      const head = Buffer.alloc(30); guid("75B22630-668E-11CF-A6D9-00AA0062CE6C").copy(head, 0); head.writeBigUInt64LE(134n, 16); head.writeUInt32LE(1, 24); head[28] = 1; head[29] = 2;
      const hollow = Buffer.concat([head, fp, Buffer.alloc(400_000)]);
      ok((await probeDurationSeconds(hollow, "audio.wma")) === 60, "the hollow WMA declares 60 seconds");
      for (const slug of ["transcribe", "transcribe-pro"]) {
        const err = await reject(prepareAudioWithinCap(hollow, "audio.wma", slug, { headers: {} }));
        ok(err?.statusCode === 400 && err.hint === "format-unreadable" && /audio format could not be read/.test(err.message) && /You were not charged\./.test(err.message), `${slug}: a file the decoder cannot read is the 400 (${err?.statusCode}: ${err?.message ?? "passed"})`);
      }

      // Files the upstream took as they came before the decoder measured them:
      // ADTS AAC behind an ID3 tag, and an MP3 behind leading zero padding.
      // Each is read by the decoder, measured and served, never the 400.
      {
        const gen = (name, args) => { const p = join(dir, name); execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=6", "-ac", "1", ...args, p], { stdio: "ignore" }); return readFileSync(p); };
        const adts = gen("p.aac", ["-c:a", "aac", "-f", "adts"]);
        const mp3 = gen("p.mp3", ["-c:a", "libmp3lame", "-f", "mp3"]);
        const ogg = gen("p.ogg", ["-c:a", "libopus", "-f", "ogg"]);
        const id3 = (body, n = 1000) => { const h = Buffer.alloc(10 + n); h.write("ID3", 0); h[3] = 4; h[6] = (n >> 21) & 127; h[7] = (n >> 14) & 127; h[8] = (n >> 7) & 127; h[9] = n & 127; return Buffer.concat([h, body]); };
        const cases = [["ADTS AAC behind an ID3 tag", id3(adts), "audio.aac", "flac"], ["an MP3 behind 3000 zero bytes", Buffer.concat([Buffer.alloc(3000), mp3]), "audio.mp3", "as-is"], ["ADTS AAC behind 3000 zero bytes (no sniff; a fallback demuxer reads it)", Buffer.concat([Buffer.alloc(3000), adts]), "audio.aac", "flac"], ["Ogg behind an ID3 tag and 3000 zero bytes (sniffed as mp3; only the ogg fallback reads it)", id3(Buffer.concat([Buffer.alloc(3000), ogg])), "audio.mp3", "flac"], ["an Ogg file named .m4a (its header parse declares nothing; the decoder reads it)", ogg, "audio.m4a", "flac"], ["an Ogg file named .flac (its header parse declares nothing; the decoder reads it)", ogg, "audio.flac", "flac"]];
        for (const [label, b, name, how] of cases) {
          for (const slug of ["transcribe", "transcribe-pro"]) {
            let p = null, err = null;
            try { p = await prepareAudioWithinCap(b, name, slug, { headers: {} }); } catch (e) { err = e; }
            const sent = how === "as-is" ? p?.buf === b : p?.filename === "audio.flac" && p.buf?.subarray(0, 4).toString("latin1") === "fLaC";
            ok(!err && sent && Math.abs(p.durationSec - 6) < 0.3 && !("trimmedToCapSeconds" in p), `${slug}: ${label} is measured and served ${how === "as-is" ? "as it came" : "as FLAC"} (${err ? `${err.statusCode}: ${err.message}` : `${p?.filename}, ${p?.durationSec}s`})`);
          }
        }
      }

      // Bytes that neither the header parse nor the decoder reads stay the 422.
      for (const slug of ["transcribe", "transcribe-pro"]) {
        const e = await reject(prepareAudioWithinCap(junk, "audio.m4a", slug, { headers: {} }));
        ok(e?.statusCode === 422 && /Could not read the audio duration/.test(e.message), `${slug}: bytes no reader measures are the 422 (${e ? `${e.statusCode}: ${e.message}` : "passed"})`);
      }

      // A file converted for the upstream is measured and converted in ONE
      // decode (a WMA): the conversion is the measurement's own output.
      {
        const runs = [];
        __setExecFileForTest((bin, args, opts, cb) => { runs.push(args); return realExecFile(bin, args, opts, cb); });
        let p = null;
        try { p = await prepareAudioWithinCap(wma, "audio.wma", "transcribe", { headers: {} }); } finally { __setExecFileForTest(null); }
        ok(runs.length === 1 && p?.filename === "audio.flac" && Math.abs(p.durationSec - 5) < 0.2, `a WMA inside the cap is measured and converted in one decode (${runs.length} run(s), ${p?.durationSec}s)`);
        if (p?.buf) ok(Math.abs((await measureAudioSeconds(p.buf)) - 5) < 0.2, "and the FLAC from that decode holds all five seconds");
        // Over the cap, the same single run still reads the whole length.
        const longWma = join(dir, "long.wma");
        execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=300", "-c:a", "wmav2", "-b:a", "32k", longWma], { stdio: "ignore" });
        const e = await reject(prepareAudioWithinCap(readFileSync(longWma), "audio.wma", "transcribe", { headers: {} }));
        ok(e?.statusCode === 422 && /Audio is 5\.0 minutes/.test(e.message), `a five-minute WMA is refused at its full measured length (${e?.message ?? "passed"})`);
      }

      // An MP4 holding two audio tracks (3 s, then 9 s): measured on the first
      // and sent as that track alone, never as the container (the upstream
      // could read the other).
      {
        const multi = join(dir, "multi.m4a");
        execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=3", "-f", "lavfi", "-i", "sine=f=880:d=9", "-map", "0", "-map", "1", "-c:a", "aac", multi], { stdio: "ignore" });
        const mb = readFileSync(multi);
        const p = await prepareAudioWithinCap(mb, "audio.m4a", "transcribe", { headers: {} });
        const sentLen = p.buf !== mb ? await measureAudioSeconds(p.buf) : null;
        ok(p.buf !== mb && p.filename === "audio.flac" && Math.abs(sentLen - 3) < 0.3, `a two-track MP4 is sent as its measured first track (${p.filename}, ${sentLen}s sent)`);
        const single = join(dir, "single.m4a");
        execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=3", "-c:a", "aac", single], { stdio: "ignore" });
        const sb = readFileSync(single);
        ok((await prepareAudioWithinCap(sb, "audio.m4a", "transcribe")).buf === sb, "control: a one-track MP4 is still sent as it came");
      }

      // A measured file on the upstream's list goes byte for byte.
      for (const [b, name] of [[short, "audio.wav"], [makeMp3(30), "audio.mp3"], [vorbis, "audio.ogg"]]) {
        const p = await prepareAudioWithinCap(b, name, "transcribe-pro");
        ok(p.buf === b && p.filename === name && !("trimmedToCapSeconds" in p), `a measured ${name} inside the cap is sent as it came, not re-encoded`);
      }

      // Through the route handler: what the upstream receives, and the answer.
      const realFetch = globalThis.fetch, hadKey = process.env.OPENAI_API_KEY;
      const sent = [];
      process.env.OPENAI_API_KEY = "sk-test-not-real";
      globalThis.fetch = async (_url, init) => {
        const f = init.body.get("file");
        sent.push({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) });
        return new Response(JSON.stringify({ text: "ok", language: "en" }), { status: 200, headers: { "content-type": "application/json" } });
      };
      const upload = async (bytes, name, slug = "transcribe") => {
        const fd = new FormData(); fd.append("file", new Blob([bytes]), name);
        const r = new Request("http://x/", { method: "POST", body: fd });
        return makeMultipartHandler(slug)({}, { headers: { "content-type": r.headers.get("content-type") }, body: Buffer.from(await r.arrayBuffer()) });
      };
      try {
        const wavOut = await upload(short, "clip.wav");
        ok(sent[0]?.name === "clip.wav" && sent[0].bytes.equals(short) && !("trimmedToCapSeconds" in wavOut), "route: a WAV reaches the upstream byte for byte, and the answer carries no cut fields");
        const wmaOut = await upload(wma, "memo.wma");
        ok(sent[1]?.name === "audio.flac" && sent[1].bytes.subarray(0, 4).toString("latin1") === "fLaC" && Math.abs(wmaOut.duration - 5) < 0.2, `route: a WMA is served as FLAC (${sent[1]?.name}, ${wmaOut.duration}s)`);
        __setMeasureForTest(async () => ({ unavailable: "the decode outlasted its deadline" }));
        const cutOut = await upload(sixty, "talk.mp3");
        ok(cutOut.trimmedToCapSeconds === 240 && cutOut.durationUnconfirmed === true && Math.abs(cutOut.duration - 240) < 0.5 && sent[2]?.name === "audio.flac", `route: the cut answer says it was cut to the cap and that the declared length was unconfirmed (${JSON.stringify({ t: cutOut.trimmedToCapSeconds, u: cutOut.durationUnconfirmed, d: cutOut.duration })})`);
      } finally {
        globalThis.fetch = realFetch;
        if (hadKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = hadKey;
        __setMeasureForTest(null);
      }
    } finally {
      __setMeasureForTest(null);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
