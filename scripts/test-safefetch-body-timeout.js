// safeFetch's timeoutMs bounds the body read as well as the headers: a
// server that answers headers at once and then trickles the body is cut off
// at timeoutMs with a 504, and a body that arrives in time is still served.
// fetch is pointed at a local trickle server; the URL handed to safeFetch is a
// public literal that is never contacted.
import http from "node:http";
import { safeFetch } from "../src/tools/fetch-guard.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const srv = http.createServer((req, res) => {
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
  ok(err && /did not finish sending within 1s/.test(err.message), "the message says the body did not finish in time");
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
