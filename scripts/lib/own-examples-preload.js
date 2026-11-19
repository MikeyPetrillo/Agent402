// Test preload for a booted CI server: a published example that names this
// server's own origin (https://agent402.tools: the home page http-check,
// site-map, site-crawl and the favicon lookup read, the /samples/ and
// /fixtures/ files) is answered by THIS process, so a sweep of those examples
// never depends on what production serves at that minute (a2a-card-fetch's
// sample card answered production's 404 to the strict sweep once). A browser
// tool (page-speed) navigates in Chromium's own network stack, which this
// fetch hook does not reach. Only a read (GET or HEAD) is answered here: a
// free-mode boot has no paywall, so a call an example makes to a paid route
// on this origin (seller-payability and the x402 inspectors POST to
// /api/hash to read its 402) goes to the published origin as written. The
// published examples keep naming production for buyers; only the fetch is
// redirected, after the address guard has passed the public name. Every other
// URL goes to the real fetch untouched.
//
//   PORT=3000 node --import ./scripts/lib/own-examples-preload.js src/server.js
//
// The server's own port is the one its HTTP server bound (src/server.js
// listens once), so PORT=0 works; before it listens nothing is redirected.
// Installed before the server's own fetch wrappers,
// which wrap whatever fetch they find, so it sits underneath them exactly
// like the network.
import http from "node:http";

export const EXAMPLE_ORIGIN = "https://agent402.tools";

/** The loopback URL that serves `url` on this process, or null for any URL
 *  this server does not serve itself. */
export function ownExampleUrl(url, port, method = "GET") {
  if (!/^(GET|HEAD)$/i.test(String(method || "GET"))) return null;
  if (!port || !Number.isInteger(Number(port)) || Number(port) <= 0) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.origin !== EXAMPLE_ORIGIN || u.username || u.password) return null;
  return `http://127.0.0.1:${Number(port)}${u.pathname}${u.search}`;
}

let boundPort = null;
const realListen = http.Server.prototype.listen;
http.Server.prototype.listen = function listenAndRecord(...args) {
  this.once("listening", () => { const a = this.address(); if (boundPort == null && a && typeof a === "object") boundPort = a.port; });
  return realListen.apply(this, args);
};

const realFetch = globalThis.fetch;
globalThis.fetch = async function ownExamples(input, init) {
  const url = typeof input === "string" ? input : input?.url || String(input);
  const method = init?.method || (typeof input === "object" && input?.method) || "GET";
  const local = ownExampleUrl(url, boundPort, method);
  if (!local) return realFetch(input, init);
  // The guard's pinned dispatcher refuses loopback by design; this hop is the
  // server reading its own file, so it goes out on the default one.
  const { dispatcher: _pinned, ...rest } = init || {};
  const res = await realFetch(local, rest);
  // The answer reads as the URL that was asked for, so a tool that reports
  // its final URL names the published one, not the loopback hop.
  Object.defineProperty(res, "url", { value: url });
  return res;
};
