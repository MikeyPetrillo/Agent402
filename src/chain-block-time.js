// Block time per chain, as the chain runs it now.
//
// Depths, margins and scan spans are wall-clock quantities (one hour behind
// the head, ten seconds of head lag, a few hours of recent transfers). They
// are written in seconds and turned into a block count here, at the block
// time in force when the count is taken, so a change to a chain's block
// time keeps every window the same length in time without a redeploy.
//
// Three sources, in order:
//   1. A measured rate: the chain's own block timestamps over its most recent
//      blocks (`refreshBlockMs`, throttled per chain). Used while fresh, and
//      not when its sample began before a scheduled activation that has since
//      passed (a sample that mixes the two rates names neither).
//   2. A scheduled activation: Base's Denim upgrade moves blocks from 2 s to
//      200 ms at an activation timestamp per network.
//        BASE_DENIM_ACTIVATION_TIMESTAMP          mainnet (unset until announced)
//        BASE_SEPOLIA_DENIM_ACTIVATION_TIMESTAMP  Base Sepolia (default below)
//      Either takes an ISO-8601 time or unix seconds; "off" clears it.
//      block.timestamp stays whole seconds after Denim, so several blocks
//      share one; the measurement divides elapsed seconds by blocks over a
//      sample wide enough that this rounds away.
//   3. The nominal table (measured per chain by sampling).
// With mainnet's activation unset, the measurement is what moves Base to its
// new rate: within one refresh of the first readable sample past the fork.

export const NOMINAL_BLOCK_MS = Object.freeze({
  base: 2000, "base-sepolia": 2000, polygon: 2100, arbitrum: 250, robinhood: 150,
  monad: 300, celo: 1000, avalanche: 1140, sei: 450, optimism: 2000, arc: 500,
});

export const DENIM_BLOCK_MS = 200;
const DENIM = Object.freeze({
  base: { env: "BASE_DENIM_ACTIVATION_TIMESTAMP", def: null, before: 2000 },
  "base-sepolia": { env: "BASE_SEPOLIA_DENIM_ACTIVATION_TIMESTAMP", def: "2026-10-21T18:00:00Z", before: 2000 },
});
const ALIASES = { "eip155:8453": "base", "eip155:84532": "base-sepolia", basesepolia: "base-sepolia", "base_sepolia": "base-sepolia" };
const key = (chain) => { const k = String(chain || "").toLowerCase(); return ALIASES[k] || k; };

/** Chains whose block time is scheduled to change, and so are re-measured. */
export const blockTimeChanges = (chain) => Object.prototype.hasOwnProperty.call(DENIM, key(chain));

/** Parse an activation setting: ISO-8601 or unix seconds (or ms). null when unset/off/unreadable. */
export function parseActivation(raw) {
  const s = String(raw ?? "").trim();
  if (!s || /^(off|none|unset|0)$/i.test(s)) return null;
  if (/^\d+(\.\d+)?$/.test(s)) { const n = Number(s); return n > 1e12 ? n : n * 1000; }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Denim activation for a network, in ms since the epoch, or null. */
export function denimActivationMs(chain, env = process.env) {
  const d = DENIM[key(chain)];
  if (!d) return null;
  return parseActivation(env[d.env] != null ? env[d.env] : d.def);
}

/** The block time a chain's schedule names at `atMs` (ignores measurement). */
export function scheduledBlockMs(chain, { atMs = Date.now(), env = process.env } = {}) {
  const k = key(chain);
  const d = DENIM[k];
  if (d) {
    const act = denimActivationMs(k, env);
    return act != null && atMs >= act ? DENIM_BLOCK_MS : d.before;
  }
  return NOMINAL_BLOCK_MS[k] || 2000;
}

// ---- measurement ------------------------------------------------------------
const measured = new Map(); // chain -> { ms, fromSec, toSec, at }
const inflight = new Map();
export const MEASURE_FRESH_MS = 15 * 60_000;
export const MEASURE_EVERY_MS = 5 * 60_000;
export const MEASURE_SAMPLE_BLOCKS = 1000;

/** Record a measured sample: two headers `{ number, timestamp }` (seconds). */
export function noteBlockSample(chain, older, newer, { now = Date.now() } = {}) {
  const n = Number(newer?.number) - Number(older?.number);
  const dt = Number(newer?.timestamp) - Number(older?.timestamp);
  if (!(n > 0) || !(dt > 0)) return null;
  const ms = (dt * 1000) / n;
  if (!(ms >= 10 && ms <= 60_000)) return null;
  const rec = { ms, fromSec: Number(older.timestamp), toSec: Number(newer.timestamp), at: now };
  measured.set(key(chain), rec);
  return rec;
}

/** Forget measurements (tests). */
export function resetBlockMsMeasurements() { measured.clear(); inflight.clear(); }
export function blockMsMeasurement(chain) { return measured.get(key(chain)) || null; }

/**
 * Read the chain's recent rate and record it. `getHeader(n | "latest")`
 * returns `{ number, timestamp }`. Throttled per chain to MEASURE_EVERY_MS;
 * never throws (an unreadable chain leaves the schedule in charge).
 */
export async function refreshBlockMs(chain, getHeader, { now = Date.now(), force = false, sampleBlocks = MEASURE_SAMPLE_BLOCKS } = {}) {
  const k = key(chain);
  const prev = measured.get(k);
  if (!force && prev && now - prev.at < MEASURE_EVERY_MS) return prev;
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    try {
      const top = await getHeader("latest");
      const back = await getHeader(Math.max(0, Number(top.number) - sampleBlocks));
      return noteBlockSample(k, back, top, { now }) || prev || null;
    } catch { return prev || null; }
  })().finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

/**
 * Milliseconds per block for `chain` now. A fresh measurement wins unless its
 * sample began before a scheduled activation that has since passed; a measurement within 20% of the
 * scheduled rate reads as the scheduled rate (stable counts, no jitter).
 */
export function blockMs(chain, { now = Date.now(), env = process.env } = {}) {
  const k = key(chain);
  const sched = scheduledBlockMs(k, { atMs: now, env });
  const m = measured.get(k);
  if (m && now - m.at <= MEASURE_FRESH_MS) {
    const act = denimActivationMs(k, env);
    // A sample that began before a scheduled activation that has since passed
    // (straddling it, or taken wholly before it) describes the old rate.
    const predates = act != null && m.fromSec * 1000 < act && act <= now;
    if (!predates) return Math.abs(m.ms - sched) <= sched * 0.2 ? sched : Math.max(1, Math.round(m.ms));
  }
  return sched;
}

/** Blocks covering `seconds` of chain time now (at least 1). */
export function blocksForSeconds(chain, seconds, opts = {}) {
  return Math.max(1, Math.ceil((Number(seconds) * 1000) / blockMs(chain, opts)));
}
