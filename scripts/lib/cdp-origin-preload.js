// Test-only preload: a booted server keeps the Coinbase Developer Platform
// origin it uses in production (the keyed facilitator client at
// https://api.cdp.coinbase.com/platform/v2/x402 and the query service beside
// it), and every fetch to that origin is sent to a loopback stand-in the test
// runs (CDP_ORIGIN_STUB_PORT): same method, path, headers, body and abort
// signal, so the server's own deadlines still act on the call. The stand-in
// lives in the test's process, so every verify, query and settle is stamped
// on one clock.
//
// Every other connection to a host that is not loopback is refused in
// process (one "[cdp-origin-preload] egress refused <host>" line per host),
// so a server booted with this preload reaches no third party.
//
// With no CDP_ORIGIN_STUB=1 or no port this preload refuses to load, so a
// boot that uses it can never reach the real service.
//
// Loaded with `node --import ./scripts/lib/cdp-origin-preload.js src/server.js`
// by scripts/test-onchain-sql-paid-path.js.
import net from "node:net";

if (process.env.CDP_ORIGIN_STUB !== "1" || !/^\d+$/.test(process.env.CDP_ORIGIN_STUB_PORT || "")) {
  throw new Error("cdp-origin-preload: CDP_ORIGIN_STUB=1 and CDP_ORIGIN_STUB_PORT are required; refusing to boot a server that could reach the real service");
}
const ORIGIN = "https://api.cdp.coinbase.com";
const LOCAL = `http://127.0.0.1:${process.env.CDP_ORIGIN_STUB_PORT}`;
const realFetch = globalThis.fetch;

globalThis.fetch = function cdpOriginFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (typeof url === "string" && (url === ORIGIN || url.startsWith(`${ORIGIN}/`))) {
    const to = LOCAL + url.slice(ORIGIN.length);
    if (typeof input === "string" || input instanceof URL) return realFetch.call(this, to, init);
    return realFetch.call(this, new Request(to, input), init);
  }
  return realFetch.call(this, input, init);
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0", "::ffff:127.0.0.1"]);
const refused = new Set();
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function cdpOriginConnect(...args) {
  const a0 = args[0];
  let opts = null;
  if (Array.isArray(a0)) opts = a0[0];
  else if (a0 && typeof a0 === "object") opts = a0;
  else if (typeof a0 === "number") opts = { port: a0, host: typeof args[1] === "string" ? args[1] : "localhost" };
  else if (typeof a0 === "string") opts = { path: a0 };
  // A path is a local socket; a host is checked by name, before any lookup.
  const host = opts?.path ? null : String(opts?.host || "localhost").toLowerCase();
  if (host === null || LOOPBACK.has(host)) return realConnect.apply(this, args);
  if (!refused.has(host)) { refused.add(host); console.log(`[cdp-origin-preload] egress refused ${host}`); }
  process.nextTick(() => this.destroy(Object.assign(new Error(`egress refused by cdp-origin-preload: ${host}`), { code: "ECONNREFUSED" })));
  return this;
};
