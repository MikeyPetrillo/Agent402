// The Idempotency-Key replay cache's per-response ceiling. Read by the cache
// itself (src/server.js) and by the tool pages (src/pages.js), which say that
// a JSON answer larger than this is not replayed. One constant, so the page
// cannot promise a replay the cache refuses.
export const IDEM_MAX_BODY_BYTES = 1024 * 1024;

/** "1 MB" for the prose. */
export const IDEM_MAX_BODY_LABEL = `${IDEM_MAX_BODY_BYTES / (1024 * 1024)} MB`;
