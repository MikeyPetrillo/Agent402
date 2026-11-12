// The SSRF dispatcher refuses a literal private IP, not only a hostname that
// resolves to one: Node skips DNS for a literal, so the lookup-based check
// never ran for http://127.0.0.1/ or http://[::1]/ (and so a redirect hop to
// one was followed). A real local server stands in for an internal service.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import http from "node:http";
import { stubGuardResolver, resolverError } from "./lib/guard-resolver-stub.js";
import { ssrfDispatcher, freshSsrfDispatcher, isSsrfBlock, isPrivateIp, assertPublicUrl, safeFetch, UNRESOLVED_OR_PRIVATE, LOOKUP_UNAVAILABLE, LOOKUP_RETRY_AFTER_S, isTransientLookupError } from "../src/tools/fetch-guard.js";

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
// IPv4-translated (::ffff:0:0:0/96) and local-use NAT64 (64:ff9b:1::/48)
// literals carry an IPv4 address and are read as one.
for (const lit of ["::ffff:0:7f00:1", "::ffff:0:a00:1", "::ffff:0:a9fe:a9fe", "64:ff9b:1::7f00:1", "64:ff9b:1::a00:1", "64:ff9b:1:ab::1"]) {
  ok(isPrivateIp(lit), `isPrivateIp(${lit}) is true`);
  let refused = null;
  try { await assertPublicUrl(`http://[${lit}]:${port}/`); } catch (e) { refused = e; }
  ok(refused?.statusCode === 400 && refused.message === UNRESOLVED_OR_PRIVATE, `assertPublicUrl refuses [${lit}] (${refused?.message ?? "allowed"})`);
  const d = await tryFetch(`http://[${lit}]:${port}/`, ssrfDispatcher);
  ok(d.err && isSsrfBlock(d.err), `the dispatcher refuses [${lit}] at connect`);
}
for (const lit of ["::ffff:0:808:808", "64:ff9b:1::808:808", "64:ff9b::808:808"]) ok(!isPrivateIp(lit), `isPrivateIp(${lit}) is false (a public v4 inside)`);

// A redirect hop to a name with a private answer and a hop to a name that does
// not resolve read the same: one code at connect, one 400 and one sentence
// from safeFetch. Emulated hop: the first URL passes the upfront check, then
// the connection goes to the hop target through the real dispatcher.
{
  const priv = await tryFetch(`http://localhost:${port}/`, ssrfDispatcher);
  const none = await tryFetch("http://nonexistent-zz9.invalid/", ssrfDispatcher);
  ok(isSsrfBlock(priv.err) && isSsrfBlock(none.err), "dispatcher: an unresolved name and a private one are both refused as blocked");
  const msg = (e) => { for (let x = e; x; x = x.cause) if (x.code === "ESSRFBLOCKED") return x.message; return null; };
  ok(msg(priv.err) === msg(none.err) && msg(priv.err) === UNRESOLVED_OR_PRIVATE, `dispatcher: both carry one message (${msg(priv.err)} | ${msg(none.err)})`);
  const real = globalThis.fetch;
  const viaHop = async (hop, opts = {}) => {
    globalThis.fetch = (u, o) => real(hop, o);
    try { await safeFetch("https://example.com/", opts); return null; } catch (e) { return e; } finally { globalThis.fetch = real; }
  };
  const a = await viaHop(`http://localhost:${port}/`);
  const b = await viaHop("http://nonexistent-zz9.invalid/");
  const c = await viaHop(`http://127.0.0.1:${port}/`);
  ok(a?.statusCode === 400 && b?.statusCode === 400 && c?.statusCode === 400, `safeFetch hop: private name, unresolved name and private literal are all 400 (${a?.statusCode}/${b?.statusCode}/${c?.statusCode})`);
  ok(a?.message === UNRESOLVED_OR_PRIVATE && b?.message === a?.message && c?.message === a?.message, `safeFetch hop: one sentence for all three (${b?.message})`);
  // A public host that does not answer is a different failure and stays a 504.
  globalThis.fetch = (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  let slow = null;
  try { await safeFetch("https://example.com/", { timeoutMs: 50 }); } catch (e) { slow = e; } finally { globalThis.fetch = real; }
  ok(slow?.statusCode === 504 && /did not respond/.test(slow.message), `a host that does not answer stays a 504 (${slow?.statusCode} ${slow?.message})`);
  globalThis.fetch = async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }); };
  let ct = null;
  try { await safeFetch("https://example.com/"); } catch (e) { ct = e; } finally { globalThis.fetch = real; }
  ok(ct?.statusCode === 504 && /UND_ERR_CONNECT_TIMEOUT/.test(ct.message), `a connect timeout stays a 504 (${ct?.message})`);
}
// A resolver that could not answer is not a name without an answer. Stubbed
// resolver, one error code at a time: "no such name" and a private answer
// stay one 400 and one sentence; a resolver failure or a lookup that does not
// finish is a retryable 503 that names no address class, at the upfront check
// and at connect (a redirect hop) alike.
{
  // The guard resolves with dns.Resolver (resolve4/resolve6), at the upfront
  // check and at connect alike; the stub answers both families.
  let mode = null;
  const restoreResolver = stubGuardResolver((h, family) => {
    if (mode === null) return undefined;
    if (mode === "PRIVATE") return family === 4 ? ["10.1.2.3"] : Promise.reject(resolverError("ENODATA"));
    if (mode === "PUBLIC") return family === 4 ? ["93.184.215.14"] : Promise.reject(resolverError("ENODATA"));
    // A public A listed first beside a private A: every answer is checked at connect, not the first.
    if (mode === "MIXED") return family === 4 ? ["93.184.215.14", "10.1.2.3"] : Promise.reject(resolverError("ENODATA"));
    if (mode === "HANG") return new Promise(() => {});
    return Promise.reject(resolverError(mode));
  });
  process.env.DNS_LOOKUP_TIMEOUT_MS = "100";
  const upfront = async (m) => { mode = m; try { await assertPublicUrl("https://some-host.example/x"); return null; } catch (e) { return e; } };
  const real = globalThis.fetch;
  // The upfront check passes (PUBLIC), then the connection resolves the hop
  // through the dispatcher's own lookup, which answers `m`.
  const hop = async (m) => {
    mode = "PUBLIC";
    globalThis.fetch = (u, o) => { mode = m; return real("http://hop-target.example/", o); };
    try { await safeFetch("https://some-host.example/"); return null; } catch (e) { return e; } finally { globalThis.fetch = real; }
  };
  for (const m of ["ENOTFOUND", "ENODATA", "EAI_FAIL", "PRIVATE", "MIXED"]) {
    const e = await upfront(m);
    ok(e?.statusCode === 400 && e.message === UNRESOLVED_OR_PRIVATE && e.retryAfter === undefined, `lookup ${m}: one 400, one sentence (${e?.statusCode} ${e?.message})`);
    const h = await hop(m);
    ok(h?.statusCode === 400 && h.message === UNRESOLVED_OR_PRIVATE, `hop ${m}: one 400, one sentence (${h?.statusCode} ${h?.message})`);
  }
  for (const m of ["EAI_AGAIN", "ESERVFAIL", "ETIMEOUT", "ECONNREFUSED", "EREFUSED", "HANG"]) {
    const e = await upfront(m);
    ok(e?.statusCode === 503 && e.message === LOOKUP_UNAVAILABLE && e.retryAfter === LOOKUP_RETRY_AFTER_S && e.attribution === "ours" && e.hint === "our-egress" && !/private/i.test(e.message),
      `lookup ${m}: retryable 503 with Retry-After, no address class (${e?.statusCode} ${e?.retryAfter} ${e?.message})`);
    if (m === "HANG") continue;
    const h = await hop(m);
    ok(h?.statusCode === 503 && h.message === LOOKUP_UNAVAILABLE && h.retryAfter === LOOKUP_RETRY_AFTER_S && !isSsrfBlock(h),
      `hop ${m}: retryable 503 (${h?.statusCode} ${h?.message})`);
  }
  ok(isTransientLookupError({ code: "EAI_AGAIN" }) && !isTransientLookupError({ code: "ENOTFOUND" }), "isTransientLookupError reads the code");
  // The failure monitor and the sweeps count a 503 as a server-side failure, not a buyer error.
  const { toolClassOf } = await import("../src/tool-failure-monitor.js");
  ok(toolClassOf(503) === "fail" && toolClassOf(400) === "buyer", `failure monitor: 503 is ${toolClassOf(503)}, 400 is ${toolClassOf(400)}`);
  mode = null;
  delete process.env.DNS_LOOKUP_TIMEOUT_MS;
  restoreResolver();
}
ok(hits === 0, `the internal server was never reached (${hits} hits)`);
srv.close(); if (v6ok) v6.close();
console.log(`\ntest-ssrf-literal-ip: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
