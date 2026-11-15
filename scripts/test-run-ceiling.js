#!/usr/bin/env node
// A run's ceiling (src/run-ceiling.js): every tool definition marked
// `endsAtCeiling` must END its upstream work at the ceiling and START none
// after it. This guard drives each marked tool's published example against
// stand-ins it controls (the address guard's name lookups, global fetch, the
// TLS connect and the reverse lookup), under a short ceiling, and fails when
//   - a handler is still running well after its ceiling,
//   - an upstream request, connection or lookup starts after the ceiling,
//   - a request in flight is not aborted at the ceiling, or
//   - a handler turns a read the ceiling cut into an answer.
// A tool that gains another kind of upstream wait fails here until that wait
// observes the ceiling, or the tool leaves the list.
//
//   node scripts/test-run-ceiling.js
//
// Nothing leaves this process: every upstream is a stand-in.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import tls from "node:tls";
import { EventEmitter } from "node:events";
import dnsPromises from "node:dns/promises";
import { stubGuardResolver, offlineGuardAnswer } from "./lib/guard-resolver-stub.js";

const { withRunCeiling, ceilingLeftMs } = await import("../src/run-ceiling.js");
const kits = await Promise.all(["kit.js", "gov-kit.js", "data-kit.js", "geo-kit.js", "weather-kit.js", "macro-kit.js"].map((f) => import(`../src/tools/${f}`)));
const MARKED = kits.flatMap((m) => Object.values(m).filter(Array.isArray).flat()).filter((d) => d && d.endsAtCeiling === true && typeof d.handler === "function");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the stand-ins --------------------------------------------------------------
const world = { dnsMs: 0, upstream: "stall", t0: 0, starts: [], aborts: [] };
const note = (kind, what) => { const e = { kind, what, at: Date.now() - world.t0, endedAt: null }; world.starts.push(e); return e; };
stubGuardResolver((host, family) => {
  const e = note("lookup", host);
  return new Promise((res, rej) => setTimeout(() => { e.endedAt = Date.now() - world.t0; try { Promise.resolve(offlineGuardAnswer(host, family)).then(res, rej); } catch (err) { rej(err); } }, world.dnsMs));
});
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  let host = "?"; try { host = new URL(String(input?.url ?? input)).host; } catch { /* kept as ? */ }
  const e = note("fetch", host);
  if (world.upstream === "500") { e.endedAt = e.at; return Promise.resolve(new Response("upstream error", { status: 500, headers: { "content-type": "text/plain" } })); }
  if (world.upstream === "ok") { e.endedAt = e.at; return Promise.resolve(new Response(JSON.stringify({ services: [[["com"], ["https://rdap.registry.example/"]]] }), { status: 200, headers: { "content-type": "application/json" } })); }
  return new Promise((_res, rej) => {
    const signal = init.signal;
    const end = () => { e.endedAt = Date.now() - world.t0; rej(signal.reason ?? Object.assign(new Error("This operation was aborted"), { name: "AbortError" })); };
    if (!signal) return; // no signal: it never ends, and the guard says so
    if (signal.aborted) return end();
    signal.addEventListener("abort", end, { once: true });
  });
};
const realConnect = tls.connect;
tls.connect = (opts) => {
  const e = note("tls", String(opts?.host));
  const socket = new EventEmitter();
  socket.destroy = () => { if (e.endedAt === null) { e.endedAt = Date.now() - world.t0; setImmediate(() => socket.emit("close")); } };
  socket.end = socket.destroy;
  return socket; // never connects: it ends only when it is destroyed
};
const R = dnsPromises.Resolver.prototype;
const realReverse = R.reverse, realCancel = R.cancel;
const pendingReverse = new WeakMap();
R.reverse = function stubReverse(ip) {
  const e = note("reverse", String(ip));
  return new Promise((_res, rej) => { pendingReverse.set(this, () => { e.endedAt = Date.now() - world.t0; rej(Object.assign(new Error("cancelled"), { code: "ECANCELLED" })); }); });
};
R.cancel = function stubCancel() { const end = pendingReverse.get(this); if (end) { pendingReverse.delete(this); end(); } };

/** Run one handler under a ceiling; what it started, when each ended, how it came back. */
async function drive(def, input, { ceilingMs, dnsMs, upstream }) {
  Object.assign(world, { dnsMs, upstream, t0: Date.now(), starts: [] });
  const started = world.starts;
  let out;
  // A handler that never comes back is a failure of its own, named (the race's timer keeps the process up).
  try { out = await Promise.race([withRunCeiling(ceilingMs, () => def.handler(structuredClone(input))).then((value) => ({ value })), wait(4000).then(() => ({ hung: true }))]); }
  catch (err) { out = { error: err }; }
  const endedMs = Date.now() - world.t0;
  await wait(120); // anything that starts late shows up here
  return { endedMs, out, started, late: started.filter((e) => e.at > ceilingMs + 25), unended: started.filter((e) => e.kind !== "lookup" && e.endedAt === null), overran: started.filter((e) => e.kind !== "lookup" && e.endedAt !== null && e.endedAt > ceilingMs + 150) };
}
const describe = (r) => `ended ${r.endedMs} ms; ${r.started.map((e) => `${e.kind} ${e.what}@${e.at}${e.endedAt === null ? " NOT ENDED" : `-${e.endedAt}`}`).join(", ") || "nothing started"}; ${r.out.hung ? "NEVER CAME BACK" : r.out.error ? `error ${r.out.error.statusCode ?? r.out.error.message}` : `VALUE ${JSON.stringify(r.out.value).slice(0, 80)}`}`;

try {
  ok(MARKED.length === 36 && ceilingLeftMs() === Infinity, `36 tool definitions declare that their upstream work ends at a run's ceiling (${MARKED.length}), and this suite itself runs with none`);

  // 1. A slow name lookup (longer than the ceiling) and an upstream that never answers.
  const CEILING = 300;
  const slowDns = [];
  for (const def of MARKED) {
    const r = await drive(def, def.discovery?.input || {}, { ceilingMs: CEILING, dnsMs: 700, upstream: "stall" });
    const bad = r.endedMs > CEILING + 250 || r.late.length || r.unended.length || r.overran.length || !r.out.error;
    if (bad) slowDns.push(`${def.slug}: ${describe(r)}`);
  }
  ok(slowDns.length === 0, `with name lookups slower than the ceiling and an upstream that never answers, every marked tool ends at its ceiling, starts nothing after it and returns no answer (${slowDns.join(" | ") || "36 of 36"})`);

  // 2. Fast lookups, the upstream never answers: the request in flight is aborted AT the ceiling.
  const stalled = [];
  let requests = 0;
  for (const def of MARKED) {
    const r = await drive(def, def.discovery?.input || {}, { ceilingMs: CEILING, dnsMs: 0, upstream: "stall" });
    requests += r.started.filter((e) => e.kind !== "lookup").length;
    const bad = r.endedMs > CEILING + 250 || r.late.length || r.unended.length || r.overran.length || !r.out.error;
    if (bad) stalled.push(`${def.slug}: ${describe(r)}`);
  }
  ok(stalled.length === 0 && requests >= 30, `with an upstream that never answers, every marked tool's request in flight is ended at the ceiling (none left running, none started after it, no answer returned) (${stalled.join(" | ") || `36 of 36, ${requests} upstream calls ended`})`);

  // 3. The upstream answers 500 at once: retries stop at the ceiling.
  const retried = [];
  for (const def of MARKED) {
    const r = await drive(def, def.discovery?.input || {}, { ceilingMs: 200, dnsMs: 0, upstream: "500" });
    const late = r.started.filter((e) => e.at > 200 + 25);
    if (late.length || r.endedMs > 200 + 450) retried.push(`${def.slug}: ${describe(r)}`);
  }
  ok(retried.length === 0, `with an upstream that answers 500, no retry starts after the ceiling (${retried.join(" | ") || "36 of 36"})`);

  // 4. tls-cert on a literal address (no lookup): the connection itself is ended at the ceiling, as a 504.
  const tlsDef = MARKED.find((d) => d.slug === "tls-cert");
  const tlsRun = await drive(tlsDef, { host: "93.184.216.34" }, { ceilingMs: CEILING, dnsMs: 0, upstream: "stall" });
  const conn = tlsRun.started.find((e) => e.kind === "tls");
  ok(conn && conn.endedAt !== null && conn.endedAt >= CEILING - 20 && conn.endedAt <= CEILING + 150 && tlsRun.out.error?.statusCode === 504 && tlsRun.out.error.ceilingCut === true && tlsRun.endedMs <= CEILING + 250, `tls-cert's connection is destroyed at the ceiling and the run reads 504, where its own idle timeout is 10 s (${describe(tlsRun)})`);

  // 5. ip-info: the reverse lookup is canceled at the ceiling, and that is a 504, never "no PTR record".
  const ipRun = await drive(MARKED.find((d) => d.slug === "ip-info"), { ip: "8.8.8.8" }, { ceilingMs: CEILING, dnsMs: 0, upstream: "stall" });
  const rev = ipRun.started.find((e) => e.kind === "reverse");
  ok(rev && rev.endedAt !== null && rev.endedAt <= CEILING + 150 && ipRun.out.error?.statusCode === 504, `ip-info's reverse lookup is canceled at the ceiling and the run reads 504 (${describe(ipRun)})`);

  // 6. A read the ceiling cut is never an answer: the handlers that turn a failed read into a result.
  const asAnswer = [];
  for (const [slug, input] of [["http-check", { url: "http://93.184.216.34/" }], ["robots-check", { url: "http://93.184.216.34/page" }], ["ip-info", { ip: "8.8.8.8" }]]) {
    const r = await drive(MARKED.find((d) => d.slug === slug), input, { ceilingMs: CEILING, dnsMs: 0, upstream: "stall" });
    if (!(r.out.error?.statusCode === 504)) asAnswer.push(`${slug}: ${describe(r)}`);
  }
  ok(asAnswer.length === 0, `http-check, robots-check and ip-info answer 504 when the ceiling ended their read: never "down", "no robots.txt" or "no PTR record" (${asAnswer.join(" | ") || "3 of 3"})`);

  // 7. With NO ceiling the same handlers keep their own behavior (http-check's own answer for an aborted read is untouched).
  {
    Object.assign(world, { dnsMs: 0, upstream: "500", t0: Date.now(), starts: [] });
    const robots = await MARKED.find((d) => d.slug === "robots-check").handler({ url: "http://93.184.216.34/page" });
    ok(robots?.allowed === true && /No readable robots\.txt/.test(robots.note || ""), "with no ceiling a failed robots.txt read is still the direct route's own answer");
  }

  // 8. whois: a registry-list refresh the ceiling cut is not remembered as a failed refresh.
  {
    const whois = MARKED.find((d) => d.slug === "whois");
    const cut = await drive(whois, { domain: "example.com" }, { ceilingMs: CEILING, dnsMs: 0, upstream: "stall" });
    Object.assign(world, { dnsMs: 0, upstream: "ok", t0: Date.now(), starts: [] });
    await whois.handler({ domain: "example.com" }).catch(() => null);
    const asked = world.starts.filter((e) => e.kind === "fetch" && e.what === "data.iana.org").length;
    ok(cut.started.some((e) => e.what === "data.iana.org") && cut.started.filter((e) => e.kind === "fetch").length === 1 && asked === 1, `a whois run cut during the registry-list refresh starts no further read, and the next run asks for the list again instead of backing off for ten minutes (${asked} request after the cut)`);
  }
} finally {
  globalThis.fetch = realFetch;
  tls.connect = realConnect;
  R.reverse = realReverse;
  R.cancel = realCancel;
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
