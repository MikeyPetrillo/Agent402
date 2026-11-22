// Speech-to-text kit — two tiers of x402-paywalled transcription via OpenAI.
// Accepts an audio URL, fetches it, sends to OpenAI, returns transcript.
// Env-gated: missing OPENAI_API_KEY → 503.
//
// Tiers:
//   transcribe      $0.03  - gpt-transcribe  (4 min max)
//   transcribe-pro  $0.10  - gpt-transcribe  (10 min max)
//   transcribe-long $0.20  - gpt-transcribe  (30 min max; listed only with
//                            TRANSCRIBE_LONG=on, see sttLongEnabled)
//
// The per-tier duration cap is a MARGIN bound, not just a UX limit: OpenAI
// bills per audio minute, so an unchecked 25 MB file (~26 min at 128 kbps
// mp3) would cost more upstream than the tool charges. Duration is probed
// locally (header parse, no upstream call) and enforced BEFORE the file is
// sent to OpenAI. The cap is sized so worst case stays under STT_MARGIN of
// the price. Pinned in scripts/test-stt-cap.js.
//
// transcribe-pro moved gpt-4o-transcribe -> gpt-transcribe 2026-08-04
// (OpenAI's 2026-07-28 release and the recommended replacement).
// transcribe moved gpt-4o-mini-transcribe -> gpt-transcribe 2026-09-18: OpenAI
// shuts down gpt-4o-mini-transcribe, gpt-4o-transcribe and whisper-1 on
// 2027-02-26 and names gpt-transcribe the successor. The two tiers now run
// the SAME model and differ only in the duration cap (and price); the pro
// tier is the longer-recording tier, not a higher-accuracy one.
//
// SPEAKERS AND WORD TIMES (2026-10-07): `diarize: true` sends the audio to
// ElevenLabs Scribe v2 over OpenRouter instead and adds `words` (each with
// start, end and a speaker number) and `speakers` to the answer. Same caps and
// prices; its per-minute rate row is pinned by the same margin test.
//
// OPENROUTER'S 2026-09-29 STT FIELDS (read 2026-10-14): the diarized answer now
// carries `language_confidence` (Scribe scores its language detection). The
// request field `keyterms` is refused upstream by every transcription model
// listed today ("does not support keyterms", probed per model), and Scribe's
// entity detection is not forwarded through provider options (no `entities`
// in the answer, same billed cost), so neither is offered here: a buyer who
// sends one gets a 400 before any fetch or spend rather than a transcript that
// quietly ignored it. Offering them is a change here once a serving model
// honors them live. Our data policy goes on every Scribe request
// (src/openrouter-audio-policy.js: data_collection deny, zdr); the default
// path calls OpenAI directly, outside OpenRouter's routing.
//
// RE-READ 2026-11-12: OpenRouter's published spec still says keyterms is
// "only supported by some providers; 400 when the selected model cannot use
// keyterms" and names none, and no model or endpoint listing carries a
// keyterms flag (only supports_diarization), so nothing shows a model we send
// honoring it: the refusal stays. x-ai/grok-stt-2.0 was read as a diarize
// fallback and not added: its one endpoint lists supports_diarization false,
// and it is not a ZDR endpoint, which Scribe is.

// ONE MORE ATTEMPT (2026-11-10): an upstream failure that passes on its own (a
// 5xx, a rate limit with a short Retry-After, a connection that failed) used
// to be the buyer's 502. It now gets one more attempt on the same model; see
// transcribeWithRetry for the bounds.

import { answerLanguage } from "../text-language.js";
import { parseMultipartFile } from "../multipart.js";
import { loadMusicMetadata } from "./lazy-deps.js";
import { safeFetch } from "./fetch-guard.js";
import { measureAudio, transcodeSpeech, inputFormatOf, SPEECH_CODECS } from "./media-kit.js";
import { admissionCallerOf } from "../dispatch-caller.js";
import { redactSecrets } from "./redact.js";
import { NOT_CHARGED, notChargedOn } from "../not-charged.js";
import { upstreamCosts } from "../upstream-costs.js";
import { OPENROUTER_ATTRIBUTION } from "../openrouter-attribution.js";
import { assertUpstreamBody } from "./llm-gateway-kit.js";
import { capturePostHogGatewayUsage } from "../posthog.js";
import { mediaMeterEnabled, setMeterSentinel } from "../gateway-meter.js";
import { audioProviderPolicy } from "../openrouter-audio-policy.js";
import { admittedSttAdditions } from "../speech-additions.js";
import { cdnSyncLeftMs } from "../cdn-sync-window.js";
import { evmCredentialBudgetMs } from "../evm-validity.js";
import { attributed, ATTRIBUTION, KIND, secondsOf, isDnsFailure, currentBudget, handlerBudgetMs, underBudgetAll, PAYMENT_WINDOW_BUDGET_MS } from "../upstream-deadline.js";

const OPENAI_KEY = () => (process.env.OPENAI_API_KEY || "").trim();
const OPENROUTER_KEY = () => (process.env.OPENROUTER_API_KEY || "").trim();
const OPENROUTER_STT_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
export const DIARIZE_MODEL = "elevenlabs/scribe-v2";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Max audio file size in bytes (25 MB — OpenAI's limit).
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Per-audio-minute upstream rate for the model each tier sends, from the
 *  private table (src/upstream-costs.js, never committed). The margin test
 *  derives the cap bound from it: maxMinutes x rate <= STT_MARGIN x price. A
 *  model missing there fails that test rather than being assumed free. */
export function upstreamUsdPerMinute(model) { return upstreamCosts().sttPerMinute[model] ?? null; }
/** Worst-case upstream spend may not exceed this share of the tier price - the
 *  same bound the LLM gateway's margin clamp holds. */
export const STT_MARGIN = 0.7;
// The thirty-minute tier (DECIDED 2026-11-15; built behind TRANSCRIBE_LONG,
// off by default). Its price is the margin rule's: the cent at or above
// 30 x the dearer model's per-minute rate / STT_MARGIN (scripts/test-stt-cap.js
// pins it to the rule). Measured 2026-11-18 on a local boot, thirty-minute
// files: a 96 kbps mp3 is 21.6 MB (25 MB holds thirty minutes at up to about
// 110 kbps; 128 kbps does not fit and is refused at the fetch); measuring one
// took 0.4 to 1.5 s and measuring with the cut 6 to 7 s; that cut as 16 kHz
// mono FLAC was 65 MB on a noisy file, past the upstream's 25 MB upload limit,
// so this tier's cut is Opus in Ogg (6.5 MB). The upstream cap (140 s per
// path, both attempts) plus the fetch (at most 25 s with its lookup) and the
// decode (at most 60 s) fit the route's run budget (EVM_RUN_SECONDS, 230 s),
// which the payment window covers; past the CDN's 90 s answer window the call
// runs as a job (Prefer: respond-async, src/slow-routes.js). The upstream's
// time on a thirty-minute file is NOT measured here (no paid call was made):
// one supervised paid run measures it before the switch goes on.
export const STT_TIERS = Object.freeze({
  transcribe:       Object.freeze({ model: "gpt-transcribe", diarizeModel: DIARIZE_MODEL, maxMinutes: 4, priceUsd: 0.03 }),
  "transcribe-pro": Object.freeze({ model: "gpt-transcribe", diarizeModel: DIARIZE_MODEL, maxMinutes: 10, priceUsd: 0.10 }),
  "transcribe-long": Object.freeze({ model: "gpt-transcribe", diarizeModel: DIARIZE_MODEL, maxMinutes: 30, priceUsd: 0.20, codec: "opus", upstreamCapMs: Object.freeze({ default: 140_000, diarize: 140_000 }) }),
});
/** The thirty-minute tier is listed and served only with TRANSCRIBE_LONG=on. */
export function sttLongEnabled(env = process.env) { return String(env.TRANSCRIBE_LONG || "").trim().toLowerCase() === "on"; }
/** The route's run budget, seconds (src/evm-validity.js EVM_RUN_SECONDS reads it). */
export const TRANSCRIBE_LONG_RUN_SECONDS = 230;
const TIERS = STT_TIERS;

/** The transcription models a buyer can name on a tier beside its own
 *  (src/speech-additions.js): each is served and listed only while its
 *  private per-minute row is present and the tier's cap on it stays inside the
 *  margin bound of the tier's price. Read at call time. */
export function sttAdditions(tierSlug) {
  const t = TIERS[tierSlug];
  return t ? admittedSttAdditions({ priceUsd: t.priceUsd, maxMinutes: t.maxMinutes }) : [];
}
/** The named model a request asks for, or null for the tier's own. A name
 *  this tier does not serve is a 400 before any fetch or spend, and so is a
 *  name beside diarize (speaker labels come from one model). */
export function sttModelOf(input, tierSlug, req = null, diarize = false) {
  const raw = input?.model;
  if (raw === undefined || raw === null || raw === "") return null;
  const name = String(raw).trim().toLowerCase();
  const tier = TIERS[tierSlug];
  if (name === tier.model || name === `openai/${tier.model}`) return null;
  const served = sttAdditions(tierSlug);
  const hit = served.find((m) => m.id === name || m.aliases.includes(name));
  if (!hit) {
    throw bad(`"model" ${served.length ? `must be one of: ${[tier.model, ...served.map((m) => m.id)].join(", ")}` : `is not a choice on this route, which serves ${tier.model}`} (or omit it).${notChargedOn(req)}`);
  }
  if (diarize) throw bad(`"model" and diarize:true cannot be combined: speaker labels come from the ${tier.diarizeModel.split("/").pop()} model. Send one or the other.${notChargedOn(req)}`);
  return hit.id;
}
/** The `model` input property of a tier's schema: present only while the tier serves a named model. */
export function sttModelProperty(tierSlug) {
  const served = sttAdditions(tierSlug);
  if (!served.length) return {};
  return { model: { type: "string", description: `Optional: a model to transcribe with in place of ${TIERS[tierSlug].model}, one of ${served.map((m) => m.id).join(", ")} (model-backed; same price and cap; not with diarize). The answer names the model that served it.` } };
}

function validateInput(input, req = null, tierSlug = null) {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!url) throw bad('"url" is required - a URL pointing to an audio file (mp3, wav, m4a, etc.)');
  if (!/^https?:\/\//i.test(url)) throw bad('"url" must be an HTTP(S) URL');

  const language = typeof input.language === "string" ? input.language.trim().toLowerCase() : undefined;
  refuseUnservedFields(input, req);
  const diarize = diarizeFlag(input.diarize);
  return { url, language, diarize, model: tierSlug ? sttModelOf(input, tierSlug, req, diarize) : null };
}

/** `keyterms` and `entities` are not honored by the models this kit sends
 *  (see the header), so a request that sets one is a 400, never a transcript
 *  that silently ignored it. An empty list or `entities: false` asks for
 *  nothing and passes. Multipart spellings: keyterms, keyterms[], entities. */
export function refuseUnservedFields(input, req = null) {
  const kt = input?.keyterms ?? input?.["keyterms[]"];
  if (kt !== undefined && kt !== null && kt !== "" && !(Array.isArray(kt) && kt.length === 0)) {
    throw bad(`"keyterms" is not supported by the transcription models this route serves; remove it.${notChargedOn(req)}`);
  }
  const ent = input?.entities;
  if (ent !== undefined && ent !== null && ent !== "" && ent !== false && ent !== "false") {
    throw bad(`"entities" (entity detection) is not supported by the transcription models this route serves; remove it.${notChargedOn(req)}`);
  }
}

/** `diarize` as JSON true or the multipart string "true". Anything else that
 *  is set is a 400, so a typo never silently drops the speaker labels. */
function diarizeFlag(v) {
  if (v === undefined || v === null || v === "" || v === false || v === "false") return false;
  if (v === true || v === "true") return true;
  throw bad('"diarize" must be true or false');
}

function guessFilename(url, contentType) {
  // Try to get extension from URL path
  const path = new URL(url).pathname;
  const ext = path.split(".").pop()?.toLowerCase();
  const audioExts = new Set(["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"]);
  if (ext && audioExts.has(ext)) return `audio.${ext}`;

  // Fall back to content-type
  const ct = (contentType || "").split(";")[0].trim();
  const ctMap = {
    "audio/mpeg": "audio.mp3", "audio/mp3": "audio.mp3",
    "audio/mp4": "audio.mp4", "audio/m4a": "audio.m4a",
    "audio/wav": "audio.wav", "audio/x-wav": "audio.wav",
    "audio/ogg": "audio.ogg", "audio/flac": "audio.flac",
    "audio/webm": "audio.webm",
  };
  return ctMap[ct] || "audio.mp3";
}

async function fetchAudio(url) {
  const { buffer: buf, contentType } = await safeFetch(url, { binary: true, maxBytes: MAX_AUDIO_BYTES });
  if (buf.length === 0) throw bad("Audio URL returned empty response", 422);

  const filename = guessFilename(url, contentType);
  return { buf, filename };
}

/** What the container says about itself, read locally (no upstream call):
 *  the duration its headers declare, whether its codec is lossy, whether it
 *  carries a video track, its channel count, its sample rate, and the bytes of embedded
 *  pictures. Null when the container cannot be read. */
async function probeContainer(buf, filename) {
  try {
    const { parseBuffer } = await loadMusicMetadata();
    const meta = await parseBuffer(buf, { path: filename }, { duration: true });
    const d = meta?.format?.duration;
    if (!(Number.isFinite(d) && d > 0)) return null;
    let pictureBytes = 0;
    for (const pic of meta?.common?.picture || []) pictureBytes += pic?.data?.length || 0;
    const channels = Number(meta?.format?.numberOfChannels);
    const sampleRate = Number(meta?.format?.sampleRate);
    // Audio tracks the container lists (TrackType audio is 2): a file with
    // more than one is converted to the first, the one that was measured.
    const tracks = Array.isArray(meta?.format?.trackInfo) ? meta.format.trackInfo : [];
    const audioTracks = tracks.filter((t) => t && (t.type === 2 || t.audio)).length;
    return { audioTracks, durationSec: d, lossy: meta?.format?.lossless === false, hasVideo: meta?.format?.hasVideo, channels: Number.isInteger(channels) ? channels : null, sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : null, pictureBytes };
  } catch {
    return null;
  }
}

/** Audio duration in seconds as the container headers declare it, or null
 *  when it cannot be determined. Pure local parse: no upstream call, no cost.
 *  A declared duration is the file's own claim: assertWithinDurationCap
 *  measures the audio as well. */
export async function probeDurationSeconds(buf, filename) {
  return (await probeContainer(buf, filename))?.durationSec ?? null;
}

// The most bits a second of lossy audio holds at a sample rate of 48 kHz or
// less in one or two channels (free-format MPEG audio tops out here; AAC,
// Opus and Vorbis sit below it there). Vorbis at 192 kHz goes past it, so the
// floor is read only up to 48 kHz (byteFloorApplies). Bytes divided by this
// is a duration such audio cannot be under.
const LOSSY_MAX_BITS_PER_SECOND = 640_000;
const NON_AUDIO_ALLOWANCE_BYTES = 256 * 1024;
/** The shortest a lossy file of this size can play, in seconds. Pure; exported for tests. */
export function byteFloorSeconds(bytes, pictureBytes = 0) {
  const audioBytes = Math.max(0, bytes - pictureBytes - NON_AUDIO_ALLOWANCE_BYTES);
  return (audioBytes * 8) / LOSSY_MAX_BITS_PER_SECOND;
}

/** Whether the byte floor bounds this container: lossy audio the parser read
 *  as holding no video track, in one or two channels, at a reported sample
 *  rate of 48 kHz or less. A video track's bytes are not audio, and more
 *  channels or a higher sample rate can carry more bits a second than the
 *  floor's rate, so any of them would make the floor longer than the audio
 *  plays. Those files, and a file whose sample rate is not reported, keep
 *  their declared length when unmeasured. Pure; exported for tests. */
export function byteFloorApplies(container) {
  return !!container && container.lossy === true && container.hasVideo === false && (container.channels === 1 || container.channels === 2)
    && Number.isFinite(container.sampleRate) && container.sampleRate > 0 && container.sampleRate <= 48000;
}

// The longest a PCM WAV can play, from its byte count alone: every sample
// frame takes channels x bytes-per-sample bytes, so a header of 8 kHz, 8-bit,
// mono or more reads at least PCM_MIN_BYTES_PER_SECOND (64 kbps) and the whole
// file cannot play longer than its bytes over that rate. Only uncompressed
// codecs qualify (PCM, float, A-law, mu-law, or the extensible header naming
// one), in a file with one fmt chunk, ahead of the data, whose fields agree.
// A compressed codec (ADPCM; MP3, AAC, Opus, Vorbis, FLAC) has no such floor:
// it can hold a second of silence in a few bytes, so its bytes bound nothing.
const PCM_MIN_BYTES_PER_SECOND = 8000;
const PCM_TAGS = new Set([1, 3, 6, 7]);
const WAV_CHUNK_WALK_MAX = 64;
/** Seconds a PCM WAV of this size cannot play past, or null when the file is
 *  not one whose bytes bound its length. Pure; exported for tests. */
export function pcmWavMaxSeconds(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return null;
  if (buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") return null;
  let off = 12, fmt = -1, fmtSize = 0, fmts = 0, data = false;
  for (let i = 0; off + 8 <= buf.length; i++) {
    if (i >= WAV_CHUNK_WALK_MAX) return null;
    const id = buf.toString("latin1", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      if (data || ++fmts > 1 || size < 16 || off + 8 + size > buf.length) return null;
      fmt = off + 8; fmtSize = size;
    } else if (id === "data") data = true;
    off += 8 + size + (size & 1);
  }
  if (fmts !== 1 || !data) return null;
  let tag = buf.readUInt16LE(fmt);
  const ch = buf.readUInt16LE(fmt + 2), rate = buf.readUInt32LE(fmt + 4), byteRate = buf.readUInt32LE(fmt + 8);
  const align = buf.readUInt16LE(fmt + 12), bits = buf.readUInt16LE(fmt + 14);
  if (tag === 0xfffe) { if (fmtSize < 40) return null; tag = buf.readUInt16LE(fmt + 24); }
  if (!PCM_TAGS.has(tag) || ch < 1 || bits < 8 || bits % 8 !== 0 || rate < 8000) return null;
  if (align !== ch * (bits / 8) || byteRate !== rate * align) return null;
  return buf.length / PCM_MIN_BYTES_PER_SECOND;
}

let measureImpl = measureAudio;
/** Test seam: replace the decode measurement (null restores it). The stand-in
 *  answers seconds (a number, or null when unmeasured) or measureAudio's own
 *  shape ({ seconds } | { undecodable } | { unavailable }). */
export function __setMeasureForTest(fn) { measureImpl = fn || measureAudio; }
let transcodeImpl = transcodeSpeech;
/** Test seam: replace the cut-and-convert run (null restores it). Same answer
 *  shape as transcodeSpeech: { audio, seconds } | { undecodable } | { unavailable }. */
export function __setTranscodeForTest(fn) { transcodeImpl = fn || transcodeSpeech; }
let unmeasured = 0;
/** Files whose audio could not be measured by decoding since boot (the byte floor bounded the ones it applies to). */
export const sttUnmeasuredSinceBoot = () => unmeasured;

/** Containers sent upstream as they arrived: the ones on the speech upstream's
 *  documented input list (flac, mp3, mp4/m4a, ogg, wav, webm). Any other
 *  container the decoder reads (ASF/WMA, raw AAC, AMR, CAF, AIFF, AVI) is
 *  converted to FLAC first, so the upstream is never handed a format it does
 *  not list. */
const UPSTREAM_READY = new Set(["flac", "mp3", "mov", "ogg", "wav", "matroska"]);
/** File-name extensions that name each container sent as it came, the first
 *  being the one used when the buyer's name names another (or none): the
 *  upstream then reads the bytes as the container that was measured. */
const NAME_EXTS = { wav: ["wav"], mp3: ["mp3", "mpga", "mpeg"], flac: ["flac"], ogg: ["ogg", "oga", "opus"], matroska: ["webm", "mkv"], mov: ["m4a", "mp4", "mov"] };
/** The upload name for bytes sent as they came: the buyer's own name when its
 *  extension names the measured container, else audio.<that container>. Pure; exported for tests. */
export function upstreamNameFor(filename, format) {
  const exts = NAME_EXTS[format];
  if (!exts) return filename;
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(filename ?? ""));
  return m && exts.includes(m[1].toLowerCase()) ? filename : `audio.${exts[0]}`;
}
/** A cut that wrote at least this close to the cap may have dropped audio past it. */
const CUT_REACHED_SLACK_SEC = 0.25;

function overCapError(durationSec, tierSlug) {
  const tier = TIERS[tierSlug];
  const mins = (durationSec / 60).toFixed(1);
  // The longer tier is named only while it is served (TRANSCRIBE_LONG=on),
  // and only for a recording it takes.
  const pro = TIERS["transcribe-pro"], long = TIERS["transcribe-long"];
  const fits = (t) => durationSec <= t.maxMinutes * 60 + 2;
  let upsell = "";
  if (tierSlug === "transcribe" && fits(pro)) upsell = ` For up to ${pro.maxMinutes} minutes, use /api/transcribe-pro.`;
  else if (tierSlug !== "transcribe-long" && sttLongEnabled() && fits(long)) upsell = ` For up to ${long.maxMinutes} minutes, use /api/transcribe-long (an audio URL).`;
  else if (tierSlug === "transcribe") upsell = ` For up to ${pro.maxMinutes} minutes, use /api/transcribe-pro.`;
  return bad(`Audio is ${mins} minutes - this tier accepts up to ${tier.maxMinutes} minutes.${upsell} Split longer recordings into chunks.`, 422);
}
/** The charge sentence is made on a route call only (finalFailure's rule): a
 *  skill-pack step runs inside a charged answer and prints the step's error. */
function unreadableError(reason, tierSlug, req) {
  return Object.assign(bad(`This file's audio format could not be read: ${reason}, so its length can be neither measured nor trimmed to this tier's ${TIERS[tierSlug].maxMinutes}-minute cap. Send a standard mp3, wav, m4a, ogg, flac, or webm file.${notChargedOn(req)}`, 400), { hint: "format-unreadable" });
}
/** Our decoder could not run (no slot in the time the call's budget leaves
 *  after the upstream's, its deadline, no ffmpeg here):
 *  the length is unbounded, so no upstream call. The charge sentence is made
 *  on a route call only (finalFailure's rule). */
function decoderBusyError(reason, tierSlug, req) {
  return Object.assign(attributed(bad(`This file's length could not be confirmed, and it could not be trimmed to this tier's ${TIERS[tierSlug].maxMinutes}-minute cap just now: ${reason}. This is on our side, not your file.${notChargedOn(req)} Retry in a minute.`, 503), ATTRIBUTION.OURS), { retryAfter: 30 });
}

/** The audio to send upstream, bounded by the tier's duration cap. Throws 422
 *  when the audio exceeds the cap, or when the duration cannot be read at all
 *  (an unreadable container would otherwise be an unbounded upstream bill).
 *  Small tolerance for container rounding.
 *
 *  The length that is capped is the longer of what the headers declare and
 *  what the audio measures: the file is decoded locally (ffmpeg, no upstream
 *  call) and the decoder's own clock is read. A measured file inside the cap
 *  goes byte for byte when its container is on the upstream's list, else as
 *  FLAC (transcodeSpeech, cut at the cap plus the tolerance).
 *
 *  A PCM WAV whose byte count alone bounds it under the cap
 *  (pcmWavMaxSeconds) is sent as it came, with no decode. Every other file
 *  waits for a decoder slot for as long as the call's budget still leaves
 *  the decode and the upstream call their time (decodeDeadlineAt).
 *
 *  Where the measurement gave no length (no free decoder slot in the time
 *  the budget leaves, its deadline, no ffmpeg), the length a file declares is not taken on trust: a
 *  lossy audio-only file in one or two channels at up to 48 kHz whose bytes
 *  alone play past the cap is the 422 (byteFloorApplies), and any other file
 *  is cut at the cap. A cut that wrote less than the cap read the whole file
 *  (that is its measured length, and the file goes as above); one that reached
 *  the cap is what is sent, and the answer says so (trimmedToCapSeconds,
 *  durationUnconfirmed). When the cut cannot run either, a retryable 503 and
 *  no upstream call. A file the decoder cannot read at all (no cut is
 *  possible) is a 400 that names it. Returns { buf, filename, durationSec,
 *  trimmedToCapSeconds?, durationUnconfirmed? }; durationSec is the length the
 *  margin math and the answer use. */
export async function prepareAudioWithinCap(buf, filename, tierSlug, req = null, { diarize = false } = {}) {
  const tier = TIERS[tierSlug];
  const durationUnreadable = () => bad("Could not read the audio duration from the file - send a standard mp3, wav, m4a, ogg, flac, or webm file", 422);
  // The header parser picks its reader from the file name, so bytes under the
  // wrong name (an Ogg file named .m4a or .mp3) can declare nothing. Such a
  // file is still measured by decoding: served only on a measured length, and
  // as the decoded FLAC, since its track count is unknown. Unmeasured, it is
  // the 422 it always was.
  const declared = await probeContainer(buf, filename);
  const headerless = declared === null;
  const container = declared ?? { audioTracks: 0, durationSec: 0, pictureBytes: 0 };
  const capSec = tier.maxMinutes * 60;
  const overCap = (sec) => sec > capSec + 2;
  // A container with more than one audio track declares the longest track's
  // length (Matroska, WebM, Ogg) or the first's (MP4). Only the first track is
  // sent, cut at the cap, so the declared length bounds nothing here: the
  // first track's measured length decides, and its bytes are not the file's.
  const declaredBounds = !(container.audioTracks > 1);
  const withDeclared = (sec) => (declaredBounds ? Math.max(container.durationSec, sec) : sec);
  if (declaredBounds && overCap(container.durationSec)) throw overCapError(container.durationSec, tierSlug);
  const sniffed = inputFormatOf(buf);
  // A container with more than one audio track is sent as its first, the one
  // measured, never as it came (the upstream could read another); so is a
  // file whose header declared nothing.
  const multiTrack = container.audioTracks > 1 || headerless;
  // A converted file goes in the tier's speech encoding (FLAC, or Opus in Ogg
  // for the thirty-minute tier, whose FLAC could pass the upload limit).
  const codec = tier.codec || "flac";
  const asFlac = (t) => ({ buf: t.audio, filename: `audio.${SPEECH_CODECS[codec].ext}` });
  // A PCM WAV whose bytes alone cannot play past the cap goes as it came,
  // without a decode (the measurement pool's state does not matter to it).
  const bound = sniffed === "wav" && !multiTrack ? pcmWavMaxSeconds(buf) : null;
  if (bound !== null && !overCap(bound)) return { buf, filename: upstreamNameFor(filename, "wav"), durationSec: container.durationSec };
  // A busy pool queues inside the call's budget, leaving the upstream its time.
  const deadlineAt = decodeDeadlineAt(req, diarize, tierSlug);
  // The decode pool admits per caller (media-kit.js): this call's caller, or
  // the caller that dispatched it when it runs as a step with no request.
  const who = admissionCallerOf(req);

  let measured = null, undecodable = null, unavailable = null, format = sniffed, cut = null;
  try {
    // A file that will be converted is measured and converted in one decode.
    const m = await measureImpl(buf, !UPSTREAM_READY.has(sniffed) || multiTrack ? { cutSeconds: capSec + 2, deadlineAt, who, codec } : { deadlineAt, who });
    if (m && typeof m === "object") {
      measured = m.seconds ?? null; undecodable = m.undecodable || null; unavailable = m.unavailable || null;
      if (typeof m.format === "string") format = m.format;
      if (m.audio) cut = m.audio;
    } else measured = m;
  } catch { /* unmeasured: below */ }
  // Sent as it came only when the sniffed demuxer read it, the upstream lists
  // its container and it holds one audio track; else as the decoded FLAC.
  const ready = !multiTrack && format === sniffed && UPSTREAM_READY.has(format);
  if (Number.isFinite(measured) && measured > 0) {
    const durationSec = withDeclared(measured);
    if (overCap(durationSec)) throw overCapError(durationSec, tierSlug);
    if (ready) return { buf, filename: upstreamNameFor(filename, format), durationSec };
    if (cut) return { ...asFlac({ audio: cut }), durationSec };
    const t = await transcodeImpl(buf, { maxSeconds: capSec + 2, format, deadlineAt, who, codec });
    if (t?.audio) return { ...asFlac(t), durationSec };
    if (t?.undecodable) throw unreadableError(t.undecodable, tierSlug, req);
    throw decoderBusyError(t?.unavailable || "the conversion did not run", tierSlug, req);
  }
  if (headerless) throw durationUnreadable();
  unmeasured++;
  if (declaredBounds && byteFloorApplies(container) && overCap(byteFloorSeconds(buf.length, container.pictureBytes))) {
    throw overCapError(byteFloorSeconds(buf.length, container.pictureBytes), tierSlug);
  }
  if (undecodable) throw unreadableError(undecodable, tierSlug, req);
  const t = await transcodeImpl(buf, { maxSeconds: capSec, format, deadlineAt, who, codec });
  if (t?.undecodable) throw unreadableError(t.undecodable, tierSlug, req);
  if (!t?.audio || !(Number.isFinite(t.seconds) && t.seconds > 0)) throw decoderBusyError(t?.unavailable || unavailable || "the decoder gave no answer", tierSlug, req);
  if (t.seconds < capSec - CUT_REACHED_SLACK_SEC) {
    // The cut read the whole file: its length is measured after all.
    const durationSec = withDeclared(t.seconds);
    return ready && (!t.format || t.format === sniffed) ? { buf, filename: upstreamNameFor(filename, sniffed), durationSec } : { ...asFlac(t), durationSec };
  }
  return { ...asFlac(t), durationSec: t.seconds, trimmedToCapSeconds: capSec, durationUnconfirmed: true };
}

/** The duration prepareAudioWithinCap bounds, for callers that need only the
 *  number (tests, the margin suite). A serving path sends prepareAudioWithinCap's
 *  `buf`, never the original bytes. */
export async function assertWithinDurationCap(buf, filename, tierSlug) {
  return (await prepareAudioWithinCap(buf, filename, tierSlug)).durationSec;
}

const BILLING_CODES = new Set(["insufficient_quota", "billing_hard_limit_reached", "billing_not_active", "billing_limit_reached"]);
/** Does an upstream refusal mean our own account hit its billing limit? Pure; exported for tests. */
export function isOurBillingLimit(status, bodyText) {
  if (status !== 429 && status !== 400 && status !== 402 && status !== 403) return false;
  let err = null;
  try { err = JSON.parse(String(bodyText || "")).error || null; } catch {}
  const code = String(err?.code || err?.type || "").toLowerCase();
  return BILLING_CODES.has(code) || (status === 402);
}
/** The refusal for our own key (401/403): names our side, keeps the status.
 *  The charge sentence and the retry advice are added by finalFailure. */
export function ourKeyRefused(status) {
  return Object.assign(attributed(bad(`Transcription is unavailable right now: the speech-to-text provider refused this server's key (HTTP ${status}); this is on our side, not your input`, 502), ATTRIBUTION.OURS, KIND.OUR_KEY), { upstreamStatus: status });
}
/** The refusal for our billing limit: names our side, no upstream name. The
 *  charge sentence is added by finalFailure on a route call only. */
export function ourBillingLimit() {
  return Object.assign(bad("Transcription is unavailable right now because this server reached its own spending limit for speech-to-text. This is on our side, not your input.", 503), { noRetry: true, ourBillingLimit: true });
}

// --- one more attempt on a transient upstream failure -----------------------
// Each path keeps the cap it had: the default path 60 s, the diarized path
// 120 s. The cap now bounds BOTH attempts together, counted from the start of
// the first, so a call never runs longer than it could before.
const UPSTREAM_CAP_MS = Object.freeze({ default: 60_000, diarize: 120_000 });
/** The upstream's cap per path (default, diarize), for tests of the decode budget. */
export const STT_UPSTREAM_CAP_MS = UPSTREAM_CAP_MS;
/** The upstream cap of a tier's path: its own where it names one, else the path's. */
export function sttUpstreamCapMs(tierSlug, diarize) {
  const own = TIERS[tierSlug]?.upstreamCapMs;
  return diarize ? (own?.diarize ?? UPSTREAM_CAP_MS.diarize) : (own?.default ?? UPSTREAM_CAP_MS.default);
}

/** The epoch ms by which this call's decode must end so its upstream call
 *  (the path's whole cap, both attempts) still fits: the route's budget (the
 *  payment window, src/upstream-deadline.js; a fresh one off a route), the
 *  CDN answer window and the payment authorization, whichever ends first,
 *  less that cap. The decode pool waits for a slot up to it. */
function decodeDeadlineAt(req, diarize, tierSlug = null) {
  const b = currentBudget();
  let left = b ? b.remaining() : handlerBudgetMs(PAYMENT_WINDOW_BUDGET_MS);
  try { const c = cdnSyncLeftMs(req); if (c !== null) left = Math.min(left, c); } catch { /* no bound to read */ }
  try { const p = req && typeof req === "object" && req.headers ? evmCredentialBudgetMs(req) : null; if (p !== null) left = Math.min(left, p); } catch { /* no bound to read */ }
  const upstreamMs = retryKnobs.capMs ?? sttUpstreamCapMs(tierSlug, diarize);
  return Date.now() + left - upstreamMs;
}
const CONNECT_FAILURES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
/** A rate limit is retried only when the upstream names a wait this short. */
export const STT_RETRY_AFTER_MAX_MS = 3_000;
const retryKnobs = { capMs: null, minLeftMs: 20_000, pauseMs: () => 250 + Math.floor(Math.random() * 500), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
/** Test seam: shorten the cap, the floor and the pause. */
export function __setSttRetryForTest(o = {}) { Object.assign(retryKnobs, { capMs: null, minLeftMs: 20_000, pauseMs: () => 250 + Math.floor(Math.random() * 500), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, o); }

/** Marks a failure that may get the second attempt. `unbilled`: the upstream
 *  answered with an error status or was never reached, so it generated
 *  nothing. `maybe-billed`: the connection opened and then failed with no
 *  answer, so a transcript may have been generated and billed. */
const retryable = (err, cls, extra = {}) => Object.assign(err, { sttRetry: cls, ...extra });
const isTimeout = (e) => e?.name === "TimeoutError" || e?.name === "AbortError" || e?.cause?.name === "TimeoutError";
/** Maps a fetch that threw. A daily-ceiling refusal keeps its own 503; a
 *  timeout is final (it spent the whole cap, and may have been billed). */
function transportFailure(e, message, { label = "Transcription upstream", ms = null } = {}) {
  if (e?.hardCap) return e;
  // Our own limit passing is ours: it names the limit, never the upstream as down.
  if (isTimeout(e)) {
    return attributed(bad(`${label} did not answer within our ${ms ? `${secondsOf(ms)} s ` : ""}limit for this transcription`, 504), ATTRIBUTION.OURS, KIND.OUR_DEADLINE);
  }
  const err = isDnsFailure(e)
    ? attributed(bad(`${label} could not be reached: this server's DNS lookup for its host failed`, 504), ATTRIBUTION.OURS, KIND.OUR_EGRESS)
    : attributed(bad(message, 504), ATTRIBUTION.UNKNOWN, KIND.CONNECT_FAILED);
  return retryable(err, CONNECT_FAILURES.has(e?.cause?.code || e?.code) ? "unbilled" : "maybe-billed", { sttCause: "connection" });
}
/** Retry-After in ms from a 429 (seconds form, or the -ms header); null when absent or unreadable. */
function retryAfterMsOf(res) {
  const read = (name, scale) => {
    const raw = String(res.headers?.get?.(name) ?? "").trim();
    const n = Number(raw);
    return raw !== "" && Number.isFinite(n) && n >= 0 ? n * scale : null;
  };
  return read("retry-after-ms", 1) ?? read("retry-after", 1000);
}
/** A 429 that is an ordinary rate limit: retried only on a short named wait. */
function rateLimited(res, message) {
  const err = bad(message, 503);
  const wait = retryAfterMsOf(res);
  return wait !== null && wait <= STT_RETRY_AFTER_MAX_MS ? retryable(err, "unbilled", { sttCause: "HTTP 429", sttWaitMs: wait }) : err;
}

async function callOpenAI(audioBuffer, filename, model, language, probedDuration = null, timeoutMs = UPSTREAM_CAP_MS.default) {
  const key = OPENAI_KEY();
  if (!key) throw bad("OpenAI not configured", 503);

  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), filename);
  form.append("model", model);
  form.append("response_format", "json");
  if (language) form.append("language", language);

  let res;
  try {
    res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw transportFailure(e, `OpenAI request failed: ${e.message}`, { label: "OpenAI", ms: timeoutMs });
  }

  const text = await res.text();
  if (!res.ok) {
    // Our account's spending or billing limit (a 429 or 400 whose code says
    // quota or billing) is this server's own limit, not the buyer's request
    // and not a rate limit worth an immediate retry.
    if (isOurBillingLimit(res.status, text)) throw ourBillingLimit();
    // Our key refused: ours, never the caller's input or the vendor's outage.
    if (res.status === 401 || res.status === 403) throw ourKeyRefused(res.status);
    if (res.status === 429) throw rateLimited(res, "OpenAI rate-limited - retry shortly");
    if (res.status >= 500) throw retryable(bad(`OpenAI upstream error (HTTP ${res.status})`, 502), "unbilled", { sttCause: `HTTP ${res.status}` });
    // Redact the FULL body BEFORE slicing/parsing (a secret straddling the
    // 200-char cut leaves an unredactable prefix); the route binder returns
    // err.message verbatim to buyers and logs it.
    const safe = redactSecrets(text);
    let msg = safe.slice(0, 200);
    try { msg = JSON.parse(safe).error?.message || msg; } catch {}
    // Reaching here means a remaining 4xx - the REQUEST was invalid (bad
    // temperature, unknown language code, oversized input), not the upstream.
    // Surfacing it as 502 taught buyers to retry the identical bad request
    // (observed 2026-07-26: paired retries ~1s apart on temperature:100) and
    // polluted upstream-failure telemetry. A self-explaining 400 teaches the
    // agent to fix the request; settlement is cancelled either way.
    throw bad(`OpenAI rejected the request: ${msg}`, 400);
  }

  let data;
  try { data = JSON.parse(text); } catch { throw bad("OpenAI returned non-JSON", 502); }
  if (typeof data?.text !== "string") throw bad("OpenAI returned no transcript - retry", 502);

  return {
    model,
    provider: "openai",
    text: data.text ?? "",
    // The json response format carries no language: the caller's hint, else a
    // guess from the transcript's words (null when no language clearly leads).
    language: answerLanguage(data.language, language, data.text),
    // OpenAI's json response carries no duration; we measured it locally for
    // the cap, so the promised field is populated (corpus, 2026-09-06).
    duration: data.duration ?? (Number.isFinite(probedDuration) ? Math.round(probedDuration * 100) / 100 : null),
  };
}

/** ElevenLabs Scribe v2 over OpenRouter, asked for speaker labels and word
 *  timestamps. Same answer fields as the default path plus `words` and
 *  `speakers`; a failure is a 4xx/5xx that cancels settlement, never a quiet
 *  fall back to a transcript without the speakers the buyer asked for. */
async function callScribe(audioBuffer, filename, model, language, probedDuration = null, timeoutMs = UPSTREAM_CAP_MS.diarize, { diarize = true } = {}) {
  const key = OPENROUTER_KEY();
  if (!key) throw bad("Speech gateway not configured (OPENROUTER_API_KEY unset)", 503);
  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), filename);
  form.append("model", model);
  // A named model (src/speech-additions.js) is asked for the transcript alone.
  form.append("response_format", diarize ? "verbose_json" : "json");
  if (diarize) {
    form.append("diarize", "true");
    form.append("timestamp_granularities[]", "word");
  }
  if (language) form.append("language", language);
  // Our data policy, set on the request (multipart takes it as a JSON string).
  form.append("provider", JSON.stringify(audioProviderPolicy(model)));
  let res;
  try {
    res = await fetch(OPENROUTER_STT_URL, { method: "POST", headers: { Authorization: `Bearer ${key}`, ...OPENROUTER_ATTRIBUTION }, body: form, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw transportFailure(e, `Transcription upstream request failed: ${String(e?.message || e).slice(0, 120)}`, { ms: timeoutMs });
  }
  const text = await res.text();
  if (!res.ok) {
    const safe = redactSecrets(text);
    let msg = safe.slice(0, 200);
    try { msg = JSON.parse(safe).error?.message || msg; } catch {}
    if (isOurBillingLimit(res.status, text)) throw ourBillingLimit();
    if (res.status === 429) throw rateLimited(res, "Transcription upstream rate-limited - retry shortly");
    if (res.status === 401 || res.status === 403) throw ourKeyRefused(res.status);
    if (res.status >= 500) throw retryable(bad(`Transcription upstream error (HTTP ${res.status})`, 502), "unbilled", { sttCause: `HTTP ${res.status}` });
    throw bad(`Transcription upstream rejected the request: ${msg}`, 400);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw bad("Transcription upstream returned non-JSON", 502); }
  assertUpstreamBody(data);
  // Silent audio is an empty transcript; a body with no transcript field is not an answer.
  if (typeof data.text !== "string") throw bad("Transcription upstream returned no transcript - retry", 502);
  if (!diarize) {
    return {
      model,
      provider: "openrouter",
      text: data.text,
      language: answerLanguage(data.language, language, data.text),
      duration: Number.isFinite(data.duration) ? data.duration : (Number.isFinite(probedDuration) ? Math.round(probedDuration * 100) / 100 : null),
    };
  }
  const words = (Array.isArray(data.words) ? data.words : []).map((w) => ({
    word: String(w.word ?? ""),
    start: Number.isFinite(w.start) ? w.start : null,
    end: Number.isFinite(w.end) ? w.end : null,
    speaker: Number.isInteger(w.speaker) ? w.speaker : null,
  }));
  const speakers = new Set(words.map((w) => w.speaker).filter((n) => n !== null)).size;
  return {
    model,
    provider: "openrouter",
    text: data.text ?? "",
    language: answerLanguage(data.language, language, data.text),
    // Scribe's 0-1 confidence in the detected language; null when not scored.
    language_confidence: Number.isFinite(data.language_confidence) && data.language_confidence >= 0 && data.language_confidence <= 1 ? Math.round(data.language_confidence * 1e4) / 1e4 : null,
    duration: Number.isFinite(data.duration) ? data.duration : (Number.isFinite(probedDuration) ? Math.round(probedDuration * 100) / 100 : null),
    speakers,
    words,
  };
}

/** Transcription bills per audio minute at the served model's private rate.
 *  The minutes are the upstream's own duration when it reports one, else the
 *  local probe that enforced the cap; recorded after every served call into
 *  the same meter and margin event as the /v1 tiers. No rate row, no figure. */
function recordSttSpend(tierSlug, out, probedDuration) {
  try {
    const seconds = Number.isFinite(out?.duration) ? out.duration : Number.isFinite(probedDuration) ? probedDuration : 0;
    const rate = upstreamUsdPerMinute(out?.model);
    const upstreamUsd = rate != null && seconds > 0 ? Math.round((seconds / 60) * rate * 1e6) / 1e6 : null;
    capturePostHogGatewayUsage({ tier: tierSlug, model: out?.model, priceUsd: TIERS[tierSlug]?.priceUsd, upstreamUsd, source: "stt" });
    return upstreamUsd;
  } catch { return null; /* telemetry must never fail a served response */ }
}

/** May a failure that could have been billed get a second attempt? Only when
 *  two billed attempts on this audio still sit inside the margin bound the
 *  duration cap holds for one (STT_MARGIN of the price). No rate row, no. */
export function twoBilledAttemptsWithinMargin(tierSlug, model, durationSec) {
  const rate = upstreamUsdPerMinute(model);
  const price = TIERS[tierSlug]?.priceUsd;
  if (!(rate > 0) || !(price > 0) || !(durationSec > 0)) return false;
  return 2 * (durationSec / 60) * rate <= STT_MARGIN * price + 1e-12;
}

/** Time the second attempt may spend: what is left of the path's cap, of the
 *  CDN answer window and of the buyer's payment authorization, whichever is
 *  shortest. */
function retryLeftMs(startedAt, capMs, req) {
  let left = startedAt + capMs - Date.now();
  try { const c = cdnSyncLeftMs(req); if (c !== null) left = Math.min(left, c); } catch { /* no bound to read */ }
  try { const p = req && typeof req === "object" && req.headers ? evmCredentialBudgetMs(req) : null; if (p !== null) left = Math.min(left, p); } catch { /* no bound to read */ }
  return left;
}

/** The 5xx a buyer gets: what failed, that it was not charged, what to do.
 *  The charge claim is made only on a route call (`req` present): a skill
 *  pack runs this handler as one step of a charged 200 and prints the step's
 *  error, where the claim would be false. On a route call it is true on every
 *  payment but a Tempo transfer sent before the call, and the route binder
 *  adds that exception to this exact sentence (server.js withPushException). */
/** finalFailure, for tests of the charge sentence on and off a route call. */
export function __sttFinalFailureForTest(err, opts) { return finalFailure(err, opts); }
function finalFailure(err, { attempts, diarize, req, named = null }) {
  if (err?.ourBillingLimit && typeof err.message === "string" && !err.message.includes(NOT_CHARGED)) {
    err.message = `${err.message}${notChargedOn(req)} Retry later.`;
    return err;
  }
  if (!err || !(err.statusCode >= 500) || err.hardCap || err.noRetry || typeof err.message !== "string" || err.message.includes(NOT_CHARGED)) return err;
  const tried = attempts > 1 ? ` (${attempts} attempts)` : "";
  // The other path is named only while this server can serve it.
  const other = named
    ? ', or send the call without "model" (the route\'s own model serves it at the same price)'
    : diarize
    ? (OPENAI_KEY() ? ", or send the call without diarize for a transcript without speaker labels (a different model serves it)" : "")
    : (OPENROUTER_KEY() ? ", or send diarize:true (a different model serves that at the same price)" : "");
  const what = err.message.replace(/\s+-\s+retry(?: shortly)?\s*$/i, "").replace(/[.\s]+$/, "");
  err.message = `${what}${tried}.${notChargedOn(req)} Retry in a minute${other}.`;
  return err;
}

/**
 * One upstream attempt, and ONE more on the same model when the first failed
 * in a way that passes on its own. The tier has no second model at its rate,
 * so the second attempt is the same model after a short jittered pause (or
 * the wait a rate limit named).
 *   - retried: an upstream 5xx, a 429 naming a wait of at most
 *     STT_RETRY_AFTER_MAX_MS, a connection that never opened (all unbilled);
 *     a connection that opened and then failed, only when two billed attempts
 *     on this audio would still be inside the margin bound.
 *   - never retried: a 4xx about the request, our key refused, our own billing
 *     limit, the daily ceiling, a timeout (it spent the cap), and a 200 whose
 *     body is not a transcript (the upstream answered, and may have billed).
 *   - bounds: both attempts end inside the path's cap, the CDN answer window
 *     and the payment authorization; with less than the floor left the first
 *     failure is the answer. Each attempt is one outbound fetch, so the egress
 *     meter and the daily ceiling count it; only a served attempt is recorded
 *     as spend, and the price does not change.
 * A served second attempt says so in `agent402_retried`.
 */
async function transcribeWithRetry(buf, filename, tierSlug, language, diarize, probedDuration, req, named = null) {
  const tier = TIERS[tierSlug];
  const model = named || (diarize ? tier.diarizeModel : tier.model);
  // A named model goes over the same wire, and keeps the same cap, as the speaker-label path.
  const wire = diarize || Boolean(named);
  const capMs = retryKnobs.capMs ?? sttUpstreamCapMs(tierSlug, wire);
  const attempt = (timeoutMs) => (wire
    ? callScribe(buf, filename, model, language, probedDuration, timeoutMs, { diarize })
    : callOpenAI(buf, filename, model, language, probedDuration, timeoutMs));
  const startedAt = Date.now();
  let first;
  try { return await attempt(capMs); } catch (e) { first = e; }
  const cls = first?.sttRetry;
  if (!cls || (cls === "maybe-billed" && !twoBilledAttemptsWithinMargin(tierSlug, model, probedDuration))) throw finalFailure(first, { attempts: 1, diarize, req, named });
  const pause = Number.isFinite(first.sttWaitMs) ? first.sttWaitMs : retryKnobs.pauseMs();
  if (retryLeftMs(startedAt, capMs, req) - pause < retryKnobs.minLeftMs) throw finalFailure(first, { attempts: 1, diarize, req, named });
  console.warn(`[stt] ${tierSlug} attempt 1 failed (${first.sttCause}); one more attempt`);
  await retryKnobs.sleep(pause);
  let out;
  try { out = await attempt(Math.max(1, Math.floor(retryLeftMs(startedAt, capMs, req)))); } catch (e) { throw finalFailure(e, { attempts: 2, diarize, req, named }); }
  out.agent402_retried = { attempts: 2, reason: `the first upstream attempt failed (${first.sttCause}); a second attempt on the same model served this transcript` };
  return out;
}

async function transcribeBuffer(buf, filename, tierSlug, language, diarize, probedDuration, req, named = null) {
  const out = await transcribeWithRetry(buf, filename, tierSlug, language, diarize, probedDuration, req, named);
  const upstreamUsd = recordSttSpend(tierSlug, out, probedDuration);
  // The work meter (METERED_MEDIA). A transcript served on a second attempt
  // was billed twice upstream and is not metered: it settles the price.
  if (mediaMeterEnabled() && !out?.agent402_retried) setMeterSentinel(out, upstreamUsd);
  return out;
}

/** Sends what prepareAudioWithinCap bounded (its durationSec is the margin
 *  math's and the answer's duration); a cut file's answer says so. */
async function transcribePrepared(prep, tierSlug, language, diarize, req, named = null) {
  const out = await transcribeBuffer(prep.buf, prep.filename, tierSlug, language, diarize, prep.durationSec, req, named);
  if (prep.trimmedToCapSeconds) Object.assign(out, { trimmedToCapSeconds: prep.trimmedToCapSeconds, durationUnconfirmed: true });
  return out;
}

function makeHandler(tierSlug) {
  return async (input, req) => {
    const { url, language, diarize, model } = validateInput(input, req, tierSlug);
    const { buf, filename } = await fetchAudio(url);
    // A named model's upstream call keeps the speaker-label path's cap, so the decode leaves it that time.
    return transcribePrepared(await prepareAudioWithinCap(buf, filename, tierSlug, req, { diarize: diarize || Boolean(model) }), tierSlug, language, diarize, req, model);
  };
}

/** OpenAI's own transcription wire: multipart/form-data with `file`.
 *
 *  We served /v1/audio/speech, /v1/rerank and /v1/embeddings on OpenAI's paths
 *  while /v1/audio/transcriptions answered 404, so an SDK pointed at this
 *  gateway spoke to three routes and then looked broken on the fourth - the
 *  same "the handler is here, the URL is not" defect the Gemini wire fixed.
 *
 *  It joins the existing handler ONE LAYER IN, at the bytes: everything that
 *  bounds this tool (the duration cap that holds the margin, the model lock,
 *  the upstream call) is downstream of `buf` and is reached unchanged. The
 *  only difference is where the bytes came from - an upload instead of a
 *  fetch - so an uploaded file skips the SSRF-guarded fetch entirely.
 */
export function makeMultipartHandler(tierSlug) {
  return async (_input, req) => {
    const ct = req?.headers?.["content-type"] || "";
    const body = req?.body;
    if (!/^multipart\/form-data/i.test(String(ct)) || !Buffer.isBuffer(body)) {
      throw bad(`This route takes OpenAI's transcription wire: multipart/form-data with a "file" part (and an optional "language"). To transcribe a URL instead, POST JSON {"url":"..."} to ${tierSlug === "transcribe-pro" ? "/api/transcribe-pro" : "/api/transcribe"}.`);
    }
    const { fields, file } = parseMultipartFile(body, ct);
    if (!file) throw bad('multipart body has no "file" part');
    const language = typeof fields.language === "string" && fields.language ? fields.language : undefined;
    const diarize = diarizeFlag(fields.diarize);
    refuseUnservedFields(fields, req);
    return transcribePrepared(await prepareAudioWithinCap(file.buf, file.filename, tierSlug, req, { diarize }), tierSlug, language, diarize, req);
  };
}

const RETRY_NOTE = " A transient upstream failure gets one more attempt inside the same time limit, and an answer served that way says so in agent402_retried.";
const TRIM_NOTE = " A file whose length cannot be confirmed is transcribed up to the cap, and the answer says so (trimmedToCapSeconds, durationUnconfirmed).";
/** Fields an answer carries only when its file was cut at the cap. */
const TRIM_OUTPUT = Object.freeze({
  trimmedToCapSeconds: { type: "number", description: "Present only when the file's length could not be confirmed: the audio was transcribed up to this many seconds (the tier's cap)" },
  durationUnconfirmed: { type: "boolean", description: "Present (true) only with trimmedToCapSeconds: the file's full length was not confirmed" },
});
const SHARED_TAGS = ["stt", "speech-to-text", "transcription", "audio", "whisper", "openai"];

export const STT_TOOLS_BASE = [
  {
    route: "POST /api/transcribe",
    name: "Speech-to-text",
    slug: "transcribe", aliases: ["speech-to-text", "stt", "transcription"],
    category: "ai",
    price: "$0.030",
    description:
      "Transcribe audio to text with the gpt-transcribe model. Provide a URL to an audio file (mp3, wav, m4a, etc.) and get back the transcript. Add diarize:true for speaker labels, word timestamps and a language confidence score (the scribe-v2 model, same price). No API key needed; pay per call via x402. Max 4 minutes of audio, 25 MB file size; /api/transcribe-pro takes the same models to 10 minutes." + TRIM_NOTE + RETRY_NOTE,
    tags: [...SHARED_TAGS, "gpt-transcribe"],
    discovery: {
      bodyType: "json",
      input: { url: "https://agent402.tools/fixtures/sample-speech.wav" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "URL of the audio file to transcribe (mp3, wav, m4a, ogg, flac, webm)" },
          language: { type: "string", description: "Optional ISO-639-1 language code (e.g. 'en', 'es', 'fr') for better accuracy" },
          diarize: { type: "boolean", description: "true: transcribe with the scribe-v2 model and add speaker labels and word timestamps (`words`, `speakers`) and `language_confidence` (0 to 1, the model's confidence in the detected language). Same price and cap. Default false" },
          ...sttModelProperty("transcribe"),
        },
        required: ["url"],
      },
      output: {
        example: {
          model: "gpt-transcribe",
          provider: "openai",
          text: "Hi, this is the Agent402 sample recording. Can you hear me clearly? Yes, loud and clear. There are two of us on this clip, so the transcript can tell us apart.",
          language: "en",
          duration: 12.6,
        },
        optional: TRIM_OUTPUT,
      },
    },
    handler: makeHandler("transcribe"),
  },
  {
    route: "POST /api/transcribe-pro",
    name: "Speech-to-text (Pro)",
    slug: "transcribe-pro",
    category: "ai",
    price: "$0.100",
    description:
      `Pro tier for longer recordings (model-backed, gpt-transcribe, the same model as the standard tier): transcribes an audio file at a URL. Max 10 minutes and 25 MB, ${sttLongEnabled() ? "and /api/transcribe-long takes a URL to 30 minutes" : "the longer cap of the transcribe routes"}. Returns the transcript text, language and duration; diarize:true adds speaker labels, word timestamps and a language confidence score. No API key needed; pay per call via x402.` + TRIM_NOTE + RETRY_NOTE,
    tags: [...SHARED_TAGS, "gpt-transcribe", "pro"],
    discovery: {
      bodyType: "json",
      input: { url: "https://agent402.tools/fixtures/sample-speech.wav" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "URL of the audio file to transcribe (mp3, wav, m4a, ogg, flac, webm)" },
          language: { type: "string", description: "Optional ISO-639-1 language code (e.g. 'en', 'es', 'fr') for better accuracy" },
          diarize: { type: "boolean", description: "true: transcribe with the scribe-v2 model and add speaker labels and word timestamps (`words`, `speakers`) and `language_confidence` (0 to 1, the model's confidence in the detected language). Same price and cap. Default false" },
          ...sttModelProperty("transcribe-pro"),
        },
        required: ["url"],
      },
      output: {
        example: {
          model: "gpt-transcribe",
          provider: "openai",
          text: "Hi, this is the Agent402 sample recording. Can you hear me clearly? Yes, loud and clear. There are two of us on this clip, so the transcript can tell us apart.",
          language: "en",
          duration: 12.6,
        },
        optional: TRIM_OUTPUT,
      },
    },
    handler: makeHandler("transcribe-pro"),
  },
  {
    route: "POST /v1/audio/transcriptions",
    name: "Transcribe (OpenAI-compatible)",
    slug: "v1-audio-transcriptions",
    category: "ai",
    price: "$0.030",
    description:
      "OpenAI's own transcription wire: POST multipart/form-data with a `file` part and get the transcript back. Point any Whisper-shaped SDK at this gateway and pay per call with USDC, no account and no API key. Same model and same four-minute cap as /api/transcribe, which takes a URL instead of an upload; /v1/pro/audio/transcriptions takes it to ten minutes." + RETRY_NOTE,
    tags: [...SHARED_TAGS],
    discovery: {
      bodyType: "form-data",
      input: { file: "<audio bytes, multipart part named file>", language: "en" },
      inputSchema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary", description: "The audio file, as a multipart part named `file`" }, language: { type: "string", description: "Optional ISO-639-1 hint" }, diarize: { type: "string", description: "\"true\" for speaker labels, word timestamps and language_confidence (the scribe-v2 model)" } } },
      output: { example: { text: "Example transcript.", duration: 3.2, model: "gpt-transcribe" }, optional: TRIM_OUTPUT },
    },
    handler: makeMultipartHandler("transcribe"),
  },
  {
    route: "POST /v1/pro/audio/transcriptions",
    name: "Speech-to-text, long audio (OpenAI transcription wire)",
    slug: "v1-audio-transcriptions-pro",
    category: "ai",
    price: "$0.100",
    description:
      "OpenAI's transcription wire on the ten-minute tier: POST multipart/form-data with a `file` part. Same model as /v1/audio/transcriptions with a longer cap, for a recording a four-minute route refuses." + RETRY_NOTE,
    tags: [...SHARED_TAGS],
    discovery: {
      bodyType: "form-data",
      input: { file: "<audio bytes, multipart part named file>" },
      inputSchema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary", description: "The audio file, as a multipart part named `file`" }, language: { type: "string", description: "Optional ISO-639-1 hint" }, diarize: { type: "string", description: "\"true\" for speaker labels, word timestamps and language_confidence (the scribe-v2 model)" } } },
      output: { example: { text: "Example transcript.", duration: 420.5, model: "gpt-transcribe" }, optional: TRIM_OUTPUT },
    },
    handler: makeMultipartHandler("transcribe-pro"),
  },
];
/** The thirty-minute tier: an audio URL only (a job replays a JSON body, and
 *  past the CDN's answer window this route runs as one). Listed only with
 *  TRANSCRIBE_LONG=on. */
export const STT_LONG_TOOL = {
  route: "POST /api/transcribe-long",
  name: "Speech-to-text (long recordings)",
  slug: "transcribe-long",
  category: "ai",
  price: "$0.200",
  description:
    "Long-recording tier (model-backed, gpt-transcribe, the same model as the other transcribe tiers): transcribes an audio file at a URL. Max 30 minutes and 25 MB (thirty minutes fit at up to about 110 kbps; a file that needs converting is sent as 16 kHz mono Opus). Returns the transcript text, language and duration; diarize:true adds speaker labels, word timestamps and a language confidence score (the scribe-v2 model, same price and cap). No API key needed; pay per call via x402." + TRIM_NOTE + RETRY_NOTE,
  tags: [...SHARED_TAGS, "gpt-transcribe", "long-audio"],
  discovery: {
    bodyType: "json",
    input: { url: "https://agent402.tools/fixtures/sample-speech.wav" },
    inputSchema: {
      properties: {
        url: { type: "string", description: "URL of the audio file to transcribe (mp3, wav, m4a, ogg, flac, webm), up to 30 minutes and 25 MB" },
        language: { type: "string", description: "Optional ISO-639-1 language code (e.g. 'en', 'es', 'fr') for better accuracy" },
        diarize: { type: "boolean", description: "true: transcribe with the scribe-v2 model and add speaker labels and word timestamps (`words`, `speakers`) and `language_confidence` (0 to 1, the model's confidence in the detected language). Same price and cap. Default false" },
        ...sttModelProperty("transcribe-long"),
      },
      required: ["url"],
    },
    output: {
      example: {
        model: "gpt-transcribe",
        provider: "openai",
        text: "Hi, this is the Agent402 sample recording. Can you hear me clearly? Yes, loud and clear. There are two of us on this clip, so the transcript can tell us apart.",
        language: "en",
        duration: 12.6,
      },
      optional: TRIM_OUTPUT,
    },
  },
  handler: makeHandler("transcribe-long"),
};
export const STT_TOOLS = [...STT_TOOLS_BASE, ...(sttLongEnabled() ? [STT_LONG_TOOL] : [])];
// Each call runs under its route's payment-window budget: the decode pool's
// wait reads it (decodeDeadlineAt), so a queued decode still leaves the
// upstream call its time.
underBudgetAll([...STT_TOOLS_BASE, STT_LONG_TOOL], PAYMENT_WINDOW_BUDGET_MS);
