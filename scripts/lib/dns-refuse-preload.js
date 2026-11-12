// Preload: every name lookup the address guard would send to a real resolver
// fails at once, the way a down or unanswering name server reads to it.
//
//   NODE_OPTIONS="--import ./scripts/lib/dns-refuse-preload.js" node scripts/test-x.js
//
// The guard (src/tools/fetch-guard.js) resolves with dns.Resolver's resolve4 /
// resolve6 and falls back to dns.lookup only on a fast refusal. Here resolve4
// and resolve6 reject with ETIMEOUT (a transient code: the guard answers its
// retryable "temporarily unavailable"), and dns.lookup of any name other than
// loopback rejects ENOTFOUND, so no answer depends on the machine's resolver.
// A suite's own stub (scripts/lib/guard-resolver-stub.js) still answers: it
// wraps whatever methods it finds and passes only the names it does not
// answer through to these.
//
// A connection to the public stand-in address the offline resolver stub
// answers with (scripts/lib/guard-dns-offline.js) is refused too: a suite
// that stubs the guard's lookups but lets a real fetch through would
// otherwise dial that outside address.
//
// Every refused name is appended to DNS_REFUSE_LOG (when set) as
// "<script>\t<method>\t<name>", so a failing run names what it asked for.
// NODE_OPTIONS reaches every child a suite spawns with process.env, so a
// booted server runs under it too. Used by scripts/test-offline-suites-no-dns.js.
import dnsPromises from "node:dns/promises";
import { appendFileSync } from "node:fs";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const LOG = process.env.DNS_REFUSE_LOG || "";
const who = String(process.argv[1] || "").split("/").pop();
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const isLocal = (h) => LOCAL.has(String(h || "").replace(/^\[|\]$/g, "").toLowerCase());
const note = (method, host) => { if (LOG) try { appendFileSync(LOG, `${who}\t${method}\t${String(host).slice(0, 200)}\n`); } catch { /* the log never breaks a run */ } };
const refused = (code, host) => Object.assign(new Error(`dns refused by test preload: ${host}`), { code, hostname: String(host) });

for (const fn of ["resolve4", "resolve6"]) {
  dnsPromises.Resolver.prototype[fn] = function refuseResolve(host) {
    note(fn, host);
    return Promise.reject(refused("ETIMEOUT", host));
  };
}
const realLookup = dnsPromises.lookup;
dnsPromises.lookup = function refuseLookup(host, ...rest) {
  if (isLocal(host)) return realLookup.call(this, host, ...rest);
  note("lookup", host);
  return Promise.reject(refused("ENOTFOUND", host));
};
syncBuiltinESMExports();

const STAND_IN = "93.184.215.14"; // scripts/lib/guard-dns-offline.js GUARD_PUBLIC_STAND_IN
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function refuseStandIn(...a) {
  const opt = a[0];
  const host = opt && typeof opt === "object" ? opt.host : typeof a[1] === "string" ? a[1] : null;
  if (String(host || "") === STAND_IN) {
    note("connect", host);
    process.nextTick(() => this.destroy(refused("ECONNREFUSED", host)));
    return this;
  }
  // A connect by name with its own lookup (the guard's connect pin): an
  // answer of the stand-in address is refused the same way.
  if (opt && typeof opt === "object" && typeof opt.lookup === "function") {
    const lookup = opt.lookup;
    a[0] = { ...opt, lookup(name, o, cb) {
      if (typeof o === "function") { cb = o; o = {}; }
      lookup(name, o, (err, addr, fam) => {
        const hit = Array.isArray(addr) ? addr.some((x) => x?.address === STAND_IN) : addr === STAND_IN;
        if (!err && hit) { note("connect", `${name} -> ${STAND_IN}`); return cb(refused("ECONNREFUSED", name)); }
        cb(err, addr, fam);
      });
    } };
  }
  return connect.apply(this, a);
};
