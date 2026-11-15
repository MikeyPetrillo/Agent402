// Test preload: a booted server under test contacts no third party.
//   - fetch: only loopback hosts are reached. A fetch to openrouter.ai is
//     answered by the local stub named in OPENROUTER_STUB_URL (same path and
//     query), so a model-backed route runs to a 200 with no key and nothing
//     spent; with STRIPE_TOKEN_STUB=on a card payment token's read is answered
//     here as an active token. Every other host fails at once as a network
//     error (the server's own background reads meet that all the time).
//   - node http and https (the Stripe client uses them, not fetch): a request
//     to api.stripe.com goes to STRIPE_STUB_URL when it is set.
//   - any other socket to a host that is not loopback is refused and SAID SO
//     on stderr with the line "[paid-wires-preload] BLOCKED outbound ...";
//     scripts/lib/paid-wires-rig.js fails the suite when the server's log
//     holds that line, so a test that would have contacted a third party
//     cannot pass.
// Loaded with `node --import ./scripts/lib/paid-wires-preload.js src/server.js`.
import http from "node:http";
import https from "node:https";
import net from "node:net";

const realFetch = globalThis.fetch;
const stub = String(process.env.OPENROUTER_STUB_URL || "").replace(/\/+$/, "");
const stripeStub = String(process.env.STRIPE_STUB_URL || "").replace(/\/+$/, "");
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/;
export const BLOCKED_MARK = "[paid-wires-preload] BLOCKED outbound";
const blocked = (what, host) => { try { process.stderr.write(`${BLOCKED_MARK} ${what} to ${String(host).slice(0, 120)}\n`); } catch { /* stderr closed */ } };

globalThis.fetch = async function paidWiresFetch(input, init) {
  let u = null;
  try { u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input?.url || String(input)); } catch { /* not a URL: let fetch say so */ }
  if (!u || LOOPBACK.test(u.hostname)) return realFetch(input, init);
  if (stub && /(^|\.)openrouter\.ai$/.test(u.hostname)) return realFetch(`${stub}${u.pathname}${u.search}`, init);
  if (process.env.STRIPE_TOKEN_STUB === "on" && u.hostname === "api.stripe.com" && u.pathname.startsWith("/v1/shared_payment/granted_tokens/")) {
    return new Response(JSON.stringify({ id: u.pathname.split("/").pop(), usage_limits: { currency: "usd", max_amount: 1000000, expires_at: Math.floor(Date.now() / 1000) + 3600 }, usage_details: { amount_captured: { value: 0 } } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new TypeError(`fetch failed (test preload: ${u.hostname} is not a loopback host)`);
};

// node https: the card client's host goes to the local stub, over http.
const hostOfOptions = (args) => {
  const a = args[0];
  if (typeof a === "string" || a instanceof URL) { try { return new URL(String(a)).hostname; } catch { return ""; } }
  return a && typeof a === "object" ? String(a.hostname || a.host || "localhost") : "";
};
const realHttpsRequest = https.request;
https.request = function paidWiresHttpsRequest(...args) {
  const host = hostOfOptions(args);
  if (stripeStub && host === "api.stripe.com" && args[0] && typeof args[0] === "object" && !(args[0] instanceof URL)) {
    const o = args[0];
    const to = new URL(stripeStub);
    return http.request({ method: o.method, host: to.hostname, port: to.port, path: `${to.pathname.replace(/\/+$/, "")}${o.path || "/"}`, headers: o.headers }, typeof args[1] === "function" ? args[1] : undefined);
  }
  return realHttpsRequest.apply(this, args);
};

// Every socket: a connection to a host that is not loopback is refused, and said so.
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function paidWiresConnect(...args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0]; // net's normalized arguments
  let host = null;
  if (a && typeof a === "object") host = a.path ? null : String(a.host ?? a.hostname ?? "localhost");
  else if (typeof a === "number") host = typeof args[1] === "string" ? args[1] : "localhost";
  if (host !== null && !LOOPBACK.test(host) && !/^(127\.|::ffff:127\.)/.test(host)) {
    blocked("connection", host);
    queueMicrotask(() => this.destroy(Object.assign(new Error(`connect ECONNREFUSED ${host} (test preload)`), { code: "ECONNREFUSED" })));
    return this;
  }
  return realConnect.apply(this, args);
};
