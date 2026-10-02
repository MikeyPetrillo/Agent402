// Rolling per-tool reliability: success/failure counts and a p95 latency.
//
// Two sources, weighted differently. What OUR execute runs observed is a
// fact (we called it, we saw the answer). What a buyer reports through
// feedback is an opinion, and the feedback route is free, so it moves the
// stats half as far and a single decision can move a tool at most once per
// step (the main app keeps one verdict per decision step).
//
// Counts decay: every update multiplies the stored counts by DECAY first, so a
// tool that failed for a week and then recovered is not held to last week.

const DECAY = 0.98;
const LAT_KEEP = 64;
export const WEIGHT = { execution: 1, feedback: 0.5 };

export class Reliability {
  constructor() {
    this.stats = new Map();  // toolId -> { successes, failures, latency_p95_ms, lastSuccessAt }
    this.lat = new Map();    // toolId -> recent latencies
    this.dirty = new Set();
    this.seen = new Set();   // today's counted (tool, payer, source, outcome)
    this.seenDay = "";
  }

  get(id) { return this.stats.get(id) || null; }

  load(rows) {
    for (const r of rows) this.stats.set(r.tool_id, { successes: Number(r.successes) || 0, failures: Number(r.failures) || 0, fbSuccesses: Number(r.fb_successes) || 0, fbFailures: Number(r.fb_failures) || 0, latency_p95_ms: r.latency_p95_ms ?? null, lastSuccessAt: r.last_success_at ? new Date(r.last_success_at).getTime() : null });
  }

  /** `by` identifies who paid for the run or filed the report (a short hash).
   *  One observation per tool, per payer, per outcome, per UTC day counts:
   *  buying the same tool twenty times through us, or filing twenty reports,
   *  moves it no further than doing it once. Observations with no `by` share
   *  one anonymous slot. */
  record({ toolId, ok, latencyMs = null, source = "execution", by = null, now = Date.now() }) {
    if (typeof toolId !== "string" || !toolId || toolId.length > 64) return false;
    const w = WEIGHT[source];
    if (!w) return false;
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.seenDay) { this.seenDay = day; this.seen = new Set(); }
    const key = `${toolId}|${String(by || "anon").slice(0, 64)}|${source}|${ok ? 1 : 0}`;
    if (this.seen.has(key)) return false;
    if (this.seen.size < 500_000) this.seen.add(key);
    const s = this.stats.get(toolId) || { successes: 0, failures: 0, fbSuccesses: 0, fbFailures: 0, latency_p95_ms: null, lastSuccessAt: null };
    if (source === "feedback") {
      // Reports are kept apart: the ranker lets them nudge a tool by a bounded
      // amount, so buying decisions to file reports cannot sink a rival.
      s.fbSuccesses = (s.fbSuccesses || 0) * DECAY + (ok ? 1 : 0);
      s.fbFailures = (s.fbFailures || 0) * DECAY + (ok ? 0 : 1);
    } else {
      s.successes = s.successes * DECAY + (ok ? w : 0);
      s.failures = s.failures * DECAY + (ok ? 0 : w);
      if (ok) s.lastSuccessAt = now;
    }
    if (ok && Number.isFinite(latencyMs) && latencyMs > 0 && latencyMs < 600_000 && source === "execution") {
      const l = this.lat.get(toolId) || [];
      l.push(latencyMs);
      if (l.length > LAT_KEEP) l.shift();
      this.lat.set(toolId, l);
      const sorted = [...l].sort((a, b) => a - b);
      s.latency_p95_ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }
    this.stats.set(toolId, s);
    this.dirty.add(toolId);
    return true;
  }

  /** Rows changed since the last flush (for persistence). */
  takeDirty() {
    const out = [...this.dirty].map((id) => ({ id, ...this.stats.get(id) }));
    this.dirty.clear();
    return out;
  }
}

export async function persistReliability(pool, rows) {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO decide_tool_reliability (tool_id, successes, failures, fb_successes, fb_failures, latency_p95_ms, last_success_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (tool_id) DO UPDATE SET successes = EXCLUDED.successes, failures = EXCLUDED.failures,
         fb_successes = EXCLUDED.fb_successes, fb_failures = EXCLUDED.fb_failures,
         latency_p95_ms = EXCLUDED.latency_p95_ms, last_success_at = EXCLUDED.last_success_at, updated_at = now()`,
      [r.id, Math.round(r.successes), Math.round(r.failures), Math.round(r.fbSuccesses || 0), Math.round(r.fbFailures || 0), r.latency_p95_ms, r.lastSuccessAt ? new Date(r.lastSuccessAt) : null]);
  }
}
