// Every large in-memory store, sized for the operator heap read
// (/__operator/heap.json `stores`). Production heaps hold far more than the
// seller index; this names where the rest sits, from production itself.
//
// A module registers a store once, with a getter (never the value itself, so
// a store that is replaced, or not built yet, reads as it is at read time):
//   registerMemoryStore("mpp-index.cache", () => cache, { note: "..." })
// or with its own cheap figure (`figure: () => ({ rows, mb })`), or as a
// SQLite handle (registerSqliteStore), whose pages live outside the JS heap
// but inside the process (an in-memory database is all of its pages).
//
// The read is bounded, never a full walk: a collection is sized from a few
// dozen evenly spaced members (scaled to its count), a nested value is walked
// to a fixed node budget, and the whole read stops at a time budget, after
// which the remaining stores report `skipped`. The sizes are estimates
// (string lengths and per-object overheads), comparable across stores, not
// byte-exact heap accounting. No imports: any module can register.

const stores = new Map(); // name -> { kind, read, note }

export function registerMemoryStore(name, read, { note = "", figure = null } = {}) {
  stores.set(String(name), { kind: figure ? "figure" : "value", read: figure || read, note: String(note || "") });
}

/** A better-sqlite3 handle (or a getter returning one, possibly null). */
export function registerSqliteStore(name, getDb, { note = "" } = {}) {
  stores.set(String(name), { kind: "sqlite", read: typeof getDb === "function" ? getDb : () => getDb, note: String(note || "") });
}

export function memoryStoreNames() { return [...stores.keys()]; }
export function _resetMemoryStoresForTest() { stores.clear(); }

const SAMPLE = 48;          // members sized per top-level collection
const NESTED_SAMPLE = 8;    // members sized per collection inside a member
const SCAN_CAP = 20_000;    // members a Map/Set walk may step over to reach its samples
const NODE_BUDGET = 12_000; // nodes one store's walk may visit
const MAX_DEPTH = 8;

// Approximate retained bytes of `v`, sampling large collections. `ctx.nodes`
// counts visits against the budget; past it the walk stops descending.
function approx(v, ctx, depth) {
  if (v == null) return 8;
  const t = typeof v;
  if (t === "string") return 16 + v.length;
  if (t === "number" || t === "boolean" || t === "bigint" || t === "symbol") return 8;
  if (t === "function") return 64;
  if (t !== "object") return 8;
  if (ctx.seen.has(v)) return 8;
  ctx.seen.add(v);
  if (++ctx.nodes > NODE_BUDGET || depth > MAX_DEPTH) { ctx.truncated = true; return 32; }
  if (ArrayBuffer.isView(v)) return 64 + v.byteLength;
  if (v instanceof ArrayBuffer) return 32 + v.byteLength;
  if (v instanceof Date) return 32;
  if (v instanceof WeakMap || v instanceof WeakSet || v instanceof Promise) return 32;
  const want = depth === 0 ? SAMPLE : NESTED_SAMPLE;
  if (Array.isArray(v)) return 16 + 8 * v.length + sampledSum(v.length, want, ctx, depth, (positions) => positions.map((i) => v[i]));
  if (v instanceof Map || v instanceof Set) {
    const size = v.size;
    return 32 + 24 * size + sampledSum(size, want, ctx, depth, (positions) => {
      const out = []; let i = 0, p = 0;
      for (const e of v instanceof Map ? v.entries() : v.values()) {
        if (p >= positions.length) break;
        if (i === positions[p]) { out.push(e); p++; }
        i++;
      }
      return out;
    });
  }
  // A plain object: its own keys, capped. Property names are shared through
  // the object's shape, so each property costs a slot, not its name.
  let bytes = 24, keys = 0;
  for (const k in v) {
    if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
    if (++keys > 2_000) { ctx.truncated = true; break; }
    let val;
    try { val = v[k]; } catch { continue; }
    bytes += 8 + approx(val, ctx, depth + 1);
    if (ctx.nodes > NODE_BUDGET) { ctx.truncated = true; break; }
  }
  return bytes;
}
// Up to `want` positions in [0, reach), spread by the golden-ratio sequence:
// even coverage without a fixed stride, which would line up with any
// periodic layout (every Nth seller being a large one) and skew the scale.
function samplePositions(reach, want) {
  if (reach <= want) return Array.from({ length: reach }, (_, i) => i);
  const set = new Set();
  for (let k = 0; set.size < want && k < want * 4; k++) set.add(Math.floor(((0.5 + k * 0.6180339887498949) % 1) * reach));
  return [...set].sort((a, b) => a - b);
}
// Size `count` members from up to `want` spread ones, scaled to the count.
function sampledSum(count, want, ctx, depth, pick) {
  if (!count) return 0;
  const sample = pick(samplePositions(Math.min(count, SCAN_CAP), want));
  if (!sample.length) return 0;
  let sum = 0;
  for (const m of sample) sum += approx(m, ctx, depth + 1);
  return Math.round((sum / sample.length) * count);
}

/** The same sampled estimate, for a store's own figure function. */
export function approxBytes(v) {
  return approx(v, { nodes: 0, seen: new WeakSet(), truncated: false }, 0);
}

function rowsOf(v) {
  if (v == null) return 0;
  if (Array.isArray(v) || typeof v === "string") return v.length;
  if (v instanceof Map || v instanceof Set) return v.size;
  if (ArrayBuffer.isView(v)) return v.length;
  if (typeof v === "object") { let n = 0; for (const k in v) { if (++n > 100_000) break; } return n; }
  return 1;
}

const mbOf = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

function sqliteFigure(db) {
  if (!db || typeof db.pragma !== "function" || db.open === false) return { rows: 0, sampledMb: 0, tables: 0 };
  const pageCount = Number(db.pragma("page_count", { simple: true })) || 0;
  const pageSize = Number(db.pragma("page_size", { simple: true })) || 0;
  let rows = 0, tables = 0;
  try {
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      tables++;
      // MAX(rowid) is an index seek, not a count: an upper bound on rows.
      try { rows += Number(db.prepare(`SELECT MAX(rowid) AS n FROM "${String(name).replace(/"/g, '""')}"`).get()?.n) || 0; } catch { /* WITHOUT ROWID */ }
    }
  } catch { /* closed or busy: pages are still reported */ }
  return { rows, sampledMb: mbOf(pageCount * pageSize), tables, memory: db.memory === true };
}

/**
 * Size every registered store within `budgetMs`, largest first. Returns
 * { stores: { name: { rows, sampledMb, note, ... } }, readMs, skipped }.
 */
export function memoryStoreFigures({ budgetMs = 40, now = () => performance.now() } = {}) {
  const start = now();
  const out = [];
  let skipped = 0;
  for (const [name, s] of stores) {
    if (now() - start > budgetMs) { out.push({ name, rows: null, sampledMb: null, note: s.note, skipped: "time budget" }); skipped++; continue; }
    const t0 = now();
    try {
      if (s.kind === "sqlite") {
        out.push({ name, ...sqliteFigure(s.read()), note: s.note, kind: "sqlite" });
      } else if (s.kind === "figure") {
        const f = s.read() || {};
        out.push({ name, rows: Number(f.rows) || 0, sampledMb: Number.isFinite(f.mb) ? Math.round(f.mb * 10) / 10 : null, note: s.note, ...(f.detail ? { detail: f.detail } : {}) });
      } else {
        const v = s.read();
        const ctx = { nodes: 0, seen: new WeakSet(), truncated: false };
        out.push({ name, rows: rowsOf(v), sampledMb: mbOf(approx(v, ctx, 0)), note: s.note, ...(ctx.truncated ? { partial: true } : {}) });
      }
    } catch (e) {
      out.push({ name, rows: null, sampledMb: null, note: s.note, error: String(e?.message || e).slice(0, 120) });
    }
    out[out.length - 1].ms = Math.round((now() - t0) * 10) / 10;
  }
  out.sort((a, b) => (b.sampledMb ?? -1) - (a.sampledMb ?? -1));
  const storesObj = {};
  for (const { name, ...rest } of out) storesObj[name] = rest;
  return { stores: storesObj, readMs: Math.round((now() - start) * 10) / 10, skipped };
}
