// Seller logos, fetched by this server and cached, so a viewer's browser never
// requests a seller's URL. Only an https URL from the directory (or the
// seller origin's /favicon.ico) is fetched: never an arbitrary URL a caller
// names. Public addresses only, one redirect at most (re-checked), images
// only, 100 KB cap. Served with a sandbox CSP so an SVG logo cannot run.
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import https from "node:https";

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

/** The eight 16-bit groups of an IPv6 literal, or null. Accepts "::"
 *  compression and a trailing dotted quad. */
export function ipv6Groups(ip) {
  let v = String(ip).toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (!net.isIPv6(v)) return null;
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (quad) {
    const [a, b, c, d] = quad[1].split(".").map(Number);
    v = v.slice(0, -quad[1].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = v.includes("::") ? v.split("::") : [v, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = tail === null ? [] : new Array(8 - h.length - t.length).fill("0");
  const g = [...h, ...fill, ...t].map((x) => parseInt(x, 16));
  return g.length === 8 && g.every((x) => x >= 0 && x <= 0xffff) ? g : null;
}

const v4of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** The IPv4 address an IPv6 literal carries (mapped, compatible, NAT64, 6to4), or null. */
function embeddedV4(g) {
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4of(g[6], g[7]);                    // ::ffff:a.b.c.d
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4of(g[6], g[7]);     // ::ffff:0:a.b.c.d
  if (zero(0, 6)) return v4of(g[6], g[7]);                                       // ::a.b.c.d (and ::, ::1)
  if (g[0] === 0x64 && g[1] === 0xff9b) return zero(2, 6) ? v4of(g[6], g[7]) : "0.0.0.0"; // NAT64 (local-use prefix refused)
  if (g[0] === 0x2002) return v4of(g[1], g[2]);                                  // 6to4
  return null;
}

export function isPrivateIp(ip) {
  const s = String(ip || "").trim();
  if (net.isIPv4(s)) {
    const [a, b, c] = s.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  const g = ipv6Groups(s);
  if (!g) return true; // not an address we can read: refuse
  const v4 = embeddedV4(g);
  if (v4) return isPrivateIp(v4);
  return (g[0] & 0xfe00) === 0xfc00          // fc00::/7 unique local
    || (g[0] & 0xffc0) === 0xfe80            // fe80::/10 link local
    || (g[0] & 0xffc0) === 0xfec0            // fec0::/10 site local (deprecated)
    || (g[0] & 0xff00) === 0xff00            // multicast
    || (g[0] === 0x2001 && g[1] === 0)       // Teredo
    || (g[0] === 0x2001 && g[1] === 0xdb8)   // documentation
    || (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)); // discard
}

/** dns.lookup with every answer checked, for a connection's own lookup: the
 *  socket connects to the address checked here, so a second resolution can
 *  never swap in another one. */
export function guardedLookup(resolve = dnsLookup, isPrivate = isPrivateIp) {
  return (hostname, options, cb) => {
    if (typeof options === "function") { cb = options; options = {}; }
    resolve(hostname, { all: true }).then((addrs) => {
      if (!addrs.length) return cb(Object.assign(new Error("no address"), { code: "ENOTFOUND" }));
      const bad = addrs.find((a) => isPrivate(a.address));
      if (bad) return cb(Object.assign(new Error("non-public address"), { code: "EPRIVATE" }));
      if (options && options.all) return cb(null, addrs.map((a) => ({ address: a.address, family: a.family || (net.isIPv6(a.address) ? 6 : 4) })));
      const a = addrs[0];
      cb(null, a.address, a.family || (net.isIPv6(a.address) ? 6 : 4));
    }, (e) => cb(e));
  };
}

/** A small fetch over node:https whose connection resolves through
 *  guardedLookup. Answers the subset of Response this module reads. */
export function guardedFetch(url, { headers = {}, timeoutMs = 6000, maxBytes = 300_000, resolve, isPrivate, transport = https } = {}) {
  return new Promise((resolveP, reject) => {
    const u = new URL(url);
    const opts = { method: "GET", headers, lookup: guardedLookup(resolve, isPrivate), timeout: timeoutMs };
    const req = transport.request(u, opts, (res) => {
      const chunks = []; let n = 0;
      const body = new Promise((ok, no) => {
        // Past maxBytes the read stops and the first maxBytes + 1 bytes are
        // answered, so a caller's own size check sees an oversized body.
        res.on("data", (c) => { chunks.push(c); n += c.length; if (n > maxBytes) { res.destroy(); ok(Buffer.concat(chunks).subarray(0, maxBytes + 1)); } });
        res.on("end", () => ok(Buffer.concat(chunks)));
        res.on("error", no);
      });
      body.catch(() => {});
      resolveP({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(", ") : String(v); } },
        arrayBuffer: async () => { const b = await body; return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
        text: async () => (await body).toString("utf8"),
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function assertPublic(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password) throw new Error("https only");
  if (u.port && u.port !== "443") throw new Error("port");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  // A literal address never reaches a lookup, so it is checked here; a name
  // is checked again on the connection's own lookup.
  if (net.isIP(host) && isPrivateIp(host)) throw new Error("non-public address");
}

const defaultFetch = (url, init = {}) => guardedFetch(url, { headers: init.headers });

export function makeLogoCache({ fetchImpl = defaultFetch } = {}) {
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
  /** "hit", "miss" (a fresh negative answer) or null (never tried, or expired). */
  function known(key) {
    const hit = cache.get(key);
    if (!hit || Date.now() - hit.at >= (hit.miss ? NEG_TTL_MS : TTL_MS)) return null;
    return hit.miss ? "miss" : "hit";
  }
  return { get, known, size: () => cache.size };
}
