// The SSRF dispatcher refuses a literal private IP, not only a hostname that
// resolves to one: Node skips DNS for a literal, so the lookup-based check
// never ran for http://127.0.0.1/ or http://[::1]/ (and so a redirect hop to
// one was followed). A real local server stands in for an internal service.
import http from "node:http";
import { ssrfDispatcher, freshSsrfDispatcher, isSsrfBlock } from "../src/tools/fetch-guard.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
let hits = 0;
const srv = http.createServer((req, res) => { hits++; res.end("INTERNAL"); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
const v6 = http.createServer((req, res) => { hits++; res.end("INTERNAL6"); });
const v6ok = await new Promise((r) => { v6.once("error", () => r(false)); v6.listen(0, "::1", () => r(true)); });

async function tryFetch(url, dispatcher) {
  try { const r = await fetch(url, { dispatcher, signal: AbortSignal.timeout(5000) }); return { body: await r.text() }; }
  catch (e) { return { err: e }; }
}
for (const [name, d] of [["shared", ssrfDispatcher], ["fresh", freshSsrfDispatcher()]]) {
  const a = await tryFetch(`http://127.0.0.1:${port}/`, d);
  ok(a.err && isSsrfBlock(a.err), `${name} dispatcher: a literal 127.0.0.1 is refused at connect (${a.body ?? a.err?.cause?.message ?? a.err?.message})`);
  const b = await tryFetch(`http://localhost:${port}/`, d);
  ok(b.err && isSsrfBlock(b.err), `${name} dispatcher: localhost (resolved) is still refused`);
  if (v6ok) {
    const c = await tryFetch(`http://[::1]:${v6.address().port}/`, d);
    ok(c.err && isSsrfBlock(c.err), `${name} dispatcher: a literal [::1] is refused`);
  }
}
ok(hits === 0, `the internal server was never reached (${hits} hits)`);
srv.close(); if (v6ok) v6.close();
console.log(`\ntest-ssrf-literal-ip: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
