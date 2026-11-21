---
paths:
  - "src/tools/pdf*.js"
  - "src/tools/office-*.js"
  - "src/tools/ocr-kit.js"
  - "src/tools/media-kit.js"
  - "src/tools/render.js"
  - "src/tools/render-static.js"
  - "src/tools/frame-diff.js"
  - "src/tools/child-env.js"
  - "src/tools/image-*.js"
  - "src/tools/markdown-*.js"
  - "scripts/fetch-tessdata.js"
  - "Dockerfile"
---

# Media and documents

Loaded when a media, document or worker-pool tool file is read.

- **Media and documents:** the OCR language data is baked into the image at build
  (`scripts/fetch-tessdata.js`, pinned and hash-checked; `OCR_TESSDATA_DIR` overrides the
  directory), so `image-ocr` never fetches a model at request time; an engine that does not
  start within `OCR_INIT_TIMEOUT_MS` (default 30000) answers 503. **OCR turns:** one image
  over `OCR_LARGE_PIXELS` (16 MP) is in an engine at a time, in an engine of its own that is
  terminated when the image is done; smaller images run one at a time on their language's worker;
  at most `OCR_WORKER_MAX` (3) engines run at once. Turns are fair across callers
  (`src/caller-turns.js`; a caller is `ocrCallerOf`: signed payer, credits key, Tempo sender, else
  the client address, every key counted): images are read in arrival order, a caller's later
  images standing where its earlier one left the engine, so one caller's run of images (from one
  wallet, several wallets behind one address, or one wallet from several addresses) waits behind
  what other callers sent meanwhile. An image holds its engine `OCR_RUN_MAX_MS` (120 s) at most
  and never past the time its call can be answered and settled (the CDN window, the payment
  authorization's life; 422 `image-too-slow`), `OCR_TURN_MS` (30 s) once
  another caller's image waits for that engine (it gives way with a retryable 503), and only
  while its caller's connection is open (499). Engine time that ends without an answer counts
  `OCR_UNPAID_WEIGHT` (4) times against that caller's place in line. A call waits in line
  `OCR_LARGE_WAIT_MS` (one turn and the engine's retirement, 45 s), then a 503 with Retry-After,
  and keeps its place for the retry (a ticket, two minutes, renewed by each retry); no call that
  arrives later is read ahead of it. The line holds `OCR_QUEUE_MAX` (64) images, `OCR_LARGE_QUEUE_MAX` (8) of them
  large, and `OCR_QUEUE_MAX_BYTES` (96 MB): when full, a caller holding nothing takes a place
  from a caller holding several (its own key, then an address holding several), then from
  whatever stands behind it; a caller that holds places is the one refused
  (`src/caller-places.js`). A request that names no caller (unsigned, behind a CDN edge with no
  proof of its client: `ANONYMOUS_CALLER`, `src/dispatch-caller.js`) shares one key. On the
  free tier the caller is the client address. Suite: `scripts/test-ocr-crash.js`. PDF transforms
  (`src/tools/pdf-ops.js`) run in a fresh worker thread per call (`pdf-offthread.js`,
  `pdf-worker.js`) with a heap limit, a decoded-stream cap and a deadline that terminates it
  (422). The Office builders (`xlsx-create`, `docx-create`, `pptx-create`; `src/tools/office-ops.js`)
  run in a small worker pool (`office-pool.js`, `office-worker.js`): `OFFICE_WORKERS_MAX` workers
  (default 2), at most `OFFICE_QUEUE_MAX` calls waiting (default 16; past it a 503 with
  Retry-After), a 15 s deadline that terminates the worker (422), idle workers retired after 30 s.
  ffmpeg and ffprobe pass an audio-only `-codec_whitelist` before `-i`, so no video decoder
  opens. html-frames runs in its own jitless browser; a payer's failed documents are bounded to
  `HTML_FRAMES_FAIL_MAX` (default 5, per replica) per `HTML_FRAMES_FAIL_WINDOW_MS` (10 minutes),
  then a 429 with Retry-After. ffmpeg, ffprobe and Chromium start with `childEnv()`
  (`src/tools/child-env.js`), an allowlist of environment variables, so no key reaches a child
  process (defense in depth: a same-user child can still read its parent's environment).
- **Answer size:** a tool that answers with bytes a converter wrote holds them to its cap in
  `src/tools/answer-cap.js` (`ANSWER_CAPS`: the audio tools 60 MB, the PDF tools 40 MB, images the
  bound their pixel cap sets; a tool with a cap of its own is in `ANSWER_CAPS_ELSEWHERE`), checked
  before the bytes are read or turned into base64; past it the answer is a 413 naming the limit.
  `audio-convert` and `audio-normalize` read the declared length first (ffprobe) and refuse before
  the encode a file whose MP3 would pass the cap, projected at the bitrate the encoder writes for
  the file's sample rate; ffmpeg gets `-fs` one byte past the cap and the output is sized
  (`readFileWithin`) before it is read, which holds a file whose headers understate its length. A
  new converter tool gets a row in one of the two tables. Suite: `scripts/test-answer-cap.js`.
- **Render without a browser:** `src/tools/render-static.js` fetches the page through `safeFetch`
  (8 s) and answers from its served HTML (`rendered: false`) when the verdict allows it: at least
  `STATIC_MIN_WORDS` (50) words, no empty single-page-app mount, no hydrated components, no
  noscript JavaScript notice beside under 300 words. Every other outcome, a refused or failed
  fetch included, runs the browser path unchanged. The markers are read from the first
  `STATIC_SCAN_MAX_CHARS` (256 KB) with bounded attribute reads, so a crafted page cannot hold the
  serving thread (`scripts/test-render-static.js` times it). `RENDER_STATIC_READ=off` (unset = on)
  sends every page to the browser.
- **Markdown:** one renderer configuration (`src/tools/markdown-render.js`: heading ids) serves
  `markdown-to-html`, the guide pages and the docs pages, so a document renders to the same bytes
  everywhere. The tool renders a document of up to `MARKDOWN_INLINE_MAX_CHARS` (2,500) characters
  on the serving thread and a longer one in its own two-worker pool (`markdown-pool.js`,
  `markdown-worker.js`), never in the HTML pool: one lane for ordinary documents, one for those a
  one-pass estimate reads as costly, each with its own waiting room (512 ordinary documents; a
  costly one is admitted only while the renders ahead of it fit in 30 s, else a 503 with
  Retry-After for that lane alone). The estimate is only a first sort: a render that started as
  ordinary gets `ORDINARY_BUDGET_MS` (1 s from the worker's start signal); past it the worker is
  ended and the document moves to the costly lane and starts again there (a 503 with Retry-After
  when that room is full), and the ordinary lane takes a spare worker kept started for it. The
  ordinary room is fair by caller (`req.ip`, which the handler passes): the next document comes
  from the caller that has used the least worker time, level callers take turns, and one address
  holds at most `ORDINARY_CALLER_MAX` (128) places. A costly render gets 10 s from its start
  signal; past it the worker is terminated and the answer is a 400 that names the deadline.
- **Image headers:** the source-pixel cap is read from the container header, so
  `src/tools/image-headers.js` holds each format to the field its decoder sizes from: one PNG
  IHDR, and it comes first; one JPEG frame header on the marker chain, with the cap also handed
  to the JPEG decoder (`maxResolutionInMP`), which applies it to whichever frame header it acts
  on; GIF frame 0 inside its screen, read with the omggif copy jimp loads, and its LZW data
  read once for a code the table does not define yet (the decoder's prefix walk does not come
  back from one); a minimum code size past 8 is refused (the decoder keeps literals in 8 bits).
  `assertInflateWithinDeclared` runs in the worker and bounds the inflate of an interlaced PNG.
  No WebP decoder is installed. The pool's call (`mainThread`) holds its own work to a fixed
  budget (4,096 TIFF entries and strip rows, a 256 KB GIF, 64 KB of GIF frame data, no per-chunk
  state for a PNG) and leaves a larger file
  to the worker, which runs the whole check before it decodes. `scripts/test-image.js` ends
  with a seeded fuzz of every format (300 mutated files each, about a second).
- **TIFF:** the tools use the first image, so `tiffLayout` reads that one directory the way the
  decoder does and bounds it (pixels, sample bytes, tile, tag value counts against the file's
  length), and the decoder is given `tiffDecoderView`: a copy of the file in which that
  directory is the only one, sub-directory and maker-note tags carry an unused tag number
  (stored, never followed), and byte counts stop at the end of the file. Those edits land in
  the directory, which a file can also point its own values at, so `tiffSettledView` checks
  the view again as the decoder will read it and refuses one that does not settle. Multi-page files,
  maker notes and raw-sensor pages decode to the same pixels as before. In the worker,
  a strip table may list no more strips than the page's rows hold, nor more bytes than twice
  the file; `assertTiffStreams` inflates each deflate strip under its own rows and all of them
  under the page, stops at the first strip that does not inflate (a failed inflate keeps its
  zlib buffer until the next collection), and caps every frame
  header an embedded-JPEG decoder could read (compression 6, 7, 34892; a raw byte scan of the
  ranges the decoder copies). CCITT pages (2, 3, 4) are decoded in a one-shot child process
  (`image-child.js`, started with `childEnv()`, a 96 MB heap ceiling and a deadline inside the
  job's): that decoder's row buffer grows with the data, so only the ceiling bounds it, and
  reaching it ends the child alone (400). Compressions 9 and 34316 answer 400: their decoders
  size buffers from fields inside their own stream. A new decoder path gets a reader that
  follows the decoder, a small-file test and a decode of the format's ordinary shapes
  (`scripts/test-image.js`).
- **Transcription length:** the per-tier cap of `transcribe` and `transcribe-pro` holds the longer of the duration a
  file's headers declare and the length its audio measures. `measureAudio` (`src/tools/media-kit.js`) decodes the first
  audio stream to nowhere with ffmpeg (audio-only whitelist) and answers `{ seconds }`, `{ undecodable }` or
  `{ unavailable }`. Its pool holds one decode per CPU the process may use (`os.availableParallelism()`, held to 2..8;
  `AUDIO_DECODE_SLOTS`, 1 to 64, overrides it). A transcription call passes `deadlineAt` (`decodeDeadlineAt` in
  `src/tools/stt-kit.js`: the route's payment-window budget, the CDN answer window and the payment authorization,
  whichever ends first, less the upstream's whole cap, 60 s or 120 s diarized): it waits for a slot while that still
  leaves a 10 s decode, and its decode may run to it (at most 60 s). A caller without one waits 5 s and decodes for 10 s.
  A PCM WAV (PCM, float, A-law, mu-law; one fmt chunk whose fields agree, 8 kHz or more) whose bytes over 8,000 a
  second fit the cap is sent as it came with no decode (`pcmWavMaxSeconds`); every compressed codec can hold silence in
  a few bytes, so its bytes bound nothing and it is always decoded. `prepareAudioWithinCap` (`src/tools/stt-kit.js`): a
  measured file inside the cap goes byte for byte when its container is on the upstream's list (flac, mp3, mp4/m4a,
  ogg, wav, webm), else as 16 kHz mono FLAC (`transcodeSpeech`, same pool and deadline). Unmeasured, a lossy audio-only
  file whose bytes alone play past the cap is the 422 (`byteFloorApplies`); any other file is cut at the cap with
  `-t`, and a cut that reached the cap is what is sent, the answer carrying `trimmedToCapSeconds` and
  `durationUnconfirmed: true`. A file ffmpeg cannot decode is a 400 (format unreadable, no upstream call); a decoder that
  cannot run (no slot in the time the budget leaves, deadline, no ffmpeg) is a retryable 503 with no upstream call. The unmeasured count since boot
  is `transcriptionUnmeasured.sinceBoot` on `/__operator/tool-failures.json`. Suite: `scripts/test-stt-cap.js`.
- **Thirty-minute tier (`transcribe-long`, `POST /api/transcribe-long`):** listed and served only with
  `TRANSCRIBE_LONG=on` (off by default; `src/tools/stt-kit.js` `sttLongEnabled`, env-gated in
  `scripts/published-slugs.js`). An audio URL only (a job replays a JSON body). Its price is the margin rule's
  (the cent at or above 30 minutes at the dearer model's rate over `STT_MARGIN`, pinned by test-stt-cap). A
  converted file goes as 16 kHz mono Opus in Ogg (`SPEECH_CODECS`, `src/tools/media-kit.js`): thirty minutes of
  FLAC can pass the 25 MB upload limit. Its upstream cap is 140 s per path (`sttUpstreamCapMs`), its run budget
  230 s (`EVM_RUN_SECONDS`, the fetch, the decode and that cap), and it is long-running (EVM exact only,
  `LONG_RUNNING_SLUGS`); past the CDN answer window it runs as a job. The other tiers' over-cap refusal and the
  pro description name it only while the switch is on. The upstream's time on a thirty-minute file is measured
  by one supervised paid run before the switch goes on.
- **Image generation moderation:** the three GPT Image tiers (`src/tools/image-gen-kit.js`) send
  `moderation: "low"` unless the caller sends `"auto"` (any other value is a 400 naming the field).
  A 400 whose OpenAI error names the `moderation` parameter (`error.param`, or an
  unknown/unsupported-parameter code quoting it) sends the same request once more without the
  field (never a loop; one console line per boot). A content-check refusal (`moderation_blocked`
  or a "safety system" message) is a 400 with a plain rephrase message, never retried and never
  sent to another model or provider. Renders and refusals by level and the fallback count since
  boot are `imageGenModeration.sinceBoot` on `/__operator/tool-failures.json` (counts only). The
  `/v1/images/*` routes ride the OpenRouter image links and do not send this parameter.
  Suite: `scripts/test-image-gen-kit.js`.
