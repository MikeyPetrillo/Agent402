// Test fixture: the regex worker behind a slow thread start (a busy runner).
// It holds the thread before the real worker module loads, then runs it.
const delay = Number(process.env.SLOW_REGEX_WORKER_START_MS || 1500);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
await import("../../src/tools/regex-worker.js");
