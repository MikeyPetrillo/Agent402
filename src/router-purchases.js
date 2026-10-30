// What the router itself bought from each outside seller, per wallet it paid.
//
// A seller's settlement evidence is read from three places: the leaderboard
// fold and the chain join leave payments from our own wallets out at the
// source, but the Bazaar's per-resource counts are a third party's
// measurement and include the router's purchases like anyone else's. So the
// router keeps its own record of them, and the evidence binding
// (src/evidence-binding.js) reduces an origin's Bazaar figures at a wallet by
// what was bought there: the calls, and one payer per spending wallet that
// paid. The unproven lane pays a seller; it never qualifies one.
//
// One record per (origin, payTo wallet): each purchase's time and the chain
// it left from (one spending wallet per chain), over the Bazaar's 30-day
// window. Kept as one state document (the file on the volume without a
// database, the row with one). Two containers buy at once, so a purchase is
// appended through the document's read-modify-write (json-document update):
// each writer merges its own buys into the stored body, and neither drops the
// other's. The memory copy is replaced by the body each write returns and
// re-read at most every REFRESH_MS when the binding reads it, so one
// container's buys reach the other's evidence within a refresh. A lost record
// only means a seller keeps what it would have been reduced by, so the record
// is written best effort and never blocks a buy.
import { createJsonDocument } from "./json-document.js";
import { trackStoreReady } from "./state-db.js";

export const PURCHASE_WINDOW_MS = 30 * 24 * 3600_000;
// Past this many purchases at one wallet the deduction is already larger
// than any count the floor reads; older stamps are dropped first.
const MAX_STAMPS = 5_000;
const MAX_KEYS = 20_000;
// How old the memory copy may be before a read re-reads the document.
const REFRESH_MS = 30_000;
// A burst of buys is one write; a write that failed is retried with a backoff.
const FLUSH_DELAY_MS = 250;
const RETRY_MAX_MS = 60_000;

const evmKey = (a) => (typeof a === "string" && /^0x[0-9a-f]{40}$/i.test(a.trim()) ? a.trim().toLowerCase() : null);
const normOrigin = (o) => {
  try { const u = new URL(String(o || "")); return u.protocol === "https:" || u.protocol === "http:" ? `${u.protocol}//${u.host.toLowerCase()}` : null; } catch { return null; }
};
const stampOf = (b) => [Number(b?.[0]), typeof b?.[1] === "string" && b[1] ? b[1] : "base"];

/** The store: `record` on every paid leg, `at` and `snapshot` for the binding. */
export function createRouterPurchaseStore({ file = null, now = Date.now, log = null, refreshMs = REFRESH_MS } = {}) {
  const doc = file ? createJsonDocument({ file, log: (m) => { if (typeof log === "function") log(m); } }) : null;
  const PG = doc?.backend === "pg";
  // origin -> wallet -> { buys: [time, chain][] } in time order
  const rows = new Map();
  // Buys recorded here and not merged into the document yet.
  let pending = [];
  let loaded = false;
  let ready = Promise.resolve();
  let saveTimer = null;
  let flushing = null;
  let retryMs = 0;
  let writeFailureLogged = false;
  let refreshedAt = 0, refreshing = null;

  function addRow(origin, wallet, at, chain) {
    if (!rows.has(origin)) { if (rows.size >= MAX_KEYS) return false; rows.set(origin, new Map()); }
    const m = rows.get(origin);
    if (!m.has(wallet)) m.set(wallet, { buys: [] });
    const e = m.get(wallet);
    e.buys.push([at, chain]);
    e.buys.sort((a, b) => a[0] - b[0]);
    prune(e, now());
    return true;
  }
  function apply(j) {
    const entries = j && typeof j.rows === "object" && j.rows ? Object.entries(j.rows) : [];
    for (const [k, v] of entries.slice(0, MAX_KEYS)) {
      const [o, w] = String(k).split("|");
      const origin = normOrigin(o), wallet = evmKey(w);
      if (!origin || !wallet || !v || typeof v !== "object") continue;
      const buys = (Array.isArray(v.buys) ? v.buys : [])
        .map(stampOf)
        .filter(([t]) => Number.isFinite(t) && t > 0)
        .sort((a, b) => a[0] - b[0])
        .slice(-MAX_STAMPS);
      if (!rows.has(origin)) rows.set(origin, new Map());
      rows.get(origin).set(wallet, { buys });
    }
  }
  // The memory copy is the stored body plus what this container has not
  // written yet.
  function replaceFrom(j) {
    rows.clear();
    if (j) apply(j);
    for (const p of pending) addRow(p.origin, p.wallet, p.at, p.chain);
    refreshedAt = now();
  }
  function load() {
    loaded = true;
    if (!doc) return ready;
    if (PG) {
      ready = trackStoreReady(doc.load(null).then((j) => { if (j !== null || !doc.lastError) replaceFrom(j); }), "router-purchases");
      return ready;
    }
    replaceFrom(doc.loadSync(null));
    return ready;
  }
  const ensure = () => { if (!loaded) load(); };
  // Another container's buys reach this one's memory on the next read past
  // REFRESH_MS. Not while a write of ours is in flight: its batch is in
  // neither the row nor `pending` until it lands.
  function kick() {
    if (!doc || flushing || refreshing || now() - refreshedAt < refreshMs) return;
    if (!PG) { replaceFrom(doc.loadSync(null)); return; }
    refreshing = doc.read().then((r) => { if (r.ok) replaceFrom(r.exists ? r.body : null); })
      .catch(() => {}).finally(() => { refreshing = null; });
  }
  function prune(entry, t) {
    const floor = t - PURCHASE_WINDOW_MS;
    while (entry.buys.length && entry.buys[0][0] < floor) entry.buys.shift();
    if (entry.buys.length > MAX_STAMPS) entry.buys.splice(0, entry.buys.length - MAX_STAMPS);
  }
  const figures = (entry) => ({ calls: entry.buys.length, payers: new Set(entry.buys.map(([, c]) => c)).size });
  // Merge a batch of buys into a stored body: other keys are kept as they
  // are (less what aged out of the window), touched keys gain the batch.
  function mergeInto(body, batch, t) {
    const b = body && typeof body === "object" && body.rows && typeof body.rows === "object" ? { ...body, version: 1, rows: { ...body.rows } } : { version: 1, rows: {} };
    const floor = t - PURCHASE_WINDOW_MS;
    const inWindow = (x) => Number.isFinite(Number(x?.[0])) && Number(x[0]) >= floor;
    for (const p of batch) {
      const key = `${p.origin}|${p.wallet}`;
      const cur = b.rows[key];
      if (!cur && Object.keys(b.rows).length >= MAX_KEYS) continue;
      const list = (cur && Array.isArray(cur.buys) ? cur.buys : []).filter(inWindow).map(stampOf);
      list.push([p.at, p.chain]);
      list.sort((x, y) => x[0] - y[0]);
      b.rows[key] = { buys: list.slice(-MAX_STAMPS) };
    }
    for (const [k, v] of Object.entries(b.rows)) if (!Array.isArray(v?.buys) || !v.buys.some(inWindow)) delete b.rows[k];
    return b;
  }
  function persist(delayMs = FLUSH_DELAY_MS) {
    if (!doc || saveTimer || flushing) return;
    saveTimer = setTimeout(() => { saveTimer = null; void flush(); }, delayMs);
    saveTimer.unref?.();
  }
  /** Write every buy recorded so far. Resolves true once they are stored. */
  function flush() {
    if (!doc) return Promise.resolve(true);
    if (flushing) return flushing;
    if (!pending.length) return Promise.resolve(true);
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    flushing = (async () => {
      const batch = pending; pending = [];
      const r = await doc.update((b) => mergeInto(b, batch, now()), { fallback: null });
      if (!r.ok) {
        // Kept for the next write; a persistent failure is retried with a backoff.
        pending = batch.concat(pending);
        if (!writeFailureLogged && typeof log === "function") { writeFailureLogged = true; log(`[router-purchases] could not write ${file}: ${String(r.error || doc.lastError || "").slice(0, 120)}`); }
        retryMs = retryMs ? Math.min(RETRY_MAX_MS, retryMs * 2) : 1000;
        return false;
      }
      writeFailureLogged = false; retryMs = 0;
      if (r.body && typeof r.body === "object") replaceFrom(r.body);
      return true;
    })().finally(() => { flushing = null; if (pending.length) persist(retryMs || FLUSH_DELAY_MS); });
    return flushing;
  }

  /** One purchase the router made (or may have made: a payment that left and
   *  got no answer counts too, the safe direction for the seller's figure). */
  function record({ origin, payTo, chain, at = now() } = {}) {
    ensure();
    const o = normOrigin(origin), w = evmKey(payTo);
    if (!o || !w) return false;
    const stamp = Number(at) || now(), c = typeof chain === "string" && chain ? chain : "base";
    if (!addRow(o, w, stamp, c)) return false;
    pending.push({ origin: o, wallet: w, at: stamp, chain: c });
    persist();
    return true;
  }
  /** { calls, payers } the router bought at `origin`'s wallet `payTo` over the window. */
  function at(origin, payTo, t = now()) {
    ensure(); kick();
    const e = rows.get(normOrigin(origin))?.get(evmKey(payTo));
    if (!e) return { calls: 0, payers: 0 };
    prune(e, t);
    return figures(e);
  }
  /** origin -> Map(wallet -> { calls, payers }), every pair with a purchase in the window. */
  function snapshot(t = now()) {
    ensure(); kick();
    const out = new Map();
    for (const [o, m] of rows) {
      for (const [w, e] of m) {
        prune(e, t);
        if (!e.buys.length) continue;
        if (!out.has(o)) out.set(o, new Map());
        out.get(o).set(w, figures(e));
      }
    }
    return out;
  }
  return { load, record, at, snapshot, flush, ready: () => ready, __reset() { rows.clear(); pending = []; } };
}

let instance = null;
/** The server's store (SOR_ROUTER_PURCHASES_FILE, or the volume's default). */
export function routerPurchaseStore() {
  if (!instance) instance = createRouterPurchaseStore({ file: process.env.SOR_ROUTER_PURCHASES_FILE || "/data/sor-router-purchases.json", log: (m) => console.warn(m) });
  return instance;
}
export function recordRouterPurchase(args) {
  try { return routerPurchaseStore().record(args); } catch { return false; }
}
export function routerPurchasesSnapshot() {
  try { return routerPurchaseStore().snapshot(); } catch { return new Map(); }
}
