// Test preload: every fetch to a host other than 127.0.0.1, localhost or ::1
// fails at once, as a network error, so a booted server under test reads only
// its stubs (a chain page's revenue read, for one, would otherwise reach the
// public chain RPCs). Loaded with `node --import ./scripts/lib/loopback-only-preload.js src/server.js`.
const realFetch = globalThis.fetch;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/;
globalThis.fetch = async function loopbackOnly(input, init) {
  let host = "";
  try { host = new URL(typeof input === "string" ? input : input?.url || String(input)).hostname; } catch { /* not a URL: let fetch say so */ }
  if (host && !LOOPBACK.test(host)) throw new TypeError(`fetch failed (test preload: ${host} is not a loopback host)`);
  return realFetch(input, init);
};
