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
// the count for the operator. The window is an hour.
//
// THRESHOLD: the word turns only past CDN_ORIGIN_UNAUTH_ALERT such requests
// in the window (default 100, floor 1). A Worker, a health check or a crawler
// on the CDN's own ranges that calls the hosting edge's host directly reaches
// the origin without the secret and is correctly keyed on its own address;
// a few of those an hour are not a lost secret. A missing or rotated secret
// makes EVERY proxied request count, so it crosses the threshold inside
// minutes of ordinary traffic.
//
// SHARED: every such request is also an entry in a shared hour window
// (src/shared-limits.js, injected by the mount as `shared`), and the count
// every replica contributed to is mirrored here (refreshed by each write and
// by refreshCdnOriginShared, which the status read awaits); the word reads
// the larger of that and this process's own count, so two replicas behind
// one proxy answer the same word instead of each reading only the requests
// it happened to serve. Without a shared store the count is per process.
const CDN_ORIGIN_WINDOW_MS = 60 * 60_000;
const CDN_ORIGIN_MAX_KEPT = 5_000;
const CDN_ORIGIN_SHARED_NAME = "cdn-origin-unauth";
/** How many unauthenticated CDN-range requests in the window turn the word. */
export const CDN_ORIGIN_UNAUTH_ALERT = Math.max(1, parseInt(process.env.CDN_ORIGIN_UNAUTH_ALERT || "100", 10) || 100);
const unauthenticatedCdnPeers = []; // timestamps
let unauthenticatedCdnPeersTotal = 0;
let lastUnauthenticatedCdnPeerAt = 0;
let cdnShared = null; // { windowAdd, windowRead } or null
let cdnSharedMirror = { count: 0, at: 0 };
let cdnSharedSeq = 0;
const cdnSharedProc = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
function noteUnauthenticatedCdnPeer(now = Date.now()) {
  unauthenticatedCdnPeersTotal++;
  lastUnauthenticatedCdnPeerAt = now;
  unauthenticatedCdnPeers.push(now);
  if (unauthenticatedCdnPeers.length > CDN_ORIGIN_MAX_KEPT) unauthenticatedCdnPeers.splice(0, unauthenticatedCdnPeers.length - CDN_ORIGIN_MAX_KEPT);
  if (cdnShared) {
    Promise.resolve()
      .then(() => cdnShared.windowAdd(CDN_ORIGIN_SHARED_NAME, "all", { windowMs: CDN_ORIGIN_WINDOW_MS, member: `${cdnSharedProc}:${++cdnSharedSeq}`, now }))
      .then((r) => { if (r?.ok) cdnSharedMirror = { count: r.count, at: now }; }, () => { /* the store's own status word reports it */ });
  }
}
/** Read the shared hour window into the mirror (a no-op without a shared store). */
export async function refreshCdnOriginShared(now = Date.now()) {
  if (!cdnShared) return;
  try {
    const r = await cdnShared.windowRead(CDN_ORIGIN_SHARED_NAME, "all", { windowMs: CDN_ORIGIN_WINDOW_MS, now });
    if (r?.ok) cdnSharedMirror = { count: r.count, at: now };
  } catch { /* the store's own status word reports it */ }
}
/** The status word (/api/gateway-status): off while the resolver is off,
 *  unauthenticated when at least `threshold` CDN-range requests reached the
 *  origin without a valid X-Origin-Auth inside the window (across the
 *  replicas, when a shared store is wired), else ok. `full` adds the counts. */
export function cdnOriginStatus({ full = false, now = Date.now(), enabled = cdnProxyEnabled(), secret = cdnOriginSecret(), threshold = CDN_ORIGIN_UNAUTH_ALERT } = {}) {
  if (!enabled) return { status: "off" };
  while (unauthenticatedCdnPeers.length && now - unauthenticatedCdnPeers[0] > CDN_ORIGIN_WINDOW_MS) unauthenticatedCdnPeers.shift();
  // The shared count is a reading of the hour window; one older than a few
  // minutes may overstate (entries age out), never understate, so it is kept
  // only that long.
  const sharedN = cdnShared && now - cdnSharedMirror.at < 300_000 ? cdnSharedMirror.count : 0;
  const n = Math.max(unauthenticatedCdnPeers.length, sharedN);
  const status = n >= threshold ? "unauthenticated" : "ok";
  return full
    ? { status, unauthenticatedInWindow: n, threshold, scope: cdnShared ? "shared" : "instance", unauthenticatedSinceBoot: unauthenticatedCdnPeersTotal, windowMinutes: CDN_ORIGIN_WINDOW_MS / 60_000, lastAt: lastUnauthenticatedCdnPeerAt ? new Date(lastUnauthenticatedCdnPeerAt).toISOString() : null, secretConfigured: Boolean(secret) }
    : { status };
}
/** Tests: forget the counted peers (this process's count and its mirror of the shared window). */
export function __resetCdnOriginStatus() { unauthenticatedCdnPeers.length = 0; unauthenticatedCdnPeersTotal = 0; lastUnauthenticatedCdnPeerAt = 0; cdnSharedMirror = { count: 0, at: 0 }; }

/** Express middleware: mount right after app.set("trust proxy", ...) and
 *  before any middleware that reads req.ip. Off (CDN_PROXY unset), it only
 *  calls next(). `shared` ({ windowAdd, windowRead }, src/shared-limits.js)
 *  makes the unauthenticated count span the replicas. */
export function cdnClientIpMiddleware({ enabled = cdnProxyEnabled(), secret = cdnOriginSecret(), ranges = null, log = console.warn, shared = null } = {}) {
  if (!enabled) return function cdnClientIpOff(_req, _res, next) { next(); };
  if (!secret) log(`[cdn-client-ip] CDN_PROXY is on but CDN_ORIGIN_SECRET is unset or shorter than ${MIN_ORIGIN_SECRET_LENGTH} characters: CF-Connecting-IP is ignored on every request`);
  cdnShared = shared && typeof shared.windowAdd === "function" && typeof shared.windowRead === "function" ? shared : null;
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
