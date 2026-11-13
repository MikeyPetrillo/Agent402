// Is this request one of our own loopback replays (an async job's replay or
// the MCP connector's paid replay)? ONE predicate for every middleware that
// exempts a replay (the trust-proxy and CDN address resolvers, both sync
// windows), so no two of them can disagree on the proof. The proof is a
// per-process secret compared in constant time (the MCP loopback marker, or a
// live async-job runner's token), never a header's presence and never the
// socket's address: behind a same-host proxy every client socket is loopback
// and a header name is caller text.
import { isMcpLoopback } from "./mcp-loopback.js";
import { isAsyncLoopbackToken, LOOPBACK_HEADER } from "./async-jobs.js";

export function isOwnReplay(req) {
  return isMcpLoopback(req) || isAsyncLoopbackToken(req?.headers?.[LOOPBACK_HEADER]);
}
