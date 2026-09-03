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
  const [a, b, c] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    // 192.0.0.0/24 special-purpose + 192.0.2.0/24 TEST-NET-1 only — the rest of
    // 192.0.0.0/16 is ordinary public space (192.0.64.0/18 is Automattic:
    // gravatar.com, wordpress.com; blocking b===0 alone broke those).
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
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

export function isPrivateIp(ip) {
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
  // Force IPv4. Railway's egress has NO working IPv6 — every AAAA address is
  // ENETUNREACH — and Node's happy-eyeballs races the IPv6 address on a dual-stack
  // host ~15% of the time, surfacing as UND_ERR_SOCKET / "could not connect"
  // (the repeatable ~4-7% 504s on treasury-debt/avg-rates, gov-data, fx, edgar).
  // Resolving IPv4-only never attempts v6; an IPv6-only host is unreachable here
  // anyway, so nothing is lost.
  lookupCb(hostname, { ...options, family: 4 }, (err, address, family) => {
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
// A FRESH pinned dispatcher for callers that must not reuse a kept-alive
// connection. Measured 2026-09-01 on a real seller: their edge corrupts the
// socket after serving a 402, so a paid retry reusing the bare leg's
// connection died with undici's "invalid content-length header" - an async
// throw that surfaced as an uncaught exception - while the same request on a
// fresh connection settled fine. Same guardedLookup pin, so SSRF safety is
// identical; the caller owns close().
export const freshSsrfDispatcher = () => new Agent({ connect: { lookup: guardedLookup, timeout: FETCH_TIMEOUT_MS } });

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

// Retry a thunk on TRANSIENT upstream failures only — 504 (timeout/network),
// 502/503 (gateway). A 4xx (e.g. safeFetch's 422 for a caller-attributable
// upstream error) is deterministic: the request itself is wrong, so retrying
// just wastes the caller's time budget — fail fast. Capped at one extra
// attempt by default so worst-case latency stays bounded.
//
// Originally lived in macro-kit.js (built for api.fiscaldata.treasury.gov's
// ~4-7% transient 504 rate); moved here 2026-08-12 after the same shape of
// failure — a legitimate-but-occasionally-slow public API losing the single
// fixed-timeout safeFetch attempt — recurred across gov-kit.js and
// weather-kit.js (different tool each time: weather-hourly, fec-candidates,
// vehicle-recalls, feed-parse, all in one day) instead of staying macro-kit-
// specific. macro-kit.js re-exports this so its own import path and tests
// (test-macro-kit.js) are unaffected by the move.
export async function retryTransient(fn, { retries = 1, backoffMs = 300 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const sc = e?.statusCode;
      if (attempt < retries && (sc === 504 || sc === 502 || sc === 503)) {
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Fetch a public http(s) URL with SSRF protection, size cap, and timeout.
 * Returns { finalUrl, html } — or { finalUrl, buffer } with `binary: true`.
 */
export async function safeFetch(rawUrl, { binary = false, maxBytes = MAX_BYTES, headers = {}, method = "GET", body, timeoutMs = FETCH_TIMEOUT_MS, validators = null, allowNotModified = false } = {}) {
  const url = await assertPublicUrl(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      // Optional request body (e.g. a JSON POST to a search API). The method and
      // body never change the connection TARGET — assertPublicUrl already pinned
      // the host and ssrfDispatcher re-validates every redirect hop — so SSRF
      // safety is identical to a GET.
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
      redirect: "follow",
      dispatcher: ssrfDispatcher,
      // Caller headers (e.g. an upstream API key) merge over the defaults;
      // headers don't change the connection target, so SSRF safety is unaffected.
      // Conditional request. `validators` are an ETag / Last-Modified pair kept
      // from a previous fetch of this exact URL; sending them lets the origin
      // answer 304 with no body instead of shipping the whole document again.
      // Caller headers still win, so an explicit If-None-Match is never
      // overwritten by a stale stored one.
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,*/*",
        ...(validators?.etag ? { "If-None-Match": validators.etag } : {}),
        ...(validators?.lastModified ? { "If-Modified-Since": validators.lastModified } : {}),
        ...headers,
      },
    });
  } catch (err) {
    if (isSsrfBlock(err)) throw badRequest("URL resolves to a private address");
    const timedOut = err.name === "AbortError";
    // undici's generic "fetch failed" hides the real transport error — walk
    // the cause chain for a code (ECONNRESET, UND_ERR_CONNECT_TIMEOUT, …) so
    // telemetry can tell egress problems from slow upstreams.
    let code = null;
    for (let e = err.cause; e && !code; e = e.cause) code = e.code || null;
    throw Object.assign(
      new Error(
        timedOut
          ? `Source URL did not respond within ${Math.round(timeoutMs / 1000)}s - host may be slow or unreachable`
          : `Could not connect to source URL: ${err.message}${code ? ` (${code})` : ""}`
      ),
      { statusCode: 504 }
    );
  } finally {
    clearTimeout(timer);
  }

  // 304 Not Modified is a SUCCESS, and it must be handled before the !ok check
  // below - `response.ok` is false for 304, so without this a conditional
  // request that worked perfectly would be reported as an upstream 4xx.
  // Only callers that asked for it (and therefore have the previous content to
  // reuse) get this; everyone else keeps the old behaviour.
  if (response.status === 304 && allowNotModified) {
    return { finalUrl: response.url, notModified: true, validators: readValidators(response) };
  }

  // Attribute upstream HTTP errors honestly. A 4xx from the upstream means the
  // caller picked a URL that doesn't serve (wrong path, 403/410, link rotted) —
  // that's caller-attributable, so surface it as 422 (Unprocessable Entity) and
  // the dashboard counts it under client_errored. A 5xx from the upstream is a
  // real upstream outage — surface as 502 and count it under server_errored. In
  // both cases the message names the upstream status so the agent knows what to
  // do next (fix the URL vs. retry later).
  if (!response.ok) {
    const upstreamStatus = response.status;
    if (upstreamStatus >= 400 && upstreamStatus < 500) {
      throw Object.assign(
        new Error(
          `Source URL returned HTTP ${upstreamStatus} - check the URL is correct and publicly reachable`
        ),
        { statusCode: 422, upstreamStatus }
      );
    }
    throw Object.assign(
      new Error(`Source URL's host returned HTTP ${upstreamStatus} - upstream issue, try again later`),
      { statusCode: 502, upstreamStatus }
    );
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
  // `contentType` is surfaced so kit-specific handlers (e.g. media-kit) can
  // fail fast when the response shape obviously doesn't match what they need
  // (text/html when an audio file is expected), instead of burning a worker
  // slot on a doomed ffprobe/parse and returning a less specific error.
  const contentType = response.headers.get("content-type") || "";
  const vals = readValidators(response);
  if (binary) return { finalUrl: response.url, buffer, contentType, validators: vals };
  return { finalUrl: response.url, html: buffer.toString("utf-8"), contentType, validators: vals };
}

/** ETag / Last-Modified off a response, or null when the origin sends neither.
 *  Returned on every safeFetch so a caller can store them and revalidate next
 *  time; null means this origin cannot be revalidated and must be re-fetched. */
function readValidators(response) {
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  if (!etag && !lastModified) return null;
  return { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
}
