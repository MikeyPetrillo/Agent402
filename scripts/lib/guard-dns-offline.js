// Test-only: the address guard's name lookups answer from this process, never
// from the machine's resolver. Every name resolves to one public stand-in
// address (A only, no AAAA), so a URL whose fetch the suite stubs passes the
// guard's upfront check (src/tools/fetch-guard.js resolveHostAddresses) at
// once, whatever the resolver on the machine is doing. The reserved names
// answer as a real resolver does (RFC 6761): localhost and *.localhost are
// loopback, *.invalid is ENOTFOUND.
//
//   import "./lib/guard-dns-offline.js";                       // in a suite
//   node --import ./scripts/lib/guard-dns-offline.js src/server.js  // a boot
//
// Import it in a suite that stubs the fetch, an upstream or a preload (a
// suite that also makes live calls installs the same answer only around its
// stubbed sections: `const undo = stubGuardResolver(offlineGuardAnswer)`); a
// suite that needs a name to answer something else (a private address, a
// refusal) installs stubGuardResolver from ./guard-resolver-stub.js after
// this one: that stub wraps these methods and passes the names it does not
// answer to them. The guard's dns.lookup fallback runs only on a refused
// query, which this never returns.
import { stubGuardResolver, offlineGuardAnswer } from "./guard-resolver-stub.js";

export { GUARD_PUBLIC_STAND_IN } from "./guard-resolver-stub.js";
stubGuardResolver(offlineGuardAnswer);
