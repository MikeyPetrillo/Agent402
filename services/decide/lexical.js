// BM25 over each row's name, description, category and input field names.
// In memory: postings are rebuilt incrementally as rows change.

const K1 = 1.2;
const B = 0.75;
const STOP = new Set(["a", "an", "the", "and", "or", "of", "to", "for", "in", "on", "with", "by", "from", "is", "are", "it", "this", "that", "as", "at", "be", "api", "tool", "endpoint", "x402", "mpp"]);

export function tokenize(text) {
  return String(text || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").split(" ")
    .filter((t) => t.length > 1 && t.length < 40 && !STOP.has(t));
}

export class LexicalIndex {
  constructor() {
    this.docs = new Map();      // id -> { len, tf: Map }
    this.postings = new Map();  // token -> Set(id)
    this.totalLen = 0;
  }

  set(id, text) {
    this.delete(id);
    const toks = tokenize(text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    this.docs.set(id, { len: toks.length, tf });
    this.totalLen += toks.length;
    for (const t of tf.keys()) {
      let s = this.postings.get(t);
      if (!s) this.postings.set(t, (s = new Set()));
      s.add(id);
    }
  }

  delete(id) {
    const d = this.docs.get(id);
    if (!d) return;
    for (const t of d.tf.keys()) {
      const s = this.postings.get(t);
      if (s) { s.delete(id); if (!s.size) this.postings.delete(t); }
    }
    this.totalLen -= d.len;
    this.docs.delete(id);
  }

  search(query, k = 50, allow = null) {
    const n = this.docs.size;
    if (!n) return [];
    const avg = this.totalLen / n || 1;
    const scores = new Map();
    for (const t of new Set(tokenize(query))) {
      const s = this.postings.get(t);
      if (!s) continue;
      const idf = Math.log(1 + (n - s.size + 0.5) / (s.size + 0.5));
      for (const id of s) {
        if (allow && !allow(id)) continue;
        const d = this.docs.get(id);
        const f = d.tf.get(t);
        const add = idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / avg)));
        scores.set(id, (scores.get(id) || 0) + add);
      }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id, score]) => ({ id, score }));
  }
}
