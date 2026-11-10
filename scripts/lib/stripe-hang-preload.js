// Test preload: every request the Stripe SDK sends (https.request to
// api.stripe.com) is accepted and never answered, and each one is named on
// stderr as "[stripe-hang-preload] request <n> <METHOD> <path>". The request
// goes to a listener in this process that reads nothing and writes nothing,
// so the SDK holds a real, open request, as it would against a host that has
// stopped answering. Loaded with
// `node --import ./scripts/lib/stripe-hang-preload.js src/server.js`.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";

const held = new Set();
const sink = net.createServer((socket) => { held.add(socket); socket.on("error", () => {}); socket.on("close", () => held.delete(socket)); });
sink.listen(0, "127.0.0.1");
await once(sink, "listening");
sink.unref();
const sinkPort = sink.address().port;

const realRequest = https.request;
let n = 0;
https.request = function stripeNeverAnswers(options, ...rest) {
  const host = typeof options === "string" ? "" : String(options?.host || options?.hostname || "");
  if (host !== "api.stripe.com") return realRequest.call(this, options, ...rest);
  n++;
  process.stderr.write(`[stripe-hang-preload] request ${n} ${options.method || "GET"} ${String(options.path || "").split("?")[0]}\n`);
  return http.request({ host: "127.0.0.1", port: sinkPort, method: options.method, path: options.path, headers: options.headers }, ...rest);
};
syncBuiltinESMExports();
