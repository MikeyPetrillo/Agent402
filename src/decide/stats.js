// Decide usage for the operator (GET /__operator/decide-stats.json): counts
// over the last 7 and 30 days, outside buyers and our own traffic apart.
// Aggregates only: no task text, plan, parameter value, payer or token ever
// leaves this module; payers are counted, never listed. Pure: the ledger hands
// in its rows (statsRows) and the caller says which rows are ours.
import { skipCodeOf, SKIP_CODES } from "./skip-codes.js";

export const STATS_WINDOWS_DAYS = Object.freeze([7, 30]);
const MAX_LISTED = 50; // shapes and planner versions listed per window and side

const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);

function emptySide() {
  return {
    decisions: { made: 0, settled: 0, byDepth: {} },
    payers: { decisions: new Set(), runs: new Set() },
    executions: { runs: 0, byStatus: {} },
    outcomes: { steps: 0, ok: 0, failed: 0, skipped: 0 },
    skipCodes: Object.fromEntries(SKIP_CODES.map((c) => [c, 0])),
    shapes: new Map(),
    plannerVersions: new Map(),
  };
}

const bucket = (map, key) => {
  const k = key || "(none)";
  if (!map.has(k)) map.set(k, { decisions: 0, settled: 0, runs: 0, complete: 0, partial: 0, failed: 0 });
  return map.get(k);
};

function addRunOutcome(b, status) {
  b.runs++;
  if (status === "complete") b.complete++;
  else if (status === "partial") b.partial++;
  else if (status === "failed" || status === "abandoned") b.failed++;
}

function finishSide(s) {
  const list = (map, keyName) => [...map.entries()]
    .map(([k, b]) => ({ [keyName]: k, ...b, successRate: rate(b.complete, b.runs), anyStepOkRate: rate(b.complete + b.partial, b.runs) }))
    .sort((a, b) => b.decisions - a.decisions || b.runs - a.runs || String(a[keyName]).localeCompare(String(b[keyName])));
  const shapes = list(s.shapes, "shapeKey");
  const versions = list(s.plannerVersions, "plannerVersion");
  return {
    decisions: s.decisions,
    distinctPayers: { decisions: s.payers.decisions.size, runs: s.payers.runs.size },
    executions: s.executions,
    outcomes: s.outcomes,
    skipCodes: s.skipCodes,
    shapes: { distinct: shapes.length, listed: shapes.slice(0, MAX_LISTED), ...(shapes.length > MAX_LISTED ? { partial: true, cap: MAX_LISTED } : {}) },
    plannerVersions: { distinct: versions.length, listed: versions.slice(0, MAX_LISTED), ...(versions.length > MAX_LISTED ? { partial: true, cap: MAX_LISTED } : {}) },
  };
}

/**
 * @param rows   { decisions: [...], runs: [...] } from ledger.statsRows
 * @param opts   { now, isOurs(row) -> boolean }
 */
export function aggregateDecideStats({ decisions = [], runs = [] } = {}, { now = Date.now(), isOurs = (r) => r.synthetic === true } = {}) {
  const ours = (r) => { try { return isOurs(r) === true; } catch { return r?.synthetic === true; } };
  const windows = {};
  for (const days of STATS_WINDOWS_DAYS) {
    const since = now - days * 86_400_000;
    const side = { external: emptySide(), ours: emptySide() };
    for (const d of decisions) {
      if (!(d.createdAt >= since)) continue;
      const s = side[ours(d) ? "ours" : "external"];
      s.decisions.made++;
      if (d.settled) s.decisions.settled++;
      s.decisions.byDepth[d.depth || "(none)"] = (s.decisions.byDepth[d.depth || "(none)"] || 0) + 1;
      if (d.payer && d.settled) s.payers.decisions.add(d.payer);
      for (const b of [bucket(s.shapes, d.shapeKey), bucket(s.plannerVersions, d.plannerVersion)]) { b.decisions++; if (d.settled) b.settled++; }
    }
    for (const r of runs) {
      if (!(r.createdAt >= since)) continue;
      const s = side[ours(r) ? "ours" : "external"];
      s.executions.runs++;
      s.executions.byStatus[r.status || "(none)"] = (s.executions.byStatus[r.status || "(none)"] || 0) + 1;
      if (r.payer) s.payers.runs.add(r.payer);
      addRunOutcome(bucket(s.shapes, r.shapeKey), r.status);
      addRunOutcome(bucket(s.plannerVersions, r.plannerVersion), r.status);
      for (const st of r.steps || []) {
        s.outcomes.steps++;
        if (st?.status === "ok") s.outcomes.ok++;
        else if (st?.status === "skipped") s.outcomes.skipped++;
        else s.outcomes.failed++;
        const attempts = Array.isArray(st?.attempts) ? st.attempts : [];
        for (const a of attempts) if (a && (a.skipped !== undefined || a.error !== undefined)) s.skipCodes[skipCodeOf(a)]++;
        // A step skipped with no attempt of its own (the run stopped first).
        if (st?.status === "skipped" && !attempts.length) s.skipCodes[skipCodeOf(st)]++;
      }
    }
    windows[`${days}d`] = { external: finishSide(side.external), ours: finishSide(side.ours) };
  }
  return {
    generatedAt: new Date(now).toISOString(),
    windows,
    note: "Aggregates of the decide ledger (kept 30 days). decisions.made counts answered decisions, settled the paid ones; distinct payers count settled decisions and booked runs. A run succeeds when every step ran (complete); anyStepOkRate counts partial runs too. skipCodes count every attempt that was skipped or failed, by fixed code. ours = signed probes and our own wallets.",
  };
}
