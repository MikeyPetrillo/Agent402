// Preload for a server under test: records every outbound request the server
// process makes and answers it from here, so nothing leaves the machine.
//   - a host under `.example` resolves to a public address (the address guard
//     passes) and answers the 402 in OUTBOUND_402_BODY (a JSON string);
//   - any other host that is not this machine answers 503.
// The parent reads the record over the IPC channel:
//   child.send({ outbound: "read", id }) -> { outbound: "record", id, requests: [{ host, path, method, body }] }
// Loaded with `node --import ./scripts/lib/outbound-record-preload.js src/server.js`
// by a boot that opens the channel (bootServer({ ipc: true })).
import { stubGuardResolver } from "./guard-resolver-stub.js";

const requests = [];
const local = (host) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";
stubGuardResolver((host, family) => (/\.example$/.test(host) ? (family === 4 ? ["93.184.216.34"] : []) : undefined));
const real = globalThis.fetch;
globalThis.fetch = async function recordedFetch(input, init = {}) {
  let u;
  try { u = new URL(typeof input === "string" ? input : input?.url ?? String(input)); } catch { return real.call(this, input, init); }
  if (local(u.hostname)) return real.call(this, input, init);
  requests.push({ host: u.hostname, path: u.pathname, method: String(init?.method || "GET").toUpperCase(), body: typeof init?.body === "string" ? init.body.slice(0, 4000) : "" });
  if (/\.example$/.test(u.hostname)) return new Response(process.env.OUTBOUND_402_BODY || "{}", { status: 402, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "content-type": "application/json" } });
};
if (typeof process.send === "function") {
  process.on("message", (m) => {
    if (m && typeof m === "object" && m.outbound === "read") process.send({ outbound: "record", id: m.id, requests: requests.slice() });
  });
  // The channel must not keep a server alive that is shutting down.
  process.channel?.unref?.();
}
