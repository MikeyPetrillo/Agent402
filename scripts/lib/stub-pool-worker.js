// A stand-in worker for scripts/test-pool-fairness.js: it stands in for the
// Office, image, HTML and PDF workers (src/tools/*-pool.js, pdf-offthread.js),
// marks its job started in a shared array and holds its thread until the test
// opens that job's gate, then answers { tag }. A pooled worker reads its job
// from a message (spec, params or payload); a PDF worker from workerData.args.
// A job whose payload is text (the xml-to-json tool's, through the real
// handler) names its hold as <hold idx="N" dir="..."/>: the stand-in writes
// started-N in that directory and holds until open-N exists, then answers the
// JSON text the handler parses.
import { parentPort, workerData } from "node:worker_threads";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function runText(text) {
  const m = /<hold idx="(\d+)" dir="([^"]+)"\/>/.exec(String(text));
  if (!m) return JSON.stringify({ tag: null });
  const [, idx, dir] = m;
  writeFileSync(join(dir, `started-${idx}`), "");
  const nap = new Int32Array(new SharedArrayBuffer(4));
  const end = Date.now() + 30_000;
  while (!existsSync(join(dir, `open-${idx}`)) && Date.now() < end) Atomics.wait(nap, 0, 0, 5);
  return JSON.stringify({ tag: Number(idx) });
}

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
  parentPort.on("message", (m) => {
    const d = m.spec ?? m.params ?? m.payload;
    parentPort.postMessage({ id: m.id, result: typeof d?.text === "string" ? runText(d.text) : run(d) });
  });
}
