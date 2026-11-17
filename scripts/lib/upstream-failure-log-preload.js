// Test preload for a booted CI server: every outbound request this process
// makes that fails (an answer of 500 or above, or no answer at all) is
// appended as one JSON line to the upstream failure log
// (scripts/lib/upstream-outage.js upstreamFailureLogPath). A sweep reads it
// to name the exact upstream request behind a tool's upstream-error answer,
// then re-reads that request from the runner itself: only when the runner is
// refused too is the answer the upstream's and not ours.
//
//   PORT=3000 node --import ./scripts/lib/upstream-failure-log-preload.js src/server.js
//
// A request that carries a credential (a key-like query parameter or header)
// is logged as keyed, with its host only, never its URL: it is never re-read
// and never excuses anything. Nothing here changes a request or an answer.
import { appendFileSync } from "node:fs";
import { upstreamFailureLogPath, isKeyedRequest } from "./upstream-outage.js";

const LOG = upstreamFailureLogPath();
function record(url, init, outcome) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return;
    const keyed = isKeyedRequest(u, init?.headers);
    const row = { t: Date.now(), host: u.hostname, method: String(init?.method || "GET").toUpperCase(), keyed, ...(keyed ? {} : { url: u.href }), ...outcome };
    appendFileSync(LOG, `${JSON.stringify(row)}\n`);
  } catch { /* the log is evidence for a sweep, never a reason to fail a request */ }
}

const realFetch = globalThis.fetch;
globalThis.fetch = async function upstreamFailureLog(input, init) {
  const url = typeof input === "string" ? input : input?.url || String(input);
  let res;
  try {
    res = await realFetch(input, init);
  } catch (e) {
    record(url, init, { error: String(e?.name || "error") });
    throw e;
  }
  if (res.status >= 500) record(url, init, { status: res.status });
  return res;
};
