// Worker that renders markdown to HTML off the serving thread (pool:
// ./markdown-pool.js). It imports the renderer alone, so it starts in tens of
// milliseconds. It reports `started` before each render: the pool's deadline
// counts render time only, never the time a worker takes to start. It says
// `ready` once, when it has loaded.
import { parentPort } from "node:worker_threads";
import { renderMarkdown } from "./markdown-render.js";

parentPort.on("message", (job) => {
  parentPort.postMessage({ id: job.id, started: true });
  try {
    parentPort.postMessage({ id: job.id, result: renderMarkdown(job.text) });
  } catch (e) {
    parentPort.postMessage({ id: job.id, error: String(e?.message || e), statusCode: e?.statusCode || 500 });
  }
});
// Loaded: the pool keeps one such worker in hand for the ordinary lane.
parentPort.postMessage({ ready: true });
