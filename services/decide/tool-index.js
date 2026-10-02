// The unified tool index inside the decide service: rows, their vectors and a
// lexical index, with pre-filters and hybrid retrieval.
//
// Hybrid = reciprocal rank fusion of a vector ranking and a BM25 ranking, so a
// query that names a tool exactly ("sha256 hash") and one that describes a job
// ("fingerprint this file") both find it. Pre-filters (rail, chain, budget,
// excluded sellers, deterministic-only, freshness) run BEFORE ranking, so the
// k slots are filled by rows the caller can actually use.

import { VectorStore, quantize } from "./vectors.js";
import { LexicalIndex } from "./lexical.js";
import { embedText } from "../../src/decide/tool-rows.js";

const RRF_K = 60;

export class ToolIndex {
  constructor() {
    this.rows = new Map();
    this.vectors = new VectorStore();
    this.lexical = new LexicalIndex();
  }

  get size() { return this.rows.size; }

  upsert(row) {
    const prev = this.rows.get(row.id);
    this.rows.set(row.id, row);
    if (!prev || prev.contentHash !== row.contentHash) {
      this.lexical.set(row.id, embedText(row));
      if (prev && prev.contentHash !== row.contentHash) this.vectors.delete(row.id); // text changed: old vector is stale
    }
  }

  setVector(id, floatVec) {
    if (this.rows.has(id)) this.vectors.set(id, floatVec instanceof Int8Array ? floatVec : quantize(floatVec));
  }

  delete(id) {
    this.rows.delete(id);
    this.vectors.delete(id);
    this.lexical.delete(id);
  }

  missingVectors() {
    const out = [];
    for (const id of this.rows.keys()) if (!this.vectors.has(id)) out.push(id);
    return out;
  }

  /** A predicate over row ids from caller constraints. */
  filterFor(c = {}, now = Date.now()) {
    const rails = Array.isArray(c.rails) && c.rails.length ? new Set(c.rails.map(String)) : null;
    const chains = Array.isArray(c.chains) && c.chains.length ? c.chains.map((x) => String(x).toLowerCase()) : null;
    const excl = Array.isArray(c.excludeSellers) && c.excludeSellers.length ? new Set(c.excludeSellers.map((s) => String(s).toLowerCase())) : null;
    const maxPrice = Number.isFinite(c.maxBudgetUsd) ? c.maxBudgetUsd : Infinity;
    const freshMs = Number.isFinite(c.freshWithinMs) ? c.freshWithinMs : null;
    return (id) => {
      const r = this.rows.get(id);
      if (!r) return false;
      if (r.priceUsd > maxPrice) return false;
      if (rails && !r.rails.some((x) => rails.has(x))) return false;
      if (chains && !r.networks.some((n) => chains.some((want) => n.toLowerCase() === want || n.toLowerCase().startsWith(want + ":")))) return false;
      if (excl && excl.has(r.seller)) return false;
      if (c.requireDeterministic && (r.modelBacked !== false)) return false;
      if (freshMs !== null && !(r.lastLiveAt && now - r.lastLiveAt <= freshMs)) return false;
      return true;
    };
  }

  /**
   * Hybrid retrieval. `queryVec` may be null (embedding unavailable): the
   * lexical ranking then stands alone, and the caller is told so.
   */
  search({ query, queryVec = null, constraints = {}, k = 30, now = Date.now() }) {
    const allow = this.filterFor(constraints, now);
    const depth = Math.max(k * 4, 60);
    const lex = this.lexical.search(query, depth, allow);
    const vec = queryVec ? this.vectors.search(queryVec instanceof Int8Array ? queryVec : quantize(queryVec), depth, allow) : [];
    const fused = new Map();
    lex.forEach((h, i) => fused.set(h.id, { id: h.id, rrf: 1 / (RRF_K + i + 1), lexScore: h.score, vecScore: null }));
    vec.forEach((h, i) => {
      const e = fused.get(h.id) || { id: h.id, rrf: 0, lexScore: null, vecScore: null };
      e.rrf += 1 / (RRF_K + i + 1);
      e.vecScore = h.score;
      fused.set(h.id, e);
    });
    const hits = [...fused.values()].sort((a, b) => b.rrf - a.rrf || (a.id < b.id ? -1 : 1)).slice(0, k)
      .map((h) => ({ ...h, row: this.rows.get(h.id) }));
    return { hits, mode: queryVec ? "hybrid" : "lexical-only", candidates: fused.size };
  }
}
