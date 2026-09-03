// Name the page instead of quoting its doctype.
//
// WHY THIS EXISTS (2026-08-07). Settlement failed 15 times in eleven minutes
// across Base, Solana, Polygon and Arbitrum, and every log line read:
//
//   [payments] facilitator SETTLE failed on eip155:8453 exact:
//   Facilitator settle failed (502): <html> <head> <title>Coinbase</title>
//   <meta name="robots" content="noindex"> <meta property="viewport" ...
//
// which is 200 characters of boilerplate and zero diagnosis. `@x402/core`
// truncates an error body at 200 chars (`responseExcerpt`), and for an HTML
// page that budget is spent before the first word of the actual message. So we
// could not tell a facilitator outage from an edge blocking our egress - and
// the difference decides whether we wait or build a relay.
//
// The repo has four relays already (Yahoo, Nasdaq, Sei, Nodely) because third
// parties block Railway's egress IPs; Nodely 403s it outright. "Their outage"
// and "our IP is being refused" look identical at 200 characters, and we
// guessed wrong on this one before reading the headers.
//
// This is the same defect `payments.js` already documents for network-level
// failures: a cause we discard is not a cause we do not have. That fix read
// `err.cause`; this one reads the response before the vendor truncates it.
//
// Deliberately DIAGNOSTIC ONLY. It never changes a response, never retries,
// never swallows an error, and never fails a request - a logger that can break
// settlement would be worse than the blindness it cures.

/** Response headers worth having when an edge refuses us. Cloudflare's ray id
 *  and `cf-mitigated` identify a block; `retry-after` identifies a rate limit;
 *  `server` says whose edge answered at all. */
const HEADERS_OF_INTEREST = [
  "server", "cf-ray", "cf-mitigated", "cf-cache-status", "retry-after",
  "x-envoy-upstream-service-time", "x-amz-cf-id", "x-request-id", "content-type",
];

/** Markers that distinguish an edge REFUSING us from an origin that failed.
 *  Ordered most-specific first; the first hit wins. */
const VERDICTS = [
  [/attention required|checking your browser|enable javascript and cookies|cf_chl|challenge-platform/i, "cloudflare challenge/block"],
  [/access denied|you (?:have been|are) blocked|forbidden|not allowed/i, "access denied (edge refused this client)"],
  [/rate.?limit|too many requests|slow down/i, "rate limited"],
  [/bad gateway|502|origin (?:is )?unreachable|no healthy upstream|upstream connect error/i, "origin error behind the edge"],
  [/gateway time-?out|504|timed? out/i, "gateway timeout"],
  [/maintenance|temporarily unavailable|503/i, "declared unavailable"],
];

/** Strip markup and collapse whitespace so the words survive a length budget
 *  that tags would otherwise eat. Scripts and styles go entirely - a block
 *  page's inline CSS is longer than its message. */
export function textFromHtml(body) {
  return String(body || "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a one-line diagnosis of a non-JSON error response.
 * Pure and synchronous so it can be tested without a network: pass the status,
 * a header lookup (a Headers object or a plain object), and the body text.
 * Returns null when there is nothing worth saying.
 */
export function describeErrorResponse({ url, status, headers, body } = {}) {
  const get = (k) => {
    if (!headers) return null;
    if (typeof headers.get === "function") return headers.get(k);
    const hit = Object.keys(headers).find((h) => h.toLowerCase() === k);
    return hit ? headers[hit] : null;
  };
  const text = textFromHtml(body);
  // VALUES only, never header NAMES. The first draft folded the names in, so
  // the literal string "cf-mitigated:" was present on every response and the
  // challenge pattern matched all of them - a plain origin 502 was reported as
  // Cloudflare blocking us, which is the exact confusion this module exists to
  // end. Caught by the test that asserts an origin failure reads as one.
  const values = HEADERS_OF_INTEREST.map((h) => get(h)).filter(Boolean).join(" ");
  const haystack = `${text} ${values}`;
  // A cf-mitigated header is Cloudflare stating outright that it acted on this
  // request; nothing in a body outranks that.
  const verdict = (get("cf-mitigated") && "cloudflare challenge/block")
    || VERDICTS.find(([re]) => re.test(haystack))?.[1]
    || (status === 429 && "rate limited")
    || (status === 503 && "declared unavailable")
    || "unclassified non-JSON error";
  const bits = HEADERS_OF_INTEREST
    .map((h) => { const v = get(h); return v ? `${h}=${v}` : null; })
    .filter(Boolean);
  // 600 chars of WORDS, having spent none of the budget on markup. The page
  // that started this fits its whole message inside it.
  //
  // Long hex/base64 runs are REDACTED first. We are logging a body we did not
  // write, from a host we authenticate to, straight into a log aggregator - and
  // an error page that echoes a request header or a signed payload would put a
  // credential there permanently. Nothing diagnostic is lost: a Cloudflare ray
  // id is short, and no failure has ever been explained by a 64-character blob.
  const redacted = text
    // JWT-shaped first: its segments are dot-separated and individually short,
    // so a plain "long run" rule walks straight past a whole bearer token.
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(?:0x)?[0-9a-fA-F]{32,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, "[redacted]");
  const excerpt = redacted.length > 600 ? `${redacted.slice(0, 597)}...` : redacted;
  return `[facilitator-diag] ${status} from ${url} - ${verdict}` +
    `${bits.length ? ` | ${bits.join(" ")}` : ""}` +
    `${excerpt ? ` | body: ${excerpt}` : " | body: <empty>"}`;
}

/**
 * Stamp a facilitator's label onto any error its settle/verify throws.
 *
 * WHY: the failure hooks log the CHAIN and never the facilitator, so on
 * 2026-08-07 a Solana, Polygon and Arbitrum failure all read as Coinbase's
 * words - even though the boot log routes those three to PayAI and only Base
 * to CDP. Clients are tried in order, so the error that surfaces is the FIRST
 * one tried, not the one that owns the chain. Without the label you cannot
 * tell "PayAI rejected this" from "CDP was tried first and never got past the
 * edge", and those have different fixes.
 *
 * The label is PREFIXED, never substituted: `isPreBroadcastSettleRejection`
 * matches `settle failed (402)` as a substring and the summarizer scans for
 * the facilitator's JSON body, so replacing the message would silently break
 * the fallback's safety classification.
 */
export function labelFacilitatorErrors(label, client, methods = ["settle", "verify"]) {
  if (!client || !label) return client;
  for (const name of methods) {
    const orig = client[name];
    if (typeof orig !== "function" || orig.__a402Labelled) continue;
    const wrapped = async (...args) => {
      try {
        return await orig.apply(client, args);
      } catch (err) {
        try {
          // First label wins: an inner client already named itself.
          if (err && !err.__a402Facilitator) {
            err.__a402Facilitator = label;
            err.message = `[${label}] ${err.message}`;
          }
        } catch { /* frozen/exotic error - a label is a nicety, never a failure */ }
        throw err;
      }
    };
    wrapped.__a402Labelled = true;
    client[name] = wrapped;
  }
  return client;
}

/** Hosts the installed wrapper watches. Module-level so registration can grow
 *  after the wrapper is in place (see installFacilitatorDiagnostics). */
const sharedHosts = new Set();

/** Test-only: what the installed wrapper currently watches. */
export function watchedHosts() {
  return [...sharedHosts];
}

/** Does this content-type carry a machine-readable error the vendor already
 *  surfaces well? JSON errors are parsed and reported upstream; only the
 *  human-page cases are blind. */
function isJsonish(contentType) {
  return /\bjson\b/i.test(String(contentType || ""));
}

/**
 * Wrap global fetch so a non-2xx, non-JSON response from a facilitator host
 * logs a real diagnosis. Idempotent, and a no-op with no hosts.
 *
 * The response is CLONED before reading: consuming the caller's body would
 * break settlement outright, which is exactly the kind of cure that is worse
 * than the disease. Every failure path is swallowed.
 */
// Socket-level failures that mean "the request never reached the far side, or
// the far side dropped the connection before answering". A response with a
// status is NOT one of these - that path is diagnosed below, never retried.
const SOCKET_ERROR_CODES = new Set(["UND_ERR_SOCKET", "ECONNRESET", "EPIPE", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]);
export function socketErrorCode(err) {
  for (const e of [err, err?.cause, err?.cause?.cause]) {
    const code = e?.code;
    if (typeof code === "string" && SOCKET_ERROR_CODES.has(code)) return code;
  }
  return null;
}
// Only a facilitator host, only a read (POST /verify or GET /supported), only a
// body that can be sent twice (a string/Buffer/none - never a stream), only a
// socket-class error. Everything else propagates untouched.
export function isRetryableFacilitatorRead(url, init, err, hosts) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!hosts?.has?.(u.host)) return false;
  if (!socketErrorCode(err)) return false;
  const method = String(init?.method || "GET").toUpperCase();
  const path = u.pathname.replace(/\/+$/, "");
  const isVerify = method === "POST" && /\/verify$/.test(path);
  const isSupported = method === "GET" && /\/supported$/.test(path);
  if (!isVerify && !isSupported) return false;
  const body = init?.body;
  if (body != null && typeof body !== "string" && !(body instanceof Uint8Array)) return false;
  return true;
}

export function installFacilitatorDiagnostics(urls = [], { log = console.error, fetchImpl } = {}) {
  // Hosts live OUTSIDE the wrapper so callers can keep adding them after the
  // first install. Facilitators register one at a time, and an
  // install-once-then-ignore design would have diagnosed only whichever
  // registered first - the wrapper would exist and quietly cover nothing.
  const hosts = fetchImpl ? new Set() : sharedHosts;
  for (const u of urls) {
    try { if (u) hosts.add(new URL(u).host); } catch { /* not a URL - ignore */ }
  }
  if (!hosts.size) return null;

  const target = fetchImpl || globalThis.fetch;
  if (!target || target.__a402FacilitatorDiag) return target || null;

  const wrapped = async function facilitatorDiagnosticFetch(input, init) {
    let res;
    try {
      res = await target(input, init);
    } catch (err) {
      // ONE retry of a facilitator VERIFY (or the GET /supported probe) that
      // died at the socket level before any response - never a settle.
      //
      // Measured twice in CI (2026-09-01 and 09-02, test-verify-hint-live):
      // the post-listen event-loop stall ran 5.4 s, the stub facilitator
      // closed the idle keep-alive socket our boot-time /supported probe had
      // opened (Node's default idle timeout is 5 s), and the first verify was
      // written to that dead pooled socket - `fetch failed [UND_ERR_SOCKET]`
      // with the facilitator having seen nothing. The buyer got a 402 for a
      // payment nobody examined. undici retries idempotent requests on a
      // stale socket by itself; a POST is not idempotent to undici, but a
      // verify IS to us: it moves no money and reads nothing that a second
      // ask would change. A settle can move money, so it is never resent
      // from here - the settle path has its own chain-truth confirmers.
      const url = typeof input === "string" ? input : (input?.url || String(input));
      if (!isRetryableFacilitatorRead(url, init, err, hosts)) throw err;
      log(`[facilitator-diag] ${new URL(url).pathname} died before a response (${socketErrorCode(err)}) - retrying once`);
      res = await target(input, init);
    }
    try {
      if (!res || res.ok) return res;
      const url = typeof input === "string" ? input : (input?.url || String(input));
      const host = (() => { try { return new URL(url).host; } catch { return null; } })();
      if (!host || !hosts.has(host)) return res;
      if (isJsonish(res.headers?.get?.("content-type"))) return res;
      // Clone FIRST: reading the original would consume the caller's body.
      const body = await res.clone().text().catch(() => "");
      const line = describeErrorResponse({ url, status: res.status, headers: res.headers, body });
      if (line) log(line);
    } catch { /* a diagnostic must never affect the call it is describing */ }
    return res;
  };
  wrapped.__a402FacilitatorDiag = true;
  if (!fetchImpl) {
    globalThis.fetch = wrapped;
    // Say so once at boot. A diagnostic that silently failed to install is a
    // diagnostic you find out about during the next incident, when the log is
    // just as empty as before.
    console.log(`[facilitator-diag] active - non-JSON facilitator errors will be diagnosed, not quoted`);
  }
  return wrapped;
}
