// Builds one Office file per message, for office-pool.js. Before any builder
// or library loads, every network API this thread could reach is replaced by
// one that refuses: the builders take text only, and a library that tried to
// fetch something (a remote image, a font) would fail the call instead of
// reaching out. syncBuiltinESMExports carries the replacements to ESM named
// imports of the built-in modules too.
import { parentPort } from "node:worker_threads";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { OFFICE_OPS } from "./office-ops.js";

const refuse = (what) => () => { throw Object.assign(new Error(`office builders make no network calls (${what} refused)`), { statusCode: 500 }); };
globalThis.fetch = async () => refuse("fetch")();
if (typeof globalThis.WebSocket === "function") globalThis.WebSocket = refuse("WebSocket");
for (const [mod, name] of [[http, "http"], [https, "https"]]) { mod.request = refuse(`${name}.request`); mod.get = refuse(`${name}.get`); }
net.connect = refuse("net.connect"); net.createConnection = refuse("net.createConnection");
tls.connect = refuse("tls.connect");
dns.lookup = refuse("dns.lookup"); dns.resolve = refuse("dns.resolve");
dns.promises.lookup = async () => refuse("dns.lookup")(); dns.promises.resolve = async () => refuse("dns.resolve")();
syncBuiltinESMExports();

parentPort.on("message", async ({ id, op, spec }) => {
  try {
    const fn = OFFICE_OPS[op];
    if (!fn) throw Object.assign(new Error(`unknown office operation: ${op}`), { statusCode: 500 });
    parentPort.postMessage({ id, result: await fn(spec) });
  } catch (e) {
    const tooDeep = e instanceof RangeError;
    parentPort.postMessage({ id, error: tooDeep ? "The input nests too deeply to build" : e.message, statusCode: tooDeep ? 400 : e.statusCode || 500 });
  }
});
