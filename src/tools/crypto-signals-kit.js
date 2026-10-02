// Crypto signals kit - keyless, deterministic crypto intelligence:
//   crypto-news          aggregated headlines from the public RSS/Atom feeds
//                        of major crypto outlets (parsed in-process, no key)
//   crypto-indicators    RSI / MACD / EMA / SMA / Bollinger / ATR / VWAP
//                        computed from Hyperliquid perp candles
//   crypto-market-pulse  one-call market breadth snapshot from Hyperliquid's
//                        metaAndAssetCtxs (advancers/decliners, leaders,
//                        open interest, funding extremes)
//
// No LLM anywhere: every number is arithmetic over a public upstream, every
// sentence is a fixed template. Handlers validate input (400), bound list
// sizes, time out (504), map upstream 5xx -> 502 and 429 -> 503, and never
// relay an upstream error body. Every response carries `source` + `fetchedAt`.
//
// Feed fetches are cached in-process for 5 minutes per source so call volume
// never hammers a publisher; one failing feed is reported in `errors[]`, and
// the call only fails (502) when every requested feed fails.
//
// All three tools egress, so they belong in WALLET_ONLY_SLUGS. Offline
// coverage: scripts/test-crypto-signals-kit.js (stubbed fetch, fixtures with
// hand-computed indicator values).

import { markUntrusted } from "./provenance.js";
// Refuse an over-large body BEFORE reading it into a string: `res.text()` has
// no cap of its own, so a broken or hostile upstream could push an unbounded
// buffer into memory once per concurrent call.
function assertBodyWithinCap(res, capBytes, label) {
  const declared = Number(res.headers?.get?.("content-length") || 0);
  if (declared && declared > capBytes) {
    const e = new Error(`${label} response is larger than the ${Math.round(capBytes / 1048576)}MB cap`);
    e.statusCode = 502; throw e;
  }
}

const HL_INFO = "https://api.hyperliquid.xyz/info";
const UA = "Mozilla/5.0 (compatible; Agent402/1.0; +https://agent402.tools)";
const HL_TIMEOUT_MS = 10_000;
const FEED_TIMEOUT_MS = 6_000;
export const FEED_TTL_MS = 5 * 60_000;
const FEED_FAIL_TTL_MS = 60_000;
const FEED_MAX_BYTES = 2_000_000;
export const META_TTL_MS = 5 * 60_000;
const MAX_CANDLES = 500;
const MAX_POINTS = 100;
const SUMMARY_CHARS = 300;
const HOURS_PER_YEAR = 24 * 365;

// Public RSS/Atom feeds, each verified live (valid XML, current items) on
// 2026-08-22. Ids are the buyer-facing `sources` values.
export const NEWS_SOURCES = {
  coindesk: { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", home: "https://www.coindesk.com" },
  cointelegraph: { name: "Cointelegraph", url: "https://cointelegraph.com/rss", home: "https://cointelegraph.com" },
  decrypt: { name: "Decrypt", url: "https://decrypt.co/feed", home: "https://decrypt.co" },
  theblock: { name: "The Block", url: "https://www.theblock.co/rss.xml", home: "https://www.theblock.co" },
  bitcoinmagazine: { name: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/feed", home: "https://bitcoinmagazine.com" },
  thedefiant: { name: "The Defiant", url: "https://thedefiant.io/feed", home: "https://thedefiant.io" },
  blockworks: { name: "Blockworks", url: "https://blockworks.co/feed", home: "https://blockworks.co" },
  cryptoslate: { name: "CryptoSlate", url: "https://cryptoslate.com/feed/", home: "https://cryptoslate.com" },
};
const SOURCE_IDS = Object.keys(NEWS_SOURCES);

// Hyperliquid candle intervals -> milliseconds (their documented set).
const INTERVALS = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000, "12h": 43_200_000,
  "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000, "1M": 2_592_000_000,
};

const INDICATOR_IDS = ["rsi", "macd", "ema", "sma", "bollinger", "atr", "vwap"];

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round = (v, d = 6) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const nowIso = () => new Date().toISOString();

// --- input helpers ---------------------------------------------------------
function takeInt(raw, name, dflt, min, max) {
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`"${name}" must be an integer between ${min} and ${max}`);
  return n;
}

function takeCoinInput(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw bad('"coin" is required (e.g. "BTC", "ETH", "SOL")');
  const s = raw.trim();
  if (s.length > 32) throw bad('"coin" too long');
  if (!/^[A-Za-z0-9:_\-.@]+$/.test(s)) throw bad('"coin" must be a perp ticker such as "BTC" or "kPEPE"');
  return s;
}

function takeList(raw, name, allowed, max) {
  if (raw == null || raw === "") return null;
  let items;
  if (Array.isArray(raw)) items = raw;
  else if (typeof raw === "string") items = raw.split(",");
  else throw bad(`"${name}" must be an array or a comma-separated string`);
  items = items.map((s) => String(s ?? "").trim().toLowerCase()).filter(Boolean);
  if (items.length === 0 || items.length > max) throw bad(`"${name}" must list between 1 and ${max} entries`);
  const unknown = items.filter((s) => !allowed.includes(s));
  if (unknown.length) throw bad(`"${name}" has unknown entries (${unknown.slice(0, 5).join(", ")}); valid: ${allowed.join(", ")}`);
  return [...new Set(items)];
}

// --- transport ------------------------------------------------------------
async function rawFetch(url, { method = "GET", body, label, timeoutMs, accept }) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "User-Agent": UA,
        Accept: accept || "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    console.warn(`[crypto-signals] ${label} unreachable: ${err?.name ?? err?.code ?? err?.message}`);
    throw bad(`${label} request timed out or was unreachable`, 504);
  }
  let text = "";
  assertBodyWithinCap(res, FEED_MAX_BYTES, "Feed");
  try { text = await res.text(); } catch { text = ""; }
  if (res.status === 429) throw bad(`${label} rate limit reached upstream - retry shortly`, 503);
  return { status: res.status, text };
}

// Hyperliquid info endpoint. Unknown coins come back as HTTP 500 "null".
async function hlInfo(payload) {
  const { status, text } = await rawFetch(HL_INFO, {
    method: "POST", body: JSON.stringify(payload), label: "Hyperliquid", timeoutMs: HL_TIMEOUT_MS,
  });
  const trimmed = text.trim();
  if (status >= 500) {
    if (trimmed === "null") throw bad("Hyperliquid has no market for that coin", 422);
    throw bad(`Hyperliquid upstream HTTP ${status} - try again later`, 502);
  }
  if (status >= 400) throw bad("Hyperliquid rejected the request (check coin / interval)", 422);
  let json;
  try { json = JSON.parse(trimmed); } catch { throw bad("Hyperliquid returned a non-JSON response", 502); }
  if (json == null) throw bad("Hyperliquid has no market for that coin", 422);
  return json;
}

// --- Hyperliquid helpers ----------------------------------------------------
let metaCache = { at: 0, names: null };
async function resolveCoin(rawInput) {
  const want = takeCoinInput(rawInput);
  if (!metaCache.names || Date.now() - metaCache.at > META_TTL_MS) {
    const json = await hlInfo({ type: "meta" });
    const universe = json?.universe;
    if (!Array.isArray(universe)) throw bad("Hyperliquid returned an unexpected response shape", 502);
    metaCache = { at: Date.now(), names: universe.filter((u) => u && !u.isDelisted).map((u) => String(u.name)) };
  }
  const exact = metaCache.names.find((n) => n === want);
  if (exact) return exact;
  const ci = metaCache.names.find((n) => n.toLowerCase() === want.toLowerCase());
  if (ci) return ci;
  throw bad(`Unknown perp market "${want}" - use a listed coin such as BTC, ETH, SOL`, 422);
}

// metaAndAssetCtxs -> [{universe:[{name, ...}]}, [ctx...]]
async function perpMarkets() {
  const json = await hlInfo({ type: "metaAndAssetCtxs" });
  const universe = json?.[0]?.universe;
  const ctxs = json?.[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxs)) throw bad("Hyperliquid returned an unexpected response shape", 502);
  const rows = [];
  for (let i = 0; i < universe.length; i++) {
    const u = universe[i];
    const c = ctxs[i];
    if (!u || !c || u.isDelisted) continue;
    const markPx = num(c.markPx);
    const prevDayPx = num(c.prevDayPx);
    const fundingHourly = num(c.funding);
    const openInterest = num(c.openInterest);
    rows.push({
      coin: String(u.name),
      markPx,
      change24hPct: markPx != null && prevDayPx ? round(((markPx - prevDayPx) / prevDayPx) * 100, 4) : null,
      fundingHourly,
      fundingAprPct: fundingHourly != null ? round(fundingHourly * HOURS_PER_YEAR * 100, 4) : null,
      openInterestUsd: openInterest != null && markPx != null ? round(openInterest * markPx, 2) : null,
      volume24hUsd: round(num(c.dayNtlVlm), 2),
    });
  }
  return rows;
}

// --- RSS / Atom parsing (dependency-free, linear-time) ----------------------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", hellip: "\u2026", mdash: "\u2014", ndash: "\u2013" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return Object.hasOwn(ENTITIES, e) ? ENTITIES[e] : m;
  });
}
function unwrapCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}
function cleanText(raw) {
  if (!raw) return "";
  // CDATA first, then entities (a CDATA body may itself carry escaped HTML,
  // as Cointelegraph/Bitcoin Magazine descriptions do), then strip tags.
  let s = unwrapCdata(raw);
  s = decodeEntities(s);
  s = s.replace(/<[^>]*>/g, " ");
  s = decodeEntities(s); // entities that were inside the stripped markup's text
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/\s+/g, " ").trim();
}
// First <tag>...</tag> child text (namespace-prefixed tags allowed via the
// `names` list, e.g. "dc:date"). Self-closing tags yield "".
function childText(block, ...names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, "i");
    const m = re.exec(block);
    if (m) return m[1];
  }
  return null;
}
function attrOf(tag, attr) {
  const m = new RegExp(`\\s${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : null;
}
function atomLink(block) {
  const tags = block.match(/<link\b[^>]*?\/?>/gi) || [];
  let first = null;
  for (const t of tags) {
    const href = attrOf(t, "href");
    if (!href) continue;
    const rel = attrOf(t, "rel");
    if (!rel || rel === "alternate") return href;
    if (!first) first = href;
  }
  return first;
}
function toIso(raw) {
  const s = cleanText(raw);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function summarize(text) {
  if (!text) return "";
  if (text.length <= SUMMARY_CHARS) return text;
  const cut = text.slice(0, SUMMARY_CHARS);
  const sp = cut.lastIndexOf(" ");
  return (sp > SUMMARY_CHARS * 0.6 ? cut.slice(0, sp) : cut).trim();
}
// Canonical article URL: trailing utm_* / tracking params removed, fragment
// dropped, so the same story seen via two feeds dedupes.
function canonicalUrl(raw) {
  const s = cleanText(raw || "");
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|mc_|ref$|source$)/i.test(k)) u.searchParams.delete(k);
    u.hash = "";
    let out = u.toString();
    if (out.endsWith("?")) out = out.slice(0, -1);
    return out;
  } catch { return null; }
}

// Parses an RSS 2.0 / RSS 1.0 / Atom document into normalized items. Throws
// (plain Error) when the body is not a feed at all; a feed with zero items is
// a valid (empty) feed.
// Some outlets prepend "<Outlet> <Title>" to the description; a summary that
// repeats the headline is noise, so that prefix is dropped when present.
function stripTitlePrefix(summary, title, outletName) {
  let s = summary;
  for (const prefix of [outletName ? `${outletName} ${title}` : null, title]) {
    if (prefix && s.startsWith(prefix)) { s = s.slice(prefix.length).trim(); break; }
  }
  return s;
}

export function parseFeed(text, outletName = null) {
  const body = String(text || "").replace(/^\uFEFF/, "");
  // Strip to a FIXED POINT: a single pass leaves a nested "<!--<!-- -->" behind,
  // which would let a hostile body hide the real root element from this sniff.
  let head = body.slice(0, 4096).replace(/<\?xml[\s\S]*?\?>/i, "").replace(/<!DOCTYPE[^>]*>/i, "");
  for (let i = 0; i < 8; i++) {
    const next = head.replace(/<!--[\s\S]*?-->/g, "");
    if (next === head) break;
    head = next;
  }
  head = head.trimStart();
  const isAtom = /^<feed[\s>]/i.test(head);
  const isRss = /^<rss[\s>]/i.test(head) || /^<rdf:RDF[\s>]/i.test(head);
  if (!isAtom && !isRss) throw new Error("not a valid RSS/Atom feed");
  const blocks = body.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry\s*>/gi : /<item[\s>][\s\S]*?<\/item\s*>/gi) || [];
  const items = [];
  for (const b of blocks) {
    const title = cleanText(childText(b, "title"));
    const url = isAtom
      ? canonicalUrl(atomLink(b))
      : canonicalUrl(childText(b, "link") ?? atomLink(b) ?? "");
    const publishedAt = isAtom
      ? toIso(childText(b, "published", "updated"))
      : toIso(childText(b, "pubDate", "dc:date", "date"));
    const summaryRaw = isAtom
      ? childText(b, "summary", "content")
      : childText(b, "description", "content:encoded");
    if (!title || !url) continue;
    items.push({ title, url, publishedAt, summary: summarize(stripTitlePrefix(cleanText(summaryRaw), title, outletName)) });
  }
  return items;
}

// --- feed cache + fetch ------------------------------------------------------
const feedCache = new Map(); // id -> { at, items, error }
// In-flight map so a burst arriving on a cold or just-expired cache makes ONE
// request per publisher, not one per caller: without it, N concurrent callers
// fan out N times across every feed, which is how an egress IP gets blocked.
const feedInFlight = new Map();

async function loadFeed(id) {
  const hit = feedCache.get(id);
  const now = Date.now();
  if (hit && now - hit.at < (hit.error ? FEED_FAIL_TTL_MS : FEED_TTL_MS)) return { ...hit, cached: true };
  const pending = feedInFlight.get(id);
  if (pending) return pending.then((e) => ({ ...e, cached: true }));
  const p = fetchFeed(id).finally(() => feedInFlight.delete(id));
  feedInFlight.set(id, p);
  return p.then((e) => ({ ...e, cached: false }));
}

async function fetchFeed(id) {
  const now = Date.now();
  const src = NEWS_SOURCES[id];
  let entry;
  try {
    const { status, text } = await rawFetch(src.url, {
      label: src.name, timeoutMs: FEED_TIMEOUT_MS,
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
    });
    if (status >= 400) throw bad(`HTTP ${status}`, status >= 500 ? 502 : 422);
    if (text.length > FEED_MAX_BYTES) throw bad("feed larger than the 2MB cap", 422);
    const items = parseFeed(text, src.name).map((it) => ({ ...it, source: id }));
    entry = { at: now, items, error: null };
  } catch (err) {
    const reason = err?.statusCode ? err.message : "not a valid RSS/Atom feed";
    console.warn(`[crypto-signals] feed ${id} failed: ${reason}`);
    entry = { at: now, items: [], error: reason };
  }
  feedCache.set(id, entry);
  return entry;
}

function queryTerms(raw) {
  if (raw == null || raw === "") return [];
  if (typeof raw !== "string") throw bad('"query" must be a string of keywords');
  const s = raw.trim();
  if (s.length > 200) throw bad('"query" must be at most 200 characters');
  const terms = s.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length > 10) throw bad('"query" must be at most 10 keywords');
  return terms;
}

// --- indicator math (pure; exported for the offline test) ------------------
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
// EMA seeded with the SMA of the first `period` values (the conventional seed).
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (values[i] - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}
// Wilder's RSI: first averages are simple means of the first `period`
// changes, then smoothed (prev*(n-1)+cur)/n.
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  const rs = (g, l) => (l === 0 ? 100 : g === 0 ? 0 : 100 - 100 / (1 + g / l));
  out[period] = rs(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = rs(avgGain, avgLoss);
  }
  return out;
}
export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const n = closes.length;
  const line = new Array(n).fill(null), signal = new Array(n).fill(null), hist = new Array(n).fill(null);
  if (n < slow) return { line, signal, hist };
  const ef = ema(closes, fast), es = ema(closes, slow);
  for (let i = slow - 1; i < n; i++) line[i] = ef[i] - es[i];
  const lineVals = line.slice(slow - 1);
  const sig = ema(lineVals, signalPeriod);
  for (let i = 0; i < sig.length; i++) {
    if (sig[i] == null) continue;
    signal[slow - 1 + i] = sig[i];
    hist[slow - 1 + i] = lineVals[i] - sig[i];
  }
  return { line, signal, hist };
}
// Population standard deviation bands around SMA(period).
export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null), lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let ss = 0;
    for (let j = i - period + 1; j <= i; j++) ss += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(ss / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { upper, middle: mid, lower };
}
// Wilder's ATR: true range from the second candle on (needs a previous
// close), first ATR = mean of the first `period` true ranges.
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  let prev = 0;
  for (let i = 0; i < period; i++) prev += tr[i];
  prev /= period;
  out[period] = prev;
  for (let i = period; i < tr.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i + 1] = prev;
  }
  return out;
}
// Cumulative VWAP over the window (typical price = (h+l+c)/3).
export function vwap(candles) {
  const out = new Array(candles.length).fill(null);
  let pv = 0, vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    pv += ((c.h + c.l + c.c) / 3) * c.v;
    vol += c.v;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

const last = (arr) => (arr.length ? arr[arr.length - 1] : null);
const tail = (arr, n) => arr.slice(Math.max(0, arr.length - n));

// --- Tools ----------------------------------------------------------------
export const CRYPTO_SIGNALS_TOOLS = [
  // ===========================================================================
  // crypto-news - aggregated headlines from public outlet feeds.
  // ===========================================================================
  {
    route: "POST /api/crypto-news",
    name: "Crypto news headlines",
    slug: "crypto-news",
    category: "crypto",
    price: "$0.002",
    description:
      `Latest crypto headlines aggregated from the public RSS/Atom feeds of ${SOURCE_IDS.length} major outlets (${SOURCE_IDS.join(", ")}), normalized to title, url, source, publishedAt and a plain-text summary, deduplicated by URL and sorted newest first. Optional keyword filter on title + summary (all keywords must match, or match=any), source subset, time window (hours, max 168) and limit (max 50). Feeds are cached 5 minutes; a feed that fails is listed in errors[] and never blocks the rest. No key, no LLM.`,
    tags: ["crypto", "news", "headlines", "rss", "bitcoin", "ethereum", "defi", "signals"],
    discovery: {
      bodyType: "json",
      input: { query: "bitcoin", limit: 10 },
      inputSchema: {
        properties: {
          query: { type: "string", description: "Optional keywords (space-separated, max 10); matched case-insensitively against title + summary." },
          match: { type: "string", description: "all (default): every keyword must appear; any: at least one." },
          sources: { type: "array", items: { type: "string" }, description: `Optional subset of source ids: ${SOURCE_IDS.join(", ")}.` },
          hours: { type: "number", description: "Only items published within the last N hours (default 48, max 168)." },
          limit: { type: "number", description: "Items to return (default 20, max 50)." },
        },
        required: [],
      },
      output: {
        example: {
          source: "rss",
          query: "bitcoin",
          match: "all",
          hours: 48,
          count: 2,
          items: [
            { title: "Bitcoin holds above a key level as ETF inflows resume", url: "https://www.coindesk.com/markets/2026/08/22/example", source: "coindesk", sourceName: "CoinDesk", publishedAt: "2026-08-22T12:00:00.000Z", summary: "Spot ETF inflows returned for a third day while funding stayed neutral." },
            { title: "Miners add hashrate ahead of the next difficulty adjustment", url: "https://decrypt.co/123456/example", source: "decrypt", sourceName: "Decrypt", publishedAt: "2026-08-22T10:30:00.000Z", summary: "Network hashrate set a new high this week." },
          ],
          sources: [{ id: "coindesk", name: "CoinDesk", items: 25, matched: 1, cached: false }],
          errors: [],
          fetchedAt: "2026-08-22T12:05:00.000Z",
        },
      },
    },
    handler: async (i = {}) => {
      const terms = queryTerms(i.query);
      const match = i.match == null || i.match === "" ? "all" : String(i.match).toLowerCase();
      if (match !== "all" && match !== "any") throw bad('"match" must be "all" or "any"');
      const ids = takeList(i.sources, "sources", SOURCE_IDS, SOURCE_IDS.length) || SOURCE_IDS;
      const hours = takeInt(i.hours, "hours", 48, 1, 168);
      const limit = takeInt(i.limit, "limit", 20, 1, 50);

      const loaded = await Promise.all(ids.map((id) => loadFeed(id).then((r) => ({ id, ...r }))));
      const errors = loaded.filter((l) => l.error).map((l) => ({ source: l.id, error: l.error }));
      if (errors.length === loaded.length) throw bad("Every requested news feed failed - try again shortly", 502);

      const since = Date.now() - hours * 3_600_000;
      const seen = new Set();
      const all = [];
      const perSource = [];
      for (const l of loaded) {
        let matched = 0;
        for (const it of l.items) {
          if (!it.publishedAt || Date.parse(it.publishedAt) < since) continue;
          if (terms.length) {
            const hay = `${it.title} ${it.summary}`.toLowerCase();
            const hit = match === "all" ? terms.every((t) => hay.includes(t)) : terms.some((t) => hay.includes(t));
            if (!hit) continue;
          }
          if (seen.has(it.url)) continue;
          seen.add(it.url);
          matched++;
          all.push({ ...it, sourceName: NEWS_SOURCES[l.id].name });
        }
        perSource.push({ id: l.id, name: NEWS_SOURCES[l.id].name, items: l.items.length, matched, cached: !!l.cached, ...(l.error ? { error: l.error } : {}) });
      }
      all.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.url.localeCompare(b.url));
      const items = all.slice(0, limit).map((it) => ({
        title: it.title, url: it.url, source: it.source, sourceName: it.sourceName, publishedAt: it.publishedAt, summary: it.summary,
      }));
      return {
        source: "rss",
        query: terms.length ? terms.join(" ") : null,
        match,
        hours,
        count: items.length,
        totalMatched: all.length,
        items,
        sources: perSource,
        errors,
        fetchedAt: nowIso(),
      };
    },
  },

  // ===========================================================================
  // crypto-indicators - RSI/MACD/EMA/SMA/Bollinger/ATR/VWAP from perp candles.
  // ===========================================================================
  {
    route: "POST /api/crypto-indicators",
    name: "Crypto technical indicators",
    slug: "crypto-indicators",
    category: "crypto",
    price: "$0.002",
    description:
      "Technical indicators for one perpetual computed deterministically from Hyperliquid candles: RSI(14), MACD(12,26,9) with signal and histogram, EMA 20/50/200, SMA 20/50, Bollinger(20,2) with bandwidth and %B, ATR(14) and window VWAP. Returns the latest close, the latest value of each, the last N series points (points, max 100), and a plain summary (trend vs EMA50, RSI zone, MACD cross on the latest bar). Set ohlcv to also get the last N OHLCV candles (open, high, low, close, volume) in the same call. interval 1m to 1M, limit = candles used (default 200, max 500). Choose a subset with indicators. No key, no LLM.",
    tags: ["crypto", "technical-analysis", "indicators", "rsi", "macd", "ema", "bollinger", "atr", "vwap", "signals", "hyperliquid", "ohlcv", "candles", "cryptocurrency", "bitcoin", "ethereum", "btc", "eth", "price"],
    // Price, candles and RSI/EMA in one call is the most repeated find-miss on
    // the demand board (2026-09-20..25); this tool answers it with ohlcv set,
    // but its name says none of those words, so the searches landed elsewhere.
    aliases: ["crypto-ohlcv", "crypto-candles", "crypto-rsi", "crypto-ema", "crypto-technical-analysis"],
    discovery: {
      bodyType: "json",
      input: { coin: "BTC", interval: "1h", limit: 200, points: 5 },
      inputSchema: {
        properties: {
          coin: { type: "string", description: "Perp ticker, e.g. BTC, ETH, SOL." },
          interval: { type: "string", description: "Candle interval (default 1h): 1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 3d 1w 1M." },
          limit: { type: "number", description: "Candles to compute over (default 200, max 500). EMA200 needs 200, MACD 34, RSI/ATR 15, SMA/Bollinger 20." },
          indicators: { type: "array", items: { type: "string" }, description: `Optional subset of: ${INDICATOR_IDS.join(", ")} (default all).` },
          points: { type: "number", description: "Series points to return per indicator, newest last (default 20, max 100)." },
          ohlcv: { type: "number", description: "Also return the last N OHLCV candles, newest last (default 0 = none, max 100)." },
        },
        required: ["coin"],
      },
      output: {
        example: {
          source: "hyperliquid",
          coin: "BTC",
          interval: "1h",
          candles: 200,
          window: { from: "2026-08-14T05:00:00.000Z", to: "2026-08-22T12:00:00.000Z" },
          lastClose: 77244,
          indicators: {
            rsi: { period: 14, value: 56.21, series: [{ t: "2026-08-22T12:00:00.000Z", v: 56.21 }] },
            macd: { fast: 12, slow: 26, signal: 9, value: 120.5, signalValue: 98.2, histogram: 22.3, series: [{ t: "2026-08-22T12:00:00.000Z", macd: 120.5, signal: 98.2, histogram: 22.3 }] },
            ema: { ema20: 77100.2, ema50: 76800.4, ema200: 75900.1, series: [{ t: "2026-08-22T12:00:00.000Z", ema20: 77100.2, ema50: 76800.4, ema200: 75900.1 }] },
            sma: { sma20: 77050.3, sma50: 76750.9, series: [{ t: "2026-08-22T12:00:00.000Z", sma20: 77050.3, sma50: 76750.9 }] },
            bollinger: { period: 20, mult: 2, upper: 77900.1, middle: 77050.3, lower: 76200.5, bandwidthPct: 2.2, percentB: 0.61, series: [{ t: "2026-08-22T12:00:00.000Z", upper: 77900.1, middle: 77050.3, lower: 76200.5 }] },
            atr: { period: 14, value: 410.2, pctOfClose: 0.53, series: [{ t: "2026-08-22T12:00:00.000Z", v: 410.2 }] },
            vwap: { value: 76990.7, series: [{ t: "2026-08-22T12:00:00.000Z", v: 76990.7 }] },
          },
          summary: { trend: "above", rsiZone: "neutral", macdCross: "none", macdHistogram: "positive", text: "BTC 1h: close above EMA50, RSI 56.2 (neutral), MACD histogram positive, no cross on the latest bar." },
          fetchedAt: "2026-08-22T12:05:00.000Z",
        },
      },
    },
    handler: async (i = {}) => {
      const limit = takeInt(i.limit, "limit", 200, 2, MAX_CANDLES);
      const points = takeInt(i.points, "points", 20, 1, MAX_POINTS);
      const ohlcvN = takeInt(i.ohlcv, "ohlcv", 0, 0, MAX_POINTS);
      const interval = i.interval == null || i.interval === "" ? "1h" : String(i.interval);
      if (!INTERVALS[interval]) throw bad(`"interval" must be one of ${Object.keys(INTERVALS).join(" ")}`);
      const want = new Set(takeList(i.indicators, "indicators", INDICATOR_IDS, INDICATOR_IDS.length) || INDICATOR_IDS);
      const coin = await resolveCoin(i.coin);
      const endTime = Date.now();
      const startTime = endTime - limit * INTERVALS[interval];
      const raw = await hlInfo({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } });
      if (!Array.isArray(raw)) throw bad("Hyperliquid returned an unexpected response shape", 502);
      const candles = raw.slice(-limit)
        .map((c) => ({ t: num(c.t), o: num(c.o), h: num(c.h), l: num(c.l), c: num(c.c), v: num(c.v) ?? 0 }))
        .filter((c) => c.t != null && c.o != null && c.h != null && c.l != null && c.c != null);
      if (candles.length < 2) throw bad("Hyperliquid returned too few candles for that coin/interval", 502);
      // The candles are already in hand for the indicators, so returning the
      // latest bars costs no extra upstream read.
      const ohlcv = ohlcvN > 0 ? candles.slice(-ohlcvN).map((c) => ({ t: new Date(c.t).toISOString(), open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v })) : undefined;
      return { source: "hyperliquid", coin, interval, ...computeIndicators(candles, want, points), ...(ohlcv ? { ohlcv } : {}), fetchedAt: nowIso(),
        disclaimer: "Technical indicators computed from public market data. Not investment advice and not a trading signal or recommendation." };
    },
  },

  // ===========================================================================
  // crypto-market-pulse - breadth snapshot across every listed perp.
  // ===========================================================================
  {
    route: "POST /api/crypto-market-pulse",
    name: "Crypto market pulse",
    slug: "crypto-market-pulse",
    category: "crypto",
    price: "$0.004",
    description:
      "One-call market snapshot across every perpetual listed on Hyperliquid: breadth (advancers, decliners, unchanged, mean/median and volume-weighted 24h change), total open interest and 24h volume, top markets by volume, top gainers and losers, highest and lowest funding, and BTC/ETH at a glance. limit caps each list (max 20); minVolumeUsd (default 1,000,000) filters illiquid markets out of the lists and breadth. Pure arithmetic over public data, no key, no LLM.",
    tags: ["crypto", "market", "breadth", "gainers", "losers", "funding", "open-interest", "signals", "hyperliquid"],
    discovery: {
      bodyType: "json",
      input: { limit: 5 },
      inputSchema: {
        properties: {
          limit: { type: "number", description: "Rows per list (default 10, max 20)." },
          minVolumeUsd: { type: "number", description: "Minimum 24h notional volume in USD for a market to count (default 1000000, 0 = all)." },
        },
        required: [],
      },
      output: {
        example: {
          source: "hyperliquid",
          markets: { listed: 230, counted: 120, minVolumeUsd: 1000000 },
          breadth: { advancers: 80, decliners: 35, unchanged: 5, advancersPct: 66.67, meanChange24hPct: 1.42, medianChange24hPct: 0.95, volumeWeightedChange24hPct: 0.61 },
          totals: { openInterestUsd: 9100000000, volume24hUsd: 12500000000, top5VolumeSharePct: 71.2 },
          funding: { positive: 90, negative: 25, zero: 5, meanAprPct: 8.4 },
          majors: { BTC: { markPx: 77244, change24hPct: 0.36, fundingAprPct: 10.95, openInterestUsd: 2776803000, volume24hUsd: 4679441788.67 }, ETH: { markPx: 2429.3, change24hPct: 2.06, fundingAprPct: -4.38, openInterestUsd: 1832000000, volume24hUsd: 3396726206.45 } },
          topByVolume: [{ coin: "BTC", markPx: 77244, change24hPct: 0.36, volume24hUsd: 4679441788.67, openInterestUsd: 2776803000, fundingAprPct: 10.95 }],
          topGainers: [{ coin: "SOL", markPx: 180.2, change24hPct: 8.1, volume24hUsd: 900000000, openInterestUsd: 500000000, fundingAprPct: 20.1 }],
          topLosers: [{ coin: "DOGE", markPx: 0.21, change24hPct: -4.2, volume24hUsd: 300000000, openInterestUsd: 200000000, fundingAprPct: -3.2 }],
          highestFunding: [{ coin: "SOL", fundingHourly: 0.0000229, fundingAprPct: 20.1, change24hPct: 8.1, openInterestUsd: 500000000 }],
          lowestFunding: [{ coin: "ETH", fundingHourly: -0.000005, fundingAprPct: -4.38, change24hPct: 2.06, openInterestUsd: 1832000000 }],
          fetchedAt: "2026-08-22T12:05:00.000Z",
        },
      },
    },
    handler: async (i = {}) => {
      const limit = takeInt(i.limit, "limit", 10, 1, 20);
      let minVol = 1_000_000;
      if (i.minVolumeUsd != null && i.minVolumeUsd !== "") {
        const n = Number(i.minVolumeUsd);
        if (!Number.isFinite(n) || n < 0) throw bad('"minVolumeUsd" must be a number >= 0');
        minVol = n;
      }
      const rows = await perpMarkets();
      return { source: "hyperliquid", ...marketPulse(rows, { limit, minVolumeUsd: minVol }), fetchedAt: nowIso() };
    },
  },
];

// --- pure assembly (exported for the offline test) -------------------------
export function computeIndicators(candles, want, points) {
  const closes = candles.map((c) => c.c);
  const ts = candles.map((c) => new Date(c.t).toISOString());
  const n = candles.length;
  const close = last(closes);
  const seriesOf = (arrs, keys) => {
    const out = [];
    for (let k = Math.max(0, n - points); k < n; k++) {
      const row = { t: ts[k] };
      let any = false;
      keys.forEach((key, j) => { const v = arrs[j][k]; row[key] = round(v, 6); if (v != null) any = true; });
      if (any) out.push(row);
    }
    return out;
  };
  const notes = [];
  const enough = (name, min) => { if (n < min) notes.push(`${name} needs at least ${min} candles (got ${n})`); return n >= min; };

  // Computed once; the summary reads the same arrays the indicators report.
  const rsiArr = rsi(closes, 14);
  const macdArr = macd(closes, 12, 26, 9);
  const ema50 = ema(closes, 50);
  const ind = {};

  if (want.has("rsi")) {
    ind.rsi = { period: 14, value: enough("rsi", 15) ? round(last(rsiArr), 4) : null, series: seriesOf([rsiArr], ["v"]) };
  }
  if (want.has("macd")) {
    const okm = enough("macd", 34);
    ind.macd = {
      fast: 12, slow: 26, signal: 9,
      value: okm ? round(last(macdArr.line), 6) : null,
      signalValue: okm ? round(last(macdArr.signal), 6) : null,
      histogram: okm ? round(last(macdArr.hist), 6) : null,
      series: seriesOf([macdArr.line, macdArr.signal, macdArr.hist], ["macd", "signal", "histogram"]),
    };
  }
  if (want.has("ema")) {
    const periods = [20, 50, 200];
    const es = periods.map((p) => (p === 50 ? ema50 : ema(closes, p)));
    const o = {};
    periods.forEach((p, j) => { o[`ema${p}`] = enough(`ema${p}`, p) ? round(last(es[j]), 6) : null; });
    o.series = seriesOf(es, periods.map((p) => `ema${p}`));
    ind.ema = o;
  }
  if (want.has("sma")) {
    const periods = [20, 50];
    const ss = periods.map((p) => sma(closes, p));
    const o = {};
    periods.forEach((p, j) => { o[`sma${p}`] = enough(`sma${p}`, p) ? round(last(ss[j]), 6) : null; });
    o.series = seriesOf(ss, periods.map((p) => `sma${p}`));
    ind.sma = o;
  }
  if (want.has("bollinger")) {
    const b = bollinger(closes, 20, 2);
    const okb = enough("bollinger", 20);
    const up = last(b.upper), mid = last(b.middle), lo = last(b.lower);
    ind.bollinger = {
      period: 20, mult: 2,
      upper: okb ? round(up, 6) : null, middle: okb ? round(mid, 6) : null, lower: okb ? round(lo, 6) : null,
      bandwidthPct: okb && mid ? round(((up - lo) / mid) * 100, 4) : null,
      percentB: okb && up !== lo ? round((close - lo) / (up - lo), 4) : null,
      series: seriesOf([b.upper, b.middle, b.lower], ["upper", "middle", "lower"]),
    };
  }
  if (want.has("atr")) {
    const a = atr(candles, 14);
    const oka = enough("atr", 15);
    const v = last(a);
    ind.atr = { period: 14, value: oka ? round(v, 6) : null, pctOfClose: oka && close ? round((v / close) * 100, 4) : null, series: seriesOf([a], ["v"]) };
  }
  if (want.has("vwap")) {
    const v = vwap(candles);
    ind.vwap = { value: round(last(v), 6), series: seriesOf([v], ["v"]) };
  }

  // Summary - fixed templates over the arrays above (no model).
  const e50 = last(ema50);
  const trend = e50 == null ? "unknown" : close > e50 ? "above" : close < e50 ? "below" : "at";
  const rsiVal = last(rsiArr);
  const rsiZone = rsiVal == null ? "unknown" : rsiVal >= 70 ? "overbought" : rsiVal <= 30 ? "oversold" : "neutral";
  const h1 = last(macdArr.hist);
  const h0 = macdArr.hist.length >= 2 ? macdArr.hist[macdArr.hist.length - 2] : null;
  const macdHistogram = h1 == null ? "unknown" : h1 > 0 ? "positive" : h1 < 0 ? "negative" : "flat";
  let macdCross = "unknown";
  if (h1 != null && h0 != null) macdCross = h0 <= 0 && h1 > 0 ? "bullish" : h0 >= 0 && h1 < 0 ? "bearish" : "none";
  else if (h1 != null) macdCross = "none";
  const parts = [
    trend === "unknown" ? "EMA50 unavailable" : `close ${trend} EMA50`,
    rsiVal == null ? "RSI unavailable" : `RSI ${round(rsiVal, 1)} (${rsiZone})`,
    macdHistogram === "unknown" ? "MACD unavailable" : `MACD histogram ${macdHistogram}, ${macdCross === "none" ? "no cross" : `${macdCross} cross`} on the latest bar`,
  ];
  return {
    candles: n,
    window: { from: ts[0], to: ts[n - 1] },
    lastClose: round(close, 8),
    indicators: ind,
    summary: { trend, rsiZone, macdCross, macdHistogram, text: parts.join(", ") + "." },
    ...(notes.length ? { notes } : {}),
  };
}

export function marketPulse(rows, { limit, minVolumeUsd }) {
  const priced = rows.filter((r) => r.markPx != null);
  const counted = priced.filter((r) => (r.volume24hUsd ?? 0) >= minVolumeUsd);
  const withChange = counted.filter((r) => r.change24hPct != null);
  const adv = withChange.filter((r) => r.change24hPct > 0).length;
  const dec = withChange.filter((r) => r.change24hPct < 0).length;
  const unch = withChange.length - adv - dec;
  const changes = withChange.map((r) => r.change24hPct).sort((a, b) => a - b);
  const median = changes.length ? (changes.length % 2 ? changes[(changes.length - 1) / 2] : (changes[changes.length / 2 - 1] + changes[changes.length / 2]) / 2) : null;
  const mean = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null;
  const volSum = withChange.reduce((a, r) => a + (r.volume24hUsd ?? 0), 0);
  const vw = volSum > 0 ? withChange.reduce((a, r) => a + r.change24hPct * (r.volume24hUsd ?? 0), 0) / volSum : null;

  const totalOi = priced.reduce((a, r) => a + (r.openInterestUsd ?? 0), 0);
  const totalVol = priced.reduce((a, r) => a + (r.volume24hUsd ?? 0), 0);
  const byVol = [...priced].sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
  const top5Vol = byVol.slice(0, 5).reduce((a, r) => a + (r.volume24hUsd ?? 0), 0);

  const fundingRows = counted.filter((r) => r.fundingHourly != null);
  const fPos = fundingRows.filter((r) => r.fundingHourly > 0).length;
  const fNeg = fundingRows.filter((r) => r.fundingHourly < 0).length;
  const fMeanApr = fundingRows.length ? fundingRows.reduce((a, r) => a + r.fundingAprPct, 0) / fundingRows.length : null;

  const view = (r) => ({ coin: r.coin, markPx: r.markPx, change24hPct: r.change24hPct, volume24hUsd: r.volume24hUsd, openInterestUsd: r.openInterestUsd, fundingAprPct: r.fundingAprPct });
  const fview = (r) => ({ coin: r.coin, fundingHourly: round(r.fundingHourly, 8), fundingAprPct: r.fundingAprPct, change24hPct: r.change24hPct, openInterestUsd: r.openInterestUsd });
  const major = (sym) => { const r = priced.find((x) => x.coin === sym); return r ? { markPx: r.markPx, change24hPct: r.change24hPct, fundingAprPct: r.fundingAprPct, openInterestUsd: r.openInterestUsd, volume24hUsd: r.volume24hUsd } : null; };
  const byChangeDesc = [...withChange].sort((a, b) => b.change24hPct - a.change24hPct || a.coin.localeCompare(b.coin));
  const byFundingDesc = [...fundingRows].sort((a, b) => b.fundingHourly - a.fundingHourly || a.coin.localeCompare(b.coin));

  return {
    markets: { listed: priced.length, counted: counted.length, minVolumeUsd },
    breadth: {
      advancers: adv, decliners: dec, unchanged: unch,
      advancersPct: withChange.length ? round((adv / withChange.length) * 100, 2) : null,
      meanChange24hPct: round(mean, 4),
      medianChange24hPct: round(median, 4),
      volumeWeightedChange24hPct: round(vw, 4),
    },
    totals: {
      openInterestUsd: round(totalOi, 2),
      volume24hUsd: round(totalVol, 2),
      top5VolumeSharePct: totalVol > 0 ? round((top5Vol / totalVol) * 100, 2) : null,
    },
    funding: { positive: fPos, negative: fNeg, zero: fundingRows.length - fPos - fNeg, meanAprPct: round(fMeanApr, 4) },
    majors: { BTC: major("BTC"), ETH: major("ETH") },
    topByVolume: byVol.slice(0, limit).map(view),
    topGainers: byChangeDesc.slice(0, limit).map(view),
    topLosers: byChangeDesc.slice().reverse().slice(0, limit).map(view),
    highestFunding: byFundingDesc.slice(0, limit).map(fview),
    lowestFunding: byFundingDesc.slice().reverse().slice(0, limit).map(fview),
  };
}

export const __test = {
  HL_INFO,
  INTERVALS,
  resetCaches: () => { metaCache = { at: 0, names: null }; feedCache.clear(); },
  feedCacheSize: () => feedCache.size,
  cleanText,
  canonicalUrl,
};

// Free text in these results is written by third parties (headlines, posts,
// casts, token names and descriptions, page titles). Anyone can mint a token or
// publish a post, so this is the cheapest prompt-injection delivery vehicle in
// the catalog: flag it as data, never instructions, the way site-crawl does.
const UNTRUSTED_TEXT_SLUGS = new Set(["crypto-news"]);
for (const t of CRYPTO_SIGNALS_TOOLS) {
  if (!UNTRUSTED_TEXT_SLUGS.has(t.slug)) continue;
  const inner = t.handler;
  t.handler = async (...args) => markUntrusted(await inner(...args));
}
