// Block <-> time, read from the chain rather than assumed.
//
// WHY THIS EXISTS. Several scans turned a time window into a block count with
// a fixed block time ("Base is 2 s, so 24h = 43,200 blocks"). A block time is
// a property of the chain's current rules, not a constant: Base's Denim
// upgrade moves it from 2 s to 200 ms, and on that day every such window
// shrinks tenfold (a 7-day board becomes 17 hours) with nothing failing. The
// fork date is not known in advance, so nothing here names it: the start of a
// window is found by BLOCK TIMESTAMP, which is right before, after and across
// the transition alike.
//
// `getHeader(n)` returns `{ number, timestamp }` (timestamp in SECONDS) for a
// block number, or for "latest". The search is interpolation with a bisection
// fallback inside a verified bracket, so a chain whose rate changed partway
// through the window (a window straddling the fork) still converges; each
// header is read at most once per clock.

const toInt = (v) => (typeof v === "string" ? parseInt(v, v.startsWith("0x") ? 16 : 10) : Number(v));

/** Adapt an EVM JSON-RPC caller `(method, params) => result` into getHeader. */
export function rpcHeaderReader(rpc) {
  return async (n) => {
    const tag = n === "latest" ? "latest" : "0x" + Number(n).toString(16);
    const b = await rpc("eth_getBlockByNumber", [tag, false]);
    const number = toInt(b?.number), timestamp = toInt(b?.timestamp);
    if (!Number.isFinite(number) || !Number.isFinite(timestamp)) throw new Error("block header unreadable");
    return { number, timestamp };
  };
}

/**
 * A per-scan clock. `fallbackMsPerBlock` is used only when the chain cannot be
 * read at all; a readable chain always answers from its own timestamps.
 */
export function createBlockClock(getHeader, { fallbackMsPerBlock = 2000, maxCalls = 40, sampleBlocks = 1000 } = {}) {
  const cache = new Map();
  let calls = 0;
  let head = null;
  let headError = null;
  const header = async (n) => {
    if (cache.has(n)) return cache.get(n);
    if (calls >= maxCalls) throw new Error("block clock: call budget spent");
    calls++;
    const h = await getHeader(n);
    cache.set(h.number, h);
    return h;
  };
  const latest = async () => {
    if (headError) throw headError; // one failed read per clock, not one per question
    if (!head) {
      calls++;
      try { head = await getHeader("latest"); } catch (e) { headError = e; throw e; }
      cache.set(head.number, head);
    }
    return head;
  };
  /** Milliseconds per block over the most recent `sampleBlocks`, or null. */
  const recentMsPerBlock = async () => {
    try {
      const top = await latest();
      const back = await header(Math.max(0, top.number - sampleBlocks));
      const n = top.number - back.number;
      return n > 0 && top.timestamp > back.timestamp ? ((top.timestamp - back.timestamp) * 1000) / n : null;
    } catch { return null; }
  };

  /**
   * The first block whose timestamp is >= `targetSec` (the start of a window
   * ending now). Returns `{ block, exact, source }`: source "chain" when the
   * bracket converged, "rate" when it fell back to the recent measured rate,
   * "assumed" when nothing could be read.
   */
  const blockAtOrAfter = async (targetSec, { headNumber } = {}) => {
    let top;
    try { top = await latest(); } catch {
      if (!Number.isFinite(headNumber)) throw new Error("block clock: head unreadable");
      const back = Math.ceil(((Date.now() / 1000 - targetSec) * 1000) / fallbackMsPerBlock);
      return { block: Math.max(0, headNumber - back), exact: false, source: "assumed" };
    }
    if (targetSec >= top.timestamp) return { block: top.number, exact: true, source: "chain" };
    try {
      // Bracket: hi is after the target, lo at or before it.
      let hi = top;
      const rate = (await recentMsPerBlock()) || fallbackMsPerBlock;
      let step = Math.max(1, Math.ceil(((top.timestamp - targetSec) * 1000) / rate));
      let lo = await header(Math.max(0, top.number - step));
      while (lo.timestamp >= targetSec && lo.number > 0) {
        hi = lo;
        step *= 2;
        lo = await header(Math.max(0, top.number - step));
      }
      if (lo.timestamp >= targetSec) return { block: lo.number, exact: true, source: "chain" }; // genesis
      let interp = true;
      while (hi.number - lo.number > 1) {
        let mid;
        if (interp && hi.timestamp > lo.timestamp) {
          mid = lo.number + Math.round(((targetSec - lo.timestamp) / (hi.timestamp - lo.timestamp)) * (hi.number - lo.number));
          mid = Math.min(hi.number - 1, Math.max(lo.number + 1, mid));
        } else {
          mid = lo.number + Math.floor((hi.number - lo.number) / 2);
        }
        interp = !interp; // alternate so a kinked (forked) range still halves
        const m = await header(mid);
        if (m.timestamp >= targetSec) hi = m; else lo = m;
      }
      return { block: hi.number, exact: true, source: "chain" };
    } catch {
      const rate = (await recentMsPerBlock()) || null;
      const back = Math.ceil(((top.timestamp - targetSec) * 1000) / (rate || fallbackMsPerBlock));
      return { block: Math.max(0, top.number - back), exact: false, source: rate ? "rate" : "assumed" };
    }
  };

  return { latest, blockAtOrAfter, recentMsPerBlock, get calls() { return calls; } };
}

/**
 * Date a block from known (block, ms) anchors of the same chain, by linear
 * interpolation between the two anchors that bracket it, else by stepping
 * from the nearest anchor at `fallbackMsPerBlock`. Anchors near the row carry
 * the rate that was in force when it was mined, so a row from before a block
 * time change is dated at the old rate and one after it at the new one.
 * `anchors` must be sorted by block ascending. Returns null with no anchor.
 */
export function dateFromAnchors(block, anchors, fallbackMsPerBlock = 2000) {
  if (!Number.isFinite(block) || !anchors || !anchors.length) return null;
  let lo = 0, hi = anchors.length - 1;
  if (block <= anchors[0][0]) return anchors[0][1] - (anchors[0][0] - block) * fallbackMsPerBlock;
  if (block >= anchors[hi][0]) return anchors[hi][1] + (block - anchors[hi][0]) * fallbackMsPerBlock;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid][0] <= block) lo = mid; else hi = mid;
  }
  const [b0, t0] = anchors[lo], [b1, t1] = anchors[hi];
  return b1 === b0 ? t0 : Math.round(t0 + ((block - b0) / (b1 - b0)) * (t1 - t0));
}
