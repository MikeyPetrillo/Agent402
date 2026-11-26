// A stand-in image worker for scripts/test-image.js: it takes `loadMs` to load
// its modules (a cold thread evaluating jimp or the barcode decoders on a busy
// host), then says "started" as the real worker does (src/tools/image-worker.js)
// and either answers at once or, with `hang`, holds its thread in synchronous
// code the way a decoder stuck in a decode does.
import { parentPort } from "node:worker_threads";

parentPort.on("message", async (job) => {
  const { loadMs = 0, hang = false } = job.params || {};
  await new Promise((r) => setTimeout(r, loadMs));
  parentPort.postMessage({ id: job.id, started: true });
  if (hang) { const end = Date.now() + 60_000; while (Date.now() < end) { /* stuck */ } }
  parentPort.postMessage({ id: job.id, result: { loadedIn: loadMs } });
});
