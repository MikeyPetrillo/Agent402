// Agent wish loop: capture demand for tools we don't have yet, instead of
// losing it silently when a caller finds nothing useful and leaves. This
// module is the write path + aggregate view for that signal: free text ->
// normalized cluster -> (eventually) a real tool.
//
// Storage: append-only JSONL, one record per line. Same volume contract as
// stats.js/pow.js (persist to /data when mounted) but the fallback is
// SILENT — losing wish history on a restart is an acceptable tradeoff for a
// demand-signal feature, unlike payment counters or PoW replay state, so
// there's no production hard-stop here.
import {
  existsSync, statSync, readFileSync, appendFileSync,
  openSync, readSync, closeSync,
} from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { logSafe } from "./log-safe.js";

const HAS_DATA_DIR = existsSync("/data");
const DATA_DIR = HAS_DATA_DIR ? "/data" : "/tmp";
let WISH_FILE = join(DATA_DIR, "wishes.jsonl");
export const wishStoragePersistent = HAS_DATA_DIR;

const NEED_MAX = 500;
const CONTEXT_MAX = 300;
const MAX_READ_BYTES = 5 * 1024 * 1024; // 5MB boot-read cap; beyond that, tail only.
const CLUSTER_CAP = 20_000; // bound in-memory distinct-cluster growth

// Rate limits: mirrors the /api/index/register pattern in server.js — a
// per-IP sliding window plus a global sliding window, checked in that order.
// Find-miss records (implicit, server-generated) are exempt: they're capped
// naturally by /api/find's own traffic and the file-line cap below, and
// penalizing a caller for a search that happened to miss would be wrong.
const IP_WINDOW_MS = 3_600_000; // 1 hour
const IP_MAX = 10;
// find-miss is exempt from the EXPLICIT-wish limit above for a good reason: a
// caller whose /api/find query legitimately missed must never be punished with
// a 429 on a search. But exemption from penalty is not a reason for exemption
// from VOLUME, and it was both: a novel unmatched query wrote a cluster with no
// per-IP bound at all, so one rotating client could fill CLUSTER_CAP (20k) in
// about 34 hours, after which every genuinely new demand signal is discarded.
// This bound is deliberately generous - a real agent exploring the catalog will
// not approach it - and exceeding it DROPS THE RECORDING rather than failing the
// caller's request.
const FIND_MISS_MAX_PER_HOUR = Number(process.env.WISH_FIND_MISS_MAX_PER_HOUR) || 60;
let findMissHits = new Map(); // ip -> timestamp[]
const GLOBAL_WINDOW_MS = 24 * 3_600_000; // 1 day
const GLOBAL_MAX = 100;

let MAX_LINES = 50_000;

let ipHits = new Map(); // ip -> timestamp[]
let globalHits = [];
let clusters = new Map(); // normalizedKey -> { count, firstSeen, lastSeen, sources, issueOpened }
let lineCount = 0;
let capReached = false;

// Threshold at which a repeated cluster is loud-logged as worth building. No
// GitHub API call from the server (no token in prod) — /api/wishes exposes
// the aggregate so a scheduled workflow can poll it and open the issue.
export const WISH_THRESHOLD = 5;

// A raw count is not enough to auto-open a public GitHub issue: one script can
// POST the same string 5 times in a minute (observed 2026-07-17: a single
// source drove a cluster to 100+ identical hits in a few hours, minting three
// junk issues). A cluster QUALIFIES only when it also shows independence —
// either corroboration across ≥2 distinct sources (api / mcp / find-miss), or
// demand sustained past QUALIFY_MIN_SPAN_MS. A genuine gap is hit by different
// agents across different surfaces, or recurs over days; a scripted burst is
// one source in one sitting and clears neither bar. Honest limit (same framing
// as the router's per-seller Sybil cap): a patient spammer can still drip over
// 24h or add a decoy hit on a second surface — this raises the cost from "5
// curls" to "sustained or multi-surface", it doesn't make gaming impossible.
// The wish is always recorded and visible on /api/wishes regardless; this gate
// only governs which clusters auto-open an issue.
export const QUALIFY_MIN_SPAN_MS = 24 * 3_600_000; // 24h

// Distinct CALLERS a cluster needs before it qualifies. Measured 2026-08-27:
// one scripted sweep re-ran ~30 queries against /api/find for two days and,
// because find-miss recording is rate-limit exempt and had no per-caller
// dedupe, every one of them "qualified" (5+ hits over 24h from ONE source
// that was really one machine). A caller is a day-scoped hash of the IP
// (never the IP itself, see callerHash): the same machine on the same day
// is one caller however many times it asks. Three distinct callers is the
// bar; a single bot can no longer manufacture a qualified cluster, and a
// patient bot now needs three machines or three days.
export const QUALIFY_MIN_CALLERS = 3;
const CALLERS_PER_CLUSTER_CAP = 1000;

// The served-overlay floor. FIND_WEAK_SCORE (3) is the threshold below which
// /api/find records a miss; reusing it as the "served" bar marked 17 of 48
// qualified clusters as served by matches scoring 5 to 24 ("todo task
// manager" -> fund-report at 5). A cluster is served only when the catalog
// answers it with a real match.
export const WISH_SERVED_MIN_SCORE = 45;

/**
 * Day-scoped, KEYED caller fingerprint: HMAC-SHA256(secret, ip|UTC day),
 * 12 hex chars. Never the IP. Keyed, not merely hashed: the fingerprint is
 * persisted on every wish line, and a plain sha256 of an IPv4 address is
 * brute-forced from the file in minutes (2^32 candidates per day), which
 * would have made "never the IP" true only while the file stayed private.
 * The secret is WISH_CALLER_SALT, else POW_SECRET (already on prod). With
 * neither set this returns null and recordWish credits no caller and dedupes
 * nothing, rather than writing an unkeyed hash to disk. Read at call time so
 * tests and rotation take effect without a restart.
 */
export function callerHash(ip, ts = Date.now()) {
  const secret = (process.env.WISH_CALLER_SALT || process.env.POW_SECRET || "").trim();
  if (!secret) return null;
  const day = new Date(ts).toISOString().slice(0, 10);
  return createHmac("sha256", secret).update(`${ip || "?"}|${day}`).digest("hex").slice(0, 12);
}

// Does a cluster's shape clear the anti-spam bar described above? Exported so
// the wish-issues workflow's gate and the unit tests share one definition.
export function clusterQualifies(c) {
  if (!c || c.count < WISH_THRESHOLD) return false;
  const distinctSources = ["api", "mcp", "find-miss"].filter((s) => (c.sources?.[s] || 0) > 0).length;
  const spanMs = (c.lastSeen || 0) - (c.firstSeen || 0);
  const callers = c.callers instanceof Set ? c.callers.size : (c.callerCount || 0);
  return callers >= QUALIFY_MIN_CALLERS && (distinctSources >= 2 || spanMs >= QUALIFY_MIN_SPAN_MS);
}

/**
 * Served-overlay for the operator board: mark every cluster whose text NOW
 * finds a real catalog tool. A qualified cluster is a demand signal only
 * while the catalog can't answer it - the "minia2a" cluster (2026-07-28)
 * stayed qualified for 8 days AFTER the tools it asked for shipped, because
 * qualification looks at count/span/sources, never at the catalog. scoreFn
 * is injected (server wires findTools + CATALOG) so this stays pure and the
 * threshold lives with the caller. Mutates and returns the same array.
 */
export function annotateServed(clusters, scoreFn, minScore) {
  for (const c of clusters || []) {
    try {
      const top = scoreFn(c.text);
      if (top && top.score >= minScore) c.served = { slug: top.slug, score: top.score };
    } catch { /* annotation is best-effort - the board must render regardless */ }
  }
  return clusters;
}

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function normalize(s) {
  return String(s || "").toLowerCase().trim().replace(/\s+/g, " ");
}

// Exact JS stringification artifacts. These are what a broken caller sends,
// never what a person types when they want something built.
const NON_QUERY = new Set([
  "undefined", "null", "nan", "[object object]", "true", "false",
  "none", "n/a", "na", "-", "--", "...", "?",
]);

/** Is this normalized string a client bug rather than a capability request? */
export function isNonQuery(key) {
  const k = String(key || "").trim();
  if (!k) return true;
  if (NON_QUERY.has(k)) return true;
  if (k.length < 2) return true;          // "a", "0", "-"
  if (!/[a-z]/i.test(k)) return true;     // "18", "0", "30", "1.5", "!!!"
  return false;
}

let overflowWarned = false;

function upsertCluster(key, source, ts, caller) {
  let c = clusters.get(key);
  if (!c) {
    if (clusters.size >= CLUSTER_CAP) {
      // Overflow guard: never grow the in-memory map without bound. The caller
      // still gets a normal { recorded: true } response, because failing a
      // search or a wish submission over OUR capacity limit would be worse.
      //
      // But it is logged LOUDLY and once, because a silent drop makes "no new
      // demand arrived" and "we stopped listening an hour ago" look identical
      // on the board, and the board is what decides what gets built.
      if (!overflowWarned) {
        overflowWarned = true;
        console.warn(`[wish] cluster cap reached (${CLUSTER_CAP}) - NEW distinct wishes are being DROPPED and the demand board is no longer complete. Investigate before trusting it.`);
      }
      return { count: 1, firstSeen: ts, lastSeen: ts, sources: { [source]: 1 }, issueOpened: false, callers: new Set(caller ? [caller] : []), __overflow: true };
    }
    c = { count: 0, firstSeen: ts, lastSeen: ts, sources: { api: 0, mcp: 0, "find-miss": 0 }, issueOpened: false, callers: new Set() };
    clusters.set(key, c);
  }
  c.count++;
  c.lastSeen = ts;
  c.sources[source] = (c.sources[source] || 0) + 1;
  if (caller && c.callers.size < CALLERS_PER_CLUSTER_CAP) c.callers.add(caller);
  return c;
}

function appendLine(obj) {
  if (capReached) return;
  try {
    appendFileSync(WISH_FILE, JSON.stringify(obj) + "\n");
    lineCount++;
    if (lineCount >= MAX_LINES) {
      capReached = true;
      console.warn(`[wish] file line cap (${MAX_LINES}) reached at ${WISH_FILE} - further wishes are still counted/clustered but no longer written to disk.`);
    }
  } catch {
    /* best-effort write-through; never throw from the write path */
  }
}

function readTail(path, maxBytes) {
  const st = statSync(path);
  if (st.size <= maxBytes) return { text: readFileSync(path, "utf8"), truncated: false, size: st.size };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
    return { text: buf.toString("utf8"), truncated: true, size: st.size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Rebuild the in-memory cluster map (and approximate lineCount) from the
 * JSONL file at boot. Reads at most MAX_READ_BYTES - beyond that only the
 * tail is read, and lineCount is estimated from the sample's average line
 * length so the 50k-line cap still engages near the real boundary. Never
 * throws: a missing or corrupt file just means starting from empty state.
 */
function rebuildFromFile() {
  clusters = new Map();
  lineCount = 0;
  capReached = false;
  if (!existsSync(WISH_FILE)) return;
  try {
    const { text, truncated, size } = readTail(WISH_FILE, MAX_READ_BYTES);
    let lines = text.split("\n").filter(Boolean);
    // A truncated read may start mid-line; drop the (possibly partial) first line.
    if (truncated && lines.length) lines.shift();
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec && rec.type === "threshold" && typeof rec.key === "string") {
        const c = clusters.get(rec.key);
        if (c) c.issueOpened = true;
        continue;
      }
      if (rec && typeof rec.need === "string") {
        const key = normalize(rec.need);
        if (key) upsertCluster(key, ["api", "mcp", "find-miss"].includes(rec.source) ? rec.source : "api", rec.ts || Date.now(), typeof rec.caller === "string" ? rec.caller : null);
      }
    }
    if (!truncated) {
      lineCount = lines.length;
    } else {
      const avgLineLen = text.length / Math.max(lines.length, 1);
      lineCount = Math.round(size / Math.max(avgLineLen, 1));
      if (lineCount >= MAX_LINES) capReached = true;
    }
  } catch {
    /* best-effort rebuild; start clean on any surprise */
  }
}
rebuildFromFile();

/** Per-IP hourly bound on IMPLICIT (find-miss) wish recording. Same shape as
 *  checkRateLimit but a separate bucket, so a flood of misses can never consume
 *  a legitimate explicit-wish allowance or vice versa. */
function findMissLimited(ip) {
  const now = Date.now();
  const key = ip || "?";
  const mine = (findMissHits.get(key) || []).filter((t) => now - t < IP_WINDOW_MS);
  if (mine.length >= FIND_MISS_MAX_PER_HOUR) { findMissHits.set(key, mine); return true; }
  mine.push(now);
  findMissHits.set(key, mine);
  if (findMissHits.size > 5_000) {
    // Bound the bucket map itself; an IP with no recent hits needs no entry.
    for (const [k, v] of findMissHits) if (!v.some((t) => now - t < IP_WINDOW_MS)) findMissHits.delete(k);
  }
  return false;
}

function checkRateLimit(ip) {
  const now = Date.now();
  const key = ip || "?";
  const mine = (ipHits.get(key) || []).filter((t) => now - t < IP_WINDOW_MS);
  if (mine.length >= IP_MAX) return { limited: true, reason: `rate limit: ${IP_MAX} wishes per hour per IP` };
  const globalMine = globalHits.filter((t) => now - t < GLOBAL_WINDOW_MS);
  if (globalMine.length >= GLOBAL_MAX) {
    globalHits = globalMine;
    return { limited: true, reason: `rate limit: wish intake is busy, try again later` };
  }
  mine.push(now); ipHits.set(key, mine);
  globalMine.push(now); globalHits = globalMine;
  return { limited: false };
}

/**
 * Record a "we don't have this tool" signal. `need` is required free text
 * (max 500 chars); `context` is optional free text (max 300).
 * `source` is "api" | "mcp" | "find-miss" - find-miss records are implicit
 * (a /api/find or find_tool query that matched nothing useful) and are
 * exempt from the rate limit, since they're not a user directly hitting an
 * endpoint. Throws Error with .statusCode on bad input (400) or over the
 * rate limit (429); otherwise best-effort (a disk write failure never
 * throws — it just silently doesn't persist that line).
 */
export function recordWish({ need, context, source, ip } = {}) {
  const src = source === "mcp" || source === "find-miss" ? source : "api";
  if (typeof need !== "string" || !need.trim()) {
    const e = new Error("`need` is required and must be non-empty text");
    e.statusCode = 400;
    throw e;
  }
  if (context != null && typeof context !== "string") {
    const e = new Error("`context` must be a string when provided");
    e.statusCode = 400;
    throw e;
  }
  const needTrimmed = need.trim().slice(0, NEED_MAX);
  const contextTrimmed = typeof context === "string" && context.trim() ? context.trim().slice(0, CONTEXT_MAX) : undefined;

  const key = normalize(needTrimmed);
  if (!key) {
    const e = new Error("`need` has no usable content after normalization");
    e.statusCode = 400;
    throw e;
  }
  if (isNonQuery(key)) {
    // A caller's BUG is not a market signal. The board was recording
    // "[object object]", "undefined", "null" and bare integers as demand -
    // a client that stringified a JS value into the query, arriving as
    // evidence that somebody wants a tool. This board decides what gets
    // built, so junk in it is not cosmetic.
    //
    // Deliberately NARROW. Only two things are rejected: strings with no
    // letter at all, and the exact set of JS stringification artifacts.
    // Real words are never filtered even when they look like a bug in
    // context ("object", "function", "request"), because "object" from a
    // broken client and "object" from someone wanting object detection are
    // indistinguishable here, and dropping a real need is the worse error.
    const e = new Error("`need` must describe a capability, not a placeholder value");
    e.statusCode = 400;
    throw e;
  }

  const exempt = src === "find-miss";
  if (!exempt) {
    const rl = checkRateLimit(ip);
    if (rl.limited) {
      const e = new Error(rl.reason);
      e.statusCode = 429;
      throw e;
    }
  } else if (findMissLimited(ip)) {
    // Never throw here: this path runs inside /api/find and the MCP find_tool,
    // and a search must not fail because the demand board is busy. Stop
    // RECORDING instead, and say so in the return value.
    return { recorded: false, reason: "find-miss volume limit for this source" };
  }

  const now = Date.now();
  // No caller identity (no ip reached us) -> no caller is credited and no
  // dedupe applies: an anonymous signal still counts once, it just cannot
  // help a cluster qualify, and it must never collapse everyone into "?".
  const caller = typeof ip === "string" && ip && ip !== "?" ? callerHash(ip, now) : null;
  if (exempt && caller) {
    // One find-miss per caller per need per day. The same machine re-running
    // the same query is one signal, not sixty; it is still recorded once.
    const existing = clusters.get(key);
    if (existing && existing.callers instanceof Set && existing.callers.has(caller) && (existing.sources["find-miss"] || 0) > 0) {
      return { recorded: false, reason: "duplicate find-miss from this caller today" };
    }
  }
  const cluster = upsertCluster(key, src, now, caller);
  appendLine({ need: needTrimmed, context: contextTrimmed, source: src, ts: now, caller });

  if (!exempt && !cluster.__overflow && cluster.count === WISH_THRESHOLD && !cluster.issueOpened) {
    cluster.issueOpened = true;
    console.warn(`[wish-threshold] cluster "${logSafe(key)}" hit ${WISH_THRESHOLD} signals`);
    appendLine({ type: "threshold", key, ts: now });
  }

  // ACKNOWLEDGEMENT ONLY - never the cluster's count.
  //
  // This used to return { cluster: { count } }, the number of signals the
  // cluster now holds. That is exactly the field the PUBLIC read deliberately
  // withholds: getWishesAggregate({detailed:false}) is a beacon (totals and how
  // many clusters qualify, never which or how hot), and the itemized board sits
  // behind the operator token. The write path was answering the question the
  // read path refuses to answer, about the same data.
  //
  // Concretely: submit a phrase, learn how many others asked for that exact
  // phrase, and since WISH_THRESHOLD is public, learn how close it is to being
  // built. The clustering key is only lowercase + collapsed whitespace, so this
  // confirms a phrase you already guessed rather than enumerating the board -
  // narrow, but free to close and inconsistent to keep. The submitter loses
  // nothing they need: the caller asked us to record a gap, and we did.
  return { recorded: true };
}

/**
 * Aggregate view for /api/wishes: normalized text, count, per-source
 * breakdown, first/last seen, and whether the threshold-crossing log already
 * fired. Deliberately excludes raw `context` - that field is free text
 * supplied by callers and never belongs on a public surface. `text` is
 * esc()'d in case this ever gets rendered on an HTML surface later.
 */
/**
 * Wish aggregate. Two modes:
 *  - detailed:true (operator dashboard + the wish-issues bridge, both
 *    token-gated) — every cluster's normalized text, per-source counts,
 *    timestamps, and qualification verdict.
 *  - detailed:false (DEFAULT, the public /api/wishes) — a BEACON only:
 *    headline totals plus qualified-cluster COUNT, no per-cluster text or
 *    counts. The itemized demand board is strategic intel (which unmet
 *    agent needs to build against, and how hot each is) that an outsider
 *    should not be able to poll for free — while "there is real demand
 *    here, come sell" stays public to pull sellers in. The paid demand-radar
 *    tool sells the analysis layer; this keeps the raw list off the free path.
 */
export function getWishesAggregate({ limit = 200, detailed = false } = {}) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const base = {
    distinctClusters: clusters.size,
    totalWishes: [...clusters.values()].reduce((s, c) => s + c.count, 0),
    threshold: WISH_THRESHOLD,
    qualifyMinSpanHours: QUALIFY_MIN_SPAN_MS / 3_600_000,
    qualifyMinCallers: QUALIFY_MIN_CALLERS,
  };
  if (!detailed) {
    // Public beacon: aggregates only. Expose how many clusters are hot enough
    // to matter, never WHICH — no text, no per-cluster counts, no timestamps.
    return { ...base, qualifiedClusters: [...clusters.values()].filter(clusterQualifies).length };
  }
  const rows = [...clusters.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].lastSeen - a[1].lastSeen)
    .slice(0, cap)
    .map(([key, c]) => ({
      text: esc(key),
      count: c.count,
      sources: { api: c.sources.api || 0, mcp: c.sources.mcp || 0, "find-miss": c.sources["find-miss"] || 0 },
      // Distinct day-scoped caller hashes seen (never addresses). Legacy
      // lines carry no caller, so old clusters read 0 until fresh signals.
      callers: c.callers instanceof Set ? c.callers.size : 0,
      firstSeen: new Date(c.firstSeen).toISOString(),
      lastSeen: new Date(c.lastSeen).toISOString(),
      issueOpened: !!c.issueOpened,
      // The gate the wish-issues workflow selects on. count >= threshold is
      // necessary but not sufficient — see clusterQualifies / QUALIFY_MIN_SPAN_MS.
      qualified: clusterQualifies(c),
    }));
  return { ...base, clusters: rows };
}

// --- test-only hooks (mirror the __testResetSubmitted style in x402-index.js) ---
// Both reset the rate-limit buckets too — a test switching storage wants a
// fully isolated instance, not just a fresh file.
export function __testSetFilePath(path) {
  WISH_FILE = path;
  ipHits = new Map();
  findMissHits = new Map();
  overflowWarned = false;
  globalHits = [];
  rebuildFromFile();
}
export function __testReset() {
  ipHits = new Map();
  findMissHits = new Map();
  overflowWarned = false;
  globalHits = [];
  rebuildFromFile();
}
export function __testSetLineCap(n) {
  MAX_LINES = n == null ? 50_000 : n;
}
export function __testState() {
  return { lineCount, capReached, clusterCount: clusters.size, file: WISH_FILE };
}
