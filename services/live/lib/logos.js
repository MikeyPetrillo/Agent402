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

/** Does the body really look like an image? A site can answer /favicon.ico
 *  with an error page labelled as an icon (one busy seller serves an npm error
 *  message there), which a browser cannot draw. Checked by magic bytes. */
export function looksLikeImage(buf) {
  if (!buf || buf.length < 4) return false;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;           // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;                              // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;                              // GIF
  if (b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00) return true; // ICO/CUR
  if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return true;
  const head = b.toString("utf8", 0, Math.min(b.length, 1024)).toLowerCase();
  return head.includes("<svg");
}

/** Icon links a homepage declares, best first: apple-touch-icon (large),
 *  then SVG, then the largest declared size. Pure; exported for tests. */
export function iconLinksFromHtml(html, baseUrl) {
  const out = [];
  for (const m of String(html || "").matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (/\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] || "").toLowerCase();
    if (!/\b(icon|apple-touch-icon)\b/.test(rel)) continue;
    const href = /\bhref\s*=\s*["']?([^"' >]+)/i.exec(tag)?.[1];
    if (!href) continue;
    let url;
    try { url = new URL(href, baseUrl); } catch { continue; }
    if (url.protocol !== "https:") continue;
    const sizes = /\bsizes\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] || "";
    const px = Math.max(0, ...sizes.split(/\s+/).map((x) => parseInt(x, 10) || 0));
    const svg = /\.svg(\?|$)/i.test(url.pathname) || /image\/svg/i.test(tag);
    const score = rel.includes("apple-touch-icon") ? 1000 : svg ? 900 : px || 16;
    out.push({ url: url.toString(), score });
  }
  return out.sort((a, b) => b.score - a.score).map((x) => x.url);
}

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
      if (!looksLikeImage(buf)) throw new Error("not an image body");
      return { body: buf, type };
    }
    throw new Error("too many redirects");
  }

  async function homepageIcons(origin) {
    try {
      await assertPublic(origin);
      const res = await fetchImpl(origin + "/", { redirect: "manual", headers: { accept: "text/html", "user-agent": "agent402-live/1 (+https://agent402.tools)" }, signal: AbortSignal.timeout(6000) });
      if (!res.ok || !/text\/html/i.test(res.headers.get("content-type") || "")) return [];
      const html = (await res.text()).slice(0, 200_000);
      return iconLinksFromHtml(html, origin + "/").slice(0, 4);
    } catch { return []; }
  }

  /** Candidate URLs for a seller: its declared icon, then its origin's favicon. */
  async function get(key, seller) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < (hit.miss ? NEG_TTL_MS : TTL_MS)) return hit.miss ? null : hit;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      // The listing's own icon, then the icons the seller's homepage declares,
      // then the conventional paths.
      const candidates = [seller?.icon];
      if (seller?.origin) {
        candidates.push(...await homepageIcons(seller.origin));
        candidates.push(`${seller.origin}/apple-touch-icon.png`, `${seller.origin}/favicon.ico`);
      }
      for (const c of [...new Set(candidates.filter(Boolean))]) {
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
