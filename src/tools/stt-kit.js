// Speech-to-text kit — two tiers of x402-paywalled transcription via OpenAI.
// Accepts an audio URL, fetches it, sends to OpenAI, returns transcript.
// Env-gated: missing OPENAI_API_KEY → 503.
//
// Tiers:
//   transcribe      $0.03  - gpt-transcribe  (4 min max)
//   transcribe-pro  $0.10  - gpt-transcribe  (10 min max)
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

// ONE MORE ATTEMPT (2026-11-10): an upstream failure that passes on its own (a
// 5xx, a rate limit with a short Retry-After, a connection that failed) used
// to be the buyer's 502. It now gets one more attempt on the same model; see
// transcribeWithRetry for the bounds.

import { parseMultipartFile } from "../multipart.js";
import { loadMusicMetadata } from "./lazy-deps.js";
import { safeFetch } from "./fetch-guard.js";
import { measureAudio, transcodeSpeech, inputFormatOf } from "./media-kit.js";
import { redactSecrets } from "./redact.js";
import { upstreamCosts } from "../upstream-costs.js";
import { OPENROUTER_ATTRIBUTION } from "../openrouter-attribution.js";
import { assertUpstreamBody } from "./llm-gateway-kit.js";
import { capturePostHogGatewayUsage } from "../posthog.js";
import { audioProviderPolicy } from "../openrouter-audio-policy.js";
import { cdnSyncLeftMs } from "../cdn-sync-window.js";
import { evmCredentialBudgetMs } from "../evm-validity.js";
import { attributed, ATTRIBUTION, KIND, secondsOf, isDnsFailure } from "../upstream-deadline.js";

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
export const STT_TIERS = Object.freeze({
  transcribe:       Object.freeze({ model: "gpt-transcribe", diarizeModel: DIARIZE_MODEL, maxMinutes: 4, priceUsd: 0.03 }),
  "transcribe-pro": Object.freeze({ model: "gpt-transcribe", diarizeModel: DIARIZE_MODEL, maxMinutes: 10, priceUsd: 0.10 }),
});
const TIERS = STT_TIERS;

function validateInput(input) {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!url) throw bad('"url" is required - a URL pointing to an audio file (mp3, wav, m4a, etc.)');
  if (!/^https?:\/\//i.test(url)) throw bad('"url" must be an HTTP(S) URL');

  const language = typeof input.language === "string" ? input.language.trim().toLowerCase() : undefined;
  refuseUnservedFields(input);
  return { url, language, diarize: diarizeFlag(input.diarize) };
}

/** `keyterms` and `entities` are not honored by the models this kit sends
 *  (see the header), so a request that sets one is a 400, never a transcript
 *  that silently ignored it. An empty list or `entities: false` asks for
 *  nothing and passes. Multipart spellings: keyterms, keyterms[], entities. */
export function refuseUnservedFields(input) {
  const kt = input?.keyterms ?? input?.["keyterms[]"];
  if (kt !== undefined && kt !== null && kt !== "" && !(Array.isArray(kt) && kt.length === 0)) {
    throw bad('"keyterms" is not supported by the transcription models this route serves; remove it (nothing was charged)');
  }
  const ent = input?.entities;
  if (ent !== undefined && ent !== null && ent !== "" && ent !== false && ent !== "false") {
    throw bad('"entities" (entity detection) is not supported by the transcription models this route serves; remove it (nothing was charged)');
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
/** A cut that wrote at least this close to the cap may have dropped audio past it. */
const CUT_REACHED_SLACK_SEC = 0.25;

function overCapError(durationSec, tierSlug) {
  const tier = TIERS[tierSlug];
  const mins = (durationSec / 60).toFixed(1);
  const upsell = tierSlug === "transcribe" ? " For up to 10 minutes, use /api/transcribe-pro." : "";
  return bad(`Audio is ${mins} minutes - this tier accepts up to ${tier.maxMinutes} minutes.${upsell} Split longer recordings into chunks.`, 422);
}
/** The charge sentence is made on a route call only (finalFailure's rule): a
 *  skill-pack step runs inside a charged answer and prints the step's error. */
function unreadableError(reason, tierSlug, req) {
  const routeCall = !!(req && typeof req === "object" && req.headers);
  return Object.assign(bad(`This file's audio format could not be read: ${reason}, so its length can be neither measured nor trimmed to this tier's ${TIERS[tierSlug].maxMinutes}-minute cap. Send a standard mp3, wav, m4a, ogg, flac, or webm file.${routeCall ? " You were not charged." : ""}`, 400), { hint: "format-unreadable" });
}
/** Our decoder could not run (no slot in time, its deadline, no ffmpeg here):
 *  the length is unbounded, so no upstream call. The charge sentence is made
 *  on a route call only (finalFailure's rule). */
function decoderBusyError(reason, tierSlug, req) {
  const routeCall = !!(req && typeof req === "object" && req.headers);
  return Object.assign(attributed(bad(`This file's length could not be confirmed, and it could not be trimmed to this tier's ${TIERS[tierSlug].maxMinutes}-minute cap just now: ${reason}. This is on our side, not your file.${routeCall ? ` ${NOT_CHARGED}` : ""} Retry in a minute.`, 503), ATTRIBUTION.OURS), { retryAfter: 30 });
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
 *  Where the measurement gave no length (no free decoder slot in time, its
 *  deadline, no ffmpeg), the length a file declares is not taken on trust: a
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
export async function prepareAudioWithinCap(buf, filename, tierSlug, req = null) {
  const tier = TIERS[tierSlug];
  const container = await probeContainer(buf, filename);
  if (container === null) {
    throw bad("Could not read the audio duration from the file - send a standard mp3, wav, m4a, ogg, flac, or webm file", 422);
  }
  const capSec = tier.maxMinutes * 60;
  const overCap = (sec) => sec > capSec + 2;
  if (overCap(container.durationSec)) throw overCapError(container.durationSec, tierSlug);
  const sniffed = inputFormatOf(buf);
  // A container with more than one audio track is sent as its first, the one
  // measured, never as it came (the upstream could read another).
  const multiTrack = container.audioTracks > 1;
  const asFlac = (t) => ({ buf: t.audio, filename: "audio.flac" });

  let measured = null, undecodable = null, unavailable = null, format = sniffed, cut = null;
  try {
    // A file that will be converted is measured and converted in one decode.
    const m = await measureImpl(buf, !UPSTREAM_READY.has(sniffed) || multiTrack ? { cutSeconds: capSec + 2 } : {});
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
    const durationSec = Math.max(container.durationSec, measured);
    if (overCap(durationSec)) throw overCapError(durationSec, tierSlug);
    if (ready) return { buf, filename, durationSec };
    if (cut) return { ...asFlac({ audio: cut }), durationSec };
    const t = await transcodeImpl(buf, { maxSeconds: capSec + 2, format });
    if (t?.audio) return { ...asFlac(t), durationSec };
    if (t?.undecodable) throw unreadableError(t.undecodable, tierSlug, req);
    throw decoderBusyError(t?.unavailable || "the conversion did not run", tierSlug, req);
  }
  unmeasured++;
  if (byteFloorApplies(container) && overCap(byteFloorSeconds(buf.length, container.pictureBytes))) {
    throw overCapError(byteFloorSeconds(buf.length, container.pictureBytes), tierSlug);
  }
  if (undecodable) throw unreadableError(undecodable, tierSlug, req);
  const t = await transcodeImpl(buf, { maxSeconds: capSec, format });
  if (t?.undecodable) throw unreadableError(t.undecodable, tierSlug, req);
  if (!t?.audio || !(Number.isFinite(t.seconds) && t.seconds > 0)) throw decoderBusyError(t?.unavailable || unavailable || "the decoder gave no answer", tierSlug, req);
  if (t.seconds < capSec - CUT_REACHED_SLACK_SEC) {
    // The cut read the whole file: its length is measured after all.
    const durationSec = Math.max(container.durationSec, t.seconds);
    return ready && (!t.format || t.format === sniffed) ? { buf, filename, durationSec } : { ...asFlac(t), durationSec };
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
/** The refusal for our billing limit: names our side, no upstream name. */
export function ourBillingLimit() {
  return Object.assign(bad("Transcription is unavailable right now because this server reached its own spending limit for speech-to-text. This is on our side, not your input; you were not charged. Retry later.", 503), { noRetry: true });
}

// --- one more attempt on a transient upstream failure -----------------------
// Each path keeps the cap it had: the default path 60 s, the diarized path
// 120 s. The cap now bounds BOTH attempts together, counted from the start of
// the first, so a call never runs longer than it could before.
const UPSTREAM_CAP_MS = Object.freeze({ default: 60_000, diarize: 120_000 });
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
    language: data.language ?? null,
    // OpenAI's json response carries no duration; we measured it locally for
    // the cap, so the promised field is populated (corpus, 2026-09-06).
    duration: data.duration ?? (Number.isFinite(probedDuration) ? Math.round(probedDuration * 100) / 100 : null),
  };
}

/** ElevenLabs Scribe v2 over OpenRouter, asked for speaker labels and word
 *  timestamps. Same answer fields as the default path plus `words` and
 *  `speakers`; a failure is a 4xx/5xx that cancels settlement, never a quiet
 *  fall back to a transcript without the speakers the buyer asked for. */
async function callScribe(audioBuffer, filename, model, language, probedDuration = null, timeoutMs = UPSTREAM_CAP_MS.diarize) {
  const key = OPENROUTER_KEY();
  if (!key) throw bad("Speech gateway not configured (OPENROUTER_API_KEY unset)", 503);
  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), filename);
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("diarize", "true");
  form.append("timestamp_granularities[]", "word");
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
    language: data.language ?? null,
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
  } catch { /* telemetry must never fail a served response */ }
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

const NOT_CHARGED = "Nothing was charged.";
/** The 5xx a buyer gets: what failed, that it was not charged, what to do.
 *  The charge claim is made only on a route call (`req` present): a skill
 *  pack runs this handler as one step of a charged 200 and prints the step's
 *  error, where the claim would be false. On a route call it is true on every
 *  payment but a Tempo transfer sent before the call, and the route binder
 *  adds that exception to this exact sentence (server.js withPushException). */
function finalFailure(err, { attempts, diarize, req }) {
  if (!err || !(err.statusCode >= 500) || err.hardCap || err.noRetry || typeof err.message !== "string" || err.message.includes(NOT_CHARGED)) return err;
  const tried = attempts > 1 ? ` (${attempts} attempts)` : "";
  // The other path is named only while this server can serve it.
  const other = diarize
    ? (OPENAI_KEY() ? ", or send the call without diarize for a transcript without speaker labels (a different model serves it)" : "")
    : (OPENROUTER_KEY() ? ", or send diarize:true (a different model serves that at the same price)" : "");
  const what = err.message.replace(/\s+-\s+retry(?: shortly)?\s*$/i, "").replace(/[.\s]+$/, "");
  const routeCall = !!(req && typeof req === "object" && req.headers);
  err.message = `${what}${tried}.${routeCall ? ` ${NOT_CHARGED}` : ""} Retry in a minute${other}.`;
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
async function transcribeWithRetry(buf, filename, tierSlug, language, diarize, probedDuration, req) {
  const tier = TIERS[tierSlug];
  const model = diarize ? tier.diarizeModel : tier.model;
  const capMs = retryKnobs.capMs ?? (diarize ? UPSTREAM_CAP_MS.diarize : UPSTREAM_CAP_MS.default);
  const attempt = (timeoutMs) => (diarize
    ? callScribe(buf, filename, model, language, probedDuration, timeoutMs)
    : callOpenAI(buf, filename, model, language, probedDuration, timeoutMs));
  const startedAt = Date.now();
  let first;
  try { return await attempt(capMs); } catch (e) { first = e; }
  const cls = first?.sttRetry;
  if (!cls || (cls === "maybe-billed" && !twoBilledAttemptsWithinMargin(tierSlug, model, probedDuration))) throw finalFailure(first, { attempts: 1, diarize, req });
  const pause = Number.isFinite(first.sttWaitMs) ? first.sttWaitMs : retryKnobs.pauseMs();
  if (retryLeftMs(startedAt, capMs, req) - pause < retryKnobs.minLeftMs) throw finalFailure(first, { attempts: 1, diarize, req });
  console.warn(`[stt] ${tierSlug} attempt 1 failed (${first.sttCause}); one more attempt`);
  await retryKnobs.sleep(pause);
  let out;
  try { out = await attempt(Math.max(1, Math.floor(retryLeftMs(startedAt, capMs, req)))); } catch (e) { throw finalFailure(e, { attempts: 2, diarize, req }); }
  out.agent402_retried = { attempts: 2, reason: `the first upstream attempt failed (${first.sttCause}); a second attempt on the same model served this transcript` };
  return out;
}

async function transcribeBuffer(buf, filename, tierSlug, language, diarize, probedDuration, req) {
  const out = await transcribeWithRetry(buf, filename, tierSlug, language, diarize, probedDuration, req);
  recordSttSpend(tierSlug, out, probedDuration);
  return out;
}

/** Sends what prepareAudioWithinCap bounded (its durationSec is the margin
 *  math's and the answer's duration); a cut file's answer says so. */
async function transcribePrepared(prep, tierSlug, language, diarize, req) {
  const out = await transcribeBuffer(prep.buf, prep.filename, tierSlug, language, diarize, prep.durationSec, req);
  if (prep.trimmedToCapSeconds) Object.assign(out, { trimmedToCapSeconds: prep.trimmedToCapSeconds, durationUnconfirmed: true });
  return out;
}

function makeHandler(tierSlug) {
  return async (input, req) => {
    const { url, language, diarize } = validateInput(input);
    const { buf, filename } = await fetchAudio(url);
    return transcribePrepared(await prepareAudioWithinCap(buf, filename, tierSlug, req), tierSlug, language, diarize, req);
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
    refuseUnservedFields(fields);
    return transcribePrepared(await prepareAudioWithinCap(file.buf, file.filename, tierSlug, req), tierSlug, language, diarize, req);
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

export const STT_TOOLS = [
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
      "Pro tier for longer recordings (model-backed, gpt-transcribe, the same model as the standard tier): transcribes an audio file at a URL. Max 10 minutes and 25 MB, the longer cap of the transcribe routes. Returns the transcript text, language and duration; diarize:true adds speaker labels, word timestamps and a language confidence score. No API key needed; pay per call via x402." + TRIM_NOTE + RETRY_NOTE,
    tags: [...SHARED_TAGS, "gpt-transcribe", "pro"],
    discovery: {
      bodyType: "json",
      input: { url: "https://agent402.tools/fixtures/sample-speech.wav" },
      inputSchema: {
        properties: {
          url: { type: "string", description: "URL of the audio file to transcribe (mp3, wav, m4a, ogg, flac, webm)" },
          language: { type: "string", description: "Optional ISO-639-1 language code (e.g. 'en', 'es', 'fr') for better accuracy" },
          diarize: { type: "boolean", description: "true: transcribe with the scribe-v2 model and add speaker labels and word timestamps (`words`, `speakers`) and `language_confidence` (0 to 1, the model's confidence in the detected language). Same price and cap. Default false" },
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
