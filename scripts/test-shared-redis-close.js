#!/usr/bin/env node
// closeSharedRedis() closes a connect still in flight.
//
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-shared-redis-close.js
//
// getSharedRedisClient() waits CONNECT_WAIT_MS (1 s) for a connect and then
// answers null while the connect keeps running. A close made in that gap used
// to see no client, return, and leave the late socket open, so the process
// never exited. A proxy in front of the real Redis holds each connection
// before passing it through, so the connect outlives the wait; the child must
// still exit once it has closed.
// Deliberately does not skip without REDIS_URL (CI provides the service).
import net from "node:net";
import { spawn } from "node:child_process";

if (!process.env.REDIS_URL) {
  console.error("FAIL: REDIS_URL is not set. This test needs a real redis. It deliberately does not skip.");
  process.exit(1);
}
const target = new URL(process.env.REDIS_URL);
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.log(`FAIL - ${m}`); } };

function delayProxy(holdMs) {
  const sockets = new Set();
  const server = net.createServer((inbound) => {
    sockets.add(inbound);
    inbound.pause();
    setTimeout(() => {
      const out = net.connect(Number(target.port || 6379), target.hostname);
      sockets.add(out);
      out.on("error", () => inbound.destroy());
      inbound.on("error", () => out.destroy());
      inbound.pipe(out); out.pipe(inbound); inbound.resume();
    }, holdMs);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    port: server.address().port,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  })));
}

const CHILD = `
  const m = await import(${JSON.stringify(new URL("../src/shared-limit.js", import.meta.url).href)});
  const c = await m.getSharedRedisClient();
  console.log("client " + (c ? "ready" : "null"));
  await m.closeSharedRedis();
  console.log("closed");
`;

function runChild(port, limitMs) {
  return new Promise((resolve) => {
    const env = { ...process.env, REDIS_URL: `redis://127.0.0.1:${port}` };
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, limitMs);
    const t0 = Date.now();
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, ms: Date.now() - t0 }); });
  });
}

// Control: a connect that answers at once is ready, and the child exits.
{
  const p = await delayProxy(0);
  const r = await runChild(p.port, 15_000);
  p.close();
  ok(/client ready/.test(r.out) && /closed/.test(r.out), `control: a prompt connect is ready and closes (${r.out.trim().replace(/\n/g, "; ")})`);
  ok(r.code === 0 && !r.signal, `control: the child exits on its own (code ${r.code}, ${r.ms} ms)`);
}
// A connect held past the wait: the caller gets null, the close still ends it.
{
  const p = await delayProxy(2_500);
  const r = await runChild(p.port, 15_000);
  p.close();
  ok(/client null/.test(r.out), `the held connect outlives the wait: the caller gets no client (${r.out.trim().replace(/\n/g, "; ")})`);
  ok(/closed/.test(r.out) && r.code === 0 && !r.signal, `the close ends the late connect and the child exits (code ${r.code}, signal ${r.signal}, ${r.ms} ms)`);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
