// Test preload: every request the Stripe SDK sends (https.request to
// api.stripe.com) goes to the local stub named by STRIPE_STUB_PORT instead, so
// a booted server's card checkout can be driven with no Stripe account and no
// network. The stub (the test's own HTTP listener) sees the method, the path
// and the form body the SDK sent, and answers as Stripe would. Loaded with
// `node --import ./scripts/lib/stripe-stub-preload.js src/server.js`.
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const port = Number(process.env.STRIPE_STUB_PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error("stripe-stub-preload: STRIPE_STUB_PORT names no port");
const realRequest = https.request;
https.request = function stripeToStub(options, ...rest) {
  const host = typeof options === "string" ? "" : String(options?.host || options?.hostname || "");
  if (host !== "api.stripe.com") return realRequest.call(this, options, ...rest);
  return http.request({ host: "127.0.0.1", port, method: options.method, path: options.path, headers: options.headers }, ...rest);
};
syncBuiltinESMExports();
