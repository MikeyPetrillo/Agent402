// Every request safeFetch and probePublicUrl send, the first and each redirect
// hop, passes the public-address check before anything is sent, and the
// connection goes to the address the connect-time check approved (no gap for a
// DNS answer that changes between the check and the connect). Covers http and
// https, IPv4 and IPv6 literals, the decimal, octal, hex and short spellings of
// loopback, localhost names, and cloud metadata addresses, on the first URL, on
// a hop the caller decides (beforeRedirect: safeFetch follows it itself) and on
// a hop the fetch follows.
//   node scripts/test-ssrf-redirect-hops.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import http from "node:http";
import net from "node:net";
import { stubGuardResolver, stubGuardLookup, resolverError } from "./lib/guard-resolver-stub.js";
import { isHost } from "./lib/url-host.js";
import { safeFetch, probePublicUrl, isPrivateIp, isSsrfBlock, UNRESOLVED_OR_PRIVATE } from "../src/tools/fetch-guard.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// A real local service stands in for an internal one: any request that reaches
// it is a failure.
let hits = 0;
const srv = http.createServer((req, res) => { hits++; res.end("INTERNAL"); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const P = srv.address().port;

// Every socket this process opens is watched. The address a socket's lookup
// gave is recorded, and a socket to anything but this machine is ended right
// there, before it connects, so nothing leaves the process. Every connection
// attempt is recorded with its address.
const lookedUp = [];
const attempts = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function watchedConnect(...args) {
  this.on("lookup", (err, address) => {
    if (err) return;
    lookedUp.push(address);
    if (address !== "127.0.0.1" && address !== "::1") this.destroy(new Error("test: stopped before connect"));
  });
  this.on("connectionAttempt", (address) => attempts.push(address));
  return realConnect.apply(this, args);
};

// Names: a public origin, a metadata name with a metadata answer, *.localhost
// as loopback, a name whose answer changes after the first query (rebinding),
// a public name the connection may use; every other name has no answer.
const queries = new Map();
const PUBLIC = "93.184.215.14";
const restoreResolver = stubGuardResolver((h, family) => {
  const name = h.toLowerCase().replace(/\.$/, "");
  const n = (queries.get(name) || 0) + 1;
  queries.set(name, n);
  const v4 = (a) => (family === 4 ? [a] : Promise.reject(resolverError("ENODATA", h)));
  if (name === "public-origin.example" || name === "pinned.example") return v4(PUBLIC);
  if (name === "metadata.google.internal") return v4("169.254.169.254");
  if (name.endsWith(".localhost")) return family === 4 ? ["127.0.0.1"] : ["::1"];
  // Public to the first query of each round, loopback after.
  if (name === "rebind.example") return v4(n === 1 ? PUBLIC : "127.0.0.1");
  return Promise.reject(resolverError("ENOTFOUND", h));
});
const restoreLookup = stubGuardLookup((h) => { throw resolverError("ENOTFOUND", h); });

const hostile = [
  "127.0.0.1", "2130706433", "0177.0.0.1", "0x7f.0.0.1", "0x7f000001", "127.1", "0", "0.0.0.0",
  "[::1]", "[::ffff:127.0.0.1]", "[0:0:0:0:0:ffff:7f00:1]", "[::]",
  "localhost", "LOCALHOST.", "app.localhost",
  "169.254.169.254", "2852039166", "[fd00:ec2::254]", "[::ffff:169.254.169.254]", "metadata.google.internal", "100.100.100.200",
];
const urls = [];
for (const scheme of ["http", "https"]) for (const h of hostile) urls.push(`${scheme}://${h}:${P}/latest/meta-data/`);

const refusedAsPrivate = (e) => e?.statusCode === 400 && e.message === UNRESOLVED_OR_PRIVATE;
const attempt = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const realFetch = globalThis.fetch;

// 1. The first URL: refused before any lookup reaches a socket.
{
  let bad = [];
  for (const u of urls) {
    const a = await attempt(() => safeFetch(u, { timeoutMs: 2000 }));
    const b = await attempt(() => probePublicUrl(u, { timeoutMs: 2000 }));
    if (!refusedAsPrivate(a) || !refusedAsPrivate(b)) bad.push(`${u} (${a?.statusCode ?? "sent"}/${b?.statusCode ?? "sent"})`);
  }
  ok(bad.length === 0, `first URL: all ${urls.length} hostile spellings refused by safeFetch and probePublicUrl with one 400 ${bad.slice(0, 3).join(", ")}`);
  ok(attempts.length === 0, `first URL: no connection attempted (${attempts.join(",")})`);
}

// 2. A hop safeFetch follows itself (the caller decides each hop): the stubbed
// first answer redirects to the hostile URL; the hop is refused by the address
// check before any request for it is made.
{
  const bad = [];
  let hopRequests = 0, decided = 0;
  for (const u of urls) {
    globalThis.fetch = async (target, init) => {
      if (isHost(target, "public-origin.example")) return new Response(null, { status: 302, headers: { location: u } });
      hopRequests++;
      return realFetch(target, init);
    };
    const e = await attempt(() => safeFetch("https://public-origin.example/start", { timeoutMs: 2000, beforeRedirect: () => { decided++; } }));
    globalThis.fetch = realFetch;
    if (!refusedAsPrivate(e)) bad.push(`${u} (${e?.statusCode ?? "followed"} ${e?.message ?? ""})`);
  }
  ok(bad.length === 0, `caller-decided hop: all ${urls.length} hostile Locations refused with one 400 ${bad.slice(0, 3).join(", ")}`);
  ok(decided === urls.length, `caller-decided hop: the caller saw each hop before it was sent (${decided})`);
  ok(hopRequests === 0, `caller-decided hop: the address check refused every hop before its request was made (${hopRequests} requests)`);
  ok(attempts.length === 0, `caller-decided hop: no connection attempted (${attempts.join(",")})`);
}

// 3. A hop the fetch follows: every connection, each hop included, goes
// through the dispatcher, which refuses a hostile address at connect.
{
  const bad = [];
  for (const u of urls) {
    globalThis.fetch = (target, init) => realFetch(isHost(target, "public-origin.example") ? u : target, init);
    const e = await attempt(() => safeFetch("https://public-origin.example/start", { timeoutMs: 2000 }));
    globalThis.fetch = realFetch;
    if (!refusedAsPrivate(e)) bad.push(`${u} (${e?.statusCode ?? "followed"} ${e?.message ?? ""})`);
  }
  ok(bad.length === 0, `followed hop: all ${urls.length} hostile hosts refused at connect with one 400 ${bad.slice(0, 3).join(", ")}`);
  ok(attempts.length === 0, `followed hop: no connection attempted (${attempts.join(",")})`);
}

// 4. Rebinding: the name answers public to the up-front check and loopback
// after. The connection uses the connect-time answer, which the dispatcher
// checks, so it is refused; nothing connects to the loopback answer.
{
  const before = lookedUp.length;
  queries.delete("rebind.example");
  const a = await attempt(() => safeFetch(`http://rebind.example:${P}/`, { timeoutMs: 2000 }));
  ok(refusedAsPrivate(a) && queries.get("rebind.example") >= 2, `rebinding on the first URL: up-front check passed, connect-time answer refused (${a?.statusCode}, ${queries.get("rebind.example")} queries)`);
  queries.delete("rebind.example");
  const b = await attempt(() => probePublicUrl(`http://rebind.example:${P}/`, { timeoutMs: 2000 }));
  // probePublicUrl hands back the fetch's own error: the connection refusal itself.
  ok(isSsrfBlock(b), `rebinding on probePublicUrl: refused at connect (${b?.cause?.code ?? b?.message})`);
  // On a caller-decided hop: the hop's own up-front check sees the public
  // answer, the connection sees loopback and is refused.
  queries.delete("rebind.example");
  globalThis.fetch = async (target, init) => (isHost(target, "public-origin.example") ? new Response(null, { status: 301, headers: { location: `https://rebind.example:${P}/` } }) : realFetch(target, init));
  const c = await attempt(() => safeFetch("https://public-origin.example/", { timeoutMs: 2000, beforeRedirect: () => {} }));
  globalThis.fetch = realFetch;
  ok(refusedAsPrivate(c) && queries.get("rebind.example") >= 2, `rebinding on a hop: refused at connect after the hop's check passed (${c?.statusCode}, ${queries.get("rebind.example")} queries)`);
  ok(lookedUp.length === before, `rebinding: no socket was given the loopback answer (${lookedUp.slice(before).join(",")})`);
  ok(attempts.length === 0, `rebinding: no connection attempted (${attempts.join(",")})`);
}

// 5. The connection uses the address the connect-time check approved: a
// public name's socket is handed exactly the checked answer (and stopped
// there, before connecting), on the first URL and on a caller-decided hop.
{
  const before = lookedUp.length;
  await attempt(() => safeFetch("https://pinned.example/", { timeoutMs: 2000 }));
  globalThis.fetch = async (target, init) => (isHost(target, "public-origin.example") ? new Response(null, { status: 302, headers: { location: "http://pinned.example/next" } }) : realFetch(target, init));
  await attempt(() => safeFetch("https://public-origin.example/", { timeoutMs: 2000, beforeRedirect: () => {} }));
  globalThis.fetch = realFetch;
  const got = lookedUp.slice(before);
  ok(got.length >= 2 && got.every((a) => a === PUBLIC), `the socket is given the checked public address, first URL and hop (${got.join(",")})`);
  ok(got.every((a) => !isPrivateIp(a)), "no socket was given a private address");
}

net.Socket.prototype.connect = realConnect;
restoreResolver(); restoreLookup();
ok(hits === 0, `the internal service was never reached (${hits} hits)`);
srv.close();
console.log(`\ntest-ssrf-redirect-hops: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
