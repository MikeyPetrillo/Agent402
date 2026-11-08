# Content Pipeline

A content pipeline (a podcast, a short video, a narrated explainer) is a chain of stages: research, script, voiceover, images, transcription, subtitles, dubbing and media checks. On Agent402.Tools each stage is one paid call, paid from one wallet over x402 or MPP, with no API key. The guide with a runnable example per stage, an end-to-end flow and live prices is at [agent402.tools/guides/content-pipeline](https://agent402.tools/guides/content-pipeline).

## Stages

| Stage | Slugs | Model-backed | Source |
|---|---|---|---|
| Answer with citations | `answer` | yes | `src/tools/search.js` |
| Research report | `research` (also `research-pro`, `research-max`) | yes | `src/tools/research-deep-kit.js` |
| Script | `v1-chat-metered` (quoted per request), or a flat `/v1` chat tier | yes | `src/tools/llm-gateway-kit.js` |
| Voiceover | `tts-lite`, `tts`, `tts-hd` | yes | `src/tools/tts-kit.js` |
| Images | `v1-images-fast`, `v1-images-pro`, `v1-images-edit` | yes | `src/tools/llm-images-fast-kit.js` |
| Transcription | `transcribe`, `transcribe-pro` (a URL); `v1-audio-transcriptions` (a multipart upload) | yes | `src/tools/stt-kit.js` |
| Subtitles | `srt-convert` (also free with proof-of-work) | no | `src/tools/kit2.js` |
| Subtitles in one call | `skill-subtitle-pipeline` | yes | `src/tools/skill-runner.js` |
| Dubbing | `dub` | yes | `src/tools/dub-kit.js` |
| Media checks | `media-info`, `audio-convert`, `audio-normalize` | no | `src/tools/media-kit.js` |

Prices and each route's chains are on [`/api/pricing`](https://agent402.tools/api/pricing). Speech, dubbing and metered chat are quoted per request, so the 402 for that body is the price.

## How the outputs chain

- `answer` returns `answer` and `citations`; the citations become the show notes and the answer feeds the script prompt.
- The metered chat answer's `choices[0].message.content` is the script. `tts` returns the audio as base64 in `audio`; split a script longer than the tier's character cap at sentence ends.
- Transcription and the media checks read a public URL, so the pipeline stores each audio file where it already keeps media and passes that URL on. Audio held as bytes goes to `POST /v1/audio/transcriptions` as a multipart `file`.
- `transcribe` with `diarize: true` returns `words` with `start` and `end` in seconds. Grouped into cues (`start`, `end` in milliseconds, `text`), they go to `srt-convert` with `to` set to `srt`, `vtt`, `text` or `json`. The subtitle-pipeline skill pack returns the whole clip as one cue, for when per-line timing is not needed.
- `dub` with `json: true` returns `translation` and the spoken `audio`; without it the answer is the audio bytes with the translation in `X-Dub-Translation`.
- `audio-normalize` and `audio-convert` return MP3 as `mp3Base64`; `media-info` returns `durationSec` and per-stream codecs.

## Slow stages

A route runs as a job when its `/api/pricing` row has an `async` block (`src/slow-routes.js`, `src/async-jobs.js`). `research` requires `Prefer: respond-async` or `Prefer: wait=<maxSeconds>` and answers a paid call with neither 400 before payment. `v1-images-fast` and `v1-images-pro` take `Prefer: respond-async` on request. The other stages answer on the connection. agent402-client sends the header where the row recommends it and collects the job.

## Paying for a pipeline

- **Spend caps.** agent402-client's `maxPerCallUsd`, `dailyLimitUsd` and `maxPerHostUsd` are checked before a payment is signed, against the quote for that request. agent402-mcp uses `AGENT402_MAX_PER_CALL` and `AGENT402_BUDGET`. Limits, retries and replays for long runs: [[Buying at Volume|Buying-at-Volume]].
- **Chains.** `research` and the image routes are long-running, so they take x402 exact on EVM chains only (`isLongRunningSlug` in `src/composite-spend-guard.js`). Every other stage takes every offered chain, over x402 or MPP.
- **Tempo.** Offered on every stage except `research` and the image routes (`tempoOfferedFor` in `src/mpp-tempo.js`). A pull credential (`payload` type `transaction`) is broadcast only after the stage answers under 400, so for a stage that fails a Tempo pull transaction is never broadcast and nothing is charged. A push credential (`payload` type `hash`) is a transfer already sent and final before the stage runs; if the stage then fails, the transfer is booked as a refund owed to the paying wallet and repaid after on-chain proof. Pipelines pay with pull: pin `mode: "pull"` on the Tempo charge method. A pull payment whose connection closed before the answer can still be broadcast, and is then booked as owed. See [[Paying with MPP]].
- **x402.** A response of 400 or above is not settled, so a failed x402 stage is not charged.
