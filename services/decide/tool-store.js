// Durable storage for the tool index: rows and their vectors in Postgres
// (decide_tools). MemoryToolStore has the same interface for tests and for a
// boot with no database configured.

import { toBytes, fromBytes } from "./vectors.js";

export class PgToolStore {
  constructor(pool) { this.pool = pool; }

  async load(onRow) {
    // Cursor-free paging by id keeps memory flat on ~117k rows.
    let after = "";
    for (;;) {
      const { rows } = await this.pool.query(
        "SELECT id, row, embedding, embedded_hash, content_hash FROM decide_tools WHERE id > $1 ORDER BY id LIMIT 5000", [after]);
      if (!rows.length) break;
      for (const r of rows) onRow(r.row, r.embedding && r.embedded_hash === r.content_hash ? fromBytes(r.embedding) : null);
      after = rows[rows.length - 1].id;
    }
  }

  async upsert(rows) {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await this.pool.query(
        `INSERT INTO decide_tools (id, content_hash, row, updated_at)
         SELECT x.id, x.h, x.r, now() FROM jsonb_to_recordset($1::jsonb) AS x(id text, h text, r jsonb)
         ON CONFLICT (id) DO UPDATE SET content_hash = EXCLUDED.content_hash, row = EXCLUDED.row, updated_at = now()`,
        [JSON.stringify(chunk.map((r) => ({ id: r.id, h: r.contentHash, r })))]);
    }
  }

  // One statement per 500 vectors, not one per vector: this Postgres is shared
  // with the main app, and a full re-embed is tens of thousands of rows.
  async setVectors(pairs) {
    for (let i = 0; i < pairs.length; i += 500) {
      const chunk = pairs.slice(i, i + 500);
      await this.pool.query(
        `UPDATE decide_tools AS t SET embedding = x.v, embedded_hash = x.h
         FROM unnest($1::text[], $2::bytea[], $3::text[]) AS x(id, v, h) WHERE t.id = x.id`,
        [chunk.map((p) => p.id), chunk.map((p) => toBytes(p.vec)), chunk.map((p) => p.hash)]);
    }
  }

  async deleteIds(ids) {
    for (let i = 0; i < ids.length; i += 1000) {
      await this.pool.query("DELETE FROM decide_tools WHERE id = ANY($1::text[])", [ids.slice(i, i + 1000)]);
    }
  }
}

export class MemoryToolStore {
  constructor() { this.rows = new Map(); this.vecs = new Map(); }
  async load(onRow) { for (const [id, row] of this.rows) { const v = this.vecs.get(id); onRow(row, v && v.hash === row.contentHash ? v.vec : null); } }
  async upsert(rows) { for (const r of rows) this.rows.set(r.id, r); }
  async setVectors(pairs) { for (const { id, hash, vec } of pairs) this.vecs.set(id, { hash, vec }); }
  async deleteIds(ids) { for (const id of ids) { this.rows.delete(id); this.vecs.delete(id); } }
}
