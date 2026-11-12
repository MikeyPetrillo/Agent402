// Preload that attributes OUTBOUND traffic to the inbound request that caused it.
//
// Loaded with `node --import ./scripts/egress-probe-preload.js src/server.js`.
// Used by scripts/test-free-tier-egress.js to prove the invariant the free tier
// depends on: a compute-payable tool must never reach the network or spawn a
// process, because those tools are served for FREE on the authless connector and
// for a CPU solve over HTTP. If one of them egressed, a free caller could farm a
// metered upstream on our account - the exact hole WALLET_ONLY_SLUGS exists to
// prevent, enforced today only by a hand-maintained list.
//
// Attribution is the hard part: the server also crawls, refreshes leaderboards
// and warms snapshots, so a naive "did anything dial out" check is useless. An
// AsyncLocalStorage context is entered per inbound request and every egress
// primitive records only when it finds that context, so background work (which
// runs outside any request) is ignored rather than blamed on a tool.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import cp from "node:child_process";

const LOG = process.env.EGRESS_LOG;
if (LOG) {
  const als = new AsyncLocalStorage();
  const record = (kind, target) => {
    const ctx = als.getStore();
    if (!ctx) return; // background work, not attributable to a request
    try {
      appendFileSync(LOG, JSON.stringify({ req: ctx.req, kind, target: String(target).slice(0, 200) }) + "\n");
    } catch { /* never break the server to write a probe log */ }
  };

  // Enter a context per inbound request. emit() is synchronous but the handler
  // chain it starts inherits the store, which is what makes async egress deep
  // inside a handler still attributable.
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, ...args) {
    if (event === "request") {
      const req = args[0];
      return als.run({ req: `${req.method} ${req.url}` }, () => emit.apply(this, [event, ...args]));
    }
    return emit.apply(this, [event, ...args]);
  };

  const f = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    record("fetch", typeof input === "string" ? input : input?.url || input);
    return f.call(this, input, init);
  };
  for (const [mod, name] of [[http, "http.request"], [https, "https.request"]]) {
    const orig = mod.request;
    mod.request = function (...a) { record(name, a[0]?.host || a[0]?.hostname || a[0]); return orig.apply(this, a); };
    const origGet = mod.get;
    mod.get = function (...a) { record(name, a[0]?.host || a[0]?.hostname || a[0]); return origGet.apply(this, a); };
  }
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...a) {
    const opt = a[0];
    record("socket.connect", typeof opt === "object" ? `${opt.host}:${opt.port}` : a.join(":"));
    return connect.apply(this, a);
  };
  for (const fn of ["lookup", "resolve", "resolve4", "resolve6", "resolveMx", "resolveTxt"]) {
    if (typeof dns[fn] === "function") {
      const orig = dns[fn];
      dns[fn] = function (...a) { record(`dns.${fn}`, a[0]); return orig.apply(this, a); };
    }
    if (dns.promises && typeof dns.promises[fn] === "function") {
      const orig = dns.promises[fn];
      dns.promises[fn] = function (...a) { record(`dns.promises.${fn}`, a[0]); return orig.apply(this, a); };
    }
  }
  // The address guard (src/tools/fetch-guard.js) resolves with a
  // dns.Resolver instance, whose methods live on the class prototypes, not on
  // the module functions above. Recorded at the query, so a tool that asks
  // for a name is seen whether or not the name then answers.
  for (const [proto, label] of [[dns.Resolver?.prototype, "dns.Resolver"], [dns.promises?.Resolver?.prototype, "dns.promises.Resolver"]]) {
    for (const fn of ["resolve", "resolve4", "resolve6", "resolveMx", "resolveTxt"]) {
      if (!proto || typeof proto[fn] !== "function") continue;
      const orig = proto[fn];
      proto[fn] = function (...a) { record(`${label}.${fn}`, a[0]); return orig.apply(this, a); };
    }
  }
  for (const fn of ["spawn", "spawnSync", "exec", "execSync", "execFile", "fork"]) {
    const orig = cp[fn];
    cp[fn] = function (...a) { record(`child_process.${fn}`, a[0]); return orig.apply(this, a); };
  }
}
