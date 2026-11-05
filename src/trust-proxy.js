// How many proxy hops in front of this server are trusted to report the client
// address (Express "trust proxy"). Every per-IP limiter keys on req.ip, so the
// value decides whether a client can name its own address: with N hops trusted,
// req.ip is the Nth X-Forwarded-For entry from the right, and a server with no
// proxy in front that trusts one hop reads the entry the client wrote.
//
// TRUST_PROXY_HOPS unset (or empty) is 0: req.ip is the socket peer and no
// forwarded header counts. A deployment behind one edge proxy (Railway) sets 1.
// A value that is not a whole number from 0 to 10 is read as 0, with a warning.
// src/cdn-client-ip.js runs after this and keeps its own CDN rules.

import { isIP } from "node:net";

const MAX_HOPS = 10;

export function trustProxyHops(env = process.env, warn = (m) => console.warn(m)) {
  const raw = env.TRUST_PROXY_HOPS;
  if (raw === undefined || String(raw).trim() === "") {
    warn("[trust-proxy] TRUST_PROXY_HOPS is unset: trusting no X-Forwarded-For hop, so req.ip is the socket address. Behind a reverse proxy, set TRUST_PROXY_HOPS to the number of proxies in front (1 behind a single edge).");
    return 0;
  }
  const s = String(raw).trim();
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_HOPS) {
    warn(`[trust-proxy] TRUST_PROXY_HOPS must be a whole number from 0 to ${MAX_HOPS}; trusting no X-Forwarded-For hop.`);
    return 0;
  }
  return n;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** With no hop trusted, our own loopback replays (the MCP connector's paid
 *  replay, an async job's replay) would all read 127.0.0.1 and share one
 *  bucket in every per-IP limiter. They carry the buyer's address in
 *  X-Forwarded-For, so for a request on a loopback socket that `isReplay`
 *  proves genuine (a per-process secret), req.ip becomes that address. Any
 *  other request keeps the socket address. Mount only when hops is 0; with a
 *  hop trusted, Express already reads the same entry. */
export function replayClientIpMiddleware({ isReplay }) {
  return function replayClientIp(req, _res, next) {
    try {
      if (LOOPBACK.has(String(req.socket?.remoteAddress || "")) && isReplay(req)) {
        const xff = String(req.headers["x-forwarded-for"] || "");
        const last = xff.split(",").pop().trim();
        if (isIP(last)) Object.defineProperty(req, "ip", { value: last, configurable: true, enumerable: true, writable: true });
      }
    } catch { /* keep the socket address */ }
    next();
  };
}
