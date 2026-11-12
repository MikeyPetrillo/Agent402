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
// A answers; AAAA answers (16-byte addresses) only where listed.
const ANSWERS = { "good.pool.test": "93.184.215.14", "priv.pool.test": "10.9.8.7", "mixed.pool.test": "93.184.215.14" };
const AAAA = { "mixed.pool.test": Buffer.from("fd000000000000000000000000000001", "hex") };
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
  // The name server turns these away at once: REFUSED (rcode 5) and SERVFAIL (rcode 2).
  const rcode = name.startsWith("refused-") ? 5 : name === "servfail.pool.test" ? 2 : 0;
  if (name === "half.pool.test" && qtype === 28) return; // A answered with no data, AAAA never
  if (!(name in ANSWERS) && name !== "half.pool.test" && !rcode) return; // the slow names: never answered
  const question = msg.subarray(12, end + 4);
  const header = Buffer.alloc(12);
  msg.copy(header, 0, 0, 2); // id
  header.writeUInt16BE(0x8180 | rcode, 2); // response, recursion desired and available, NOERROR unless refused
  header.writeUInt16BE(1, 4); // one question
  const answers = [];
  if (qtype === 1 && ANSWERS[name]) {
    const rr = Buffer.alloc(16);
    rr.writeUInt16BE(0xc00c, 0); rr.writeUInt16BE(1, 2); rr.writeUInt16BE(1, 4); rr.writeUInt32BE(30, 6); rr.writeUInt16BE(4, 10);
    ANSWERS[name].split(".").forEach((o, i) => { rr[12 + i] = Number(o); });
    answers.push(rr);
  }
  if (qtype === 28 && AAAA[name]) {
    const rr = Buffer.alloc(28);
    rr.writeUInt16BE(0xc00c, 0); rr.writeUInt16BE(28, 2); rr.writeUInt16BE(1, 4); rr.writeUInt32BE(30, 6); rr.writeUInt16BE(16, 10);
    AAAA[name].copy(rr, 12);
    answers.push(rr);
  }
  header.writeUInt16BE(answers.length, 6); // otherwise no data
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
// The OS-resolver fallback (dns.lookup, taken only when the name server
// refuses a query at once) is answered here, counted per name.
const osLookups = new Map();
const OS_ANSWERS = {
  "refused-pub.pool.test": [{ address: "93.184.215.14", family: 4 }],
  "refused-mixed.pool.test": [{ address: "93.184.215.14", family: 4 }, { address: "fd00::7", family: 6 }],
};
const realLookup = dnsPromises.lookup;
dnsPromises.lookup = async (host, opts) => {
  osLookups.set(host, (osLookups.get(host) || 0) + 1);
  if (!opts?.all) throw new Error("the fallback must ask for every address");
  if (OS_ANSWERS[host]) return OS_ANSWERS[host].filter((a) => !opts.family || a.family === opts.family);
  throw Object.assign(new Error(`stub ENOTFOUND ${host}`), { code: "ENOTFOUND" });
};
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
// Every answer is checked: a public A beside a private AAAA is refused.
const mixed = await assertPublicUrl("https://mixed.pool.test/").catch((e) => e);
ok(mixed?.statusCode === 400 && (await hostIsPublic("mixed.pool.test")) === false, `a public A beside a private AAAA is refused (${mixed?.statusCode ?? "passed"})`);

// A name with no A record whose AAAA query is never answered may still have a
// public AAAA: the retryable 503, not the 400 for a name with no address.
const half = await assertPublicUrl("https://half.pool.test/").catch((e) => e);
ok(half?.statusCode === 503 && half.message === LOOKUP_UNAVAILABLE, `no A and an unanswered AAAA is the retryable 503 (${half?.statusCode})`);

// A name server that answers REFUSED: the OS resolver answers once instead,
// and every address it gives is checked like a c-ares answer.
const rPub = await assertPublicUrl("https://refused-pub.pool.test/").catch((e) => e);
ok(rPub instanceof URL && osLookups.get("refused-pub.pool.test") >= 1, `a REFUSED query falls back to the OS resolver and a public answer passes (${rPub instanceof URL ? "public" : `${rPub?.statusCode} ${rPub?.message}`})`);
const rMixed = await assertPublicUrl("https://refused-mixed.pool.test/").catch((e) => e);
ok(rMixed?.statusCode === 400 && (await hostIsPublic("refused-mixed.pool.test")) === false, `the fallback's every address is checked: a private AAAA beside a public A is refused (${rMixed?.statusCode ?? "passed"})`);
const rNone = await assertPublicUrl("https://refused-none.pool.test/").catch((e) => e);
ok(rNone?.statusCode === 400, `a REFUSED query whose fallback finds no such name is the neutral 400 (${rNone?.statusCode})`);
let rConnect = null;
try { await fetch("http://refused-none.pool.test:8081/", { dispatcher: ssrfDispatcher, signal: AbortSignal.timeout(5000) }); } catch (e) { rConnect = e; }
ok(isSsrfBlock(rConnect), "the connect-time pin takes the same fallback and refuses a name it cannot resolve");
// SERVFAIL stays on c-ares: the retryable 503, no OS lookup.
const sf = await assertPublicUrl("https://servfail.pool.test/").catch((e) => e);
ok(sf?.statusCode === 503 && !osLookups.has("servfail.pool.test"), `a SERVFAIL is the retryable 503 with no OS lookup (${sf?.statusCode}, ${osLookups.get("servfail.pool.test") || 0} lookups)`);

// The slow names end at their bound as the retryable 503, the pool still full.
const ended = await Promise.all(slow);
ok(ended.every((r) => r.e?.statusCode === 503 && r.e.message === LOOKUP_UNAVAILABLE && r.ms < 3000), `eight unanswered names are each a 503 at the bound (${ended.map((r) => r.e?.statusCode ?? "ok").join(",")}; slowest ${Math.round(Math.max(...ended.map((r) => r.ms || 0)))} ms)`);
const dupEnded = await Promise.all(dup);
ok(dupEnded.every((e) => e?.statusCode === 503), "fifty checks of one unanswered name all end as the 503");
ok(![...osLookups.keys()].some((h) => h.startsWith("slow")), `a timed-out query never falls back to the OS resolver (${[...osLookups.keys()].join(",")})`);
ok((queries.get("slow-dup.pool.test A") || 0) === 1, `concurrent checks of one name share one query (${queries.get("slow-dup.pool.test A") || 0} A queries)`);

// The query itself, not only the caller's wait, ends near the bound: c-ares
// grows the per-try timeout on each retry, so without a ceiling on it three
// tries to one unanswering server kept a query alive well past the 10 s
// bound (about 13 s measured). Run in a fresh process whose resolver has
// never heard from its server: c-ares shortens later timeouts from the
// latencies it has seen, so this process's resolver would hide the growth.
{
  const child = `
    import ${JSON.stringify(new URL("./lib/offline-stores.js", import.meta.url).href)};
    import dgram from "node:dgram";
    import dnsPromises from "node:dns/promises";
    const s = dgram.createSocket("udp4"); let n = 0; s.on("message", () => { n++; });
    await new Promise((r) => s.bind(0, "127.0.0.1", r));
    const P = dnsPromises.Resolver.prototype, real = P.resolve4;
    P.resolve4 = function (...a) { if (!this.__t) { this.setServers(["127.0.0.1:" + s.address().port]); this.__t = true; } return real.apply(this, a); };
    process.env.DNS_LOOKUP_TIMEOUT_MS = "60000";
    const { resolveHostAddresses } = await import(${JSON.stringify(new URL("../src/tools/fetch-guard.js", import.meta.url).href)});
    const t = performance.now();
    const e = await resolveHostAddresses("never-answered.pool.test", { families: [4] }).catch((x) => x);
    console.log(JSON.stringify({ code: e?.code, ms: Math.round(performance.now() - t), tries: n }));
    s.close();
  `;
  const { execFileSync } = await import("node:child_process");
  const { childJson } = await import("./lib/child-json.js");
  const r = childJson(execFileSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8", timeout: 30_000 }));
  ok(r.code === "ETIMEOUT" && r.ms < 11_000 && r.tries === 3, `an unanswered query is given up by the resolver after ${r.tries} tries in ${r.ms} ms, near the 10000 ms bound (${r.code})`);
}

// A name server with nothing on its port (ECONNREFUSED): the same single
// fallback, in a fresh process whose resolver points at a closed port.
{
  const child = `
    import ${JSON.stringify(new URL("./lib/offline-stores.js", import.meta.url).href)};
    import dgram from "node:dgram";
    import dnsPromises from "node:dns/promises";
    const s = dgram.createSocket("udp4");
    await new Promise((r) => s.bind(0, "127.0.0.1", r));
    const closed = s.address().port; s.close();
    const P = dnsPromises.Resolver.prototype, r4 = P.resolve4, r6 = P.resolve6;
    const point = function (real) { return function (...a) { if (!this.__t) { this.setServers(["127.0.0.1:" + closed]); this.__t = true; } return real.apply(this, a); }; };
    P.resolve4 = point(r4); P.resolve6 = point(r6);
    let lookups = 0;
    dnsPromises.lookup = async (h, o) => { lookups++; return h === "closed-pub.pool.test" ? [{ address: "93.184.215.14", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]; };
    const { resolveHostAddresses, assertPublicUrl } = await import(${JSON.stringify(new URL("../src/tools/fetch-guard.js", import.meta.url).href)});
    const t = performance.now();
    const pub = await resolveHostAddresses("closed-pub.pool.test").then((a) => a.map((x) => x.address).join(","), (e) => "ERR " + e.code);
    const loop = await assertPublicUrl("https://closed-loop.pool.test/").then(() => 200, (e) => e.statusCode);
    console.log(JSON.stringify({ pub, loop, lookups, ms: Math.round(performance.now() - t) }));
  `;
  const { execFileSync } = await import("node:child_process");
  const { childJson } = await import("./lib/child-json.js");
  const r = childJson(execFileSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8", timeout: 30_000 }));
  ok(r.pub === "93.184.215.14" && r.loop === 400 && r.lookups === 2 && r.ms < 2000, `a closed name server port falls back to the OS resolver once per name, and its answer is checked (${JSON.stringify(r)})`);
}

const controlMs = await control;
ok(controlMs > 1000, `(control) a getaddrinfo lookup waited ${Math.round(controlMs)} ms for the full pool`);
await Promise.all(poolWork);
server.close();
dnsPromises.lookup = realLookup;
console.log(`\ntest-dns-pool-starvation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
