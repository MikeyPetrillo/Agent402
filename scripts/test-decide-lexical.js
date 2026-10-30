// The decide service's BM25 index (services/decide/lexical.js) against the
// Map-and-Set index it replaced, kept below verbatim as the reference: one
// deterministic synthetic catalog, one mutation sequence (adds, text updates,
// deletes, re-adds, no-op upserts), and every query answered by both through
// the same entry points the service serves: LexicalIndex.search at full
// depth, ToolIndex.search under random constraints (POST /internal/search),
// and the base planner over the decide suite's tasks with its stub model.
// Scores, order (ties included) and plans must be identical. Offline.
//
//   node scripts/test-decide-lexical.js
//   DECIDE_EQ_ROWS=200000 node --expose-gc scripts/test-decide-lexical.js   production scale, with heap figures

import { readFileSync } from "node:fs";
import { LexicalIndex, tokenize } from "../services/decide/lexical.js";
import { ToolIndex } from "../services/decide/tool-index.js";
import { BasePlanner, runPlan } from "../services/decide/base-planner.js";
import { localToolRow, remoteToolRow, embedText } from "../src/decide/tool-rows.js";
import { decideConfig } from "../src/decide/config.js";
import { DIMS } from "../services/decide/vectors.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

// ---- the reference: the index before typed arrays, unchanged ----
const K1 = 1.2;
const B = 0.75;
class RefLexicalIndex {
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

// ---- a deterministic catalog with a long-tailed vocabulary ----
const ROWS = Math.max(1000, Number(process.env.DECIDE_EQ_ROWS) || 6000);
const QUERIES = Math.max(2000, Number(process.env.DECIDE_EQ_QUERIES) || 2000);
const NOW = 1_800_000_000_000;

function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rand = prng(402);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const suite = JSON.parse(readFileSync(new URL("./fixtures/decide-suite.json", import.meta.url), "utf8"));
const real = [...new Set(tokenize(JSON.stringify(suite)))];
const SYL = ["ba", "co", "di", "fu", "ga", "he", "ki", "lo", "me", "nu", "pa", "qui", "ro", "si", "tu", "va", "wo", "xe", "yu", "zo", "an", "er", "in", "on", "un"];
const synth = new Set();
while (synth.size < Math.min(80_000, 2_000 + ROWS / 2)) {
  let w = "";
  for (let i = 0, n = 2 + Math.floor(rand() * 3); i < n; i++) w += pick(SYL);
  if (rand() < 0.1) w += Math.floor(rand() * 1000);
  synth.add(w);
}
// Real words take the head of the distribution, invented ones the tail.
const VOCAB = [...real, ...synth];
const cum = new Float64Array(VOCAB.length);
for (let i = 0, s = 0; i < VOCAB.length; i++) { s += 1 / Math.pow(i + 1, 1.05); cum[i] = s; }
function zipfWord() {
  const x = rand() * cum[cum.length - 1];
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; }
  return VOCAB[lo];
}
const words = (n) => Array.from({ length: n }, zipfWord).join(" ");
const CATEGORIES = Array.from({ length: 40 }, () => words(1 + Math.floor(rand() * 2)));
const FIELDS = Array.from({ length: 300 }, () => zipfWord().replace(/[^a-z0-9_]/g, "") || "q");
const SELLERS = Array.from({ length: Math.max(50, Math.floor(ROWS / 60)) }, (_, i) => `seller${i}.${pick(["com", "io", "ai", "xyz"])}`);
const NETS = ["eip155:8453", "eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "eip155:137", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k", "stellar:pubnet", "eip155:4663"];

function makeRow(i, version = 0) {
  const r = prng(i * 7919 + version * 104729 + 1);
  const desc = Array.from({ length: 6 + Math.floor(r() * r() * 90) }, zipfWord).join(r() < 0.3 ? ", " : " ");
  const name = Array.from({ length: 1 + Math.floor(r() * 4) }, zipfWord).join("-");
  const props = {};
  for (let j = 0, n = Math.floor(r() * 6); j < n; j++) props[FIELDS[Math.floor(r() * FIELDS.length)]] = { type: "string" };
  if (prng(i + 5)() < 0.04) {
    const row = localToolRow({ route: `POST /api/t${i}`, slug: `t${i}`, name, description: desc, category: CATEGORIES[i % CATEGORIES.length], price: `$${(0.001 + r() * 0.05).toFixed(3)}`, modelBacked: r() < 0.3, discovery: { inputSchema: { properties: props, required: Object.keys(props).slice(0, 1) } } },
      { networks: NETS.slice(0, 2), now: NOW - Math.floor(r() * 9e6) });
    return row;
  }
  // Identity (seller, method, route) depends on i alone, so a new version is
  // an update of the same id.
  const ri = prng(i + 17);
  const seller = SELLERS[Math.floor(ri() * ri() * SELLERS.length)];
  const method = ri() < 0.5 ? "GET" : "POST";
  const req = Object.keys(props);
  return remoteToolRow({ seller: `https://${seller}`, route: `/v1/x${i}`, method, slug: `x${i}`, name, description: desc, category: CATEGORIES[Math.floor(r() * CATEGORIES.length)],
    price: Math.round((0.0005 + r() * r() * 2) * 10000) / 10000, networks: NETS.filter(() => r() < 0.35), health: r() < 0.5 ? Math.round(r() * 100) / 100 : undefined },
  { requestContract: { state: pick(["declared", "partial", "unknown", "absent"]), required: { [r() < 0.5 ? "body" : "query"]: req } }, lastLiveAt: r() < 0.7 ? NOW - Math.floor(r() * 4e8) : null, mppOrigins: new Set(r() < 0.2 ? [`https://${seller}`] : []), executable: r() < 0.8 });
}

function vecFor(i) {
  const r = prng(i + 99);
  return Array.from({ length: DIMS }, () => r() - 0.5);
}

// Both indexes hold the same rows: `newIdx` is the service's own, `refIdx`
// the same class with the reference lexical index swapped in.
const newIdx = new ToolIndex();
const refIdx = new ToolIndex();
refIdx.lexical = new RefLexicalIndex();
const both = (fn) => { fn(refIdx); fn(newIdx); };
const live = new Map(); // i -> { id, version, json }
const withVectors = ROWS <= 20_000;

function upsert(i, version) {
  const row = makeRow(i, version);
  if (!row) return;
  // Each index keeps its own copy, as each process would.
  both((idx) => idx.upsert(JSON.parse(JSON.stringify(row))));
  if (withVectors && i % 23 === 0) { const v = vecFor(i * 31 + version); both((idx) => idx.setVector(row.id, v)); }
  live.set(i, { id: row.id, version, json: JSON.stringify(row) });
}
const delRow = (i) => { const e = live.get(i); if (!e) return; both((idx) => idx.delete(e.id)); live.delete(i); };

// ---- queries ----
const taskTexts = suite.tasks.flatMap((t) => [t.task, ...(t.model?.decompose || []).map((s) => s.query), ...(t.model?.decomposeGuided || []).map((s) => s.query)]).filter(Boolean);
function makeQuery(q) {
  const r = rand();
  if (r < 0.25) return pick(taskTexts);
  if (r < 0.3) return pick(["", "the api for x402", "a", "zzzzunknownzzzz", "SHA-256 hash ÉTÉ café", "Weather   forecast!!"]);
  if (r < 0.45) return `${words(1)} ${pick(VOCAB.slice(-5000))}`; // a rare word with a common one
  return words(1 + Math.floor(rand() * 8)) + (q % 7 === 0 ? " " + words(2) : ""); // repeated tokens in one query
}
function makeConstraints() {
  const r = rand();
  if (r < 0.45) return {};
  const c = {};
  if (rand() < 0.4) c.maxBudgetUsd = pick([0.001, 0.01, 0.05, 0.5]);
  if (rand() < 0.3) c.rails = [pick(["x402", "mpp"])];
  if (rand() < 0.3) c.chains = [pick(["solana", "eip155", "eip155:8453", "algorand", "stellar"])];
  if (rand() < 0.3) c.excludeSellers = SELLERS.slice(0, 1 + Math.floor(rand() * 20));
  if (rand() < 0.2) c.requireDeterministic = true;
  if (rand() < 0.2) c.freshWithinMs = pick([3_600_000, 86_400_000, 30 * 86_400_000]);
  return c;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let queries = 0, mismatches = 0;
const firstMismatch = [];
function compare(label, q) {
  queries++;
  // Full depth: every scored row, so a difference anywhere in the ranking shows.
  const lr = refIdx.lexical.search(q, 1e9), ln = newIdx.lexical.search(q, 1e9);
  const c = makeConstraints(), k = pick([1, 5, 20, 30, 50]);
  const vec = withVectors && rand() < 0.3 ? vecFor(Math.floor(rand() * ROWS)) : null;
  const sr = refIdx.search({ query: q, queryVec: vec, constraints: c, k, now: NOW });
  const sn = newIdx.search({ query: q, queryVec: vec, constraints: c, k, now: NOW });
  if (!same(lr, ln) || !same(sr, sn)) {
    mismatches++;
    if (firstMismatch.length < 3) firstMismatch.push({ label, q, c, lex: [lr.slice(0, 3), ln.slice(0, 3)] });
  }
}
const runQueries = (label, n) => { for (let q = 0; q < n; q++) compare(label, makeQuery(q)); };

const per = Math.ceil(QUERIES / 5);
const t0 = Date.now();
for (let i = 0; i < ROWS; i++) upsert(i, 0);
console.log(`built ${newIdx.size} rows in ${Date.now() - t0} ms (both indexes)`);
runQueries("build", per);

// Text updates: a delete and a re-add of the same id inside the index.
for (let i = 0; i < ROWS; i++) if (rand() < 0.15) upsert(i, 1);
// No-op upserts: same content hash, no lexical change.
for (let i = 0; i < ROWS; i += 11) { const e = live.get(i); if (e) upsert(i, e.version); }
runQueries("updates", per);

// Deletes, past half of the index, then a delete of an id never seen.
const deleted = [];
for (let i = 0; i < ROWS; i++) if (rand() < 0.55) { delRow(i); deleted.push(i); }
both((idx) => idx.delete("no-such-id"));
both((idx) => idx.lexical.delete("no-such-id"));
runQueries("deletes", per);

// Re-adds: some with their old text, some with new.
for (const i of deleted) if (rand() < 0.5) upsert(i, rand() < 0.5 ? 0 : 2);
runQueries("re-adds", per);

// Churn the same ids again, then empty a token's whole posting and refill it.
for (let round = 0; round < 3; round++) for (let i = 0; i < ROWS; i += 3) if (live.has(i)) upsert(i, 3 + round);
both((idx) => { idx.lexical.set("solo-a", "quuxuniquetoken alpha"); idx.lexical.set("solo-b", "quuxuniquetoken beta"); });
compare("solo", "quuxuniquetoken");
both((idx) => { idx.lexical.delete("solo-a"); idx.lexical.delete("solo-b"); });
compare("solo-gone", "quuxuniquetoken alpha");
both((idx) => idx.lexical.set("solo-a", "quuxuniquetoken gamma"));
compare("solo-back", "quuxuniquetoken gamma");
both((idx) => idx.lexical.delete("solo-a"));
runQueries("churn", QUERIES - 4 * per);

ok(refIdx.size === newIdx.size && newIdx.size === live.size, `both indexes hold the same ${live.size} rows after the mutation sequence`);
ok([...live.values()].every((e) => JSON.stringify(newIdx.rows.get(e.id)) === e.json), "every stored row reads exactly as the row it was given (shared strings change no value)");
ok(newIdx.lexical.compactions > 0, `the sequence reached the index's compaction (${newIdx.lexical.compactions} runs)`);
ok(mismatches === 0, `${queries} queries through LexicalIndex.search (full depth) and ToolIndex.search: ${mismatches} mismatches${mismatches ? " " + JSON.stringify(firstMismatch).slice(0, 1500) : ""}`);

// ---- empty and emptied indexes ----
{
  const a = new RefLexicalIndex(), b = new LexicalIndex();
  ok(same(a.search("x"), b.search("x")), "an empty index answers []");
  for (const x of [a, b]) { x.set("p", "hash digest"); x.set("p", "hash digest twice digest"); x.set("q", ""); x.delete("p"); x.delete("q"); }
  ok(same(a.search("hash"), b.search("hash")), "an index emptied by deletes answers []");
  for (const x of [a, b]) { x.set("q", ""); x.set("r", "hash"); }
  ok(same(a.search("hash"), b.search("hash")) && b.search("hash").length === 1, "an empty-text row counts toward the average length as before");
}

// ---- planner path: the suite's tasks with its stub model over the big index ----
{
  const { stubModel, suiteIndex } = await import("./decide-evolve.mjs");
  const cfg = decideConfig({});
  // The suite's own tools join the synthetic catalog in both indexes.
  for (const row of suiteIndex(suite, NOW).rows.values()) both((idx) => idx.upsert(JSON.parse(JSON.stringify(row))));
  let planned = 0, planMismatch = 0;
  for (const task of suite.tasks) {
    const input = { task: task.task, constraints: {}, depth: task.depth || "plan" };
    const outs = [];
    for (const index of [refIdx, newIdx]) {
      const deps = { index, embed: async () => { throw new Error("offline"); }, llm: stubModel(task), cfg, now: NOW, deadline: Date.now() + 60_000 };
      const r = await runPlan(new BasePlanner(), input, deps, {});
      outs.push(JSON.stringify(r.out, (k, v) => (/^(decisionId|latencyMs|elapsedMs|ms|durationMs)$/.test(k) ? undefined : v)));
      if (process.env.DEBUG_PLAN) console.log(outs.at(-1).slice(0, 3000));
    }
    planned++;
    if (outs[0] !== outs[1]) planMismatch++;
  }
  ok(planned === suite.tasks.length && planMismatch === 0, `${planned} suite tasks planned over both indexes: ${planMismatch} plans differ`);
}

// ---- heap, at scale ----
if (typeof globalThis.gc === "function") {
  const mb = (x) => Math.round(x / 1048576 * 10) / 10;
  const texts = [...newIdx.rows.values()].map((r) => [r.id, embedText(r)]);
  const measure = (Cls) => {
    globalThis.gc(); globalThis.gc();
    const h0 = process.memoryUsage();
    let x = new Cls();
    for (const [id, t] of texts) x.set(id, t);
    globalThis.gc(); globalThis.gc();
    const h1 = process.memoryUsage();
    const out = { heapMb: mb(h1.heapUsed - h0.heapUsed), externalMb: mb(h1.arrayBuffers - h0.arrayBuffers), rssMb: mb(h1.rss - h0.rss), held: x.search("x").length >= 0 };
    x = null;
    return out;
  };
  const ref = measure(RefLexicalIndex), cur = measure(LexicalIndex);
  console.log(`lexical index over ${texts.length} rows: reference ${JSON.stringify(ref)}, current ${JSON.stringify(cur)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
