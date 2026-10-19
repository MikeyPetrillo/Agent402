// Worker that runs HTML parsing (jsdom, Readability, turndown) in an isolated
// thread, so a page that is slow to parse can never occupy the server's event
// loop. Long-lived: the pool in ./html-pool.js keeps the jsdom import warm and
// terminates this thread outright when a job overruns its time limit.
import { parentPort } from "node:worker_threads";
import { runOp } from "./html-worker-ops.js";
import { loadJsdom } from "./lazy-deps.js";

// This thread has no listener to protect, so jsdom loads at start and the
// first job finds it warm.
loadJsdom().catch(() => { /* the first job's parse reports the failure */ });

parentPort.on("message", async (job) => {
  let reply;
  try {
    reply = { id: job.id, result: await runOp(job.op, job.payload) };
  } catch (e) {
    // statusCode rides back so a 400 stays a 400. An error without one is a
    // defect in here, not bad input, so it is a 500 and never billed.
    reply = { id: job.id, error: String(e?.message || e), statusCode: e?.statusCode || 500 };
  }
  try { parentPort.postMessage(reply); }
  catch (e) { parentPort.postMessage({ id: job.id, error: `HTML result could not be returned: ${e.message}`, statusCode: 500 }); }
});
