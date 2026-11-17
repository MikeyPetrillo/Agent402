#!/usr/bin/env node
// scripts/lib/shed-answer.js: the sweeps (test-all, test-discoverability) wait
// out the server's load-shed answer as it asks and judge every other answer as
// it is. Against a loopback stub:
//   - the server's own shed answer (src/load-shed.js shedResponse) is
//     recognized, waited out and asked again, and the next 200 is returned;
//   - a 503 that is not a shed answer (no Retry-After, or a body that does not
//     carry the same figure) is returned at once, never retried;
//   - a shed that lasts is returned at the ask bound, marked stillShed.
// Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { createServer } from "node:http";
import { shedResponse } from "../src/load-shed.js";
import { shedWaitMs, fetchHonoringShed } from "./lib/shed-answer.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

// Per path: how many shed answers to give before a 200, and how many asks arrived.
const plan = { "/once": 1, "/always": Infinity };
const asks = {};
const srv = createServer((req, res) => {
  asks[req.url] = (asks[req.url] || 0) + 1;
  if (req.url === "/plain503") { res.writeHead(503, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "down" })); }
  if (req.url === "/mismatch") { res.writeHead(503, { "content-type": "application/json", "retry-after": "2" }); return res.end(JSON.stringify({ error: "x", retryAfterSeconds: 5 })); }
  if (asks[req.url] <= (plan[req.url] ?? 0)) {
    // The server's own shed answer, through an Express-shaped shim.
    const shim = { locals: {}, headers: {}, code: 0, set(k, v) { this.headers[k.toLowerCase()] = v; return this; }, status(c) { this.code = c; return this; },
      json(b) { res.writeHead(this.code, { ...this.headers, "content-type": "application/json" }); res.end(JSON.stringify(b)); return this; } };
    return shedResponse(shim, 1);
  }
  res.writeHead(200, { "content-type": "text/html" }); res.end("<p>page</p>");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const B = `http://127.0.0.1:${srv.address().port}`;
const slept = [];
const sleep = (ms) => { slept.push(ms); return Promise.resolve(); };

try {
  ok(shedWaitMs(503, "2", { retryAfterSeconds: 2 }) === 2000 && shedWaitMs(503, "2", { retryAfterSeconds: 5 }) === null && shedWaitMs(503, null, { retryAfterSeconds: 2 }) === null && shedWaitMs(500, "2", { retryAfterSeconds: 2 }) === null,
    "a shed answer is read from its fields: 503, Retry-After, and the same figure in retryAfterSeconds");

  const once = await fetchHonoringShed(`${B}/once`, {}, { sleep });
  ok(once.res.status === 200 && once.text === "<p>page</p>" && once.shed === 1 && !once.stillShed && asks["/once"] === 2 && slept[0] === 1000,
    `the server's shed answer is waited out as it asks and the next answer returned (${once.res.status}, ${asks["/once"]} asks, waited ${slept[0]} ms)`);

  const plain = await fetchHonoringShed(`${B}/plain503`, {}, { sleep });
  ok(plain.res.status === 503 && plain.shed === 0 && asks["/plain503"] === 1, "control: a 503 that is not a shed answer is returned at once, never asked again");
  const mismatch = await fetchHonoringShed(`${B}/mismatch`, {}, { sleep });
  ok(mismatch.res.status === 503 && asks["/mismatch"] === 1, "control: a body whose figure differs from Retry-After is not a shed answer");

  const always = await fetchHonoringShed(`${B}/always`, {}, { sleep, maxAsks: 3 });
  ok(always.res.status === 503 && always.stillShed === true && asks["/always"] === 3 && always.shed === 2, `a shed that lasts is returned at the ask bound, marked still shed (${asks["/always"]} asks)`);
} finally {
  srv.close();
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
