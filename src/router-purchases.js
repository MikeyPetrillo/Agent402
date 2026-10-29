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
// window. Kept as one state document (the file on the
// volume without a database, the row with one); a lost record only means a
// seller keeps what it would have been reduced by, so the record is written
// best effort and never blocks a buy.
import { createJsonDocument } from "./json-document.js";
import { trackStoreReady } from "./state-db.js";

export const PURCHASE_WINDOW_MS = 30 * 24 * 3600_000;
// Past this many purchases at one wallet the deduction is already larger
// than any count the floor reads; older stamps are dropped first.
const MAX_STAMPS = 5_000;
const MAX_KEYS = 20_000;

const evmKey = (a) => (typeof a === "string" && /^0x[0-9a-f]{40}$/i.test(a.trim()) ? a.trim().toLowerCase() : null);
const normOrigin = (o) => {
  try { const u = new URL(String(o || "")); return u.protocol === "https:" || u.protocol === "http:" ? `${u.protocol}//${u.host.toLowerCase()}` : null; } catch { return null; }
};

/** The store: `record` on every paid leg, `at` and `snapshot` for the binding. */
export function createRouterPurchaseStore({ file = null, now = Date.now, log = null } = {}) {
  const doc = file ? createJsonDocument({ file, log: (m) => { if (typeof log === "function") log(m); } }) : null;
  // origin -> wallet -> { buys: [time, chain][] } in time order
  const rows = new Map();
  let loaded = false;
  let ready = Promise.resolve();
  let saveTimer = null;
  let writeFailureLogged = false;

  function apply(j) {
    const entries = j && typeof j.rows === "object" && j.rows ? Object.entries(j.rows) : [];
    for (const [k, v] of entries.slice(0, MAX_KEYS)) {
      const [o, w] = String(k).split("|");
      const origin = normOrigin(o), wallet = evmKey(w);
      if (!origin || !wallet || !v || typeof v !== "object") continue;
      const buys = (Array.isArray(v.buys) ? v.buys : [])
        .map((b) => [Number(b?.[0]), typeof b?.[1] === "string" && b[1] ? b[1] : "base"])
        .filter(([t]) => Number.isFinite(t) && t > 0)
        .sort((a, b) => a[0] - b[0])
        .slice(-MAX_STAMPS);
      if (!rows.has(origin)) rows.set(origin, new Map());
      rows.get(origin).set(wallet, { buys });
    }
  }
  function load() {
    loaded = true;
    if (!doc) return ready;
    if (doc.backend === "pg") {
      ready = trackStoreReady(doc.load(null).then((j) => { if (j) apply(j); }));
      return ready;
    }
    const j = doc.loadSync(null);
    if (j) apply(j);
    return ready;
  }
  const ensure = () => { if (!loaded) load(); };
  function prune(entry, t) {
    const floor = t - PURCHASE_WINDOW_MS;
    while (entry.buys.length && entry.buys[0][0] < floor) entry.buys.shift();
    if (entry.buys.length > MAX_STAMPS) entry.buys.splice(0, entry.buys.length - MAX_STAMPS);
  }
  const figures = (entry) => ({ calls: entry.buys.length, payers: new Set(entry.buys.map(([, c]) => c)).size });
  function body() {
    const out = {};
    for (const [o, m] of rows) for (const [w, e] of m) if (e.buys.length) out[`${o}|${w}`] = { buys: e.buys };
    return { version: 1, rows: out };
  }
  function persist() {
    if (!doc || saveTimer) return;
    // Coalesced: a burst of buys is one write.
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void doc.save(body()).then((stored) => {
        if (stored) { writeFailureLogged = false; return; }
        if (!writeFailureLogged && typeof log === "function") { writeFailureLogged = true; log(`[router-purchases] could not write ${file}: ${String(doc.lastError || "").slice(0, 120)}`); }
      });
    }, 250);
    saveTimer.unref?.();
  }

  /** One purchase the router made (or may have made: a payment that left and
   *  got no answer counts too, the safe direction for the seller's figure). */
  function record({ origin, payTo, chain, at = now() } = {}) {
    ensure();
    const o = normOrigin(origin), w = evmKey(payTo);
    if (!o || !w) return false;
    if (!rows.has(o)) { if (rows.size >= MAX_KEYS) return false; rows.set(o, new Map()); }
    const m = rows.get(o);
    if (!m.has(w)) m.set(w, { buys: [] });
    const e = m.get(w);
    e.buys.push([Number(at) || now(), typeof chain === "string" && chain ? chain : "base"]);
    e.buys.sort((a, b) => a[0] - b[0]);
    prune(e, now());
    persist();
    return true;
  }
  /** { calls, payers } the router bought at `origin`'s wallet `payTo` over the window. */
  function at(origin, payTo, t = now()) {
    ensure();
    const e = rows.get(normOrigin(origin))?.get(evmKey(payTo));
    if (!e) return { calls: 0, payers: 0 };
    prune(e, t);
    return figures(e);
  }
  /** origin -> Map(wallet -> { calls, payers }), every pair with a purchase in the window. */
  function snapshot(t = now()) {
    ensure();
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
  return { load, record, at, snapshot, ready: () => ready, __reset() { rows.clear(); } };
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
export function __setRouterPurchaseStoreForTest(store) { instance = store; }
