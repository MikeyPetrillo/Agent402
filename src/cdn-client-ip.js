// The client address, whether a request reached us straight through the
// hosting edge or through a CDN proxy in front of it.
//
// "trust proxy" (TRUST_PROXY_HOPS, default 1) makes req.ip the address the
// hosting edge saw: the last X-Forwarded-For entry, which the edge appends and
// a caller cannot choose. Reached directly, that is the client. Reached through
// Cloudflare's proxy, it is a Cloudflare address, and the client is the
// CF-Connecting-IP header Cloudflare sets.
//
// SWITCH: CDN_PROXY ("cloudflare" or "on"; default off). Off, the middleware
// is a pass-through: CF-Connecting-IP is never read and req.ip is the address
// trust proxy gives, unchanged.
//
// RULE (on): CF-Connecting-IP is read ONLY when the edge-reported peer (req.ip
// under the hop count) is inside Cloudflare's published ranges, AND the request
// carries the shared origin secret (CDN_ORIGIN_SECRET) in X-Origin-Auth, which
// the proxy adds for this zone only, AND the header parses as an IP address.
// Without all three the header is ignored entirely, so neither a caller sending
// its own CF-Connecting-IP straight to the hosting edge nor one calling from
// Cloudflare's ranges (a Worker, another zone) can change the address any
// limiter, budget or attribution keys on. The secret is compared in constant
// time and removed from the request headers before any handler runs.
//
// The middleware redefines req.ip on the request itself, before any reader
// runs, so every req.ip reader (limiters, budgets, the async job replay, the
// connector loopback) sees the resolved address. req.viaCdn marks a request
// that came through the CDN proxy (src/cdn-sync-window.js reads it).
//
// RANGES: https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6
// (fetched 2026-10-21). CF_IP_RANGES_EXTRA adds CIDRs (comma or space
// separated) without a code change when the published list grows.
import { BlockList, isIP } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";

export const CLOUDFLARE_IPV4 = Object.freeze([
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
]);
export const CLOUDFLARE_IPV6 = Object.freeze([
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
]);

/** A BlockList of the published ranges plus any extra CIDRs. Bad extras are skipped. */
export function buildCdnRanges(extra = process.env.CF_IP_RANGES_EXTRA) {
  const list = new BlockList();
  const add = (cidr) => {
    const [addr, bitsRaw] = String(cidr).trim().split("/");
    const fam = isIP(addr || "");
    const bits = Number(bitsRaw);
    if (!fam || !Number.isInteger(bits) || bits < 0 || bits > (fam === 4 ? 32 : 128)) return false;
    list.addSubnet(addr, bits, fam === 4 ? "ipv4" : "ipv6");
    return true;
  };
  for (const c of [...CLOUDFLARE_IPV4, ...CLOUDFLARE_IPV6]) add(c);
  for (const c of String(extra || "").split(/[\s,]+/).filter(Boolean)) {
    if (!add(c)) console.warn(`[cdn-client-ip] CF_IP_RANGES_EXTRA entry ignored (not a CIDR): ${c.slice(0, 64)}`);
  }
  return list;
}

/** "::ffff:1.2.3.4" -> "1.2.3.4"; anything else trimmed. */
export function normalizeIp(v) {
  const s = String(v ?? "").trim();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  return m ? m[1] : s;
}

/** True when `ip` is inside the ranges. */
export function inCdnRanges(ip, ranges) {
  const a = normalizeIp(ip);
  const fam = isIP(a);
  if (!fam) return false;
  try { return ranges.check(a, fam === 4 ? "ipv4" : "ipv6"); } catch { return false; }
}

/** The header the proxy sets to the shared origin secret. */
export const ORIGIN_AUTH_HEADER = "x-origin-auth";
/** Shortest CDN_ORIGIN_SECRET accepted; a shorter one counts as unset. */
export const MIN_ORIGIN_SECRET_LENGTH = 16;

/** True when CDN_PROXY turns the resolver on ("cloudflare" or "on"). */
export function cdnProxyEnabled(env = process.env) {
  const v = String(env.CDN_PROXY || "").trim().toLowerCase();
  return v === "cloudflare" || v === "on";
}

/** The configured origin secret, or "" when unset or too short. */
export function cdnOriginSecret(env = process.env) {
  const s = String(env.CDN_ORIGIN_SECRET || "");
  return s.length >= MIN_ORIGIN_SECRET_LENGTH ? s : "";
}

const digest = (v) => createHash("sha256").update(String(v)).digest();
/** Constant-time check of an X-Origin-Auth value against the secret. False
 *  when no secret is configured or the header is missing or repeated. */
export function originAuthOk(header, secret) {
  if (!secret || typeof header !== "string" || !header) return false;
  return timingSafeEqual(digest(header), digest(secret));
}

/** The client address for an edge-reported peer and a CF-Connecting-IP value.
 *  { ip, viaCdn }: viaCdn is true when the peer is a CDN address that carried
 *  the origin secret (originAuthed), whether or not the header was usable; ip
 *  is the header only then and only when valid. */
export function resolveClientIp(edgeIp, cfHeader, ranges, originAuthed = false) {
  const peer = normalizeIp(edgeIp);
  if (originAuthed !== true || !inCdnRanges(peer, ranges)) return { ip: peer, viaCdn: false };
  const raw = Array.isArray(cfHeader) ? cfHeader[0] : cfHeader;
  const cand = normalizeIp(typeof raw === "string" ? raw : "");
  return { ip: cand && cand.length <= 64 && isIP(cand) ? cand : peer, viaCdn: true };
}

// CDN-range peers that reached the origin without a valid origin secret: with
// the resolver on, each such request is keyed on the edge address instead of
// its client. A missing or rotated CDN_ORIGIN_SECRET looks exactly like this,
// so it is one word on /api/gateway-status (ok / unauthenticated / off) with
// the count for the operator. Per process; the window is an hour.
const CDN_ORIGIN_WINDOW_MS = 60 * 60_000;
const CDN_ORIGIN_MAX_KEPT = 5_000;
const unauthenticatedCdnPeers = []; // timestamps
let unauthenticatedCdnPeersTotal = 0;
let lastUnauthenticatedCdnPeerAt = 0;
function noteUnauthenticatedCdnPeer(now = Date.now()) {
  unauthenticatedCdnPeersTotal++;
  lastUnauthenticatedCdnPeerAt = now;
  unauthenticatedCdnPeers.push(now);
  if (unauthenticatedCdnPeers.length > CDN_ORIGIN_MAX_KEPT) unauthenticatedCdnPeers.splice(0, unauthenticatedCdnPeers.length - CDN_ORIGIN_MAX_KEPT);
}
/** The status word (/api/gateway-status): off while the resolver is off,
 *  unauthenticated when a CDN-range peer reached the origin without a valid
 *  X-Origin-Auth inside the window, else ok. `full` adds the counts. */
export function cdnOriginStatus({ full = false, now = Date.now(), enabled = cdnProxyEnabled(), secret = cdnOriginSecret() } = {}) {
  if (!enabled) return { status: "off" };
  while (unauthenticatedCdnPeers.length && now - unauthenticatedCdnPeers[0] > CDN_ORIGIN_WINDOW_MS) unauthenticatedCdnPeers.shift();
  const n = unauthenticatedCdnPeers.length;
  const status = n ? "unauthenticated" : "ok";
  return full
    ? { status, unauthenticatedInWindow: n, unauthenticatedSinceBoot: unauthenticatedCdnPeersTotal, windowMinutes: CDN_ORIGIN_WINDOW_MS / 60_000, lastAt: lastUnauthenticatedCdnPeerAt ? new Date(lastUnauthenticatedCdnPeerAt).toISOString() : null, secretConfigured: Boolean(secret) }
    : { status };
}
/** Tests: forget the counted peers. */
export function __resetCdnOriginStatus() { unauthenticatedCdnPeers.length = 0; unauthenticatedCdnPeersTotal = 0; lastUnauthenticatedCdnPeerAt = 0; }

/** Express middleware: mount right after app.set("trust proxy", ...) and
 *  before any middleware that reads req.ip. Off (CDN_PROXY unset), it only
 *  calls next(). */
export function cdnClientIpMiddleware({ enabled = cdnProxyEnabled(), secret = cdnOriginSecret(), ranges = null, log = console.warn } = {}) {
  if (!enabled) return function cdnClientIpOff(_req, _res, next) { next(); };
  if (!secret) log(`[cdn-client-ip] CDN_PROXY is on but CDN_ORIGIN_SECRET is unset or shorter than ${MIN_ORIGIN_SECRET_LENGTH} characters: CF-Connecting-IP is ignored on every request`);
  const list = ranges || buildCdnRanges();
  return function cdnClientIp(req, _res, next) {
    let edgeIp = "";
    try { edgeIp = req.ip || ""; } catch { edgeIp = ""; }
    const authed = originAuthOk(req.headers[ORIGIN_AUTH_HEADER], secret);
    delete req.headers[ORIGIN_AUTH_HEADER];
    if (!authed && inCdnRanges(edgeIp, list)) noteUnauthenticatedCdnPeer();
    const { ip, viaCdn } = resolveClientIp(edgeIp, req.headers["cf-connecting-ip"], list, authed);
    if (viaCdn) {
      Object.defineProperty(req, "ip", { value: ip, configurable: true, enumerable: true, writable: true });
      req.cdnPeerIp = normalizeIp(edgeIp);
    }
    req.viaCdn = viaCdn;
    next();
  };
}
