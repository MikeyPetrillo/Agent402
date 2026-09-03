// Optional verified-list preference for the Smart Order Router.
//
// When candidate routes TIE on the existing ranking (score, health, Bazaar
// payers, known price, slug length), prefer a route that appears on an
// operator-configured HTTPS JSON feed. The feed is PROVIDER-NEUTRAL: any host
// can publish the same contract. The default URL happens to be
// https://samedaydesk.com/x402/verified.json; pointing X402_VERIFIED_LIST_URL
// at a different document does not change matching or ranking rules.
//
// Rollout switch = X402_VERIFIED_LIST=on (default OFF). Call-time read, so a
// process that never sets the flag never fetches and never re-ranks.
//
// Fail-open: a missing, oversized, or unparseable feed is an empty set. A
// failed refresh keeps the last good set. Nothing here gates payment.

import { safeFetch } from "./tools/fetch-guard.js";

export const DEFAULT_VERIFIED_LIST_URL = "https://samedaydesk.com/x402/verified.json";
const MAX_FEED_BYTES = 512 * 1024;
const MAX_ENTRIES = 10_000;

function emptyFeed() {
  return { sellers: new Set(), routes: new Set() };
}

let currentFeed = emptyFeed();
let refreshTimer = null;

/** Call-time. Empty / unset / anything other than 1|true|yes|on → off. */
export function verifiedListEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.X402_VERIFIED_LIST || "").trim());
}

export function verifiedListUrl() {
  const raw = String(process.env.X402_VERIFIED_LIST_URL || "").trim();
  return raw || DEFAULT_VERIFIED_LIST_URL;
}

export function canonOrigin(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s.includes("://") ? s : `https://${s}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return `${u.protocol}//${u.host}`.toLowerCase().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function canonPath(raw) {
  let p = String(raw || "/").trim();
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p;
}

function addSeller(feed, origin) {
  const o = canonOrigin(origin);
  if (!o) return;
  if (feed.sellers.size + feed.routes.size >= MAX_ENTRIES) return;
  feed.sellers.add(o);
}

function addRoute(feed, origin, path, method) {
  const o = canonOrigin(origin);
  if (!o) return;
  if (feed.sellers.size + feed.routes.size >= MAX_ENTRIES) return;
  const p = canonPath(path);
  const m = method ? String(method).trim().toUpperCase() : "*";
  feed.routes.add(`${o}\t${m}\t${p}`);
}

function ingestString(feed, value) {
  const s = String(value || "").trim();
  if (!s) return;
  try {
    const u = new URL(s);
    if (u.pathname && u.pathname !== "/") addRoute(feed, s, u.pathname, null);
    else addSeller(feed, s);
  } catch {
    const o = canonOrigin(s);
    if (o) addSeller(feed, o);
  }
}

function ingestObject(feed, item) {
  if (!item || typeof item !== "object") return;
  const url = item.url || item.resource || item.href || item.resourceUrl;
  const origin = item.origin || item.seller || item.host;
  const path = item.route || item.path || item.pathname;
  const method = item.method;
  if (typeof url === "string" && url) {
    try {
      const u = new URL(url);
      addRoute(feed, url, path || u.pathname, method);
    } catch {
      /* skip */
    }
    return;
  }
  if (origin && path) {
    addRoute(feed, origin, path, method);
    return;
  }
  if (origin) addSeller(feed, origin);
}

/**
 * Parse a provider-neutral verified-list document.
 *
 * Accepted shapes (any mix):
 *   - a JSON array of URL / origin strings
 *   - `{ routes, urls, sellers, origins }` arrays
 *   - route entries as strings (`https://seller.example/api/foo`) or objects
 *     `{ url } | { origin, route|path, method? }`
 *   - seller entries as strings (`https://seller.example`) or `{ origin }`
 *
 * A seller-level entry matches every route at that origin. A route entry
 * without `method` matches any method on that path. Unknown keys are ignored.
 */
export function parseVerifiedFeed(body) {
  const feed = emptyFeed();
  let data = body;
  if (typeof body === "string") {
    try { data = JSON.parse(body); } catch { return feed; }
  }
  if (data == null) return feed;
  const items = Array.isArray(data)
    ? data
    : (data && typeof data === "object")
      ? [
          ...(Array.isArray(data.routes) ? data.routes : []),
          ...(Array.isArray(data.urls) ? data.urls : []),
          ...(Array.isArray(data.sellers) ? data.sellers : []),
          ...(Array.isArray(data.origins) ? data.origins : []),
        ]
      : [];
  for (const item of items) {
    if (typeof item === "string") ingestString(feed, item);
    else if (item && typeof item === "object") ingestObject(feed, item);
  }
  return feed;
}

function originOf(tool) {
  if (!tool || typeof tool !== "object") return "";
  const raw = (typeof tool.seller === "string" && /^https?:\/\//i.test(tool.seller))
    ? tool.seller
    : (tool.sellerHome || tool.origin || "");
  return canonOrigin(raw);
}

/**
 * True when the flag is on AND this candidate is on the loaded feed.
 * Always false when the flag is off, even if a feed was injected for tests.
 */
export function routeOnVerifiedList(tool, feed = currentFeed) {
  if (!verifiedListEnabled()) return false;
  if (!feed) return false;
  const origin = originOf(tool);
  if (!origin) return false;
  if (feed.sellers.has(origin)) return true;
  const path = canonPath(tool.route);
  const method = String(tool.method || "").trim().toUpperCase();
  return feed.routes.has(`${origin}\t${method}\t${path}`)
    || feed.routes.has(`${origin}\t*\t${path}`);
}

export function getVerifiedList() { return currentFeed; }

export function _setVerifiedListForTest(feed) {
  currentFeed = feed && typeof feed === "object"
    ? { sellers: new Set(feed.sellers || []), routes: new Set(feed.routes || []) }
    : emptyFeed();
}

export function _resetVerifiedListForTest() {
  currentFeed = emptyFeed();
  stopVerifiedListRefresh();
}

export async function refreshVerifiedList({ fetchImpl } = {}) {
  if (!verifiedListEnabled()) {
    currentFeed = emptyFeed();
    return currentFeed;
  }
  const url = verifiedListUrl();
  if (!/^https:\/\//i.test(url)) {
    console.warn("[verified-list] URL must be https; feed ignored");
    return currentFeed;
  }
  try {
    const fetchFn = fetchImpl || ((u, opts) => safeFetch(u, { ...opts, maxBytes: MAX_FEED_BYTES, headers: { Accept: "application/json" } }));
    const res = await fetchFn(url, { headers: { Accept: "application/json" } });
    const text = typeof res === "string" ? res : (res?.html ?? res?.text ?? "");
    if (typeof text !== "string" || !text) return currentFeed;
    if (Buffer.byteLength(text, "utf8") > MAX_FEED_BYTES) {
      console.warn("[verified-list] feed too large; ignored");
      return currentFeed;
    }
    currentFeed = parseVerifiedFeed(text);
    console.log(`[verified-list] loaded ${currentFeed.sellers.size} seller(s) + ${currentFeed.routes.size} route(s) from ${url}`);
  } catch (err) {
    console.warn(`[verified-list] fetch failed (${err.message || err}); keeping previous set`);
  }
  return currentFeed;
}

export function startVerifiedListRefresh() {
  stopVerifiedListRefresh();
  if (!verifiedListEnabled()) return;
  refreshVerifiedList().catch(() => {});
  const ms = Number(process.env.X402_VERIFIED_LIST_REFRESH_MS);
  const interval = Number.isFinite(ms) && ms > 0 ? ms : 30 * 60 * 1000;
  refreshTimer = setInterval(() => { refreshVerifiedList().catch(() => {}); }, interval);
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

export function stopVerifiedListRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
