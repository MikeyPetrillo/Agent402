// How many proxy hops in front of this server are trusted to report the client
// address (Express "trust proxy"). Every per-IP limiter keys on req.ip, so the
// value decides whether a client can name its own address: with N hops trusted,
// req.ip is the Nth X-Forwarded-For entry from the right, and a server with no
// proxy in front that trusts one hop reads the entry the client wrote.
//
// TRUST_PROXY_HOPS unset (or empty) is 0: req.ip is the socket peer and no
// forwarded header counts. A deployment behind one edge proxy (Railway) sets 1.
// A value that is not a whole number from 0 to 10 is read as 0, with a warning.
// Unset in production (src/production-env.js) the boot still serves, but the
// warning goes to stderr as an error: behind the edge every client would read
// as the edge's address and share one bucket in every per-IP limiter. The
// deploy job's variable upsert sets 1, so a production boot never reads it unset.
// src/cdn-client-ip.js runs after this and keeps its own CDN rules.

import { isIP, BlockList } from "node:net";
import { isProductionEnv } from "./production-env.js";

const MAX_HOPS = 10;

export function trustProxyHops(env = process.env, warn = (m) => console.warn(m), alarm = (m) => console.error(m)) {
  const raw = env.TRUST_PROXY_HOPS;
  if (raw === undefined || String(raw).trim() === "") {
    if (isProductionEnv(env)) {
      alarm("[trust-proxy] ERROR: production boot with TRUST_PROXY_HOPS unset: trusting no X-Forwarded-For hop, so every client behind the edge reads as the edge's address and shares one bucket in every per-IP limiter. Set TRUST_PROXY_HOPS=1 on the service (the deploy job's variable upsert sets it).");
      return 0;
    }
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

// Peers that are a proxy in front of this listener far more often than a
// client: loopback and the private, shared and link-local ranges.
const PROXY_LIKE = new BlockList();
for (const [net, bits] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["169.254.0.0", 16]]) PROXY_LIKE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::1", 128], ["fc00::", 7], ["fe80::", 10]]) PROXY_LIKE.addSubnet(net, bits, "ipv6");
export function isProxyLikePeer(addr) {
  let a = String(addr || "").trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) a = mapped[1];
  const fam = isIP(a);
  if (!fam) return false;
  try { return PROXY_LIKE.check(a, fam === 4 ? "ipv4" : "ipv6"); } catch { return false; }
}

/** Mounted only when hops is 0. A request from a loopback or private peer
 *  that carries X-Forwarded-For is the sign of a proxy in front that
 *  TRUST_PROXY_HOPS does not count: every client behind it then shares the
 *  proxy's address in each per-IP limiter. Warns once per process (our own
 *  proven loopback replays, which carry the buyer's address, never count),
 *  and changes nothing about the request. */
export function forwardedWithoutHopsWarning({ isReplay = () => false, warn = (m) => console.warn(m) } = {}) {
  let warned = false;
  return function forwardedWithoutHops(req, _res, next) {
    if (!warned) {
      try {
        if (req.headers["x-forwarded-for"] !== undefined && isProxyLikePeer(req.socket?.remoteAddress) && !isReplay(req)) {
          warned = true;
          warn("[trust-proxy] a request from a loopback or private peer carries X-Forwarded-For while TRUST_PROXY_HOPS is 0 (unset reads 0): every client behind that proxy shares its address in each per-IP limiter. Behind a reverse proxy, set TRUST_PROXY_HOPS to the number of proxies in front (1 behind a single edge). Logged once per process.");
        }
      } catch { /* a warning never breaks a request */ }
    }
    next();
  };
}
