// The tesseract.js worker thread (ocr-kit.js passes this file as workerPath):
// the package's own Node worker script, with one change on the way out. Each
// job is answered once. tesseract.js 7's initialize answers a failed start
// (unreadable language data) with a reject and then a resolve; the main
// thread's handler deletes a job's promise on its first answer and reads it
// again on the second, which throws inside a worker message listener, outside
// any caller's reach: an uncaught exception that would end the server. Here a
// second final answer (resolve or reject) for a job is dropped, so a failed
// start rejects once (the startup deadline in ocr-kit.js then answers 503) and
// every other job is unchanged.
"use strict";
const { parentPort } = require("node:worker_threads");

const answered = new Set();
const ANSWERED_KEEP = 64; // jobs run one at a time per worker; a few suffice
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (msg, ...rest) => {
  if (msg && (msg.status === "resolve" || msg.status === "reject")) {
    const key = `${msg.action}-${msg.jobId}`;
    if (answered.has(key)) return;
    answered.add(key);
    if (answered.size > ANSWERED_KEEP) answered.delete(answered.values().next().value);
  }
  return post(msg, ...rest);
};

require("tesseract.js/src/worker-script/node/index.js");
