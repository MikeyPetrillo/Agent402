// Preload for scripts/test-redos-free-tier.js: every outbound call to a host
// other than loopback fails at once, so a tool that would wait on the network
// returns quickly and what is left of its time is its own CPU work.
//
//   node --import ./scripts/offline-egress-preload.js src/server.js
import dns from "node:dns";
import net from "node:net";

const LOCAL = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0", "::ffff:127.0.0.1"]);
const isLocal = (h) => !h || LOCAL.has(String(h).replace(/^\[|\]$/g, "").toLowerCase());
const offline = (what) => Object.assign(new Error(`offline test: ${what}`), { code: "ENOTFOUND" });

const f = globalThis.fetch;
globalThis.fetch = function (input, init) {
  let host = null;
  try { host = new URL(typeof input === "string" ? input : input?.url || String(input)).hostname; } catch { /* relative */ }
  if (host && !isLocal(host)) return Promise.reject(offline(host));
  return f.call(this, input, init);
};

const lookup = dns.lookup;
dns.lookup = function (host, ...a) {
  if (isLocal(host)) return lookup.call(this, host, ...a);
  const cb = a.find((x) => typeof x === "function");
  if (cb) process.nextTick(cb, offline(host));
  return {};
};
if (dns.promises?.lookup) {
  const pl = dns.promises.lookup;
  dns.promises.lookup = (host, ...a) => (isLocal(host) ? pl(host, ...a) : Promise.reject(offline(host)));
}
for (const fn of ["resolve", "resolve4", "resolve6", "resolveMx", "resolveTxt", "resolveCname", "resolveNs", "resolveSoa", "resolveCaa", "resolveSrv", "resolveAny", "reverse"]) {
  if (typeof dns[fn] === "function") {
    dns[fn] = function (host, ...a) { const cb = a.find((x) => typeof x === "function"); if (cb) process.nextTick(cb, offline(host)); };
  }
  if (dns.promises && typeof dns.promises[fn] === "function") dns.promises[fn] = (host) => Promise.reject(offline(host));
  if (typeof dns.Resolver?.prototype?.[fn] === "function") dns.Resolver.prototype[fn] = function (host, ...a) { const cb = a.find((x) => typeof x === "function"); if (cb) process.nextTick(cb, offline(host)); };
  if (typeof dns.promises?.Resolver?.prototype?.[fn] === "function") dns.promises.Resolver.prototype[fn] = (host) => Promise.reject(offline(host));
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) {
  const opt = a[0];
  const host = typeof opt === "object" && opt ? opt.host : typeof a[1] === "string" ? a[1] : null;
  const path = typeof opt === "object" && opt ? opt.path : null;
  if (!path && host && !isLocal(host)) {
    process.nextTick(() => this.destroy(offline(host)));
    return this;
  }
  return connect.apply(this, a);
};
