// timSortSteps (src/timsort-steps.js) is the engine's Array.prototype.sort in
// steps: it must ask the comparator the same questions in the same order and
// leave the same order, for consistent comparators and for ones that are not
// (the router's tiebreak is not transitive, so its published order is the
// engine's comparison sequence). Each case below runs the engine's sort and
// the stepped one with a comparator that logs every call, and requires the two
// logs and the two results to be identical. A comparator that answers at
// random from a seeded stream is the strictest: any difference in what is
// compared, or when, changes every later answer. Offline, no imports from src
// beyond the module.
import assert from "node:assert/strict";
import { timSortSteps } from "../src/timsort-steps.js";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function drive(gen) { let r = gen.next(), steps = 0; while (!r.done) { steps++; r = gen.next(); } return { value: r.value, steps }; }

// Run both sorts; `make` builds a fresh comparator (with its own state) per run.
function same(arr, make, label) {
  const e = arr.slice(), s = arr.slice();
  const logE = [], logS = [];
  const ce = make(logE), cs = make(logS);
  e.sort(ce);
  const { value } = drive(timSortSteps(s, cs, { stepCompares: 7 }));
  const sameLog = logE.length === logS.length && logE.every((x, i) => x === logS[i]);
  const sameOut = e.length === s.length && e.every((x, i) => x === s[i]);
  if (!(sameLog && sameOut)) console.log(`# ${label}: n=${arr.length} compares engine ${logE.length} stepped ${logS.length}`);
  ok(sameLog && sameOut && value === s, label);
}

const rows = (len, r, spread) => Array.from({ length: len }, (_, i) => ({ id: i, k: Math.floor(r() * spread), h: Math.floor(r() * 3), loc: r() < 0.1 }));
const consistent = (log) => (a, b) => { log.push(`${a.id},${b.id}`); return a.k - b.k; };
// The router's shape: a step skipped for some pairs only, so not transitive.
const routerLike = (log) => (a, b) => {
  log.push(`${a.id},${b.id}`);
  if (a.k !== b.k) return b.k - a.k;
  if (!(a.loc || b.loc) && a.h !== b.h) return b.h - a.h;
  return (a.id % 7) - (b.id % 7);
};
const randomAnswers = (seed) => (log) => { const r = rng(seed); return (a, b) => { log.push(`${a.id},${b.id}`); const x = r(); return x < 0.45 ? -1 : x < 0.9 ? 1 : 0; }; };

// Every length up to 300 (insertion-sort runs, the first merges), each comparator.
for (let len = 0; len <= 300; len++) {
  const r = rng(len + 11);
  const arr = rows(len, r, 1 + (len % 9));
  same(arr, consistent, `consistent n=${len}`);
  same(arr, routerLike, `router-like n=${len}`);
  same(arr, randomAnswers(len * 31 + 7), `random answers n=${len}`);
}
// Larger arrays: random, presorted, reversed, sawtooth and few-distinct keys,
// where galloping and the adaptive threshold come into play.
const shapes = {
  random: (len, r) => rows(len, r, len),
  fewKeys: (len, r) => rows(len, r, 4),
  sorted: (len) => Array.from({ length: len }, (_, i) => ({ id: i, k: i, h: i % 3, loc: false })),
  reversed: (len) => Array.from({ length: len }, (_, i) => ({ id: i, k: len - i, h: i % 3, loc: i % 11 === 0 })),
  sawtooth: (len) => Array.from({ length: len }, (_, i) => ({ id: i, k: i % 97, h: i % 5, loc: i % 13 === 0 })),
  blocks: (len, r) => { const out = []; let k = 0; while (out.length < len) { const run = 1 + Math.floor(r() * 400), up = r() < 0.5; for (let j = 0; j < run && out.length < len; j++) out.push({ id: out.length, k: up ? k + j : k + run - j, h: j % 2, loc: false }); k += Math.floor(r() * 300) - 100; } return out; },
};
for (const [name, make] of Object.entries(shapes)) {
  for (const len of [1000, 4097, 20000, 33000]) {
    const r = rng(len ^ name.length);
    const arr = make(len, r);
    same(arr, consistent, `consistent ${name} n=${len}`);
    same(arr, routerLike, `router-like ${name} n=${len}`);
    same(arr, randomAnswers(len + name.length), `random answers ${name} n=${len}`);
  }
}
// A NaN answer reads as 0, as the engine reads it.
same(rows(500, rng(5), 10), (log) => (a, b) => { log.push(`${a.id},${b.id}`); return a.k === b.k ? NaN : a.k - b.k; }, "a NaN answer reads as equal");

// It does stop: a sort of 30,000 rows yields many times, so a caller can hand
// the loop back inside it.
const big = rows(30000, rng(99), 30000);
const { steps } = drive(timSortSteps(big, (a, b) => a.k - b.k));
ok(steps > 100, `a 30,000-row sort yields at intervals (${steps} yields)`);
ok(big.every((x, i) => i === 0 || big[i - 1].k <= x.k), "and sorts");

// A comparator that throws mid-sort leaves the array as it was (the engine
// sorts a copy too), in every trial, whenever the throw lands.
{
  let intact = 0;
  const trials = 50;
  for (let t = 0; t < trials; t++) {
    const r = rng(1000 + t);
    const arr = rows(400, r, 50);
    const before = arr.slice();
    let calls = 0;
    const throwAt = 1 + Math.floor(r() * 2500);
    let threw = false;
    try { drive(timSortSteps(arr, (a, b) => { if (++calls === throwAt) throw new Error("comparator failed"); return a.k - b.k; }, { stepCompares: 13 })); } catch { threw = true; }
    if (!threw || (arr.length === before.length && arr.every((x, i) => x === before[i]))) intact++;
  }
  ok(intact === trials, `a throwing comparator leaves the array untouched (${intact} of ${trials} trials intact)`);
}

// undefined and holes: the engine moves them to the end (values, then the
// undefineds, then the holes) and never asks the comparator about them.
{
  const cases = [
    [3, undefined, 1, 2],
    [undefined, 3],
    [undefined],
    [undefined, undefined, 5, 4],
    // eslint-disable-next-line no-sparse-arrays
    [3, , 1, , 2],
    // eslint-disable-next-line no-sparse-arrays
    [, undefined, 9, , 7, undefined, 8],
    Object.assign(new Array(40), { 3: 5, 17: undefined, 20: 1, 39: 2 }),
  ];
  const r = rng(77);
  const mixed = Array.from({ length: 300 }, () => r() < 0.1 ? undefined : Math.floor(r() * 100));
  for (let i = 0; i < 300; i += 7) delete mixed[i];
  cases.push(mixed);
  for (const [ci, arr] of cases.entries()) {
    const e = arr.slice(), s = arr.slice();
    const logE = [], logS = [];
    e.sort((a, b) => { logE.push(`${a},${b}`); return a - b; });
    drive(timSortSteps(s, (a, b) => { logS.push(`${a},${b}`); return a - b; }, { stepCompares: 5 }));
    const shape = (x) => Array.from({ length: x.length }, (_, i) => (i in x ? (x[i] === undefined ? "u" : x[i]) : "hole")).join("|");
    ok(shape(e) === shape(s) && logE.join(" ") === logS.join(" ") && !logS.some((c) => c.includes("undefined")), `undefined and holes, case ${ci}: same order, holes and comparator calls as the engine (${shape(s).slice(0, 60)})`);
  }
}
console.log(`test-timsort-steps: ${n} passed`);
