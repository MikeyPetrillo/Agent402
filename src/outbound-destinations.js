// New-destination watch over the outbound payment ledger.
//
// Every payment one of our spending wallets signs is recorded by
// src/outbound-ledger.js with its chain and its recipient. This keeps the
// FIRST time each (chain, recipient) pair was paid, and answers one word on
// /api/gateway-status:
//
//   ok     no first-time recipient inside the window
//   new    at least one first-time recipient inside the window: expected, the
//          router buys from a seller it has just proven, a buyer probes a
//          seller's payability, the unproven lane tries a new one
//   burst  more than OUTBOUND_NEW_DEST_BURST distinct first-time recipients
//          inside the window: more new wallets than a normal day reaches, so
//          a human reads the operator listing
//   unknown the stored body has not been read (database mode, load failed)
//
// The word is the whole public answer; recipients, chains per recipient,
// counts and times are on the operator listing only. The write happens off
// the payment path: the ledger hands the pair over after the paid response
// is in, and nothing in a buy awaits it.
//
// One JSON document (src/json-document.js): the file on the volume without a
// state database, the row with one. A first sighting is a read-modify-write
// of the one key it adds, so two containers paying the same new recipient at
// once record it once, and a container's memory is only a fast path: a pair
// already in memory costs no write, a pair not in memory is checked against
// the stored body before it is called new.
//
// Keys: an EVM address is one wallet in any letter case, so it is kept
// lowercased; every other address (Solana, Algorand, Stellar) is kept exactly
// as the seller quoted it, never case-folded.
import { dirname, join } from "node:path";
import { createJsonDocument, SKIP_UPDATE } from "./json-document.js";
import { trackStoreReady } from "./state-db.js";

export const DEFAULT_WINDOW_HOURS = 24;
export const DEFAULT_BURST_OVER = 10;
const MAX_ENTRIES = 50_000;
const REFRESH_MS = 30_000;

const envNum = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };

/** The key one recipient is remembered under. EVM lowercased; anything else exact. */
export function destinationKey(chain, payTo) {
  const c = String(chain || "").trim().toLowerCase();
  const p = String(payTo || "").trim();
  if (!c || !p || p.length > 128) return null;
  const addr = /^0x[0-9a-f]{40}$/i.test(p) ? p.toLowerCase() : p;
  return `${c}:${addr}`;
}

/** The word for `n` first-time recipients inside the window. */
export function destinationWord(newInWindow, burstOver = DEFAULT_BURST_OVER) {
  if (!Number.isFinite(newInWindow) || newInWindow < 0) return "unknown";
  if (newInWindow > burstOver) return "burst";
  return newInWindow > 0 ? "new" : "ok";
}

/** Host only - an origin can carry a path and a path can carry a key. */
function hostOf(u) {
  if (!u) return null;
  try { return new URL(String(u)).host; } catch { return typeof u === "string" && /^[a-z0-9.-]+(:\d+)?$/i.test(u) ? u : null; }
}

/**
 * The store. `note()` records a pair the first time it is seen and resolves
 * whether it was new; `status()` is the gateway-status word; `list()` is the
 * operator listing. `now` is injectable so a test can move the window.
 */
export function createOutboundDestinationStore({ file = null, now = Date.now, windowHours = envNum("OUTBOUND_NEW_DEST_WINDOW_H", DEFAULT_WINDOW_HOURS), burstOver = envNum("OUTBOUND_NEW_DEST_BURST", DEFAULT_BURST_OVER), log = null } = {}) {
  const seen = new Map(); // key -> { firstAt, chain, origin, slug }
  const doc = file ? createJsonDocument({ file, log: (m) => say(m) }) : null;
  const PG = doc?.backend === "pg";
  let loaded = false;
  let bodyRead = !PG; // without a database the file is the body, read on demand
  let ready = Promise.resolve();
  let refreshedAt = 0, refreshing = null;
  // One log line per ten minutes: a store that cannot write must not turn
  // every payment into a warning.
  let warnedAt = 0;
  const say = (m) => {
    if (typeof log !== "function") return;
    const t = now();
    if (t - warnedAt < 600_000) return;
    warnedAt = t;
    try { log(`[outbound-destinations] ${m}`); } catch { /* logging never throws */ }
  };
  const windowMs = () => windowHours * 3600_000;

  function apply(j) {
    seen.clear();
    const entries = j && typeof j === "object" && j.seen && typeof j.seen === "object" ? Object.entries(j.seen) : [];
    for (const [k, v] of entries) {
      if (typeof k !== "string" || !v || typeof v !== "object" || typeof v.firstAt !== "string") continue;
      seen.set(k, { firstAt: v.firstAt, chain: typeof v.chain === "string" ? v.chain : k.split(":")[0], origin: typeof v.origin === "string" ? v.origin : null, slug: typeof v.slug === "string" ? v.slug : null });
    }
  }
  /** Read the stored body. Synchronous on a file; the database path resolves a promise. */
  function load() {
    loaded = true;
    if (!doc) return ready;
    if (PG) {
      ready = trackStoreReady(doc.load(null).then((j) => { if (j !== null || !doc.lastError) { apply(j); bodyRead = true; refreshedAt = now(); } }), "outbound-destinations");
      return ready;
    }
    apply(doc.loadSync(null));
    return ready;
  }
  const ensure = () => { if (!loaded) load(); };
  // Database mode: another container's sightings reach this one's memory on
  // the next read, at most every 30 s, so both containers answer the same word.
  function refresh() {
    if (!PG || refreshing) return refreshing || Promise.resolve();
    if (now() - refreshedAt < REFRESH_MS) return Promise.resolve();
    refreshing = doc.read().then((r) => { if (r.ok) { apply(r.exists ? r.body : null); bodyRead = true; refreshedAt = now(); } })
      .catch(() => {}).finally(() => { refreshing = null; });
    return refreshing;
  }

  /**
   * Record a paid recipient. Resolves { new: boolean, key } (key null when the
   * pair is unusable). Never rejects: the caller is a payment path's
   * bookkeeping and must never see an error from here.
   */
  async function note({ chain, payTo, origin = null, slug = null } = {}) {
    const key = destinationKey(chain, payTo);
    if (!key) return { new: false, key: null };
    ensure();
    if (PG && !bodyRead) { try { await ready; } catch { /* unloaded: the update below reads the row itself */ } }
    if (seen.has(key)) return { new: false, key };
    const entry = { firstAt: new Date(now()).toISOString(), chain: String(chain).toLowerCase(), origin: hostOf(origin), slug: typeof slug === "string" ? slug.slice(0, 80) : null };
    if (!doc) {
      seen.set(key, entry);
      return { new: true, key };
    }
    let verdict = false;
    try {
      const r = await doc.update((b) => {
        const body = b && typeof b === "object" && b.seen && typeof b.seen === "object" ? { ...b, version: 1, seen: { ...b.seen } } : { version: 1, seen: {} };
        if (body.seen[key]) return SKIP_UPDATE;
        body.seen[key] = entry;
        // The oldest first sightings age out past the cap; a sighting inside
        // the window is never the one dropped.
        const keys = Object.keys(body.seen);
        if (keys.length > MAX_ENTRIES) {
          keys.sort((a, c) => String(body.seen[a].firstAt).localeCompare(String(body.seen[c].firstAt)));
          for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete body.seen[k];
        }
        verdict = true;
        return body;
      }, { fallback: null });
      if (!r.ok) { say(`could not record a destination (${String(r.error || doc.lastError || "").slice(0, 120)}); the payment itself is unaffected`); return { new: false, key }; }
      if (r.body && typeof r.body === "object") { apply(r.body); bodyRead = true; refreshedAt = now(); }
      return { new: r.changed ? verdict : false, key };
    } catch (e) {
      say(`could not record a destination (${String(e?.message || e).slice(0, 120)}); the payment itself is unaffected`);
      return { new: false, key };
    }
  }

  function recentEntries() {
    const since = now() - windowMs();
    const out = [];
    for (const [key, v] of seen) {
      const t = Date.parse(v.firstAt);
      if (Number.isFinite(t) && t >= since) out.push({ key, ...v, firstAtMs: t });
    }
    out.sort((a, b) => b.firstAtMs - a.firstAtMs);
    return out;
  }
  /** The count of first-time recipients inside the window, or null when the body was never read. */
  function newInWindow() {
    ensure();
    if (!bodyRead) return null;
    return recentEntries().length;
  }
  /** The word (sync, from memory). */
  function word() {
    const n = newInWindow();
    return n == null ? "unknown" : destinationWord(n, burstOver);
  }
  /**
   * The gateway-status field. Public: the word only. Operator: the window,
   * the threshold and the counts; still no address (the listing has those).
   */
  async function status({ full = false } = {}) {
    ensure();
    try { await refresh(); } catch { /* memory answers */ }
    const n = newInWindow();
    const w = n == null ? "unknown" : destinationWord(n, burstOver);
    if (!full) return { status: w };
    return { status: w, windowHours, burstOver, newInWindow: n, known: bodyRead ? seen.size : null, backend: doc ? doc.backend : "memory" };
  }
  /** The operator listing: every first sighting inside the window, newest first, then the rest up to `limit`. */
  async function list({ limit = 100 } = {}) {
    ensure();
    try { await refresh(); } catch { /* memory answers */ }
    const n = newInWindow();
    const recentRows = recentEntries();
    const recentKeys = new Set(recentRows.map((r) => r.key));
    const recent = recentRows.map(({ key, chain, origin, slug, firstAt }) => ({ chain, payTo: key.slice(chain.length + 1), firstAt, origin, slug }));
    const older = [...seen.entries()]
      .filter(([k]) => !recentKeys.has(k))
      .map(([k, v]) => ({ chain: v.chain, payTo: k.slice(v.chain.length + 1), firstAt: v.firstAt, origin: v.origin, slug: v.slug }))
      .sort((a, b) => String(b.firstAt).localeCompare(String(a.firstAt)));
    const cap = Math.max(1, Math.min(5000, Number(limit) || 100));
    return {
      status: n == null ? "unknown" : destinationWord(n, burstOver),
      windowHours, burstOver, newInWindow: n, known: bodyRead ? seen.size : null,
      recent: recent.slice(0, cap),
      earlier: older.slice(0, Math.max(0, cap - Math.min(recent.length, cap))),
      truncated: recent.length + older.length > cap,
    };
  }
  return { note, status, list, word, load, newInWindow, get size() { return seen.size; }, get backend() { return doc ? doc.backend : "memory"; } };
}

// The server's one store, built from the environment on first use. The file
// sits beside the outbound ledger (the same volume, or its test directory).
let instance = null;
export function outboundDestinationStore() {
  if (!instance) {
    const ledgerFile = (process.env.OUTBOUND_LEDGER_FILE || "/data/outbound-spend.ndjson").trim();
    const file = (process.env.OUTBOUND_DESTINATIONS_FILE || join(dirname(ledgerFile), "outbound-destinations.json")).trim();
    instance = createOutboundDestinationStore({ file, log: (m) => console.warn(m) });
  }
  return instance;
}

/**
 * The ledger's hook: called for every signed payment, never awaited by it.
 * Runs on the next turn of the event loop so a buy's response is already on
 * its way before the store is touched.
 */
export function noteOutboundDestination(rec) {
  setImmediate(() => { outboundDestinationStore().note(rec).catch(() => {}); });
}
