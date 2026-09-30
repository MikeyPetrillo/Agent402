// Seller logos, fetched by this server and cached, so a viewer's browser never
// requests a seller's URL. Only an https URL from the directory (or the
// seller origin's /favicon.ico) is fetched: never an arbitrary URL a caller
// names. Public addresses only, one redirect at most (re-checked), images
// only, 100 KB cap. Served with a sandbox CSP so an SVG logo cannot run.
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

const MAX_BYTES = 100_000;
const TTL_MS = 24 * 3600_000, NEG_TTL_MS = 3600_000, MAX_ENTRIES = 3000;
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml"]);

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
}

async function assertPublic(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password) throw new Error("https only");
  if (u.port && u.port !== "443") throw new Error("port");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dnsLookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("non-public address");
}

export function makeLogoCache({ fetchImpl = fetch } = {}) {
  const cache = new Map(); // key -> { at, body, type } | { at, miss: true }
  const inflight = new Map();

  async function fetchOne(url) {
    let current = url;
    for (let hop = 0; hop < 2; hop++) {
      await assertPublic(current);
      const res = await fetchImpl(current, { redirect: "manual", headers: { accept: "image/*", "user-agent": "agent402-live/1 (+https://agent402.tools)" }, signal: AbortSignal.timeout(6000) });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { current = new URL(res.headers.get("location"), current).toString(); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!TYPES.has(type)) throw new Error("not an image");
      const len = Number(res.headers.get("content-length") || 0);
      if (len > MAX_BYTES) throw new Error("too large");
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES || !buf.length) throw new Error("bad size");
      return { body: buf, type };
    }
    throw new Error("too many redirects");
  }

  /** Candidate URLs for a seller: its declared icon, then its origin's favicon. */
  async function get(key, seller) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < (hit.miss ? NEG_TTL_MS : TTL_MS)) return hit.miss ? null : hit;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const candidates = [seller?.icon, seller?.origin ? `${seller.origin}/favicon.ico` : null].filter(Boolean);
      for (const c of candidates) {
        try { const r = await fetchOne(c); const v = { at: Date.now(), ...r }; set(key, v); return v; } catch { /* next candidate */ }
      }
      set(key, { at: Date.now(), miss: true });
      return null;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }
  function set(key, v) {
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, v);
  }
  return { get, size: () => cache.size };
}
