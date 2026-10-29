// BM25 over each row's name, description, category and input field names.
// In memory: postings are rebuilt incrementally as rows change.
//
// Typed arrays rather than a Map per document and a Set per token: at ~200k
// rows the per-object overhead was most of the service's heap. Each document
// holds a slot (an integer); each token an integer id, a live count and one
// Uint32Array of (slot, term frequency) pairs in the order the documents were
// added. A delete only marks its slot dead: entries pointing at a dead slot are
// skipped, and once dead slots outnumber half the live ones every array is
// compacted in place, keeping each posting's order. Search walks postings in
// that order and sums in query-token order, so scores and their tie order are
// the same as the Map-and-Set index's (scripts/test-decide-lexical.js).

const K1 = 1.2;
const B = 0.75;
const STOP = new Set(["a", "an", "the", "and", "or", "of", "to", "for", "in", "on", "with", "by", "from", "is", "are", "it", "this", "that", "as", "at", "be", "api", "tool", "endpoint", "x402", "mpp"]);
const COMPACT_MIN_DEAD = 1024;

export function tokenize(text) {
  return String(text || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").split(" ")
    .filter((t) => t.length > 1 && t.length < 40 && !STOP.has(t));
}

const grownU32 = (a, need) => {
  if (need <= a.length) return a;
  const b = new Uint32Array(Math.max(need, a.length * 2, 16));
  b.set(a);
  return b;
};

export class LexicalIndex {
  constructor() {
    // Documents, by slot.
    this.slotOf = new Map();          // id -> slot
    this.ids = [];                    // slot -> id, undefined once deleted
    this.lens = new Uint32Array(0);   // slot -> token count
    this.start = new Uint32Array(0);  // slot -> offset of its token ids in `arena`
    this.width = new Uint32Array(0);  // slot -> number of distinct tokens
    this.arena = new Uint32Array(0);  // each slot's distinct token ids, slot after slot
    this.arenaLen = 0;
    this.live = 0;
    this.dead = 0;
    // Tokens, by token id.
    this.tokenId = new Map();         // token -> token id
    this.tokens = [];                 // token id -> token, undefined once freed
    this.freeTokens = [];
    this.postings = [];               // token id -> Uint32Array of (slot, tf) pairs
    this.postLen = new Uint32Array(0); // token id -> pairs used, dead slots included
    this.postLive = new Uint32Array(0); // token id -> pairs whose slot is live
    this.totalLen = 0;
    this.compactions = 0;
  }

  get size() { return this.live; }

  set(id, text) {
    this.delete(id);
    const toks = tokenize(text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    const slot = this.ids.length;
    this.ids.push(id);
    this.slotOf.set(id, slot);
    if (slot >= this.lens.length) {
      this.lens = grownU32(this.lens, slot + 1);
      this.start = grownU32(this.start, slot + 1);
      this.width = grownU32(this.width, slot + 1);
    }
    this.lens[slot] = toks.length;
    this.start[slot] = this.arenaLen;
    this.width[slot] = tf.size;
    this.arena = grownU32(this.arena, this.arenaLen + tf.size);
    this.totalLen += toks.length;
    this.live++;
    for (const [t, f] of tf) {
      const tid = this.intern(t);
      this.arena[this.arenaLen++] = tid;
      const used = this.postLen[tid];
      let p = this.postings[tid];
      if (2 * used + 2 > p.length) {
        const q = new Uint32Array(Math.max(4, p.length * 2));
        q.set(p);
        this.postings[tid] = p = q;
      }
      p[2 * used] = slot;
      p[2 * used + 1] = f;
      this.postLen[tid] = used + 1;
      this.postLive[tid]++;
    }
  }

  intern(t) {
    let tid = this.tokenId.get(t);
    if (tid !== undefined) return tid;
    if (this.freeTokens.length) {
      tid = this.freeTokens.pop();
      this.tokens[tid] = t;
    } else {
      tid = this.tokens.length;
      this.tokens.push(t);
      if (tid >= this.postLen.length) {
        this.postLen = grownU32(this.postLen, tid + 1);
        this.postLive = grownU32(this.postLive, tid + 1);
      }
    }
    this.tokenId.set(t, tid);
    this.postings[tid] = new Uint32Array(4);
    this.postLen[tid] = 0;
    this.postLive[tid] = 0;
    return tid;
  }

  delete(id) {
    const slot = this.slotOf.get(id);
    if (slot === undefined) return;
    for (let i = this.start[slot], end = i + this.width[slot]; i < end; i++) {
      const tid = this.arena[i];
      if (--this.postLive[tid] === 0) {
        // Every pair left points at a dead slot: the token goes, as the Set did.
        this.tokenId.delete(this.tokens[tid]);
        this.tokens[tid] = undefined;
        this.postings[tid] = null;
        this.postLen[tid] = 0;
        this.freeTokens.push(tid);
      }
    }
    this.totalLen -= this.lens[slot];
    this.ids[slot] = undefined;
    this.slotOf.delete(id);
    this.live--;
    this.dead++;
    if (this.dead >= COMPACT_MIN_DEAD && this.dead * 2 > this.live) this.compact();
  }

  /** Drop dead slots: renumber live ones in slot order, in place. */
  compact() {
    const n = this.ids.length;
    const remap = new Uint32Array(n);
    const alive = new Uint8Array(n);
    let to = 0, arenaTo = 0;
    for (let s = 0; s < n; s++) {
      const id = this.ids[s];
      if (id === undefined) continue;
      alive[s] = 1;
      remap[s] = to;
      const from = this.start[s], w = this.width[s];
      this.arena.copyWithin(arenaTo, from, from + w);
      this.ids[to] = id;
      this.slotOf.set(id, to);
      this.lens[to] = this.lens[s];
      this.start[to] = arenaTo;
      this.width[to] = w;
      arenaTo += w;
      to++;
    }
    this.ids.length = to;
    this.arenaLen = arenaTo;
    // Postings keep their order; only pairs on a live slot stay.
    for (let tid = 0; tid < this.tokens.length; tid++) {
      const p = this.postings[tid];
      if (!p) continue;
      let w = 0;
      for (let i = 0, end = 2 * this.postLen[tid]; i < end; i += 2) {
        const s = p[i];
        if (!alive[s]) continue;
        p[w++] = remap[s];
        p[w++] = p[i + 1];
      }
      this.postLen[tid] = w / 2;
    }
    this.dead = 0;
    this.compactions++;
  }

  search(query, k = 50, allow = null) {
    const n = this.live;
    if (!n) return [];
    const avg = this.totalLen / n || 1;
    const scores = new Map();
    const ids = this.ids, lens = this.lens;
    for (const t of new Set(tokenize(query))) {
      const tid = this.tokenId.get(t);
      if (tid === undefined) continue;
      const size = this.postLive[tid];
      const idf = Math.log(1 + (n - size + 0.5) / (size + 0.5));
      const p = this.postings[tid];
      for (let i = 0, end = 2 * this.postLen[tid]; i < end; i += 2) {
        const slot = p[i];
        const id = ids[slot];
        if (id === undefined) continue;
        if (allow && !allow(id)) continue;
        const f = p[i + 1];
        const add = idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (lens[slot] / avg)));
        scores.set(id, (scores.get(id) || 0) + add);
      }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id, score]) => ({ id, score }));
  }
}
