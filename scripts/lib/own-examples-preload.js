// Test preload for a booted CI server: a published example that names this
// server's own origin (https://agent402.tools: the home page http-check,
// site-map, site-crawl and the favicon lookup read, the /samples/ and
// /fixtures/ files) is answered by THIS process, so a sweep of those examples
// never depends on what production serves at that minute (a2a-card-fetch's
// sample card answered production's 404 to the strict sweep once). A browser
// tool (render, screenshot, page-speed) navigates in Chromium's own network
// stack, which the fetch hook does not reach: the same reads are answered
// there through the request routing the tool already installs on its browser
// context (answerInBrowser below), so a sweep's browser examples load this
// server's pages, never production's. Only a read (GET or HEAD) is answered here: a
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

// Hop-by-hop and encoding headers the loopback answer does not pass on: the
// body handed to the browser is already decoded and complete.
const DROP_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

/** Answer one browser request from this server when it is a read of the
 *  published origin; returns false (nothing done) for any other request. The
 *  answer keeps the published URL: a redirect to the loopback names the
 *  published origin again, so the next hop is routed here too. */
export async function answerInBrowser(route, port, fetchImpl = realFetch) {
  const request = route.request();
  const local = ownExampleUrl(request.url(), port, request.method());
  if (!local) return false;
  const headers = { ...request.headers(), "accept-encoding": "identity" };
  delete headers.host;
  const res = await fetchImpl(local, { method: request.method(), headers, redirect: "manual" });
  const out = {};
  res.headers.forEach((v, k) => { if (!DROP_HEADERS.has(k)) out[k] = v; });
  if (out.location) {
    try {
      const to = new URL(out.location, local);
      if (to.origin === new URL(local).origin) out.location = `${EXAMPLE_ORIGIN}${to.pathname}${to.search}${to.hash}`;
    } catch { /* an unparsable location goes through as sent */ }
  }
  const body = request.method().toUpperCase() === "HEAD" ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
  await route.fulfill({ status: res.status, headers: out, body });
  return true;
}

// The browser tools install one routing handler per context (the public-host
// check in src/tools/render.js); each handler is wrapped so a read of the
// published origin is answered here and every other request reaches the
// tool's own handler unchanged. Installed on Playwright's chromium launcher,
// which is the module instance render.js imports.
export function wrapContextRoutes(context, portOf = () => boundPort) {
  if (!context || typeof context.route !== "function" || context.__ownExamples) return context;
  const realRoute = context.route.bind(context);
  context.route = (pattern, handler, options) => realRoute(pattern, async (route, request) => {
    let answered = false;
    // A read of the published origin that this server could not answer is
    // aborted, never passed on to production.
    try { answered = await answerInBrowser(route, portOf()); } catch { await route.abort("failed").catch(() => {}); return; }
    if (!answered) return handler(route, request);
  }, options);
  Object.defineProperty(context, "__ownExamples", { value: true });
  return context;
}

try {
  const { chromium } = await import("playwright");
  if (chromium && typeof chromium.launch === "function") {
    const realLaunch = chromium.launch.bind(chromium);
    chromium.launch = async (...args) => {
      const browser = await realLaunch(...args);
      const realNewContext = browser.newContext.bind(browser);
      browser.newContext = async (...o) => wrapContextRoutes(await realNewContext(...o));
      return browser;
    };
  }
} catch { /* no Playwright here: the browser tools answer 503 on their own */ }
