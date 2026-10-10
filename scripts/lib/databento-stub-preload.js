// Test-only preload: every fetch to https://hist.databento.com/... goes to a
// local stub instead, keeping the path, and the SSRF guard's DNS lookup for
// that host answers locally. Same rule as openrouter-stub-preload.js: with no
// DATABENTO_STUB_URL this preload refuses to load, so a test boot that uses it
// can never reach the real market-data upstream.
//
// Loaded with `node --import ./scripts/lib/databento-stub-preload.js src/server.js`
// by scripts/test-paid-phase-timing.js.
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

const STUB = process.env.DATABENTO_STUB_URL;
if (!STUB) throw new Error("databento-stub-preload: DATABENTO_STUB_URL is unset; refusing to boot a server that could reach the real upstream");
const ORIGIN = "https://hist.databento.com";
const HOST = "hist.databento.com";
const base = STUB.replace(/\/+$/, "");
const realFetch = globalThis.fetch;

const realLookup = dnsPromises.lookup;
dnsPromises.lookup = function stubLookup(hostname, options) {
  if (hostname === HOST) return Promise.resolve(options?.all ? [{ address: "1.1.1.1", family: 4 }] : { address: "1.1.1.1", family: 4 });
  return realLookup.call(this, hostname, options);
};
syncBuiltinESMExports();

globalThis.fetch = function databentoStubFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (typeof url === "string" && (url === ORIGIN || url.startsWith(`${ORIGIN}/`))) {
    const target = base + url.slice(ORIGIN.length);
    if (typeof Request !== "undefined" && input instanceof Request) return realFetch.call(this, new Request(target, input), init);
    return realFetch.call(this, target, init);
  }
  return realFetch.call(this, input, init);
};
