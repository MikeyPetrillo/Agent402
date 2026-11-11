import { lookup } from "node:dns/promises";
import { lookup as lookupCb } from "node:dns";
import { isIP } from "node:net";
import { Agent, buildConnector } from "undici";
import { checkServerIdentity } from "../tls-distrust.js";

const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
// Points at the page that explains the crawl and offers removal, not at the
// code repo: an operator who finds this string in their logs wants to know
// what we read and how to stop us, and a link to a source tree answers
// neither. src/crawler-page.js is the page, and it imports this string; the
// index crawler's raw 402 probes (x402-index.js, mpp-index.js) send it too.
export const USER_AGENT =
  "Mozilla/5.0 (compatible; Agent402/1.0; +https://agent402.tools/crawler)";

const SSRF_BLOCK_CODE = "ESSRFBLOCKED";

/** The refusal for a host that does not resolve or resolves to a private address. */
export const UNRESOLVED_OR_PRIVATE = "URL host could not be resolved, or resolves to a private address";

// One error for every connect-time refusal (a name that does not resolve, a
// name with a private answer, a private literal), so a redirect hop reads the
// same whichever it was: same code, same message. The resolver error stays on
// .cause for logs and is never put in the message.
function blockedError(cause) {
  return Object.assign(new Error(UNRESOLVED_OR_PRIVATE), { code: SSRF_BLOCK_CODE, ...(cause ? { cause } : {}) });
}

// A resolver that failed to answer (as opposed to answering "no such name"):
// the name may well exist, so the caller's URL is not at fault and a retry can
// succeed. getaddrinfo reports EAI_AGAIN; the c-ares codes cover a resolver
// that returned SERVFAIL, timed out, refused the query or was unreachable.
// Answered apart from the refusal above, it says nothing about which names
// exist or what they resolve to.
const TRANSIENT_LOOKUP_CODES = new Set([
  "EAI_AGAIN", "ESERVFAIL", "ETIMEOUT", "ETIMEDOUT", "ECONNREFUSED", "EREFUSED", "ECANCELLED", "EDNSLOOKUPTIMEOUT",
]);
export const LOOKUP_RETRY_AFTER_S = 5;
const LOOKUP_UNAVAILABLE_CODE = "EDNSUNAVAILABLE";
/** The answer for a lookup the resolver could not finish. Names no address class. */
export const LOOKUP_UNAVAILABLE = "Name resolution for the URL host is temporarily unavailable on this server; retry shortly";

/** True when a resolver error means "try again", not "this name has no answer". */
export function isTransientLookupError(err) {
  return TRANSIENT_LOOKUP_CODES.has(String(err?.code || ""));
}

export function lookupUnavailable(cause) {
  return Object.assign(new Error(LOOKUP_UNAVAILABLE), {
    code: LOOKUP_UNAVAILABLE_CODE,
    statusCode: 503,
    // This server's own resolver path (the attribution vocabulary of
    // src/upstream-deadline.js, written out here so this module imports
    // nothing of the payment path): ours, kind our-egress.
    attribution: "ours",
    hint: "our-egress",
    retryAfter: LOOKUP_RETRY_AFTER_S,
    ...(cause ? { cause } : {}),
  });
}

// The retryable lookup failure, wherever it sits on a thrown fetch error's cause chain.
function lookupUnavailableIn(err) {
  let e = err;
  for (let i = 0; i < 5 && e; i++) {
    if (e.code === LOOKUP_UNAVAILABLE_CODE) return e;
    e = e.cause;
  }
  return null;
}

// One bound on an upfront lookup, so a resolver that never answers reads as a
// lookup that could not finish rather than a request that hangs.
// DNS_LOOKUP_TIMEOUT_MS overrides the default, read per call.
const LOOKUP_TIMEOUT_MS = 10_000;
async function boundedLookup(host) {
  const timeoutMs = Number(process.env.DNS_LOOKUP_TIMEOUT_MS) > 0 ? Number(process.env.DNS_LOOKUP_TIMEOUT_MS) : LOOKUP_TIMEOUT_MS;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("lookup timed out"), { code: "EDNSLOOKUPTIMEOUT" })), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([lookup(host), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

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
  // IPv4-translated (::ffff:0:0:0/96, RFC 2765): re-check the v4
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return isPrivateV4(embedded(g[6], g[7]));
  // NAT64 64:ff9b::/96 — translated v4 in the low 32 bits
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return isPrivateV4(embedded(g[6], g[7]));
  // Local-use NAT64 64:ff9b:1::/48 (RFC 8215). In the /96 layout the v4 is the
  // low 32 bits and is re-checked; any other layout puts the v4 where this
  // check cannot read it, so the address is refused.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) {
    return g[3] === 0 && g[4] === 0 && g[5] === 0 ? isPrivateV4(embedded(g[6], g[7])) : true;
  }
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

/** Seconds from a Retry-After header, delta-seconds or HTTP-date, bounded to a
 *  day and to something a caller can act on. null when it says nothing. */
export function retryAfterSeconds(header) {
  const raw = String(header ?? "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 0 && n <= 86400 ? n : null;
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  const secs = Math.ceil((at - Date.now()) / 1000);
  return secs > 0 && secs <= 86400 ? secs : null;
}

/** The host of a URL, for an error message. Never throws, never returns a path
 *  or a query - a refused URL can carry a caller's token in either. */
function safeHostOf(u) {
  try { return new URL(String(u)).host; } catch { return null; }
}

/** Turn an upstream HTTP failure into OUR status, with the attribution on it.
 *
 * NOT EVERY UPSTREAM 4xx IS THE CALLER'S URL BEING WRONG, and for a year every
 * one of them was answered with the sentence "check the URL is correct and
 * publicly reachable". Two whole classes are not about the caller's input:
 *
 *   429/408 - the host is throttling or timing out THIS SERVER. The URL is
 *   fine, the caller can change nothing, and the right move is to retry: the
 *   exact opposite of what the old message told them to do. Our own
 *   programmatic pages already special-cased this one layer up ("an EDGAR RATE
 *   LIMIT is never treated as unresolvable"), which is the tell that the
 *   misclassification was known and fixed at the instance, not the class.
 *
 *   401/403/407/451 - access, not addressing. Often it is OUR egress that is
 *   refused, not the caller's link; this repo documents three hosts that block
 *   our IPs outright while serving everyone else. A buyer told to check a URL
 *   that is correct and publicly reachable concludes their input is broken, or
 *   that we are.
 *
 * `attribution` is the machine-readable half (here "caller" | "upstream" |
 * "upstream-access"; the whole vocabulary is in src/upstream-deadline.js);
 * the route binder in server.js reads it to decide whether echoing the tool's
 * input schema back would be help or a lie.
 *
 * Pure so it unit-tests with no socket and no DNS, like probe-classify.js.
 */
export function upstreamFailure(upstreamStatus, { retryAfter = null, host = null } = {}) {
  const where = host || "the host";
  if (upstreamStatus === 429 || upstreamStatus === 408) {
    return Object.assign(
      new Error(`The host rate-limited or timed out this server (HTTP ${upstreamStatus}) - the URL is fine, this is throttling at ${where}; retry${retryAfter ? ` in ${retryAfter}s` : " later"}`),
      { statusCode: 503, upstreamStatus, attribution: "upstream", ...(retryAfter ? { retryAfter } : {}) }
    );
  }
  if ([401, 403, 407, 451].includes(upstreamStatus)) {
    return Object.assign(
      new Error(`The host refused this server's request (HTTP ${upstreamStatus}) - this is access, not a bad URL: the resource may require credentials we do not hold, or the host may block this server's requests while serving yours`),
      { statusCode: 422, upstreamStatus, attribution: "upstream-access" }
    );
  }
  if (upstreamStatus >= 400 && upstreamStatus < 500) {
    return Object.assign(
      new Error(`Source URL returned HTTP ${upstreamStatus} - check the URL is correct and publicly reachable`),
      { statusCode: 422, upstreamStatus, attribution: "caller" }
    );
  }
  return Object.assign(
    new Error(`Source URL's host returned HTTP ${upstreamStatus} - upstream issue, try again later`),
    { statusCode: 502, upstreamStatus, attribution: "upstream" }
  );
}

/**
 * A DNS lookup that rejects any resolved private/loopback/metadata address.
 * Used as the connect-time `lookup` for the SSRF dispatcher below: because the
 * connection is made to the exact IP this returns, an attacker cannot win the
 * race between an upfront DNS check and the socket connect (DNS rebinding), and
 * every redirect hop re-resolves through the same guard.
 */
// A single-label name (no dot: "ftp", "localhost", an internal service name)
// is never a public site, and how a resolver answers one depends on the
// machine's search domains. It is refused like a private address, before any
// lookup, so the answer is the same on every host.
function isSingleLabel(host) {
  return !isIP(host) && !String(host).replace(/\.$/, "").includes(".");
}
function guardedLookup(hostname, options, callback) {
  if (isSingleLabel(hostname)) return callback(blockedError());
  // Force IPv4. Railway's egress has NO working IPv6 — every AAAA address is
  // ENETUNREACH — and Node's happy-eyeballs races the IPv6 address on a dual-stack
  // host ~15% of the time, surfacing as UND_ERR_SOCKET / "could not connect"
  // (the repeatable ~4-7% 504s on treasury-debt/avg-rates, gov-data, fx, edgar).
  // Resolving IPv4-only never attempts v6; an IPv6-only host is unreachable here
  // anyway, so nothing is lost.
  lookupCb(hostname, { ...options, family: 4 }, (err, address, family) => {
    // A name that does not resolve is refused exactly like a name with a
    // private answer: on a redirect hop the two must read the same. A
    // resolver that could not answer at all is neither, and is retryable.
    if (err) return callback(isTransientLookupError(err) ? lookupUnavailable(err) : blockedError(err));
    const entries = Array.isArray(address) ? address : [{ address, family }];
    for (const e of entries) {
      if (isPrivateIp(e.address)) return callback(blockedError());
    }
    callback(null, address, family);
  });
}

// Shared dispatcher that pins every connection (and redirect hop) to a
// validated public IP. Scoped to the tool fetchers — it is passed explicitly
// and never set as the process-global dispatcher, so the x402 payment client's
// own outbound calls are unaffected.
// The lookup above never runs for a literal IP: Node connects to it directly.
// A redirect to http://127.0.0.1/ or http://[::1]/ therefore skipped the check
// entirely, so every connection (each redirect hop included) is checked here,
// at connect time, whatever form its host takes.
function guardedConnector() {
  const connect = buildConnector({ lookup: guardedLookup, timeout: FETCH_TIMEOUT_MS, checkServerIdentity });
  return (opts, callback) => {
    const host = String(opts?.hostname || "").replace(/^\[|\]$/g, "");
    if (isIP(host) && isPrivateIp(host)) {
      return callback(blockedError(), null);
    }
    return connect(opts, callback);
  };
}
export const ssrfDispatcher = new Agent({ connect: guardedConnector() });
// A FRESH pinned dispatcher for callers that must not reuse a kept-alive
// connection. Measured 2026-09-01 on a real seller: their edge corrupts the
// socket after serving a 402, so a paid retry reusing the bare leg's
// connection died with undici's "invalid content-length header" - an async
// throw that surfaced as an uncaught exception - while the same request on a
// fresh connection settled fine. Same guardedLookup pin, so SSRF safety is
// identical; the caller owns close().
export const freshSsrfDispatcher = () => new Agent({ connect: guardedConnector() });

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
  // One message for "does not resolve" and "resolves to a private address",
  // so the answer cannot tell the caller which internal names exist.
  if (isIP(host) ? isPrivateIp(host) : false) {
    throw badRequest(UNRESOLVED_OR_PRIVATE);
  }
  if (isSingleLabel(host)) throw badRequest(UNRESOLVED_OR_PRIVATE);
  if (!isIP(host)) {
    let resolved;
    try {
      resolved = await boundedLookup(host);
    } catch (err) {
      if (isTransientLookupError(err)) throw lookupUnavailable(err);
      throw badRequest(UNRESOLVED_OR_PRIVATE);
    }
    if (isPrivateIp(resolved.address)) {
      throw badRequest(UNRESOLVED_OR_PRIVATE);
    }
  }
  return url;
}

/**
 * One unpaid probe of a crawled seller URL, answered as the raw Response: its
 * status and headers are the reading, so nothing is thrown for a 401/402 and
 * no redirect is followed. The URL is external data and is only ever fetched
 * through this guard: assertPublicUrl refuses a non-public target before the
 * request, ssrfDispatcher re-checks the resolved address at connect (a DNS
 * answer that changed since the check), and redirect: "manual" keeps the
 * request on the validated host. Sends the crawler User-Agent.
 */
export async function probePublicUrl(rawUrl, { method = "GET", headers = {}, body, timeoutMs = 8000 } = {}) {
  await assertPublicUrl(rawUrl);
  return fetch(rawUrl, {
    method,
    headers: { "User-Agent": USER_AGENT, ...headers },
    ...(body !== undefined ? { body } : {}),
    dispatcher: ssrfDispatcher,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// Retry a thunk on TRANSIENT upstream failures only — 504 (timeout/network),
// 502/503 (gateway). A 4xx (e.g. safeFetch's 422 for a caller-attributable
// upstream error) is deterministic: the request itself is wrong, so retrying
// just wastes the caller's time budget — fail fast. Capped at one extra
// attempt by default so worst-case latency stays bounded.
//
// Shared by every kit that reads a public API with an occasional slow or
// 5xx answer (macro, gov and weather sources alike): one fixed-timeout
// safeFetch attempt loses such a call, and the retry recovers it without a
// kit-specific copy of the loop. macro-kit.js re-exports this so its own
// import path and tests (test-macro-kit.js) are unchanged.
export async function retryTransient(fn, { retries = 1, backoffMs = 300 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const sc = e?.statusCode;
      // A 429 is now a 503 (it is the host throttling us, not the caller's URL
      // being wrong), and a 503 is retryable here - but retrying a rate-limit
      // immediately is the one case where a retry makes the upstream's problem
      // worse. Excluded by upstream status, not by our own, so the rest of the
      // 503 family keeps its retry.
      const throttled = e?.upstreamStatus === 429;
      // noRetry: a deterministic refusal wearing a 503 (e.g. our own key rejected).
      if (attempt < retries && !throttled && !e?.noRetry && (sc === 504 || sc === 502 || sc === 503)) {
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** Connect failures that are this server's own network path, not the
 *  host's answer: no local address to send from (EADDRNOTAVAIL). No route to
 *  the host or its network (EHOSTUNREACH, ENETUNREACH) can come from an ICMP
 *  answer near the host, so it reads as the host not answering, as a refused,
 *  reset or TLS-failed connection does. */
export const OUR_EGRESS_CONNECT_CODES = Object.freeze(new Set(["EADDRNOTAVAIL"]));

/**
 * Fetch a public http(s) URL with SSRF protection, size cap, and timeout.
 * Returns { finalUrl, html } — or { finalUrl, buffer } with `binary: true`.
 */
export async function safeFetch(rawUrl, { binary = false, maxBytes = MAX_BYTES, headers = {}, method = "GET", body, timeoutMs = FETCH_TIMEOUT_MS, validators = null, allowNotModified = false } = {}) {
  const url = await assertPublicUrl(rawUrl);

  // timeoutMs bounds the whole exchange: connect, headers AND body. The timer
  // is cleared only once the body has been read (or the call has failed), so
  // a server that sends headers and then trickles the body is cut off too.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
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
    // Every hop, the first included: a refused connection (no answer for the
    // name, or a private one) is one 400 with one sentence.
    if (isSsrfBlock(err)) throw badRequest(UNRESOLVED_OR_PRIVATE);
    const unavailable = lookupUnavailableIn(err);
    if (unavailable) throw lookupUnavailable(unavailable.cause);
    const timedOut = err.name === "AbortError";
    // undici's generic "fetch failed" hides the real transport error — walk
    // the cause chain for a code (ECONNRESET, UND_ERR_CONNECT_TIMEOUT, …) so
    // telemetry can tell egress problems from slow upstreams.
    let code = null;
    for (let e = err.cause; e && !code; e = e.cause) code = e.code || null;
    // A URL the caller named that gave no answer: our limit passing, or a
    // connection that failed, proves nothing about whose side it is (the URL
    // may be dead, the host slow, or our egress), so the attribution is
    // "unknown" and the advice covers both: check the URL, or retry. The hint
    // is the code a caller branches on.
    throw Object.assign(
      new Error(
        timedOut
          ? `Source URL did not respond within our ${Math.max(1, Math.round(timeoutMs / 1000))} s limit; check that the URL is correct and publicly reachable, or retry`
          : `Could not connect to source URL: ${err.message}${code ? ` (${code})` : ""}; check that the URL is correct and publicly reachable, or retry`
      ),
      // The transport code rides beside the hint (never as `code`, which
      // other readers branch on), so a reader that keeps our own egress
      // apart (OUR_EGRESS_CONNECT_CODES) can tell it from the host's answer.
      { statusCode: 504, attribution: "unknown", hint: timedOut ? "source-timeout" : "source-unreachable", ...(code ? { transportCode: String(code).slice(0, 40) } : {}) }
    );
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
    throw upstreamFailure(response.status, {
      retryAfter: retryAfterSeconds(response.headers.get("retry-after")),
      host: safeHostOf(response.url),
    });
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    let step;
    try {
      step = await reader.read();
    } catch (err) {
      if (controller.signal.aborted) {
        throw Object.assign(new Error(`Source URL did not finish sending within our ${Math.max(1, Math.round(timeoutMs / 1000))} s limit; check that the URL serves what you expect, or retry`), { statusCode: 504, attribution: "unknown", hint: "source-timeout" });
      }
      throw err;
    }
    const { done, value } = step;
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
  } finally {
    clearTimeout(timer);
  }
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
