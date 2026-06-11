import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; Agent402/1.0; +https://github.com/MikeyPetrillo/Agent402)";

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
 * Fetch a public http(s) URL with SSRF protection, size cap, and timeout.
 * Returns { finalUrl, html }.
 */
export async function safeFetch(rawUrl) {
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,*/*" },
    });
  } catch (err) {
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
    if (received > MAX_BYTES) {
      reader.cancel();
      throw Object.assign(new Error("Page exceeds 5MB limit"), { statusCode: 413 });
    }
    chunks.push(value);
  }
  const html = Buffer.concat(chunks).toString("utf-8");
  return { finalUrl: response.url, html };
}
