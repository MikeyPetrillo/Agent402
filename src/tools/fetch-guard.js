import { lookup } from "node:dns/promises";
import { lookup as lookupCb } from "node:dns";
import { isIP } from "node:net";
import { Agent } from "undici";

const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; Agent402/1.0; +https://github.com/MikeyPetrillo/Agent402)";

const SSRF_BLOCK_CODE = "ESSRFBLOCKED";

function isPrivateIp(ip) {
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" ||
      lower.startsWith("fe80:") ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("::ffff:") // IPv4-mapped — re-check the embedded v4
    );
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
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

  const host = url.hostname;
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
