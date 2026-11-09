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
- **Image headers:** the source-pixel cap is read from the container header, so
  `src/tools/image-headers.js` holds each format to the field its decoder sizes from: one PNG
  IHDR, and it comes first; one JPEG frame header on the marker chain, with the cap also handed
  to the JPEG decoder (`maxResolutionInMP`), which applies it to whichever frame header it acts
  on; GIF frame 0 inside its screen, read with the omggif copy jimp loads; for TIFF every
  directory the decoder reads, with the cap on the page total (at most 32 pages) and on the
  decoded sample bytes. TIFF decodes compressions 1, 5, 8, 32946 and 32773; any other, a camera
  maker note in a vendor layout, or a tag declaring more values than the file holds answers 400.
  `assertInflateWithinDeclared` runs in the worker before the decode and bounds the inflate of
  an interlaced PNG and of each deflate TIFF strip or tile. No WebP decoder is installed. A new
  decoder path gets a header walk that follows the decoder, a small-file test and a decode of
  the format's ordinary shapes (`scripts/test-image.js`).
