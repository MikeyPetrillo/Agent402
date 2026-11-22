// A store of per-key scan states kept across restarts: the shape the Solana
// and EVM activity scans share (src/solana-activity-store.js,
// src/evm-activity-store.js).
//
// WHERE. With a state database: one row per key in the `records` table
// (the store's collection, id the key), read one key at a time on that key's
// first view in a process, never as a whole at boot. Without one: a single
// JSON document in the store's file (`/data/<name>.json` by default, the
// temp directory without a volume).
//
// BOUNDS. At most `maxWallets` keys are kept (the least recently written
// dropped first), and a row not written for `keepDays` is dropped. What one
// key's state holds is the caller's `compact` to bound.
//
// WRITES ARE OFF THE REQUEST PATH. A finished scan marks its key's state as
// waiting; a timer writes at most `flushChunk` keys a tick, one row each,
// under the store's lease, and prunes once an hour. Each key's state is
// compacted and written in a turn of its own. A write that does not
// land keeps the key waiting for the next tick. Nothing here throws to a
// caller: a store that cannot be read is a cold key, as before.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonDocument } from "./json-document.js";
import { stateDbEnabled, stateDbSchema, stateQuery, records, leased } from "./state-db.js";

const PRUNE_EVERY_MS = 60 * 60_000;

/**
 * name           the store's name (file name, lease prefix)
 * collection     the records collection
 * env            { file, enabled, maxWallets, flushMs }: the env variable names
 * keyOk(key)     whether a key may be stored
 * compact(state) the stored form (null: not stored), expand(body) the state (null: not one this build reads)
 */
export function createScanStateStore({ name, collection, env, keyOk, compact, expand, keepDays = 35, flushChunk = 20, defaultMaxWallets = 500 }) {
  const maxWallets = (e = process.env) => { const n = Math.floor(Number(e[env.maxWallets])); return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : defaultMaxWallets; };
  const flushMs = (e = process.env) => Math.max(1_000, Number(e[env.flushMs]) || 60_000);
  const enabled = (e = process.env) => String(e[env.enabled] || "").trim().toLowerCase() !== "off";

  let fileDoc = null;
  const fileOf = () => process.env[env.file] || join(existsSync("/data") ? "/data" : tmpdir(), `${name}.json`);
  const docOf = () => (fileDoc ||= createJsonDocument({ name, file: fileOf(), log: () => {} }));
  const fileBody = (b) => (b && typeof b === "object" && b.wallets && typeof b.wallets === "object" ? b : { v: 1, wallets: {} });
  function pruneWallets(wallets, now = Date.now()) {
    const cutoff = now - keepDays * 86_400_000;
    for (const [w, b] of Object.entries(wallets)) if (!(Number(b?.at) >= cutoff)) delete wallets[w];
    const over = Object.keys(wallets).length - maxWallets();
    if (over > 0) for (const [w] of Object.entries(wallets).sort((a, b) => (Number(a[1]?.at) || 0) - (Number(b[1]?.at) || 0)).slice(0, over)) delete wallets[w];
    return wallets;
  }

  const waiting = new Map();     // key -> scan state not yet written
  const counters = { loads: 0, hits: 0, misses: 0, loadFailures: 0, writes: 0, writeFailures: 0, notKept: 0, pruned: 0, flushes: 0 };
  let timer = null;
  let lastPruneAt = 0;

  /** The stored scan state of one key, or null (none stored, the store is off, or it could not be read). Never throws. */
  async function load(key) {
    if (!enabled() || !keyOk(key)) return null;
    // A state this process has not written yet is the newest there is.
    if (waiting.has(key)) return waiting.get(key);
    counters.loads++;
    try {
      let body;
      if (stateDbEnabled()) body = await records.get(collection, key);
      else body = fileBody(await docOf().load(null)).wallets[key];
      const st = expand(body);
      if (st) counters.hits++; else counters.misses++;
      return st;
    } catch {
      counters.loadFailures++;
      return null;
    }
  }

  /** A finished scan's state, to be written by the next flush. Synchronous. */
  function note(key, state) {
    if (!enabled() || !keyOk(key) || !state || typeof state !== "object") return false;
    waiting.delete(key); // newest last, so a flush writes the longest-waiting first
    waiting.set(key, state);
    // Keys nobody could ever flush are not kept without bound.
    while (waiting.size > maxWallets()) waiting.delete(waiting.keys().next().value);
    if (!timer) {
      timer = setInterval(() => { flush().catch(() => {}); }, flushMs());
      timer.unref?.();
    }
    return true;
  }

  async function pruneRows(now) {
    const T = `${stateDbSchema()}.records`;
    const old = await stateQuery(`DELETE FROM ${T} WHERE collection = $1 AND updated_at < now() - make_interval(days => $2)`, [collection, keepDays]);
    const over = await stateQuery(
      `DELETE FROM ${T} WHERE collection = $1 AND id IN (SELECT id FROM ${T} WHERE collection = $1 ORDER BY updated_at DESC, id OFFSET $2)`,
      [collection, maxWallets()],
    );
    counters.pruned += (old.rowCount || 0) + (over.rowCount || 0);
    lastPruneAt = now;
  }

  // One key's state is compacted and written in its own turn of the event
  // loop: a flush of many large states never holds the loop for all of them
  // at once (the drain's flush of up to 100 included).
  const nextTurn = () => new Promise((r) => { setImmediate(r); });
  // The stored form of one waiting state, or null when its compact form does
  // not keep it (over the store's bound): not written, and the key stays cold
  // for the next process, as before.
  const compactOne = (key, st) => {
    const body = compact(st);
    if (body) return body;
    counters.notKept++;
    if (waiting.get(key) === st) waiting.delete(key);
    return null;
  };
  async function flushUnleased({ max = flushChunk, now = Date.now() } = {}) {
    counters.flushes++;
    const batch = [...waiting.entries()].slice(0, Math.max(1, max));
    let written = 0;
    if (stateDbEnabled()) {
      let i = 0;
      for (const [key, st] of batch) {
        if (i++) await nextTurn();
        const body = compactOne(key, st);
        if (!body) continue;
        try {
          await records.put(collection, key, body);
          // A newer state noted while this row was being written stays waiting.
          if (waiting.get(key) === st) waiting.delete(key);
          written++; counters.writes++;
        } catch { counters.writeFailures++; break; } // the store is not answering: the rest waits for the next tick
      }
      if (now - lastPruneAt >= PRUNE_EVERY_MS) { try { await pruneRows(now); } catch { /* the next tick tries again */ } }
    } else {
      const bodies = new Map();
      let i = 0;
      for (const [key, st] of batch) {
        if (i++) await nextTurn();
        const body = compactOne(key, st);
        if (body) bodies.set(key, body);
      }
      if (bodies.size) {
        try {
          const r = await docOf().update((b) => {
            const x = fileBody(b);
            const wallets = { ...x.wallets };
            for (const [key, body] of bodies) wallets[key] = body;
            return { v: 1, wallets: pruneWallets(wallets, now) };
          }, { fallback: null });
          if (r?.ok) { for (const [key, st] of batch) if (bodies.has(key) && waiting.get(key) === st) waiting.delete(key); written = bodies.size; counters.writes += written; }
          else counters.writeFailures++;
        } catch { counters.writeFailures++; }
      }
    }
    return { ok: true, written, waiting: waiting.size };
  }
  // The default (no fail-open): the flush writes only to the state database, so
  // with the database not answering there is nothing a run without the lease
  // could write; the keys stay waiting.
  const flushLeased = leased(`${name}-store-flush`, { ttlMs: 120_000, log: () => {} }, flushUnleased);

  /** Write up to `max` waiting keys. Never throws. `{ skipped }` when another container holds the lease. */
  async function flush(opts = {}) {
    if (!waiting.size && Date.now() - lastPruneAt < PRUNE_EVERY_MS) return { ok: true, written: 0, waiting: 0 };
    try { return await flushLeased(opts); } catch { return { ok: false, written: 0, waiting: waiting.size }; }
  }

  /** Counts only, for the operator view. */
  function status(extra = {}) {
    return { enabled: enabled(), backend: stateDbEnabled() ? "state-db" : "file", waiting: waiting.size, maxWallets: maxWallets(), ...extra, ...counters };
  }

  /** Test seam. */
  function reset() {
    waiting.clear(); fileDoc = null; lastPruneAt = 0;
    if (timer) { clearInterval(timer); timer = null; }
    for (const k of Object.keys(counters)) counters[k] = 0;
  }

  return { load, note, flush, status, reset, enabled, maxWallets };
}
