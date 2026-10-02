// Decisions, their steps and their ranking log. Pg + memory implementations
// share one interface; the service picks by configuration.

export class MemoryDecisionStore {
  constructor() { this.decisions = new Map(); this.steps = []; }
  async save(d, meta) {
    // Memory only (no database): bounded, oldest dropped first.
    if (this.decisions.size >= 5000) this.decisions.delete(this.decisions.keys().next().value);
    if (this.steps.length > 30000) this.steps.splice(0, this.steps.length - 25000);
    this.decisions.set(d.decisionId, { result: d, ...meta, createdAt: Date.now() });
    this.costs ||= new Map();
    if (this.costs.size >= 5000) this.costs.delete(this.costs.keys().next().value);
    this.costs.set(d.decisionId, meta.cost || null);
    d.plan.forEach((p) => {
      this.steps.push({ decisionId: d.decisionId, step: p.step, role: "primary", toolId: p.tool.id, seller: p.tool.seller, firstParty: p.tool.firstParty, score: p.score });
      for (const f of p.fallbacks) this.steps.push({ decisionId: d.decisionId, step: p.step, role: "fallback", toolId: f.id, seller: f.seller, firstParty: f.firstParty, score: f.score });
    });
  }
  async get(id) { return this.decisions.get(id) || null; }
  async getCost(id) { return this.costs?.get(id) || null; }
}

export class PgDecisionStore {
  /** Drop decisions (task text, payer id; steps cascade) and feedback older
   *  than `days`: the same 30-day window the main app's ledger keeps. */
  async prune(days = 30) {
    const d = Math.max(1, Math.floor(Number(days) || 30));
    const a = await this.pool.query("DELETE FROM decide_decisions WHERE created_at < now() - make_interval(days => $1)", [d]);
    const b = await this.pool.query("DELETE FROM decide_feedback WHERE created_at < now() - make_interval(days => $1)", [d]);
    return { decisions: a.rowCount || 0, feedback: b.rowCount || 0 };
  }
  constructor(pool) { this.pool = pool; }
  async save(d, meta) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `INSERT INTO decide_decisions (id, task, constraints, depth, cache_key, payer, rail, price_usd, confidence, result, ranking_weights, cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [d.decisionId, d.task, meta.constraints || {}, d.depth, meta.cacheKey || null, meta.payer || null, meta.rail || null, meta.priceUsd || 0, d.confidence, d, { weights: d.ranking?.weights, log: meta.rankingLog || [] }, meta.cost || null]);
      for (const p of d.plan) {
        const rows = [{ role: "primary", t: p.tool, score: p.score }, ...p.fallbacks.map((f) => ({ role: "fallback", t: f, score: f.score }))];
        for (const r of rows) {
          await c.query("INSERT INTO decide_decision_steps (decision_id, step, role, tool_id, seller, first_party, score) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
            [d.decisionId, p.step, r.role, r.t.id, r.t.seller, r.t.firstParty, { score: r.score }]);
        }
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { c.release(); }
  }
  async getCost(id) {
    const { rows } = await this.pool.query("SELECT cost FROM decide_decisions WHERE id = $1", [id]);
    return rows[0]?.cost || null;
  }
  async get(id) {
    const { rows } = await this.pool.query("SELECT result, payer, rail, price_usd, created_at FROM decide_decisions WHERE id = $1", [id]);
    return rows[0] ? { result: rows[0].result, payer: rows[0].payer, rail: rows[0].rail, priceUsd: Number(rows[0].price_usd), createdAt: new Date(rows[0].created_at).getTime() } : null;
  }
}

/** A bounded concurrency gate: `max` running, `queue` waiting, the rest refused. */
export function makeGate(max = 4, queue = 16) {
  let running = 0;
  const waiters = [];
  return {
    async run(fn) {
      if (running >= max) {
        if (waiters.length >= queue) throw Object.assign(new Error("decision service busy - retry shortly"), { statusCode: 503, retryAfter: 5 });
        await new Promise((r) => waiters.push(r));
      }
      running++;
      try { return await fn(); } finally {
        running--;
        const next = waiters.shift();
        if (next) next();
      }
    },
    stats: () => ({ running, waiting: waiters.length, max, queue }),
  };
}

/** Short-TTL decision cache by normalized task + constraints + depth. */
export function makeDecisionCache(ttlMs, maxEntries = 2000) {
  const m = new Map();
  return {
    get(key, now = Date.now()) {
      const e = m.get(key);
      if (!e) return null;
      if (now - e.at > ttlMs) { m.delete(key); return null; }
      return e.value;
    },
    set(key, value, now = Date.now()) {
      if (m.size >= maxEntries) m.delete(m.keys().next().value);
      m.set(key, { at: now, value });
    },
    size: () => m.size,
  };
}
