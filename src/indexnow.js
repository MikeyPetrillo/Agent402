// IndexNow helpers: collect every URL from the site's sitemaps and ping
// api.indexnow.org in protocol-sized batches. Used by scripts/indexnow-submit.js.
// No state here; the caller decides which URLs changed.

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export const INDEXNOW_MAX_URLS = 10_000; // protocol cap per POST

const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// Parse one sitemap document: { kind: "index"|"urlset", entries: [{loc, lastmod}] }.
export function parseSitemap(xml) {
  const text = String(xml || "");
  const kind = /<sitemapindex[\s>]/.test(text) ? "index" : "urlset";
  const tag = kind === "index" ? "sitemap" : "url";
  const entries = [];
  const blockRe = new RegExp(`<${tag}[\\s>]([\\s\\S]*?)</${tag}>`, "g");
  for (const m of text.matchAll(blockRe)) {
    const loc = (m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/) || [])[1];
    if (!loc) continue;
    const lastmod = (m[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/) || [])[1] || null;
    entries.push({ loc: decode(loc), lastmod });
  }
  if (!entries.length) for (const m of text.matchAll(LOC_RE)) entries.push({ loc: decode(m[1]), lastmod: null });
  return { kind, entries };
}

// Walk the sitemap index (and any extra roots), following child sitemaps on the
// same host. Returns deduped [{loc, lastmod}] and the list of sitemaps read.
export async function collectSitemapUrls(baseUrl, { fetchImpl = fetch, roots = ["/sitemapindex.xml", "/sitemap.xml"], maxSitemaps = 50, timeoutMs = 30_000 } = {}) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const host = new URL(base).host;
  const queue = roots.map((r) => (r.startsWith("http") ? r : base + r));
  const seenMaps = new Set();
  const urls = new Map();
  const read = [];
  const errors = [];
  while (queue.length && seenMaps.size < maxSitemaps) {
    const u = queue.shift();
    if (seenMaps.has(u)) continue;
    seenMaps.add(u);
    let xml;
    try {
      const r = await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) { errors.push(`${u}: HTTP ${r.status}`); continue; }
      xml = await r.text();
    } catch (e) { errors.push(`${u}: ${e.message}`); continue; }
    read.push(u);
    const { kind, entries } = parseSitemap(xml);
    for (const e of entries) {
      let h;
      try { h = new URL(e.loc).host; } catch { continue; }
      if (h !== host) continue;
      if (kind === "index") queue.push(e.loc);
      else {
        const had = urls.get(e.loc);
        if (!urls.has(e.loc) || (e.lastmod && (!had || e.lastmod > had))) urls.set(e.loc, e.lastmod); // keep the newest lastmod
      }
    }
  }
  return { urls: [...urls].map(([loc, lastmod]) => ({ loc, lastmod })), sitemaps: read, errors };
}

// Which URLs to submit: new vs a previous URL set, or lastmod on/after `since`.
export function selectChanged(entries, { previous = null, since = null } = {}) {
  const prev = previous ? new Set(previous) : null;
  return entries.filter((e) => {
    if (prev && !prev.has(e.loc)) return true;
    if (since && e.lastmod && e.lastmod.slice(0, 10) >= since) return true;
    return !prev && !since;
  }).map((e) => e.loc);
}

export function chunk(list, size = INDEXNOW_MAX_URLS) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// POST urls to IndexNow in batches. Resolves { ok, batches:[{status, urls}] }.
export async function pingIndexNow({ host, key, keyLocation, urls, fetchImpl = fetch, endpoint = INDEXNOW_ENDPOINT, timeoutMs = 60_000 }) {
  if (!key) return { ok: false, reason: "no-key", batches: [] };
  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) return { ok: true, reason: "nothing-to-submit", batches: [] };
  const batches = [];
  for (const urlList of chunk(list)) {
    let status = 0, body = "";
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host, key, keyLocation, urlList }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      body = (await res.text()).slice(0, 200);
    } catch (e) { body = e.message; }
    batches.push({ status, urls: urlList.length, body });
  }
  return { ok: batches.every((b) => b.status === 200 || b.status === 202), batches };
}
