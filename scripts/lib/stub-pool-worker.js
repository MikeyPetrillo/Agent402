// A stand-in worker for scripts/test-pool-fairness.js: it stands in for the
// Office, image, HTML and PDF workers (src/tools/*-pool.js, pdf-offthread.js),
// marks its job started in a shared array and holds its thread until the test
// opens that job's gate, then answers { tag }. A pooled worker reads its job
// from a message (spec, params or payload); a PDF worker from workerData.args.
import { parentPort, workerData } from "node:worker_threads";

function run(d) {
  const gate = new Int32Array(d.gate);
  const started = new Int32Array(d.started);
  Atomics.store(started, d.idx, 1);
  Atomics.wait(gate, d.idx, 0, 30_000);
  return { tag: d.idx };
}

if (workerData && Array.isArray(workerData.args)) {
  parentPort.postMessage({ result: run(workerData.args[0]) });
} else {
  parentPort.on("message", (m) => parentPort.postMessage({ id: m.id, result: run(m.spec ?? m.params ?? m.payload) }));
}
