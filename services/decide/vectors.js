// Exact cosine search over int8-quantized embeddings, in memory.
//
// Railway's default Postgres ships no pgvector, so vectors are stored as bytes
// in Postgres and searched here. 117k rows x 512 dims x 1 byte is ~60 MB and a
// full scan is tens of milliseconds; exact search also means no index to tune
// and no recall loss to explain.

export const DIMS = 512;

/** Unit-normalize, then scale to int8. */
export function quantize(vec) {
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round((vec[i] / norm) * 127)));
  return out;
}

export function toBytes(q) { return Buffer.from(q.buffer, q.byteOffset, q.byteLength); }
export function fromBytes(buf) { return new Int8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); }

export class VectorStore {
  constructor(dims = DIMS) {
    this.dims = dims;
    this.ids = [];
    this.pos = new Map();
    this.data = new Int8Array(0);
    this.count = 0;
  }

  set(id, q) {
    if (!(q instanceof Int8Array) || q.length !== this.dims) throw new Error("vector dims mismatch");
    let i = this.pos.get(id);
    if (i === undefined) {
      i = this.count++;
      if (i * this.dims + this.dims > this.data.length) {
        const grown = new Int8Array(Math.max(this.dims * 1024, this.data.length * 2));
        grown.set(this.data);
        this.data = grown;
      }
      this.ids[i] = id;
      this.pos.set(id, i);
    }
    this.data.set(q, i * this.dims);
  }

  has(id) { return this.pos.has(id); }

  delete(id) {
    const i = this.pos.get(id);
    if (i === undefined) return;
    const last = --this.count;
    if (i !== last) {
      this.data.copyWithin(i * this.dims, last * this.dims, last * this.dims + this.dims);
      this.ids[i] = this.ids[last];
      this.pos.set(this.ids[i], i);
    }
    this.ids.length = last;
    this.pos.delete(id);
  }

  /** Top k ids by cosine similarity to a quantized query, filtered by `allow`. */
  search(q, k = 50, allow = null) {
    const d = this.dims, data = this.data;
    const best = [];
    let floor = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const id = this.ids[i];
      if (allow && !allow(id)) continue;
      let dot = 0;
      const off = i * d;
      for (let j = 0; j < d; j++) dot += q[j] * data[off + j];
      if (best.length < k) {
        best.push([id, dot]);
        if (best.length === k) { best.sort((a, b) => b[1] - a[1]); floor = best[k - 1][1]; }
      } else if (dot > floor) {
        best[k - 1] = [id, dot];
        best.sort((a, b) => b[1] - a[1]);
        floor = best[k - 1][1];
      }
    }
    best.sort((a, b) => b[1] - a[1]);
    return best.map(([id, dot]) => ({ id, score: dot / (127 * 127) }));
  }
}
