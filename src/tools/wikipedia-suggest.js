// search-suggest's source: English Wikipedia's opensearch API (article titles
// that complete a partial input). Keyless and shared, so it is read the way
// the Wikimedia API etiquette and User-Agent policy ask
// (mediawiki.org/wiki/API:Etiquette, foundation.wikimedia.org's User-Agent
// policy and API usage guidelines, mediawiki.org/wiki/Wikimedia_APIs/Rate_limits):
//   - a User-Agent that names the client, says it is a bot and gives contact
//     details (an identified bot may make 200 requests a minute);
//   - requests made one after another, never in parallel;
//   - a per-minute ceiling under that limit for this process, so a burst
//     waits briefly or is answered busy (503, before any payment is taken),
//     and never reaches the source as a spike;
//   - a bound on the wait for the reads ahead (SUGGEST_MAX_QUEUE_WAIT_MS): a
//     caller whose turn would come later, by the recent read time, or has
//     not come by then, is answered busy (503 with a retry time) before the
//     settle point, and the reads still run one at a time;
//   - the source is named on every answer (the tool's credit, the license
//     link and a statement that we are not affiliated with the Foundation);
//   - an answer is kept per normalized prefix (SUGGEST_CACHE_TTL_MS, at most
//     SUGGEST_CACHE_MAX prefixes), so a repeated prefix never reaches the
//     source again while it is kept: the API is read at the rate of distinct
//     prefixes, never per paid call.
// The usage guidelines bar sublicensing or leasing access to a Foundation
// API, so the tool is never sold through a third party (marked barred in
// src/tools/search.js; scripts/test-resale-clearance.js).
import { upstreamFetch, bodyUnderDeadline } from "../upstream-deadline.js";
import { settleBeforeUpstream } from "../settle-first.js";
import { CAP_NAMES } from "../upstream-cap-refusals.js";
import { SUGGEST_UA } from "../user-agents.js";
import { noteHostRequest } from "../seller-load.js"; // the request log /crawler describes

export const WIKIPEDIA_OPENSEARCH_URL = "https://en.wikipedia.org/w/api.php";
/** The listed string (src/user-agents.js; /crawler renders it). */
export const SUGGEST_USER_AGENT = SUGGEST_UA;
/** Reads per rolling minute this process sends, under the source's 200. */
export const SUGGEST_MAX_PER_MINUTE = 150;
/** Callers that may wait for their turn at once; one more is answered busy. */
export const SUGGEST_MAX_WAITING = 20;
/** The longest a caller waits for room in the minute before it is answered busy. */
export const SUGGEST_MAX_WAIT_MS = 2000;
/** The longest a caller waits for the reads ahead of it before it is answered busy. */
export const SUGGEST_MAX_QUEUE_WAIT_MS = 3000;
let maxQueueWaitMs = SUGGEST_MAX_QUEUE_WAIT_MS;
const TIMEOUT_MS = 8000;
/** How long a prefix's suggestions are kept, and how many prefixes at most. */
export const SUGGEST_CACHE_TTL_MS = 24 * 3600_000;
export const SUGGEST_CACHE_MAX = 10_000;
/** The most titles one read asks for (the tool's own count cap). */
const READ_LIMIT = 20;
const cache = new Map(); // normalized prefix -> { at, titles }
let cacheHits = 0, cacheMisses = 0;
/** The cache key for `q`: Unicode-normalized, trimmed, single-spaced, lower case. */
export function suggestPrefixKey(q) {
  return String(q ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (now() - e.at > SUGGEST_CACHE_TTL_MS) { cache.delete(key); return null; }
  cache.delete(key); cache.set(key, e); // most recently used last
  return e.titles;
}
function cachePut(key, titles) {
  cache.set(key, { at: now(), titles });
  while (cache.size > SUGGEST_CACHE_MAX) cache.delete(cache.keys().next().value);
}
/** Counts of the prefix cache (tests and the operator view). */
export function suggestCacheStats() { return { size: cache.size, hits: cacheHits, misses: cacheMisses }; }
/** Test hook: an empty cache. */
export function _clearSuggestCacheForTest() { cache.clear(); cacheHits = 0; cacheMisses = 0; }
const WINDOW_MS = 60_000;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
const busy = (retryAfter = 1, { ours = true } = {}) => Object.assign(bad("Search suggestions are busy - retry shortly", 503), { retryAfter: Math.max(1, Math.ceil(retryAfter)), ...(ours ? { capRefusal: CAP_NAMES.suggestRate } : {}) });

// One read at a time: each caller's turn starts when the previous read ends.
let tail = Promise.resolve();
let waiting = 0;
const sent = []; // send times inside the rolling minute
let now = () => Date.now();
let sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The recent read time (a moving average, wall clock), to predict a turn.
let readMs = 0;

/** Test hook: the queue wait bound (default SUGGEST_MAX_QUEUE_WAIT_MS). */
export function _setSuggestQueueWaitForTest(ms) {
  maxQueueWaitMs = Number(ms) > 0 ? Number(ms) : SUGGEST_MAX_QUEUE_WAIT_MS;
  readMs = 0;
}

/** Test hook: a clock and a sleep of the caller's, and an empty window. */
export function _setSuggestClockForTest(clock, sleeper) {
  now = clock || (() => Date.now());
  sleep = sleeper || ((ms) => new Promise((r) => setTimeout(r, ms)));
  sent.length = 0; waiting = 0; tail = Promise.resolve();
  cache.clear();
}

function roomAfterMs() {
  const t = now();
  while (sent.length && t - sent[0] >= WINDOW_MS) sent.shift();
  return sent.length < SUGGEST_MAX_PER_MINUTE ? 0 : sent[0] + WINDOW_MS - t;
}

/** Run `read` in this process's turn order, under the per-minute ceiling
 *  and the bound on the wait for the reads ahead. */
async function inTurn(read) {
  if (waiting >= SUGGEST_MAX_WAITING) throw busy();
  // The reads ahead would take longer than the bound: busy at once.
  if (readMs > 0 && waiting * readMs > maxQueueWaitMs) throw busy((waiting * readMs) / 1000);
  waiting++;
  let release;
  const prev = tail;
  tail = new Promise((r) => { release = r; });
  let timer = null;
  const late = Symbol("late");
  const turn = await Promise.race([
    prev.then(() => true),
    new Promise((r) => { timer = setTimeout(() => r(late), maxQueueWaitMs); timer.unref?.(); }),
  ]);
  clearTimeout(timer);
  if (turn === late) {
    // Out of line, but the next caller's turn still starts only when the
    // read ahead of this one ends, so reads never overlap.
    prev.then(() => { waiting--; release(); });
    throw busy((waiting * Math.max(readMs, 100)) / 1000);
  }
  try {
    const wait = roomAfterMs();
    if (wait > SUGGEST_MAX_WAIT_MS) throw busy(wait / 1000);
    if (wait > 0) await sleep(wait);
    sent.push(now());
    const t0 = Date.now();
    try { return await read(); }
    finally { const took = Date.now() - t0; readMs = readMs ? readMs * 0.7 + took * 0.3 : took; }
  } finally {
    waiting--;
    release();
  }
}

/** Up to `count` Wikipedia article titles completing `q`, in the source's
 *  order: from the prefix cache when it holds `q`, else one read of up to
 *  READ_LIMIT titles, kept for the next caller. */
export async function wikipediaSuggestions(q, count) {
  const key = suggestPrefixKey(q);
  const kept = cacheGet(key);
  if (kept) { cacheHits++; return kept.slice(0, count); }
  cacheMisses++;
  const titles = await readSuggestions(q);
  cachePut(key, titles);
  return titles.slice(0, count);
}

async function readSuggestions(q) {
  const count = READ_LIMIT;
  return inTurn(async () => {
    // The settle point (src/settle-first.js), after our own checks and the
    // turn, before the read.
    await settleBeforeUpstream();
    const url = new URL(WIKIPEDIA_OPENSEARCH_URL);
    url.search = new URLSearchParams({ action: "opensearch", format: "json", formatversion: "2", namespace: "0", limit: String(count), search: q }).toString();
    const ctx = { label: "Search suggestions", step: "opensearch", timeoutMs: TIMEOUT_MS, tag: "[search-suggest]" };
    noteHostRequest(url.href, "suggest");
    const res = await upstreamFetch(url, { headers: { "User-Agent": SUGGEST_USER_AGENT, "Api-User-Agent": SUGGEST_USER_AGENT, Accept: "application/json" } }, ctx);
    if (res.status === 429) throw busy(1, { ours: false });
    if (!res.ok) throw bad(`Search suggestions upstream error (HTTP ${res.status})`, 502);
    let data;
    try { data = await bodyUnderDeadline(res.json(), ctx); }
    catch (err) { if (err?.statusCode) throw err; throw bad("Search suggestions upstream returned non-JSON", 502); }
    const titles = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
    return titles.filter((s) => typeof s === "string").slice(0, count);
  });
}
