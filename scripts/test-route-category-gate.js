#!/usr/bin/env node
// The raw-text gate in src/route-category.js may only skip text the
// normalized PREFILTER would also reject: a miss here would let a route in an
// excluded category through to the router. Checked three ways: every word in
// PREFILTER holds one of the raw stems; every PREFILTER word, rewritten with
// case, separators, apostrophes and Unicode punctuation, passes both gates; and
// random text built from those words never passes PREFILTER while failing the
// raw gate.
import { strict as assert } from "node:assert";
import { __routeCategoryGatesForTests as G, personalDataMatch } from "../src/route-category.js";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// The words PREFILTER names, expanded from its alternation.
const inner = G.prefilterSource.replace(/^\\b\(\?:/, "").replace(/\)\\b$/, "");
const words = [];
for (const alt of inner.split("|")) {
  if (alt.includes(" ?")) { const [a, b] = alt.split(" ?"); words.push(`${a} ${b}`, `${a}${b}`); }
  else if (alt.endsWith("s?")) { words.push(alt.slice(0, -2), `${alt.slice(0, -2)}s`); }
  else words.push(alt);
}
ok(words.length >= 40, `PREFILTER expands to its words (${words.length})`);
for (const w of words) ok(G.rawGate(w), `the raw gate passes the PREFILTER word "${w}"`);

const seps = [" ", "-", "_", "/", ".", "|", "—", " ", ":", "  "];
const wrap = (w, i) => {
  const s = seps[i % seps.length];
  const cased = i % 3 === 0 ? w.toUpperCase() : i % 3 === 1 ? w[0].toUpperCase() + w.slice(1) : w;
  const apos = i % 4 === 0 && cased.length > 3 ? `${cased.slice(0, 2)}'${cased.slice(2)}` : i % 4 === 1 && cased.length > 3 ? `${cased.slice(0, 2)}’${cased.slice(2)}` : cased;
  return `api${s}v1${s}${apos.replace(/ /g, s)}${s}tool`;
};
let checked = 0;
for (const [i, w] of words.entries()) {
  for (let k = 0; k < 8; k++) {
    const text = wrap(w, i + k);
    if (G.prefilter(text)) { checked++; ok(G.rawGate(text), `prefilter passes and so does the raw gate: ${JSON.stringify(text)}`); }
  }
}
ok(checked > 100, `the rewritten words reach the prefilter (${checked} cases)`);

// Random text from the words plus filler: never prefilter-yes, raw-no.
let seed = 7;
const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % m; };
const filler = ["data", "api", "lookup", "search", "the", "for", "o'", "x", "’s", "-", "/", "123", "été"];
let miss = 0;
for (let i = 0; i < 20000; i++) {
  const parts = [];
  for (let j = 0; j < 1 + rnd(6); j++) parts.push(rnd(3) ? filler[rnd(filler.length)] : words[rnd(words.length)]);
  const text = parts.join(seps[rnd(seps.length)]);
  if (G.prefilter(text) && !G.rawGate(text)) miss++;
}
ok(miss === 0, `20000 random texts: no case the prefilter passes and the raw gate skips (${miss})`);

// The verdicts the tests elsewhere hold still hold through the gate.
ok(personalDataMatch({ route: "/v1/people-search", name: "People Search" }) === "people_search", "a people-search route still matches");
ok(personalDataMatch({ route: "/v1/peo'ple-search", name: "x" }) === "people_search", "an apostrophe inside the word does not slip past the gate");
ok(personalDataMatch({ route: "/v1/dns", name: "DNS lookup", description: "Resolve A records." }) === null, "an ordinary tool skips at the raw gate");

console.log(`test-route-category-gate: ${n} assertions OK`);
