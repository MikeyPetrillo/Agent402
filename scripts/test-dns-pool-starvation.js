// The address guard's name lookups never wait on libuv's thread pool. That
// pool (four threads by default) runs getaddrinfo, fs, zlib and crypto work;
// a name whose server never answers held one thread per lookup for as long as
// getaddrinfo kept retrying, long after the guard's own bound had answered the
// caller, so a handful of such names stalled every lookup in the process. The
// guard now resolves with c-ares (dns.Resolver), a socket on the event loop.
//
// Offline: a DNS server on loopback answers the healthy names and never answers
// the slow ones, and the guard's resolver is pointed at it. The pool is filled
// with crypto work for a few seconds (standing in for threads held by slow
// getaddrinfo calls), and a getaddrinfo control proves it is really full.
// While it is full and eight slow names are in flight, a healthy name resolves
// at the upfront check, the browser check and the connect-time pin within a
// second, and the slow names end as the retryable 503 at their bound.
//
//   node scripts/test-dns-pool-starvation.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { pbkdf2, pbkdf2Sync } from "node:crypto";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- a DNS server on loopback ----------------------------------------------------
const ANSWERS = { "good.pool.test": "93.184.215.14", "priv.pool.test": "10.9.8.7" };
const queries = new Map(); // "name type" -> count
const server = dgram.createSocket("udp4");
function readName(buf, off) {
  const labels = [];
  for (;;) {
    const len = buf[off];
    if (len === 0) return { name: labels.join(".").toLowerCase(), end: off + 1 };
    labels.push(buf.toString("latin1", off + 1, off + 1 + len));
    off += 1 + len;
  }
}
server.on("message", (msg, rinfo) => {
  const { name, end } = readName(msg, 12);
  const qtype = msg.readUInt16BE(end);
  const key = `${name} ${qtype === 1 ? "A" : qtype === 28 ? "AAAA" : qtype}`;
  queries.set(key, (queries.get(key) || 0) + 1);
  if (!(name in ANSWERS)) return; // the slow names: never answered
  const question = msg.subarray(12, end + 4);
  const header = Buffer.alloc(12);
  msg.copy(header, 0, 0, 2); // id
  header.writeUInt16BE(0x8180, 2); // response, recursion desired and available, NOERROR
  header.writeUInt16BE(1, 4); // one question
  const answers = [];
  if (qtype === 1) {
    const rr = Buffer.alloc(16);
    rr.writeUInt16BE(0xc00c, 0); rr.writeUInt16BE(1, 2); rr.writeUInt16BE(1, 4); rr.writeUInt32BE(30, 6); rr.writeUInt16BE(4, 10);
    ANSWERS[name].split(".").forEach((o, i) => { rr[12 + i] = Number(o); });
    answers.push(rr);
  }
  header.writeUInt16BE(answers.length, 6); // AAAA: no data
  server.send(Buffer.concat([header, question, ...answers]), rinfo.port, rinfo.address);
});
await new Promise((r) => server.bind(0, "127.0.0.1", r));
const dnsPort = server.address().port;

// Point every promise Resolver at it on first use (the real c-ares underneath).
const P = dnsPromises.Resolver.prototype;
for (const fn of ["resolve4", "resolve6"]) {
  const real = P[fn];
  P[fn] = function (...a) {
    if (!this.__poolTest) { this.setServers([`127.0.0.1:${dnsPort}`]); this.__poolTest = true; }
    return real.apply(this, a);
  };
}
process.env.DNS_LOOKUP_TIMEOUT_MS = "1500";
const { assertPublicUrl, hostIsPublic, ssrfDispatcher, isSsrfBlock, LOOKUP_UNAVAILABLE } = await import("../src/tools/fetch-guard.js");

// --- fill the thread pool for a few seconds ----------------------------------------
const POOL = Number(process.env.UV_THREADPOOL_SIZE) > 0 ? Number(process.env.UV_THREADPOOL_SIZE) : 4;
const t1 = performance.now();
pbkdf2Sync("x", "salt", 20_000, 32, "sha256");
const perIter = Math.max((performance.now() - t1) / 20_000, 1e-5);
const HOLD_MS = 4000;
const iterations = Math.ceil(HOLD_MS / perIter);
const tStart = performance.now();
let firstPoolDone = Infinity;
const poolWork = Array.from({ length: POOL }, () => new Promise((resolve) => pbkdf2("x", "salt", iterations, 32, "sha256", () => { firstPoolDone = Math.min(firstPoolDone, performance.now()); resolve(); })));
const since = () => Math.round(performance.now() - tStart);

// Control: getaddrinfo really waits on the full pool.
const control = new Promise((resolve) => { const t = performance.now(); dns.lookup("localhost", () => resolve(performance.now() - t)); });

// Eight slow names in flight, and fifty concurrent checks of one more slow name.
const slow = Array.from({ length: 8 }, (_, i) => {
  const t = performance.now();
  return assertPublicUrl(`https://slow${i}.pool.test/`).then(() => ({ ok: true }), (e) => ({ e, ms: performance.now() - t }));
});
const dup = Array.from({ length: 50 }, () => assertPublicUrl("https://slow-dup.pool.test/").catch((e) => e));
await new Promise((r) => setTimeout(r, 100));

// A healthy name at the upfront check.
let t = performance.now();
const good = await assertPublicUrl("https://good.pool.test/path").catch((e) => e);
const goodMs = performance.now() - t;
ok(good instanceof URL && goodMs < 1000 && performance.now() < firstPoolDone, `a healthy name passes the upfront check in ${Math.round(goodMs)} ms while the pool is full (${good instanceof URL ? "public" : good?.message})`);

// The browser renderer's check.
t = performance.now();
const pub = await hostIsPublic("good.pool.test");
ok(pub === true && performance.now() - t < 1000, `hostIsPublic answers in ${Math.round(performance.now() - t)} ms while the pool is full (${pub})`);

// The connect-time pin: a private answer is refused at connect, promptly.
t = performance.now();
let connectErr = null;
try { await fetch("http://priv.pool.test:8081/", { dispatcher: ssrfDispatcher, signal: AbortSignal.timeout(5000) }); } catch (e) { connectErr = e; }
const connectMs = performance.now() - t;
ok(isSsrfBlock(connectErr) && connectMs < 1000 && performance.now() < firstPoolDone, `the connect-time lookup refuses a private answer in ${Math.round(connectMs)} ms while the pool is full`);

// A private answer at the upfront check is the same neutral 400.
const priv = await assertPublicUrl("https://priv.pool.test/").catch((e) => e);
ok(priv?.statusCode === 400, `a private answer at the upfront check is a 400 (${priv?.statusCode})`);

// The slow names end at their bound as the retryable 503, the pool still full.
const ended = await Promise.all(slow);
ok(ended.every((r) => r.e?.statusCode === 503 && r.e.message === LOOKUP_UNAVAILABLE && r.ms < 3000), `eight unanswered names are each a 503 at the bound (${ended.map((r) => r.e?.statusCode ?? "ok").join(",")}; slowest ${Math.round(Math.max(...ended.map((r) => r.ms || 0)))} ms)`);
const dupEnded = await Promise.all(dup);
ok(dupEnded.every((e) => e?.statusCode === 503), "fifty checks of one unanswered name all end as the 503");
ok((queries.get("slow-dup.pool.test A") || 0) === 1, `concurrent checks of one name share one query (${queries.get("slow-dup.pool.test A") || 0} A queries)`);

const controlMs = await control;
ok(controlMs > 1000, `(control) a getaddrinfo lookup waited ${Math.round(controlMs)} ms for the full pool`);
await Promise.all(poolWork);
server.close();
console.log(`\ntest-dns-pool-starvation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
