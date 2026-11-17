// Test preload for a booted CI server: every outbound request this process
// makes that fails (an answer of 500 or above, an access refusal of 401, 403
// or 429, or no answer at all) is
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
import { upstreamFailureLogPath, isKeyedRequest, ACCESS_STATUSES } from "./upstream-outage.js";

const LOG = upstreamFailureLogPath();
function record(url, init, outcome) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return;
    const keyed = isKeyedRequest(u, init?.headers);
    const accept = keyed ? null : acceptOf(init?.headers);
    const row = { t: Date.now(), host: u.hostname, method: String(init?.method || "GET").toUpperCase(), keyed, ...(keyed ? {} : { url: u.href }), ...(accept ? { accept } : {}), ...outcome };
    appendFileSync(LOG, `${JSON.stringify(row)}\n`);
  } catch { /* the log is evidence for a sweep, never a reason to fail a request */ }
}

function acceptOf(headers) {
  try {
    if (headers && typeof headers.get === "function") return headers.get("accept");
    if (Array.isArray(headers)) return headers.find((h) => String(h?.[0]).toLowerCase() === "accept")?.[1] || null;
    if (headers && typeof headers === "object") for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === "accept") return String(v);
  } catch { /* no header is no evidence */ }
  return null;
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
  if (res.status >= 500 || ACCESS_STATUSES.has(res.status)) record(url, init, { status: res.status });
  return res;
};
