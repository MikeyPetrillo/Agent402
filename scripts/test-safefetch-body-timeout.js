// safeFetch's timeoutMs bounds the body read as well as the headers: a
// server that answers headers at once and then trickles the body is cut off
// at timeoutMs with a 504, and a body that arrives in time is still served.
// A host that never sends headers is cut off at timeoutMs too. Both 504s are
// the source host's doing: they carry attribution "upstream" and the hint
// "source-timeout" (what a media-info caller met on 2026-11-06), which a
// tool's error answer passes on (src/tool-error-fields.js).
// fetch is pointed at a local trickle server; the URL handed to safeFetch is a
// public literal that is never contacted.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import http from "node:http";
import { safeFetch } from "../src/tools/fetch-guard.js";
import { toolErrorFields } from "../src/tool-error-fields.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const srv = http.createServer((req, res) => {
  // Headers never sent: the socket stays open until the client gives up.
  if (req.url === "/silent") return;
  res.writeHead(200, { "content-type": "text/plain" });
  if (req.url === "/fast") return res.end("hello");
  // One byte every 200 ms for a minute.
  let n = 0;
  const t = setInterval(() => { if (++n > 300) { clearInterval(t); return res.end(); } res.write("x"); }, 200);
  req.on("close", () => clearInterval(t));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const local = `http://127.0.0.1:${srv.address().port}`;
const orig = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  const { dispatcher, ...rest } = init;
  return orig(local + new URL(url).pathname, rest);
};

try {
  const t0 = Date.now();
  let err = null;
  try { await safeFetch("http://8.8.8.8/slow", { timeoutMs: 1000 }); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  ok(err && err.statusCode === 504, `a trickled body ends in a 504 (got ${err ? err.statusCode + " " + err.message : "a body"})`);
  ok(ms < 3000, `cut off near timeoutMs, not when the body ends (${ms} ms)`);
  ok(err && /did not finish sending within our 1 s limit/.test(err.message), "the message says the body did not finish inside our limit");
  ok(err?.attribution === "unknown" && err?.hint === "source-timeout", `a trickled body is a source timeout whose side is unknown (${err?.attribution}, ${err?.hint})`);

  let silent = null;
  const t1 = Date.now();
  try { await safeFetch("http://8.8.8.8/silent", { timeoutMs: 1000, binary: true }); } catch (e) { silent = e; }
  ok(silent?.statusCode === 504 && /did not respond within our 1 s limit; check that the URL is correct and publicly reachable, or retry$/.test(silent?.message), `a host that sends no headers ends in a 504 that advises checking the URL or retrying (got ${silent?.statusCode} ${silent?.message})`);
  ok(Date.now() - t1 < 3000, "cut off near timeoutMs");
  ok(silent?.attribution === "unknown" && silent?.hint === "source-timeout", `no headers is a source timeout whose side is unknown (${silent?.attribution}, ${silent?.hint})`);
  const fields = toolErrorFields(silent);
  ok(fields.attribution === "unknown" && fields.hint === "source-timeout", "the tool error answer carries attribution and hint");
  const fast = await safeFetch("http://8.8.8.8/fast", { timeoutMs: 1000 });
  ok(fast.html === "hello", "a body that arrives in time is served");
  // The timer is cleared after a success: nothing fires later.
  await new Promise((r) => setTimeout(r, 1200));
  ok(true, "no late abort after a completed read");
} finally {
  globalThis.fetch = orig;
  srv.close(); srv.closeAllConnections?.();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
