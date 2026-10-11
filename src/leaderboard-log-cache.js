// The Base leaderboard's log window, read once and kept.
//
// The board is a sliding window (7 days in production) of USDC transfers to
// every known seller wallet. It used to re-read the WHOLE window every hour:
// one eth_getLogs per (block chunk x wallet chunk), every block of which it
// had already read the hour before. Settled logs are immutable, so this keeps
// the decoded transfers it has read, by block segment, and each scan reads
// only:
//   * the blocks after its cursor (the head), for every wallet, and
//   * the whole window for a wallet it has not read before (a new seller).
// Everything else is folded from the kept rows. The fold sees the same
// transfers in the same per-wallet order (chain position) as a full re-read,
// so every published figure is the same.
//
// Rules, each one tested in scripts/test-leaderboard-log-cache.js:
//   * The cursor advances only when every head read of the scan succeeded,
//     and only to `latest - reorgMarginBlocks`: the newest blocks are read
//     and folded every scan but never kept, so a reorganized head block is
//     never folded twice or kept stale.
//   * A new wallet is kept (covered) only when every read of its batch
//     succeeded; otherwise it is read again next scan. Its earlier rows (a
//     wallet that left and came back) are dropped before its new rows go in.
//   * Rows older than the window are not folded; a segment wholly older is
//     deleted.
//   * State survives a restart in the same store the board's other documents
//     use (json-document: the state database, or files on the volume). The
//     meta document is written last and names each segment's row count and
//     digest; a segment that does not match it (a save that did not land)
//     discards the whole cache, and the next scan is a full read (the old
//     behavior), never a gap or a double count.
//   * LEADERBOARD_LOG_CACHE=off turns the cache off: every scan is a full
//     read, exactly as before.
import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createJsonDocument } from "./json-document.js";
import { documents, stateDbEnabled } from "./state-db.js";
import { posOf } from "./seller-funding.js";

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
export const LOG_CACHE_DEFAULTS = Object.freeze({
  segmentBlocks: num(process.env.LEADERBOARD_LOG_CACHE_SEGMENT_BLOCKS, 18_000),
  reorgMarginBlocks: num(process.env.LEADERBOARD_LOG_CACHE_REORG_BLOCKS, 300),
  maxRows: num(process.env.LEADERBOARD_LOG_CACHE_MAX_ROWS, 2_000_000),
  saveTimeoutMs: 20_000,
});
const VERSION = 1;

/** Off only when LEADERBOARD_LOG_CACHE=off (read at call time). */
export function logCacheEnabled(env = process.env) {
  return String(env.LEADERBOARD_LOG_CACHE || "").trim().toLowerCase() !== "off";
}

/**
 * Where the cache lives. With a state database: documents named
 * `<prefix>-meta` and `<prefix>-<segment start>`. Without one: files in `dir`
 * (the volume), or memory only when there is no dir (local runs, tests that
 * pass none).
 */
export function createLogCacheStore({ prefix, dir = null } = {}) {
  const usePg = stateDbEnabled();
  const docs = new Map();
  const nameOf = (key) => `${prefix}-${key}`;
  const fileOf = (key) => (!usePg && dir ? join(dir, `${nameOf(key)}.json`) : null);
  const memory = new Map();
  const persistent = usePg || !!dir;
  const docOf = (key) => {
    let d = docs.get(key);
    if (!d) {
      d = createJsonDocument({ name: nameOf(key), file: fileOf(key), log: () => {}, failLog: () => {}, importFromFile: false, writeThroughFiles: false });
      docs.set(key, d);
    }
    return d;
  };
  return {
    persistent,
    /** { ok, body } (body null when there is none); ok:false on a read error. */
    async read(key) {
      if (!persistent) return { ok: true, body: memory.has(key) ? memory.get(key) : null };
      const r = await docOf(key).read({ quiet: true });
      return r.ok ? { ok: true, body: r.exists ? r.body : null } : { ok: false, body: null };
    },
    async save(key, body, timeoutMs = LOG_CACHE_DEFAULTS.saveTimeoutMs) {
      if (!persistent) { memory.set(key, body); return true; }
      let timer;
      const timeout = new Promise((r) => { timer = setTimeout(() => r(false), timeoutMs); timer.unref?.(); });
      try { return await Promise.race([docOf(key).save(body), timeout]); } finally { clearTimeout(timer); }
    },
    async del(key) {
      if (!persistent) { memory.delete(key); return true; }
      docs.delete(key);
      try {
        if (usePg) await documents.del(nameOf(key));
        const f = dir ? join(dir, `${nameOf(key)}.json`) : null;
        if (f && existsSync(f)) unlinkSync(f);
        return true;
      } catch { return false; }
    },
  };
}

// ---- in-memory state ------------------------------------------------------
// A segment holds parallel arrays (wallet, payer, micro, block, logIndex);
// address strings are interned so a wallet's string is held once.
const intern = new Map();
const I = (s) => { if (s == null) return null; let v = intern.get(s); if (v === undefined) { intern.set(s, s); v = s; } return v; };
const newSeg = (start) => ({ start, w: [], p: [], m: [], b: [], li: [], dirty: true });
const segRows = (s) => s.w.length;

function serializeSeg(s) {
  const wallets = [], payers = [], wi = new Map(), pi = new Map(), rows = [];
  for (let i = 0; i < s.w.length; i++) {
    let a = wi.get(s.w[i]); if (a === undefined) { a = wallets.length; wallets.push(s.w[i]); wi.set(s.w[i], a); }
    let b = -1;
    if (s.p[i] != null) { b = pi.get(s.p[i]); if (b === undefined) { b = payers.length; payers.push(s.p[i]); pi.set(s.p[i], b); } }
    rows.push(a, b, s.m[i], s.b[i], s.li[i]);
  }
  return { v: VERSION, start: s.start, wallets, payers, rows };
}
function parseSeg(body) {
  if (!body || body.v !== VERSION || !Array.isArray(body.rows) || body.rows.length % 5) return null;
  const s = newSeg(Number(body.start)); s.dirty = false;
  const wallets = (body.wallets || []).map(I), payers = (body.payers || []).map(I);
  for (let i = 0; i < body.rows.length; i += 5) {
    const w = wallets[body.rows[i]];
    if (typeof w !== "string") return null;
    s.w.push(w); s.p.push(body.rows[i + 1] >= 0 ? payers[body.rows[i + 1]] ?? null : null);
    s.m.push(Number(body.rows[i + 2])); s.b.push(Number(body.rows[i + 3])); s.li.push(Number(body.rows[i + 4]));
  }
  return s;
}
const digestOf = (body) => createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);

/**
 * One chain's log window cache.
 *   store            createLogCacheStore(...) (or a test double)
 *   token            the token contract; a cache read for another token is discarded
 */
export function createLogWindowCache({ store, token, segmentBlocks = LOG_CACHE_DEFAULTS.segmentBlocks, reorgMarginBlocks = LOG_CACHE_DEFAULTS.reorgMarginBlocks, maxRows = LOG_CACHE_DEFAULTS.maxRows } = {}) {
  let state = null;          // { cursor, covered: Map(wallet -> fromBlock), segs: Map(start -> seg) }
  let loaded = false;
  const deleted = new Set(); // segment keys to delete on the next persist
  const stats = { scans: 0, fullScans: 0, incrementalScans: 0, headCalls: 0, backfillCalls: 0, failedCalls: 0, resets: 0, overCap: 0, lastRows: 0, lastCursor: null, lastReason: null, persistFailures: 0 };
  const segStartOf = (block) => Math.floor(block / segmentBlocks) * segmentBlocks;

  const empty = () => ({ cursor: null, covered: new Map(), segs: new Map() });
  function reset(reason) {
    if (state) for (const k of state.segs.keys()) deleted.add(k);
    state = empty();
    stats.resets++; stats.lastReason = reason;
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    state = empty();
    let meta;
    try { meta = await store.read("meta"); } catch { meta = { ok: false }; }
    if (!meta.ok || !meta.body) { if (!meta.ok) stats.lastReason = "meta unreadable"; return; }
    const m = meta.body;
    if (m.v !== VERSION || String(m.token || "").toLowerCase() !== String(token).toLowerCase() || m.segmentBlocks !== segmentBlocks || !Number.isFinite(m.cursor)) { reset("meta from another configuration"); return; }
    const segs = new Map();
    for (const [key, want] of Object.entries(m.segs || {})) {
      let r;
      try { r = await store.read(key); } catch { r = { ok: false }; }
      if (!r.ok || !r.body || digestOf(r.body) !== want.digest) { reset(`segment ${key} does not match the meta`); for (const k of Object.keys(m.segs || {})) deleted.add(k); return; }
      const s = parseSeg(r.body);
      if (!s || segRows(s) !== want.rows || s.b.some((b) => b > m.cursor || segStartOf(b) !== s.start)) { reset(`segment ${key} is malformed`); for (const k of Object.keys(m.segs || {})) deleted.add(k); return; }
      segs.set(s.start, s);
    }
    state = { cursor: m.cursor, covered: new Map(Object.entries(m.covered || {}).map(([w, b]) => [I(w), Number(b)])), segs };
  }

  async function persist() {
    if (!state) return true;
    let okAll = true;
    const metaSegs = {};
    for (const [k, s] of state.segs) {
      const body = serializeSeg(s);
      if (s.dirty) {
        const saved = await store.save(String(k), body).catch(() => false);
        if (!saved) okAll = false; else s.dirty = false;
      }
      metaSegs[k] = { rows: segRows(s), digest: digestOf(body) };
    }
    for (const k of deleted) { if (!state.segs.has(Number(k))) await store.del(String(k)).catch(() => false); }
    deleted.clear();
    // The meta goes last, and only when every segment it names landed.
    if (!okAll) { stats.persistFailures++; return false; }
    const meta = { v: VERSION, token: String(token).toLowerCase(), segmentBlocks, cursor: state.cursor, covered: Object.fromEntries(state.covered), segs: metaSegs };
    const ok = await store.save("meta", meta).catch(() => false);
    if (!ok) stats.persistFailures++;
    return ok;
  }

  function addRow(t) {
    const k = segStartOf(t.block);
    let s = state.segs.get(k);
    if (!s) { s = newSeg(k); state.segs.set(k, s); deleted.delete(k); }
    s.w.push(I(t.wallet)); s.p.push(I(t.payer)); s.m.push(t.micro); s.b.push(t.block); s.li.push(t.logIndex); s.dirty = true;
  }
  function dropWallets(set) {
    for (const s of state.segs.values()) {
      if (!s.w.some((w) => set.has(w))) continue;
      const keep = (_, i) => !set.has(s.w[i]);
      s.p = s.p.filter(keep); s.m = s.m.filter(keep); s.b = s.b.filter(keep); s.li = s.li.filter(keep); s.w = s.w.filter((w) => !set.has(w));
      s.dirty = true;
    }
  }
  function prune(start) {
    for (const k of [...state.segs.keys()]) if (k + segmentBlocks - 1 < start) { state.segs.delete(k); deleted.add(k); }
  }
  const totalRows = () => { let n = 0; for (const s of state.segs.values()) n += segRows(s); return n; };

  /**
   * One scan of [start, latest] for `wallets`.
   *   readLogs(from, to, paddedWallets) -> decoded transfers [{ wallet, payer, micro, block, logIndex }]; throws on failure
   *   chunkBlocks, walletChunk, pad   the scan's own chunking
   * Returns { transfers (chain order, every wallet), calls, failedCalls, failedFromByWallet, mode }.
   */
  async function scan({ wallets, start, latest, chunkBlocks, walletChunk, pad, readLogs, onError = null }) {
    await load();
    stats.scans++;
    const ws = [...new Set(wallets.map((w) => I(String(w).toLowerCase())))];
    const wsSet = new Set(ws);
    if (state.cursor !== null && (state.cursor < start - 1 || state.cursor > latest)) reset(state.cursor > latest ? "cursor ahead of the head" : "cursor older than the window");
    const cold = state.cursor === null;
    const cursor = cold ? start - 1 : state.cursor;
    const fresh = cold ? ws : ws.filter((w) => !(state.covered.get(w) <= start));
    const freshSet = new Set(fresh);
    const failedFromByWallet = new Map();
    let calls = 0, failedCalls = 0;

    const readRange = async (from, to, list, kind) => {
      const out = []; let failed = false;
      const groups = [];
      for (let i = 0; i < list.length; i += walletChunk) groups.push(list.slice(i, i + walletChunk));
      const failedGroups = new Set();
      for (let a = from; a <= to; a += chunkBlocks) {
        const b = Math.min(a + chunkBlocks - 1, to);
        for (const [gi, g] of groups.entries()) {
          calls++; if (kind === "head") stats.headCalls++; else stats.backfillCalls++;
          try { out.push(...await readLogs(a, b, g.map(pad))); }
          catch (e) {
            failed = true; failedCalls++; stats.failedCalls++; failedGroups.add(gi);
            for (const w of g) failedFromByWallet.set(w, Math.min(failedFromByWallet.get(w) ?? Infinity, a));
            if (typeof onError === "function") onError(a, b, e);
          }
        }
      }
      return { out, failed, failedGroups, groups };
    };

    // 1. Wallets read for the first time: the window up to the cursor.
    const back = fresh.length && cursor >= start ? await readRange(start, cursor, fresh, "backfill") : { out: [], failed: false, failedGroups: new Set(), groups: [] };
    // 2. Every wallet: the blocks after the cursor.
    const head = cursor < latest ? await readRange(cursor + 1, latest, ws, "head") : { out: [], failed: false };

    // The fold: kept rows (covered wallets, inside the window), the new
    // wallets' rows and the head, in chain order.
    const rows = [];
    for (const s of state.segs.values()) {
      if (s.start + segmentBlocks - 1 < start) continue;
      for (let i = 0; i < s.w.length; i++) {
        const w = s.w[i];
        if (s.b[i] < start || s.b[i] > cursor || !wsSet.has(w) || freshSet.has(w) || !(state.covered.get(w) <= start)) continue;
        rows.push({ wallet: w, payer: s.p[i], micro: s.m[i], block: s.b[i], logIndex: s.li[i] });
      }
    }
    for (const t of back.out) if (t.block >= start && t.block <= cursor) rows.push(t);
    for (const t of head.out) if (t.block > cursor && t.block <= latest) rows.push(t);
    rows.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);

    // Keep what this scan read in full.
    if (cold) {
      if (!head.failed) {
        const settled = Math.max(start - 1, latest - reorgMarginBlocks);
        for (const t of head.out) if (t.block <= settled) addRow(t);
        for (const w of ws) state.covered.set(w, start);
        state.cursor = settled;
      }
    } else {
      // New wallets whose every read landed: drop any older rows, keep these.
      const done = new Set();
      for (const [gi, g] of back.groups.entries()) if (!back.failedGroups.has(gi)) for (const w of g) done.add(w);
      if (cursor < start) for (const w of fresh) done.add(w); // nothing to backfill
      if (done.size) {
        dropWallets(done);
        for (const t of back.out) if (done.has(t.wallet) && t.block >= start && t.block <= cursor) addRow(t);
        for (const w of done) state.covered.set(w, start);
      }
      if (!head.failed) {
        const settled = Math.max(cursor, latest - reorgMarginBlocks);
        for (const t of head.out) {
          if (t.block <= cursor || t.block > settled) continue;
          // A wallet not covered yet keeps no head rows: its backfill comes
          // again next scan and covers up to the new cursor.
          if (!(state.covered.get(t.wallet) <= start)) continue;
          addRow(t);
        }
        // Wallets still uncovered (their backfill failed) are re-read next scan.
        state.cursor = settled;
      }
    }
    // Wallets no longer listed stop being covered (their rows age out).
    for (const w of [...state.covered.keys()]) if (!wsSet.has(w)) state.covered.delete(w);
    prune(start);
    const n = totalRows();
    stats.lastRows = n; stats.lastCursor = state.cursor;
    if (cold) stats.fullScans++; else stats.incrementalScans++;
    if (n > maxRows) { stats.overCap++; reset(`over ${maxRows} rows`); }
    return {
      transfers: rows, calls, failedCalls, failedFromByWallet,
      mode: cold ? "full" : "incremental", newWallets: cold ? 0 : fresh.length,
    };
  }

  return {
    scan, load, persist,
    stats: () => ({ ...stats, cursor: state?.cursor ?? null, rows: state ? totalRows() : 0, segments: state ? state.segs.size : 0, coveredWallets: state ? state.covered.size : 0 }),
    /** Tests: drop the in-memory copy so the next scan loads from the store. */
    _forget() { state = null; loaded = false; deleted.clear(); },
  };
}

/** A transfer decoded from one eth_getLogs entry (topics[2] = recipient). */
export function decodeTransferLog(l) {
  const t1 = l?.topics?.[1];
  return {
    wallet: ("0x" + l.topics[2].slice(-40)).toLowerCase(),
    payer: t1 && t1.length >= 40 ? ("0x" + t1.slice(-40)).toLowerCase() : null,
    micro: Number(BigInt(l.data)),
    block: parseInt(l.blockNumber, 16),
    logIndex: parseInt(l.logIndex, 16),
  };
}
export const transferForFold = (t) => ({ wallet: t.wallet, payer: t.payer, usd: t.micro / 1e6, pos: posOf(t.block, t.logIndex) });
