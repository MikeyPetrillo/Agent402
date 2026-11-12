// Test-only: answer the address guard's name lookups (src/tools/fetch-guard.js
// resolves with dns.Resolver's resolve4/resolve6, and with dns.lookup only as
// the fallback for a refused query: stubGuardLookup below) from a
// function, so a suite steers what a name resolves to with nothing leaving the
// process. Patches the promise Resolver's prototype, so it applies to the
// guard's resolver whether it was built before or after the stub.
//
//   const restore = stubGuardResolver((host, family) => ...);
//
// `answer(host, family)` returns an array of address strings, a promise of
// one, or throws / rejects with a resolver error ({ code: "ENOTFOUND" } etc.).
// Returning undefined passes the query to the real resolver. Returns a
// function that puts the real methods back.
import dnsPromises from "node:dns/promises";

export function stubGuardResolver(answer) {
  const P = dnsPromises.Resolver.prototype;
  const real4 = P.resolve4, real6 = P.resolve6;
  const wrap = (real, family) => function stubResolve(host, ...rest) {
    let out;
    try { out = answer(String(host), family); } catch (e) { return Promise.reject(e); }
    if (out === undefined) return real.call(this, host, ...rest);
    return Promise.resolve(out);
  };
  P.resolve4 = wrap(real4, 4);
  P.resolve6 = wrap(real6, 6);
  return () => { P.resolve4 = real4; P.resolve6 = real6; };
}

/**
 * The guard's one dns.lookup path: the OS-resolver fallback it takes when the
 * name server refuses a query at once (fetch-guard.js resolveHostAddresses).
 * `answer(host, options)` returns [{ address, family }], a promise of one, or
 * throws / rejects ({ code: "ENOTFOUND" } etc.); undefined passes to the real
 * dns.lookup. Returns a function that puts the real one back.
 */
export function stubGuardLookup(answer) {
  const real = dnsPromises.lookup;
  dnsPromises.lookup = function stubLookup(host, options, ...rest) {
    let out;
    try { out = answer(String(host), options); } catch (e) { return Promise.reject(e); }
    if (out === undefined) return real.call(this, host, options, ...rest);
    return Promise.resolve(out);
  };
  return () => { dnsPromises.lookup = real; };
}

/** A resolver error with a code, as c-ares reports one. */
export const resolverError = (code, host = "") => Object.assign(new Error(`stub ${code} ${host}`.trim()), { code });

/** Every name answers one IPv4 address and no AAAA (the common stub). */
export const oneV4 = (address) => (_host, family) => (family === 4 ? [address] : Promise.reject(resolverError("ENODATA")));
