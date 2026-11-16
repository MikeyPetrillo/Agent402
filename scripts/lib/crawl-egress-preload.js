// Test preload for scripts/test-crawl-default-off.js: records every outbound
// request a booted server attempts (host and the src/ files on the
// caller's stack, comma-separated) to CRAWL_EGRESS_LOG, then refuses any host that is not
// loopback as a network error, so the run itself never reaches a third party.
// Loaded with `node --import ./scripts/lib/crawl-egress-preload.js src/server.js`.
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const OUT = process.env.CRAWL_EGRESS_LOG;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/;
// Wrappers between the caller and this preload (the server's own egress meter
// and fetch guard wrap globalThis.fetch too) are skipped when attributing.
const PLUMBING = /egress-meter\.js|fetch-guard\.js|drain-abort\.js|request-timing\.js|facilitator-diagnostics\.js|crawl-egress-preload\.js|node:internal|node_modules/;

function callerFile() {
  const prev = Error.stackTraceLimit;
  Error.stackTraceLimit = 80;
  let stack = "";
  try { stack = new Error().stack || ""; } finally { Error.stackTraceLimit = prev; }
  // Every src/ file on the stack, nearest first (async frames included), so
  // a crawler reached through a helper is still named.
  const files = [];
  for (const line of stack.split("\n").slice(1)) {
    if (PLUMBING.test(line)) continue;
    const m = line.match(/\/src\/([^\s:)]+)/);
    if (m && !files.includes(m[1])) files.push(m[1]);
  }
  return files.join(",") || "?";
}
function note(host) {
  if (!OUT || !host) return;
  try { appendFileSync(OUT, `${host}\t${callerFile()}\n`); } catch { /* best effort */ }
}
function hostOf(input) {
  try {
    if (typeof input === "string") return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input?.url) return new URL(input.url).hostname;
    if (input && (input.hostname || input.host)) return String(input.hostname || input.host).replace(/:\d+$/, "");
  } catch { /* not a URL */ }
  return "";
}

const realFetch = globalThis.fetch;
globalThis.fetch = async function recordedFetch(input, init) {
  const host = hostOf(input);
  note(host);
  if (host && !LOOPBACK.test(host)) throw new TypeError(`fetch failed (test preload: ${host} is not a loopback host)`);
  return realFetch(input, init);
};
for (const mod of [http, https]) {
  for (const fn of ["request", "get"]) {
    const orig = mod[fn];
    mod[fn] = function recordedRequest(...args) {
      const host = hostOf(args[0]);
      note(host);
      if (host && !LOOPBACK.test(host)) {
        // Refused the way a closed port refuses: an 'error' event the caller
        // already handles, never a synchronous throw it may not expect.
        const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : undefined;
        return orig.call(this, { host: "127.0.0.1", port: 9, path: "/", method: "GET" }, cb);
      }
      return orig.apply(this, args);
    };
  }
}
