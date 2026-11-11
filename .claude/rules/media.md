---
paths:
  - "src/tools/pdf*.js"
  - "src/tools/office-*.js"
  - "src/tools/ocr-kit.js"
  - "src/tools/media-kit.js"
  - "src/tools/render.js"
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
  start within `OCR_INIT_TIMEOUT_MS` (default 30000) answers 503. PDF transforms
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
  file's headers declare and the length its audio measures. `measureAudioSeconds` (`src/tools/media-kit.js`) decodes
  the first audio stream to nowhere with ffmpeg (audio-only whitelist, its own two-slot pool that queues, 10 s
  deadline) and never refuses: where it cannot measure (no ffmpeg, a failed or slow decode) a lossy audio-only file in
  one or two channels at a reported sample rate of 48 kHz or less is held to the shortest its bytes can play
  (`byteFloorApplies`, `byteFloorSeconds`, `src/tools/stt-kit.js`); a file with a video track, more channels, a higher
  sample rate (192 kHz Vorbis passes 640 kbps) or no reported sample rate keeps its declared length, since its bytes
  are not all audio at the floor's rate. The unmeasured count since boot is `transcriptionUnmeasured.sinceBoot` on
  `/__operator/tool-failures.json`. Suite: `scripts/test-stt-cap.js`.
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
