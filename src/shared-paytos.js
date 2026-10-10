// Operator-listed SHARED payTo wallets (2026-09-28).
//
// Some Base payTo addresses are not one seller's wallet: a split or router
// contract that forwards each payment by merchant id, a marketplace's
// settlement wallet. Every seller behind one of them is honestly "paid at" it,
// so the router's per-wallet binding (src/evidence-binding.js) cannot tell
// them apart: whichever seller names the wallet would be credited with the
// whole wallet's settlement history, including payments that were forwarded
// to somebody else.
//
// Working out automatically who owns such a wallet was tried and dropped:
// every rule (registrable-domain tenants, dominance in the Bazaar feed,
// first-seen incumbency, crowding) handed either a newcomer or an early
// squatter a lever over sellers it does not control. So the operator LISTS
// these wallets instead. A listed wallet credits NOBODY with its leaderboard
// or chain-join history; an origin paid at it keeps only the per-resource
// Bazaar evidence measured on its own URLs.
//
// Two sources, unioned:
//   - SOR_MULTI_TENANT_PAYTOS: comma-separated 0x addresses, read at boot (the
//     floor a redeploy restores); a malformed entry is dropped WHOLE and
//     logged, never applied in part;
//   - the runtime lever: POST /__operator/shared-paytos {action, wallet, note},
//     persisted to a file on the /data volume (tmp + rename), applied from the
//     next evidence read, no redeploy. An env-listed wallet cannot be removed
//     at runtime: the environment is the operator's standing decision.
import { createJsonDocument, SKIP_UPDATE } from "./json-document.js";
import { trackStoreReady } from "./state-db.js";

const evmKey = (a) => (typeof a === "string" && /^0x[0-9a-f]{40}$/i.test(a.trim()) ? a.trim().toLowerCase() : null);
const MAX_ENTRIES = 10_000;
const NOTE_MAX = 200;

/** Parse SOR_MULTI_TENANT_PAYTOS (or another comma-separated wallet list named
 *  by `envName`). Returns { wallets: Set, rejected: string[] }. */
export function parseSharedPayTosEnv(value, { log = null, label = "shared-paytos", envName = "SOR_MULTI_TENANT_PAYTOS" } = {}) {
  const wallets = new Set();
  const rejected = [];
  for (const part of String(value || "").split(",")) {
    const t = part.trim();
    if (!t) continue;
    const w = evmKey(t);
    if (w) wallets.add(w);
    else rejected.push(JSON.stringify(t.slice(0, 80)));
  }
  if (rejected.length && typeof log === "function") log(`[${label}] ignored ${rejected.length} malformed ${envName} entr${rejected.length === 1 ? "y" : "ies"} (not a 0x address): ${rejected.join(", ")}`);
  return { wallets, rejected };
}

/**
 * The store. `has(wallet)` is the one question the evidence builder asks.
 * `version` changes on every accepted change, so a memoized reader can tell.
 * The same operator-listed wallet store also holds the wallets whose
 * self-funded verdict the operator has cleared (src/leaderboard.js
 * configureSellerFunding): `label` and `envName` name it in its messages.
 */
export function createSharedPayToStore({ file = null, envWallets = new Set(), now = Date.now, log = null, label = "shared-paytos", envName = "SOR_MULTI_TENANT_PAYTOS" } = {}) {
  const env = new Set([...(envWallets || [])].map(evmKey).filter(Boolean));
  const runtime = new Map(); // wallet -> { addedAt, note }
  let version = 0;
  let loaded = false;
  let ready = Promise.resolve();
  const say = (m) => { if (typeof log === "function") log(m); };
  // The listing is one JSON document: the file on the volume, or the state
  // database when one is configured (the file is imported once).
  const doc = file ? createJsonDocument({ file, log: say }) : null;
  const MISSING = Object.freeze({}); // "no stored listing" as distinct from an empty one

  function apply(j) {
    const entries = j && typeof j.wallets === "object" && j.wallets ? Object.entries(j.wallets) : [];
    for (const [w0, v] of entries.slice(0, MAX_ENTRIES)) {
      const w = evmKey(w0);
      if (!w) continue;
      runtime.set(w, { addedAt: typeof v?.addedAt === "string" ? v.addedAt : null, note: typeof v?.note === "string" ? v.note.slice(0, NOTE_MAX) : "" });
    }
    version++;
  }
  const unreadable = () => {
    // An unreadable store must not silently un-list wallets the operator
    // listed: say so loudly. The env floor still applies.
    say(`[${label}] could not parse ${file}: ${String(doc?.lastError || "").slice(0, 120)}; runtime listings are not applied until it is fixed`);
  };
  /** Read the listing. Synchronous on a file; returns a promise the database path resolves. */
  function load() {
    loaded = true;
    if (!doc) return ready;
    if (doc.backend === "pg") {
      ready = trackStoreReady(doc.load(MISSING).then((j) => { if (j === MISSING) { if (doc.lastError) unreadable(); } else apply(j); }));
      return ready;
    }
    const j = doc.loadSync(MISSING);
    if (j === MISSING) { if (doc.lastError) unreadable(); return ready; } // no file yet: nothing listed at runtime
    apply(j);
    return ready;
  }
  const ensure = () => { if (!loaded) load(); };

  // Database mode: two containers can change the listing at once, so a
  // change is a versioned read-modify-write of the one wallet it touches,
  // and the listing in memory is replaced by the row it produced. The sync
  // readers re-read the row in the background at most every 30 s.
  const PG = doc?.backend === "pg";
  let refreshedAt = 0, refreshing = null;
  function replaceFrom(j) { runtime.clear(); apply(j); }
  function kick() {
    if (!PG || refreshing || Date.now() - refreshedAt < 30_000) return;
    refreshing = doc.read().then((r) => { if (r.ok) { if (r.exists) replaceFrom(r.body); else { runtime.clear(); version++; } refreshedAt = Date.now(); } })
      .catch(() => {}).finally(() => { refreshing = null; });
  }
  async function change(w, mutate) {
    let verdict = null;
    const r = await doc.update((b) => {
      const body = b && typeof b === "object" && b.wallets && typeof b.wallets === "object" ? { ...b, version: 1, wallets: { ...b.wallets } } : { version: 1, wallets: {} };
      verdict = mutate(body.wallets);
      return verdict === "changed" ? body : SKIP_UPDATE;
    }, { fallback: null });
    if (!r.ok) return { ok: false };
    if (r.body && typeof r.body === "object") replaceFrom(r.body);
    refreshedAt = Date.now();
    return { ok: true, verdict };
  }

  async function persist() {
    if (!doc) return true;
    const stored = await doc.save({ version: 1, wallets: Object.fromEntries(runtime) });
    if (!stored) say(`[${label}] could not write ${file}: ${String(doc.lastError || "").slice(0, 120)}`);
    return stored;
  }

  const bad = (msg, statusCode = 400) => Object.assign(new Error(msg), { statusCode });

  return {
    load,
    has(wallet) { ensure(); kick(); const w = evmKey(wallet); return !!w && (env.has(w) || runtime.has(w)); },
    /** Every listed wallet, env first. */
    list() {
      ensure(); kick();
      const out = [...env].sort().map((wallet) => ({ wallet, source: "env", addedAt: null, note: "" }));
      for (const [wallet, v] of [...runtime].sort(([a], [b]) => a.localeCompare(b))) if (!env.has(wallet)) out.push({ wallet, source: "operator", addedAt: v.addedAt, note: v.note });
      return out;
    },
    async add(wallet, { note = "" } = {}) {
      ensure(); await ready;
      const w = evmKey(wallet);
      if (!w) throw bad("wallet must be a 0x address (40 hex characters)");
      if (env.has(w)) return { wallet: w, listed: true, source: "env", changed: false };
      if (PG) {
        const entry = { addedAt: new Date(now()).toISOString(), note: String(note || "").slice(0, NOTE_MAX) };
        const r = await change(w, (wallets) => {
          if (Object.hasOwn(wallets, w)) return "present";
          if (Object.keys(wallets).length >= MAX_ENTRIES) return "full";
          wallets[w] = entry; return "changed";
        });
        if (!r.ok) throw bad("the listing could not be stored, so it was not applied", 503);
        if (r.verdict === "full") throw bad(`at most ${MAX_ENTRIES} wallets can be listed at runtime`, 409);
        return { wallet: w, listed: true, source: "operator", changed: r.verdict === "changed" };
      }
      if (runtime.has(w)) return { wallet: w, listed: true, source: "operator", changed: false };
      if (runtime.size >= MAX_ENTRIES) throw bad(`at most ${MAX_ENTRIES} wallets can be listed at runtime`, 409);
      runtime.set(w, { addedAt: new Date(now()).toISOString(), note: String(note || "").slice(0, NOTE_MAX) });
      version++;
      if (!(await persist())) { runtime.delete(w); version++; throw bad("the listing could not be stored, so it was not applied", 503); }
      return { wallet: w, listed: true, source: "operator", changed: true };
    },
    async remove(wallet) {
      ensure(); await ready;
      const w = evmKey(wallet);
      if (!w) throw bad("wallet must be a 0x address (40 hex characters)");
      if (env.has(w)) throw bad(`this wallet is listed by ${envName}; remove it there (a redeploy), not at runtime`, 409);
      if (PG) {
        const r = await change(w, (wallets) => { if (!Object.hasOwn(wallets, w)) return "absent"; delete wallets[w]; return "changed"; });
        if (!r.ok) throw bad("the change could not be stored, so it was not applied", 503);
        return { wallet: w, listed: false, changed: r.verdict === "changed" };
      }
      if (!runtime.has(w)) return { wallet: w, listed: false, changed: false };
      const prev = runtime.get(w);
      runtime.delete(w);
      version++;
      if (!(await persist())) { runtime.set(w, prev); version++; throw bad("the change could not be stored, so it was not applied", 503); }
      return { wallet: w, listed: false, changed: true };
    },
    get version() { ensure(); return version; },
    ready() { ensure(); return ready; },
    counts() { ensure(); return { env: env.size, operator: [...runtime.keys()].filter((w) => !env.has(w)).length }; },
  };
}
