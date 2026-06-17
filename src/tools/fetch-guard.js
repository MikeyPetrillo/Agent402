import { lookup } from "node:dns/promises";
import { lookup as lookupCb } from "node:dns";
import { isIP } from "node:net";
import { Agent } from "undici";

const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; Agent402/1.0; +https://github.com/MikeyPetrillo/Agent402)";

const SSRF_BLOCK_CODE = "ESSRFBLOCKED";

function isPrivateV4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 special-purpose + 192.0.2.0/24 doc
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51) || (a === 203 && b === 113) || // doc ranges
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expand an IPv6 literal to 8 hextet numbers, supporting "::" and a trailing
 *  dotted-quad. Returns null when unparseable (callers treat that as blocked). */
function expandV6(ip) {
  let s = ip;
  // trailing dotted-quad (e.g. ::ffff:169.254.169.254) → two hextets
  const v4 = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    s = s.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - left.length - right.length;
  if (halves.length === 2 ? fill < 0 : left.length !== 8) return null;
  const parts = [...left, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...right];
  const out = parts.map((p) => (/^[0-9a-f]{1,4}$/i.test(p) ? parseInt(p, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function isPrivateIp(ip) {
  if (!ip.includes(":")) return isPrivateV4(ip);
  if (ip.includes("%")) return true; // zone-scoped — never a global address
  const g = expandV6(ip.toLowerCase());
  if (!g) return true; // unparseable — fail closed
  const embedded = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.every((x) => x === 0)) return true; // :: unspecified (routes to loopback)
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) — re-check the v4
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateV4(embedded(g[6], g[7]));
  // NAT64 64:ff9b::/96 — translated v4 in the low 32 bits
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return isPrivateV4(embedded(g[6], g[7]));
  // 6to4 2002::/16 — v4 embedded in hextets 1-2
  if (g[0] === 0x2002) return isPrivateV4(embedded(g[1], g[2]));
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo tunnel
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard 100::/64
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * A DNS lookup that rejects any resolved private/loopback/metadata address.
 * Used as the connect-time `lookup` for the SSRF dispatcher below: because the
 * connection is made to the exact IP this returns, an attacker cannot win the
 * race between an upfront DNS check and the socket connect (DNS rebinding), and
 * every redirect hop re-resolves through the same guard.
 */
function guardedLookup(hostname, options, callback) {
  lookupCb(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const entries = Array.isArray(address) ? address : [{ address, family }];
    for (const e of entries) {
      if (isPrivateIp(e.address)) {
        return callback(Object.assign(new Error(`Blocked: ${hostname} resolves to a private address`), { code: SSRF_BLOCK_CODE }));
      }
    }
    callback(null, address, family);
  });
}

// Shared dispatcher that pins every connection (and redirect hop) to a
// validated public IP. Scoped to the tool fetchers — it is passed explicitly
// and never set as the process-global dispatcher, so the x402 payment client's
// own outbound calls are unaffected.
export const ssrfDispatcher = new Agent({ connect: { lookup: guardedLookup, timeout: FETCH_TIMEOUT_MS } });

// Distinguish an SSRF-block from a generic network failure on a thrown fetch error.
export function isSsrfBlock(err) {
  let e = err;
  for (let i = 0; i < 5 && e; i++) {
    if (e.code === SSRF_BLOCK_CODE) return true;
    e = e.cause;
  }
  return false;
}

// Request-time host check for the browser renderer: every request a page makes
// (navigation, redirect hop, subresource) is validated against the same policy
// as the fetch path. Very-short-TTL cache: long enough to dedupe the burst of
// subresources a single page load fires, short enough that a flip from a
// public to a private answer is observed almost immediately. 30s was the
// original value; tightened to 2s after the security audit because Chromium
// can pipeline subresource lookups for minutes during a long render.
const hostCache = new Map();
const HOST_CACHE_TTL_MS = 2_000;
export async function hostIsPublic(hostname) {
  if (isIP(hostname)) return !isPrivateIp(hostname);
  const now = Date.now();
  const hit = hostCache.get(hostname);
  if (hit && hit.exp > now) return hit.ok;
  let ok = false;
  try {
    const addrs = await lookup(hostname, { all: true });
    ok = addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    ok = false;
  }
  if (hostCache.size > 5000) hostCache.clear();
  hostCache.set(hostname, { ok, exp: now + HOST_CACHE_TTL_MS });
  return ok;
}

/**
 * Validate that a URL is http(s) and does not resolve to a private address.
 * Returns the parsed URL. Shared by the plain fetcher and the browser renderer.
 */
export async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw badRequest("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest("Only http(s) URLs are supported");
  }
  // Strip any userinfo (user:pass@host): we won't forward caller-smuggled
  // credentials to an upstream host from our egress IP, and userinfo can
  // confuse host parsing.
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }

  // IPv6 literals keep their brackets in URL.hostname — strip them so the IP
  // check actually evaluates the address (literals never hit DNS, so this
  // upfront check is the only guard they get).
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) ? isPrivateIp(host) : false) {
    throw badRequest("URL resolves to a private address");
  }
  if (!isIP(host)) {
    let resolved;
    try {
      resolved = await lookup(host);
    } catch {
      throw badRequest(`Could not resolve host: ${host}`);
    }
    if (isPrivateIp(resolved.address)) {
      throw badRequest("URL resolves to a private address");
    }
  }
  return url;
}

/**
 * Fetch a public http(s) URL with SSRF protection, size cap, and timeout.
 * Returns { finalUrl, html } — or { finalUrl, buffer } with `binary: true`.
 */
export async function safeFetch(rawUrl, { binary = false, maxBytes = MAX_BYTES } = {}) {
  const url = await assertPublicUrl(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      dispatcher: ssrfDispatcher,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,*/*" },
    });
  } catch (err) {
    if (isSsrfBlock(err)) throw badRequest("URL resolves to a private address");
    throw Object.assign(
      new Error(err.name === "AbortError" ? "Upstream fetch timed out" : `Fetch failed: ${err.message}`),
      { statusCode: 504 }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw Object.assign(new Error(`Upstream returned HTTP ${response.status}`), { statusCode: 502 });
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      reader.cancel();
      throw Object.assign(new Error(`Resource exceeds ${Math.round(maxBytes / 1048576)}MB limit`), {
        statusCode: 413,
      });
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks);
  if (binary) return { finalUrl: response.url, buffer };
  return { finalUrl: response.url, html: buffer.toString("utf-8") };
}
